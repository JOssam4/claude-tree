import { useCallback, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ProjectTreeDTO } from '@claude-tree/shared';
import type { Theme } from '../hooks/useTheme';
import { buildForestGraph } from '../tree/turnGraph';
import { TurnNode } from './TurnNode';

const nodeTypes: NodeTypes = {
  turn: TurnNode as NodeTypes[string],
};

interface TreeCanvasProps {
  tree: ProjectTreeDTO;
  theme: Theme;
  /** Milestone 8: called with a turn's targetNodeUuid when its "⧉ copy resume command" button is clicked. */
  onCopyResumeCommand: (targetNodeUuid: string) => Promise<string | null>;
}

/** Renders one project's forest: a disconnected xyflow component per root session, dagre-laid-out. */
export const TreeCanvas = ({ tree, theme, onCopyResumeCommand }: TreeCanvasProps) => {
  // At most one turn expanded at a time — clicking an already-expanded card collapses it back down.
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(null);
  const onToggleExpand = useCallback((turnId: string) => {
    setExpandedTurnId((current) => (current === turnId ? null : turnId));
  }, []);

  const { nodes, edges } = useMemo(
    () => buildForestGraph(tree, onCopyResumeCommand, expandedTurnId, onToggleExpand),
    [tree, onCopyResumeCommand, expandedTurnId, onToggleExpand],
  );

  if (nodes.length === 0) {
    return <div className="tree-canvas__empty">This project has no indexed sessions yet.</div>;
  }

  return (
    <div className="tree-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.05}
        proOptions={{ hideAttribution: true }}
        colorMode={theme}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
};
