import { useState } from 'react';
import type { ConversationSummaryDTO } from '@claude-tree/shared';
import { Project } from './Project';

interface ProjectListProps {
  conversations: ConversationSummaryDTO[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onToggleHidden: (sessionId: string, hidden: boolean) => void;
}

interface ProjectGroup {
  projectSlug: string;
  projectCwd: string;
  conversations: ConversationSummaryDTO[];
}

/**
 * Groups conversations by project without disturbing their existing order.
 * `conversations` arrives sorted most-recent-activity-first (see
 * listConversationSummaries), so a project's position ends up set by its most
 * recent conversation, and conversations stay in that order within each
 * project's group — Map preserves insertion order, so the first time a
 * project's slug is seen fixes the group's position.
 */
function groupByProject(conversations: ConversationSummaryDTO[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const c of conversations) {
    let group = groups.get(c.projectSlug);
    if (!group) {
      group = { projectSlug: c.projectSlug, projectCwd: c.projectCwd, conversations: [] };
      groups.set(c.projectSlug, group);
    }
    group.conversations.push(c);
  }
  return [...groups.values()];
}

/** Sidebar listing every indexed conversation (root session), grouped by project (working directory); click one to render its tree. */
export const ProjectList = ({ conversations, selectedSessionId, onSelect, onToggleHidden }: ProjectListProps) => {
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = conversations.filter((c) => c.isHidden).length;
  const visibleConversations = showHidden ? conversations : conversations.filter((c) => !c.isHidden);
  const projectGroups = groupByProject(visibleConversations);
  return (
    <div className="conversation-list">
      <h2>Conversations</h2>
      {conversations.length === 0 && <p className="conversation-list__empty">No conversations indexed yet.</p>}
      {projectGroups.map((group) => (
        <Project
          key={group.projectSlug}
          projectCwd={group.projectCwd}
          conversations={group.conversations}
          selectedSessionId={selectedSessionId}
          onSelect={onSelect}
          onToggleHidden={onToggleHidden}
        />
      ))}
      {hiddenCount > 0 ? (
        <button type="button" className="conversation-list__show-hidden" onClick={() => setShowHidden((s) => !s)}>
          {showHidden ? 'Hide hidden conversations' : `Show ${hiddenCount} hidden conversation${hiddenCount === 1 ? '' : 's'}`}
        </button>
      ) : (
        <p className="conversation-list__show-hidden conversation-list__show-hidden--empty">No hidden conversations</p>
      )}
    </div>
  );
};
