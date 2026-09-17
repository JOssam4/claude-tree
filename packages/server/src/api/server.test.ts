import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chainLine, writeJsonlFile } from "../test/fixtures.js";
import { createFixtureClaudeHome, type FixtureClaudeHome } from "../test/tempHome.js";

// The branch endpoint (POST /api/nodes/:uuid/branch) goes through
// sessionForker.ts, which reads CLAUDE_PROJECTS_DIR from config.ts at
// module-eval time — same reasoning as sessionForker.test.ts: stub the env
// override and force a fresh module graph before importing the server.
describe("API routes (Fastify .inject, temp fixture DB + fixture projects dir)", () => {
  let fixture: FixtureClaudeHome;
  let db: import("../db/client.js").DB;
  let apiServer: import("./server.js").ApiServer;
  const slug = "-tmp-api-project";
  let sessionId: string;
  let rootUuid: string;
  let leafUuid: string;

  beforeAll(async () => {
    fixture = createFixtureClaudeHome();
    vi.stubEnv("CLAUDE_TREE_HOME_OVERRIDE", fixture.homeDir);
    vi.resetModules();

    const { openDb } = await import("../db/client.js");
    const { runBackfill } = await import("../indexer/backfill.js");
    const { createApiServer } = await import("./server.js");

    sessionId = crypto.randomUUID();
    rootUuid = crypto.randomUUID();
    leafUuid = crypto.randomUUID();
    const filePath = path.join(fixture.projectsDir, slug, `${sessionId}.jsonl`);
    writeJsonlFile(filePath, [
      chainLine({ uuid: rootUuid, parentUuid: null, type: "user", text: "hello", cwd: "/tmp/api-cwd" }),
      chainLine({ uuid: leafUuid, parentUuid: rootUuid, type: "assistant", text: "hi there" }),
    ]);

    db = openDb(":memory:");
    await runBackfill(db, { projectsDir: fixture.projectsDir });
    apiServer = await createApiServer(db);
  });

  afterAll(async () => {
    await apiServer.close();
    db.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    fixture.cleanup();
  });

  it("GET /api/projects lists the fixture project", async () => {
    const res = await apiServer.app.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { slug: string; sessionCount: number; rootSessionCount: number }[];
    const project = body.find((p) => p.slug === slug);
    expect(project).toBeDefined();
    expect(project?.sessionCount).toBe(1);
    expect(project?.rootSessionCount).toBe(1);
  });

  it("GET /api/projects/:slug/tree returns the forest, and reflects a nested fork after branching", async () => {
    const before = await apiServer.app.inject({ method: "GET", url: `/api/projects/${slug}/tree` });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as { roots: { session: { id: string }; nodes: unknown[]; forks: unknown[] }[] };
    expect(beforeBody.roots).toHaveLength(1);
    expect(beforeBody.roots[0]?.session.id).toBe(sessionId);
    expect(beforeBody.roots[0]?.nodes).toHaveLength(2);
    expect(beforeBody.roots[0]?.forks).toHaveLength(0);

    const branchRes = await apiServer.app.inject({ method: "POST", url: `/api/nodes/${leafUuid}/branch` });
    expect(branchRes.statusCode).toBe(200);
    const { newSessionId } = branchRes.json() as { newSessionId: string };

    const after = await apiServer.app.inject({ method: "GET", url: `/api/projects/${slug}/tree` });
    const afterBody = after.json() as {
      roots: { forks: { edgeType: string; sourceNodeUuid: string; session: { session: { id: string } } }[] }[];
    };
    expect(afterBody.roots[0]?.forks).toHaveLength(1);
    const fork = afterBody.roots[0]!.forks[0]!;
    expect(fork.edgeType).toBe("branch");
    expect(fork.sourceNodeUuid).toBe(leafUuid);
    expect(fork.session.session.id).toBe(newSessionId);
  });

  it("GET /api/nodes/:uuid returns 200 with ancestry for a real node, and 404 for an unknown one", async () => {
    const ok = await apiServer.app.inject({ method: "GET", url: `/api/nodes/${leafUuid}` });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { node: { uuid: string }; ancestry: { path: { uuid: string }[] } };
    expect(body.node.uuid).toBe(leafUuid);
    expect(body.ancestry.path.map((n) => n.uuid)).toEqual([rootUuid, leafUuid]);

    const missing = await apiServer.app.inject({
      method: "GET",
      url: `/api/nodes/${crypto.randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("POST /api/nodes/:uuid/branch writes the new fixture file into the temp projects dir and inserts correct DB rows", async () => {
    const res = await apiServer.app.inject({ method: "POST", url: `/api/nodes/${rootUuid}/branch` });
    expect(res.statusCode).toBe(200);
    const { newSessionId } = res.json() as { newSessionId: string };

    const newFilePath = path.join(fixture.projectsDir, slug, `${newSessionId}.jsonl`);
    expect(fs.existsSync(newFilePath)).toBe(true);
    const content = fs.readFileSync(newFilePath, "utf-8").trim().split("\n");
    expect(content).toHaveLength(1); // only the root line, since we branched from the root node
    expect(JSON.parse(content[0]!).uuid).toBe(rootUuid);

    const sessionRow = db
      .prepare(`SELECT is_synthetic as isSynthetic, file_path as filePath FROM sessions WHERE id = ?`)
      .get(newSessionId) as { isSynthetic: number; filePath: string } | undefined;
    expect(sessionRow?.isSynthetic).toBe(1);
    expect(sessionRow?.filePath).toBe(newFilePath);

    const edgeRow = db
      .prepare(`SELECT source_node_uuid as src, edge_type as type FROM branch_edges WHERE target_session_id = ?`)
      .get(newSessionId) as { src: string; type: string } | undefined;
    expect(edgeRow).toEqual({ src: rootUuid, type: "branch" });
  });

  it("POST /api/nodes/:uuid/branch returns 404 for an unknown node uuid", async () => {
    const res = await apiServer.app.inject({ method: "POST", url: `/api/nodes/${crypto.randomUUID()}/branch` });
    expect(res.statusCode).toBe(404);
  });
});
