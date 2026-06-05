// Contract unit tests for AIDocs — run in plain Node (no VS Code), fast and CI-friendly.
// They guard rule 4 (AGENTS.md): the doc JSON must match schema/document.schema.v1.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import example from "../../../../schema/example.document.json";
import { validateDocumentBytes } from "../../validateDocument";

const encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const clone = <T>(obj: T): T => JSON.parse(JSON.stringify(obj));

test("golden example.document.json validates (incl. table + diagram blocks)", () => {
  const res = validateDocumentBytes(encode(example));
  assert.equal(res.valid, true, res.errors.join("; "));
  assert.equal(res.doc?.doc.id, "model-comparison");
  // The example exercises the declarative block types.
  const types = res.doc?.blocks.map((b) => b.type) ?? [];
  assert.ok(types.includes("table"), "example should contain a table block");
  assert.ok(types.includes("diagram"), "example should contain a diagram block");
  assert.ok(types.includes("chart"), "example should contain a chart block");
});

test("chart block: bad axis scale is rejected", () => {
  const bad = clone(example) as unknown as { blocks: { type: string; xAxis?: { scale: string } }[] };
  const chart = bad.blocks.find((b) => b.type === "chart");
  chart!.xAxis!.scale = "logarithmic";
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("chart block: point missing y is rejected", () => {
  const bad = clone(example) as unknown as {
    blocks: { type: string; series?: { points: { x: number; y?: number }[] }[] }[];
  };
  const chart = bad.blocks.find((b) => b.type === "chart");
  delete chart!.series![0].points[0].y;
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("chart block: interval error bar {low,high} validates", () => {
  const ok = clone(example);
  const res = validateDocumentBytes(encode(ok));
  assert.equal(res.valid, true, res.errors.join("; "));
});

test("chart series: a hex color validates", () => {
  const ok = clone(example) as unknown as { blocks: { type: string; series?: { color?: string }[] }[] };
  const chart = ok.blocks.find((b) => b.type === "chart");
  chart!.series![0].color = "#1f77b4";
  const res = validateDocumentBytes(encode(ok));
  assert.equal(res.valid, true, res.errors.join("; "));
});

test("chart series: a non-hex color is rejected", () => {
  const bad = clone(example) as unknown as { blocks: { type: string; series?: { color?: string }[] }[] };
  const chart = bad.blocks.find((b) => b.type === "chart");
  chart!.series![0].color = "red";
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("wrong schemaVersion is rejected", () => {
  const bad = clone(example);
  (bad as { schemaVersion: string }).schemaVersion = "2.0";
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
  assert.ok(res.errors.length > 0);
});

test("missing required field (doc.title) is rejected", () => {
  const bad = clone(example);
  delete (bad.doc as Partial<typeof bad.doc>).title;
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("unknown extra property is rejected (additionalProperties:false)", () => {
  const bad = clone(example) as Record<string, unknown>;
  bad.surprise = true;
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("non-kebab doc.id is rejected (pattern)", () => {
  const bad = clone(example);
  bad.doc.id = "Not A Slug";
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("null doc.description is allowed (required key, nullable value)", () => {
  const ok = clone(example);
  (ok.doc as { description: string | null }).description = null;
  const res = validateDocumentBytes(encode(ok));
  assert.equal(res.valid, true, res.errors.join("; "));
});

test("table block without rows is rejected", () => {
  const bad = clone(example) as unknown as {
    blocks: { type: string; header?: unknown; rows?: unknown }[];
  };
  const table = bad.blocks.find((b) => b.type === "table");
  delete table!.rows;
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("diagram block without mermaid source is rejected", () => {
  const bad = clone(example) as unknown as {
    blocks: { type: string; mermaid?: unknown }[];
  };
  const diagram = bad.blocks.find((b) => b.type === "diagram");
  delete diagram!.mermaid;
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("unknown block type is rejected", () => {
  const bad = clone(example);
  (bad.blocks as { type: string }[]).push({ type: "video" });
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("figure block referencing a missing figure still validates shape (label is free text)", () => {
  // The schema doesn't cross-check labels (the renderer degrades gracefully); a figure block
  // with any label is structurally valid. This documents that boundary.
  const ok = clone(example);
  (ok.blocks as { type: string; label?: string }[]).push({ type: "figure", label: "Figure 99" });
  const res = validateDocumentBytes(encode(ok));
  assert.equal(res.valid, true, res.errors.join("; "));
});

test("non date-time timestamp is rejected (format validation on)", () => {
  const bad = clone(example);
  bad.generatedBy.timestamp = "not a date";
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("figures[] is optional (a doc with no PDF figures validates)", () => {
  const ok = clone(example) as Record<string, unknown>;
  delete ok.figures;
  const res = validateDocumentBytes(encode(ok));
  assert.equal(res.valid, true, res.errors.join("; "));
});

test("malformed figure bbox (wrong length) is rejected", () => {
  const bad = clone(example) as unknown as { figures: { bbox: number[] | null }[] };
  bad.figures.push({ bbox: [0.1, 0.2, 0.3] } as { bbox: number[] });
  const res = validateDocumentBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("non-JSON bytes produce a clear error, not a throw", () => {
  const res = validateDocumentBytes(new TextEncoder().encode("not json {"));
  assert.equal(res.valid, false);
  assert.match(res.errors[0], /Not valid JSON/);
});
