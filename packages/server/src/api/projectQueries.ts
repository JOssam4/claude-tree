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
 * definition as rootSessionCount above), across every project, newest-indexed
 * first. Backs the sidebar's conversation list (GET /api/conversations).
 */
export function listConversationSummaries(db: DB): ConversationSummaryDTO[] {
  return db
    .prepare(
      `SELECT
         s.id as sessionId,
         p.slug as projectSlug,
         p.cwd as projectCwd,
         s.ai_title as aiTitle,
         s.created_at as createdAt,
         s.last_indexed_at as lastIndexedAt
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE NOT EXISTS (SELECT 1 FROM branch_edges be WHERE be.target_session_id = s.id)
       ORDER BY s.last_indexed_at DESC`,
    )
    .all() as ConversationSummaryDTO[];
}
