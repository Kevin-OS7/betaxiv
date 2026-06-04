// Tests for the annotation geometry + store. Pure math / data — no PDF.js or DOM. The rects
// are normalized 0..1 against the rendered page box (the same upright cropBox frame figures
// use), so highlights stay aligned across zoom/relayout; these lock that mapping and the
// store's edit/load semantics.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Annotation, AnnotationRect } from "../../protocol";
import {
  AnnotationStore,
  normalizeClientRects,
  mergeRectsByLine,
  denormRect,
  unionBbox,
  pointInRects,
} from "../../webview/annotations";

const REF = { left: 100, top: 50, width: 400, height: 600 };

function annotation(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "id-1",
    page: 1,
    rects: [{ x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2 }],
    text: "hello",
    note: "",
    color: "yellow",
    createdAt: "2026-06-05T00:00:00Z",
    updatedAt: "2026-06-05T00:00:00Z",
    ...over,
  };
}

test("normalizeClientRects maps a line box to page-normalized coords", () => {
  const [r] = normalizeClientRects([{ left: 140, top: 80, width: 200, height: 20 }], REF);
  assert.ok(Math.abs(r.x0 - 0.1) < 1e-9);
  assert.ok(Math.abs(r.y0 - 0.05) < 1e-9);
  assert.ok(Math.abs(r.x1 - 0.6) < 1e-9);
  assert.ok(Math.abs(r.y1 - 0.08333333) < 1e-6);
});

test("normalizeClientRects clamps a box spilling past the page edge into [0,1]", () => {
  const [r] = normalizeClientRects([{ left: 50, top: 40, width: 100, height: 30 }], REF);
  assert.equal(r.x0, 0); // left:50 is left of ref.left:100 → clamped to 0
  assert.equal(r.y0, 0);
  assert.ok(Math.abs(r.x1 - 0.125) < 1e-9);
});

test("normalizeClientRects merges runs on one line and drops a sliver line", () => {
  const rects = normalizeClientRects(
    [
      { left: 140, top: 80, width: 60, height: 20 }, // run 1 of the line
      { left: 210, top: 80, width: 80, height: 20 }, // run 2 (gap before it) → merges
      { left: 140, top: 200, width: 200, height: 0.4 }, // sliver-height line → dropped
    ],
    REF
  );
  assert.equal(rects.length, 1);
  // The merged line bridges the gap between the two runs: x spans 140..290.
  assert.ok(Math.abs(rects[0].x0 - 0.1) < 1e-9); // (140-100)/400
  assert.ok(Math.abs(rects[0].x1 - 0.475) < 1e-9); // (290-100)/400
});

test("mergeRectsByLine bridges gaps within a line but keeps separate lines apart", () => {
  const merged = mergeRectsByLine([
    { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.14 }, // line A, run 1
    { x0: 0.35, y0: 0.1, x1: 0.6, y1: 0.14 }, // line A, run 2 (gap) → merge
    { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.24 }, // line B → stays separate
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.14 });
  assert.deepEqual(merged[1], { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.24 });
});

test("normalizeClientRects returns nothing for a zero-size reference", () => {
  assert.deepEqual(
    normalizeClientRects([{ left: 0, top: 0, width: 10, height: 10 }], { left: 0, top: 0, width: 0, height: 0 }),
    []
  );
});

test("denormRect inverts the normalization onto a rendered page size", () => {
  const r: AnnotationRect = { x0: 0.1, y0: 0.05, x1: 0.6, y1: 0.25 };
  const box = denormRect(r, 400, 600);
  assert.deepEqual(box, { left: 40, top: 30, width: 200, height: 120 });
});

test("unionBbox covers all rects; null when empty", () => {
  assert.equal(unionBbox([]), null);
  const u = unionBbox([
    { x0: 0.2, y0: 0.3, x1: 0.4, y1: 0.5 },
    { x0: 0.1, y0: 0.35, x1: 0.6, y1: 0.45 },
  ]);
  assert.deepEqual(u, { x0: 0.1, y0: 0.3, x1: 0.6, y1: 0.5 });
});

test("pointInRects hits inside and misses outside", () => {
  const rects: AnnotationRect[] = [{ x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.4 }];
  assert.equal(pointInRects(0.3, 0.3, rects), true);
  assert.equal(pointInRects(0.6, 0.3, rects), false);
});

test("AnnotationStore.setAll does not fire onChange; edits do", () => {
  let changes = 0;
  const store = new AnnotationStore(() => changes++);

  store.setAll([annotation({ id: "a", page: 1 })]);
  assert.equal(changes, 0, "loading from host must not echo back as a change");

  store.add(annotation({ id: "b", page: 2 }));
  assert.equal(changes, 1);
  assert.equal(store.list().length, 2);

  assert.deepEqual(store.byPage(2).map((a) => a.id), ["b"]);

  store.update("a", { note: "x" });
  assert.equal(changes, 2);
  assert.equal(store.get("a")?.note, "x");

  assert.equal(store.update("missing", { note: "y" }), undefined);
  assert.equal(changes, 2, "no-op update must not fire onChange");

  assert.equal(store.remove("a"), true);
  assert.equal(changes, 3);
  assert.equal(store.remove("missing"), false);
  assert.equal(changes, 3);
});
