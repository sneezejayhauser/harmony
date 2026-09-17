import type { ChatMessage, ToolCall } from "./llm.js";
import { route } from "./router.js";
import { runTool, toolDefs, isDangerous } from "./tools.js";
import type { ModelEntry, Config } from "./config.js";
import { debugLog } from "./debug-log.js";
import { verifyWorkspace, type VerificationResult } from "./verification.js";
import { classifyTask, type TaskClassification } from "./typesafe.js";

export class AgentAborted extends Error {
  constructor() {
    super("aborted by user");
  }
}

export interface AgentResult {
  finalText: string;
  status: "completed" | "failed" | "cancelled" | "max_iterations";
  iterations: number;
  filesChanged: number;
  verificationPassed?: boolean;
  verification?: VerificationResult;
  toolCallsMade: { name: string; args: any; result: string }[];
  messages: ChatMessage[];
  plan?: AgentPlan;
}

export interface AgentPlan {
  objective: string;
  steps: string[];
  verification: string[];
}

export interface AgentEvents {
  onProgress?: (event: { phase: "planning" | "executing" | "verifying" | "repairing" | "completed" | "failed"; message: string; iteration: number }) => void;
  onModel?: (provider: string, model: string) => void;
  onToolStart?: (name: string, args: any) => void;
  onToolEnd?: (name: string, result: string) => void;
  onContent?: (delta: string) => void;
  onCorruption?: (content: string, reason: string, provider: string, model: string) => void;
  /** return true to approve a dangerous tool call in safe mode */
  confirm?: (tool: string, summary: string) => Promise<boolean>;
  /** abort signal forwarded to tools (bash kills its child on abort) */
  abortSignal?: AbortSignal;
  /** called to check if the run was aborted (e.g. Esc pressed) */
  isAborted?: () => boolean;
  onTurnEnd?: (result: AgentResult) => void;
  onVerification?: (result: VerificationResult) => void;
}

export async function runAgent(
  userTask: string,
  pool: ModelEntry[],
  cfg: Config,
  cwd: string,
  history: ChatMessage[] = [],
  events: AgentEvents = {}
): Promise<AgentResult> {
  const toolCallsMade: AgentResult["toolCallsMade"] = [];
  let filesChanged = 0;
  let repairIterations = 0;
  let qualityRetries = 0;
  const seenToolCalls = new Set<string>();

  const messages: ChatMessage[] = [...history];
  if (messages.length === 0 && cfg.systemPrompt) {
    messages.push({ role: "system", content: cfg.systemPrompt });
  }
  messages.push({ role: "user", content: userTask });
  debugLog("agent.start", { task: userTask, cwd, poolSize: pool.length, history: history.length });

  const tools = toolDefs();
  let selectedModel: ModelEntry | undefined;

  // TypeSafe (System One) judgment on whether this task needs repository
  // tools. Replaces the keyword regex below when a TYPESAFE_API_KEY is set;
  // the classification is shared with the router via its own call there.
  const classification: TaskClassification | undefined = await classifyTask(userTask);
  const legacyRequiresTool = (task: string) => /\b(use|run|read|inspect|check|list|search|find)\b.{0,40}\b(tool|file|repo|repository|directory|test|code|package\.json|tsconfig)/i.test(task);
  const requiresTool = classification ? classification.needsTools > 0.5 : legacyRequiresTool(userTask);

  let plan: AgentPlan | undefined;
  if (cfg.planning === true && !history.some((m) => m.role === "system" && m.content.includes("HARMONY_PLAN"))) {
    events.onProgress?.({ phase: "planning", message: "Creating an implementation plan", iteration: 0 });
    messages.push({ role: "system", content: "HARMONY_PLAN: Before making changes, briefly state the objective, 1-5 implementation steps, and verification commands. Do not edit files in the planning response." });
    const planResp = await route({ messages, maxTokens: Math.min(cfg.maxTokens ?? 4096, 800), temperature: 0.2, topP: 0.9, timeoutMs: Number(process.env.HARMONY_TIMEOUT_MS ?? process.env.SNEEZE_TIMEOUT_MS ?? 10_000) }, pool, { onCorruption: events.onCorruption }, userTask);
    selectedModel = planResp.entry;
    plan = parsePlan(planResp.content, userTask);
    messages.push({ role: "assistant", content: planResp.content });
    messages.push({ role: "user", content: `Plan accepted. Execute it now using tools. Do not merely describe changes. Objective: ${plan.objective}\nSteps:\n${plan.steps.map((s, n) => `${n + 1}. ${s}`).join("\n")}\nVerification:\n${plan.verification.join("\n")}` });
  }

  const maxIter = cfg.maxIterations ?? 40;
  for (let i = 0; i < maxIter; i++) {
    events.onProgress?.({ phase: "executing", message: "Selecting next action", iteration: i + 1 });
    if (events.isAborted?.() || events.abortSignal?.aborted) {
      const result: AgentResult = { finalText: "(cancelled)", status: "cancelled", iterations: i, filesChanged, toolCallsMade, messages };
      events.onTurnEnd?.(result);
      throw new AgentAborted();
    }
    const resp = await route(
      {
        messages,
        tools,
        maxTokens: cfg.maxTokens,
        temperature: 1.0,
        topP: 0.9,
        timeoutMs: Number(process.env.HARMONY_TIMEOUT_MS ?? process.env.SNEEZE_TIMEOUT_MS ?? 10_000),
      },
      pool,
      { onContent: events.onContent, onCorruption: events.onCorruption },
      userTask,
      selectedModel
    );
    selectedModel = resp.entry;
    debugLog("agent.model", { provider: resp.entry.provider, model: resp.entry.model, iteration: i + 1 });
    events.onModel?.(resp.entry.provider, resp.entry.model);

    if (resp.toolCalls.length === 0) {
      const empty = !resp.content.trim();
      const needsTools = requiresTool;
      if ((empty || (needsTools && toolCallsMade.length === 0)) && qualityRetries < 2) {
        qualityRetries++;
        messages.push({ role: "assistant", content: resp.content });
        messages.push({ role: "user", content: empty ? "Your response was empty. Continue the task and provide a useful answer." : "You did not use a tool even though this task requires repository inspection. Use the appropriate read-only tool before answering." });
        continue;
      }
      messages.push({ role: "assistant", content: resp.content });
      const verification = filesChanged > 0 && cfg.verify !== false ? await verifyWorkspace(cwd, events.abortSignal) : undefined;
      if (verification) events.onProgress?.({ phase: "verifying", message: "Running workspace verification", iteration: i + 1 });
      if (verification) events.onVerification?.(verification);
      if (verification && !verification.passed && repairIterations < (cfg.maxRepairIterations ?? 2)) {
        repairIterations++;
        events.onProgress?.({ phase: "repairing", message: `Verification failed; repair cycle ${repairIterations}`, iteration: i + 1 });
        messages.push({ role: "user", content: verificationPrompt(verification) });
        continue;
      }
      const qualityFailed = empty || (needsTools && toolCallsMade.length === 0);
      const result: AgentResult = { finalText: qualityFailed ? "Unable to produce a valid task result." : resp.content, status: qualityFailed || verification?.passed === false ? "failed" : "completed", iterations: i + 1, filesChanged, verificationPassed: verification?.passed, verification, toolCallsMade, messages, plan };
      events.onTurnEnd?.(result);
      events.onProgress?.({ phase: result.status === "completed" ? "completed" : "failed", message: result.finalText, iteration: i + 1 });
      return result;
    }

    messages.push({
      role: "assistant",
      content: resp.content,
      tool_calls: resp.toolCalls,
    });

    for (const tc of resp.toolCalls as ToolCall[]) {
      if (events.isAborted?.() || events.abortSignal?.aborted) throw new AgentAborted();
      let args: any = {};
      let parseError = false;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = {};
        parseError = true;
      }

      const signature = `${tc.function.name}:${tc.function.arguments}`;
      if (seenToolCalls.has(signature)) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: "ERROR: repeated identical tool call; reconsider the task and choose a different action." });
        continue;
      }
      seenToolCalls.add(signature);

      if (isDangerous(tc.function.name) && !cfg.yolo && events.confirm) {
        const ok = await events.confirm(tc.function.name, summarize(tc.function.name, args));
        if (!ok) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "DENIED by user.",
          });
          continue;
        }
      }

      events.onToolStart?.(tc.function.name, args);
      debugLog("tool.start", { name: tc.function.name, args });
      const result = parseError ? "ERROR: malformed tool arguments; arguments must be valid JSON" : await runTool(tc.function.name, args, {
        cwd,
        confirm: events.confirm,
        pool,
        cfg,
        signal: events.abortSignal,
      });
      toolCallsMade.push({ name: tc.function.name, args, result });
      if (["write_file", "edit_file", "patch_file", "delete_file"].includes(tc.function.name)) filesChanged++;
      events.onToolEnd?.(tc.function.name, result);
      debugLog("tool.end", { name: tc.function.name, chars: result.length });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    trimContext(messages, cfg.maxContextMessages ?? 40);
  }

  const result: AgentResult = {
    finalText: "(max iterations reached without final answer)",
    status: "max_iterations",
    iterations: maxIter,
    filesChanged,
    toolCallsMade,
    messages,
    plan,
  };
  events.onTurnEnd?.(result);
  return result;
}

function parsePlan(text: string, fallback: string): AgentPlan {
  const lines = text.split("\n").map((line) => line.replace(/^\s*[-*\d.)]+\s*/, "").trim()).filter(Boolean);
  const verification = lines.filter((line) => /\b(test|check|build|lint|verify|command|npm|pytest|cargo|go test)\b/i.test(line)).slice(-3);
  const steps = lines.filter((line) => !verification.includes(line)).slice(0, 5);
  return { objective: lines[0] ?? fallback, steps: steps.length > 0 ? steps : [fallback], verification: verification.length > 0 ? verification : ["Run the project's available verification checks"] };
}

function verificationPrompt(result: VerificationResult): string {
  const details = result.checks.map((c) => `${c.passed ? "PASS" : "FAIL"} ${c.command}\n${c.output ?? ""}`).join("\n");
  return `Verification failed. Fix the implementation, then rerun the relevant checks.\n\n${details}`.slice(0, 12_000);
}

function summarize(name: string, args: any): string {
  switch (name) {
    case "bash":
    case "bash_bg":
      return `$ ${args.command}`;
    case "write_file":
      return `write ${args.path} (${(args.content ?? "").length} bytes)`;
    case "edit_file":
      return `edit ${args.path}`;
    case "patch_file":
      return `patch ${args.path} (${args.edits?.length ?? 0} edits)`;
    case "delete_file":
      return `delete ${args.path}`;
    default:
      return `${name} ${JSON.stringify(args).slice(0, 80)}`;
  }
}

/** Keep system prompt + recent messages; drop oldest middle content when over budget. */
function trimContext(messages: ChatMessage[], max: number): void {
  if (messages.length <= max) return;
  const hasSystem = messages[0]?.role === "system";
  const system = hasSystem ? messages[0] : undefined;
  const rest = hasSystem ? messages.slice(1) : messages;
  const overflow = rest.length - (max - (hasSystem ? 1 : 0));
  if (overflow <= 0) return;
  let kept = rest.slice(overflow);
  // Preserve complete assistant tool-call + tool-result exchanges. If the
  // boundary lands inside one, discard that incomplete exchange.
  while (kept.length > 0 && kept[0].role !== "user" && kept[0].role !== "assistant") kept.shift();
  if (kept[0]?.role === "assistant" && kept[0].tool_calls) {
    const ids = new Set(kept[0].tool_calls.map((c) => c.id));
    let end = 1;
    while (end < kept.length && kept[end].role === "tool" && ids.has(kept[end].tool_call_id ?? "")) end++;
    const complete = [...ids].every((id) => kept.slice(1, end).some((m) => m.tool_call_id === id));
    if (!complete) kept = kept.slice(end);
  }
  messages.length = 0;
  if (system) messages.push(system);
  messages.push(...kept);
}
