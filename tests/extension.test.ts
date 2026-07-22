import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/workflow.ts";

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
      model: { provider: "test", id: "main" },
      modelRegistry: {},
      sessionManager: { getSessionId: () => "session-1" },
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
