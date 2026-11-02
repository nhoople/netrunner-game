import {
  paidAbilitiesFromCard,
  playEffectFromCard,
  subroutinesFromCard,
  type GameState,
} from "netrunner-engine";

/** One Effect IR node a seat can read: the op, and the kind when the node is an action. */
export interface CardIr {
  op?: string;
  kind?: string;
}

interface IrNode {
  op?: string;
  action?: { kind?: string };
  effects?: unknown[];
  then?: unknown;
  else?: unknown;
  options?: Array<{ effect?: unknown }>;
}

export function effectIr(effect: unknown): CardIr[] {
  if (!effect || typeof effect !== "object") return [];
  const node = effect as IrNode;
  const self: CardIr[] = [];
  if (node.op || node.action?.kind) {
    self.push({
      ...(node.op ? { op: node.op } : {}),
      ...(node.action?.kind ? { kind: node.action.kind } : {}),
    });
  }
  const nested = [
    ...(node.effects ?? []),
    node.then,
    node.else,
    ...(node.options ?? []).map((option) => option.effect),
  ];
  return [...self, ...nested.flatMap((item) => effectIr(item))];
}

type IrCard = GameState["cards"][string];

/** Play, paid, and subroutine instructions on a card (CR 9.3.7d, 9.3.7b, 9.3.7e). */
export function cardIr(card: IrCard): CardIr[] {
  return [
    ...effectIr(playEffectFromCard(card)),
    ...paidAbilitiesFromCard(card).flatMap((ability) => effectIr(ability.effect)),
    ...subroutinesFromCard(card).flatMap((sub) => effectIr(sub.effect)),
  ];
}

export interface BoardCard {
  id: string;
  defId?: string;
  title?: string;
  type?: string;
  zone?: string;
  faceup?: boolean;
  rezzed?: boolean;
  ir: CardIr[];
}

/**
 * The match's own cards, including facedown deck cards. A seat snapshot does
 * not carry this. The debug view does.
 */
export function internalBoard(state: GameState) {
  const show = (id: string): BoardCard => {
    const card = state.cards[id];
    if (!card) return { id, ir: [] };
    return {
      id,
      defId: card.defId,
      title: card.title,
      type: card.type,
      zone: card.zone,
      faceup: card.faceup,
      rezzed: card.rezzed,
      ir: cardIr(card),
    };
  };
  const pile = (ids: readonly string[]) => ids.map(show);
  return {
    timingKey: state.timingKey,
    turnNumber: state.turnNumber,
    activeSide: state.activeSide,
    done: state.done,
    winner: state.winner,
    corp: {
      credits: state.corp.credits,
      clicks: state.corp.clicks,
      hand: pile(state.corp.hand),
      deck: pile(state.corp.deck),
      discard: pile(state.corp.discardPile),
    },
    runner: {
      credits: state.runner.credits,
      clicks: state.runner.clicks,
      hand: pile(state.runner.hand),
      deck: pile(state.runner.deck),
      discard: pile(state.runner.discardPile),
    },
    servers: Object.values(state.servers).map((server) => ({
      id: server.id,
      ice: pile(server.ice),
      root: pile(server.root),
    })),
    run: state.run
      ? {
          serverId: state.run.attackedServerId,
          phase: state.run.phase,
          successful: state.run.successful,
        }
      : null,
  };
}
