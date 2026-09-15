import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const COPY_EXCLUSIONS = new Set([".git", "dist", "node_modules"]);

function copyPackageSource(destination: string): void {
  cpSync(REPOSITORY_ROOT, destination, {
    recursive: true,
    filter(source) {
      const [topLevel] = relative(REPOSITORY_ROOT, source).split(sep);
      return !COPY_EXCLUSIONS.has(topLevel);
    },
  });
}

function childFailure(result: ReturnType<typeof spawnSync>): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

test("source-only production and packed installs expose the awaited Node API to plain Node", {
  timeout: 90_000,
}, () => {
  const sandbox = mkdtempSync(join(tmpdir(), "workflow-package-node-api-"));
  const packagePath = join(sandbox, "package");
  const consumerPath = join(sandbox, "consumer");
  const projectPath = join(sandbox, "project");
  const unrelatedCwd = join(sandbox, "unrelated-cwd");
  const home = join(sandbox, "home");
  const agentDir = join(home, ".pi", "agent");
  const npmCache = join(sandbox, "npm-cache");

  try {
    copyPackageSource(packagePath);
    assert.equal(existsSync(join(packagePath, "dist")), false, "the package fixture starts without build output");

    const install = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--omit=dev", "--cache", npmCache, "--no-audit", "--no-fund"],
      {
        cwd: packagePath,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    assert.equal(install.signal, null, childFailure(install));
    assert.equal(install.status, 0, childFailure(install));
    assert.equal(existsSync(join(packagePath, "dist")), false, "production install must not build dist");
    assert.equal(existsSync(join(packagePath, "node_modules", "@biomejs", "biome")), false, "dev tools are omitted");

    const pack = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--json", "--pack-destination", sandbox],
      {
        cwd: packagePath,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    assert.equal(pack.signal, null, childFailure(pack));
    assert.equal(pack.status, 0, childFailure(pack));
    const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
    assert.equal(packed.length, 1, pack.stdout);
    const packageArchive = join(sandbox, packed[0].filename);

    mkdirSync(consumerPath, { recursive: true });
    writeFileSync(join(consumerPath, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const consumerInstall = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--omit=dev",
        "--cache",
        npmCache,
        "--no-audit",
        "--no-fund",
        packageArchive,
        "@earendil-works/pi-coding-agent@0.85.0",
        "@earendil-works/pi-tui@0.85.0",
        // SDK 0.85.0 imports this undeclared dependency even under native Node ESM.
        "@earendil-works/pi-server@0.85.0",
        "typebox@1.3.19",
      ],
      {
        cwd: consumerPath,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    assert.equal(consumerInstall.signal, null, childFailure(consumerInstall));
    assert.equal(consumerInstall.status, 0, childFailure(consumerInstall));

    const installedPackage = join(consumerPath, "node_modules", "@quintinshaw", "pi-dynamic-workflows");
    assert.equal(existsSync(join(installedPackage, "dist")), false, "the packed source install has no dist");

    for (const devTool of ["typescript", "@biomejs/biome"]) {
      assert.equal(existsSync(join(consumerPath, "node_modules", devTool)), false, `${devTool} is not needed`);
    }

    mkdirSync(projectPath, { recursive: true });
    mkdirSync(unrelatedCwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), "{}\n");

    writeFileSync(
      join(projectPath, "finish.mjs"),
      `import { createRequire } from 'node:module'
const fs = createRequire(import.meta.url)('fs')
export function finish(args, cwd) {
  if (!fs.existsSync(cwd)) throw new Error('builtin fs unavailable')
  return { imported: 'relative-helper', value: args.value, cwd }
}
`,
    );
    writeFileSync(
      join(projectPath, "workflow.mjs"),
      `import { finish } from './finish.mjs'
export const meta = { name: 'package_smoke', description: 'Package Node API smoke test' }
export async function run({ args, cwd }) {
  if (args.fail) throw new Error('consumer-workflow-boom')
  args.markEntered()
  await args.gate
  return finish(args, cwd)
}
`,
    );

    const consumerScript = join(consumerPath, "run.mjs");
    writeFileSync(
      consumerScript,
      `import { writeFile } from 'node:fs/promises'
import { runWorkflow } from '@quintinshaw/pi-dynamic-workflows/node-api'

const [mode, projectPath, outputPath] = process.argv.slice(2)
const legacy = await runWorkflow(
  'export const meta = { name: "legacy", description: "Retained low-level API" }; return args.value',
  { args: { value: 'legacy-result' }, persistLogs: false },
)
if (legacy.result !== 'legacy-result') throw new Error('low-level signature lost')
if (mode === 'failure') {
  const completed = await runWorkflow({
    scriptPath: './workflow.mjs',
    cwd: projectPath,
    args: { fail: true, markEntered() {}, gate: Promise.resolve() },
    persistLogs: false,
  })
  await writeFile(outputPath, JSON.stringify(completed.result))
} else {
  let releaseGate
  let markEntered
  const gate = new Promise((resolve) => { releaseGate = resolve })
  const entered = new Promise((resolve) => { markEntered = resolve })
  let settled = false
  const running = runWorkflow({
    scriptPath: './workflow.mjs',
    cwd: projectPath,
    args: { gate, markEntered, value: 'terminal-result' },
    persistLogs: false,
  })
  void running.then(() => { settled = true })
  await entered
  await Promise.resolve()
  if (settled) throw new Error('runWorkflow settled before native workflow completion')
  releaseGate()
  const completed = await running
  await writeFile(outputPath, JSON.stringify({ processCwd: process.cwd(), workflow: completed.result }))
}
`,
    );

    const childEnvironment = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      NO_COLOR: "1",
    };
    const successOutput = join(sandbox, "success.json");
    const success = spawnSync(process.execPath, [consumerScript, "success", projectPath, successOutput], {
      cwd: unrelatedCwd,
      env: childEnvironment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(success.signal, null, childFailure(success));
    assert.equal(success.status, 0, childFailure(success));
    assert.deepEqual(JSON.parse(readFileSync(successOutput, "utf8")), {
      processCwd: realpathSync(unrelatedCwd),
      workflow: {
        imported: "relative-helper",
        value: "terminal-result",
        cwd: projectPath,
      },
    });

    const falseResult = join(sandbox, "false-result.json");
    const failure = spawnSync(process.execPath, [consumerScript, "failure", projectPath, falseResult], {
      cwd: unrelatedCwd,
      env: childEnvironment,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(failure.signal, null, childFailure(failure));
    assert.notEqual(failure.status, 0, "an unhandled workflow rejection must make plain node exit nonzero");
    assert.match(failure.stderr, /consumer-workflow-boom/);
    assert.equal(existsSync(falseResult), false, "a rejected workflow must not write a terminal result");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
