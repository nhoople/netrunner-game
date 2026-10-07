/**
 * One match. No sockets. The server adapts a connection to these methods.
 * Closing a connection must not delete the match.
 */
import { randomBytes } from "node:crypto";
import {
  abilityCost,
  applyIntent,
  autoWalk,
  createGame,
  effectiveEventPlayCost,
  effectiveOperationExtraClicks,
  getPublicView,
  operationAndEventPlayCostIncreaseTotal,
  queryLegality,
  type GameState,
  type Intent,
} from "netrunner-engine";
import { printingCodeFor } from "./printing-codes.js";

export const PROTOCOL_VERSION = 1;
const CHAT_LIMIT = 500;

export type Seat = "corp" | "runner";
export type ViewerRole = Seat | "spectator";
export type ChatRoom = "table" | "spectator";
export type HostEnd = "concede" | "intentional_draw" | "judge";

export interface MatchLabels {
  tournamentId?: string;
  round?: number;
  table?: number;
  game?: number;
  format?: string;
}

export interface ChatLine {
  seq: number;
  room: ChatRoom;
  from: ViewerRole;
  text: string;
}

export interface ChatPort {
  post(matchId: string, line: ChatLine): void;
  history(matchId: string, room: ChatRoom): ChatLine[];
}

export class MemoryChat implements ChatPort {
  private readonly lines = new Map<string, ChatLine[]>();

  post(matchId: string, line: ChatLine): void {
    const list = this.lines.get(matchId) ?? [];
    list.push(line);
    this.lines.set(matchId, list);
  }

  history(matchId: string, room: ChatRoom): ChatLine[] {
    return (this.lines.get(matchId) ?? []).filter((line) => line.room === room);
  }
}

export interface GameLogEntry {
  seq: number;
  seat: ViewerRole | "host";
  kind: "intent" | HostEnd;
  intent?: Intent;
  ok: boolean;
  summary: string;
  /** Summary for the other seat and spectators. Omits hidden card titles. */
  publicSummary?: string;
  /** Citations that made this intent legal. Omitted when the intent was rejected. */
  cites?: RuleCiteWire[];
}

export interface MatchResult {
  done: boolean;
  winner: Seat | null;
  winReason: GameState["winReason"];
  hostEnd: HostEnd | null;
}

/** A Comprehensive Rules citation. The current step is open information (CR 10.2.3a). */
export interface RuleCiteWire {
  number: string;
  id: string;
}

/**
 * The timing step every seat can see.
 * A `pass` step is a priority window (CR 9.2.4).
 */
export interface TimingWire {
  /** Appendix or rule number for the current step, such as `11.2_2_b_ii`. */
  stepNumber: string;
  stepId: string;
  label: string;
  kind: string;
  /** Who may act in this step (CR 9.2.4). */
  priority: "corp" | "runner" | "system";
  activeSide: "corp" | "runner";
}

export interface LegalWire {
  intent: Intent;
  label: string;
  /** A rules action, or an ability printed on a card. */
  source: "basic" | "card";
  /** Card that grants a card ability, when this seat can see its title. */
  card?: string;
  /** Comprehensive Rules citations for this legal intent. */
  cites: RuleCiteWire[];
}

export interface SeatSnapshot {
  v: number;
  viewer: ViewerRole;
  view: unknown;
  legal: LegalWire[];
  log: GameLogEntry[];
  chat: ChatLine[];
  result: MatchResult;
  /** Current timing step and priority holder. The same for every seat (CR 10.2.3a, CR 9.2.4). */
  timing: TimingWire;
  glossary: Record<string, { title: string; type: string; cost: string; text: string; code?: string; hosted?: number }>;
  /** Printed card from an access the engine already finished. */
  access?: { title: string; type: string; cost: string; text: string; code?: string; hosted?: number };
}

export class MatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchError";
  }
}

export interface CreateMatchOptions {
  setup?: () => GameState;
  labels?: MatchLabels;
  chat?: ChatPort;
  id?: string;
  tokens?: { corp: string; runner: string; spectator?: string };
}

const matches = new Map<string, Match>();

export function createMatch(options: CreateMatchOptions = {}): Match {
  const match = new Match(options);
  matches.set(match.id, match);
  return match;
}

export function getMatch(id: string): Match | undefined {
  return matches.get(id);
}

export function findMatchByToken(token: string): { match: Match; role: ViewerRole } | undefined {
  for (const match of matches.values()) {
    const role = match.roleForToken(token);
    if (role) return { match, role };
  }
  return undefined;
}

export class Match {
  readonly id: string;
  readonly tokens: { corp: string; runner: string; spectator: string };
  readonly labels: MatchLabels;
  readonly chat: ChatPort;

  private state: GameState;
  private hostEnd: HostEnd | null = null;
  private readonly log: GameLogEntry[] = [];
  private chatSeq = 0;
  private readonly appliedIntentIds = new Set<string>();
  private readonly secretRefs = new Map<string, string>();
  private readonly idToRef = new Map<string, string>();
  private shownAccess: { title: string; type: string; cost: string; text: string; code?: string; hosted?: number } | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CreateMatchOptions = {}) {
    this.id = options.id ?? randomBytes(9).toString("base64url");
    this.tokens = {
      corp: options.tokens?.corp ?? randomBytes(18).toString("base64url"),
      runner: options.tokens?.runner ?? randomBytes(18).toString("base64url"),
      spectator: options.tokens?.spectator ?? randomBytes(18).toString("base64url"),
    };
    this.labels = { ...options.labels };
    this.chat = options.chat ?? new MemoryChat();
    const setup = options.setup;
    this.state = createGame({
      setup,
      agendaPointsToWin: 6,
      stopAfterFirstCycle: false,
    });
    autoWalk(this.state);
    this.passEmptyWindows();
  }

  hiddenIds(side: Seat): { hand: string[]; deck: string[] } {
    const player = side === "corp" ? this.state.corp : this.state.runner;
    return { hand: [...player.hand], deck: [...player.deck] };
  }

  seatForToken(token: string): Seat | undefined {
    if (token === this.tokens.corp) return "corp";
    if (token === this.tokens.runner) return "runner";
    return undefined;
  }

  roleForToken(token: string): ViewerRole | undefined {
    if (token === this.tokens.spectator) return "spectator";
    return this.seatForToken(token);
  }

  result(): MatchResult {
    return {
      done: this.state.done || this.hostEnd !== null,
      winner: this.state.winner,
      winReason: this.state.winReason,
      hostEnd: this.hostEnd,
    };
  }

  /** Full log for replay. Not sent to clients unfiltered. */
  gameLog(): readonly GameLogEntry[] {
    return this.log;
  }

  /**
   * Run work for this match one at a time. A disconnect does not flush the match.
   */
  enqueue<T>(work: () => T): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  submit(token: string, intentId: string, submitted: Intent): Promise<SeatSnapshot> {
    return this.enqueue(() => {
      const seat = this.requireSeat(token);
      if (!intentId) throw new MatchError("Missing intent id");
      if (this.appliedIntentIds.has(intentId)) return this.snapshot(seat);
      this.assertPlaying();
      const intent = this.uncloak(submitted) as Intent;
      const legal = queryLegality(this.state).legal.find(
        (entry) => entry.actor === seat && sameIntent(entry.action, intent),
      );
      if (!legal) {
        this.appendLog({
          seat,
          kind: "intent",
          intent,
          ok: false,
          summary: `${seatLabel(seat)} action rejected`,
        });
        throw new MatchError("That action is not legal for this seat");
      }
      const offered = describeIntent(this.state, legal.action);
      const applied = applyIntent(this.state, legal.action);
      if (!applied.ok) {
        this.appendLog({
          seat,
          kind: "intent",
          intent: legal.action,
          ok: false,
          summary: `${seatLabel(seat)} action rejected`,
        });
        throw new MatchError("That action is not legal for this seat");
      }
      this.state = applied.state;
      autoWalk(this.state);
      this.passEmptyWindows();
      this.appliedIntentIds.add(intentId);
      this.noteAccess(legal.action);
      const revealed = `${seatLabel(seat)}: ${legal.action.type === "access_card" ? describeIntent(this.state, legal.action) : offered}`;
      this.appendLog({
        seat,
        kind: "intent",
        intent: legal.action,
        ok: true,
        summary: revealed,
        publicSummary: `${seatLabel(seat)}: ${describeIntent(this.state, legal.action, "spectator")}`,
        cites: citeWire(legal.cites),
      });
      return this.snapshot(seat);
    });
  }

  concede(token: string): Promise<SeatSnapshot> {
    return this.enqueue(() => {
      const seat = this.requireSeat(token);
      this.end(seat, "concede", seat === "corp" ? "runner" : "corp");
      return this.snapshot(seat);
    });
  }

  /** Judge ruling or intentional draw. Same ending path as concede. */
  endByHost(
    reason: "intentional_draw" | "judge",
    winner: Seat | null,
  ): Promise<MatchResult> {
    return this.enqueue(() => {
      this.end("host", reason, winner);
      return this.result();
    });
  }

  postChat(from: ViewerRole, room: ChatRoom, text: string): Promise<ChatLine> {
    return this.enqueue(() => {
      if (room === "table" && from === "spectator") {
        throw new MatchError("Spectators cannot speak at the table");
      }
      if (room === "spectator" && from !== "spectator") {
        throw new MatchError("Only spectators can speak in the spectator room");
      }
      const trimmed = text.trim();
      if (!trimmed) throw new MatchError("Empty message");
      if (trimmed.length > CHAT_LIMIT) throw new MatchError("Message is too long");
      const line: ChatLine = {
        seq: ++this.chatSeq,
        room,
        from,
        text: trimmed,
      };
      this.chat.post(this.id, line);
      return line;
    });
  }

  snapshotForToken(token: string): SeatSnapshot {
    return this.snapshot(this.requireRole(token));
  }

  snapshotForRole(role: ViewerRole): SeatSnapshot {
    return this.snapshot(role);
  }

  private requireSeat(token: string): Seat {
    const seat = this.seatForToken(token);
    if (!seat) throw new MatchError("Unknown seat");
    return seat;
  }

  private requireRole(token: string): ViewerRole {
    const role = this.roleForToken(token);
    if (!role) throw new MatchError("Unknown seat");
    return role;
  }

  private noteAccess(action: Intent): void {
    if (action.type !== "access_card" || this.state.run?.accessingCardId) {
      this.shownAccess = null;
      return;
    }
    const card = this.state.cards[action.cardId];
    if (!card) {
      this.shownAccess = null;
      return;
    }
    const code = printingCodeFor(card.defId);
    this.shownAccess = {
      title: card.title,
      type: card.type,
      cost: printedCost(card),
      text: cardRules(card),
      ...(code ? { code } : {}),
      ...(card.hostedCredits != null ? { hosted: card.hostedCredits } : {}),
    };
  }

  private assertPlaying(): void {
    if (this.result().done) throw new MatchError("This game is over");
  }

  private end(seat: ViewerRole | "host", reason: HostEnd, winner: Seat | null): void {
    this.assertPlaying();
    this.hostEnd = reason;
    this.state.done = true;
    this.state.winner = winner;
    const who =
      reason === "concede" && seat !== "host"
        ? `${seatLabel(seat)} concedes`
        : reason === "intentional_draw"
          ? "intentional draw"
          : `judge ruling${winner ? `: ${winner} wins` : ""}`;
    this.appendLog({
      seat,
      kind: reason,
      ok: true,
      summary: who,
    });
  }

  private appendLog(entry: Omit<GameLogEntry, "seq">): void {
    this.log.push({ seq: this.log.length + 1, ...entry });
  }

  private snapshot(role: ViewerRole): SeatSnapshot {
    const secrets = secretIds(this.state, role);
    const rooms: ChatRoom[] = role === "spectator" ? ["table", "spectator"] : ["table"];
    const legality = queryLegality(this.state);
    const view =
      role === "spectator" ? spectatorView(this.state) : seatView(this.state, role);
    // The engine log names hidden cards. Players read the host log instead.
    if (view && typeof view === "object" && "log" in view) {
      delete (view as { log?: unknown }).log;
    }
    const legal = this.legalFor(role, legality).map((entry) => ({
      ...entry,
      intent: this.cloak(entry.intent, secrets) as Intent,
    }));
    const body = {
      v: PROTOCOL_VERSION,
      viewer: role,
      view,
      legal,
      log: this.log.map((entry) => {
        const shown = publicLogEntry(entry);
        if (role === entry.seat || !entry.publicSummary) return shown;
        return { ...shown, summary: entry.publicSummary };
      }),
      chat: rooms
        .flatMap((room) => this.chat.history(this.id, room))
        .sort((a, b) => a.seq - b.seq),
      result: this.result(),
      timing: timingWire(legality),
      glossary: glossary(this.state, role, secrets),
      ...(role !== "spectator" && this.shownAccess ? { access: this.shownAccess } : {}),
    };
    return stripSecrets(body, secrets) as SeatSnapshot;
  }

  /**
   * A pass step whose actor has no other legal action is resolved immediately.
   * Paid abilities and rezzes still wait. The click is not written to the game log.
   */
  private passEmptyWindows(): void {
    for (let i = 0; i < 32; i++) {
      if (this.state.done) return;
      const legal = playable(this.state);
      const pass = legal.find(
        (entry) => entry.action.type === "pass_window" && entry.actor !== "system",
      );
      if (!pass) return;
      const forActor = legal.filter((entry) => entry.actor === pass.actor);
      if (forActor.length !== 1) return;
      const actor = pass.actor;
      const before = this.state.timingKey;
      const applied = applyIntent(this.state, pass.action);
      if (!applied.ok) return;
      this.state = applied.state;
      autoWalk(this.state);
      const again = playable(this.state).filter((entry) => entry.actor === actor);
      if (
        this.state.timingKey === before &&
        again.length === 1 &&
        again[0]?.action.type === "pass_window"
      ) {
        return;
      }
    }
  }

  private legalFor(role: ViewerRole, legality = queryLegality(this.state)): LegalWire[] {
    if (role === "spectator") return [];
    const secrets = secretIds(this.state, role);
    return playable(this.state, legality)
      .filter((entry) => entry.actor === role)
      .map((entry) => {
        const source = actionSource(entry.action.type);
        const grantId = grantingCardId(this.state, entry.action);
        const grant = grantId ? this.state.cards[grantId] : undefined;
        const card = source === "card" && grant && canSeeTitle(grant, role, secrets, this.state.run?.accessingCardId ?? undefined) ? grant.title : undefined;
        return {
          intent: entry.action,
          label: describeIntent(this.state, entry.action, role),
          source,
          ...(card ? { card } : {}),
          cites: citeWire(entry.cites),
        };
      });
  }

  /** A secret card id in a legal intent is replaced with a token this match can resolve. */
  private refFor(id: string): string {
    const existing = this.idToRef.get(id);
    if (existing) return existing;
    const token = `ref_${randomBytes(9).toString("base64url")}`;
    this.idToRef.set(id, token);
    this.secretRefs.set(token, id);
    return token;
  }

  private cloak(value: unknown, secrets: Set<string>): unknown {
    if (typeof value === "string") return secrets.has(value) ? this.refFor(value) : value;
    if (Array.isArray(value)) return value.map((item) => this.cloak(item, secrets));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = this.cloak(item, secrets);
      return out;
    }
    return value;
  }

  private uncloak(value: unknown): unknown {
    if (typeof value === "string") return this.secretRefs.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => this.uncloak(item));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = this.uncloak(item);
      return out;
    }
    return value;
  }
}

/** Candidates the engine will accept. Some listed installs cost more than the seat can pay. */
function playable(state: GameState, legality = queryLegality(state)) {
  return legality.legal.filter((entry) => applyIntent(state, entry.action).ok);
}

function citeWire(cites: readonly { number: string; id: string }[]): RuleCiteWire[] {
  return cites.map((cite) => ({ number: cite.number, id: cite.id }));
}

function timingWire(legality: ReturnType<typeof queryLegality>): TimingWire {
  return {
    stepNumber: legality.window.stepNumber,
    stepId: legality.window.stepId,
    label: legality.window.label,
    kind: legality.window.kind,
    priority: legality.priority,
    activeSide: legality.activeSide,
  };
}

function seatLabel(seat: ViewerRole | "host"): string {
  switch (seat) {
    case "corp":
      return "Corp";
    case "runner":
      return "Runner";
    case "spectator":
      return "Spectator";
    case "host":
      return "Host";
  }
}

function publicLogEntry(entry: GameLogEntry): GameLogEntry {
  return {
    seq: entry.seq,
    seat: entry.seat,
    kind: entry.kind,
    ok: entry.ok,
    summary: entry.summary,
    ...(entry.cites?.length ? { cites: entry.cites } : {}),
  };
}

function secretIds(state: GameState, role: ViewerRole): Set<string> {
  const ids = new Set<string>();
  const hide = (side: Seat) => {
    const player = side === "corp" ? state.corp : state.runner;
    for (const id of player.hand) ids.add(id);
    for (const id of player.deck) ids.add(id);
  };
  if (role === "spectator") {
    hide("corp");
    hide("runner");
  } else {
    hide(role === "corp" ? "runner" : "corp");
  }
  const accessing = state.run?.accessingCardId;
  if (accessing) ids.delete(accessing);
  return ids;
}

function glossary(
  state: GameState,
  role: ViewerRole,
  secrets: Set<string>,
): Record<string, { title: string; type: string; cost: string; text: string; code?: string; hosted?: number }> {
  const out: Record<string, { title: string; type: string; cost: string; text: string; code?: string; hosted?: number }> = {};
  for (const card of Object.values(state.cards)) {
    if (!canSeeTitle(card, role, secrets, state.run?.accessingCardId ?? undefined)) continue;
    const code = printingCodeFor(card.defId);
    out[card.id] = {
      title: card.title,
      type: card.type,
      cost: printedCost(card),
      text: cardRules(card),
      ...(code ? { code } : {}),
      ...(card.hostedCredits != null ? { hosted: card.hostedCredits } : {}),
    };
  }
  return out;
}

function printedCost(card: GameState["cards"][string]): string {
  const bits: string[] = [];
  if (card.type === "event" || card.type === "operation") {
    bits.push(`play ${card.playCost ?? 0}¢`);
  }
  if (card.type === "agenda") {
    if (card.advancementRequirement != null) bits.push(`advance ${card.advancementRequirement}`);
    if (card.agendaPoints != null) bits.push(`${card.agendaPoints} points`);
  }
  if (
    card.type === "program" ||
    card.type === "hardware" ||
    card.type === "resource" ||
    card.type === "ice" ||
    card.type === "asset" ||
    card.type === "upgrade"
  ) {
    bits.push(`install ${card.installCost}¢`);
  }
  if (card.rezCost != null && (card.type === "ice" || card.type === "asset" || card.type === "upgrade")) {
    bits.push(`rez ${card.rezCost}¢`);
  }
  if (card.memoryCost != null && card.memoryCost > 0) bits.push(`${card.memoryCost} MU`);
  if (card.trashCost != null) bits.push(`trash ${card.trashCost}¢`);
  if (card.strength != null && (card.type === "ice" || card.type === "program")) {
    bits.push(`strength ${card.strength}`);
  }
  return bits.join(", ");
}

type CardFace = GameState["cards"][string];

interface EffectNode {
  op?: string;
  action?: {
    kind?: string;
    side?: string;
    amount?: number;
    base?: number;
    preferNotInstalledThisTurn?: boolean;
  };
  effects?: EffectNode[];
  options?: Array<{ label?: string }>;
  cond?: { op?: string };
  then?: EffectNode;
}

function cardRules(card: CardFace): string {
  const lines: string[] = [];
  const play = effectSentence(card.onPlay as EffectNode | undefined);
  if (play) lines.push(play);
  const scored = effectSentence(card.onScore as EffectNode | undefined);
  if (scored) lines.push(`When scored, ${lowerFirst(scored)}`);
  const rezzed = effectSentence(card.onRez as EffectNode | undefined);
  if (rezzed) lines.push(`When rezzed, ${lowerFirst(rezzed)}`);
  const turn = effectSentence(card.onTurnBegin as EffectNode | undefined);
  if (turn) lines.push(`At the start of your turn, ${lowerFirst(turn)}`);
  const accessed = effectSentence(card.onAccess as EffectNode | undefined);
  if (accessed) lines.push(`When accessed, ${lowerFirst(accessed)}`);
  const run = effectSentence(card.onSuccessfulRun as EffectNode | undefined);
  if (run) lines.push(`After a successful run, ${lowerFirst(run)}`);
  if (card.subroutines?.length) {
    lines.push(card.subroutines.map((sub) => sub.text).join(" "));
  }
  if (card.breaker) {
    const sub = card.breaker.breaksSubtype === "*" ? "any" : card.breaker.breaksSubtype;
    const many = card.breaker.breakMaxSubs && card.breaker.breakMaxSubs > 1
      ? `up to ${card.breaker.breakMaxSubs} ${sub} subroutines`
      : sub === "any"
        ? "any subroutine"
        : `a ${sub} subroutine`;
    const pump = card.breaker.pumpUsesIcebreakerCount
      ? `${card.breaker.pumpCredits}¢: +1 strength for each installed icebreaker.`
      : `${card.breaker.pumpCredits}¢: +${card.breaker.pumpStrength ?? 1} strength.`;
    lines.push(`Break ${many} for ${card.breaker.breakCredits}¢. ${pump}`);
  }
  for (const ability of card.paidAbilities ?? []) {
    if (!ability.label || ability.label.toLowerCase().startsWith("pump ")) continue;
    const once = ability.oncePerTurn ? " Once per turn." : "";
    lines.push(`${ability.label}.${once}`);
  }
  if (card.runEvent) lines.push(runEventSentence(card.runEvent));
  if (card.handSizeBonus) lines.push(`+${card.handSizeBonus} maximum hand size.`);
  if (card.mayRezIceIgnoringCostsOnScoreOrSteal) {
    lines.push("When scored or stolen, you may rez a piece of ice, ignoring all costs.");
  }
  if (card.strengthBonusProtectingRemote) {
    lines.push(`+${card.strengthBonusProtectingRemote} strength while protecting a remote server.`);
  }
  if (card.drawOnHostedEmpty) {
    lines.push(`When the hosted credits are gone, trash this card and draw ${card.drawOnHostedEmpty}.`);
  }
  if (card.approachServerTax) {
    lines.push(
      `When the Runner approaches this server, they spend ${card.approachServerTax.clicks} clicks or ${card.approachServerTax.credits}¢, or end the run.`,
    );
  }
  if (card.bonusAccessOnFirstHqBreachThisTurn) {
    lines.push("The first time you breach HQ each turn, access 1 additional card.");
  }
  if (card.hostedCreditsOnInstall) {
    lines.push(`When you install this card, place ${card.hostedCreditsOnInstall}¢ on it.`);
  }
  if (card.muBonus) lines.push(`+${card.muBonus} MU.`);
  if (card.installCostDiscountIfSuccessfulRunThisTurn) {
    lines.push(
      `Costs ${card.installCostDiscountIfSuccessfulRunThisTurn}¢ less to install if you made a successful run this turn.`,
    );
  }
  if (card.trashAfterBreakingThisRun) {
    lines.push("Trash this card after it breaks a subroutine this run.");
  }
  return lines.join(" ");
}

function effectSentence(effect: EffectNode | undefined): string | null {
  if (!effect?.op) return null;
  if (effect.op === "do" && effect.action) return actionSentence(effect.action);
  if (effect.op === "seq") {
    const parts = (effect.effects ?? []).map((item) => effectSentence(item)).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(" ") : null;
  }
  if (effect.op === "choose") {
    const labels = (effect.options ?? [])
      .map((option) => option.label)
      .filter((label): label is string => typeof label === "string" && label.toLowerCase() !== "decline");
    return labels.length ? `you may ${labels.join(" or ")}.` : null;
  }
  if (effect.op === "if") {
    const then = effectSentence(effect.then);
    if (!then) return null;
    if (effect.cond?.op === "clicks_remaining") return `If you have clicks left, ${lowerFirst(then)}`;
    return then;
  }
  return null;
}

function actionSentence(action: NonNullable<EffectNode["action"]>): string | null {
  const amount = action.amount ?? 0;
  switch (action.kind) {
    case "gain_credits":
      return amount > 0 ? `Gain ${amount}¢.` : null;
    case "draw":
      return `Draw ${amount || 1}.`;
    case "place_hosted_credits":
      return `Place ${amount}¢ on this card.`;
    case "take_hosted_credits":
      return amount >= 99 ? "Take all credits from this card." : `Take ${amount}¢ from this card.`;
    case "place_advancements":
      return action.preferNotInstalledThisTurn
        ? `Place ${amount} advancement counters on a card that can be advanced and was not installed this turn.`
        : `Place ${amount} advancement counters.`;
    case "net_damage":
      return `Do ${amount} net damage.`;
    case "net_damage_per_advancement":
      return `Do ${action.base ?? 0} net damage plus 1 for each advancement token on this card.`;
    case "lose_clicks":
      return amount === 1 ? "Lose 1 click." : `Lose ${amount} clicks.`;
    case "lose_credits":
      return `${action.side === "runner" ? "The Runner" : "You"} lose ${amount}¢.`;
    default:
      return null;
  }
}

function runEventSentence(spec: NonNullable<CardFace["runEvent"]>): string {
  const server =
    spec.servers === "any"
      ? "any server"
      : spec.servers === "hq_rd"
        ? "HQ or R&D"
        : spec.servers === "central"
          ? "a central server"
          : String(spec.servers);
  const bits = [`Run ${server}.`];
  if (spec.iceRezCostIncrease) bits.push(`Ice rez costs +${spec.iceRezCostIncrease}¢ during this run.`);
  if (spec.placeEventCredits) bits.push(`You have ${spec.placeEventCredits}¢ to spend during this run.`);
  if (spec.bonusAccess) bits.push(`If successful, access ${spec.bonusAccess} additional card.`);
  const after = effectSentence(spec.onSuccessfulRun as EffectNode | undefined);
  if (after) bits.push(`If successful, ${lowerFirst(after)}`);
  return bits.join(" ");
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function canSeeTitle(
  card: GameState["cards"][string],
  role: ViewerRole,
  secrets: Set<string>,
  revealedId?: string,
): boolean {
  if (role !== "spectator" && revealedId && card.id === revealedId) return true;
  if (secrets.has(card.id)) return false;
  if ((card.zone === "corp:rd" || card.zone === "runner:stack") && !card.faceup) return false;
  if (card.type === "identity") return true;
  if (card.rezzed || card.faceup) return true;
  if (role === "corp" && card.side === "corp") return true;
  if (role === "runner" && card.side === "runner") return true;
  return false;
}

/** The card on top of a discard pile. A facedown top omits the card id. */
/** Advancement counters on an installed card are open when the face is not (CR 1.18.1, CR 10.2.3a). */
function advancementField(card: { advancementTokens?: number } | undefined): { advancementTokens?: number } {
  const count = card?.advancementTokens ?? 0;
  return count > 0 ? { advancementTokens: count } : {};
}

/**
 * A faceup or rezzed card's printing is open (CR 10.2.3a). A facedown card keeps its face hidden (CR 10.2.2a).
 * The printing code is the card image. It is not an instance id.
 */
function visibleFace(card: CardFace | undefined): {
  title: string | null;
  rezzed?: boolean;
  type?: string;
  strength?: number;
  code?: string;
} {
  if (!card) return { title: null };
  const corpStatus = card.side === "corp" ? { rezzed: Boolean(card.rezzed) } : {};
  if (!card.rezzed && !card.faceup) return { title: null, ...corpStatus };
  const code = printingCodeFor(card.defId);
  return {
    title: card.title,
    ...corpStatus,
    type: card.type,
    ...(card.strength != null ? { strength: card.strength } : {}),
    ...(code ? { code } : {}),
  };
}

/** Credit counters on an installed card stay visible when the face does not (CR 1.9.5a, CR 10.2.3a). */
function hostedField(card: { hostedCredits?: number } | undefined): { hosted?: number } {
  const count = card?.hostedCredits ?? 0;
  return count > 0 ? { hosted: count } : {};
}

function decorateInstalledIds(state: GameState, ids: readonly string[]) {
  return ids.map((id) => {
    const hosted = hostedField(state.cards[id]);
    return hosted.hosted ? { id, ...hosted } : id;
  });
}

function discardTop(state: GameState, ids: readonly string[]): { faceup: true; id: string } | { faceup: false } | null {
  const id = ids.at(-1);
  if (!id) return null;
  if (!state.cards[id]?.faceup) return { faceup: false };
  return { faceup: true, id };
}

function seatView(state: GameState, role: Seat) {
  const view = getPublicView(state, role);
  const self = role === "corp" ? state.corp : state.runner;
  const opponent = role === "corp" ? state.runner : state.corp;
  return {
    ...view,
    servers: view.servers.map((server) => ({
      ...server,
      ice: server.ice.map((card) => ({ ...card, ...hostedField(state.cards[card.id]) })),
      root: server.root.map((card) => ({ ...card, ...hostedField(state.cards[card.id]) })),
    })),
    self: {
      ...view.self,
      discardTop: discardTop(state, self.discard),
      rig: decorateInstalledIds(state, view.self.rig),
    },
    opponent: {
      ...view.opponent,
      discardCount: opponent.discard.length,
      discardTop: discardTop(state, opponent.discard),
      rig: decorateInstalledIds(state, view.opponent.rig),
    },
    badPublicity: state.corp.badPublicity ?? 0,
  };
}

function spectatorView(state: GameState): unknown {
  const player = (side: Seat) => {
    const p = side === "corp" ? state.corp : state.runner;
    return {
      clicks: p.clicks,
      credits: p.credits,
      tags: p.tags,
      handCount: p.hand.length,
      deckCount: p.deck.length,
      discardCount: p.discard.length,
      scoreCount: p.score.length,
      identityId: p.identityId,
      identity: state.cards[p.identityId]?.title ?? null,
      link: p.link,
      badPublicity: side === "corp" ? (p.badPublicity ?? 0) : undefined,
      rig: p.rig.map((id) => {
        const card = state.cards[id];
        const face = visibleFace(card);
        return {
          title: face.title ?? "card",
          type: face.type ?? null,
          ...(face.strength != null ? { strength: face.strength } : {}),
          ...(face.code ? { code: face.code } : {}),
          ...hostedField(card),
        };
      }),
      score: p.score.map((id) => visibleFace(state.cards[id])).filter((face) => face.title),
      discardFaceup: p.discard
        .filter((id) => state.cards[id]?.faceup)
        .map((id) => state.cards[id]?.title)
        .filter((title): title is string => Boolean(title)),
      discardTop: discardTop(state, p.discard),
    };
  };
  return {
    viewer: "spectator",
    turnNumber: state.turnNumber,
    activeSide: state.activeSide,
    timingKey: state.timingKey,
    done: state.done,
    winner: state.winner,
    badPublicity: state.corp.badPublicity ?? 0,
    corp: player("corp"),
    runner: player("runner"),
    servers: Object.values(state.servers).map((server) => ({
      id: server.id,
      ice: server.ice.map((id) => {
        const card = state.cards[id];
        return {
          ...visibleFace(card),
          ...advancementField(card),
          ...hostedField(card),
        };
      }),
      root: server.root.map((id) => {
        const card = state.cards[id];
        return {
          ...visibleFace(card),
          ...advancementField(card),
          ...hostedField(card),
        };
      }),
    })),
  };
}

function stripSecrets(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === "string") {
    if (secrets.has(value)) return null;
    let out = value;
    for (const id of secrets) {
      if (out.includes(id)) out = out.split(id).join("[hidden]");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = stripSecrets(item, secrets);
    }
    return out;
  }
  return value;
}

function sameIntent(left: Intent, right: Intent): boolean {
  return stable(left) === stable(right);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const CARD_ACTION_TYPES = new Set<Intent["type"]>([
  "use_paid_ability",
  "use_identity_ability",
  "break_subroutine",
  "break_bioroid_subroutine",
  "break_bioroid_subroutines",
  "access_rfg_paying_trash_cost",
  "access_trash_from_grip",
  "access_trash_with_virus",
  "access_trash_free",
  "access_trash_paying_printed_cost_from_stealth",
  "access_trash_self_non_agenda_draw",
  "access_host_non_agenda_faceup",
  "access_host_agenda_on_film_critic",
  "prevent_damage",
  "prevent_damage_lose_all_clicks",
  "choose_option",
]);

/** Basic actions are the rules menu. Card actions are printed on a card. */
export function actionSource(type: Intent["type"]): "basic" | "card" {
  return CARD_ACTION_TYPES.has(type) ? "card" : "basic";
}

function grantingCardId(state: GameState, intent: Intent): string | undefined {
  switch (intent.type) {
    case "use_paid_ability":
      return intent.cardId;
    case "use_identity_ability": {
      const corpHas = state.cards[state.corp.identityId]?.paidAbilities?.some((item) => item.id === intent.abilityId);
      return corpHas ? state.corp.identityId : state.runner.identityId;
    }
    case "break_subroutine":
      return intent.breakerId;
    case "break_bioroid_subroutine":
    case "break_bioroid_subroutines":
      return state.run?.encounter?.iceId;
    case "access_rfg_paying_trash_cost":
      return intent.slumsId;
    case "access_trash_paying_printed_cost_from_stealth":
      return intent.lampadesId;
    case "access_trash_self_non_agenda_draw":
      return intent.gourmandId;
    case "access_host_agenda_on_film_critic":
      return intent.hostId;
    case "access_trash_from_grip":
      return state.runner.rig.find((id) => state.cards[id]?.accessTrashFromGrip);
    case "access_trash_with_virus":
      return state.runner.rig.find((id) => state.cards[id]?.accessTrashWithVirus);
    case "access_host_non_agenda_faceup":
      return state.runner.rig.find((id) => state.cards[id]?.accessHostNonAgendaFaceup);
    case "choose_option":
      return state.pendingChoice?.sourceId;
    default:
      return undefined;
  }
}

function withCard(title: string | undefined, text: string): string {
  if (!title || text.toLowerCase().includes(title.toLowerCase())) return text;
  return `${title}: ${text}`;
}

function describeIntent(state: GameState, intent: Intent, viewer?: ViewerRole): string {
  const name = seenTitle(state, "cardId" in intent ? intent.cardId : undefined, viewer);
  switch (intent.type) {
    case "keep_starting_hand":
      return "Keep this hand";
    case "mulligan":
      return "Mulligan — shuffle back and draw 5";
    case "pass_window":
      return "Continue";
    case "basic_gain_credit":
      return priced("Gain 1 credit", 1, 0);
    case "basic_draw":
      return priced("Draw 1 card", 1, 0);
    case "basic_trash_resource":
      return priced(`Trash ${name}`, 1, 0);
    case "basic_install": {
      const card = state.cards[intent.cardId];
      return priced(`Install ${name} ${installWhere(intent.destination)}`.trim(), 1, card?.installCost ?? 0);
    }
    case "basic_run":
      return priced(`Run ${serverName(intent.serverId)}`, 1, 0);
    case "basic_remove_tag":
      return priced("Remove 1 tag", 1, 2);
    case "play_event": {
      const card = state.cards[intent.cardId];
      const extra =
        typeof card?.playAdditionalClicks === "number"
          ? card.playAdditionalClicks
          : card?.playAdditionalClick
            ? 1
            : 0;
      const credits = card ? effectiveEventPlayCost(state, card.playCost, card) : 0;
      return priced(`Play ${name}${onServer(intent)}`, 1 + extra, credits);
    }
    case "play_operation": {
      const card = state.cards[intent.cardId];
      const extra = card ? effectiveOperationExtraClicks(state, card) : 0;
      const credits = card
        ? (card.playCost ?? 0) + operationAndEventPlayCostIncreaseTotal(state)
        : 0;
      return priced(`Play ${name}`, 1 + extra, credits);
    }
    case "advance":
      return priced(`Advance ${name}`, 1, 1);
    case "score_agenda":
      return `Score ${name}`;
    case "rez_ice":
    case "rez_asset": {
      const card = state.cards[intent.cardId];
      return priced(`Rez ${name}`, 0, card?.rezCost ?? 0);
    }
    case "use_paid_ability": {
      const card = state.cards[intent.cardId];
      const ability = card?.paidAbilities?.find((item) => item.id === intent.abilityId);
      const hidden = name === "a card";
      const label = (ability?.label ?? name).replaceAll(card?.title ?? "\0", hidden ? "a card" : card?.title ?? "");
      const where = onServer(intent);
      const text = where && !label.toLowerCase().includes(where.trim().toLowerCase()) ? `${label}${where}` : label;
      return withCard(hidden ? undefined : card?.title, describeAbility(text, ability && card ? abilityCost(ability, state, card) : {}));
    }
    case "use_identity_ability": {
      const identity =
        state.cards[state.corp.identityId]?.paidAbilities?.find((item) => item.id === intent.abilityId) ??
        state.cards[state.runner.identityId]?.paidAbilities?.find((item) => item.id === intent.abilityId);
      const source = state.cards[state.corp.identityId]?.paidAbilities?.some((item) => item.id === intent.abilityId)
        ? state.cards[state.corp.identityId]
        : state.cards[state.runner.identityId];
      return withCard(
        seenTitle(state, source?.id, viewer) === "a card" ? undefined : source?.title,
        describeAbility(identity?.label ?? "Identity ability", identity ? abilityCost(identity, state, source) : {}),
      );
    }
    case "choose_option": {
      const option = state.pendingChoice?.options.find((item) => item.id === intent.optionId);
      const source = state.cards[state.pendingChoice?.sourceId ?? ""];
      const sourceTitle = seenTitle(state, source?.id, viewer);
      return withCard(sourceTitle === "a card" ? undefined : source?.title, option?.label ?? "Choose");
    }
    case "break_subroutine": {
      const breaker = state.cards[intent.breakerId];
      return priced(
        `Break subroutine ${intent.subIndex + 1} with ${seenTitle(state, breaker?.id, viewer)}`,
        0,
        breaker?.breaker?.breakCredits ?? 0,
      );
    }
    case "break_bioroid_subroutine":
      return priced(`Break subroutine ${intent.subIndex + 1}`, 1, 0);
    case "break_bioroid_subroutines":
      return priced(`Break ${intent.subIndexes.length} subroutines`, intent.subIndexes.length, 0);
    case "jack_out":
      return "Jack out";
    case "continue_run":
      return "Continue the run";
    case "access_card": {
      const card = state.cards[intent.cardId];
      if (card?.faceup) return `Access ${card.title}`;
      const server = state.run?.attackedServerId;
      if (server === "rd") return "Access the top card of R&D";
      if (server === "hq") return "Access a card from HQ";
      if (server === "archives") return "Access a facedown card in Archives";
      if (server) return `Access a card in ${serverName(server)}`;
      return "Access a card";
    }
    case "finish_breach":
      return "Finish the breach";
    case "finish_access":
      return "Finish accessing";
    case "steal_agenda":
      return `Steal ${name}`;
    case "trash_accessed": {
      const card = state.cards[intent.cardId];
      return priced(`Trash ${name}`, 0, card?.trashCost ?? 0);
    }
    case "discard_to_hand_size":
      return "Discard to hand size";
    default:
      return intent.type.replaceAll("_", " ");
  }
}

function onServer(intent: Intent): string {
  if (!("serverId" in intent) || !intent.serverId) return "";
  return ` on ${serverName(intent.serverId)}`;
}

function seenTitle(state: GameState, id: string | undefined, viewer?: ViewerRole): string {
  if (!id) return "a card";
  const card = state.cards[id];
  if (!card) return "a card";
  if (viewer && !canSeeTitle(card, viewer, secretIds(state, viewer), state.run?.accessingCardId ?? undefined)) return "a card";
  return card.title;
}

function priced(label: string, clicks: number, credits: number, extra: string[] = []): string {
  const parts: string[] = [];
  if (clicks > 0) parts.push(clicks === 1 ? "1 click" : `${clicks} clicks`);
  parts.push(`${credits}¢`);
  parts.push(...extra);
  return `${label} — ${parts.join(", ")}`;
}

function describeAbility(
  label: string,
  cost: { clicks?: number; credits?: number; virusCounters?: number; powerCounters?: number; trashSelf?: boolean },
): string {
  const extra: string[] = [];
  if (cost.virusCounters) extra.push(cost.virusCounters === 1 ? "1 virus counter" : `${cost.virusCounters} virus counters`);
  if (cost.powerCounters) extra.push(cost.powerCounters === 1 ? "1 power counter" : `${cost.powerCounters} power counters`);
  if (cost.trashSelf) extra.push("trash this card");
  return priced(label, cost.clicks ?? 0, cost.credits ?? 0, extra);
}

function serverName(id: string): string {
  if (id === "hq") return "HQ";
  if (id === "rd") return "R&D";
  if (id === "archives") return "Archives";
  if (id.startsWith("remote-")) return `remote ${id.slice("remote-".length)}`;
  return id;
}

function installWhere(destination: { kind: string; serverId?: string; iceId?: string; hostId?: string }): string {
  if (destination.kind === "rig") return "in the rig";
  if (destination.kind === "new_remote") return "in a new remote";
  if (destination.kind === "protect" && destination.serverId) {
    return `protecting ${serverName(destination.serverId)}`;
  }
  if (destination.kind === "remote_root" && destination.serverId) {
    return `in ${serverName(destination.serverId)}`;
  }
  if (destination.kind === "host_ice" || destination.kind === "host_card" || destination.kind === "host_upgrade") {
    return "hosted";
  }
  return "";
}
