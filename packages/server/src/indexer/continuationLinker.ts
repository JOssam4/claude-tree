/**
 * Joins a Claude Code "continuation" session back onto the session it
 * continues.
 *
 * Observed behavior (not a documented Claude Code contract): resuming a
 * conversation can start a brand-new session file rather than appending to
 * the original. The new file re-writes the ENTIRE prior history under the new
 * sessionId, then continues with new turns, and the old file gets a trailing
 * `{"type":"continued-in","continuedInSessionId":...}` marker. Because
 * `nodes.uuid` is the primary key (INSERT OR IGNORE, see lineIndexer.ts), the
 * copied history stays owned by the original session, and only the genuinely
 * new lines land in the new session — whose FIRST stored node's parent_uuid
 * therefore lives in the original session.
 *
 * Without an edge, the new session would show up as a separate conversation
 * root consisting of just those new turns. So: if a session's first stored
 * node is parented to a node in a different session, and nothing else
 * (a fork or subagent link) already targets this session, record a
 * `branch_edges` row (edge_type='continuation') from that parent node.
 * Keying off the parent linkage rather than the `continued-in` marker means
 * any future Claude Code behavior that splits one chain across files is
 * linked the same way.
 */
import type { DB } from "../db/client.js";

export interface ContinuationLinkResult {
  linked: boolean;
}

export function linkContinuation(db: DB, sessionId: string): ContinuationLinkResult {
  // Already a fork/subagent target (or linked on an earlier pass) — our own
  // forks' first node is parented cross-session too, and already has its edge.
  const alreadyTargeted = db.prepare(`SELECT 1 FROM branch_edges WHERE target_session_id = ?`).get(sessionId);
  if (alreadyTargeted) return { linked: false };

  const first = db
    .prepare(
      `SELECT n.parent_uuid AS parentUuid, p.session_id AS parentSessionId
       FROM nodes n
       LEFT JOIN nodes p ON p.uuid = n.parent_uuid
       WHERE n.session_id = ?
       ORDER BY n.seq
       LIMIT 1`,
    )
    .get(sessionId) as { parentUuid: string | null; parentSessionId: string | null } | undefined;
  if (!first?.parentUuid || !first.parentSessionId || first.parentSessionId === sessionId) {
    return { linked: false };
  }

  db.prepare(
    `INSERT INTO branch_edges (source_node_uuid, target_session_id, edge_type, created_at)
     VALUES (?, ?, 'continuation', ?)`,
  ).run(first.parentUuid, sessionId, new Date().toISOString());
  return { linked: true };
}
