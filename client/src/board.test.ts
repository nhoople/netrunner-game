import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boardModel, iceFromServerTowardRunner, orderedServers, type SeatWire } from "./board.js";

describe("product board", () => {
  it("draws ice from the server toward the Runner", () => {
    const toward = iceFromServerTowardRunner([
      { id: "outer" },
      { id: "inner" },
    ]);
    assert.deepEqual(toward.map((card) => card.id), ["inner", "outer"]);
    assert.deepEqual(
      orderedServers([{ id: "remote-1" }, { id: "archives" }, { id: "hq" }, { id: "rd" }]).map((server) => server.id),
      ["hq", "rd", "archives", "remote-1"],
    );
  });

  it("keeps hidden zones as counts (CR 10.2.2a)", () => {
    const snapshot: SeatWire = {
      viewer: "runner",
      glossary: {
        "id-r": { title: "The Catalyst", type: "identity" },
        "grip-1": { title: "Sure Gamble", type: "event", text: "Gain 9." },
      },
      view: {
        self: {
          identityId: "id-r",
          hand: ["grip-1"],
          deckCount: 20,
          deck: [{ title: "Diesel" }],
        } as SeatWire["view"] extends infer V ? V : never,
        opponent: {
          identity: "The Syndicate",
          handCount: 5,
          deckCount: 34,
          deck: [{ title: "Hedge Fund", defId: "hedge-fund" }],
        } as SeatWire["view"] extends infer V ? V : never,
        servers: [
          {
            id: "hq",
            ice: [{ id: "ice-1", defId: "ice-wall" }],
            root: [],
          },
          { id: "rd", ice: [], root: [] },
          { id: "archives", ice: [], root: [] },
        ],
      },
    };
    const board = boardModel(snapshot);
    const hq = board.servers.find((server) => server.id === "hq");
    assert.equal(hq?.ice[0]?.hidden, true);
    assert.equal(hq?.ice[0]?.title, "Ice");
    assert.equal(board.hand.map((card) => card.title).join(","), "Sure Gamble");
    assert.equal(board.corp.deckCount, 34);
    assert.equal(board.corp.handCount, 5);
    const rendered = JSON.stringify(board);
    assert.equal(rendered.includes("Hedge Fund"), false);
    assert.equal(rendered.includes("hedge-fund"), false);
    assert.equal(rendered.includes("ice-wall"), false);
    assert.equal(rendered.includes("Diesel"), false);
  });

  it("shows a spectator neither hand", () => {
    const board = boardModel({
      viewer: "spectator",
      view: {
        corp: { handCount: 5, hand: ["secret"] },
        runner: { handCount: 5, hand: ["secret-2"] },
        servers: [],
      },
    });
    assert.equal(board.seesHand, false);
    assert.deepEqual(board.hand, []);
    assert.equal(board.corp.handCount, 5);
    assert.equal(JSON.stringify(board).includes("secret"), false);
  });
});
