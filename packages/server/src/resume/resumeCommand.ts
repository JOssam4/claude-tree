/**
 * Milestone 8: builds the copy-pasteable shell command equivalent of what
 * ptyManager.ts spawns in-process, so a user can continue a branched session
 * in their own terminal instead of (or after) the embedded one. Pure/no I/O,
 * deliberately factored out of server.ts so it's independently unit-testable.
 */

/**
 * POSIX single-quote escaping: wraps `value` in single quotes, and any
 * embedded single quote is closed out, literal-quoted via a backslash outside
 * the quotes, then reopened (`'\''`) — the standard shell idiom for safely
 * quoting a string that may itself contain single quotes.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `cd '<cwd>' && claude --resume <sessionId>`, with `cwd` shell-escaped since project paths could contain spaces/special chars. */
export function buildResumeCommand(cwd: string, sessionId: string): string {
  return `cd ${shellQuoteSingle(cwd)} && claude --resume ${sessionId}`;
}
