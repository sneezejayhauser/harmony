import * as readline from "node:readline";
import { runAgent } from "./agent.js";
import { saveSession, loadSession, listSessions, newSessionId } from "./config.js";
const C = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
function printHelp() {
    console.log(`${C.bold("commands")}
  /help            this help
  /new             start a fresh session
  /resume [id]     list or resume a saved session
  /sessions        list saved sessions
  /pool            show model pool
  /cwd <dir>       change working directory
  /yolo            toggle auto-approval of dangerous tools
  /typesafe        enter or replace the TypeSafe API key
  /clear           clear screen
  /exit            quit

${C.bold("anything else")} is sent to the agent.`);
}
async function askConfirm(tool, summary) {
    process.stdout.write(`\n${C.yellow(`⚠ ${tool}: ${summary}`)}\n${C.dim("  [y]es / [a]ll / [n]o ")} `);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => rl.question("", (a) => {
        rl.close();
        res(a.trim().toLowerCase());
    }));
    if (answer === "a") {
        process.env.HARMONY_YOLO_SESSION = "1";
        return true;
    }
    return answer === "" || answer === "y" || answer === "yes";
}
async function agentTurn(state, task) {
    const yolo = state.cfg.yolo || process.env.HARMONY_YOLO_SESSION === "1" || process.env.SNEEZE_YOLO_SESSION === "1";
    const events = {
        onModel: (p, m) => process.stdout.write(C.dim(`\n[${p}/${m}]\n`)),
        onContent: (d) => process.stdout.write(d),
        onCorruption: (_content, reason, provider, model) => process.stdout.write(`\n[rejected ${provider}/${model}: ${reason}; retrying]\n`),
        onToolStart: (name, args) => process.stdout.write(C.cyan(`\n⚡ ${name} ${JSON.stringify(args).slice(0, 100)}\n`)),
        onToolEnd: (name, result) => {
            const oneLine = result.split("\n")[0].slice(0, 100);
            process.stdout.write(C.dim(`  ↳ ${oneLine}\n`));
        },
        confirm: yolo ? undefined : askConfirm,
    };
    try {
        const result = await runAgent(task, state.pool, state.cfg, state.cwd, state.session.messages, events);
        state.session.messages = result.messages;
        if (result.verification) {
            process.stdout.write(C.dim(`verification: ${result.verificationPassed ? "passed" : "failed"}\n`));
        }
        if (result.finalText && !result.finalText.includes("\n")) {
            // content was streamed; newline for spacing
        }
        console.log();
        saveSession(state.session);
    }
    catch (err) {
        console.log(C.red(`\n✗ ${err?.message ?? err}\n`));
        saveSession(state.session);
    }
}
export async function startRepl(pool, cfg, cwd) {
    const state = {
        session: { id: newSessionId(), created: new Date().toISOString(), cwd, messages: [] },
        pool,
        cfg,
        cwd,
    };
    console.log(C.bold(`\nharmony`) + C.dim(` — ${pool.length} models in pool · cwd ${cwd}`));
    console.log(C.dim(`session ${state.session.id} · /help for commands\n`));
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: C.green("› "),
    });
    rl.prompt();
    rl.on("line", async (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }
        if (input.startsWith("/")) {
            const [cmd, ...rest] = input.split(/\s+/);
            switch (cmd) {
                case "/help":
                    printHelp();
                    break;
                case "/new":
                    state.session = { id: newSessionId(), created: new Date().toISOString(), cwd: state.cwd, messages: [] };
                    console.log(C.dim(`new session ${state.session.id}`));
                    break;
                case "/resume": {
                    const id = rest[0];
                    if (!id) {
                        const sessions = listSessions().slice(0, 10);
                        if (sessions.length === 0)
                            console.log(C.dim("no saved sessions"));
                        else
                            sessions.forEach((s) => console.log(`  ${s.id}  ${s.messages.length} msgs`));
                    }
                    else {
                        const s = loadSession(id);
                        if (s) {
                            state.session = s;
                            state.cwd = s.cwd;
                            console.log(C.dim(`resumed ${s.id} (${s.messages.length} msgs)`));
                        }
                        else
                            console.log(C.red(`session ${id} not found`));
                    }
                    break;
                }
                case "/sessions":
                    listSessions().slice(0, 20).forEach((s) => console.log(`  ${s.id}  ${s.messages.length} msgs`));
                    break;
                case "/pool":
                    state.pool.forEach((m) => console.log(`  ${m.provider}/${m.model}${m.priority !== undefined ? ` (priority ${m.priority})` : ""}${m.rpm ? ` (${m.rpm} rpm)` : ""}`));
                    break;
                case "/cwd":
                    if (rest[0]) {
                        state.cwd = rest[0];
                        state.session.cwd = rest[0];
                        console.log(C.dim(`cwd → ${state.cwd}`));
                    }
                    break;
                case "/yolo":
                    state.cfg.yolo = !state.cfg.yolo;
                    console.log(C.yellow(`yolo ${state.cfg.yolo ? "ON — no confirmations" : "OFF"}`));
                    break;
                case "/typesafe": {
                    const key = await readSecret("TypeSafe API key: ");
                    if (!key)
                        console.log(C.dim("cancelled — existing TypeSafe key unchanged"));
                    else {
                        state.cfg.typesafe = true;
                        state.cfg.typesafeApiKey = key;
                        const { saveConfig } = await import("./config.js");
                        saveConfig(state.cfg);
                        console.log(C.green("TypeSafe enabled and saved"));
                    }
                    break;
                }
                case "/clear":
                    console.clear();
                    break;
                case "/exit":
                case "/quit":
                    rl.close();
                    process.exit(0);
                default:
                    console.log(C.red(`unknown command ${cmd}, /help for list`));
            }
            rl.prompt();
            return;
        }
        // agent turn — pause the prompt while working
        rl.pause();
        await agentTurn(state, input);
        rl.resume();
        rl.prompt();
    });
    rl.on("close", () => {
        console.log(C.dim("\nbye"));
        process.exit(0);
    });
}
async function readSecret(prompt) {
    if (!process.stdin.isTTY)
        return undefined;
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    return new Promise((resolve) => {
        let value = "";
        const onData = (data) => {
            for (const ch of data.toString()) {
                if (ch === "\r" || ch === "\n") {
                    process.stdin.removeListener("data", onData);
                    process.stdin.setRawMode(false);
                    process.stdout.write("\n");
                    resolve(value.trim() || undefined);
                }
                else if (ch === "\u0003" || ch === "\u001b") {
                    process.stdin.removeListener("data", onData);
                    process.stdin.setRawMode(false);
                    process.stdout.write("\n");
                    resolve(undefined);
                }
                else if (ch >= " ")
                    value += ch;
            }
        };
        process.stdin.on("data", onData);
    });
}
