/**
 * Shared DTOs for the Claude Code Conversation Tree Manager.
 * Mirrors the SQLite schema in packages/server/src/db/schema.sql.
 * Consumed by both the server (API responses) and, later, the web UI.
 */

/** Line types that participate in the parent/child chain (have uuid + parentUuid). */
export type ChainNodeType = "user" | "assistant" | "system" | "attachment";

/**
 * Non-chain "metadata" line types Claude Code is known to emit today.
 * NOT exhaustive by design — a future Claude Code version can add new metadata
 * types at any time. The indexer treats anything outside ChainNodeType as
 * metadata-to-skip-for-tree-purposes rather than erroring, so this list is
 * documentation/reference only, not a validation whitelist.
 */
export type KnownMetadataLineType =
  | "mode"
  | "permission-mode"
  | "atis-latch"
  | "file-history-snapshot"
  | "file-history-delta"
  | "last-prompt"
  | "ai-title"
  | "cost-state"
  | "queue-operation";

export interface ProjectDTO {
  id: number;
  slug: string;
  cwd: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SessionDTO {
  id: string;
  projectId: number;
  filePath: string;
  isSidechain: boolean;
  agentId: string | null;
  aiTitle: string | null;
  createdAt: string;
  lastIndexedAt: string;
  lastByteOffset: number;
  isSynthetic: boolean;
}

export interface NodeDTO {
  uuid: string;
  sessionId: string;
  parentUuid: string | null;
  type: string;
  role: string | null;
  contentText: string | null;
  contentRaw: string;
  timestamp: string;
  seq: number;
}

export type BranchEdgeType = "branch" | "subagent";

export interface BranchEdgeDTO {
  id: number;
  sourceNodeUuid: string;
  targetSessionId: string;
  edgeType: BranchEdgeType;
  createdAt: string;
}

/** Per-project summary row, as returned by GET /api/projects. */
export interface ProjectSummaryDTO extends ProjectDTO {
  /** Count of all sessions (including subagent sidechains) belonging to this project. */
  sessionCount: number;
  /** Count of root sessions — sessions with no branch_edges row targeting them, i.e. forest roots for GET /api/projects/:slug/tree. */
  rootSessionCount: number;
}

/**
 * A single session forked off of some node in its parent session, nested one
 * level down in the forest. `sourceNodeUuid` is the node (in the PARENT
 * session) the fork originated from — redundant with the parent's own node
 * list but included here so a consumer never has to search for it.
 */
export interface SessionForkDTO {
  edgeType: BranchEdgeType;
  sourceNodeUuid: string;
  session: SessionTreeNodeDTO;
}

/** One session's full node chain plus any sessions (branch or subagent) forked from a node within it, recursively. */
export interface SessionTreeNodeDTO {
  session: SessionDTO;
  nodes: NodeDTO[];
  forks: SessionForkDTO[];
}

/**
 * Forest of sessions for a single project, as returned by GET
 * /api/projects/:slug/tree. One entry in `roots` per session that is not
 * itself a branch_edges target (i.e. a genuine new conversation, not a fork
 * of another node) — every other session in the project hangs off some
 * root's `forks` tree, including subagent sidechains (edgeType='subagent').
 */
export interface ProjectTreeDTO {
  project: ProjectDTO;
  roots: SessionTreeNodeDTO[];
}

/**
 * A single node's ancestry, oldest -> newest, ending with the node itself.
 * Ancestry walks parent_uuid up to the session root, and if that session is
 * itself a branch_edges target, continues into the parent session through
 * the fork's source node — so the path CAN cross session boundaries. See
 * the server's ancestry-walk implementation for the cycle/depth guard.
 */
export interface NodeAncestryDTO {
  path: NodeDTO[];
}

/** Single node detail, as returned by GET /api/nodes/:uuid. */
export interface NodeDetailDTO {
  node: NodeDTO;
  ancestry: NodeAncestryDTO;
}

/** Summary counts produced by a backfill run, used for verification/reporting. */
export interface BackfillSummary {
  projectsFound: number;
  sessionsFound: number;
  nodesInserted: number;
  sidechainLinksFound: number;
  sidechainLinksOrphaned: number;
  warnings: string[];
}

/**
 * Payload emitted whenever the live watcher (packages/server/src/indexer/watcher.ts)
 * commits new nodes for a session — either from a brand-new file or from
 * tailing an appended one. Shape matches the WS `tree:update` message
 * described in the plan (`{ type: "tree:update", projectSlug, sessionId,
 * addedNodeUuids }`); defined here now (Milestone 2) so the future WebSocket
 * server (Milestone 3) can wrap this directly into that message without the
 * watcher module needing to change.
 */
export interface TreeUpdateEvent {
  projectSlug: string;
  sessionId: string;
  addedNodeUuids: string[];
}

/** The actual message shape sent over `WS /ws` (Milestone 3), wrapping TreeUpdateEvent with its `type` tag. */
export interface TreeUpdateWsMessage extends TreeUpdateEvent {
  type: "tree:update";
}

/** Union of all server->client WS message types. Just one for now; grows as more are added (e.g. terminal:data in Milestone 5). */
export type WsServerMessage = TreeUpdateWsMessage;
