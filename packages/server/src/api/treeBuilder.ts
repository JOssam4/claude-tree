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

/**
 * Builds the full nested forest for one project in a handful of bulk queries
 * (no N+1: one query each for sessions, nodes, and branch_edges, all scoped
 * to this project's session ids), then assembles the tree in memory.
 * Returns null if the project slug doesn't exist.
 */
export function buildProjectTree(db: DB, slug: string, log: LogFn = console.warn): ProjectTreeDTO | null {
  const project = getProjectBySlug(db, slug);
  if (!project) return null;

  const sessionRows = db
    .prepare(
      `SELECT id, project_id as projectId, file_path as filePath, is_sidechain as isSidechain,
              agent_id as agentId, ai_title as aiTitle, created_at as createdAt,
              last_indexed_at as lastIndexedAt, last_byte_offset as lastByteOffset,
              is_synthetic as isSynthetic
       FROM sessions WHERE project_id = ?`,
    )
    .all(project.id) as SessionRow[];

  const sessionsById = new Map<string, SessionDTO>();
  for (const row of sessionRows) sessionsById.set(row.id, toSessionDTO(row));

  const sessionIds = [...sessionsById.keys()];
  const nodesBySession = new Map<string, NodeDTO[]>();
  const edgesBySourceNode = new Map<string, BranchEdgeDTO[]>();
  const incomingTargetSessionIds = new Set<string>();

  if (sessionIds.length > 0) {
    const nodeRows = db
      .prepare(
        `SELECT uuid, session_id as sessionId, parent_uuid as parentUuid, type, role,
                content_text as contentText, content_raw as contentRaw, timestamp, seq
         FROM nodes WHERE session_id IN (${placeholders(sessionIds.length)})
         ORDER BY session_id, seq`,
      )
      .all(...sessionIds) as NodeDTO[];

    for (const node of nodeRows) {
      const bucket = nodesBySession.get(node.sessionId);
      if (bucket) bucket.push(node);
      else nodesBySession.set(node.sessionId, [node]);
    }

    // Edges originating FROM a node in this project (used to attach forks under their source node).
    const nodeUuids = nodeRows.map((n) => n.uuid);
    if (nodeUuids.length > 0) {
      const edgeRows = db
        .prepare(
          `SELECT id, source_node_uuid as sourceNodeUuid, target_session_id as targetSessionId,
                  edge_type as edgeType, created_at as createdAt
           FROM branch_edges WHERE source_node_uuid IN (${placeholders(nodeUuids.length)})`,
        )
        .all(...nodeUuids) as BranchEdgeDTO[];

      for (const edge of edgeRows) {
        const bucket = edgesBySourceNode.get(edge.sourceNodeUuid);
        if (bucket) bucket.push(edge);
        else edgesBySourceNode.set(edge.sourceNodeUuid, [edge]);
      }
    }

    // Separately: which of THIS project's sessions are themselves a fork
    // target (determines forest roots). Queried by target rather than
    // derived from edgesBySourceNode above so a session is correctly
    // excluded from `roots` even if its source node somehow lives outside
    // this project's node set (defensive — shouldn't happen per schema).
    const targetRows = db
      .prepare(
        `SELECT DISTINCT target_session_id as targetSessionId
         FROM branch_edges WHERE target_session_id IN (${placeholders(sessionIds.length)})`,
      )
      .all(...sessionIds) as { targetSessionId: string }[];
    for (const row of targetRows) incomingTargetSessionIds.add(row.targetSessionId);
  }

  function buildSubtree(sessionId: string, ancestors: ReadonlySet<string>, depth: number): SessionTreeNodeDTO | null {
    const session = sessionsById.get(sessionId);
    if (!session) {
      // branch_edges.target_session_id pointing at a session outside this
      // project (or not indexed at all) shouldn't happen per the schema, but
      // guard rather than crash on a future bug.
      log(`[tree] project=${slug}: branch_edges references unknown/foreign session ${sessionId} — skipping`);
      return null;
    }
    if (ancestors.has(sessionId)) {
      // See MAX_FOREST_DEPTH doc comment above — cycles should be structurally
      // impossible, but log and bail rather than recurse forever if one ever appears.
      log(`[tree] project=${slug}: cycle detected in branch_edges forest at session ${sessionId} — skipping`);
      return null;
    }
    if (depth > MAX_FOREST_DEPTH) {
      log(`[tree] project=${slug}: fork depth exceeded ${MAX_FOREST_DEPTH} at session ${sessionId} — truncating`);
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
        const childTree = buildSubtree(edge.targetSessionId, nextAncestors, depth + 1);
        if (childTree) forks.push({ edgeType: edge.edgeType, sourceNodeUuid: node.uuid, session: childTree });
      }
    }

    return { session, nodes, forks };
  }

  const roots: SessionTreeNodeDTO[] = [];
  for (const sessionId of sessionIds) {
    if (incomingTargetSessionIds.has(sessionId)) continue; // not a root — attached as a fork elsewhere in the recursion below
    const tree = buildSubtree(sessionId, new Set(), 0);
    if (tree) roots.push(tree);
  }

  return { project, roots };
}
