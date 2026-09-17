import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalDataWsMessage, WsClientMessage } from "@claude-tree/shared";

interface TerminalPanelProps {
  sessionId: string;
  onClose: () => void;
}

/**
 * Milestone 5: a live, real Claude Code terminal (`claude --resume <sessionId>`)
 * running server-side via node-pty, streamed to this xterm instance over its
 * own dedicated WS connection to the shared `/ws` endpoint (differentiated
 * from tree:update broadcasts by each message's `type` field — see
 * packages/server/src/api/server.ts).
 */
export function TerminalPanel({ sessionId, onClose }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 13, convertEol: true });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    if (containerRef.current) term.open(containerRef.current);
    fitAddon.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${window.location.host}/ws`);

    function send(message: WsClientMessage): void {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    socket.addEventListener("open", () => {
      send({ type: "terminal:open", sessionId, cols: term.cols, rows: term.rows });
    });
    socket.addEventListener("message", (ev) => {
      try {
        const message = JSON.parse(ev.data as string) as TerminalDataWsMessage & { type: string };
        if (message.type === "terminal:data" && message.sessionId === sessionId) term.write(message.data);
      } catch {
        // Ignore malformed frames rather than crashing the panel.
      }
    });

    const dataSub = term.onData((data) => send({ type: "terminal:input", sessionId, data }));

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      send({ type: "terminal:resize", sessionId, cols: term.cols, rows: term.rows });
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataSub.dispose();
      send({ type: "terminal:close", sessionId });
      socket.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__header">
        <span className="terminal-panel__title">Branch terminal — session {sessionId}</span>
        <button className="terminal-panel__close" onClick={onClose} title="Close terminal">
          ✕
        </button>
      </div>
      <div className="terminal-panel__body" ref={containerRef} />
    </div>
  );
}
