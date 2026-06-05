// Unit tests for the pure content-id core (no VS Code) — guards the rename/move logic the
// extension relies on: stable ids, workspace-relative keys, title upsert, and index re-pointing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentIdFromBytes,
  relativizePath,
  setTitle,
  repathEntries,
  CONTENT_ID_LEN,
  type ContentIndex,
} from "../../contentIndexCore";

const idx = (entries: ContentIndex["entries"]): ContentIndex => ({
  version: 1,
  note: "",
  entries,
});

test("contentIdFromBytes is the SHA-256 hex prefix, deterministic and length-capped", () => {
  // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  const id = contentIdFromBytes(new TextEncoder().encode("hello"));
  assert.equal(id, "2cf24dba5fb0a30e");
  assert.equal(id.length, CONTENT_ID_LEN);
  assert.equal(contentIdFromBytes(new TextEncoder().encode("hello")), id); // stable
  assert.notEqual(contentIdFromBytes(new TextEncoder().encode("hello!")), id);
});

test("relativizePath: inside, trailing slash, equal, and outside the base", () => {
  assert.equal(relativizePath("/ws", "/ws/papers/a.pdf"), "papers/a.pdf");
  assert.equal(relativizePath("/ws/", "/ws/papers/a.pdf"), "papers/a.pdf"); // base trailing slash
  assert.equal(relativizePath("/ws", "/ws"), ""); // the folder itself
  assert.equal(relativizePath("/ws", "/elsewhere/a.pdf"), "a.pdf"); // outside → basename
});

test("setTitle only writes a real, changed title", () => {
  const i = idx({ "papers/a.pdf": { hash: "h", size: 1 } });
  assert.equal(setTitle(i, "papers/a.pdf", "Title"), true);
  assert.equal(i.entries["papers/a.pdf"].title, "Title");
  assert.equal(setTitle(i, "papers/a.pdf", "Title"), false); // unchanged
  assert.equal(setTitle(i, "papers/a.pdf", ""), false); // empty ignored
  assert.equal(setTitle(i, "papers/missing.pdf", "X"), false); // no entry
});

test("repathEntries rewrites a single renamed PDF key", () => {
  const i = idx({
    "papers/a.pdf": { hash: "h1", size: 1 },
    "papers/b.pdf": { hash: "h2", size: 2 },
  });
  assert.equal(repathEntries(i, "papers/a.pdf", "papers/renamed.pdf"), true);
  assert.deepEqual(Object.keys(i.entries).sort(), ["papers/b.pdf", "papers/renamed.pdf"]);
  assert.equal(i.entries["papers/renamed.pdf"].hash, "h1"); // id preserved, no re-hash
  assert.equal(i.entries["papers/b.pdf"].hash, "h2"); // unrelated entry untouched
});

test("repathEntries rewrites every descendant when a folder is moved", () => {
  const i = idx({
    "papers/x/a.pdf": { hash: "h1", size: 1 },
    "papers/x/sub/b.pdf": { hash: "h2", size: 2 },
    "papers/y/c.pdf": { hash: "h3", size: 3 },
  });
  assert.equal(repathEntries(i, "papers/x", "archive/x"), true);
  assert.deepEqual(
    Object.keys(i.entries).sort(),
    ["archive/x/a.pdf", "archive/x/sub/b.pdf", "papers/y/c.pdf"]
  );
});

test("repathEntries is a no-op when nothing matches", () => {
  const i = idx({ "papers/a.pdf": { hash: "h1", size: 1 } });
  assert.equal(repathEntries(i, "papers/zzz.pdf", "papers/q.pdf"), false);
  assert.deepEqual(Object.keys(i.entries), ["papers/a.pdf"]);
});
