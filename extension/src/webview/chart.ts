// Dependency-free scatter/line chart renderer for AIDoc `chart` blocks.
//
// "Agent declares, extension draws": the agent supplies declarative data (series of x/y points
// with optional error bars + axis config); we draw a crisp vector SVG. No charting library, no
// canvas, no network — it slots into the same per-figure zoom shell as figures/diagrams and
// stays sharp at any zoom. Mermaid xychart-beta handles categorical BAR charts; this owns the
// scientific niche Mermaid can't: scatter, log axes, error bars, multiple series, legends.
//
// The math helpers (domain/ticks/validation) are pure and unit-tested; only renderChartSvg
// touches the DOM (document.createElementNS — never innerHTML, so no agent string is ever
// parsed as markup → CSP-safe).

import type { ChartBlock, ChartErrorBar, ChartPoint, ChartSeries } from "../protocol";

const SVGNS = "http://www.w3.org/2000/svg";

// Distinct, saturated colors that read well on the light backdrop diagrams sit on.
const PALETTE = [
  "#1f6fb2", "#d1495b", "#2e8b57", "#8456c4", "#e07b00",
  "#0e8a8a", "#b5651d", "#c43a86", "#5b6b1f", "#3b5bdb",
];
const MARKERS = ["circle", "square", "triangle", "diamond", "cross"] as const;
type Marker = (typeof MARKERS)[number];

/** Accept only a hex color (#rgb / #rrggbb); anything else falls back to the palette. Defensive
 *  even though the schema validates it — the value lands in an inline style attribute. */
function safeColor(c: string | undefined): string | null {
  return c && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c) ? c : null;
}

/** The color for series index `si`: the series' own hex if valid, else the palette slot. */
function seriesColor(s: ChartSeries, si: number): string {
  return safeColor(s.color) ?? PALETTE[si % PALETTE.length];
}

// ---------------------------------------------------------------------------
// Pure helpers (no DOM) — unit-tested in chart.test.ts.
// ---------------------------------------------------------------------------

/** Resolve an error bar at value `v` to an absolute [lo, hi] interval, or null if absent. */
export function errorInterval(v: number, e: ChartErrorBar | undefined): [number, number] | null {
  if (e === undefined) return null;
  if (typeof e === "number") return [v - e, v + e];
  if (e && typeof e === "object" && Number.isFinite(e.low) && Number.isFinite(e.high)) {
    return [Math.min(e.low, e.high), Math.max(e.low, e.high)];
  }
  return null;
}

/** Collect every finite value an axis must span for one coordinate (point centers + error ends). */
export function axisValues(series: ChartSeries[], axis: "x" | "y"): number[] {
  const out: number[] = [];
  for (const s of series) {
    for (const p of s.points) {
      const v = axis === "x" ? p.x : p.y;
      if (Number.isFinite(v)) out.push(v);
      const iv = errorInterval(v, axis === "x" ? p.xError : p.yError);
      if (iv) {
        if (Number.isFinite(iv[0])) out.push(iv[0]);
        if (Number.isFinite(iv[1])) out.push(iv[1]);
      }
    }
  }
  return out;
}

function padLinear(min: number, max: number): [number, number] {
  if (min === max) {
    const d = Math.abs(min) || 1;
    return [min - d * 0.5, max + d * 0.5];
  }
  const p = (max - min) * 0.05;
  return [min - p, max + p];
}

function padLog(min: number, max: number): [number, number] {
  if (min === max) return [min / 2, max * 2];
  const lp = (Math.log10(max) - Math.log10(min)) * 0.05;
  return [10 ** (Math.log10(min) - lp), 10 ** (Math.log10(max) + lp)];
}

/**
 * Resolve an axis domain. Explicit `[a,b]` wins (normalized lo<hi); otherwise derive from the
 * data with 5% padding (log padding is multiplicative). For log axes only positive values count.
 * Returns null when there's nothing valid to span (caller surfaces an error).
 */
export function computeDomain(
  values: number[],
  scale: "linear" | "log",
  explicit?: "auto" | [number, number]
): [number, number] | null {
  if (Array.isArray(explicit)) {
    const lo = Math.min(explicit[0], explicit[1]);
    const hi = Math.max(explicit[0], explicit[1]);
    if (!(Number.isFinite(lo) && Number.isFinite(hi)) || lo === hi) return null;
    if (scale === "log" && lo <= 0) return null;
    return [lo, hi];
  }
  const vals = values.filter((v) => Number.isFinite(v) && (scale !== "log" || v > 0));
  if (!vals.length) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return scale === "log" ? padLog(min, max) : padLinear(min, max);
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / 10 ** exp;
  let nf: number;
  if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
  else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nf * 10 ** exp;
}

/** "1/2/5×10ⁿ" ticks falling within [min,max]. */
export function niceLinearTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [min];
  const step = niceNum((max - min) / Math.max(1, count - 1), true);
  if (!(step > 0)) return [min];
  const out: number[] = [];
  // Start at the first step multiple >= min; nudge by a tiny epsilon for float safety.
  const start = Math.ceil(min / step - 1e-9) * step;
  for (let v = start; v <= max + step * 1e-9 && out.length < 50; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out.length ? out : [min];
}

/** Powers of ten within [min,max]; if too few, add 2×/5× minors so an axis isn't bare. */
export function niceLogTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > min)) return [min].filter((v) => v > 0);
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const decades: number[] = [];
  for (let k = lo; k <= hi; k++) {
    const base = 10 ** k;
    if (base >= min / 1.0000001 && base <= max * 1.0000001) decades.push(base);
  }
  if (decades.length >= 2) return decades;
  // Narrow range: add 2× and 5× of each decade that falls in range.
  const out: number[] = [];
  for (let k = lo; k <= hi; k++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** k;
      if (v >= min / 1.0000001 && v <= max * 1.0000001) out.push(v);
    }
  }
  return out.length ? out : decades.length ? decades : [min];
}

/** Compact tick label: exponential for very large/small magnitudes, trimmed fixed otherwise. */
export function formatNum(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) {
    return v.toExponential(a >= 1e5 ? 0 : 1).replace(/e\+?(-?\d+)/, "e$1");
  }
  return String(Math.round(v * 1e6) / 1e6);
}

/** Semantic validation beyond JSON Schema. Returns human-readable errors ([] if the chart is drawable). */
export function validateChart(spec: ChartBlock): string[] {
  const errs: string[] = [];
  if (!spec.series?.length) errs.push("chart has no series");
  for (const axisName of ["xAxis", "yAxis"] as const) {
    const axis = spec[axisName];
    if (Array.isArray(axis?.domain)) {
      const [a, b] = axis.domain;
      if (!(Number.isFinite(a) && Number.isFinite(b)) || a === b) {
        errs.push(`${axisName}.domain must be two distinct finite numbers`);
      } else if (axis.scale === "log" && Math.min(a, b) <= 0) {
        errs.push(`${axisName}.domain must be > 0 for a log scale`);
      }
    }
  }
  // At least one point must be plottable on both axes.
  const xLog = spec.xAxis?.scale === "log";
  const yLog = spec.yAxis?.scale === "log";
  const anyPlottable = (spec.series ?? []).some((s) =>
    s.points.some(
      (p) =>
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        (!xLog || p.x > 0) &&
        (!yLog || p.y > 0)
    )
  );
  if (spec.series?.length && !anyPlottable) {
    errs.push("no points are plottable (check for non-finite values, or values ≤ 0 on a log axis)");
  }
  return errs;
}

// ---------------------------------------------------------------------------
// SVG rendering (DOM). Throws Error(message) when the chart can't be drawn.
// ---------------------------------------------------------------------------

const W = 680;
const H = 440;

function svg(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function svgText(x: number, y: number, s: string, cls: string, extra: Record<string, string | number> = {}): SVGElement {
  const t = svg("text", { x, y, class: cls, ...extra });
  t.textContent = s; // textContent — never innerHTML; agent text is escaped
  return t;
}

function markerPath(kind: Marker, cx: number, cy: number, r: number): SVGElement {
  switch (kind) {
    case "square":
      return svg("rect", { x: cx - r, y: cy - r, width: r * 2, height: r * 2, class: "chart-marker" });
    case "triangle":
      return svg("path", { d: `M${cx},${cy - r} L${cx + r},${cy + r} L${cx - r},${cy + r} Z`, class: "chart-marker" });
    case "diamond":
      return svg("path", { d: `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`, class: "chart-marker" });
    case "cross":
      return svg("path", { d: `M${cx - r},${cy - r} L${cx + r},${cy + r} M${cx + r},${cy - r} L${cx - r},${cy + r}`, class: "chart-marker chart-marker-stroke" });
    default:
      return svg("circle", { cx, cy, r, class: "chart-marker" });
  }
}

/**
 * Render a `chart` block to an SVG element (viewBox 0 0 680 440; --fig-w pins natural width so
 * the existing .fig-image zoom CSS scales it). Throws on an undrawable spec so the caller shows
 * an inline error instead of a blank/broken chart.
 */
export function renderChartSvg(spec: ChartBlock): SVGSVGElement {
  const errs = validateChart(spec);
  if (errs.length) throw new Error(errs[0]);

  const xLog = spec.xAxis.scale === "log";
  const yLog = spec.yAxis.scale === "log";
  const xDomain = computeDomain(axisValues(spec.series, "x"), spec.xAxis.scale, spec.xAxis.domain);
  const yDomain = computeDomain(axisValues(spec.series, "y"), spec.yAxis.scale, spec.yAxis.domain);
  if (!xDomain || !yDomain) throw new Error("could not determine an axis range from the data");

  const showLegend = spec.legend ?? spec.series.length > 1;
  const m = { top: spec.title ? 38 : 20, right: showLegend ? 150 : 26, bottom: 58, left: 78 };
  const px0 = m.left;
  const px1 = W - m.right;
  const py0 = m.top; // top (max y)
  const py1 = H - m.bottom; // bottom (min y)

  const sx = (v: number) =>
    xLog
      ? px0 + ((Math.log10(v) - Math.log10(xDomain[0])) / (Math.log10(xDomain[1]) - Math.log10(xDomain[0]))) * (px1 - px0)
      : px0 + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * (px1 - px0);
  const sy = (v: number) =>
    yLog
      ? py1 - ((Math.log10(v) - Math.log10(yDomain[0])) / (Math.log10(yDomain[1]) - Math.log10(yDomain[0]))) * (py1 - py0)
      : py1 - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * (py1 - py0);

  const root = svg("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "fig-image chart-svg",
    role: "img",
    preserveAspectRatio: "xMidYMid meet",
  }) as SVGSVGElement;
  root.style.setProperty("--fig-w", `${W}px`);
  const titleEl = document.createElementNS(SVGNS, "title");
  titleEl.textContent = spec.title || "chart";
  root.appendChild(titleEl);
  if (spec.alt) {
    const desc = document.createElementNS(SVGNS, "desc");
    desc.textContent = spec.alt;
    root.appendChild(desc);
  }

  // Plot frame.
  root.appendChild(svg("rect", { x: px0, y: py0, width: px1 - px0, height: py1 - py0, class: "chart-frame" }));

  // Gridlines + tick labels.
  const xTicks = xLog ? niceLogTicks(xDomain[0], xDomain[1]) : niceLinearTicks(xDomain[0], xDomain[1], spec.xAxis.tickCount);
  const yTicks = yLog ? niceLogTicks(yDomain[0], yDomain[1]) : niceLinearTicks(yDomain[0], yDomain[1], spec.yAxis.tickCount);
  for (const t of xTicks) {
    const x = sx(t);
    if (x < px0 - 0.5 || x > px1 + 0.5) continue;
    root.appendChild(svg("line", { x1: x, y1: py0, x2: x, y2: py1, class: "chart-grid" }));
    root.appendChild(svgText(x, py1 + 18, formatNum(t), "chart-tick chart-tick-x", { "text-anchor": "middle" }));
  }
  for (const t of yTicks) {
    const y = sy(t);
    if (y < py0 - 0.5 || y > py1 + 0.5) continue;
    root.appendChild(svg("line", { x1: px0, y1: y, x2: px1, y2: y, class: "chart-grid" }));
    root.appendChild(svgText(px0 - 8, y + 4, formatNum(t), "chart-tick chart-tick-y", { "text-anchor": "end" }));
  }

  // Axis labels.
  root.appendChild(svgText((px0 + px1) / 2, H - 14, spec.xAxis.label, "chart-axis-label", { "text-anchor": "middle" }));
  const yLab = svgText(20, (py0 + py1) / 2, spec.yAxis.label, "chart-axis-label", {
    "text-anchor": "middle",
    transform: `rotate(-90 20 ${(py0 + py1) / 2})`,
  });
  root.appendChild(yLab);
  if (spec.title) root.appendChild(svgText((px0 + px1) / 2, 22, spec.title, "chart-title", { "text-anchor": "middle" }));

  // Clip series drawing to the plot rect (so an out-of-domain point/error never paints over axes).
  const clipId = "chart-clip";
  const defs = document.createElementNS(SVGNS, "defs");
  const clip = svg("clipPath", { id: clipId });
  clip.appendChild(svg("rect", { x: px0, y: py0, width: px1 - px0, height: py1 - py0 }));
  defs.appendChild(clip);
  root.appendChild(defs);

  let skipped = 0;
  spec.series.forEach((s, si) => {
    const color = seriesColor(s, si);
    const marker: Marker = s.marker ?? MARKERS[si % MARKERS.length];
    const g = svg("g", { "clip-path": `url(#${clipId})`, style: `color:${color}` });

    const plottable = s.points.filter(
      (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && (!xLog || p.x > 0) && (!yLog || p.y > 0)
    );
    skipped += s.points.length - plottable.length;

    // Line first (under markers), sorted by x.
    if (spec.kind === "line" && plottable.length > 1) {
      const sorted = [...plottable].sort((a, b) => a.x - b.x);
      const d = sorted.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(" ");
      g.appendChild(svg("path", { d, class: "chart-line" }));
    }

    // Error bars.
    for (const p of plottable) {
      drawErrorBar(g, p, "y", sx, sy, xLog, yLog);
      drawErrorBar(g, p, "x", sx, sy, xLog, yLog);
    }

    // Markers.
    for (const p of plottable) g.appendChild(markerPath(marker, sx(p.x), sy(p.y), 4.2));

    root.appendChild(g);
  });

  // Legend (right margin): swatch marker + series name per row.
  if (showLegend) {
    const lx = px1 + 14;
    spec.series.forEach((s, si) => {
      const color = seriesColor(s, si);
      const marker: Marker = s.marker ?? MARKERS[si % MARKERS.length];
      const ly = py0 + 6 + si * 20;
      const row = svg("g", { style: `color:${color}` });
      row.appendChild(markerPath(marker, lx + 5, ly, 4.2));
      row.appendChild(svgText(lx + 16, ly + 4, s.name, "chart-legend"));
      root.appendChild(row);
    });
  }

  // Honest footnote when points were dropped (off-scale / non-finite) — never silent.
  if (skipped > 0) {
    root.appendChild(
      svgText(px1, py0 - 6, `${skipped} point${skipped > 1 ? "s" : ""} off-scale omitted`, "chart-note", {
        "text-anchor": "end",
      })
    );
  }

  return root;
}

function drawErrorBar(
  g: SVGElement,
  p: ChartPoint,
  axis: "x" | "y",
  sx: (v: number) => number,
  sy: (v: number) => number,
  xLog: boolean,
  yLog: boolean
): void {
  const center = axis === "x" ? p.x : p.y;
  const iv = errorInterval(center, axis === "x" ? p.xError : p.yError);
  if (!iv) return;
  const log = axis === "x" ? xLog : yLog;
  // On a log axis an interval end ≤ 0 can't be drawn; clip it to the center so the bar still shows.
  const lo = log && iv[0] <= 0 ? center : iv[0];
  const hi = iv[1];
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) return;
  const cap = 3;
  if (axis === "y") {
    const x = sx(p.x);
    g.appendChild(svg("line", { x1: x, y1: sy(lo), x2: x, y2: sy(hi), class: "chart-err" }));
    g.appendChild(svg("line", { x1: x - cap, y1: sy(lo), x2: x + cap, y2: sy(lo), class: "chart-err" }));
    g.appendChild(svg("line", { x1: x - cap, y1: sy(hi), x2: x + cap, y2: sy(hi), class: "chart-err" }));
  } else {
    const y = sy(p.y);
    g.appendChild(svg("line", { x1: sx(lo), y1: y, x2: sx(hi), y2: y, class: "chart-err" }));
    g.appendChild(svg("line", { x1: sx(lo), y1: y - cap, x2: sx(lo), y2: y + cap, class: "chart-err" }));
    g.appendChild(svg("line", { x1: sx(hi), y1: y - cap, x2: sx(hi), y2: y + cap, class: "chart-err" }));
  }
}
