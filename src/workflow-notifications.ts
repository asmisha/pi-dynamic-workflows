import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAgentStep, resolveWorkflowFailureLocation } from "./display.js";
import { formatWorkflowFailure } from "./errors.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import { workflowOutcome } from "./workflow-outcome.js";

export function deliverText(run: ManagedRun): string {
  const tokens = run.result?.tokenUsage ? ` · ${run.result.tokenUsage.total.toLocaleString()} tokens` : "";
  const agents = run.result?.agentCount ?? run.snapshot.agents.filter(isAgentStep).length;
  const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
  const outcome = workflowOutcome(run.result?.result);
  const icon = outcome && !outcome.startsWith("completed") ? "⚠" : "✓";
  const verdict = outcome ? `; outcome: ${outcome}` : "";
  return (
    `${icon} Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}${duration}${verdict}). ` +
    `full output: ${run.outputFile ?? "unavailable"}`
  );
}

export function failureDeliveryText(run: ManagedRun, error: unknown): string {
  return `✗ ${formatWorkflowFailure(error, {
    runId: run.runId,
    ...resolveWorkflowFailureLocation(run.snapshot, run.error?.agentLabel),
  })}`;
}

export function stoppedDeliveryText(runId: string): string {
  return `⊘ Background workflow ${runId} stopped.`;
}

export function checkpointDeliveryText(runId: string, prompt: string): string {
  return (
    `⏸ Background workflow ${runId} paused for parent-conversation input.\n\n` +
    `${prompt}\n\n` +
    `The run stays paused until a reply continues the same run with workflow({resumeRunId: "${runId}", reply}).`
  );
}

export function agentFailureDeliveryText(runId: string, cause?: string): string {
  return (
    `⏸ Background workflow ${runId} paused after ${cause ?? "retryable agent failure"}. ` +
    `Completed sibling work is saved — run /workflows retry ${runId} to rerun only the failed agent call(s).`
  );
}

export function usageLimitDeliveryText(runId: string, cause?: string, resetHint?: string): string {
  const when = resetHint ? ` (${resetHint})` : "";
  return (
    `⏸ Background workflow ${runId} paused: ${cause ?? "provider usage limit reached"}${when}. ` +
    `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`
  );
}

type DeliverySessionManager = ExtensionContext["sessionManager"];
type WorkflowResultDetails = { runId: string; deliveryId: string };

function deliveredNotificationIds(sessionManager: DeliverySessionManager): Set<string> {
  const ids = new Set<string>();
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "custom_message" || entry.customType !== "workflow-result") continue;
    const details = entry.details as Partial<WorkflowResultDetails> | undefined;
    if (typeof details?.deliveryId === "string") ids.add(details.deliveryId);
  }
  return ids;
}

/**
 * Deliver workflow notifications through the persisted run outbox. An outbox
 * record remains pending until its matching custom message is visible in the
 * append-only session, so a queued message lost with the process is replayed.
 */
export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  sessionManager: DeliverySessionManager,
  options: { isIdle?: () => boolean } = {},
): void {
  // Mutable holder on manager so shared across re-calls (e.g. session_start after /reload).
  const m = manager as unknown as {
    __deliveryInstalled?: boolean;
    __holder?: {
      pi: ExtensionAPI;
      sessionManager: DeliverySessionManager;
      sessionId: string;
      isIdle: () => boolean;
      queuedDeliveryIds: Set<string>;
    };
  };
  const sessionId = sessionManager.getSessionId();

  const reconcile = (options: { noTriggerOnly?: boolean } = {}) => {
    const holder = m.__holder;
    if (!holder) return;

    let deliveredIds: Set<string>;
    try {
      deliveredIds = deliveredNotificationIds(holder.sessionManager);
    } catch {
      return;
    }

    const pending = manager.listPendingTerminalDeliveries(holder.sessionId);
    const pendingIds = new Set(pending.map((delivery) => delivery.deliveryId));
    for (const deliveryId of holder.queuedDeliveryIds) {
      if (!pendingIds.has(deliveryId)) holder.queuedDeliveryIds.delete(deliveryId);
    }

    for (const delivery of pending) {
      if (options.noTriggerOnly && delivery.deliveryMode !== "no-trigger") continue;
      if (deliveredIds.has(delivery.deliveryId)) {
        manager.markTerminalDeliveryDelivered(delivery.runId, delivery.deliveryId);
        holder.queuedDeliveryIds.delete(delivery.deliveryId);
        continue;
      }
      if (delivery.deliveryMode === "no-trigger") {
        try {
          if (!holder.isIdle()) continue;
        } catch {
          // A replaced Pi session invalidates its old ExtensionContext. Leave the
          // durable record pending for reconciliation when that session is opened again.
          continue;
        }
        if (delivery.parentLeafId !== null && delivery.parentLeafId !== undefined) {
          try {
            if (!holder.sessionManager.getBranch().some((entry) => entry.id === delivery.parentLeafId)) continue;
          } catch {
            continue;
          }
        }
      }
      if (holder.queuedDeliveryIds.has(delivery.deliveryId)) continue;

      holder.queuedDeliveryIds.add(delivery.deliveryId);
      try {
        holder.pi.sendMessage<WorkflowResultDetails>(
          {
            customType: "workflow-result",
            content: delivery.content,
            display: true,
            details: { runId: delivery.runId, deliveryId: delivery.deliveryId },
          },
          delivery.deliveryMode === "no-trigger"
            ? { triggerTurn: false }
            : { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        holder.queuedDeliveryIds.delete(delivery.deliveryId);
      }
    }
  };

  if (m.__deliveryInstalled) {
    if (m.__holder) {
      // A session_start/reload is a process-boundary equivalent for queued
      // follow-ups: if no durable entry exists, enqueue the pending record again.
      m.__holder.queuedDeliveryIds.clear();
      m.__holder.pi = pi;
      m.__holder.sessionManager = sessionManager;
      m.__holder.sessionId = sessionId;
      m.__holder.isIdle = options.isIdle ?? (() => true);
    }
    reconcile();
    return;
  }
  m.__deliveryInstalled = true;
  m.__holder = {
    pi,
    sessionManager,
    sessionId,
    isIdle: options.isIdle ?? (() => true),
    queuedDeliveryIds: new Set(),
  };

  manager.on("complete", () => reconcile());
  manager.on("error", () => reconcile());
  manager.on("stopped", () => reconcile());
  manager.on("paused", () => reconcile());
  pi.on("agent_settled", () => {
    m.__holder?.queuedDeliveryIds.clear();
    reconcile();
  });
  // Tree navigation happens before the next manual turn. Reconcile here so a
  // branch-affine result is already in model context for that first turn.
  pi.on("session_tree", () => reconcile({ noTriggerOnly: true }));

  reconcile();
}
