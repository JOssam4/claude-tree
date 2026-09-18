import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { chainLine, aiTitleLine, writeJsonlFile } from "../test/fixtures.js";
import { createFixtureClaudeHome, type FixtureClaudeHome } from "../test/tempHome.js";
import { runBackfill } from "./backfill.js";
import { pruneStaleSessions } from "./prune.js";

// pruneStaleSessions checks fs.existsSync against sessions.file_path directly
// (no directory override needed, unlike runBackfill's projectsDir option), so
// these tests seed the DB via runBackfill against a temp fixture dir, then
// delete files from that same fixture dir before pruning.
describe("pruneStaleSessions", () => {
  let fixture: FixtureClaudeHome;
  let db: DB;
  const slug = "-tmp-prune-project";

  beforeEach(() => {
    fixture = createFixtureClaudeHome();
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
  });

  function sessionCount(): number {
    return (db.prepare(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number }).c;
  }
  function nodeCount(): number {
    return (db.prepare(`SELECT COUNT(*) as c FROM nodes`).get() as { c: number }).c;
  }
  function branchEdgeCount(): number {
    return (db.prepare(`SELECT COUNT(*) as c FROM branch_edges`).get() as { c: number }).c;
  }
  function projectCount(): number {
    return (db.prepare(`SELECT COUNT(*) as c FROM projects`).get() as { c: number }).c;
  }

  function writeSimpleSession(sessionFileName: string): { filePath: string; nodeCount: number } {
    const sessionId = sessionFileName.replace(/\.jsonl$/, "");
    const filePath = path.join(fixture.projectsDir, slug, sessionFileName);
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    writeJsonlFile(filePath, [
      aiTitleLine("A session"),
      chainLine({ uuid: u1, parentUuid: null, type: "user", text: "hi", cwd: "/tmp/proj", sessionId }),
      chainLine({ uuid: u2, parentUuid: u1, type: "assistant", text: "hello", sessionId }),
    ]);
    return { filePath, nodeCount: 2 };
  }

  /** Main session + one linked subagent sidechain, producing exactly one 'subagent' branch_edges row. */
  function seedLinkedFixture() {
    const mainSessionId = crypto.randomUUID();
    const linkedAgentId = "agent-linked-123";
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const u3 = crypto.randomUUID();

    const mainFilePath = path.join(fixture.projectsDir, slug, `${mainSessionId}.jsonl`);
    writeJsonlFile(mainFilePath, [
      aiTitleLine("Main session"),
      chainLine({ uuid: u1, parentUuid: null, type: "user", text: "start", cwd: "/tmp/real-cwd" }),
      chainLine({ uuid: u2, parentUuid: u1, type: "assistant", text: "invoking subagent" }),
      chainLine({ uuid: u3, parentUuid: u2, type: "user", text: "tool result", toolUseResultAgentId: linkedAgentId }),
    ]);

    const s1 = crypto.randomUUID();
    const sidechainFilePath = path.join(
      fixture.projectsDir,
      slug,
      mainSessionId,
      "subagents",
      `agent-${linkedAgentId}.jsonl`,
    );
    writeJsonlFile(sidechainFilePath, [
      chainLine({ uuid: s1, parentUuid: null, type: "user", text: "subagent task", isSidechain: true }),
    ]);

    return {
      mainSessionId,
      mainFilePath,
      sidechainSessionId: `agent-${linkedAgentId}`,
      sidechainFilePath,
    };
  }

  it("leaves a session untouched when its file still exists", async () => {
    writeSimpleSession(`${crypto.randomUUID()}.jsonl`);
    await runBackfill(db, { projectsDir: fixture.projectsDir });

    const summary = pruneStaleSessions(db);

    expect(summary.sessionsPruned).toBe(0);
    expect(summary.warnings).toHaveLength(0);
    expect(sessionCount()).toBe(1);
    expect(nodeCount()).toBe(2);
    expect(projectCount()).toBe(1);
  });

  it("prunes a session whose file has been deleted, along with its nodes", async () => {
    const { filePath, nodeCount: expectedNodes } = writeSimpleSession(`${crypto.randomUUID()}.jsonl`);
    await runBackfill(db, { projectsDir: fixture.projectsDir });
    fs.unlinkSync(filePath);

    const summary = pruneStaleSessions(db);

    expect(summary.sessionsPruned).toBe(1);
    expect(summary.nodesPruned).toBe(expectedNodes);
    expect(sessionCount()).toBe(0);
    expect(nodeCount()).toBe(0);
  });

  it("prunes a branch_edges SOURCE session without a foreign key violation", async () => {
    const fx = seedLinkedFixture();
    await runBackfill(db, { projectsDir: fixture.projectsDir });
    expect(branchEdgeCount()).toBe(1);

    fs.unlinkSync(fx.mainFilePath); // main session's node is the edge's source_node_uuid

    const summary = pruneStaleSessions(db);

    expect(summary.warnings).toHaveLength(0);
    expect(summary.sessionsPruned).toBe(1);
    expect(summary.branchEdgesPruned).toBe(1);
    expect(branchEdgeCount()).toBe(0);
    expect(sessionCount()).toBe(1); // the sidechain session survives, just orphaned
  });

  it("prunes a branch_edges TARGET session without a foreign key violation", async () => {
    const fx = seedLinkedFixture();
    await runBackfill(db, { projectsDir: fixture.projectsDir });
    expect(branchEdgeCount()).toBe(1);

    fs.unlinkSync(fx.sidechainFilePath); // sidechain session is the edge's target_session_id

    const summary = pruneStaleSessions(db);

    expect(summary.warnings).toHaveLength(0);
    expect(summary.sessionsPruned).toBe(1);
    expect(summary.branchEdgesPruned).toBe(1);
    expect(branchEdgeCount()).toBe(0);
    expect(sessionCount()).toBe(1); // the main session survives
  });

  it("garbage-collects a project once its last session is pruned", async () => {
    const { filePath } = writeSimpleSession(`${crypto.randomUUID()}.jsonl`);
    await runBackfill(db, { projectsDir: fixture.projectsDir });
    fs.unlinkSync(filePath);

    const summary = pruneStaleSessions(db);

    expect(summary.projectsPruned).toBe(1);
    expect(projectCount()).toBe(0);
  });

  it("does not garbage-collect a project that still has a remaining session", async () => {
    const { filePath: keepPath } = writeSimpleSession(`${crypto.randomUUID()}.jsonl`);
    const { filePath: deletePath } = writeSimpleSession(`${crypto.randomUUID()}.jsonl`);
    await runBackfill(db, { projectsDir: fixture.projectsDir });
    fs.unlinkSync(deletePath);
    void keepPath;

    const summary = pruneStaleSessions(db);

    expect(summary.sessionsPruned).toBe(1);
    expect(summary.projectsPruned).toBe(0);
    expect(projectCount()).toBe(1);
  });
});
