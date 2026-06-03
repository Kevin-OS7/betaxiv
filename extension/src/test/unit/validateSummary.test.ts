// Contract unit tests — run in plain Node (no VS Code), so they're fast and CI-friendly.
// They guard rule 4 (AGENTS.md): the summary JSON must match schema/summary.schema.v1.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import example from "../../../../schema/example.summary.json";
import { validateSummaryBytes } from "../../validateSummary";

const encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const clone = <T>(obj: T): T => JSON.parse(JSON.stringify(obj));

test("golden example.summary.json validates", () => {
  const res = validateSummaryBytes(encode(example));
  assert.equal(res.valid, true, res.errors.join("; "));
  assert.equal(res.summary?.paper.title, "Attention Is All You Need");
});

test("wrong schemaVersion is rejected", () => {
  const bad = clone(example);
  (bad as { schemaVersion: string }).schemaVersion = "2.0";
  const res = validateSummaryBytes(encode(bad));
  assert.equal(res.valid, false);
  assert.ok(res.errors.length > 0);
});

test("missing required field (summary.tldr) is rejected", () => {
  const bad = clone(example);
  delete (bad.summary as Partial<typeof bad.summary>).tldr;
  const res = validateSummaryBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("unknown extra property is rejected (additionalProperties:false)", () => {
  const bad = clone(example) as Record<string, unknown>;
  bad.surprise = true;
  const res = validateSummaryBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("null page anchor is allowed (required key, nullable value)", () => {
  const ok = clone(example);
  (ok.summary.sections[0] as { page: number | null }).page = null;
  const res = validateSummaryBytes(encode(ok));
  assert.equal(res.valid, true, res.errors.join("; "));
});

test("non date-time timestamp is rejected (format validation on)", () => {
  const bad = clone(example);
  bad.generatedBy.timestamp = "not a date";
  const res = validateSummaryBytes(encode(bad));
  assert.equal(res.valid, false);
});

test("valid ISO date-time timestamp is accepted", () => {
  const ok = clone(example);
  ok.generatedBy.timestamp = "2026-06-03T12:34:56Z";
  const res = validateSummaryBytes(encode(ok));
  assert.equal(res.valid, true, res.errors.join("; "));
});

test("non-JSON bytes produce a clear error, not a throw", () => {
  const res = validateSummaryBytes(new TextEncoder().encode("not json {"));
  assert.equal(res.valid, false);
  assert.match(res.errors[0], /Not valid JSON/);
});
