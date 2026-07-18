/**
 * Interactive `/workflows` navigator, modeled on Claude Code's view:
 *
 *   runs ──enter──▶ phases ──enter──▶ agents ──enter──▶ agent detail
 *        ◀──esc───        ◀──esc────         ◀──esc────
 *
 * Keys: ↑/↓ (or j/k) select · enter/→ drill in · esc/← back (esc at top closes)
 *       On runs: p pause · x stop · d remove · r restart · q quit
 *
 * The state machine and line rendering are pure and unit-tested; the pi-tui
 * Component shell (openWorkflowNavigator) wires them to live manager events.
 */

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { parseKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
import type { PersistedRunState } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  queued: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  done: "✓",
  failed: "✗",
  error: "✗",
  aborted: "⊘",
  skipped: "⊘",
};

/** Minimal theme surface so rendering is testable without the real Theme class. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const PLAIN: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

// Border characters for the overlay box
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

export type ViewKind = "runs" | "phases" | "agents" | "detail";

interface RunRow {
  runId: string;
  name: string;
  status: string;
  done: number;
  total: number;
  tokens: number;
  cost: number;
}
interface PhaseRow {
  title: string;
  done: number;
  total: number;
  tokens: number;
}
interface AgentRow {
  id: number;
  label: string;
  status: string;
  phase?: string;
  tokens?: number;
  model?: string;
}

/** Short, human-friendly model label: drop the provider prefix for display. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** Reads run/phase/agent data from the manager, preferring live snapshots. */
export class NavigatorModel {
  constructor(private readonly manager: Pick<WorkflowManager, "listRuns" | "getRun">) {}

  private snapshot(runId: string): { snapshot: WorkflowSnapshot; status: string } | undefined {
    const live = this.manager.getRun(runId);
    if (live) return { snapshot: live.snapshot, status: live.status };
    const p = this.manager.listRuns().find((r) => r.runId === runId);
    if (!p) return undefined;
    return { snapshot: persistedToSnapshot(p), status: p.status };
  }

  runs(): RunRow[] {
    return this.manager.listRuns().map((p) => {
      const live = this.manager.getRun(p.runId);
      const agents = (live?.snapshot.agents ?? p.agents) as WorkflowAgentSnapshot[];
      return {
        runId: p.runId,
        name: live?.snapshot.name ?? p.workflowName,
        status: live?.status ?? p.status,
        done: agents.filter((a) => a.status === "done").length,
        total: agents.length,
        tokens: (live?.snapshot.tokenUsage ?? p.tokenUsage)?.total ?? 0,
        cost: (live?.snapshot.tokenUsage ?? p.tokenUsage)?.cost ?? 0,
      };
    });
  }

  runName(runId: string): string {
    return this.snapshot(runId)?.snapshot.name ?? runId;
  }

  runStatus(runId: string): string {
    return this.snapshot(runId)?.status ?? "unknown";
  }

  phases(runId: string): PhaseRow[] {
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap) return [];
    const order = snap.phases.length ? [...snap.phases] : [];
    const byPhase = new Map<string, AgentRow[]>();
    for (const a of snap.agents) {
      const key = a.phase ?? "(no phase)";
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key)?.push(a);
      if (!order.includes(key)) order.push(key);
    }
    return order.map((title) => {
      const agents = byPhase.get(title) ?? [];
      return {
        title,
        done: agents.filter((a) => a.status === "done").length,
        total: agents.length,
        tokens: agents.reduce((n, a) => n + (a.tokens ?? 0), 0),
      };
    });
  }

  agents(runId: string, phase: string): AgentRow[] {
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap) return [];
    return snap.agents
      .filter((a) => (a.phase ?? "(no phase)") === phase)
      .map((a) => ({ id: a.id, label: a.label, status: a.status, phase: a.phase, tokens: a.tokens, model: a.model }));
  }

  agentDetail(runId: string, agentId: number): WorkflowAgentSnapshot | undefined {
    return this.snapshot(runId)?.snapshot.agents.find((a) => a.id === agentId);
  }
}

type StackFrame = {
  kind: ViewKind;
  cursor: number;
  runId?: string;
  phase?: string;
  agentId?: number;
};

function persistedToSnapshot(p: PersistedRunState): WorkflowSnapshot {
  return {
    name: p.workflowName,
    phases: p.phases,
    currentPhase: p.currentPhase,
    logs: p.logs,
    agents: p.agents.map((a) => ({
      id: a.id,
      label: a.label,
      phase: a.phase,
      prompt: a.prompt,
      status: a.status,
      resultPreview:
        a.result == null ? undefined : String(typeof a.result === "string" ? a.result : JSON.stringify(a.result)),
      error: a.error,
      errorCode: a.errorCode,
      recoverable: a.recoverable,
      history: a.history,
      model: a.model,
    })),
    agentCount: p.agents.length,
    runningCount: p.agents.filter((a) => a.status === "running").length,
    doneCount: p.agents.filter((a) => a.status === "done").length,
    errorCount: p.agents.filter((a) => a.status === "error").length,
    tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
    runId: p.runId,
  };
}

/** Navigation state machine: a stack of (view, cursor) frames plus detail scroll. */
export class NavigatorState {
  private stack: StackFrame[] = [{ kind: "runs", cursor: 0 }];
  scroll = 0;

  private top(): StackFrame {
    return this.stack[this.stack.length - 1];
  }
  get kind(): ViewKind {
    return this.top().kind;
  }
  get cursor(): number {
    return this.top().cursor;
  }
  set cursor(val: number) {
    this.top().cursor = val;
  }
  get runId(): string | undefined {
    return this.top().runId;
  }
  get phase(): string | undefined {
    return this.top().phase;
  }
  get agentId(): number | undefined {
    return this.top().agentId;
  }
  get depth(): number {
    return this.stack.length;
  }

  /** Clamp the cursor to [0, count). */
  clamp(count: number) {
    const t = this.top();
    t.cursor = count <= 0 ? 0 : Math.max(0, Math.min(t.cursor, count - 1));
  }

  move(delta: number, count: number) {
    if (this.kind === "detail") {
      this.scroll = Math.max(0, this.scroll + delta);
      return;
    }
    if (count <= 0) return;
    const t = this.top();
    t.cursor = (t.cursor + delta + count) % count;
  }

  /** Drill into the selected item. Returns true if the view changed. */
  drill(model: NavigatorModel): boolean {
    const t = this.top();
    if (t.kind === "runs") {
      const run = model.runs()[t.cursor];
      if (!run) return false;
      this.stack.push({ kind: "phases", cursor: 0, runId: run.runId });
      return true;
    }
    if (t.kind === "phases" && t.runId) {
      const phases = model.phases(t.runId);
      const ph = phases[t.cursor];
      if (!ph) return false;
      this.stack.push({ kind: "agents", cursor: 0, runId: t.runId, phase: ph.title });
      return true;
    }
    if (t.kind === "agents" && t.runId && t.phase) {
      const agents = model.agents(t.runId, t.phase);
      const ag = agents[t.cursor];
      if (!ag) return false;
      this.scroll = 0;
      this.stack.push({ kind: "detail", cursor: 0, runId: t.runId, phase: t.phase, agentId: ag.id });
      return true;
    }
    return false;
  }

  /** Pop one level. Returns false when already at the top (caller should close). */
  back(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.scroll = 0;
    return true;
  }

  /** The active runId, if this navigator frame represents a run. */
  activeRunId(model: NavigatorModel): string | undefined {
    if (this.runId) return this.runId;
    return this.kind === "runs" ? model.runs()[this.cursor]?.runId : undefined;
  }
}

function pad(n: number): string {
  return n.toLocaleString();
}

function fmtTokens(t: number): string {
  return t > 0 ? `${pad(t)} tok` : "";
}

/** Build the lines for the current view. Pure: depends only on state + model + theme. */
export function renderNavigator(
  state: NavigatorState,
  model: NavigatorModel,
  width: number,
  theme: ThemeLike = PLAIN,
  viewportRows = 24,
): string[] {
  const lines: string[] = [];
  const sel = (i: number, text: string) =>
    i === state.cursor ? theme.fg("accent", theme.bold(`❯ ${text}`)) : `  ${text}`;
  const dim = (t: string) => theme.fg("dim", t);

  // Render a detail body inside a FIXED-height viewport so j/k scrolls within a
  // stable box (clamping state.scroll) instead of slicing to the end — which
  // shrank the overlay and looked like it was collapsing.
  const pushScrollable = (body: string[]) => {
    const viewport = Math.max(5, viewportRows - 4); // reserve title + blank + footer + indicator
    const maxScroll = Math.max(0, body.length - viewport);
    state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
    lines.push(...body.slice(state.scroll, state.scroll + viewport));
    if (body.length > viewport) {
      const end = Math.min(state.scroll + viewport, body.length);
      lines.push(dim(`  [${state.scroll + 1}-${end} / ${body.length}]`));
    }
  };

  if (state.kind === "runs") {
    const runs = model.runs();
    state.clamp(runs.length);
    lines.push(theme.bold("Workflows"));
    if (runs.length === 0) {
      lines.push(dim("  No runs yet. Start one with a background workflow."));
    }
    // Render runs
    runs.forEach((r, i) => {
      const icon = STATUS_ICON[r.status] ?? "?";
      const meta = [`${r.done}/${r.total}`, fmtTokens(r.tokens), r.cost > 0 ? `$${r.cost.toFixed(4)}` : ""]
        .filter(Boolean)
        .join(" · ");
      lines.push(sel(i, `${icon} ${r.name}  ${dim(`${r.runId} · ${r.status} · ${meta}`)}`));
    });
  } else if (state.kind === "phases" && state.runId) {
    const phases = model.phases(state.runId);
    state.clamp(phases.length);
    lines.push(theme.bold(model.runName(state.runId)) + dim(`  (${model.runStatus(state.runId)})`));
    phases.forEach((p, i) => {
      const meta = [`${p.done}/${p.total} agents`, fmtTokens(p.tokens)].filter(Boolean).join(" · ");
      lines.push(sel(i, `${p.title}  ${dim(meta)}`));
    });
  } else if (state.kind === "agents" && state.runId && state.phase) {
    const agents = model.agents(state.runId, state.phase);
    state.clamp(agents.length);
    lines.push(theme.bold(`${model.runName(state.runId)} › ${state.phase}`));
    agents.forEach((a, i) => {
      const icon = STATUS_ICON[a.status] ?? "?";
      const mdl = shortModel(a.model);
      const meta = [mdl, a.tokens ? fmtTokens(a.tokens) : undefined].filter(Boolean).join(" · ");
      lines.push(sel(i, `${icon} ${a.label}${meta ? dim(`  ${meta}`) : ""}`));
    });
  } else if (state.kind === "detail" && state.runId && state.agentId != null) {
    const a = model.agentDetail(state.runId, state.agentId);
    lines.push(theme.bold(a ? a.label : "agent"));
    if (a) {
      const body: string[] = [];
      body.push(dim("Status: ") + (a.status ?? ""));
      if (a.model) body.push(dim("Model: ") + (shortModel(a.model) ?? ""));
      if (a.error) body.push(dim("Error: ") + a.error);
      if (a.errorCode) body.push(`${dim("Error code: ")}${a.errorCode}${a.recoverable ? " (recoverable)" : ""}`);
      body.push("", dim("Prompt:"));
      body.push(...wrap(a.prompt ?? "", width));
      body.push("", dim("Result:"));
      body.push(...wrap(a.resultPreview ?? "(none)", width));
      if (a.history?.length) {
        body.push("", dim("History:"));
        for (const entry of a.history) {
          body.push(...wrap(`${historyLabel(entry)}: ${entry.text}`, width));
        }
      }
      pushScrollable(body);
    }
  }

  lines.push("");
  lines.push(footerHint(state, theme));
  return lines;
}

function historyLabel(entry: NonNullable<WorkflowAgentSnapshot["history"]>[number]): string {
  if (entry.kind === "toolCall") return entry.toolName ? `assistant tool ${entry.toolName}` : "assistant tool";
  if (entry.role === "tool") return entry.toolName ? `tool ${entry.toolName}` : "tool";
  if (entry.kind === "error") return `${entry.role} error`;
  return entry.role;
}

function footerHint(state: NavigatorState, theme: ThemeLike): string {
  const parts: string[] = [];
  switch (state.kind) {
    case "detail":
      parts.push("j/k scroll", "esc back");
      break;
    case "runs":
      parts.push("↑/↓ select", "enter open", "esc back", "p pause", "x stop", "d remove", "r restart", "q quit");
      break;
    default:
      parts.push("↑/↓ select", "enter open", "esc back", "q quit");
  }
  return theme.fg("dim", parts.join(" · "));
}

function wrap(text: string, width: number): string[] {
  return wrapTextWithAnsi(text ?? "", Math.max(20, width));
}

/** What a key press should do. Pure mapping from a parsed key id to an action. */
export type NavAction =
  | { type: "move"; delta: number }
  | { type: "drill" }
  | { type: "back" }
  | { type: "close" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "deleteRun" }
  | { type: "none" };

export function keyToAction(keyId: string | undefined, kind: ViewKind): NavAction {
  switch (keyId) {
    case "up":
      return { type: "move", delta: -1 };
    case "down":
      return { type: "move", delta: 1 };
    case "k":
      return { type: "move", delta: -1 };
    case "j":
      return { type: "move", delta: 1 };
    case "enter":
    case "return":
    case "right":
      if (kind === "detail") return { type: "none" };
      return { type: "drill" };
    case "escape":
    case "esc":
    case "left":
      return { type: "back" };
    case "q":
      return { type: "close" };
    case "p":
      return { type: "pause" };
    case "x":
      return { type: "stop" };
    case "d":
    case "delete":
      return kind === "runs" ? { type: "deleteRun" } : { type: "none" };
    case "r":
      return { type: "restart" };
    default:
      return { type: "none" };
  }
}

function currentCount(state: NavigatorState, model: NavigatorModel): number {
  if (state.kind === "runs") return model.runs().length;
  if (state.kind === "phases" && state.runId) return model.phases(state.runId).length;
  if (state.kind === "agents" && state.runId && state.phase) return model.agents(state.runId, state.phase).length;
  return 0;
}

import type { OverlayAnchor } from "@earendil-works/pi-tui";

export interface NavigatorOptions {
  /** Overlay anchor position: "center" (default) or "right-center" for sidebar. */
  anchor?: OverlayAnchor;
}

/**
 * Open the interactive `/workflows` navigator as a focused overlay. Resolves when
 * the user closes it (esc at the top level, or `q`).
 */
export function openWorkflowNavigator(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: NavigatorOptions = {},
): Promise<void> {
  const model = new NavigatorModel(manager);
  const state = new NavigatorState();

  return ui.custom<void>(
    (tui: TUI, theme: Theme, _keybindings, done: (r: undefined) => void) => {
      const rerender = () => tui.requestRender();
      const events = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];
      const onEvent = () => rerender();
      for (const ev of events) manager.on(ev, onEvent);
      const cleanup = () => {
        for (const ev of events) manager.off(ev, onEvent);
      };

      const act = (data: string) => {
        const action = keyToAction(parseKey(data), state.kind);
        switch (action.type) {
          case "move":
            state.move(action.delta, currentCount(state, model));
            break;
          case "drill":
            state.drill(model);
            break;
          case "back":
            if (!state.back()) {
              cleanup();
              done(undefined);
            }
            break;
          case "close":
            cleanup();
            done(undefined);
            return;
          case "pause": {
            const id = state.activeRunId(model);
            if (id) ui.notify(manager.pause(id) ? `Paused ${id}` : `Cannot pause ${id}`, "info");
            break;
          }
          case "stop": {
            const id = state.activeRunId(model);
            if (id) ui.notify(manager.stop(id) ? `Stopped ${id}` : `Cannot stop ${id}`, "info");
            break;
          }
          case "deleteRun": {
            const id = state.activeRunId(model);
            if (id) ui.notify(manager.deleteRun(id) ? `Removed ${id}` : `No run ${id}`, "info");
            break;
          }
          case "restart": {
            const id = state.activeRunId(model);
            const run = id ? manager.listRuns().find((r) => r.runId === id) : undefined;
            if (!run?.script) {
              ui.notify(id ? `Cannot restart ${id} (no persisted script)` : "No run selected to restart", "warning");
              break;
            }
            const { runId: newId } = manager.startInBackground(run.script, run.args, {
              cwd: run.cwd,
              workflowModulePath: run.workflowModulePath,
            });
            ui.notify(`Restarted ${run.workflowName || "workflow"} as ${newId}`, "info");
            break;
          }
          default:
            return;
        }
        rerender();
      };

      // Wrap the rendered content inside a visual box border for better
      // screen-boundary contrast. Follows the same pattern as pi-ask-user:
      //   top border ──╭───╮
      //   side borders │ … │
      //   bottom border╰───╯
      let _focused = false;
      const component: Component & Focusable & { dispose?(): void } = {
        get focused(): boolean {
          return _focused;
        },
        set focused(v: boolean) {
          _focused = v;
        },
        render: (width: number) => {
          // Brighter border when focused, muted when not
          const borderColor = (s: string) => (_focused ? theme.fg("accent", s) : theme.fg("borderMuted", s));
          const titleColor = (s: string) => (_focused ? theme.fg("dim", theme.bold(s)) : theme.fg("muted", s));
          const bgColor = (s: string) => theme.bg("customMessageBg", s);
          const innerWidth = Math.max(10, width - BOX_BORDER_OVERHEAD);
          const raw = renderNavigator(state, model, innerWidth, theme, tui.terminal?.rows ?? 24);
          const title = titleColor(" workflows ");
          const topBorder =
            borderColor("╭─") + title + borderColor("─".repeat(Math.max(0, innerWidth - 10))) + borderColor("╮");
          const botBorder = borderColor(`╰${"─".repeat(Math.max(0, innerWidth + 2))}╯`);
          const wrapAndBg = (line: string) => {
            const padded = truncateToWidth(line, innerWidth, "", true);
            const fullLine = borderColor(BOX_BORDER_LEFT) + padded + borderColor(BOX_BORDER_RIGHT);
            // Fill trailing whitespace for consistent background across the width
            const trailingPad = width - fullLine.length;
            return bgColor(fullLine + (trailingPad > 0 ? " ".repeat(trailingPad) : ""));
          };
          return [bgColor(topBorder), ...raw.map(wrapAndBg), bgColor(botBorder)];
        },
        handleInput: (data: string) => act(data),
        invalidate: () => {},
        dispose: () => cleanup(),
      };
      return component;
    },
    // A roomy overlay with visual margin so borders stand out from the terminal edge.
    // Supports sidebar mode via opts.anchor="right-center".
    {
      overlay: true,
      overlayOptions: {
        width: opts.anchor === "right-center" ? "60%" : "94%",
        maxHeight: "92%",
        anchor: opts.anchor ?? "center",
        margin: 1,
      },
    },
  );
}
