import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalDataWsMessage, WsClientMessage } from '@claude-tree/shared';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';

interface TerminalPanelProps {
  sessionId: string;
  /** Milestone 8: the same branch call's resumeCommand, so someone who opened this embedded terminal can still switch to their own. */
  resumeCommand: string;
  onClose: () => void;
}

/**
 * Milestone 5: a live, real Claude Code terminal (`claude --resume <sessionId>`)
 * running server-side via node-pty, streamed to this xterm instance over its
 * own dedicated WS connection to the shared `/ws` endpoint (differentiated
 * from tree:update broadcasts by each message's `type` field — see
 * packages/server/src/api/server.ts).
 */
export function TerminalPanel({ sessionId, resumeCommand, onClose }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { copied, failed, copy } = useCopyToClipboard();

  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 13, convertEol: true });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    if (containerRef.current) term.open(containerRef.current);
    fitAddon.fit();

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${window.location.host}/ws`);

    // Milestone 6: track whether this socket ever reached OPEN and whether
    // *we* (the cleanup below) initiated the close, so the 'close' handler
    // can tell a normal panel-close apart from the connection dying/never
    // coming up in the first place — the two cases a user could otherwise
    // read as "the terminal is just frozen" with no explanation.
    let didOpen = false;
    let intentionalClose = false;

    function send(message: WsClientMessage): void {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    socket.addEventListener('open', () => {
      didOpen = true;
      send({ type: 'terminal:open', sessionId, cols: term.cols, rows: term.rows });
    });
    socket.addEventListener('message', (ev) => {
      try {
        const message = JSON.parse(ev.data as string) as TerminalDataWsMessage & { type: string };
        if (message.type === 'terminal:data' && message.sessionId === sessionId) term.write(message.data);
      } catch {
        // Ignore malformed frames rather than crashing the panel.
      }
    });
    socket.addEventListener('error', () => {
      term.write('\r\n\x1b[31m[error] could not connect to the claude-tree server (is it running?)\x1b[0m\r\n');
    });
    socket.addEventListener("close", () => {
      if (intentionalClose) return;
      const reason = didOpen
        ? '\r\n\x1b[31m[error] connection to the claude-tree server was lost\x1b[0m\r\n'
        : '\r\n\x1b[31m[error] could not connect to the claude-tree server (is it running?)\x1b[0m\r\n';
      term.write(reason);
    });

    const dataSub = term.onData((data) => send({ type: 'terminal:input', sessionId, data }));

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      send({ type: 'terminal:resize', sessionId, cols: term.cols, rows: term.rows });
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataSub.dispose();
      intentionalClose = true;
      send({ type: 'terminal:close', sessionId });
      socket.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__header">
        <span className="terminal-panel__title">Branch terminal — session {sessionId}</span>
        <div className="terminal-panel__actions">
          <button
            className="terminal-panel__copy"
            onClick={() => copy(resumeCommand)}
            title="Copy a ready-to-run `claude --resume` command, to continue this branch in your own terminal instead"
          >
            {copied ? "Copied!" : failed ? "Copy failed" : "⧉ copy command"}
          </button>
          <button className="terminal-panel__close" onClick={onClose} title="Close terminal">
            ✕
          </button>
        </div>
      </div>
      <div className="terminal-panel__body" ref={containerRef} />
    </div>
  );
}
