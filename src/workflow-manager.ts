/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import { preview, resolveWorkflowFailureLocation, type WorkflowSnapshot } from "./display.js";
import { errorStack, WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedExecutionOptions,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import {
  type JournalEntry,
  type PendingCheckpoint,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowRunResult,
} from "./workflow.js";

function checkpointFromError(error: WorkflowError): PendingCheckpoint | undefined {
  if (error.code !== WorkflowErrorCode.CHECKPOINT_INPUT_REQUIRED) return undefined;
  const value = error.details;
  if (!value || typeof value !== "object") return undefined;
  const checkpoint = value as Partial<PendingCheckpoint>;
  if (
    !Number.isInteger(checkpoint.callIndex) ||
    typeof checkpoint.hash !== "string" ||
    typeof checkpoint.prompt !== "string"
  ) {
    return undefined;
  }
  return checkpoint as PendingCheckpoint;
}

function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId);
}

function isValidCheckpointReply(_checkpoint: PendingCheckpoint, reply: unknown): reply is string {
  return typeof reply === "string" && reply.trim().length > 0;
}

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Parent Pi session that owns delivery and checkpoint replies. */
  sessionId?: string;
  /** Effective cwd for this run, independent of the host session cwd. */
  cwd: string;
  /** Effective execution limits preserved across pause/resume. */
  executionOptions?: PersistedExecutionOptions;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /** Durable checkpoint currently awaiting a reply from the parent conversation. */
  pendingCheckpoint?: PendingCheckpoint;
  /** Why this run is paused. */
  pauseReason?: "manual" | "usage_limit" | "human_input";
  /** True after the user removes the run; suppresses final persistence from the unwinding execution. */
  deleted?: boolean;
  /** True once the run's execution fully unwound (final state persisted, lease released). */
  finalized?: boolean;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Effective cwd for the workflow and its default subagent/bash execution. */
  cwd?: string;
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Cumulative usage already spent by the replayed prefix. */
  initialTokenUsage?: PersistedRunState["tokenUsage"];
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /**
   * The host Pi session's model registry. When provided, workflow subagents
   * resolve models against the same registry as the main session, including
   * extension-registered providers such as ollama-cloud.
   */
  modelRegistry?: ModelRegistry;
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The host Pi session's model registry, shared with subagents. */
  private modelRegistry?: ModelRegistry;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultAgentRetries: number;
  /** Short-TTL cache for listRuns(): the task panel re-renders on every run event,
   * and an uncached list re-reads + re-parses every persisted run file each time. */
  private runsCache?: { at: number; runs: PersistedRunState[] };
  /** Pending debounced persists, keyed by runId (journal saves are coalesced). */
  private persistTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    // Wrap the persistence writers so ANY save/delete (including direct calls via
    // getPersistence()) invalidates the listRuns() cache.
    const persistence = createRunPersistence(this.cwd);
    this.persistence = {
      ...persistence,
      save: (state, opts) => {
        this.runsCache = undefined;
        persistence.save(state, opts);
      },
      delete: (runId) => {
        this.runsCache = undefined;
        return persistence.delete(runId);
      },
    };
    this.recoverStaleRuns();
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            this.persistence.save({ ...p, status: "paused" });
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Set the host session's model registry so subagents resolve models consistently. */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /**
   * The host session's model registry, when set. Read lazily (e.g. by the
   * workflow tool's model routing guideline) since `setModelRegistry` is called
   * from `session_start`, which runs after the tool is created — a snapshot
   * taken at tool-creation time would miss it.
   */
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const runId = generateRunId();
    const controller = new AbortController();
    const parsed = parseWorkflowScript(script);
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      sessionId: this.sessionId,
      cwd: exec.cwd ?? this.cwd,
      executionOptions: this.resolveExecutionOptions(exec),
      journal: [],
      background: true,
      lease,
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state
      this.persistence.save({
        runId,
        workflowName: parsed.meta.name,
        script,
        args,
        cwd: managed.cwd,
        executionOptions: managed.executionOptions,
        sessionId: this.sessionId,
        status: "running",
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        updatedAt: managed.startedAt.toISOString(),
      });
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.createManaged(script, args, exec);
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.executeRun(managed, script, args, exec);
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown, exec: ExecOptions = {}): ManagedRun {
    const parsed = parseWorkflowScript(script);
    return {
      runId: generateRunId(),
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      sessionId: this.sessionId,
      cwd: exec.cwd ?? this.cwd,
      executionOptions: this.resolveExecutionOptions(exec),
      journal: [],
      background: false,
    };
  }

  private resolveExecutionOptions(exec: ExecOptions): PersistedExecutionOptions {
    return {
      maxAgents: exec.maxAgents,
      agentTimeoutMs: exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs,
      tokenBudget: exec.tokenBudget,
      concurrency: exec.concurrency ?? this.concurrency,
      agentRetries: exec.agentRetries ?? this.defaultAgentRetries,
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const {
      resumeJournal,
      maxAgents,
      agentTimeoutMs,
      externalSignal,
      onProgress,
      tokenBudget,
      concurrency,
      agentRetries,
      initialTokenUsage,
    } = exec;
    const resolvedAgentTimeoutMs = agentTimeoutMs !== undefined ? agentTimeoutMs : this.defaultAgentTimeoutMs;
    const resolvedConcurrency = concurrency ?? this.concurrency;
    const resolvedAgentRetries = agentRetries ?? this.defaultAgentRetries;
    managed.executionOptions ??= {
      maxAgents,
      agentTimeoutMs: resolvedAgentTimeoutMs,
      tokenBudget,
      concurrency: resolvedConcurrency,
      agentRetries: resolvedAgentRetries,
    };
    const progress = () => onProgress?.(managed.snapshot);
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
    }
    try {
      const result = await runWorkflow(script, {
        runId: managed.runId,
        cwd: managed.cwd,
        args,
        agent: this.agent,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        tokenBudget,
        initialTokenUsage,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        onAgentJournal: (entry) => {
          // Keep the latest entry per index, then persist (debounced: journal flushes
          // rewrite the whole run file, so per-agent-completion writes are coalesced).
          const existing = managed.journal.findIndex((e) => e.index === entry.index);
          if (existing >= 0) managed.journal[existing] = entry;
          else managed.journal.push(entry);
          this.schedulePersist(managed);
        },
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
          });
          this.emit("agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.tokens = event.tokens;
            if (event.model) agent.model = event.model;
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onAgentHistory: (event) => {
          const agent = [...managed.snapshot.agents]
            .reverse()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.history = event.history;
          }
          this.emit("agentHistory", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          managed.snapshot.tokenUsage = usage;
          this.emit("tokenUsage", { runId: managed.runId, usage });
          progress();
        },
      });

      if (managed.deleted || managed.finalized) {
        managed.finalized = true;
        this.releaseRunLease(managed);
        return result;
      }

      managed.status = "completed";
      managed.result = result;
      this.emit("complete", { runId: managed.runId, result });

      // Persist final state
      this.persistRun(managed);
      managed.finalized = true;
      this.releaseRunLease(managed);

      return result;
    } catch (error) {
      const wrappedError = wrapError(error);
      const workflowError =
        managed.controller.signal.aborted && wrappedError.code !== WorkflowErrorCode.WORKFLOW_ABORTED
          ? new WorkflowError(wrappedError.message, WorkflowErrorCode.WORKFLOW_ABORTED, {
              recoverable: true,
              details: error,
            })
          : wrappedError;

      const checkpoint = checkpointFromError(workflowError);
      if (!managed.controller.signal.aborted && checkpoint) {
        managed.status = "paused";
        managed.pendingCheckpoint = checkpoint;
        managed.pauseReason = "human_input";
        if (!this.persistRun(managed)) {
          const persistenceError = new WorkflowError(
            "Could not persist the workflow checkpoint",
            WorkflowErrorCode.PERSISTENCE_ERROR,
            { recoverable: false, details: workflowError },
          );
          managed.status = "failed";
          managed.pendingCheckpoint = undefined;
          managed.pauseReason = undefined;
          managed.error = persistenceError;
          this.emit("error", { runId: managed.runId, error: persistenceError });
          managed.finalized = true;
          this.releaseRunLease(managed);
          throw persistenceError;
        }
        this.emit("paused", { runId: managed.runId, reason: "human_input", checkpoint });
        managed.finalized = true;
        this.releaseRunLease(managed);
        this.runs.delete(managed.runId);
        throw new WorkflowError(workflowError.message, WorkflowErrorCode.CHECKPOINT_INPUT_REQUIRED, {
          recoverable: false,
          details: { ...checkpoint, runId: managed.runId },
        });
      }

      const usageLimitPaused =
        !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
      let abortedByHost = false;
      if (managed.controller.signal.aborted) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
        if (managed.status === "running") {
          managed.status = "aborted";
          abortedByHost = true; // Esc/external abort: no pause()/stop() emitted an event
        }
      } else if (usageLimitPaused) {
        managed.pauseReason = "usage_limit";
        // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
        // the persisted journal (completed agent results) is replayed by resume()
        // once the budget refills — instead of the user starting from scratch.
        managed.status = "paused";
      } else {
        managed.status = "failed";
      }
      managed.error = workflowError;
      if (managed.deleted || managed.finalized) {
        // Removed, or already finalized by pause()/stop() (which persisted the
        // final state and released the lease) — do not persist again: another
        // process may have legitimately taken the run over since.
        managed.finalized = true;
        this.releaseRunLease(managed);
        throw workflowError;
      }

      if (usageLimitPaused) {
        this.emit("paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
        });
      } else if (abortedByHost) {
        // Host abort (Esc / external signal): the run was stopped, not failed —
        // pause()/stop() paths already emitted their own event before this unwind.
        this.emit("stopped", { runId: managed.runId });
      } else if (!managed.controller.signal.aborted) {
        this.emit("error", { runId: managed.runId, error: workflowError });
      }

      // Persist final state. The lease is held until here — pause()/stop() do not
      // release it early, so another process cannot resume this run and have its
      // state clobbered by this late persist.
      this.persistRun(managed);
      managed.finalized = true;
      this.releaseRunLease(managed);

      throw workflowError;
    }
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  /**
   * Debounced persist for hot-path saves (journal flushes). Coalesces a burst of
   * agent completions into one full-file write; status transitions persist
   * immediately via persistRun() (which cancels any pending flush).
   */
  private schedulePersist(managed: ManagedRun): void {
    if (managed.deleted || managed.finalized) return;
    if (this.persistTimers.has(managed.runId)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(managed.runId);
      if (managed.deleted || managed.finalized) return;
      this.persistRun(managed);
    }, 250);
    (timer as { unref?: () => void }).unref?.();
    this.persistTimers.set(managed.runId, timer);
  }

  private cancelScheduledPersist(runId: string): void {
    const timer = this.persistTimers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(runId);
  }

  private persistRun(managed: ManagedRun): boolean {
    if (managed.deleted) return false;
    this.cancelScheduledPersist(managed.runId);
    const failureLocation = resolveWorkflowFailureLocation(managed.snapshot, managed.error?.agentLabel);
    try {
      this.persistence.save(
        {
          runId: managed.runId,
          workflowName: managed.snapshot.name,
          // Persist the real script + journal so the run can be resumed. Runs live
          // in workflow run storage — protect via directory permissions, not blanking.
          script: managed.script,
          args: managed.args,
          cwd: managed.cwd,
          executionOptions: managed.executionOptions,
          sessionId: managed.sessionId,
          journal: managed.journal,
          status: managed.status,
          pauseReason: managed.status === "paused" ? managed.pauseReason : undefined,
          pendingCheckpoint: managed.status === "paused" ? managed.pendingCheckpoint : undefined,
          resetHint:
            managed.status === "paused" && managed.pauseReason === "usage_limit" ? managed.error?.resetHint : undefined,
          phases: managed.snapshot.phases,
          currentPhase: managed.snapshot.currentPhase,
          agents: managed.snapshot.agents.map((a) => ({
            ...a,
            startedAt: managed.startedAt.toISOString(),
            endedAt: new Date().toISOString(),
          })),
          logs: managed.snapshot.logs,
          result: managed.result?.result,
          error: managed.error
            ? {
                message: managed.error.message,
                code: managed.error.code,
                recoverable: managed.error.recoverable,
                phase: failureLocation.phase,
                agentLabel: failureLocation.agentLabel,
                stack: errorStack(managed.error.details) ?? managed.error.stack,
              }
            : undefined,
          tokenUsage: managed.snapshot.tokenUsage
            ? {
                input: managed.snapshot.tokenUsage.input,
                output: managed.snapshot.tokenUsage.output,
                total: managed.snapshot.tokenUsage.total,
                cost: managed.snapshot.tokenUsage.cost,
                cacheRead: managed.snapshot.tokenUsage.cacheRead,
                cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
              }
            : undefined,
          startedAt: managed.startedAt.toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
          durationMs: managed.result?.durationMs,
          // Skip the .bak sidecar while the run is hot; final states keep the backup.
        },
        { backup: managed.status !== "running" },
      );
      return true;
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
      return false;
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    managed.pauseReason = "manual";
    this.emit("paused", { runId });
    // Persist the final paused state and release the lease NOW so the run is
    // immediately resumable; `finalized` suppresses the unwinding execution's
    // own late persist, which could otherwise clobber a subsequent resume.
    this.persistRun(managed);
    managed.finalized = true;
    this.releaseRunLease(managed);
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. A human-input pause must use resumeWithReply().
   */
  async resume(runId: string): Promise<boolean> {
    const active = this.runs.get(runId);
    if (active?.status === "running" || active?.status === "aborted") return false;

    const persisted = this.persistence.load(runId);
    if (
      !persisted?.script ||
      persisted.status === "completed" ||
      persisted.status === "aborted" ||
      persisted.pendingCheckpoint
    ) {
      return false;
    }
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    this.startResumedRun(persisted, lease, persisted.journal ?? []);
    return true;
  }

  /** Supply the one pending checkpoint reply and continue the same persisted run. */
  async resumeWithReply(runId: string, reply: unknown): Promise<boolean> {
    if (!isValidRunId(runId)) return false;
    const active = this.runs.get(runId);
    if (active?.status === "running" || active?.status === "aborted") return false;

    const persisted = this.persistence.load(runId);
    const checkpoint = persisted?.pendingCheckpoint;
    if (!persisted?.script || persisted.status !== "paused" || !checkpoint) return false;
    if (!this.ownsCurrentSession(persisted.sessionId)) return false;
    if (!isValidCheckpointReply(checkpoint, reply)) return false;

    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      const latest = this.persistence.load(runId);
      const currentCheckpoint = latest?.pendingCheckpoint;
      if (
        !latest?.script ||
        latest.status !== "paused" ||
        !currentCheckpoint ||
        !this.ownsCurrentSession(latest.sessionId) ||
        !isValidCheckpointReply(currentCheckpoint, reply)
      ) {
        this.persistence.releaseRunLease(lease);
        return false;
      }
      const journal = [
        ...(latest.journal ?? []).filter((entry) => entry.index !== currentCheckpoint.callIndex),
        { index: currentCheckpoint.callIndex, hash: currentCheckpoint.hash, result: reply },
      ].sort((left, right) => left.index - right.index);
      const resumedState: PersistedRunState = {
        ...latest,
        journal,
        pendingCheckpoint: undefined,
        pauseReason: undefined,
        resetHint: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.persistence.save(resumedState);
      this.startResumedRun(resumedState, lease, journal);
      return true;
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      throw error;
    }
  }

  private startResumedRun(persisted: PersistedRunState, lease: RunLease, journal: JournalEntry[]): void {
    const managed: ManagedRun = {
      runId: persisted.runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script: persisted.script,
      args: persisted.args,
      sessionId: persisted.sessionId,
      cwd: persisted.cwd ?? this.cwd,
      executionOptions: persisted.executionOptions,
      journal,
      background: true,
      lease,
    };
    this.runs.set(persisted.runId, managed);

    const resumeJournal = new Map(journal.map((entry) => [entry.index, entry] as const));
    this.emit("resumed", { runId: persisted.runId });
    void this.executeRun(managed, persisted.script, persisted.args, {
      ...persisted.executionOptions,
      resumeJournal,
      initialTokenUsage: persisted.tokenUsage,
    }).catch(() => {});
  }

  private hasLiveExternalOwner(runId: string): boolean {
    const lock = this.persistence.getRunLock(runId);
    return Boolean(lock?.alive && !this.runs.has(runId));
  }

  /**
   * Stop a running or paused workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) {
      if (managed.status !== "running" && managed.status !== "paused") return false;

      managed.controller.abort();
      managed.status = "aborted";
      this.emit("stopped", { runId });
      // Same contract as pause(): persist the final state, mark finalized so the
      // unwinding execution's late persist is suppressed, release the lease.
      this.persistRun(managed);
      managed.finalized = true;
      this.releaseRunLease(managed);
      return true;
    }

    // A paused/running checkpoint with a live lock but no in-memory run belongs
    // to another manager/Pi session. This manager cannot safely stop it, and the
    // UI filters it out; leave it alone.
    const persisted = this.persistence.load(runId);
    if (!persisted || (persisted.status !== "running" && persisted.status !== "paused")) return false;
    if (this.hasLiveExternalOwner(runId)) return false;

    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      const latest = this.persistence.load(runId) ?? persisted;
      if (latest.status !== "running" && latest.status !== "paused") return false;
      this.persistence.save({
        ...latest,
        status: "aborted",
        pauseReason: undefined,
        pendingCheckpoint: undefined,
        resetHint: undefined,
      });
      this.emit("stopped", { runId });
      return true;
    } finally {
      this.persistence.releaseRunLease(lease);
    }
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  private ownsCurrentSession(owner: string | undefined): boolean {
    return this.sessionId === undefined || owner === undefined || owner === this.sessionId;
  }

  /** Whether this run belongs to the parent Pi session currently bound to the manager. */
  isRunInCurrentSession(runId: string): boolean {
    const owner = this.runs.get(runId)?.sessionId ?? this.persistence.load(runId)?.sessionId;
    return this.ownsCurrentSession(owner);
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const now = Date.now();
    // 300ms TTL: the task panel calls this on every run event; without a cache
    // each call re-reads and re-parses every persisted run file plus a lock file
    // and a pid liveness probe per run. Writers invalidate via the wrapped
    // persistence, so the TTL only bounds staleness from OTHER processes.
    if (!this.runsCache || now - this.runsCache.at > 300) {
      this.runsCache = {
        at: now,
        runs: this.persistence.list().filter((r) => !this.hasLiveExternalOwner(r.runId)),
      };
    }
    const all = this.runsCache.runs;
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run. If this manager owns it, abort it first so the
   * deleted record is not recreated while the execution unwinds. Live runs owned
   * by another manager/Pi session are ignored; listRuns() filters them out.
   */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) {
      managed.deleted = true;
      managed.controller.abort();
      managed.status = "aborted";
      this.cancelScheduledPersist(runId);
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      this.persistence.delete(runId);
      this.emit("stopped", { runId });
      return true;
    }

    if (this.hasLiveExternalOwner(runId)) return false;
    const deleted = this.persistence.delete(runId);
    if (deleted) this.emit("stopped", { runId });
    return deleted;
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
