import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

interface SessionWriterLockFile {
  sessionPath: string;
  pid: number;
  token: string;
  startedAt: string;
}

export interface SessionWriterLease {
  release(): void;
}

const RETRY_MS = 25;
const GENERATION_PATTERN = /^owner-(\d+)\.lock$/;

function lockDirectory(): string {
  const owner = typeof process.getuid === "function" ? process.getuid() : (process.env.USER ?? "default");
  return join(tmpdir(), `pi-dynamic-workflows-${owner}`, "session-locks");
}

/** Resolve symlink and relative-path aliases so one session file maps to one lock scope. */
function canonicalSessionPath(rawSessionPath: string): string {
  const resolved = resolve(rawSessionPath);
  try {
    return realpathSync(resolved);
  } catch {
    // The session file may not exist yet; canonicalize its directory instead.
    try {
      return join(realpathSync(dirname(resolved)), basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function lockScope(sessionPath: string): string {
  const key = createHash("sha256").update(sessionPath).digest("hex");
  return join(lockDirectory(), key);
}

function readLock(path: string): SessionWriterLockFile | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionWriterLockFile>;
    if (
      typeof value.sessionPath !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.token !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      return undefined;
    }
    return value as SessionWriterLockFile;
  } catch {
    return undefined;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function abortError(): Error {
  const error = new Error("Session writer lease acquisition was aborted");
  error.name = "AbortError";
  return error;
}

function waitToRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(finish, RETRY_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Publish a complete lock payload atomically, without replacing an existing lock. */
function publishLock(path: string, payload: SessionWriterLockFile): boolean {
  const candidatePath = `${path}.${payload.token}.candidate`;
  try {
    writeFileSync(candidatePath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
    try {
      linkSync(candidatePath, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      removeFile(candidatePath);
    } catch {
      // A leftover candidate is never consulted for ownership.
    }
  }
}

function releaseOwnedLock(path: string, token: string): void {
  try {
    if (readLock(path)?.token === token) removeFile(path);
  } catch {
    // A contender will observe the still-owned lock and keep waiting.
  }
}

function currentGeneration(scope: string): { generation: number; path: string } | undefined {
  let latest: { generation: number; path: string } | undefined;
  for (const name of readdirSync(scope)) {
    const match = GENERATION_PATTERN.exec(name);
    if (!match) continue;
    const generation = Number(match[1]);
    if (!latest || generation > latest.generation) latest = { generation, path: join(scope, name) };
  }
  return latest;
}

function lockPayload(sessionPath: string, token: string): SessionWriterLockFile {
  return {
    sessionPath,
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Acquire exclusive cross-process ownership of a persistent Pi session file.
 * Contenders wait until the current owner releases after its AgentSession cleanup.
 *
 * The session is owned by whichever process created the highest-numbered
 * `owner-<n>.lock` generation in the session's lock scope. Every claim — first
 * acquisition or succession after a released or crashed owner — is an exclusive
 * create of the next generation name, so the filesystem picks exactly one winner,
 * and no process ever unlinks a file it did not create: a live owner cannot lose
 * its lock. Generations left by crashed owners stay in place as tmpdir litter
 * rather than becoming recovery work.
 */
export async function acquireSessionWriterLease(
  rawSessionPath: string,
  signal?: AbortSignal,
): Promise<SessionWriterLease> {
  const sessionPath = canonicalSessionPath(rawSessionPath);
  const scope = lockScope(sessionPath);
  mkdirSync(scope, { recursive: true, mode: 0o700 });

  while (true) {
    if (signal?.aborted) throw abortError();

    const latest = currentGeneration(scope);
    if (latest) {
      const owner = readLock(latest.path);
      // An unreadable owner lock is treated as live: never risk a second writer.
      if (!owner || pidIsAlive(owner.pid)) {
        await waitToRetry(signal);
        continue;
      }
    }

    const generationPath = join(scope, `owner-${(latest?.generation ?? 0) + 1}.lock`);
    const token = `${process.pid}-${randomUUID()}`;
    if (!publishLock(generationPath, lockPayload(sessionPath, token))) continue;

    if (signal?.aborted) {
      releaseOwnedLock(generationPath, token);
      throw abortError();
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        releaseOwnedLock(generationPath, token);
      },
    };
  }
}
