/**
 * Manages live `claude --resume <sessionId>` pty processes for the embedded
 * terminal panel (Milestone 5), one per (WS client socket, sessionId) pair so
 * multiple branch/resume terminals can be open concurrently, including
 * several against the same client.
 *
 * Read-only against ~/.claude in spirit — this module never touches session
 * *files* directly, it only shells out to the real `claude` CLI, which reads
 * (and, as the user types, appends to) them itself exactly as it would from a
 * normal terminal.
 */
import * as pty from "node-pty";
import type WebSocket from "ws";
import type { WsClientMessage, WsServerMessage } from "@claude-tree/shared";
import type { DB } from "../db/client.js";

export type PtyLogFn = (message: string) => void;

export interface PtyManager {
  /** Routes one parsed client->server WS message; no-ops on anything that isn't a recognized terminal:* type. */
  handleClientMessage(socket: WebSocket, message: unknown): void;
  /** Kills and forgets every pty this socket owns — call on WS 'close'/'error'. */
  handleSocketClosed(socket: WebSocket): void;
}

function getSessionProjectCwd(db: DB, sessionId: string): string | null {
  const row = db
    .prepare(`SELECT p.cwd as cwd FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?`)
    .get(sessionId) as { cwd: string } | undefined;
  return row?.cwd ?? null;
}

export function createPtyManager(db: DB, log: PtyLogFn = console.log): PtyManager {
  // Per-socket map of sessionId -> live pty, so ptys are cleanly scoped to the
  // client that opened them and never leak across reconnects.
  const ptysBySocket = new Map<WebSocket, Map<string, pty.IPty>>();

  function send(socket: WebSocket, message: WsServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  function openTerminal(socket: WebSocket, sessionId: string, cols: number, rows: number): void {
    const cwd = getSessionProjectCwd(db, sessionId);
    if (!cwd) {
      log(`[pty] cannot open terminal for unknown session ${sessionId}`);
      send(socket, { type: "terminal:data", sessionId, data: `\r\n[error] unknown session ${sessionId}\r\n` });
      return;
    }

    let sockets = ptysBySocket.get(socket);
    if (!sockets) {
      sockets = new Map();
      ptysBySocket.set(socket, sockets);
    }
    const existing = sockets.get(sessionId);
    if (existing) {
      try {
        existing.kill();
      } catch {
        // Already dead — fine, we're about to replace it.
      }
    }

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn("claude", ["--resume", sessionId], {
        name: "xterm-color",
        cols: cols > 0 ? cols : 80,
        rows: rows > 0 ? rows : 24,
        // CRITICAL: must be the ORIGINAL project's cwd, not this server process's
        // own cwd or anything else. Verified in the Milestone-0 spike: `claude
        // --resume` launched from the wrong cwd doesn't error — it silently
        // starts a blank session, which would look like a truncation bug but
        // actually be a cwd bug. Looked up fresh per-open (not cached) so it
        // stays correct even if the project's cwd is ever corrected later.
        cwd,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      // Milestone 6: node-pty can throw synchronously here (observed for a
      // missing `claude` binary — ENOENT propagates out of spawn() rather
      // than only showing up later via onExit). Without this, the panel just
      // sits blank forever with no indication anything went wrong. Surface it
      // the same way a normal pty exit is surfaced (a terminal:data message),
      // so the frontend needs no separate error-message plumbing.
      const reason = (err as Error).message ?? String(err);
      log(`[pty] failed to spawn claude for session ${sessionId}: ${reason}`);
      send(socket, {
        type: "terminal:data",
        sessionId,
        data: `\r\n[error] failed to start claude (is it on PATH?): ${reason}\r\n`,
      });
      return;
    }
    sockets.set(sessionId, ptyProcess);

    ptyProcess.onData((data) => send(socket, { type: "terminal:data", sessionId, data }));
    ptyProcess.onExit(({ exitCode, signal }) => {
      send(socket, {
        type: "terminal:data",
        sessionId,
        data: `\r\n[process exited, code=${exitCode}${signal ? ` signal=${signal}` : ""}]\r\n`,
      });
      ptysBySocket.get(socket)?.delete(sessionId);
    });
  }

  function closeTerminal(socket: WebSocket, sessionId: string): void {
    const sockets = ptysBySocket.get(socket);
    const p = sockets?.get(sessionId);
    if (!p) return;
    try {
      p.kill();
    } catch {
      // Already exited — fine.
    }
    sockets?.delete(sessionId);
  }

  return {
    handleClientMessage(socket, rawMessage) {
      if (rawMessage == null || typeof rawMessage !== "object") return;
      const message = rawMessage as Record<string, unknown>;
      const type = message.type;
      switch (type) {
        case "terminal:open": {
          const m = message as unknown as Extract<WsClientMessage, { type: "terminal:open" }>;
          if (typeof m.sessionId === "string") openTerminal(socket, m.sessionId, Number(m.cols), Number(m.rows));
          break;
        }
        case "terminal:input": {
          const m = message as unknown as Extract<WsClientMessage, { type: "terminal:input" }>;
          const p = ptysBySocket.get(socket)?.get(m.sessionId);
          if (p && typeof m.data === "string") p.write(m.data);
          break;
        }
        case "terminal:resize": {
          const m = message as unknown as Extract<WsClientMessage, { type: "terminal:resize" }>;
          const p = ptysBySocket.get(socket)?.get(m.sessionId);
          if (p && m.cols > 0 && m.rows > 0) p.resize(m.cols, m.rows);
          break;
        }
        case "terminal:close": {
          const m = message as unknown as Extract<WsClientMessage, { type: "terminal:close" }>;
          if (typeof m.sessionId === "string") closeTerminal(socket, m.sessionId);
          break;
        }
        default:
          break; // Not a terminal:* message — nothing else is expected from the client today.
      }
    },
    handleSocketClosed(socket) {
      const sockets = ptysBySocket.get(socket);
      if (!sockets) return;
      for (const p of sockets.values()) {
        try {
          p.kill();
        } catch {
          // Already exited — fine.
        }
      }
      ptysBySocket.delete(socket);
    },
  };
}
