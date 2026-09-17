import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copies text to the clipboard and exposes a short-lived `copied` flag so a
 * caller can flash a button's label (e.g. "Copied!") for `flashMs` before it
 * reverts — shared by TurnNode's and TerminalPanel's "copy resume command"
 * buttons (Milestone 8).
 */
export function useCopyToClipboard(flashMs = 1500): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => setCopied(false), flashMs);
        })
        .catch(() => {
          // Clipboard API can reject (e.g. no permission/insecure context) — no flash, silently no-op.
        });
    },
    [flashMs],
  );

  return { copied, copy };
}
