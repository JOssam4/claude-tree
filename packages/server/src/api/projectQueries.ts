/**
 * Read-only queries backing GET /api/projects. Only ever SELECTs from this
 * app's own SQLite DB (never touches ~/.claude directly — that constraint
 * belongs to the indexer/watcher, not the API layer).
 */
import type { ConversationSummaryDTO, ProjectSummaryDTO } from "@claude-tree/shared";
import type { DB } from "../db/client.js";

/**
 * One row per project with session/root counts, cheap enough to compute with
 * correlated subqueries at this data scale (a local single-user tool's
 * project/session counts are in the tens-to-low-thousands, not something
 * that needs a join+group-by rewrite).
 */
export function listProjectSummaries(db: DB): ProjectSummaryDTO[] {
  return db
    .prepare(
      `SELECT
         p.id as id,
         p.slug as slug,
         p.cwd as cwd,
         p.first_seen_at as firstSeenAt,
         p.last_seen_at as lastSeenAt,
         (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) as sessionCount,
         (SELECT COUNT(*) FROM sessions s
            WHERE s.project_id = p.id
              AND NOT EXISTS (SELECT 1 FROM branch_edges be WHERE be.target_session_id = s.id)
         ) as rootSessionCount
       FROM projects p
       ORDER BY p.last_seen_at DESC`,
    )
    .all() as ProjectSummaryDTO[];
}

/**
 * One row per conversation (root session — same "no branch_edges targets it"
 * definition as rootSessionCount above), across every project, ordered by the
 * most recent activity anywhere in that conversation's tree (the root session
 * itself plus every branch/subagent session forked from it, recursively).
 * Backs the sidebar's conversation list (GET /api/conversations).
 *
 * "Most recent activity" is the MAX(nodes.timestamp) across every node in
 * every session in the tree — the real message timestamp from Claude Code's
 * own JSONL — not sessions.last_indexed_at, which is only the wall-clock time
 * our own indexer last happened to touch that row (e.g. a fresh backfill
 * stamps every session with "now" in directory-scan order, which has no
 * relation to when the underlying conversation actually last had a message).
 * Falls back to the root's own created_at only for the (edge-case) root with
 * zero nodes anywhere in its tree yet, e.g. mid-backfill.
 *
 * The recursive walk uses plain UNION (not UNION ALL) so a synthetic
 * branch_edges cycle (see treeBuilder.ts's cycle guard) can't loop forever:
 * UNION dedupes (root_id, session_id) pairs, so the row set is bounded by
 * sessions.length and the recursion reaches a fixpoint.
 */
interface ConversationSummaryRow extends Omit<ConversationSummaryDTO, "isHidden"> {
  isHidden: number;
}

export function listConversationSummaries(db: DB): ConversationSummaryDTO[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(root_id, session_id) AS (
         SELECT s.id, s.id
         FROM sessions s
         WHERE NOT EXISTS (SELECT 1 FROM branch_edges be WHERE be.target_session_id = s.id)
         UNION
         SELECT t.root_id, be.target_session_id
         FROM tree t
         JOIN nodes n ON n.session_id = t.session_id
         JOIN branch_edges be ON be.source_node_uuid = n.uuid
       ),
       tree_activity AS (
         SELECT t.root_id as rootId, MAX(n2.timestamp) as lastActivityAt
         FROM tree t
         LEFT JOIN nodes n2 ON n2.session_id = t.session_id
         GROUP BY t.root_id
       )
       SELECT
         s.id as sessionId,
         p.slug as projectSlug,
         p.cwd as projectCwd,
         s.ai_title as aiTitle,
         s.created_at as createdAt,
         s.last_indexed_at as lastIndexedAt,
         COALESCE(ta.lastActivityAt, s.created_at) as lastActivityAt,
         s.hidden as isHidden
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       JOIN tree_activity ta ON ta.rootId = s.id
       WHERE NOT EXISTS (SELECT 1 FROM branch_edges be WHERE be.target_session_id = s.id)
       ORDER BY COALESCE(ta.lastActivityAt, s.created_at) DESC`,
    )
    .all() as ConversationSummaryRow[];
  return rows.map((row) => ({ ...row, isHidden: row.isHidden === 1 }));
}

/**
 * Sets (or clears) the hidden flag on a conversation's root session, backing
 * PATCH /api/conversations/:id/hidden. A display-only preference — never
 * touches nodes/branch_edges, so hiding a conversation stays fully
 * reversible. Returns false if no session with that id exists.
 */
export function setConversationHidden(db: DB, sessionId: string, hidden: boolean): boolean {
  const result = db.prepare(`UPDATE sessions SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, sessionId);
  return result.changes > 0;
}
