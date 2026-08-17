/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  isAgentStep,
  resolveWorkflowFailureLocation,
  shorten,
  statusIcon,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import { formatWorkflowFailure } from "./errors.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import { workflowOutcome } from "./workflow-outcome.js";
import type { WorkflowSettings } from "./workflow-settings.js";
import { shortModel } from "./workflow-ui.js";

// `tokenUsage` is included so the detailed panel's live token/s counter refreshes
// as tokens accrue (not only on agent start/end). It is harmless in compact mode —
// it redraws identical content.
const RUN_EVENTS = [
  "agentStart",
  "agentEnd",
  "bashStart",
  "bashEnd",
  "phase",
  "log",
  "tokenUsage",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
];
/** Events after which a run is gone and its token-rate samples can be dropped. */
const RUN_END_EVENTS = ["complete", "error", "stopped"] as const;

export interface TaskPanelOptions {
  /**
   * Live settings loader. When provided, the panel reads it fresh (with a short
   * TTL cache) on each render so `/workflows-progress` takes effect without a
   * restart. Omitted in tests / minimal hosts → always compact.
   */
  loadSettings?: () => WorkflowSettings;
}

function fitLine(line: string, width?: number): string {
  if (typeof width !== "number" || !Number.isFinite(width)) return line;
  const maxWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth);
}

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

type DeliverySessionManager = ExtensionContext["sessionManager"];
type WorkflowResultDetails = { runId: string; deliveryId: string };

function deliveredTerminalIds(sessionManager: DeliverySessionManager): Set<string> {
  const ids = new Set<string>();
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "custom_message" || entry.customType !== "workflow-result") continue;
    const details = entry.details as Partial<WorkflowResultDetails> | undefined;
    if (typeof details?.deliveryId === "string") ids.add(details.deliveryId);
  }
  return ids;
}

/**
 * Deliver terminal notifications through the persisted run outbox. An outbox
 * record remains pending until its matching custom message is visible in the
 * append-only session, so a queued message lost with the process is replayed.
 */
export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  sessionManager: DeliverySessionManager,
): void {
  // Mutable holder on manager so shared across re-calls (e.g. session_start after /reload).
  const m = manager as unknown as {
    __deliveryInstalled?: boolean;
    __holder?: {
      pi: ExtensionAPI;
      sessionManager: DeliverySessionManager;
      sessionId: string;
      queuedDeliveryIds: Set<string>;
    };
  };
  const sessionId = sessionManager.getSessionId();

  const reconcile = () => {
    const holder = m.__holder;
    if (!holder) return;

    let deliveredIds: Set<string>;
    try {
      deliveredIds = deliveredTerminalIds(holder.sessionManager);
    } catch {
      return;
    }

    const pending = manager.listPendingTerminalDeliveries(holder.sessionId);
    const pendingIds = new Set(pending.map((delivery) => delivery.deliveryId));
    for (const deliveryId of holder.queuedDeliveryIds) {
      if (!pendingIds.has(deliveryId)) holder.queuedDeliveryIds.delete(deliveryId);
    }

    for (const delivery of pending) {
      if (deliveredIds.has(delivery.deliveryId)) {
        manager.markTerminalDeliveryDelivered(delivery.runId, delivery.deliveryId);
        holder.queuedDeliveryIds.delete(delivery.deliveryId);
        continue;
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
          { triggerTurn: true, deliverAs: "followUp" },
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
    }
    reconcile();
    return;
  }
  m.__deliveryInstalled = true;
  m.__holder = { pi, sessionManager, sessionId, queuedDeliveryIds: new Set() };

  const deliverTransient = (runId: string, content: string) => {
    if (!manager.isRunInCurrentSession(runId)) return;
    try {
      m.__holder?.pi.sendMessage(
        { customType: "workflow-result", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // Paused notifications are advisory; terminal notifications use the durable outbox above.
    }
  };

  const checkpointText = (runId: string, prompt: string) =>
    `⏸ Background workflow ${runId} paused for parent-conversation input.\n\n` +
    `${prompt}\n\n` +
    `The run stays paused until a reply continues the same run with workflow({resumeRunId: "${runId}", reply}).`;

  manager.on("complete", reconcile);
  manager.on("error", reconcile);
  manager.on("stopped", reconcile);
  pi.on("agent_settled", () => {
    m.__holder?.queuedDeliveryIds.clear();
    reconcile();
  });

  // Durable checkpoints and provider limits both pause without failing. Deliver
  // the reason to the parent conversation so it can ask the user or explain resume.
  manager.on(
    "paused",
    ({
      runId,
      reason,
      error,
      resetHint,
      checkpoint,
    }: {
      runId: string;
      reason?: string;
      error?: { message?: string };
      resetHint?: string;
      checkpoint?: { prompt: string };
    }) => {
      if (!manager.getRun(runId) || !manager.isRunInCurrentSession(runId)) return;
      if (reason === "human_input" && checkpoint) {
        deliverTransient(runId, checkpointText(runId, checkpoint.prompt));
        return;
      }
      if (reason === "agent_failure") {
        const cause = error?.message ?? "retryable agent failure";
        deliverTransient(
          runId,
          `⏸ Background workflow ${runId} paused after ${cause}. ` +
            `Completed sibling work is saved — run /workflows retry ${runId} to rerun only the failed agent call(s).`,
        );
        return;
      }
      if (reason !== "usage_limit") return;
      const when = resetHint ? ` (${resetHint})` : "";
      const cause = error?.message ?? "provider usage limit reached";
      deliverTransient(
        runId,
        `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
          `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`,
      );
    },
  );

  reconcile();
}

export function renderPanel(manager: WorkflowManager, theme: Theme, width?: number): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const rows = active.map((r) => {
    const live = manager.getRun(r.runId);
    const steps = live?.snapshot.agents ?? r.agents;
    const done = steps.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    // Running bash steps are the only visible work in script-heavy workflows.
    const bashRunning = steps.filter((a) => !isAgentStep(a) && a.status === "running").length;
    const bash = bashRunning ? ` · ${bashRunning} bash running` : "";
    const phase = live?.snapshot.currentPhase ? ` · ${live.snapshot.currentPhase}` : "";
    return `  ${icon} ${r.workflowName}  ${done}/${steps.length} steps${bash}${phase}`;
  });
  // Finished runs leave this live panel but are kept in the navigator. Tell the
  // user so a completed run doesn't look like it vanished.
  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  const hint = theme.fg(
    "dim",
    finished > 0
      ? `  /workflows — open navigator (${finished} finished kept in history)`
      : "  /workflows — open navigator",
  );
  return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint].map((line) => fitLine(line, width));
}

// ─── Detailed mode: live token rate ────────────────────────────────────────────

/** Rolling window for the token/s rate. Older samples age out so a stall decays to 0. */
const RATE_WINDOW_MS = 10_000;
/** Per-run (timestamp, cumulative total) samples, keyed by the persisted runId so
 *  the rolling rate survives pause→resume. Cleared when a run ends. */
const tokenSamples = new Map<string, Array<{ ts: number; total: number }>>();

/** Record a token-total sample for `runId` at time `now` (ms). */
export function sampleTokens(runId: string, total: number, now: number): void {
  const samples = tokenSamples.get(runId) ?? [];
  const last = samples[samples.length - 1];
  // Collapse repeat renders within the same instant (e.g. width recalcs).
  if (last && last.ts === now && last.total === total) return;
  samples.push({ ts: now, total });
  // Drop samples beyond the rolling window, always keeping ≥2 so a rate is computable.
  while (samples.length > 2 && now - samples[0].ts > RATE_WINDOW_MS) samples.shift();
  tokenSamples.set(runId, samples);
}

/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export function tokensPerSecond(runId: string): number {
  const samples = tokenSamples.get(runId);
  if (!samples || samples.length < 2) return 0;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedMs = newest.ts - oldest.ts;
  if (elapsedMs <= 0) return 0;
  const delta = newest.total - oldest.total;
  if (delta <= 0) return 0;
  return (delta / elapsedMs) * 1000;
}

/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export function clearTokenSamples(runId: string): void {
  tokenSamples.delete(runId);
}

/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export function clampMaxAgents(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 8;
  return Math.min(1000, Math.floor(value));
}

/** Per-phase + per-agent body for one run in detailed mode (mirrors renderWorkflowLines). */
function renderRunBody(
  snap: WorkflowSnapshot,
  agents: WorkflowAgentSnapshot[],
  maxAgents: number,
  theme: Theme,
): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const lines: string[] = [];
  // Group agents by phase, declared order first then discovery order (as the navigator does).
  const order = snap.phases.length ? [...snap.phases] : [];
  const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
  for (const a of agents) {
    const key = a.phase ?? "(no phase)";
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)?.push(a);
    if (!order.includes(key)) order.push(key);
  }
  for (const title of order) {
    const phaseAgents = byPhase.get(title) ?? [];
    if (!phaseAgents.length) continue;
    const done = phaseAgents.filter((a) => a.status === "done").length;
    const running = phaseAgents.filter((a) => a.status === "running").length;
    const errors = phaseAgents.filter((a) => a.status === "error").length;
    const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
    const complete = done + errors + skipped === phaseAgents.length;
    const marker = running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
    const phaseTokens = phaseAgents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    const bash = phaseAgents.filter((a) => !isAgentStep(a)).length;
    const phaseMeta = [
      `${done}/${phaseAgents.length} steps`,
      bash ? `${bash} bash` : "",
      running ? `${running} running` : "",
      errors ? `${errors} errors` : "",
      phaseTokens > 0 ? `${fmtTokensShort(phaseTokens)} tok` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(theme.fg("accent", `  ${marker} ${title}`) + dim(`  ${phaseMeta}`));

    const visible = phaseAgents.slice(-maxAgents);
    for (const a of visible) {
      const tok = a.tokens ? dim(` ${fmtTokensShort(a.tokens)} tok`) : "";
      const mdl = shortModel(a.model);
      const model = mdl ? dim(` · ${mdl}${a.thinking ? ` · ${a.thinking}` : ""}`) : "";
      lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${tok}${model}`);
    }
    if (phaseAgents.length > visible.length) {
      lines.push(dim(`    … ${phaseAgents.length - visible.length} earlier steps`));
    }
  }
  return lines;
}

/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export function renderPanelDetailed(
  manager: WorkflowManager,
  theme: Theme,
  width: number | undefined,
  maxAgents: number,
  now: number,
): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const dim = (t: string) => theme.fg("dim", t);
  const out: string[] = [theme.bold(`Workflows running (${active.length}):`)];

  for (const r of active) {
    const live = manager.getRun(r.runId);
    const snap = live?.snapshot;
    const agents = (snap?.agents ?? r.agents) as WorkflowAgentSnapshot[];
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const usage = snap?.tokenUsage ?? r.tokenUsage;
    // Sum per-agent usage so the run header stays consistent with the phase
    // subtotals. Running agents update after each provider response.
    const total = agents.reduce((n, a) => n + (a.tokens ?? 0), 0);
    // Sample the running total and derive the rolling token/s. Paused runs don't
    // accrue tokens, so their rate is suppressed (a stalled rate would mislead).
    sampleTokens(r.runId, total, now);
    const rate = r.status === "running" ? tokensPerSecond(r.runId) : 0;
    const bashRunning = agents.filter((a) => !isAgentStep(a) && a.status === "running").length;
    const meta = [
      `${done}/${agents.length} steps`,
      bashRunning ? `${bashRunning} bash running` : "",
      snap?.currentPhase || "",
      total > 0 ? `${fmtTokensShort(total)} tok` : "",
      // 2 decimals for ≥1¢, 4 for sub-cent so a real cost never shows as "$0.00".
      // (cost is only known once the run finalizes its usage.)
      usage?.cost ? `$${usage.cost.toFixed(usage.cost >= 0.01 ? 2 : 4)}` : "",
      rate > 0 ? `${Math.round(rate)} tok/s` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${icon} ${theme.bold(r.workflowName)}  ${dim(meta)}`);
    if (snap) out.push(...renderRunBody(snap, agents, maxAgents, theme));
  }

  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  out.push(
    dim(
      finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator",
    ),
  );
  return out.map((line) => fitLine(line, width));
}

/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export function installTaskPanel(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: TaskPanelOptions = {},
): void {
  // Live-read settings with a ~1s TTL: a render-path disk read every frame would
  // be wasteful, but re-reading at most once a second still makes
  // /workflows-progress take effect "immediately" (no restart).
  let cached: WorkflowSettings = {};
  let cachedAt = Number.NEGATIVE_INFINITY;
  const settings = (): WorkflowSettings => {
    if (!opts.loadSettings) return cached;
    const now = Date.now();
    if (now - cachedAt > 1000) {
      try {
        cached = opts.loadSettings() ?? {};
      } catch {
        cached = {};
      }
      cachedAt = now;
    }
    return cached;
  };
  const hasActiveRun = () => manager.listRuns().some((r) => r.status === "running" || r.status === "paused");

  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      // Coalesce render requests: run events arrive in bursts (log/agent/token
      // events from up to 16 concurrent agents); one render per ~100ms is plenty.
      let renderTimer: ReturnType<typeof setTimeout> | undefined;
      const onEvent = () => {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
          renderTimer = undefined;
          tui.requestRender();
        }, 100);
        (renderTimer as { unref?: () => void }).unref?.();
      };
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      const onRunEnd = ({ runId }: { runId: string }) => clearTokenSamples(runId);
      for (const ev of RUN_END_EVENTS) manager.on(ev, onRunEnd);
      // In detailed mode, force a redraw every 2s while a run is active so the
      // token/s rate keeps updating between sparse token events — and decays to 0
      // when an agent stalls. Gated + unref'd so it costs nothing when idle.
      const timer = setInterval(() => {
        if (settings().progressPanelMode === "detailed" && hasActiveRun()) tui.requestRender();
      }, 2000);
      (timer as { unref?: () => void }).unref?.();
      // Purely informational: it lists running runs and re-renders on events. To
      // open the navigator, the user runs /workflows (the panel takes no input).
      const comp: Component & { dispose?(): void } = {
        render: (width: number) => {
          const s = settings();
          if (s.progressPanelMode === "detailed") {
            return renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), Date.now());
          }
          return renderPanel(manager, theme, width);
        },
        invalidate: () => {},
        dispose: () => {
          clearInterval(timer);
          if (renderTimer) clearTimeout(renderTimer);
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
          for (const ev of RUN_END_EVENTS) manager.off(ev, onRunEnd);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
