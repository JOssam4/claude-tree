/**
 * Turns a ProjectTreeDTO forest into an @xyflow/react node/edge graph.
 *
 * Grouping rule: every `user`-type node starts a new "turn"; every following
 * node (attachment/system/assistant) folds into that turn until the next
 * user node. This is intentionally naive — Claude Code also emits tool-result
 * replies and local-command output as `user`-type lines, so some turn boxes
 * end up empty-looking (no human-authored text). That's an accepted
 * simplification for Milestone 4: turn count stays a direct, predictable
 * function of `nodes.filter(n => n.type === 'user').length`, and semantic
 * dedup of synthetic user lines is left for later polish.
 */
import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";
import type { NodeDTO, ProjectTreeDTO, SessionTreeNodeDTO } from "@claude-tree/shared";

export interface TurnNodeData extends Record<string, unknown> {
  sessionId: string;
  /** All underlying node uuids folded into this box — plumbing for Milestone 5's branch-target picker. */
  memberUuids: string[];
  /** The specific node Milestone 5's branch action should target (latest node in this turn). */
  targetNodeUuid: string;
  userText: string | null;
  assistantText: string | null;
  timestamp: string;
  isSessionRoot: boolean;
  isSidechain: boolean;
  /** Milestone 5: invoked with `targetNodeUuid` when this turn's "⑂ branch" button is clicked. */
  onBranch: (targetNodeUuid: string) => void;
}

export type TurnNode = Node<TurnNodeData, "turn">;

/**
 * Milestone 6: a freshly-forked session has zero of its own indexed `nodes`
 * (its shared-prefix lines' uuids already belong to the original session, so
 * `INSERT OR IGNORE` skips them) until the user's first genuinely new message
 * gets appended and indexed. Without special-casing this, the fork would
 * render nothing at all — no box, no edge — since there's no real turn to
 * anchor either to. This placeholder is keyed directly off the `branch_edges`
 * row itself (via `fork.session.session`, which always exists immediately
 * after a successful branch call), not off indexed node data, so it appears
 * the instant the branch API call succeeds. It disappears on its own: once
 * the session gets indexed, the next `tree:update` broadcast triggers
 * App.tsx's refetch, `fork.session.nodes` is non-empty, and
 * `buildSessionSubtree` renders a real `TurnNode` in its place instead.
 */
export interface PlaceholderNodeData extends Record<string, unknown> {
  sessionId: string;
  edgeType: "branch" | "subagent";
}
export type PlaceholderNode = Node<PlaceholderNodeData, "placeholder">;

/** Everything `buildForestGraph` can hand xyflow — a real turn box or a not-yet-indexed fork's placeholder. */
export type TreeFlowNode = TurnNode | PlaceholderNode;

export type ForkEdgeData = Record<string, never>;
export type TurnEdge = Edge<ForkEdgeData>;

const NODE_WIDTH = 260;
const NODE_HEIGHT = 96;
const RANK_SEP = 90;
const NODE_SEP = 32;
const ROOT_GAP = 80;

/** Truncate long message text for compact box display. */
function preview(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length <= 160) return trimmed;
  return `${trimmed.slice(0, 160)}…`;
}

interface Turn {
  id: string;
  memberUuids: string[];
  userNode: NodeDTO | null;
  assistantNode: NodeDTO | null;
  lastNode: NodeDTO;
}

/** Groups one session's flat node list into turn boxes (see module doc for the rule). */
function groupTurns(sessionId: string, nodes: NodeDTO[]): Turn[] {
  const sorted = [...nodes].sort((a, b) => a.seq - b.seq);
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const node of sorted) {
    if (node.type === "user" || current === null) {
      current = {
        id: `${sessionId}#${turns.length}`,
        memberUuids: [node.uuid],
        userNode: node.type === "user" ? node : null,
        assistantNode: null,
        lastNode: node,
      };
      turns.push(current);
    } else {
      current.memberUuids.push(node.uuid);
      current.lastNode = node;
      if (node.type === "assistant" && !current.assistantNode) current.assistantNode = node;
    }
  }
  return turns;
}

interface BuildResult {
  nodes: TreeFlowNode[];
  edges: TurnEdge[];
}

/** Recursively builds nodes/edges for one session subtree (its own turns plus every fork hanging off it). */
function buildSessionSubtree(
  tree: SessionTreeNodeDTO,
  isRoot: boolean,
  onBranch: (targetNodeUuid: string) => void,
): BuildResult {
  const { session, nodes: rawNodes, forks } = tree;
  const turns = groupTurns(session.id, rawNodes);
  const nodes: TreeFlowNode[] = [];
  const edges: TurnEdge[] = [];

  // uuid -> turn id, so fork source nodes (which reference a specific underlying node) resolve to their box.
  const uuidToTurnId = new Map<string, string>();
  for (const turn of turns) {
    for (const uuid of turn.memberUuids) uuidToTurnId.set(uuid, turn.id);
  }

  turns.forEach((turn, i) => {
    nodes.push({
      id: turn.id,
      type: "turn",
      position: { x: 0, y: 0 }, // overwritten by dagre in layoutForest
      data: {
        sessionId: session.id,
        memberUuids: turn.memberUuids,
        targetNodeUuid: turn.lastNode.uuid,
        userText: preview(turn.userNode?.contentText ?? null),
        assistantText: preview(turn.assistantNode?.contentText ?? null),
        timestamp: turn.lastNode.timestamp,
        isSessionRoot: isRoot && i === 0,
        isSidechain: session.isSidechain,
        onBranch,
      },
    });
    // Linear-chain guarantee (see plan): within one session, turn i's parent is always turn i-1.
    if (i > 0) {
      const prev = turns[i - 1];
      if (prev) {
        edges.push({
          id: `e-${prev.id}-${turn.id}`,
          source: prev.id,
          target: turn.id,
          type: "smoothstep",
        });
      }
    }
  });

  for (const fork of forks) {
    const sourceTurnId = uuidToTurnId.get(fork.sourceNodeUuid);
    if (!sourceTurnId) continue; // shouldn't happen: fork.sourceNodeUuid always belongs to this very session's own turns

    if (fork.session.nodes.length === 0) {
      // See PlaceholderNodeData doc comment: this fork's target session exists
      // (the branch call succeeded and its branch_edges/sessions rows are
      // real) but has no indexed content yet. A zero-node session can't
      // itself have any forks yet either (you can only branch from an
      // existing indexed node), so there's nothing to recurse into.
      const placeholderId = `placeholder-${fork.session.session.id}`;
      nodes.push({
        id: placeholderId,
        type: "placeholder",
        position: { x: 0, y: 0 }, // overwritten by dagre in layoutForest
        data: { sessionId: fork.session.session.id, edgeType: fork.edgeType },
      });
      edges.push({
        id: `fork-${fork.sourceNodeUuid}-${placeholderId}`,
        source: sourceTurnId,
        target: placeholderId,
        type: "smoothstep",
        className: fork.edgeType === "subagent" ? "edge-subagent" : "edge-branch",
        label: fork.edgeType,
        data: {},
      });
      continue;
    }

    const child = buildSessionSubtree(fork.session, true, onBranch);
    nodes.push(...child.nodes);
    edges.push(...child.edges);
    const childRootId = child.nodes[0]?.id;
    if (childRootId) {
      edges.push({
        id: `fork-${fork.sourceNodeUuid}-${childRootId}`,
        source: sourceTurnId,
        target: childRootId,
        type: "smoothstep",
        className: fork.edgeType === "subagent" ? "edge-subagent" : "edge-branch",
        label: fork.edgeType,
        data: {},
      });
    }
  }

  return { nodes, edges };
}

/** Runs dagre top-to-bottom layout over one connected component, returning nodes with computed positions. */
function layoutComponent(nodes: TreeFlowNode[], edges: TurnEdge[]): TreeFlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: NODE_SEP, ranksep: RANK_SEP });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } };
  });
}

/**
 * Builds the full forest for a project: one dagre-laid-out connected
 * component per root session, placed side by side left-to-right so
 * disconnected trees never overlap. No synthetic super-root is added.
 */
export function buildForestGraph(tree: ProjectTreeDTO, onBranch: (targetNodeUuid: string) => void): BuildResult {
  const allNodes: TreeFlowNode[] = [];
  const allEdges: TurnEdge[] = [];
  let xOffset = 0;

  for (const root of tree.roots) {
    const { nodes, edges } = buildSessionSubtree(root, true, onBranch);
    if (nodes.length === 0) continue;
    const laidOut = layoutComponent(nodes, edges);
    const minX = Math.min(...laidOut.map((n) => n.position.x));
    const maxX = Math.max(...laidOut.map((n) => n.position.x + NODE_WIDTH));
    const shifted = laidOut.map((n) => ({
      ...n,
      position: { x: n.position.x - minX + xOffset, y: n.position.y },
    }));
    allNodes.push(...shifted);
    allEdges.push(...edges);
    xOffset += maxX - minX + ROOT_GAP;
  }

  return { nodes: allNodes, edges: allEdges };
}
