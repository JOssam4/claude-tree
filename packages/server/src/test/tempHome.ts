/**
 * Test-only helpers for pointing the app at a hermetic, throwaway fixture
 * "claude home" instead of the real ~/.claude. NEVER imported by production
 * code — only by *.test.ts files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REAL_CLAUDE_HOME = path.join(os.homedir(), ".claude");

/**
 * Fails loudly rather than silently touching real user data. Every helper
 * below calls this before creating/tearing down a fixture directory, so a
 * future bug (e.g. a bad path.join, or CLAUDE_TREE_HOME_OVERRIDE left unset)
 * that resolves back to the real ~/.claude aborts the test run instead of
 * reading or writing real conversation history.
 */
export function assertNotRealClaudeHome(candidate: string): void {
  const resolved = path.resolve(candidate);
  if (resolved === REAL_CLAUDE_HOME || resolved.startsWith(REAL_CLAUDE_HOME + path.sep)) {
    throw new Error(`Refusing to touch real CLAUDE_HOME-derived path in a test: ${resolved}`);
  }
}

export interface FixtureClaudeHome {
  homeDir: string;
  projectsDir: string;
  cleanup: () => void;
}

/**
 * Creates a fresh mkdtemp'd fixture "claude home" (with an empty projects/
 * dir, mirroring ~/.claude/projects) for one test. Caller must call the
 * returned cleanup() (e.g. in afterEach/afterAll) so no temp dirs are left
 * behind after a test run.
 */
export function createFixtureClaudeHome(): FixtureClaudeHome {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tree-test-home-"));
  assertNotRealClaudeHome(homeDir);
  const projectsDir = path.join(homeDir, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
  return {
    homeDir,
    projectsDir,
    cleanup: () => {
      assertNotRealClaudeHome(homeDir); // re-assert immediately before the recursive rm, belt-and-braces
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}
