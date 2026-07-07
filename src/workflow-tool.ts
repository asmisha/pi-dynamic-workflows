import { defineTool, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listAvailableModelSpecs } from "./agent.js";
import { listAgentTypes, loadAgentRegistry } from "./agent-registry.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { parseWorkflowScript, type WorkflowRunResult } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

/**
 * Model routing guideline for workflow authors.
 * Tells the LLM about opts.tier (small/medium/big) for runtime-enforced
 * model selection, and opts.model for an exact provider/id override.
 *
 * This string is injected into the workflow tool's promptGuidelines and
 * therefore appears in the LLM's system prompt for every workflow execution.
 *
 * `registry` is a live host-session ModelRegistry (or a getter reaching one),
 * e.g. from WorkflowManager.getModelRegistry(). A getter lets each call see
 * the registry as it stands at that moment — the manager's registry is set on
 * session_start, after the tool is created, so an early snapshot would miss it.
 */
export function modelRoutingGuideline(registry?: ModelRegistry | (() => ModelRegistry | undefined)): string {
  const resolvedRegistry = typeof registry === "function" ? registry() : registry;
  const available = listAvailableModelSpecs(resolvedRegistry);
  const list = available.length ? ` Available models: ${available.join(", ")}.` : "";
  return (
    "Tag EVERY agent with opts.tier — 'small' (exploration/search), 'medium' (analysis), 'big' (synthesis/judgment); " +
    "the user maps tiers to models via /workflows-models and untagged agents fall back to medium. " +
    `If the user names a model, pass opts.model with that exact provider/id (overrides tier).${list}`
  );
}

/**
 * Tells the LLM which named subagent definitions (agentType) are available, so
 * it can route an agent() to a reusable role that binds tools+model+prompt.
 * Returns undefined when no definitions are registered (nothing to advertise).
 */
export function agentTypeGuideline(cwd: string = process.cwd()): string | undefined {
  let types: Array<{ name: string; description?: string }>;
  try {
    types = listAgentTypes(loadAgentRegistry(cwd));
  } catch {
    return undefined;
  }
  if (!types.length) return undefined;
  const list = types.map((t) => (t.description ? `${t.name} (${t.description})` : t.name)).join(", ");
  return `opts.agentType routes an agent to a named definition binding tools, model, and role prompt. Available: ${list}. An explicit opts.model overrides the definition's model.`;
}

const workflowToolSchema = Type.Object({
  script: Type.String({
    description:
      "Raw JavaScript workflow script (no Markdown fences). Must start with the meta export and call agent() at least once — see the workflow guidelines.",
  }),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as global `args`." }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Default true: return immediately with a run ID; the result is delivered back when the run finishes. false blocks for the result inline.",
    }),
  ),
  maxAgents: Type.Optional(
    Type.Number({
      description: "Maximum number of agents allowed in this run. Default: 1000.",
    }),
  ),
  concurrency: Type.Optional(
    Type.Number({
      description:
        "Maximum concurrent agents for this run. Clamped to the runtime maximum. Use when provider/transport stability matters.",
    }),
  ),
  agentRetries: Type.Optional(
    Type.Number({
      description:
        "Retry attempts for recoverable agent failures such as timeout, connection failure, or empty assistant output. Default 0 unless configured.",
    }),
  ),
  agentTimeoutMs: Type.Optional(
    Type.Number({
      description:
        "Timeout per agent in milliseconds. Omit for no hard timeout by default. Set only when the user asks to bound time.",
    }),
  ),
  tokenBudget: Type.Optional(
    Type.Number({
      description:
        "Hard total-token budget for the whole run. Once spent reaches it, further agent() calls fail and the run stops. Omit for no limit. Set it when the user asks to cap spend.",
    }),
  ),
});

export type WorkflowToolInput = {
  script: string;
  args?: unknown;
  background?: boolean;
  maxAgents?: number;
  concurrency?: number;
  agentRetries?: number;
  agentTimeoutMs?: number;
  tokenBudget?: number;
};

export interface WorkflowToolOptions {
  cwd?: string;
  concurrency?: number;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /** Shared saved-workflow storage. */
  storage?: WorkflowStorage;
  /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default max concurrent agents when no tool-level concurrency is passed. */
  defaultConcurrency?: number;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  const storage = options.storage ?? createWorkflowStorage(options.cwd ?? process.cwd());
  const cwd = options.cwd ?? process.cwd();
  const defaults = resolveWorkflowToolDefaults(options, cwd);
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      concurrency: defaults.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
      defaultAgentTimeoutMs: defaults.agentTimeoutMs,
      defaultAgentRetries: defaults.agentRetries,
    });

  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), pipeline(), and shell steps via bash().",
      "script is required raw JavaScript. It must start with export const meta = { name, description, phases? } and must call agent() at least once.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Required script header: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }.",
    // Lazy accessor: the SDK re-reads definition.promptGuidelines on every
    // tool-registry refresh, so each read sees the manager's registry as it
    // stands then (setModelRegistry runs on session_start, after tool creation).
    // Residual caveat: providers registered after the last refresh won't appear
    // until the next one.
    get promptGuidelines() {
      return [
        "Use workflow only when the user explicitly asks for a workflow, fan-out, or multi-agent orchestration — for decomposable work (repo inspection, independent checks, multi-perspective review, fan-out/fan-in synthesis), not a single quick read/edit.",
        [
          "script is one raw JavaScript string — no fences, no prose, no TypeScript/imports/require/fs/Date.now()/Math.random()/new Date(). Skeleton:",
          "export const meta = { name: 'short_snake_case', description: 'non-empty', phases: [{ title: 'Phase' }] }",
          "phase('Phase')",
          "const results = await parallel(items.map(item => () => agent('task + context + paths', { label: 'unique 2-4 words', tier: 'small' })))",
          "return { ok: true, verdict: '...', results }",
        ].join("\n"),
        "Globals: agent(prompt, opts), parallel(thunks: Array<() => Promise<unknown>>), pipeline(items, ...stages), phase(title), bash(cmd, {cwd?, timeoutMs?}), log(msg), args, cwd, budget, workflow('saved-name', args) (nests one level; global caps hold). Helpers built on agent(): verify(item,{reviewers,lens}), judgePanel(attempts,{judges,rubric}), loopUntilDry({round,key}), completenessCheck(args,results), retry(thunk,{attempts,until}), gate(thunk,validator,{attempts}), checkpoint(prompt,opts).",
        "bash(cmd) runs a shell command and returns {pid, exitCode, stdoutFile, stderrFile}. Full stdout/stderr go to those files; do not paste output directly through the workflow result. Use it for mechanical steps (grep/build/test), check exitCode, then pass the file paths to agent() so subagents can read/grep the files. Results are journaled so resume replays them without re-running.",
        "parallel() takes an array of zero-arg functions (thunks), not promises. Correct: await parallel(items.map(item => () => agent(...))). Wrong: await parallel(items.map(item => agent(...))) and wrong: await parallel(items.map(async item => agent(...))). Before calling workflow, self-check every parallel(...) argument: each array element must be a function you have not called yet. Results keep input order; failed branches return null and log: check for nulls before synthesizing. pipeline() runs stages sequentially per item, items concurrently; each stage gets (prev, original, index).",
        "Subagents have NO parent context unless you give it to them: each prompt must carry the task, relevant paths, and expected output. For machine-readable output pass a plain JSON Schema via opts.schema (not TypeScript/TypeBox). opts.cwd runs an agent in another directory. Session args: opts.forkFrom forks an existing Pi session file as read-only starting context; opts.sessionPath persists/continues this subagent's working session (relative paths resolve under ~/.pi/workflows/sessions/); using both forks into a new persistent session and is invalid if the target already exists. Workflow subagents bind extensions headlessly, so the configured compaction/autocontinue extension lifecycle still applies. With multiple phases, call phase('Exact Title') before each phase's work so agents group correctly. End with a synthesis agent when combining results; return a compact JSON-serializable value.",
        modelRoutingGuideline(() => manager.getModelRegistry()),
        agentTypeGuideline(),
        "Runs are background by default (run ID now, result delivered when finished); background: false only when the result is needed inline this turn. Don't set tokenBudget/agentTimeoutMs unless the user asks to cap spend/time; to bound spend use tokenBudget, phase('Name', {budget: N}) (wrap in try/catch), or branch on budget.remaining(). Use low concurrency + agentRetries for flaky provider fan-outs.",
      ].filter((g): g is string => typeof g === "string" && g.length > 0);
    },
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const script = normalizeWorkflowScript(params.script);
      const parsed = parseWorkflowScript(script);

      // checkpoint() reaches the human only on a UI-bearing foreground run; a
      // background run is detached, so checkpoint() falls back to its headless
      // default. Map a checkpoint to ctx.ui.confirm (a yes/no gate) when available.
      const uiCtx = ctx as
        | { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
        | undefined;
      const uiConfirm = uiCtx?.hasUI ? uiCtx.ui?.confirm : undefined;
      const confirm = uiConfirm
        ? (promptText: string) => uiConfirm.call(uiCtx?.ui, "Workflow checkpoint", promptText)
        : undefined;

      // Background execution is the default: return immediately so the turn ends
      // and the user isn't blocked. The result is delivered back into the
      // conversation when the run finishes (see installResultDelivery). Only an
      // explicit `background: false` blocks for the result inline.
      if (params.background ?? true) {
        const { runId } = manager.startInBackground(script, params.args, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
        });
        return {
          content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
          details: { runId, background: true },
        };
      }

      // Synchronous execution (blocking) — but routed through the manager so the
      // run shows up live in the /workflows navigator and the task panel while it
      // runs, then stays in history afterwards. We still block on the result and
      // return it inline, so the model gets the full output in the same turn.
      let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
      const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
        key: "workflow",
        streamToolUpdates: true,
        maxAgents: 4,
        showResultPreviews: false,
      });

      let result: WorkflowRunResult;
      try {
        result = await manager.runSync(script, params.args, {
          maxAgents: params.maxAgents,
          concurrency: params.concurrency,
          agentRetries: params.agentRetries,
          agentTimeoutMs: params.agentTimeoutMs,
          tokenBudget: params.tokenBudget,
          confirm,
          externalSignal: signal,
          onProgress(live) {
            snapshot = recomputeWorkflowSnapshot(live);
            display.update(snapshot);
          },
        });
      } catch (error) {
        if (signal?.aborted || (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED)) {
          for (const agent of snapshot.agents) {
            if (agent.status === "running") {
              agent.status = "skipped";
              agent.error = "aborted";
            }
          }
          snapshot = recomputeWorkflowSnapshot(snapshot);
          display.complete(snapshot);
          throw new Error("Workflow was aborted");
        }
        throw error;
      }

      if (result.agentCount === 0) {
        throw new Error(
          "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
        );
      }

      snapshot.result = result.result;
      snapshot.durationMs = result.durationMs;
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);

      // Format token usage (include cost when the provider reports it)
      const tokenInfo = result.tokenUsage
        ? `\n\nToken usage: ${result.tokenUsage.total.toLocaleString()} tokens${
            result.tokenUsage.cost ? ` ($${result.tokenUsage.cost.toFixed(4)})` : ""
          }`
        : "";

      const formattedResult =
        result.result !== undefined ? `\n\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\`` : "";

      return {
        content: [
          {
            type: "text",
            text: `Workflow **${result.meta.name}** completed with **${result.agentCount}** agent(s).${tokenInfo}\n\n## Result${formattedResult}`,
          },
        ],
        details: {
          ...snapshot,
          meta: result.meta,
          phases: result.phases,
          logs: result.logs,
          result: result.result,
          durationMs: result.durationMs,
          tokenUsage: result.tokenUsage,
          runId: result.runId,
        },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
      }
      // Fallback: strip markdown syntax so the TUI doesn't display raw asterisks/hashes.
      // The `content` field is for the LLM (where markdown is preserved), but the TUI
      // renderer (Text component) shows text literally — so we strip markdown here.
      const text = result.content?.[0];
      const raw = text?.type === "text" ? text.text : theme.fg("muted", "workflow");
      const clean = raw
        .replace(/\*\*/g, "")
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .replace(/^##+\s*/gm, "")
        .trim();
      return new Text(clean || theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function resolveWorkflowToolDefaults(
  options: WorkflowToolOptions,
  cwd: string,
): { agentTimeoutMs: number | null; concurrency?: number; agentRetries: number } {
  const settings = loadWorkflowSettings({ cwd });
  return {
    agentTimeoutMs:
      options.defaultAgentTimeoutMs !== undefined
        ? options.defaultAgentTimeoutMs
        : (settings.defaultAgentTimeoutMs ?? null),
    concurrency: options.defaultConcurrency ?? options.concurrency ?? settings.defaultConcurrency,
    agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
  };
}

/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" started in the background.`,
    `Run ID: ${runId}`,
    "It keeps running on its own. When it finishes, the result is delivered back",
    "here and the conversation continues automatically — the user does not need to",
    "do anything. Tell the user they can simply wait here for it to finish (it will",
    "resume the conversation by itself), or keep chatting / working on other things",
    "in the meantime; either way the result will come back to this conversation.",
    `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
  ].join("\n");
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") throw new Error("workflow requires an object argument with a script string");
  const value = args as Record<string, unknown>;
  if (typeof value.script !== "string") throw new Error("workflow requires `script` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function _isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
