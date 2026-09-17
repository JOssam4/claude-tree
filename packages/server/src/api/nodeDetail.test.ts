import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { getNodeDetail } from "./nodeDetail.js";

function uuid(): string {
  return crypto.randomUUID();
}

function insertProject(db: DB, slug: string): number {
  db.prepare(
    `INSERT INTO projects (slug, cwd, first_seen_at, last_seen_at) VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(slug, `/tmp/${slug}`);
  return (db.prepare(`SELECT id FROM projects WHERE slug = ?`).get(slug) as { id: number }).id;
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
     VALUES (?, ?, ?, 'user', 'user', ?, '{}', '2026-01-01T00:00:00Z', ?)`,
  ).run(uuidVal, sessionId, parentUuid, uuidVal, seq);
}

function insertBranchEdge(db: DB, sourceNodeUuid: string, targetSessionId: string): void {
  db.prepare(
    `INSERT INTO branch_edges (source_node_uuid, target_session_id, edge_type, created_at) VALUES (?, ?, 'branch', '2026-01-01T00:00:00Z')`,
  ).run(sourceNodeUuid, targetSessionId);
}

describe("getNodeDetail", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for a nonexistent uuid", () => {
    expect(getNodeDetail(db, "does-not-exist")).toBeNull();
  });

  it("walks a plain in-session ancestry root -> leaf", () => {
    const projectId = insertProject(db, "-p1");
    const sessionId = uuid();
    insertSession(db, sessionId, projectId);
    const root = uuid();
    const mid = uuid();
    const leaf = uuid();
    insertNode(db, root, sessionId, null, 0);
    insertNode(db, mid, sessionId, root, 1);
    insertNode(db, leaf, sessionId, mid, 2);

    const detail = getNodeDetail(db, leaf);
    expect(detail?.node.uuid).toBe(leaf);
    expect(detail?.ancestry.path.map((n) => n.uuid)).toEqual([root, mid, leaf]);
  });

  it("hops across a session boundary via branch_edges when the session root is itself a fork target", () => {
    const projectId = insertProject(db, "-p2");
    const sessionA = uuid();
    const sessionB = uuid();
    insertSession(db, sessionA, projectId);
    insertSession(db, sessionB, projectId);
    const a1 = uuid();
    const a2 = uuid(); // fork source node
    insertNode(db, a1, sessionA, null, 0);
    insertNode(db, a2, sessionA, a1, 1);
    const b1 = uuid(); // session B's own root
    const b2 = uuid();
    insertNode(db, b1, sessionB, null, 0);
    insertNode(db, b2, sessionB, b1, 1);
    insertBranchEdge(db, a2, sessionB);

    const detail = getNodeDetail(db, b2);
    expect(detail?.ancestry.path.map((n) => n.uuid)).toEqual([a1, a2, b1, b2]);
  });

  it("continues walking through a compaction boundary via prior seq, instead of stopping at the second parent_uuid:null root", () => {
    const projectId = insertProject(db, "-p3");
    const sessionId = uuid();
    insertSession(db, sessionId, projectId);
    const c1 = uuid(); // true root, seq 0
    const c2 = uuid(); // seq 1
    const c3 = uuid(); // compaction-injected second root (parent_uuid null), seq 2
    const c4 = uuid(); // seq 3, child of c3
    insertNode(db, c1, sessionId, null, 0);
    insertNode(db, c2, sessionId, c1, 1);
    insertNode(db, c3, sessionId, null, 2); // parent_uuid IS NULL but NOT the true session start
    insertNode(db, c4, sessionId, c3, 3);

    const detail = getNodeDetail(db, c4);
    // Must continue past c3 into c2/c1 by prior-seq, not stop at c3.
    expect(detail?.ancestry.path.map((n) => n.uuid)).toEqual([c1, c2, c3, c4]);
  });

  it("does not false-positive the cycle guard on a legitimate deep-ish chain", () => {
    const projectId = insertProject(db, "-p4");
    const sessionId = uuid();
    insertSession(db, sessionId, projectId);
    const uuids: string[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 100; i++) {
      const id = uuid();
      insertNode(db, id, sessionId, parent, i);
      uuids.push(id);
      parent = id;
    }
    const logs: string[] = [];
    const detail = getNodeDetail(db, uuids[uuids.length - 1]!, (msg) => logs.push(msg));
    expect(detail?.ancestry.path.map((n) => n.uuid)).toEqual(uuids);
    expect(logs.some((l) => l.includes("cycle"))).toBe(false);
  });

  it("terminates and logs on a synthetic pathological parent_uuid cycle instead of recursing forever", () => {
    const projectId = insertProject(db, "-p5");
    const sessionId = uuid();
    insertSession(db, sessionId, projectId);
    const n1 = uuid();
    const n2 = uuid();
    // Mutual cycle: n1's parent is n2 and n2's parent is n1. foreign_keys is ON,
    // so insert both referencing each other by disabling FK enforcement just for
    // this deliberately-invalid synthetic fixture (real data can never look like this).
    db.pragma("foreign_keys = OFF");
    insertNode(db, n1, sessionId, n2, 0);
    insertNode(db, n2, sessionId, n1, 1);
    db.pragma("foreign_keys = ON");

    const logs: string[] = [];
    const detail = getNodeDetail(db, n1, (msg) => logs.push(msg));
    expect(detail).not.toBeNull();
    expect(detail?.ancestry.path.length).toBeLessThanOrEqual(2);
    expect(logs.some((l) => l.includes("cycle detected"))).toBe(true);
  });
});
