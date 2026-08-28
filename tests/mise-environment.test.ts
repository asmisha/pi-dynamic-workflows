import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMiseBashOperations, resolveMiseEnvironment } from "../src/mise-environment.js";

test("real mise configures the Bash child environment for its cwd", async (t) => {
  if (spawnSync("mise", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("mise is unavailable");
    return;
  }

  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-real-mise-"));
  try {
    mkdirSync(join(cwd, ".mise"));
    writeFileSync(join(cwd, ".mise", "config.toml"), '[env]\nPI_WORKFLOW_SAFE_PROJECT_VALUE = "actual-mise"\n');
    const output: Buffer[] = [];
    const operations = createMiseBashOperations();
    const result = await operations.exec(`printf '%s' "$PI_WORKFLOW_SAFE_PROJECT_VALUE"`, cwd, {
      env: { ...process.env, MISE_TRUSTED_CONFIG_PATHS: cwd },
      onData: (data) => output.push(data),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.concat(output).toString(), "actual-mise");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("mise environment resolution shares the Bash command timeout", async (t) => {
  if (spawnSync("mise", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("mise is unavailable");
    return;
  }

  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-mise-timeout-"));
  try {
    writeFileSync(join(cwd, "mise-source.sh"), "sleep 5\nexport PI_WORKFLOW_SAFE_TIMEOUT_VALUE=too-late\n");
    writeFileSync(join(cwd, "mise.toml"), '[env._]\nsource = "./mise-source.sh"\n');
    const startedAt = Date.now();
    const operations = createMiseBashOperations();

    await assert.rejects(
      () =>
        operations.exec("echo command-should-not-run", cwd, {
          env: { ...process.env, MISE_TRUSTED_CONFIG_PATHS: cwd },
          timeout: 0.2,
          onData() {},
        }),
      /timeout:0.2/,
    );
    assert.ok(Date.now() - startedAt < 2_000, "the mise preflight must not outlive the Bash timeout");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missing mise leaves the subagent environment unresolved without mutating the host", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-no-mise-"));
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.equal(await resolveMiseEnvironment(cwd), undefined);
    assert.equal(process.env.PATH, "");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(cwd, { recursive: true, force: true });
  }
});
