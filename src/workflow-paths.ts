/**
 * Filesystem layout for pi-dynamic-workflows state.
 *
 * New writes live under the user's workflow home so projects do not get
 * scattered `.pi/workflows` directories. Project-scoped state is still isolated
 * by a stable cwd-derived namespace.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { WORKFLOW_RUNS_DIR, WORKFLOW_SAVED_DIR } from "./config.js";

export const WORKFLOW_HOME_RELATIVE_DIR = ".pi/workflows";
export const WORKFLOW_PROJECTS_SUBDIR = "projects";

export interface WorkflowProjectPaths {
  key: string;
  rootDir: string;
  runsDir: string;
  savedDir: string;
  settingsPath: string;
  legacyRunsDir: string;
  legacySavedDir: string;
}

export function workflowHomeDir(): string {
  return join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
}

export function workflowUserSavedDir(): string {
  return join(workflowHomeDir(), "saved");
}

/** Dedicated home for persisted subagent sessions (~/.pi/workflows/sessions). */
export function workflowSessionsDir(): string {
  return join(workflowHomeDir(), "sessions");
}

/**
 * Session persistence path rules for agent({ sessionPath }):
 *   - absolute path → used as-is
 *   - `~/...`       → home-expanded
 *   - anything else (bare name or relative path) → lands under the dedicated
 *     sessions dir (~/.pi/workflows/sessions/) so persisted subagent sessions
 *     never scatter across project checkouts
 * A `.jsonl` extension is appended when missing so the file is always a valid
 * Pi session file target. Resolution is deterministic, so the same input
 * yields the same path across resumes (resume-journal identity relies on it).
 */
export function resolveWorkflowSessionPath(raw: string): string {
  const trimmed = raw.trim();
  const withExt = trimmed.endsWith(".jsonl") ? trimmed : `${trimmed}.jsonl`;
  if (withExt.startsWith("~/")) return join(homedir(), withExt.slice(2));
  if (isAbsolute(withExt)) return withExt;
  return join(workflowSessionsDir(), withExt);
}

export function workflowProjectKey(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = sanitizePathSegment(basename(projectPath) || "project");
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

export function workflowProjectPaths(cwd: string): WorkflowProjectPaths {
  const key = workflowProjectKey(cwd);
  const rootDir = join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR, key);
  return {
    key,
    rootDir,
    runsDir: join(rootDir, "runs"),
    savedDir: join(rootDir, "saved"),
    settingsPath: join(rootDir, "settings.json"),
    legacyRunsDir: resolve(cwd, WORKFLOW_RUNS_DIR),
    legacySavedDir: resolve(cwd, WORKFLOW_SAVED_DIR),
  };
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "project";
}
