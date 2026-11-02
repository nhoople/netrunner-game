/**
 * Layout for the product client. Titles come only from the seat snapshot.
 * CR 10.2.2a: facedown cards, HQ, R&D, the grip, and the stack are hidden
 * information. This module never reads a deck list.
 */

export interface WireCard {
  id?: string;
  title?: string | null;
  type?: string;
  code?: string;
  rezzed?: boolean;
  faceup?: boolean;
  hosted?: number;
  strength?: number;
}

export interface GlossaryCard {
  title: string;
  type: string;
  cost?: string;
  text?: string;
  code?: string;
}

export interface SlotFace {
  empty: boolean;
  hidden: boolean;
  title: string;
  type?: string;
  code?: string | null;
  text?: string;
  rezzed: boolean;
  hosted?: number;
}

export interface PileView {
  identity: SlotFace;
  credits: number;
  clicks: number;
  agendaPoints: number;
  tags: number;
  link: number;
  handCount: number;
  deckCount: number;
  discard: SlotFace;
  score: SlotFace[];
  installed: { programs: SlotFace[]; hardware: SlotFace[]; resources: SlotFace[] };
}

export interface ServerColumn {
  id: string;
  name: string;
  underRun: boolean;
  central: boolean;
  face: SlotFace;
  root: SlotFace[];
  /** Innermost ice first, outermost last (toward the Runner). */
  ice: SlotFace[];
}

export interface BoardModel {
  viewer: string;
  seesHand: boolean;
  handLabel: string;
  hand: SlotFace[];
  corp: PileView;
  runner: PileView;
  servers: ServerColumn[];
  runLabel: string | null;
  access: SlotFace | null;
  removed: SlotFace[];
  setAside: SlotFace[];
  badPublicity: number;
  badPublicityFund: number;
  result: string | null;
  timing: string;
  priority: string;
}

type Glossary = Record<string, GlossaryCard>;

export function serverName(id: string): string {
  if (id === "hq") return "HQ";
  if (id === "rd") return "R&D";
  if (id === "archives") return "Archives";
  if (id.startsWith("remote-")) return `Remote ${id.slice("remote-".length)}`;
  return id || "Server";
}

export function serverRank(id: string): number {
  if (id === "hq") return 0;
  if (id === "rd") return 1;
  if (id === "archives") return 2;
  const n = Number(id.slice("remote-".length));
  return 10 + (Number.isFinite(n) ? n : 0);
}

export function orderedServers<T extends { id: string }>(servers: T[]): T[] {
  return [...servers].sort((a, b) => serverRank(a.id) - serverRank(b.id));
}

/** Public ice lists the outermost piece first. Draw from the server toward the Runner. */
export function iceFromServerTowardRunner<T>(ice: readonly T[]): T[] {
  return [...ice].reverse();
}

export function seatSeesHand(viewer: string): boolean {
  return viewer === "corp" || viewer === "runner";
}

export function hiddenCount(count: number): string {
  if (!count) return "empty";
  if (count === 1) return "1 card";
  return `${count} cards`;
}

export function slotFace(
  card: WireCard | null | undefined,
  glossary: Glossary,
  fallback: string,
): SlotFace {
  if (!card) {
    return { empty: true, hidden: false, title: "empty", rezzed: false };
  }
  const known = card.id ? glossary[card.id] : undefined;
  const title = card.title || known?.title || "";
  if (!title) {
    return {
      empty: false,
      hidden: true,
      title: fallback,
      rezzed: Boolean(card.rezzed),
      hosted: card.hosted,
    };
  }
  return {
    empty: false,
    hidden: false,
    title,
    type: card.type || known?.type,
    code: known?.code ?? card.code ?? null,
    text: known?.text,
    rezzed: Boolean(card.rezzed),
    hosted: card.hosted,
  };
}

interface Pile {
  identity?: string;
  identityId?: string;
  credits?: number;
  clicks?: number;
  scorePoints?: number;
  tags?: number;
  link?: number;
  hand?: string[];
  handCount?: number;
  deckCount?: number;
  discardPileTop?: WireCard | null;
  scoreArea?: Array<string | WireCard>;
  installed?: Array<string | WireCard>;
}

interface ServerWire {
  id: string;
  ice?: WireCard[];
  root?: WireCard[];
}

interface View {
  self?: Pile;
  opponent?: Pile;
  corp?: Pile;
  runner?: Pile;
  servers?: ServerWire[];
  run?: { attackedServerId?: string; phase?: string; accessingCardId?: string };
  removedFromGame?: WireCard[];
  setAside?: WireCard[];
  badPublicity?: number;
  badPublicityFund?: number;
  turnNumber?: number;
  activeSide?: string;
}

export interface SeatWire {
  viewer?: string;
  view?: View;
  glossary?: Glossary;
  access?: GlossaryCard;
  result?: { done?: boolean; winner?: string; hostEnd?: string; winReason?: string };
  timing?: { stepNumber?: string; label?: string; priority?: string };
}

function pileFor(view: View, viewer: string, side: "corp" | "runner"): Pile {
  if (viewer !== "corp" && viewer !== "runner") {
    return (side === "corp" ? view.corp : view.runner) ?? {};
  }
  if (viewer === side) return view.self ?? {};
  return view.opponent ?? {};
}

function asCard(entry: string | WireCard): WireCard {
  return typeof entry === "string" ? { id: entry } : entry;
}

function emptyPile(glossary: Glossary, pile: Pile, side: "corp" | "runner", own: boolean): PileView {
  const identityId = pile.identityId
    ?? Object.entries(glossary).find(([, card]) => card.type === "identity" && card.title === pile.identity)?.[0];
  const handCount = own ? (pile.hand?.length ?? pile.handCount ?? 0) : (pile.handCount ?? 0);
  return {
    identity: identityId
      ? slotFace({ id: identityId }, glossary, "Identity")
      : slotFace(pile.identity ? { title: pile.identity, type: "identity" } : null, glossary, "Identity"),
    credits: pile.credits ?? 0,
    clicks: pile.clicks ?? 0,
    agendaPoints: pile.scorePoints ?? 0,
    tags: pile.tags ?? 0,
    link: pile.link ?? 0,
    handCount,
    deckCount: pile.deckCount ?? 0,
    discard: slotFace(pile.discardPileTop, glossary, side === "corp" ? "Archives" : "Heap"),
    score: (pile.scoreArea ?? []).map((entry) => slotFace(asCard(entry), glossary, "Agenda")),
    installed: {
      programs: installedOf(pile, glossary, "program"),
      hardware: installedOf(pile, glossary, "hardware"),
      resources: installedOf(pile, glossary, "resource"),
    },
  };
}

function installedOf(pile: Pile, glossary: Glossary, type: string): SlotFace[] {
  return (pile.installed ?? [])
    .map((entry) => asCard(entry))
    .filter((card) => {
      const known = card.id ? glossary[card.id] : undefined;
      return (card.type || known?.type) === type;
    })
    .map((card) => slotFace(card, glossary, type));
}

function centralFace(server: ServerWire, pile: Pile, you: boolean, glossary: Glossary): SlotFace {
  if (server.id === "hq") {
    const n = you ? (pile.hand?.length ?? pile.handCount ?? 0) : (pile.handCount ?? 0);
    return { empty: n === 0, hidden: n > 0, title: hiddenCount(n), rezzed: false };
  }
  if (server.id === "rd") {
    const n = pile.deckCount ?? 0;
    return { empty: n === 0, hidden: n > 0, title: hiddenCount(n), rezzed: false };
  }
  return slotFace(pile.discardPileTop, glossary, "Archives");
}

export function boardModel(snapshot: SeatWire): BoardModel {
  const viewer = snapshot.viewer ?? "";
  const view = snapshot.view ?? {};
  const glossary = snapshot.glossary ?? {};
  const corpPile = pileFor(view, viewer, "corp");
  const runnerPile = pileFor(view, viewer, "runner");
  const seesHand = seatSeesHand(viewer);
  const attacked = view.run?.attackedServerId;
  const servers = orderedServers(view.servers ?? []).map((server) => {
    const central = server.id === "hq" || server.id === "rd" || server.id === "archives";
    const rootCards = server.root ?? [];
    return {
      id: server.id,
      name: serverName(server.id),
      underRun: attacked === server.id,
      central,
      face: central
        ? centralFace(server, corpPile, viewer === "corp", glossary)
        : { empty: rootCards.length === 0, hidden: false, title: serverName(server.id), rezzed: false },
      root: rootCards.map((card) => slotFace(card, glossary, "Card")),
      ice: iceFromServerTowardRunner(server.ice ?? []).map((card) => slotFace(card, glossary, "Ice")),
    };
  });
  const liveId = view.run?.accessingCardId;
  const live = liveId ? slotFace({ id: liveId }, glossary, "Card") : null;
  const printed = snapshot.access;
  const access = live && !live.hidden
    ? live
    : printed
      ? slotFace({ title: printed.title, type: printed.type, code: printed.code }, glossary, "Card")
      : live;
  const result = snapshot.result?.done
    ? snapshot.result.winner === "draw" || snapshot.result.winReason === "draw"
      ? "Game over. Draw."
      : `Game over. Winner: ${snapshot.result.winner ?? "none"} ${snapshot.result.hostEnd ?? snapshot.result.winReason ?? ""}`.trim()
    : null;
  const timing = snapshot.timing;
  const turn = `Turn ${view.turnNumber ?? "?"}`;
  const side = view.activeSide === "runner" ? "Runner's turn" : view.activeSide === "corp" ? "Corp's turn" : "";
  const holder = timing?.priority === "corp"
    ? "Corp has priority"
    : timing?.priority === "runner"
      ? "Runner has priority"
      : timing?.priority === "system"
        ? "The game is resolving this step"
        : "";
  const self = viewer === "corp" || viewer === "runner" ? view.self : undefined;
  return {
    viewer,
    seesHand,
    handLabel: viewer === "corp" ? "HQ" : viewer === "runner" ? "Grip" : "Hands",
    hand: seesHand ? (self?.hand ?? []).map((id) => slotFace({ id }, glossary, "Card")) : [],
    corp: emptyPile(glossary, corpPile, "corp", viewer === "corp"),
    runner: emptyPile(glossary, runnerPile, "runner", viewer === "runner"),
    servers,
    runLabel: attacked
      ? `Run on ${serverName(attacked)}${view.run?.phase ? ` · ${view.run.phase}` : ""}`
      : null,
    access,
    removed: (view.removedFromGame ?? []).map((card) => slotFace(card, glossary, "Card")),
    setAside: (view.setAside ?? []).map((card) => slotFace(card, glossary, "Set aside")),
    badPublicity: view.badPublicity ?? 0,
    badPublicityFund: view.badPublicityFund ?? 0,
    result,
    timing: timing ? `Rules ${timing.stepNumber} — ${timing.label}` : "Waiting for the timing step",
    priority: [turn, side, holder].filter(Boolean).join(" · "),
  };
}
