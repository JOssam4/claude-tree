import { useCallback, useEffect, useState } from "react";
import type { ProjectSummaryDTO, ProjectTreeDTO } from "@claude-tree/shared";
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
  // Milestone 5: the currently-open branch terminal, if any. Serves both "resume
  // from here" and "start a new conversation from here" — same mechanism, just
  // triggered from a node's branch button, per the plan.
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);

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

  const handleBranch = useCallback((targetNodeUuid: string) => {
    branchFromNode(targetNodeUuid)
      .then(({ newSessionId }) => {
        setTerminalSessionId(newSessionId);
        setError(null);
        // The new session shows up in the tree on its own once the watcher
        // indexes the freshly-written file and broadcasts tree:update — no
        // explicit refetch needed here.
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="app">
      <aside className="app__sidebar">
        <ProjectList projects={projects} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />
      </aside>
      <main className="app__main">
        {error && <div className="app__error">{error}</div>}
        {!selectedSlug && <div className="tree-canvas__empty">Select a project to view its conversation tree.</div>}
        {selectedSlug && tree && <TreeCanvas tree={tree} onBranch={handleBranch} key={selectedSlug} />}
      </main>
      {terminalSessionId && (
        <TerminalPanel sessionId={terminalSessionId} onClose={() => setTerminalSessionId(null)} />
      )}
    </div>
  );
}
