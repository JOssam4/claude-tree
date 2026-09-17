/**
 * Connects to the backend's `WS /ws` and surfaces `tree:update` events to
 * React. Milestone 4 scope: correctness over cleverness — callers just get
 * notified an event happened and are expected to refetch, not patch in place.
 */
import { useEffect, useRef, useState } from "react";
import type { TreeUpdateWsMessage, WsServerMessage } from "@claude-tree/shared";

const RECONNECT_DELAY_MS = 2000;

export function useTreeUpdates(onUpdate: (event: TreeUpdateWsMessage) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  // Ref so the effect's socket setup doesn't need to re-run when the caller passes a new closure.
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByCleanup = false;

    function connect() {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${proto}//${window.location.host}/ws`);

      socket.addEventListener("open", () => setConnected(true));
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!closedByCleanup) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
      socket.addEventListener("error", () => socket?.close());
      socket.addEventListener("message", (ev) => {
        try {
          const message = JSON.parse(ev.data) as WsServerMessage;
          if (message.type === "tree:update") onUpdateRef.current(message);
        } catch {
          // Ignore malformed frames rather than crashing the socket handler.
        }
      });
    }
    connect();

    return () => {
      closedByCleanup = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return { connected };
}
