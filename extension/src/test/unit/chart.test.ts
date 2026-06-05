// Unit tests for the pure (DOM-free) chart math: error intervals, domains, ticks, formatting,
// and semantic validation. The SVG-building part (renderChartSvg) needs a DOM and is covered by
// manual dev-host verification; importing chart.ts here is safe because no module-level code
// touches `document`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  errorInterval,
  axisValues,
  computeDomain,
  niceLinearTicks,
  niceLogTicks,
  formatNum,
  validateChart,
} from "../../webview/chart";
import type { ChartBlock } from "../../protocol";

test("errorInterval: symmetric number -> centered interval", () => {
  assert.deepEqual(errorInterval(10, 2), [8, 12]);
});

test("errorInterval: {low,high} -> normalized interval; undefined -> null", () => {
  assert.deepEqual(errorInterval(10, { low: 9, high: 12 }), [9, 12]);
  assert.deepEqual(errorInterval(10, { low: 12, high: 9 }), [9, 12]); // order-normalized
  assert.equal(errorInterval(10, undefined), null);
});

test("axisValues: collects centers and error-bar ends", () => {
  const series = [
    { name: "s", points: [{ x: 1, y: 5, yError: 1 }, { x: 2, y: 8, yError: { low: 7, high: 10 } }] },
  ];
  const ys = axisValues(series, "y").sort((a, b) => a - b);
  assert.deepEqual(ys, [4, 5, 6, 7, 8, 10]); // 5±1 -> 4,6 ; 8 with [7,10]
  assert.deepEqual(axisValues(series, "x").sort((a, b) => a - b), [1, 2]);
});

test("computeDomain: explicit domain wins and is normalized", () => {
  assert.deepEqual(computeDomain([1, 2, 3], "linear", [10, 0]), [0, 10]);
});

test("computeDomain: explicit log domain with <=0 is rejected (null)", () => {
  assert.equal(computeDomain([1, 2], "log", [0, 100]), null);
});

test("computeDomain: auto linear pads ~5% each side", () => {
  const d = computeDomain([0, 100], "linear", "auto");
  assert.ok(d);
  assert.ok(d![0] < 0 && d![1] > 100);
});

test("computeDomain: log filters non-positive values", () => {
  const d = computeDomain([-5, 0, 10, 1000], "log", "auto");
  assert.ok(d);
  assert.ok(d![0] > 0, "log domain min must be > 0");
  assert.ok(d![0] < 10 && d![1] > 1000);
});

test("computeDomain: no usable values -> null", () => {
  assert.equal(computeDomain([NaN, Infinity], "linear", "auto"), null);
  assert.equal(computeDomain([-1, -2], "log", "auto"), null);
});

test("niceLinearTicks: returns round, in-range, ascending ticks", () => {
  const ticks = niceLinearTicks(0, 100, 5);
  assert.ok(ticks.length >= 3);
  assert.ok(ticks.every((t) => t >= 0 && t <= 100));
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1]);
});

test("niceLogTicks: powers of ten within range", () => {
  const ticks = niceLogTicks(1, 1000);
  assert.deepEqual(ticks, [1, 10, 100, 1000]);
});

test("niceLogTicks: narrow range falls back to 1/2/5 minors", () => {
  const ticks = niceLogTicks(1, 5);
  assert.ok(ticks.length >= 2, "should add minor ticks when fewer than two decades");
  assert.ok(ticks.every((t) => t > 0));
});

test("formatNum: compact fixed + exponential extremes", () => {
  assert.equal(formatNum(0), "0");
  assert.equal(formatNum(42), "42");
  assert.equal(formatNum(2.5), "2.5");
  assert.match(formatNum(1e6), /e6$/);
  assert.match(formatNum(3.3e-4), /e-4$/);
});

const baseChart = (): ChartBlock => ({
  type: "chart",
  kind: "scatter",
  xAxis: { label: "x", scale: "linear" },
  yAxis: { label: "y", scale: "linear" },
  series: [{ name: "s", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
});

test("validateChart: a normal spec has no errors", () => {
  assert.deepEqual(validateChart(baseChart()), []);
});

test("validateChart: log axis with all non-positive values errors", () => {
  const c = baseChart();
  c.yAxis.scale = "log";
  c.series[0].points = [{ x: 1, y: -2 }, { x: 3, y: 0 }];
  assert.ok(validateChart(c).length > 0);
});

test("validateChart: explicit equal-endpoint domain errors", () => {
  const c = baseChart();
  c.xAxis.domain = [5, 5];
  assert.ok(validateChart(c).some((e) => /domain/.test(e)));
});
