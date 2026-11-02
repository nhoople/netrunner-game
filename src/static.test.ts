import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentType, publicFile } from "./static.js";

describe("static files", () => {
  it("serves the product client index and its script type", () => {
    assert.equal(publicFile("/play"), "play/index.html");
    assert.equal(publicFile("/play/"), "play/index.html");
    assert.equal(publicFile("/play/index.html"), "play/index.html");
    assert.equal(publicFile("/play/assets/index.js"), "play/assets/index.js");
    assert.equal(contentType(".js"), "text/javascript; charset=utf-8");
    assert.equal(contentType(".css"), "text/css; charset=utf-8");
  });

  it("keeps the verification table at /", () => {
    assert.equal(publicFile("/"), "table.html");
    assert.equal(publicFile("/table.html"), "table.html");
  });

  it("rejects a path that escapes public/", () => {
    assert.ok(publicFile("/play/../../package.json").startsWith(".."));
  });
});
