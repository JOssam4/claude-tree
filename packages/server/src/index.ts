/**
 * Runnable server entry point (Milestone 3): runs a full backfill once on
 * startup, then starts the live watcher AND the HTTP/WS API server, and
 * keeps the process alive.
 *
 * Read-only against ~/.claude — see backfill.ts / watcher.ts for the
 * specifics. The only things this process writes to are this app's own
 * SQLite DB (packages/server/data/tree.db) and its own HTTP/WS server
 * socket — never ~/.claude.
 *
 * Usage: npm run dev --workspace packages/server   (tsx, from source)
 *        npm run build && npm run start --workspace packages/server  (compiled dist/)
 */
import { createApiServer } from "./api/server.js";
import { CLAUDE_PROJECTS_DIR, DB_PATH, HTTP_PORT } from "./config.js";
import { openDb } from "./db/client.js";
import { runBackfill } from "./indexer/backfill.js";
import { startPruneJob } from "./indexer/prune.js";
import { startWatcher } from "./indexer/watcher.js";

async function main(): Promise<void> {
  const db = openDb(DB_PATH);

  console.log("[startup] running backfill...");
  const summary = await runBackfill(db);
  console.log(
    `[startup] backfill complete: ${summary.projectsFound} projects, ${summary.sessionsFound} sessions, ` +
      `${summary.nodesInserted} nodes, ${summary.sidechainLinksFound} sidechain links` +
      (summary.warnings.length ? ` (${summary.warnings.length} warnings)` : ""),
  );
  for (const w of summary.warnings) console.warn(`[backfill warning] ${w}`);

  const api = await createApiServer(db);

  const handle = startWatcher(
    db,
    (event) => {
      console.log(
        `[tree:update] project=${event.projectSlug} session=${event.sessionId} +${event.addedNodeUuids.length} nodes`,
      );
      api.broadcastTreeUpdate(event);
    },
    (msg) => console.log(msg),
  );

  console.log(`[startup] watcher running, watching ${CLAUDE_PROJECTS_DIR}/**/*.jsonl`);

  const pruneHandle = startPruneJob(db, {}, (msg) => console.log(msg));

  await api.listen(HTTP_PORT);
  console.log(`[startup] API server listening on http://127.0.0.1:${HTTP_PORT} (WS at /ws)`);
  console.log("[startup] ready. Press Ctrl+C to stop.");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] received ${signal}, closing watcher and API server...`);
    await handle.close();
    await pruneHandle.close();
    await api.close();
    db.close();
    console.log("[shutdown] done.");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
