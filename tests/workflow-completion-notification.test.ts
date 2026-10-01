import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { loadWorkflowModule } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { installResultDelivery } from "../src/workflow-notifications.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const meta = "export const meta = { name: 'notification', description: 'completion policy' }";

async function withState(fn: (cwd: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "workflow-notification-"));
  try {
    await withFakeHomeAsync(join(root, "home"), () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function deliveryHost(manager: WorkflowManager, cwd: string, initiallyIdle = true) {
  const session = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.setSessionId(session.getSessionId());
  let idle = initiallyIdle;
  const sent: Array<{ options: unknown; content: unknown }> = [];
  const handlers = new Map<string, () => void>();
  const pi = {
    on(event: string, handler: () => void) {
      handlers.set(event, handler);
    },
    sendMessage(message: any, options: unknown) {
      sent.push({ options, content: message.content });
      session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  } as unknown as ExtensionAPI;
  const install = (target: WorkflowManager) => installResultDelivery(pi, target, session, { isIdle: () => idle });
  install(manager);
  return {
    sent,
    session,
    install,
    settle() {
      idle = true;
      handlers.get("agent_settled")?.();
    },
  };
}

for (const { name, body, expected } of [
  { name: "default wakes", body: "", expected: "wake" },
  { name: "explicit wake", body: 'setCompletionNotification("wake")', expected: "wake" },
  { name: "silent", body: 'setCompletionNotification("silent")', expected: "silent" },
  {
    name: "last call restores wake",
    body: 'setCompletionNotification("silent"); setCompletionNotification("wake")',
    expected: "wake",
  },
  {
    name: "last call selects silent",
    body: 'setCompletionNotification("wake"); setCompletionNotification("silent")',
    expected: "silent",
  },
  {
    name: "conditional silent after agent result",
    body: 'setCompletionNotification(result === "clear" ? "silent" : "wake")',
    expected: "silent",
  },
]) {
  test(`completion notification: ${name}`, () =>
    withState(async (cwd) => {
      const manager = new WorkflowManager({ cwd, agent: { run: async () => "clear" } });
      const host = deliveryHost(manager, cwd);
      const { runId, promise } = manager.startInBackground(
        `${meta}\nconst result = await agent('check')\n${body}\nreturn result`,
      );
      const result = await promise;
      assert.equal(result.completionNotification ?? "wake", expected);
      assert.equal(result.result, "clear");
      assert.equal(manager.getRun(runId)?.status, "completed");
      assert.equal(readFileSync(manager.getRun(runId)?.outputFile as string, "utf8"), "clear");
      assert.equal(host.sent.length, 1);
      assert.deepEqual(
        host.sent[0].options,
        expected === "silent" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "followUp" },
      );
      assert.match(String(host.sent[0].content), /full output:/);
      assert.match(JSON.stringify(host.session.buildSessionContext().messages), /full output:/);
      host.settle();
      assert.equal(host.sent.length, 1, "durable completion is not delivered twice");
      assert.equal(manager.getPersistence().load(runId)?.terminalDeliveries?.[0].state, "delivered");
    }));
}

test("silent delivery stays pending while busy and survives manager restart", () =>
  withState(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: { run: async () => "clear" } });
    const host = deliveryHost(manager, cwd, false);
    const { runId, promise } = manager.startInBackground(
      `${meta}\nawait agent('check')\nsetCompletionNotification('silent')\nreturn 'done'`,
    );
    await promise;
    assert.equal(host.sent.length, 0);
    assert.equal(manager.getPersistence().load(runId)?.terminalDeliveries?.[0].deliveryMode, "no-trigger");
    const restarted = new WorkflowManager({ cwd, sessionId: host.session.getSessionId() });
    host.install(restarted);
    assert.equal(host.sent.length, 0);
    host.settle();
    assert.equal(host.sent.length, 1);
    assert.deepEqual(host.sent[0].options, { triggerTurn: false });
    host.settle();
    assert.equal(host.sent.length, 1);
    assert.equal(restarted.getPersistence().load(runId)?.terminalDeliveries?.[0].state, "delivered");
  }));

test("notification choice is isolated between runs on the same manager", () =>
  withState(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: { run: async () => "ok" } });
    const host = deliveryHost(manager, cwd);
    await Promise.all([
      manager.startInBackground(`${meta}\nsetCompletionNotification('silent')\nreturn await agent('quiet')`).promise,
      manager.startInBackground(`${meta}\nreturn await agent('default')`).promise,
    ]);
    assert.equal(host.sent.length, 2);
    assert.deepEqual(host.sent.map((message) => (message.options as { triggerTurn: boolean }).triggerTurn).sort(), [
      false,
      true,
    ]);
  }));

test("native modules can choose silent completion through context", () =>
  withState(async (cwd) => {
    const path = join(cwd, "workflow.mjs");
    writeFileSync(
      path,
      `${meta}\nexport async function run({agent, setCompletionNotification}) {
const result = await agent('check');
setCompletionNotification(result === 'clear' ? 'silent' : 'wake');
return result;
}`,
    );
    const manager = new WorkflowManager({ cwd, agent: { run: async () => "clear" } });
    const host = deliveryHost(manager, cwd);
    const workflowModule = await loadWorkflowModule(path);
    await manager.startInBackground("", undefined, { workflowModule, workflowModulePath: path }).promise;
    assert.equal(host.sent.length, 1);
    assert.deepEqual(host.sent[0].options, { triggerTurn: false });
  }));

for (const mode of ['"off"', "null", "undefined", "false", "{}"] as const) {
  test(`invalid completion mode ${mode} is rejected`, () =>
    withState(async (cwd) => {
      const manager = new WorkflowManager({ cwd, agent: { run: async () => "ok" } });
      const host = deliveryHost(manager, cwd);
      const { promise } = manager.startInBackground(
        `${meta}\nawait agent('check')\nsetCompletionNotification(${mode})`,
      );
      await assert.rejects(promise, /requires "wake" or "silent"/);
      assert.equal(host.sent.length, 1);
      assert.deepEqual(host.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
    }));
}

test("silent selection does not suppress failure wakeups", () =>
  withState(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: { run: async () => "ok" } });
    const host = deliveryHost(manager, cwd, false);
    const { promise } = manager.startInBackground(
      `${meta}\nsetCompletionNotification('silent')\nawait agent('check')\nthrow new Error('failed check')`,
    );
    await assert.rejects(promise, /failed check/);
    assert.equal(host.sent.length, 1, "failure is delivered even while the parent is busy");
    assert.deepEqual(host.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
  }));

test("checkpoint wakes the parent and cold resume reconstructs a conditional silent choice", () =>
  withState(async (cwd) => {
    let calls = 0;
    const agent = {
      run: async () => {
        calls++;
        return "clear";
      },
    };
    const first = new WorkflowManager({ cwd, agent });
    const host = deliveryHost(first, cwd);
    const { runId, promise } = first.startInBackground(`${meta}
const result = await agent('check');
setCompletionNotification(result === 'clear' ? 'silent' : 'wake');
const answer = await checkpoint('Continue?');
return answer;`);
    await assert.rejects(promise, /Continue\?/);
    assert.deepEqual(host.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
    const second = new WorkflowManager({ cwd, agent, sessionId: host.session.getSessionId() });
    host.install(second);
    const completed = new Promise<void>((resolve) => second.once("complete", () => resolve()));
    assert.equal(await second.resumeWithReply(runId, "yes"), true);
    await completed;
    assert.equal(calls, 1, "the result driving the notification choice replays from the journal");
    assert.equal(second.getRun(runId)?.result?.result, "yes");
    assert.equal(host.sent.length, 2);
    assert.deepEqual(host.sent[1].options, { triggerTurn: false });
  }));

test("retry failure wakes the parent and retry reconstructs silent completion", () =>
  withState(async (cwd) => {
    let calls = 0;
    const agent = {
      run: async () => {
        if (++calls === 1)
          throw new WorkflowError("try again", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
        return "ok";
      },
    };
    const first = new WorkflowManager({ cwd, agent });
    const host = deliveryHost(first, cwd);
    const { runId, promise } = first.startInBackground(
      `${meta}
setCompletionNotification('silent');
return await agent('check', { retryable: true, readOnly: false });`,
      undefined,
      { agentRetries: 0 },
    );
    await assert.rejects(promise, /try again/);
    assert.equal(first.getRun(runId)?.pauseReason, "agent_failure");
    assert.deepEqual(host.sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
    const second = new WorkflowManager({ cwd, agent, sessionId: host.session.getSessionId() });
    host.install(second);
    const completed = new Promise<void>((resolve) => second.once("complete", () => resolve()));
    assert.equal(await second.retry(runId), true);
    await completed;
    assert.equal(calls, 2);
    assert.equal(host.sent.length, 2);
    assert.deepEqual(host.sent[1].options, { triggerTurn: false });
  }));
