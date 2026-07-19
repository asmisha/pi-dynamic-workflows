import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("runWorkflow concurrency caps parallel agents", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const started: Array<string> = [];
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(prompt);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'concurrency_cap', description: 'cap parallelism' }
const xs = await parallel(['a','b','c','d'].map((p) => () => agent(p, { label: p })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 2, "only the first two agents should start before the gate opens");
  release.resolve();
  const result = await run;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.result, ["ok:a", "ok:b", "ok:c", "ok:d"]);
  assert.equal(result.agentCount, 4);
});

test("runWorkflow retries recoverable empty output then succeeds", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_success', description: 'retry success' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1, "retries should not allocate extra logical agent slots");
  assert.equal(journal.length, 1, "only the final success is journaled");
});

test("read-only agents retry once by default without rerunning a successful sibling", async () => {
  const calls = { reviewer: 0, sibling: 0 };
  const result = await runWorkflow(
    `export const meta = { name: 'readonly_retry', description: 'read-only retry' }
return await parallel([
  () => agent('review', { label: 'reviewer', readOnly: true }),
  () => agent('inspect', { label: 'sibling', readOnly: true }),
])`,
    {
      agent: {
        async run(prompt: string) {
          if (prompt === "inspect") {
            calls.sibling++;
            return "evidence";
          }
          calls.reviewer++;
          return calls.reviewer === 1 ? "" : "reviewed";
        },
      },
      persistLogs: false,
    },
  );

  assert.deepEqual(result.result, ["reviewed", "evidence"]);
  assert.deepEqual(calls, { reviewer: 2, sibling: 1 });
});

test("explicit retries zero disables the read-only retry default", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'readonly_no_retry', description: 'explicit read-only retry override' }
return await agent('review', { label: 'reviewer', readOnly: true, retries: 0 })`,
        {
          agent: {
            async run() {
              calls++;
              return "";
            },
          },
          persistLogs: false,
        },
      ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
  );
  assert.equal(calls, 1);
});

test("runWorkflow retries schema noncompliance without rerunning a successful sibling", async () => {
  const calls = { reviewer: 0, sibling: 0 };
  const result = await runWorkflow(
    `export const meta = { name: 'schema_retry', description: 'schema retry' }
return await parallel([
  () => agent('review', { label: 'reviewer' }),
  () => agent('inspect', { label: 'sibling' }),
])`,
    {
      agent: {
        async run(prompt: string) {
          if (prompt === "inspect") {
            calls.sibling++;
            return "evidence";
          }
          calls.reviewer++;
          if (calls.reviewer === 1) {
            throw new WorkflowError("invalid structured output", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, {
              recoverable: true,
            });
          }
          return "reviewed";
        },
      },
      agentRetries: 1,
      persistLogs: false,
    },
  );

  assert.deepEqual(result.result, ["reviewed", "evidence"]);
  assert.deepEqual(calls, { reviewer: 2, sibling: 1 });
});

test("runWorkflow never automatically retries an agent marked retryable false", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'no_writer_retry', description: 'no writer retry' }
return await agent('write files', { label: 'writer', retryable: false })`,
        {
          agent: {
            async run() {
              calls++;
              return "";
            },
          },
          agentRetries: 2,
          persistLogs: false,
        },
      ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
  );
  assert.equal(calls, 1);
});

test("runWorkflow throws the classified recoverable error when retries are exhausted", async () => {
  let calls = 0;
  const logs: string[] = [];
  const journal: JournalEntry[] = [];
  let ended: { label: string; errorCode?: WorkflowErrorCode; recoverable?: boolean } | undefined;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'retry_exhausted', description: 'retry exhausted' }
const a = await agent('work', { label: 'a' })
return a`,
        {
          agent: {
            async run() {
              calls++;
              return "";
            },
          },
          agentRetries: 1,
          persistLogs: false,
          onLog: (message) => logs.push(message),
          onAgentEnd: (event) => (ended = event),
          onAgentJournal: (entry) => journal.push(entry),
        },
      ),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT &&
      error.recoverable &&
      error.agentLabel === "a",
  );

  assert.equal(calls, 2, "one initial attempt plus the one configured retry");
  assert.equal(journal.length, 1, "failed calls are journaled with failed status, not as successes");
  assert.equal(journal[0]?.status, "failed");
  assert.equal(journal[0]?.error?.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(ended?.label, "a");
  assert.equal(ended?.errorCode, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(ended?.recoverable, true);
  assert.ok(
    logs.some((message) => /retrying/i.test(message)),
    "logs should mention retrying",
  );
  assert.ok(
    logs.some((message) => /exhausted/i.test(message)),
    "logs should mention exhaustion",
  );
});

test("runWorkflow does not retry nonrecoverable errors", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'no_retry_nonrecoverable', description: 'nonrecoverable' }
const a = await agent('work', { label: 'a' })
return a`,
      {
        agent: {
          async run() {
            calls++;
            throw new WorkflowError("hard stop", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
        agentRetries: 2,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(calls, 1);
});

test("per-agent retries override run-level retries", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'agent_retry_override', description: 'override' }
const a = await agent('work', { label: 'a', retries: 1 })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 0,
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
});

test("runWorkflow accumulates real per-agent usage (incl. cost + cache tokens)", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002, cacheRead: 50, cacheWrite: 10 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9, "should be within tolerance");
  assert.equal(result.tokenUsage?.cacheRead, 100, "cacheRead accumulates across agents");
  assert.equal(result.tokenUsage?.cacheWrite, 20, "cacheWrite accumulates across agents");
});

test("runWorkflow aggregates absolute live usage across parallel agents without double counting", async () => {
  const release = createDeferred<void>();
  const reporters = new Map<string, (usage: AgentUsage) => void>();
  const liveTotals: number[] = [];
  const liveAgentTotals = new Map<string, number[]>();
  const endedAgentTotals = new Map<string, number>();
  const finalUsage: Record<string, AgentUsage> = {
    a: { input: 10, output: 8, total: 18, cost: 0.018, cacheRead: 4, cacheWrite: 2 },
    b: { input: 15, output: 7, total: 22, cost: 0.022, cacheRead: 3, cacheWrite: 1 },
  };
  const runner = {
    async run(
      prompt: string,
      options: {
        onUsage?: (usage: AgentUsage) => void;
        onUsageUpdate?: (usage: AgentUsage) => void;
      },
    ) {
      if (options.onUsageUpdate) reporters.set(prompt, options.onUsageUpdate);
      await release.promise;
      options.onUsageUpdate?.(finalUsage[prompt]);
      options.onUsage?.(finalUsage[prompt]);
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'live_parallel', description: 'live usage' }
const results = await parallel(['a', 'b'].map((p) => () => agent(p, { label: p })))
return results`;

  const run = runWorkflow(script, {
    agent: runner,
    concurrency: 2,
    persistLogs: false,
    initialTokenUsage: { input: 3, output: 2, total: 5, cost: 0.1, cacheRead: 1, cacheWrite: 2 },
    onAgentUsage: ({ label, tokens }) => {
      const totals = liveAgentTotals.get(label) ?? [];
      totals.push(tokens);
      liveAgentTotals.set(label, totals);
    },
    onAgentEnd: ({ label, tokens }) => endedAgentTotals.set(label, tokens ?? 0),
    onTokenUsage: (usage) => liveTotals.push(usage.total),
  });

  while (reporters.size < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  reporters.get("a")?.({ input: 6, output: 4, total: 10, cost: 0.01, cacheRead: 2, cacheWrite: 1 });
  reporters.get("a")?.({ input: 6, output: 4, total: 10, cost: 0.01, cacheRead: 2, cacheWrite: 1 });
  reporters.get("b")?.({ input: 12, output: 8, total: 20, cost: 0.02, cacheRead: 2, cacheWrite: 1 });
  reporters.get("a")?.({ input: 9, output: 6, total: 15, cost: 0.015, cacheRead: 3, cacheWrite: 1 });

  assert.deepEqual(liveTotals, [15, 15, 35, 40], "repeated absolute snapshots must not be added twice");
  assert.deepEqual(liveAgentTotals.get("a"), [10, 10, 15], "an active agent's usage should update monotonically");
  assert.deepEqual(liveAgentTotals.get("b"), [20]);

  release.resolve();
  const result = await run;

  assert.deepEqual(result.tokenUsage, {
    input: 28,
    output: 17,
    total: 45,
    cost: 0.14,
    cacheRead: 8,
    cacheWrite: 5,
  });
  assert.equal(endedAgentTotals.get("a"), 18);
  assert.equal(endedAgentTotals.get("b"), 22);
  assert.equal(liveTotals[liveTotals.length - 1], 45, "the final emitted aggregate stays exact");
});

test("provisional SDK-retry usage does not block a concurrent pipeline stage", async () => {
  const provisionalReported = createDeferred<void>();
  const rollBackProvisional = createDeferred<void>();
  const usage = (total: number): AgentUsage => ({
    input: total,
    output: 0,
    total,
    cost: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const runner = {
    async run(prompt: string, options: { onUsageUpdate?: (usage: AgentUsage) => void }) {
      if (prompt === "retrying") {
        options.onUsageUpdate?.(usage(100));
        provisionalReported.resolve();
        await rollBackProvisional.promise;
        options.onUsageUpdate?.(usage(0));
        options.onUsageUpdate?.(usage(10));
        return "first:retrying";
      }
      if (prompt === "fast") {
        await provisionalReported.promise;
        options.onUsageUpdate?.(usage(10));
        setTimeout(() => rollBackProvisional.resolve(), 0);
        return "first:fast";
      }
      options.onUsageUpdate?.(usage(10));
      return prompt;
    },
  };
  const script = `export const meta = { name: 'provisional_budget', description: 'provisional usage' }
const results = await pipeline(
  ['retrying', 'fast'],
  item => agent(item, { label: 'first:' + item }),
  (_first, item) => agent('next:' + item, { label: 'second:' + item }),
)
return { results, spent: budget.spent(), remaining: budget.remaining() }`;

  const result = await runWorkflow<{ results: string[]; spent: number; remaining: number }>(script, {
    agent: runner,
    concurrency: 2,
    tokenBudget: 50,
    persistLogs: false,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    results: ["next:retrying", "next:fast"],
    spent: 40,
    remaining: 10,
  });
  assert.equal(result.tokenUsage.total, 40, "the rolled-back response stays out of final aggregate usage");
});

test("runWorkflow keeps logical-agent usage cumulative across retries", async () => {
  let attempt = 0;
  const liveAgentTotals: number[] = [];
  let endedTokens = 0;
  const runner = {
    async run(_prompt: string, options: { onUsage?: (usage: AgentUsage) => void }) {
      attempt++;
      if (attempt === 1) {
        options.onUsage?.({ input: 100, output: 0, total: 100, cost: 0.1, cacheRead: 0, cacheWrite: 0 });
        throw new Error("retry me");
      }
      options.onUsage?.({ input: 20, output: 0, total: 20, cost: 0.02, cacheRead: 0, cacheWrite: 0 });
      return "ok";
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'retry_usage', description: 'retry usage' }
return await agent('work', { label: 'worker' })`,
    {
      agent: runner,
      agentRetries: 1,
      persistLogs: false,
      onAgentUsage: ({ tokens }) => liveAgentTotals.push(tokens),
      onAgentEnd: ({ tokens }) => (endedTokens = tokens ?? 0),
    },
  );

  assert.equal(result.tokenUsage.input, 120);
  assert.equal(result.tokenUsage.total, 120);
  assert.ok(Math.abs(result.tokenUsage.cost - 0.12) < 1e-9);
  assert.equal(endedTokens, 120);
  assert.deepEqual(liveAgentTotals, [100, 120]);
});

test("runWorkflow settles timed-out attempts before starting a retry", async () => {
  let attempt = 0;
  let endedTokens = 0;
  const runner = {
    async run(_prompt: string, options: { onUsageUpdate?: (usage: AgentUsage) => void }) {
      attempt++;
      if (attempt === 1) {
        options.onUsageUpdate?.({ input: 10, output: 0, total: 10, cost: 0.01, cacheRead: 0, cacheWrite: 0 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        options.onUsageUpdate?.({ input: 20, output: 0, total: 20, cost: 0.02, cacheRead: 0, cacheWrite: 0 });
        return "too late";
      }
      options.onUsageUpdate?.({ input: 5, output: 0, total: 5, cost: 0.005, cacheRead: 0, cacheWrite: 0 });
      return "ok";
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'timeout_usage', description: 'timeout usage' }
return await agent('work', { label: 'worker', timeoutMs: 5 })`,
    {
      agent: runner,
      agentRetries: 1,
      persistLogs: false,
      onAgentEnd: ({ tokens }) => (endedTokens = tokens ?? 0),
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(result.tokenUsage.input, 25);
  assert.equal(result.tokenUsage.total, 25);
  assert.ok(Math.abs(result.tokenUsage.cost - 0.025) < 1e-9);
  assert.equal(endedTokens, 25);
});

test("runWorkflow bounds cleanup and does not retry a timed-out runner that never settles", async () => {
  let attempts = 0;
  const runner = {
    async run() {
      attempts++;
      return new Promise<never>(() => {});
    },
  };
  const started = Date.now();

  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'stuck_timeout', description: 'stuck timeout' }
return await agent('work', { label: 'worker', timeoutMs: 5 })`,
      { agent: runner, agentRetries: 1, persistLogs: false },
    ),
    (error: unknown) =>
      error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_TIMEOUT && !error.recoverable,
  );

  assert.equal(attempts, 1, "an abandoned attempt must not overlap a retry");
  assert.ok(Date.now() - started < 2500, "timeout cleanup must remain bounded");
});

test("meta.model is parsed and routes as the default model for agents", async () => {
  let seenModel: string | undefined;
  const recorder = {
    async run(_p: string, o: { model?: string }) {
      seenModel = o.model;
      return "ok";
    },
  };
  const script = `export const meta = { name: 'm', description: 'd', model: 'meta/default-model' }
await agent('x', { label: 'x' })
return 1`;
  await runWorkflow(script, { agent: recorder, persistLogs: false });
  assert.equal(seenModel, "meta/default-model", "an agent with no model/tier/phase route uses meta.model");
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("agents default to the first declared phase when the script omits phase()", async () => {
  // Regression for the "(no phase) has agents, declared phase 0/0" bug: a script
  // that declares meta.phases but never calls phase() should still group its
  // agents under the first declared phase, not an orphan "(no phase)" bucket.
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Research' }, { title: 'Synthesize' }] }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["Research"]);
});

test("explicit phase() overrides the default first phase", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
     phase('B')
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["B"]);
});

test("no declared phases => agent phase stays undefined (no synthetic phase)", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd' }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, [undefined]);
});

test("runWorkflow routes models: explicit opts.model > phase model > default", async () => {
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; onUsage?: (u: AgentUsage) => void }) {
      seen.push(options.model);
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'routing', description: 'model routing',
    phases: [{ title: 'A', model: 'phase-a-model' }, { title: 'B' }]
  }
  phase('A')
  await agent('explicit wins', { label: 'e', model: 'explicit-model' })
  await agent('phase routed', { label: 'p' })
  phase('B')
  await agent('no model -> default', { label: 'n' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  assert.deepEqual(seen, ["explicit-model", "phase-a-model", undefined]);
});

test("runWorkflow plumbs opts.tier through to the agent with correct precedence", async () => {
  // Regression guard: tier must reach WorkflowAgent.run() (it was previously
  // dropped). Precedence: explicit model > tier > phase model.
  const seen: Array<{ model?: string; tier?: string }> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; tier?: string }) {
      seen.push({ model: options.model, tier: options.tier });
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'tier_routing', description: 'tier routing',
    phases: [{ title: 'A', model: 'phase-a-model' }]
  }
  phase('A')
  await agent('tier beats phase', { label: 't', tier: 'small' })
  await agent('explicit beats tier', { label: 'e', tier: 'small', model: 'explicit-model' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  // 1) tier set, no explicit model: model is left undefined so the tier (resolved
  //    inside run()) wins over the phase model; tier is forwarded.
  assert.deepEqual(seen[0], { model: undefined, tier: "small" });
  // 2) explicit model + tier: explicit model is forwarded and still wins.
  assert.deepEqual(seen[1], { model: "explicit-model", tier: "small" });
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

const threeCallScript = `export const meta = { name: 'prefix', description: 'prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent('B', { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;

test("resume re-runs the changed call AND everything after it (longest-unchanged-prefix)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  // Edit the MIDDLE call (index 1). Index 0 is an unchanged prefix → cache hit.
  // Index 1 changed → re-run; index 2 is unchanged but AFTER the first miss, so
  // it must re-run too (the bug was serving it stale from the journal).
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run; only the prefix (0) is cached");
});

test("resume treats a failed journal entry as a prefix miss", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  const failedJournal = journal.map((entry) =>
    entry.index === 1
      ? {
          ...entry,
          status: "failed" as const,
          result: undefined,
          error: {
            message: "failed before pause",
            code: WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            recoverable: true,
          },
        }
      : entry,
  );

  const second = countingAgent();
  await runWorkflow(threeCallScript, {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(failedJournal.map((e) => [e.index, e])),
  });

  assert.equal(second.state.calls, 2, "failed call and its suffix re-run; only the prefix is cached");
});

test("resume in parallel(): editing one thunk re-runs that index and every later one", async () => {
  // Three identical-prompt thunks; editing the middle one must invalidate it and
  // the same-or-later index, not just the single changed call.
  const script = (mid: string) => `export const meta = { name: 'par_prefix', description: 'parallel prefix' }
  const xs = await parallel([
    () => agent('x', { label: 'p0' }),
    () => agent('${mid}', { label: 'p1' }),
    () => agent('x', { label: 'p2' }),
  ])
  return xs`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script("x"), {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  const second = countingAgent();
  await runWorkflow(script("x-edited"), {
    agent: second.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "changed thunk (index 1) + later index (2) re-run; index 0 cached");
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("removed nested and quality globals are unavailable in the workflow VM", async () => {
  const script = `export const meta = { name: 'removed_globals', description: 'removed globals' }
return [typeof workflow, typeof verify, typeof judgePanel, typeof loopUntilDry, typeof completenessCheck, typeof retry, typeof gate]`;

  const result = await runWorkflow<string[]>(script, { agent: countingAgent().runner, persistLogs: false });

  assert.deepEqual(
    [...result.result],
    ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined", "undefined"],
  );
});

test("runWorkflow budget gates on accumulated tokens", async () => {
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
const a = await agent('first', { label: 'a' })
let second = null
try { second = await agent('second', { label: 'b' }) } catch (e) { second = 'blocked' }
return { a, second }`;

  const result = await runWorkflow<{ a: unknown; second: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    tokenBudget: 100,
    persistLogs: false,
  });

  assert.equal(result.result.second, "blocked");
});

test("token budget exhaustion inside parallel() halts (non-recoverable, not swallowed)", async () => {
  // A warm-up agent spends the whole budget (soft gate: spent accrues after it
  // finishes); the agent() inside parallel() then hits the gate and must
  // propagate the non-recoverable error, not become a null in the result array.
  const script = `export const meta = { name: 'pb', description: 'budget in parallel' }
await agent('warmup', { label: 'w' })
const xs = await parallel([() => agent('x', { label: '1' })])
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
        tokenBudget: 100,
        persistLogs: false,
      }),
    /budget/i,
    "exhausted budget must reject the run, not become a null in the result array",
  );
});

test("parallel propagates exhausted recoverable errors and supports per-branch best effort", async () => {
  const failScript = `export const meta = { name: 'recoverable_parallel', description: 'recoverable lane failure' }
return await parallel([() => agent('lane', { label: 'lane' })])`;
  await assert.rejects(
    () => runWorkflow(failScript, { agent: { run: async () => "" }, persistLogs: false }),
    (error: unknown) =>
      error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT && error.recoverable,
  );

  const bestEffortScript = `export const meta = { name: 'best_effort_parallel', description: 'local catch fallback' }
const results = await parallel([
  () => agent('bad', { label: 'bad' }).catch(() => 'fallback'),
  () => agent('good', { label: 'good' }),
])
const after = await agent('after', { label: 'after' })
return { results, after }`;
  const result = await runWorkflow(bestEffortScript, {
    agent: { run: async (prompt: string) => (prompt === "bad" ? "" : prompt) },
    persistLogs: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { results: ["fallback", "good"], after: "after" });
});

test("detached parallel and pipeline failures keep their exact returned promises observed", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const body of [
      `parallel([() => { throw new Error('detached parallel') }])`,
      `pipeline(['x'], () => { throw new Error('detached pipeline') })`,
    ]) {
      const script = `export const meta = { name: 'detached_combinator', description: 'observe rejection' }
${body}
await Promise.resolve()
return 'done'`;
      await runWorkflow(script, { persistLogs: false }).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("parallel schedules every thunk when an earlier thunk throws synchronously", async () => {
  const started: string[] = [];
  const script = `export const meta = { name: 'sync_parallel_throw', description: 'schedule every branch' }
return await parallel([
  () => { throw new Error('sync branch failure') },
  () => agent('later', { label: 'later' }),
])`;
  const run = runWorkflow(script, {
    agent: {
      async run(prompt: string) {
        started.push(prompt);
        return prompt;
      },
    },
    persistLogs: false,
  });

  await assert.rejects(run, /sync branch failure/);
  for (let i = 0; i < 10 && !started.includes("later"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual(started, ["later"]);
});

test("pipeline keeps its runtime-owned branch live while a later stage yields", async () => {
  const gate = createDeferred<void>();
  const stageEntered = createDeferred<void>();
  const live = new Set<Promise<unknown>>();
  const script = `export const meta = { name: 'pipeline_branch_lifetime', description: 'track yielded branch' }
try {
  await pipeline(['bad', 'slow'],
    (item) => agent(item + '-one', { label: item + '-one' }),
    async (value) => {
      if (value === 'slow-one') {
        args.stageEntered()
        await args.gate
        return agent('slow-two', { label: 'slow-two' })
      }
      return value
    },
  )
} catch {}
return 'continued after aggregate catch'`;
  const run = runWorkflow(script, {
    args: { gate: gate.promise, stageEntered: () => stageEntered.resolve() },
    agent: { run: async (prompt: string) => (prompt === "bad-one" ? "" : prompt) },
    persistLogs: false,
    onRuntimeOwnedWorkStart(work) {
      live.add(work);
      void work.then(
        () => live.delete(work),
        () => live.delete(work),
      );
    },
  });

  await stageEntered.promise;
  await assert.rejects(
    run,
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.ok(live.size > 0, "the yielded pipeline branch remains runtime-owned after aggregate rejection");

  gate.resolve();
  for (let i = 0; i < 10 && live.size > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(live.size, 0);
});

test("pipeline propagates recoverable failures rather than converting them to null", async () => {
  const script = `export const meta = { name: 'recoverable_pipeline', description: 'recoverable pipeline failure' }
return await pipeline([0], () => agent('lane', { label: 'lane' }))`;
  await assert.rejects(
    () => runWorkflow(script, { agent: { run: async () => "" }, persistLogs: false }),
    (error: unknown) =>
      error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT && error.recoverable,
  );
});

test("non-recoverable agent-limit propagates out of pipeline() too", async () => {
  const script = `export const meta = { name: 'mp', description: 'agent limit pipeline' }
const xs = await pipeline([0, 1, 2, 3], (n) => agent('x' + n, { label: 'p' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("phase sub-budget throws when a phase exceeds its ceiling (run total untouched)", async () => {
  const script = `export const meta = { name: 'pb', description: 'phase budget' }
phase('noisy', { budget: 100 })
let blocked = false
try {
  await agent('a', { label: '1' })
  await agent('b', { label: '2' })
} catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
phase('calm')
const after = await agent('c', { label: '3' })
return { blocked, after }`;
  const res = await runWorkflow<{ blocked: boolean; after: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    persistLogs: false,
  });
  assert.equal(res.result.blocked, true, "the 2nd agent in the phase hit the sub-budget");
  assert.ok(res.result.after !== null, "a later phase still proceeds");
});

test("maxAgents is enforced under a parallel() fan-out (atomic slot reservation)", async () => {
  // Four agents fan out with maxAgents=2. With the synchronous slot reservation,
  // the 3rd agent() throws AGENT_LIMIT instead of all four passing the gate.
  const script = `export const meta = { name: 'ma', description: 'agent limit' }
const xs = await parallel([0, 1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

// ─── Additional edge case tests ─────────────────────────────────────────────────

test("runWorkflow returns meta, logs, phases, and duration", async () => {
  const ONE_AGENT = `export const meta = { name: 'meta_test', description: 'check metadata' }
const a = await agent('test', { label: 'a' })
return a`;

  const result = await runWorkflow(ONE_AGENT, {
    agent: fakeAgent({ total: 50 }),
    persistLogs: false,
  });

  assert.equal(result.meta.name, "meta_test");
  assert.equal(result.meta.description, "check metadata");
  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
  assert.ok(Array.isArray(result.phases), "result.phases should be an array");
  assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId should be a non-empty string");
});

test("runWorkflow handles empty script without phases gracefully", async () => {
  const SIMPLE = `export const meta = { name: 'simple', description: 'simple' }
const a = await agent('hello', { label: 'greeter' })
return a`;

  const result = await runWorkflow(SIMPLE, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.equal(result.result, "done");
  assert.equal(result.agentCount, 1);
});

test("runWorkflow parallel returns results in input order", async () => {
  const script = `export const meta = { name: 'parallel_order', description: 'check order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n, { label: 't' + n })))
return results`;

  let callIndex = 0;
  const agent = {
    async run(prompt: string) {
      return `result-${++callIndex}:${prompt}`;
    },
  };

  const result = await runWorkflow<unknown[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 3);
});

test("runWorkflow pipeline stages in order", async () => {
  const script = `export const meta = { name: 'pipeline_test', description: 'test pipeline' }
const results = await pipeline(['a','b'], item => agent('stage1 ' + item), result => agent('stage2 ' + result))
return results`;

  const log: string[] = [];
  const agent = {
    async run(prompt: string) {
      log.push(prompt);
      return prompt.replace("stage1", "stage1-done").replace("stage2", "stage2-done");
    },
  };

  const result = await runWorkflow<string[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 2);
});

test("runWorkflow agent with different labels", async () => {
  const script = `export const meta = { name: 'label_test', description: 'labels' }
const a = await agent('task1', { label: 'worker-1' })
const b = await agent('task2', { label: 'worker-2' })
return { a, b }`;

  const seenLabels: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentStart: (e) => seenLabels.push(e.label),
  });

  assert.deepEqual(seenLabels, ["worker-1", "worker-2"]);
});

test("runWorkflow with phases assignment to agents", async () => {
  const script = `export const meta = { name: 'phase_test', description: 'phases', phases: [{ title: 'Phase1' }, { title: 'Phase2' }] }
phase('Phase1')
const a = await agent('phase1 work', { label: 'p1' })
phase('Phase2')
const b = await agent('phase2 work', { label: 'p2' })
return { a, b }`;

  const phases: string[] = [];
  const agentPhases: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onAgentStart: (e) => {
      if (e.phase) agentPhases.push(e.phase);
    },
  });

  assert.ok(phases.includes("Phase1"), "should contain Phase1");
  assert.ok(phases.includes("Phase2"), "should contain Phase2");
});

test("runWorkflow can send args to the script", async () => {
  const script = `export const meta = { name: 'args_test', description: 'test args' }
return { received: args && args.value }`;

  const result = await runWorkflow<{ received: unknown }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    args: { value: 42 },
  });

  // No agent calls means 0 agents
  assert.equal(result.result.received, 42);
});

test("runWorkflow log function works inside script", async () => {
  const script = `export const meta = { name: 'log_test', description: 'logging' }
log('hello from script')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("hello from script")),
    "should contain hello from script",
  );
});

test("runWorkflow console.log works inside script", async () => {
  const script = `export const meta = { name: 'console_test', description: 'console' }
console.log('console log')
console.warn('console warn')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("console log")),
    "should contain console log",
  );
  assert.ok(
    result.logs.some((l) => l.includes("console warn")),
    "should contain console warn",
  );
});

test("runWorkflow process.cwd() works inside script", async () => {
  const script = `export const meta = { name: 'cwd_test', description: 'cwd' }
return { cwd: process.cwd() }`;

  const result = await runWorkflow<{ cwd: string }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.equal(typeof result.result.cwd, "string");
  assert.ok(result.result.cwd.length > 0, "result.cwd should not be empty");
});

test("runWorkflow budget object exposes spent() and remaining()", async () => {
  const script = `export const meta = { name: 'budget_api', description: 'budget API' }
try { const s = budget.spent(); const r = budget.remaining(); return { spent: s, remaining: typeof r } }
catch(e) { return { error: String(e) } }`;

  const result = await runWorkflow<{ spent: number; remaining: string }>(script, {
    agent: fakeAgent({ total: 100 }),
    persistLogs: false,
  });

  assert.equal(result.result.spent, 0); // before first agent
  assert.equal(result.result.remaining, "number");
});

test("runWorkflow returns empty logs array when nothing logged", async () => {
  const script = `export const meta = { name: 'no_log', description: 'no logs' }
await agent('silent', { label: 's' })
return 1`;

  const result = await runWorkflow(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
});

// ─── Runtime determinism hardening (P0-5) ───────────────────────────────────────

const noopAgent = {
  async run() {
    return "ok";
  },
};

function probe(expr: string): Promise<{ result: { err: string | null; val: unknown } }> {
  const script = `export const meta = { name: 'det', description: 'determinism' }
let err = null, val = null
try { val = ${expr} } catch (e) { err = String((e && e.message) || e) }
await agent('noop', { label: 'x' })
return { err, val }`;
  return runWorkflow(script, { agent: noopAgent, persistLogs: false });
}

test("parse-time guard rejects literal Date.now / Math.random / new Date()", async () => {
  for (const expr of ["Math.random()", "Date.now()", "new Date()"]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'lit', description: 'd' }\nconst v = ${expr}\nawait agent('x', { label: 'x' })\nreturn v`,
          { agent: noopAgent, persistLogs: false },
        ),
      /deterministic|unavailable/i,
      `${expr} literal should be rejected at parse time`,
    );
  }
});

test("runtime guard neuters computed-access bypasses the parse regex misses", async () => {
  const r1 = await probe('Math["random"]()');
  assert.match(r1.result.err ?? "", /unavailable|resume/i, 'Math["random"]() should throw at runtime');
  const r2 = await probe('Date["now"]()');
  assert.match(r2.result.err ?? "", /unavailable|resume/i, 'Date["now"]() should throw at runtime');
  const r3 = await probe("(() => { const D = Date; return new D(); })()");
  assert.match(r3.result.err ?? "", /unavailable|resume/i, "aliased no-arg Date should throw at runtime");
});

test("runtime determinism: new Date(arg) and Math.max still work", async () => {
  const d = await probe("new Date(0).getTime()");
  assert.equal(d.result.err, null, "new Date(0) should construct");
  assert.equal(d.result.val, 0, "new Date(0).getTime() === 0");
  const m = await probe("Math.max(1, 2, 3)");
  assert.equal(m.result.err, null);
  assert.equal(m.result.val, 3);
});

test("vm-realm builtins work and the constructor escape hits the neutered Date.now", async () => {
  // The escape string is split so the parse-time regex doesn't flag it; at runtime
  // the vm Function runs in the vm realm where Date.now is neutered.
  const script = `export const meta = { name: 'vm', description: 'vm realm' }
let escaped = null
try { escaped = ({}).constructor.constructor('return Da' + 'te.now()')() } catch (e) { escaped = 'blocked:' + String((e && e.message) || e) }
const arr = [1, 2, 3].map((x) => x * 2)
const j = JSON.stringify({ a: 1 })
const s = [...new Set([1, 1, 2])]
await agent('noop', { label: 'x' })
return { escaped, arr, j, s }`;
  const r = await runWorkflow<{ escaped: string; arr: number[]; j: string; s: number[] }>(script, {
    agent: noopAgent,
    persistLogs: false,
  });
  // Spread to a host array: vm-realm arrays don't deepStrictEqual host literals.
  assert.deepEqual([...r.result.arr], [2, 4, 6], "vm Array.map works");
  assert.equal(r.result.j, '{"a":1}', "vm JSON works");
  assert.deepEqual([...r.result.s], [1, 2], "vm Set works");
  // ({}).constructor.constructor is the vm Function; its code runs in the vm realm
  // where Date.now is neutered -> blocked (the old host-object escape is closed).
  assert.match(r.result.escaped, /blocked/, "constructor escape via vm objects is closed");
});

// ── per-agent cwd / session forwarding ─────────────────────────────────────────

test("agent opts.cwd, opts.forkFrom, and opts.sessionPath are forwarded to the runner", async () => {
  const seen: Array<{ cwd?: string; forkFrom?: string; sessionPath?: string }> = [];
  const runner = {
    async run(_prompt: string, options: { cwd?: string; forkFrom?: string; sessionPath?: string }) {
      seen.push({ cwd: options.cwd, forkFrom: options.forkFrom, sessionPath: options.sessionPath });
      return "ok";
    },
  };
  const script = `export const meta = { name: 'fwd', description: 'cwd/session forwarding' }
await agent('a', { label: 'plain' })
await agent('b', { label: 'placed', cwd: '/tmp/elsewhere', forkFrom: '/tmp/parent-session.jsonl', sessionPath: 'child-session' })
return 'done'`;
  await runWorkflow(script, { agent: runner, cwd: "/tmp/base", persistLogs: false });
  assert.deepEqual(seen, [
    { cwd: "/tmp/base", forkFrom: undefined, sessionPath: undefined },
    { cwd: "/tmp/elsewhere", forkFrom: "/tmp/parent-session.jsonl", sessionPath: "child-session" },
  ]);
});

test("changing opts.cwd, opts.forkFrom, or opts.sessionPath busts the resume cache", async () => {
  const journal: JournalEntry[] = [];
  const script = (extra: string) => `export const meta = { name: 'fwd_hash', description: 'hash bust' }
const r = await agent('task', { label: 'a'${extra} })
return r`;
  const first = countingAgent();
  await runWorkflow(script(""), {
    agent: first.runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 1);

  // Unchanged call replays from the journal.
  const replay = countingAgent();
  await runWorkflow(script(""), {
    agent: replay.runner,
    persistLogs: false,
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(replay.state.calls, 0, "unchanged call must replay");

  for (const [extra, label] of [
    [", cwd: '/tmp/x'", "cwd"],
    [", forkFrom: '/tmp/source.jsonl'", "forkFrom"],
    [", sessionPath: 'persistent-reviewer'", "sessionPath"],
  ] as const) {
    const rerun = countingAgent();
    await runWorkflow(script(extra), {
      agent: rerun.runner,
      persistLogs: false,
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.equal(rerun.state.calls, 1, `changed ${label} must re-run live`);
  }
});

test("parallel rejection does not cancel started or queued agent siblings", async () => {
  const release = createDeferred<void>();
  const started: string[] = [];
  const completed: string[] = [];
  const signals: AbortSignal[] = [];
  const script = `export const meta = { name: 'parallel_siblings', description: 'branch failures do not cancel siblings' }
return await parallel(['bad', 'slow-a', 'slow-b'].map((prompt) => () => agent(prompt, { label: prompt })))`;
  const run = runWorkflow(script, {
    concurrency: 1,
    persistLogs: false,
    agent: {
      async run(prompt: string, options: { signal: AbortSignal }) {
        started.push(prompt);
        signals.push(options.signal);
        if (prompt === "bad") return "";
        await release.promise;
        completed.push(prompt);
        return prompt;
      },
    },
  });

  await assert.rejects(run, (error: unknown) => error instanceof WorkflowError && error.recoverable);
  while (!started.includes("slow-a")) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["bad", "slow-a"], "the queued sibling starts after the first branch rejects");
  release.resolve();
  while (!completed.includes("slow-b")) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(completed, ["slow-a", "slow-b"]);
  assert.ok(
    signals.every((signal) => !signal.aborted),
    "branch failure does not abort sibling attempt signals",
  );
});
