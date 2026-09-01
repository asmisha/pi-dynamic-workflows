# pi-dynamic-workflows

[![npm](https://img.shields.io/npm/v/@quintinshaw/pi-dynamic-workflows?color=cb3837&logo=npm)](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev)

> **Claude Code–style dynamic workflows for [Pi](https://pi.dev).**
> Turn one prompt into a fleet of subagents that fan out in parallel, cross-check each other, and hand back a single synthesized answer.

**[Website](https://quintinshaw.github.io/pi-dynamic-workflows/) · [npm](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows) · [Pi package](https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows) · [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows)**

![pi-dynamic-workflows demo](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/demo.gif)

Instead of one model grinding a task step by step, Pi writes a small JavaScript **orchestration script** that spawns many subagents at once, keeps the intermediate work in script variables (not your chat context), and returns only the result. It's the "code mode for subagents" from Claude Code — on any model Pi can reach.

Built for **codebase-wide audits, multi-perspective review, large refactors, and cross-checked research** — anything one context window can't hold.

## Install

```bash
pi install npm:@quintinshaw/pi-dynamic-workflows
```

Then `/reload` in Pi. You get the `workflow` tool plus the `/workflows` management commands.

### Use from Node

For a Node ESM application, install the library and its Pi SDK peers:

```bash
npm install @quintinshaw/pi-dynamic-workflows \
  @earendil-works/pi-coding-agent @earendil-works/pi-tui typebox
```

A source-only git install uses the same API and does not need a package build. Declare the git dependency in the consumer's `package.json`, commit the resulting lockfile, and use `npm ci` for reproducible installs:

```bash
npm install \
  github:asmisha/pi-dynamic-workflows#main \
  @earendil-works/pi-coding-agent @earendil-works/pi-tui typebox
```

Import the stable one-shot API through the public `node-api` subpath. It is a plain-JavaScript entrypoint that loads the package's shipped TypeScript through its own `tsx` runtime dependency. The caller runs plain `node`: it does not need a TypeScript loader, a build step, or knowledge of the package's `src/` layout. Loading is anchored to the installed package, not the calling process's current directory.

The object form of `runWorkflow` loads Pi's agent directory, settings, model catalog, and authentication, then waits for the workflow's real terminal `WorkflowRunResult`:

```js
// run-audit.mjs
import { runWorkflow } from '@quintinshaw/pi-dynamic-workflows/node-api'

const controller = new AbortController()

const completed = await runWorkflow({
  script: `export const meta = {
    name: 'node_audit',
    description: 'Audit targets supplied by the caller',
  }
  const findings = await parallel(args.targets.map((target) =>
    () => agent('Audit ' + target, { tier: 'small', readOnly: true })
  ))
  return { findings, project: cwd }`,
  args: { targets: ['src/auth.ts', 'src/routes.ts'] },
  cwd: process.cwd(),
  mainModel: 'anthropic/claude-sonnet-4-5',
  signal: controller.signal,
  persistLogs: false,
})

console.log(completed.result)
console.log(completed.agentCount, completed.tokenUsage, completed.durationMs)
```

Reusable workflows can be trusted native ESM. Relative `scriptPath` values resolve from `cwd` (or `process.cwd()` when `cwd` is omitted), and imports inside the module resolve normally from the module file:

```js
// workflows/review.mjs
import { summarize } from './summarize.mjs'

export const meta = { name: 'node_review', description: 'Review one target' }

export async function run({ agent, args, cwd }) {
  const review = await agent(`Review ${args.target} under ${cwd}`, {
    model: args.model,
    readOnly: true,
  })
  return summarize(review)
}
```

```js
// workflows/summarize.mjs
export function summarize(review) {
  return { summary: review.trim() }
}
```

```js
// run-review.mjs
import { runWorkflow } from '@quintinshaw/pi-dynamic-workflows/node-api'

const completed = await runWorkflow({
  scriptPath: './workflows/review.mjs',
  args: { target: 'src/', model: 'openai/gpt-5.4' },
  cwd: process.cwd(),
})

console.log(completed.result)
```

Pass exactly one of `script` or `scriptPath`.

| Option | Semantics |
| --- | --- |
| `script` / `scriptPath` | Inline VM source, or a trusted native ESM entry point exporting `meta` and `run(context)`. Exactly one is required. |
| `args` | Any caller-owned value exposed as `args` (or `context.args`) without interpretation. |
| `cwd` | Base directory for path resolution and default agent/bash work. Relative values resolve from the calling process's current directory. This is also the Pi project trust boundary: setup loads that project's configured package sources and `.pi/extensions` (resolving/installing packages when needed) and executes extension code, so use only a trusted directory. |
| `mainModel` | Exact `provider/modelId` used by untagged agents and as the fallback route for an unconfigured tier. |
| `signal` | Run-level `AbortSignal`, forwarded to agent and bash work. Cancellation rejects with `WorkflowErrorCode.WORKFLOW_ABORTED`; trusted native JS is not forcibly preempted between runtime calls. |
| `agentTimeoutMs` | Per-agent attempt timeout. `null` means no hard timeout. An individual `agent(..., { timeoutMs })` overrides it. This is not a whole-workflow deadline. |
| `concurrency` / `agentRetries` | Run-level agent concurrency and recoverable retry limits; per-agent options still take precedence. |
| `persistLogs`, `artifactCwd`, `runId` | Control one-shot log/bash artifacts and their run identity. Logs persist by default; this does not create managed run state. |
| callbacks | The progress, phase, agent, usage, and log callbacks from `WorkflowRunOptions` observe the in-process run. |
| `agent`, `agentRegistry`, `tools`, `instructions` | Advanced injection/customization boundaries for tests and embedded hosts. Ordinary callers do not need Pi SDK plumbing. |

`WorkflowRunResult<T>` contains the validated workflow `meta`, returned `result`, collected `logs` and `phases`, `agentCount`, `durationMs`, `runId`, and cumulative `tokenUsage`/cost. The promise resolves only after the workflow and its awaited runtime-owned work finish; workflow, module-load, model, timeout, and abort errors reject it rather than being converted into a result.

The object API resolves `PI_CODING_AGENT_DIR` or `~/.pi/agent`, reads `auth.json`, `models.json`, and effective settings through public `@earendil-works/pi-coding-agent` APIs, composes configured provider extensions, and creates one `ModelRuntime` plus one shared `ModelRegistry` per run. SDK catalog refreshes do not use the network during setup. The same runtime is passed to every subagent session in that run, while each concurrent session keeps isolated extension state. If `mainModel` is omitted, the configured default provider/model is used when both are present; tiers come from `~/.pi/workflows/model-tiers.json`. `mainModel`, a script's explicit `agent(..., { model })`, and `fallbackModel` use unambiguous `provider/modelId` specs. Existing phase/meta routes, agent-type definitions, and tier settings may also use a bare model id; the shared registry resolves it using the same available-first policy as `WorkflowAgent`. Every selected route, including configured routes, must exist and be authenticated. An unavailable route fails before that agent starts; only an explicit `fallbackModel` permits a different model.

`AbortSignal` is checked during setup and around workflow runtime calls, and aborts active agent/bash work. Trusted native module code is not forcibly preempted while it is between runtime calls; if it creates other asynchronous work, that code must settle or observe a caller-supplied signal itself. `agentTimeoutMs` and per-agent `timeoutMs` bound individual agent attempts; `bash(..., { timeoutMs })` bounds one shell step. Inline code has no timers. There is deliberately no implicit whole-workflow timeout.

Common failures are rejected directly: source-selection and inline validation errors, native ESM load/export errors, unavailable or unauthenticated models, classified `WorkflowError`s from agent/bash/checkpoint execution, and errors thrown by workflow code. A one-shot `checkpoint()` rejects with `CHECKPOINT_INPUT_REQUIRED` because this API has no reply/resume lifecycle.

`runWorkflow({ ... })` is awaited one-shot execution: the calling process owns the run and must remain alive until the promise settles. It does **not** persist `WorkflowManager` state or provide durable resume, retry, pause, checkpoint replies, or terminal delivery. Use `WorkflowManager.startInBackground()` when the program needs those managed-run paths:

```js
import { WorkflowManager } from '@quintinshaw/pi-dynamic-workflows'

const manager = new WorkflowManager({ cwd: process.cwd() })
const { runId, promise } = manager.startInBackground(inlineScript, args)
console.log('started', runId)

// Await this when the Node process must stay alive for terminal completion.
const completed = await promise
```

The manager starts asynchronously and persists run/journal state for its resume/retry APIs; its returned promise is still the terminal result for this process. The Pi extension's `workflow` tool is different again: it always launches through the manager in the background, ends the current Pi turn immediately, updates the live panel, and delivers completion or checkpoint events back to the parent conversation.

The original low-level `runWorkflow(script, options)` signature remains supported for existing consumers and injected hosts. New standalone Node callers should use the object form so the package owns Pi runtime/model setup. The built package root still exports `runWorkflow` for existing published/built consumers; source-only git consumers should use the `node-api` subpath because the root export remains backed by `dist/`.

## Try it

Ask in plain language:

```text
Run a workflow to audit every route under src/routes/ for missing auth checks.
```

Pi writes the script and runs it in the background — your turn ends immediately and a live panel tracks progress while you keep working. To force a workflow explicitly, run `/workflows run <prompt>`.

## What a workflow looks like

Inline workflows are plain JavaScript: the first statement exports literal metadata, then the script orchestrates with runtime globals:

```js
export const meta = {
  name: 'auth_audit',
  description: 'Find routes missing auth checks and verify the findings',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }],
}

phase('Scan')
const files = await agent('List every route file under src/routes/.', { tier: 'small', readOnly: true })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`Audit ${file} for missing auth checks.`, { tier: 'medium', readOnly: true }),
  ),
)

phase('Verify')
return await agent('Synthesize and double-check these findings:\n' + findings.join('\n\n'), { tier: 'big', readOnly: true })
```

`agent()` spawns an isolated subagent, `parallel()` runs many at once, `phase()` groups them in the live view, and `tier` routes each one to the right model. That's the whole idea.

Reusable file-backed workflows are trusted native ESM modules, so they can use normal JavaScript imports:

```js
// workflow.mjs
import { audit } from './audit.mjs'

export const meta = { name: 'shared_audit', description: 'Audit with shared code' }

export async function run(context) {
  return await audit(context, context.args.target)
}

// audit.mjs
export async function audit({ agent, checkpoint }, target) {
  const answer = await checkpoint(`Audit ${target}?`)
  return await agent(`Audit ${target}; user answer: ${answer}`, { readOnly: true })
}
```

Pass `workflow.mjs` through `scriptPath`. The exported `run(context)` receives the same `agent`, `parallel`, `pipeline`, `phase`, `bash`, `checkpoint`, `log`, `args`, `cwd`, and `runId` APIs available as globals in inline workflows. Native modules execute as trusted Node.js code; keep the entry and imported source files unchanged while a run remains resumable.

## Highlights

- **Fan-out orchestration** — `agent()`, `parallel()`, `pipeline()`, `phase()` in a sandboxed script. Up to 16 run concurrently; total subagents are not capped, and intermediate results stay in variables rather than the chat.
- **Real model routing** — `small` / `medium` / `big` tiers (or an exact `model`) per agent. It actually switches the subagent's model — cheap work on a light one, hard synthesis on a big one.
- **Automatic + durable retry** — read-only agents retry one recoverable failure automatically. If a retryable failure is exhausted, the same run pauses; `/workflows retry` reruns only failed calls while completed agent, shell, and checkpoint work replays without side effects.
- **Real token & cost accounting** — read from each subagent's session, not estimated.
- **Background by default** — the turn ends right away, a live "Workflows running" panel tracks runs, and each result is delivered back so the conversation auto-continues when it finishes. The panel is compact by default; `/workflows-progress detailed` expands it inline to per-phase/per-agent rows with tokens, cost, and a live tok/s rate (so a stalled agent shows as 0 tok/s) — no need to open `/workflows`.
- **Interactive `/workflows` TUI** — drill runs → phases → agents → detail; inspect per-agent failures and compact subagent history; pause, stop, restart, or remove runs from the keyboard.

## How it maps to Claude Code dynamic workflows

The same model — on Pi, plus the production pieces a real run needs:

| Claude Code dynamic workflows | pi-dynamic-workflows (on Pi) |
| --- | --- |
| Code-mode orchestration — the model writes a script that drives subagents | A JS `workflow` tool running inline scripts in a VM or trusted file-backed workflows as native ESM |
| Subagents with isolated context | Fresh in-memory Pi sessions; results held in script variables, not the chat |
| Structured outputs | JSON-Schema `schema` → a validated object, with bounded repair if the model misses |
| Background runs | Non-blocking by default, a live task panel, and auto-continue delivery |
| Resume | **Journaled + replayable** — survives restarts and replays the unchanged prefix |
| Model selection | **Per-agent / per-phase routing** across any provider Pi is authenticated for |
| — | **Real cost accounting** and persisted diagnostics |

## Commands

```text
/workflows                  open the interactive navigator (plain list in print mode)
/workflows status <id>      watch a run live; print its result when it finishes
/workflows pause|resume|retry|stop|rm <id>
/workflows run <prompt>     force a dynamic workflow from <prompt> on demand;
                            the run shows in the panel + /workflows.
/subtask <task>             persist the active conversation branch and run <task> in the child
/workflows continue <id> <instruction>
                            continue a terminal fork run on its saved child session with a new run ID
/workflows-progress compact|detailed|status
                            switch the live panel between the compact one-liner and the detailed
                            per-phase/per-agent view (with tokens, cost, and a live tok/s rate)
/workflows-progress-max <N> cap agents shown per phase in detailed mode (1-1000, default 8)
/workflows-models           map the small / medium / big tiers to real models
```

Agents can inspect and control current-session runs directly with the `workflow_status`, `workflow_pause`, `workflow_resume`, `workflow_retry`, and `workflow_stop` tools; the slash commands remain available for manual control. `workflow_status` is for one-off checks only — the tool contract tells the model never to poll it or `sleep` while waiting, because completion, failure, and checkpoint delivery wakes the conversation on its own. A background completion notification stays one line and points to `<runId>.stdout`, which contains the complete untruncated workflow return value.

In the navigator: `↑/↓` select · `enter`/`→` open · `esc`/`←` back · `p` pause · `x` stop · `d` remove · `r` restart · `q` quit. Each agent shows the model it ran on; the detail view shows its prompt, result, error diagnostics, and compact message/tool history.

## Storage

Workflow state is stored under `~/.pi/workflows` so projects do not accumulate extension-owned `.pi/workflows` directories. Global settings and model tiers live at `~/.pi/workflows/settings.json` and `~/.pi/workflows/model-tiers.json`; persistent fork sessions live under `~/.pi/workflows/sessions/`; project-scoped run history, resume journals, and locks live under `~/.pi/workflows/projects/<project>/`. Removing a run does not delete its child session. Older project-local `.pi/workflows/runs` data is still read as a fallback. Saved-workflow JSON is intentionally neither read nor mutated.

## Reference

The essentials:

| Global | What it does |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text, or a validated object with `opts.schema`; exhausted recoverable failures throw a classified `WorkflowError` with diagnostics in `/workflows`. |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently; results keep input order on success and ordinary branch errors reject the fan-out. For best effort, catch inside each branch, not on `parallel(...)`, because sibling branches can still be running when the aggregate rejects. |
| `pipeline(items, ...stages)` | Fan items through sequential stages `(prev, original, index)`; branch errors reject the pipeline unless caught inside that branch/stage. Do not catch only the aggregate while continuing with more workflow work. |
| `bash(cmd, { cwd?, timeoutMs? })` | Run a shell command; returns `{ pid, exitCode, stdoutFile, stderrFile }`. Full stdout/stderr are written to those files and journaled like `agent()`, so resume replays paths without re-running. Pass file paths to `agent()` for analysis. |
| `phase(title)` | Group agents in the live view. |
| `runId` | This run's id — the one naming its persisted state, log, and bash artifacts. Assigned once and unchanged by resume/retry, so use it (never an id invented in the script, which would change on replay and break journal identity) when a run needs its own artifact or `sessionPath` values. |
| `checkpoint(question)` | Always pauses the run and transfers a durable question to the parent conversation. Continue the same run with the host `workflow({ resumeRunId, reply })` tool call; completed steps replay from the journal. |
| Agent option | Description |
| --- | --- |
| `tier` | `"small"` \| `"medium"` \| `"big"` — coarse model routing (configure via `/workflows-models`). |
| `model` | Exact `provider/modelId` (always wins over `tier`). |
| `thinking` | Reasoning effort for one agent: `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`. Independent of `model`/`tier` — each model translates the level through its own thinking-level map, so the same name works across providers. Omit it to keep the session default. Changing it invalidates that call's cached result on resume. |
| `fallbackModel` | Exact backup model. If the primary is unauthenticated, hits a provider usage limit, or stops answering (gateway/overload errors after the SDK's own retries), the same subagent session continues on this model with its transcript and completed tool work intact. |
| `agentType` | A named definition (`.pi/agents/<name>.md`) binding a tool allow/deny policy + model + role prompt. Under `readOnly`, its allowlist is final across built-in and extension tools after read-only hard denials. |
| `cwd` | Run this agent in a different working directory (tools + session bind to it). |
| `forkFrom` | Fork an existing Pi session file (JSONL) as starting context. The source file is never mutated; without `sessionPath`, the fork is temporary. |
| `sessionPath` | Persist/continue this agent's working session. Existing files are continued; missing files are created. Relative paths resolve under `~/.pi/workflows/sessions/`. Combined with `forkFrom`, the target must not already exist. |
| `schema` | JSON Schema → the subagent returns a validated object. |
| `label` / `phase` / `timeoutMs` | Display label / phase override / optional per-agent hard timeout. Omit `timeoutMs` for no hard timeout. |
| `retries` | Explicit retry attempts after a recoverable failure for this agent. Overrides all defaults; use `0` to disable automatic retry. |
| `retryable` | Whether automatic retries or `/workflows retry` may rerun this agent. Default `true`; set `false` for any agent that can duplicate side effects. |
| `readOnly` | Set `true` for reviewers/searchers. Without a named tool policy, it keeps the fixed repository read/search set and, on macOS, a sandboxed `bash` for read-only Git inspection. A resolved `agentType` can retain explicitly named non-mutating extension tools, while repository mutators, unrestricted shell, and workflow controls stay blocked. Writes are limited to isolated `$HOME`/`$TMPDIR`; unsupported platforms omit `bash` rather than falling back to unrestricted execution. It defaults to one automatic retry unless `retries` overrides it. |

A live `checkpoint()` never guesses or supplies a default. The manager persists its prompt, call index, and hash, releases the run lease, and asks the parent conversation. The host `workflow({ resumeRunId: "...", reply: ... })` tool call validates the reply, journals it, and resumes the same run ID. The script executes from the top, but the unchanged completed prefix is replayed without rerunning agents or shell commands. Workflows may pause at multiple sequential checkpoints; each reply continues the same run until the next checkpoint or completion. `/workflows resume` is for paused/interrupted runs; `/workflows retry` is for runs paused by retryable agent failures. Ordinary failed runs remain terminal.

Subagent sessions are temporary by default. Use `sessionPath` only when a reviewer/worker should keep context across runs; use `forkFrom` when it should start from an existing Pi conversation. Persistent-session writers are serialized across runs and processes, so a second writer waits until the current AgentSession finishes cleanup. Workflow subagents bind extensions headlessly, so the configured compaction/autocontinue extension lifecycle applies normally.

By default, workflows do not set a per-agent hard timeout. Use the `workflow` tool's `agentTimeoutMs` or per-agent `timeoutMs` only when you want an explicit time bound. A global fallback timeout can also be set in `~/.pi/workflows/settings.json` as `{ "defaultAgentTimeoutMs": 600000 }`; set it to `null` or omit it for no default hard timeout.

For flakier fan-outs, the `workflow` tool accepts `agentRetries` (run-level retry attempts after recoverable agent failures), which can be defaulted in `~/.pi/workflows/settings.json`. Per-agent `retries` overrides the run value. Read-only agents get at least one automatic retry by default. Other agents default to `0`, and side-effecting agents must set `retryable: false`. Nonrecoverable errors never retry.

`fallbackModel` is deliberately narrower than retry: it activates only when the primary model lacks availability/authentication, reaches a provider usage limit, or stops answering with a gateway/overload error. A mid-task handoff switches the existing subagent session rather than launching another agent, so an editing agent retains its transcript and completed side effects. If the backup model is itself unavailable, the call fails before starting.

The live "Workflows running" panel is configured in the same `~/.pi/workflows/settings.json`: `"progressPanelMode"` is `"compact"` (default, one line per run) or `"detailed"` (per-phase/per-agent rows with tokens, cost, and a live tok/s rate), and `"progressPanelMaxAgents"` (default `8`, range `1`–`1000`) caps how many agents each phase shows in detailed mode before a `… N earlier agents` line. Toggle them live with `/workflows-progress compact|detailed` and `/workflows-progress-max <N>` — changes take effect on the next render without a restart.

Inline workflows run in a Node `vm` sandbox; `Date.now()`, `Math.random()`, `new Date()`, and `require`/`import`/`fs`/network are unavailable. File-backed `scriptPath` workflows are trusted native ESM modules and are responsible for remaining deterministic and unchanged while a run is resumable.

## Development

```bash
npm install
npm test     # biome + tsc + unit tests
```

After local code changes, rebuild and reinstall the extension from this checkout:

```bash
npm run build && pi install .
```

Then restart/reload Pi so the next session loads the rebuilt extension. `pi list` should show this repo path for the installed package.

Do not manually run `npm install` or `npm run build` inside an *installed* package directory. Pi's installer owns the initial `npm install --omit=dev`, and `pi update --extensions` resets the checkout, cleans it, and reinstalls runtime dependencies. Pi loads `extensions/workflow.ts` and its `src/` imports directly; the public `node-api` subpath loads the same shipped source through the package's `tsx` dependency. `dist/` remains the built root export. A manual plain `npm install` adds a second Pi SDK copy that wins over the host's peer dependency, and the extension then silently runs whatever version that copy pins.

Every feature is also verified end-to-end against a real Pi subagent session before release.

## Credits

The "code mode for subagents" idea comes from Michael Livs' original [pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) and Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code). This project builds on it with real model routing, journaled resume, cost accounting, and an interactive TUI.

## License

MIT — see [LICENSE](LICENSE).
