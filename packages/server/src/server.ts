/**
 * Reusable startup logic for the Claude Tree server (Milestone 3, extracted
 * for Electron): runs a full backfill once, starts the live watcher AND the
 * HTTP/WS API server, and starts the daily prune job. Returns handles for
 * clean shutdown, so callers control their own process lifecycle instead of
 * this module calling `process.exit`/registering signal handlers itself.
 *
 * Read-only against ~/.claude — see backfill.ts / watcher.ts for the
 * specifics. The only things this process writes to are this app's own
 * SQLite DB and its own HTTP/WS server socket — never ~/.claude.
 *
 * Used by both the CLI entrypoint (index.ts) and Electron's main process.
 */
import { createApiServer, type ApiServer } from "./api/server.js";
import { CLAUDE_PROJECTS_DIR, DB_PATH, HTTP_PORT, WEB_DIST_DIR } from "./config.js";
import { openDb, type DB } from "./db/client.js";
import { runBackfill } from "./indexer/backfill.js";
import { startPruneJob } from "./indexer/prune.js";
import type { PruneJobHandle } from "./indexer/prune.js";
import { startWatcher } from "./indexer/watcher.js";
import type { TreeWatcherHandle } from "./indexer/watcher.js";

export interface StartServerOptions {
  port?: number;
  /** Where this app's own SQLite DB lives. Defaults to the monorepo-local DB_PATH. */
  dbPath?: string;
  /** Built web UI to serve at `/`. Defaults to the monorepo-local WEB_DIST_DIR. */
  webDistDir?: string;
  log?: (msg: string) => void;
}

export interface ServerHandles {
  db: DB;
  api: ApiServer;
  watcherHandle: TreeWatcherHandle;
  pruneHandle: PruneJobHandle;
  /** Idempotent; closes watcher, prune job, and API (incl. WS clients/ptys), then the db. */
  close(): Promise<void>;
}

export async function startClaudeTreeServer(options: StartServerOptions = {}): Promise<ServerHandles> {
  const log = options.log ?? console.log;
  const port = options.port ?? HTTP_PORT;

  const db = openDb(options.dbPath ?? DB_PATH);

  log("[startup] running backfill...");
  const summary = await runBackfill(db);
  log(
    `[startup] backfill complete: ${summary.projectsFound} projects, ${summary.sessionsFound} sessions, ` +
      `${summary.nodesInserted} nodes, ${summary.sidechainLinksFound} sidechain links` +
      (summary.warnings.length ? ` (${summary.warnings.length} warnings)` : ""),
  );
  for (const w of summary.warnings) log(`[backfill warning] ${w}`);

  const api = await createApiServer(db, options.webDistDir ?? WEB_DIST_DIR);

  const watcherHandle = startWatcher(
    db,
    (event) => {
      log(
        `[tree:update] project=${event.projectSlug} session=${event.sessionId} +${event.addedNodeUuids.length} nodes`,
      );
      api.broadcastTreeUpdate(event);
    },
    log,
  );

  log(`[startup] watcher running, watching ${CLAUDE_PROJECTS_DIR}/**/*.jsonl`);

  // Runs its first sweep inline, before listen() below, so stale conversations
  // (session files Claude Code has since deleted) are gone before the UI loads.
  const pruneHandle = startPruneJob(db, {}, log);

  await api.listen(port);
  log(`[startup] API server listening on http://127.0.0.1:${port} (WS at /ws)`);

  let closed = false;
  return {
    db,
    api,
    watcherHandle,
    pruneHandle,
    async close() {
      if (closed) return;
      closed = true;
      await watcherHandle.close();
      await pruneHandle.close();
      await api.close();
      db.close();
    },
  };
}
