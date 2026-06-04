// Tests for copy reflow: wrapped lines within a paragraph join (de-hyphenating split words),
// and a line that ends short of the right margin starts a new paragraph. Pure geometry — the
// `left`/`right` are pixel x-coordinates of each line's extent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reflowLines } from "../../webview/textReflow";

test("wrapped lines in a paragraph join with a single space", () => {
  // Both lines reach the right margin (right=100), so they are one flowing paragraph.
  const out = reflowLines([
    { text: "the quick brown", left: 0, right: 100 },
    { text: "fox jumps over", left: 0, right: 98 },
  ]);
  assert.equal(out, "the quick brown fox jumps over");
});

test("a short line marks a paragraph end → newline before the next line", () => {
  const out = reflowLines([
    { text: "End of the paragraph.", left: 0, right: 55 }, // stops well short of margin
    { text: "A new paragraph begins here", left: 0, right: 100 },
  ]);
  assert.equal(out, "End of the paragraph.\nA new paragraph begins here");
});

test("a word split across a line break rejoins without space or hyphen", () => {
  const out = reflowLines([
    { text: "we reformulate the repre-", left: 0, right: 100 },
    { text: "sentation of layers", left: 0, right: 70 },
  ]);
  assert.equal(out, "we reformulate the representation of layers");
});

test("blank / whitespace-only lines are dropped", () => {
  const out = reflowLines([
    { text: "first line of text", left: 0, right: 100 },
    { text: "   ", left: 0, right: 4 },
    { text: "second line of text", left: 0, right: 99 },
  ]);
  assert.equal(out, "first line of text second line of text");
});

test("a single line is returned trimmed", () => {
  assert.equal(reflowLines([{ text: "  just one line  ", left: 0, right: 80 }]), "just one line");
});

test("empty input yields empty string", () => {
  assert.equal(reflowLines([]), "");
});
