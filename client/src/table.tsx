import { For, Show, type JSX } from "solid-js";
import type { BoardModel, SlotFace } from "./board";

export interface LegalChoice {
  intent: Record<string, unknown>;
  label: string;
  source?: string;
  cites?: { id: string; number: string }[];
}

function CardSlot(props: { face: SlotFace }): JSX.Element {
  return (
    <div
      class="slot"
      classList={{
        empty: props.face.empty,
        sleeve: props.face.hidden,
        filled: !props.face.empty && !props.face.hidden,
        rezzed: props.face.rezzed,
      }}
      title={props.face.hidden ? undefined : props.face.text}
    >
      <Show when={props.face.hosted}>
        <span class="hosted">{props.face.hosted}</span>
      </Show>
      <Show when={props.face.code}>
        <img
          alt={props.face.title}
          src={`/img/cards/${encodeURIComponent(props.face.code ?? "")}.jpg`}
          onError={(event) => event.currentTarget.remove()}
        />
      </Show>
      <div class="name">{props.face.title}</div>
      <Show when={props.face.type}>
        <div class="where">{props.face.type}</div>
      </Show>
    </div>
  );
}

function Stat(props: { label: string; value: number }): JSX.Element {
  return (
    <div class="stat">
      <b>{props.value}</b>
      <span>{props.label}</span>
    </div>
  );
}

export function Table(props: { board: BoardModel }): JSX.Element {
  const board = () => props.board;
  return (
    <div class="plane">
      <div class="felt">
        <Show when={board().result}>
          <p>{board().result}</p>
        </Show>
        <p class="muted">{board().timing}</p>
        <p class="muted">{board().priority}</p>
        <Show when={board().runLabel}>
          <p>{board().runLabel}</p>
        </Show>
        <div class="corp-bar">
          <div class="identity">
            <CardSlot face={board().corp.identity} />
          </div>
          <Stat label="Agenda" value={board().corp.agendaPoints} />
          <Stat label="Credits" value={board().corp.credits} />
          <Stat label="Clicks" value={board().corp.clicks} />
          <Stat label="Bad publicity" value={board().badPublicity} />
        </div>
        <div class="servers">
          <For each={board().servers}>
            {(server) => (
              <div class="server" classList={{ "under-run": server.underRun }}>
                <div class="server-name">{server.name}</div>
                <Show when={server.central}>
                  <CardSlot face={server.face} />
                </Show>
                <For each={server.root}>
                  {(card) => <CardSlot face={card} />}
                </For>
                <For each={server.ice}>
                  {(card) => <CardSlot face={card} />}
                </For>
              </div>
            )}
          </For>
        </div>
        <div class="runner-near">
          <div class="runner-bar">
            <div class="identity">
              <CardSlot face={board().runner.identity} />
            </div>
            <Stat label="Credits" value={board().runner.credits} />
            <Stat label="Clicks" value={board().runner.clicks} />
            <Stat label="Tags" value={board().runner.tags} />
            <Stat label="Link" value={board().runner.link} />
            <Stat label="Agenda" value={board().runner.agendaPoints} />
          </div>
          <Show when={board().runner.installed.programs.length}>
            <div class="installed-row">
              <h3>Programs</h3>
              <div class="row">
                <For each={board().runner.installed.programs}>
                  {(card) => <CardSlot face={card} />}
                </For>
              </div>
            </div>
          </Show>
          <Show when={board().runner.installed.hardware.length}>
            <div class="installed-row">
              <h3>Hardware</h3>
              <div class="row">
                <For each={board().runner.installed.hardware}>
                  {(card) => <CardSlot face={card} />}
                </For>
              </div>
            </div>
          </Show>
          <Show when={board().runner.installed.resources.length}>
            <div class="installed-row">
              <h3>Resources</h3>
              <div class="row">
                <For each={board().runner.installed.resources}>
                  {(card) => <CardSlot face={card} />}
                </For>
              </div>
            </div>
          </Show>
          <div class="row">
            <CardSlot face={{ empty: board().runner.handCount === 0, hidden: board().runner.handCount > 0, title: board().runner.handCount ? `${board().runner.handCount} in grip` : "empty", rezzed: false }} />
            <CardSlot face={{ empty: board().runner.deckCount === 0, hidden: board().runner.deckCount > 0, title: board().runner.deckCount ? `${board().runner.deckCount} in stack` : "empty", rezzed: false }} />
            <CardSlot face={board().runner.discard} />
          </div>
        </div>
      </div>
    </div>
  );
}
