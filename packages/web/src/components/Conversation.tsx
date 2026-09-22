import {ConversationSummaryDTO} from '@claude-tree/shared';

interface ConversationProps {
    conversation: ConversationSummaryDTO;
    selectedSessionId: string | null;
    onSelect: (sessionId: string) => void;
}

export const Conversation = ({conversation, selectedSessionId, onSelect}: ConversationProps) => {
    return (
        <button
            className={
                conversation.sessionId === selectedSessionId
                    ? 'conversation-list__item conversation-list__item--active'
                    : 'conversation-list__item'
            }
            onClick={() => onSelect(conversation.sessionId)}
        >
            <div className="conversation-list__title">{conversation.aiTitle ?? '(untitled conversation)'}</div>
        </button>
    );
}