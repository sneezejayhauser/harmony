import { TypeSafeClient, choice, score, noul } from "@typesafe-ai/sdk";
import { debugLog } from "./debug-log.js";
import { loadConfig } from "./config.js";

/**
 * TypeSafe (System One) task classification.
 *
 * One `systemOne` call asks three atomic questions about the user's task and
 * returns typed answers the router and agent loop can branch on directly:
 *
 *   kind       (Choice) — what sort of task is this?
 *   difficulty (Score)  — 0..2, how much model capability does it need?
 *   needsTools (Noul)   — does answering require repository tools?
 *
 * This replaces keyword regexes with a calibrated model judgment. Everything
 * here is best-effort: no API key, a network error, or a timeout all resolve
 * to `undefined`, and callers fall back to the legacy heuristics.
 */

export type TaskKind = "coding" | "writing" | "analysis" | "chat";

export interface TaskClassification {
  kind: TaskKind;
  /** 0 = trivial, 1 = moderate, 2 = hard (probability-weighted, can land between levels) */
  difficulty: number;
  /** confidence of the kind/difficulty answers, 0..1 */
  confidence: number;
  /** probability that the task requires repository tools, 0..1 */
  needsTools: number;
}

let client: TypeSafeClient | undefined;
let disabled = false;

function getClient(): TypeSafeClient | undefined {
  if (disabled) return undefined;
  if (loadConfig().typesafe === false) return undefined;
  if (!process.env.TYPESAFE_API_KEY) return undefined;
  if (!client) {
    try {
      client = new TypeSafeClient({ timeout: 5_000 });
    } catch (err: any) {
      debugLog("typesafe.init_error", { error: err?.message ?? String(err) });
      disabled = true;
      return undefined;
    }
  }
  return client;
}

/** Classify a user task. Returns undefined when TypeSafe is unavailable. */
export async function classifyTask(task: string): Promise<TaskClassification | undefined> {
  const c = getClient();
  if (!c) return undefined;
  try {
    const res = await c.systemOne({
      state: { task },
      questions: {
        kind: choice("What kind of task is the user asking for?", {
          coding: "Writing, editing, debugging, testing, or explaining code or repository files",
          writing: "Composing prose: emails, docs, essays, summaries of provided text",
          analysis: "Reasoning, comparing, planning, or answering questions that need thought but no code changes",
          chat: "Small talk, greetings, or simple factual questions",
        }),
        difficulty: score("How difficult is this task for an AI model?", [
          "Trivial: a small or weak model can handle it",
          "Moderate: needs a competent general model",
          "Hard: needs the strongest available model",
        ]),
        needsTools: noul("Does completing this task require reading, searching, editing, or running files in a code repository?"),
      },
    });
    const kind = res.answers.kind;
    const difficulty = res.answers.difficulty;
    const classification: TaskClassification = {
      kind: kind.choice as TaskKind,
      difficulty: difficulty.score,
      confidence: Math.min(kind.confidence, difficulty.confidence),
      needsTools: res.answers.needsTools.noul,
    };
    debugLog("typesafe.classify", { task: task.slice(0, 120), ...classification });
    return classification;
  } catch (err: any) {
    debugLog("typesafe.error", { error: err?.message ?? String(err) });
    return undefined;
  }
}
