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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, defineTool, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowAgent } from "../src/agent.js";
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
 * Run `fn` with an isolated HOME and a dummy provider key so hasConfiguredAuth()
 * passes via env — no real credentials are touched, and the faux api means the
 * key is never actually used. A faux "deepseek" provider is registered/torn down
 * around `fn`; `setResponses` queues the scripted turns.
 */
async function withFauxSession(
  fn: (ctx: {
    cwd: string;
    model: unknown;
    setResponses: (msgs: unknown[]) => void;
    fauxAssistantMessage: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
  }) => Promise<void>,
): Promise<void> {
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  const home = mkdtempSync(join(tmpdir(), "pi-dw-i26-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-i26-cwd-"));
  const prevKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "faux-dummy-key-not-used";
  const faux = registerFauxProvider({
    provider: "deepseek",
    models: [{ id: "faux-deepseek", name: "Faux DeepSeek", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, () =>
      fn({
        cwd,
        model: faux.getModel(),
        setResponses: (msgs) => faux.setResponses(msgs as never),
        fauxAssistantMessage,
      }),
    );
  } finally {
    faux.unregister();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevKey;
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

test("a successful real turn whose text merely mentions 'rate limit' is NOT misclassified", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("Done. I handled the rate limit gracefully.", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });
    const text = await agent.run("do the task", { label: "ok" });
    assert.ok(typeof text === "string" && text.includes("Done."), `expected normal text, got ${String(text)}`);
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
            for (const name of ["ast_grep_search", "ast_grep_replace"]) {
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
    assert.ok(
      activeTools.includes("ast_grep_search"),
      `expected ast_grep_search to remain active, got ${activeTools.join(", ")}`,
    );
    for (const name of ["bash", "edit", "write", "ast_grep_replace"]) {
      assert.ok(!activeTools.includes(name), `expected ${name} to be excluded, got ${activeTools.join(", ")}`);
    }
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
