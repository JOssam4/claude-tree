import type { ProjectSummaryDTO } from '@claude-tree/shared';

interface ProjectListProps {
  projects: ProjectSummaryDTO[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}

/** Sidebar listing every indexed project; click one to load its tree. */
export function ProjectList({ projects, selectedSlug, onSelect }: ProjectListProps) {
  return (
    <div className="project-list">
      <h2>Projects</h2>
      {projects.length === 0 && <p className="project-list__empty">No projects indexed yet.</p>}
      <ul>
        {projects.map((p) => (
          <li key={p.slug}>
            <button
              className={p.slug === selectedSlug ? "project-list__item project-list__item--active" : "project-list__item"}
              onClick={() => onSelect(p.slug)}
            >
              <div className="project-list__cwd">{p.cwd}</div>
              <div className="project-list__meta">
                {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'} &middot; {p.rootSessionCount} root
                {p.rootSessionCount === 1 ? '' : 's'}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
