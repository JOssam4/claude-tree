import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import type { TurnNode as TurnNodeType } from '../tree/turnGraph';

/**
 * Custom xyflow node rendering one user+assistant turn. `data.memberUuids`
 * and `data.targetNodeUuid` are exposed as data-* attributes so Milestone 5
 * has something to hook a click handler / context menu onto without needing
 * to touch this component again.
 */
export function TurnNode({ id, data }: NodeProps<TurnNodeType>) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div
      className={`turn-node${data.isSessionRoot ? ' turn-node--root' : ''}${data.isSidechain ? ' turn-node--sidechain' : ''}${
        // 'nowheel' is @xyflow/react's built-in escape hatch (default noWheelClassName): scrolling
        // over an element with this class scrolls the element's own overflow instead of the usual
        // zoom-on-scroll behavior over the canvas. Only needed once expanded — the collapsed card
        // has no scrollable overflow, and we still want scroll-to-zoom to work everywhere else.
        data.isExpanded ? ' turn-node--expanded nowheel' : ''
      }`}
      data-target-node-uuid={data.targetNodeUuid}
      data-member-uuids={data.memberUuids.join(',')}
      role="button"
      tabIndex={0}
      aria-expanded={data.isExpanded}
      title={data.isExpanded ? 'Click to collapse' : 'Click to expand and read the full turn'}
      onClick={() => data.onToggleExpand(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          data.onToggleExpand(id);
        }
      }}
    >
      <Handle type="target" position={Position.Top} />
      {data.isSessionRoot && <div className="turn-node__badge">{data.isSidechain ? 'subagent root' : 'session root'}</div>}
      <div className="turn-node__speaker turn-node__speaker--user">You</div>
      <div className="turn-node__user">{data.userText ?? <em>(no user text — tool result/continuation)</em>}</div>
      {data.assistantText && (
        <>
          <div className="turn-node__speaker turn-node__speaker--assistant">Claude</div>
          <div className="turn-node__assistant">{data.assistantText}</div>
        </>
      )}
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
          {copied ? 'Copied!' : '⧉ copy resume command'}
        </button>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
