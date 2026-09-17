/**
 * Small builders for synthetic Claude Code .jsonl fixture content, shared
 * across test files. Deliberately minimal — just enough shape to exercise the
 * parser/indexer/forker, not a full replica of every real field.
 */
import fs from "node:fs";
import path from "node:path";

export interface ChainLineOpts {
  uuid: string;
  parentUuid: string | null;
  type?: "user" | "assistant" | "system" | "attachment";
  role?: string;
  text?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  agentId?: string;
  /** Sets `toolUseResult: { agentId }` on this line — the undocumented sidechain join key. */
  toolUseResultAgentId?: string;
  extra?: Record<string, unknown>;
}

/** Builds one raw chain-participating JSONL line (user/assistant/system/attachment). */
export function chainLine(opts: ChainLineOpts): string {
  const type = opts.type ?? "user";
  const line: Record<string, unknown> = {
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    type,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.isSidechain !== undefined ? { isSidechain: opts.isSidechain } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.text !== undefined
      ? { message: { role: opts.role ?? (type === "assistant" ? "assistant" : "user"), content: opts.text } }
      : {}),
    ...(opts.toolUseResultAgentId ? { toolUseResult: { agentId: opts.toolUseResultAgentId } } : {}),
    ...(opts.extra ?? {}),
  };
  return JSON.stringify(line);
}

/** Builds a non-chain metadata line (mode, permission-mode, file-history-snapshot, cost-state, etc.) — no uuid field. */
export function metadataLine(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}

/** Builds an `ai-title` line. */
export function aiTitleLine(title: string): string {
  return JSON.stringify({ type: "ai-title", aiTitle: title });
}

/** Joins lines with trailing newlines (matching real Claude Code .jsonl files) and writes them, creating parent dirs as needed. */
export function writeJsonlFile(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map((l) => `${l}\n`).join(""));
}
