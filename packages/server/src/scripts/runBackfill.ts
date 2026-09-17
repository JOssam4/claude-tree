/**
 * Runs a full backfill against the REAL ~/.claude/projects directory on this
 * machine and prints summary counts. Read-only against ~/.claude; the only
 * thing this script writes to is this app's own SQLite DB (packages/server/data/tree.db).
 *
 * Usage: npm run backfill --workspace packages/server
 */
import { DB_PATH } from "../config.js";
import { openDb } from "../db/client.js";
import { runBackfill } from "../indexer/backfill.js";

async function main() {
  const db = openDb(DB_PATH);
  const summary = await runBackfill(db);

  console.log("Backfill summary:");
  console.log(`  projectsFound:         ${summary.projectsFound}`);
  console.log(`  sessionsFound:         ${summary.sessionsFound}`);
  console.log(`  nodesInserted:         ${summary.nodesInserted}`);
  console.log(`  sidechainLinksFound:   ${summary.sidechainLinksFound}`);
  console.log(`  sidechainLinksOrphaned:${summary.sidechainLinksOrphaned}`);
  console.log(`  warnings:              ${summary.warnings.length}`);
  for (const w of summary.warnings) console.log(`    - ${w}`);

  const counts = {
    projects: (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n,
    sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
    nodes: (db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n,
    branchEdges: (db.prepare("SELECT COUNT(*) AS n FROM branch_edges").get() as { n: number }).n,
  };
  console.log("DB row counts after backfill:", counts);

  db.close();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exitCode = 1;
});
