import * as readline from "node:readline";
import { runAgent, AgentAborted, type AgentEvents } from "./agent.js";
import type { ModelEntry, Config, Session } from "./config.js";
import {
  saveSession,
  saveConfig,
  loadSession,
  listSessions,
  newSessionId,
  deleteSession,
} from "./config.js";
import { PROVIDERS, visibleProviders } from "./providers.js";
import { CATALOG } from "./catalog.js";
import { usageLog, checkBudget } from "./llm.js";
import { route } from "./router.js";
import { listTasks, spawnSubtask, getTask } from "./subagents.js";
import type { ChatMessage } from "./llm.js";

// ── colors ────────────────────────────────────────────────────────────
// Colors are callable AND string-coercible: c.cyan("hi") wraps text, while
// `${c.cyan}` / (c.green + "★") yield the raw escape code. Both styles are
// used across the TUI.
function mk(code: string): ((s: string) => string) & string {
  const fn = ((s: string) => `${code}${s}\x1b[0m`) as ((s: string) => string) & string;
  fn.toString = () => code;
  return fn;
}
const c = {
  reset: mk("\x1b[0m"),
  dim: mk("\x1b[2m"),
  bold: mk("\x1b[1m"),
  red: mk("\x1b[31m"),
  green: mk("\x1b[32m"),
  yellow: mk("\x1b[33m"),
  blue: mk("\x1b[34m"),
  magenta: mk("\x1b[35m"),
  cyan: mk("\x1b[36m"),
  gray: mk("\x1b[90m"),
  white: mk("\x1b[97m"),
};

function box(title: string, lines: string[], width: number): string[] {
  const out: string[] = [];
  const inner = width - 4;
  out.push(`${c.cyan}┌─${c.bold} ${title} ${c.reset}${c.cyan}${"─".repeat(Math.max(0, inner - title.length - 2))}┐${c.reset}`);
  for (const l of lines) {
    const visible = l.replace(/\x1b\[[0-9;]*m/g, "");
    const pad = Math.max(0, inner - visible.length);
    out.push(`${c.cyan}│${c.reset} ${l}${" ".repeat(pad)} ${c.cyan}│${c.reset}`);
  }
  out.push(`${c.cyan}└${"─".repeat(inner + 2)}┘${c.reset}`);
  return out;
}

function rule(width = 72): string {
  return `${c.gray}${"─".repeat(width)}${c.reset}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── raw-mode key input ────────────────────────────────────────────────
interface KeyHandler {
  onKey: (key: string, data: Buffer) => void;
  listener?: (data: Buffer) => void;
}

function enableRaw(h: KeyHandler): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    h.listener = (d: Buffer) => h.onKey(d.toString(), d);
    process.stdin.on("data", h.listener);
  }
}

function disableRaw(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

// ── picker ────────────────────────────────────────────────────────────
async function pick<T>(
  title: string,
  items: { label: string; hint?: string; value: T }[],
  current?: number
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let sel = current !== undefined ? Math.max(0, current) : 0;
    let filter = "";
    let view = items;
    const render = () => {
      const lines = view.map((it, i) => {
        const arrow = i === sel ? `${c.cyan}❯${c.reset} ` : "  ";
        const label = i === sel ? `${c.bold}${it.label}${c.reset}` : it.label;
        const hint = it.hint ? ` ${c.gray}${it.hint}${c.reset}` : "";
        return `${arrow}${label}${hint}`;
      });
      console.clear();
      console.log(box(title, lines.slice(0, 30), 90).join("\n"));
      console.log(c.gray("  ↑/↓ move · enter select · esc cancel · type to filter") + c.reset);
    };
    const refilter = (): void => {
      view = items.filter((it) => it.label.toLowerCase().includes(filter.toLowerCase()));
      if (sel >= view.length) sel = Math.max(0, view.length - 1);
    };
    render();
    const h: KeyHandler = {
      onKey: (key: string) => {
        if (key === "\x1b[A") {
          sel = Math.max(0, sel - 1);
          render();
        } else if (key === "\x1b[B") {
          sel = Math.min(view.length - 1, sel + 1);
          render();
        } else if (key === "\r" || key === "\n") {
          cleanup();
          resolve(view[sel]?.value);
        } else if (key === "\x1b" || key === "\x03") {
          cleanup();
          resolve(undefined);
        } else if (key === "\x7f") {
          filter = filter.slice(0, -1);
          refilter();
          render();
        } else if (key.length === 1 && key >= " ") {
          filter += key;
          refilter();
          if (view.length > 0 && !view.includes(items[sel])) sel = 0;
          render();
        }
      },
    };
    function cleanup(): void {
      if (h.listener) process.stdin.removeListener("data", h.listener);
      disableRaw();
      console.clear();
    }
    enableRaw(h);
  });
}

// ── confirm ───────────────────────────────────────────────────────────
async function confirmPrompt(tool: string, summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(
      `\n${c.yellow}⚠ ${tool}${c.reset} ${c.gray}${summary}${c.reset}\n${c.bold}[y]es / [a]ll / [n]o ${c.reset}`
    );
    const h: KeyHandler = {
      onKey: (key: string) => {
        const k = key.toLowerCase();
        if (k === "y" || k === "\r") {
          cleanup();
          resolve(true);
        } else if (k === "a") {
          process.env.HARMONY_YOLO_SESSION = "1";
          cleanup();
          resolve(true);
        } else if (k === "n" || k === "\x1b" || k === "\x03") {
          cleanup();
          resolve(false);
        }
      },
    };
    function cleanup(): void {
      process.stdout.write("\n");
      if (h.listener) process.stdin.removeListener("data", h.listener);
      disableRaw();
    }
    enableRaw(h);
  });
}

// ── main TUI ──────────────────────────────────────────────────────────
interface TuiState {
  session: Session;
  pool: ModelEntry[];
  cfg: Config;
  cwd: string;
  running: boolean;
  abort: AbortController | null;
  statusLine: string;
  lastModel: string;
}

export async function startTui(pool: ModelEntry[], cfg: Config, cwd: string, initialCommand?: string): Promise<void> {
  const queue: string[] = [];
  let commandBusy = false;
  const state: TuiState = {
    session: { id: newSessionId(), created: new Date().toISOString(), cwd, messages: [] },
    pool,
    cfg,
    cwd,
    running: false,
    abort: null,
    statusLine: "",
    lastModel: "",
  };

  console.clear();
  banner(state);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.green}❯${c.reset} `,
    terminal: true,
  });
  rl.setPrompt(`${c.magenta}❯${c.reset} `);
  rl.prompt();

  const processLine = async (input: string): Promise<void> => {
    commandBusy = true;
    if (input.startsWith("/")) {
      try {
        await handleCommand(state, input, rl);
        if (!state.running) rl.prompt();
      } finally {
        commandBusy = false;
      }
      return;
    }
    // agent turn
    state.running = true;
    rl.pause();
    try {
      await agentTurn(state, input, rl);
      state.running = false;
      rl.resume();
      rl.prompt();
      // drain anything typed while the turn was running
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (next === "/exit" || next === "/quit") {
          rl.close();
          return;
        }
        await processLine(next);
      }
    } finally {
      commandBusy = false;
    }
  };

  rl.on("line", (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (commandBusy && !state.running) {
      // A picker or secret prompt owns stdin while this is true. Ignore any
      // line event emitted from input buffered before raw mode was enabled.
      return;
    }
    if (state.running) {
      // queue while the agent is working (like Claude Code)
      queue.push(input);
      process.stdout.write(c.gray(`  ↳ queued "${truncate(input, 40)}"` + c.reset) + "\n");
      return;
    }
    void processLine(input);
  });

  rl.on("close", () => {
    // Do not force-exit here. A picker temporarily pauses readline; closing
    // readline must not terminate the process before the TUI can resume.
    console.log(c.gray("\ninput closed") + c.reset);
  });

  if (initialCommand) {
    await handleCommand(state, initialCommand, rl);
    if (!state.running) rl.prompt();
  }
}

function banner(state: TuiState): void {
  const poolInfo = state.pool.length
    ? `${state.pool.length} models`
    : "empty pool — /provider to configure";
  console.log(`\n${c.magenta}${c.bold}  ◈ HARMONY${c.reset} ${c.gray}·${c.reset} ${c.white}coding agent${c.reset}`);
  console.log(`  ${c.gray}${poolInfo} · session ${c.dim}${state.session.id}${c.reset}`);
  console.log(`  ${c.gray}/help commands ${c.gray}·${c.gray} esc abort ${c.gray}·${c.gray}/exit quit${c.reset}`);
  console.log(`${rule()}\n`);
}

async function handleCommand(state: TuiState, input: string, rl: readline.Interface): Promise<void> {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd) {
    case "/help":
      printHelp();
      break;
    case "/new":
    case "/clear":
    case "/reset":
      state.session = { id: newSessionId(), created: new Date().toISOString(), cwd: state.cwd, messages: [] };
      console.log(c.gray(`new session ${state.session.id}`) + c.reset);
      break;
    case "/resume":
    case "/continue": {
      const sessions = listSessions().slice(0, 15);
      if (sessions.length === 0) {
        console.log(c.gray("no saved sessions") + c.reset);
        break;
      }
      const picked = await pick(
        "Resume session",
        sessions.map((s) => ({
          label: s.name ?? s.id,
          hint: `${s.messages.length} msgs · ${s.created.slice(0, 16).replace("T", " ")}`,
          value: s,
        }))
      );
      if (picked) {
        state.session = picked;
        state.cwd = picked.cwd;
        console.log(c.gray(`resumed ${picked.name ?? picked.id} (${picked.messages.length} msgs)`) + c.reset);
      }
      break;
    }
    case "/sessions": {
      const sessions = listSessions().slice(0, 20);
      if (sessions.length === 0) console.log(c.gray("no saved sessions") + c.reset);
      else {
        for (const s of sessions) {
          console.log(`  ${c.cyan}${(s.name ?? s.id).padEnd(24)}${c.reset} ${c.gray}${s.messages.length} msgs · ${s.created.slice(0, 16).replace("T", " ")}${c.reset}`);
        }
      }
      break;
    }
    case "/delete-session": {
      const sessions = listSessions().slice(0, 15);
      const picked = await pick(
        "Delete session",
        sessions.map((s) => ({ label: s.name ?? s.id, hint: `${s.messages.length} msgs`, value: s }))
      );
      if (picked) {
        deleteSession(picked.id);
        console.log(c.yellow(`deleted ${picked.name ?? picked.id}`) + c.reset);
      }
      break;
    }
    case "/rename":
      if (arg) {
        state.session.name = arg;
        saveSession(state.session);
        console.log(c.gray(`renamed to ${arg}`) + c.reset);
      } else console.log(c.red("usage: /rename <name>") + c.reset);
      break;
    case "/model":
    case "/models": {
      if (state.pool.length === 0) {
        console.log(c.gray("no configured models — use /provider or /catalog") + c.reset);
        break;
      }
      console.log(c.gray(`${state.pool.length} configured models. Routing selects models automatically per task.`) + c.reset);
      break;
    }
    case "/pool":
      if (state.pool.length === 0) console.log(c.gray("pool is empty — /provider to configure a provider") + c.reset);
      state.pool.forEach((m, i) => {
        const def = PROVIDERS[m.provider];
        const b = checkBudget(m);
        console.log(
          `  ${i === 0 ? c.green + "★" : c.gray + " "} [${i}]${c.reset} ${c.cyan}${m.provider}/${m.model}${c.reset} ${c.gray}${m.priority !== undefined ? `priority ${m.priority} ` : ""}${m.rpm ? m.rpm + "rpm" : ""}${b.ok ? "" : " " + c.red + b.reason + c.reset}`
        );
      });
      break;
    case "/providers":
      for (const p of visibleProviders()) {
        console.log(`  ${c.cyan}${p.id.padEnd(20)}${c.reset} ${c.gray}${p.notes}${c.reset}`);
      }
      break;
    case "/typesafe": {
      const key = await withPicker(rl, () => readSecret("TypeSafe API key (leave empty to cancel): "));
      if (!key) {
        console.log(c.yellow("cancelled — existing TypeSafe key unchanged") + c.reset);
        break;
      }
      state.cfg.typesafe = true;
      state.cfg.typesafeApiKey = key;
      saveConfig(state.cfg);
      process.env.TYPESAFE_API_KEY = key;
      console.log(c.green("✓ TypeSafe enabled for this session and saved configuration") + c.reset);
      break;
    }
    case "/provider":
    case "/add-provider": {
      const prov = arg || (await withPicker(rl, pickProvider));
      if (prov) await configureProvider(state, rl, prov);
      break;
    }
    case "/catalog": {
      const prov = arg || (await withPicker(rl, pickProvider));
      if (!prov) break;
      await configureProvider(state, rl, prov);
      break;
    }
    case "/cwd":
      if (arg) {
        state.cwd = arg;
        state.session.cwd = arg;
        console.log(c.gray(`cwd → ${state.cwd}`) + c.reset);
      } else console.log(`  ${c.gray}${state.cwd}${c.reset}`);
      break;
    case "/yolo":
      state.cfg.yolo = !state.cfg.yolo;
      console.log(state.cfg.yolo ? c.yellow("yolo ON — no confirmations") + c.reset : c.gray("yolo OFF — prompting for dangerous tools") + c.reset);
      break;
    case "/usage":
    case "/cost": {
      if (usageLog.size === 0) {
        console.log(c.gray("no usage this session") + c.reset);
        break;
      }
      let reqs = 0, tin = 0, tout = 0;
      for (const [k, u] of usageLog) {
        console.log(`  ${c.cyan}${k.padEnd(40)}${c.reset} ${u.requests} req  ${u.tokensIn} in  ${u.tokensOut} out`);
        reqs += u.requests; tin += u.tokensIn; tout += u.tokensOut;
      }
      console.log(`  ${c.bold}${"total".padEnd(40)}${c.reset} ${reqs} req  ${tin} in  ${tout} out`);
      break;
    }
    case "/tasks": {
      const tasks = listTasks();
      if (tasks.length === 0) {
        console.log(c.gray("no background tasks — ask the agent to spawn one with the subtask tool") + c.reset);
        break;
      }
      for (const t of tasks) {
        const icon = t.status === "running" ? c.yellow + "●" : t.status === "done" ? c.green + "✓" : c.red + "✗";
        console.log(`  ${icon}${c.reset} ${c.cyan}${t.id}${c.reset} ${c.gray}${t.status} · ${t.toolCalls} tools${c.reset}`);
        console.log(`    ${c.dim}${truncate(t.task, 80)}${c.reset}`);
        if (t.result) console.log(`    ${c.gray}${truncate(t.result, 100)}${c.reset}`);
        if (t.error) console.log(`    ${c.red}${truncate(t.error, 100)}${c.reset}`);
      }
      break;
    }
    case "/subtask":
      if (arg) {
        const t = spawnSubtask(arg, state.pool, state.cfg, state.cwd, {
          onToolStart: (name, a) => console.log(c.gray(`  [${getTask(arg)?.id ?? "sub"}] ${name}`) + c.reset),
        }, (done) => {
          console.log(`\n${c.green}✓ subtask ${done.id} finished${c.reset} ${c.gray}${truncate(done.result ?? done.error ?? "", 80)}${c.reset}\n`);
          rl.prompt();
        });
        console.log(c.gray(`spawned ${t.id}: ${truncate(arg, 70)}`) + c.reset);
      } else console.log(c.red("usage: /subtask <task>") + c.reset);
      break;
    case "/compact":
      await compactSession(state);
      break;
    case "/context": {
      const msgs = state.session.messages;
      const chars = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0);
      const tokens = Math.ceil(chars / 4);
      const max = 128_000;
      const pct = Math.min(100, Math.round((tokens / max) * 100));
      const filled = Math.round(pct / 5);
      const bar = c.green + "█".repeat(filled) + c.gray + "░".repeat(20 - filled) + c.reset;
      console.log(`\n  context ${bar} ${pct}%  (${tokens} / ${max} tokens, ${msgs.length} msgs)\n`);
      break;
    }
    case "/export": {
      const file = arg || `${state.session.id}.md`;
      const { writeFileSync } = await import("node:fs");
      const md = state.session.messages
        .map((m) => `## ${m.role}\n\n${m.content}\n`)
        .join("\n");
      writeFileSync(file, `# harmony session ${state.session.name ?? state.session.id}\n\n${md}`);
      console.log(c.green(`exported to ${file}`) + c.reset);
      break;
    }
    case "/clear-screen":
      console.clear();
      banner(state);
      break;
    case "/exit":
    case "/quit":
      rl.close();
      process.exit(0);
    default:
      console.log(c.red(`unknown command ${cmd}`) + c.reset + c.gray(" — /help for list") + c.reset);
  }
}

async function pickProvider(): Promise<string | undefined> {
  const provs = visibleProviders();
  const picked = await pick(
    "Provider",
    provs.map((p) => ({ label: p.name, hint: p.id, value: p.id }))
  );
  return picked;
}

async function configureProvider(state: TuiState, rl: readline.Interface, prov: string): Promise<void> {
  const def = PROVIDERS[prov as keyof typeof PROVIDERS];
  if (!def) return;

  if (!def.keyless) {
    const key = await withPicker(rl, () => readSecret(`API key for ${def.name} (${def.keyEnv}): `));
    if (!key) {
      console.log(c.yellow("cancelled — no API key entered") + c.reset);
      return;
    }
    state.cfg.apiKeys = { ...(state.cfg.apiKeys ?? {}), [prov]: key };
  }

  const models = CATALOG.filter((m) => m.provider === prov && !m.tags?.some((t) => ["asr", "tts", "image", "embed"].includes(t)));
  const existing = new Set(state.pool.filter((m) => m.provider === prov).map((m) => m.model));
  let added = 0;
  for (const model of models) {
    if (!existing.has(model.model)) {
      state.pool.push({ provider: prov as ModelEntry["provider"], model: model.model, rpm: model.rpm });
      added++;
    }
  }
  state.cfg.models = state.pool;
  saveConfig(state.cfg);
  console.log(c.green(`✓ configured ${def.name}: added ${added} compatible models`) + c.reset);
}

async function readSecret(prompt: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    process.stdout.write(`\n${c.bold}${prompt}${c.reset}`);
    const previous = process.stdin.isRaw;
    let value = "";
    // Read the key in raw mode so terminals do not echo it into the TUI or
    // into `script` recordings. Show a neutral bullet for each character.
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const onData = (data: Buffer) => {
      for (const ch of data.toString()) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          if (process.stdin.isTTY) process.stdin.setRawMode(previous ?? false);
          resolve(value.trim() || undefined);
          return;
        }
        if (ch === "\x03" || ch === "\x1b") {
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          if (process.stdin.isTTY) process.stdin.setRawMode(previous ?? false);
          resolve(undefined);
          return;
        }
        if (ch === "\x7f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          process.stdout.write("•");
        }
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function withPicker<T>(rl: readline.Interface, fn: () => Promise<T>): Promise<T> {
  rl.pause();
  try {
    return await fn();
  } finally {
    rl.resume();
  }
}

async function compactSession(state: TuiState): Promise<void> {
  const msgs = state.session.messages;
  // need enough history to be worth an LLM call: keep last N verbatim + something to summarize
  if (msgs.length < 6) {
    console.log(c.gray("nothing to compact") + c.reset);
    return;
  }

  const KEEP = 4; // recent messages kept verbatim (2 turns of user+assistant/tool)
  const toSummarize = msgs.slice(0, -KEEP);
  const keep = msgs.slice(-KEEP);

  console.log(c.gray("compacting… (LLM summarize)") + c.reset);
  try {
    const resp = await route(
      {
        messages: [
          {
            role: "system",
            content:
              "Summarize the conversation so far for use as compacted context. " +
              "Capture: the user's goals and requests, key decisions made, files read/edited, " +
              "commands run and their outcomes, and anything unresolved. Be factual and dense. " +
              "Do not add commentary — output only the summary.",
          },
          {
            role: "user",
            content:
              toSummarize
                  .map((m) => {
                    const tc = m.tool_calls?.length
                      ? ` [tool calls: ${m.tool_calls.map((t) => t.function.name).join(", ")}]`
                      : "";
                    return `${m.role}: ${truncate((m.content ?? "").replace(/\s+/g, " "), 400)}${tc}`;
                  })
                .join("\n") + "\n\nWrite the summary now.",
          },
        ],
        maxTokens: 1024,
      },
      state.pool,
      undefined,
      "compact conversation history"
    );

    state.session.messages = [
      { role: "user", content: `[earlier conversation summary]\n${resp.content.trim()}\n\n[continue from here]` },
      ...keep,
    ];
    saveSession(state.session);
    console.log(
      c.green(`✓ compacted ${msgs.length} → ${state.session.messages.length} messages`) +
        c.reset +
        c.gray(` via ${resp.entry.provider}/${resp.entry.model} · kept last ${KEEP} verbatim`) +
        c.reset
    );
  } catch (err: any) {
    console.log(c.red(`✗ compact failed: ${err?.message ?? err}`) + c.reset);
  }
}

function printHelp(): void {
  const rows: [string, string][] = [
    ["/help", "this help"],
    ["/new /clear", "fresh session"],
    ["/resume", "pick a saved session"],
    ["/sessions", "list saved sessions"],
    ["/rename <n>", "name current session"],
    ["/delete-session", "remove a saved session"],
    ["/model", "show configured model count; routing is automatic"],
    ["/catalog [prov]", "configure provider and add all models"],
    ["/provider [id]", "configure one provider"],
    ["/pool", "show model pool"],
    ["/providers", "list providers"],
    ["/typesafe", "enter or replace the TypeSafe API key"],
    ["/usage", "token/request usage"],
    ["/context", "context window bar"],
    ["/compact", "summarize older messages"],
    ["/subtask <t>", "spawn background subagent"],
    ["/tasks", "list background tasks"],
    ["/cwd <dir>", "change working dir"],
    ["/yolo", "toggle auto-approve"],
    ["/export [f]", "save transcript as markdown"],
    ["/clear-screen", "redraw"],
    ["/exit", "quit"],
  ];
  for (const [cmd, desc] of rows) {
    console.log(`  ${c.cyan}${cmd.padEnd(20)}${c.reset} ${c.gray}${desc}${c.reset}`);
  }
}

async function agentTurn(state: TuiState, task: string, rl: readline.Interface): Promise<void> {
  const yolo = state.cfg.yolo || process.env.HARMONY_YOLO_SESSION === "1" || process.env.SNEEZE_YOLO_SESSION === "1";
  state.abort = new AbortController();
  let aborted = false;
  const startedAt = Date.now();
  let streamed = "";
  state.abort.signal.addEventListener("abort", () => {
    aborted = true;
  });

  // esc key aborts
  const escHandler: KeyHandler = {
    onKey: (key: string) => {
      if (key === "\x1b") {
        aborted = true;
        state.abort?.abort();
      }
    },
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    escHandler.listener = (d: Buffer) => escHandler.onKey(d.toString(), d);
    process.stdin.on("data", escHandler.listener);
  }

  const events: AgentEvents = {
    onModel: (p, m) => {
      state.lastModel = `${p}/${m}`;
      process.stdout.write(c.gray(`\n  ◦ trying ${p}/${m} · ${elapsed(startedAt)}`) + c.reset + "\n");
    },
    onContent: (d) => {
      streamed += d;
      process.stdout.write(d);
    },
    onCorruption: (_content, reason, provider, model) => {
      const lines = streamed.split("\n").length;
      process.stdout.write("\x1b[2K");
      for (let i = 1; i < lines; i++) process.stdout.write("\x1b[1A\x1b[2K");
      process.stdout.write("\r");
      console.log(c.red(`✗ rejected ${provider}/${model}: ${reason}`) + c.reset);
      console.log(c.yellow("↻ erased bad output; retrying with a new model…") + c.reset);
      streamed = "";
    },
    onToolStart: (name, args) =>
      process.stdout.write(c.cyan(`\n⚡ ${name} `) + c.gray + truncate(JSON.stringify(args), 90) + c.reset + ` ${c.dim}(${elapsed(startedAt)})${c.reset}\n`),
    onToolEnd: (name, result) => {
      const first = result.split("\n")[0];
      const marker = /^ERROR|^EXIT|^ABORTED/.test(first) ? c.red("✗") : c.green("✓");
      process.stdout.write(c.gray(`  ${marker} ${truncate(first, 100)} · ${elapsed(startedAt)}`) + c.reset + "\n");
    },
    confirm: yolo ? undefined : confirmPrompt,
    abortSignal: state.abort?.signal,
    isAborted: () => aborted,
  };

  try {
    const result = await runAgent(
      task,
      state.pool,
      state.cfg,
      state.cwd,
      state.session.messages as ChatMessage[],
      events
    );
    if (result.verification) process.stdout.write(`\nverification: ${result.verificationPassed ? "passed" : "failed"}\n`);
    state.session.messages = result.messages;
    saveSession(state.session);
    console.log("\n");
  } catch (err: any) {
    if (err instanceof AgentAborted || aborted) {
      console.log(c.yellow("\n✗ aborted") + c.reset);
    } else {
      console.log(c.red(`\n✗ ${err?.message ?? err}`) + c.reset);
    }
    saveSession(state.session);
  } finally {
    if (process.stdin.isTTY) {
      if (escHandler.listener) process.stdin.removeListener("data", escHandler.listener);
      process.stdin.setRawMode(false);
    }
    state.abort = null;
  }
}

function elapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
