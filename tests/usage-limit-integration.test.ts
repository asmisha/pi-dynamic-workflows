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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
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
import { runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { loadFaux } from "./helpers/load-faux.js";

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";
const SAFE_MISE_VARIABLE = "PI_WORKFLOW_SAFE_PROJECT_VALUE";
const SAFE_INHERITED_VARIABLE = "PI_WORKFLOW_SAFE_INHERITED_VALUE";

async function withSyntheticMise(run: () => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-mise-"));
  const bin = join(root, "bin");
  const executable = join(bin, "mise");
  const globalConfig = join(root, "global.toml");
  mkdirSync(bin);
  writeFileSync(globalConfig, `[env]\n${SAFE_MISE_VARIABLE} = "global-wrong"\n`);
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { existsSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const cdIndex = args.indexOf("-C");
const cwd = cdIndex >= 0 ? args[cdIndex + 1] : process.cwd();
const globalConfig = ${JSON.stringify(globalConfig)};
const localConfig = [
  join(cwd, "mise.toml"),
  join(cwd, ".mise", "config.toml"),
  join(cwd, ".config", "mise", "config.toml"),
].find(existsSync);
if (args[0] === "config" && args[1] === "ls") {
  const failOnce = join(cwd, ".mise-fail-once");
  if (existsSync(failOnce)) {
    rmSync(failOnce);
    process.exit(1);
  }
  const configs = [{ path: realpathSync(globalConfig), tools: [] }];
  if (localConfig) configs.unshift({ path: realpathSync(localConfig), tools: [] });
  process.stdout.write(JSON.stringify(configs));
} else if (args[0] === "env") {
  const config = localConfig ?? globalConfig;
  const match = readFileSync(config, "utf8").match(/${SAFE_MISE_VARIABLE}\\s*=\\s*"([^"]*)"/);
  if (!match) process.exit(1);
  process.stdout.write(JSON.stringify({ ${SAFE_MISE_VARIABLE}: match[1] }));
} else {
  process.exit(2);
}
`,
  );
  chmodSync(executable, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);
  try {
    await run();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
}

function toolResultTexts(context: unknown): string[] {
  const messages = (context as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
  return messages.flatMap((message) => {
    if (message.role !== "toolResult") return [];
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.find((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      ),
    )?.text;
    return text === undefined ? [] : [text.trim()];
  });
}

function echoLatestToolText(
  context: unknown,
  fauxAssistantMessage: typeof import("@earendil-works/pi-ai").fauxAssistantMessage,
): unknown {
  const text = toolResultTexts(context).at(-1);
  if (text === undefined) throw new Error("bash did not produce a text tool result");
  return fauxAssistantMessage(text, { stopReason: "stop" });
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

test("a subagent cwd without mise configuration preserves the inherited process environment", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, fauxToolCall }) => {
    await withSyntheticMise(async () => {
      const previousValue = process.env[SAFE_MISE_VARIABLE];
      process.env[SAFE_MISE_VARIABLE] = "inherited-host";
      try {
        setResponses([
          fauxAssistantMessage(fauxToolCall("bash", { command: `printf '%s' "$${SAFE_MISE_VARIABLE}"` }), {
            stopReason: "toolUse",
          }),
          (context: unknown) => echoLatestToolText(context, fauxAssistantMessage),
        ]);
        const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });

        assert.equal(await agent.run("read the safe project value"), "inherited-host");
        assert.equal(process.env[SAFE_MISE_VARIABLE], "inherited-host");
      } finally {
        if (previousValue === undefined) delete process.env[SAFE_MISE_VARIABLE];
        else process.env[SAFE_MISE_VARIABLE] = previousValue;
      }
    });
  }));

test("a subagent uses the mise environment configured for its default cwd", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, fauxToolCall }) => {
    await withSyntheticMise(async () => {
      writeFileSync(join(cwd, "mise.toml"), `[env]\n${SAFE_MISE_VARIABLE} = "default-cwd-project"\n`);

      const previousValue = process.env[SAFE_MISE_VARIABLE];
      process.env[SAFE_MISE_VARIABLE] = "inherited-host";
      try {
        setResponses([
          fauxAssistantMessage(fauxToolCall("bash", { command: `printf '%s' "$${SAFE_MISE_VARIABLE}"` }), {
            stopReason: "toolUse",
          }),
          (context: unknown) => echoLatestToolText(context, fauxAssistantMessage),
        ]);
        const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });

        assert.equal(await agent.run("read the safe project value"), "default-cwd-project");
        assert.equal(process.env[SAFE_MISE_VARIABLE], "inherited-host");
      } finally {
        if (previousValue === undefined) delete process.env[SAFE_MISE_VARIABLE];
        else process.env[SAFE_MISE_VARIABLE] = previousValue;
      }
    });
  }));

test("a transient mise failure falls back for one Bash process and retries for the next", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, fauxToolCall }) => {
    await withSyntheticMise(async () => {
      const worktree = join(cwd, "retry-worktree");
      mkdirSync(worktree);
      writeFileSync(join(worktree, "mise.toml"), `[env]\n${SAFE_MISE_VARIABLE} = "retry-project"\n`);
      writeFileSync(join(worktree, ".mise-fail-once"), "fail once\n");

      const previousValue = process.env[SAFE_MISE_VARIABLE];
      process.env[SAFE_MISE_VARIABLE] = "inherited-host";
      try {
        const bashCall = () =>
          fauxAssistantMessage(fauxToolCall("bash", { command: `printf '%s' "$${SAFE_MISE_VARIABLE}"` }), {
            stopReason: "toolUse",
          });
        setResponses([
          bashCall(),
          bashCall(),
          (context: unknown) => fauxAssistantMessage(toolResultTexts(context).join("|"), { stopReason: "stop" }),
        ]);
        const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });

        assert.equal(
          await agent.run("read the safe project value twice", { cwd: worktree }),
          "inherited-host|retry-project",
        );
      } finally {
        if (previousValue === undefined) delete process.env[SAFE_MISE_VARIABLE];
        else process.env[SAFE_MISE_VARIABLE] = previousValue;
      }
    });
  }));

test("concurrent subagents bind Bash processes to distinct cwd-local mise environments", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, fauxToolCall }) => {
    await withSyntheticMise(async () => {
      const firstCwd = join(cwd, "worktree-one");
      const secondCwd = join(cwd, "worktree-two");
      mkdirSync(join(firstCwd, ".mise"), { recursive: true });
      mkdirSync(join(secondCwd, ".config", "mise"), { recursive: true });
      writeFileSync(join(firstCwd, ".mise", "config.toml"), `[env]\n${SAFE_MISE_VARIABLE} = "first-project"\n`);
      writeFileSync(
        join(secondCwd, ".config", "mise", "config.toml"),
        `[env]\n${SAFE_MISE_VARIABLE} = "second-project"\n`,
      );

      const previousValue = process.env[SAFE_MISE_VARIABLE];
      const previousInheritedValue = process.env[SAFE_INHERITED_VARIABLE];
      process.env[SAFE_MISE_VARIABLE] = "inherited-host";
      process.env[SAFE_INHERITED_VARIABLE] = "preserved-inherited";
      try {
        const bashCall = () =>
          fauxAssistantMessage(
            fauxToolCall("bash", {
              command: `printf '%s|%s' "$${SAFE_MISE_VARIABLE}" "$${SAFE_INHERITED_VARIABLE}"`,
            }),
            { stopReason: "toolUse" },
          );
        setResponses([
          bashCall(),
          bashCall(),
          (context: unknown) => echoLatestToolText(context, fauxAssistantMessage),
          (context: unknown) => echoLatestToolText(context, fauxAssistantMessage),
        ]);
        const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });

        const [first, second] = await Promise.all([
          agent.run("read the first project value", { cwd: firstCwd }),
          agent.run("read the second project value", { cwd: secondCwd }),
        ]);

        assert.deepEqual([first, second], ["first-project|preserved-inherited", "second-project|preserved-inherited"]);
        assert.equal(process.env[SAFE_MISE_VARIABLE], "inherited-host");
      } finally {
        if (previousValue === undefined) delete process.env[SAFE_MISE_VARIABLE];
        else process.env[SAFE_MISE_VARIABLE] = previousValue;
        if (previousInheritedValue === undefined) delete process.env[SAFE_INHERITED_VARIABLE];
        else process.env[SAFE_INHERITED_VARIABLE] = previousInheritedValue;
      }
    });
  }));

test("persisted subagent follow-ups resolve the current mise environment through the shared run boundary", () =>
  withFauxSession(async ({ cwd, modelRegistry, model, setResponses, fauxAssistantMessage, fauxToolCall }) => {
    await withSyntheticMise(async () => {
      const worktree = join(cwd, "persistent-worktree");
      const config = join(worktree, "mise.toml");
      const sessionPath = join(cwd, "persisted-subagent.jsonl");
      mkdirSync(worktree);
      writeFileSync(config, `[env]\n${SAFE_MISE_VARIABLE} = "initial-project"\n`);

      const bashCall = () =>
        fauxAssistantMessage(fauxToolCall("bash", { command: `printf '%s' "$${SAFE_MISE_VARIABLE}"` }), {
          stopReason: "toolUse",
        });
      setResponses([
        bashCall(),
        (context: unknown) => echoLatestToolText(context, fauxAssistantMessage),
        bashCall(),
        (context: unknown) => echoLatestToolText(context, fauxAssistantMessage),
      ]);
      const agent = new WorkflowAgent({ cwd, modelRegistry, session: { model: model as never } });

      const first = await agent.run("read the initial project value", { cwd: worktree, sessionPath });
      writeFileSync(config, `[env]\n${SAFE_MISE_VARIABLE} = "follow-up-project"\n`);
      const followUp = await agent.run("read the current project value", { cwd: worktree, sessionPath });

      assert.equal(first, "initial-project");
      assert.equal(followUp, "follow-up-project");
      assert.equal(existsSync(sessionPath), true);
    });
  }));

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
