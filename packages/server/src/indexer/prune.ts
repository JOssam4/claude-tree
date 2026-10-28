/**
 * Daily reconciliation sweep: Claude Code's own CLI auto-deletes session
 * .jsonl files once they're older than its cleanupPeriodDays setting (default
 * 30 days). Neither the backfill nor the watcher ever notices a file
 * disappearing (the watcher has no `unlink` handler, and backfill only ever
 * upserts), so without this sweep a deleted session's rows stay indexed
 * forever. This module's only filesystem interaction is fs.existsSync against
 * paths already stored in `sessions.file_path` (read-only, same convention as
 * backfill.ts/watcher.ts) — its writes are DELETEs against this app's own DB.
 */
import fs from "node:fs";
import type { PruneSummary } from "@claude-tree/shared";
import { PRUNE_INTERVAL_MS } from "../config.js";
import type { DB } from "../db/client.js";

export interface PruneOptions {
  /** Override for testing; defaults to fs.existsSync. */
  existsFn?: (filePath: string) => boolean;
}

/**
 * One sweep: for every indexed session whose file_path no longer exists,
 * deletes its rows (branch_edges -> nodes -> sessions, the only FK-safe order
 * since schema.sql declares no ON DELETE CASCADE and client.ts turns
 * `foreign_keys = ON`), then garbage-collects any project left with zero
 * sessions. Each stale session is pruned in its own transaction, with a
 * try/catch around the call site — one bad row must not block pruning the
 * rest of the sweep, since this runs again tomorrow regardless.
 */
export function pruneStaleSessions(db: DB, options: PruneOptions = {}): PruneSummary {
  const exists = options.existsFn ?? fs.existsSync;
  const warnings: string[] = [];
  let sessionsPruned = 0;
  let nodesPruned = 0;
  let branchEdgesPruned = 0;

  const pruneOneSession = db.transaction((sessionId: string) => {
    const branchEdgesResult = db
      .prepare(
        `DELETE FROM branch_edges
         WHERE source_node_uuid IN (SELECT uuid FROM nodes WHERE session_id = ?)
            OR target_session_id = ?`,
      )
      .run(sessionId, sessionId);
    const nodesResult = db.prepare(`DELETE FROM nodes WHERE session_id = ?`).run(sessionId);
    const sessionResult = db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    return {
      branchEdges: branchEdgesResult.changes,
      nodes: nodesResult.changes,
      sessions: sessionResult.changes,
    };
  });

  const rows = db.prepare(`SELECT id, file_path as filePath FROM sessions`).all() as {
    id: string;
    filePath: string;
  }[];

  for (const row of rows) {
    if (exists(row.filePath)) continue;
    try {
      const result = pruneOneSession(row.id);
      sessionsPruned += result.sessions;
      nodesPruned += result.nodes;
      branchEdgesPruned += result.branchEdges;
    } catch (err) {
      warnings.push(`failed to prune session ${row.id} (${row.filePath}): ${(err as Error).message}`);
    }
  }

  // A project with zero remaining sessions is pure clutter in the UI's
  // project list; nothing else references projects.id, and this runs after
  // all session deletes above, so it's safe with no FK-ordering concerns.
  const projectsResult = db
    .prepare(`DELETE FROM projects WHERE id NOT IN (SELECT DISTINCT project_id FROM sessions)`)
    .run();

  return {
    sessionsPruned,
    nodesPruned,
    branchEdgesPruned,
    projectsPruned: projectsResult.changes,
    warnings,
  };
}

export type PruneLogFn = (message: string) => void;

export interface PruneJobHandle {
  close(): Promise<void>;
}

export interface StartPruneJobOptions extends PruneOptions {
  intervalMs?: number;
}

/**
 * Runs pruneStaleSessions once synchronously before returning, then on a
 * daily interval until close() is called. The first sweep is synchronous so
 * that, called before the API starts listening, the UI never sees
 * conversations whose files Claude Code has already deleted.
 */
export function startPruneJob(
  db: DB,
  options: StartPruneJobOptions = {},
  log: PruneLogFn = console.log,
): PruneJobHandle {
  const intervalMs = options.intervalMs ?? PRUNE_INTERVAL_MS;

  function runSweep(): void {
    let summary: PruneSummary;
    try {
      summary = pruneStaleSessions(db, options);
    } catch (err) {
      // Must never take down startup (the first sweep runs inline there);
      // the next interval sweep will retry.
      log(`[prune warning] sweep failed: ${(err as Error).message}`);
      return;
    }
    if (summary.sessionsPruned > 0 || summary.warnings.length > 0) {
      log(
        `[prune] removed ${summary.sessionsPruned} stale sessions, ${summary.nodesPruned} nodes, ` +
          `${summary.branchEdgesPruned} branch_edges, ${summary.projectsPruned} empty projects` +
          (summary.warnings.length ? ` (${summary.warnings.length} warnings)` : ""),
      );
    }
    for (const w of summary.warnings) log(`[prune warning] ${w}`);
  }

  runSweep();
  const interval = setInterval(runSweep, intervalMs);

  return {
    async close() {
      clearInterval(interval);
    },
  };
}
