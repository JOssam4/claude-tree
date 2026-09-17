import { useCallback, useEffect, useState } from "react";
import type { ProjectSummaryDTO, ProjectTreeDTO } from "@claude-tree/shared";
import { getProjects, getProjectTree } from "./api/client";
import { useTreeUpdates } from "./api/useTreeUpdates";
import { ProjectList } from "./components/ProjectList";
import { TreeCanvas } from "./components/TreeCanvas";

export function App() {
  const [projects, setProjects] = useState<ProjectSummaryDTO[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [tree, setTree] = useState<ProjectTreeDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="app">
      <aside className="app__sidebar">
        <ProjectList projects={projects} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />
      </aside>
      <main className="app__main">
        {error && <div className="app__error">{error}</div>}
        {!selectedSlug && <div className="tree-canvas__empty">Select a project to view its conversation tree.</div>}
        {selectedSlug && tree && <TreeCanvas tree={tree} key={selectedSlug} />}
      </main>
    </div>
  );
}
