import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
function configDir() {
    return process.env.HARMONY_CONFIG_DIR ?? process.env.SNEEZE_CONFIG_DIR ?? `${homedir()}/.config/harmony`;
}
function sessionsDirPath() {
    return `${configDir()}/sessions`;
}
function configFilePath() {
    return process.env.HARMONY_CONFIG ?? process.env.SNEEZE_CONFIG ?? `${configDir()}/config.json`;
}
export function configPath() {
    return configFilePath();
}
export function sessionsDir() {
    return sessionsDirPath();
}
export function loadConfig() {
    const p = configPath();
    if (!existsSync(p))
        return { models: [] };
    return JSON.parse(readFileSync(p, "utf8"));
}
export function saveConfig(cfg) {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    try {
        chmodSync(p, 0o600);
    }
    catch { /* best effort on filesystems without POSIX permissions */ }
}
export function defaultConfig() {
    return {
        models: [],
        maxTokens: 4096,
        maxContextMessages: 40,
        yolo: false,
        planning: true,
        systemPrompt: "You are harmony, a capable coding agent working in the user's repository. " +
            "Use the provided tools to read, explore, edit, and run code. " +
            "Prefer precise edit_file operations over rewriting whole files. " +
            "When done, summarize what you changed.",
    };
}
export function saveSession(s) {
    const dir = sessionsDirPath();
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${s.id}.json`, JSON.stringify(s, null, 2) + "\n");
}
export function loadSession(id) {
    const p = `${sessionsDirPath()}/${id}.json`;
    if (!existsSync(p))
        return undefined;
    return JSON.parse(readFileSync(p, "utf8"));
}
export function deleteSession(id) {
    const p = `${sessionsDirPath()}/${id}.json`;
    if (existsSync(p))
        rmSync(p);
}
export function listSessions() {
    const dir = sessionsDirPath();
    if (!existsSync(dir))
        return [];
    return readdirSorted(dir)
        .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")))
        .sort((a, b) => b.created.localeCompare(a.created));
}
function readdirSorted(dir) {
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
}
export function newSessionId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
}
