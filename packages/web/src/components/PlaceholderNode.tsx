import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PlaceholderNode as PlaceholderNodeType } from '../tree/turnGraph';

/**
 * Milestone 6: rendered in place of a real TurnNode for a fork whose target
 * session has zero indexed nodes yet (see PlaceholderNodeData's doc comment
 * in turnGraph.ts for why that happens). Deliberately visually distinct from
 * a real turn box — dashed border, muted text, no branch button (there's no
 * real node here to branch from yet) — so it reads unambiguously as "branch
 * created, nothing said yet" rather than as an empty/broken turn.
 */
export function PlaceholderNode({ data }: NodeProps<PlaceholderNodeType>) {
  return (
    <div className="turn-node turn-node--placeholder" data-session-id={data.sessionId}>
      <Handle type="target" position={Position.Top} />
      <div className="turn-node__placeholder-text">
        ◌ new {data.edgeType === 'subagent' ? 'subagent' : 'branch'} — waiting for first message
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
