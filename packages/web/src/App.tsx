import { useCallback, useEffect, useRef, useState } from "react";
import type { BranchResponseDTO, ProjectSummaryDTO, ProjectTreeDTO } from "@claude-tree/shared";
import { branchFromNode, getProjects, getProjectTree } from "./api/client";
import { useTreeUpdates } from "./api/useTreeUpdates";
import { ProjectList } from "./components/ProjectList";
import { TerminalPanel } from "./components/TerminalPanel";
import { TreeCanvas } from "./components/TreeCanvas";

export function App() {
  const [projects, setProjects] = useState<ProjectSummaryDTO[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [tree, setTree] = useState<ProjectTreeDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Milestone 5: the currently-open branch terminal's branch result, if any (also
  // carries Milestone 8's resumeCommand for the panel's own "copy command" button).
  // Serves both "resume from here" and "start a new conversation from here" — same
  // mechanism, just triggered from a node's branch button, per the plan.
  const [terminalBranch, setTerminalBranch] = useState<BranchResponseDTO | null>(null);

  // Milestone 8: caches one branch result per source node uuid for this session's
  // lifetime, so clicking both "⑂ branch" and "⧉ copy resume command" for the same
  // node forks only ONE new session file, not two.
  const branchCacheRef = useRef(new Map<string, BranchResponseDTO>());

  const getOrCreateBranch = useCallback((targetNodeUuid: string): Promise<BranchResponseDTO> => {
    const cached = branchCacheRef.current.get(targetNodeUuid);
    if (cached) return Promise.resolve(cached);
    return branchFromNode(targetNodeUuid).then((result) => {
      branchCacheRef.current.set(targetNodeUuid, result);
      return result;
    });
  }, []);

  const refetchProjects = useCallback(() => {
    getProjects()
      .then((data) => {
        setProjects(data);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const refetchTree = useCallback((slug: string) => {
    getProjectTree(slug)
      .then((data) => {
        setTree(data);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => refetchProjects(), [refetchProjects]);
  useEffect(() => {
    if (selectedSlug) refetchTree(selectedSlug);
  }, [selectedSlug, refetchTree]);

  // Milestone 4 scope: any live update just triggers a refetch (of the project list, and
  // of the open tree if it's the affected project) rather than patching state in place.
  useTreeUpdates((event) => {
    refetchProjects();
    if (event.projectSlug === selectedSlug) refetchTree(event.projectSlug);
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
        <ProjectList projects={projects} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />
      </aside>
      <main className="app__main">
        {error && <div className="app__error">{error}</div>}
        {!selectedSlug && <div className="tree-canvas__empty">Select a project to view its conversation tree.</div>}
        {selectedSlug && tree && (
          <TreeCanvas tree={tree} onBranch={handleBranch} onCopyResumeCommand={handleCopyResumeCommand} key={selectedSlug} />
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
