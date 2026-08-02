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

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * A command without its own timeout is killed after this long, process tree
 * included. A wedged command cannot be rescued from inside the shell: a plain
 * `timeout` signals the shell, which only handles it once the hung foreground
 * command returns, so the bound has to live out here.
 */
export const DEFAULT_READ_ONLY_BASH_TIMEOUT_SECONDS = 120;

export interface ReadOnlyBashSession {
  tool?: ToolDefinition;
  cleanup(): void;
}

type SandboxPaths = {
  root: string;
  temp: string;
  profile: string;
};

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
      // The guarantee is "no writes", not isolation: reads and network stay open
      // so remote-log commands (ssh, curl, kubectl) and the toolchain work with
      // the user's real HOME. Writes are confined to /dev/null and the per-agent
      // sandbox directory (which backs $TMPDIR).
      "(allow network*)",
      "(allow file-read*)",
      '(allow file-write* (literal "/dev/null"))',
      `(allow file-write* (subpath ${JSON.stringify(root)}))`,
      "",
    ].join("\n"),
  );
  return { root, temp, profile };
}

/**
 * Build a bash tool whose child process can read the filesystem and reach the
 * network, but can write only to /dev/null and its per-agent scratch directory,
 * and is always time-bounded. Unsupported platforms fail closed by returning no
 * tool instead of exposing Pi's unrestricted built-in bash.
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
  const operations: BashOperations = {
    async exec(command, commandCwd, options) {
      const sandbox = ensurePaths();
      const wrappedCommand = [SANDBOX_EXEC, "-f", sandbox.profile, shell.shell, ...shell.args, command]
        .map(shellQuote)
        .join(" ");
      return localOperations.exec(wrappedCommand, commandCwd, {
        ...options,
        timeout: options.timeout ?? defaultTimeoutSeconds,
        env: {
          ...options.env,
          // HOME stays real so ssh config/keys, CLI credentials, and dotfiles
          // resolve normally; the sandbox profile still blocks writing them.
          TMPDIR: `${sandbox.temp}${sep}`,
          TMP: sandbox.temp,
          TEMP: sandbox.temp,
          XDG_CACHE_HOME: join(sandbox.root, "cache"),
          GIT_OPTIONAL_LOCKS: "0",
        },
      });
    },
  };
  const tool = createBashToolDefinition(cwd, { operations });
  tool.description = `${tool.description} Reads and network access work normally (ssh, curl, remote logs), but all writes outside $TMPDIR are blocked: the repository, $HOME, and the rest of the host are not writable, so commands that must persist files will fail. A command without its own timeout is killed after ${defaultTimeoutSeconds} seconds.`;

  return {
    tool: tool as unknown as ToolDefinition,
    cleanup() {
      if (!paths) return;
      rmSync(paths.root, { recursive: true, force: true });
      paths = undefined;
    },
  };
}
