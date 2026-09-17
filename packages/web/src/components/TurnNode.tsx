import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { TurnNode as TurnNodeType } from "../tree/turnGraph";

/**
 * Custom xyflow node rendering one user+assistant turn. `data.memberUuids`
 * and `data.targetNodeUuid` are exposed as data-* attributes so Milestone 5
 * has something to hook a click handler / context menu onto without needing
 * to touch this component again.
 */
export function TurnNode({ data }: NodeProps<TurnNodeType>) {
  return (
    <div
      className={`turn-node${data.isSessionRoot ? " turn-node--root" : ""}${data.isSidechain ? " turn-node--sidechain" : ""}`}
      data-target-node-uuid={data.targetNodeUuid}
      data-member-uuids={data.memberUuids.join(",")}
    >
      <Handle type="target" position={Position.Top} />
      {data.isSessionRoot && <div className="turn-node__badge">{data.isSidechain ? "subagent root" : "session root"}</div>}
      <div className="turn-node__user">{data.userText ?? <em>(no user text — tool result/continuation)</em>}</div>
      {data.assistantText && <div className="turn-node__assistant">{data.assistantText}</div>}
      {/* Placeholder affordance for Milestone 5 — not wired to any action yet. */}
      <button className="turn-node__branch-btn" disabled title="Branch from here (Milestone 5)">
        ⑂ branch
      </button>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
