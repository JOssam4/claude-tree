-- Schema for the Claude Code Conversation Tree Manager's own local index.
-- This database is entirely owned by this app. Claude Code's own files under
-- ~/.claude/projects/** are never written to; they are only read to populate
-- these tables.

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  cwd TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  file_path TEXT NOT NULL,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  ai_title TEXT,
  created_at TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL,
  last_byte_offset INTEGER NOT NULL DEFAULT 0,
  is_synthetic INTEGER NOT NULL DEFAULT 0 -- 1 = created by our own branch/resume action (not used yet, but included now)
);

CREATE TABLE IF NOT EXISTS nodes (
  uuid TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_uuid TEXT REFERENCES nodes(uuid),
  type TEXT NOT NULL,
  role TEXT,
  content_text TEXT,
  content_raw TEXT NOT NULL, -- verbatim JSON line, needed later for byte-faithful fork writes
  timestamp TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_session ON nodes(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_uuid);

CREATE TABLE IF NOT EXISTS branch_edges (
  id INTEGER PRIMARY KEY,
  source_node_uuid TEXT NOT NULL REFERENCES nodes(uuid),
  target_session_id TEXT NOT NULL REFERENCES sessions(id),
  edge_type TEXT NOT NULL, -- 'branch' | 'subagent'
  created_at TEXT NOT NULL
);
