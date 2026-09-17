import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { checkBudget, chat } from "./llm.js";
import { metadataFor, scoreModel, codingScore } from "./model-data.js";
import { debugLog } from "./debug-log.js";
import { healthCheck, recordHealthFailure, recordHealthSuccess } from "./health.js";
import { capabilitiesFor } from "./catalog.js";
import { classifyTask } from "./typesafe.js";
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** Per-ranked-group round-robin cursor: next call starts where the last one left off.
 *  Persisted to disk so separate one-shot `run` invocations keep rotating. */
const CURSOR_PATH = process.env.HARMONY_CURSOR ?? process.env.SNEEZE_CURSOR ?? `${homedir()}/.config/harmony/cursor.json`;
function loadCursor() {
    try {
        if (existsSync(CURSOR_PATH)) {
            return new Map(Object.entries(JSON.parse(readFileSync(CURSOR_PATH, "utf8"))).map(([k, v]) => [k, v]));
        }
    }
    catch {
        // corrupt cursor — start fresh
    }
    return new Map();
}
function saveCursor(c) {
    try {
        mkdirSync(dirname(CURSOR_PATH), { recursive: true });
        writeFileSync(CURSOR_PATH, JSON.stringify(Object.fromEntries(c)));
    }
    catch {
        // cursor persistence is best-effort
    }
}
const modelCursor = loadCursor();
/**
 * Rank the model pool for the current task using checked-in/live metadata.
 * Availability and provider/model limits are evaluated at call time, so an
 * exhausted high-scoring model falls through safely.
 * Skip rate-limited / budget-exhausted models. On a 429, wait for the
 * cooldown to expire and retry the same model (up to 2 waits) before
 * falling to the next tier — preserving capability-first ordering.
 */
export async function route(req, pool, cb, task = "", preferred, hints) {
    const attempts = [];
    let providerAttempts = 0;
    // Tiny local smoke-test models can answer text but may ignore the tool
    // protocol. Do not let one of them win a coding-agent turn when a capable
    // configured provider is available. If it is the only configured model,
    // retain it as a fallback so simple local prompts still work.
    const toolCapable = req.tools?.length
        ? pool.filter((entry) => capabilitiesFor(entry.provider, entry.model).tools === "yes" || metadataFor(entry).supportsTools === true)
        : pool;
    const candidates = toolCapable.length > 0 ? toolCapable : pool;
    // TypeSafe (System One) classification of the task: kind, difficulty, tool
    // need. Prefer the shared per-turn classification from hints so a whole
    // agent turn costs one API call; classify directly only for standalone
    // route calls. Undefined (no key, error, timeout) = legacy regex decides.
    const classification = hints?.classification ?? (task ? await classifyTask(task) : undefined);
    const codingTask = classification ? classification.kind === "coding" : /\b(fix|implement|add|change|edit|refactor|debug|test|build|code|file|repository|repo)\b/i.test(task);
    // Difficulty gates how much static capability score matters: trivial tasks
    // flatten the ranking so cheap/unlimited models win ties; hard tasks widen
    // the gap so scarce high-capability quota is spent where it pays off.
    const capabilityWeight = classification ? 0.6 + classification.difficulty * 0.4 : 1;
    const ranked = [...candidates].sort((a, b) => {
        const aScore = scoreModel(a, task) * capabilityWeight + (codingTask ? codingScore(a) : 0);
        const bScore = scoreModel(b, task) * capabilityWeight + (codingTask ? codingScore(b) : 0);
        return bScore - aScore;
    });
    // Keep one model for the whole agent turn whenever possible. Switching
    // models between tool calls loses provider-specific formatting and context
    // discipline, which is especially damaging on small/free models.
    if (preferred) {
        const preferredIndex = ranked.findIndex((e) => e.provider === preferred.provider && e.model === preferred.model);
        if (preferredIndex > 0) {
            const [entry] = ranked.splice(preferredIndex, 1);
            ranked.unshift(entry);
        }
    }
    const groups = new Map();
    for (const entry of ranked) {
        const score = Math.round(scoreModel(entry, task));
        const group = groups.get(score) ?? [];
        group.push(entry);
        groups.set(score, group);
    }
    for (const group of groups.values()) {
        const key = group.map((e) => `${e.provider}:${e.model}`).join("|");
        const start = (modelCursor.get(key) ?? 0) % group.length;
        const rotated = [...group.slice(start), ...group.slice(0, start)];
        for (let gi = 0; gi < rotated.length; gi++) {
            const entry = rotated[gi];
            debugLog("route.try", { provider: entry.provider, model: entry.model, attempt: providerAttempts + 1 });
            if (providerAttempts++ >= 12) {
                throw new Error(`Stopped after 12 provider attempts; no reliable model responded.\n` +
                    attempts.map((a) => `  - ${a.entry.provider}/${a.entry.model}: ${a.error ?? "ok"}`).join("\n"));
            }
            const health = healthCheck(entry);
            if (!health.ok) {
                attempts.push({ entry, error: health.reason });
                debugLog("route.quarantined", { provider: entry.provider, model: entry.model, reason: health.reason });
                continue;
            }
            // wait out 429 cooldowns instead of immediately degrading capability
            let waited = false;
            for (let waits = 0; waits < 2; waits++) {
                const budget = checkBudget(entry);
                if (budget.ok)
                    break;
                const cooling = budget.reason?.includes("cooling down");
                if (!cooling) {
                    attempts.push({ entry, error: budget.reason });
                    waited = false;
                    break;
                }
                attempts.push({ entry, error: budget.reason });
                await sleep(2_500);
                waited = true;
            }
            if (waited && !checkBudget(entry).ok)
                continue;
            if (!checkBudget(entry).ok)
                continue;
            try {
                const resp = await chat(entry, req, cb);
                recordHealthSuccess(entry);
                // advance cursor past the model that just succeeded
                modelCursor.set(key, (start + gi + 1) % group.length);
                saveCursor(modelCursor);
                attempts.push({ entry });
                return { ...resp, entry, attempts };
            }
            catch (err) {
                attempts.push({ entry, error: err?.message ?? String(err) });
                debugLog("route.fail", { provider: entry.provider, model: entry.model, error: err?.message ?? String(err) });
                const status = typeof err?.status === "number" ? err.status : undefined;
                const permanent = status === 404 || status === 410;
                const health = recordHealthFailure(entry, err?.message ?? String(err), permanent);
                debugLog("route.health", { provider: entry.provider, model: entry.model, failures: health.failures, quarantineUntil: health.quarantineUntil });
                modelCursor.set(key, (start + gi + 1) % group.length);
                saveCursor(modelCursor);
                debugLog("route.fallback", { from: `${entry.provider}/${entry.model}`, nextAttempt: providerAttempts + 1 });
                continue;
            }
        }
    }
    throw new Error(`All ${pool.length} models exhausted or unavailable.\n` +
        attempts.map((a) => `  - ${a.entry.provider}/${a.entry.model}: ${a.error ?? "ok"}`).join("\n"));
}
