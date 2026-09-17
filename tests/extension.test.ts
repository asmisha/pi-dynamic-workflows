import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/workflow.ts";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { saveWorkflowSettings } from "../src/workflow-settings.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

test("workflow extension session_start activates the tool and installs the task panel", () => {
  let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
  const activeTools: string[] = [];
  const registeredTools: string[] = [];
  const widgets: string[] = [];
  const pi = {
    events: createEventBus(),
    registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
    registerCommand: () => {},
    getCommands: () => [],
    getActiveTools: () => [...activeTools],
    setActiveTools: (next: string[]) => activeTools.splice(0, activeTools.length, ...next),
    on: (event: string, listener: (event: unknown, ctx: unknown) => void) => {
      if (event === "session_start") sessionStart = listener;
    },
    sendMessage: () => undefined,
  };

  extension(pi as unknown as ExtensionAPI);
  assert.ok(sessionStart, "extension registers session_start");
  sessionStart(
    {},
    {
      cwd: process.cwd(),
      model: { provider: "test", id: "main" },
      modelRegistry: {},
      sessionManager: { getSessionId: () => "session-1" },
      isIdle: () => true,
      ui: { setWidget: (name: string) => widgets.push(name) },
    },
  );

  assert.deepEqual(registeredTools, [
    "workflow",
    "workflow_status",
    "workflow_pause",
    "workflow_resume",
    "workflow_retry",
    "workflow_stop",
  ]);
  assert.ok(activeTools.includes("workflow"), "workflow tool is active after session start");
  assert.ok(activeTools.includes("workflow_status"), "workflow status tool is active after session start");
  assert.ok(activeTools.includes("workflow_pause"), "workflow pause tool is active after session start");
  assert.ok(activeTools.includes("workflow_resume"), "workflow resume tool is active after session start");
  assert.ok(activeTools.includes("workflow_retry"), "workflow retry tool is active after session start");
  assert.ok(activeTools.includes("workflow_stop"), "workflow stop tool is active after session start");
  assert.deepEqual(widgets, ["workflow-tasks"]);
});

test("commands launch native workflows through the same parent-session manager", async () => {
  const originalCwd = process.cwd();
  const processCwd = mkdtempSync(join(tmpdir(), "workflow-extension-process-cwd-"));
  const sessionCwd = mkdtempSync(join(tmpdir(), "workflow-extension-session-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "workflow-extension-cwd-home-"));
  try {
    process.chdir(processCwd);
    await withFakeHomeAsync(home, async () => {
      saveWorkflowSettings({ defaultAgentRetries: 3 }, { cwd: sessionCwd, scope: "project" });

      let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
      const registeredTools = new Map<string, any>();
      const activeTools: string[] = [];
      let resolveDelivery: (() => void) | undefined;
      const delivery = new Promise<void>((resolve) => {
        resolveDelivery = resolve;
      });
      const pi = {
        events: createEventBus(),
        registerTool: (tool: { name: string }) => {
          registeredTools.set(tool.name, tool);
        },
        registerCommand: () => {},
        getCommands: () => [],
        getActiveTools: () => [...activeTools],
        setActiveTools: (next: string[]) => activeTools.splice(0, activeTools.length, ...next),
        on: (event: string, listener: (event: unknown, ctx: unknown) => void) => {
          if (event === "session_start") sessionStart = listener;
        },
        sendMessage: (message: { customType?: string }) => {
          assert.equal(message.customType, "workflow-result", "no message asks the parent agent to launch");
          resolveDelivery?.();
        },
      };

      extension(pi as unknown as ExtensionAPI);
      assert.ok(sessionStart);
      sessionStart(
        {},
        {
          cwd: sessionCwd,
          model: undefined,
          modelRegistry: {},
          sessionManager: { getSessionId: () => "cwd-session", getEntries: () => [] },
          isIdle: () => true,
          ui: { setWidget: () => {} },
        },
      );

      const scriptPath = join(sessionCwd, "workflow.mjs");
      writeFileSync(
        scriptPath,
        `export const meta = { name: 'extension_cwd', description: 'reports its cwd' }
export async function run({ cwd, args }) { return { cwd, args } }`,
      );
      let pending: Promise<any> | undefined;
      pi.events.emit("workflow:run", {
        params: { scriptPath, args: { feedback: "arbitrary\ninput" } },
        ctx: { cwd: sessionCwd, hasUI: false },
        respond: (result: Promise<any>) => {
          pending = result;
        },
      });
      assert.ok(pending, "the command gets the start promise directly");
      const started = await pending;
      await delivery;

      const status = await registeredTools.get("workflow_status").execute("status", { runId: started.details.runId });
      assert.match(status.content[0].text, /completed/);

      let invalid: Promise<any> | undefined;
      pi.events.emit("workflow:run", {
        params: { scriptPath, script: "invalid second source" },
        ctx: { cwd: sessionCwd, hasUI: false },
        respond: (result: Promise<any>) => {
          invalid = result;
        },
      });
      assert.ok(invalid);
      await assert.rejects(invalid, /exactly one/);

      const runPath = join(workflowProjectPaths(sessionCwd).runsDir, `${started.details.runId}.json`);
      assert.equal(existsSync(runPath), true);
      const persisted = JSON.parse(readFileSync(runPath, "utf-8"));
      assert.equal(persisted.cwd, sessionCwd);
      assert.deepEqual(persisted.result, { cwd: sessionCwd, args: { feedback: "arbitrary\ninput" } });
      assert.equal(persisted.sessionId, "cwd-session");
      assert.equal(persisted.executionOptions.agentRetries, 3);
      assert.equal(existsSync(join(workflowProjectPaths(processCwd).runsDir, `${started.details.runId}.json`)), false);
    });
  } finally {
    process.chdir(originalCwd);
    rmSync(processCwd, { recursive: true, force: true });
    rmSync(sessionCwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
