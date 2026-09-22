import fs from "node:fs";
import Database from "better-sqlite3";
import { DB_DIR, DB_PATH, SCHEMA_SQL_PATH } from "../config.js";

export type DB = Database.Database;

/**
 * Opens (creating if needed) this app's own SQLite database and ensures the
 * schema exists. This is the ONLY database this app writes to — it is
 * separate from, and has no bearing on, anything under ~/.claude.
 *
 * Migration strategy for now: just (re-)run schema.sql, whose statements are
 * all `CREATE TABLE/INDEX IF NOT EXISTS`, plus a handful of one-off `ALTER
 * TABLE ADD COLUMN` calls below for columns added after a database already
 * existed (CREATE TABLE IF NOT EXISTS is a no-op against an existing table,
 * so a new column never appears there on its own). That's sufficient until
 * the schema needs to evolve more than this; a real migration framework can
 * replace this later without changing the call site.
 */
export function openDb(dbPath: string = DB_PATH): DB {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(SCHEMA_SQL_PATH, "utf-8");
  db.exec(schema);

  addColumnIfMissing(db, "sessions", "hidden", "INTEGER NOT NULL DEFAULT 0");

  return db;
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const exists = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
