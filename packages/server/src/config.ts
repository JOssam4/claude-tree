import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Root of Claude Code's own data directory. This app only ever READS under
 * here (see claudeProjectsDir / claudeHistoryFile) — never write, move, or
 * delete anything under CLAUDE_HOME. That constraint is enforced by
 * convention (no fs write calls anywhere touch these paths), not by the
 * filesystem, so keep it that way in any code that imports this config.
 *
 * Test-only override: when CLAUDE_TREE_HOME_OVERRIDE is set (see
 * packages/server/src/test/tempHome.ts), the whole app points at a throwaway
 * mkdtemp'd fixture directory instead of the real ~/.claude, so the automated
 * test suite never reads or writes real conversation history. Unset in every
 * normal/production run, in which case this is byte-for-byte the prior
 * (real-homedir-based) behavior — purely additive.
 */
export const CLAUDE_HOME = process.env.CLAUDE_TREE_HOME_OVERRIDE
  ? path.resolve(process.env.CLAUDE_TREE_HOME_OVERRIDE)
  : path.join(os.homedir(), ".claude");

/** `~/.claude/projects/<slug>/` — one directory per project, containing session .jsonl files. */
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

/** Root of this repo's server package (…/packages/server), used to anchor our own writable paths. */
export const SERVER_ROOT = path.resolve(__dirname, "..");

/**
 * Default location of this app's own SQLite database (CLI/dev). All writes
 * from this app go to its DB, never under CLAUDE_HOME. Electron passes its own
 * per-OS user-data path via startClaudeTreeServer's `dbPath` option instead.
 */
export const DB_DIR = path.join(SERVER_ROOT, "data");
export const DB_PATH = path.join(DB_DIR, "tree.db");

export const SCHEMA_SQL_PATH = path.join(__dirname, "db", "schema.sql");

/**
 * Default location of the built `packages/web` assets served at `/` (monorepo
 * layout). A packaged Electron build copies them elsewhere and passes that
 * path via startClaudeTreeServer's `webDistDir` option instead.
 */
export const WEB_DIST_DIR = path.resolve(SERVER_ROOT, "../web/dist");

/** HTTP/WS server port. Local-only tool — no auth, override via env if 4317 collides with something else. */
export const HTTP_PORT = Number(process.env.CLAUDE_TREE_PORT ?? 4317);

/**
 * How often the background prune job sweeps for sessions whose backing
 * .jsonl file has been deleted (Claude Code's own CLI auto-deletes session
 * files older than its `cleanupPeriodDays` setting, default 30 days).
 * Overridable for testing/tuning, analogous to Claude Code's own
 * cleanupPeriodDays being user-configurable.
 */
export const PRUNE_INTERVAL_MS = Number(process.env.CLAUDE_TREE_PRUNE_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
