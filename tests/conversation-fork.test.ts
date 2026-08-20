import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { snapshotActiveConversationBranch } from "../src/conversation-fork.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { installResultDelivery } from "../src/task-panel.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];

function appendUser(session: SessionManager, text: string): string {
  return session.appendMessage({ role: "user", content: [{ type: "text", text }] } as SessionMessage);
}

function appendAssistant(session: SessionManager, text: string): string {
  return session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    provider: "test",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
    timestamp: Date.now(),
  } as unknown as SessionMessage);
}

function sessionText(session: SessionManager): string {
  return JSON.stringify(session.buildSessionContext().messages);
}

async function waitForTerminal(manager: WorkflowManager, runId: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const status = manager.getPersistence().load(runId)?.status;
    if (status && status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`run ${runId} did not reach a terminal state`);
}

function tempDirs() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-conversation-fork-"));
  const home = mkdtempSync(join(tmpdir(), "pi-dw-conversation-home-"));
  return {
    cwd,
    home,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("snapshotActiveConversationBranch copies only the active path and leaves the parent unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-active-branch-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent"));
    const rootId = appendUser(parent, "shared root");
    appendAssistant(parent, "abandoned answer");
    appendUser(parent, "abandoned branch marker");
    appendAssistant(parent, "abandoned branch result");
    parent.branch(rootId);
    appendAssistant(parent, "active answer");
    appendUser(parent, "active branch marker");
    appendAssistant(parent, "active branch result");

    const parentPath = parent.getSessionFile();
    assert.ok(parentPath);
    const parentBefore = readFileSync(parentPath, "utf8");
    const activeIds = parent.getBranch().map((entry) => entry.id);
    const childPath = join(root, "child.jsonl");

    await snapshotActiveConversationBranch(parent, childPath, {
      cwd: root,
      model: { provider: "current-provider", id: "current-model" },
      thinkingLevel: "high",
    });

    assert.equal(readFileSync(parentPath, "utf8"), parentBefore, "forking must not append to or rewrite the parent");
    const child = SessionManager.open(childPath, undefined, root);
    const copiedIds = child
      .getEntries()
      .filter((entry) => entry.type !== "model_change" && entry.type !== "thinking_level_change")
      .map((entry) => entry.id);
    assert.deepEqual(copiedIds, activeIds, "the child contains exactly the selected root-to-leaf path");
    assert.match(sessionText(child), /active branch marker/);
    assert.doesNotMatch(sessionText(child), /abandoned branch marker/);
    assert.deepEqual(child.buildSessionContext().model, { provider: "current-provider", modelId: "current-model" });
    assert.equal(child.buildSessionContext().thinkingLevel, "high");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshotActiveConversationBranch never removes an existing target it did not create", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-existing-fork-target-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent"));
    appendUser(parent, "parent context");
    const childPath = join(root, "existing-child.jsonl");
    writeFileSync(childPath, "existing session bytes\n");

    await assert.rejects(snapshotActiveConversationBranch(parent, childPath, { cwd: root }), /exist/i);
    assert.equal(readFileSync(childPath, "utf8"), "existing session bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale parent extension context cannot reclassify a completed fork or strand its session", async () => {
  const dirs = tempDirs();
  try {
    await withFakeHomeAsync(dirs.home, async () => {
      const parent = SessionManager.create(dirs.cwd, join(dirs.cwd, "stale-context-parent"));
      appendUser(parent, "parent context");
      let call = 0;
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        sessionId: parent.getSessionId(),
        agent: {
          async run() {
            call++;
            return call === 1 ? "fork completed" : "continuation completed";
          },
        },
      });
      const pi = {
        on: () => {},
        sendMessage: () => {
          throw new Error("stale API should not be reached");
        },
      } as unknown as ExtensionAPI;
      installResultDelivery(pi, manager, parent, {
        isIdle: () => {
          throw new Error("This extension context is stale");
        },
      });

      const fork = await manager.startConversationFork({
        task: "finish after session replacement",
        parentSession: parent,
      });
      assert.equal((await fork.promise).result, "fork completed");
      const persisted = manager.getPersistence().load(fork.runId);
      assert.equal(persisted?.status, "completed");
      assert.deepEqual(
        persisted?.terminalDeliveries?.map((delivery) => delivery.deliveryId),
        [`${fork.runId}:completed`],
      );

      const continuation = manager.continueConversationFork({
        sourceRunId: fork.runId,
        instruction: "use the child after stale delivery",
        parentSession: parent,
      });
      assert.equal((await continuation.promise).result, "continuation completed");
    });
  } finally {
    dirs.cleanup();
  }
});

test("command-started fork failures and stops persist no-trigger parent results", async () => {
  const dirs = tempDirs();
  try {
    await withFakeHomeAsync(dirs.home, async () => {
      const parent = SessionManager.create(dirs.cwd, join(dirs.cwd, "parent-terminal"));
      appendUser(parent, "terminal parent context");

      const failing = new WorkflowManager({
        cwd: dirs.cwd,
        sessionId: parent.getSessionId(),
        agent: {
          async run() {
            throw new WorkflowError("terminal child failure", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
              recoverable: false,
            });
          },
        },
      });
      const failed = await failing.startConversationFork({ task: "fail explicitly", parentSession: parent });
      await assert.rejects(failed.promise);
      const failedState = failing.getPersistence().load(failed.runId);
      assert.equal(failedState?.status, "failed");
      assert.equal(failedState?.terminalDeliveries?.[0]?.deliveryMode, "no-trigger");
      assert.match(failedState?.terminalDeliveries?.[0]?.content ?? "", /terminal child failure/);
      assert.match(failedState?.terminalDeliveries?.[0]?.content ?? "", /fail explicitly/);
      assert.match(failedState?.terminalDeliveries?.[0]?.content ?? "", /Child session:/);

      const stoppedManager = new WorkflowManager({
        cwd: dirs.cwd,
        sessionId: parent.getSessionId(),
        agent: {
          async run(_prompt: string, options?: { signal?: AbortSignal }) {
            await new Promise<void>((_resolve, reject) => {
              if (options?.signal?.aborted) reject(new Error("aborted"));
              else options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
            return "unreachable";
          },
        },
      });
      const stopped = await stoppedManager.startConversationFork({ task: "stop explicitly", parentSession: parent });
      assert.equal(stoppedManager.stop(stopped.runId), true);
      await assert.rejects(stopped.promise);
      const stoppedState = stoppedManager.getPersistence().load(stopped.runId);
      assert.equal(stoppedState?.status, "aborted");
      assert.equal(stoppedState?.terminalDeliveries?.[0]?.deliveryMode, "no-trigger");
      assert.match(stoppedState?.terminalDeliveries?.[0]?.content ?? "", /stop explicitly/);
      assert.match(stoppedState?.terminalDeliveries?.[0]?.content ?? "", /Child session:/);
    });
  } finally {
    dirs.cleanup();
  }
});

test("a fork usage-limit pause notifies durably without a parent turn and clears on resume", async () => {
  const dirs = tempDirs();
  try {
    await withFakeHomeAsync(dirs.home, async () => {
      const parent = SessionManager.create(dirs.cwd, join(dirs.cwd, "pause-parent"));
      appendUser(parent, "pause parent context");
      let calls = 0;
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        sessionId: parent.getSessionId(),
        agent: {
          async run() {
            calls++;
            if (calls === 1) {
              throw new WorkflowError("Codex usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
                recoverable: false,
                resetHint: "Resets in ~3h",
              });
            }
            return "recovered result";
          },
        },
      });
      const sent: Array<{ content: string; options: unknown }> = [];
      const pi = {
        on: () => {},
        sendMessage: (message: { content?: string }, options: unknown) => {
          sent.push({ content: message.content ?? "", options });
        },
      } as unknown as ExtensionAPI;
      installResultDelivery(pi, manager, parent, { isIdle: () => true });

      const fork = await manager.startConversationFork({ task: "survive the limit", parentSession: parent });
      await assert.rejects(fork.promise);

      const paused = manager.getPersistence().load(fork.runId);
      assert.equal(paused?.status, "paused");
      assert.equal(paused?.pauseReason, "usage_limit");
      const pauseNotice = paused?.terminalDeliveries?.[0];
      assert.ok(pauseNotice?.deliveryId.startsWith(`${fork.runId}:paused`));
      assert.equal(pauseNotice?.deliveryMode, "no-trigger");
      assert.equal(pauseNotice?.parentLeafId, parent.getLeafId());
      assert.match(pauseNotice?.content ?? "", /Codex usage limit reached/);
      assert.match(pauseNotice?.content ?? "", /Resets in ~3h/);
      assert.match(pauseNotice?.content ?? "", /survive the limit/);
      assert.match(pauseNotice?.content ?? "", new RegExp(`/workflows resume ${fork.runId}`));
      assert.match(pauseNotice?.content ?? "", /Child session:/);

      assert.equal(sent.length, 1, "the pause notice is delivered once");
      assert.equal(sent[0].content, pauseNotice?.content);
      assert.deepEqual(sent[0].options, { triggerTurn: false }, "a fork pause must not trigger a parent turn");

      assert.equal(await manager.resume(fork.runId), true);
      const resumedOnDisk = manager.getPersistence().load(fork.runId);
      assert.equal(
        resumedOnDisk?.terminalDeliveries?.some(
          (delivery) => delivery.state === "pending" && delivery.deliveryId.startsWith(`${fork.runId}:paused`),
        ),
        false,
        "resume durably clears the pause notice before the resumed run's first debounced persist",
      );
      const deadline = Date.now() + 3000;
      while (manager.getPersistence().load(fork.runId)?.status !== "completed" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const completed = manager.getPersistence().load(fork.runId);
      assert.equal(completed?.status, "completed");
      assert.deepEqual(
        completed?.terminalDeliveries?.map((delivery) => delivery.deliveryId),
        [`${fork.runId}:completed`],
        "resume clears the stale pause notice",
      );
    });
  } finally {
    dirs.cleanup();
  }
});

test("stopping a usage-limit-paused fork drops its pending pause notice", async () => {
  const dirs = tempDirs();
  try {
    await withFakeHomeAsync(dirs.home, async () => {
      const parent = SessionManager.create(dirs.cwd, join(dirs.cwd, "pause-stop-parent"));
      appendUser(parent, "pause stop parent context");
      const limitAgent = {
        async run(): Promise<string> {
          throw new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets in ~1h",
          });
        },
      };

      // In-memory stop of an acknowledged command: no notice of any kind remains.
      const manager = new WorkflowManager({ cwd: dirs.cwd, sessionId: parent.getSessionId(), agent: limitAgent });
      const acknowledged = await manager.startConversationFork({ task: "stop me quietly", parentSession: parent });
      await assert.rejects(acknowledged.promise);
      assert.equal(manager.stop(acknowledged.runId, { notifyParent: false }), true);
      const quiet = manager.getPersistence().load(acknowledged.runId);
      assert.equal(quiet?.status, "aborted");
      assert.deepEqual(quiet?.terminalDeliveries ?? [], []);

      // Cross-restart stop with notification: the pause notice is replaced by the
      // aborted fork notice, never delivered alongside it.
      const second = await manager.startConversationFork({ task: "stop me after restart", parentSession: parent });
      await assert.rejects(second.promise);
      const restarted = new WorkflowManager({ cwd: dirs.cwd, sessionId: parent.getSessionId() });
      assert.equal(restarted.getRun(second.runId), undefined, "the restarted manager has no in-memory run");
      assert.equal(restarted.stop(second.runId), true);
      const stopped = restarted.getPersistence().load(second.runId);
      assert.equal(stopped?.status, "aborted");
      assert.deepEqual(
        stopped?.terminalDeliveries?.map((delivery) => delivery.deliveryId),
        [`${second.runId}:aborted`],
      );
      assert.equal(stopped?.terminalDeliveries?.[0]?.deliveryMode, "no-trigger");
      assert.match(stopped?.terminalDeliveries?.[0]?.content ?? "", /stop me after restart/);
    });
  } finally {
    dirs.cleanup();
  }
});

test("/workflows fork and continue use one persistent transcript, new run IDs, and no parent turn", async () => {
  const dirs = tempDirs();
  try {
    await withFakeHomeAsync(dirs.home, async () => {
      const parent = SessionManager.create(dirs.cwd, join(dirs.cwd, "parent"));
      appendUser(parent, "parent question");
      appendAssistant(parent, "parent context");
      const parentPath = parent.getSessionFile();
      assert.ok(parentPath);
      const parentBefore = readFileSync(parentPath, "utf8");

      const calls: Array<{
        prompt: string;
        sessionPath: string;
        before: string;
        model?: string;
        restoreSessionModel?: boolean;
      }> = [];
      let releaseContinuation: (() => void) | undefined;
      const continuationGate = new Promise<void>((resolve) => {
        releaseContinuation = resolve;
      });
      const manager = new WorkflowManager({
        cwd: dirs.cwd,
        sessionId: parent.getSessionId(),
        agent: {
          async run(prompt: string, options?: { sessionPath?: string; model?: string; restoreSessionModel?: boolean }) {
            assert.ok(options?.sessionPath);
            const child = SessionManager.open(options.sessionPath, undefined, dirs.cwd);
            calls.push({
              prompt,
              sessionPath: options.sessionPath,
              before: sessionText(child),
              model: options.model,
              restoreSessionModel: options.restoreSessionModel,
            });
            appendUser(child, prompt);
            const result = calls.length === 1 ? "first result" : "continued result";
            if (calls.length === 2) await continuationGate;
            appendAssistant(child, result);
            return result;
          },
        },
      });

      manager.setMainModel("parent-provider/parent-model");

      let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
      const sent: Array<{ message: unknown; options: unknown }> = [];
      const notices: Array<{ message: string; type?: string }> = [];
      const pi = {
        getCommands: () => [],
        registerCommand: (_name: string, command: { handler: typeof handler }) => {
          handler = command.handler;
        },
        sendMessage: (message: unknown, options: unknown) => {
          sent.push({ message, options });
        },
      } as unknown as ExtensionAPI;
      registerWorkflowCommands(pi, manager);
      assert.ok(handler);
      const ctx = {
        sessionManager: parent,
        model: { provider: "test", id: "test-model" },
        thinkingLevel: "high",
        waitForIdle: async () => {},
        ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
      };

      await handler("fork implement the explicit child task", ctx);
      assert.equal(sent.length, 0, "the command must not send a parent message or trigger a parent LLM turn");
      const forkRun = manager.listRuns()[0];
      assert.ok(forkRun?.conversationFork);
      await waitForTerminal(manager, forkRun.runId);
      const completedFork = manager.getPersistence().load(forkRun.runId);
      assert.equal(completedFork?.status, "completed");
      const childPath = completedFork?.conversationFork?.childSessionPath;
      assert.ok(childPath && existsSync(childPath));
      assert.equal(
        readFileSync(parentPath, "utf8"),
        parentBefore,
        "background child execution leaves the parent unchanged",
      );
      assert.match(calls[0].before, /parent context/, "the first child turn inherits the active parent conversation");
      assert.match(calls[0].prompt, /implement the explicit child task/);
      assert.equal(calls[0].model, undefined, "initial execution does not route from the parent model");
      assert.equal(
        calls[0].restoreSessionModel,
        true,
        "initial execution restores the command-time model saved in the child",
      );
      assert.equal(
        completedFork?.agents[0]?.sessionPath,
        childPath,
        "the agent state persists its absolute session path",
      );
      assert.match(completedFork?.terminalDeliveries?.[0]?.content ?? "", /first result/);
      assert.match(
        completedFork?.terminalDeliveries?.[0]?.content ?? "",
        new RegExp(childPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.equal(completedFork?.terminalDeliveries?.[0]?.deliveryMode, "no-trigger");
      const sourceRunPath = join(manager.getPersistence().getRunsDir(), `${forkRun.runId}.json`);
      const sourceRunBeforeContinuation = readFileSync(sourceRunPath, "utf8");

      await handler(`continue ${forkRun.runId} apply the follow-up instruction`, ctx);
      const activeContinuation = manager
        .listRuns()
        .find((run) => run.runId !== forkRun.runId && run.status === "running");
      assert.ok(activeContinuation?.conversationFork);
      assert.notEqual(activeContinuation.runId, forkRun.runId);
      assert.equal(activeContinuation.conversationFork.childSessionPath, childPath);

      releaseContinuation?.();
      await waitForTerminal(manager, activeContinuation.runId);
      assert.equal(calls[1].sessionPath, childPath);
      assert.match(calls[1].before, /first result/, "continuation sees the prior child result before its new turn");
      assert.match(calls[1].prompt, /apply the follow-up instruction/);
      assert.equal(calls[1].model, undefined, "continuation does not route from the parent model");
      assert.equal(calls[1].restoreSessionModel, true, "continuation preserves the child session's saved model state");
      assert.match(sessionText(SessionManager.open(childPath, undefined, dirs.cwd)), /continued result/);
      assert.equal(
        readFileSync(sourceRunPath, "utf8"),
        sourceRunBeforeContinuation,
        "continuation creates a new run without mutating the completed source run",
      );

      const restarted = new WorkflowManager({ cwd: dirs.cwd, sessionId: parent.getSessionId() });
      const persistedContinuation = restarted.listRuns().find((run) => run.runId === activeContinuation.runId);
      assert.equal(
        persistedContinuation?.conversationFork?.childSessionPath,
        childPath,
        "restart restores the run-to-session link",
      );

      await handler(`status ${activeContinuation.runId}`, ctx);
      const statusMessage = sent.at(-1)?.message as { content?: string } | undefined;
      assert.match(statusMessage?.content ?? "", new RegExp(childPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      assert.equal(manager.deleteRun(forkRun.runId), true);
      assert.equal(existsSync(childPath), true, "removing run history must not delete the child session");
      assert.ok(notices.some((notice) => notice.message.includes("Child session:")));
    });
  } finally {
    dirs.cleanup();
  }
});
