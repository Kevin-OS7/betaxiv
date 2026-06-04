// Crop-frame regression tests for the figure cropper (issue: figures cropped loosely, pulling
// in author blocks/captions). They lock the contract that the bbox is interpreted in the
// page's UPRIGHT cropBox frame — the same frame the skill's crop_helper.py grounds in — so a
// rotated or cropped-offset page can't drift. Pure math, no PDF.js/DOM needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bbox } from "../../protocol";
import { normalizeBbox, sourceRect } from "../../webview/cropGeometry";

test("normalizeBbox orders reversed corners and clamps out-of-range", () => {
  // x emitted high→low, y in range but with a negative/over-1 spill.
  const n = normalizeBbox([0.8, -0.1, 0.2, 1.4] as Bbox);
  assert.ok(n);
  assert.deepEqual([n.x0, n.y0, n.x1, n.y1], [0.2, 0, 0.8, 1]);
  assert.ok(Math.abs(n.wN - 0.6) < 1e-9);
  assert.equal(n.hN, 1);
});

test("normalizeBbox rejects zero-area boxes", () => {
  assert.equal(normalizeBbox([0.5, 0.5, 0.5, 0.9] as Bbox), null); // zero width
  assert.equal(normalizeBbox([0.1, 0.3, 0.9, 0.3] as Bbox), null); // zero height
});

test("sourceRect maps normalized box to pixels on a portrait viewport", () => {
  // A 612x792pt page rendered at scale 2 => 1224x1584 canvas.
  const n = normalizeBbox([0.5, 0.28, 0.93, 0.38] as Bbox)!;
  const r = sourceRect(n, 1224, 1584, 1224, 1584);
  assert.equal(r.sx, Math.round(0.5 * 1224));
  assert.equal(r.sy, Math.round(0.28 * 1584));
  assert.equal(r.sw, Math.round(0.43 * 1224));
  assert.equal(r.sh, Math.round(0.1 * 1584));
});

test("sourceRect follows the UPRIGHT (rotated) viewport — dims are swapped by PDF.js", () => {
  // A landscape-rotated page: PDF.js getViewport returns swapped dims (height<width). The same
  // normalized box must map against THOSE dims, not the un-rotated page size. This is the
  // regression guard for rotation != 0.
  const n = normalizeBbox([0.1, 0.2, 0.6, 0.5] as Bbox)!;
  const r = sourceRect(n, 1584, 1224, 1584, 1224); // width 1584 > height 1224 (rotated)
  assert.equal(r.sx, Math.round(0.1 * 1584));
  assert.equal(r.sy, Math.round(0.2 * 1224));
  assert.equal(r.sw, Math.round(0.5 * 1584));
  assert.equal(r.sh, Math.round(0.3 * 1224));
});

test("sourceRect clamps the rect inside the canvas bounds", () => {
  // Box hugging the right/bottom edge stays within [0, canvas) with >=1px extent.
  const n = normalizeBbox([0.95, 0.95, 1.0, 1.0] as Bbox)!;
  const r = sourceRect(n, 1000, 1000, 1000, 1000);
  assert.ok(r.sx + r.sw <= 1000);
  assert.ok(r.sy + r.sh <= 1000);
  assert.ok(r.sw >= 1 && r.sh >= 1);
});
