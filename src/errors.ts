/**
 * Workflow-specific error types.
 */

export enum WorkflowErrorCode {
  /** Agent exceeded timeout. */
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  /** Workflow was aborted by user. */
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  /** Agent limit exceeded. */
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  /** Token budget exhausted. */
  TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
  /**
   * The provider's subscription/usage/quota/rate limit was hit. Distinct from the
   * user's self-imposed TOKEN_BUDGET_EXHAUSTED: a provider limit refills on its own,
   * so the run is checkpointed (paused) and replayed by resume() rather than failed.
   */
  PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
  /** A workflow checkpoint is waiting for a reply from the parent conversation. */
  CHECKPOINT_INPUT_REQUIRED = "CHECKPOINT_INPUT_REQUIRED",
  /** Script validation failed. */
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  /** A schema agent never produced valid structured_output (after repair + extraction). */
  SCHEMA_NONCOMPLIANCE = "SCHEMA_NONCOMPLIANCE",
  /** A non-schema agent completed without any assistant text output. */
  AGENT_EMPTY_OUTPUT = "AGENT_EMPTY_OUTPUT",
  /** Agent execution failed. */
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
  /** Run state persistence failed. */
  PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
  /** Unknown error. */
  UNKNOWN = "UNKNOWN",
}

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;
  /** For PROVIDER_USAGE_LIMIT: the provider's human reset hint, e.g. "Resets in ~3h" (verbatim). */
  readonly resetHint?: string;
  /** Deterministic runtime call ID for an agent failure that escaped workflow code. */
  readonly callId?: string;

  constructor(
    message: string,
    code: WorkflowErrorCode,
    options: {
      recoverable?: boolean;
      agentLabel?: string;
      details?: unknown;
      resetHint?: string;
      callId?: string;
    } = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
    this.resetHint = options.resetHint;
    this.callId = options.callId;
  }
}

export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}

export function isProviderUsageLimit(error: unknown): error is WorkflowError {
  return isWorkflowError(error) && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
}

/**
 * Detect a provider subscription/usage/quota/rate-limit exhaustion from free-form
 * error text, and extract the provider's human reset hint when present.
 *
 * The pi SDK does NOT throw these — it records them as an assistant message with
 * stopReason "error" and an errorMessage like "Codex usage limit reached (plus
 * plan). Resets in ~3h.". Callers reading message metadata MUST gate on
 * stopReason === "error" before trusting this, so a task whose own output merely
 * mentions "rate limit" is never misclassified. Patterns mirror the SDK's own
 * non-retryable-limit table. Deliberately excludes transient overloaded/5xx
 * errors, which stay recoverable and keep retrying.
 */
export function classifyProviderLimit(text: string | undefined): { matched: boolean; resetHint?: string } {
  if (!text) return { matched: false };
  const matched =
    /usage limit|limit reached|insufficient[_\s]?quota|quota exceeded|exceeded your current quota|out of budget|available balance|\bquota\b|rate.?limit|too many requests|\b429\b|GoUsageLimitError|FreeUsageLimitError|\bbilling\b/i.test(
      text,
    );
  if (!matched) return { matched: false };
  const reset = text.match(/resets?\s+(?:in|at)\s+[^.\n]+/i);
  return { matched: true, resetHint: reset?.[0]?.trim() };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

export function errorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack;
  if (error && typeof error === "object" && "stack" in error && typeof error.stack === "string") {
    return error.stack;
  }
  return undefined;
}

function isErrorLike(error: unknown): error is { message: string; name?: unknown; stack?: unknown } {
  return (
    error instanceof Error ||
    (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string")
  );
}

export function isAbortError(error: unknown): boolean {
  return isErrorLike(error) && /\babort(?:ed)?\b/i.test(errorMessage(error));
}

export function isTimeoutError(error: unknown): boolean {
  return isErrorLike(error) && (/\btimeout\b/i.test(errorMessage(error)) || error.name === "TimeoutError");
}

/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 */
export interface WorkflowFailureContext {
  runId?: string;
  phase?: string;
  agentLabel?: string;
  callId?: string;
}

export function formatWorkflowFailure(error: unknown, context: WorkflowFailureContext = {}): string {
  const workflowError = wrapError(error, { agentLabel: context.agentLabel });
  const run = context.runId ? ` ${context.runId}` : "";
  const stage = [context.phase, context.agentLabel].filter(Boolean).join(" / ");
  return `Workflow${run} failed${stage ? ` at ${stage}` : ""}: ${workflowError.code}: ${workflowError.message}`;
}

export function wrapError(error: unknown, context?: { agentLabel?: string; callId?: string }): WorkflowError {
  if (isWorkflowError(error)) {
    const agentLabel = error.agentLabel ?? context?.agentLabel;
    const callId = error.callId ?? context?.callId;
    if (agentLabel === error.agentLabel && callId === error.callId) return error;
    return new WorkflowError(error.message, error.code, {
      recoverable: error.recoverable,
      agentLabel,
      details: error.details ?? error,
      resetHint: error.resetHint,
      callId,
    });
  }

  if (error && typeof error === "object" && "recoverable" in error && error.recoverable === false) {
    const rawCode = "code" in error ? error.code : undefined;
    const code =
      typeof rawCode === "string" && Object.values(WorkflowErrorCode).includes(rawCode as WorkflowErrorCode)
        ? (rawCode as WorkflowErrorCode)
        : WorkflowErrorCode.AGENT_EXECUTION_ERROR;
    const agentLabel =
      "agentLabel" in error && typeof error.agentLabel === "string" ? error.agentLabel : context?.agentLabel;
    return new WorkflowError(errorMessage(error), code, {
      recoverable: false,
      agentLabel,
      details: error,
      callId: context?.callId,
    });
  }

  if (isAbortError(error)) {
    return new WorkflowError(errorMessage(error) || "Workflow was aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
      recoverable: true,
      details: error,
      callId: context?.callId,
    });
  }

  if (isTimeoutError(error)) {
    return new WorkflowError(errorMessage(error) || "Agent timed out", WorkflowErrorCode.AGENT_TIMEOUT, {
      recoverable: true,
      agentLabel: context?.agentLabel,
      details: error,
      callId: context?.callId,
    });
  }

  // Defense-in-depth: today the SDK buries provider usage/quota limits in an
  // assistant message (detected in agent.ts), but a future SDK might throw them.
  // Classify a thrown limit here too — recoverable:false so the run checkpoints
  // (paused) instead of being retried into the same wall or silently nulled.
  const message = errorMessage(error);
  const limit = classifyProviderLimit(message);
  if (limit.matched) {
    return new WorkflowError(message, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
      recoverable: false,
      agentLabel: context?.agentLabel,
      resetHint: limit.resetHint,
      callId: context?.callId,
    });
  }

  return new WorkflowError(message, WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
    recoverable: true,
    agentLabel: context?.agentLabel,
    details: error,
    callId: context?.callId,
  });
}
