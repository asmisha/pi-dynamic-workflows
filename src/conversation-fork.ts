import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { RunStatus } from "./run-persistence.js";
import { acquireSessionWriterLease } from "./session-writer-lease.js";

export interface ConversationForkState {
  command: "fork" | "continue";
  /** Absolute path to the persistent child Pi JSONL session. */
  childSessionPath: string;
  /** Explicit task/instruction supplied to the slash command. */
  task: string;
  /** Active parent-tree leaf when the command was started; null is the tree root. */
  parentLeafId: string | null;
}

export interface ParentSessionSnapshotSource {
  getBranch(): SessionEntry[];
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

/**
 * Copy only the parent's active root-to-leaf path into a new persistent session.
 * The source manager and source JSONL file are read-only throughout.
 */
export async function snapshotActiveConversationBranch(
  source: ParentSessionSnapshotSource,
  targetPath: string,
  options: {
    cwd: string;
    model?: { provider: string; id: string };
    thinkingLevel?: string;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  const header = {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id: randomUUID(),
    timestamp,
    cwd: options.cwd,
    parentSession: source.getSessionFile(),
  };
  const branch = source.getBranch();
  const content = `${[header, ...branch].map((entry) => JSON.stringify(entry)).join("\n")}\n`;

  const lease = await acquireSessionWriterLease(targetPath);
  let created = false;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, { flag: "wx" });
    created = true;
    const child = SessionManager.open(targetPath, undefined, options.cwd);
    // Record the command-time settings in the child itself. Initial execution
    // then follows normal createAgentSession restoration, and later continuations
    // restore whatever model/thinking state the child most recently saved.
    if (options.model) child.appendModelChange(options.model.provider, options.model.id);
    if (options.thinkingLevel) child.appendThinkingLevelChange(options.thinkingLevel);
  } catch (error) {
    if (created) {
      try {
        unlinkSync(targetPath);
      } catch {
        // Cleanup is best-effort after this call created the target.
      }
    }
    throw error;
  } finally {
    lease.release();
  }
}

export function buildConversationForkScript(state: ConversationForkState): string {
  const prompt =
    state.command === "fork"
      ? `Continue from the inherited parent Pi conversation in this persistent session and execute this explicit task:\n\n${state.task}`
      : `Continue this persistent Pi conversation from its saved state and execute this explicit instruction:\n\n${state.task}`;
  const name = state.command === "fork" ? "conversation_fork" : "conversation_continuation";
  const description =
    state.command === "fork" ? "Persistent conversation fork" : "Persistent conversation continuation";
  return `export const meta = ${JSON.stringify({ name, description, phases: [{ title: "Work" }] })}
phase('Work')
const result = await agent(${JSON.stringify(prompt)}, { label: ${JSON.stringify(name)}, sessionPath: ${JSON.stringify(
    state.childSessionPath,
  )}, retryable: false })
return result`;
}

function formatResult(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

export function conversationForkDeliveryText(
  runId: string,
  status: Extract<RunStatus, "completed" | "failed" | "aborted">,
  state: ConversationForkState,
  result?: unknown,
  error?: string,
): string {
  const label = state.command === "fork" ? "Conversation fork" : "Conversation continuation";
  const lines = [
    `${status === "completed" ? "✓" : status === "failed" ? "✗" : "⊘"} ${label} ${runId} ${status}.`,
    `Task: ${state.task}`,
  ];
  const resultText = formatResult(result);
  if (resultText) lines.push(`Result:\n${resultText}`);
  if (error) lines.push(`Error: ${error}`);
  lines.push(`Child session: ${state.childSessionPath}`);
  return lines.join("\n\n");
}
