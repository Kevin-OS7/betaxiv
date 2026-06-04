// Pure (DOM-free) crop geometry, extracted from renderFigureImage so it can be unit-tested
// in plain Node. The bbox is normalized 0..1 against the page's UPRIGHT cropBox viewport
// (PDF.js getViewport — rotation applied, page.view = cropBox). The skill grounds the bbox in
// that exact frame (crop_helper.py renders the same upright cropBox), so these two must agree.

import type { Bbox } from "../protocol";

export interface NormBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  wN: number;
  hN: number;
}

/** Order-normalize + clamp a model bbox to [0,1]. Returns null if it has no area. */
export function normalizeBbox(bbox: Bbox): NormBox | null {
  const [a, b, c, d] = bbox;
  const x0 = Math.max(0, Math.min(1, Math.min(a, c)));
  const x1 = Math.max(0, Math.min(1, Math.max(a, c)));
  const y0 = Math.max(0, Math.min(1, Math.min(b, d)));
  const y1 = Math.max(0, Math.min(1, Math.max(b, d)));
  const wN = x1 - x0;
  const hN = y1 - y0;
  if (wN <= 0 || hN <= 0) return null;
  return { x0, y0, x1, y1, wN, hN };
}

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Map a normalized box to an integer source rectangle on a rendered page canvas of size
 * `vpWidth`×`vpHeight` (the UPRIGHT viewport — for a rotated page these dims are already
 * swapped by PDF.js, so the crop follows the page's displayed orientation). `canvasWidth`/
 * `canvasHeight` are the actual canvas extents (`Math.ceil` of the viewport) used to clamp.
 */
export function sourceRect(
  n: NormBox,
  vpWidth: number,
  vpHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): SourceRect {
  let sx = Math.round(n.x0 * vpWidth);
  let sy = Math.round(n.y0 * vpHeight);
  let sw = Math.round(n.wN * vpWidth);
  let sh = Math.round(n.hN * vpHeight);
  sx = Math.max(0, Math.min(canvasWidth - 1, sx));
  sy = Math.max(0, Math.min(canvasHeight - 1, sy));
  sw = Math.max(1, Math.min(canvasWidth - sx, sw));
  sh = Math.max(1, Math.min(canvasHeight - sy, sh));
  return { sx, sy, sw, sh };
}
