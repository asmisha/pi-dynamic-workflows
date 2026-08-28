import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  getShellConfig,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createMiseEnvironmentBinding, type MiseCommandOptions, type MiseCommandResult } from "./mise-environment.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * A command without its own timeout is killed after this long, process tree
 * included. A wedged command cannot be rescued from inside the shell: a plain
 * `timeout` signals the shell, which only handles it once the hung foreground
 * command returns, so the bound has to live out here.
 */
export const DEFAULT_READ_ONLY_BASH_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

export interface ReadOnlyBashSession {
  tool?: ToolDefinition;
  cleanup(): void;
}

type SandboxPaths = {
  root: string;
  temp: string;
  profile: string;
};

function sandboxEnvironment(environment: NodeJS.ProcessEnv | undefined, sandbox: SandboxPaths): NodeJS.ProcessEnv {
  return {
    ...environment,
    // HOME stays real so ssh config/keys, CLI credentials, and dotfiles
    // resolve normally; the sandbox profile still blocks writing them.
    TMPDIR: `${sandbox.temp}${sep}`,
    TMP: sandbox.temp,
    TEMP: sandbox.temp,
    XDG_CACHE_HOME: join(sandbox.root, "cache"),
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function runSandboxedMise(
  profile: string,
  args: string[],
  options: MiseCommandOptions,
): Promise<MiseCommandResult | undefined> {
  return new Promise((resolveResult) => {
    let settled = false;
    let output = "";
    const child = spawn(SANDBOX_EXEC, ["-f", profile, "mise", ...args], {
      cwd: options.cwd,
      env: options.environment,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(kill, Math.max(1, options.timeoutMs));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
    };
    const finish = (result?: MiseCommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(result);
    };

    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.on("error", () => finish());
    child.on("close", (code) => finish(code === 0 ? { stdout: output } : undefined));
    if (options.signal?.aborted) kill();
    else options.signal?.addEventListener("abort", kill, { once: true });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createSandboxPaths(): SandboxPaths {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-readonly-bash-")));
  const temp = join(root, "tmp");
  const profile = join(root, "sandbox.sb");
  mkdirSync(temp);
  writeFileSync(
    profile,
    [
      "(version 1)",
      "(deny default)",
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      // The guarantee is "no durable host writes", not isolation: reads and
      // network stay open so remote-log commands (ssh, curl, kubectl) and the
      // toolchain work with the user's real HOME. Writes are confined to
      // /dev/null, the per-agent sandbox directory (which backs $TMPDIR), and
      // the shared /tmp so agents can persist temporary artifacts that other
      // agents or the host read after this agent finishes.
      "(allow network*)",
      "(allow file-read*)",
      '(allow file-write* (literal "/dev/null"))',
      '(allow file-write* (subpath "/private/tmp"))',
      `(allow file-write* (subpath ${JSON.stringify(root)}))`,
      "",
    ].join("\n"),
  );
  return { root, temp, profile };
}

/**
 * Build a bash tool whose child process can read the filesystem and reach the
 * network, but can write only to /dev/null, the shared /tmp, and its per-agent
 * scratch directory, and is always time-bounded. Unsupported platforms fail
 * closed by returning no tool instead of exposing Pi's unrestricted built-in
 * bash.
 */
export function createReadOnlyBashSession(
  cwd: string,
  { defaultTimeoutSeconds = DEFAULT_READ_ONLY_BASH_TIMEOUT_SECONDS }: { defaultTimeoutSeconds?: number } = {},
): ReadOnlyBashSession {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
    return { cleanup() {} };
  }

  const localOperations = createLocalBashOperations();
  const shell = getShellConfig();
  let paths: SandboxPaths | undefined;
  const ensurePaths = () => (paths ??= createSandboxPaths());
  const bindEnvironment = createMiseEnvironmentBinding((args, options) => {
    const sandbox = ensurePaths();
    return runSandboxedMise(sandbox.profile, args, {
      ...options,
      environment: sandboxEnvironment(options.environment, sandbox),
    });
  });
  const operations: BashOperations = {
    async exec(command, commandCwd, options) {
      const sandbox = ensurePaths();
      const timeoutSeconds = options.timeout ?? defaultTimeoutSeconds;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
        throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
      }
      const startedAt = Date.now();
      const environment = await bindEnvironment(commandCwd, options.signal, options.env, timeoutSeconds * 1000);
      const remainingTimeoutSeconds = timeoutSeconds - (Date.now() - startedAt) / 1000;
      if (remainingTimeoutSeconds <= 0) throw new Error(`timeout:${timeoutSeconds}`);

      const wrappedCommand = [SANDBOX_EXEC, "-f", sandbox.profile, shell.shell, ...shell.args, command]
        .map(shellQuote)
        .join(" ");
      try {
        return await localOperations.exec(wrappedCommand, commandCwd, {
          ...options,
          timeout: remainingTimeoutSeconds,
          env: sandboxEnvironment(environment, sandbox),
        });
      } catch (error) {
        if ((error as Error | undefined)?.message.startsWith("timeout:")) {
          throw new Error(`timeout:${timeoutSeconds}`);
        }
        throw error;
      }
    },
  };
  const tool = createBashToolDefinition(cwd, { operations });
  tool.description = `${tool.description} Reads and network access work normally (ssh, curl, remote logs), but writes are confined to /tmp and $TMPDIR: the repository, $HOME, and the rest of the host are not writable. $TMPDIR is a private scratch directory deleted when this agent finishes; write files that must outlive this agent or be shared with other agents under /tmp. A command without its own timeout is killed after ${defaultTimeoutSeconds} seconds.`;

  return {
    tool: tool as unknown as ToolDefinition,
    cleanup() {
      if (!paths) return;
      rmSync(paths.root, { recursive: true, force: true });
      paths = undefined;
    },
  };
}
