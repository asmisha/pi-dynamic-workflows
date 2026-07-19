import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { type AgentHistoryEntry, compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import {
  classifyProviderLimit,
  isProviderAuthFailure,
  isProviderUsageLimit,
  WorkflowError,
  WorkflowErrorCode,
} from "./errors.js";
import { loadModelTierConfig, type ModelTierConfig, resolveTierModel } from "./model-tier-config.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";
import { resolveWorkflowSessionPath } from "./workflow-paths.js";

const READ_ONLY_EXCLUDED_TOOL_NAMES = ["bash", "edit", "write", "ast_grep_replace"];

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}

export function throwIfAssistantExecutionError(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  throwIfProviderLimit(messages, label);
  throw new WorkflowError(
    err.errorMessage ?? "Provider stopped with an execution error",
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    {
      recoverable: true,
      agentLabel: label,
    },
  );
}

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

interface IdleTrackedSession {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly pendingMessageCount: number;
}

const SUBAGENT_IDLE_POLL_MS = 25;
const SUBAGENT_IDLE_STABLE_MS = 100;

function abortError(): Error {
  return new Error("Subagent was aborted");
}

function waitForTimer(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done(abortError());
    function done(error?: Error): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForSubagentIdle(session: IdleTrackedSession, signal?: AbortSignal): Promise<void> {
  // agent_end extension handlers may schedule compaction/autocontinue from a
  // timer. Yield once so that deferred work can become visible before we test
  // idle state or read the final assistant output.
  await waitForTimer(0, signal);

  let idleSince: number | undefined;
  while (true) {
    if (signal?.aborted) throw abortError();
    const idle = !session.isStreaming && !session.isCompacting && session.pendingMessageCount === 0;
    const now = Date.now();
    if (idle) {
      idleSince ??= now;
      if (now - idleSince >= SUBAGENT_IDLE_STABLE_MS) return;
    } else {
      idleSince = undefined;
    }
    await waitForTimer(SUBAGENT_IDLE_POLL_MS, signal);
  }
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw retryable SCHEMA_NONCOMPLIANCE so the workflow's bounded agent retry can
 * start a fresh session. Module-level with an injected `lastText` for unit tests.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string },
  lastText: (messages: unknown[]) => string,
  afterPrompt?: () => Promise<void>,
): Promise<T> {
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    if (options.signal?.aborted) throw abortError();
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
    await afterPrompt?.();
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit a provider/runtime error. Surface that as
  // the retryable execution cause instead of misleading SCHEMA_NONCOMPLIANCE.
  throwIfAssistantExecutionError(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: true, agentLabel: options.label },
  );
}

/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export function resolveAgentModelSpec(
  options: { model?: string; tier?: string },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
): string | undefined {
  if (options.model) return options.model;
  const config = loadConfig();
  if (options.tier) {
    return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
  }
  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) return medium;
  }
  return undefined;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model (`provider/modelId`). Used as a fallback when
   * resolving opts.tier and no model-tiers.json config exists. Without this,
   * a workflow using `{ tier: "small" }` would log a warning and fall through
   * to the session default when no config is saved yet.
   */
  mainModel?: string;
  /**
   * Shared model registry from the host Pi session. When provided, subagents
   * resolve tier/model specs against the same registry the main session uses,
   * including dynamically-registered providers such as ollama-cloud. Without
   * this, the agent builds an isolated registry from disk and may miss models
   * that are only available via extension registration.
   */
  modelRegistry?: ModelRegistry;
}

/**
 * List the user's currently available models (those with auth configured) as
 * `provider/modelId` specs. Used to tell the workflow author which models it may
 * route agents to. Best-effort: returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry?: ModelRegistry): string[] {
  try {
    if (registry) {
      return registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
    }
    const dir = getAgentDir();
    const auth = AuthStorage.create(join(dir, "auth.json"));
    const r = ModelRegistry.create(auth, join(dir, "models.json"));
    return r.getAvailable().map((m) => `${m.provider}/${m.id}`);
  } catch {
    return [];
  }
}

/**
 * Fork a Pi session file into a throwaway session dir so a subagent can start
 * with the source conversation's context without ever mutating the source.
 * Returns the forked manager and a cleanup that removes the temp dir.
 */
export function forkSessionForSubagent(
  sessionFile: string,
  cwd: string,
): { sessionManager: SessionManager; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-session-fork-"));
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  };
  try {
    return { sessionManager: SessionManager.forkFrom(sessionFile, cwd, dir), cleanup };
  } catch (error) {
    cleanup();
    throw new WorkflowError(
      `Cannot fork session file "${sessionFile}": ${error instanceof Error ? error.message : error}`,
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      { recoverable: true },
    );
  }
}

/** How a subagent's session is sourced and persisted. */
export interface SubagentSessionSpec {
  /** Fork this Pi session file (JSONL) as starting context. Never mutated. */
  forkFrom?: string;
  /** Persist the subagent's own session here (see resolveWorkflowSessionPath rules). */
  sessionPath?: string;
}

/**
 * Resolve the session manager for a subagent run:
 *   - neither arg          → temp in-memory session (default; nothing persisted)
 *   - forkFrom only        → fork into a throwaway temp dir (cleaned up after)
 *   - sessionPath, exists  → continue that persisted session (appends to it)
 *   - sessionPath, new     → create a new persisted session at that exact path
 *   - both, path new       → fork forkFrom and persist the fork at sessionPath
 *   - both, path exists    → validation error: refusing to clobber an existing
 *                            session with a fork (delete it or drop one arg)
 */
export function resolveSubagentSession(
  spec: SubagentSessionSpec,
  cwd: string,
): { sessionManager: SessionManager; cleanup: () => void } {
  const noop = () => {};
  const target = spec.sessionPath ? resolveWorkflowSessionPath(spec.sessionPath) : undefined;

  if (!spec.forkFrom && !target) {
    return { sessionManager: SessionManager.inMemory(cwd), cleanup: noop };
  }
  if (spec.forkFrom && !target) {
    return forkSessionForSubagent(spec.forkFrom, cwd);
  }
  if (!target) throw new Error("unreachable");

  if (spec.forkFrom && existsSync(target)) {
    throw new WorkflowError(
      `Validation: sessionPath "${target}" already exists — cannot fork "${spec.forkFrom}" into an existing session. Continue it without forkFrom, or pick a new sessionPath.`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    if (spec.forkFrom) {
      // Fork writes a generated filename; move it onto the requested path.
      const forked = SessionManager.forkFrom(spec.forkFrom, cwd, dirname(target));
      const generated = forked.getSessionFile();
      if (generated && generated !== target) renameSync(generated, target);
      forked.setSessionFile(target);
      return { sessionManager: forked, cleanup: noop };
    }
    if (existsSync(target)) {
      // Continue the existing persisted session in the run's cwd.
      return { sessionManager: SessionManager.open(target, undefined, cwd), cleanup: noop };
    }
    // New persisted session at the exact requested path (the SDK's --session flow:
    // create in the parent dir, then pin the explicit file path).
    const manager = SessionManager.create(cwd, dirname(target));
    manager.setSessionFile(target);
    return { sessionManager: manager, cleanup: noop };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(
      `Cannot use sessionPath "${target}": ${error instanceof Error ? error.message : error}`,
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      { recoverable: true },
    );
  }
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /** Called once before disposal with this subagent run's final usage. */
  onUsage?: (usage: AgentUsage) => void;
  /** Called with cumulative usage after each completed assistant response or SDK retry rollback. */
  onUsageUpdate?: (usage: AgentUsage) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`. When it can't be resolved, the session default is used and
   * a warning is logged. When omitted, the session default applies.
   */
  model?: string;
  /**
   * Continue the same subagent session on this model when the primary model is
   * unavailable, unauthenticated, or reaches a provider usage limit. This is a
   * model handoff, not a fresh agent retry, so completed tool work is preserved.
   */
  fallbackModel?: string;
  /**
   * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
   * `model` is given), the model is resolved from the user's model-tiers.json
   * config before `run()` starts, falling back to the session's main model when
   * the tier has no configured entry. An explicit `model` always takes priority,
   * so workflow scripts can use `{ tier: "small" }` for coarse routing without
   * caring which concrete model backs that tier.
   */
  tier?: string;
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** Called when the primary model falls back to another model or the session default. */
  onModelFallback?: (requestedSpec: string, fallbackSpec?: string, reason?: string) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Run this agent in a different working directory. */
  cwd?: string;
  /**
   * Fork this Pi session file (JSONL) so the subagent starts with that
   * conversation's full context. The source file is never mutated. Without
   * `sessionPath` the fork lives in a throwaway temp dir; with it, the fork is
   * persisted at that path.
   */
  forkFrom?: string;
  /**
   * Persist the subagent's session at this path. An existing file is continued
   * (its context is inherited and new turns append); a missing file is created.
   * Bare names/relative paths resolve under ~/.pi/workflows/sessions/. Combined
   * with `forkFrom` the path must not exist yet (validation error otherwise).
   */
  sessionPath?: string;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
  disallowedToolNames?: string[];
  /** Exclude tools that can change code, including shell, edit, write, and AST replacement tools. */
  readOnly?: boolean;
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts (tools restricted to
   * structured_output) before falling back to strict prose extraction. Default 2.
   */
  maxSchemaRetries?: number;
  /**
   * Per-run model registry override. Takes precedence over the constructor's
   * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for both model
   * resolution and the `createAgentSession` call this run makes. Falls back to
   * the constructor's shared registry, then a lazily-built disk registry, when
   * omitted.
   */
  modelRegistry?: ModelRegistry;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  /** Shared registry from the host session, when provided. */
  private readonly sharedRegistry?: ModelRegistry;
  /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
  private registry?: ModelRegistry;
  /** Lazily built once per agent instance (one per run) instead of per subagent. */
  private settingsManager?: SettingsManager;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.sharedRegistry = options.modelRegistry;
  }

  /**
   * Resolve the registry for a run: an explicit per-run registry wins, then the
   * constructor's shared registry, then a lazily-built disk registry (shared
   * across calls once built).
   */
  private getRegistry(perRunRegistry?: ModelRegistry): ModelRegistry {
    if (perRunRegistry) {
      return perRunRegistry;
    }
    if (this.sharedRegistry) {
      return this.sharedRegistry;
    }
    if (!this.registry) {
      const dir = getAgentDir();
      // Same agentDir/auth files createAgentSession uses by default, so a model
      // resolved here carries valid credentials.
      const auth = AuthStorage.create(join(dir, "auth.json"));
      this.registry = ModelRegistry.create(auth, join(dir, "models.json"));
    }
    return this.registry;
  }

  /**
   * Resolve a model spec to a Model. Accepts `provider/modelId` (unambiguous)
   * or a bare `modelId` (prefers auth-configured models, then any known model).
   * Returns undefined when nothing matches.
   */
  private resolveModel(spec: string, perRunRegistry?: ModelRegistry): Model<any> | undefined {
    const registry = this.getRegistry(perRunRegistry);
    const slash = spec.indexOf("/");
    if (slash > 0) {
      return registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    }
    return registry.getAvailable().find((m) => m.id === spec) ?? registry.getAll().find((m) => m.id === spec);
  }

  private modelIsAvailable(model: Model<any>, perRunRegistry?: ModelRegistry): boolean {
    return this.getRegistry(perRunRegistry)
      .getAvailable()
      .some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
    // since tools capture their cwd at construction and can't be relocated.
    const runCwd = options.cwd ?? this.cwd;
    const baseTools = runCwd === this.cwd ? this.baseTools : createCodingTools(runCwd);
    // Apply the agentType tool policy BEFORE adding structured_output, so a
    // restrictive allowlist never strips the schema tool.
    const customTools: ToolDefinition[] = applyToolPolicy(
      [...baseTools, ...(options.tools ?? [])],
      options.toolNames,
      options.disallowedToolNames,
    );

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    // Resolve the model spec (explicit model > tier > session default). This
    // composes with phase-based routing in workflow.ts, which only supplies
    // options.model when a phase pattern matches — so an explicit model wins.
    const modelSpec = resolveAgentModelSpec(options, this.mainModel);

    const fallbackSpec = options.fallbackModel?.trim();
    if (fallbackSpec && !modelSpec) {
      throw new WorkflowError("fallbackModel requires a primary model", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
        agentLabel: options.label,
      });
    }

    // An explicit fallback makes model availability a fail-closed route: use the
    // fallback immediately when the primary lacks auth, and reject a fallback
    // that cannot itself run. Without one, preserve the existing session-default
    // behavior for unresolved model specs.
    let resolvedModel: Model<any> | undefined;
    let resolvedFallbackModel: Model<any> | undefined;
    if (fallbackSpec) {
      resolvedFallbackModel = this.resolveModel(fallbackSpec, options.modelRegistry);
      if (!resolvedFallbackModel || !this.modelIsAvailable(resolvedFallbackModel, options.modelRegistry)) {
        throw new WorkflowError(
          `Fallback model "${fallbackSpec}" is unavailable or unauthenticated`,
          WorkflowErrorCode.AGENT_EXECUTION_ERROR,
          { recoverable: false, agentLabel: options.label },
        );
      }
    }
    if (modelSpec) {
      resolvedModel = this.resolveModel(modelSpec, options.modelRegistry);
      if (resolvedModel && (!fallbackSpec || this.modelIsAvailable(resolvedModel, options.modelRegistry))) {
        options.onModelResolved?.(`${resolvedModel.provider}/${resolvedModel.id}`);
      } else if (resolvedFallbackModel && fallbackSpec) {
        resolvedModel = resolvedFallbackModel;
        options.onModelFallback?.(modelSpec, fallbackSpec, "primary model is unavailable or unauthenticated");
        options.onModelResolved?.(`${resolvedFallbackModel.provider}/${resolvedFallbackModel.id}`);
      } else {
        console.warn(`[workflow] model "${modelSpec}" not found; using session default`);
        options.onModelFallback?.(modelSpec);
      }
    }

    const agentDir = getAgentDir();
    // Use a real SettingsManager to inherit the user's default provider/model,
    // compaction, and extension settings (inMemory() would miss ~/.pi/settings.json
    // and could route to an unauthed model). Built once per run, not once per subagent.
    this.settingsManager ??= SettingsManager.create(this.cwd, agentDir);
    // Session source/persistence matrix: temp in-memory by default; forkFrom
    // inherits another session's context; sessionPath persists/continues one.
    const forked = resolveSubagentSession({ forkFrom: options.forkFrom, sessionPath: options.sessionPath }, runCwd);
    const session = await (async () => {
      try {
        const created = await createAgentSession({
          cwd: runCwd,
          agentDir,
          sessionManager: forked.sessionManager,
          settingsManager: this.settingsManager,
          customTools,
          // Per-run modelRegistry wins over the constructor's shared registry, same
          // precedence as resolveModel() above.
          ...(options.modelRegistry || this.sharedRegistry
            ? { modelRegistry: options.modelRegistry ?? this.sharedRegistry }
            : {}),
          ...this.sessionOptions,
          // Per-call model wins over any sessionOptions.model.
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(options.readOnly
            ? { excludeTools: [...(this.sessionOptions.excludeTools ?? []), ...READ_ONLY_EXCLUDED_TOOL_NAMES] }
            : {}),
        });
        // createAgentSession loads configured extensions, but hooks (including
        // compaction/autocontinue extensions and session_start tool setup) only run
        // after binding. Bind headlessly so workflow subagents participate in the
        // same extension lifecycle as normal sessions.
        await created.session.bindExtensions({});
        return created.session;
      } catch (error) {
        forked.cleanup();
        throw error;
      }
    })();

    let removeAbortListener: (() => void) | undefined;
    let removeSessionListener: (() => void) | undefined;
    let lastHistoryEmit = 0;
    const emitHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
    const maybeEmitHistory = () => {
      if (!options.onHistory) return;
      const now = Date.now();
      // 1s throttle: each emit walks the full message array and triggers a host
      // render; with 8-16 concurrent agents a tighter cadence hammers the CPU.
      if (now - lastHistoryEmit < 1000) return;
      lastHistoryEmit = now;
      emitHistory();
    };
    const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    let lastAssistantUsage: AgentUsage | undefined;
    const emitUsage = (callback: ((usage: AgentUsage) => void) | undefined) => {
      try {
        callback?.({ ...usage });
      } catch {
        // Usage is best-effort; never let its observer mask the real result/error.
      }
    };
    const applyUsage = (change: AgentUsage, direction: 1 | -1) => {
      usage.input += change.input * direction;
      usage.output += change.output * direction;
      usage.cacheRead += change.cacheRead * direction;
      usage.cacheWrite += change.cacheWrite * direction;
      usage.total += change.total * direction;
      usage.cost += change.cost * direction;
      emitUsage(options.onUsageUpdate);
    };
    const recordAssistantUsage = (message: AssistantMessage) => {
      lastAssistantUsage = {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        total: message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite,
        cost: message.usage.cost.total,
      };
      applyUsage(lastAssistantUsage, 1);
    };
    try {
      if (options.signal?.aborted) throw abortError();
      if (options.signal) {
        const onAbort = () => {
          session.abortBash();
          void session.abort();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.onHistory || options.onUsageUpdate || options.onUsage) {
        removeSessionListener = session.subscribe((event) => {
          maybeEmitHistory();
          if (event.type === "message_end" && event.message.role === "assistant") {
            recordAssistantUsage(event.message);
          } else if (event.type === "agent_end" && event.willRetry && lastAssistantUsage) {
            applyUsage(lastAssistantUsage, -1);
            lastAssistantUsage = undefined;
          }
        });
      }

      const completeTurn = async (): Promise<AgentRunResult<TSchemaDef>> => {
        if (options.signal?.aborted) throw abortError();

        // The SDK can bury provider/runtime errors in assistant metadata instead of
        // throwing; detect them before schema/empty-text handling.
        throwIfAssistantExecutionError(session.messages, options.label);

        if (options.schema) {
          return (await resolveStructuredOutput(
            session,
            capture,
            options.schema,
            options,
            (m) => this.lastAssistantText(m),
            () => waitForSubagentIdle(session, options.signal),
          )) as AgentRunResult<TSchemaDef>;
        }

        const text = this.lastAssistantText(session.messages);
        if (!text.trim()) {
          throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
            recoverable: true,
            agentLabel: options.label,
          });
        }
        return text as AgentRunResult<TSchemaDef>;
      };

      try {
        await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));
        await waitForSubagentIdle(session, options.signal);
        return await completeTurn();
      } catch (error) {
        const fallbackModel = resolvedFallbackModel;
        const canHandoff =
          resolvedModel &&
          fallbackModel &&
          (resolvedModel.provider !== fallbackModel.provider || resolvedModel.id !== fallbackModel.id);
        if (
          !modelSpec ||
          !fallbackModel ||
          !canHandoff ||
          (!isProviderUsageLimit(error) && !isProviderAuthFailure(error))
        ) {
          throw error;
        }

        const reason = isProviderUsageLimit(error)
          ? "primary provider usage limit"
          : "primary provider authentication failed";
        resolvedModel = fallbackModel;
        // Keep the same transcript and tool state so a writer that already edited
        // files remains one logical agent. Avoid AgentSession.setModel(), which
        // would also overwrite the user's global default model.
        session.agent.state.model = fallbackModel;
        session.sessionManager.appendModelChange(fallbackModel.provider, fallbackModel.id);
        session.setThinkingLevel(session.thinkingLevel);
        options.onModelFallback?.(modelSpec, fallbackSpec, reason);
        options.onModelResolved?.(`${fallbackModel.provider}/${fallbackModel.id}`);

        const structuredReminder = options.schema
          ? " Finish by calling structured_output exactly once with the required replacement result."
          : "";
        await session.prompt(
          `The primary model became unavailable. Continue the same task from this transcript and current tool state. Do not restart or repeat completed work. Verify actual state, finish the original task, and satisfy the original output contract.${structuredReminder}`,
        );
        await waitForSubagentIdle(session, options.signal);
        return await completeTurn();
      }
    } finally {
      removeAbortListener?.();
      removeSessionListener?.();
      try {
        emitHistory();
      } catch {
        // History is diagnostic only; never let it mask the real result/error.
      }
      emitUsage(options.onUsage);
      session.dispose();
      forked?.cleanup();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const task = prompt.trimStart();
    const metadata = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
    ].filter(Boolean);
    const parts = task.startsWith("/") ? [task, ...metadata] : [...metadata, prompt];

    if (structured) {
      parts.push(
        "Finish by calling structured_output exactly once with the result as its arguments — no prose final answer.",
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
