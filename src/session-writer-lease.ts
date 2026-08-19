import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const OWNER_FILE = "owner.lock";
const RECOVERY_PREFIX = "recovery-";

function lockDirectory(): string {
  const owner = typeof process.getuid === "function" ? process.getuid() : (process.env.USER ?? "default");
  return join(tmpdir(), `pi-dynamic-workflows-${owner}`, "session-locks");
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

/**
 * Recovery markers prevent a stale-owner cleanup from racing a new owner into
 * the same fixed lock path. Dead markers are safe to remove because their paths
 * are unique and never reused.
 */
function recoveryInProgress(scope: string): boolean {
  let busy = false;
  for (const name of readdirSync(scope)) {
    if (!name.startsWith(RECOVERY_PREFIX) || !name.endsWith(".lock")) continue;
    const path = join(scope, name);
    const marker = readLock(path);
    if (!marker) {
      busy = true;
      continue;
    }
    if (pidIsAlive(marker.pid)) {
      busy = true;
      continue;
    }
    try {
      removeFile(path);
    } catch {
      busy = true;
    }
  }
  return busy;
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
 */
export async function acquireSessionWriterLease(
  rawSessionPath: string,
  signal?: AbortSignal,
): Promise<SessionWriterLease> {
  const sessionPath = resolve(rawSessionPath);
  const scope = lockScope(sessionPath);
  const ownerPath = join(scope, OWNER_FILE);
  mkdirSync(scope, { recursive: true, mode: 0o700 });

  while (true) {
    if (signal?.aborted) throw abortError();
    if (recoveryInProgress(scope)) {
      await waitToRetry(signal);
      continue;
    }

    const token = `${process.pid}-${randomUUID()}`;
    if (publishLock(ownerPath, lockPayload(sessionPath, token))) {
      // A stale-owner recovery may have started after the pre-check. Never open
      // the session until every such cleanup has finished.
      if (recoveryInProgress(scope)) {
        releaseOwnedLock(ownerPath, token);
        await waitToRetry(signal);
        continue;
      }
      if (signal?.aborted) {
        releaseOwnedLock(ownerPath, token);
        throw abortError();
      }

      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          releaseOwnedLock(ownerPath, token);
        },
      };
    }

    const existing = readLock(ownerPath);
    if (existing && !pidIsAlive(existing.pid)) {
      const recoveryToken = `${process.pid}-${randomUUID()}`;
      const recoveryPath = join(scope, `${RECOVERY_PREFIX}${recoveryToken}.lock`);
      if (publishLock(recoveryPath, lockPayload(sessionPath, recoveryToken))) {
        try {
          const current = readLock(ownerPath);
          if (current?.token === existing.token && !pidIsAlive(current.pid)) removeFile(ownerPath);
        } finally {
          removeFile(recoveryPath);
        }
        continue;
      }
    }

    // An unreadable owner may still be in use by an older process publishing
    // non-atomically. Treat it as owned rather than risking a second writer.
    await waitToRetry(signal);
  }
}
