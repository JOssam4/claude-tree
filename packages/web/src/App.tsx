import { useCallback, useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMoon, faSun } from '@fortawesome/free-solid-svg-icons';
import type { BranchResponseDTO, ConversationSummaryDTO, ProjectTreeDTO } from '@claude-tree/shared';
import { branchFromNode, getConversations, getSessionTree, setConversationHidden } from './api/client';
import { useTreeUpdates } from './api/useTreeUpdates';
import { ProjectList } from './components/ProjectList';
import { TreeCanvas } from './components/TreeCanvas';
import { useTheme } from './hooks/useTheme';

// There used to be a "⑂ branch" action here too (a `terminalBranch` state +
// `handleBranch` callback + `<TerminalPanel>` render, wired to a node's now-removed
// branch button) that opened the freshly-forked session in an embedded terminal.
// Removed for now — copy resume command covers the need. TerminalPanel.tsx is
// untouched; to restore, re-add that state/callback here (mirroring
// handleCopyResumeCommand below, but calling setTerminalBranch(result) instead of
// returning resumeCommand) and render `{terminalBranch && <TerminalPanel .../>}`
// alongside <TreeCanvas> below.

export const App = () => {
  const [conversations, setConversations] = useState<ConversationSummaryDTO[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [tree, setTree] = useState<ProjectTreeDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { theme, toggleTheme } = useTheme();

  // Milestone 8: caches one branch call per source node uuid for this session's
  // lifetime, so repeated '⧉ copy resume command' clicks for the same node fork
  // only ONE new session file, not several. Caches the in-flight PROMISE itself
  // (not just the resolved result) and stores it synchronously before any await —
  // otherwise two calls issued back-to-back (e.g. a rapid double-click) would both
  // miss an empty cache and both hit the API before either populated it, forking
  // two session files for one logical click. A failed call evicts itself so a later
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

  // Hides/unhides a conversation in the sidebar. Applied optimistically (the
  // sidebar shouldn't wait on a round-trip for a toggle this trivial) and
  // reverted if the PATCH fails, since conversations is otherwise only ever
  // replaced wholesale by refetchConversations.
  const handleToggleHidden = useCallback((sessionId: string, hidden: boolean) => {
    setConversations((prev) => prev.map((c) => (c.sessionId === sessionId ? { ...c, isHidden: hidden } : c)));
    setConversationHidden(sessionId, hidden).catch((e: Error) => {
      setConversations((prev) => prev.map((c) => (c.sessionId === sessionId ? { ...c, isHidden: !hidden } : c)));
      setError(e.message);
    });
  }, []);

  // Milestone 8: resolves to the resumeCommand, or null (after surfacing the error)
  // so the button can just skip copying rather than copy an error message.
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
        <button
          type="button"
          className="app__theme-toggle"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={toggleTheme}
        >
          <FontAwesomeIcon icon={theme === 'dark' ? faSun : faMoon} />
        </button>
        <ProjectList
          conversations={conversations}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
          onToggleHidden={handleToggleHidden}
        />
      </aside>
      <main className="app__main">
        {error && <div className="app__error">{error}</div>}
        {!selectedSessionId && <div className="tree-canvas__empty">Select a conversation to view its tree.</div>}
        {selectedSessionId && tree && (
          <TreeCanvas tree={tree} theme={theme} onCopyResumeCommand={handleCopyResumeCommand} key={selectedSessionId} />
        )}
      </main>
    </div>
  );
};
