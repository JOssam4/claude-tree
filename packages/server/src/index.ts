/**
 * Runnable server entry point (CLI). Starts the server via server.ts and
 * keeps the process alive, wiring SIGINT/SIGTERM to a clean shutdown.
 *
 * Usage: npm run dev --workspace packages/server   (tsx, from source)
 *        npm run build && npm run start --workspace packages/server  (compiled dist/)
 */
import { startClaudeTreeServer } from "./server.js";

async function main(): Promise<void> {
  const handles = await startClaudeTreeServer();
  console.log("[startup] ready. Press Ctrl+C to stop.");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] received ${signal}, closing watcher and API server...`);
    await handles.close();
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
