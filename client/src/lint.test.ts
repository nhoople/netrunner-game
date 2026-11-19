import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ESLint } from "eslint";

// Lints a snippet as if it were a client file, with the repo's own
// eslint.config.js, so these tests fail if the Solid rules stop applying.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function lintClient(code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, { filePath: "client/src/lint-fixture.tsx" });
  return result!.messages.map((message) => message.ruleId ?? message.message);
}

describe("client lint", () => {
  it("fails a component that destructures its props, because Solid props lose reactivity", async () => {
    const rules = await lintClient(
      ["export function Credits({ count }: { count: number }) {", "  return <span>{count}</span>;", "}", ""].join("\n"),
    );
    assert.deepEqual(rules, ["solid/no-destructure"]);
  });

  it("passes the same component when it reads props.count", async () => {
    const rules = await lintClient(
      ["export function Credits(props: { count: number }) {", "  return <span>{props.count}</span>;", "}", ""].join(
        "\n",
      ),
    );
    assert.deepEqual(rules, []);
  });
});
