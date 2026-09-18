import { describe, expect, it } from "vitest";
import type { NodeDTO, ProjectTreeDTO, SessionDTO, SessionForkDTO, SessionTreeNodeDTO } from "@claude-tree/shared";
import { buildForestGraph, type PlaceholderNode, type TurnNode } from "./turnGraph.js";

let seq = 0;
function makeUuid(label: string): string {
  seq++;
  return `${label}-${seq}`;
}

function makeNode(opts: {
  uuid: string;
  parentUuid: string | null;
  type: "user" | "assistant" | "system" | "attachment";
  seq: number;
  sessionId: string;
  text?: string;
  /** Marks this line as a Claude Code-injected companion (e.g. a spliced-in skill/command body), not something the human typed. */
  isMeta?: boolean;
}): NodeDTO {
  return {
    uuid: opts.uuid,
    sessionId: opts.sessionId,
    parentUuid: opts.parentUuid,
    type: opts.type,
    role: opts.type === "user" ? "user" : "assistant",
    contentText: opts.text ?? null,
    contentRaw: JSON.stringify({ isMeta: opts.isMeta ?? false }),
    timestamp: `2026-01-01T00:00:${String(opts.seq).padStart(2, "0")}Z`,
    seq: opts.seq,
  };
}

function makeSession(id: string, overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id,
    projectId: 1,
    filePath: `/tmp/fake/${id}.jsonl`,
    isSidechain: false,
    agentId: null,
    aiTitle: null,
    createdAt: "2026-01-01T00:00:00Z",
    lastIndexedAt: "2026-01-01T00:00:00Z",
    lastByteOffset: 0,
    isSynthetic: false,
    ...overrides,
  };
}

function makeSessionTree(session: SessionDTO, nodes: NodeDTO[], forks: SessionForkDTO[] = []): SessionTreeNodeDTO {
  return { session, nodes, forks };
}

function makeProjectTree(roots: SessionTreeNodeDTO[]): ProjectTreeDTO {
  return {
    project: { id: 1, slug: "-tmp", cwd: "/tmp", firstSeenAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z" },
    roots,
  };
}

function isTurnNode(n: { type: string }): n is TurnNode {
  return n.type === "turn";
}
function isPlaceholderNode(n: { type: string }): n is PlaceholderNode {
  return n.type === "placeholder";
}

const noopBranch = () => {};

describe("buildForestGraph / turn grouping", () => {
  it("pairs a user+assistant turn into a single turn box", () => {
    const sessionId = "s1";
    const u1 = makeUuid("u");
    const a1 = makeUuid("a");
    const tree = makeProjectTree([
      makeSessionTree(makeSession(sessionId), [
        makeNode({ uuid: u1, parentUuid: null, type: "user", seq: 0, sessionId, text: "hello" }),
        makeNode({ uuid: a1, parentUuid: u1, type: "assistant", seq: 1, sessionId, text: "hi" }),
      ]),
    ]);

    const { nodes, edges } = buildForestGraph(tree, noopBranch);
    const turnNodes = nodes.filter(isTurnNode);
    expect(turnNodes).toHaveLength(1);
    expect(turnNodes[0]?.data.memberUuids).toEqual([u1, a1]);
    expect(turnNodes[0]?.data.userText).toBe("hello");
    expect(turnNodes[0]?.data.assistantText).toBe("hi");
    expect(edges).toHaveLength(0);
  });

  it("gives a trailing user turn with no assistant reply yet a null assistantText", () => {
    const sessionId = "s1";
    const u1 = makeUuid("u");
    const a1 = makeUuid("a");
    const u2 = makeUuid("u");
    const tree = makeProjectTree([
      makeSessionTree(makeSession(sessionId), [
        makeNode({ uuid: u1, parentUuid: null, type: "user", seq: 0, sessionId, text: "hello" }),
        makeNode({ uuid: a1, parentUuid: u1, type: "assistant", seq: 1, sessionId, text: "hi" }),
        makeNode({ uuid: u2, parentUuid: a1, type: "user", seq: 2, sessionId, text: "follow up" }),
      ]),
    ]);

    const { nodes, edges } = buildForestGraph(tree, noopBranch);
    const turnNodes = nodes.filter(isTurnNode);
    expect(turnNodes).toHaveLength(2);
    expect(turnNodes[1]?.data.userText).toBe("follow up");
    expect(turnNodes[1]?.data.assistantText).toBeNull();
    expect(edges).toHaveLength(1); // one linear edge between the two turns
  });

  it("produces no nodes/edges for a zero-node root session, without crashing", () => {
    const tree = makeProjectTree([makeSessionTree(makeSession("empty-session"), [])]);
    const { nodes, edges } = buildForestGraph(tree, noopBranch);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("folds tool-call/tool-result action lines (no real text) into the surrounding turn instead of starting new boxes", () => {
    const sessionId = "s1";
    const u1 = makeUuid("u");
    const toolCall = makeUuid("a"); // assistant line with only a tool_use block: no text extracted
    const toolResult = makeUuid("u"); // synthetic user-type tool_result reply: no text extracted
    const a1 = makeUuid("a");
    const tree = makeProjectTree([
      makeSessionTree(makeSession(sessionId), [
        makeNode({ uuid: u1, parentUuid: null, type: "user", seq: 0, sessionId, text: "run the tests" }),
        makeNode({ uuid: toolCall, parentUuid: u1, type: "assistant", seq: 1, sessionId }), // no text
        makeNode({ uuid: toolResult, parentUuid: toolCall, type: "user", seq: 2, sessionId }), // no text
        makeNode({ uuid: a1, parentUuid: toolResult, type: "assistant", seq: 3, sessionId, text: "tests pass" }),
      ]),
    ]);

    const { nodes, edges } = buildForestGraph(tree, noopBranch);
    const turnNodes = nodes.filter(isTurnNode);
    expect(turnNodes).toHaveLength(1);
    expect(turnNodes[0]?.data.memberUuids).toEqual([u1, toolCall, toolResult, a1]);
    expect(turnNodes[0]?.data.userText).toBe("run the tests");
    expect(turnNodes[0]?.data.assistantText).toBe("tests pass");
    expect(edges).toHaveLength(0);
  });

  it("folds an injected skill/command body (isMeta line with real text) into the preceding turn instead of a new box", () => {
    const sessionId = "s1";
    const u1 = makeUuid("u");
    const skillBody = makeUuid("u"); // isMeta companion line Claude Code splices in right after the typed command
    const a1 = makeUuid("a");
    const tree = makeProjectTree([
      makeSessionTree(makeSession(sessionId), [
        makeNode({ uuid: u1, parentUuid: null, type: "user", seq: 0, sessionId, text: "/simplify" }),
        makeNode({
          uuid: skillBody,
          parentUuid: u1,
          type: "user",
          seq: 1,
          sessionId,
          text: "# Simplify skill\n\nFull markdown body of the skill goes here...",
          isMeta: true,
        }),
        makeNode({ uuid: a1, parentUuid: skillBody, type: "assistant", seq: 2, sessionId, text: "Done." }),
      ]),
    ]);

    const { nodes, edges } = buildForestGraph(tree, noopBranch);
    const turnNodes = nodes.filter(isTurnNode);
    expect(turnNodes).toHaveLength(1);
    expect(turnNodes[0]?.data.userText).toBe("/simplify");
    expect(turnNodes[0]?.data.assistantText).toBe("Done.");
    expect(turnNodes[0]?.data.memberUuids).toEqual([u1, skillBody, a1]);
    expect(edges).toHaveLength(0);
  });

  it("targets the latest real message for resume, not a trailing tool-call action node", () => {
    const sessionId = "s1";
    const u1 = makeUuid("u");
    const a1 = makeUuid("a"); // real assistant reply
    const trailingToolCall = makeUuid("a"); // assistant calls a tool after replying, no text, ends the turn
    const tree = makeProjectTree([
      makeSessionTree(makeSession(sessionId), [
        makeNode({ uuid: u1, parentUuid: null, type: "user", seq: 0, sessionId, text: "do a thing" }),
        makeNode({ uuid: a1, parentUuid: u1, type: "assistant", seq: 1, sessionId, text: "sure, one sec" }),
        makeNode({ uuid: trailingToolCall, parentUuid: a1, type: "assistant", seq: 2, sessionId }), // no text
      ]),
    ]);

    const { nodes } = buildForestGraph(tree, noopBranch);
    const turnNodes = nodes.filter(isTurnNode);
    expect(turnNodes).toHaveLength(1);
    // targetNodeUuid should resolve to a1 (last real message), not trailingToolCall.
    expect(turnNodes[0]?.data.targetNodeUuid).toBe(a1);
  });
});

describe("buildForestGraph / fork attachment", () => {
  function buildThreeTurnRoot(sessionId: string) {
    const uuids = { u1: makeUuid("u"), a1: makeUuid("a"), u2: makeUuid("u"), a2: makeUuid("a"), u3: makeUuid("u"), a3: makeUuid("a") };
    const nodes = [
      makeNode({ uuid: uuids.u1, parentUuid: null, type: "user", seq: 0, sessionId, text: "msg1" }),
      makeNode({ uuid: uuids.a1, parentUuid: uuids.u1, type: "assistant", seq: 1, sessionId, text: "reply1" }),
      makeNode({ uuid: uuids.u2, parentUuid: uuids.a1, type: "user", seq: 2, sessionId, text: "msg2" }),
      makeNode({ uuid: uuids.a2, parentUuid: uuids.u2, type: "assistant", seq: 3, sessionId, text: "reply2" }),
      makeNode({ uuid: uuids.u3, parentUuid: uuids.a2, type: "user", seq: 4, sessionId, text: "msg3" }),
      makeNode({ uuid: uuids.a3, parentUuid: uuids.u3, type: "assistant", seq: 5, sessionId, text: "reply3" }),
    ];
    return { nodes, uuids };
  }

  it("attaches a fork to the turn actually containing sourceNodeUuid (the middle turn), not the first or last turn", () => {
    const sessionId = "root-sess";
    const { nodes, uuids } = buildThreeTurnRoot(sessionId);
    const forkSessionId = "fork-sess";
    const forkNode = makeUuid("fu");
    const fork: SessionForkDTO = {
      edgeType: "branch",
      sourceNodeUuid: uuids.a2, // belongs to the MIDDLE turn (turn index 1)
      session: makeSessionTree(makeSession(forkSessionId), [
        makeNode({ uuid: forkNode, parentUuid: null, type: "user", seq: 0, sessionId: forkSessionId, text: "forked msg" }),
      ]),
    };
    const tree = makeProjectTree([makeSessionTree(makeSession(sessionId), nodes, [fork])]);

    const { edges } = buildForestGraph(tree, noopBranch);
    const forkEdge = edges.find((e) => e.id.startsWith("fork-"));
    expect(forkEdge).toBeDefined();
    expect(forkEdge?.source).toBe(`${sessionId}#1`); // the middle turn's id, not #0 or #2
  });

  it("marks a subagent-type fork edge distinctly from a branch-type fork edge", () => {
    const sessionId = "root-sess2";
    const { nodes, uuids } = buildThreeTurnRoot(sessionId);
    const forkSessionId = "fork-sess2";
    const forkNode = makeUuid("fu");
    const fork: SessionForkDTO = {
      edgeType: "subagent",
      sourceNodeUuid: uuids.a1, // first turn
      session: makeSessionTree(makeSession(forkSessionId), [
        makeNode({ uuid: forkNode, parentUuid: null, type: "user", seq: 0, sessionId: forkSessionId, text: "forked msg" }),
      ]),
    };
    const tree = makeProjectTree([makeSessionTree(makeSession(sessionId), nodes, [fork])]);

    const { edges } = buildForestGraph(tree, noopBranch);
    const forkEdge = edges.find((e) => e.id.startsWith("fork-"));
    expect(forkEdge?.className).toBe("edge-subagent");
    expect(forkEdge?.label).toBe("subagent");
    expect(forkEdge?.source).toBe(`${sessionId}#0`);
  });

  it("renders a placeholder node (not a real turn) for a fork whose target session has zero indexed nodes yet", () => {
    const sessionId = "root-sess3";
    const { nodes, uuids } = buildThreeTurnRoot(sessionId);
    const forkSessionId = "fresh-fork-sess";
    const fork: SessionForkDTO = {
      edgeType: "branch",
      sourceNodeUuid: uuids.u3,
      session: makeSessionTree(makeSession(forkSessionId), []), // not indexed yet
    };
    const tree = makeProjectTree([makeSessionTree(makeSession(sessionId), nodes, [fork])]);

    const { nodes: outNodes, edges } = buildForestGraph(tree, noopBranch);
    const placeholder = outNodes.filter(isPlaceholderNode);
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]?.id).toBe(`placeholder-${forkSessionId}`);
    expect(placeholder[0]?.data).toEqual({ sessionId: forkSessionId, edgeType: "branch" });

    const forkEdge = edges.find((e) => e.id.startsWith("fork-"));
    expect(forkEdge?.source).toBe(`${sessionId}#2`); // uuids.u3 is in the third (last) turn
    expect(forkEdge?.target).toBe(`placeholder-${forkSessionId}`);
  });

  it("recursively nests a fork-of-a-fork (branch, then subagent, two levels deep)", () => {
    const sessionA = "sess-A";
    const uA = makeUuid("u");
    const aA = makeUuid("a");
    const sessionB = "sess-B";
    const uB = makeUuid("u");
    const aB = makeUuid("a");
    const sessionC = "sess-C";
    const uC = makeUuid("u");

    const treeC = makeSessionTree(makeSession(sessionC), [
      makeNode({ uuid: uC, parentUuid: null, type: "user", seq: 0, sessionId: sessionC, text: "subagent task" }),
    ]);
    const treeB = makeSessionTree(
      makeSession(sessionB),
      [
        makeNode({ uuid: uB, parentUuid: null, type: "user", seq: 0, sessionId: sessionB, text: "msg B" }),
        makeNode({ uuid: aB, parentUuid: uB, type: "assistant", seq: 1, sessionId: sessionB, text: "reply B" }),
      ],
      [{ edgeType: "subagent", sourceNodeUuid: aB, session: treeC }],
    );
    const treeA = makeSessionTree(
      makeSession(sessionA),
      [
        makeNode({ uuid: uA, parentUuid: null, type: "user", seq: 0, sessionId: sessionA, text: "msg A" }),
        makeNode({ uuid: aA, parentUuid: uA, type: "assistant", seq: 1, sessionId: sessionA, text: "reply A" }),
      ],
      [{ edgeType: "branch", sourceNodeUuid: aA, session: treeB }],
    );

    const { nodes, edges } = buildForestGraph(makeProjectTree([treeA]), noopBranch);
    const turnNodes = nodes.filter(isTurnNode);
    expect(turnNodes.map((n) => n.data.sessionId).sort()).toEqual([sessionA, sessionB, sessionC].sort());

    const forkEdges = edges.filter((e) => e.id.startsWith("fork-"));
    expect(forkEdges).toHaveLength(2);
    const aToB = forkEdges.find((e) => e.className === "edge-branch");
    const bToC = forkEdges.find((e) => e.className === "edge-subagent");
    expect(aToB?.source).toBe(`${sessionA}#0`);
    expect(aToB?.target).toBe(`${sessionB}#0`);
    expect(bToC?.source).toBe(`${sessionB}#0`);
    expect(bToC?.target).toBe(`${sessionC}#0`);
  });
});

describe("buildForestGraph / click-to-expand", () => {
  function buildLinearSession(sessionId: string) {
    const u1 = makeUuid("u");
    const a1 = makeUuid("a");
    const u2 = makeUuid("u");
    const a2 = makeUuid("a");
    return makeProjectTree([
      makeSessionTree(makeSession(sessionId), [
        makeNode({ uuid: u1, parentUuid: null, type: "user", seq: 0, sessionId, text: "hello" }),
        makeNode({ uuid: a1, parentUuid: u1, type: "assistant", seq: 1, sessionId, text: "hi" }),
        makeNode({ uuid: u2, parentUuid: a1, type: "user", seq: 2, sessionId, text: "again" }),
        makeNode({ uuid: a2, parentUuid: u2, type: "assistant", seq: 3, sessionId, text: "sure" }),
      ]),
    ]);
  }

  it("marks only the expanded turn's data.isExpanded, defaulting to false for everyone else", () => {
    const sessionId = "s1";
    const tree = buildLinearSession(sessionId);
    const expandedTurnId = `${sessionId}#0`;

    const { nodes } = buildForestGraph(tree, noopBranch, undefined, expandedTurnId);
    const turnNodes = nodes.filter(isTurnNode);
    expect(turnNodes.find((n) => n.id === expandedTurnId)?.data.isExpanded).toBe(true);
    expect(turnNodes.find((n) => n.id !== expandedTurnId)?.data.isExpanded).toBe(false);
  });

  it("reserves extra vertical room for the expanded turn instead of overlapping its neighbor", () => {
    const sessionId = "s1";
    const tree = buildLinearSession(sessionId);
    const expandedTurnId = `${sessionId}#0`;

    const collapsed = buildForestGraph(tree, noopBranch);
    const collapsedTurns = collapsed.nodes.filter(isTurnNode);
    const collapsedGap = (collapsedTurns[1]?.position.y ?? 0) - (collapsedTurns[0]?.position.y ?? 0);

    const expanded = buildForestGraph(tree, noopBranch, undefined, expandedTurnId);
    const expandedTurns = expanded.nodes.filter(isTurnNode);
    const expandedGap = (expandedTurns[1]?.position.y ?? 0) - (expandedTurns[0]?.position.y ?? 0);

    // Dagre must reserve strictly more room below a bigger box, so the next turn never overlaps it.
    expect(expandedGap).toBeGreaterThan(collapsedGap);
  });
});

describe("buildForestGraph / dagre layout", () => {
  it("lays out multiple root sessions side by side with non-overlapping bounding boxes", () => {
    const sessionX = "sess-X";
    const sessionY = "sess-Y";
    const xu1 = makeUuid("u");
    const xa1 = makeUuid("a");
    const xu2 = makeUuid("u");
    const yu1 = makeUuid("u");
    const yu2 = makeUuid("u");
    const yu3 = makeUuid("u");

    const treeX = makeSessionTree(makeSession(sessionX), [
      makeNode({ uuid: xu1, parentUuid: null, type: "user", seq: 0, sessionId: sessionX, text: "x msg 1" }),
      makeNode({ uuid: xa1, parentUuid: xu1, type: "assistant", seq: 1, sessionId: sessionX, text: "x reply 1" }),
      makeNode({ uuid: xu2, parentUuid: xa1, type: "user", seq: 2, sessionId: sessionX, text: "x msg 2" }),
    ]);
    const treeY = makeSessionTree(makeSession(sessionY), [
      makeNode({ uuid: yu1, parentUuid: null, type: "user", seq: 0, sessionId: sessionY, text: "y msg 1" }),
      makeNode({ uuid: yu2, parentUuid: yu1, type: "user", seq: 1, sessionId: sessionY, text: "y msg 2" }),
      makeNode({ uuid: yu3, parentUuid: yu2, type: "user", seq: 2, sessionId: sessionY, text: "y msg 3" }),
    ]);

    const { nodes } = buildForestGraph(makeProjectTree([treeX, treeY]), noopBranch);
    const groupX = nodes.filter(isTurnNode).filter((n) => n.data.sessionId === sessionX);
    const groupY = nodes.filter(isTurnNode).filter((n) => n.data.sessionId === sessionY);
    expect(groupX.length).toBeGreaterThan(0);
    expect(groupY.length).toBeGreaterThan(0);

    const maxX_X = Math.max(...groupX.map((n) => n.position.x));
    const minX_Y = Math.min(...groupY.map((n) => n.position.x));
    // The second root's forest is placed strictly to the right of the first's.
    expect(minX_Y).toBeGreaterThan(maxX_X);

    // Sanity: within one root, y positions vary (dagre actually laid out ranks), not all identical/zero.
    const ys = groupX.map((n) => n.position.y);
    expect(new Set(ys).size).toBeGreaterThan(1);
  });
});
