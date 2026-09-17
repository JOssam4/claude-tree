import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { buildProjectTree } from "./treeBuilder.js";

// treeBuilder.ts only ever queries `db` (this app's own SQLite DB, never
// ~/.claude), so these tests build rows directly via raw SQL against an
// in-memory DB — no filesystem fixtures or CLAUDE_HOME override needed.

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
     VALUES (?, ?, ?, 'user', 'user', 'text', '{}', '2026-01-01T00:00:00Z', ?)`,
  ).run(uuidVal, sessionId, parentUuid, seq);
}

function insertBranchEdge(db: DB, sourceNodeUuid: string, targetSessionId: string, edgeType: "branch" | "subagent"): void {
  db.prepare(
    `INSERT INTO branch_edges (source_node_uuid, target_session_id, edge_type, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`,
  ).run(sourceNodeUuid, targetSessionId, edgeType);
}

describe("buildProjectTree", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns null for an unknown project slug", () => {
    expect(buildProjectTree(db, "does-not-exist")).toBeNull();
  });

  it("detects roots as sessions with no branch_edges row targeting them", () => {
    const projectId = insertProject(db, "-tmp-proj");
    const rootSessionId = uuid();
    const forkedSessionId = uuid();
    insertSession(db, rootSessionId, projectId);
    insertSession(db, forkedSessionId, projectId);
    const rootNode = uuid();
    insertNode(db, rootNode, rootSessionId, null, 0);
    insertBranchEdge(db, rootNode, forkedSessionId, "branch");

    const tree = buildProjectTree(db, "-tmp-proj");
    expect(tree).not.toBeNull();
    // Only the un-targeted session is a root; the forked one is nested instead.
    expect(tree?.roots.map((r) => r.session.id)).toEqual([rootSessionId]);
  });

  it("attaches a nested fork under its correct source node, recursively", () => {
    const projectId = insertProject(db, "-tmp-proj2");
    const rootSessionId = uuid();
    const branchSessionId = uuid();
    insertSession(db, rootSessionId, projectId);
    insertSession(db, branchSessionId, projectId);
    const rootNode = uuid();
    const branchRootNode = uuid();
    insertNode(db, rootNode, rootSessionId, null, 0);
    insertNode(db, branchRootNode, branchSessionId, null, 0);
    insertBranchEdge(db, rootNode, branchSessionId, "branch");

    const tree = buildProjectTree(db, "-tmp-proj2");
    expect(tree?.roots).toHaveLength(1);
    const root = tree!.roots[0]!;
    expect(root.forks).toHaveLength(1);
    expect(root.forks[0]!.sourceNodeUuid).toBe(rootNode);
    expect(root.forks[0]!.edgeType).toBe("branch");
    expect(root.forks[0]!.session.session.id).toBe(branchSessionId);
  });

  it("guards against a synthetic cycle in branch_edges instead of infinite-looping", () => {
    // foreign_keys is ON in openDb; a genuine 2-session mutual-fork cycle is
    // constructible without disabling it, since each edge only requires a
    // node+session that already exist by the time it's inserted.
    const projectId = insertProject(db, "-tmp-cycle");
    const sessionA = uuid();
    const sessionB = uuid();
    insertSession(db, sessionA, projectId);
    insertSession(db, sessionB, projectId);
    const nodeA = uuid();
    const nodeB = uuid();
    insertNode(db, nodeA, sessionA, null, 0);
    insertNode(db, nodeB, sessionB, null, 0);
    insertBranchEdge(db, nodeA, sessionB, "branch"); // A -> B
    insertBranchEdge(db, nodeB, sessionA, "branch"); // B -> A (cycle)

    const logs: string[] = [];
    const tree = buildProjectTree(db, "-tmp-cycle", (msg) => logs.push(msg));

    // Both sessions are branch_edges targets, so neither is a root; the whole
    // forest is cyclic and unreachable from any true root — roots is empty,
    // and the recursion must have bailed out (logged) rather than hung.
    expect(tree?.roots).toEqual([]);
  });

  it("detects a cycle reached mid-recursion and logs rather than recursing forever", () => {
    // A is a genuine root; A -> B -> C -> B forms a cycle two levels deep.
    const projectId = insertProject(db, "-tmp-cycle2");
    const sessionA = uuid();
    const sessionB = uuid();
    const sessionC = uuid();
    insertSession(db, sessionA, projectId);
    insertSession(db, sessionB, projectId);
    insertSession(db, sessionC, projectId);
    const nodeA = uuid();
    const nodeB = uuid();
    const nodeC = uuid();
    insertNode(db, nodeA, sessionA, null, 0);
    insertNode(db, nodeB, sessionB, null, 0);
    insertNode(db, nodeC, sessionC, null, 0);
    insertBranchEdge(db, nodeA, sessionB, "branch"); // A -> B
    insertBranchEdge(db, nodeB, sessionC, "branch"); // B -> C
    insertBranchEdge(db, nodeC, sessionB, "branch"); // C -> B (cycle back to B)

    const logs: string[] = [];
    const tree = buildProjectTree(db, "-tmp-cycle2", (msg) => logs.push(msg));

    expect(tree?.roots.map((r) => r.session.id)).toEqual([sessionA]);
    expect(logs.some((l) => l.includes("cycle detected"))).toBe(true);
    // The B->C->B cycle is truncated (C's own re-entry into B is dropped), not infinite.
    const bFork = tree!.roots[0]!.forks[0]!;
    expect(bFork.session.session.id).toBe(sessionB);
    const cFork = bFork.session.forks[0]!;
    expect(cFork.session.session.id).toBe(sessionC);
    expect(cFork.session.forks).toEqual([]);
  });
});
