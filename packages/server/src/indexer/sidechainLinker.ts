/**
 * Joins Task-tool subagent sidechain files back to their invocation point in
 * a parent session's main chain.
 *
 * UNDOCUMENTED, version-fragile behavior (verified by hand on this machine,
 * not a documented Claude Code contract): a sidechain file at
 * subagents/agent-<agentId>.jsonl is joined to the main chain via a
 * `toolUseResult.agentId` field found on a `user`-type line in the main
 * chain (the tool-result line for the Task invocation) — there is no direct
 * field on the tool_use block itself. If a future Claude Code version
 * changes this, `linkSidechain` simply finds no match and the sidechain is
 * indexed as an orphaned tree (its session/nodes still exist; no
 * branch_edges row is created) rather than throwing.
 */
import type { DB } from "../db/client.js";

const SUBAGENT_FILENAME_RE = /^agent-(.+)\.jsonl$/;

/** Extracts the agentId from a `agent-<agentId>.jsonl` filename, or null if it doesn't match (e.g. the sibling `.meta.json` files Claude Code also writes there). */
export function parseAgentIdFromFilename(filename: string): string | null {
  const m = SUBAGENT_FILENAME_RE.exec(filename);
  return m ? (m[1] ?? null) : null;
}

export interface SidechainLinkResult {
  linked: boolean;
}

/**
 * Looks up `agentId` in the map of {toolUseResult.agentId -> node uuid}
 * gathered while indexing the parent session's chain, and if found, records
 * a `branch_edges` row (edge_type='subagent') from that invocation node to
 * the sidechain's session. Idempotent: re-running against the same DB will
 * not create duplicate edges.
 */
export function linkSidechain(
  db: DB,
  agentId: string,
  sidechainSessionId: string,
  agentIdToNodeUuid: ReadonlyMap<string, string>,
): SidechainLinkResult {
  const sourceNodeUuid = agentIdToNodeUuid.get(agentId);
  if (!sourceNodeUuid) return { linked: false };

  const existing = db
    .prepare(
      `SELECT 1 FROM branch_edges WHERE source_node_uuid = ? AND target_session_id = ? AND edge_type = 'subagent'`,
    )
    .get(sourceNodeUuid, sidechainSessionId);

  if (!existing) {
    db.prepare(
      `INSERT INTO branch_edges (source_node_uuid, target_session_id, edge_type, created_at)
       VALUES (?, ?, 'subagent', ?)`,
    ).run(sourceNodeUuid, sidechainSessionId, new Date().toISOString());
  }
  return { linked: true };
}
