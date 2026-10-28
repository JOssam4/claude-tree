import { useState } from 'react';
import type { ConversationSummaryDTO } from '@claude-tree/shared';
import { ConversationList } from './ConversationList';

interface ProjectProps {
  projectCwd: string;
  conversations: ConversationSummaryDTO[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onToggleHidden: (sessionId: string, hidden: boolean) => void;
  onRename: (sessionId: string, title: string | null) => void;
}

/** One collapsible project group: a header toggling the visibility of its conversation list. */
export const Project = ({ projectCwd, conversations, selectedSessionId, onSelect, onToggleHidden, onRename }: ProjectProps) => {
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
        <ConversationList
          conversations={conversations}
          selectedSessionId={selectedSessionId}
          onSelect={onSelect}
          onToggleHidden={onToggleHidden}
          onRename={onRename}
        />
      )}
    </div>
  );
};
