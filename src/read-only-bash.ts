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

export interface ReadOnlyBashSession {
  tool?: ToolDefinition;
  cleanup(): void;
}

type SandboxPaths = {
  root: string;
  home: string;
  temp: string;
  profile: string;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createSandboxPaths(): SandboxPaths {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-readonly-bash-")));
  const home = join(root, "home");
  const temp = join(root, "tmp");
  const profile = join(root, "sandbox.sb");
  mkdirSync(home);
  mkdirSync(temp);
  writeFileSync(
    profile,
    [
      "(version 1)",
      "(deny default)",
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow file-read*)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      '(allow file-write* (literal "/dev/null"))',
      `(allow file-write* (subpath ${JSON.stringify(root)}))`,
      "",
    ].join("\n"),
  );
  return { root, home, temp, profile };
}

/**
 * Build a bash tool whose child process can read the host filesystem but can
 * write only to its per-agent HOME/TMPDIR. Unsupported platforms fail closed by
 * returning no tool instead of exposing Pi's unrestricted built-in bash.
 */
export function createReadOnlyBashSession(cwd: string): ReadOnlyBashSession {
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
        env: {
          ...options.env,
          HOME: sandbox.home,
          TMPDIR: `${sandbox.temp}${sep}`,
          TMP: sandbox.temp,
          TEMP: sandbox.temp,
          XDG_CACHE_HOME: join(sandbox.home, ".cache"),
          GIT_OPTIONAL_LOCKS: "0",
        },
      });
    },
  };
  const tool = createBashToolDefinition(cwd, { operations });
  tool.description = `${tool.description} Repository and host writes are blocked; temporary writes are allowed only under $HOME and $TMPDIR.`;

  return {
    tool: tool as unknown as ToolDefinition,
    cleanup() {
      if (!paths) return;
      rmSync(paths.root, { recursive: true, force: true });
      paths = undefined;
    },
  };
}
