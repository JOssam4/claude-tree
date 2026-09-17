/**
 * Byte-precise reader for the watcher's incremental tailing path.
 *
 * STRICTLY READ-ONLY: only fs.openSync(path, "r") / fs.fstatSync / fs.readSync
 * / fs.closeSync are used here — never a write/truncate/rename call.
 */
import fs from "node:fs";

export interface TailReadResult {
  /** Complete lines found (trailing \r stripped, no \n), in file order. */
  lines: string[];
  /**
   * Exact number of bytes consumed by `lines` — always the byte offset of the
   * last '\n' found (inclusive) relative to `fromOffset`. The caller should
   * advance its stored offset by exactly this much, never more.
   */
  bytesConsumed: number;
}

/**
 * Reads raw bytes from `fromOffset` to the file's current end and returns
 * only the complete (newline-terminated) lines found.
 *
 * Claude Code may still be mid-write when a `change` event fires, so any
 * trailing bytes after the last '\n' are deliberately NOT returned or
 * counted as consumed — the caller must not advance its stored byte offset
 * past them. The next tail read simply starts again from that same
 * (unadvanced) offset and will pick up the now-completed line once the
 * writer finishes it, plus whatever else has been appended since.
 *
 * Cutting the buffer at a raw '\n' (0x0A) byte is always a safe UTF-8
 * character boundary: 0x0A cannot appear as a continuation byte in any
 * multi-byte UTF-8 sequence, so decoding each side of the cut independently
 * can never split a character.
 */
export function readNewCompleteLines(filePath: string, fromOffset: number): TailReadResult {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    // File vanished between the watcher event and this read — nothing new to report.
    return { lines: [], bytesConsumed: 0 };
  }

  try {
    const { size } = fs.fstatSync(fd);
    if (size <= fromOffset) return { lines: [], bytesConsumed: 0 };

    const length = size - fromOffset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, fromOffset);

    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      // No complete line yet in the new bytes at all — hold everything back.
      return { lines: [], bytesConsumed: 0 };
    }

    const complete = buf.subarray(0, lastNewline + 1);
    const text = complete.toString("utf-8");
    const rawLines = text.split("\n");
    rawLines.pop(); // trailing "" from the split on the final \n we just included
    const lines = rawLines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

    return { lines, bytesConsumed: lastNewline + 1 };
  } finally {
    fs.closeSync(fd);
  }
}
