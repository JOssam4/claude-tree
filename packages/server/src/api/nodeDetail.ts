/**
 * Builds the DTO for GET /api/nodes/:uuid — the node itself plus its
 * ancestry path. Read-only against this app's own SQLite DB, same constraint
 * as projectQueries.ts / treeBuilder.ts.
 */
import type { NodeDetailDTO, NodeDTO } from "@claude-tree/shared";
import type { DB } from "../db/client.js";

export type LogFn = (message: string) => void;

/**
 * Defensive bound on total nodes walked while building ancestry. Guards
 * against two distinct failure modes, neither of which should be reachable
 * given the indexer's guarantees, but both are cheap to guard against:
 *  - a corrupt parent_uuid chain that cycles WITHIN a single session
 *    (caught immediately below via the visited-node-uuid check, this bound
 *    is just a backstop);
 *  - pathologically deep histories (thousands of turns) that would otherwise
 *    walk unbounded.
 */
const MAX_ANCESTRY_NODES = 5000;

function getNodeRow(db: DB, uuid: string): NodeDTO | undefined {
  return db
    .prepare(
      `SELECT uuid, session_id as sessionId, parent_uuid as parentUuid, type, role,
              content_text as contentText, content_raw as contentRaw, timestamp, seq
       FROM nodes WHERE uuid = ?`,
    )
    .get(uuid) as NodeDTO | undefined;
}

/** The node (if any) a session was forked FROM, i.e. the branch_edges row where this session is the target. */
function getForkSourceNodeUuid(db: DB, sessionId: string): string | null {
  const row = db
    .prepare(`SELECT source_node_uuid as sourceNodeUuid FROM branch_edges WHERE target_session_id = ? LIMIT 1`)
    .get(sessionId) as { sourceNodeUuid: string } | undefined;
  return row?.sourceNodeUuid ?? null;
}

/**
 * The node with the largest `seq` strictly less than `seq` within the same
 * session, if any — i.e. "whatever line came immediately before this one in
 * file append order." Milestone 6 finding (see watcher.ts's compaction
 * comment): Claude Code's compaction appends a fresh `parentUuid: null` chain
 * root partway through an existing session file rather than chaining onto
 * the pre-compaction tail. A `parent_uuid IS NULL` node is therefore NOT
 * reliably "this session's root" — it's only the root if nothing in the
 * session precedes it by seq. This lets the ancestry walk below tell the two
 * cases apart and keep walking through a compaction boundary instead of
 * stopping there.
 */
function getPriorSeqNodeUuid(db: DB, sessionId: string, seq: number): string | null {
  const row = db
    .prepare(`SELECT uuid FROM nodes WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1`)
    .get(sessionId, seq) as { uuid: string } | undefined;
  return row?.uuid ?? null;
}

/**
 * Walks parent_uuid from `uuid` up to its session's root, then — if that
 * session is itself a branch_edges target — continues into the PARENT
 * session via the fork's source node, and repeats. So ancestry can cross
 * session boundaries when the node's session (or an ancestor session) was
 * itself forked from somewhere; it only stops at a session root that is a
 * true forest root (no branch_edges row targets it). Returns null if `uuid`
 * doesn't exist.
 */
export function getNodeDetail(db: DB, uuid: string, log: LogFn = console.warn): NodeDetailDTO | null {
  const startNode = getNodeRow(db, uuid);
  if (!startNode) return null;

  const path: NodeDTO[] = []; // accumulated newest -> oldest, reversed at the end
  const visitedNodeUuids = new Set<string>();
  const visitedSessionRoots = new Set<string>();

  let currentUuid: string | null = uuid;
  let steps = 0;

  while (currentUuid && steps < MAX_ANCESTRY_NODES) {
    steps++;
    if (visitedNodeUuids.has(currentUuid)) {
      // A parent_uuid cycle within one session should be structurally
      // impossible (the indexer only ever appends, in file order), but stop
      // rather than loop forever if one is ever seen.
      log(`[nodeDetail] cycle detected in parent_uuid chain at node ${currentUuid} — stopping ancestry walk`);
      break;
    }
    visitedNodeUuids.add(currentUuid);

    const node: NodeDTO | undefined = getNodeRow(db, currentUuid);
    if (!node) {
      log(`[nodeDetail] ancestry walk hit missing node uuid=${currentUuid} — stopping`);
      break;
    }
    path.push(node);

    if (node.parentUuid) {
      currentUuid = node.parentUuid;
      continue;
    }

    // parent_uuid is null. This is normally "session root reached," but see
    // getPriorSeqNodeUuid's doc comment: post-compaction, Claude Code appends
    // a SECOND parent_uuid:null chain root partway through the same session
    // file. Tell the two apart by seq: if an earlier-seq node exists in this
    // same session, this is a compaction boundary, not the true root — keep
    // walking by hopping to whatever line immediately preceded it in file
    // order, so ancestry doesn't silently truncate at the compaction point.
    const priorInSameSession = getPriorSeqNodeUuid(db, node.sessionId, node.seq);
    if (priorInSameSession) {
      currentUuid = priorInSameSession;
      continue;
    }

    // Genuine session root reached. Ancestry stops here UNLESS this session
    // was itself created by a branch/subagent fork, in which case we hop into
    // the parent session at the fork's source node and keep walking.
    if (visitedSessionRoots.has(node.sessionId)) {
      log(`[nodeDetail] cycle detected across session boundaries at session ${node.sessionId} — stopping ancestry walk`);
      break;
    }
    visitedSessionRoots.add(node.sessionId);

    currentUuid = getForkSourceNodeUuid(db, node.sessionId);
  }

  if (steps >= MAX_ANCESTRY_NODES) {
    log(`[nodeDetail] ancestry walk for uuid=${uuid} exceeded ${MAX_ANCESTRY_NODES} nodes — truncating`);
  }

  path.reverse();
  return { node: startNode, ancestry: { path } };
}
