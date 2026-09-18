/**
 * Builds the nested forest DTO for GET /api/projects/:slug/tree. Read-only
 * against this app's own SQLite DB — see projectQueries.ts's header comment,
 * same constraint applies here.
 */
import type {
  BranchEdgeDTO,
  NodeDTO,
  ProjectDTO,
  ProjectTreeDTO,
  SessionDTO,
  SessionForkDTO,
  SessionTreeNodeDTO,
} from "@claude-tree/shared";
import type { DB } from "../db/client.js";

export type LogFn = (message: string) => void;

/**
 * Defensive bound on fork-chain depth while recursing through branch_edges.
 * branch_edges should form a tree (every edge points from an existing node to
 * a BRAND NEW session, per the indexer), so this should never trigger in
 * practice — it exists purely so a future bug elsewhere (e.g. a duplicate
 * edge accidentally pointing a session back at an ancestor) degrades to a
 * truncated response instead of an infinite recursion / stack overflow.
 */
const MAX_FOREST_DEPTH = 200;

interface SessionRow {
  id: string;
  projectId: number;
  filePath: string;
  isSidechain: number;
  agentId: string | null;
  aiTitle: string | null;
  createdAt: string;
  lastIndexedAt: string;
  lastByteOffset: number;
  isSynthetic: number;
}

function toSessionDTO(row: SessionRow): SessionDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    filePath: row.filePath,
    isSidechain: row.isSidechain === 1,
    agentId: row.agentId,
    aiTitle: row.aiTitle,
    createdAt: row.createdAt,
    lastIndexedAt: row.lastIndexedAt,
    lastByteOffset: row.lastByteOffset,
    isSynthetic: row.isSynthetic === 1,
  };
}

/** SQLite has no array params; build the right number of `?` placeholders for an `IN (...)` clause. */
function placeholders(n: number): string {
  return Array(n).fill("?").join(",");
}

export function getProjectBySlug(db: DB, slug: string): ProjectDTO | undefined {
  return db
    .prepare(
      `SELECT id, slug, cwd, first_seen_at as firstSeenAt, last_seen_at as lastSeenAt
       FROM projects WHERE slug = ?`,
    )
    .get(slug) as ProjectDTO | undefined;
}

/** The project a given session belongs to, joined in one query (used by buildSessionTree, which only has a session id to start from). */
function getProjectForSession(db: DB, sessionId: string): ProjectDTO | undefined {
  return db
    .prepare(
      `SELECT p.id as id, p.slug as slug, p.cwd as cwd,
              p.first_seen_at as firstSeenAt, p.last_seen_at as lastSeenAt
       FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as ProjectDTO | undefined;
}

/** Bulk-loaded lookup tables shared by both buildProjectTree and buildSessionTree's recursion. */
interface TreeContext {
  sessionsById: Map<string, SessionDTO>;
  nodesBySession: Map<string, NodeDTO[]>;
  edgesBySourceNode: Map<string, BranchEdgeDTO[]>;
}

function groupBy<T, K>(rows: T[], keyOf: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function loadSessionRows(db: DB, sessionIds: readonly string[]): SessionRow[] {
  if (sessionIds.length === 0) return [];
  return db
    .prepare(
      `SELECT id, project_id as projectId, file_path as filePath, is_sidechain as isSidechain,
              agent_id as agentId, ai_title as aiTitle, created_at as createdAt,
              last_indexed_at as lastIndexedAt, last_byte_offset as lastByteOffset,
              is_synthetic as isSynthetic
       FROM sessions WHERE id IN (${placeholders(sessionIds.length)})`,
    )
    .all(...sessionIds) as SessionRow[];
}

function loadNodeRows(db: DB, sessionIds: readonly string[]): NodeDTO[] {
  if (sessionIds.length === 0) return [];
  return db
    .prepare(
      `SELECT uuid, session_id as sessionId, parent_uuid as parentUuid, type, role,
              content_text as contentText, content_raw as contentRaw, timestamp, seq
       FROM nodes WHERE session_id IN (${placeholders(sessionIds.length)})
       ORDER BY session_id, seq`,
    )
    .all(...sessionIds) as NodeDTO[];
}

/** Edges originating FROM one of `nodeUuids` (used to attach forks under their source node). */
function loadEdgesFromNodes(db: DB, nodeUuids: readonly string[]): BranchEdgeDTO[] {
  if (nodeUuids.length === 0) return [];
  return db
    .prepare(
      `SELECT id, source_node_uuid as sourceNodeUuid, target_session_id as targetSessionId,
              edge_type as edgeType, created_at as createdAt
       FROM branch_edges WHERE source_node_uuid IN (${placeholders(nodeUuids.length)})`,
    )
    .all(...nodeUuids) as BranchEdgeDTO[];
}

/**
 * Loads every session/node/branch-edge belonging to one project in a handful
 * of bulk queries (no N+1: one query each for sessions, nodes, and
 * branch_edges, all scoped to this project's session ids).
 */
function loadProjectContext(db: DB, projectId: number): TreeContext {
  const sessionRows = db
    .prepare(
      `SELECT id, project_id as projectId, file_path as filePath, is_sidechain as isSidechain,
              agent_id as agentId, ai_title as aiTitle, created_at as createdAt,
              last_indexed_at as lastIndexedAt, last_byte_offset as lastByteOffset,
              is_synthetic as isSynthetic
       FROM sessions WHERE project_id = ?`,
    )
    .all(projectId) as SessionRow[];

  const sessionsById = new Map<string, SessionDTO>();
  for (const row of sessionRows) sessionsById.set(row.id, toSessionDTO(row));

  const sessionIds = [...sessionsById.keys()];
  const nodeRows = loadNodeRows(db, sessionIds);
  const edgeRows = loadEdgesFromNodes(
    db,
    nodeRows.map((n) => n.uuid),
  );

  return {
    sessionsById,
    nodesBySession: groupBy(nodeRows, (n) => n.sessionId),
    edgesBySourceNode: groupBy(edgeRows, (e) => e.sourceNodeUuid),
  };
}

/**
 * Loads only the sessions/nodes/edges reachable from `rootSessionId` by
 * BFS-ing outward through branch_edges, rather than bulk-loading the whole
 * project. buildSessionTree backs GET /api/sessions/:id/tree, which fires on
 * every sidebar click and every relevant live-update event, so pulling in a
 * project's other, unrelated root conversations just to discard them would
 * scale with the whole project instead of with the one tree being rendered.
 */
function loadSessionSubtreeContext(db: DB, rootSessionId: string): TreeContext {
  const sessionsById = new Map<string, SessionDTO>();
  const nodeRows: NodeDTO[] = [];
  const edgeRows: BranchEdgeDTO[] = [];

  const visited = new Set<string>();
  let frontier = [rootSessionId];

  while (frontier.length > 0) {
    for (const row of loadSessionRows(db, frontier)) sessionsById.set(row.id, toSessionDTO(row));

    const frontierNodes = loadNodeRows(db, frontier);
    nodeRows.push(...frontierNodes);

    const frontierEdges = loadEdgesFromNodes(
      db,
      frontierNodes.map((n) => n.uuid),
    );
    edgeRows.push(...frontierEdges);

    for (const id of frontier) visited.add(id);
    frontier = frontierEdges.map((e) => e.targetSessionId).filter((id) => !visited.has(id));
  }

  return {
    sessionsById,
    nodesBySession: groupBy(nodeRows, (n) => n.sessionId),
    edgesBySourceNode: groupBy(edgeRows, (e) => e.sourceNodeUuid),
  };
}

/** Recursively assembles one session's tree (its own nodes plus every fork hanging off it), scoped to `ctx`. */
function buildSubtree(
  ctx: TreeContext,
  sessionId: string,
  ancestors: ReadonlySet<string>,
  depth: number,
  log: LogFn,
): SessionTreeNodeDTO | null {
  const { sessionsById, nodesBySession, edgesBySourceNode } = ctx;
  const session = sessionsById.get(sessionId);
  if (!session) {
    // branch_edges.target_session_id pointing at a session outside this
    // context (or not indexed at all) shouldn't happen per the schema, but
    // guard rather than crash on a future bug.
    log(`[tree] branch_edges references unknown/foreign session ${sessionId} — skipping`);
    return null;
  }
  if (ancestors.has(sessionId)) {
    // See MAX_FOREST_DEPTH doc comment above — cycles should be structurally
    // impossible, but log and bail rather than recurse forever if one ever appears.
    log(`[tree] cycle detected in branch_edges forest at session ${sessionId} — skipping`);
    return null;
  }
  if (depth > MAX_FOREST_DEPTH) {
    log(`[tree] fork depth exceeded ${MAX_FOREST_DEPTH} at session ${sessionId} — truncating`);
    return { session, nodes: nodesBySession.get(sessionId) ?? [], forks: [] };
  }

  const nodes = nodesBySession.get(sessionId) ?? [];
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(sessionId);

  const forks: SessionForkDTO[] = [];
  for (const node of nodes) {
    const edges = edgesBySourceNode.get(node.uuid);
    if (!edges) continue;
    for (const edge of edges) {
      const childTree = buildSubtree(ctx, edge.targetSessionId, nextAncestors, depth + 1, log);
      if (childTree) forks.push({ edgeType: edge.edgeType, sourceNodeUuid: node.uuid, session: childTree });
    }
  }

  return { session, nodes, forks };
}

/**
 * Builds the full nested forest for one project. Returns null if the project
 * slug doesn't exist.
 */
export function buildProjectTree(db: DB, slug: string, log: LogFn = console.warn): ProjectTreeDTO | null {
  const project = getProjectBySlug(db, slug);
  if (!project) return null;

  const ctx = loadProjectContext(db, project.id);
  const sessionIds = [...ctx.sessionsById.keys()];

  // Which of this project's sessions are themselves a fork target
  // (determines forest roots). Queried by target rather than derived from
  // ctx.edgesBySourceNode so a session is correctly excluded from `roots`
  // even if its source node somehow lives outside this project's node set
  // (defensive — shouldn't happen per schema).
  const incomingTargetSessionIds = new Set<string>();
  if (sessionIds.length > 0) {
    const targetRows = db
      .prepare(
        `SELECT DISTINCT target_session_id as targetSessionId
         FROM branch_edges WHERE target_session_id IN (${placeholders(sessionIds.length)})`,
      )
      .all(...sessionIds) as { targetSessionId: string }[];
    for (const row of targetRows) incomingTargetSessionIds.add(row.targetSessionId);
  }

  const roots: SessionTreeNodeDTO[] = [];
  for (const sessionId of sessionIds) {
    if (incomingTargetSessionIds.has(sessionId)) continue; // not a root — attached as a fork elsewhere in the recursion below
    const tree = buildSubtree(ctx, sessionId, new Set(), 0, log);
    if (tree) roots.push(tree);
  }

  return { project, roots };
}

/**
 * Builds a single conversation's tree — one root session plus every fork
 * (recursively) hanging off it — wrapped in the same ProjectTreeDTO shape as
 * buildProjectTree but with exactly one entry in `roots`, so every existing
 * forest consumer (turnGraph.ts, TreeCanvas) renders it unchanged as one
 * standalone tree instead of the project's whole forest. Returns null if
 * `sessionId` doesn't exist.
 */
export function buildSessionTree(db: DB, sessionId: string, log: LogFn = console.warn): ProjectTreeDTO | null {
  const project = getProjectForSession(db, sessionId);
  if (!project) return null;

  const ctx = loadSessionSubtreeContext(db, sessionId);
  const root = buildSubtree(ctx, sessionId, new Set(), 0, log);
  if (!root) return null;

  return { project, roots: [root] };
}
