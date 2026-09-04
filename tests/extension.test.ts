import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

test("workflow extension binds project state and defaults to the session cwd", async () => {
  const originalCwd = process.cwd();
  const processCwd = mkdtempSync(join(tmpdir(), "workflow-extension-process-cwd-"));
  const sessionCwd = mkdtempSync(join(tmpdir(), "workflow-extension-session-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "workflow-extension-cwd-home-"));
  try {
    process.chdir(processCwd);
    await withFakeHomeAsync(home, async () => {
      saveWorkflowSettings({ defaultAgentRetries: 3 }, { cwd: sessionCwd, scope: "project" });

      let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
      let workflowTool: any;
      const activeTools: string[] = [];
      let resolveDelivery: (() => void) | undefined;
      const delivery = new Promise<void>((resolve) => {
        resolveDelivery = resolve;
      });
      const pi = {
        registerTool: (tool: { name: string }) => {
          if (tool.name === "workflow") workflowTool = tool;
        },
        registerCommand: () => {},
        getCommands: () => [],
        getActiveTools: () => [...activeTools],
        setActiveTools: (next: string[]) => activeTools.splice(0, activeTools.length, ...next),
        on: (event: string, listener: (event: unknown, ctx: unknown) => void) => {
          if (event === "session_start") sessionStart = listener;
        },
        sendMessage: (message: { customType?: string }) => {
          if (message.customType === "workflow-result") resolveDelivery?.();
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

      const started = await workflowTool.execute(
        "cwd-call",
        {
          script: `export const meta = { name: 'extension_cwd', description: 'reports its cwd' }
return { cwd }`,
        },
        new AbortController().signal,
        () => {},
        { cwd: sessionCwd, hasUI: false },
      );
      await delivery;

      const runPath = join(workflowProjectPaths(sessionCwd).runsDir, `${started.details.runId}.json`);
      assert.equal(existsSync(runPath), true);
      const persisted = JSON.parse(readFileSync(runPath, "utf-8"));
      assert.equal(persisted.cwd, sessionCwd);
      assert.deepEqual(persisted.result, { cwd: sessionCwd });
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
