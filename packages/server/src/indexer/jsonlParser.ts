/**
 * Parses individual lines of a Claude Code session .jsonl file into typed
 * records, splitting "chain" lines (which build the conversation tree) from
 * "metadata" lines (which don't).
 *
 * Verified on this machine (see plan doc): chain-participating line types
 * are `user`, `assistant`, `system`, `attachment` — each carries `uuid` +
 * `parentUuid` (null = root of that file's chain) and file order == append
 * order == topological order, so a single forward streaming pass suffices.
 */

// Line `type`s known to participate in the parent/child chain.
const CHAIN_TYPES = new Set(["user", "assistant", "system", "attachment"]);

/**
 * Line `type`s observed on this machine that carry no uuid/parentUuid and
 * are irrelevant to tree structure (session-level mode flags, snapshots,
 * titles, cost bookkeeping, etc). This list is NOT treated as exhaustive:
 * a future Claude Code version can add new metadata types at any time, so
 * anything with no `uuid` field is skipped as metadata regardless of
 * whether its `type` appears here — this set exists for the `ai-title`
 * special case below and for documentation, not for validation.
 */
const KNOWN_METADATA_TYPES = new Set([
  "mode",
  "permission-mode",
  "atis-latch",
  "file-history-snapshot",
  "file-history-delta", // observed on this machine; not called out in the original spec
  "last-prompt",
  "ai-title",
  "cost-state",
  "queue-operation",
]);

export interface ChainLineRecord {
  kind: "chain";
  uuid: string;
  parentUuid: string | null;
  type: string;
  role: string | null;
  contentText: string | null;
  timestamp: string;
  sessionId: string | null;
  isSidechain: boolean;
  /**
   * Present only on lines inside a subagents/agent-<agentId>.jsonl sidechain
   * file — the id of the subagent that produced this line.
   */
  agentId: string | null;
  /**
   * UNDOCUMENTED, version-fragile: when this chain line's `toolUseResult`
   * carries an `agentId`, it marks the invocation point in the main chain
   * that a sidechain file (subagents/agent-<agentId>.jsonl) should be
   * joined to. This is the only known join key — there is no direct field
   * on the tool_use block itself. May break in a future Claude Code version.
   */
  toolUseResultAgentId: string | null;
  /** The working directory Claude Code was run from when this line was written, when present. Used to populate `projects.cwd` from real data. */
  cwd: string | null;
  raw: string;
}

export interface TitleLineRecord {
  kind: "title";
  aiTitle: string;
}

export interface IgnoredLineRecord {
  kind: "ignore";
}

export interface ErrorLineRecord {
  kind: "error";
  message: string;
}

export type ParsedLine = ChainLineRecord | TitleLineRecord | IgnoredLineRecord | ErrorLineRecord;

/** Extracts a flat text summary from a Claude Code `message.content` field, which is either a plain string or an array of content blocks. */
export function extractContentText(message: unknown): string | null {
  if (message == null || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((block): block is { type: string; text: string } => {
        return (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        );
      })
      .map((block) => block.text);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

/**
 * Parses one raw JSONL line. Never throws — JSON parse failures and unknown
 * shapes come back as `{ kind: "error" | "ignore" }` so a single malformed
 * or future-format line can never abort an entire backfill/tail pass.
 */
export function parseLine(rawLine: string): ParsedLine {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) return { kind: "ignore" };

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    return { kind: "error", message: `JSON parse failure: ${(err as Error).message}` };
  }

  const type = typeof data.type === "string" ? data.type : undefined;

  // `ai-title` lines carry the human-readable session title but aren't part of the chain.
  if (type === "ai-title" && typeof data.aiTitle === "string") {
    return { kind: "title", aiTitle: data.aiTitle };
  }

  const hasChainShape = typeof data.uuid === "string";
  if (!hasChainShape || !type || !CHAIN_TYPES.has(type)) {
    // Either a recognized metadata type, or an unrecognized future type we've
    // never seen — both are safe to ignore for tree-building purposes.
    return { kind: "ignore" };
  }

  const toolUseResult = data.toolUseResult;
  const toolUseResultAgentId =
    toolUseResult != null &&
    typeof toolUseResult === "object" &&
    typeof (toolUseResult as { agentId?: unknown }).agentId === "string"
      ? (toolUseResult as { agentId: string }).agentId
      : null;

  const message = data.message;
  const role =
    message != null && typeof message === "object" && typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : null;

  return {
    kind: "chain",
    uuid: data.uuid as string,
    parentUuid: typeof data.parentUuid === "string" ? data.parentUuid : null,
    type,
    role,
    contentText: extractContentText(message),
    timestamp: typeof data.timestamp === "string" ? data.timestamp : "",
    sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
    isSidechain: data.isSidechain === true,
    agentId: typeof data.agentId === "string" ? data.agentId : null,
    toolUseResultAgentId,
    cwd: typeof data.cwd === "string" ? data.cwd : null,
    raw: trimmed,
  };
}
