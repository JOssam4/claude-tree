import crypto from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { chainLine, metadataLine, aiTitleLine, writeJsonlFile } from "../test/fixtures.js";
import { createFixtureClaudeHome, type FixtureClaudeHome } from "../test/tempHome.js";
import { runBackfill } from "./backfill.js";

// runBackfill accepts an explicit `projectsDir` override (see backfill.ts's
// BackfillOptions), so these tests never touch CLAUDE_PROJECTS_DIR/config.ts
// at all — just point it straight at a temp fixture dir.
describe("runBackfill", () => {
  let fixture: FixtureClaudeHome;
  let db: DB;
  const slug = "-tmp-backfill-project";

  beforeEach(() => {
    fixture = createFixtureClaudeHome();
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
    fixture.cleanup();
  });

  function seedFixture() {
    const mainSessionId = crypto.randomUUID();
    const linkedAgentId = "agent-linked-123";
    const orphanAgentId = "agent-orphan-999";

    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID(); // the tool-result line invoking the linked subagent
    const u3 = crypto.randomUUID();

    const mainFilePath = path.join(fixture.projectsDir, slug, `${mainSessionId}.jsonl`);
    writeJsonlFile(mainFilePath, [
      metadataLine("mode", { mode: "default" }),
      aiTitleLine("My Test Session"),
      chainLine({ uuid: u1, parentUuid: null, type: "user", text: "start", cwd: "/tmp/real-cwd" }),
      chainLine({ uuid: u2, parentUuid: u1, type: "assistant", text: "invoking subagent" }),
      chainLine({ uuid: u3, parentUuid: u2, type: "user", text: "tool result", toolUseResultAgentId: linkedAgentId }),
    ]);

    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    const linkedSidechainPath = path.join(
      fixture.projectsDir,
      slug,
      mainSessionId,
      "subagents",
      `agent-${linkedAgentId}.jsonl`,
    );
    writeJsonlFile(linkedSidechainPath, [
      chainLine({ uuid: s1, parentUuid: null, type: "user", text: "subagent task", isSidechain: true }),
      chainLine({ uuid: s2, parentUuid: s1, type: "assistant", text: "subagent result", isSidechain: true }),
    ]);

    const o1 = crypto.randomUUID();
    const orphanSidechainPath = path.join(
      fixture.projectsDir,
      slug,
      mainSessionId,
      "subagents",
      `agent-${orphanAgentId}.jsonl`,
    );
    writeJsonlFile(orphanSidechainPath, [
      chainLine({ uuid: o1, parentUuid: null, type: "user", text: "orphaned subagent, no matching invocation" }),
    ]);

    return { mainSessionId, linkedAgentId, orphanAgentId, u1, u2, u3, s1, s2, o1 };
  }

  it("indexes projects/sessions/nodes/branch_edges correctly from fixture files", async () => {
    const fx = seedFixture();
    const summary = await runBackfill(db, { projectsDir: fixture.projectsDir });

    expect(summary.projectsFound).toBe(1);
    expect(summary.sessionsFound).toBe(3); // main + 2 subagent sidechains
    expect(summary.sidechainLinksFound).toBe(1);
    expect(summary.sidechainLinksOrphaned).toBe(1);

    const project = db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as { cwd: string } | undefined;
    expect(project).toBeDefined();
    expect(project?.cwd).toBe("/tmp/real-cwd"); // peeked from the chain line's cwd, not the lossy slug fallback

    const sessions = db.prepare(`SELECT id, is_sidechain, agent_id, ai_title FROM sessions ORDER BY id`).all() as {
      id: string;
      is_sidechain: number;
      agent_id: string | null;
      ai_title: string | null;
    }[];
    expect(sessions).toHaveLength(3);
    const mainRow = sessions.find((s) => s.id === fx.mainSessionId);
    expect(mainRow?.is_sidechain).toBe(0);
    expect(mainRow?.ai_title).toBe("My Test Session");
    const linkedRow = sessions.find((s) => s.id === `agent-${fx.linkedAgentId}`);
    expect(linkedRow?.is_sidechain).toBe(1);
    expect(linkedRow?.agent_id).toBe(fx.linkedAgentId);

    const nodeCount = (db.prepare(`SELECT COUNT(*) as c FROM nodes`).get() as { c: number }).c;
    expect(nodeCount).toBe(6); // 3 main + 2 linked sidechain + 1 orphan sidechain

    const edges = db
      .prepare(`SELECT source_node_uuid as src, target_session_id as target, edge_type as type FROM branch_edges`)
      .all() as { src: string; target: string; type: string }[];
    expect(edges).toHaveLength(1); // only the linked sidechain gets an edge; the orphan gets none
    expect(edges[0]).toEqual({ src: fx.u3, target: `agent-${fx.linkedAgentId}`, type: "subagent" });
  });

  it("is idempotent: running backfill twice does not duplicate rows", async () => {
    seedFixture();
    await runBackfill(db, { projectsDir: fixture.projectsDir });
    const countsAfterFirst = {
      projects: (db.prepare(`SELECT COUNT(*) as c FROM projects`).get() as { c: number }).c,
      sessions: (db.prepare(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number }).c,
      nodes: (db.prepare(`SELECT COUNT(*) as c FROM nodes`).get() as { c: number }).c,
      edges: (db.prepare(`SELECT COUNT(*) as c FROM branch_edges`).get() as { c: number }).c,
    };

    await runBackfill(db, { projectsDir: fixture.projectsDir });
    const countsAfterSecond = {
      projects: (db.prepare(`SELECT COUNT(*) as c FROM projects`).get() as { c: number }).c,
      sessions: (db.prepare(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number }).c,
      nodes: (db.prepare(`SELECT COUNT(*) as c FROM nodes`).get() as { c: number }).c,
      edges: (db.prepare(`SELECT COUNT(*) as c FROM branch_edges`).get() as { c: number }).c,
    };

    expect(countsAfterSecond).toEqual(countsAfterFirst);
  });

  it("indexes a sidechain whose first line has a dangling parentUuid instead of aborting the whole file", async () => {
    const mainSessionId = crypto.randomUUID();
    const agentId = "agent-dangling-parent";
    const u1 = crypto.randomUUID();

    const mainFilePath = path.join(fixture.projectsDir, slug, `${mainSessionId}.jsonl`);
    writeJsonlFile(mainFilePath, [
      chainLine({ uuid: u1, parentUuid: null, type: "user", text: "start", toolUseResultAgentId: agentId }),
    ]);

    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    const danglingUuid = crypto.randomUUID(); // never written to any file, on purpose
    const sidechainPath = path.join(fixture.projectsDir, slug, mainSessionId, "subagents", `agent-${agentId}.jsonl`);
    writeJsonlFile(sidechainPath, [
      chainLine({ uuid: s1, parentUuid: danglingUuid, type: "user", text: "lost my real opening line", isSidechain: true }),
      chainLine({ uuid: s2, parentUuid: s1, type: "assistant", text: "still readable", isSidechain: true }),
    ]);

    const summary = await runBackfill(db, { projectsDir: fixture.projectsDir });
    expect(summary.warnings.some((w) => w.includes(danglingUuid))).toBe(true);

    const nodes = db
      .prepare(`SELECT uuid, parent_uuid as parentUuid FROM nodes WHERE session_id = ? ORDER BY seq`)
      .all(`agent-${agentId}`) as { uuid: string; parentUuid: string | null }[];
    expect(nodes).toEqual([
      { uuid: s1, parentUuid: null }, // fell back to a chain root instead of losing the whole file
      { uuid: s2, parentUuid: s1 }, // rest of the chain is unaffected
    ]);

    // still links to its parent conversation via toolUseResult.agentId, not the broken parentUuid
    const edges = db
      .prepare(`SELECT source_node_uuid as src, target_session_id as target FROM branch_edges`)
      .all() as { src: string; target: string }[];
    expect(edges).toEqual([{ src: u1, target: `agent-${agentId}` }]);
  });

  it("returns an empty-but-successful summary when the projects dir doesn't exist", async () => {
    const summary = await runBackfill(db, { projectsDir: path.join(fixture.homeDir, "no-such-dir") });
    expect(summary.projectsFound).toBe(0);
    expect(summary.warnings.length).toBeGreaterThan(0);
  });
});
