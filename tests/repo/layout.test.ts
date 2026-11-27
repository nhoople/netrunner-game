/**
 * Repository layout checks (repository layout plan, slice G1).
 *
 * Layout map: README.md's "Layout" section has a table row for every folder
 * in the repo, so an agent can find its way from the map alone. A folder the
 * map leaves out fails here, and so does a row for a folder that is gone.
 *
 * Test placement: tests live under `tests/`, in a folder that mirrors the code
 * they test (`tests/match/` for `src/match/`) or one folder per kind of check
 * (`tests/repo/`, `tests/browser/`). A test file directly in `tests/`, or
 * anywhere outside `tests/`, fails here.
 *
 * Both checks read the files git tracks plus new files it does not ignore, so
 * a new folder or test file fails before its first commit. Ignored folders
 * (`deps/`, `vendor/`, `public/play/`, `data/matches/`, …) are not mapped.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));

function git(args: readonly string[]): string[] {
  // -z: names exactly as stored, never quoted.
  return execFileSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** Files on disk that git tracks or would track: deleted files drop out, new ones count. */
function repoFiles(): string[] {
  const deleted = new Set(git(["--deleted"]));
  return git(["--cached", "--others", "--exclude-standard"]).filter((file) => !deleted.has(file));
}

/** Every folder that holds a file, and every folder above it, written `path/`. */
function foldersOf(files: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const file of files) {
    for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) folders.add(`${dir}/`);
  }
  return folders;
}

/** The folders in the first column of the table under README.md's `## Layout`. */
function mappedFolders(readme: string): Set<string> {
  const section = readme.split(/^## /m).find((part) => part.startsWith("Layout\n"));
  assert.ok(section, 'README.md has no "## Layout" section');
  const folders = new Set<string>();
  for (const line of section.split("\n")) {
    const row = /^\|\s*`([^`]+\/)`\s*\|/.exec(line);
    if (row) folders.add(row[1]!);
  }
  return folders;
}

function layoutMapProblems(files: readonly string[], readme: string): string[] {
  const folders = foldersOf(files);
  const mapped = mappedFolders(readme);
  return [
    ...[...folders]
      .filter((folder) => !mapped.has(folder))
      .map((folder) => `${folder} is missing from README.md's Layout table: add a row saying what it holds`),
    ...[...mapped]
      .filter((folder) => !folders.has(folder))
      .map((folder) => `${folder} is in README.md's Layout table but holds no file: remove its row`),
  ].sort();
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function misplacedTests(files: readonly string[]): string[] {
  return files
    .filter((file) => TEST_FILE.test(file))
    .filter((file) => !file.startsWith("tests/") || posix.dirname(file) === "tests")
    .map((file) =>
      file.startsWith("tests/")
        ? `${file} is in the top tests/ folder: move it to the tests/ folder that mirrors the code it tests`
        : `${file} is outside tests/: move it to the tests/ folder that mirrors its code (npm test runs only tests/**/*.test.ts)`,
    )
    .sort();
}

const readme = readFileSync(join(root, "README.md"), "utf8");

describe("layout map", () => {
  it("README.md's Layout table names every folder in the repo, and no folder that is gone", () => {
    assert.deepEqual(layoutMapProblems(repoFiles(), readme), []);
  });

  it("a made-up folder fails the layout map check, and so does a row for a folder that is gone", () => {
    const files = ["README.md", "src/server.ts", "src/match/match.ts", "src/made-up/thing.ts"];
    const map =
      "## Layout\n\n| Folder | What it holds |\n| --- | --- |\n| `src/` | Code |\n| `src/match/` | A match |\n";
    assert.deepEqual(layoutMapProblems(files, map), [
      "src/made-up/ is missing from README.md's Layout table: add a row saying what it holds",
    ]);
    assert.deepEqual(layoutMapProblems(["src/server.ts"], map), [
      "src/match/ is in README.md's Layout table but holds no file: remove its row",
    ]);
  });
});

describe("test placement", () => {
  it("every test file sits in a folder under tests/, none in the top tests/ folder", () => {
    assert.deepEqual(misplacedTests(repoFiles()), []);
  });

  it("a new test file in the top tests/ folder fails the check", () => {
    assert.deepEqual(misplacedTests(["tests/match/match.test.ts", "tests/new-thing.test.ts"]), [
      "tests/new-thing.test.ts is in the top tests/ folder: move it to the tests/ folder that mirrors the code it tests",
    ]);
  });

  it("a test file beside its code in src/ fails the check", () => {
    assert.deepEqual(misplacedTests(["tests/match/match.test.ts", "src/match/new-thing.test.ts"]), [
      "src/match/new-thing.test.ts is outside tests/: move it to the tests/ folder that mirrors its code (npm test runs only tests/**/*.test.ts)",
    ]);
  });
});
