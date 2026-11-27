/**
 * The one Playwright fixture for browser tests (dev tooling plan, shared pieces).
 *
 * `server` starts the game host once per worker on a free port, with an empty
 * temporary MATCH_DIR. `match` creates a match through the host's own
 * `POST /matches` request and hands back every link a person would open.
 * Tests use these; they never start a server or create a match themselves.
 *
 * Every test also fails on an uncaught page error.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));

interface GameServer {
  /** Origin of the running host, such as `http://127.0.0.1:41234`. */
  url: string;
}

interface MatchLinks {
  matchId: string;
  /** Verification table pages, by seat. */
  table: {
    corp: string;
    runner: string;
    spectator: string;
    log: string;
    debug: string;
  };
  /** Product client (`/play/`) pages, by seat. */
  play: {
    corp: string;
    runner: string;
    spectator: string;
  };
}

interface Fixtures {
  match: MatchLinks;
  pageErrors: string[];
}

interface WorkerFixtures {
  server: GameServer;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("No port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function waitForListening(child: ChildProcess, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`The game server did not start on port ${port}:\n${output}`));
    }, 30_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`listening on http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The game server exited with code ${code}:\n${output}`));
    });
  });
}

function link(origin: string, path: string, token: string): string {
  const url = new URL(path, origin);
  url.searchParams.set("token", token);
  return url.toString();
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  server: [
    // Playwright needs the object pattern here, even with no other fixtures.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      if (!existsSync(join(root, "public", "play", "index.html"))) {
        throw new Error("The product client is not built. Run `npm run build:client` first.");
      }
      const matchDir = await mkdtemp(join(tmpdir(), "netrunner-browser-"));
      const port = await freePort();
      const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: root,
        env: { ...process.env, PORT: String(port), MATCH_DIR: matchDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForListening(child, port);
        await use({ url: `http://127.0.0.1:${port}` });
      } finally {
        child.kill();
        await rm(matchDir, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],

  baseURL: async ({ server }, use) => {
    await use(server.url);
  },

  match: async ({ server, request }, use) => {
    const res = await request.post(`${server.url}/matches`);
    expect(res.status(), "POST /matches creates a match").toBe(201);
    const body = (await res.json()) as {
      matchId: string;
      seats: { corp: string; runner: string; spectator: string; log: string; debug: string };
    };
    const { seats } = body;
    await use({
      matchId: body.matchId,
      table: {
        corp: link(server.url, "/", seats.corp),
        runner: link(server.url, "/", seats.runner),
        spectator: link(server.url, "/", seats.spectator),
        log: link(server.url, "/log.html", seats.log),
        debug: link(server.url, "/debug.html", seats.debug),
      },
      play: {
        corp: link(server.url, "/play/", seats.corp),
        runner: link(server.url, "/play/", seats.runner),
        spectator: link(server.url, "/play/", seats.spectator),
      },
    });
  },

  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
      await use(errors);
      expect(errors, "the page threw no error").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
