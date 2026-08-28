import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { parse, resolve } from "node:path";
import { type BashOperations, createLocalBashOperations } from "@earendil-works/pi-coding-agent";

export interface MiseCommandOptions {
  cwd: string;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface MiseCommandResult {
  stdout: string;
}

export type MiseCommandRunner = (args: string[], options: MiseCommandOptions) => Promise<MiseCommandResult | undefined>;

type MiseResolution =
  | { kind: "resolved"; environment: NodeJS.ProcessEnv }
  | { kind: "unconfigured" }
  | { kind: "failed" };

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const runMiseCommand: MiseCommandRunner = (args, options) =>
  new Promise((resolveResult) => {
    execFile(
      "mise",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        signal: options.signal,
        env: options.environment,
        timeout: options.timeoutMs,
      },
      (error, stdout) => resolveResult(error ? undefined : { stdout }),
    );
  });

function parseConfigPaths(output: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const paths: string[] = [];
  for (const entry of parsed) {
    const path = (entry as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string") return undefined;
    paths.push(canonicalPath(path));
  }
  return paths;
}

function parseEnvironment(output: string): NodeJS.ProcessEnv | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") return undefined;
    environment[name] = value;
  }
  return environment;
}

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

function timeoutMilliseconds(timeoutSeconds: number | undefined): number | undefined {
  if (timeoutSeconds === undefined) return undefined;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutSeconds * 1000;
}

function remainingTimeout(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - Date.now());
}

async function resolveMise(
  cwd: string,
  signal: AbortSignal | undefined,
  inheritedEnvironment: NodeJS.ProcessEnv | undefined,
  runner: MiseCommandRunner,
  timeoutMs?: number,
): Promise<MiseResolution> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const run = async (args: string[], commandCwd: string): Promise<MiseCommandResult | undefined> => {
    const remaining = remainingTimeout(deadline);
    if (remaining === 0) return undefined;
    try {
      return await runner(args, {
        cwd: commandCwd,
        signal,
        environment: inheritedEnvironment,
        timeoutMs: remaining,
      });
    } catch {
      return undefined;
    }
  };

  const cwdConfigsResult = await run(["config", "ls", "--json", "-C", cwd], cwd);
  if (!cwdConfigsResult) return { kind: "failed" };
  const cwdConfigs = parseConfigPaths(cwdConfigsResult.stdout);
  if (!cwdConfigs) return { kind: "failed" };

  const filesystemRoot = parse(canonicalPath(cwd)).root;
  const globalConfigsResult = await run(["config", "ls", "--json", "-C", filesystemRoot], filesystemRoot);
  if (!globalConfigsResult) return { kind: "failed" };
  const globalConfigs = parseConfigPaths(globalConfigsResult.stdout);
  if (!globalConfigs) return { kind: "failed" };

  const globalPaths = new Set(globalConfigs);
  if (!cwdConfigs.some((path) => !globalPaths.has(path))) return { kind: "unconfigured" };

  const environmentResult = await run(["env", "--json", "-C", cwd], cwd);
  if (!environmentResult) return { kind: "failed" };
  const environment = parseEnvironment(environmentResult.stdout);
  return environment ? { kind: "resolved", environment } : { kind: "failed" };
}

/** Resolve cwd-local mise values once without layering them over the inherited environment. */
export async function resolveMiseEnvironment(
  cwd: string,
  signal?: AbortSignal,
  inheritedEnvironment?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv | undefined> {
  const resolution = await resolveMise(cwd, signal, inheritedEnvironment, runMiseCommand);
  return resolution.kind === "resolved" ? resolution.environment : undefined;
}

/**
 * Bind one subagent's environment. Successful and unconfigured outcomes are
 * stable for that subagent; failed mise attempts fall back and are retried by
 * its next Bash process.
 */
export function createMiseEnvironmentBinding(
  runner: MiseCommandRunner = runMiseCommand,
): (
  cwd: string,
  signal: AbortSignal | undefined,
  inheritedEnvironment: NodeJS.ProcessEnv | undefined,
  timeoutMs?: number,
) => Promise<NodeJS.ProcessEnv | undefined> {
  let cached: Promise<MiseResolution> | undefined;
  return async (cwd, signal, inheritedEnvironment, timeoutMs) => {
    cached ??= resolveMise(cwd, signal, inheritedEnvironment, runner, timeoutMs);
    const resolution = await cached;
    if (resolution.kind === "failed") cached = undefined;
    return resolution.kind === "resolved"
      ? { ...inheritedEnvironment, ...resolution.environment }
      : inheritedEnvironment;
  };
}

/** Bind each Bash child process to the environment owned by its subagent. */
export function createMiseBashOperations(): BashOperations {
  const localOperations = createLocalBashOperations();
  const bindEnvironment = createMiseEnvironmentBinding();
  return {
    async exec(command, cwd, options) {
      const timeoutMs = timeoutMilliseconds(options.timeout);
      const startedAt = Date.now();
      const environment = await bindEnvironment(cwd, options.signal, options.env, timeoutMs);
      const remainingTimeoutSeconds =
        options.timeout === undefined ? undefined : options.timeout - (Date.now() - startedAt) / 1000;
      if (remainingTimeoutSeconds !== undefined && remainingTimeoutSeconds <= 0) {
        throw new Error(`timeout:${options.timeout}`);
      }

      try {
        return await localOperations.exec(command, cwd, {
          ...options,
          timeout: remainingTimeoutSeconds,
          env: environment,
        });
      } catch (error) {
        if (options.timeout !== undefined && (error as Error | undefined)?.message.startsWith("timeout:")) {
          throw new Error(`timeout:${options.timeout}`);
        }
        throw error;
      }
    },
  };
}
