import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copies text to the clipboard and exposes short-lived `copied`/`failed`
 * flags so a caller can flash a button's label (e.g. "Copied!"/"Copy
 * failed") for `flashMs` before it reverts — shared by TurnNode's and
 * TerminalPanel's "copy resume command" buttons (Milestone 8).
 */
export function useCopyToClipboard(
  flashMs = 1500,
): { copied: boolean; failed: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const flash = useCallback(
    (ok: boolean) => {
      setCopied(ok);
      setFailed(!ok);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setCopied(false);
        setFailed(false);
      }, flashMs);
    },
    [flashMs],
  );

  const copy = useCallback(
    (text: string) => {
      // navigator.clipboard.writeText only works in a secure context
      // (https, or exactly `localhost`) and can reject if the document
      // briefly isn't focused — both bite in practice (e.g. opening this
      // app via a LAN/WSL IP instead of localhost). `navigator.clipboard`
      // can also be undefined outright there, so don't even assume the
      // property exists. Previously a failure here was swallowed
      // completely — no flash, no error, the button just did nothing.
      // Fall back to the legacy execCommand path, and always flash
      // success/failure either way.
      const legacyFallback = () => {
        try {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.position = "fixed";
          textarea.style.top = "-1000px";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(textarea);
          flash(ok);
        } catch {
          flash(false);
        }
      };

      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(() => flash(true))
          .catch(legacyFallback);
      } else {
        legacyFallback();
      }
    },
    [flash],
  );

  return { copied, failed, copy };
}
