import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadOnlyBashSession } from "../src/read-only-bash.js";

const macOnly = { skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec") };

async function runBash(
  tool: NonNullable<ReturnType<typeof createReadOnlyBashSession>["tool"]>,
  command: string,
): Promise<string> {
  const result = await (tool.execute as (...args: any[]) => Promise<any>)(
    "test-call",
    { command },
    new AbortController().signal,
    () => {},
    // The bash tool reads session identity for PI_SESSION_* env vars; a real run
    // always has a session manager, so stub the two accessors it touches.
    { hasUI: false, sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined } },
  );
  return result.content.map((item: { text?: string }) => item.text ?? "").join("\n");
}

test("read-only bash supports Git reads and isolated temporary writes", macOnly, async () => {
  const repo = mkdtempSync(join(tmpdir(), "readonly-bash-repo-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
    writeFileSync(join(repo, "tracked.txt"), "tracked\n");
    execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);

    const sandbox = createReadOnlyBashSession(repo);
    assert.ok(sandbox.tool);
    try {
      const gitOutput = await runBash(
        sandbox.tool,
        "git status --short; git log -1 --oneline; git show --stat --oneline HEAD",
      );
      assert.match(gitOutput, /initial/);

      await runBash(sandbox.tool, 'printf "persisted" > "$TMPDIR/result.txt"');
      const tempOutput = await runBash(sandbox.tool, 'cat "$TMPDIR/result.txt"; printf "\\n%s" "$TMPDIR"');
      assert.match(tempOutput, /persisted/);
      const sandboxTemp = tempOutput.trim().split("\n").at(-1);
      assert.ok(sandboxTemp && existsSync(sandboxTemp));

      sandbox.cleanup();
      assert.equal(existsSync(sandboxTemp), false);
    } finally {
      sandbox.cleanup();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("read-only bash allows shell network access", macOnly, async () => {
  const repo = mkdtempSync(join(tmpdir(), "readonly-bash-network-"));
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.end("reachable");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const sandbox = createReadOnlyBashSession(repo);
  assert.ok(sandbox.tool);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const output = await runBash(
      sandbox.tool,
      `/usr/bin/curl --http0.9 --max-time 5 --silent --show-error http://127.0.0.1:${address.port} 2>&1 || true`,
    );
    assert.match(output, /reachable/);
  } finally {
    sandbox.cleanup();
    // Destroy lingering connection sockets: server.close() alone waits for them
    // and can hang the test runner even after the client has exited.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  }
});

test("read-only bash blocks repository writes from shells, Python, Node, and symlinks", macOnly, async () => {
  const repo = mkdtempSync(join(tmpdir(), "readonly-bash-deny-"));
  try {
    execFileSync("git", ["init", "-q", repo]);
    const sandbox = createReadOnlyBashSession(repo);
    assert.ok(sandbox.tool);
    try {
      await runBash(
        sandbox.tool,
        [
          "touch shell-write 2>/dev/null || true",
          'sh -c "touch child-write" 2>/dev/null || true',
          `python3 -c 'open(${JSON.stringify(join(repo, "python-write"))}, "w").write("x")' 2>/dev/null || true`,
          `node -e 'require("fs").writeFileSync(${JSON.stringify(join(repo, "node-write"))}, "x")' 2>/dev/null || true`,
          `ln -s ${JSON.stringify(join(repo, "symlink-write"))} "$TMPDIR/link"`,
          'printf x > "$TMPDIR/link" 2>/dev/null || true',
          "touch .git/git-write 2>/dev/null || true",
        ].join("; "),
      );

      for (const path of [
        "shell-write",
        "child-write",
        "python-write",
        "node-write",
        "symlink-write",
        ".git/git-write",
      ]) {
        assert.equal(existsSync(join(repo, path)), false, `${path} must remain absent`);
      }
    } finally {
      sandbox.cleanup();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("read-only bash reads the real home but cannot write to it", macOnly, async () => {
  const repo = mkdtempSync(join(tmpdir(), "readonly-bash-scope-"));
  const outside = mkdtempSync(join(homedir(), "readonly-bash-outside-"));
  try {
    writeFileSync(join(repo, "inside.txt"), "inside\n");
    writeFileSync(join(outside, "config.txt"), "home-config\n");

    const sandbox = createReadOnlyBashSession(repo);
    assert.ok(sandbox.tool);
    try {
      assert.match(await runBash(sandbox.tool, "cat inside.txt"), /inside/);

      // HOME is not overridden: real dotfiles/configs (e.g. ~/.ssh) stay readable.
      const homeRead = await runBash(
        sandbox.tool,
        `printf "%s\\n" "$HOME"; cat ${JSON.stringify(join(outside, "config.txt"))}`,
      );
      assert.match(homeRead, new RegExp(`^${homedir().replaceAll(".", "\\.")}$`, "m"));
      assert.match(homeRead, /home-config/);

      // But writes to the real home are still blocked.
      await runBash(sandbox.tool, `touch ${JSON.stringify(join(outside, "home-write"))} 2>/dev/null || true`);
      assert.equal(existsSync(join(outside, "home-write")), false);
    } finally {
      sandbox.cleanup();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("read-only bash kills a command that outlives the default timeout", macOnly, async () => {
  const repo = mkdtempSync(join(tmpdir(), "readonly-bash-timeout-"));
  try {
    const sandbox = createReadOnlyBashSession(repo, { defaultTimeoutSeconds: 1 });
    assert.ok(sandbox.tool);
    try {
      const startedAt = Date.now();
      // The shell would never handle a signal while `sleep` holds the foreground,
      // so the bound must kill the whole process tree from outside. The agent sees
      // an explicit timeout error instead of waiting forever.
      await assert.rejects(() => runBash(sandbox.tool, "sleep 30; echo finished"), /timed out after 1 seconds/);
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 15_000, `expected an early kill, took ${elapsedMs}ms`);
      assert.equal(execFileSync("/bin/sh", ["-c", "pgrep -f 'sleep 30' | wc -l"]).toString().trim(), "0");
    } finally {
      sandbox.cleanup();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
