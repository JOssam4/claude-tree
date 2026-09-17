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
}): NodeDTO {
  return {
    uuid: opts.uuid,
    sessionId: opts.sessionId,
    parentUuid: opts.parentUuid,
    type: opts.type,
    role: opts.type === "user" ? "user" : "assistant",
    contentText: opts.text ?? null,
    contentRaw: "{}",
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
});

describe("buildForestGraph / fork attachment", () => {
  function buildThreeTurnRoot(sessionId: string) {
    const uuids = { u1: makeUuid("u"), a1: makeUuid("a"), u2: makeUuid("u"), a2: makeUuid("a"), u3: makeUuid("u"), a3: makeUuid("a") };
    const nodes = [
      makeNode({ uuid: uuids.u1, parentUuid: null, type: "user", seq: 0, sessionId }),
      makeNode({ uuid: uuids.a1, parentUuid: uuids.u1, type: "assistant", seq: 1, sessionId }),
      makeNode({ uuid: uuids.u2, parentUuid: uuids.a1, type: "user", seq: 2, sessionId }),
      makeNode({ uuid: uuids.a2, parentUuid: uuids.u2, type: "assistant", seq: 3, sessionId }),
      makeNode({ uuid: uuids.u3, parentUuid: uuids.a2, type: "user", seq: 4, sessionId }),
      makeNode({ uuid: uuids.a3, parentUuid: uuids.u3, type: "assistant", seq: 5, sessionId }),
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
        makeNode({ uuid: forkNode, parentUuid: null, type: "user", seq: 0, sessionId: forkSessionId }),
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
        makeNode({ uuid: forkNode, parentUuid: null, type: "user", seq: 0, sessionId: forkSessionId }),
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
      makeNode({ uuid: uC, parentUuid: null, type: "user", seq: 0, sessionId: sessionC }),
    ]);
    const treeB = makeSessionTree(
      makeSession(sessionB),
      [
        makeNode({ uuid: uB, parentUuid: null, type: "user", seq: 0, sessionId: sessionB }),
        makeNode({ uuid: aB, parentUuid: uB, type: "assistant", seq: 1, sessionId: sessionB }),
      ],
      [{ edgeType: "subagent", sourceNodeUuid: aB, session: treeC }],
    );
    const treeA = makeSessionTree(
      makeSession(sessionA),
      [
        makeNode({ uuid: uA, parentUuid: null, type: "user", seq: 0, sessionId: sessionA }),
        makeNode({ uuid: aA, parentUuid: uA, type: "assistant", seq: 1, sessionId: sessionA }),
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
      makeNode({ uuid: xu1, parentUuid: null, type: "user", seq: 0, sessionId: sessionX }),
      makeNode({ uuid: xa1, parentUuid: xu1, type: "assistant", seq: 1, sessionId: sessionX }),
      makeNode({ uuid: xu2, parentUuid: xa1, type: "user", seq: 2, sessionId: sessionX }),
    ]);
    const treeY = makeSessionTree(makeSession(sessionY), [
      makeNode({ uuid: yu1, parentUuid: null, type: "user", seq: 0, sessionId: sessionY }),
      makeNode({ uuid: yu2, parentUuid: yu1, type: "user", seq: 1, sessionId: sessionY }),
      makeNode({ uuid: yu3, parentUuid: yu2, type: "user", seq: 2, sessionId: sessionY }),
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
