import type { ConversationSummaryDTO } from '@claude-tree/shared';
import { Conversation } from './Conversation';

interface ConversationListProps {
  conversations: ConversationSummaryDTO[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onToggleHidden: (sessionId: string, hidden: boolean) => void;
  onRename: (sessionId: string, title: string | null) => void;
}

/** List of conversations (root sessions) belonging to a single project; click one to render its tree. */
export const ConversationList = ({ conversations, selectedSessionId, onSelect, onToggleHidden, onRename }: ConversationListProps) => {
  return (
    <ul>
      {conversations.map((c) => (
        <li key={c.sessionId}>
          <Conversation
            conversation={c}
            selectedSessionId={selectedSessionId}
            onSelect={onSelect}
            onToggleHidden={onToggleHidden}
            onRename={onRename}
          />
        </li>
      ))}
    </ul>
  );
};
