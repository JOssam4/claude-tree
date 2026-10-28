import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { listConversationSummaries, setConversationHidden } from "./projectQueries.js";

// listConversationSummaries only ever queries `db` (this app's own SQLite
// DB), so these tests build rows directly via raw SQL against an in-memory
// DB — same approach as treeBuilder.test.ts.

function uuid(): string {
  return crypto.randomUUID();
}

function insertProject(db: DB, slug: string): number {
  db.prepare(
    `INSERT INTO projects (slug, cwd, first_seen_at, last_seen_at) VALUES (?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(slug, `/tmp/${slug}`);
  return (db.prepare(`SELECT id FROM projects WHERE slug = ?`).get(slug) as { id: number }).id;
}

// lastIndexedAt is deliberately settable per-session (and, in several tests
// below, set to values that would produce the WRONG order if the query used
// it for sorting) — lastActivityAt must come from nodes.timestamp, the real
// Claude Code message time, never from this indexing-time column.
function insertSession(db: DB, id: string, projectId: number, lastIndexedAt: string): void {
  db.prepare(
    `INSERT INTO sessions (id, project_id, file_path, is_sidechain, agent_id, ai_title, created_at, last_indexed_at, last_byte_offset, is_synthetic)
     VALUES (?, ?, ?, 0, NULL, NULL, '2026-01-01T00:00:00Z', ?, 0, 0)`,
  ).run(id, projectId, `/tmp/fake/${id}.jsonl`, lastIndexedAt);
}

function insertNode(db: DB, uuidVal: string, sessionId: string, parentUuid: string | null, seq: number, timestamp: string): void {
  db.prepare(
    `INSERT INTO nodes (uuid, session_id, parent_uuid, type, role, content_text, content_raw, timestamp, seq)
     VALUES (?, ?, ?, 'user', 'user', 'text', '{}', ?, ?)`,
  ).run(uuidVal, sessionId, parentUuid, timestamp, seq);
}

function insertBranchEdge(db: DB, sourceNodeUuid: string, targetSessionId: string, edgeType: "branch" | "subagent"): void {
  db.prepare(
    `INSERT INTO branch_edges (source_node_uuid, target_session_id, edge_type, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`,
  ).run(sourceNodeUuid, targetSessionId, edgeType);
}

describe("listConversationSummaries", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("orders conversations by their latest node timestamp, ignoring last_indexed_at", () => {
    const projectId = insertProject(db, "-tmp-proj");
    const older = uuid();
    const newer = uuid();
    // last_indexed_at is set BACKWARDS from the real message times below, so
    // this only passes if ordering comes from nodes.timestamp, not this column.
    insertSession(db, older, projectId, "2026-01-09T00:00:00Z");
    insertSession(db, newer, projectId, "2026-01-01T00:00:00Z");
    insertNode(db, uuid(), older, null, 0, "2026-01-01T00:00:00Z");
    insertNode(db, uuid(), newer, null, 0, "2026-01-02T00:00:00Z");

    const rows = listConversationSummaries(db);
    expect(rows.map((r) => r.sessionId)).toEqual([newer, older]);
    expect(rows.find((r) => r.sessionId === newer)?.lastActivityAt).toBe("2026-01-02T00:00:00Z");
  });

  it("ranks a conversation by the most recent node timestamp anywhere in its tree, not just its own session", () => {
    const projectId = insertProject(db, "-tmp-proj2");

    // recentlyActive's own messages are old, but a forked child session off
    // of it has a much more recent message — it should still sort first.
    const recentlyActive = uuid();
    const staleRoot = uuid();
    insertSession(db, recentlyActive, projectId, "2026-01-01T00:00:00Z");
    insertSession(db, staleRoot, projectId, "2026-01-01T00:00:00Z");
    insertNode(db, uuid(), staleRoot, null, 0, "2026-01-05T00:00:00Z");

    const rootNode = uuid();
    insertNode(db, rootNode, recentlyActive, null, 0, "2026-01-01T00:00:00Z");
    const forkedSession = uuid();
    insertSession(db, forkedSession, projectId, "2026-01-01T00:00:00Z");
    insertBranchEdge(db, rootNode, forkedSession, "branch");
    insertNode(db, uuid(), forkedSession, null, 0, "2026-01-10T00:00:00Z");

    const rows = listConversationSummaries(db);
    expect(rows.map((r) => r.sessionId)).toEqual([recentlyActive, staleRoot]);
    const top = rows.find((r) => r.sessionId === recentlyActive);
    expect(top?.lastActivityAt).toBe("2026-01-10T00:00:00Z");
  });

  it("still ranks by the forked session's latest message when nested two levels deep", () => {
    const projectId = insertProject(db, "-tmp-proj3");
    const root = uuid();
    const otherRoot = uuid();
    insertSession(db, root, projectId, "2026-01-01T00:00:00Z");
    insertSession(db, otherRoot, projectId, "2026-01-01T00:00:00Z");
    insertNode(db, uuid(), otherRoot, null, 0, "2026-01-02T00:00:00Z");

    const rootNode = uuid();
    insertNode(db, rootNode, root, null, 0, "2026-01-01T00:00:00Z");
    const branchSession = uuid();
    insertSession(db, branchSession, projectId, "2026-01-01T00:00:00Z");
    insertBranchEdge(db, rootNode, branchSession, "branch");

    const branchNode = uuid();
    insertNode(db, branchNode, branchSession, null, 0, "2026-01-01T01:00:00Z");
    const subagentSession = uuid();
    insertSession(db, subagentSession, projectId, "2026-01-01T00:00:00Z");
    insertBranchEdge(db, branchNode, subagentSession, "subagent");
    insertNode(db, uuid(), subagentSession, null, 0, "2026-01-20T00:00:00Z");

    const rows = listConversationSummaries(db);
    expect(rows.map((r) => r.sessionId)).toEqual([root, otherRoot]);
    expect(rows.find((r) => r.sessionId === root)?.lastActivityAt).toBe("2026-01-20T00:00:00Z");
  });

  it("falls back to the root's created_at when its tree has no nodes yet", () => {
    const projectId = insertProject(db, "-tmp-proj4");
    const empty = uuid();
    insertSession(db, empty, projectId, "2026-01-01T00:00:00Z");

    const rows = listConversationSummaries(db);
    expect(rows.map((r) => r.sessionId)).toEqual([empty]);
    expect(rows[0]?.lastActivityAt).toBe(rows[0]?.createdAt);
  });

  it("omits subagent sidechain sessions that were never linked to a parent", () => {
    const projectId = insertProject(db, "-tmp-orphan-sidechain");
    const root = uuid();
    insertSession(db, root, projectId, "2026-01-01T00:00:00Z");
    insertNode(db, uuid(), root, null, 0, "2026-01-01T00:00:00Z");

    // No branch_edges row targets this sidechain, so it would otherwise count as a root.
    const orphanSidechain = "agent-a900a6ae610d93259";
    db.prepare(
      `INSERT INTO sessions (id, project_id, file_path, is_sidechain, agent_id, ai_title, created_at, last_indexed_at, last_byte_offset, is_synthetic)
       VALUES (?, ?, ?, 1, 'a900a6ae610d93259', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0)`,
    ).run(orphanSidechain, projectId, `/tmp/fake/${root}/subagents/${orphanSidechain}.jsonl`);
    insertNode(db, uuid(), orphanSidechain, null, 0, "2026-01-05T00:00:00Z");

    const rows = listConversationSummaries(db);
    expect(rows.map((r) => r.sessionId)).toEqual([root]);
  });

  it("does not hang on a synthetic branch_edges cycle", () => {
    const projectId = insertProject(db, "-tmp-cycle");
    const sessionA = uuid();
    const sessionB = uuid();
    insertSession(db, sessionA, projectId, "2026-01-01T00:00:00Z");
    insertSession(db, sessionB, projectId, "2026-01-01T00:00:00Z");
    const nodeA = uuid();
    const nodeB = uuid();
    insertNode(db, nodeA, sessionA, null, 0, "2026-01-01T00:00:00Z");
    insertNode(db, nodeB, sessionB, null, 0, "2026-01-01T00:00:00Z");
    insertBranchEdge(db, nodeA, sessionB, "branch"); // A -> B
    insertBranchEdge(db, nodeB, sessionA, "branch"); // B -> A (cycle)

    // Both sessions are branch_edges targets, so neither is a root.
    expect(listConversationSummaries(db)).toEqual([]);
  });

  it("defaults isHidden to false and reflects setConversationHidden", () => {
    const projectId = insertProject(db, "-tmp-hidden");
    const sessionId = uuid();
    insertSession(db, sessionId, projectId, "2026-01-01T00:00:00Z");

    expect(listConversationSummaries(db)[0]?.isHidden).toBe(false);

    expect(setConversationHidden(db, sessionId, true)).toBe(true);
    expect(listConversationSummaries(db)[0]?.isHidden).toBe(true);

    expect(setConversationHidden(db, sessionId, false)).toBe(true);
    expect(listConversationSummaries(db)[0]?.isHidden).toBe(false);

    expect(setConversationHidden(db, "does-not-exist", true)).toBe(false);
  });
});
