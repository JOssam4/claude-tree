import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNewCompleteLines } from "./tailReader.js";

// Plain scratch temp files, not under any "claude home" concept — tailReader
// operates on an arbitrary file path handed to it, so no config/override
// machinery is needed here, just an isolated tmp file per test.
describe("readNewCompleteLines", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tree-test-tail-"));
    filePath = path.join(dir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never counts or returns an incomplete trailing line (no trailing \\n yet)", () => {
    fs.writeFileSync(filePath, "line-one\nline-two-partial-no-newline");
    const result = readNewCompleteLines(filePath, 0);
    expect(result.lines).toEqual(["line-one"]);
    expect(result.bytesConsumed).toBe(Buffer.byteLength("line-one\n"));
  });

  it("returns [] with bytesConsumed 0 when there is no complete line at all yet", () => {
    fs.writeFileSync(filePath, "still-being-written-no-newline");
    const result = readNewCompleteLines(filePath, 0);
    expect(result.lines).toEqual([]);
    expect(result.bytesConsumed).toBe(0);
  });

  it("computes exact byte offsets, including with multi-byte UTF-8 content", () => {
    const line1 = "café☕日本語ümlaut";
    const line2 = "plain-ascii";
    fs.writeFileSync(filePath, `${line1}\n${line2}\n`);
    const result = readNewCompleteLines(filePath, 0);
    expect(result.lines).toEqual([line1, line2]);
    expect(result.bytesConsumed).toBe(Buffer.byteLength(`${line1}\n${line2}\n`, "utf-8"));
  });

  it("reading from a nonzero offset returns only bytes after it", () => {
    const line1 = "banana\n";
    const line2 = "pineapple\n";
    fs.writeFileSync(filePath, line1 + line2);
    const firstOffset = Buffer.byteLength(line1, "utf-8");
    const result = readNewCompleteLines(filePath, firstOffset);
    expect(result.lines).toEqual(["pineapple"]);
    expect(result.bytesConsumed).toBe(Buffer.byteLength(line2, "utf-8"));
  });

  it("a second read from the previously-consumed offset picks up newly appended lines only", () => {
    fs.writeFileSync(filePath, "one\ntwo\n");
    const first = readNewCompleteLines(filePath, 0);
    expect(first.lines).toEqual(["one", "two"]);

    fs.appendFileSync(filePath, "three\n");
    const second = readNewCompleteLines(filePath, first.bytesConsumed);
    expect(second.lines).toEqual(["three"]);
  });

  it("strips a trailing \\r (CRLF line endings)", () => {
    fs.writeFileSync(filePath, "one\r\ntwo\r\n");
    const result = readNewCompleteLines(filePath, 0);
    expect(result.lines).toEqual(["one", "two"]);
  });

  it("returns [] with bytesConsumed 0 for a nonexistent file, without throwing", () => {
    expect(() => readNewCompleteLines(path.join(dir, "does-not-exist.jsonl"), 0)).not.toThrow();
    const result = readNewCompleteLines(path.join(dir, "does-not-exist.jsonl"), 0);
    expect(result).toEqual({ lines: [], bytesConsumed: 0 });
  });

  it("returns [] with bytesConsumed 0 when fromOffset is at or past the current file size", () => {
    fs.writeFileSync(filePath, "one\n");
    const size = fs.statSync(filePath).size;
    expect(readNewCompleteLines(filePath, size)).toEqual({ lines: [], bytesConsumed: 0 });
    expect(readNewCompleteLines(filePath, size + 100)).toEqual({ lines: [], bytesConsumed: 0 });
  });
});
