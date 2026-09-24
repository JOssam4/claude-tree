/**
 * Electron main process. A thin shell around the existing Fastify server:
 * starts it in-process, points a BrowserWindow at its http://127.0.0.1
 * origin, and shuts the server down (ending any open terminal sessions) on quit.
 */
import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import fixPath from "fix-path";
import { startClaudeTreeServer, type ServerHandles } from "@claude-tree/server";

// Must match config.ts's own HTTP_PORT default — duplicated here rather than
// imported since this package only depends on @claude-tree/server's "main"
// entry (server.ts), which doesn't re-export config.
const DEFAULT_PORT = 4317;

let win: BrowserWindow | null = null;
let handles: ServerHandles | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });

  app.whenReady().then(async () => {
    // GUI-launched apps (Finder/Dock/.desktop) don't source shell rc files,
    // so `claude` may not be on PATH otherwise. No-op on Windows, which
    // doesn't have this gap.
    fixPath();

    handles = await startClaudeTreeServer({
      dbPath: path.join(app.getPath("userData"), "tree.db"),
      // Packaged builds copy web/dist here via electron-builder's extraResources;
      // in dev, the server's own monorepo-relative default is correct.
      webDistDir: app.isPackaged ? path.join(process.resourcesPath, "web-dist") : undefined,
    });
    const port = Number(process.env.CLAUDE_TREE_PORT ?? DEFAULT_PORT);

    win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadURL(`http://127.0.0.1:${port}`);
    win.show();
    win.on("closed", () => {
      win = null;
      app.quit();
    });
  }).catch((err: unknown) => {
    // Without this a startup failure (e.g. port in use) leaves an invisible,
    // windowless process running with no indication anything went wrong.
    dialog.showErrorBox("Claude Tree failed to start", err instanceof Error ? err.stack ?? err.message : String(err));
    app.exit(1);
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      await handles?.close();
      app.quit();
    })();
  });
}
