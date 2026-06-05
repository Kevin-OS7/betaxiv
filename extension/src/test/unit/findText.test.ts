// Tests for the pure find helpers (Ctrl+F): case folding, occurrence location, flattening matches
// across pages, and per-page ordinal mapping. The DOM side (Ranges, CSS Highlight API, scrolling)
// lives in webview.ts and is exercised manually / by integration.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldCase,
  locateAll,
  buildPdfMatches,
  ordinalInPage,
  type PageText,
} from "../../webview/findText";

test("foldCase lowercases unless case-sensitive", () => {
  assert.equal(foldCase("AbC", false), "abc");
  assert.equal(foldCase("AbC", true), "AbC");
});

test("locateAll finds every non-overlapping occurrence", () => {
  assert.deepEqual(locateAll("abracadabra", "abra"), [0, 7]);
  assert.deepEqual(locateAll("the cat sat", "at"), [5, 9]);
});

test("locateAll is non-overlapping for repeated runs", () => {
  // "aa" in "aaaa": positions 0 and 2, not 0/1/2 (next search starts past the match).
  assert.deepEqual(locateAll("aaaa", "aa"), [0, 2]);
});

test("locateAll returns [] for no match or empty needle", () => {
  assert.deepEqual(locateAll("hello", "z"), []);
  assert.deepEqual(locateAll("hello", ""), []);
});

test("buildPdfMatches orders by page then position, case-insensitively", () => {
  const pages: PageText[] = [
    { pageNum: 1, text: "Transformer uses attention. Attention is all." },
    { pageNum: 2, text: "no hits here" },
    { pageNum: 3, text: "attention again" },
  ];
  assert.deepEqual(buildPdfMatches(pages, "attention"), [
    { pageNum: 1, start: 17 }, // "Transformer uses " is 17 chars
    { pageNum: 1, start: 28 },
    { pageNum: 3, start: 0 },
  ]);
});

test("buildPdfMatches honors case sensitivity", () => {
  const pages: PageText[] = [{ pageNum: 1, text: "Attention attention" }];
  assert.deepEqual(buildPdfMatches(pages, "Attention", true), [{ pageNum: 1, start: 0 }]);
  assert.equal(buildPdfMatches(pages, "attention", false).length, 2);
});

test("buildPdfMatches returns [] for an empty/whitespace query", () => {
  const pages: PageText[] = [{ pageNum: 1, text: "anything" }];
  assert.deepEqual(buildPdfMatches(pages, ""), []);
  assert.deepEqual(buildPdfMatches(pages, "   "), []);
});

test("ordinalInPage counts earlier matches on the same page", () => {
  const matches = buildPdfMatches(
    [
      { pageNum: 1, text: "x x" }, // two matches of "x" → starts 0,2
      { pageNum: 2, text: "x" }, // one match
    ],
    "x"
  );
  // matches: [{1,0},{1,2},{2,0}]
  assert.equal(ordinalInPage(matches, 0), 0); // first on page 1
  assert.equal(ordinalInPage(matches, 1), 1); // second on page 1
  assert.equal(ordinalInPage(matches, 2), 0); // first on page 2
  assert.equal(ordinalInPage(matches, 99), 0); // out of range
});
