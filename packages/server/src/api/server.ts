/**
 * HTTP + WebSocket API (Milestone 3). Strictly read-only against this app's
 * own SQLite DB (`db`) — never touches ~/.claude itself; that's the
 * indexer/watcher's job (backfill.ts, watcher.ts), not this module's.
 *
 * Local single-user tool, per the plan: binds to 127.0.0.1 only, no auth.
 */
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type { TreeUpdateEvent, WsServerMessage } from "@claude-tree/shared";
import type { DB } from "../db/client.js";
import { createPtyManager } from "../resume/ptyManager.js";
import { buildResumeCommand } from "../resume/resumeCommand.js";
import { forkSessionFromNode } from "../resume/sessionForker.js";
import { getNodeDetail } from "./nodeDetail.js";
import { listProjectSummaries } from "./projectQueries.js";
import { buildProjectTree } from "./treeBuilder.js";

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export interface ApiServer {
  app: FastifyInstance;
  /** Broadcasts a tree:update message to every currently-connected WS client (no per-client filtering yet — see plan's Milestone 3 notes). */
  broadcastTreeUpdate(event: TreeUpdateEvent): void;
  listen(port: number): Promise<void>;
  close(): Promise<void>;
}

export async function createApiServer(db: DB): Promise<ApiServer> {
  const app = Fastify({ logger: true });
  await app.register(fastifyWebsocket);

  const clients = new Set<WebSocket>();

  app.get("/api/projects", async () => listProjectSummaries(db));

  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/tree",
    {
      schema: {
        params: {
          type: "object",
          properties: { slug: { type: "string", minLength: 1 } },
          required: ["slug"],
        },
      },
    },
    async (request, reply) => {
      const tree = buildProjectTree(db, request.params.slug, (msg) => app.log.warn(msg));
      if (!tree) {
        reply.code(404);
        return { error: `project not found: ${request.params.slug}` };
      }
      return tree;
    },
  );

  app.get<{ Params: { uuid: string } }>(
    "/api/nodes/:uuid",
    {
      schema: {
        params: {
          type: "object",
          properties: { uuid: { type: "string", pattern: UUID_PATTERN } },
          required: ["uuid"],
        },
      },
    },
    async (request, reply) => {
      const detail = getNodeDetail(db, request.params.uuid, (msg) => app.log.warn(msg));
      if (!detail) {
        reply.code(404);
        return { error: `node not found: ${request.params.uuid}` };
      }
      return detail;
    },
  );

  // Milestone 5: forks the node's history into a brand-new session file (see
  // resume/sessionForker.ts) and returns its id. Serves both "resume from
  // here" and "start a new conversation from here" — same mechanism, per the plan.
  app.post<{ Params: { uuid: string } }>(
    "/api/nodes/:uuid/branch",
    {
      schema: {
        params: {
          type: "object",
          properties: { uuid: { type: "string", pattern: UUID_PATTERN } },
          required: ["uuid"],
        },
      },
    },
    async (request, reply) => {
      let result;
      try {
        result = await forkSessionFromNode(db, request.params.uuid);
      } catch (err) {
        app.log.error(err);
        reply.code(500);
        return { error: `failed to fork session: ${(err as Error).message}` };
      }
      if (!result) {
        reply.code(404);
        return { error: `node not found: ${request.params.uuid}` };
      }
      // Milestone 8: hand back the copy-pasteable equivalent of what
      // ptyManager.ts spawns, so the frontend can offer it as an alternative
      // to the embedded terminal without a second branch call.
      return {
        newSessionId: result.newSessionId,
        cwd: result.cwd,
        resumeCommand: buildResumeCommand(result.cwd, result.newSessionId),
      };
    },
  );

  const ptyManager = createPtyManager(db, (msg) => app.log.info(msg));

  // Registered in its own encapsulated plugin context per @fastify/websocket convention.
  // Shares this one endpoint between the tree:update broadcast (above) and
  // Milestone 5's terminal:* messages, differentiated by each message's `type`
  // field, per the plan's WS message shapes.
  await app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket) => {
      clients.add(socket);
      socket.on("message", (raw: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return; // Malformed frame — ignore rather than crash the connection.
        }
        try {
          ptyManager.handleClientMessage(socket, parsed);
        } catch (err) {
          // Belt-and-braces: ptyManager's own spawn path already catches and
          // surfaces failures as a terminal:data message, but a WS message
          // handler throwing uncaught would otherwise crash this whole
          // long-lived server process for every open terminal — never worth
          // that blast radius for a local dev tool's one connection.
          app.log.error(err);
        }
      });
      socket.on("close", () => {
        clients.delete(socket);
        ptyManager.handleSocketClosed(socket);
      });
      socket.on("error", () => {
        clients.delete(socket);
        ptyManager.handleSocketClosed(socket);
      });
    });
  });

  function broadcastTreeUpdate(event: TreeUpdateEvent): void {
    const message: WsServerMessage = { type: "tree:update", ...event };
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  return {
    app,
    broadcastTreeUpdate,
    async listen(port: number) {
      await app.listen({ port, host: "127.0.0.1" });
    },
    async close() {
      for (const client of clients) client.close();
      await app.close();
    },
  };
}
