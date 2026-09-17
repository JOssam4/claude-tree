/**
 * Incremental tail indexing: parses and inserts ONLY the new complete lines
 * appended to a session file since its stored `last_byte_offset`. Never
 * re-reads or re-parses bytes already indexed (see tailReader.ts).
 */
import type { DB } from "../db/client.js";
import { createAccumulator, indexRawLine, prepareInsertNodeStmt } from "./lineIndexer.js";
import { readNewCompleteLines } from "./tailReader.js";

export interface TailIndexResult {
  nodeCount: number;
  addedNodeUuids: string[];
  aiTitle: string | null;
  cwd: string | null;
  agentIdToNodeUuid: Map<string, string>;
  warnings: string[];
  /** New value the caller should persist as the session's last_byte_offset. Equal to fromOffset when nothing new/complete was found. */
  newByteOffset: number;
}

function getMaxSeq(db: DB, sessionId: string): number {
  const row = db.prepare(`SELECT MAX(seq) as maxSeq FROM nodes WHERE session_id = ?`).get(sessionId) as {
    maxSeq: number | null;
  };
  return row.maxSeq ?? -1;
}

export function tailIndexFile(db: DB, filePath: string, sessionId: string, fromOffset: number): TailIndexResult {
  const { lines, bytesConsumed } = readNewCompleteLines(filePath, fromOffset);
  const startSeq = getMaxSeq(db, sessionId) + 1;
  const acc = createAccumulator(startSeq);

  if (lines.length > 0) {
    const insertNode = prepareInsertNodeStmt(db);
    lines.forEach((rawLine, i) => indexRawLine(insertNode, sessionId, rawLine, i + 1, filePath, acc));
  }

  return {
    nodeCount: acc.seq - startSeq,
    addedNodeUuids: acc.addedNodeUuids,
    aiTitle: acc.aiTitle ?? acc.titleFallback,
    cwd: acc.cwd,
    agentIdToNodeUuid: acc.agentIdToNodeUuid,
    warnings: acc.warnings,
    newByteOffset: fromOffset + bytesConsumed,
  };
}
