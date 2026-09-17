import { describe, expect, it } from "vitest";
import { buildResumeCommand, shellQuoteSingle } from "./resumeCommand.js";

describe("shellQuoteSingle", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuoteSingle("/tmp/my-project")).toBe("'/tmp/my-project'");
  });

  it("escapes embedded single quotes with the close-literal-reopen idiom", () => {
    expect(shellQuoteSingle("/tmp/o'brien's project")).toBe("'/tmp/o'\\''brien'\\''s project'");
  });

  it("preserves spaces since the whole value stays inside one quoted string", () => {
    expect(shellQuoteSingle("/tmp/has spaces/dir")).toBe("'/tmp/has spaces/dir'");
  });
});

describe("buildResumeCommand", () => {
  it("builds a cd-then-resume command with the escaped cwd", () => {
    expect(buildResumeCommand("/tmp/proj", "abc-123")).toBe("cd '/tmp/proj' && claude --resume abc-123");
  });

  it("escapes a cwd containing a single quote", () => {
    expect(buildResumeCommand("/tmp/o'brien", "abc-123")).toBe("cd '/tmp/o'\\''brien' && claude --resume abc-123");
  });
});
