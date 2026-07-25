import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/**
 * User-home trees that hold executables the shell legitimately needs (nvm's node,
 * user-installed CLIs). Everything else under the home directory stays unreadable.
 */
function toolReadRoots(): string[] {
  const home = homedir();
  return [join(home, ".nvm"), join(home, ".local"), join(home, ".bun"), "/opt/homebrew"].filter((path) =>
    existsSync(path),
  );
}

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

function createSandboxPaths(readRoots: string[]): SandboxPaths {
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
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      // Reads: system trees for the toolchain, then nothing under user data except
      // the review target and the sandbox itself. Later rules win, so the denies
      // carve the user's home and mounted volumes out of the broad allow, and the
      // explicit allows carve the target back in. A denied read fails immediately;
      // a filesystem-wide scan can no longer wander into a tree that blocks.
      "(allow file-read*)",
      '(deny file-read* (subpath "/Users"))',
      '(deny file-read* (subpath "/Volumes"))',
      '(deny file-read* (subpath "/System/Volumes/Data"))',
      `(allow file-read* (subpath ${JSON.stringify(root)}))`,
      ...readRoots.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`),
      '(allow file-write* (literal "/dev/null"))',
      `(allow file-write* (subpath ${JSON.stringify(root)}))`,
      "",
    ].join("\n"),
  );
  return { root, home, temp, profile };
}

/**
 * Build a bash tool whose child process can read the review target and the
 * toolchain but nothing else under the user's home, can write only to its
 * per-agent HOME/TMPDIR, and is always time-bounded. Unsupported platforms fail
 * closed by returning no tool instead of exposing Pi's unrestricted built-in bash.
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
  const readRoots = [...new Set([realpathSync(cwd), ...toolReadRoots()])];
  const ensurePaths = () => (paths ??= createSandboxPaths(readRoots));
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
  tool.description = `${tool.description} Reads are limited to this repository and the toolchain: paths elsewhere under the user's home, and mounted volumes, are unreadable, so a filesystem-wide search returns nothing. Repository and host writes are blocked; temporary writes are allowed only under $HOME and $TMPDIR. A command without its own timeout is killed after ${defaultTimeoutSeconds} seconds.`;

  return {
    tool: tool as unknown as ToolDefinition,
    cleanup() {
      if (!paths) return;
      rmSync(paths.root, { recursive: true, force: true });
      paths = undefined;
    },
  };
}
