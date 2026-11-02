/**
 * WebSocket host. Match rules live in match.ts. A closed socket leaves the match in memory.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { matchSetupFromBody } from "./decks.js";
import { loadDurableMatches, saveDurableMatch } from "./durable.js";
import { goldenNames, openGolden, stepGolden } from "./golden.js";
import {
  createMatch,
  findMatchByToken,
  PROTOCOL_VERSION,
  type ChatRoom,
  type ViewerRole,
} from "./match.js";
import type { Intent } from "netrunner-engine";
import { contentType, publicFile } from "./static.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const matchDir = process.env.MATCH_DIR ?? join(root, "data", "matches");
const port = Number(process.env.PORT ?? 8787);

loadDurableMatches(matchDir);

const clients = new Set<{
  socket: WebSocket;
  matchId: string;
  token: string;
  role: ViewerRole;
}>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcastSnapshot(matchId: string): void {
  for (const client of clients) {
    if (client.matchId !== matchId) continue;
    const found = findMatchByToken(client.token);
    if (!found) continue;
    const snapshot = found.match.snapshotForToken(client.token);
    send(client.socket, { type: "snapshot", ...snapshot });
  }
}

function broadcastChat(matchId: string, room: ChatRoom, line: unknown): void {
  for (const client of clients) {
    if (client.matchId !== matchId) continue;
    if (room === "spectator" && client.role !== "spectator") continue;
    const found = findMatchByToken(client.token);
    if (!found) continue;
    send(client.socket, { v: PROTOCOL_VERSION, type: "chat", line });
  }
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/matches") {
    const raw = await readBody(req);
    let parsed: unknown;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Bad JSON" }));
        return;
      }
    }
    const decision = matchSetupFromBody(parsed, randomBytes(4).readUInt32BE(0));
    if (!decision.ok) {
      res.writeHead(decision.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: decision.error,
          corp: decision.corp,
          runner: decision.runner,
        }),
      );
      return;
    }
    const opening = decision.opening;
    if (!opening) throw new Error("A stored match needs its opening");
    const match = createMatch({
      setup: decision.setup,
      onRecord: (current) => saveDurableMatch(matchDir, current, opening),
    });
    saveDurableMatch(matchDir, match, opening);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        matchId: match.id,
        seats: {
          corp: match.tokens.corp,
          runner: match.tokens.runner,
          spectator: match.tokens.spectator,
          log: match.tokens.log,
          debug: match.tokens.debug,
        },
      }),
    );
    console.log(`match created ${match.id}`);
    return;
  }

  if (req.method === "GET" && url.pathname === "/goldens") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ names: goldenNames() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/goldens") {
    const raw = await readBody(req);
    let name = "";
    try {
      const body = JSON.parse(raw) as { name?: unknown };
      if (typeof body.name === "string") name = body.name;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Bad JSON" }));
      return;
    }
    const opened = openGolden(name);
    if (!opened) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown golden" }));
      return;
    }
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify(opened));
    return;
  }

  const goldenStep = url.pathname.match(/^\/goldens\/([^/]+)$/);
  if (req.method === "POST" && goldenStep) {
    const raw = await readBody(req);
    let delta = 0;
    try {
      const body = JSON.parse(raw) as { delta?: unknown };
      if (typeof body.delta === "number") delta = body.delta;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Bad JSON" }));
      return;
    }
    const view = stepGolden(decodeURIComponent(goldenStep[1] ?? ""), delta);
    if (!view) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown golden session" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(view));
    return;
  }

  const rel = publicFile(url.pathname);
  if (rel.startsWith("..")) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const file = await readFile(join(publicDir, rel));
    const type = contentType(extname(rel));
    res.writeHead(200, { "content-type": type });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

const http = createServer((req, res) => {
  handleHttp(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "request failed";
    console.error(message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

const wss = new WebSocketServer({ server: http });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const token = url.searchParams.get("token") ?? "";
  const found = findMatchByToken(token);
  if (!found) {
    send(socket, { v: PROTOCOL_VERSION, type: "error", message: "Unknown seat" });
    socket.close();
    return;
  }
  const client = { socket, matchId: found.match.id, token, role: found.role };
  clients.add(client);
  console.log(`joined ${found.match.id} ${found.role}`);
  send(socket, {
    v: PROTOCOL_VERSION,
    type: "welcome",
    matchId: found.match.id,
    seat: found.role,
  });
  send(socket, {
    type: "snapshot",
    ...found.match.snapshotForToken(token),
  });

  socket.on("message", (raw) => {
    void onMessage(client, raw.toString()).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "request failed";
      send(socket, { v: PROTOCOL_VERSION, type: "error", message });
    });
  });

  socket.on("close", () => {
    clients.delete(client);
  });
});

async function onMessage(
  client: { socket: WebSocket; matchId: string; token: string; role: ViewerRole },
  raw: string,
): Promise<void> {
  const found = findMatchByToken(client.token);
  if (!found) throw new Error("Unknown seat");
  let message: { type?: string; intentId?: string; intent?: Intent; room?: ChatRoom; text?: string; seq?: number };
  try {
    message = JSON.parse(raw) as typeof message;
  } catch {
    throw new Error("Bad message");
  }
  if (message.type === "intent") {
    if (!message.intentId || !message.intent) throw new Error("Missing intent");
    await found.match.submit(client.token, message.intentId, message.intent);
    broadcastSnapshot(found.match.id);
    return;
  }
  if (message.type === "concede") {
    await found.match.concede(client.token);
    broadcastSnapshot(found.match.id);
    return;
  }
  if (message.type === "seek") {
    if (message.seq == null) throw new Error("Missing log position");
    await found.match.seek(client.token, message.seq);
    broadcastSnapshot(found.match.id);
    return;
  }
  if (message.type === "chat") {
    const room: ChatRoom = message.room === "spectator" ? "spectator" : "table";
    const line = await found.match.postChat(found.role, room, message.text ?? "");
    broadcastChat(found.match.id, room, line);
    return;
  }
  throw new Error("Unknown message");
}

http.listen(port, "127.0.0.1", () => {
  console.log(`netrunner-game listening on http://127.0.0.1:${port}`);
});

