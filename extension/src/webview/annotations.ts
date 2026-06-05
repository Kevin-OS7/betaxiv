// Annotation model + pure geometry, extracted from the webview DOM wiring so the math is
// unit-testable in plain Node (mirrors cropGeometry.ts). A highlight's rects are normalized
// 0..1 against the page's UPRIGHT cropBox viewport — the SAME frame figures use — so they
// stay correct across zoom/relayout and line up with the rendered page exactly.

import type { Annotation, AnnotationRect } from "../protocol";

/** Highlight palette. The first entry is the default; keys are stored in `Annotation.color`. */
export const ANNOTATION_COLORS = [
  "yellow",
  "green",
  "blue",
  "pink",
  "orange",
  "purple",
  "red",
] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];
export const DEFAULT_COLOR: AnnotationColor = "yellow";

/** A DOMRect-like box (only the fields we use), so callers can pass real DOMRects or plain objects. */
export interface BoxLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Rects thinner/shorter than this fraction of the page are dropped — they come from empty
// line boxes or selection edge artifacts and would render as invisible slivers.
const MIN_EXTENT = 0.002;

/**
 * Convert client rects (selection line boxes) to page-normalized rects, relative to the
 * rendered page box `ref`. The browser returns one rect per text run, so a single line comes
 * back as several boxes with gaps at word/punctuation boundaries; we MERGE the boxes on each
 * line into one continuous rect so the highlight reads as a solid bar (no stray gaps). Clamps
 * to [0,1] and drops degenerate slivers.
 */
export function normalizeClientRects(rects: BoxLike[], ref: BoxLike): AnnotationRect[] {
  if (ref.width <= 0 || ref.height <= 0) return [];
  const clamped: AnnotationRect[] = [];
  for (const r of rects) {
    const x0 = clamp01((r.left - ref.left) / ref.width);
    const y0 = clamp01((r.top - ref.top) / ref.height);
    const x1 = clamp01((r.left + r.width - ref.left) / ref.width);
    const y1 = clamp01((r.top + r.height - ref.top) / ref.height);
    if (x1 > x0 && y1 > y0) clamped.push({ x0, y0, x1, y1 });
  }
  return mergeRectsByLine(clamped).filter(
    (r) => r.x1 - r.x0 >= MIN_EXTENT && r.y1 - r.y0 >= MIN_EXTENT
  );
}

/**
 * Collapse rects that sit on the same text line into one spanning box. Two rects share a line
 * when their vertical ranges overlap by more than half the shorter one's height. The result is
 * one rect per line — bridging the word/punctuation gaps the browser leaves between runs.
 */
export function mergeRectsByLine(rects: AnnotationRect[]): AnnotationRect[] {
  if (rects.length <= 1) return rects.map((r) => ({ ...r }));
  const sorted = [...rects].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: AnnotationRect[] = [];
  for (const r of sorted) {
    const line = lines[lines.length - 1];
    if (line && sameLine(line, r)) {
      line.x0 = Math.min(line.x0, r.x0);
      line.y0 = Math.min(line.y0, r.y0);
      line.x1 = Math.max(line.x1, r.x1);
      line.y1 = Math.max(line.y1, r.y1);
    } else {
      lines.push({ ...r });
    }
  }
  return lines;
}

function sameLine(a: AnnotationRect, b: AnnotationRect): boolean {
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const minHeight = Math.min(a.y1 - a.y0, b.y1 - b.y0);
  return minHeight > 0 && overlap > 0.5 * minHeight;
}

/** Map a normalized rect back to pixel offsets on a rendered page of `width`×`height`. */
export function denormRect(
  r: AnnotationRect,
  width: number,
  height: number
): { left: number; top: number; width: number; height: number } {
  return {
    left: r.x0 * width,
    top: r.y0 * height,
    width: (r.x1 - r.x0) * width,
    height: (r.y1 - r.y0) * height,
  };
}

/** Smallest box covering all rects, or null if there are none. */
export function unionBbox(rects: AnnotationRect[]): AnnotationRect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x0);
    y0 = Math.min(y0, r.y0);
    x1 = Math.max(x1, r.x1);
    y1 = Math.max(y1, r.y1);
  }
  return { x0, y0, x1, y1 };
}

/** Hit-test a normalized point (e.g. a click position) against a set of normalized rects. */
export function pointInRects(px: number, py: number, rects: AnnotationRect[]): boolean {
  return rects.some((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * In-memory annotation set. Loading from the host (`setAll`) does NOT fire `onChange` — only
 * user edits (add/update/remove) do, so the host write is never echoed straight back as a
 * change. `update`/`remove` no-op on an unknown id.
 */
export class AnnotationStore {
  private items: Annotation[] = [];

  constructor(private readonly onChange: (items: Annotation[]) => void = () => {}) {}

  setAll(items: Annotation[]): void {
    this.items = items.slice();
  }

  list(): Annotation[] {
    return this.items;
  }

  byPage(page: number): Annotation[] {
    return this.items.filter((a) => a.page === page);
  }

  get(id: string): Annotation | undefined {
    return this.items.find((a) => a.id === id);
  }

  add(a: Annotation): void {
    this.items.push(a);
    this.onChange(this.items);
  }

  update(id: string, patch: Partial<Omit<Annotation, "id">>): Annotation | undefined {
    const a = this.get(id);
    if (!a) return undefined;
    Object.assign(a, patch);
    this.onChange(this.items);
    return a;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((a) => a.id !== id);
    const removed = this.items.length !== before;
    if (removed) this.onChange(this.items);
    return removed;
  }
}
