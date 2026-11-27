import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boardModel,
  iceFromServerTowardRunner,
  orderedServers,
  playsModel,
  type LegalChoice,
  type SeatWire,
} from "../../client/src/board.js";

describe("product board", () => {
  it("draws ice from the server toward the Runner", () => {
    const toward = iceFromServerTowardRunner([{ id: "outer" }, { id: "inner" }]);
    assert.deepEqual(
      toward.map((card) => card.id),
      ["inner", "outer"],
    );
    assert.deepEqual(
      orderedServers([{ id: "remote-1" }, { id: "archives" }, { id: "hq" }, { id: "rd" }]).map((server) => server.id),
      ["hq", "rd", "archives", "remote-1"],
    );
  });

  it("keeps hidden zones as counts (CR 10.2.2a)", () => {
    // These carry fields the board model must never read (deck contents and
    // card definition ids). They are named first, not written inline, so the
    // extra fields typecheck: TypeScript rejects unknown fields only on an
    // object literal written in place.
    const runnerSelf = {
      identityId: "id-r",
      hand: ["grip-1"],
      deckCount: 20,
      deck: [{ title: "Diesel" }],
    };
    const corpOpponent = {
      identity: "The Syndicate",
      handCount: 5,
      deckCount: 34,
      deck: [{ title: "Hedge Fund", defId: "hedge-fund" }],
    };
    const facedownIce = { id: "ice-1", defId: "ice-wall" };
    const snapshot: SeatWire = {
      viewer: "runner",
      glossary: {
        "id-r": { title: "The Catalyst", type: "identity" },
        "grip-1": { title: "Sure Gamble", type: "event", text: "Gain 9." },
      },
      view: {
        self: runnerSelf,
        opponent: corpOpponent,
        servers: [
          {
            id: "hq",
            ice: [facedownIce],
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

  it("takes card images from the snapshot's links", () => {
    const image = "https://card-images.netrunnerdb.com/v2/large/30001.jpg";
    const snapshot: SeatWire = {
      viewer: "spectator",
      glossary: { "id-r": { title: 'René "Loup" Arcemont', type: "identity", code: "30001", image } },
      view: {
        corp: { identity: "Corp" },
        runner: { identityId: "id-r" },
        servers: [],
      } as SeatWire["view"] extends infer V ? V : never,
    };
    assert.equal(boardModel(snapshot).runner.identity.image, image);
  });

  it("groups plays by the host's group and finds the primary one", () => {
    const legal: LegalChoice[] = [
      {
        intent: { type: "basic_gain_credit" },
        label: "Gain 1 credit",
        group: "basic",
        anchor: { kind: "none" },
        default: true,
      },
      {
        intent: { type: "basic_install" },
        label: "Install A in a new remote",
        group: "install",
        anchor: { kind: "card", cardId: "hq-1" },
        target: { kind: "new_remote" },
      },
      {
        intent: { type: "basic_install" },
        label: "Install A protecting HQ",
        group: "install",
        anchor: { kind: "card", cardId: "hq-1" },
        target: { kind: "server", serverId: "hq" },
      },
      {
        intent: { type: "use_paid_ability" },
        label: "Ability",
        group: "ability",
        anchor: { kind: "card", cardId: "corp-id" },
      },
    ];
    const model = playsModel(legal);
    assert.deepEqual(
      model.groups.map((group) => group.group),
      ["ability", "install", "basic"],
    );
    assert.equal(model.primary?.index, 0);
    assert.equal(model.byAnchor.get("card:hq-1")?.length, 2);
    assert.deepEqual(
      model.groups[1]!.plays.map((play) => play.target.kind),
      ["new_remote", "server"],
    );
  });

  it("has no primary play while the other seat decides", () => {
    const model = playsModel([]);
    assert.equal(model.primary, null);
    assert.deepEqual(model.groups, []);
  });

  it("never reads the intent's fields", () => {
    // An intent with throwing getters: building the model must not touch it.
    const intent = new Proxy(
      {},
      {
        get() {
          throw new Error("read an intent field");
        },
        ownKeys() {
          throw new Error("read an intent field");
        },
      },
    );
    const model = playsModel([{ intent, label: "Pass", group: "window", anchor: { kind: "none" }, default: true }]);
    assert.equal(model.primary?.label, "Pass");
  });

  it("files an entry without the new fields as an unanchored choice", () => {
    const model = playsModel([{ intent: {}, label: "Old host" }]);
    assert.equal(model.groups[0]?.group, "choice");
    assert.equal(model.primary, null);
  });
});
