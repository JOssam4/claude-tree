import { useState } from 'react';
import type { ConversationSummaryDTO } from '@claude-tree/shared';
import { ConversationList } from './ConversationList';

interface ProjectProps {
  projectCwd: string;
  conversations: ConversationSummaryDTO[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

/** One collapsible project group: a header toggling the visibility of its conversation list. */
export function Project({ projectCwd, conversations, selectedSessionId, onSelect }: ProjectProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="conversation-list__project">
      <button
        type="button"
        className="conversation-list__project-name"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className={`conversation-list__project-caret${collapsed ? ' conversation-list__project-caret--collapsed' : ''}`}>
          ▾
        </span>
        {projectCwd}
      </button>
      {!collapsed && (
        <ConversationList conversations={conversations} selectedSessionId={selectedSessionId} onSelect={onSelect} />
      )}
    </div>
  );
}
