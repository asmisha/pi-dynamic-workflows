import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { JournalEntry, PendingCheckpoint } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

test("checkpoint(): always transfers control with durable metadata", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Approve plan?')`;
  let thrown: unknown;
  try {
    await runWorkflow(script, { agent: noopAgent, persistLogs: false });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof WorkflowError);
  assert.equal(thrown.code, WorkflowErrorCode.CHECKPOINT_INPUT_REQUIRED);
  assert.equal(thrown.recoverable, false);
  const checkpoint = thrown.details as PendingCheckpoint;
  assert.equal(checkpoint.callIndex, 0);
  assert.equal(typeof checkpoint.hash, "string");
  assert.equal(checkpoint.prompt, "Approve plan?");
  assert.equal(typeof checkpoint.callId, "string");
  assert.deepEqual(Object.keys(checkpoint).sort(), ["callId", "callIndex", "hash", "prompt"]);
});

test("checkpoint(): rejects all options including removed default/headless flags", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?', { default: true, headless: 'default' })`;
  await assert.rejects(
    () => runWorkflow(script, { agent: noopAgent, persistLogs: false }),
    /accepts only a question string/i,
  );
});

test("checkpoint(): replays a journaled parent reply and continues", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const reply = await checkpoint('Approve?')
return { reply, continued: true }`;
  let checkpoint: PendingCheckpoint | undefined;
  try {
    await runWorkflow(script, { agent: noopAgent, persistLogs: false });
  } catch (error) {
    if (error instanceof WorkflowError) checkpoint = error.details as PendingCheckpoint;
  }
  assert.ok(checkpoint);

  const journal = new Map<number, JournalEntry>([
    [checkpoint.callIndex, { index: checkpoint.callIndex, hash: checkpoint.hash, result: "approved" }],
  ]);
  const resumed = await runWorkflow<{ reply: string; continued: boolean }>(script, {
    agent: noopAgent,
    persistLogs: false,
    resumeJournal: journal,
  });

  assert.equal(resumed.result.reply, "approved");
  assert.equal(resumed.result.continued, true);
});

test("checkpoint(): cached prefix and reply replay even when cumulative token budget is exhausted", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const before = await agent('before')
const reply = await checkpoint('Approve?')
return { before, reply }`;
  const journal: JournalEntry[] = [];
  let pending: PendingCheckpoint | undefined;
  try {
    await runWorkflow(script, {
      agent: noopAgent,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    });
  } catch (error) {
    if (error instanceof WorkflowError) pending = error.details as PendingCheckpoint;
  }
  assert.ok(pending);
  journal.push({ index: pending.callIndex, hash: pending.hash, result: "approved" });
  const resumed = await runWorkflow<{ before: string; reply: string }>(script, {
    agent: {
      run: async () => {
        throw new Error("cached agent must not rerun");
      },
    },
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    tokenBudget: 100,
    initialTokenUsage: { total: 100 },
  });
  assert.equal(resumed.result.before, "ok");
  assert.equal(resumed.result.reply, "approved");
});

test("checkpoint(): rejects concurrent parallel placement", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await parallel([() => checkpoint('unsafe')])`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /awaited sequentially/i);
});

test("checkpoint(): disables native Promise scheduling", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await Promise.all([agent('work'), checkpoint('unsafe')])`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /Promise|undefined/i);
});

test("checkpoint(): rejects detached async functions at parse time", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' };
(async () => { await agent('late work') })()
return await checkpoint('unsafe')`;
  await assert.rejects(
    () => runWorkflow(script, { agent: noopAgent, persistLogs: false }),
    /cannot detach async functions/i,
  );
});

test("checkpoint(): transfers control even when its returned value is not awaited", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
checkpoint('still pauses')
return 'unreachable'`;
  await assert.rejects(
    () => runWorkflow(script, { agent: noopAgent, persistLogs: false }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.CHECKPOINT_INPUT_REQUIRED,
  );
});

test("checkpoint(): allows at most one parent decision per run", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const first = await checkpoint('first')
const second = await checkpoint('second')
return { first, second }`;
  let first: PendingCheckpoint | undefined;
  try {
    await runWorkflow(script, { agent: noopAgent, persistLogs: false });
  } catch (error) {
    if (error instanceof WorkflowError) first = error.details as PendingCheckpoint;
  }
  assert.ok(first);
  const journal = new Map<number, JournalEntry>([
    [first.callIndex, { index: first.callIndex, hash: first.hash, result: "answer" }],
  ]);
  await assert.rejects(
    () => runWorkflow(script, { agent: noopAgent, persistLogs: false, resumeJournal: journal }),
    /at most once/i,
  );
});

test("checkpoint(): rejects workflows with phase token sub-budgets", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint', phases: [{ title: 'P' }] }
phase('P', { budget: 100 })
return await checkpoint('unsupported budget combination')`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /phase token sub-budgets/i);
});

test("checkpoint(): counts against maxAgents", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('a')
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false, maxAgents: 0 }), /limit/i);
});
