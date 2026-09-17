import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import type { TurnNode as TurnNodeType } from "../tree/turnGraph";

/**
 * Custom xyflow node rendering one user+assistant turn. `data.memberUuids`
 * and `data.targetNodeUuid` are exposed as data-* attributes so Milestone 5
 * has something to hook a click handler / context menu onto without needing
 * to touch this component again.
 */
export function TurnNode({ data }: NodeProps<TurnNodeType>) {
  const { copied, copy } = useCopyToClipboard();

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
      <div className="turn-node__actions">
        <button
          className="turn-node__branch-btn"
          onClick={(e) => {
            e.stopPropagation();
            data.onBranch(data.targetNodeUuid);
          }}
          title="Branch from here: forks this conversation's history into a new, independently-resumable session, and opens it in an embedded terminal"
        >
          ⑂ branch
        </button>
        <button
          className="turn-node__copy-btn"
          onClick={(e) => {
            e.stopPropagation();
            // Same underlying branch call as "⑂ branch" — the caller (App.tsx) caches
            // the result per node so this never forks a second, redundant session.
            data.onCopyResumeCommand(data.targetNodeUuid).then((command) => {
              if (command) copy(command);
            });
          }}
          title="Branch from here and copy a ready-to-run `claude --resume` command to paste into your own terminal"
        >
          {copied ? "Copied!" : "⧉ copy resume command"}
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
