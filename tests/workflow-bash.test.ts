import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";

function fakeAgent() {
  return {
    async run(prompt: string) {
      return `ok:${prompt}`;
    },
  };
}

function withTempDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-workflow-bash-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "bash() runs a command and returns pid, exit code, and output file paths",
  withTempDir(async (dir) => {
    const script = `export const meta = { name: 'bash_basic', description: 'bash stdout files' }
const r = await bash('echo hello-workflow')
return { pidType: typeof r.pid, code: r.exitCode, stdoutFile: r.stdoutFile, stderrFile: r.stderrFile }`;
    const result = (await runWorkflow(script, { cwd: dir, agent: fakeAgent(), persistLogs: false })).result as {
      pidType: string;
      code: number;
      stdoutFile: string;
      stderrFile: string;
    };
    assert.equal(result.pidType, "number");
    assert.equal(result.code, 0);
    assert.equal(readFileSync(result.stdoutFile, "utf-8").trim(), "hello-workflow");
    assert.equal(readFileSync(result.stderrFile, "utf-8"), "");
  }),
);

test(
  "bash() returns non-zero exit codes and stores stderr instead of throwing",
  withTempDir(async (dir) => {
    const script = `export const meta = { name: 'bash_exit', description: 'bash exit code' }
const r = await bash('echo boom >&2; exit 3')
return { code: r.exitCode, stderrFile: r.stderrFile }`;
    const result = (await runWorkflow(script, { cwd: dir, agent: fakeAgent(), persistLogs: false })).result as {
      code: number;
      stderrFile: string;
    };
    assert.equal(result.code, 3);
    assert.equal(readFileSync(result.stderrFile, "utf-8").trim(), "boom");
  }),
);

test(
  "bash() runs in the workflow cwd by default and honors a per-call cwd",
  withTempDir(async (dir) => {
    const script = `export const meta = { name: 'bash_cwd', description: 'bash cwd' }
const here = await bash('pwd')
await bash('mkdir -p sub')
const there = await bash('pwd', { cwd: cwd + '/sub' })
return { hereFile: here.stdoutFile, thereFile: there.stdoutFile }`;
    const result = (await runWorkflow(script, { cwd: dir, agent: fakeAgent(), persistLogs: false })).result as {
      hereFile: string;
      thereFile: string;
    };
    const here = readFileSync(result.hereFile, "utf-8").trim();
    const there = readFileSync(result.thereFile, "utf-8").trim();
    // Compare realpath-insensitively (macOS /tmp -> /private/tmp symlink).
    assert.ok(here.endsWith(dir.split("/").pop() as string));
    assert.equal(there, `${here}/sub`);
  }),
);

test(
  "bash() output paths pipe into agent() prompts",
  withTempDir(async (dir) => {
    const prompts: string[] = [];
    const runner = {
      async run(prompt: string) {
        prompts.push(prompt);
        return "analyzed";
      },
    };
    const script = `export const meta = { name: 'bash_pipe', description: 'pipe bash files to agent' }
const r = await bash('printf "alpha\\nbeta"')
const verdict = await agent('Analyze stdout file: ' + r.stdoutFile + '\\nStderr file: ' + r.stderrFile, { label: 'analyzer' })
return verdict`;
    const result = await runWorkflow(script, { cwd: dir, agent: runner, persistLogs: false });
    assert.equal(result.result, "analyzed");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Analyze stdout file:/);
    const stdoutPath = prompts[0].match(/Analyze stdout file: (.*)\nStderr file:/)?.[1];
    assert.ok(stdoutPath);
    assert.equal(readFileSync(stdoutPath, "utf-8"), "alpha\nbeta");
  }),
);

test(
  "bash() results are journaled and replayed on resume without re-running",
  withTempDir(async (dir) => {
    const marker = join(dir, "marker.txt");
    const journal: JournalEntry[] = [];
    const script = `export const meta = { name: 'bash_resume', description: 'bash journal replay' }
const r = await bash('echo ran >> ' + args.marker + '; echo did-run')
const a = await agent('summarize stdout file: ' + r.stdoutFile, { label: 'sum' })
return { stdoutFile: r.stdoutFile, a }`;

    const first = await runWorkflow(script, {
      cwd: dir,
      agent: fakeAgent(),
      persistLogs: false,
      args: { marker },
      onAgentJournal: (e) => journal.push(e),
    });
    const firstResult = first.result as { stdoutFile: string; a: string };
    assert.equal(readFileSync(firstResult.stdoutFile, "utf-8").trim(), "did-run");
    assert.equal(readFileSync(marker, "utf-8").trim(), "ran", "command ran once");
    assert.equal(journal.length, 2, "bash + agent journal entries");

    // Resume: both the bash call and the agent replay from the journal.
    const second = await runWorkflow(script, {
      cwd: dir,
      agent: {
        async run() {
          throw new Error("agent should not re-run on a full journal replay");
        },
      },
      persistLogs: false,
      args: { marker },
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.deepEqual({ ...(second.result as object) }, { ...(first.result as object) });
    assert.equal(readFileSync(marker, "utf-8").trim(), "ran", "command must NOT re-run on resume");
  }),
);

test(
  "editing the bash command busts the resume cache for it and everything after",
  withTempDir(async (dir) => {
    const marker = join(dir, "marker.txt");
    const journal: JournalEntry[] = [];
    const script = (cmd: string) => `export const meta = { name: 'bash_bust', description: 'bash cache bust' }
const r = await bash('${cmd} >> ' + args.marker + '; echo ok')
const a = await agent('after bash stdout file: ' + r.stdoutFile, { label: 'after' })
return a`;

    await runWorkflow(script("echo one"), {
      cwd: dir,
      agent: fakeAgent(),
      persistLogs: false,
      args: { marker },
      onAgentJournal: (e) => journal.push(e),
    });
    let agentRuns = 0;
    await runWorkflow(script("echo two"), {
      cwd: dir,
      agent: {
        async run(prompt: string) {
          agentRuns++;
          return `ok:${prompt}`;
        },
      },
      persistLogs: false,
      args: { marker },
      resumeJournal: new Map(journal.map((e) => [e.index, e])),
    });
    assert.equal(readFileSync(marker, "utf-8").trim(), "one\ntwo", "changed command re-runs");
    assert.equal(agentRuns, 1, "downstream agent re-runs after the miss (longest-unchanged-prefix)");
  }),
);

test(
  "bash() stores full output without truncating in-memory results",
  withTempDir(async (dir) => {
    const script = `export const meta = { name: 'bash_full_output', description: 'bash full output file' }
const r = await bash('yes a | head -c 250000')
return { stdoutFile: r.stdoutFile }`;
    const result = (await runWorkflow(script, { cwd: dir, agent: fakeAgent(), persistLogs: false })).result as {
      stdoutFile: string;
    };
    assert.equal(readFileSync(result.stdoutFile, "utf-8").length, 250_000);
  }),
);

test(
  "workflow abort kills a running bash command",
  withTempDir(async (dir) => {
    const controller = new AbortController();
    const script = `export const meta = { name: 'bash_abort', description: 'bash abort' }
await bash('sleep 30')
return 'unreachable'`;
    const started = Date.now();
    const run = runWorkflow(script, {
      cwd: dir,
      agent: fakeAgent(),
      persistLogs: false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof WorkflowError);
      assert.equal(err.code, WorkflowErrorCode.WORKFLOW_ABORTED);
      return true;
    });
    assert.ok(Date.now() - started < 10_000, "abort must not wait out the sleep");
  }),
);

test(
  "bash() timeoutMs kills the command and throws AGENT_TIMEOUT",
  withTempDir(async (dir) => {
    const script = `export const meta = { name: 'bash_timeout', description: 'bash timeout' }
await bash('sleep 30', { timeoutMs: 100 })
return 'unreachable'`;
    const started = Date.now();
    await assert.rejects(runWorkflow(script, { cwd: dir, agent: fakeAgent(), persistLogs: false }), (err: unknown) => {
      assert.ok(err instanceof WorkflowError);
      assert.equal(err.code, WorkflowErrorCode.AGENT_TIMEOUT);
      return true;
    });
    assert.ok(Date.now() - started < 10_000, "timeout must not wait out the sleep");
  }),
);

test(
  "bash() rejects a non-string command",
  withTempDir(async (dir) => {
    const script = `export const meta = { name: 'bash_bad', description: 'bash bad arg' }
await bash(42)
return 'unreachable'`;
    await assert.rejects(runWorkflow(script, { cwd: dir, agent: fakeAgent(), persistLogs: false }), /command string/);
  }),
);
