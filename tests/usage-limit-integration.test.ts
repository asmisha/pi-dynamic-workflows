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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentUsage, WorkflowAgent } from "../src/agent.js";
import type { AgentRegistry } from "../src/agent-registry.js";
import { WorkflowErrorCode } from "../src/errors.js";
import { subagentResourceLoader } from "../src/subagent-resource-loader.js";
import { runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowSessionsDir } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { loadFaux } from "./helpers/load-faux.js";

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";

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
    modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
    anthropicCallCount: () => number;
    deepseekCallCount: () => number;
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
      { id: "faux-deepseek", name: "Faux DeepSeek", contextWindow: 128000, maxTokens: 4096, reasoning: true },
      {
        id: "faux-deepseek-fallback",
        name: "Faux DeepSeek Fallback",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: true,
      },
      {
        id: "faux-deepseek-last",
        name: "Faux Last Backup",
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: true,
      },
    ],
  });
  for (const model of faux.models) model.thinkingLevelMap = { xhigh: "xhigh" };
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
  // Production always injects the host's composed registry (ExtensionContext
  // carries one and session_start hands it to the manager), so build the
  // equivalent here from the isolated agent dir instead of leaving the agent
  // with no catalog at all.
  const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const modelRegistry = new ModelRegistry(
    await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    }),
  );
  try {
    await withFakeHomeAsync(home, () =>
      fn({
        cwd,
        modelRegistry,
        model: faux.getModel("faux-deepseek"),
        fallbackModel: faux.getModel("faux-deepseek-fallback"),
        setResponses: (msgs) => faux.setResponses(msgs as never),
        anthropicCallCount: () => anthropicFaux.state.callCount,
        deepseekCallCount: () => faux.state.callCount,
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

test("command conversation forks and continuations use the real persistent createAgentSession path", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    const parent = SessionManager.create(cwd, join(cwd, "parent-session"));
    parent.appendMessage({
      role: "user",
      content: [{ type: "text", text: "inherited parent request" }],
    } as Parameters<SessionManager["appendMessage"]>[0]);
    parent.appendMessage(
      fauxAssistantMessage("inherited parent answer", { stopReason: "stop" }) as Parameters<
        SessionManager["appendMessage"]
      >[0],
    );
    const parentPath = parent.getSessionFile();
    assert.ok(parentPath);
    const parentBefore = readFileSync(parentPath, "utf8");
    const currentModel = model as { provider: string; id: string };

    const manager = new WorkflowManager({
      cwd,
      sessionId: parent.getSessionId(),
      modelRegistry,
      mainModel: "anthropic/faux-anthropic",
    });
    setResponses([fauxAssistantMessage("first persistent answer", { stopReason: "stop" })]);
    const fork = await manager.startConversationFork({
      task: "perform the first explicit task",
      parentSession: parent,
      model: { provider: currentModel.provider, id: currentModel.id },
      thinkingLevel: "high",
    });
    const firstResult = await fork.promise;
    assert.equal(firstResult.result, "first persistent answer");
    assert.equal(readFileSync(parentPath, "utf8"), parentBefore);

    setResponses([fauxAssistantMessage("continued persistent answer", { stopReason: "stop" })]);
    const continuation = manager.continueConversationFork({
      sourceRunId: fork.runId,
      instruction: "perform the follow-up task",
      parentSession: parent,
    });
    const secondResult = await continuation.promise;
    assert.equal(secondResult.result, "continued persistent answer");
    assert.notEqual(continuation.runId, fork.runId);
    assert.equal(continuation.sessionPath, fork.sessionPath);

    const child = SessionManager.open(fork.sessionPath, undefined, cwd);
    const transcript = JSON.stringify(child.buildSessionContext().messages);
    assert.match(transcript, /inherited parent request/);
    assert.match(transcript, /perform the first explicit task/);
    assert.match(transcript, /first persistent answer/);
    assert.match(transcript, /perform the follow-up task/);
    assert.match(transcript, /continued persistent answer/);
    assert.equal(child.buildSessionContext().model?.provider, currentModel.provider);
    assert.equal(child.buildSessionContext().thinkingLevel, "high");
  }));

test("an empty-parent command fork uses the parent model and thinking settings", () =>
  withFauxSession(
    async ({
      cwd,
      modelRegistry,
      model,
      setResponses,
      anthropicCallCount,
      deepseekCallCount,
      fauxAssistantMessage,
    }) => {
      const parent = SessionManager.create(cwd, join(cwd, "empty-parent-session"));
      const currentModel = model as { provider: string; id: string };
      const manager = new WorkflowManager({ cwd, sessionId: parent.getSessionId(), modelRegistry });
      setResponses([fauxAssistantMessage("empty-parent fork answer", { stopReason: "stop" })]);

      const fork = await manager.startConversationFork({
        task: "run from an empty parent branch",
        parentSession: parent,
        model: { provider: currentModel.provider, id: currentModel.id },
        thinkingLevel: "high",
      });
      await fork.promise;

      assert.equal(deepseekCallCount(), 1, "the command-time parent model executes the initial child turn");
      assert.equal(anthropicCallCount(), 0, "global provider ordering must not replace the parent model");
      const child = SessionManager.open(fork.sessionPath, undefined, cwd).buildSessionContext();
      assert.equal(child.model?.provider, currentModel.provider);
      assert.equal(child.thinkingLevel, "high");
    },
  ));

test("stop then continue queues at the child session until the first AgentSession finishes cleanup", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, deepseekCallCount, fauxAssistantMessage }) => {
    let announceShutdown!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => {
      announceShutdown = resolve;
    });
    let allowShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => {
      allowShutdown = resolve;
    });
    let shutdownCount = 0;
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          pi.on("session_shutdown", async () => {
            shutdownCount++;
            if (shutdownCount !== 1) return;
            announceShutdown();
            await shutdownGate;
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([
      fauxAssistantMessage("first child answer", { stopReason: "stop" }),
      fauxAssistantMessage("continued child answer", { stopReason: "stop" }),
    ]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { resourceLoader } });
    const parent = SessionManager.create(cwd, join(cwd, "writer-window-parent"));
    parent.appendMessage({
      role: "user",
      content: [{ type: "text", text: "parent context" }],
    } as Parameters<SessionManager["appendMessage"]>[0]);
    const currentModel = model as { provider: string; id: string };
    const manager = new WorkflowManager({ cwd, sessionId: parent.getSessionId(), modelRegistry, agent });
    const first = await manager.startConversationFork({
      task: "first task",
      parentSession: parent,
      model: { provider: currentModel.provider, id: currentModel.id },
      thinkingLevel: "high",
    });

    await shutdownStarted;
    assert.equal(deepseekCallCount(), 1);
    assert.equal(manager.stop(first.runId), true);
    const continuation = manager.continueConversationFork({
      sourceRunId: first.runId,
      instruction: "continue immediately after stop",
      parentSession: parent,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      deepseekCallCount(),
      1,
      "the continuation cannot reach its provider while the earlier AgentSession can still append during shutdown",
    );

    allowShutdown();
    await first.promise.catch(() => undefined);
    const result = await continuation.promise;
    assert.equal(result.result, "continued child answer");
    assert.equal(deepseekCallCount(), 2);
    assert.equal(shutdownCount, 2);
    const transcript = JSON.stringify(
      SessionManager.open(first.sessionPath, undefined, cwd).buildSessionContext().messages,
    );
    assert.match(transcript, /first child answer/);
    assert.match(transcript, /continued child answer/);
  }));

test("a real subagent session that hits a usage limit surfaces PROVIDER_USAGE_LIMIT (not SCHEMA_NONCOMPLIANCE/EMPTY)", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });
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
  withFauxSession(async ({ cwd, modelRegistry, setResponses, anthropicCallCount, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("fallback ready", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry });
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
  withFauxSession(async ({ cwd, modelRegistry, setResponses, fauxAssistantMessage, fauxToolCall }) => {
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
    const agent = new WorkflowAgent({ cwd, modelRegistry });
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
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("Done. I handled the rate limit gracefully.", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });
    const text = await agent.run("do the task", { label: "ok" });
    assert.ok(typeof text === "string" && text.includes("Done."), `expected normal text, got ${String(text)}`);
  }));

test("onUsage alone receives one nonzero final snapshot from a real subagent session", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const snapshots: AgentUsage[] = [];
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });

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

test("a resolved named read-only policy is final across built-in and extension tools", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, fauxToolCall }) => {
    let activeTools: string[] = [];
    let executeCalls = 0;
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          for (const name of [
            "grep",
            "web_search",
            "unlisted_extension",
            "ast_grep_replace",
            "workflow",
            "workflow_status",
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
          pi.registerTool(
            defineTool({
              name: "execute",
              description: "execute test tool",
              parameters: Type.Object({}),
              async execute() {
                executeCalls++;
                return { content: [{ type: "text", text: "executed" }] };
              },
            }),
          );
          pi.on("session_start", () => {
            activeTools = pi.getActiveTools();
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([
      fauxAssistantMessage(fauxToolCall("execute", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("structured_output", { ok: true }), { stopReason: "toolUse" }),
    ]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    const agentRegistry: AgentRegistry = new Map([
      [
        "market",
        {
          name: "market",
          tools: ["read", "web_search", "execute"],
          prompt: "Research the market without changing the repository.",
          source: "project",
        },
      ],
    ]);

    const result = await runWorkflow(
      `export const meta = { name: 'named_read_only', description: 'named read-only policy' }
return await agent('research', {
  label: 'market',
  agentType: 'market',
  readOnly: true,
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
})`,
      { agent, agentRegistry, persistLogs: false },
    );

    assert.deepEqual(result.result, { ok: true });
    assert.equal(executeCalls, 1, "the named execute tool should be callable");
    assert.deepEqual(
      new Set(activeTools),
      new Set(["read", "web_search", "execute", "structured_output"]),
      `expected the named policy plus schema output to be final, got ${activeTools.join(", ")}`,
    );
  }));

test("a named read-only denylist and hard denials cannot re-enable mutating or workflow tools", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    let activeTools: string[] = [];
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          for (const name of ["execute", "ast_grep_replace", "workflow"]) {
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
          pi.on("session_start", () => {
            activeTools = pi.getActiveTools();
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    const agentRegistry: AgentRegistry = new Map([
      [
        "locked",
        {
          name: "locked",
          tools: ["read", "execute", "edit", "write", "ast_grep_replace", "workflow"],
          disallowedTools: ["execute"],
          prompt: "Inspect without changing the repository.",
          source: "project",
        },
      ],
    ]);

    const result = await runWorkflow(
      `export const meta = { name: 'locked_read_only', description: 'read-only hard denials' }
return await agent('inspect', { label: 'locked', agentType: 'locked', readOnly: true })`,
      { agent, agentRegistry, persistLogs: false },
    );

    assert.equal(result.result, "done");
    assert.deepEqual(activeTools, ["read"], `expected only the non-denied read tool, got ${activeTools.join(", ")}`);
  }));

test("a named read-only denylist applies without an allowlist", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    let activeTools: string[] = [];
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          for (const name of ["grep", "web_search"]) {
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
          pi.on("session_start", () => {
            activeTools = pi.getActiveTools();
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    const agentRegistry: AgentRegistry = new Map([
      [
        "deny-only",
        {
          name: "deny-only",
          disallowedTools: ["web_search"],
          prompt: "Inspect without web search.",
          source: "project",
        },
      ],
    ]);

    const result = await runWorkflow(
      `export const meta = { name: 'deny_only_read_only', description: 'read-only deny-only policy' }
return await agent('inspect', { label: 'deny-only', agentType: 'deny-only', readOnly: true })`,
      { agent, agentRegistry, persistLogs: false },
    );

    assert.equal(result.result, "done");
    const expectedTools = ["read", "grep", "find", "ls"];
    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) expectedTools.push("bash");
    assert.deepEqual(
      new Set(activeTools),
      new Set(expectedTools),
      `expected the deny-only policy to remove web_search, got ${activeTools.join(", ")}`,
    );
  }));

test("a read-only real subagent excludes write-capable tools and preserves read-only tools", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
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
              "execute",
              "unlisted_extension",
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
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    await agent.run("review the code", { label: "read-only", readOnly: true });

    const expectedTools = ["read", "grep", "find", "ls", "ffgrep", "fffind", "ast_grep_search", "web_search"];
    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) expectedTools.push("bash");
    assert.deepEqual(
      new Set(activeTools),
      new Set(expectedTools),
      `expected the ordinary fixed read-only tool set, got ${activeTools.join(", ")}`,
    );
  }));

test("workflow orchestration tools are excluded from every subagent session", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
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
              "workflow",
              "workflow_status",
              "workflow_resume",
              "workflow_pause",
              "workflow_stop",
              "workflow_retry",
              "structured_return",
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
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    await agent.run("implement the change", { label: "writer" });

    for (const name of ["read", "edit", "write", "bash", "structured_return"]) {
      assert.ok(activeTools.includes(name), `expected ${name} to remain active, got ${activeTools.join(", ")}`);
    }
    for (const name of [
      "workflow",
      "workflow_status",
      "workflow_resume",
      "workflow_pause",
      "workflow_stop",
      "workflow_retry",
    ]) {
      assert.ok(!activeTools.includes(name), `expected ${name} to be excluded, got ${activeTools.join(", ")}`);
    }
  }));

test("allowSubagents restores the workflow orchestration tools for that call", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    let activeTools: string[] = [];
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            for (const name of ["workflow", "workflow_status", "workflow_resume"]) {
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
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    await agent.run("run the code review workflow", { label: "reviewer", allowSubagents: true });

    for (const name of ["workflow", "workflow_status", "workflow_resume"]) {
      assert.ok(activeTools.includes(name), `expected ${name} to be active, got ${activeTools.join(", ")}`);
    }
  }));

test("live usage removes an assistant response discarded by SDK auto-retry", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
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
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });
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

test("a real subagent provider turn receives the configured system prompt", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    const marker = "WORKFLOW_SUBAGENT_SYSTEM_PROMPT_MARKER";
    const agentDir = getAgentDir();
    writeFileSync(join(agentDir, "SYSTEM.md"), marker);
    let effectiveSystemPrompt = "";
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", (event) => {
            effectiveSystemPrompt = event.systemPrompt;
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    await agent.run("do the task", { label: "system-prompt" });

    assert.match(
      effectiveSystemPrompt,
      new RegExp(marker),
      "the provider-facing system prompt must include the subagent's configured SYSTEM.md",
    );
  }));

for (const suppliedLoader of [false, true]) {
  test(`subagents exclude OM without changing parent resources (supplied loader: ${suppliedLoader})`, () =>
    withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
      const agentDir = getAgentDir();
      const extensionDir = join(agentDir, "extensions");
      mkdirSync(extensionDir);
      // Use arbitrary filenames: OM's public commands, not its install path,
      // identify the extension. Hooks stand in for its paid background work.
      writeFileSync(
        join(extensionDir, "memory.js"),
        `export default function(pi) {
          pi.registerCommand("om:status", { handler: async () => {} });
          pi.registerCommand("om:view", { handler: async () => {} });
          pi.on("agent_start", () => pi.appendEntry("fixture-om-work", {}));
          pi.on("session_before_compact", () => ({ cancel: true }));
        }`,
      );
      writeFileSync(
        join(extensionDir, "other.js"),
        `export default function(pi) {
          pi.on("session_start", () => pi.appendEntry("fixture-other-start", {}));
          pi.on("session_shutdown", () => pi.appendEntry("fixture-other-shutdown", {}));
        }`,
      );
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir });
      await resourceLoader.reload();
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        session: { model: model as never, ...(suppliedLoader ? { resourceLoader } : {}) },
      });
      const childPath = join(cwd, "child.jsonl");
      const forkPath = join(cwd, "fork.jsonl");
      for (const options of [
        { sessionPath: childPath },
        { sessionPath: childPath },
        { sessionPath: forkPath, forkFrom: childPath },
      ]) {
        // Pi invalidates extension runtimes on disposal; a caller reusing a
        // supplied loader must reload it before creating another session.
        if (suppliedLoader) await resourceLoader.reload();
        const originalExtensions = [...resourceLoader.getExtensions().extensions];
        setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
        assert.equal(await agent.run("do the task", options), "ok");
        assert.deepEqual(
          resourceLoader.getExtensions().extensions,
          originalExtensions,
          "the caller's extension list must not be filtered in place",
        );
        const entries = SessionManager.open(options.sessionPath, undefined, cwd).getEntries();
        const customTypes = entries.filter((entry) => entry.type === "custom").map((entry) => entry.customType);
        assert.ok(!customTypes.includes("fixture-om-work"), "OM must not run on fresh, continued, or forked children");
        assert.ok(customTypes.includes("fixture-other-start"), "other extension startup must still run");
        assert.ok(customTypes.includes("fixture-other-shutdown"), "other extension cleanup must still run");
      }

      // The same supplied loader still enables OM for a normal parent session.
      // This also demonstrates that global extension configuration is untouched.
      await resourceLoader.reload();
      const parent = await createAgentSession({ cwd, agentDir, model: model as never, resourceLoader });
      try {
        await parent.session.bindExtensions({});
        setResponses([fauxAssistantMessage("parent ok", { stopReason: "stop" })]);
        await parent.session.prompt("parent task");
        assert.ok(
          parent.session.sessionManager
            .getEntries()
            .some((entry) => entry.type === "custom" && entry.customType === "fixture-om-work"),
          "a normal parent must retain OM even after workflow use of its loader",
        );
      } finally {
        await parent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        parent.session.dispose();
      }
    }));
}

test("excluding OM leaves native compaction and other compaction hooks working", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 100 } });
    let otherCompactionHookRan = false;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.registerCommand("om:status", { handler: async () => {} });
          pi.registerCommand("om:view", { handler: async () => {} });
          pi.on("session_before_compact", () => ({ cancel: true }));
        },
        (pi) => {
          pi.on("session_before_compact", () => {
            otherCompactionHookRan = true;
          });
        },
      ],
    });
    await loader.reload();
    const sessionManager = SessionManager.create(cwd, join(cwd, "native-compaction"));
    for (let i = 0; i < 3; i++) {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "earlier task context ".repeat(100) }],
        timestamp: Date.now(),
      });
      sessionManager.appendMessage(fauxAssistantMessage("earlier answer ".repeat(100)));
    }
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: model as never,
      settingsManager,
      sessionManager,
      resourceLoader: subagentResourceLoader(loader),
    });
    try {
      await session.bindExtensions({});
      setResponses([
        fauxAssistantMessage("native summary", { stopReason: "stop" }),
        fauxAssistantMessage("retained turn summary", { stopReason: "stop" }),
      ]);
      const result = await session.compact();
      assert.ok(result.summary.includes("native summary"));
      assert.equal(otherCompactionHookRan, true);
      const compaction = sessionManager.getEntries().find((entry) => entry.type === "compaction");
      assert.ok(compaction, "the native compaction must be persisted");
      assert.equal(compaction.fromHook, false, "the summary must come from Pi, not the excluded OM hook");
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  }));

test("the workflow subagent flag is session-local and available before extension hooks", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    const observations: Array<boolean | string | undefined> = [];
    const agentDir = getAgentDir();
    const sessionOptions = async () => {
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
        extensionFactories: [
          (pi) => {
            pi.registerFlag("pi-dynamic-workflows-subagent", { type: "boolean", default: false });
            pi.on("session_start", () => {
              observations.push(pi.getFlag("pi-dynamic-workflows-subagent"));
            });
            pi.on("input", () => {
              observations.push(pi.getFlag("pi-dynamic-workflows-subagent"));
              return { action: "continue" };
            });
          },
        ],
      });
      await resourceLoader.reload();
      return { model: model as never, resourceLoader };
    };

    // Include an absolute path outside workflow storage and its continuation:
    // the context must not depend on where a transcript is stored.
    const customPath = join(cwd, "custom-session.jsonl");
    for (const options of [
      { readOnly: true },
      { sessionPath: customPath, allowSubagents: true },
      { sessionPath: customPath },
      { forkFrom: customPath },
    ]) {
      const agent = new WorkflowAgent({ cwd, modelRegistry, session: await sessionOptions() });
      setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
      assert.equal(await agent.run("do the task", options), "ok");
    }
    assert.deepEqual(observations, [true, true, true, true, true, true, true, true]);
    observations.length = 0;

    const { session } = await createAgentSession({ cwd, ...(await sessionOptions()) });
    try {
      await session.bindExtensions({});
      setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
      await session.prompt("normal headless session");
      assert.deepEqual(observations, [false, false], "a normal session in the same process is not a subagent");
    } finally {
      session.dispose();
    }
  }));

test("a real subagent completes the extension lifecycle it starts", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    let sessionStartRan = false;
    let sessionShutdownRan = false;
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
          pi.on("session_shutdown", async () => {
            // Prove WorkflowAgent awaits async native-resource cleanup instead
            // of disposing the extension runner immediately after emission.
            await new Promise((resolve) => setTimeout(resolve, 10));
            sessionShutdownRan = true;
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    const text = await agent.run("do the task", { label: "extension-bind" });

    assert.equal(text, "ok");
    assert.equal(sessionStartRan, true, "subagents must emit session_start by binding extensions");
    assert.ok(
      activeAfterRegistration.includes("late_session_tool"),
      `expected late_session_tool to be active, got ${activeAfterRegistration.join(", ")}`,
    );
    assert.equal(sessionShutdownRan, true, "subagents must await session_shutdown before returning");
  }));

test("a failed subagent attempt still emits session_shutdown", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    let sessionShutdownCount = 0;
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      extensionFactories: [
        (pi) => {
          pi.on("session_shutdown", () => {
            sessionShutdownCount++;
          });
        },
      ],
    });
    await resourceLoader.reload();

    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    await assert.rejects(agent.run("do the task", { label: "extension-failure" }), /provider failed/);

    assert.equal(sessionShutdownCount, 1, "failed attempts must release extension-owned resources");
  }));

test("a real subagent waits for deferred extension continuation before returning and disposing", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
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
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
    const text = await agent.run("do the task", { label: "deferred-continuation" });

    assert.equal(text, "continued response");
    assert.equal(continuationScheduled, true, "agent_end extension should schedule a deferred continuation");
    assert.equal(agentEndCount, 2, "deferred continuation should run as a second turn before return");
    assert.deepEqual(continuationErrors, []);
  }));

test("through the manager: a usage limit pauses the run (not fails) and resume replays the journal", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage }) => {
    const managerAgent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });
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

    // The provider limit resets: agent 2 now succeeds. Resume replays agent 1 from the journal.
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

test("an unavailable primary provider hands the same session to fallbackModel", () =>
  withFauxSession(async ({ cwd, modelRegistry, setResponses, fauxAssistantMessage }) => {
    const requests: string[] = [];
    // The SDK retries a transient provider error a few times on its own, so the
    // primary keeps failing here until those retries are exhausted; only then does
    // the handoff decision run. The fallback answers on its first request.
    const respond = (_context: unknown, _options: unknown, _state: unknown, requestModel: { id: string }) => {
      requests.push(requestModel.id);
      if (requestModel.id === "faux-deepseek") throw new Error("503 Service Unavailable");
      return fauxAssistantMessage("fallback answered", { stopReason: "stop" });
    };
    setResponses(Array.from({ length: 12 }, () => respond));
    const agent = new WorkflowAgent({ cwd, modelRegistry });
    const handoffs: Array<{ requested: string; fallback?: string; reason?: string }> = [];

    const result = await agent.run("do the task", {
      label: "unavailable-fallback-probe",
      model: "deepseek/faux-deepseek",
      fallbackModel: "deepseek/faux-deepseek-fallback",
      onModelFallback: (requested, fallback, reason) => handoffs.push({ requested, fallback, reason }),
    });

    assert.equal(result, "fallback answered");
    assert.equal(requests.at(-1), "faux-deepseek-fallback", `requests: ${requests.join(", ")}`);
    assert.deepEqual(handoffs, [
      {
        requested: "deepseek/faux-deepseek",
        fallback: "deepseek/faux-deepseek-fallback",
        reason: "primary provider is not answering",
      },
    ]);
  }));

test("an unavailable primary without a fallbackModel still fails the stage", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses }) => {
    setResponses(
      Array.from({ length: 12 }, () => () => {
        throw new Error("503 Service Unavailable");
      }),
    );
    const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });

    await assert.rejects(() => agent.run("do the task", { label: "no-fallback-probe" }), /Service Unavailable/);
  }));

// Named routes make the expected provider order independent of the response queue.
const primary = "deepseek/faux-deepseek";
const middle = "deepseek/faux-deepseek-fallback";
const last = "deepseek/faux-deepseek-last";
for (const scenario of [
  { name: "healthy primary", errors: [], expected: [[primary, "xhigh"]] },
  {
    name: "first available backup",
    errors: [USAGE_LIMIT_MSG],
    expected: [
      [primary, "xhigh"],
      [middle, "high"],
    ],
  },
  {
    name: "both runtime handoffs",
    errors: [USAGE_LIMIT_MSG, "502 Bad Gateway"],
    expected: [
      [primary, "xhigh"],
      [middle, "high"],
      [last, "xhigh"],
    ],
  },
  {
    name: "absent optional backup",
    optional: "missing/model",
    errors: [USAGE_LIMIT_MSG],
    expected: [
      [primary, "xhigh"],
      [last, "xhigh"],
    ],
  },
  {
    name: "unauthenticated optional backup",
    optional: "anthropic/faux-anthropic",
    errors: [USAGE_LIMIT_MSG],
    expected: [
      [primary, "xhigh"],
      [last, "xhigh"],
    ],
  },
  {
    name: "unavailable primary then failed backup",
    primary: "missing/model",
    errors: ["401 Unauthorized"],
    expected: [
      [middle, "high"],
      [last, "xhigh"],
    ],
  },
  {
    name: "exhausted chain",
    errors: [USAGE_LIMIT_MSG, "502 Bad Gateway", USAGE_LIMIT_MSG],
    expected: [
      [primary, "xhigh"],
      [middle, "high"],
      [last, "xhigh"],
    ],
    reject: WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
  },
  {
    name: "task error does not hand off",
    errors: ["invalid request: task failure"],
    expected: [[primary, "xhigh"]],
    reject: WorkflowErrorCode.AGENT_EXECUTION_ERROR,
  },
]) {
  test(`ordered fallbacks: ${scenario.name}, preserving effort, tool work, and session`, () =>
    withFauxSession(
      async ({ cwd, modelRegistry, setResponses, fauxAssistantMessage, fauxToolCall, anthropicCallCount }) => {
        SettingsManager.create(cwd, getAgentDir()).setRetryEnabled(false);
        const artifact = join(cwd, "completed-once.txt");
        const sessionPath = join(cwd, "chain.jsonl");
        const requests: string[][] = [];
        const resolved: string[][] = [];
        const handoffs: Array<[string, string | undefined]> = [];
        const usage: AgentUsage[] = [];
        const responses = [
          fauxAssistantMessage(fauxToolCall("write", { path: artifact, content: "completed once" }), {
            stopReason: "toolUse",
          }),
          ...scenario.errors.map((errorMessage) => fauxAssistantMessage("", { stopReason: "error", errorMessage })),
          ...(scenario.reject
            ? []
            : [fauxAssistantMessage(fauxToolCall("structured_output", { ok: true }), { stopReason: "toolUse" })]),
        ];
        setResponses(
          responses.map(
            (response, index) =>
              (
                context: { messages: Array<{ role: string; toolName?: string }> },
                options: { reasoning?: string },
                _state: unknown,
                model: { provider: string; id: string },
              ) => {
                requests.push([`${model.provider}/${model.id}`, options.reasoning ?? "off"]);
                if (index > 0) {
                  assert.equal(
                    context.messages.filter((m) => m.role === "toolResult" && m.toolName === "write").length,
                    1,
                    "every later model sees the single completed tool result",
                  );
                }
                return response;
              },
          ),
        );
        const agent = new WorkflowAgent({ cwd, modelRegistry });
        const promise = agent.run("Write the artifact once, then report success.", {
          model: scenario.primary ?? primary,
          thinking: "xhigh",
          sessionPath,
          fallbacks: [
            { model: scenario.optional ?? middle, thinking: "high", optional: true },
            { model: last, thinking: "xhigh" },
          ],
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
            additionalProperties: false,
          },
          onModelResolved: (model, thinking) => resolved.push([model, thinking ?? "off"]),
          onModelFallback: (from, to) => handoffs.push([from, to]),
          onUsage: (snapshot) => usage.push(snapshot),
        });
        if (scenario.reject) {
          await assert.rejects(promise, (error: unknown) => (error as { code: string }).code === scenario.reject);
        } else {
          assert.deepEqual(await promise, { ok: true });
        }
        const expected = scenario.expected;
        assert.deepEqual(requests, [expected[0], ...expected]);
        assert.deepEqual(resolved, expected, "actual model/effort attribution follows every handoff");
        const chain = [scenario.primary ?? primary, ...expected.map(([model]) => model)];
        assert.deepEqual(
          handoffs,
          chain.slice(1).flatMap((model, i) => (model === chain[i] ? [] : [[chain[i], model]])),
        );
        assert.equal(anthropicCallCount(), 0);
        assert.equal(readFileSync(artifact, "utf8"), "completed once");
        const saved = SessionManager.open(sessionPath).buildSessionContext();
        assert.equal(`${saved.model?.provider}/${saved.model?.modelId}`, expected.at(-1)?.[0]);
        assert.equal(saved.thinkingLevel, expected.at(-1)?.[1]);
        assert.equal(saved.messages.filter((m) => m.role === "toolResult" && m.toolName === "write").length, 1);
        const assistantMessages = saved.messages.filter((message) => message.role === "assistant");
        assert.equal(assistantMessages.length, requests.length);
        assert.ok((usage.at(-1)?.total ?? 0) > 0);
        assert.equal(
          usage.at(-1)?.total,
          assistantMessages.reduce((total, message) => total + message.usage.totalTokens, 0),
          "one usage total includes all provider attempts, not only the last route",
        );
      },
    ));
}

test("required unavailable fallback still fails before a healthy primary starts", () =>
  withFauxSession(async ({ cwd, modelRegistry, deepseekCallCount }) => {
    const agent = new WorkflowAgent({ cwd, modelRegistry });
    await assert.rejects(
      () =>
        agent.run("task", {
          model: primary,
          fallbacks: [
            { model: middle, thinking: "high", optional: true },
            { model: "missing/model", thinking: "xhigh" },
          ],
        }),
      /Fallback model.*unavailable or unauthenticated/,
    );
    assert.equal(deepseekCallCount(), 0);
  }));

test("an all-optional unavailable chain cannot silently use the session default", () =>
  withFauxSession(async ({ cwd, modelRegistry, deepseekCallCount }) => {
    const agent = new WorkflowAgent({ cwd, modelRegistry });
    await assert.rejects(
      () =>
        agent.run("task", {
          model: "missing/primary",
          fallbacks: [{ model: "missing/backup", thinking: "high", optional: true }],
        }),
      /unavailable or unauthenticated/,
    );
    assert.equal(deepseekCallCount(), 0);
  }));

for (const entrypoint of ["direct", "legacy"] as const) {
  test(`${entrypoint} uses supplied persistent storage without a usable default session directory`, () =>
    withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, deepseekCallCount }) => {
      const sessionManager = SessionManager.create(cwd, join(cwd, "caller-sessions"));
      sessionManager.appendMessage(fauxAssistantMessage("Saved caller context"));
      const sessionPath = sessionManager.getSessionFile();
      assert.ok(sessionPath);
      // A file blocking the parent directory makes default storage unusable
      // deterministically, even when tests run with permission to bypass chmod.
      const blockedParent = join(workflowSessionsDir(), "..");
      writeFileSync(blockedParent, "not a directory");
      setResponses([fauxAssistantMessage("Persisted caller answer")]);
      const options = { cwd, modelRegistry, session: { model: model as never, sessionManager } };
      const answer =
        entrypoint === "direct"
          ? await new WorkflowAgent(options).run("task")
          : (
              await runWorkflow(
                `export const meta = { name: 'caller_storage', description: 'Use supplied persistent storage' };
return await agent('task');`,
                { ...options, persistLogs: false },
              )
            ).result;
      assert.equal(answer, "Persisted caller answer");
      assert.equal(deepseekCallCount(), 1);
      const messages = SessionManager.open(sessionPath).buildSessionContext().messages;
      assert.match(JSON.stringify(messages), /Saved caller context/);
      assert.match(JSON.stringify(messages), /Persisted caller answer/);
      const response = messages.at(-1);
      assert.ok(response?.role === "assistant" && response.usage.totalTokens > 0);
      assert.equal(readFileSync(blockedParent, "utf8"), "not a directory");
    }));

  for (const populated of [false, true]) {
    test(`${entrypoint} rejects ${populated ? "populated" : "empty"} in-memory session overrides before provider execution`, () =>
      withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, deepseekCallCount }) => {
        const sessionManager = SessionManager.inMemory(cwd);
        if (populated) {
          sessionManager.appendMessage({ role: "user", content: "Keep my supplied context", timestamp: Date.now() });
          sessionManager.appendMessage(fauxAssistantMessage("Prior answer"));
          sessionManager.appendThinkingLevelChange("high");
          sessionManager.appendModelChange("deepseek", "faux-deepseek");
        }
        const before = structuredClone(sessionManager.getEntries());
        setResponses([fauxAssistantMessage("Must not execute")]);
        const options = { cwd, modelRegistry, session: { model: model as never, sessionManager } };
        await assert.rejects(
          () =>
            entrypoint === "direct"
              ? new WorkflowAgent(options).run("task")
              : runWorkflow(
                  `export const meta = { name: 'memory_override', description: 'Reject ephemeral sessions' };
return await agent('task');`,
                  { ...options, persistLogs: false },
                ),
          /in-memory sessionManager.*not supported.*persistent/i,
        );
        assert.equal(deepseekCallCount(), 0);
        assert.deepEqual(sessionManager.getEntries(), before, "rejection leaves supplied history and settings intact");
        assert.equal(sessionManager.isPersisted(), false);
      }));
  }
}

for (const ending of ["success", "failure", "cancellation"] as const) {
  test(`default and fork-only sessions retain completed usage after ${ending}`, () =>
    withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, fauxToolCall }) => {
      let controller = new AbortController();
      let returnedUsage: AgentUsage | undefined;
      const completed = fauxAssistantMessage([fauxToolCall("finish", {})], { stopReason: "toolUse" });
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry,
        session: { model: model as never },
        tools: [
          defineTool({
            name: "finish",
            description: "Controlled completion",
            parameters: Type.Object({}),
            async execute() {
              if (ending === "cancellation") controller.abort();
              return { content: [{ type: "text", text: "finished" }] };
            },
          }),
        ],
      });
      const queue = () =>
        setResponses([
          completed,
          ending === "failure"
            ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "controlled failure" })
            : fauxAssistantMessage("done", { stopReason: "stop" }),
        ]);
      const paths = () =>
        readdirSync(workflowSessionsDir())
          .filter((p) => p.endsWith(".jsonl"))
          .map((p) => join(workflowSessionsDir(), p));
      const run = async (forkFrom?: string) => {
        controller = new AbortController();
        returnedUsage = undefined;
        queue();
        const promise = agent.run("synthetic persistence task", {
          forkFrom,
          signal: controller.signal,
          onUsageUpdate: (usage) => {
            returnedUsage ??= { ...usage };
          },
        });
        if (ending === "success") assert.equal(await promise, "done");
        else await assert.rejects(promise);
      };
      await run();
      const [source] = paths();
      assert.ok(source);
      const bytes = readFileSync(source, "utf8");
      const entries = bytes
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries[0].cwd, cwd);
      const response = entries.find((entry) => entry.type === "message" && entry.message.stopReason === "toolUse");
      assert.ok(response.message.usage.input > 0);
      assert.equal(response.message.usage.input, returnedUsage?.input);
      assert.equal(response.message.usage.output, returnedUsage?.output);
      assert.equal(response.message.usage.cacheRead, returnedUsage?.cacheRead);
      assert.equal(response.message.usage.cacheWrite, returnedUsage?.cacheWrite);
      assert.equal(response.message.usage.cost.total, returnedUsage?.cost);
      assert.equal(response.message.provider, (model as { provider: string }).provider);
      assert.equal(response.message.model, (model as { id: string }).id);
      assert.ok(SessionManager.open(source).buildSessionContext().messages.length > 0);
      {
        await run(source);
        const fork = paths().find((path) => path !== source);
        assert.ok(fork);
        assert.equal(readFileSync(source, "utf8"), bytes);
        assert.equal(SessionManager.open(fork).getHeader()?.parentSession, source);
        assert.equal(
          SessionManager.open(fork)
            .buildSessionContext()
            .messages.filter((message) => message.role === "assistant" && message.stopReason === "toolUse").length,
          2,
        );
      }
      if (ending === "success") {
        await run();
        const fresh = paths().find((path) => path !== source && !SessionManager.open(path).getHeader()?.parentSession);
        assert.ok(fresh);
        assert.equal(
          SessionManager.open(fresh)
            .buildSessionContext()
            .messages.filter((message) => message.role === "assistant" && message.stopReason === "toolUse").length,
          1,
        );
      }
    }));
}

for (const fork of [false, true]) {
  test(`${fork ? "fork-only" : "default"} session continuation waits through original writer shutdown`, () =>
    withFauxSession(async ({ cwd, modelRegistry, model, setResponses, deepseekCallCount, fauxAssistantMessage }) => {
      let announceShutdown!: () => void;
      const shutdownStarted = new Promise<void>((resolve) => {
        announceShutdown = resolve;
      });
      let allowShutdown!: () => void;
      const shutdownGate = new Promise<void>((resolve) => {
        allowShutdown = resolve;
      });
      const agentDir = getAgentDir();
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
        extensionFactories: [
          (pi) => {
            pi.on("session_shutdown", async () => {
              announceShutdown();
              await shutdownGate;
            });
          },
        ],
      });
      await resourceLoader.reload();
      const source = SessionManager.create(cwd, join(cwd, "source"));
      source.appendMessage(fauxAssistantMessage("inherited source"));
      setResponses([fauxAssistantMessage("original completed answer"), fauxAssistantMessage("continued answer")]);
      const firstAgent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never, resourceLoader } });
      const nextAgent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });
      const sourcePath = source.getSessionFile();
      assert.ok(sourcePath);
      const first = firstAgent.run("original task", fork ? { forkFrom: sourcePath } : {});
      try {
        await shutdownStarted;
        const [file] = readdirSync(workflowSessionsDir()).filter((path) => path.endsWith(".jsonl"));
        assert.ok(file);
        const sessionPath = join(workflowSessionsDir(), file);
        const waiting = nextAgent.run("cancelled waiter", { sessionPath, signal: AbortSignal.timeout(100) });
        await assert.rejects(waiting);
        assert.equal(deepseekCallCount(), 1, "a waiting continuation must not call the provider during shutdown");
        const continuation = nextAgent.run("continue", { sessionPath });
        allowShutdown();
        assert.equal(await first, "original completed answer");
        assert.equal(await continuation, "continued answer");
        const messages = SessionManager.open(sessionPath).buildSessionContext().messages;
        const transcript = JSON.stringify(messages);
        assert.match(transcript, /original completed answer/);
        assert.match(transcript, /continued answer/);
        assert.doesNotMatch(transcript, /cancelled waiter/);
        assert.equal(deepseekCallCount(), 2);
      } finally {
        allowShutdown();
        await first;
      }
    }));
}
