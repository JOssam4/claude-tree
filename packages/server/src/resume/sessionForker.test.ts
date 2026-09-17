import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../db/client.js";
import { runBackfill } from "../indexer/backfill.js";
import { chainLine, metadataLine, writeJsonlFile } from "../test/fixtures.js";
import { createFixtureClaudeHome, type FixtureClaudeHome } from "../test/tempHome.js";

// sessionForker.ts is the ONE module allowed to write under CLAUDE_PROJECTS_DIR,
// and it reads that constant from config.ts at module-eval time — so these
// tests must set CLAUDE_TREE_HOME_OVERRIDE and force a fresh module graph
// (vi.resetModules + dynamic import) BEFORE importing sessionForker, or it
// would silently resolve to the real ~/.claude/projects instead of the fixture.
describe("forkSessionFromNode", () => {
  let fixture: FixtureClaudeHome;
  let db: DB;
  let forkSessionFromNode: typeof import("./sessionForker.js").forkSessionFromNode;
  let projectsDir: string;

  beforeEach(async () => {
    fixture = createFixtureClaudeHome();
    projectsDir = fixture.projectsDir;
    vi.stubEnv("CLAUDE_TREE_HOME_OVERRIDE", fixture.homeDir);
    vi.resetModules();
    ({ forkSessionFromNode } = await import("./sessionForker.js"));
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    vi.resetModules();
    fixture.cleanup();
  });

  const slug = "-tmp-fork-project";

  /** UTF-8 multi-byte content styled after prior milestones' fixture data, plus interspersed non-chain metadata lines. */
  function buildFixtureLines(uuids: { u1: string; u2: string; u3: string; u4: string }) {
    return [
      metadataLine("mode", { mode: "default" }),
      chainLine({ uuid: uuids.u1, parentUuid: null, type: "user", text: "banana café☕", cwd: "/tmp/proj" }),
      metadataLine("file-history-snapshot", { snapshot: [] }),
      chainLine({ uuid: uuids.u2, parentUuid: uuids.u1, type: "assistant", text: "pineapple 日本語" }),
      chainLine({ uuid: uuids.u3, parentUuid: uuids.u2, type: "user", text: "mango ümlaut" }),
      metadataLine("cost-state", { cost: 1.23 }),
      chainLine({ uuid: uuids.u4, parentUuid: uuids.u3, type: "assistant", text: "final reply 🎉" }),
    ];
  }

  async function seedSession() {
    const sessionId = crypto.randomUUID();
    const uuids = {
      u1: crypto.randomUUID(),
      u2: crypto.randomUUID(),
      u3: crypto.randomUUID(),
      u4: crypto.randomUUID(),
    };
    const filePath = path.join(projectsDir, slug, `${sessionId}.jsonl`);
    const lines = buildFixtureLines(uuids);
    writeJsonlFile(filePath, lines);
    await runBackfill(db, { projectsDir });
    return { sessionId, filePath, uuids, lines };
  }

  it("reconstructs a byte-exact prefix through the target line, including interspersed metadata and multi-byte UTF-8", async () => {
    const { filePath, uuids } = await seedSession();
    const fixedNewId = crypto.randomUUID();
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(fixedNewId as `${string}-${string}-${string}-${string}-${string}`);

    const result = await forkSessionFromNode(db, uuids.u3); // cut mid-conversation, at the second user turn
    expect(result).not.toBeNull();
    expect(result?.newSessionId).toBe(fixedNewId);

    const newFilePath = path.join(projectsDir, slug, `${fixedNewId}.jsonl`);
    const newContent = fs.readFileSync(newFilePath);

    // Expected: source file's raw lines up to and including u3's line, byte-for-byte.
    const sourceContent = fs.readFileSync(filePath, "utf-8");
    const sourceLines = sourceContent.split("\n").filter((l) => l.length > 0);
    const cutoffIndex = sourceLines.findIndex((l) => JSON.parse(l).uuid === uuids.u3);
    const expected = sourceLines
      .slice(0, cutoffIndex + 1)
      .map((l) => `${l}\n`)
      .join("");

    expect(newContent.toString("utf-8")).toBe(expected);
    expect(Buffer.byteLength(expected, "utf-8")).toBe(newContent.length);

    // The cutoff line (last line of the fork) is exactly the target uuid.
    const newLines = newContent.toString("utf-8").trim().split("\n");
    const lastParsed = JSON.parse(newLines[newLines.length - 1]!);
    expect(lastParsed.uuid).toBe(uuids.u3);

    vi.restoreAllMocks();
  });

  it("includes a target line that is the file's very last line with no trailing newline", async () => {
    const sessionId = crypto.randomUUID();
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const filePath = path.join(projectsDir, slug, `${sessionId}.jsonl`);
    const lines = [
      chainLine({ uuid: u1, parentUuid: null, type: "user", text: "hello" }),
      chainLine({ uuid: u2, parentUuid: u1, type: "assistant", text: "world" }),
    ];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Deliberately no trailing newline on the last line.
    fs.writeFileSync(filePath, lines.join("\n"));
    await runBackfill(db, { projectsDir });

    const fixedNewId = crypto.randomUUID();
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(fixedNewId as `${string}-${string}-${string}-${string}-${string}`);

    const result = await forkSessionFromNode(db, u2);
    expect(result).not.toBeNull();
    const newContent = fs.readFileSync(path.join(projectsDir, slug, `${fixedNewId}.jsonl`), "utf-8");
    expect(newContent).toBe(`${lines[0]}\n${lines[1]}`);

    vi.restoreAllMocks();
  });

  it("refuses to overwrite an existing file at the target path (exclusive-create write safety)", async () => {
    const { uuids } = await seedSession();
    const collisionId = crypto.randomUUID();
    const collisionPath = path.join(projectsDir, slug, `${collisionId}.jsonl`);
    fs.writeFileSync(collisionPath, "pre-existing content, must not be touched\n");

    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(collisionId as `${string}-${string}-${string}-${string}-${string}`);

    await expect(forkSessionFromNode(db, uuids.u2)).rejects.toThrow(/already exists/);

    // Original file must be byte-identical to what it was before the attempted fork.
    expect(fs.readFileSync(collisionPath, "utf-8")).toBe("pre-existing content, must not be touched\n");

    vi.restoreAllMocks();
  });

  it("returns null for an unknown target node uuid", async () => {
    await seedSession();
    const result = await forkSessionFromNode(db, "not-a-real-uuid");
    expect(result).toBeNull();
  });
});
