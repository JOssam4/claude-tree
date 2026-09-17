import { describe, expect, it } from "vitest";
import { extractContentText, parseLine } from "./jsonlParser.js";

describe("parseLine", () => {
  it("classifies user/assistant/system/attachment lines as chain lines", () => {
    for (const type of ["user", "assistant", "system", "attachment"] as const) {
      const parsed = parseLine(
        JSON.stringify({ uuid: `u-${type}`, parentUuid: null, type, timestamp: "2026-01-01T00:00:00Z" }),
      );
      expect(parsed.kind).toBe("chain");
      if (parsed.kind === "chain") {
        expect(parsed.uuid).toBe(`u-${type}`);
        expect(parsed.type).toBe(type);
      }
    }
  });

  it("classifies known non-chain metadata lines (no uuid) as ignore", () => {
    for (const type of ["mode", "permission-mode", "file-history-snapshot", "cost-state", "queue-operation"]) {
      expect(parseLine(JSON.stringify({ type, someField: 1 }))).toEqual({ kind: "ignore" });
    }
  });

  it("classifies an unrecognized future line type as ignore rather than erroring", () => {
    // No uuid, and a `type` never seen on this machine — must degrade gracefully.
    expect(parseLine(JSON.stringify({ type: "some-future-type-2027", payload: {} }))).toEqual({ kind: "ignore" });
    // Even WITH a uuid, an unrecognized type is not chain-shaped for our purposes.
    expect(parseLine(JSON.stringify({ uuid: "x", type: "some-future-type-2027" }))).toEqual({ kind: "ignore" });
  });

  it("ignores blank/whitespace-only lines", () => {
    expect(parseLine("")).toEqual({ kind: "ignore" });
    expect(parseLine("   \t  ")).toEqual({ kind: "ignore" });
  });

  it("never throws on malformed JSON, returning an error record instead", () => {
    expect(() => parseLine("{not valid json")).not.toThrow();
    const parsed = parseLine("{not valid json");
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") expect(parsed.message).toMatch(/JSON parse failure/);
  });

  it("never throws on truncated JSON (mid-write file tail)", () => {
    const truncated = JSON.stringify({ uuid: "abc", parentUuid: null, type: "user", message: { content: "hi" } });
    const cut = truncated.slice(0, truncated.length - 10); // chop off the closing braces
    expect(() => parseLine(cut)).not.toThrow();
    expect(parseLine(cut).kind).toBe("error");
  });

  it("extracts ai-title lines distinctly from chain/ignore", () => {
    const parsed = parseLine(JSON.stringify({ type: "ai-title", aiTitle: "My Session Title" }));
    expect(parsed).toEqual({ kind: "title", aiTitle: "My Session Title" });
  });

  it("extracts toolUseResult.agentId when present on a chain line", () => {
    const parsed = parseLine(
      JSON.stringify({
        uuid: "n1",
        parentUuid: null,
        type: "user",
        toolUseResult: { agentId: "agent-xyz", otherField: 1 },
      }),
    );
    expect(parsed.kind).toBe("chain");
    if (parsed.kind === "chain") expect(parsed.toolUseResultAgentId).toBe("agent-xyz");
  });

  it("leaves toolUseResultAgentId null when toolUseResult has no agentId, or is absent", () => {
    const noAgentId = parseLine(
      JSON.stringify({ uuid: "n1", parentUuid: null, type: "user", toolUseResult: { other: 1 } }),
    );
    const absent = parseLine(JSON.stringify({ uuid: "n2", parentUuid: null, type: "user" }));
    expect(noAgentId.kind === "chain" && noAgentId.toolUseResultAgentId).toBeNull();
    expect(absent.kind === "chain" && absent.toolUseResultAgentId).toBeNull();
  });

  it("round-trips multi-byte UTF-8 content in contentText", () => {
    const text = "café☕日本語ümlaut";
    const parsed = parseLine(
      JSON.stringify({ uuid: "n1", parentUuid: null, type: "user", message: { role: "user", content: text } }),
    );
    expect(parsed.kind === "chain" && parsed.contentText).toBe(text);
  });
});

describe("extractContentText", () => {
  it("returns a plain string content as-is", () => {
    expect(extractContentText({ content: "hello" })).toBe("hello");
  });

  it("joins text blocks from an array content, ignoring non-text blocks", () => {
    const content = [
      { type: "text", text: "part one" },
      { type: "tool_use", id: "x" },
      { type: "text", text: "part two" },
    ];
    expect(extractContentText({ content })).toBe("part one\npart two");
  });

  it("returns null when there are no text blocks, or message/content is missing or malformed", () => {
    expect(extractContentText({ content: [{ type: "tool_use", id: "x" }] })).toBeNull();
    expect(extractContentText({ content: [] })).toBeNull();
    expect(extractContentText(null)).toBeNull();
    expect(extractContentText(undefined)).toBeNull();
    expect(extractContentText("not-an-object")).toBeNull();
    expect(extractContentText({})).toBeNull();
  });
});
