/**
 * Runnable server entry point (Milestone 2): runs a full backfill once on
 * startup, then starts the live watcher and keeps the process alive.
 *
 * Read-only against ~/.claude — see backfill.ts / watcher.ts for the
 * specifics. The only thing this process writes to is this app's own SQLite
 * DB (packages/server/data/tree.db).
 *
 * Usage: npm run dev --workspace packages/server   (tsx, from source)
 *        npm run build && npm run start --workspace packages/server  (compiled dist/)
 */
import { CLAUDE_PROJECTS_DIR, DB_PATH } from "./config.js";
import { openDb } from "./db/client.js";
import { runBackfill } from "./indexer/backfill.js";
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

  const handle = startWatcher(
    db,
    (event) => {
      console.log(
        `[tree:update] project=${event.projectSlug} session=${event.sessionId} +${event.addedNodeUuids.length} nodes`,
      );
    },
    (msg) => console.log(msg),
  );

  console.log(`[startup] watcher running, watching ${CLAUDE_PROJECTS_DIR}/**/*.jsonl`);
  console.log("[startup] ready. Press Ctrl+C to stop.");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] received ${signal}, closing watcher...`);
    await handle.close();
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
