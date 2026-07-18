import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function executeTool(manager: WorkflowManager, cwd: string) {
  return createWorkflowTool({ cwd, manager }).execute as (...args: any[]) => Promise<any>;
}

test("scriptPath runs a native ESM workflow with relative shared code", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-native-module-"));
  const home = mkdtempSync(join(tmpdir(), "workflow-native-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      writeFileSync(
        join(cwd, "shared.mjs"),
        `export async function runShared({ agent, args, cwd, phase, log }) {
  phase('Imported')
  log('shared helper')
  return await agent('shared:' + args.topic + ':' + cwd, { label: 'shared helper' })
}
`,
      );
      const scriptPath = join(cwd, "workflow.mjs");
      writeFileSync(
        scriptPath,
        `import { runShared } from './shared.mjs'

export const meta = {
  name: 'native_module',
  description: 'native ESM workflow',
  phases: [{ title: 'Imported' }],
}

export async function run(context) {
  return await runShared(context)
}
`,
      );
      const prompts: string[] = [];
      const manager = new WorkflowManager({
        cwd,
        agent: {
          async run(prompt: string) {
            prompts.push(prompt);
            return "native-ok";
          },
        },
      });

      const result = await executeTool(manager, cwd)(
        "native-module",
        { scriptPath, cwd, args: { topic: "imports" }, background: false },
        new AbortController().signal,
        () => {},
        { hasUI: false },
      );

      assert.equal(result.details.result, "native-ok");
      assert.deepEqual(prompts, [`shared:imports:${cwd}`]);
      assert.ok(manager.listRuns()[0]?.logs.includes("shared helper"));
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("awaited checkpoint in an imported native module replays its answer after manager restart", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-native-checkpoint-"));
  const home = mkdtempSync(join(tmpdir(), "workflow-native-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      writeFileSync(
        join(cwd, "shared.mjs"),
        `export async function ask({ checkpoint }, question) {
  return checkpoint(question)
}
`,
      );
      const scriptPath = join(cwd, "workflow.mjs");
      writeFileSync(
        scriptPath,
        `import { ask } from './shared.mjs'

export const meta = { name: 'native_checkpoint', description: 'native checkpoint workflow' }

export async function run(context) {
  const before = await context.agent('before', { label: 'before' })
  const answer = await ask(context, 'Continue?')
  const after = await context.agent('after:' + answer, { label: 'after' })
  return { before, answer, after }
}
`,
      );
      const prompts: string[] = [];
      const agent = {
        async run(prompt: string) {
          prompts.push(prompt);
          return prompt;
        },
      };
      const first = new WorkflowManager({ cwd, agent, sessionId: "native-session" });
      const paused = await executeTool(first, cwd)(
        "native-checkpoint-start",
        { scriptPath, cwd, background: false },
        new AbortController().signal,
        () => {},
        { hasUI: false },
      );
      assert.equal(paused.details.paused, true);
      assert.equal(prompts.length, 1);

      const second = new WorkflowManager({ cwd, agent, sessionId: "native-session" });
      const completed = new Promise<void>((resolve) => second.once("complete", () => resolve()));
      assert.equal(await second.resumeWithReply(paused.details.runId, "yes"), true);
      await completed;

      assert.deepEqual(prompts, ["before", "after:yes"]);
      const result = second.getRun(paused.details.runId)?.result?.result as {
        before?: string;
        answer?: string;
        after?: string;
      };
      assert.deepEqual(result, { before: "before", answer: "yes", after: "after:yes" });
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("scriptPath requires native ESM meta and run exports", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-native-invalid-"));
  try {
    for (const [name, source, message] of [
      ["missing-meta", "export async function run() {}", /export.*meta/i],
      ["missing-run", "export const meta = { name: 'missing_run', description: 'missing run' }", /export.*run/i],
    ] as const) {
      const scriptPath = join(cwd, `${name}.mjs`);
      writeFileSync(scriptPath, source);
      const manager = new WorkflowManager({ cwd, agent: { run: async () => "unused" } });
      await assert.rejects(
        executeTool(manager, cwd)(
          `native-${name}`,
          { scriptPath, cwd, background: false },
          new AbortController().signal,
          () => {},
          { hasUI: false },
        ),
        message,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
