/**
 * Turns a ProjectTreeDTO forest into an @xyflow/react node/edge graph.
 *
 * Grouping rule: a new "turn" starts only on a `user`-type node that carries
 * real human-authored text; every following node folds into that turn until
 * the next such node. Two Claude Code behaviors would otherwise pollute that
 * text:
 *  1. Tool-call (`assistant`-type, no text — only tool_use blocks) and
 *     tool-result (`user`-type, no text — only tool_result blocks) lines.
 *     `extractContentText` only ever populates `contentText` from
 *     `text`-typed content blocks, so these "action" lines always have
 *     `contentText === null`.
 *  2. Skill/slash-command bodies, spliced in as their OWN `user`-type line
 *     (marked `isMeta: true` in the raw JSONL) immediately after the line
 *     the human actually typed — this one DOES carry real `text` content
 *     (the skill's full markdown), so `contentText` alone can't catch it.
 * `hasRealText` folds both into the surrounding turn instead of starting a
 * new box or becoming a resume target for it.
 */
import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";
import type { NodeDTO, ProjectTreeDTO, SessionTreeNodeDTO } from "@claude-tree/shared";

export interface TurnNodeData extends Record<string, unknown> {
  sessionId: string;
  /** All underlying node uuids folded into this box — plumbing for a future branch-target picker (see onBranch's removal note below). */
  memberUuids: string[];
  /** The specific node a resume/branch action should target (latest node in this turn). */
  targetNodeUuid: string;
  userText: string | null;
  assistantText: string | null;
  timestamp: string;
  isSessionRoot: boolean;
  isSidechain: boolean;
  /** True for the single turn currently expanded (click-to-expand), if any — see `EXPANDED_WIDTH`/`EXPANDED_HEIGHT`. */
  isExpanded: boolean;
  /** Invoked with this turn's own id (the xyflow node id) when its card is clicked, to toggle expansion. */
  onToggleExpand: (turnId: string) => void;
  /**
   * Milestone 8: invoked with `targetNodeUuid` when this turn's "⧉ copy resume
   * command" button is clicked; resolves to the ready-to-paste command, or
   * null if the branch call failed (error already surfaced elsewhere by the caller).
   *
   * There used to be a sibling `onBranch: (targetNodeUuid: string) => void`
   * field here too, wired to a "⑂ branch" button that opened the forked
   * session in an embedded terminal (App.tsx's old `handleBranch`/
   * `terminalBranch` state + `<TerminalPanel>`). It's removed for now — copy
   * resume command covers the need and shares the same underlying
   * `POST /api/nodes/:uuid/branch` call via App.tsx's `getOrCreateBranch`
   * cache. To bring it back: re-add this field, thread it through
   * `buildSessionSubtree`/`buildForestGraph` alongside `onCopyResumeCommand`
   * below, render the button again in TurnNode.tsx, and in App.tsx restore
   * `terminalBranch` state + a `handleBranch` that calls `getOrCreateBranch`
   * and renders `<TerminalPanel>` (still present, untouched) on success.
   */
  onCopyResumeCommand: (targetNodeUuid: string) => Promise<string | null>;
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
/**
 * Must match the `.turn-node` `max-height` in index.css. Dagre spaces boxes
 * assuming every node is exactly this tall, so if the real rendered card
 * could ever exceed it, boxes start overlapping (they did — see the CSS
 * comment on `.turn-node`'s per-block line-clamp truncation, which is what
 * keeps the real height from ever growing past this budget).
 */
const NODE_HEIGHT = 210;
const RANK_SEP = 110;
const NODE_SEP = 40;
const ROOT_GAP = 80;

/**
 * Click-to-expand size, for the (at most one) turn the user has clicked open.
 * Must match `.turn-node--expanded`'s `max-height`/`width` in index.css —
 * same lockstep contract as NODE_HEIGHT above, so dagre always reserves
 * exactly as much room as the expanded card can actually grow to, and it
 * never overlaps a neighbor.
 */
const EXPANDED_WIDTH = 420;
const EXPANDED_HEIGHT = 480;

/** Truncate pathologically long message text (collapsed-view visual truncation is CSS line-clamp; this is just a sanity bound on DOM size). */
function preview(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length <= 20000) return trimmed;
  return `${trimmed.slice(0, 20000)}…`;
}

/** The {width, height} dagre should reserve for a node — bigger for the single expanded turn, if any. */
function nodeDimensions(node: TreeFlowNode, expandedTurnId: string | null): { width: number; height: number } {
  if (node.type === "turn" && node.id === expandedTurnId) {
    return { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT };
  }
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

/**
 * True when this chain line is a synthetic companion Claude Code injects
 * alongside the user's own line — e.g. a Skill/command's full body, spliced
 * in as its own `user`-type line (`isMeta: true`, often with `sourceToolUseID`
 * set) right after the line the human actually typed. It carries real
 * `text`-block content, so `contentText` alone can't distinguish it from a
 * genuine message; `isMeta` (preserved verbatim in `contentRaw`, since
 * NodeDTO's own fields don't carry it) is the only signal. Never present on
 * the DB's own synthesized fields, so a parse failure just means "not meta."
 */
function isSyntheticMetaLine(node: NodeDTO): boolean {
  try {
    const raw = JSON.parse(node.contentRaw) as { isMeta?: unknown };
    return raw.isMeta === true;
  } catch {
    return false;
  }
}

/** True for a real, human/model-authored `user` or `assistant` message — false for a tool-call/tool-result "action" line or an injected skill/command body (see module doc). */
function hasRealText(node: NodeDTO): boolean {
  return node.contentText !== null && node.contentText.trim().length > 0 && !isSyntheticMetaLine(node);
}

interface Turn {
  id: string;
  memberUuids: string[];
  userNode: NodeDTO | null;
  assistantNode: NodeDTO | null;
  lastNode: NodeDTO;
  /** Latest real user/assistant message in this turn — what a resume/branch action should target, never a trailing tool-call action node. */
  targetNode: NodeDTO | null;
}

/** Groups one session's flat node list into turn boxes (see module doc for the rule). */
function groupTurns(sessionId: string, nodes: NodeDTO[]): Turn[] {
  const sorted = [...nodes].sort((a, b) => a.seq - b.seq);
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const node of sorted) {
    const isRealUserMessage = node.type === "user" && hasRealText(node);
    if (isRealUserMessage || current === null) {
      current = {
        id: `${sessionId}#${turns.length}`,
        memberUuids: [node.uuid],
        userNode: isRealUserMessage ? node : null,
        assistantNode: null,
        lastNode: node,
        targetNode: null,
      };
      turns.push(current);
    } else {
      current.memberUuids.push(node.uuid);
      current.lastNode = node;
    }
    if (node.type === "assistant" && hasRealText(node) && !current.assistantNode) {
      current.assistantNode = node;
    }
    if ((node.type === "user" || node.type === "assistant") && hasRealText(node)) {
      current.targetNode = node;
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
  expandedTurnId: string | null,
  onToggleExpand: (turnId: string) => void,
  onCopyResumeCommand: (targetNodeUuid: string) => Promise<string | null>,
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

  // A turn renders only if it contains a real user or assistant message — an
  // action-only turn (tool calls/results with no human-authored or
  // model-authored text) is folded into the graph structurally (its member
  // uuids still resolve via uuidToTurnId) but never gets its own box. Given
  // the grouping rule, this can only ever happen for turn 0 (every later
  // turn is created BY a real user message, so it's always visible).
  const visible = turns.map((turn) => turn.userNode !== null || turn.assistantNode !== null);
  const firstVisibleIndex = visible.indexOf(true);

  // Routes a turn id (possibly hidden) to the nearest visible turn's id, so
  // fork edges sourced from an action node still land somewhere on screen.
  const turnIdToVisibleId = new Map<string, string>();
  turns.forEach((turn, i) => {
    if (visible[i]) {
      turnIdToVisibleId.set(turn.id, turn.id);
      return;
    }
    for (let j = i - 1; j >= 0; j--) {
      if (visible[j]) {
        turnIdToVisibleId.set(turn.id, turns[j]!.id);
        return;
      }
    }
    for (let j = i + 1; j < turns.length; j++) {
      if (visible[j]) {
        turnIdToVisibleId.set(turn.id, turns[j]!.id);
        return;
      }
    }
    // No visible turn anywhere in this session — left unset; forks from here are dropped below.
  });

  turns.forEach((turn, i) => {
    if (!visible[i]) return;
    nodes.push({
      id: turn.id,
      type: "turn",
      position: { x: 0, y: 0 }, // overwritten by dagre in layoutForest
      data: {
        sessionId: session.id,
        memberUuids: turn.memberUuids,
        targetNodeUuid: (turn.targetNode ?? turn.lastNode).uuid,
        userText: preview(turn.userNode?.contentText ?? null),
        assistantText: preview(turn.assistantNode?.contentText ?? null),
        timestamp: turn.lastNode.timestamp,
        isSessionRoot: isRoot && i === firstVisibleIndex,
        isSidechain: session.isSidechain,
        isExpanded: turn.id === expandedTurnId,
        onToggleExpand,
        onCopyResumeCommand,
      },
    });
    // Linear-chain guarantee (see plan): connect to the nearest preceding visible turn, if any.
    for (let j = i - 1; j >= 0; j--) {
      if (visible[j]) {
        edges.push({
          id: `e-${turns[j]!.id}-${turn.id}`,
          source: turns[j]!.id,
          target: turn.id,
          type: "smoothstep",
        });
        break;
      }
    }
  });

  for (const fork of forks) {
    const rawSourceTurnId = uuidToTurnId.get(fork.sourceNodeUuid);
    if (!rawSourceTurnId) continue; // shouldn't happen: fork.sourceNodeUuid always belongs to this very session's own turns
    const sourceTurnId = turnIdToVisibleId.get(rawSourceTurnId);
    if (!sourceTurnId) continue; // this session has no visible turn at all to attach the fork to

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

    const child = buildSessionSubtree(fork.session, true, expandedTurnId, onToggleExpand, onCopyResumeCommand);
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
function layoutComponent(nodes: TreeFlowNode[], edges: TurnEdge[], expandedTurnId: string | null): TreeFlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: NODE_SEP, ranksep: RANK_SEP });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, nodeDimensions(n, expandedTurnId));
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    const { width, height } = nodeDimensions(n, expandedTurnId);
    return { ...n, position: { x: pos.x - width / 2, y: pos.y - height / 2 } };
  });
}

/**
 * Builds the full forest for a project: one dagre-laid-out connected
 * component per root session, placed side by side left-to-right so
 * disconnected trees never overlap. No synthetic super-root is added.
 */
export function buildForestGraph(
  tree: ProjectTreeDTO,
  // Optional + defaulted so existing callers/tests don't need to change (Milestone 8 addition).
  onCopyResumeCommand: (targetNodeUuid: string) => Promise<string | null> = () => Promise.resolve(null),
  // Optional + defaulted for the same reason (click-to-expand addition): no turn expanded, toggling a no-op.
  expandedTurnId: string | null = null,
  onToggleExpand: (turnId: string) => void = () => {},
): BuildResult {
  const allNodes: TreeFlowNode[] = [];
  const allEdges: TurnEdge[] = [];
  let xOffset = 0;

  for (const root of tree.roots) {
    const { nodes, edges } = buildSessionSubtree(root, true, expandedTurnId, onToggleExpand, onCopyResumeCommand);
    if (nodes.length === 0) continue;
    const laidOut = layoutComponent(nodes, edges, expandedTurnId);
    const minX = Math.min(...laidOut.map((n) => n.position.x));
    const maxX = Math.max(...laidOut.map((n) => n.position.x + nodeDimensions(n, expandedTurnId).width));
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
