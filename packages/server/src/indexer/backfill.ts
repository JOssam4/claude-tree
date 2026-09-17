/**
 * Full backfill: streams every existing session .jsonl (+ subagent sidechain
 * .jsonl) file under ~/.claude/projects/** into this app's own SQLite DB.
 *
 * STRICTLY READ-ONLY with respect to ~/.claude/projects/** — this module
 * never calls fs.writeFile/rm/rename/etc. on anything under that tree, only
 * fs.readdirSync/statSync/createReadStream/openSync("r"). All writes go to
 * the `db` handle passed in, which lives under this app's own data/ dir.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { BackfillSummary } from "@claude-tree/shared";
import { CLAUDE_PROJECTS_DIR } from "../config.js";
import type { DB } from "../db/client.js";
import { parseLine } from "./jsonlParser.js";
import { linkSidechain, parseAgentIdFromFilename } from "./sidechainLinker.js";

const TITLE_FALLBACK_MAX_LEN = 200;

function nowIso(): string {
  return new Date().toISOString();
}

interface SessionIndexResult {
  createdAt: string;
  aiTitle: string | null;
  nodeCount: number;
  /** {toolUseResult.agentId -> node uuid}, collected while indexing this session's chain, for later subagent sidechain joins. */
  agentIdToNodeUuid: Map<string, string>;
  cwd: string | null;
  warnings: string[];
  /**
   * Bytes actually consumed from the file by this indexing pass, taken from
   * the underlying read stream's own counter rather than a post-hoc
   * fs.statSync(filePath).size. This matters because the file can be a live
   * Claude Code session that keeps growing (e.g. this very indexer running
   * inside a session that's actively being appended to) — stat'ing after the
   * fact would race and could report an offset larger than what was actually
   * parsed and inserted, causing a future incremental tailer to silently skip
   * unindexed trailing lines. Stream bytesRead reflects exactly how far this
   * pass actually read, immune to growth that happens after EOF.
   */
  bytesRead: number;
}

/** Streams one session (or subagent sidechain) .jsonl file into the `nodes` table in a single forward pass. */
async function indexSessionFile(db: DB, filePath: string, sessionId: string): Promise<SessionIndexResult> {
  const agentIdToNodeUuid = new Map<string, string>();
  const warnings: string[] = [];
  let seq = 0;
  let createdAt: string | null = null;
  let aiTitle: string | null = null;
  let titleFallback: string | null = null;
  let cwd: string | null = null;

  // uuid is PRIMARY KEY; OR IGNORE makes re-running backfill against an
  // already-populated DB safe (historical lines are immutable once written).
  const insertNode = db.prepare(
    `INSERT OR IGNORE INTO nodes (uuid, session_id, parent_uuid, type, role, content_text, content_raw, timestamp, seq)
     VALUES (@uuid, @sessionId, @parentUuid, @type, @role, @contentText, @contentRaw, @timestamp, @seq)`,
  );

  const readStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: readStream,
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const rawLine of rl) {
    lineNo++;
    if (rawLine.trim().length === 0) continue;

    const parsed = parseLine(rawLine);

    if (parsed.kind === "error") {
      warnings.push(`${filePath}:${lineNo}: ${parsed.message}`);
      continue;
    }
    if (parsed.kind === "title") {
      aiTitle = parsed.aiTitle;
      continue;
    }
    if (parsed.kind === "ignore") continue;

    // parsed.kind === "chain"
    if (createdAt === null) createdAt = parsed.timestamp || nowIso();
    if (cwd === null && parsed.cwd) cwd = parsed.cwd;
    if (titleFallback === null && parsed.type === "user" && parsed.contentText) {
      titleFallback = parsed.contentText.slice(0, TITLE_FALLBACK_MAX_LEN);
    }
    // See sidechainLinker.ts: this is the undocumented join key for Task subagent sidechains.
    if (parsed.toolUseResultAgentId) {
      agentIdToNodeUuid.set(parsed.toolUseResultAgentId, parsed.uuid);
    }

    insertNode.run({
      uuid: parsed.uuid,
      sessionId,
      parentUuid: parsed.parentUuid,
      type: parsed.type,
      role: parsed.role,
      contentText: parsed.contentText,
      contentRaw: parsed.raw,
      timestamp: parsed.timestamp,
      seq: seq++,
    });
  }

  return {
    createdAt: createdAt ?? nowIso(),
    aiTitle: aiTitle ?? titleFallback,
    nodeCount: seq,
    agentIdToNodeUuid,
    cwd,
    warnings,
    bytesRead: readStream.bytesRead,
  };
}

/**
 * Cheap bounded peek (first 8KB, not the whole file) at a project's session
 * files to recover its real cwd from a chain line's `cwd` field. Preferred
 * over reverse-slugifying the directory name, which is lossy: slugs are a
 * pure `/` -> `-` replace, so e.g. a literal `-` in a real path segment is
 * indistinguishable from a directory separator once slugified.
 */
function peekProjectCwd(projectDir: string, sessionFileNames: string[]): string | null {
  const buf = Buffer.alloc(8192);
  for (const name of sessionFileNames) {
    const filePath = path.join(projectDir, name);
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, "r");
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf-8", 0, bytesRead);
      // Drop the last (possibly truncated-by-the-8KB-cutoff) line.
      const lines = text.split("\n").slice(0, -1);
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseLine(line);
        if (parsed.kind === "chain" && parsed.cwd) return parsed.cwd;
      }
    } catch {
      // Unreadable/vanished file — try the next session file in this project.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return null;
}

export interface BackfillOptions {
  /** Override for testing; defaults to the real ~/.claude/projects. */
  projectsDir?: string;
}

export async function runBackfill(db: DB, options: BackfillOptions = {}): Promise<BackfillSummary> {
  const projectsDir = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
  const warnings: string[] = [];
  let projectsFound = 0;
  let sessionsFound = 0;
  let nodesInserted = 0;
  let sidechainLinksFound = 0;
  let sidechainLinksOrphaned = 0;

  if (!fs.existsSync(projectsDir)) {
    return {
      projectsFound: 0,
      sessionsFound: 0,
      nodesInserted: 0,
      sidechainLinksFound: 0,
      sidechainLinksOrphaned: 0,
      warnings: [`projects dir not found: ${projectsDir}`],
    };
  }

  const upsertProject = db.prepare(`
    INSERT INTO projects (slug, cwd, first_seen_at, last_seen_at)
    VALUES (@slug, @cwd, @firstSeenAt, @lastSeenAt)
    ON CONFLICT(slug) DO UPDATE SET
      cwd = excluded.cwd,
      first_seen_at = min(projects.first_seen_at, excluded.first_seen_at),
      last_seen_at = max(projects.last_seen_at, excluded.last_seen_at)
  `);
  const getProject = db.prepare(`SELECT id FROM projects WHERE slug = ?`);
  const updateProjectSeenAt = db.prepare(`UPDATE projects SET first_seen_at = ?, last_seen_at = ? WHERE id = ?`);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, project_id, file_path, is_sidechain, agent_id, ai_title, created_at, last_indexed_at, last_byte_offset, is_synthetic)
    VALUES (@id, @projectId, @filePath, @isSidechain, @agentId, @aiTitle, @createdAt, @lastIndexedAt, @lastByteOffset, 0)
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      is_sidechain = excluded.is_sidechain,
      agent_id = excluded.agent_id,
      ai_title = excluded.ai_title,
      created_at = excluded.created_at,
      last_indexed_at = excluded.last_indexed_at,
      last_byte_offset = excluded.last_byte_offset
  `);

  const projectDirents = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const dirent of projectDirents) {
    const slug = dirent.name;
    const projectDir = path.join(projectsDir, slug);

    const topLevelEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    const sessionFileEntries = topLevelEntries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"));
    // A session-uuid subdirectory containing a subagents/ folder holds Task-tool
    // sidechains for that session. Other subdirectories (e.g. this machine has a
    // "memory" notes folder in some project dirs) are unrelated and skipped.
    const sidechainContainerDirs = topLevelEntries.filter(
      (e) => e.isDirectory() && fs.existsSync(path.join(projectDir, e.name, "subagents")),
    );

    if (sessionFileEntries.length === 0 && sidechainContainerDirs.length === 0) {
      continue; // e.g. a project dir with only a memory/ notes folder and no conversations yet
    }

    projectsFound++;

    const peekedCwd = peekProjectCwd(
      projectDir,
      sessionFileEntries.map((e) => e.name),
    );
    const cwd = peekedCwd ?? slug.replace(/-/g, "/"); // lossy fallback only, see peekProjectCwd doc comment

    const seedTimestamp = nowIso();
    upsertProject.run({ slug, cwd, firstSeenAt: seedTimestamp, lastSeenAt: seedTimestamp });
    const projectRow = getProject.get(slug) as { id: number } | undefined;
    if (!projectRow) throw new Error(`invariant violated: project '${slug}' missing immediately after upsert`);
    const projectId = projectRow.id;

    const perSessionAgentMap = new Map<string, Map<string, string>>();
    let projectFirstSeen: string | null = null;
    let projectLastSeen: string | null = null;

    for (const entry of sessionFileEntries) {
      const sessionId = entry.name.replace(/\.jsonl$/, "");
      const filePath = path.join(projectDir, entry.name);
      sessionsFound++;

      // Nodes carry a FK to sessions(id), so the session row must exist
      // before any of its nodes are inserted — seed it with placeholder
      // stats now, then upsert the real stats once indexing finishes below.
      upsertSession.run({
        id: sessionId,
        projectId,
        filePath,
        isSidechain: 0,
        agentId: null,
        aiTitle: null,
        createdAt: nowIso(),
        lastIndexedAt: nowIso(),
        lastByteOffset: 0,
      });

      let result: SessionIndexResult;
      try {
        result = await indexSessionFile(db, filePath, sessionId);
      } catch (err) {
        // A single file-level failure (e.g. a transient read error, or the
        // file vanishing mid-read) must not abort the rest of the backfill.
        // The session row is left with its placeholder stats (last_byte_offset
        // 0), which honestly reflects "not confirmed fully indexed"; any nodes
        // that *did* get inserted before the throw are still safe (uuid is the
        // primary key with INSERT OR IGNORE), and a subsequent backfill run
        // will simply re-read the whole file from the start and fill in the
        // rest idempotently.
        warnings.push(`${filePath}: failed to index: ${(err as Error).message}`);
        continue;
      }
      nodesInserted += result.nodeCount;
      warnings.push(...result.warnings);
      perSessionAgentMap.set(sessionId, result.agentIdToNodeUuid);

      if (!projectFirstSeen || result.createdAt < projectFirstSeen) projectFirstSeen = result.createdAt;
      if (!projectLastSeen || result.createdAt > projectLastSeen) projectLastSeen = result.createdAt;

      upsertSession.run({
        id: sessionId,
        projectId,
        filePath,
        isSidechain: 0,
        agentId: null,
        aiTitle: result.aiTitle,
        createdAt: result.createdAt,
        lastIndexedAt: nowIso(),
        lastByteOffset: result.bytesRead,
      });
    }

    for (const containerDir of sidechainContainerDirs) {
      const parentSessionId = containerDir.name;
      const subagentsDir = path.join(projectDir, containerDir.name, "subagents");
      const agentIdToNodeUuid = perSessionAgentMap.get(parentSessionId) ?? new Map<string, string>();

      let subagentFileNames: string[] = [];
      try {
        subagentFileNames = fs.readdirSync(subagentsDir).filter((f) => f.endsWith(".jsonl"));
      } catch (err) {
        warnings.push(`could not read subagents dir ${subagentsDir}: ${(err as Error).message}`);
        continue;
      }

      for (const fileName of subagentFileNames) {
        const agentId = parseAgentIdFromFilename(fileName);
        if (!agentId) {
          warnings.push(`skipping unrecognized file in subagents dir: ${path.join(subagentsDir, fileName)}`);
          continue;
        }

        const filePath = path.join(subagentsDir, fileName);
        // Sidechain files reuse the PARENT session's sessionId internally, so we
        // mint our own session id for them rather than colliding with it.
        const sidechainSessionId = `agent-${agentId}`;
        sessionsFound++;

        // Same ordering requirement as above: seed the session row before indexing its nodes.
        upsertSession.run({
          id: sidechainSessionId,
          projectId,
          filePath,
          isSidechain: 1,
          agentId,
          aiTitle: null,
          createdAt: nowIso(),
          lastIndexedAt: nowIso(),
          lastByteOffset: 0,
        });

        let result: SessionIndexResult;
        try {
          result = await indexSessionFile(db, filePath, sidechainSessionId);
        } catch (err) {
          warnings.push(`${filePath}: failed to index: ${(err as Error).message}`);
          continue;
        }
        nodesInserted += result.nodeCount;
        warnings.push(...result.warnings);

        if (!projectFirstSeen || result.createdAt < projectFirstSeen) projectFirstSeen = result.createdAt;
        if (!projectLastSeen || result.createdAt > projectLastSeen) projectLastSeen = result.createdAt;

        upsertSession.run({
          id: sidechainSessionId,
          projectId,
          filePath,
          isSidechain: 1,
          agentId,
          aiTitle: result.aiTitle,
          createdAt: result.createdAt,
          lastIndexedAt: nowIso(),
          lastByteOffset: result.bytesRead,
        });

        const linkResult = linkSidechain(db, agentId, sidechainSessionId, agentIdToNodeUuid);
        if (linkResult.linked) {
          sidechainLinksFound++;
        } else {
          sidechainLinksOrphaned++;
          warnings.push(
            `orphaned sidechain: no toolUseResult.agentId match for agent-${agentId} in parent session ${parentSessionId} ` +
              `(this join is undocumented Claude Code internal behavior and may have changed)`,
          );
        }
      }
    }

    if (projectFirstSeen && projectLastSeen) {
      updateProjectSeenAt.run(projectFirstSeen, projectLastSeen, projectId);
    }
  }

  return { projectsFound, sessionsFound, nodesInserted, sidechainLinksFound, sidechainLinksOrphaned, warnings };
}
