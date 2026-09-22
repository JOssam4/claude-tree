/**
 * Typed fetch wrapper for the read-only REST endpoints exposed by
 * packages/server/src/api/server.ts. Same-origin in both dev (via Vite's
 * proxy, see vite.config.ts) and prod (server can serve the built assets),
 * so no base URL configuration needed.
 */
import type { BranchResponseDTO, ConversationSummaryDTO, NodeDetailDTO, ProjectTreeDTO } from "@claude-tree/shared";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Sidebar's conversation list: one entry per root session across every project. */
export function getConversations(): Promise<ConversationSummaryDTO[]> {
  return getJson<ConversationSummaryDTO[]>("/api/conversations");
}

/** A single conversation's tree, wrapped in the same ProjectTreeDTO forest shape as the server's project-tree route, but with exactly one root. */
export function getSessionTree(sessionId: string): Promise<ProjectTreeDTO> {
  return getJson<ProjectTreeDTO>(`/api/sessions/${encodeURIComponent(sessionId)}/tree`);
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

/** Shows/hides a conversation in the sidebar — a display preference only, never deletes anything. */
export async function setConversationHidden(sessionId: string, hidden: boolean): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(sessionId)}/hidden`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hidden }),
  });
  if (!res.ok) {
    throw new Error(`PATCH hidden for ${sessionId} failed: ${res.status} ${res.statusText}`);
  }
}
