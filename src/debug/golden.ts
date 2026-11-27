import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  applyIntent,
  createGame,
  getPublicView,
  GOLDEN_TRANSCRIPTS,
  goldenTranscript,
  type GoldenTranscriptName,
  type Intent,
} from "netrunner-engine";
import { internalBoard } from "./inspect.js";

export interface GoldenView {
  id: string;
  name: string;
  position: number;
  total: number;
  intent: Intent | null;
  applyIntentMs: number | null;
  timingKey: string;
  corp: ReturnType<typeof getPublicView>;
  runner: ReturnType<typeof getPublicView>;
  board: ReturnType<typeof internalBoard>;
}

const sessions = new Map<string, GoldenSession>();

export function goldenNames(): readonly string[] {
  return GOLDEN_TRANSCRIPTS;
}

/** Start at the demo game, before any intent of this golden. */
export function openGolden(name: string): GoldenView | undefined {
  if (!(GOLDEN_TRANSCRIPTS as readonly string[]).includes(name)) return undefined;
  const steps = goldenTranscript(name as GoldenTranscriptName) as Intent[];
  const session = new GoldenSession(name, steps);
  sessions.set(session.id, session);
  return session.view();
}

/** Move one intent forward, or back. Back replays from the start. */
export function stepGolden(id: string, delta: number): GoldenView | undefined {
  const session = sessions.get(id);
  if (!session || !Number.isInteger(delta)) return undefined;
  session.step(delta);
  return session.view();
}

class GoldenSession {
  readonly id = randomBytes(9).toString("base64url");
  private cursor = 0;
  private readonly origin = createGame({ stopAfterFirstCycle: true });
  private state = structuredClone(this.origin);
  private lastMs: number | null = null;

  constructor(
    readonly name: string,
    private readonly steps: Intent[],
  ) {}

  step(delta: number): void {
    const next = Math.max(0, Math.min(this.steps.length, this.cursor + delta));
    if (next === this.cursor) return;
    const started = performance.now();
    if (next < this.cursor) {
      this.state = structuredClone(this.origin);
      this.cursor = 0;
    }
    while (this.cursor < next) {
      const applied = applyIntent(this.state, this.steps[this.cursor]!);
      if (!applied.ok) throw new Error(applied.error ?? "golden intent was not legal");
      this.state = applied.state;
      this.cursor += 1;
    }
    this.lastMs = Math.round(performance.now() - started);
  }

  view(): GoldenView {
    return {
      id: this.id,
      name: this.name,
      position: this.cursor,
      total: this.steps.length,
      intent: this.cursor > 0 ? this.steps[this.cursor - 1]! : null,
      applyIntentMs: this.lastMs,
      timingKey: this.state.timingKey,
      corp: getPublicView(this.state, "corp"),
      runner: getPublicView(this.state, "runner"),
      board: internalBoard(this.state),
    };
  }
}
