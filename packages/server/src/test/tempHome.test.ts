import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNotRealClaudeHome, createFixtureClaudeHome } from "./tempHome.js";

// This guard is the load-bearing safety net for the whole test suite's "never
// touch the real ~/.claude" constraint — worth testing directly, not just
// trusting by inspection.
describe("assertNotRealClaudeHome", () => {
  it("throws for the real ~/.claude path and anything under it", () => {
    const real = path.join(os.homedir(), ".claude");
    expect(() => assertNotRealClaudeHome(real)).toThrow();
    expect(() => assertNotRealClaudeHome(path.join(real, "projects"))).toThrow();
    expect(() => assertNotRealClaudeHome(path.join(real, "projects", "some-project", "session.jsonl"))).toThrow();
  });

  it("does not throw for an unrelated temp directory", () => {
    expect(() => assertNotRealClaudeHome(os.tmpdir())).not.toThrow();
    expect(() => assertNotRealClaudeHome("/tmp/claude-tree-test-home-abc123")).not.toThrow();
  });
});

describe("createFixtureClaudeHome", () => {
  it("creates an mkdtemp'd dir with an empty projects/ subdirectory, and cleanup removes it", () => {
    const fixture = createFixtureClaudeHome();
    try {
      expect(fixture.homeDir).toContain(os.tmpdir());
      expect(fixture.projectsDir).toBe(path.join(fixture.homeDir, "projects"));
      expect(() => assertNotRealClaudeHome(fixture.homeDir)).not.toThrow();
    } finally {
      fixture.cleanup();
    }
    // After cleanup, nothing should remain on disk at homeDir.
    expect(() => fs.statSync(fixture.homeDir)).toThrow();
  });
});
