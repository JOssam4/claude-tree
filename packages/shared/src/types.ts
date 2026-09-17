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

/** Forest of sessions + nodes + branch_edges for a single project, as returned by GET /api/projects/:slug/tree. */
export interface ProjectTreeDTO {
  project: ProjectDTO;
  sessions: SessionDTO[];
  nodes: NodeDTO[];
  branchEdges: BranchEdgeDTO[];
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
