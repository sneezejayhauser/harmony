# harmony

An interactive coding-agent harness for your terminal. `harmony` uses a maintained catalog of free providers and free models. Provider API keys are access credentials, not Harmony charges: Harmony does not bill users or add a paid service layer. It can read, edit, search, and run commands in a repository
using a single agent loop.

## Installation

### From npm

Install the command globally once:

```bash
npm install --global harmony
```

After that, start the application from any directory:

```bash
harmony
```

The package declares the `harmony` executable and ships its compiled CLI.
Node.js 20 or newer is required. Git and source installs build automatically.

### From GitHub

To use the current repository version before it is published to npm, install
from the tarball URL (npm symlinks `git+https` installs into a cache temp
directory that macOS purges, which leaves a broken `harmony` binary):

```bash
npm install --global https://codeload.github.com/sneezejayhauser/harmony/tar.gz/main
harmony
```

### From a checkout

```bash
git clone https://github.com/sneezejayhauser/harmony.git
cd harmony
npm install
npm link
harmony
```

`npm link` puts the local build on your `PATH`; `npm run build` can be used
after source changes.

## Quick start

1. Configure at least one provider key. For example:

   ```bash
   export OPENROUTER_API_KEY=...
   export INCEPTIONLABS_API_KEY=...
   export TOKENREPLY_API_KEY=...
   export REQUESTY_API_KEY=...
   export LOGFARE_API_KEY=...
   export POLLINATIONS_API_KEY=...
   ```

2. Add the complete compatible text-model catalog:

   ```bash
   harmony add --auto
   ```

   Or add individual models with `harmony add <provider> <model> [priority]`.
   Browse the built-in catalog with `harmony models`.

3. Start the interactive agent:

   ```bash
   harmony
   ```

### Public model metadata

Routing can refresh its model metadata without additional API keys:

```bash
harmony sync-models
```

The sync combines OpenRouter's official `/api/v1/models` catalog with the
public Arena text/code leaderboards, the Hugging Face Open LLM Leaderboard
dataset server, and the latest `Jwrede/llm-bench-data` benchmark snapshot.
OpenRouter supplies the broad model facts—context size, modalities, pricing,
and tool support—and those facts can be matched to equivalent models exposed
through other providers.

### Interactive provider setup

Use the provider flow instead of adding models one by one:

```bash
harmony --catalog
```

Choose a provider, enter its API key when prompted, and harmony will add all
compatible text models for that provider to the local pool. The provider key
and model pool are saved in `~/.config/harmony/config.json`, so they are
available the next time you run `harmony`.

Inside the TUI, `/catalog` or `/provider` opens the same flow. There is no
visible model list in onboarding: selecting a provider configures it and adds
all compatible text models automatically. `/model` only reports the configured
pool; task-aware routing chooses the actual model.

## Providers and routing

All providers currently included in Harmony's catalog are intended to expose
free access paths. Free access can still have provider-side quotas such as RPM,
RPD, token, or fair-use limits. Harmony's `usage` command reports request and
token counters; it does not report monetary charges.

The provider registry is deliberately closed and maintained by the project.
Current providers are:

| Provider | Notes |
| --- | --- |
| `openrouter` | Quality models; account-wide daily and RPM limits |
| `inceptionlabs` | Shared token budget and high RPM limit |
| `tokenreply` | Account-wide 3 RPM limit |
| `requesty` | Account-wide daily limit |
| `logfare` | Account-wide RPM limit |
| `pollinations` | Keyed, per-model limits |

### TypeSafe task classification (optional)

When `TYPESAFE_API_KEY` is set, Harmony asks [TypeSafe](https://typesafe.ai)'s
System One model (`jev-latest`) to classify each task before routing. One
`systemOne` call returns three typed answers:

- **kind** (Choice) — `coding` / `writing` / `analysis` / `chat`. Replaces the
  keyword regex that decides whether coding-benchmark scores boost a model.
- **difficulty** (Score, 0–2) — scales how much static capability scores
  matter, so trivial tasks flatten the ranking (cheap/unlimited models win
  ties) and hard tasks spend scarce high-capability quota where it pays off.
- **needsTools** (Noul) — the probability the task requires repository tools.
  Replaces the keyword regex the agent loop uses to reject text-only answers
  on tasks that needed file inspection.

TypeSafe is not a chat provider and never handles agent turns — it only makes
these routing judgments. Every call is best-effort: no key, a network error,
or a timeout falls back to the legacy heuristics. Disable it entirely with
`"typesafe": false` in the config file.

Routing is model-first rather than provider-tier-first. Each request is ranked
using the model's capability, coding, arena-preference, speed, latency, and
semantic tags. The router then checks that individual model's availability and
its applicable limit bucket before trying it. Rate-limited or exhausted models
fall through to the next ranked model. A per-ranked-group cursor spreads load
across equivalent models, while rate state persists across processes.

The repository can contain a reviewable snapshot at
`data/model-metadata.json`. The built-in catalog remains the safe fallback when
benchmark data is unavailable. Metadata is intentionally optional: routing
continues using catalog tags and neutral default scores.

Runtime reliability

Each request has a 10-second hard timeout by default (`HARMONY_TIMEOUT_MS` can
override it). Failed models accumulate persistent health failures in
`~/.config/harmony/health.json`; repeated failures quarantine a model with an
exponential cooldown. Request routing and model failures are recorded as
secret-free JSONL in `~/.config/harmony/harmony.log` (`HARMONY_LOG` overrides).

Run the synthetic streaming checks and report:

```bash
npm run test:fake-stream
npm run benchmark:report
```

To measure every configured provider model without sending repository data, use
the rate-aware reliability probe:

```bash
# Inspect the plan; sends nothing
npm run test:models -- --dry-run

# Send one tiny READY probe per configured model
npm run test:models -- --confirm --resume
```

The probe uses each provider's configured RPM bucket, spaces requests instead
of bursting, waits after HTTP 429 responses, skips providers without keys, and
writes secret-free JSONL results to
`.agent-recordings/model-reliability.jsonl`. `--resume` skips models already
completed in the output file. The test consumes real provider quota; OpenRouter
and TokenReply are intentionally slow because their limits are account-wide.
Use `--timeout`, `--probe-count`, and `--output` to adjust a run. It sends only
the fixed probe prompt and never reads workspace files.

### Opt-in anonymous telemetry

Telemetry is disabled by default. When enabled, Harmony queues only provider
and model reliability metrics such as success, timeout, rate-limit, corruption,
tool-call count, and latency. It never sends prompts, responses, file paths,
tool arguments, API keys, authorization headers, usernames, or repository names.

```bash
harmony telemetry status
harmony telemetry enable https://your-collector.example/v1/events
harmony telemetry flush
harmony telemetry disable
```

Events are queued locally at `~/.config/harmony/telemetry.jsonl` and uploads are
best-effort with a five-second timeout. The collector endpoint is deliberately
not enabled by default; users must explicitly configure one.

The former `SNEEZE_*` environment names remain accepted as compatibility
aliases, but new configurations should use `HARMONY_*`.

### Agent runtime controls

Use `harmony doctor` to inspect the configured pool, runtime, and missing
provider keys. Tool output is bounded, shell commands can be cancelled, and
the shell timeout can be configured with `HARMONY_TOOL_TIMEOUT_MS` (default 60
seconds). Model requests use `HARMONY_TIMEOUT_MS` (default 10 seconds).

One-shot runs report an explicit lifecycle status—`completed`, `cancelled`, or
`max_iterations`—along with iteration, tool-call, and file-change counts.
Permanent model errors such as HTTP 404 and 410 are quarantined separately from
transient failures.

New configurations enable a planning turn before execution. The plan records
the objective, implementation steps, and verification guidance; set
`planning: false` for low-latency runs. During execution, Harmony emits
structured planning, execution, verification, repair, and completion progress.
For coding tasks, routing gives additional weight to models with coding and
tool-use metadata rather than relying only on general model scores.

After a mutating agent turn, Harmony automatically runs `git diff --check` and
the first available project script from `test`, `check`, `build`, or `lint`.
If a check fails, the failure output is sent back to the model for up to two
repair cycles. A task is completed only when verification passes; otherwise it
ends with `failed`. Use `harmony verify` to run the same checks directly. Set
`verify: false` in the config file to disable automatic verification. Configure
the repair limit with `maxRepairIterations`.

`harmony run -p "..."` exits with code `0` only for a completed task. Failed
verification, failed quality gates, and max-iteration runs return `1`; a user
cancellation returns `130`. File tools reject paths outside the workspace,
including symlink escapes.

Runs are recorded as secret-free summaries in
`~/.config/harmony/recordings.jsonl` (override with `HARMONY_RECORDINGS`) and
can be viewed with `harmony runs`. Recordings contain status and bounded
metrics, not prompts, model responses, API keys, or tool arguments. Run the
deterministic task benchmark with `npm run benchmark:tasks`.

### Model metadata sources

The metadata sync layer accepts normalized JSON from the two initial sources:

- Artificial Analysis, configured with `HARMONY_ARTIFICIAL_ANALYSIS_URL` and
   `ARTIFICIAL_ANALYSIS_API_KEY`.
- LMArena/Chatbot Arena, configured with `HARMONY_LMARENA_URL`.

Run a sync after setting those variables:

```bash
HARMONY_ARTIFICIAL_ANALYSIS_URL=https://... \
HARMONY_LMARENA_URL=https://... \
harmony sync-models
```

The URLs are configurable because both services may expose different preview,
dataset, or proxy endpoints over time. The command merges fetched rows with
the built-in catalog and writes the snapshot to `data/model-metadata.json`
(override the path with `HARMONY_METADATA`). Do not commit API keys or private
raw responses. A future adapter can add `llm-bench-data` performance rows
without changing the router interface.

Useful commands:

```bash
harmony setup                 # show key and pool setup help
harmony providers             # list provider limits
harmony models [provider]     # browse the model catalog
harmony add --auto            # add all catalog text models
harmony sync-models           # refresh optional benchmark metadata
harmony pool                  # show the configured pool
harmony status                # show rate and budget state
harmony usage                 # show this process's free-provider quota usage
```

## Interactive TUI

Running `harmony` without arguments opens the streaming TUI. You can enter
another request while a turn is running; it is queued for the next turn. Press
Esc to abort a turn and terminate an in-flight shell command.

Available slash commands:

```text
/help                 Show commands
/new                  Start a new session
/resume [id]          Resume a saved session
/sessions             List saved sessions
/rename <name>        Rename the current session
/delete-session       Delete a saved session
/model                Show configured model count; routing is automatic
/catalog              Choose a provider and add all compatible models
/pool                 Show the configured model pool
/providers            List providers
/usage                Show session usage
/context              Show context-window usage
/compact              Summarize older history
/subtask <task>       Start a background subagent
/tasks                Show background subagents
/cwd <directory>      Change the working directory
/yolo                 Toggle automatic approval of dangerous tools
/clear-screen         Clear the terminal
/export [file]        Export the transcript as Markdown
/exit                 Save and exit
```

Dangerous tools such as `bash`, file writes, patches, and deletion ask for
approval unless `/yolo` is enabled. `/compact` uses the selected LLM to
summarize older history, keeps the last four messages verbatim, and leaves the
session unchanged if summarization fails.

## One-shot mode

```bash
harmony run "refactor src/ to use async/await"
harmony -p "find and explain the failing tests"
harmony run "apply the migration" --yolo
harmony run "continue the work" --resume <session-id>
```

## Configuration and sessions

Configuration and sessions are stored by default under:

```text
~/.config/harmony/config.json
~/.config/harmony/sessions/
```

Override these locations when testing or isolating profiles:

```bash
HARMONY_CONFIG_DIR=./.harmony harmony
HARMONY_CONFIG=./test-config.json harmony status
```

The configuration includes the model pool, maximum output tokens, context
limits, system prompt, iteration limit, and the default approval mode.

## Comparing other coding-agent TUIs

The repository includes terminal-recording launchers for comparing Harmony
with Claude Code, OpenCode, and Codex. Install the clients separately, then
run one of these commands from the repository root:

```bash
./scripts/record-opencode-tui.sh
./scripts/record-codex-tui.sh
./scripts/record-claude-tui.sh
```

Or use the dispatcher:

```bash
./scripts/record-agent-tui.sh opencode
```

Each session is saved as a `*.typescript` terminal recording under
.agent-recordings/` (override the directory with
`HARMONY_AGENT_RECORD_DIR=/path/to/records`). OpenCode and Codex can be
configured with their own model providers. Claude Code requires an
Anthropic-compatible endpoint and credentials.

## Development and mock mode

Build and run the local CLI:

```bash
npm install
npm run build
node dist/index.js --help
```

The hidden mock provider can exercise the real agent and tools without API
keys:

```bash
HARMONY_CONFIG=./test-pool.json \
HARMONY_MOCK=1 \
HARMONY_MOCK_SCRIPT=./mock-script.json \
harmony run "audit the loop"
```

The mock script is a JSON list of tool calls followed by a final response. It
executes the real tools against the current repository.

## License

MIT
