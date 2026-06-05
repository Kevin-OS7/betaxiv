// Tests for the pure "Ref" provenance line builder used by Copy^p.

import { test } from "node:test";
import assert from "node:assert/strict";
import { refValue, buildRefLine, buildCopyPayload } from "../../webview/refLine";

test("refValue leaves bare tokens unquoted", () => {
  assert.equal(refValue("papers/foo.pdf"), "papers/foo.pdf");
  assert.equal(refValue("4"), "4");
});

test("refValue quotes values with whitespace/commas, escaping quotes", () => {
  assert.equal(refValue("Figure 2"), '"Figure 2"');
  assert.equal(refValue("a, b"), '"a, b"');
  assert.equal(refValue('say "hi"'), '"say \\"hi\\""');
});

test("buildRefLine puts path first and drops empty/undefined fields", () => {
  assert.equal(
    buildRefLine("papers/foo.pdf", [
      ["page", 4],
      ["fig", undefined],
    ]),
    "Ref path=papers/foo.pdf, page=4"
  );
});

test("buildRefLine keeps numbers bare and always quotes free-text fields", () => {
  assert.equal(
    buildRefLine("papers/foo.pdf", [
      ["page", 4],
      ["fig", "Figure 2"],
    ]),
    'Ref path=papers/foo.pdf, page=4, fig="Figure 2"'
  );
  // A single-word sec is still quoted (the field is free text), and the page badge is its own key.
  assert.equal(
    buildRefLine("x.doc.json", [
      ["fig", ""],
      ["sec", "Method"],
      ["page", 5],
    ]),
    'Ref path=x.doc.json, sec="Method", page=5'
  );
});

test("buildRefLine quotes a path containing spaces and escapes quotes in fields", () => {
  assert.equal(buildRefLine("my papers/a b.pdf", []), 'Ref path="my papers/a b.pdf"');
  assert.equal(buildRefLine("x", [["sec", 'A "B"']]), 'Ref path=x, sec="A \\"B\\""');
});

test("buildCopyPayload fences the selection under the Ref line", () => {
  assert.equal(
    buildCopyPayload("Ref path=papers/foo.pdf, page=4", "the quick\nbrown fox"),
    "Ref path=papers/foo.pdf, page=4\n===SELECTED TEXT===\nthe quick\nbrown fox\n===/SELECTED TEXT==="
  );
});

test("buildCopyPayload with no Ref yields just the fenced text", () => {
  assert.equal(
    buildCopyPayload("", "hello"),
    "===SELECTED TEXT===\nhello\n===/SELECTED TEXT==="
  );
});
