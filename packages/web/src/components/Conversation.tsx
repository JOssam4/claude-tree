import {useRef, useState} from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faEye, faEyeSlash, faPen} from '@fortawesome/free-solid-svg-icons';
import {ConversationSummaryDTO} from '@claude-tree/shared';

interface ConversationProps {
    conversation: ConversationSummaryDTO;
    selectedSessionId: string | null;
    onSelect: (sessionId: string) => void;
    onToggleHidden: (sessionId: string, hidden: boolean) => void;
    onRename: (sessionId: string, title: string | null) => void;
}

export const Conversation = ({conversation, selectedSessionId, onSelect, onToggleHidden, onRename}: ConversationProps) => {
    const [draftTitle, setDraftTitle] = useState<string | null>(null);
    // Enter/Escape end editing and unmount the input, which can also fire its
    // onBlur — this guards against saving twice, or saving after Escape.
    const editingRef = useRef(false);

    const displayTitle = conversation.customTitle ?? conversation.aiTitle ?? '(untitled conversation)';

    const classNames = ['conversation-list__item'];
    if (conversation.sessionId === selectedSessionId) classNames.push('conversation-list__item--active');
    if (conversation.isHidden) classNames.push('conversation-list__item--hidden');

    const startEditing = () => {
        editingRef.current = true;
        setDraftTitle(conversation.customTitle ?? conversation.aiTitle ?? '');
    };

    // A blank name clears the custom title, falling back to the AI title.
    const finishEditing = (save: boolean) => {
        if (!editingRef.current) return;
        editingRef.current = false;
        const trimmed = draftTitle?.trim() ?? '';
        setDraftTitle(null);
        if (save && trimmed !== displayTitle) onRename(conversation.sessionId, trimmed || null);
    };

    return (
        <div className={classNames.join(' ')}>
            {draftTitle !== null ? (
                <input
                    className="conversation-list__title-input"
                    aria-label="Conversation name"
                    value={draftTitle}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onBlur={() => finishEditing(true)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') finishEditing(true);
                        else if (e.key === 'Escape') finishEditing(false);
                    }}
                />
            ) : (
                <button
                    type="button"
                    className="conversation-list__item-select"
                    onClick={() => onSelect(conversation.sessionId)}
                >
                    <div className="conversation-list__title">{displayTitle}</div>
                </button>
            )}
            <button
                type="button"
                className="conversation-list__item-action"
                title="Rename this conversation"
                aria-label="Rename this conversation"
                onClick={startEditing}
            >
                <FontAwesomeIcon icon={faPen} />
            </button>
            <button
                type="button"
                className="conversation-list__item-action"
                title={conversation.isHidden ? 'Unhide this conversation' : 'Hide this conversation'}
                aria-label={conversation.isHidden ? 'Unhide this conversation' : 'Hide this conversation'}
                onClick={() => onToggleHidden(conversation.sessionId, !conversation.isHidden)}
            >
                <FontAwesomeIcon icon={conversation.isHidden ? faEye : faEyeSlash} />
            </button>
        </div>
    );
}
