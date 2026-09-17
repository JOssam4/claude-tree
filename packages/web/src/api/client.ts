/**
 * Typed fetch wrapper for the read-only REST endpoints exposed by
 * packages/server/src/api/server.ts. Same-origin in both dev (via Vite's
 * proxy, see vite.config.ts) and prod (server can serve the built assets),
 * so no base URL configuration needed.
 */
import type { BranchResponseDTO, NodeDetailDTO, ProjectSummaryDTO, ProjectTreeDTO } from "@claude-tree/shared";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function getProjects(): Promise<ProjectSummaryDTO[]> {
  return getJson<ProjectSummaryDTO[]>("/api/projects");
}

export function getProjectTree(slug: string): Promise<ProjectTreeDTO> {
  return getJson<ProjectTreeDTO>(`/api/projects/${encodeURIComponent(slug)}/tree`);
}

export function getNodeDetail(uuid: string): Promise<NodeDetailDTO> {
  return getJson<NodeDetailDTO>(`/api/nodes/${encodeURIComponent(uuid)}`);
}

/** Milestone 5: forks the node's history into a new, independently-resumable session (see server's sessionForker.ts). */
export async function branchFromNode(uuid: string): Promise<BranchResponseDTO> {
  const res = await fetch(`/api/nodes/${encodeURIComponent(uuid)}/branch`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`POST branch for ${uuid} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as BranchResponseDTO;
}
