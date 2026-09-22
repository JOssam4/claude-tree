import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faEye, faEyeSlash} from '@fortawesome/free-solid-svg-icons';
import {ConversationSummaryDTO} from '@claude-tree/shared';

interface ConversationProps {
    conversation: ConversationSummaryDTO;
    selectedSessionId: string | null;
    onSelect: (sessionId: string) => void;
    onToggleHidden: (sessionId: string, hidden: boolean) => void;
}

export const Conversation = ({conversation, selectedSessionId, onSelect, onToggleHidden}: ConversationProps) => {
    const classNames = ['conversation-list__item'];
    if (conversation.sessionId === selectedSessionId) classNames.push('conversation-list__item--active');
    if (conversation.isHidden) classNames.push('conversation-list__item--hidden');

    return (
        <div className={classNames.join(' ')}>
            <button
                type="button"
                className="conversation-list__item-select"
                onClick={() => onSelect(conversation.sessionId)}
            >
                <div className="conversation-list__title">{conversation.aiTitle ?? '(untitled conversation)'}</div>
            </button>
            <button
                type="button"
                className="conversation-list__item-hide"
                title={conversation.isHidden ? 'Unhide this conversation' : 'Hide this conversation'}
                aria-label={conversation.isHidden ? 'Unhide this conversation' : 'Hide this conversation'}
                onClick={() => onToggleHidden(conversation.sessionId, !conversation.isHidden)}
            >
                <FontAwesomeIcon icon={conversation.isHidden ? faEye : faEyeSlash} />
            </button>
        </div>
    );
}
