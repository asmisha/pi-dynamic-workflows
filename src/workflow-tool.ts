import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { defineTool, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listAvailableModelSpecs } from "./agent.js";
import { listAgentTypes, loadAgentRegistry } from "./agent-registry.js";
import { recomputeWorkflowSnapshot, renderWorkflowText, type WorkflowSnapshot } from "./display.js";
import { loadWorkflowModule, parseWorkflowScript, type WorkflowModuleDefinition } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { workflowOutcome } from "./workflow-outcome.js";
import { loadWorkflowSettings } from "./workflow-settings.js";

/**
 * The authoring rules a caller must follow or the run fails. They live in the
 * tool's `description`, which is part of the tool schema and therefore always
 * reaches the model — unlike `promptGuidelines`, which the host drops whenever
 * the user supplies a custom system prompt (see core/system-prompt: the
 * customPrompt branch returns before guidelines are read). `promptGuidelines`
 * reuses this same array so the two can never drift.
 */
export const WORKFLOW_CONTRACT = [
  "Use it for decomposable work — repo inspection, independent checks, multi-perspective review, fan-out/fan-in synthesis — or when the user or a skill asks for it; not for a single quick read/edit.",
  "An inline script is plain deterministic sandboxed JavaScript: no Markdown fences, prose, TypeScript, import/require, filesystem or network APIs, Date.now(), new Date(), or Math.random(). `export const meta = { name, description, phases? }` must be its first statement, and it must call agent() at least once.",
  "Inline globals, also available as fields of a native run(context): agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), bash(cmd, opts), checkpoint(question), log, args, cwd, runId. Use runId, never an invented id, when a run needs its own artifact or session paths.",
  "Subagents inherit no parent context: every prompt must carry its own task, paths, and expected output. Set opts.readOnly = true for reviewers and searchers, and opts.retryable = false for any agent that can duplicate side effects. Subagents cannot launch nested workflow runs unless the call sets opts.allowSubagents = true.",
  "parallel() and pipeline() reject on branch failure: for best effort catch inside the branch, never on the aggregate. bash() returns {pid, exitCode, stdoutFile, stderrFile}; pass those paths to agents instead of pasting output through results.",
  "Runs always execute in the background — the call returns a run ID, and every completion, failure, and checkpoint is delivered back into this conversation and wakes you automatically. Never wait for a run: no workflow_status polling, no sleep, no idle turns. Do other useful work or end the turn.",
];

/**
 * Model routing guideline for workflow authors.
 * Tells the LLM about opts.tier (small/medium/big) for runtime-enforced
 * model selection, and opts.model for an exact provider/id override.
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
    "the user maps tiers to models via /workflows-models and untagged agents use the session model. " +
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

const MAX_WORKFLOW_SCRIPT_BYTES = 1024 * 1024;

const workflowToolSchema = Type.Object({
  resumeRunId: Type.Optional(
    Type.String({
      description: "Paused workflow run to continue with `reply`. Omit script/scriptPath for continuation calls.",
    }),
  ),
  reply: Type.Optional(
    Type.String({ description: "Non-empty parent-conversation reply for the paused run's checkpoint." }),
  ),
  script: Type.Optional(
    Type.String({
      description: [
        "Raw deterministic JavaScript workflow script (no Markdown fences). Pass exactly one of script or scriptPath. Skeleton:",
        "export const meta = { name: 'short_snake_case', description: 'non-empty', phases: [{ title: 'Phase' }] }",
        "phase('Phase')",
        "const results = await parallel(items.map(item => () => agent('task + context + paths', { label: 'unique 2-4 words', readOnly: true })))",
        "return { verdict: '...', results }",
      ].join("\n"),
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({
      description:
        "Absolute path to a trusted native ESM workflow exporting `meta` and `run(context)`. Normal Node.js imports are supported. Pass exactly one of script or scriptPath.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Absolute existing directory used as the workflow cwd and default cwd for its subagents and bash steps. Defaults to the host Pi cwd.",
    }),
  ),
  args: Type.Optional(
    Type.Any({
      description:
        "Optional JSON object exposed to the workflow script as global `args`. Pass an object, not stringified JSON.",
    }),
  ),
  agentRetries: Type.Optional(
    Type.Number({
      description:
        "Run-level retry attempts for recoverable agent failures. Non-read-only agents default to 0; read-only agents default to at least 1 unless per-agent retries overrides it.",
    }),
  ),
  agentTimeoutMs: Type.Optional(
    Type.Number({
      description:
        "Timeout per agent in milliseconds. Omit for no hard timeout by default. Set only when the user asks to bound time.",
    }),
  ),
});

export type WorkflowToolInput = {
  resumeRunId?: string;
  reply?: string;
  script?: string;
  scriptPath?: string;
  cwd?: string;
  args?: unknown;
  agentRetries?: number;
  agentTimeoutMs?: number;
};

export interface WorkflowToolOptions {
  cwd?: string;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
}

const workflowControlToolSchema = Type.Object({
  runId: Type.String({
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    description: "Workflow run ID returned by the workflow tool.",
  }),
});

export function createWorkflowStatusTool(
  manager: WorkflowManager,
): ToolDefinition<typeof workflowControlToolSchema, any> {
  return defineTool({
    name: "workflow_status",
    label: "Workflow Status",
    description:
      "Get the current status and compact progress of a workflow run in the current session. " +
      "Use it for a one-off state check, e.g. when the user asks how a run is doing — not to wait for a run: " +
      "completion, failure, and checkpoint pauses all wake this conversation on their own.",
    promptSnippet: "Inspect a workflow run's current status, phase, agent counts, token usage, and terminal error.",
    promptGuidelines: [
      "Pass the exact runId returned by the workflow tool.",
      "Never poll it in a loop and never pair it with sleep to await a background run: the run's completion, failure, or checkpoint is delivered back to this conversation automatically.",
    ],
    parameters: workflowControlToolSchema,
    async execute(_toolCallId, params) {
      if (!manager.isRunInCurrentSession(params.runId)) {
        throw new Error(`Workflow ${params.runId} is unavailable in this session`);
      }
      const live = manager.getRun(params.runId);
      const persisted = live ? undefined : manager.listRuns().find((run) => run.runId === params.runId);
      if (!live && !persisted) {
        throw new Error(`Workflow ${params.runId} is unavailable in this session`);
      }

      const snapshot = live ? recomputeWorkflowSnapshot(live.snapshot) : undefined;
      const statuses = snapshot?.agents ?? persisted?.agents ?? [];
      const agents = {
        total: statuses.length,
        running: statuses.filter((agent) => agent.status === "running").length,
        done: statuses.filter((agent) => agent.status === "done").length,
        error: statuses.filter((agent) => agent.status === "error").length,
      };
      const workflowName = snapshot?.name ?? persisted?.workflowName ?? "workflow";
      const status = live?.status ?? persisted?.status;
      const outcome = workflowOutcome(live?.result?.result ?? persisted?.result);
      const currentPhase = snapshot?.currentPhase ?? persisted?.currentPhase;
      const tokenUsage = snapshot?.tokenUsage ?? persisted?.tokenUsage;
      const pauseReason = live?.pauseReason ?? persisted?.pauseReason;
      const sourceError = live?.error ?? persisted?.error;
      const error = sourceError ? { code: sourceError.code, message: sourceError.message } : undefined;
      const retryFailures = (live?.retryState ?? persisted?.retryState)?.failures.map((failure) => ({
        label: failure.label,
        phase: failure.phase,
        code: failure.code,
        message: failure.message,
        attempt: failure.attempt,
        retryable: failure.retryable,
      }));
      const details = {
        runId: params.runId,
        workflowName,
        status,
        outcome,
        currentPhase,
        agents,
        tokenUsage,
        pauseReason,
        retryFailures,
        error,
      };
      const lines = [
        `Workflow execution ${workflowName} (${params.runId}) is ${status}.`,
        ...(outcome ? [`Workflow outcome: ${outcome}.`] : []),
        ...(currentPhase ? [`Current phase: ${currentPhase}.`] : []),
        `Agents: ${agents.done}/${agents.total} done, ${agents.running} running, ${agents.error} error.`,
        ...(tokenUsage ? [`Tokens: ${tokenUsage.total}.`] : []),
        ...(pauseReason ? [`Pause reason: ${pauseReason}.`] : []),
        ...(retryFailures?.length
          ? [
              `Retryable failures: ${retryFailures
                .map(
                  (failure) =>
                    `${failure.label ?? "agent"}${failure.phase ? ` (${failure.phase})` : ""}: ${failure.code ?? "error"}, attempt ${failure.attempt}, retryable ${failure.retryable}`,
                )
                .join("; ")}.`,
            ]
          : []),
        ...(error ? [`Error: ${error.code}: ${error.message}`] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details };
    },
  });
}

function createWorkflowControlTool(
  manager: WorkflowManager,
  action: "pause" | "stop" | "retry",
): ToolDefinition<typeof workflowControlToolSchema, any> {
  const pastTense = action === "pause" ? "paused" : action === "stop" ? "stopped" : "retried";
  return defineTool({
    name: `workflow_${action}`,
    label: action === "pause" ? "Pause Workflow" : action === "stop" ? "Stop Workflow" : "Retry Workflow",
    description:
      action === "pause"
        ? "Temporarily pause a running workflow in the current session. The run can be resumed later."
        : action === "stop"
          ? "Stop a running or paused workflow in the current session. Stopped runs cannot be resumed."
          : "Retry a paused retryable agent failure in the same workflow run, replaying completed work.",
    promptSnippet:
      action === "pause"
        ? "Pause a running workflow when its work should be suspended but may continue later."
        : action === "stop"
          ? "Stop a workflow when its remaining work should be aborted and must not continue."
          : "Retry a workflow paused after retryable agent failure without creating a replacement run.",
    promptGuidelines: [
      `Pass the exact runId returned by the workflow tool. Use workflow_${action} only for runs in the current parent session.`,
    ],
    parameters: workflowControlToolSchema,
    async execute(_toolCallId, params) {
      if (!manager.isRunInCurrentSession(params.runId)) {
        throw new Error(`Workflow ${params.runId} is unavailable in this session`);
      }
      const ok =
        action === "stop" ? manager.stop(params.runId, { notifyParent: false }) : await manager[action](params.runId);
      if (!ok) {
        throw new Error(`Workflow ${params.runId} cannot be ${pastTense} in its current state`);
      }
      return {
        content: [{ type: "text", text: `Workflow ${params.runId} ${pastTense}.` }],
        details: { runId: params.runId, [pastTense]: true },
      };
    },
  });
}

export function createWorkflowPauseTool(
  manager: WorkflowManager,
): ToolDefinition<typeof workflowControlToolSchema, any> {
  return createWorkflowControlTool(manager, "pause");
}

export function createWorkflowStopTool(
  manager: WorkflowManager,
): ToolDefinition<typeof workflowControlToolSchema, any> {
  return createWorkflowControlTool(manager, "stop");
}

export function createWorkflowRetryTool(
  manager: WorkflowManager,
): ToolDefinition<typeof workflowControlToolSchema, any> {
  return createWorkflowControlTool(manager, "retry");
}

export function createWorkflowResumeTool(
  manager: WorkflowManager,
): ToolDefinition<typeof workflowControlToolSchema, any> {
  return defineTool({
    name: "workflow_resume",
    label: "Resume Workflow",
    description: "Resume a manually paused or interrupted workflow in the same run, replaying completed work.",
    promptSnippet: "Resume an interrupted or manually paused workflow without creating a replacement run.",
    promptGuidelines: ["Pass the exact runId returned by the workflow tool. Use only for runs in this parent session."],
    parameters: workflowControlToolSchema,
    async execute(_toolCallId, params) {
      if (!manager.isRunInCurrentSession(params.runId)) {
        throw new Error(`Workflow ${params.runId} is unavailable in this session`);
      }
      if (!(await manager.resume(params.runId))) {
        throw new Error(
          `Workflow ${params.runId} cannot be resumed in its current state. Use workflow_retry for agent-failure pauses or workflow({ resumeRunId, reply }) for checkpoints`,
        );
      }
      return {
        content: [{ type: "text", text: `Workflow ${params.runId} resumed.` }],
        details: { runId: params.runId, resumed: true },
      };
    },
  });
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  let manager = options.manager;
  if (!manager) {
    const cwd = options.cwd ?? process.cwd();
    const defaults = resolveWorkflowToolDefaults(options, cwd);
    manager = new WorkflowManager({
      cwd: options.cwd,
      defaultAgentTimeoutMs: defaults.agentTimeoutMs,
      defaultAgentRetries: defaults.agentRetries,
    });
  }

  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: [
      "Execute or continue a deterministic JavaScript workflow that orchestrates subagents and shell steps.",
      "To start, pass exactly one source: inline script or absolute scriptPath. To answer a paused checkpoint, pass only resumeRunId and reply.",
      ...WORKFLOW_CONTRACT,
    ].join(" "),
    promptSnippet:
      "Run a workflow from one source: an inline deterministic script, or a trusted native ESM scriptPath exporting `meta` and `run(context)`.",
    // Lazy accessor: the SDK re-reads definition.promptGuidelines on every
    // tool-registry refresh, so each read sees the manager's registry as it
    // stands then (setModelRegistry runs on session_start, after tool creation).
    // Residual caveat: providers registered after the last refresh won't appear
    // until the next one.
    get promptGuidelines() {
      return [
        // Hard contract first, shared verbatim with `description` so a host that
        // drops guidelines still delivers it.
        ...WORKFLOW_CONTRACT,
        "For a trusted reusable scriptPath, use native ESM: export literal `meta` and `async function run(context)`, use normal Node.js imports, and destructure workflow APIs from context. Keep its source files unchanged while a run is resumable.",
        "checkpoint(question) always pauses and transfers its question to the parent conversation; continue the same run with the host workflow({resumeRunId, reply}) tool call.",
        "For machine-readable agent output pass a plain JSON Schema via opts.schema (not TypeScript/TypeBox). opts.cwd runs an agent in another directory. opts.thinking sets one agent's reasoning effort (low | medium | high | xhigh | max); it is independent of the model and each model maps the level itself, so raise it for judgement-heavy synthesis and lower it for mechanical scans. opts.readOnly also removes code-writing tools and grants one automatic recoverable retry by default, so ordinary read-only calls need no retries configuration; read-only agents can persist files only under /tmp, so direct their artifact outputs there. For a required cross-provider backup, set opts.fallbackModel to an exact provider/modelId alongside opts.model; only missing authentication/availability or a provider usage limit triggers the handoff, and the same subagent session continues with prior tool work intact. Session args: opts.forkFrom forks an existing Pi session file as read-only starting context; opts.sessionPath persists/continues this subagent's working session (relative paths resolve under ~/.pi/workflows/sessions/); using both forks into a new persistent session and is invalid if the target already exists. Workflow subagents bind extensions headlessly, so the configured compaction/autocontinue extension lifecycle still applies. With multiple phases, call phase('Exact Title') before each phase's work so agents group correctly. End with a synthesis agent when combining results; return a compact JSON-serializable value.",
        modelRoutingGuideline(() => manager.getModelRegistry()),
        agentTypeGuideline(manager.getCwd()),
        "Don't set agentTimeoutMs unless the user asks to bound time. Use agentRetries for flaky provider fan-outs.",
      ].filter((g): g is string => typeof g === "string" && g.length > 0);
    },
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.resumeRunId) {
        const resumed = await manager.resumeWithReply(params.resumeRunId, params.reply);
        if (!resumed) {
          throw new Error(
            `Workflow ${params.resumeRunId} is not paused at a checkpoint, is already running, or rejected the reply`,
          );
        }
        return {
          content: [
            {
              type: "text",
              text: `Checkpoint reply accepted. Workflow ${params.resumeRunId} resumed in the background. Its result will return to this conversation.`,
            },
          ],
          details: { runId: params.resumeRunId, resumed: true },
        };
      }

      const source = await resolveWorkflowSource(params);
      const runCwd = resolveWorkflowCwd(params.cwd ?? options.cwd ?? ctx.cwd);
      const parsed = source.workflowModule ? { meta: source.workflowModule.meta } : parseWorkflowScript(source.script);

      // Always background: return immediately so the turn ends and the user
      // isn't blocked. The result is delivered back into the conversation when
      // the run finishes (see installResultDelivery).
      const { runId } = manager.startInBackground(source.script, params.args, {
        workflowModulePath: source.workflowModulePath,
        workflowModule: source.workflowModule,
        agentRetries: params.agentRetries,
        agentTimeoutMs: params.agentTimeoutMs,
        cwd: runCwd,
      });
      return {
        content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
        details: { runId },
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
): { agentTimeoutMs: number | null; agentRetries: number } {
  const settings = loadWorkflowSettings({ cwd });
  return {
    agentTimeoutMs:
      options.defaultAgentTimeoutMs !== undefined
        ? options.defaultAgentTimeoutMs
        : (settings.defaultAgentTimeoutMs ?? null),
    agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
  };
}

/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 *
 * Facts and commands only. Conduct — not polling, what to tell the user —
 * belongs to the host's skill layer; the standing ban on waiting lives in
 * WORKFLOW_CONTRACT so skill-less hosts stay guarded.
 */
export function backgroundStartedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" started in the background.`,
    `Run ID: ${runId}`,
    "Completion, failure, or a checkpoint is delivered back into this conversation automatically.",
    `Track or cancel with /workflows status ${runId} or /workflows stop ${runId}.`,
  ].join("\n");
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object") {
    throw new Error("workflow requires an object argument");
  }
  const value = args as Record<string, unknown>;
  const hasScript = value.script !== undefined;
  const hasScriptPath = value.scriptPath !== undefined;
  const hasResume = value.resumeRunId !== undefined;
  if (hasResume) {
    if (hasScript || hasScriptPath) {
      throw new Error("workflow continuation cannot include `script` or `scriptPath`");
    }
    if (typeof value.resumeRunId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.resumeRunId)) {
      throw new Error("workflow `resumeRunId` must be a valid run ID");
    }
    if (typeof value.reply !== "string" || value.reply.trim().length === 0) {
      throw new Error("workflow continuation requires a non-empty string `reply`");
    }
    const continuationFields = new Set(["resumeRunId", "reply"]);
    if (Object.keys(value).some((field) => !continuationFields.has(field))) {
      throw new Error("workflow continuation accepts only `resumeRunId` and `reply`");
    }
    return value as WorkflowToolInput;
  }
  if (hasScript === hasScriptPath) {
    throw new Error("workflow start requires exactly one of `script` or `scriptPath`");
  }
  if (Object.hasOwn(value, "reply")) {
    throw new Error("workflow `reply` requires `resumeRunId`");
  }
  const startFields = new Set(["script", "scriptPath", "cwd", "args", "agentRetries", "agentTimeoutMs"]);
  const unsupportedField = Object.keys(value).find((field) => !startFields.has(field));
  if (unsupportedField) throw new Error(`workflow \`${unsupportedField}\` is not supported`);
  if (hasScript && typeof value.script !== "string") {
    throw new Error("workflow requires `script` to be a string");
  }
  if (hasScriptPath) validateAbsolutePath(value.scriptPath, "scriptPath");
  if (value.cwd !== undefined) validateAbsolutePath(value.cwd, "cwd");
  return {
    ...value,
    ...(Object.hasOwn(value, "args") ? { args: parseJsonArgs(value.args) } : {}),
    ...(typeof value.script === "string" ? { script: normalizeWorkflowScript(value.script) } : {}),
  } as WorkflowToolInput;
}

/**
 * `args` is intentionally untyped, so callers routinely hand it stringified JSON.
 * Parse that back into the object/array the script expects; anything else stays
 * verbatim, because a workflow may legitimately want a plain string.
 */
function parseJsonArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  const trimmed = args.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return args;
  try {
    return JSON.parse(trimmed);
  } catch {
    return args;
  }
}

function validateAbsolutePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`workflow \`${field}\` must be an absolute path`);
  }
}

async function resolveWorkflowSource(input: WorkflowToolInput): Promise<{
  script: string;
  workflowModulePath?: string;
  workflowModule?: WorkflowModuleDefinition;
}> {
  if (input.script !== undefined) return { script: normalizeWorkflowScript(input.script) };
  if (!input.scriptPath) throw new Error("workflow requires exactly one of `script` or `scriptPath`");
  try {
    const stat = statSync(input.scriptPath);
    if (!stat.isFile()) throw new Error("path is not a file");
    if (stat.size > MAX_WORKFLOW_SCRIPT_BYTES) {
      throw new Error(`file exceeds ${MAX_WORKFLOW_SCRIPT_BYTES} byte limit`);
    }
    const workflowModule = await loadWorkflowModule(input.scriptPath);
    return {
      script: `export const meta = ${JSON.stringify(workflowModule.meta)}`,
      workflowModulePath: input.scriptPath,
      workflowModule,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load workflow scriptPath ${input.scriptPath}: ${message}`, { cause: error });
  }
}

function resolveWorkflowCwd(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (!statSync(value).isDirectory()) throw new Error("path is not a directory");
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not use workflow cwd ${value}: ${message}`, { cause: error });
  }
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
