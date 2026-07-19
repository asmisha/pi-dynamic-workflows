import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { AgentUsage } from "./agent.js";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { workflowProjectPaths } from "./workflow-paths.js";

const AGENT_TIMEOUT_CLEANUP_GRACE_MS = 1000;

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model/tier. */
  model?: string;
}

export type JournalCallKind = "agent" | "bash" | "checkpoint";
export type JournalEntryStatus = "succeeded" | "failed";

export interface JournalEntryError {
  message: string;
  code: WorkflowErrorCode;
  recoverable: boolean;
  agentLabel?: string;
  phase?: string;
}

/** One durable runtime call state. Legacy entries only have index/hash/result. */
export interface JournalEntry {
  /** Legacy deterministic call index; still used for prefix resume and old run files. */
  index: number;
  /** Deterministic structural call ID for same-run retry. */
  callId?: string;
  kind?: JournalCallKind;
  status?: JournalEntryStatus;
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result?: unknown;
  error?: JournalEntryError;
  /** Durable retry attempt count for this call. */
  attempt?: number;
  /** Workflow author safety flag. Agent calls default true; side-effecting agents may opt out. */
  retryable?: boolean;
  label?: string;
  phase?: string;
}

/** Global resources shared by the runtime's agent and bash primitives. */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  /** Live/queued agent/bash calls and combinator branches; checkpoints require this to be zero. */
  activeCalls: number;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `.pi/agents` (project) + `~/.pi/agents`.
   * Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  concurrency?: number;
  /** Run-level retry attempts after a recoverable agent failure. Read-only calls default to at least one. */
  agentRetries?: number;
  tokenBudget?: number | null;
  /** Trusted native ESM workflow loaded from scriptPath. Inline workflows omit this. */
  workflowModule?: WorkflowModuleDefinition;
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /** Resume: cached call results keyed by deterministic call index. */
  resumeJournal?: Map<number, JournalEntry>;
  /** Retry: failed structural call IDs to rerun while replaying successful siblings. */
  retryFailedCallIds?: Set<string>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Resume: cumulative usage already spent by the journaled prefix. */
  initialTokenUsage?: Partial<SharedRuntime["tokenUsage"]>;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Internal: observes runtime-owned agent()/bash() promises and combinator branches. */
  onRuntimeOwnedWorkStart?: (work: Promise<unknown>) => void;
  /** Internal: records failed agent calls that escaped a runtime-owned branch. */
  onAgentFailureEscaped?: (callId: string) => void;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { callId: string; label: string; phase?: string; prompt: string; model?: string }) => void;
  onAgentEnd?: (event: {
    callId: string;
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    model?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
  }) => void;
  onAgentHistory?: (event: { callId: string; label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  onAgentUsage?: (event: { callId: string; label: string; phase?: string; tokens: number }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * The workflow author chooses per-agent models per the routing policy in the
   * tool guidelines (e.g. a lighter model for exploration, the main model for
   * analysis). When omitted, the session's main model is used.
   */
  model?: string;
  /**
   * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
   * model-tiers config (see /workflows-models). An explicit `model` takes
   * precedence; a tier takes precedence over the phase model. When the tier has
   * no configured entry it falls back to the session's main model.
   */
  tier?: string;
  /**
   * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist, model, and body prompt
   * to this agent. An explicit `model` overrides the definition's model; the
   * definition's model overrides `tier`/phase. An unknown name logs a warning
   * and falls back to default tools/model (with the name as a prose hint).
   */
  agentType?: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Retry attempts after a recoverable failure for this agent. Defaults to one for read-only calls. */
  retries?: number;
  /** Whether automatic and durable failure recovery may rerun this agent. Defaults to true. */
  retryable?: boolean;
  /** Exclude code-writing tools and default this call to one automatic recoverable retry. */
  readOnly?: boolean;
  /** Run this agent in a different working directory (tools + session bind to it). */
  cwd?: string;
  /**
   * Fork this Pi session file (JSONL) as the agent's starting context. The source
   * file is never mutated. Without `sessionPath`, the fork is temporary.
   */
  forkFrom?: string;
  /**
   * Persist/continue this agent's working session at this path. Existing files
   * are continued; missing files are created. Relative paths land under
   * ~/.pi/workflows/sessions/. Combined with `forkFrom`, the target must not
   * already exist.
   */
  sessionPath?: string;
}

/** Result of a workflow-level bash() call. Full output is stored on disk. */
export interface WorkflowBashResult {
  /** PID of the spawned bash process. */
  pid: number | null;
  /** Process exit code; null when killed by a signal. */
  exitCode: number | null;
  /** File containing full stdout. */
  stdoutFile: string;
  /** File containing full stderr. */
  stderrFile: string;
}

export interface WorkflowRuntimeContext {
  agent: (prompt: string, options?: AgentOptions) => Promise<unknown>;
  bash: (command: string, options?: { cwd?: string; timeoutMs?: number | null }) => Promise<WorkflowBashResult>;
  parallel: (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
  pipeline: (
    items: unknown[],
    ...stages: Array<(previous: unknown, original: unknown, index: number) => unknown>
  ) => Promise<unknown[]>;
  checkpoint: (question: string) => unknown;
  log: (message: string) => void;
  phase: (title: string, options?: { budget?: number }) => void;
  args: unknown;
  cwd: string;
  budget: {
    total: number | null;
    spent: () => number;
    remaining: () => number;
  };
}

export interface WorkflowModuleDefinition {
  meta: WorkflowMeta;
  run: (context: WorkflowRuntimeContext) => unknown | Promise<unknown>;
}

/** Persisted identity of the one checkpoint currently awaiting a parent-chat reply. */
export interface PendingCheckpoint {
  callIndex: number;
  callId?: string;
  hash: string;
  prompt: string;
}

interface RuntimeExecutionContext {
  concurrent: boolean;
  path: string;
  callSeq: number;
  branchSeq: number;
}

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /** At most one durable parent checkpoint is allowed per run. */
  checkpointSeen: boolean;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = options.workflowModule
    ? { meta: options.workflowModule.meta, body: "" }
    : parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const maxAgents = options.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    callSeq: 0,
    checkpointSeen: false,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  const initialUsage = options.initialTokenUsage;
  const shared: SharedRuntime = {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: initialUsage?.total ?? 0,
    tokenUsage: {
      input: initialUsage?.input ?? 0,
      output: initialUsage?.output ?? 0,
      total: initialUsage?.total ?? 0,
      cost: initialUsage?.cost ?? 0,
      cacheRead: initialUsage?.cacheRead ?? 0,
      cacheWrite: initialUsage?.cacheWrite ?? 0,
    },
    activeCalls: 0,
  };
  const limiter = shared.limiter;
  const rootExecutionContext: RuntimeExecutionContext = { concurrent: false, path: "root", callSeq: 0, branchSeq: 0 };
  const executionContext = new AsyncLocalStorage<RuntimeExecutionContext>();
  const currentExecutionContext = () => executionContext.getStore() ?? rootExecutionContext;
  const nextCallIdentity = () => {
    const ctx = currentExecutionContext();
    const localSeq = ctx.callSeq++;
    return { index: state.callSeq++, callId: `${ctx.path}/${localSeq}` };
  };
  const nextBranchBase = (kind: "parallel" | "pipeline") => {
    const ctx = currentExecutionContext();
    const branchSeq = ctx.branchSeq++;
    return `${ctx.path}/${kind}${branchSeq}`;
  };
  const childExecutionContext = (path: string): RuntimeExecutionContext => ({
    concurrent: true,
    path,
    callSeq: 0,
    branchSeq: 0,
  });
  const observeRuntimeOwnedWork = <T>(work: Promise<T>): Promise<T> => {
    // Keep the exact promise returned to workflow code observed even when a
    // malformed script discards it. The handler does not change rejection
    // semantics for callers that await/return the promise.
    void work.catch(() => {});
    options.onRuntimeOwnedWorkStart?.(work);
    return work;
  };
  const trackCombinatorBranch = <T>(branch: Promise<T>): Promise<T> => {
    shared.activeCalls++;
    const work = observeRuntimeOwnedWork(branch);
    void work.catch((error) => {
      if (error instanceof WorkflowError && error.callId) options.onAgentFailureEscaped?.(error.callId);
    });
    void work.then(
      () => shared.activeCalls--,
      () => shared.activeCalls--,
    );
    return work;
  };

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  let abandonedAgentError: WorkflowError | undefined;
  const throwIfAborted = () => {
    if (abandonedAgentError) throw abandonedAgentError;
    if (options.signal?.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const retryFailedCallIds = options.retryFailedCallIds ?? new Set<string>();
  const retryMode = retryFailedCallIds.size > 0;
  const resumeJournalByCallId = new Map<string, JournalEntry>();
  for (const entry of options.resumeJournal?.values() ?? []) {
    if (entry.callId) resumeJournalByCallId.set(entry.callId, entry);
  }
  const cachedForCall = (callId: string, index: number): JournalEntry | undefined =>
    resumeJournalByCallId.get(callId) ?? options.resumeJournal?.get(index);
  const ensureRetryHash = (entry: JournalEntry | undefined, hash: string, callId: string) => {
    if (retryMode && entry && entry.hash !== hash) {
      throw new WorkflowError(
        `workflow retry journal mismatch for call ${callId}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        {
          recoverable: false,
        },
      );
    }
  };

  const agentImpl = async (prompt: string, agentOptions: AgentOptions = {}) => {
    throwIfAborted();

    // Check agent limit
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }

    const assignedPhase = agentOptions.phase ?? state.currentPhase;
    const requestedLabel = agentOptions.label?.trim();

    // Resolve a named agentType to its bound definition (tools/model/prompt).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
    // The "explicit-level" model is opts.model, else the definition's model — either
    // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
    // the phase model) decides inside WorkflowAgent.run().
    const explicitModel = agentOptions.model ?? agentDef?.model;
    const modelSpec =
      explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
    // For display in /workflows: the model this agent runs on — its explicit/phase
    // spec, else the session's main model. The real resolved id overrides this via
    // onModelResolved once the subagent session is created.
    let displayModel = modelSpec ?? options.mainModel;

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const { index: callIndex, callId } = nextCallIdentity();
    const callHash = hashAgentCall(prompt, modelSpec, assignedPhase, agentOptions, agentDefinitionKey(agentDef));

    // Reserve the agent slot synchronously — atomic with the limit/budget gate
    // above (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
    // spent accrues after each agent, matching Claude Code; in-flight agents may
    // push slightly past total, then further agent() calls throw.)
    shared.agentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    const cached = cachedForCall(callId, callIndex);
    ensureRetryHash(cached, callHash, callId);
    const hashMatches = cached != null && cached.hash === callHash;
    const cachedSucceeded = isJournalSuccess(cached);
    const cachedEmptyOutput = cachedSucceeded && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    if (hashMatches && cachedSucceeded && !cachedEmptyOutput && (retryMode || callIndex < state.firstMiss)) {
      options.onAgentStart?.({ callId, label, phase: assignedPhase, prompt, model: displayModel });
      options.onAgentEnd?.({
        callId,
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: 0,
        model: displayModel,
      });
      return cached.result;
    }
    if (retryMode && cached?.status === "failed") {
      if (!retryFailedCallIds.has(callId) || cached.retryable === false) {
        throw new WorkflowError(
          `workflow retry cannot rerun call ${callId}`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          {
            recoverable: false,
          },
        );
      }
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }
    // A genuine miss (no journal entry, failed entry, or hash change) marks where
    // the unchanged prefix ends; this call and every later one then run live.
    if (!retryMode && (!hashMatches || !cachedSucceeded || cachedEmptyOutput)) {
      state.firstMiss = Math.min(state.firstMiss, callIndex);
    }

    shared.activeCalls++;
    const work = limiter(async () => {
      throwIfAborted();
      const timeout = agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs;
      const mayRetry = agentOptions.retryable !== false;
      const defaultRetries = agentOptions.readOnly
        ? Math.max(options.agentRetries ?? 0, 1)
        : (options.agentRetries ?? 0);
      const retryAttempts = mayRetry ? normalizeAgentRetries(agentOptions.retries ?? defaultRetries) : 0;
      const maxAttempts = retryAttempts + 1;
      const durableAttempt = (cached?.status === "failed" ? (cached.attempt ?? 1) : 0) + 1;

      options.onAgentStart?.({ callId, label, phase: assignedPhase, prompt, model: displayModel });

      // Each retry attempt reports cumulative snapshots from zero. Keep its
      // baseline local while publishing the logical agent's cumulative total.
      let committedTokens = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let usage: AgentUsage | undefined;
        let acceptingUsage = true;
        const updateUsage = (next: AgentUsage) => {
          if (!acceptingUsage) return;
          const previous = usage;
          shared.tokenUsage.input += next.input - (previous?.input ?? 0);
          shared.tokenUsage.output += next.output - (previous?.output ?? 0);
          shared.tokenUsage.cost += next.cost - (previous?.cost ?? 0);
          shared.tokenUsage.cacheRead += next.cacheRead - (previous?.cacheRead ?? 0);
          shared.tokenUsage.cacheWrite += next.cacheWrite - (previous?.cacheWrite ?? 0);
          const tokenDelta = next.total - (previous?.total ?? 0);
          shared.tokenUsage.total += tokenDelta;
          usage = next;
          options.onAgentUsage?.({
            callId,
            label,
            phase: assignedPhase,
            tokens: committedTokens + next.total,
          });
          options.onTokenUsage?.(shared.tokenUsage);
        };
        const commitUsage = (result: unknown) => {
          let tokens = usage?.total ?? 0;
          if (tokens > 0) {
            shared.spent += tokens;
            committedTokens += tokens;
            return;
          }
          tokens = estimateTokens(result) + estimateTokens(prompt);
          shared.tokenUsage.total += tokens;
          shared.spent += tokens;
          committedTokens += tokens;
          options.onAgentUsage?.({ callId, label, phase: assignedPhase, tokens: committedTokens });
          options.onTokenUsage?.(shared.tokenUsage);
        };
        // Per-attempt abort scope: fires on run abort AND on timeout, so a timed-out
        // attempt's session is actually torn down instead of running (and consuming
        // tokens/RAM outside the concurrency cap) until it finishes naturally.
        const attemptController = new AbortController();
        const onRunAbort = () => attemptController.abort();
        if (options.signal?.aborted) attemptController.abort();
        else options.signal?.addEventListener("abort", onRunAbort, { once: true });
        try {
          throwIfAborted();

          // Run agent with timeout; timeout aborts the attempt's session.
          const result = await withTimeout(
            agentRunner.run(prompt, {
              label,
              schema: agentOptions.schema,
              signal: attemptController.signal,
              instructions: buildAgentInstructions(meta, assignedPhase, agentOptions, agentDef),
              model: modelSpec,
              tier: agentOptions.tier,
              modelRegistry: options.modelRegistry,
              toolNames: agentDef?.tools,
              disallowedToolNames: agentDef?.disallowedTools,
              readOnly: agentOptions.readOnly,
              cwd: agentOptions.cwd ?? baseCwd,
              forkFrom: agentOptions.forkFrom,
              sessionPath: agentOptions.sessionPath,
              onModelResolved: (id: string) => {
                displayModel = id;
              },
              onModelFallback: (spec: string) => {
                // Make the silent degrade visible in /workflows, not just console.
                log(`${label}: model "${spec}" unavailable — using the session default`);
              },
              onUsageUpdate: updateUsage,
              onUsage: (finalUsage) => {
                if (
                  usage?.input !== finalUsage.input ||
                  usage?.output !== finalUsage.output ||
                  usage?.cacheRead !== finalUsage.cacheRead ||
                  usage?.cacheWrite !== finalUsage.cacheWrite ||
                  usage?.total !== finalUsage.total ||
                  usage?.cost !== finalUsage.cost
                ) {
                  updateUsage(finalUsage);
                }
              },
              onHistory: (history: AgentHistoryEntry[]) => {
                options.onAgentHistory?.({ callId, label, phase: assignedPhase, history });
              },
            }),
            timeout,
            label,
            () => attemptController.abort(),
          );

          acceptingUsage = false;
          throwIfAborted();
          if (isEmptyTextAgentResult(result, agentOptions.schema)) {
            throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
              recoverable: true,
              agentLabel: label,
            });
          }

          commitUsage(result);
          options.onAgentJournal?.({
            index: callIndex,
            callId,
            kind: "agent",
            status: "succeeded",
            hash: callHash,
            result,
            attempt: durableAttempt,
            retryable: mayRetry,
            label,
            phase: assignedPhase,
          });
          options.onAgentEnd?.({
            callId,
            label,
            phase: assignedPhase,
            result,
            tokens: committedTokens,
            model: displayModel,
          });
          return result;
        } catch (error) {
          acceptingUsage = false;
          if (options.signal?.aborted) throw error;

          const workflowError = wrapError(error, { agentLabel: label, callId });
          if (workflowError.code === WorkflowErrorCode.AGENT_TIMEOUT && !workflowError.recoverable) {
            abandonedAgentError ??= workflowError;
          }
          logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
          commitUsage(null);

          if (workflowError.recoverable && attempt < maxAttempts) {
            log(
              `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
            );
            continue;
          }

          options.onAgentJournal?.({
            index: callIndex,
            callId,
            kind: "agent",
            status: "failed",
            hash: callHash,
            error: {
              message: workflowError.message,
              code: workflowError.code,
              recoverable: workflowError.recoverable,
              agentLabel: label,
              phase: assignedPhase,
            },
            attempt: durableAttempt,
            retryable: mayRetry,
            label,
            phase: assignedPhase,
          });
          options.onAgentEnd?.({
            callId,
            label,
            phase: assignedPhase,
            result: null,
            tokens: committedTokens,
            model: displayModel,
            error: workflowError.message,
            errorCode: workflowError.code,
            recoverable: workflowError.recoverable,
          });

          if (workflowError.recoverable) {
            log(
              `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
            );
          }
          throw workflowError;
        } finally {
          acceptingUsage = false;
          options.signal?.removeEventListener("abort", onRunAbort);
        }
      }
      throw new WorkflowError("agent retry loop exited unexpectedly", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
        recoverable: false,
        agentLabel: label,
      });
    }).finally(() => {
      shared.activeCalls--;
    });
    return work;
  };
  const agent = (prompt: string, agentOptions: AgentOptions = {}): Promise<unknown> =>
    observeRuntimeOwnedWork(agentImpl(prompt, agentOptions));

  // Journaled shell step: run a command, write full stdout/stderr to files, and
  // cache the result by call index exactly like agent(). Bash output is
  // nondeterministic, so the journal is what keeps resume's longest-unchanged-
  // prefix contract intact without re-running side effects.
  const bashImpl = async (
    command: string,
    bashOptions: { cwd?: string; timeoutMs?: number | null } = {},
  ): Promise<WorkflowBashResult> => {
    throwIfAborted();
    if (typeof command !== "string" || !command.trim()) {
      throw new TypeError("bash(command, options?) needs a non-empty command string");
    }
    const { index: callIndex, callId } = nextCallIdentity();
    const callHash = hashBashCall(command, bashOptions.cwd, bashOptions.timeoutMs ?? null);
    const cached = cachedForCall(callId, callIndex);
    ensureRetryHash(cached, callHash, callId);
    const hashMatches = cached != null && cached.hash === callHash;
    if (hashMatches && isJournalSuccess(cached) && (retryMode || callIndex < state.firstMiss)) {
      return cached.result as WorkflowBashResult;
    }
    if (!retryMode && (cached == null || cached.hash !== callHash || !isJournalSuccess(cached))) {
      state.firstMiss = Math.min(state.firstMiss, callIndex);
    }

    shared.activeCalls++;
    const work = (async () => {
      try {
        const output = bashOutputFiles(baseCwd, runId, callIndex, options.persistLogs ?? true);
        const result = await runBashCommand(command, {
          cwd: bashOptions.cwd ?? baseCwd,
          timeoutMs: bashOptions.timeoutMs ?? null,
          signal: options.signal,
          stdoutFile: output.stdoutFile,
          stderrFile: output.stderrFile,
        });
        throwIfAborted();
        const shortCmd = command.length > 80 ? `${command.slice(0, 80)}…` : command;
        log(
          `$ ${shortCmd} (pid ${result.pid ?? "?"}, exit ${result.exitCode ?? "signal"}; stdout ${result.stdoutFile}; stderr ${result.stderrFile})`,
        );
        options.onAgentJournal?.({
          index: callIndex,
          callId,
          kind: "bash",
          status: "succeeded",
          hash: callHash,
          result,
        });
        return result;
      } finally {
        shared.activeCalls--;
      }
    })();
    return work;
  };
  const bash = (
    command: string,
    bashOptions: { cwd?: string; timeoutMs?: number | null } = {},
  ): Promise<WorkflowBashResult> => observeRuntimeOwnedWork(bashImpl(command, bashOptions));

  const parallel = (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
    observeRuntimeOwnedWork(
      (async () => {
        throwIfAborted();
        if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
        if (thunks.some((thunk) => typeof thunk !== "function")) {
          throw new TypeError(
            "parallel() expects an array of zero-arg functions, not promises. Correct: parallel(items.map(item => () => agent(...))). Wrong: parallel(items.map(item => agent(...))) or parallel(items.map(async item => agent(...))).",
          );
        }
        const branchBase = nextBranchBase("parallel");
        const branches = thunks.map((thunk, index) => {
          const path = `${branchBase}.${index}`;
          return trackCombinatorBranch(
            Promise.resolve().then(() => executionContext.run(childExecutionContext(path), thunk)),
          );
        });
        return Promise.all(branches);
      })(),
    );

  const pipeline = (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ): Promise<unknown[]> =>
    observeRuntimeOwnedWork(
      (async () => {
        throwIfAborted();
        if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
        if (stages.some((stage) => typeof stage !== "function")) {
          throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
        }
        const branchBase = nextBranchBase("pipeline");
        const branches = items.map((item, index) => {
          const path = `${branchBase}.${index}`;
          return trackCombinatorBranch(
            Promise.resolve().then(() =>
              executionContext.run(childExecutionContext(path), async () => {
                let value: unknown = item;
                for (const stage of stages) {
                  throwIfAborted();
                  value = await stage(value, item, index);
                  throwIfAborted();
                }
                return value;
              }),
            ),
          );
        });
        return Promise.all(branches);
      })(),
    );

  // Deterministic durable checkpoint. A live call always unwinds to the workflow
  // manager so the parent conversation can ask the human without holding a worker
  // or VM stack open. resumeWithReply() journals the answer; the next execution
  // replays the unchanged prefix and returns that answer here before continuing.
  const checkpoint = (promptText: string, checkpointOptions?: unknown): unknown => {
    throwIfAborted();
    if (typeof promptText !== "string" || promptText.trim().length === 0) {
      throw new TypeError("checkpoint() needs a non-empty question string");
    }
    if (checkpointOptions !== undefined) {
      throw new TypeError("checkpoint() accepts only a question string");
    }
    if (executionContext.getStore()?.concurrent) {
      throw new WorkflowError(
        "checkpoint() must be awaited sequentially, outside parallel() and pipeline()",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    if (state.phaseBudgets.size > 0) {
      throw new WorkflowError(
        "checkpoint() is not supported in workflows with phase token sub-budgets",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    if (shared.activeCalls > 0) {
      throw new WorkflowError(
        "checkpoint() requires all prior runtime work to be awaited",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    if (state.checkpointSeen) {
      throw new WorkflowError(
        "checkpoint() may be called at most once per workflow run",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    state.checkpointSeen = true;
    if (shared.agentCount >= maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const { index: callIndex, callId } = nextCallIdentity();
    const callHash = hashCheckpoint(promptText);
    const cached = cachedForCall(callId, callIndex);
    ensureRetryHash(cached, callHash, callId);
    if (
      cached != null &&
      cached.hash === callHash &&
      isJournalSuccess(cached) &&
      (retryMode || callIndex < state.firstMiss)
    ) {
      shared.agentCount++;
      return cached.result;
    }
    if (!retryMode && (cached == null || cached.hash !== callHash || !isJournalSuccess(cached))) {
      state.firstMiss = Math.min(state.firstMiss, callIndex);
    }
    shared.agentCount++;

    const pending: PendingCheckpoint = { callIndex, callId, hash: callHash, prompt: promptText };
    throw new WorkflowError(promptText, WorkflowErrorCode.CHECKPOINT_INPUT_REQUIRED, {
      recoverable: false,
      details: pending,
    });
  };

  const workflowContext: WorkflowRuntimeContext = Object.freeze({
    agent,
    bash,
    parallel,
    pipeline,
    checkpoint,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    budget,
  });

  let result: unknown;
  if (options.workflowModule) {
    result = await options.workflowModule.run(workflowContext);
  } else {
    const context = vm.createContext({
      ...workflowContext,
      process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
      // Checkpoint workflows must use the provided sequential/parallel primitives;
      // native Promise scheduling can detach work from the durable journal boundary.
      Promise: /\bcheckpoint\s*\(/.test(body) ? undefined : Promise,
      console: {
        log,
        info: log,
        warn: (m: unknown) => log(`[warn] ${String(m)}`),
        error: (m: unknown) => log(`[error] ${String(m)}`),
      },
      // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
      // itself — we deliberately do NOT inject host built-ins, whose .constructor
      // would be the host Function (a determinism-guard bypass). Math/Date are
      // neutered in-realm by DETERMINISM_PRELUDE below.
    });
    result = await new vm.Script(`${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`, {
      filename: `${meta.name || "workflow"}.js`,
    }).runInContext(context);
  }
  if (abandonedAgentError) throw abandonedAgentError;
  if (shared.activeCalls > 0) {
    throw new WorkflowError(
      "workflow returned while runtime work was still active; await all work before returning",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  // Persist logs
  const logFile = logger.persist();
  if (logFile) {
    log(`Logs persisted to ${logFile}`);
  }

  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: shared.agentCount,
    durationMs: Date.now() - started,
    runId,
    tokenUsage: shared.tokenUsage,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  validateCheckpointScheduling(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

export async function loadWorkflowModule(modulePath: string): Promise<WorkflowModuleDefinition> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load workflow module ${modulePath}: ${message}`, { cause: error });
  }

  if (!Object.hasOwn(loaded, "meta")) {
    throw new Error(`Workflow module ${modulePath} must export \`meta\``);
  }
  try {
    validateMeta(loaded.meta);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow module ${modulePath} has invalid \`meta\`: ${message}`, { cause: error });
  }
  if (typeof loaded.run !== "function") {
    throw new Error(`Workflow module ${modulePath} must export function \`run(context)\``);
  }

  return {
    meta: loaded.meta,
    run: loaded.run as WorkflowModuleDefinition["run"],
  };
}

function validateCheckpointScheduling(ast: AnyNode): void {
  let usesCheckpoint = false;
  const asyncNames = new Set<string>();
  walkAst(ast, undefined, (node) => {
    if (node.type === "Identifier" && node.name === "checkpoint") usesCheckpoint = true;
    if (node.type === "FunctionDeclaration" && node.async && node.id?.type === "Identifier") {
      asyncNames.add(node.id.name);
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression") &&
      node.init.async
    ) {
      asyncNames.add(node.id.name);
    }
  });
  if (!usesCheckpoint) return;

  walkAst(ast, undefined, (node, parent) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee as AnyNode;
    const callsAsyncFunction =
      ((callee.type === "ArrowFunctionExpression" || callee.type === "FunctionExpression") && callee.async) ||
      (callee.type === "Identifier" && asyncNames.has(callee.name));
    const callsPromiseCallback =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property?.type === "Identifier" &&
      ["then", "catch", "finally"].includes(callee.property.name);
    if (!callsAsyncFunction && !callsPromiseCallback) return;
    const safelyChained =
      parent?.type === "AwaitExpression" ||
      parent?.type === "ReturnStatement" ||
      (parent?.type === "ArrowFunctionExpression" && parent.body === node);
    if (!safelyChained) {
      throw new WorkflowError(
        "checkpoint workflows cannot detach async functions or Promise callbacks",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
  });
}

function walkAst(node: AnyNode, parent: AnyNode | undefined, visit: (node: AnyNode, parent?: AnyNode) => void): void {
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof child.type === "string") {
          walkAst(child as AnyNode, node, visit);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as AnyNode).type === "string") {
      walkAst(value as AnyNode, node, visit);
    }
  }
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string): string {
  return createHash("sha256").update(promptText).digest("hex");
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
): string {
  const identity = JSON.stringify({
    prompt,
    model: model ?? null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
    cwd: options.cwd ?? null,
    forkFrom: options.forkFrom ?? null,
    sessionPath: options.sessionPath ?? null,
    retryable: options.retryable ?? true,
    readOnly: options.readOnly ?? false,
  });
  return createHash("sha256").update(identity).digest("hex");
}

/** Stable identity hash for a bash() call — a cache miss on resume when it changes. */
function hashBashCall(command: string, cwd: string | undefined, timeoutMs: number | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind: "bash", command, cwd: cwd ?? null, timeoutMs }))
    .digest("hex");
}

function bashOutputFiles(cwd: string, runId: string, callIndex: number, persistLogs: boolean) {
  const dir = persistLogs
    ? join(workflowProjectPaths(cwd).runsDir, `${runId}-bash`)
    : join(tmpdir(), `pi-workflow-bash-${runId}`);
  mkdirSync(dir, { recursive: true });
  const stem = String(callIndex).padStart(4, "0");
  return { stdoutFile: join(dir, `${stem}.stdout`), stderrFile: join(dir, `${stem}.stderr`) };
}

/**
 * Spawn a shell command in its own process group, redirect full stdout/stderr to
 * files, and kill the whole tree on workflow abort or timeout (SIGTERM, then SIGKILL).
 */
function runBashCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number | null; signal?: AbortSignal; stdoutFile: string; stderrFile: string },
): Promise<WorkflowBashResult> {
  return new Promise((resolve, reject) => {
    const abortError = () =>
      new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }

    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    let fdsClosed = false;
    const closeFds = () => {
      if (fdsClosed) return;
      fdsClosed = true;
      for (const fd of [stdoutFd, stderrFd]) {
        if (fd === undefined) continue;
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      stdoutFd = openSync(opts.stdoutFile, "w");
      stderrFd = openSync(opts.stderrFile, "w");
      child = spawn("/bin/bash", ["-c", command], {
        cwd: opts.cwd,
        stdio: ["ignore", stdoutFd, stderrFd],
        // Own process group so an abort can kill the whole tree, not just the shell.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      closeFds();
      reject(error);
      return;
    }
    const pid = child.pid ?? null;

    const killTree = () => {
      const childPid = child.pid;
      if (!childPid) return;
      const signalTree = (sig: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32") process.kill(-childPid, sig);
          else child.kill(sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            // already gone
          }
        }
      };
      signalTree("SIGTERM");
      const hardKill = setTimeout(() => signalTree("SIGKILL"), 2000);
      (hardKill as { unref?: () => void }).unref?.();
    };

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs != null && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, opts.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    }
    const onAbort = () => killTree();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      closeFds();
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (opts.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        reject(
          new WorkflowError(`bash command timed out after ${opts.timeoutMs}ms`, WorkflowErrorCode.AGENT_TIMEOUT, {
            recoverable: true,
          }),
        );
        return;
      }
      resolve({ pid, exitCode: code, stdoutFile: opts.stdoutFile, stderrFile: opts.stderrFile });
    });
  });
}

function buildAgentInstructions(
  meta: WorkflowMeta,
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  // Minimal parent context so the subagent knows what larger task it serves.
  const context = `You are a subagent in workflow "${meta.name}" (${meta.description})${phase ? `, phase "${phase}"` : ""}.`;
  lines.push(context);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.join("\n\n");
}

function isJournalSuccess(entry: JournalEntry | undefined): entry is JournalEntry & { result: unknown } {
  return entry !== undefined && (entry.status === "succeeded" || (entry.status === undefined && "result" in entry));
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/**
 * Abort work at the deadline, then wait for its cleanup before releasing the
 * concurrency slot. This keeps a timed-out attempt's final usage and events
 * from racing a retry or a finalized workflow.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;
  const settled = promise.then(
    (value) => ({ type: "resolved" as const, value }),
    (error: unknown) => ({ type: "rejected" as const, error }),
  );
  const timedOut = new Promise<{ type: "timedOut" }>((resolve) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // aborting is best-effort; the timeout error is the real signal
      }
      resolve({ type: "timedOut" });
    }, ms);
  });

  const outcome = await Promise.race([settled, timedOut]);
  if (timeoutId) clearTimeout(timeoutId);
  if (outcome.type === "resolved") return outcome.value;
  if (outcome.type === "rejected") throw outcome.error;

  let cleanupTimer: NodeJS.Timeout | undefined;
  const cleanupFinished = await Promise.race([
    settled.then(() => true),
    new Promise<false>((resolve) => {
      cleanupTimer = setTimeout(() => resolve(false), AGENT_TIMEOUT_CLEANUP_GRACE_MS);
    }),
  ]);
  if (cleanupTimer) clearTimeout(cleanupTimer);
  if (!cleanupFinished) {
    throw new WorkflowError(
      `Agent "${label}" timed out after ${ms}ms and did not stop within ${AGENT_TIMEOUT_CLEANUP_GRACE_MS}ms`,
      WorkflowErrorCode.AGENT_TIMEOUT,
      { recoverable: false },
    );
  }
  throw new WorkflowError(
    `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
    WorkflowErrorCode.AGENT_TIMEOUT,
    { recoverable: true },
  );
}
