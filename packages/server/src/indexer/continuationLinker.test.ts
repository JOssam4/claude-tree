import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { linkContinuation } from "./continuationLinker.js";

function uuid(): string {
  return crypto.randomUUID();
}

function insertProject(db: DB): number {
  db.prepare(
    `INSERT INTO projects (slug, cwd, first_seen_at, last_seen_at) VALUES ('p', '/tmp/p', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
  return (db.prepare(`SELECT id FROM projects WHERE slug = 'p'`).get() as { id: number }).id;
}

function insertSession(db: DB, id: string, projectId: number): void {
  db.prepare(
    `INSERT INTO sessions (id, project_id, file_path, is_sidechain, agent_id, ai_title, created_at, last_indexed_at, last_byte_offset, is_synthetic)
     VALUES (?, ?, ?, 0, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0)`,
  ).run(id, projectId, `/tmp/fake/${id}.jsonl`);
}

function insertNode(db: DB, uuidVal: string, sessionId: string, parentUuid: string | null, seq: number): void {
  db.prepare(
    `INSERT INTO nodes (uuid, session_id, parent_uuid, type, role, content_text, content_raw, timestamp, seq)
     VALUES (?, ?, ?, 'user', 'user', 'text', '{}', '2026-01-01T00:00:00Z', ?)`,
  ).run(uuidVal, sessionId, parentUuid, seq);
}

function edgesTargeting(db: DB, sessionId: string): { source_node_uuid: string; edge_type: string }[] {
  return db
    .prepare(`SELECT source_node_uuid, edge_type FROM branch_edges WHERE target_session_id = ?`)
    .all(sessionId) as { source_node_uuid: string; edge_type: string }[];
}

describe("linkContinuation", () => {
  let db: DB;
  let projectId: number;
  const original = uuid();
  const continued = uuid();
  const a1 = uuid();
  const a2 = uuid();

  beforeEach(() => {
    db = openDb(":memory:");
    projectId = insertProject(db);
    insertSession(db, original, projectId);
    insertSession(db, continued, projectId);
    insertNode(db, a1, original, null, 0);
    insertNode(db, a2, original, a1, 1);
  });

  afterEach(() => {
    db.close();
  });

  it("links a session whose first node is parented into another session", () => {
    // seq starts past the copied history, as it does when those lines were ignored as duplicates.
    const b1 = uuid();
    insertNode(db, b1, continued, a2, 2);
    insertNode(db, uuid(), continued, b1, 3);

    expect(linkContinuation(db, continued)).toEqual({ linked: true });
    expect(edgesTargeting(db, continued)).toEqual([{ source_node_uuid: a2, edge_type: "continuation" }]);
  });

  it("is idempotent", () => {
    insertNode(db, uuid(), continued, a2, 2);
    linkContinuation(db, continued);
    expect(linkContinuation(db, continued)).toEqual({ linked: false });
    expect(edgesTargeting(db, continued)).toHaveLength(1);
  });

  it("does not link a session whose first node is a root or parented within itself", () => {
    expect(linkContinuation(db, original)).toEqual({ linked: false });
    expect(linkContinuation(db, continued)).toEqual({ linked: false }); // no nodes yet
    expect(edgesTargeting(db, original)).toHaveLength(0);
  });

  it("only considers the first node, not a later cross-session parent", () => {
    const b1 = uuid();
    insertNode(db, b1, continued, null, 0);
    insertNode(db, uuid(), continued, a2, 1);
    expect(linkContinuation(db, continued)).toEqual({ linked: false });
  });

  it("leaves a session that is already a fork target alone", () => {
    insertNode(db, uuid(), continued, a2, 2);
    db.prepare(
      `INSERT INTO branch_edges (source_node_uuid, target_session_id, edge_type, created_at) VALUES (?, ?, 'branch', '2026-01-01T00:00:00Z')`,
    ).run(a2, continued);
    expect(linkContinuation(db, continued)).toEqual({ linked: false });
    expect(edgesTargeting(db, continued)).toEqual([{ source_node_uuid: a2, edge_type: "branch" }]);
  });
});
