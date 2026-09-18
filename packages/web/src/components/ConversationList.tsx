import type { ConversationSummaryDTO } from '@claude-tree/shared';

interface ConversationListProps {
  conversations: ConversationSummaryDTO[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

/** Sidebar listing every indexed conversation (root session) by its AI title; click one to render its tree. */
export function ConversationList({ conversations, selectedSessionId, onSelect }: ConversationListProps) {
  return (
    <div className="conversation-list">
      <h2>Conversations</h2>
      {conversations.length === 0 && <p className="conversation-list__empty">No conversations indexed yet.</p>}
      <ul>
        {conversations.map((c) => (
          <li key={c.sessionId}>
            <button
              className={
                c.sessionId === selectedSessionId
                  ? 'conversation-list__item conversation-list__item--active'
                  : 'conversation-list__item'
              }
              onClick={() => onSelect(c.sessionId)}
            >
              <div className="conversation-list__title">{c.aiTitle ?? '(untitled conversation)'}</div>
              <div className="conversation-list__meta">{c.projectCwd}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
