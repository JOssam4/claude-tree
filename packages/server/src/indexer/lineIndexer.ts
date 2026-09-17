/**
 * Shared per-line parse-and-insert logic for turning one raw JSONL line into
 * a `nodes` row. This is the single place that logic lives — the full-file
 * backfill pass (backfill.ts), fresh-file watcher indexing, and incremental
 * tail indexing (tailIndexer.ts) all call `indexRawLine` so their node-shape /
 * title / cwd / sidechain-join-key extraction can never drift out of sync.
 */
import type Database from "better-sqlite3";
import type { DB } from "../db/client.js";
import { parseLine } from "./jsonlParser.js";

export const TITLE_FALLBACK_MAX_LEN = 200;

/** Running state threaded through repeated `indexRawLine` calls for one session's worth of (possibly partial) lines. */
export interface LineIndexAccumulator {
  /** Next `seq` value to assign. Callers seed this at 0 for a full file, or (current max seq + 1) for a tail continuation. */
  seq: number;
  createdAt: string | null;
  aiTitle: string | null;
  titleFallback: string | null;
  cwd: string | null;
  /** {toolUseResult.agentId -> node uuid}, for later subagent sidechain joins. */
  agentIdToNodeUuid: Map<string, string>;
  /** uuids that were ACTUALLY newly inserted (changes > 0), not ones ignored as already-present duplicates. */
  addedNodeUuids: string[];
  warnings: string[];
}

export function createAccumulator(startSeq: number): LineIndexAccumulator {
  return {
    seq: startSeq,
    createdAt: null,
    aiTitle: null,
    titleFallback: null,
    cwd: null,
    agentIdToNodeUuid: new Map(),
    addedNodeUuids: [],
    warnings: [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function prepareInsertNodeStmt(db: DB): Database.Statement {
  // uuid is PRIMARY KEY; OR IGNORE makes re-indexing (backfill re-runs, a
  // watcher restart, or a compaction re-index) idempotent — historical lines
  // are immutable once written, so a duplicate insert is simply a no-op.
  return db.prepare(
    `INSERT OR IGNORE INTO nodes (uuid, session_id, parent_uuid, type, role, content_text, content_raw, timestamp, seq)
     VALUES (@uuid, @sessionId, @parentUuid, @type, @role, @contentText, @contentRaw, @timestamp, @seq)`,
  );
}

/**
 * Parses and inserts ONE raw JSONL line for `sessionId`, mutating `acc` in
 * place. `rawLine` must already be a single complete line (no embedded
 * newline, trailing newline optional) — callers are responsible for only
 * ever passing confirmed-complete lines (see tailReader.ts for the
 * incomplete-trailing-line handling on the watcher's tail path).
 */
export function indexRawLine(
  insertNode: Database.Statement,
  sessionId: string,
  rawLine: string,
  lineNo: number,
  filePath: string,
  acc: LineIndexAccumulator,
): void {
  if (rawLine.trim().length === 0) return;
  const parsed = parseLine(rawLine);

  if (parsed.kind === "error") {
    acc.warnings.push(`${filePath}:${lineNo}: ${parsed.message}`);
    return;
  }
  if (parsed.kind === "title") {
    acc.aiTitle = parsed.aiTitle;
    return;
  }
  if (parsed.kind === "ignore") return;

  // parsed.kind === "chain"
  if (acc.createdAt === null) acc.createdAt = parsed.timestamp || nowIso();
  if (acc.cwd === null && parsed.cwd) acc.cwd = parsed.cwd;
  if (acc.titleFallback === null && parsed.type === "user" && parsed.contentText) {
    acc.titleFallback = parsed.contentText.slice(0, TITLE_FALLBACK_MAX_LEN);
  }
  // See sidechainLinker.ts: undocumented join key for Task subagent sidechains.
  if (parsed.toolUseResultAgentId) {
    acc.agentIdToNodeUuid.set(parsed.toolUseResultAgentId, parsed.uuid);
  }

  const info = insertNode.run({
    uuid: parsed.uuid,
    sessionId,
    parentUuid: parsed.parentUuid,
    type: parsed.type,
    role: parsed.role,
    contentText: parsed.contentText,
    contentRaw: parsed.raw,
    timestamp: parsed.timestamp,
    seq: acc.seq++,
  });
  if (info.changes > 0) acc.addedNodeUuids.push(parsed.uuid);
}
