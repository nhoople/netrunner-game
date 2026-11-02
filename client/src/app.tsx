import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { boardModel, type SeatWire } from "./board";
import { Table, type LegalChoice } from "./table";

interface MatchBody {
  matchId?: string;
  error?: string;
  seats?: { corp: string; runner: string; spectator: string; log: string; debug: string };
}

interface LogEntry {
  seq: number;
  summary: string;
}

interface ChatLine {
  from: string;
  text: string;
}

interface Snapshot extends SeatWire {
  type?: string;
  legal?: LegalChoice[];
  log?: LogEntry[];
  chat?: ChatLine[];
}

function tokenFromLocation(): string {
  return new URLSearchParams(location.search).get("token") ?? "";
}

function playLink(token: string): string {
  const url = new URL("play/", `${location.origin}/`);
  url.searchParams.set("token", token);
  return url.pathname + url.search;
}

export function App() {
  const token = tokenFromLocation();
  if (!token) return <Lobby />;
  return <Seat token={token} />;
}

function Lobby() {
  const [status, setStatus] = createSignal("Create a match, then open a seat.");
  const [seats, setSeats] = createSignal<MatchBody["seats"]>();
  const [busy, setBusy] = createSignal(false);

  async function create(payload?: unknown) {
    setBusy(true);
    const res = await fetch("/matches", {
      method: "POST",
      headers: payload ? { "content-type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const body = (await res.json()) as MatchBody;
    setBusy(false);
    if (!res.ok) {
      setStatus(body.error ?? "Could not create the match");
      return;
    }
    setSeats(body.seats);
    setStatus(`Match ${body.matchId ?? ""}`);
  }

  return (
    <main class="app">
      <h1>Netrunner</h1>
      <p class="muted">{status()}</p>
      <p>
        <button type="button" disabled={busy()} onClick={() => void create()}>
          Learn to play
        </button>{" "}
        <button type="button" disabled={busy()} onClick={() => void create({ preset: "expanded" })}>
          Expanded learn to play
        </button>
      </p>
      <Show when={seats()}>
        {(links) => (
          <ul>
            <li><a href={playLink(links().corp)}>Corp</a></li>
            <li><a href={playLink(links().runner)}>Runner</a></li>
            <li><a href={playLink(links().spectator)}>Spectator</a></li>
          </ul>
        )}
      </Show>
      <p class="muted">
        <a href="/">Verification table</a>
      </p>
    </main>
  );
}

function Seat(props: { token: string }) {
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null);
  const [seat, setSeat] = createSignal("");
  const [status, setStatus] = createSignal("Connecting");
  const [error, setError] = createSignal("");
  let socket: WebSocket | undefined;
  let chatInput: HTMLInputElement | undefined;

  onMount(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${location.host}/?token=${encodeURIComponent(props.token)}`);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Snapshot & { type?: string; message?: string; seat?: string; matchId?: string; line?: ChatLine };
      if (message.type === "error") {
        setError(message.message ?? "Error");
        return;
      }
      if (message.type === "welcome") {
        setSeat(message.seat ?? "");
        setStatus(`Match ${message.matchId ?? ""}`);
        return;
      }
      if (message.type === "chat" && message.line) {
        setSnapshot((current) => current ? { ...current, chat: [...(current.chat ?? []), message.line as ChatLine] } : current);
        return;
      }
      if (message.type === "snapshot") {
        setError("");
        setSnapshot(message);
      }
    });
  });

  onCleanup(() => socket?.close());

  function play(choice: LegalChoice) {
    socket?.send(JSON.stringify({
      v: 1,
      type: "intent",
      intentId: crypto.randomUUID(),
      intent: choice.intent,
    }));
  }

  function sendChat(event: SubmitEvent) {
    event.preventDefault();
    const text = chatInput?.value.trim() ?? "";
    if (!text) return;
    socket?.send(JSON.stringify({
      v: 1,
      type: "chat",
      room: seat() === "spectator" ? "spectator" : "table",
      text,
    }));
    if (chatInput) chatInput.value = "";
  }

  const board = () => {
    const current = snapshot();
    return current ? boardModel(current) : null;
  };

  return (
    <main class="app">
      <p class="muted">{status()}{seat() ? ` · ${seat() === "spectator" ? "watching" : seat()}` : ""}</p>
      <Show when={board()} fallback={<p>Waiting for the table.</p>}>
        {(model) => (
          <div class="play">
            <Table board={model()} />
            <section class="panel">
              <h2>Legal plays</h2>
              <div class="plays">
                <For each={snapshot()?.legal ?? []}>
                  {(choice) => (
                    <button type="button" onClick={() => play(choice)}>
                      {choice.label}
                    </button>
                  )}
                </For>
              </div>
              <h2>{model().handLabel}</h2>
              <Show when={model().seesHand} fallback={<p>Hidden. HQ and the grip stay with their seats.</p>}>
                <div class="row">
                  <For each={model().hand}>
                    {(card) => <div class="slot filled"><div class="name">{card.title}</div></div>}
                  </For>
                </div>
              </Show>
              <Show when={model().access}>
                {(card) => (
                  <>
                    <h3>Accessing</h3>
                    <p>{card().title}</p>
                  </>
                )}
              </Show>
              <h2>Game log</h2>
              <div class="log">
                <For each={snapshot()?.log ?? []}>
                  {(entry) => <p>{entry.seq}. {entry.summary}</p>}
                </For>
              </div>
              <h2>Table chat</h2>
              <div class="chat-log">
                <For each={snapshot()?.chat ?? []}>
                  {(line) => <p>{line.from}: {line.text}</p>}
                </For>
              </div>
              <form class="chat" onSubmit={sendChat}>
                <input
                  ref={chatInput}
                  maxlength="500"
                  placeholder={seat() === "spectator" ? "Message other spectators" : "Message the other seat"}
                />
                <button type="submit">Send</button>
              </form>
              <Show when={seat() === "corp" || seat() === "runner"}>
                <p>
                  <button type="button" onClick={() => socket?.send(JSON.stringify({ v: 1, type: "concede" }))}>
                    Concede
                  </button>
                </p>
              </Show>
              <p class="error">{error()}</p>
            </section>
          </div>
        )}
      </Show>
    </main>
  );
}
