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
 */
export const CLAUDE_HOME = path.join(os.homedir(), ".claude");

/** `~/.claude/projects/<slug>/` — one directory per project, containing session .jsonl files. */
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

/** Root of this repo's server package (…/packages/server), used to anchor our own writable paths. */
export const SERVER_ROOT = path.resolve(__dirname, "..");

/** This app's own SQLite database. All writes from this app go here, never under CLAUDE_HOME. */
export const DB_DIR = path.join(SERVER_ROOT, "data");
export const DB_PATH = path.join(DB_DIR, "tree.db");

export const SCHEMA_SQL_PATH = path.join(__dirname, "db", "schema.sql");
