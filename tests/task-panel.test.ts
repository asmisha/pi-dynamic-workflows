import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import {
  agentFailureDeliveryText,
  checkpointDeliveryText,
  usageLimitDeliveryText,
} from "../src/workflow-notifications.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

type TaskPanelModule = {
  deliverText: (run: unknown) => string;
  installResultDelivery: (
    pi: ExtensionAPI,
    manager: unknown,
    sessionManager: unknown,
    options?: { isIdle?: () => boolean },
  ) => void;
  installTaskPanel: (pi: ExtensionAPI | null, manager: unknown, ui: unknown) => void;
};

type Delivery = {
  runId: string;
  deliveryId: string;
  sessionId: string;
  content: string;
  state: "pending" | "delivered";
  deliveryMode?: "no-trigger";
  parentLeafId?: string | null;
};

type MockSessionManager = {
  getSessionId: () => string;
  getEntries: () => unknown[];
  getBranch: () => Array<{ id: string }>;
  entries: unknown[];
  branch: Array<{ id: string }>;
};

type MockPi = ExtensionAPI & {
  _calls: Array<{
    content: string;
    customType?: string;
    display?: boolean;
    details?: { runId: string; deliveryId: string };
  }>;
  _emit: (event: string) => void;
  _options: unknown[];
};

// Loaded once before all tests
let mod: TaskPanelModule;

before(async () => {
  mod = (await import("../src/task-panel.js")) as TaskPanelModule;
});

function createMockSessionManager(
  sessionId = "session-1",
  entries: unknown[] = [],
  branch: Array<{ id: string }> = [],
): MockSessionManager {
  return {
    getSessionId: () => sessionId,
    getEntries: () => entries,
    getBranch: () => branch,
    entries,
    branch,
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
      deliveryMode: options.deliveryMode,
      parentLeafId: options.parentLeafId,
    };
    pending.push(delivery);
    return delivery;
  };
  return manager;
}

function createMockPi(): MockPi {
  const calls: MockPi["_calls"] = [];
  const options: unknown[] = [];
  const handlers = new Map<string, Array<() => void>>();
  const obj = {
    sendMessage(msg: unknown, opts?: unknown) {
      options.push(opts);
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
    _options: options,
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

async function withTempWorkflowState(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-delivery-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  try {
    await withFakeHomeAsync(fakeHome, () => fn(cwd));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
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

  it("leaves a no-trigger result pending when its captured session context is stale", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const session = createMockSessionManager("session-1", [], [{ id: "origin-leaf" }]);
    manager._queue("completed before session replacement", {
      deliveryMode: "no-trigger",
      parentLeafId: "origin-leaf",
    });
    mod.installResultDelivery(pi, manager, session, {
      isIdle: () => {
        throw new Error("This extension context is stale");
      },
    });

    assert.doesNotThrow(() => manager.emit("complete", { runId: "test-run-1" }));
    assert.equal(pi._calls.length, 0);
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

  it("defers no-trigger delivery until idle and then appends without starting a turn", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const session = createMockSessionManager("session-1", [], [{ id: "origin-leaf" }]);
    let idle = false;

    mod.installResultDelivery(pi, manager, session, { isIdle: () => idle });
    manager._queue("fork done", {
      deliveryMode: "no-trigger",
      parentLeafId: "origin-leaf",
    });
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(pi._calls.length, 0, "streaming parent sessions must not receive the result yet");

    idle = true;
    pi._emit("agent_settled");
    assert.equal(pi._calls.length, 1);
    assert.deepEqual(pi._options[0], { triggerTurn: false });
  });

  it("does not use command branch-navigation reconciliation for tool-started delivery", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    mod.installResultDelivery(pi, manager, createMockSessionManager());
    manager._queue("ordinary workflow result");

    pi._emit("session_tree");
    assert.equal(pi._calls.length, 0);
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(pi._calls.length, 1);
    assert.deepEqual(pi._options[0], { triggerTurn: true, deliverAs: "followUp" });
  });

  it("keeps a no-trigger delivery pending on an unrelated tree branch", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const session = createMockSessionManager("session-1", [], [{ id: "other-branch" }]);
    mod.installResultDelivery(pi, manager, session, { isIdle: () => true });
    manager._queue("branch-private result", {
      deliveryMode: "no-trigger",
      parentLeafId: "origin-leaf",
    });

    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(pi._calls.length, 0);
    assert.equal(manager.listPendingTerminalDeliveries("session-1").length, 1);

    session.branch.push({ id: "origin-leaf" });
    pi._emit("session_tree");
    assert.equal(pi._calls.length, 1, "returning to the originating branch reconciles before the next turn");
  });

  it("makes a no-trigger custom result part of the next manually initiated parent context", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const root = mkdtempSync(join(tmpdir(), "pi-dw-parent-context-"));
    try {
      const parent = SessionManager.create(root, join(root, "sessions"));
      parent.appendMessage({ role: "user", content: [{ type: "text", text: "shared parent task" }] } as Parameters<
        typeof parent.appendMessage
      >[0]);
      const sharedLeaf = parent.getLeafId();
      assert.ok(sharedLeaf);
      parent.appendMessage({ role: "user", content: [{ type: "text", text: "originating branch" }] } as Parameters<
        typeof parent.appendMessage
      >[0]);
      const originLeaf = parent.getLeafId();
      assert.ok(originLeaf);
      parent.branch(sharedLeaf);
      parent.appendMessage({ role: "user", content: [{ type: "text", text: "unrelated branch" }] } as Parameters<
        typeof parent.appendMessage
      >[0]);

      const pi = createMockPi();
      const originalSend = pi.sendMessage.bind(pi);
      pi.sendMessage = ((message: any, options?: unknown) => {
        parent.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        originalSend(message, options);
      }) as typeof pi.sendMessage;
      const manager = createMockManager(makeRun());
      manager._queue("durable child result", {
        sessionId: parent.getSessionId(),
        deliveryMode: "no-trigger",
        parentLeafId: originLeaf,
      });

      mod.installResultDelivery(pi, manager, parent as unknown as MockSessionManager, { isIdle: () => true });
      manager.emit("complete", { runId: "test-run-1" });
      assert.equal(pi._calls.length, 0, "the result stays off the unrelated branch");

      parent.branch(originLeaf);
      pi._emit("session_tree");
      parent.appendMessage({ role: "user", content: [{ type: "text", text: "my next manual turn" }] } as Parameters<
        typeof parent.appendMessage
      >[0]);

      const context = JSON.stringify(parent.buildSessionContext().messages);
      assert.match(context, /durable child result/);
      assert.match(context, /my next manual turn/);
      assert.deepEqual(pi._options[0], { triggerTurn: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("redelivers a pending checkpoint notification after a simulated manager restart", async () => {
    await withTempWorkflowState(async (cwd) => {
      const delivery: Delivery = {
        runId: "restart-run",
        deliveryId: "restart-run:paused:checkpoint",
        sessionId: "session-1",
        content: checkpointDeliveryText("restart-run", "Approve restart?"),
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
          content: checkpointDeliveryText("restart-run", "Approve restart?"),
          details: { runId: "restart-run", deliveryId: "restart-run:paused:checkpoint" },
        },
      ]);
      assert.equal(
        restarted.getPersistence().load("restart-run")?.terminalDeliveries?.[0].state,
        "pending",
        "enqueueing is not proof that Pi persisted the message",
      );
    });
  });

  it("redelivers a branch-affine no-trigger result after manager restart", async () => {
    await withTempWorkflowState(async (cwd) => {
      const delivery: Delivery = {
        runId: "command-restart-run",
        deliveryId: "command-restart-run:completed",
        sessionId: "session-1",
        content: "durable fork completion",
        state: "pending",
        deliveryMode: "no-trigger",
        parentLeafId: "origin-leaf",
      };
      const original = new WorkflowManager({ cwd, sessionId: "session-1" });
      original.getPersistence().save(persistedRun(delivery));

      const restarted = new WorkflowManager({ cwd, sessionId: "session-1" });
      const pi = createMockPi();
      mod.installResultDelivery(pi, restarted, createMockSessionManager("session-1", [], [{ id: "origin-leaf" }]), {
        isIdle: () => true,
      });

      assert.equal(pi._calls[0]?.content, "durable fork completion");
      assert.deepEqual(pi._options[0], { triggerTurn: false });
    });
  });

  it("does not duplicate a pause message already persisted before restart", async () => {
    await withTempWorkflowState(async (cwd) => {
      const delivery: Delivery = {
        runId: "dedup-run",
        deliveryId: "dedup-run:paused:checkpoint",
        sessionId: "session-1",
        content: checkpointDeliveryText("dedup-run", "Already asked?"),
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
          content: checkpointDeliveryText("dedup-run", "Already asked?"),
          display: true,
          details: { runId: "dedup-run", deliveryId: "dedup-run:paused:checkpoint" },
        },
      ]);

      mod.installResultDelivery(pi, restarted, session);

      assert.equal(pi._calls.length, 0);
      assert.equal(restarted.getPersistence().load("dedup-run")?.terminalDeliveries?.[0].state, "delivered");
    });
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

  const actionablePauseCases = [
    {
      name: "usage limit",
      deliveryId: "test-run-1:paused:usage",
      content: usageLimitDeliveryText("test-run-1", "Codex usage limit reached (plus plan).", "Resets in ~3h"),
      matches: [/paused/, /\/workflows resume test-run-1/, /Resets in ~3h/],
      excludes: [/failed/],
    },
    {
      name: "retryable agent failure",
      deliveryId: "test-run-1:paused:failure",
      content: agentFailureDeliveryText("test-run-1", "reviewer returned malformed output"),
      matches: [/reviewer returned malformed output/, /\/workflows retry test-run-1/],
      excludes: [],
    },
    {
      name: "human checkpoint",
      deliveryId: "test-run-1:paused:checkpoint",
      content: checkpointDeliveryText("test-run-1", "Accept the bounded rollout risk?"),
      matches: [/Accept the bounded rollout risk\?/, /resumeRunId/],
      excludes: [/Ask the user|Do not start a new run/],
    },
  ];

  for (const deliveryCase of actionablePauseCases) {
    it(`delivers a durable ${deliveryCase.name} pause record`, () => {
      const pi = createMockPi();
      const manager = createMockManager(makeRun());
      mod.installResultDelivery(pi, manager, createMockSessionManager());
      manager._queue(deliveryCase.content, { deliveryId: deliveryCase.deliveryId });

      manager.emit("paused", { runId: "test-run-1" });

      assert.equal(pi._calls.length, 1);
      for (const pattern of deliveryCase.matches) assert.match(pi._calls[0].content, pattern);
      for (const pattern of deliveryCase.excludes) assert.doesNotMatch(pi._calls[0].content, pattern);
      assert.deepEqual(pi._calls[0].details, {
        runId: "test-run-1",
        deliveryId: deliveryCase.deliveryId,
      });
    });
  }

  const managedActionablePauseCases = [
    {
      name: "human checkpoint",
      script: `export const meta = { name: 'checkpoint_wakeup', description: 'checkpoint wakeup' }
return await checkpoint('Approve the next step?')`,
      agent: {
        async run() {
          return "unused";
        },
      },
      content: /Approve the next step\?/,
    },
    {
      name: "retryable agent failure",
      script: `export const meta = { name: 'failure_wakeup', description: 'failure wakeup' }
return await agent('review', { label: 'reviewer' })`,
      agent: {
        async run() {
          throw new WorkflowError("retryable reviewer failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: true,
            agentLabel: "reviewer",
          });
        },
      },
      content: /retryable reviewer failure/,
    },
    {
      name: "usage limit",
      script: `export const meta = { name: 'usage_wakeup', description: 'usage wakeup' }
return await agent('continue', { label: 'limited', retryable: false })`,
      agent: {
        async run() {
          throw new WorkflowError("provider usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets soon",
          });
        },
      },
      content: /provider usage limit reached/,
    },
  ];

  for (const pauseCase of managedActionablePauseCases) {
    it(`wakes the parent for a manager-produced ${pauseCase.name} pause`, async () => {
      await withTempWorkflowState(async (cwd) => {
        const manager = new WorkflowManager({
          cwd,
          sessionId: "session-1",
          agent: pauseCase.agent,
        });
        const pi = createMockPi();
        mod.installResultDelivery(pi, manager, createMockSessionManager(), { isIdle: () => false });

        const { runId, promise } = manager.startInBackground(pauseCase.script);
        await assert.rejects(promise);

        assert.equal(pi._calls.length, 1);
        assert.match(pi._calls[0].content, pauseCase.content);
        assert.deepEqual(pi._options, [{ triggerTurn: true, deliverAs: "followUp" }]);
        assert.equal(pi._calls[0].details?.runId, runId);
        assert.ok(pi._calls[0].details?.deliveryId.startsWith(`${runId}:paused:`));
      });
    });
  }

  it("wakes the parent again when the same retryable run pauses after retry", async () => {
    await withTempWorkflowState(async (cwd) => {
      let attempts = 0;
      const manager = new WorkflowManager({
        cwd,
        sessionId: "session-1",
        agent: {
          async run() {
            attempts++;
            throw new WorkflowError(`retryable failure ${attempts}`, WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
              recoverable: true,
              agentLabel: "reviewer",
            });
          },
        },
      });
      const session = createMockSessionManager();
      const pi = createMockPi();
      const originalSend = pi.sendMessage.bind(pi);
      pi.sendMessage = ((message: any, options?: unknown) => {
        session.entries.push({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
        originalSend(message, options);
      }) as typeof pi.sendMessage;
      mod.installResultDelivery(pi, manager, session, { isIdle: () => false });

      const script = `export const meta = { name: 'repeat_wakeup', description: 'repeat wakeup' }
return await agent('review', { label: 'reviewer' })`;
      const { runId, promise } = manager.startInBackground(script);
      await assert.rejects(promise);
      assert.equal(pi._calls.length, 1);
      const firstDeliveryId = pi._calls[0].details?.deliveryId;
      assert.ok(firstDeliveryId);

      pi._emit("agent_settled");
      assert.equal(
        manager
          .getPersistence()
          .load(runId)
          ?.terminalDeliveries?.find((delivery) => delivery.deliveryId === firstDeliveryId)?.state,
        "delivered",
      );

      const pausedAgain = new Promise<void>((resolve) => manager.once("paused", () => resolve()));
      assert.equal(await manager.retry(runId), true);
      await pausedAgain;

      assert.equal(attempts, 2);
      assert.equal(pi._calls.length, 2, "the second actionable pause must send another wake-up");
      assert.match(pi._calls[1].content, /retryable failure 2/);
      assert.ok(pi._calls[1].details?.deliveryId.startsWith(`${runId}:paused:`));
      assert.notEqual(pi._calls[1].details?.deliveryId, firstDeliveryId);
      assert.deepEqual(pi._options, [
        { triggerTurn: true, deliverAs: "followUp" },
        { triggerTurn: true, deliverAs: "followUp" },
      ]);
    });
  });

  it("a command fork's usage-limit pause delivers only its durable no-trigger record", () => {
    const pi = createMockPi();
    const manager = createMockManager(
      makeRun({
        conversationFork: {
          command: "fork",
          childSessionPath: "/tmp/child.jsonl",
          task: "background task",
          parentLeafId: null,
        },
      }),
    );
    mod.installResultDelivery(pi, manager, createMockSessionManager());
    manager._queue("⏸ Conversation fork test-run-1 paused", {
      deliveryId: "test-run-1:paused:1",
      deliveryMode: "no-trigger",
      parentLeafId: null,
    });

    manager.emit("paused", { runId: "test-run-1" });

    assert.equal(pi._calls.length, 1, "only the durable outbox record is delivered");
    assert.equal(pi._calls[0].content, "⏸ Conversation fork test-run-1 paused");
    assert.deepEqual(pi._options[0], { triggerTurn: false }, "a fork pause never triggers a parent turn");
  });

  it("a manual manager pause leaves no actionable record or parent wake-up", async () => {
    await withTempWorkflowState(async (cwd) => {
      let releaseAgent!: () => void;
      const agentReleased = new Promise<void>((resolve) => {
        releaseAgent = resolve;
      });
      const manager = new WorkflowManager({
        cwd,
        sessionId: "session-1",
        agent: {
          async run() {
            await agentReleased;
            return "done";
          },
        },
      });
      const pi = createMockPi();
      mod.installResultDelivery(pi, manager, createMockSessionManager());
      const started = new Promise<void>((resolve) => manager.once("agentStart", () => resolve()));
      const run = manager.startInBackground(`export const meta = { name: 'manual', description: 'manual pause' }
return await agent('wait')`);
      await started;

      assert.equal(manager.pause(run.runId), true);
      assert.deepEqual(manager.listPendingTerminalDeliveries("session-1"), []);
      assert.equal(pi._calls.length, 0);

      releaseAgent();
      await run.promise.catch(() => {});
    });
  });
});

// ─── installTaskPanel ─────────────────────────────────────────────────────────

describe("installTaskPanel", () => {
  it("registers a widget named workflow-tasks with belowEditor placement", () => {
    const manager = new EventEmitter() as ReturnType<typeof EventEmitter> & {
      listActiveRuns: () => unknown[];
    };
    manager.listActiveRuns = () => [];

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
      listActiveRuns: () => unknown[];
    };
    manager.listActiveRuns = () => [
      {
        runId: "a",
        status: "running",
        snapshot: {
          name: "handle_gh_issues_11_12_with_a_long_suffix",
          agents: [{ status: "done" }, { status: "running" }],
        },
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

  it("renders active runs without reading persisted history", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const manager = {
      listActiveRuns: () => [
        {
          runId: "a",
          status: "running",
          snapshot: { name: "live", agents: [{ status: "done" }] },
        },
      ],
      listRuns: () => {
        throw new Error("render must not list persisted history");
      },
    };
    const lines = renderPanel(manager as never, theme as never);
    assert.ok(
      lines.some((l) => l.includes("live")),
      "active run should be rendered",
    );
    assert.ok(!lines.some((l) => l.includes("/workflows")), "panel should not render a navigator hint");
  });

  it("renders nothing when no run is active", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const manager = { listActiveRuns: () => [] };
    assert.deepEqual(renderPanel(manager as never, theme as never), []);
  });

  it("truncates every rendered line to the requested visible width", async () => {
    const { renderPanel } = await import("../src/task-panel.js");
    const ansiTheme = {
      fg: (_c: string, t: string) => `\x1b[2m${t}\x1b[22m`,
      bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
    };
    const manager = {
      listActiveRuns: () => [
        {
          runId: "a",
          status: "running",
          snapshot: {
            name: "handle_gh_issues_11_12_中文_🙂_very_long_workflow_name",
            currentPhase: "Issue implementation phase with a very long suffix",
            agents: [{ status: "done" }, { status: "running" }],
          },
        },
      ],
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
      listActiveRuns: () => [{ runId: "r1", status, snapshot }],
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
    assert.ok(!lines.some((l) => l.includes("/workflows")), "panel should not render a navigator hint");
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
      listActiveRuns: () => unknown[];
    };
    const snapshot = {
      name: "wf",
      phases: ["P1"],
      currentPhase: "P1",
      logs: [],
      agents: [{ id: 1, label: "a", status: "running", phase: "P1", tokens: 500 }],
      tokenUsage: { total: 500, input: 250, output: 250 },
    };
    manager.listActiveRuns = () => [{ runId: "r1", status: "running", snapshot }];
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
