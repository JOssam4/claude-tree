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

  // Registered in its own encapsulated plugin context per @fastify/websocket convention.
  await app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket) => {
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => clients.delete(socket));
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
