/**
 * Real-session integration tests for WorkflowAgent.run.
 *
 * Most tests inject a fake agent runner; these drive the REAL
 * `WorkflowAgent.run` → `createAgentSession` path and use the pi SDK's built-in
 * FAUX provider, so no network call is made and NO provider quota is consumed.
 * The usage-limit cases guard the load-bearing SDK assumption behind issue #26:
 * quota exhaustion surfaces as an error-status assistant message, not a thrown error.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, defineTool, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentUsage, WorkflowAgent } from "../src/agent.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";

/**
 * Load the faux provider from the SAME pi-ai instance that pi-coding-agent's
 * createAgentSession dispatches through. pi-coding-agent ships its own nested
 * pi-ai copy; registering on a different instance would be invisible to the
 * session ("No API provider registered"). Prefer the nested copy when present,
 * else fall back to the bare specifier — which, when npm has deduped to a single
 * copy, resolves to that same shared instance. Robust to both layouts.
 */
async function loadFaux(): Promise<typeof import("@earendil-works/pi-ai")> {
  const nested = fileURLToPath(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
      import.meta.url,
    ),
  );
  const entry = existsSync(nested) ? nested : "@earendil-works/pi-ai";
  return import(entry) as Promise<typeof import("@earendil-works/pi-ai")>;
}

/**
 * Run `fn` with isolated Pi settings and a dummy provider key so
 * hasConfiguredAuth() passes via env — no real credentials are touched, and the
 * faux api means the key is never actually used. A faux "deepseek" provider is
 * registered/torn down around `fn`; `setResponses` queues the scripted turns.
 */
async function withFauxSession(
  fn: (ctx: {
    cwd: string;
    model: unknown;
    fallbackModel: unknown;
    setResponses: (msgs: unknown[]) => void;
    anthropicCallCount: () => number;
    fauxAssistantMessage: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
    fauxToolCall: typeof import("@earendil-works/pi-ai").fauxToolCall;
  }) => Promise<void>,
): Promise<void> {
  const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = await loadFaux();
  const home = mkdtempSync(join(tmpdir(), "pi-dw-i26-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-i26-cwd-"));
  const prevKey = process.env.DEEPSEEK_API_KEY;
  const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const prevAnthropicToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.DEEPSEEK_API_KEY = "faux-dummy-key-not-used";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  // An explicit host PI_CODING_AGENT_DIR overrides HOME. Isolate it too so a
  // user's compaction settings cannot consume faux responses between test turns.
  const agentDir = join(home, ".pi", "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const anthropicFaux = registerFauxProvider({
    provider: "anthropic",
    models: [{ id: "faux-anthropic", name: "Faux Anthropic", contextWindow: 128000, maxTokens: 4096 }],
  });
  const faux = registerFauxProvider({
    provider: "deepseek",
    models: [
      { id: "faux-deepseek", name: "Faux DeepSeek", contextWindow: 128000, maxTokens: 4096 },
      { id: "faux-deepseek-fallback", name: "Faux DeepSeek Fallback", contextWindow: 128000, maxTokens: 4096 },
    ],
  });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        anthropic: { models: anthropicFaux.models },
        deepseek: { models: faux.models },
      },
    }),
  );
  try {
    await withFakeHomeAsync(home, () =>
      fn({
        cwd,
        model: faux.getModel("faux-deepseek"),
        fallbackModel: faux.getModel("faux-deepseek-fallback"),
        setResponses: (msgs) => faux.setResponses(msgs as never),
        anthropicCallCount: () => anthropicFaux.state.callCount,
        fauxAssistantMessage,
        fauxToolCall,
      }),
    );
  } finally {
    faux.unregister();
    anthropicFaux.unregister();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevKey;
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
    if (prevAnthropicToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
    else process.env.ANTHROPIC_OAUTH_TOKEN = prevAnthropicToken;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("a real subagent session that hits a usage limit surfaces PROVIDER_USAGE_LIMIT (not SCHEMA_NONCOMPLIANCE/EMPTY)", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });
    await assert.rejects(
      () => agent.run("do the task", { label: "probe" }),
      (err: unknown) => {
        const e = err as { code?: string; recoverable?: boolean; message?: string; resetHint?: string };
        assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, `got ${e.code}`);
        assert.equal(e.recoverable, false, "must halt so the run can checkpoint, not retry-into-the-wall");
        assert.ok(e.message?.includes("usage limit reached"), "carries the real provider message");
        assert.equal(e.resetHint, "Resets in ~3h", "extracts the provider reset hint");
        return true;
      },
    );
  }));

test("an unauthenticated primary model starts directly on fallbackModel", () =>
  withFauxSession(async ({ cwd, setResponses, anthropicCallCount, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("fallback ready", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd });
    const handoffs: Array<{ requested: string; fallback?: string; reason?: string }> = [];
    const result = await agent.run("do the task", {
      label: "auth-fallback-probe",
      model: "anthropic/faux-anthropic",
      fallbackModel: "deepseek/faux-deepseek-fallback",
      onModelFallback: (requested, fallback, reason) => handoffs.push({ requested, fallback, reason }),
    });

    assert.equal(result, "fallback ready");
    assert.equal(anthropicCallCount(), 0, "the unauthenticated primary must not receive a request");
    assert.deepEqual(handoffs, [
      {
        requested: "anthropic/faux-anthropic",
        fallback: "deepseek/faux-deepseek-fallback",
        reason: "primary model is unavailable or unauthenticated",
      },
    ]);
  }));

test("a provider usage limit continues the same structured-output session on fallbackModel", () =>
  withFauxSession(async ({ cwd, setResponses, fauxAssistantMessage, fauxToolCall }) => {
    const fallbackRequests: Array<{ model: string; messages: number }> = [];
    setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG }),
      (context: unknown, _options: unknown, _state: unknown, requestModel: { id: string }) => {
        fallbackRequests.push({
          model: requestModel.id,
          messages: (context as { messages?: unknown[] }).messages?.length ?? 0,
        });
        return fauxAssistantMessage(fauxToolCall("structured_output", { ok: true }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);
    const agent = new WorkflowAgent({ cwd });
    const handoffs: Array<{ requested: string; fallback?: string; reason?: string }> = [];
    const result = await agent.run("do the task", {
      label: "fallback-probe",
      model: "deepseek/faux-deepseek",
      fallbackModel: "deepseek/faux-deepseek-fallback",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
      onModelFallback: (requested, fallback, reason) => handoffs.push({ requested, fallback, reason }),
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(fallbackRequests[0]?.model, "faux-deepseek-fallback");
    assert.ok(fallbackRequests[0]?.messages >= 2, "the fallback request should retain the original transcript");
    assert.deepEqual(handoffs, [
      {
        requested: "deepseek/faux-deepseek",
        fallback: "deepseek/faux-deepseek-fallback",
        reason: "primary provider usage limit",
      },
    ]);
  }));

test("a successful real turn whose text merely mentions 'rate limit' is NOT misclassified", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("Done. I handled the rate limit gracefully.", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });
    const text = await agent.run("do the task", { label: "ok" });
    assert.ok(typeof text === "string" && text.includes("Done."), `expected normal text, got ${String(text)}`);
  }));

test("onUsage alone receives one nonzero final snapshot from a real subagent session", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const snapshots: AgentUsage[] = [];
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });

    const text = await agent.run("do the task", {
      label: "final-usage-only",
      onUsage: (usage) => snapshots.push(usage),
    });

    assert.equal(text, "done");
    assert.equal(snapshots.length, 1);
    const usage = snapshots[0];
    assert.ok(usage.total > 0);
    assert.deepEqual(usage, {
      input: usage.input,
      output: 1,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usage.input + 1 + usage.cacheRead + usage.cacheWrite,
      cost: 0,
    });
  }));

test("a read-only real subagent excludes write-capable tools and preserves read-only tools", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    let activeTools: string[] = [];
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            for (const name of [
              "grep",
              "find",
              "ls",
              "ffgrep",
              "fffind",
              "ast_grep_search",
              "web_search",
              "ast_grep_replace",
              "structured_return",
              "workflow",
            ]) {
              pi.registerTool(
                defineTool({
                  name,
                  description: `${name} test tool`,
                  parameters: Type.Object({}),
                  async execute() {
                    return { content: [{ type: "text", text: "ok" }] };
                  },
                }),
              );
            }
            activeTools = pi.getActiveTools();
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never, resourceLoader } });
    await agent.run("review the code", { label: "read-only", readOnly: true });

    assert.ok(activeTools.includes("read"), `expected read to remain active, got ${activeTools.join(", ")}`);
    for (const name of ["grep", "find", "ls", "ffgrep", "fffind", "ast_grep_search", "web_search"]) {
      assert.ok(activeTools.includes(name), `expected ${name} to remain active, got ${activeTools.join(", ")}`);
    }
    const sandboxedBashAvailable = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
    assert.equal(
      activeTools.includes("bash"),
      sandboxedBashAvailable,
      `expected bash availability to match the read-only sandbox, got ${activeTools.join(", ")}`,
    );
    for (const name of ["edit", "write", "ast_grep_replace", "structured_return", "workflow"]) {
      assert.ok(!activeTools.includes(name), `expected ${name} to be excluded, got ${activeTools.join(", ")}`);
    }
  }));

test("live usage removes an assistant response discarded by SDK auto-retry", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    const agentDir = getAgentDir();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }),
    );
    setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 server error" }),
      fauxAssistantMessage("done", { stopReason: "stop" }),
    ]);

    const snapshots: AgentUsage[] = [];
    const finalUsage: AgentUsage[] = [];
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });
    const text = await agent.run("do the task", {
      label: "auto-retry",
      onUsageUpdate: (usage) => snapshots.push(usage),
      onUsage: (usage) => finalUsage.push(usage),
    });

    assert.equal(text, "done");
    assert.ok((snapshots[0]?.total ?? 0) > 0, "the failed response is visible before SDK retry");
    const resetIndex = snapshots.findIndex((usage) => usage.total === 0);
    assert.ok(resetIndex > 0, "SDK retry removes the discarded response");
    assert.deepEqual(
      snapshots[snapshots.length - 1],
      snapshots[resetIndex + 1],
      "final usage contains only the replacement response",
    );
    assert.deepEqual(finalUsage, [snapshots[snapshots.length - 1]], "legacy onUsage remains one-shot");
  }));

test("a real subagent session binds extensions so session_start-registered tools become active", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    let sessionStartRan = false;
    let activeAfterRegistration: string[] = [];
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            sessionStartRan = true;
            pi.registerTool(
              defineTool({
                name: "late_session_tool",
                description: "Tool registered from session_start",
                parameters: Type.Object({}),
                async execute() {
                  return { content: [{ type: "text", text: "late tool result" }] };
                },
              }),
            );
            activeAfterRegistration = pi.getActiveTools();
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never, resourceLoader } });
    const text = await agent.run("do the task", { label: "extension-bind" });

    assert.equal(text, "ok");
    assert.equal(sessionStartRan, true, "subagents must emit session_start by binding extensions");
    assert.ok(
      activeAfterRegistration.includes("late_session_tool"),
      `expected late_session_tool to be active, got ${activeAfterRegistration.join(", ")}`,
    );
  }));

test("a real subagent waits for deferred extension continuation before returning and disposing", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    let continuationScheduled = false;
    let agentEndCount = 0;
    const continuationErrors: string[] = [];
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          pi.on("agent_end", () => {
            agentEndCount++;
            if (continuationScheduled) return;
            continuationScheduled = true;
            setTimeout(() => {
              try {
                pi.sendUserMessage("continue");
              } catch (error) {
                continuationErrors.push(error instanceof Error ? error.message : String(error));
              }
            }, 0);
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([
      fauxAssistantMessage("first response", { stopReason: "stop" }),
      fauxAssistantMessage("continued response", { stopReason: "stop" }),
    ]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never, resourceLoader } });
    const text = await agent.run("do the task", { label: "deferred-continuation" });

    assert.equal(text, "continued response");
    assert.equal(continuationScheduled, true, "agent_end extension should schedule a deferred continuation");
    assert.equal(agentEndCount, 2, "deferred continuation should run as a second turn before return");
    assert.deepEqual(continuationErrors, []);
  }));

test("through the manager: a usage limit pauses the run (not fails) and resume replays the journal", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    const managerAgent = new WorkflowAgent({ cwd, session: { model: model as never } });
    const manager = new WorkflowManager({ cwd, agent: managerAgent });
    const pausedReasons: Array<string | undefined> = [];
    manager.on("paused", (e: { reason?: string }) => pausedReasons.push(e.reason));
    manager.on("error", () => {});

    const twoAgentScript = `export const meta = { name: 'i26_integration', description: 'two agents' }
const a = await agent('first step', { label: 'first' })
const b = await agent('second step', { label: 'second' })
return { a, b }`;

    // Agent 1 succeeds (journaled); agent 2 hits the usage limit.
    setResponses([
      fauxAssistantMessage("first-result-text", { stopReason: "stop" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG }),
    ]);
    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise.catch(() => {});

    assert.equal(manager.getRun(runId)?.status, "paused", "run is checkpointed as paused, not failed");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.pauseReason, "usage_limit");
    assert.equal(persisted?.resetHint, "Resets in ~3h");
    assert.ok((persisted?.journal?.length ?? 0) >= 1, "agent 1's result is journaled");
    assert.ok(pausedReasons.includes("usage_limit"), "a usage_limit 'paused' event fired");

    // Budget refills: agent 2 now succeeds. Resume replays agent 1 from the journal.
    setResponses([fauxAssistantMessage("second-result-text", { stopReason: "stop" })]);
    assert.equal(await manager.resume(runId), true, "the paused run is resumable");
    const deadline = Date.now() + 1000;
    let done = manager.getRun(runId);
    while (done?.status !== "completed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      done = manager.getRun(runId);
    }

    assert.equal(done?.status, "completed", "resumed run completes once the limit clears");
    assert.equal((done?.result?.result as { a?: string })?.a, "first-result-text", "agent 1 replayed from journal");
    assert.equal((done?.result?.result as { b?: string })?.b, "second-result-text", "agent 2 ran live after refill");
  }));
