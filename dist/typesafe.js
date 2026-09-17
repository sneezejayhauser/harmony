import { debugLog } from "./debug-log.js";
import { loadConfig } from "./config.js";
let client;
let sdkPromise;
let disabled = false;
async function getClient() {
    if (disabled)
        return undefined;
    const config = loadConfig();
    if (config.typesafe === false)
        return undefined;
    const apiKey = process.env.TYPESAFE_API_KEY ?? config.typesafeApiKey;
    if (!apiKey)
        return undefined;
    if (!client) {
        try {
            sdkPromise ??= import("@typesafe-ai/sdk").catch((err) => {
                debugLog("typesafe.sdk_unavailable", { error: err?.message ?? String(err) });
                return undefined;
            });
            const sdk = await sdkPromise;
            if (!sdk)
                return undefined;
            client = new sdk.TypeSafeClient({ apiKey, timeout: 5_000 });
        }
        catch (err) {
            debugLog("typesafe.init_error", { error: err?.message ?? String(err) });
            disabled = true;
            return undefined;
        }
    }
    return client;
}
/** Classify a user task. Returns undefined when TypeSafe is unavailable. */
export async function classifyTask(task) {
    const c = await getClient();
    if (!c)
        return undefined;
    try {
        const { choice, score, noul } = await import("@typesafe-ai/sdk");
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
        const classification = {
            kind: kind.choice,
            difficulty: difficulty.score,
            confidence: Math.min(kind.confidence, difficulty.confidence),
            needsTools: res.answers.needsTools.noul,
        };
        debugLog("typesafe.classify", { task: task.slice(0, 120), ...classification });
        return classification;
    }
    catch (err) {
        debugLog("typesafe.error", { error: err?.message ?? String(err) });
        return undefined;
    }
}
