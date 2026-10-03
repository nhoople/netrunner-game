/**
 * WebSocket host. Match rules live in match.ts. A closed socket leaves the match in memory.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { learnToPlaySetup } from "./decks.js";
import {
  createMatch,
  findMatchByToken,
  PROTOCOL_VERSION,
  type ChatRoom,
} from "./match.js";
import type { Intent } from "netrunner-engine";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT ?? 8787);

const clients = new Set<{
  socket: WebSocket;
  matchId: string;
  token: string;
}>();

function contentType(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
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
    if (room !== "table") continue;
    const found = findMatchByToken(client.token);
    if (!found) continue;
    send(client.socket, { v: PROTOCOL_VERSION, type: "chat", line });
  }
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/matches") {
    const match = createMatch({ setup: learnToPlaySetup });
    res.writeHead(201, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        matchId: match.id,
        seats: { corp: match.tokens.corp, runner: match.tokens.runner },
      }),
    );
    console.log(`match created ${match.id}`);
    return;
  }

  const rel = normalize(url.pathname === "/" ? "table.html" : url.pathname.slice(1));
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
  const client = { socket, matchId: found.match.id, token };
  clients.add(client);
  console.log(`seat joined ${found.match.id} ${found.seat}`);
  send(socket, {
    v: PROTOCOL_VERSION,
    type: "welcome",
    matchId: found.match.id,
    seat: found.seat,
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
  client: { socket: WebSocket; matchId: string; token: string },
  raw: string,
): Promise<void> {
  const found = findMatchByToken(client.token);
  if (!found) throw new Error("Unknown seat");
  let message: { type?: string; intentId?: string; intent?: Intent; room?: ChatRoom; text?: string };
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
  if (message.type === "chat") {
    const room: ChatRoom = message.room === "spectator" ? "spectator" : "table";
    const line = await found.match.postChat(found.seat, room, message.text ?? "");
    broadcastChat(found.match.id, room, line);
    return;
  }
  throw new Error("Unknown message");
}

http.listen(port, "127.0.0.1", () => {
  console.log(`netrunner-game listening on http://127.0.0.1:${port}`);
});

