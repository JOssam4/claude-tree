import type { ConversationSummaryDTO } from '@claude-tree/shared';
import { Conversation } from './Conversation';

interface ConversationListProps {
  conversations: ConversationSummaryDTO[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

/** List of conversations (root sessions) belonging to a single project; click one to render its tree. */
export const ConversationList = ({ conversations, selectedSessionId, onSelect }: ConversationListProps) => {
  return (
    <ul>
      {conversations.map((c) => (
        <li key={c.sessionId}>
          <Conversation conversation={c} selectedSessionId={selectedSessionId} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
};
