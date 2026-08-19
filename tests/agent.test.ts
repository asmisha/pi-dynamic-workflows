import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRunOptions, AgentUsage } from "../src/agent.js";
import {
  forkSessionForSubagent,
  listAvailableModelSpecs,
  resolveAgentModelSpec,
  resolveSubagentSession,
  resolveTaskAnswer,
  WorkflowAgent,
} from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { ModelTierConfig } from "../src/model-tier-config.js";
import { acquireSessionWriterLease } from "../src/session-writer-lease.js";
import { runWorkflow } from "../src/workflow.js";

// Private methods used for testing - cast to this type to access them without `any`
type WorkflowAgentPrivates = {
  buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string;
};

test("listAvailableModelSpecs returns an array (empty when no auth configured)", () => {
  const result = listAvailableModelSpecs();
  assert.ok(Array.isArray(result), "should always return an array");
  // On CI or fresh installs there may be no models configured
  // The important thing is it doesn't throw
});

test("listAvailableModelSpecs entries have provider/model format when non-empty", () => {
  const result = listAvailableModelSpecs();
  for (const spec of result) {
    assert.ok(spec.includes("/"), `model spec "${spec}" should use provider/id format`);
    const [provider, id] = spec.split("/");
    assert.ok(provider.length > 0, "provider should not be empty");
    assert.ok(id.length > 0, "model id should not be empty");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveAgentModelSpec — model precedence: explicit model > tier > main model > medium fallback
// ═══════════════════════════════════════════════════════════════════════════

const tierConfig: ModelTierConfig = {
  tiers: { small: "vendor/small", medium: "vendor/medium", big: "vendor/big" },
};
const loadCfg = () => tierConfig;
const noCfg = () => null;

test("resolveAgentModelSpec: explicit model wins over tier (the precedence bug fix)", () => {
  // Even with a tier set AND a config that resolves it, an explicit model wins.
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "small" }, "main/model", loadCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: explicit model wins even when no config exists", () => {
  assert.equal(
    resolveAgentModelSpec({ model: "explicit/model", tier: "small" }, "main/model", noCfg),
    "explicit/model",
  );
});

test("resolveAgentModelSpec: tier resolves from config when no explicit model", () => {
  assert.equal(resolveAgentModelSpec({ tier: "big" }, "main/model", loadCfg), "vendor/big");
});

test("resolveAgentModelSpec: unconfigured tier falls back to the main model", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, "main/model", noCfg), "main/model");
  assert.equal(resolveAgentModelSpec({ tier: "unknown-tier" }, "main/model", loadCfg), "main/model");
});

test("resolveAgentModelSpec: untagged agent uses the session model before configured medium", () => {
  assert.equal(resolveAgentModelSpec({}, "main/model", loadCfg), "main/model");
});

test("resolveAgentModelSpec: untagged agent uses the session model without tier config", () => {
  assert.equal(resolveAgentModelSpec({}, "main/model", noCfg), "main/model");
});

test("resolveAgentModelSpec: untagged agent uses the session model when config lacks medium", () => {
  const noMedium = () => ({ tiers: { small: "vendor/small" } });
  assert.equal(resolveAgentModelSpec({}, "main/model", noMedium), "main/model");
});

test("resolveAgentModelSpec: untagged agent falls back to configured medium without a session model", () => {
  assert.equal(resolveAgentModelSpec({}, undefined, loadCfg), "vendor/medium");
});

test("resolveAgentModelSpec: tier with no main model and no config yields undefined", () => {
  assert.equal(resolveAgentModelSpec({ tier: "small" }, undefined, noCfg), undefined);
});

test("WorkflowAgent constructor accepts all option shapes without throwing", () => {
  const optionSets = [
    undefined,
    { cwd: "/tmp" },
    { cwd: "/tmp", instructions: "custom instruction" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test" },
    { cwd: "/tmp", mainModel: "openai/gpt-4.1" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test", mainModel: "openai/gpt-4.1" },
    {
      cwd: "/tmp",
      modelRegistry: {
        getAvailable: () => [{ provider: "mock", id: "model" }],
        find: () => undefined,
        getAll: () => [],
      } as any,
    },
  ];
  for (const opts of optionSets) {
    const agent = opts ? new WorkflowAgent(opts) : new WorkflowAgent();
    assert.ok(agent instanceof WorkflowAgent, `agent should be constructed for options: ${JSON.stringify(opts)}`);
  }
});

test("WorkflowAgent reuses an injected ModelRegistry instead of building its own", () => {
  const mockModel = { provider: "mock", id: "shared" } as any;
  const registry = {
    find: (provider: string, id: string) => (provider === "mock" && id === "shared" ? mockModel : undefined),
    getAvailable: () => [mockModel],
    getAll: () => [mockModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: registry });
  const resolved = (agent as any).resolveModel("mock/shared");
  assert.equal(resolved, mockModel, "should resolve via the injected registry");
});

test("WorkflowAgent falls back to building a disk registry when no registry is injected", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  // Should not throw; getRegistry() lazily builds a ModelRegistry.
  assert.doesNotThrow(() => (agent as any).getRegistry());
});

test("WorkflowAgent.resolveModel resolves via a per-run registry when the constructor got none", () => {
  // Regression test for the per-run `modelRegistry` AgentRunOptions field: a
  // model present only in a registry passed to run() (not the constructor)
  // must still resolve.
  const perRunModel = { provider: "router", id: "per-run-only" } as any;
  const perRunRegistry = {
    find: (provider: string, id: string) => (provider === "router" && id === "per-run-only" ? perRunModel : undefined),
    getAvailable: () => [perRunModel],
    getAll: () => [perRunModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const resolved = (agent as any).resolveModel("router/per-run-only", perRunRegistry);
  assert.equal(resolved, perRunModel, "should resolve via the per-run registry, not a disk registry");
});

test("WorkflowAgent.resolveModel: per-run registry takes precedence over the constructor's shared registry", () => {
  const constructorModel = { provider: "ctor", id: "shared" } as any;
  const constructorRegistry = {
    find: (provider: string, id: string) => (provider === "ctor" && id === "shared" ? constructorModel : undefined),
    getAvailable: () => [constructorModel],
    getAll: () => [constructorModel],
  } as any;

  const perRunModel = { provider: "run", id: "override" } as any;
  const perRunRegistry = {
    find: (provider: string, id: string) => (provider === "run" && id === "override" ? perRunModel : undefined),
    getAvailable: () => [perRunModel],
    getAll: () => [perRunModel],
  } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  // The per-run registry, not the constructor's, is consulted when both are set.
  const resolved = (agent as any).resolveModel("run/override", perRunRegistry);
  assert.equal(resolved, perRunModel, "per-run registry should win over the constructor's shared registry");
  // And the constructor registry is still used when no per-run registry is given.
  const fallback = (agent as any).resolveModel("ctor/shared");
  assert.equal(fallback, constructorModel, "constructor registry should still apply without a per-run override");
});

test("WorkflowAgent.getRegistry: per-run registry wins, then constructor's shared registry, then disk", () => {
  const constructorRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;
  const perRunRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  assert.equal((agent as any).getRegistry(perRunRegistry), perRunRegistry);
  assert.equal((agent as any).getRegistry(), constructorRegistry);

  const bareAgent = new WorkflowAgent({ cwd: "/tmp" });
  assert.doesNotThrow(() => (bareAgent as any).getRegistry());
});

// ═══════════════════════════════════════════════════════════════════════════
// buildPrompt — verifies that the agent's internal prompt assembly is correct
// ═══════════════════════════════════════════════════════════════════════════

test("buildPrompt includes base instructions, task label, and user prompt", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a helper." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "analyze this",
    { label: "analyzer" },
    false,
  );
  assert.ok(built.includes("You are a helper."), "should include base instructions");
  assert.ok(built.includes("Task label: analyzer"), "should include task label");
  assert.ok(built.includes("analyze this"), "should include user prompt");
});

test("buildPrompt includes per-call instructions when provided", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Base." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "do it",
    { label: "x", instructions: "Extra." },
    false,
  );
  assert.ok(built.includes("Base."), "base instructions");
  assert.ok(built.includes("Extra."), "per-call instructions");
  assert.ok(built.includes("do it"), "user prompt");
});

test("buildPrompt injects structured output contract when schema is used", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("return result", { label: "t" }, true);
  assert.ok(built.includes("structured_output"), "should mention structured_output");
  assert.ok(built.includes("no prose final answer"), "should discourage prose");
  assert.ok(built.includes("calling structured_output exactly once"), "should enforce single call");
});

test("buildPrompt works without base instructions", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", { label: "greeter" }, false);
  assert.ok(built.includes("Task label: greeter"), "should contain Task label: greeter");
  assert.ok(built.includes("hello"), "should contain hello");
});

test("buildPrompt works without label", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Help." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", {}, false);
  assert.ok(built.includes("Help."), "should contain Help.");
  assert.ok(built.includes("hello"), "should contain hello");
  assert.ok(!built.includes("Task label:"), "no label when omitted");
});

test("buildPrompt includes both instructions when both base and per-call are set", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a code reviewer." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "check this file",
    { label: "reviewer", instructions: "Focus on security." },
    true,
  );
  // Order: base instructions, per-call instructions, label, prompt, structured contract
  assert.ok(built.indexOf("You are a code reviewer.") < built.indexOf("Focus on security."), "base before per-call");
  assert.ok(built.indexOf("Focus on security.") < built.indexOf("Task label: reviewer"), "per-call before label");
  assert.ok(built.indexOf("Task label: reviewer") < built.indexOf("check this file"), "label before prompt");
  assert.ok(
    built.indexOf("check this file") < built.indexOf("calling structured_output exactly once"),
    "prompt before structured contract",
  );
});

test("buildPrompt preserves a leading slash template for native Pi prompt expansion", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Base workflow context." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "  /correctness-reviewer review cwd and changed files",
    { label: "correctness", instructions: "Per-call workflow context." },
    true,
  );

  assert.ok(built.startsWith("/correctness-reviewer review cwd and changed files"), "slash template stays first");
  assert.ok(
    built.indexOf("/correctness-reviewer") < built.indexOf("Base workflow context."),
    "native template appears before workflow context",
  );
  assert.ok(
    built.indexOf("Base workflow context.") < built.indexOf("Per-call workflow context."),
    "base context before per-call context",
  );
  assert.ok(built.includes("Task label: correctness"), "label is preserved");
  assert.ok(built.includes("calling structured_output exactly once"), "structured output contract is preserved");
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveTaskAnswer — the agent's answer to the task, not merely its last words
// ═══════════════════════════════════════════════════════════════════════════

const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const note = (text = "compaction recall note") => ({
  role: "custom",
  customType: "session-history-recall-note",
  content: text,
  display: true,
});
const answer = (text: string, stopReason = "stop") => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text }],
});
const toolTurn = (name: string) => ({
  role: "assistant",
  stopReason: "toolUse",
  content: [{ type: "toolCall", name, id: "t1", arguments: {} }],
});
const toolResult = (text: string) => ({ role: "toolResult", toolName: "read", content: [{ type: "text", text }] });

test("resolveTaskAnswer extracts last assistant text content", () => {
  const result = resolveTaskAnswer([userMsg("hello"), answer("hi there")]);
  assert.equal(result.text, "hi there");
  assert.equal(result.droppedTurns, 0);
});

test("resolveTaskAnswer joins multiple text parts", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    },
  ];
  assert.equal(resolveTaskAnswer(messages).text, "part1part2");
});

test("resolveTaskAnswer skips non-text content parts", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1" },
        { type: "text", text: "result" },
      ],
    },
  ];
  assert.equal(resolveTaskAnswer(messages).text, "result");
});

test("resolveTaskAnswer returns empty string when no assistant text", () => {
  assert.equal(resolveTaskAnswer([]).text, "");
  assert.equal(resolveTaskAnswer([userMsg("hello")]).text, "");
});

test("resolveTaskAnswer picks the last assistant message, not first", () => {
  const messages = [answer("first"), userMsg("more"), answer("final")];
  assert.equal(resolveTaskAnswer(messages).text, "final");
});

test("resolveTaskAnswer returns the report, not the reply to a post-compaction note", () => {
  const messages = [userMsg("audit this"), toolTurn("read"), toolResult("data"), answer("## Report\n\nfindings")];
  const withNote = [...messages, note(), answer("Understood.")];

  const result = resolveTaskAnswer(withNote);
  assert.equal(result.text, "## Report\n\nfindings");
  assert.equal(result.droppedTurns, 1);
  // Parity: without the injected note the same transcript resolves identically.
  assert.equal(resolveTaskAnswer(messages).text, result.text);
});

test("resolveTaskAnswer sees past a compaction summary preceding the note", () => {
  const messages = [
    { role: "compactionSummary", summary: "earlier work", tokensBefore: 100 },
    userMsg("audit this"),
    answer("## Report"),
    note(),
    answer("Understood."),
  ];
  assert.equal(resolveTaskAnswer(messages).text, "## Report");
});

test("resolveTaskAnswer unwinds a stack of notes and acknowledgements", () => {
  const messages = [
    userMsg("audit this"),
    answer("## Report"),
    note("first note"),
    answer("Understood."),
    note("second note"),
    answer("Understood again."),
  ];
  const result = resolveTaskAnswer(messages);
  assert.equal(result.text, "## Report");
  assert.equal(result.droppedTurns, 2);
});

test("resolveTaskAnswer keeps the continuation when a note lands mid-task", () => {
  // Compaction can fire between tool calls; there is no finished answer yet, so
  // the turn that follows the note carries the real result.
  const messages = [
    userMsg("audit this"),
    toolTurn("read"),
    toolResult("data"),
    note(),
    answer("## Report written after the note"),
  ];
  const result = resolveTaskAnswer(messages);
  assert.equal(result.text, "## Report written after the note");
  assert.equal(result.droppedTurns, 0);
});

test("resolveTaskAnswer keeps a note-driven turn when the answer was truncated", () => {
  // stopReason "length" means the answer never finished, so what follows continues it.
  const messages = [userMsg("audit this"), answer("## Report (cut off", "length"), note(), answer("...rest")];
  assert.equal(resolveTaskAnswer(messages).text, "...rest");
});

test("resolveTaskAnswer keeps a user-initiated continuation, so autocontinue still works", () => {
  const messages = [userMsg("audit this"), answer("partial"), userMsg("continue"), answer("the real ending")];
  const result = resolveTaskAnswer(messages);
  assert.equal(result.text, "the real ending");
  assert.equal(result.droppedTurns, 0);
});

test("resolveTaskAnswer answers the note when the task itself never produced one", () => {
  const messages = [userMsg("audit this"), toolTurn("read"), toolResult("data"), note(), answer("Understood.")];
  const result = resolveTaskAnswer(messages);
  assert.equal(result.text, "Understood.");
  assert.equal(result.droppedTurns, 0);
});

test("resolveTaskAnswer recovers the answer when the note turn failed outright", () => {
  // A provider error in the acknowledgement turn must not discard a finished
  // 4M-token report: droppedTurns tells the caller to skip the error throw.
  const messages = [
    userMsg("audit this"),
    answer("## Report"),
    note(),
    { role: "assistant", stopReason: "error", errorMessage: "rate limit", content: [] },
  ];
  const result = resolveTaskAnswer(messages);
  assert.equal(result.text, "## Report");
  assert.equal(result.droppedTurns, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Full agent() pipeline inside runWorkflow — verifies the agent() function
// in workflow.ts correctly invokes the runner with all options.
// ═══════════════════════════════════════════════════════════════════════════

/** A smart mock agent runner that records every call and validates options shape. */
class CallRecordingAgent {
  calls: Array<{
    prompt: string;
    options: Record<string, unknown>;
  }> = [];

  result: unknown = "mock-result";

  async run(prompt: string, options: any) {
    this.calls.push({ prompt, options: { ...options } });
    // Fire callbacks with synthetic data to test the full pipeline
    options.onUsage?.({
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 30,
      cost: 0.001,
    } satisfies AgentUsage);
    options.onModelResolved?.("openai/gpt-4.1-mini");
    return this.result;
  }
}

test("agent() in workflow passes prompt and label to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze this', { label: 'analyzer' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].prompt, "analyze this");
});

test("agent() in workflow forwards modelRegistry to the runner", async () => {
  const rec = new CallRecordingAgent();
  const fakeRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't' })
     return r`,
    { agent: rec, persistLogs: false, modelRegistry: fakeRegistry },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { modelRegistry?: any }).modelRegistry, fakeRegistry);
});

test("agent() in workflow passes model spec to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model");
});

test("agent() in workflow fires onAgentStart and onAgentEnd callbacks", async () => {
  const rec = new CallRecordingAgent();
  const events: string[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => events.push(`start:${e.label}`),
      onAgentEnd: (e) => events.push(`end:${e.label}`),
    },
  );
  assert.deepEqual(events, ["start:greeter", "end:greeter"]);
});

test("agent() in workflow forwards compact subagent history snapshots", async () => {
  const historyRunner = {
    async run(_prompt: string, options: any) {
      options.onHistory?.([{ role: "assistant", kind: "text", text: "working" }]);
      return "done";
    },
  };
  const histories: Array<{ label: string; history: Array<{ text: string }> }> = [];

  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: historyRunner,
      persistLogs: false,
      onAgentHistory: (event) => histories.push(event),
    },
  );

  assert.equal(histories.length, 1);
  assert.equal(histories[0].label, "greeter");
  assert.equal(histories[0].history[0].text, "working");
});

test("agent() in workflow fires onAgentStart with phase info", async () => {
  const rec = new CallRecordingAgent();
  const starts: Array<{ label: string; phase?: string }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't', phases: [{ title: 'Phase1' }] }
     phase('Phase1')
     await agent('work', { label: 'w' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => starts.push({ label: e.label, phase: e.phase }),
    },
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].phase, "Phase1");
});

test("agent() in workflow returns runner result", async () => {
  const rec = new CallRecordingAgent();
  rec.result = { findings: ["issue1"] };
  const result = await runWorkflow<{ findings: string[] }>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze', { label: 'a' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.deepEqual(result.result, { findings: ["issue1"] });
});

test("agent() in workflow throws classified recoverable errors after retries", async () => {
  const failer = {
    async run() {
      throw new Error("recoverable agent error");
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  await assert.rejects(
    () =>
      runWorkflow<unknown>(
        `export const meta = { name: 'test', description: 't' }
         const r = await agent('failing task', { label: 'f' })
         return r`,
        { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
      ),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.AGENT_EXECUTION_ERROR &&
      error.recoverable &&
      error.agentLabel === "f",
  );
  assert.equal(end?.result, null);
  assert.equal(end?.error, "recoverable agent error");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow treats empty text output as a recoverable failure", async () => {
  const rec = new CallRecordingAgent();
  rec.result = "   ";
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  await assert.rejects(
    () =>
      runWorkflow<unknown>(
        `export const meta = { name: 'test', description: 't' }
         const r = await agent('empty task', { label: 'empty' })
         return r`,
        { agent: rec, persistLogs: false, onAgentEnd: (e) => (end = e) },
      ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.AGENT_EMPTY_OUTPUT,
  );

  assert.equal(end?.result, null);
  assert.equal(end?.error, "Subagent produced no assistant output");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow reports non-recoverable errors before throwing", async () => {
  const failer = {
    async run() {
      throw new WorkflowError("schema failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;

  await assert.rejects(
    () =>
      runWorkflow<unknown>(
        `export const meta = { name: 'test', description: 't' }
         await agent('schema task', { label: 'schema' })
         return 1`,
        { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
      ),
    (err) => err instanceof WorkflowError && err.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
  );

  assert.equal(end?.result, null);
  assert.equal(end?.error, "schema failed");
  assert.equal(end?.errorCode, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
  assert.equal(end?.recoverable, false);
});

test("agent() in workflow fires cumulative onTokenUsage after each agent", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ input: number; output: number; total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ input: u.input, output: u.output, total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "one agent emits one cumulative usage update");
  assert.equal(usageEvents[0].total, 30, "should accumulate from agent usage");
});

test("agent() passes onModelResolved callback for display model updates", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't', model: 'some/model' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentEnd: (e) => {
        assert.equal(e.model, "openai/gpt-4.1-mini");
      },
    },
  );
  assert.ok(rec.calls.length > 0, "rec.calls should not be empty");
});

test("agent() reports the resolved model through onAgentModel as soon as it is known", async () => {
  const rec = new CallRecordingAgent();
  const modelEvents: Array<{ callId: string; label: string; model: string }> = [];
  const startModels: Array<string | undefined> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 'tiered' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => startModels.push(e.model),
      onAgentModel: (e) => modelEvents.push({ callId: e.callId, label: e.label, model: e.model }),
    },
  );
  // Before resolution the display model is the session default; the resolved
  // model must arrive as its own event, not only at agent end.
  assert.equal(modelEvents.length, 1, "one resolution reports once");
  assert.equal(modelEvents[0].label, "tiered");
  assert.equal(modelEvents[0].model, "openai/gpt-4.1-mini");
  assert.equal(startModels.length, 1);
});

test("agent() accumulates usage across multiple agents", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('first', { label: 'a' })
     await agent('second', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ total: u.total }),
    },
  );
  assert.deepEqual(usageEvents, [{ total: 30 }, { total: 60 }], "usage updates after each agent");
});

test("agent() with timeout exposes its recoverable error to a local catch", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 50));
      return "slow";
    },
  };
  let errorMessage = "";
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     let val = null
     try { val = await agent('slow', { label: 's', timeoutMs: 5 }) } catch (e) { val = 'error:' + (e && e.message || e) }
     return { val }`,
    {
      agent: slow,
      persistLogs: false,
      onAgentEnd: (event) => {
        if (event.error) errorMessage = event.error;
      },
    },
  );
  const r = result.result as { val: unknown };
  assert.match(String(r.val), /error:Agent "s" timed out after 5ms/);
  assert.match(errorMessage, /timed out after 5ms/);
  assert.match(errorMessage, /raise or omit timeoutMs\/agentTimeoutMs/);
});

test("agent() default timeout is unbounded", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's' })
     return { val }`,
    { agent: slow, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() timeoutMs null overrides a run-level timeout", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's', timeoutMs: null })
     return { val }`,
    { agent: slow, agentTimeoutMs: 5, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() with parallel invokes all agents", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await parallel(['a','b','c'].map(p => () => agent(p, { label: p })))
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 3);
  const prompts = rec.calls.map((c) => c.prompt).sort();
  assert.deepEqual(prompts, ["a", "b", "c"]);
});

test("agent() with pipeline invokes agent per stage per item", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await pipeline(['x','y'],
       item => agent('stage1 ' + item, { label: 's1-' + item }),
       result => agent('stage2 ' + result, { label: 's2-' + result }),
     )
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 4); // 2 items × 2 stages
});

test("agent() monitors agent count and calls onAgentStart/End for each", async () => {
  const rec = new CallRecordingAgent();
  const counts: number[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('a', { label: 'a' })
     await agent('b', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: () => {},
      onAgentEnd: (e) => counts.push(e.tokens ?? 0),
    },
  );
  assert.equal(counts.length, 2);
  assert.ok(counts[0] > 0, "first agent tokens");
  assert.ok(counts[1] > 0, "second agent tokens");
});

// ═══════════════════════════════════════════════════════════════════════════
// forkSessionForSubagent — session-file inheritance without mutating the source
// ═══════════════════════════════════════════════════════════════════════════

test("forkSessionForSubagent inherits the source context and never mutates the source", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-fork-test-"));
  try {
    const sessionDir = join(root, "sessions");
    const source = SessionManager.create(root, sessionDir);
    source.appendMessage({
      role: "user",
      content: [{ type: "text", text: "the secret context is 42" }],
    } as Parameters<SessionManager["appendMessage"]>[0]);
    // The SDK only flushes a session file once an assistant message exists.
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "understood" }],
      stopReason: "stop",
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    const sourcePath = source.getSessionFile();
    assert.ok(sourcePath, "source session should persist to a file");
    const sourceBytes = readFileSync(sourcePath as string, "utf-8");

    const { sessionManager, cleanup } = forkSessionForSubagent(sourcePath as string, root);
    try {
      const context = sessionManager.buildSessionContext();
      const text = JSON.stringify(context.messages);
      assert.ok(text.includes("the secret context is 42"), "fork should carry the source context");

      // Appending to the fork must not touch the source file.
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "subagent-only message" }],
      } as Parameters<SessionManager["appendMessage"]>[0]);
      assert.equal(readFileSync(sourcePath as string, "utf-8"), sourceBytes, "source file must be unchanged");

      const forkPath = sessionManager.getSessionFile();
      assert.ok(forkPath && forkPath !== sourcePath, "fork lives in its own file");
      cleanup();
      assert.equal(existsSync(forkPath as string), false, "cleanup removes the fork");
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forkSessionForSubagent throws a recoverable WorkflowError for a missing file", () => {
  assert.throws(
    () => forkSessionForSubagent("/nonexistent/session.jsonl", "/tmp"),
    (err: unknown) => {
      assert.ok(err instanceof WorkflowError);
      assert.equal(err.recoverable, true);
      assert.match(err.message, /Cannot fork session file/);
      return true;
    },
  );
});

test("resolveSubagentSession defaults to an in-memory temp session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-session-matrix-"));
  try {
    const { sessionManager, cleanup } = await resolveSubagentSession({}, root);
    try {
      assert.equal(sessionManager.isPersisted(), false);
      assert.equal(sessionManager.getSessionFile(), undefined);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSubagentSession creates and continues a persisted sessionPath", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-session-matrix-"));
  try {
    const target = join(root, "persisted.jsonl");
    const first = await resolveSubagentSession({ sessionPath: target }, root);
    try {
      assert.equal(first.sessionManager.isPersisted(), true);
      assert.equal(first.sessionManager.getSessionFile(), target);
      first.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "persist me" }],
      } as Parameters<SessionManager["appendMessage"]>[0]);
      first.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "persisted" }],
        stopReason: "stop",
      } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
      assert.equal(existsSync(target), true);
    } finally {
      first.cleanup();
    }

    const second = await resolveSubagentSession({ sessionPath: target }, root);
    try {
      const text = JSON.stringify(second.sessionManager.buildSessionContext().messages);
      assert.ok(text.includes("persist me"), "existing sessionPath is continued");
    } finally {
      second.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent session writers queue at the session-opening boundary and waiting is abortable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-session-writer-"));
  try {
    const target = join(root, "shared.jsonl");
    const first = await resolveSubagentSession({ sessionPath: target }, root);
    try {
      let secondSettled = false;
      const secondPromise = resolveSubagentSession({ sessionPath: target }, root).finally(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(secondSettled, false, "a same-process contender waits instead of opening or rejecting");

      const controller = new AbortController();
      const aborted = resolveSubagentSession({ sessionPath: target }, root, controller.signal);
      controller.abort();
      await assert.rejects(aborted, (error: unknown) => (error as Error).name === "AbortError");

      first.cleanup();
      const second = await secondPromise;
      second.cleanup();
    } finally {
      first.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable live session-writer lock is never stolen", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-unreadable-writer-"));
  const target = join(root, "shared.jsonl");
  const lockRoot = join(
    tmpdir(),
    `pi-dynamic-workflows-${typeof process.getuid === "function" ? process.getuid() : (process.env.USER ?? "default")}`,
    "session-locks",
  );
  const findOwnedLock = (directory: string): string | undefined => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = findOwnedLock(path);
        if (nested) return nested;
        continue;
      }
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as { sessionPath?: string; pid?: number };
        if (value.sessionPath === resolve(target) && value.pid === process.pid) return path;
      } catch {
        // Other lock users may be publishing or removing unrelated files.
      }
    }
    return undefined;
  };

  const first = await acquireSessionWriterLease(target);
  let ownedLock: string | undefined;
  try {
    ownedLock = findOwnedLock(lockRoot);
    assert.ok(ownedLock, "the acquired lease should publish its ownership");
    writeFileSync(ownedLock, "");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75);
    try {
      await assert.rejects(
        acquireSessionWriterLease(target, controller.signal).then((lease) => lease.release()),
        (error: unknown) => (error as Error).name === "AbortError",
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    first.release();
    if (ownedLock) rmSync(ownedLock, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent session writer exclusion is cross-process", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-cross-process-writer-"));
  const target = join(root, "shared.jsonl");
  const moduleUrl = new URL("../src/agent.ts", import.meta.url).href;
  const runChild = async (script: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const [code] = (await once(child, "close")) as [number];
    assert.equal(code, 0, stderr);
    return stdout.trim();
  };
  const runContender = (abortAfterMs?: number) =>
    runChild(`
      import { resolveSubagentSession } from ${JSON.stringify(moduleUrl)};
      const controller = new AbortController();
      ${abortAfterMs ? `setTimeout(() => controller.abort(), ${abortAfterMs});` : ""}
      try {
        const owned = await resolveSubagentSession(
          { sessionPath: ${JSON.stringify(target)} },
          ${JSON.stringify(root)},
          ${abortAfterMs ? "controller.signal" : "undefined"}
        );
        owned.cleanup();
        console.log("acquired");
      } catch (error) {
        if (error?.name !== "AbortError") throw error;
        console.log("blocked");
      }
    `);
  const runCriticalContender = () =>
    runChild(`
      import { rmSync, writeFileSync } from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      import { resolveSubagentSession } from ${JSON.stringify(moduleUrl)};
      const criticalPath = ${JSON.stringify(join(root, "critical-section"))};
      const owned = await resolveSubagentSession(
        { sessionPath: ${JSON.stringify(target)} },
        ${JSON.stringify(root)}
      );
      let entered = false;
      try {
        writeFileSync(criticalPath, String(process.pid), { flag: "wx" });
        entered = true;
        await delay(100);
        console.log("acquired");
      } finally {
        if (entered) rmSync(criticalPath, { force: true });
        owned.cleanup();
      }
    `);

  let crashedOwner: ReturnType<typeof spawn> | undefined;
  try {
    const first = await resolveSubagentSession({ sessionPath: target }, root);
    try {
      assert.equal(await runContender(100), "blocked", "another process cannot open while the owner is live");
    } finally {
      first.cleanup();
    }
    assert.equal(await runContender(), "acquired", "a queued process can open after release");

    crashedOwner = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import { resolveSubagentSession } from ${JSON.stringify(moduleUrl)};
          await resolveSubagentSession({ sessionPath: ${JSON.stringify(target)} }, ${JSON.stringify(root)});
          console.log("owned");
          setInterval(() => {}, 1_000);
        `,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let crashedStderr = "";
    crashedOwner.stderr.on("data", (chunk) => (crashedStderr += String(chunk)));
    await new Promise<void>((resolveOwned, rejectOwned) => {
      const timer = setTimeout(() => rejectOwned(new Error(`owner did not acquire lease: ${crashedStderr}`)), 2_000);
      crashedOwner.stdout.on("data", (chunk) => {
        if (!String(chunk).includes("owned")) return;
        clearTimeout(timer);
        resolveOwned();
      });
      crashedOwner.once("error", rejectOwned);
    });
    crashedOwner.kill("SIGKILL");
    await once(crashedOwner, "close");

    assert.deepEqual(
      (await Promise.all([runCriticalContender(), runCriticalContender()])).sort(),
      ["acquired", "acquired"],
      "contenders recover a dead owner without overlapping",
    );
  } finally {
    if (crashedOwner?.exitCode === null && crashedOwner.signalCode === null) {
      crashedOwner.kill("SIGKILL");
      await once(crashedOwner, "close").catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSubagentSession can fork into a new persistent sessionPath", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-session-matrix-"));
  try {
    const sourceDir = join(root, "source");
    const source = SessionManager.create(root, sourceDir);
    source.appendMessage({
      role: "user",
      content: [{ type: "text", text: "forked context" }],
    } as Parameters<SessionManager["appendMessage"]>[0]);
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      stopReason: "stop",
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    const sourcePath = source.getSessionFile();
    assert.ok(sourcePath);
    const sourceBytes = readFileSync(sourcePath as string, "utf-8");

    const target = join(root, "child.jsonl");
    const fork = await resolveSubagentSession({ forkFrom: sourcePath as string, sessionPath: target }, root);
    try {
      assert.equal(fork.sessionManager.getSessionFile(), target);
      assert.equal(existsSync(target), true, "fork is persisted at the requested path immediately");
      const text = JSON.stringify(fork.sessionManager.buildSessionContext().messages);
      assert.ok(text.includes("forked context"));
      assert.equal(readFileSync(sourcePath as string, "utf-8"), sourceBytes, "source session is not mutated");
    } finally {
      fork.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSubagentSession rejects forkFrom + existing sessionPath", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-session-matrix-"));
  try {
    const sourceDir = join(root, "source");
    const source = SessionManager.create(root, sourceDir);
    source.appendMessage({
      role: "user",
      content: [{ type: "text", text: "source" }],
    } as Parameters<SessionManager["appendMessage"]>[0]);
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      stopReason: "stop",
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    const sourcePath = source.getSessionFile();
    assert.ok(sourcePath);

    const target = join(root, "existing.jsonl");
    const existing = await resolveSubagentSession({ sessionPath: target }, root);
    existing.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "existing" }],
    } as Parameters<SessionManager["appendMessage"]>[0]);
    existing.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ready" }],
      stopReason: "stop",
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    existing.cleanup();

    await assert.rejects(
      resolveSubagentSession({ forkFrom: sourcePath as string, sessionPath: target }, root),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowError);
        assert.equal(err.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.equal(err.recoverable, false);
        assert.match(err.message, /already exists/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
