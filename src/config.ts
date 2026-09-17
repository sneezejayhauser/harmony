import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { ProviderId } from "./providers.js";

export interface ModelEntry {
  provider: ProviderId;
  /** exact model id string as the provider API expects — user supplies this */
  model: string;
  /** optional manual priority; lower values are preferred before scored models */
  priority?: number;
  /** per-model rpm override (e.g. Pollinations per-model limits) */
  rpm?: number;
  label?: string;
}

export interface Config {
  models: ModelEntry[];
  /** Provider API keys entered through the interactive setup flow. */
  apiKeys?: Partial<Record<ProviderId, string>>;
  maxTokens?: number;
  systemPrompt?: string;
  /** auto-approve tool calls without prompting (default: prompt for writes/bash) */
  yolo?: boolean;
  /** max context messages kept before trimming (default 40) */
  maxContextMessages?: number;
  /** max agent loop iterations (default 40) */
  maxIterations?: number;
  /** optional session name shown in pickers */
  name?: string;
  /** Anonymous reliability telemetry is disabled unless explicitly enabled. */
  telemetry?: { enabled: boolean; endpoint?: string };
  /** run safe workspace verification after mutating agent turns (default true) */
  verify?: boolean;
  /** maximum verification-driven repair cycles (default 2) */
  maxRepairIterations?: number;
  /** require a short planning turn before repository changes (default false) */
  planning?: boolean;
  /** use TypeSafe (System One) for task classification when TYPESAFE_API_KEY is set (default true) */
  typesafe?: boolean;
}

function configDir(): string {
  return process.env.HARMONY_CONFIG_DIR ?? process.env.SNEEZE_CONFIG_DIR ?? `${homedir()}/.config/harmony`;
}
function sessionsDirPath(): string {
  return `${configDir()}/sessions`;
}
function configFilePath(): string {
  return process.env.HARMONY_CONFIG ?? process.env.SNEEZE_CONFIG ?? `${configDir()}/config.json`;
}

export function configPath(): string {
  return configFilePath();
}
export function sessionsDir(): string {
  return sessionsDirPath();
}

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) return { models: [] };
  return JSON.parse(readFileSync(p, "utf8")) as Config;
}

export function saveConfig(cfg: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

export function defaultConfig(): Config {
  return {
    models: [],
    maxTokens: 4096,
    maxContextMessages: 40,
    yolo: false,
    planning: true,
    systemPrompt:
      "You are harmony, a capable coding agent working in the user's repository. " +
      "Use the provided tools to read, explore, edit, and run code. " +
      "Prefer precise edit_file operations over rewriting whole files. " +
      "When done, summarize what you changed.",
  };
}

// ---------- sessions ----------

export interface Session {
  id: string;
  created: string;
  cwd: string;
  name?: string;
  messages: ChatMessageLite[];
}

export interface ChatMessageLite {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export function saveSession(s: Session): void {
  const dir = sessionsDirPath();
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${s.id}.json`, JSON.stringify(s, null, 2) + "\n");
}

export function loadSession(id: string): Session | undefined {
  const p = `${sessionsDirPath()}/${id}.json`;
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as Session;
}

export function deleteSession(id: string): void {
  const p = `${sessionsDirPath()}/${id}.json`;
  if (existsSync(p)) rmSync(p);
}

export function listSessions(): Session[] {
  const dir = sessionsDirPath();
  if (!existsSync(dir)) return [];
  return readdirSorted(dir)
    .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as Session)
    .sort((a, b) => b.created.localeCompare(a.created));
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
