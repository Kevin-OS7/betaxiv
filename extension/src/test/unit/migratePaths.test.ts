// Tests for the pure path/name helpers used by "Copy with Data to Workspace".

import { test } from "node:test";
import assert from "node:assert/strict";
import { betaxivDataPaths, legacyDataPaths, uniqueFileName } from "../../migratePaths";

test("betaxivDataPaths keys every artifact by the content id", () => {
  assert.deepEqual(betaxivDataPaths("1e0651b6810ecba3"), {
    summary: ".betaxiv/summaries/1e0651b6810ecba3.summary.json",
    docsDir: ".betaxiv/docs/1e0651b6810ecba3",
    annotations: ".betaxiv/annotations/1e0651b6810ecba3.json",
  });
});

test("legacyDataPaths keys summary/annotations by the PDF basename (pre-migration layout)", () => {
  assert.deepEqual(legacyDataPaths("resnet"), {
    summary: ".betaxiv/summaries/resnet.summary.json",
    annotations: ".betaxiv/annotations/resnet.json",
  });
});

test("uniqueFileName returns the bare name when the folder is free", () => {
  assert.equal(uniqueFileName(new Set(), "resnet", ".pdf"), "resnet.pdf");
  assert.equal(uniqueFileName(new Set(["other.pdf"]), "resnet", ".pdf"), "resnet.pdf");
});

test("uniqueFileName suffixes ' (n)' on collision, scanning to the first free slot", () => {
  assert.equal(uniqueFileName(new Set(["resnet.pdf"]), "resnet", ".pdf"), "resnet (2).pdf");
  assert.equal(
    uniqueFileName(new Set(["resnet.pdf", "resnet (2).pdf"]), "resnet", ".pdf"),
    "resnet (3).pdf"
  );
  // A gap is reused: (2) is taken but (3) is free even though (4) exists.
  assert.equal(
    uniqueFileName(new Set(["resnet.pdf", "resnet (2).pdf", "resnet (4).pdf"]), "resnet", ".pdf"),
    "resnet (3).pdf"
  );
});
