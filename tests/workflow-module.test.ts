import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadWorkflowModule } from "../src/workflow.js";
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

      const completed = new Promise<void>((resolve) => manager.once("complete", () => resolve()));
      const result = await executeTool(manager, cwd)(
        "native-module",
        { scriptPath, cwd, args: { topic: "imports" } },
        new AbortController().signal,
        () => {},
        { hasUI: false },
      );

      const runId = result.details.runId;
      assert.ok(runId);
      await completed;
      assert.equal(manager.getRun(runId)?.result?.result, "native-ok");
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
      const pausedEvent = new Promise<void>((resolve) => first.once("paused", () => resolve()));
      const started = await executeTool(first, cwd)(
        "native-checkpoint-start",
        { scriptPath, cwd },
        new AbortController().signal,
        () => {},
        { hasUI: false },
      );
      assert.ok(started.details.runId);
      await pausedEvent;
      assert.equal(prompts.length, 1);

      const second = new WorkflowManager({ cwd, agent, sessionId: "native-session" });
      const completed = new Promise<void>((resolve) => second.once("complete", () => resolve()));
      assert.equal(await second.resumeWithReply(started.details.runId, "yes"), true);
      await completed;

      assert.deepEqual(prompts, ["before", "after:yes"]);
      const result = second.getRun(started.details.runId)?.result?.result as {
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

test("loadWorkflowModule re-imports an edited module (mtime cache invalidation)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-native-reload-"));
  try {
    const scriptPath = join(cwd, "workflow.mjs");
    const source = (version: string) =>
      `export const meta = { name: 'reload_test', description: 'reload test' }
export async function run() { return '${version}' }
`;

    writeFileSync(scriptPath, source("v1"));
    // Pin distinct mtimes: same-millisecond writes would otherwise produce
    // identical cache keys and make the test flaky.
    utimesSync(scriptPath, new Date(1000), new Date(1000));
    const first = await loadWorkflowModule(scriptPath);
    assert.equal(await first.run({} as any), "v1");

    writeFileSync(scriptPath, source("v2"));
    utimesSync(scriptPath, new Date(2000), new Date(2000));
    const second = await loadWorkflowModule(scriptPath);
    assert.equal(await second.run({} as any), "v2");

    // Unchanged file: same URL, cached instance is reused.
    const third = await loadWorkflowModule(scriptPath);
    assert.equal(third.run, second.run);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadWorkflowModule re-imports an edited module under pi's jiti extension loader", async () => {
  // pi loads extension TypeScript through jiti, which rewrites source-level
  // dynamic import() into jitiImport() and resolves the specifier back to a
  // bare file path — a ?mtime= query on the import URL does not survive. Load
  // workflow.ts through the same jiti version and options as pi's extension
  // loader to prove cache busting works on the production path too.
  const piRequire = createRequire(new URL("../node_modules/@earendil-works/pi-coding-agent/_.js", import.meta.url));
  const { createJiti } = piRequire("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const wf = (await jiti.import(
    fileURLToPath(new URL("../src/workflow.ts", import.meta.url)),
  )) as typeof import("../src/workflow.js");

  const cwd = mkdtempSync(join(tmpdir(), "workflow-jiti-reload-"));
  try {
    const scriptPath = join(cwd, "workflow.mjs");
    const source = (version: string) =>
      `export const meta = { name: 'jiti_reload_test', description: 'jiti reload test' }
export async function run() { return '${version}' }
`;

    writeFileSync(scriptPath, source("v1"));
    utimesSync(scriptPath, new Date(1000), new Date(1000));
    const first = await wf.loadWorkflowModule(scriptPath);
    assert.equal(await first.run({} as any), "v1");

    writeFileSync(scriptPath, source("v2"));
    utimesSync(scriptPath, new Date(2000), new Date(2000));
    const second = await wf.loadWorkflowModule(scriptPath);
    assert.equal(await second.run({} as any), "v2");

    // Unchanged file: same URL, cached instance is reused.
    const third = await wf.loadWorkflowModule(scriptPath);
    assert.equal(third.run, second.run);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
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
        executeTool(manager, cwd)(`native-${name}`, { scriptPath, cwd }, new AbortController().signal, () => {}, {
          hasUI: false,
        }),
        message,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
