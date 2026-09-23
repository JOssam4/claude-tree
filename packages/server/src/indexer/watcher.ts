/**
 * Live, incremental file watcher on top of the one-shot backfill indexer.
 *
 * STRICTLY READ-ONLY with respect to ~/.claude/projects/** — this module only
 * ever calls fs.statSync/openSync("r")/fstatSync/readSync/closeSync (directly,
 * or via backfill.ts's indexSessionFile / tailReader.ts) on files under
 * CLAUDE_PROJECTS_DIR. All writes go to the `db` handle passed in.
 *
 * Responsibilities:
 *  - `add`    -> full index from byte 0 (same function backfill.ts uses).
 *  - `change` -> tail-index only the bytes after the session's stored
 *                last_byte_offset (see tailIndexer.ts / tailReader.ts).
 *  - shrink detection -> defensive full re-index (see handleChange below).
 *  - debounced per-file dispatch, serialized per file path so overlapping
 *    events for the same file can never race on last_byte_offset.
 */
import fs from "node:fs";
import path from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { TreeUpdateEvent } from "@claude-tree/shared";
import { CLAUDE_PROJECTS_DIR } from "../config.js";
import type { DB } from "../db/client.js";
import { indexSessionFile } from "./backfill.js";
import { tailIndexFile } from "./tailIndexer.js";
import { linkSidechain, parseAgentIdFromFilename } from "./sidechainLinker.js";
import { linkContinuation } from "./continuationLinker.js";

/** Trailing debounce per file path for `change` events — Claude Code can write several lines within milliseconds during one turn. */
const DEBOUNCE_MS = 75;

export type WatcherLogFn = (message: string) => void;
export type WatcherUpdateFn = (event: TreeUpdateEvent) => void;

export interface TreeWatcherHandle {
  /** Stops the underlying chokidar watcher and waits for any in-flight indexing to settle. */
  close(): Promise<void>;
}

interface FileContext {
  slug: string;
  isSidechain: boolean;
  /** `sessionId` for a normal session file, or `agent-<agentId>` for a subagent sidechain file. */
  sessionId: string;
  agentId: string | null;
  /** Parent session's id, sidechain files only. */
  parentSessionId: string | null;
}

/**
 * Determines project slug / session id / sidechain-ness purely from a
 * discovered file's path relative to CLAUDE_PROJECTS_DIR, mirroring the two
 * shapes backfill.ts's directory walk recognizes:
 *   <projectsDir>/<slug>/<sessionId>.jsonl
 *   <projectsDir>/<slug>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 * Returns null for anything else (defensively ignored, not an error).
 */
function resolveFileContext(filePath: string): FileContext | null {
  const rel = path.relative(CLAUDE_PROJECTS_DIR, filePath);
  const parts = rel.split(path.sep);

  if (parts.length === 2) {
    const slug = parts[0] ?? "";
    const fileName = parts[1] ?? "";
    if (!slug || !fileName.endsWith(".jsonl")) return null;
    return {
      slug,
      isSidechain: false,
      sessionId: fileName.replace(/\.jsonl$/, ""),
      agentId: null,
      parentSessionId: null,
    };
  }

  if (parts.length === 4 && parts[2] === "subagents") {
    const slug = parts[0] ?? "";
    const parentSessionId = parts[1] ?? "";
    const fileName = parts[3] ?? "";
    const agentId = parseAgentIdFromFilename(fileName);
    if (!slug || !parentSessionId || !agentId) return null;
    return {
      slug,
      isSidechain: true,
      sessionId: `agent-${agentId}`,
      agentId,
      parentSessionId,
    };
  }

  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function upsertProjectAndGetId(db: DB, slug: string, cwdHint: string | null): number {
  const now = nowIso();
  // Lossy fallback only (pure `/` <-> `-` replace) — same convention as backfill.ts's
  // peekProjectCwd fallback; replaced with the real cwd once a chain line supplies one.
  const cwd = cwdHint ?? slug.replace(/-/g, "/");
  db.prepare(
    `INSERT INTO projects (slug, cwd, first_seen_at, last_seen_at)
     VALUES (@slug, @cwd, @now, @now)
     ON CONFLICT(slug) DO UPDATE SET
       last_seen_at = excluded.last_seen_at`,
  ).run({ slug, cwd, now });
  const row = db.prepare(`SELECT id FROM projects WHERE slug = ?`).get(slug) as { id: number };
  return row.id;
}

function updateProjectCwd(db: DB, projectId: number, cwd: string | null): void {
  if (!cwd) return;
  db.prepare(`UPDATE projects SET cwd = ?, last_seen_at = ? WHERE id = ?`).run(cwd, nowIso(), projectId);
}

function getSessionRow(
  db: DB,
  sessionId: string,
): { id: string; projectId: number; lastByteOffset: number } | undefined {
  return db
    .prepare(`SELECT id, project_id as projectId, last_byte_offset as lastByteOffset FROM sessions WHERE id = ?`)
    .get(sessionId) as { id: string; projectId: number; lastByteOffset: number } | undefined;
}

/**
 * Best-effort join of a just-(re)indexed subagent sidechain file back to its
 * invocation point in the parent session's main chain. Same undocumented
 * `toolUseResult.agentId` join key as sidechainLinker.ts / backfill.ts, but
 * reconstructed here by scanning the parent session's already-indexed
 * content_raw (backfill's in-memory {agentId -> node uuid} map only lives for
 * the duration of a single backfill pass, so the watcher — which reacts to
 * files arriving independently, possibly long after the parent was indexed —
 * has no such map available and must recover it from the DB instead).
 *
 * A sidechain file typically receives many `change` events over its lifetime
 * (one per debounced write burst), but the link only needs to be established
 * once. Without this check, every single tail event for an active subagent
 * would re-scan and JSON.parse *every* node in the parent session's
 * content_raw looking for a match that was already found minutes ago —
 * observed directly against a live long-running subagent session during
 * review (15+ tail events in under 30s, each re-scanning the full parent
 * chain). Bail out immediately once a link already exists for this sidechain
 * session so the expensive scan only ever runs while still unlinked.
 */
function linkSidechainForFile(
  db: DB,
  parentSessionId: string,
  agentId: string,
  sidechainSessionId: string,
  log: WatcherLogFn,
): void {
  const alreadyLinked = db
    .prepare(`SELECT 1 FROM branch_edges WHERE target_session_id = ? AND edge_type = 'subagent'`)
    .get(sidechainSessionId);
  if (alreadyLinked) return;

  const rows = db.prepare(`SELECT uuid, content_raw as contentRaw FROM nodes WHERE session_id = ?`).all(
    parentSessionId,
  ) as { uuid: string; contentRaw: string }[];

  let sourceNodeUuid: string | null = null;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.contentRaw) as { toolUseResult?: { agentId?: unknown } };
      if (parsed.toolUseResult && parsed.toolUseResult.agentId === agentId) {
        sourceNodeUuid = row.uuid;
        break;
      }
    } catch {
      // Malformed content_raw should be unreachable (it's a verbatim line we already parsed once), skip defensively.
    }
  }

  const map = sourceNodeUuid ? new Map([[agentId, sourceNodeUuid]]) : new Map<string, string>();
  const result = linkSidechain(db, agentId, sidechainSessionId, map);
  if (!result.linked) {
    log(
      `[watcher] warning: orphaned sidechain agent-${agentId} (no toolUseResult.agentId match yet in parent session ${parentSessionId}; ` +
        `this join is undocumented Claude Code internal behavior, may be a timing issue if the parent hasn't been indexed yet, or may have changed)`,
    );
  }
}

/** Full index from byte 0 — used for a brand-new file (`add`) and for a detected compaction/rewrite (full re-index fallback). */
async function handleAdd(db: DB, filePath: string, onUpdate: WatcherUpdateFn, log: WatcherLogFn): Promise<void> {
  const ctx = resolveFileContext(filePath);
  if (!ctx) return; // Path shape we don't recognize (e.g. a sibling .meta.json) — ignore defensively, not an error.

  const now = nowIso();
  const projectId = upsertProjectAndGetId(db, ctx.slug, null);

  db.prepare(
    `INSERT INTO sessions (id, project_id, file_path, is_sidechain, agent_id, ai_title, created_at, last_indexed_at, last_byte_offset, is_synthetic)
     VALUES (@id, @projectId, @filePath, @isSidechain, @agentId, NULL, @now, @now, 0, 0)
     ON CONFLICT(id) DO UPDATE SET file_path = excluded.file_path`,
  ).run({
    id: ctx.sessionId,
    projectId,
    filePath,
    isSidechain: ctx.isSidechain ? 1 : 0,
    agentId: ctx.agentId,
    now,
  });

  let result;
  try {
    result = await indexSessionFile(db, filePath, ctx.sessionId);
  } catch (err) {
    log(`[watcher] error: failed to index ${filePath}: ${(err as Error).message}`);
    return;
  }

  db.prepare(
    `UPDATE sessions SET ai_title = @aiTitle, created_at = @createdAt, last_indexed_at = @now, last_byte_offset = @bytesRead
     WHERE id = @id`,
  ).run({ id: ctx.sessionId, aiTitle: result.aiTitle, createdAt: result.createdAt, now, bytesRead: result.bytesRead });

  updateProjectCwd(db, projectId, result.cwd);

  if (ctx.isSidechain && ctx.parentSessionId && ctx.agentId) {
    linkSidechainForFile(db, ctx.parentSessionId, ctx.agentId, ctx.sessionId, log);
  } else if (!ctx.isSidechain) {
    linkContinuation(db, ctx.sessionId);
  }

  for (const w of result.warnings) log(`[watcher] ${w}`);

  if (result.addedNodeUuids.length > 0) {
    log(`[watcher] indexed new file ${filePath}: +${result.addedNodeUuids.length} nodes`);
    onUpdate({ projectSlug: ctx.slug, sessionId: ctx.sessionId, addedNodeUuids: result.addedNodeUuids });
  }
}

/** Incremental tail from the session's stored last_byte_offset, with shrink (compaction/rewrite) detection. */
async function handleChange(db: DB, filePath: string, onUpdate: WatcherUpdateFn, log: WatcherLogFn): Promise<void> {
  const ctx = resolveFileContext(filePath);
  if (!ctx) return;

  const session = getSessionRow(db, ctx.sessionId);
  if (!session) {
    // We've never indexed this file (e.g. an 'add' event was somehow missed) — treat as brand new.
    await handleAdd(db, filePath, onUpdate, log);
    return;
  }

  let currentSize: number;
  try {
    currentSize = fs.statSync(filePath).size;
  } catch {
    return; // File vanished between the event firing and this stat — nothing to do.
  }

  if (currentSize < session.lastByteOffset) {
    // VERIFIED (Milestone 6 spike, 2026-09-16, Claude Code CLI v2.1.274):
    // deliberately triggered a real `/compact` in a scratch session on this
    // machine (throwaway cwd, node-pty-scripted interactive session) and
    // diffed the .jsonl before/after byte-for-byte. Compaction is strictly
    // APPEND-ONLY — every pre-compaction line stays exactly where it was,
    // untouched; Claude Code appends a new `system` line followed by a
    // `user` line holding the compacted summary text ("This session is
    // being continued from a previous conversation that ran out of
    // context..."), then continues the conversation normally. The file only
    // ever grew (56 lines / ~266KB in the observed run) across the compact
    // event — it was never truncated or rewritten in place.
    //
    // One related wrinkle worth recording even though it's out of scope for
    // this shrink check: the appended post-compaction `system` line has
    // `parentUuid: null`, i.e. compaction starts a *second* chain root
    // within the same session file rather than chaining onto the
    // pre-compaction tail. That affects ancestry-walking (a node whose
    // ancestry crosses a compaction boundary will stop at the new root) but
    // not this indexer, which groups/orders purely by append position
    // (`seq`), not by walking parentUuid.
    //
    // So: on this Claude Code version, `currentSize < last_byte_offset`
    // genuinely never fires as a result of compaction. If it fires anyway,
    // it means something else rewrote/truncated the file out from under us
    // (a future Claude Code version changing this behavior, manual editing,
    // filesystem weirdness, etc.) — treating that as "rewritten, re-index
    // fully" remains the correct, safe fallback either way.
    log(
      `[watcher] WARNING: ${filePath} shrank (size=${currentSize} < last_byte_offset=${session.lastByteOffset}); ` +
        `treating as rewritten/compacted and re-indexing fully from byte 0`,
    );
    // NOTE: pre-existing gap, not fixed here — this deletes nodes without first
    // deleting any branch_edges rows sourced from them, which would throw
    // SQLITE_CONSTRAINT_FOREIGNKEY today if this session ever sourced a
    // branch/subagent edge. See prune.ts's pruneOneSession for the correct
    // branch_edges -> nodes -> sessions ordering.
    db.prepare(`DELETE FROM nodes WHERE session_id = ?`).run(ctx.sessionId);
    db.prepare(`UPDATE sessions SET last_byte_offset = 0 WHERE id = ?`).run(ctx.sessionId);
    await handleAdd(db, filePath, onUpdate, log);
    return;
  }

  const result = tailIndexFile(db, filePath, ctx.sessionId, session.lastByteOffset);
  for (const w of result.warnings) log(`[watcher] ${w}`);

  if (result.newByteOffset === session.lastByteOffset) return; // No new complete line yet — nothing to persist.

  const now = nowIso();
  db.prepare(
    `UPDATE sessions SET last_byte_offset = ?, last_indexed_at = ?, ai_title = COALESCE(?, ai_title) WHERE id = ?`,
  ).run(result.newByteOffset, now, result.aiTitle, ctx.sessionId);

  updateProjectCwd(db, session.projectId, result.cwd);

  if (ctx.isSidechain && ctx.parentSessionId && ctx.agentId) {
    linkSidechainForFile(db, ctx.parentSessionId, ctx.agentId, ctx.sessionId, log);
  } else if (!ctx.isSidechain) {
    // A continuation file's copied history can arrive before its first new
    // line (the one parented into the original session), so keep checking
    // on tail passes too — cheap, and a no-op once an edge exists.
    linkContinuation(db, ctx.sessionId);
  }

  if (result.addedNodeUuids.length > 0) {
    log(
      `[watcher] tailed ${filePath}: +${result.addedNodeUuids.length} nodes ` +
        `(offset ${session.lastByteOffset} -> ${result.newByteOffset})`,
    );
    onUpdate({ projectSlug: ctx.slug, sessionId: ctx.sessionId, addedNodeUuids: result.addedNodeUuids });
  }
}

/**
 * Starts watching ~/.claude/projects/**\/*.jsonl (via CLAUDE_PROJECTS_DIR,
 * never hardcoded) for new files and appended lines, indexing incrementally
 * into `db`. Call `runBackfill` first — this only reacts to filesystem events
 * from the moment it starts (`ignoreInitial: true`), it does not itself do an
 * initial full scan.
 *
 * `onUpdate` fires once per file per indexing pass that actually committed
 * new nodes, shaped to match the plan's WS `tree:update` message
 * (@claude-tree/shared's `TreeUpdateEvent`) so Milestone 3's WebSocket server
 * can wire this straight through without this module changing.
 */
export function startWatcher(db: DB, onUpdate: WatcherUpdateFn, log: WatcherLogFn = console.log): TreeWatcherHandle {
  // Per-file promise chain so overlapping events (e.g. a debounced 'change'
  // firing while a slow 'add' full-index is still running) for the SAME file
  // are always handled one at a time, never concurrently racing on that
  // file's last_byte_offset.
  const fileQueues = new Map<string, Promise<void>>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function runSerialized(filePath: string, fn: () => Promise<void>): void {
    const prev = fileQueues.get(filePath) ?? Promise.resolve();
    const next = prev.then(fn).catch((err: unknown) => {
      log(`[watcher] error handling ${filePath}: ${(err as Error).message}`);
    });
    fileQueues.set(filePath, next);
  }

  // NOTE: chokidar is given the directory itself, not a `**/*.jsonl` glob
  // string. Verified on this machine (WSL2 + chokidar v5) that glob-pattern
  // watching silently fires no add/change events at all here — even a
  // single-level `*.jsonl` glob never emitted anything, while a plain
  // directory watch (recursive by default, including newly-created nested
  // subdirectories such as a session's subagents/ folder appearing after
  // watch start) worked correctly. Filtering to `.jsonl` in the handlers
  // below sidesteps that glob issue entirely and is more robust regardless
  // of its cause.
  const watcher: FSWatcher = chokidarWatch(CLAUDE_PROJECTS_DIR, {
    // Pre-existing files are the backfill's job; the watcher only reacts to
    // filesystem events from the moment it starts.
    ignoreInitial: true,
    // usePolling: chokidar's default native-fs-event watch (inotify, via
    // fsevents/node's fs.watch) was reproduced (isolated down to a minimal
    // chokidar.watch(CLAUDE_PROJECTS_DIR) + bare `ws` server repro, no
    // Fastify/DB/app code involved) to destroy ANY concurrently-open
    // WebSocket connection in this process within ~a few hundred ms, 100%
    // reproducibly, whenever it was actively watching this user's real
    // ~/.claude/projects on WSL2 (9p/drvfs-backed). Root cause is believed to
    // be an fd/event-loop interaction between native recursive fs watching
    // and concurrently-open sockets under WSL2's filesystem backend — the
    // exact mechanism doesn't matter as much as the fix. Polling sidesteps
    // native fs-event watching entirely and is the standard, documented
    // remedy for this class of chokidar-on-WSL2/network-fs issue. DO NOT
    // remove/"simplify" this back to the default without re-verifying the WS
    // stability repro (see packages/server's Milestone 3 WS-fix task) first.
    usePolling: true,
    interval: 750, // text file polling interval; this dir has few files, no need to poll faster.
    binaryInterval: 750,
  });

  watcher.on("add", (filePath: string) => {
    if (!filePath.endsWith(".jsonl")) return;
    runSerialized(filePath, () => handleAdd(db, filePath, onUpdate, log));
  });

  watcher.on("change", (filePath: string) => {
    if (!filePath.endsWith(".jsonl")) return;
    const existing = pendingTimers.get(filePath);
    if (existing) clearTimeout(existing);
    pendingTimers.set(
      filePath,
      setTimeout(() => {
        pendingTimers.delete(filePath);
        runSerialized(filePath, () => handleChange(db, filePath, onUpdate, log));
      }, DEBOUNCE_MS),
    );
  });

  watcher.on("error", (err: unknown) => {
    log(`[watcher] chokidar error: ${(err as Error).message}`);
  });

  return {
    async close() {
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      await Promise.allSettled(fileQueues.values());
      await watcher.close();
    },
  };
}
