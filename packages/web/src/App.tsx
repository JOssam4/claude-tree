import { useCallback, useEffect, useRef, useState } from 'react';
import type { BranchResponseDTO, ConversationSummaryDTO, ProjectTreeDTO } from '@claude-tree/shared';
import { branchFromNode, getConversations, getSessionTree } from './api/client';
import { useTreeUpdates } from './api/useTreeUpdates';
import { ConversationList } from './components/ConversationList';
import { TerminalPanel } from './components/TerminalPanel';
import { TreeCanvas } from './components/TreeCanvas';

export function App() {
  const [conversations, setConversations] = useState<ConversationSummaryDTO[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [tree, setTree] = useState<ProjectTreeDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Milestone 5: the currently-open branch terminal's branch result, if any (also
  // carries Milestone 8's resumeCommand for the panel's own 'copy command' button).
  // Serves both 'resume from here' and 'start a new conversation from here' — same
  // mechanism, just triggered from a node's branch button, per the plan.
  const [terminalBranch, setTerminalBranch] = useState<BranchResponseDTO | null>(null);

  // Milestone 8: caches one branch call per source node uuid for this session's
  // lifetime, so clicking both '⑂ branch' and '⧉ copy resume command' for the same
  // node forks only ONE new session file, not two. Caches the in-flight PROMISE
  // itself (not just the resolved result) and stores it synchronously before any
  // await — otherwise two calls issued back-to-back (e.g. a rapid double-click, or
  // clicking 'branch' then immediately 'copy resume command') would both miss an
  // empty cache and both hit the API before either populated it, forking two
  // session files for one logical click. A failed call evicts itself so a later
  // click can retry instead of being stuck replaying the same rejection.
  const branchCacheRef = useRef(new Map<string, Promise<BranchResponseDTO>>());

  const getOrCreateBranch = useCallback((targetNodeUuid: string): Promise<BranchResponseDTO> => {
    const cached = branchCacheRef.current.get(targetNodeUuid);
    if (cached) return cached;
    const pending = branchFromNode(targetNodeUuid).catch((err: Error) => {
      branchCacheRef.current.delete(targetNodeUuid);
      throw err;
    });
    branchCacheRef.current.set(targetNodeUuid, pending);
    return pending;
  }, []);

  const refetchConversations = useCallback(() => {
    getConversations()
      .then((data) => {
        setConversations(data);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const refetchTree = useCallback((sessionId: string) => {
    getSessionTree(sessionId)
      .then((data) => {
        setTree(data);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => refetchConversations(), [refetchConversations]);
  useEffect(() => {
    if (selectedSessionId) refetchTree(selectedSessionId);
  }, [selectedSessionId, refetchTree]);

  // Milestone 4 scope: any live update just triggers a refetch (of the conversation list, and
  // of the open tree if it belongs to the selected conversation's project — a fork landing
  // anywhere in that project could be a new node in the currently-displayed tree) rather than
  // patching state in place.
  useTreeUpdates((event) => {
    refetchConversations();
    if (selectedSessionId && event.projectSlug === tree?.project.slug) refetchTree(selectedSessionId);
  });

  const handleBranch = useCallback(
    (targetNodeUuid: string) => {
      getOrCreateBranch(targetNodeUuid)
        .then((result) => {
          setTerminalBranch(result);
          setError(null);
          // The new session shows up in the tree on its own once the watcher
          // indexes the freshly-written file and broadcasts tree:update — no
          // explicit refetch needed here.
        })
        .catch((e: Error) => setError(e.message));
    },
    [getOrCreateBranch],
  );

  // Milestone 8: shares the same cached branch call as handleBranch above — resolves
  // to the resumeCommand, or null (after surfacing the error the same way handleBranch
  // does) so the button can just skip copying rather than copy an error message.
  const handleCopyResumeCommand = useCallback(
    (targetNodeUuid: string): Promise<string | null> => {
      return getOrCreateBranch(targetNodeUuid)
        .then((result) => {
          setError(null);
          return result.resumeCommand;
        })
        .catch((e: Error) => {
          setError(e.message);
          return null;
        });
    },
    [getOrCreateBranch],
  );

  return (
    <div className="app">
      <aside className="app__sidebar">
        <ConversationList
          conversations={conversations}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
        />
      </aside>
      <main className="app__main">
        {error && <div className="app__error">{error}</div>}
        {!selectedSessionId && <div className="tree-canvas__empty">Select a conversation to view its tree.</div>}
        {selectedSessionId && tree && (
          <TreeCanvas
            tree={tree}
            onBranch={handleBranch}
            onCopyResumeCommand={handleCopyResumeCommand}
            key={selectedSessionId}
          />
        )}
      </main>
      {terminalBranch && (
        <TerminalPanel
          sessionId={terminalBranch.newSessionId}
          resumeCommand={terminalBranch.resumeCommand}
          onClose={() => setTerminalBranch(null)}
        />
      )}
    </div>
  );
}
