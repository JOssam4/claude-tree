import { useMemo } from 'react';
import { ReactFlow, Background, Controls, MiniMap, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ProjectTreeDTO } from '@claude-tree/shared';
import { buildForestGraph } from '../tree/turnGraph';
import { PlaceholderNode } from './PlaceholderNode';
import { TurnNode } from './TurnNode';

const nodeTypes: NodeTypes = {
  turn: TurnNode as NodeTypes[string],
  placeholder: PlaceholderNode as NodeTypes[string],
};

interface TreeCanvasProps {
  tree: ProjectTreeDTO;
  /** Milestone 5: called with a turn's targetNodeUuid when its "⑂ branch" button is clicked. */
  onBranch: (targetNodeUuid: string) => void;
  /** Milestone 8: called with a turn's targetNodeUuid when its "⧉ copy resume command" button is clicked. */
  onCopyResumeCommand: (targetNodeUuid: string) => Promise<string | null>;
}

/** Renders one project's forest: a disconnected xyflow component per root session, dagre-laid-out. */
export function TreeCanvas({ tree, onBranch, onCopyResumeCommand }: TreeCanvasProps) {
  const { nodes, edges } = useMemo(
    () => buildForestGraph(tree, onBranch, onCopyResumeCommand),
    [tree, onBranch, onCopyResumeCommand],
  );

  if (nodes.length === 0) {
    return <div className="tree-canvas__empty">This project has no indexed sessions yet.</div>;
  }

  return (
    <div className="tree-canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.05} proOptions={{ hideAttribution: true }}>
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
