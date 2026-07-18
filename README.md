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
const files = await agent('List every route file under src/routes/.', { tier: 'small' })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`Audit ${file} for missing auth checks.`, { tier: 'medium' }),
  ),
)

phase('Verify')
return await agent('Synthesize and double-check these findings:\n' + findings.join('\n\n'), { tier: 'big' })
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
  return await agent(`Audit ${target}; user answer: ${answer}`)
}
```

Pass `workflow.mjs` through `scriptPath`. The exported `run(context)` receives the same `agent`, `parallel`, `pipeline`, `phase`, `bash`, `checkpoint`, `log`, `args`, `cwd`, and `budget` APIs available as globals in inline workflows. Native modules execute as trusted Node.js code; keep the entry and imported source files unchanged while a run remains resumable.

## Highlights

- **Fan-out orchestration** — `agent()`, `parallel()`, `pipeline()`, `phase()` in a sandboxed script. Up to 16 concurrent / 1000 total subagents; intermediate results stay in variables, not the chat.
- **Real model routing** — `small` / `medium` / `big` tiers (or an exact `model`) per agent. It actually switches the subagent's model — cheap work on a light one, hard synthesis on a big one.
- **Journaled resume + retry** — a paused or interrupted run replays finished work from a journal (no re-run, no tokens) and runs only what's left or what you changed. Retryable agent failures pause the same run; `/workflows retry` reruns only the failed retryable agents while completed agent, shell, and checkpoint work replays without side effects.
- **Real token & cost accounting** — read from each subagent's session, not estimated. Runs have no default token cap; `tokenBudget`, phase budgets, and `budget` let you add explicit gates when you want them.
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
/workflows-progress compact|detailed|status
                            switch the live panel between the compact one-liner and the detailed
                            per-phase/per-agent view (with tokens, cost, and a live tok/s rate)
/workflows-progress-max <N> cap agents shown per phase in detailed mode (1-1000, default 8)
/workflows-models           map the small / medium / big tiers to real models
```

Agents can inspect and control current-session runs directly with the `workflow_status`, `workflow_pause`, `workflow_retry`, and `workflow_stop` tools; the slash commands remain available for manual control.

In the navigator: `↑/↓` select · `enter`/`→` open · `esc`/`←` back · `p` pause · `x` stop · `d` remove · `r` restart · `q` quit. Each agent shows the model it ran on; the detail view shows its prompt, result, error diagnostics, and compact message/tool history.

## Storage

Workflow state is stored under `~/.pi/workflows` so projects do not accumulate extension-owned `.pi/workflows` directories. Global settings and model tiers live at `~/.pi/workflows/settings.json` and `~/.pi/workflows/model-tiers.json`; project-scoped run history, resume journals, and locks live under `~/.pi/workflows/projects/<project>/`. Older project-local `.pi/workflows/runs` data is still read as a fallback. Saved-workflow JSON is intentionally neither read nor mutated.

## Reference

The essentials:

| Global | What it does |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text, or a validated object with `opts.schema`; exhausted recoverable failures throw a classified `WorkflowError` with diagnostics in `/workflows`. |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently; results keep input order on success and ordinary branch errors reject the fan-out. For best effort, catch inside each branch, not on `parallel(...)`, because sibling branches can still be running when the aggregate rejects. |
| `pipeline(items, ...stages)` | Fan items through sequential stages `(prev, original, index)`; branch errors reject the pipeline unless caught inside that branch/stage. Do not catch only the aggregate while continuing with more workflow work. |
| `bash(cmd, { cwd?, timeoutMs? })` | Run a shell command; returns `{ pid, exitCode, stdoutFile, stderrFile }`. Full stdout/stderr are written to those files and journaled like `agent()`, so resume replays paths without re-running. Pass file paths to `agent()` for analysis. |
| `phase(title, { budget? })` | Group agents in the live view; optional per-phase token sub-budget. |
| `checkpoint(question)` | Always pauses the run and transfers a durable question to the parent conversation. Continue the same run with the host `workflow({ resumeRunId, reply })` tool call; completed steps replay from the journal. |
| `budget` | `{ total, spent(), remaining() }` real-token tracker. |

| Agent option | Description |
| --- | --- |
| `tier` | `"small"` \| `"medium"` \| `"big"` — coarse model routing (configure via `/workflows-models`). |
| `model` | Exact `provider/modelId` (always wins over `tier`). |
| `agentType` | A named definition (`.pi/agents/<name>.md`) binding tools + model + role prompt. |
| `cwd` | Run this agent in a different working directory (tools + session bind to it). |
| `forkFrom` | Fork an existing Pi session file (JSONL) as starting context. The source file is never mutated; without `sessionPath`, the fork is temporary. |
| `sessionPath` | Persist/continue this agent's working session. Existing files are continued; missing files are created. Relative paths resolve under `~/.pi/workflows/sessions/`. Combined with `forkFrom`, the target must not already exist. |
| `schema` | JSON Schema → the subagent returns a validated object. |
| `label` / `phase` / `timeoutMs` | Display label / phase override / optional per-agent hard timeout. Omit `timeoutMs` for no hard timeout. |
| `retries` | Retry attempts after a recoverable failure (timeout, connection failure, empty output) for this agent. Overrides the run-level `agentRetries`. Default `0`. |
| `retryable` | Whether an exhausted agent failure may pause the run for `/workflows retry`. Default `true`; set `false` for agents that edit files, post comments, submit forms, or can otherwise duplicate side effects. |
| `readOnly` | Set `true` for reviewers/searchers to exclude code-writing tools (`bash`, `edit`, `write`, and AST replacement) while preserving read-only tools. |

A live `checkpoint()` never guesses or supplies a default. The manager persists its prompt, call index, and hash, releases the run lease, and asks the parent conversation. The host `workflow({ resumeRunId: "...", reply: ... })` tool call validates the reply, journals it, and resumes the same run ID. The script executes from the top, but the unchanged completed prefix is replayed without rerunning agents or shell commands. A workflow run may call `checkpoint()` at most once. `/workflows resume` is for paused/interrupted runs; `/workflows retry` is for runs paused by retryable agent failures. Ordinary failed runs remain terminal.

Subagent sessions are temporary by default. Use `sessionPath` only when a reviewer/worker should keep context across runs; use `forkFrom` when it should start from an existing Pi conversation. Workflow subagents bind extensions headlessly, so the configured compaction/autocontinue extension lifecycle applies normally.

By default, workflows do not set a run-wide token budget or per-agent hard timeout. Use the `workflow` tool's `tokenBudget` / `agentTimeoutMs`, per-phase budgets, or per-agent `timeoutMs` only when you want an explicit cap. A global fallback timeout can also be set in `~/.pi/workflows/settings.json` as `{ "defaultAgentTimeoutMs": 600000 }`; set it to `null` or omit it for no default hard timeout.

For larger or flakier fan-outs, the `workflow` tool also accepts `concurrency` (max agents running at once, clamped to the runtime maximum of `16`) and `agentRetries` (retry attempts after a recoverable agent failure such as a timeout, connection failure, or empty output). Both can be defaulted in `~/.pi/workflows/settings.json` as `{ "defaultConcurrency": 4, "defaultAgentRetries": 2 }`; a per-run tool value overrides the default, and a per-agent `retries` overrides `agentRetries`. Retries default to `0` (off) unless configured or passed, and only recoverable failures retry — nonrecoverable errors still abort the run.

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

Every feature is also verified end-to-end against a real Pi subagent session before release.

## Credits

The "code mode for subagents" idea comes from Michael Livs' original [pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) and Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code). This project builds on it with real model routing, journaled resume, cost accounting, and an interactive TUI.

## License

MIT — see [LICENSE](LICENSE).
