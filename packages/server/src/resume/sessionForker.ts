/**
 * Milestone 5's core mechanism: forks a target node's conversation history
 * into a brand-new, independently-resumable Claude Code session file.
 *
 * This module is the ONE place in the entire codebase allowed to write under
 * ~/.claude — and even here, it may ONLY ever CREATE a fresh file at a new
 * UUID path (see forkSessionFromNode below). It never opens an existing file
 * under ~/.claude for writing, truncating, appending, deleting, or renaming.
 * Every other module remains strictly read-only against ~/.claude, unchanged.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS_DIR } from "../config.js";
import type { DB } from "../db/client.js";

const NEWLINE = 0x0a;

/** Returns true iff `lineBuf` parses as JSON with a top-level `uuid` field equal to `targetUuid`. */
function lineMatchesUuid(lineBuf: Buffer, targetUuid: string): boolean {
  const text = lineBuf.toString("utf-8").trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as { uuid?: unknown };
    return typeof parsed.uuid === "string" && parsed.uuid === targetUuid;
  } catch {
    // Non-JSON or JSON without a uuid field — never a chain line, so it can't be the target we're cutting at.
    return false;
  }
}

/**
 * Streams the ORIGINAL session .jsonl file and returns every line up to and
 * including the one whose `uuid` equals `targetUuid`, concatenated exactly
 * as they appear on disk.
 *
 * Deliberately reads the raw file rather than reassembling from the `nodes`
 * table (which has content_raw per chain node): real session files interleave
 * non-chain metadata lines (`mode`, `permission-mode`, `file-history-snapshot`,
 * `ai-title`, `cost-state`, etc.) that are NOT persisted as `nodes` rows —
 * only chain-participating user/assistant/system/attachment lines are.
 * Reassembling from the DB would silently drop those metadata lines, producing
 * a file shape `claude --resume` was never verified to accept (the Milestone-0
 * spike validated copying the original file's RAW LINES verbatim, metadata
 * included). Operating on raw Buffers — not readline/utf-8 text — also keeps
 * the output byte-identical to the source, including its exact line
 * terminators, rather than just textually equivalent.
 */
async function reconstructForkedFileBuffer(sourceFilePath: string, targetUuid: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let leftover = Buffer.alloc(0);
  let found = false;

  const readStream = fs.createReadStream(sourceFilePath);
  try {
    for await (const chunkUnknown of readStream) {
      const chunk = chunkUnknown as Buffer;
      let data = Buffer.concat([leftover, chunk]);
      let nlIndex: number;
      while ((nlIndex = data.indexOf(NEWLINE)) !== -1) {
        const lineBuf = data.subarray(0, nlIndex + 1); // includes the trailing \n, byte-for-byte as on disk
        chunks.push(lineBuf);
        if (lineMatchesUuid(lineBuf, targetUuid)) {
          found = true;
          break;
        }
        data = data.subarray(nlIndex + 1);
      }
      leftover = found ? Buffer.alloc(0) : data;
      if (found) break;
    }
  } finally {
    readStream.destroy(); // stop reading the rest of a possibly-much-larger file once the target line is found
  }

  // Target line was the file's very last line with no trailing newline (rare, but handle it).
  if (!found && leftover.length > 0 && lineMatchesUuid(leftover, targetUuid)) {
    chunks.push(leftover);
    found = true;
  }

  if (!found) {
    throw new Error(`target uuid ${targetUuid} was not found while streaming ${sourceFilePath}`);
  }

  return Buffer.concat(chunks);
}

interface NodeRow {
  uuid: string;
  sessionId: string;
}

interface SessionRow {
  id: string;
  projectId: number;
  filePath: string;
}

interface ProjectRow {
  id: number;
  slug: string;
  cwd: string;
}

export interface ForkResult {
  newSessionId: string;
  /** The original project's cwd — needed by ptyManager.ts when spawning `claude --resume`. */
  cwd: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Forks the session history up through `targetNodeUuid` into a brand-new
 * session file/session row/branch_edges row. Returns null if the node uuid
 * doesn't exist (caller maps that to a 404).
 *
 * Does NOT index the new file's nodes itself — the already-running chokidar
 * watcher (indexer/watcher.ts) picks up the new file via its normal `add`
 * event, since it's written into the same watched directory, and indexes it
 * through the standard path (emitting the usual tree:update broadcast).
 */
export async function forkSessionFromNode(db: DB, targetNodeUuid: string): Promise<ForkResult | null> {
  const node = db.prepare(`SELECT uuid, session_id as sessionId FROM nodes WHERE uuid = ?`).get(targetNodeUuid) as
    | NodeRow
    | undefined;
  if (!node) return null;

  const session = db
    .prepare(`SELECT id, project_id as projectId, file_path as filePath FROM sessions WHERE id = ?`)
    .get(node.sessionId) as SessionRow | undefined;
  if (!session) return null; // shouldn't happen: nodes.session_id FK-references sessions(id)

  const project = db.prepare(`SELECT id, slug, cwd FROM projects WHERE id = ?`).get(session.projectId) as
    | ProjectRow
    | undefined;
  if (!project) return null; // shouldn't happen: sessions.project_id FK-references projects(id)

  const buffer = await reconstructForkedFileBuffer(session.filePath, targetNodeUuid);

  const newSessionId = crypto.randomUUID();
  const newFilePath = path.join(CLAUDE_PROJECTS_DIR, project.slug, `${newSessionId}.jsonl`);

  // Write-safety, non-negotiable: a fresh crypto.randomUUID() colliding with an
  // existing file is astronomically unlikely, but assert it anyway rather than
  // silently trusting that, and use an exclusive-create flag so even a
  // (theoretical) race loses to an error instead of silently overwriting.
  if (fs.existsSync(newFilePath)) {
    throw new Error(`refusing to fork: path already exists (uuid collision?): ${newFilePath}`);
  }
  fs.writeFileSync(newFilePath, buffer, { flag: "wx" });

  const now = nowIso();
  const insertBranchRows = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, project_id, file_path, is_sidechain, agent_id, ai_title, created_at, last_indexed_at, last_byte_offset, is_synthetic)
       VALUES (@id, @projectId, @filePath, 0, NULL, NULL, @now, @now, 0, 1)`,
    ).run({ id: newSessionId, projectId: project.id, filePath: newFilePath, now });

    db.prepare(
      `INSERT INTO branch_edges (source_node_uuid, target_session_id, edge_type, created_at)
       VALUES (@sourceNodeUuid, @targetSessionId, 'branch', @now)`,
    ).run({ sourceNodeUuid: targetNodeUuid, targetSessionId: newSessionId, now });
  });
  insertBranchRows();

  return { newSessionId, cwd: project.cwd };
}
