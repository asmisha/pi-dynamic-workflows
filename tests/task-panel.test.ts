import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

type TaskPanelModule = {
  deliverText: (run: unknown) => string;
  installResultDelivery: (pi: ExtensionAPI, manager: unknown, sessionManager: unknown) => void;
  installTaskPanel: (pi: ExtensionAPI | null, manager: unknown, ui: unknown) => void;
};

type Delivery = {
  runId: string;
  deliveryId: string;
  sessionId: string;
  content: string;
  state: "pending" | "delivered";
};

type MockSessionManager = {
  getSessionId: () => string;
  getEntries: () => unknown[];
  entries: unknown[];
};

type MockPi = ExtensionAPI & {
  _calls: Array<{
    content: string;
    customType?: string;
    display?: boolean;
    details?: { runId: string; deliveryId: string };
  }>;
  _emit: (event: string) => void;
};

// Loaded once before all tests
let mod: TaskPanelModule;

before(async () => {
  mod = (await import("../src/task-panel.js")) as TaskPanelModule;
});

function createMockSessionManager(sessionId = "session-1", entries: unknown[] = []): MockSessionManager {
  return {
    getSessionId: () => sessionId,
    getEntries: () => entries,
    entries,
  };
}

function createMockManager(run?: unknown) {
  const pending: Delivery[] = [];
  const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
    getRun: (...args: unknown[]) => unknown;
    isRunInCurrentSession: (...args: unknown[]) => boolean;
    listPendingTerminalDeliveries: (sessionId: string) => Delivery[];
    markTerminalDeliveryDelivered: (runId: string, deliveryId: string) => boolean;
    _queue: (content: string, options?: Partial<Delivery>) => Delivery;
  };
  manager.getRun = () => run;
  manager.isRunInCurrentSession = () => true;
  manager.listPendingTerminalDeliveries = (sessionId) =>
    pending.filter((delivery) => delivery.sessionId === sessionId && delivery.state === "pending");
  manager.markTerminalDeliveryDelivered = (runId, deliveryId) => {
    const delivery = pending.find((candidate) => candidate.runId === runId && candidate.deliveryId === deliveryId);
    if (!delivery) return false;
    delivery.state = "delivered";
    return true;
  };
  manager._queue = (content, options = {}) => {
    const delivery: Delivery = {
      runId: options.runId ?? "test-run-1",
      deliveryId: options.deliveryId ?? "test-run-1:completed",
      sessionId: options.sessionId ?? "session-1",
      content,
      state: options.state ?? "pending",
    };
    pending.push(delivery);
    return delivery;
  };
  return manager;
}

function createMockPi(): MockPi {
  const calls: MockPi["_calls"] = [];
  const handlers = new Map<string, Array<() => void>>();
  const obj = {
    sendMessage(msg: unknown, _opts?: unknown) {
      calls.push({
        content: (msg as { content?: string }).content ?? "",
        customType: (msg as { customType?: string }).customType,
        display: (msg as { display?: boolean }).display,
        details: (msg as { details?: { runId: string; deliveryId: string } }).details,
      });
    },
    registerTool: () => {},
    on: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools: () => [],
    setActiveTools: () => {},
    reload: () => Promise.resolve(),
    _calls: calls,
    _emit: (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
  return obj as unknown as MockPi;
}

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "test-run-1",
    snapshot: {
      name: "test-workflow",
      agentCount: 3,
      agents: [
        { id: "a1", status: "done", step: "agent 1", phase: "phase-1" },
        { id: "a2", status: "done", step: "agent 2", phase: "phase-1" },
        { id: "a3", status: "done", step: "agent 3", phase: "phase-2" },
      ],
      phases: [{ title: "phase-1" }, { title: "phase-2" }],
      currentPhase: "phase-2",
      startedAt: new Date(),
      completedAt: new Date(),
    },
    outputFile: "/tmp/workflows/test-run-1.stdout",
    result: {
      agentCount: 3,
      durationMs: 1500,
      tokenUsage: { total: 50000, input: 25000, output: 25000 },
      result: { verdict: "## All tests passed\n\nEverything looks good!" },
    },
    ...overrides,
  };
}

function persistedRun(delivery: Delivery) {
  const timestamp = new Date().toISOString();
  return {
    runId: delivery.runId,
    workflowName: "test-workflow",
    script: "export const meta = { name: 'test-workflow', description: 'test' }",
    sessionId: delivery.sessionId,
    status: "completed" as const,
    phases: [],
    agents: [],
    logs: [],
    startedAt: timestamp,
    updatedAt: timestamp,
    terminalDeliveries: [delivery],
  };
}

// ─── Durable terminal-result delivery ────────────────────────────────────────

describe("installResultDelivery", () => {
  it("delivers persisted terminal content with stable run and delivery details", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const session = createMockSessionManager();
    const content =
      `✓ Background workflow "test-workflow" finished (3 agents · ${Number(50000).toLocaleString()} tokens · 1.5s). ` +
      "full output: /tmp/workflows/test-run-1.stdout";

    mod.installResultDelivery(pi, manager, session);
    manager._queue(content);
    manager.emit("complete", { runId: "test-run-1", deliveryId: "test-run-1:completed" });

    assert.deepEqual(pi._calls, [
      {
        customType: "workflow-result",
        display: true,
        content,
        details: { runId: "test-run-1", deliveryId: "test-run-1:completed" },
      },
    ]);
  });

  it("installs terminal listeners only once", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const session = createMockSessionManager();

    mod.installResultDelivery(pi, manager, session);
    mod.installResultDelivery(pi, manager, session);
    manager._queue("done");
    manager.emit("complete", { runId: "test-run-1" });

    assert.equal(pi._calls.length, 1);
  });

  it("leaves a delivery pending when sendMessage throws", () => {
    const pi = createMockPi();
    pi.sendMessage = () => {
      throw new Error("This extension ctx is stale");
    };
    const manager = createMockManager(makeRun());
    const session = createMockSessionManager();
    manager._queue("done");

    assert.doesNotThrow(() => mod.installResultDelivery(pi, manager, session));
    assert.equal(manager.listPendingTerminalDeliveries("session-1").length, 1);
  });

  it("does not deliver terminal records owned by another session", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    manager._queue("private failure", { sessionId: "other-session", deliveryId: "test-run-1:failed" });

    mod.installResultDelivery(pi, manager, createMockSessionManager("session-1"));
    manager.emit("error", { runId: "test-run-1" });

    assert.equal(pi._calls.length, 0);
  });

  it("requeues an uncertain in-memory delivery when the session binding reloads", () => {
    const first = createMockPi();
    const second = createMockPi();
    const manager = createMockManager(makeRun());
    const session = createMockSessionManager();

    mod.installResultDelivery(first, manager, session);
    manager._queue("done");
    manager.emit("complete", { runId: "test-run-1" });
    mod.installResultDelivery(second, manager, session);

    assert.equal(first._calls.length, 1);
    assert.equal(second._calls.length, 1);
    assert.equal(second._calls[0].details?.deliveryId, "test-run-1:completed");
  });

  it("redelivers a pending terminal notification after a simulated manager restart", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { WorkflowManager } = await import("../src/workflow-manager.js");
    const { withFakeHomeAsync } = await import("./helpers/fake-home.js");
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-delivery-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const delivery: Delivery = {
          runId: "restart-run",
          deliveryId: "restart-run:completed",
          sessionId: "session-1",
          content: "durable completion",
          state: "pending",
        };
        const original = new WorkflowManager({ cwd, sessionId: "session-1" });
        original.getPersistence().save(persistedRun(delivery));

        const restarted = new WorkflowManager({ cwd, sessionId: "session-1" });
        const pi = createMockPi();
        mod.installResultDelivery(pi, restarted, createMockSessionManager());

        assert.deepEqual(pi._calls, [
          {
            customType: "workflow-result",
            display: true,
            content: "durable completion",
            details: { runId: "restart-run", deliveryId: "restart-run:completed" },
          },
        ]);
        assert.equal(
          restarted.getPersistence().load("restart-run")?.terminalDeliveries?.[0].state,
          "pending",
          "enqueueing is not proof that Pi persisted the message",
        );
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not duplicate a custom message already persisted before restart", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { WorkflowManager } = await import("../src/workflow-manager.js");
    const { withFakeHomeAsync } = await import("./helpers/fake-home.js");
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-dedup-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const delivery: Delivery = {
          runId: "dedup-run",
          deliveryId: "dedup-run:completed",
          sessionId: "session-1",
          content: "already delivered",
          state: "pending",
        };
        const original = new WorkflowManager({ cwd, sessionId: "session-1" });
        original.getPersistence().save(persistedRun(delivery));
        const restarted = new WorkflowManager({ cwd, sessionId: "session-1" });
        const pi = createMockPi();
        const session = createMockSessionManager("session-1", [
          {
            type: "custom_message",
            customType: "workflow-result",
            content: "already delivered",
            display: true,
            details: { runId: "dedup-run", deliveryId: "dedup-run:completed" },
          },
        ]);

        mod.installResultDelivery(pi, restarted, session);

        assert.equal(pi._calls.length, 0);
        assert.equal(restarted.getPersistence().load("dedup-run")?.terminalDeliveries?.[0].state, "delivered");
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("marks an enqueued delivery delivered only after agent-settled sees its session entry", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const session = createMockSessionManager();
    const delivery = manager._queue("done");

    mod.installResultDelivery(pi, manager, session);
    assert.equal(delivery.state, "pending");
    session.entries.push({
      type: "custom_message",
      customType: "workflow-result",
      details: { runId: delivery.runId, deliveryId: delivery.deliveryId },
    });
    pi._emit("agent_settled");

    assert.equal(delivery.state, "delivered");
    assert.equal(pi._calls.length, 1);
  });

  // Paused notifications remain transient: they are resumable, not terminal.
  it("delivers a resumable checkpoint message on a usage-limit paused event", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    mod.installResultDelivery(pi, manager, createMockSessionManager());

    manager.emit("paused", {
      runId: "test-run-1",
      reason: "usage_limit",
      error: { message: "Codex usage limit reached (plus plan)." },
      resetHint: "Resets in ~3h",
    });

    assert.equal(pi._calls.length, 1);
    assert.match(pi._calls[0].content, /paused/);
    assert.match(pi._calls[0].content, /\/workflows resume test-run-1/);
    assert.match(pi._calls[0].content, /Resets in ~3h/);
    assert.doesNotMatch(pi._calls[0].content, /failed/);
  });

  it("delivers a retryable agent-failure pause without treating it as terminal", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    mod.installResultDelivery(pi, manager, createMockSessionManager());

    manager.emit("paused", {
      runId: "test-run-1",
      reason: "agent_failure",
      error: { message: "reviewer returned malformed output" },
    });

    assert.equal(pi._calls.length, 1);
    assert.match(pi._calls[0].content, /reviewer returned malformed output/);
    assert.match(pi._calls[0].content, /\/workflows retry test-run-1/);
    assert.equal(pi._calls[0].details, undefined);
  });

  it("delivers a human checkpoint to the parent conversation", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    mod.installResultDelivery(pi, manager, createMockSessionManager());

    manager.emit("paused", {
      runId: "test-run-1",
      reason: "human_input",
      checkpoint: { prompt: "Accept the bounded rollout risk?" },
    });

    assert.equal(pi._calls.length, 1);
    assert.match(pi._calls[0].content, /Accept the bounded rollout risk\?/);
    assert.match(pi._calls[0].content, /resumeRunId/);
    assert.doesNotMatch(pi._calls[0].content, /Ask the user|Do not start a new run/);
  });

  it("ignores a manual pause", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    mod.installResultDelivery(pi, manager, createMockSessionManager());

    manager.emit("paused", { runId: "test-run-1" });

    assert.equal(pi._calls.length, 0);
  });
});

// ─── installTaskPanel ─────────────────────────────────────────────────────────

describe("installTaskPanel", () => {
  it("registers a widget named workflow-tasks with belowEditor placement", () => {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (...args: unknown[]) => unknown;
      listRuns: () => unknown[];
    };
    manager.getRun = () => null;
    manager.listRuns = () => [];

    let registeredName = "";
    let registeredPlacement = "";
    const ui = {
      setWidget: (name: string, _factory: unknown, opts: { placement?: string }) => {
        registeredName = name;
        registeredPlacement = opts.placement ?? "";
      },
    };

    mod.installTaskPanel(null, manager, ui);
    assert.equal(registeredName, "workflow-tasks");
    assert.equal(registeredPlacement, "belowEditor");
  });

  it("passes the render width through to the task panel", () => {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (...args: unknown[]) => unknown;
      listRuns: () => unknown[];
    };
    manager.getRun = () => undefined;
    manager.listRuns = () => [
      {
        runId: "a",
        workflowName: "handle_gh_issues_11_12_with_a_long_suffix",
        status: "running",
        agents: [{ status: "done" }, { status: "running" }],
        logs: [],
      },
    ];

    let factory:
      | ((
          tui: { requestRender(): void },
          theme: { fg(color: string, text: string): string; bold(text: string): string },
        ) => { render(width: number): string[] })
      | undefined;
    const ui = {
      setWidget: (_name: string, registeredFactory: typeof factory) => {
        factory = registeredFactory;
      },
    };
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

    mod.installTaskPanel(null, manager, ui);
    const component = factory?.({ requestRender: () => {} }, theme);
    const lines = component?.render(24) ?? [];

    assert.ok(lines.length > 0, "panel should render active runs");
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 24, `line exceeds width: ${visibleWidth(line)} > 24`);
    }
  });
});

describe("renderPanel", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  it("hints that finished runs are kept in /workflows history", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const manager = {
      listRuns: () => [
        { runId: "a", workflowName: "live", status: "running", agents: [{ status: "done" }], logs: [] },
        { runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] },
        { runId: "c", workflowName: "older", status: "aborted", agents: [], logs: [] },
      ],
      getRun: () => undefined,
    };
    const lines = renderPanel(manager as never, theme as never);
    assert.ok(
      lines.some((l) => /2 finished kept in history/.test(l)),
      "hint should report the finished-run count",
    );
    assert.ok(
      lines.some((l) => l.includes("/workflows")),
      "hint should point at /workflows",
    );
  });

  it("renders nothing when no run is active", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const manager = {
      listRuns: () => [{ runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] }],
      getRun: () => undefined,
    };
    assert.deepEqual(renderPanel(manager as never, theme as never), []);
  });

  it("truncates every rendered line to the requested visible width", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const ansiTheme = {
      fg: (_c: string, t: string) => `\x1b[2m${t}\x1b[22m`,
      bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
    };
    const manager = {
      listRuns: () => [
        {
          runId: "a",
          workflowName: "handle_gh_issues_11_12_中文_🙂_very_long_workflow_name",
          status: "running",
          agents: [{ status: "done" }, { status: "running" }],
          logs: [],
        },
        { runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] },
      ],
      getRun: () => ({
        snapshot: {
          currentPhase: "Issue implementation phase with a very long suffix",
          agents: [{ status: "done" }, { status: "running" }],
        },
      }),
    };

    const lines = renderPanel(manager as never, ansiTheme as never, 42);

    assert.ok(lines.length > 0, "panel should render active runs");
    assert.ok(
      lines.some((line) => line.includes("...")),
      "at least one line should be truncated",
    );
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds width: ${visibleWidth(line)} > 42`);
    }
  });
});

// ─── token/s rolling-window math ────────────────────────────────────────────────

describe("token rate", () => {
  it("returns 0 with fewer than two samples and after clearing", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("rate-a");
    assert.equal(tokensPerSecond("rate-a"), 0);
    sampleTokens("rate-a", 100, 1000);
    assert.equal(tokensPerSecond("rate-a"), 0);
    sampleTokens("rate-a", 1100, 2000);
    assert.equal(tokensPerSecond("rate-a"), 1000, "1000 tokens over 1s = 1000 tok/s");
    clearTokenSamples("rate-a");
    assert.equal(tokensPerSecond("rate-a"), 0, "cleared samples reset the rate");
  });

  it("computes the rate over the oldest-to-newest window", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("rate-b");
    sampleTokens("rate-b", 0, 1000);
    sampleTokens("rate-b", 1000, 2000);
    sampleTokens("rate-b", 1500, 3000);
    // (1500 - 0) tokens over (3000 - 1000) ms = 750 tok/s
    assert.equal(tokensPerSecond("rate-b"), 750);
  });

  it("decays to 0 when the total plateaus (stall detection)", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("rate-c");
    sampleTokens("rate-c", 0, 0);
    sampleTokens("rate-c", 1000, 1000);
    assert.equal(tokensPerSecond("rate-c"), 1000);
    // A stall: same total sampled > 10s later ages out the growth window → 0 tok/s.
    sampleTokens("rate-c", 1000, 12000);
    assert.equal(tokensPerSecond("rate-c"), 0, "stalled agent shows 0 tok/s");
  });
});

// ─── detailed progress panel ─────────────────────────────────────────────────────

describe("renderPanelDetailed", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  // `blueTokens` drives the first agent's live token count; the run aggregate and
  // token/s are summed from per-agent tokens (the run-level tokenUsage aggregate is
  // not live — see renderPanelDetailed), so growing blueTokens grows the rate.
  function detailedManager(blueTokens: number, status = "running") {
    const snapshot = {
      name: "auth_audit",
      phases: ["Scan", "Review"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 1,
          label: "discover_routes",
          status: "done",
          phase: "Scan",
          tokens: blueTokens,
          model: "anthropic/claude-haiku-4-5",
        },
        { id: 2, label: "audit_auth", status: "running", phase: "Scan", tokens: 1800 },
        { id: 3, label: "scan_middleware", status: "queued", phase: "Scan" },
        { id: 4, label: "cross_check", status: "queued", phase: "Review" },
      ],
      // Only `cost` is read from the run-level aggregate (it lands when the run ends).
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0.02 },
    };
    return {
      listRuns: () => [
        { runId: "r1", workflowName: "auth_audit", status, agents: snapshot.agents, tokenUsage: snapshot.tokenUsage },
      ],
      getRun: (id: string) => (id === "r1" ? { snapshot, status } : undefined),
    };
  }

  it("renders aggregate tokens, cost, phases, and per-agent rows", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    // discover_routes 2100 + audit_auth 1800 = 3900 → "3.9K tok" aggregate.
    const lines = renderPanelDetailed(detailedManager(2100) as never, theme as never, undefined, 8, 1000);
    const text = lines.join("\n");

    assert.ok(/auth_audit/.test(text), "shows the run name");
    assert.ok(/1\/4 steps/.test(text), "shows done/total steps");
    assert.ok(/3\.9K tok/.test(text), "shows aggregate tokens summed from per-agent tokens");
    assert.ok(/\$0\.02/.test(text), "shows cost");
    // Phase headers
    assert.ok(
      lines.some((l) => l.includes("▶ Scan") && /1\/3 steps/.test(l) && /3\.9K tok/.test(l)),
      "Scan phase header with subtotal",
    );
    assert.ok(
      lines.some((l) => l.includes("Review") && /0\/1 steps/.test(l)),
      "Review phase header",
    );
    // Agent rows: status icons + label + tokens + model
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ discover_routes") && /2\.1K tok/.test(l) && /claude-haiku-4-5/.test(l)),
      "done agent row with model",
    );
    assert.ok(
      lines.some((l) => l.includes("[2] ● audit_auth") && /1\.8K tok/.test(l)),
      "running agent row",
    );
    assert.ok(
      lines.some((l) => l.includes("[3] ○ scan_middleware")),
      "queued agent row",
    );
  });

  it("shows a live token/s after two growing samples", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    // aggregate goes 3900 → 5900 over 1s = 2000 tok/s
    renderPanelDetailed(detailedManager(2100) as never, theme as never, undefined, 8, 1000);
    const lines = renderPanelDetailed(detailedManager(4100) as never, theme as never, undefined, 8, 2000);
    assert.ok(
      lines.some((l) => /2000 tok\/s/.test(l)),
      `expected a tok/s readout, got:\n${lines.join("\n")}`,
    );
  });

  it("caps agents per phase and reports the overflow", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    const lines = renderPanelDetailed(detailedManager(12400) as never, theme as never, undefined, 2, 1000);
    const text = lines.join("\n");
    // Scan has 3 agents, cap 2 → most recent 2 shown + "… 1 earlier steps"
    assert.ok(/… 1 earlier steps/.test(text), "overflow line present");
    assert.ok(!/discover_routes/.test(text), "oldest agent hidden when capped");
    assert.ok(/audit_auth/.test(text) && /scan_middleware/.test(text), "most recent agents shown");
  });

  it("suppresses tok/s for paused runs", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    renderPanelDetailed(detailedManager(1000, "paused") as never, theme as never, undefined, 8, 1000);
    const lines = renderPanelDetailed(detailedManager(3000, "paused") as never, theme as never, undefined, 8, 2000);
    assert.ok(!lines.some((l) => /tok\/s/.test(l)), "paused run shows no token rate");
  });
});

// ─── mode selection in installTaskPanel ───────────────────────────────────────────

describe("installTaskPanel mode selection", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  function activeManager() {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      getRun: (id: string) => unknown;
      listRuns: () => unknown[];
    };
    const snapshot = {
      name: "wf",
      phases: ["P1"],
      currentPhase: "P1",
      logs: [],
      agents: [{ id: 1, label: "a", status: "running", phase: "P1", tokens: 500 }],
      tokenUsage: { total: 500, input: 250, output: 250 },
    };
    manager.listRuns = () => [
      { runId: "r1", workflowName: "wf", status: "running", agents: snapshot.agents, tokenUsage: snapshot.tokenUsage },
    ];
    manager.getRun = (id: string) => (id === "r1" ? { snapshot, status: "running" } : undefined);
    return manager;
  }

  function captureRender(loadSettings?: () => Record<string, unknown>) {
    const manager = activeManager();
    let factory:
      | ((tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[]; dispose?(): void })
      | undefined;
    const ui = {
      setWidget: (_n: string, f: typeof factory) => {
        factory = f;
      },
    };
    mod.installTaskPanel(null, manager as never, ui as never, { loadSettings } as never);
    const comp = factory?.({ requestRender: () => {} }, theme);
    const lines = comp?.render(120) ?? [];
    comp?.dispose?.();
    return lines;
  }

  it("uses compact rendering when no loadSettings is provided", () => {
    const lines = captureRender();
    assert.ok(
      lines.some((l) => /1 steps/.test(l)),
      "compact one-liner",
    );
    assert.ok(!lines.some((l) => /▶ P1/.test(l)), "no per-phase detail in compact");
  });

  it("uses compact rendering when the mode is compact", () => {
    const lines = captureRender(() => ({ progressPanelMode: "compact" }));
    assert.ok(!lines.some((l) => /▶ P1/.test(l)), "no per-phase detail in compact");
  });

  it("uses detailed rendering when the mode is detailed", () => {
    const lines = captureRender(() => ({ progressPanelMode: "detailed" }));
    assert.ok(
      lines.some((l) => /▶ P1/.test(l)),
      "per-phase detail in detailed mode",
    );
    assert.ok(
      lines.some((l) => /\[1\] ● a/.test(l)),
      "per-agent row in detailed mode",
    );
  });
});
