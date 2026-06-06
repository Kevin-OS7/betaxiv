// Webview (browser world). Receives messages from the host, renders the PDF on the
// left via vendored PDF.js, and the validated summary on the right. No network, no
// browser storage — state goes through the VS Code webview state API (rules 1 & 5).

import katex from "katex";
import type {
  HostMessage,
  PaperSummary,
  PaperDoc,
  DocBlock,
  TableBlock,
  DiagramBlock,
  ChartBlock,
  Figure,
  ListItem,
  Annotation,
  AnnotationRect,
} from "../protocol";
import { normalizeBbox, sourceRect, figureContainingPoint } from "./cropGeometry";
import { renderChartSvg } from "./chart";
import {
  AnnotationStore,
  ANNOTATION_COLORS,
  DEFAULT_COLOR,
  normalizeClientRects,
  denormRect,
  pointInRects,
  unionBbox,
} from "./annotations";
import { enableCopyReflow, reflowCurrentSelection } from "./textLayerSelection";
import {
  buildPdfMatches,
  foldCase,
  locateAll,
  ordinalInPage,
  type PageText,
  type PdfMatch,
} from "./findText";
import { buildRefLine, buildCopyPayload } from "./refLine";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// Mermaid renders AIDoc `diagram` blocks to SVG client-side (the agent only declares source).
// It's ESM-only, so we import it dynamically (esbuild bundles it for the webview; the CJS
// typecheck stays happy) and lazily — papers without a diagram never pay its load cost. It's
// initialized once: startOnLoad:false → we call render() ourselves; securityLevel:"strict"
// sanitizes labels and blocks script/click-handler injection. Only built-in diagram types are
// used (see the betaxiv-documenter skill), so nothing is lazily fetched — CSP-clean + offline.
// Minimal surface of the Mermaid API we use (a full ESM type-import would need a
// resolution-mode attribute under Node16; this avoids that and documents our usage).
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}
let mermaidPromise: Promise<MermaidApi> | undefined;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const m = (mod as { default: MermaidApi }).default;
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        // Pin a font that actually exists on the host (Mermaid's default "trebuchet ms" is
        // absent on Linux/webview).
        fontFamily: '-apple-system, "Segoe UI", Roboto, Ubuntu, system-ui, sans-serif',
        // htmlLabels:false → labels are SVG <text> (text-anchor:middle), sized via getBBox and
        // centered accurately. This avoids Mermaid's <foreignObject> labels, whose width drifts
        // in a webview (canvas vs DOM metrics) and both clipped and mis-centered the text.
        htmlLabels: false,
        // Don't stretch flowcharts to the full column width (the default); render at natural
        // size and let the figure-zoom CSS scale them like summary figures.
        flowchart: { useMaxWidth: false, htmlLabels: false },
      });
      return m;
    });
  }
  return mermaidPromise;
}

const pdfStatus = document.getElementById("pdf-status") as HTMLElement;
const pdfPages = document.getElementById("pdf-pages") as HTMLElement;
const summaryRoot = document.getElementById("summary-root") as HTMLElement;

// Annotation state (highlights + notes). The store fires its onChange only on user edits,
// which we debounce-persist to the host; loading from the host (setAll) does not echo back.
// The UI wiring (toolbar, popover, painting, hit-testing) lives in the annotation section
// further down — all function declarations, so it is hoisted above first use in renderSlot.
const annoStore = new AnnotationStore((items) => scheduleAnnoSave(items));
let currentSelectionAnchor: SelectionAnchor | null = null;

// The loaded PDF document, hoisted to module scope so the summary renderer can crop
// figure images out of pages. renderPdf() resolves it once getDocument() completes; the
// figure renderer awaits it, which transparently handles a `summary` message arriving
// before the PDF finishes loading and any later live-reload re-render.
let resolvePdfDoc: (doc: unknown) => void = () => {};
const pdfDocPromise = new Promise<any>((resolve) => {
  resolvePdfDoc = resolve;
});

// Hooks owned by the Find (Ctrl+F) section near the bottom, declared here so module-scope code
// (renderSlot, setSummaryOpen) can fire them. They stay undefined until that section runs at the
// end of module load — which is before the host posts `bootstrap`, so they're set before any page
// renders or pane toggles that matter. `onPageRendered`: a PDF page's text layer just attached →
// an open PDF find repaints its match highlights. `onSummaryToggle`: the right pane opened/closed
// → reposition / re-scope the find widget.
let onPageRendered: ((pageNum: number) => void) | undefined;
let onSummaryToggle: (() => void) | undefined;

interface SavedState {
  pdfScrollTop?: number;
  fitMode?: boolean; // true: page tracks pane width; false: page held at absScale
  absScale?: number; // absolute render scale (1 == PDF native size) when not fit-to-width
  summaryOpen?: boolean;
  splitCols?: string;
  summaryZoom?: number;
  figZoom?: Record<string, number>; // per-figure zoom, keyed by figure label
  selToolbarOffset?: { dx: number; dy: number }; // user-dragged shift off the toolbar's anchor
}
function saveState(patch: Partial<SavedState>): void {
  const cur = (vscode.getState() as SavedState) ?? {};
  vscode.setState({ ...cur, ...patch });
}

// --- AIDocs state -----------------------------------------------------------
// The right pane shows ONE artifact at a time, chosen from the AIDocs dropdown: the special
// Summary, or one of the agent-authored docs. The host streams each independently, so we keep
// the latest of each and (re)render whatever is currently selected.
type SummaryState =
  | { kind: "waiting" }
  | { kind: "ready"; summary: PaperSummary }
  | { kind: "missing"; relPath: string; skillName: string }
  | { kind: "invalid"; relPath: string; errors: string[] };
type Selection =
  | { kind: "summary" }
  | { kind: "doc"; id: string }
  | { kind: "invalid"; relPath: string };

let summaryState: SummaryState = { kind: "waiting" };
let docsState: PaperDoc[] = [];
let docsInvalidState: { relPath: string; errors: string[] }[] = [];
let docsSkillName = "betaxiv-documenter";
let selection: Selection = { kind: "summary" };
// Workspace-relative file paths of the right-pane artifacts, used as the provenance prefix when
// copying selected summary/AIDoc text ("copy with path"): the summary JSON, and each doc by id.
let summaryRelPathReady = "";
let docRelPaths: Record<string, string> = {};
// Workspace-relative path of the open PDF (from bootstrap) — used as copy provenance and to
// name the PDF in copied prompts. Falls back to the filename if no workspace-relative path.
let openedPdfRelPath = "";

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "bootstrap":
      openedPdfRelPath = msg.pdfRelPath || pdfBasename(msg.pdfUri);
      void renderPdf(
        msg.pdfUri,
        msg.pdfjsLibUri,
        msg.pdfViewerLibUri,
        msg.pdfWorkerUri,
        msg.cMapUri,
        msg.standardFontUri
      );
      break;
    case "summary":
      summaryState = { kind: "ready", summary: msg.summary };
      summaryRelPathReady = msg.summaryRelPath;
      refreshAidocs();
      break;
    case "summary-missing":
      summaryState = { kind: "missing", relPath: msg.summaryRelPath, skillName: msg.skillName };
      refreshAidocs();
      break;
    case "summary-invalid":
      summaryState = { kind: "invalid", relPath: msg.summaryRelPath, errors: msg.errors };
      refreshAidocs();
      break;
    case "docs":
      docsState = msg.docs;
      docRelPaths = msg.docRelPaths;
      docsInvalidState = msg.invalid;
      docsSkillName = msg.docsSkillName;
      refreshAidocs();
      break;
    case "annotations":
      annoStore.setAll(msg.annotations);
      repaintAllAnnotations();
      break;
  }
});

// Persist scroll position so it survives reloads.
const pdfPane = document.getElementById("pdf-pane") as HTMLElement;
let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined;
pdfPane.addEventListener("scroll", () => {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => saveState({ pdfScrollTop: pdfPane.scrollTop }), 150);
});

// --- Summary pane: collapsible + resizable splitter -------------------------
const app = document.getElementById("app") as HTMLElement;
const splitter = document.getElementById("splitter") as HTMLElement;
const aidocsToggle = document.getElementById("aidocs-toggle") as HTMLButtonElement;

const viewState = (vscode.getState() as SavedState) ?? {};
if (viewState.splitCols) app.style.setProperty("--split-cols", viewState.splitCols);

// The right pane is collapsed by default; opening it is driven by the AIDocs dropdown (and the
// pane stays open across selections). The choice persists. setSummaryOpen only owns the pane's
// visibility; the AIDocs button owns the dropdown menu (see the AIDocs section below).
let summaryOpen = viewState.summaryOpen ?? false;
function setSummaryOpen(open: boolean): void {
  summaryOpen = open;
  app.classList.toggle("summary-open", open);
  aidocsToggle.setAttribute("aria-pressed", String(open));
  saveState({ summaryOpen: open });
  onSummaryToggle?.(); // keep an open find widget positioned / scoped to the visible panes
}
setSummaryOpen(summaryOpen);

// Close (×) at the pane's top-left collapses the right pane.
document
  .getElementById("aidocs-close")
  ?.addEventListener("click", () => setSummaryOpen(false));

// --- Summary text zoom (independent of the PDF zoom) ------------------------
// Scales only the summary pane's base font-size via the --summary-zoom CSS var; the
// summary content is all em-sized, so it enlarges together. Driven by buttons and
// Ctrl/Cmd+scroll over the pane (keyboard +/-/0 stays bound to the PDF pane).
const summaryPane = document.getElementById("summary-pane") as HTMLElement;
const SUMMARY_MIN_ZOOM = 0.6;
const SUMMARY_MAX_ZOOM = 2.5;
const summaryZoomLevel = document.getElementById("summary-zoom-level");
let summaryZoom =
  typeof viewState.summaryZoom === "number"
    ? Math.max(SUMMARY_MIN_ZOOM, Math.min(SUMMARY_MAX_ZOOM, viewState.summaryZoom))
    : 1;
function applySummaryZoom(target: number): void {
  summaryZoom = Math.max(SUMMARY_MIN_ZOOM, Math.min(SUMMARY_MAX_ZOOM, target));
  app.style.setProperty("--summary-zoom", String(summaryZoom));
  if (summaryZoomLevel) summaryZoomLevel.textContent = `${Math.round(summaryZoom * 100)}%`;
  saveState({ summaryZoom });
}
applySummaryZoom(summaryZoom);
document
  .getElementById("summary-zoom-in")
  ?.addEventListener("click", () => applySummaryZoom(summaryZoom * 1.1));
document
  .getElementById("summary-zoom-out")
  ?.addEventListener("click", () => applySummaryZoom(summaryZoom / 1.1));
document
  .getElementById("summary-zoom-reset")
  ?.addEventListener("click", () => applySummaryZoom(1));
// --- Per-figure zoom --------------------------------------------------------
// Each figure carries its OWN persistent zoom. A slider on the figure sets it directly; and
// after clicking the figure to focus it, Ctrl/Cmd+scroll over it nudges the same value. The
// click gate keeps the summary zoom from silently switching to figure zoom when the pointer
// merely drifts over a figure. The zoom is saved per figure label, so clicking away only drops
// the focus outline (never the size) and it survives a summary live-reload.
let activeFigure: HTMLElement | null = null;
const FIG_MIN_ZOOM = 0.5;
const FIG_MAX_ZOOM = 5;

function clampFigZoom(z: number): number {
  return Math.max(FIG_MIN_ZOOM, Math.min(FIG_MAX_ZOOM, z));
}

function getFigZoom(label: string): number {
  const z = ((vscode.getState() as SavedState) ?? {}).figZoom?.[label];
  return typeof z === "number" ? clampFigZoom(z) : 1;
}

function saveFigZoom(label: string, z: number): void {
  const cur = (vscode.getState() as SavedState) ?? {};
  saveState({ figZoom: { ...(cur.figZoom ?? {}), [label]: z } });
}

// Apply a zoom to a figure: set the CSS var, persist it (by label), and sync its slider + %.
function setFigureZoom(figure: HTMLElement, z: number): void {
  const zoom = clampFigZoom(z);
  figure.style.setProperty("--fig-zoom", String(zoom));
  if (figure.dataset.figLabel) saveFigZoom(figure.dataset.figLabel, zoom);
  const slider = figure.querySelector<HTMLInputElement>(".fig-zoom-slider");
  if (slider) slider.value = String(zoom);
  const pct = figure.querySelector<HTMLElement>(".fig-zoom-pct");
  if (pct) pct.textContent = `${Math.round(zoom * 100)}%`;
}

function setActiveFigure(fig: HTMLElement | null): void {
  if (activeFigure === fig) return;
  activeFigure?.classList.remove("fig-active");
  activeFigure = fig;
  activeFigure?.classList.add("fig-active");
}

function toggleActiveFigure(fig: HTMLElement): void {
  setActiveFigure(activeFigure === fig ? null : fig);
}

function activeFigureUnder(target: EventTarget | null): HTMLElement | null {
  if (!activeFigure) return null;
  const node = target instanceof Element ? target : null;
  return node?.closest(".fig") === activeFigure ? activeFigure : null;
}

summaryPane.addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const fig = activeFigureUnder(e.target);
    if (fig) {
      setFigureZoom(fig, (parseFloat(fig.style.getPropertyValue("--fig-zoom")) || 1) * factor);
    } else {
      applySummaryZoom(summaryZoom * factor);
    }
  },
  { passive: false }
);

// Clicking outside any figure only drops the focus outline; the figure keeps its zoom.
summaryPane.addEventListener("click", (e) => {
  const onFigure = e.target instanceof Element && e.target.closest(".fig");
  if (!onFigure) setActiveFigure(null);
});

// Drag the splitter to re-balance the two panes; the ratio is persisted.
let dragging = false;
splitter.addEventListener("mousedown", (e) => {
  if (!summaryOpen) return;
  dragging = true;
  e.preventDefault();
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const total = app.clientWidth || 1;
  const leftFr = Math.max(0.2, Math.min(0.85, e.clientX / total));
  app.style.setProperty("--split-cols", `${leftFr}fr 6px ${1 - leftFr}fr`);
});
window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  saveState({ splitCols: app.style.getPropertyValue("--split-cols") });
});

// --- PDF rendering ----------------------------------------------------------
async function renderPdf(
  pdfUri: string,
  libUri: string,
  viewerLibUri: string,
  workerUri: string,
  cMapUri: string,
  standardFontUri: string
): Promise<void> {
  try {
    // pdf.js is a vendored .mjs loaded from a local, CSP-pinned URI (not bundled).
    const pdfjsLib: any = await import(/* @vite-ignore */ libUri);

    // The viewer module (TextLayerBuilder) reads the core off `globalThis.pdfjsLib`, so expose
    // the instance we just loaded BEFORE importing it — then they share one library. We use
    // PDF.js's own TextLayerBuilder for the text layer to get its maintained selection glue.
    (globalThis as unknown as { pdfjsLib: unknown }).pdfjsLib = pdfjsLib;
    const viewerLib: any = await import(/* @vite-ignore */ viewerLibUri);
    const TextLayerBuilder = viewerLib.TextLayerBuilder;

    // VS Code serves webview resources from a different origin (vscode-cdn.net), and
    // browsers refuse to spawn a Worker from a cross-origin URL — PDF.js silently falls
    // back to a "fake worker" that parses on the main thread (catastrophically slow:
    // ~30s for a 12-page paper). Fetch the worker code and wrap it in a same-origin blob
    // URL so the real worker thread is used.
    const workerCode = await (await fetch(workerUri)).text();
    const workerBlobUrl = URL.createObjectURL(
      new Blob([workerCode], { type: "text/javascript" })
    );
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;

    const doc = await pdfjsLib.getDocument({
      url: pdfUri,
      cMapUrl: cMapUri,
      cMapPacked: true,
      standardFontDataUrl: standardFontUri,
    }).promise;
    resolvePdfDoc(doc); // unblock figure cropping in the summary pane
    pdfStatus.style.display = "none";
    pdfPages.replaceChildren();

    // Mutable: the fit-to-width baseline must track the pane width, which changes when the
    // summary pane is toggled/resized or the window is resized (see the ResizeObserver below).
    // Measure the scroll container (pdfPane), not pdfPages: when a pinned page overflows the pane
    // pdfPages grows to the page width, but pdfPane.clientWidth stays the true available width
    // (the scrollbar gutter is reserved), so Fit always computes against the real column width.
    const paneWidth = () => pdfPane.clientWidth || 600;
    let containerWidth = paneWidth();
    const dpr = window.devicePixelRatio || 1;

    // Sticky-fit zoom model. Two modes:
    //   fitMode=true  — each page is scaled to fill the pane width (capped at FIT_CAP). A pane
    //                   resize re-fits, so the page always fills the column. This is the default
    //                   on open and what the "Fit" button returns to.
    //   fitMode=false — the page is held at a fixed absolute scale (absScale, 1 == PDF native
    //                   size), the SAME for every page. A pane resize no longer rezooms it; if the
    //                   pane gets narrower than the page, the CSS just adds a horizontal scrollbar.
    // Manually zooming (buttons / Ctrl+scroll-equiv keys) leaves fit mode and pins the size; this
    // is why dragging the splitter or toggling the sidebar stops silently rescaling the PDF.
    const FIT_CAP = 2; // fit-to-width never magnifies a page past 200% of its native size
    const MIN_SCALE = 0.25;
    const MAX_SCALE = 5;
    const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    const savedState = (vscode.getState() as SavedState) ?? {};
    let fitMode = savedState.fitMode ?? true;
    let absScale =
      typeof savedState.absScale === "number" ? clampScale(savedState.absScale) : 1;
    const fitFactor = (baseWidth: number) =>
      Math.min(FIT_CAP, (containerWidth - 16) / baseWidth);
    const scaleFor = (baseWidth: number) =>
      fitMode ? fitFactor(baseWidth) : absScale;

    // Lazy rendering: build placeholder slots up front (so scroll geometry is stable),
    // then rasterize a page to canvas only when it nears the viewport, and release its
    // canvas when it scrolls far away. This bounds memory on large PDFs regardless of
    // retainContextWhenHidden.
    //
    // Critically, only page 1 is fetched (getPage) up front. The rest are fetched lazily
    // inside renderSlot, so the time-to-first-page does NOT grow with the page count —
    // placeholder slots use page 1's size as an estimate (papers have a uniform page size)
    // and each slot's real size is corrected when it's actually rendered.
    interface Slot {
      el: HTMLElement;
      pageNum: number;
      page?: any;
      viewport?: any;
      canvas?: HTMLCanvasElement;
      tlb?: any; // PDF.js TextLayerBuilder instance (owns the text layer + selection glue)
      textLayer?: HTMLDivElement; // tlb.div: transparent selectable text, over the canvas
      annoLayer?: HTMLDivElement; // highlight rectangles, under the text layer
      rendering?: boolean;
    }

    const firstPage = await doc.getPage(1);
    const base1 = firstPage.getViewport({ scale: 1 });
    // Placeholder size estimate for not-yet-measured pages, at the current zoom (papers
    // have a uniform page size). Recomputed when zoom changes.
    const estDims = () => {
      const vp = firstPage.getViewport({ scale: scaleFor(base1.width) });
      return { w: Math.floor(vp.width), h: Math.floor(vp.height) };
    };
    const vp1 = firstPage.getViewport({ scale: scaleFor(base1.width) });
    const estWidth = `${Math.floor(vp1.width)}px`;
    const estHeight = `${Math.floor(vp1.height)}px`;

    const slots: Slot[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const el = document.createElement("div");
      el.className = "page-slot";
      el.dataset.page = String(i); // lets the annotation hit-test resolve a click's page
      el.style.width = estWidth;
      el.style.height = estHeight;
      pdfPages.appendChild(el);
      slots.push(
        i === 1
          ? { el, pageNum: 1, page: firstPage, viewport: vp1 }
          : { el, pageNum: i }
      );
    }

    const MAX_RENDERED = 8; // soft cap on simultaneously rasterized pages
    const rendered: Slot[] = [];
    // Bumped by rescaleAll. An in-flight render captures it before awaiting; if it changes
    // mid-rasterize (a zoom/relayout dropped every canvas, including this one) the finished
    // canvas is stale and detached, so we discard it and re-render at the current scale instead
    // of leaving the slot blank. Without this, a relayout that fires while page 1 is still
    // rasterizing on open leaves page 1 blank until a scroll re-triggers it.
    let renderEpoch = 0;

    const releaseFarthest = (keep: Slot) => {
      while (rendered.length > MAX_RENDERED) {
        // Evict the rendered page visually farthest from the one we just drew.
        let worst = -1;
        let worstDist = -1;
        for (let i = 0; i < rendered.length; i++) {
          if (rendered[i] === keep) continue;
          const dist = Math.abs(rendered[i].el.offsetTop - keep.el.offsetTop);
          if (dist > worstDist) {
            worstDist = dist;
            worst = i;
          }
        }
        if (worst < 0) break;
        const victim = rendered.splice(worst, 1)[0];
        // Drop all three layers together so an evicted page doesn't leave a blank canvas
        // with floating selectable text / highlights over it.
        victim.canvas?.remove();
        victim.canvas = undefined;
        victim.tlb?.cancel(); // deregisters from PDF.js's global selection listener
        victim.tlb = undefined;
        victim.textLayer?.remove();
        victim.textLayer = undefined;
        victim.annoLayer?.remove();
        victim.annoLayer = undefined;
      }
    };

    const renderSlot = async (slot: Slot) => {
      if (slot.canvas || slot.rendering) return;
      slot.rendering = true;
      const epoch = renderEpoch;
      try {
        // Lazily fetch the page (all but page 1) and derive its real viewport, then
        // correct the placeholder size in case this page differs from the page-1 estimate.
        if (!slot.page) slot.page = await doc.getPage(slot.pageNum);
        if (!slot.viewport) {
          const base = slot.page.getViewport({ scale: 1 });
          slot.viewport = slot.page.getViewport({ scale: scaleFor(base.width) });
          slot.el.style.width = `${Math.floor(slot.viewport.width)}px`;
          slot.el.style.height = `${Math.floor(slot.viewport.height)}px`;
        }
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d")!;
        canvas.width = Math.floor(slot.viewport.width * dpr);
        canvas.height = Math.floor(slot.viewport.height * dpr);
        canvas.style.width = `${Math.floor(slot.viewport.width)}px`;
        canvas.style.height = `${Math.floor(slot.viewport.height)}px`;
        slot.el.replaceChildren(canvas);
        slot.canvas = canvas;
        await slot.page.render({
          canvasContext: ctx,
          viewport: slot.viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        if (epoch !== renderEpoch) {
          // A rescale (zoom/relayout) ran while we were rasterizing: this canvas is sized to a
          // now-stale scale and rescaleAll has already detached it. Drop it and re-render the
          // currently-visible slots at the new scale once `rendering` clears (in finally).
          canvas.remove();
          if (slot.canvas === canvas) slot.canvas = undefined;
          setTimeout(renderVisible, 0);
          return;
        }
        rendered.push(slot);
        releaseFarthest(slot);

        // Highlight overlay (under the text) + transparent selectable text layer (on top).
        // Both are sized to the canvas's CSS box; the text layer needs --scale-factor so
        // PDF.js positions its spans at the current zoom (see the .textLayer CSS).
        const cssW = Math.floor(slot.viewport.width);
        const cssH = Math.floor(slot.viewport.height);
        const annoLayer = document.createElement("div");
        annoLayer.className = "anno-layer";
        slot.el.appendChild(annoLayer);
        slot.annoLayer = annoLayer;
        paintAnnoLayer(annoLayer, slot.pageNum, cssW, cssH);

        try {
          const tlb = new TextLayerBuilder({ pdfPage: slot.page });
          await tlb.render(slot.viewport);
          // The standalone builder doesn't set --scale-factor (PDF.js's page view normally
          // does); its text-layer CSS needs it to position spans at the current zoom.
          tlb.div.style.setProperty("--scale-factor", String(slot.viewport.scale));
          slot.el.appendChild(tlb.div);
          slot.tlb = tlb;
          slot.textLayer = tlb.div;
          onPageRendered?.(slot.pageNum); // PDF find can now paint matches on this page
        } catch {
          // The text layer is a selection convenience; if it fails the page still renders.
          slot.tlb?.cancel();
          slot.tlb = undefined;
          slot.textLayer = undefined;
        }
      } finally {
        slot.rendering = false;
      }
    };

    // Draw page 1 immediately, without waiting for the IntersectionObserver to fire its
    // first tick — this is the user's time-to-first-page.
    void renderSlot(slots[0]);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const slot = slots.find((s) => s.el === entry.target);
            if (slot) void renderSlot(slot);
          }
        }
      },
      { root: pdfPane, rootMargin: "400px 0px" }
    );
    for (const slot of slots) observer.observe(slot.el);

    // Restore saved scroll position now that slots give the document its full height.
    if (typeof savedState.pdfScrollTop === "number") {
      pdfPane.scrollTop = savedState.pdfScrollTop;
    }

    // --- Zoom -----------------------------------------------------------------
    // The IntersectionObserver only fires on intersection changes, not on resize, so a
    // zoom change must explicitly re-render whatever is currently in view.
    const renderVisible = () => {
      const top = pdfPane.scrollTop - 400;
      const bottom = pdfPane.scrollTop + pdfPane.clientHeight + 400;
      for (const slot of slots) {
        const slotTop = slot.el.offsetTop;
        const slotBottom = slotTop + slot.el.offsetHeight;
        if (slotBottom >= top && slotTop <= bottom) void renderSlot(slot);
      }
    };

    // The effective absolute scale of a standard (page-1-sized) page right now: the fit factor
    // while fitting, or the pinned absScale otherwise. Used for the % label and as the starting
    // point when a manual zoom converts "fit" into a pinned absolute size.
    const effectiveScale = () => (fitMode ? fitFactor(base1.width) : absScale);
    const zoomLevel = document.getElementById("zoom-level");
    const updateZoomLabel = () => {
      if (zoomLevel) zoomLevel.textContent = `${Math.round(effectiveScale() * 100)}%`;
    };

    // Re-scale every slot to the current zoom/containerWidth: drop stale canvases,
    // recompute viewports (loaded pages) or reset to the new placeholder estimate
    // (not-yet-loaded pages).
    const rescaleAll = () => {
      renderEpoch++; // invalidate any in-flight render: its canvas is about to be detached
      const est = estDims();
      for (const slot of slots) {
        slot.canvas?.remove();
        slot.canvas = undefined;
        slot.tlb?.cancel();
        slot.tlb = undefined;
        slot.textLayer = undefined;
        slot.annoLayer = undefined;
        slot.el.replaceChildren();
        if (slot.page) {
          const base = slot.page.getViewport({ scale: 1 });
          slot.viewport = slot.page.getViewport({ scale: scaleFor(base.width) });
        } else {
          slot.viewport = undefined;
        }
        const w = slot.viewport ? Math.floor(slot.viewport.width) : est.w;
        const h = slot.viewport ? Math.floor(slot.viewport.height) : est.h;
        slot.el.style.width = `${w}px`;
        slot.el.style.height = `${h}px`;
      }
      rendered.length = 0;
    };

    // Manual zoom: pin the page at a fixed absolute scale (leaving fit mode), stepping from
    // whatever size is on screen now so the first +/− doesn't jump.
    const applyZoom = (factor: number) => {
      const prev = effectiveScale();
      const next = clampScale(prev * factor);
      if (Math.abs(next - prev) < 0.001 && !fitMode) return;
      const oldScrollTop = pdfPane.scrollTop;
      fitMode = false;
      absScale = next;
      rescaleAll();
      // Heights scale linearly with the scale, so scaling scrollTop keeps the same content
      // anchored near the top of the viewport.
      pdfPane.scrollTop = oldScrollTop * (next / prev);
      updateZoomLabel();
      renderVisible();
      saveState({ fitMode, absScale });
    };

    // Fit button / Ctrl+0: (re-)enter fit-to-width mode, preserving scroll proportionally.
    const fitWidth = () => {
      const frac = pdfPane.scrollTop / (pdfPages.scrollHeight || 1);
      fitMode = true;
      rescaleAll();
      pdfPane.scrollTop = frac * pdfPages.scrollHeight;
      updateZoomLabel();
      renderVisible();
      saveState({ fitMode });
    };

    // Pane width changed (summary toggle, splitter drag, sidebar, window resize). In fit mode we
    // re-fit so the page keeps filling the column; when the size is pinned we deliberately do NOT
    // rescale — the page holds its size and the pane just reveals more/less of it. Debounced so a
    // splitter drag doesn't trigger a re-render storm.
    const relayout = () => {
      const w = paneWidth();
      if (!w || w === containerWidth) return;
      containerWidth = w;
      if (!fitMode) return; // pinned: pane resize must not rezoom the page
      const frac = pdfPane.scrollTop / (pdfPages.scrollHeight || 1);
      rescaleAll();
      pdfPane.scrollTop = frac * pdfPages.scrollHeight;
      renderVisible();
    };
    let relayoutTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (relayoutTimer) clearTimeout(relayoutTimer);
      relayoutTimer = setTimeout(relayout, 120);
    });
    ro.observe(pdfPane);

    document.getElementById("zoom-in")?.addEventListener("click", () => applyZoom(1.2));
    document.getElementById("zoom-out")?.addEventListener("click", () => applyZoom(1 / 1.2));
    document.getElementById("zoom-reset")?.addEventListener("click", () => fitWidth());

    window.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        applyZoom(1.2);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        applyZoom(1 / 1.2);
      } else if (e.key === "0") {
        e.preventDefault();
        fitWidth();
      }
    });

    pdfPane.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        applyZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      },
      { passive: false }
    );

    updateZoomLabel();
    document.getElementById("zoom-toolbar")?.removeAttribute("hidden");
  } catch (err) {
    // Unblock the figure renderer with a null doc so its "Rendering figure…" placeholders
    // collapse to caption-only instead of hanging forever (the PDF never loaded).
    resolvePdfDoc(null);
    pdfStatus.style.display = "";
    pdfStatus.textContent = `Failed to render PDF: ${(err as Error).message}`;
    vscode.postMessage({ type: "error", message: String((err as Error).message) });
  }
}

// --- Summary rendering (DOM-only; no innerHTML with agent text) --------------
function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function section(title: string): HTMLElement {
  const s = el("section", "summary-section");
  s.appendChild(el("h2", undefined, title));
  return s;
}

function listOf(items: string[]): HTMLUListElement {
  const ul = document.createElement("ul");
  for (const item of items) ul.appendChild(el("li", undefined, item));
  return ul;
}

function pageBadge(page: number | null): HTMLElement | null {
  if (page === null || page === undefined) return null;
  return el("span", "page-badge", `p.${page}`);
}

// Render a LaTeX expression as real (publication-style) math via KaTeX. KaTeX builds its own
// DOM under `into` (escaping the source), so the agent text never reaches raw innerHTML. On a
// parse error we fall back to the verbatim source as plain text rather than KaTeX's red error
// box, so a slightly-off expression still reads sensibly.
function renderMath(tex: string, into: HTMLElement, displayMode: boolean): void {
  try {
    katex.render(tex, into, { displayMode, throwOnError: true, output: "html" });
  } catch {
    into.textContent = tex;
  }
}

// Minimal, CSP-safe inline emphasis: **bold**, `code`, and $…$ inline math (KaTeX).
// Non-markup runs are plain text nodes, so this never touches raw innerHTML with agent text.
function inline(text: string, into: HTMLElement): void {
  // $…$ first so a `$x$` isn't mistaken for code; `\$` is an escaped literal dollar sign.
  const re = /\$((?:\\\$|[^$])+?)\$|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) into.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const span = el("span", "math-inline");
      renderMath(m[1].replace(/\\\$/g, "$"), span, false);
      into.appendChild(span);
    } else if (m[2] !== undefined) {
      into.appendChild(el("strong", undefined, m[2]));
    } else {
      into.appendChild(el("code", "inline-code", m[3]));
    }
    last = re.lastIndex;
  }
  if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
}

function slugify(s: string, i: number): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `sec-${i}-${base || "section"}`;
}

// Bound how many full-page figure renders run at once. Each render rasterizes a whole PDF
// page to an offscreen canvas, so firing all figures in parallel (esp. several on one page,
// or while the summary is collapsed) can spike memory. A small gate keeps it flat without
// noticeably hurting responsiveness for the handful of figures a summary has.
const FIG_CONCURRENCY = 2;
let figActive = 0;
const figWaiters: Array<() => void> = [];
function withFigSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    figActive++;
    try {
      return await fn();
    } finally {
      figActive--;
      figWaiters.shift()?.();
    }
  };
  if (figActive < FIG_CONCURRENCY) return run();
  return new Promise<void>((res) => figWaiters.push(res)).then(run);
}

// Crop the real figure image out of its PDF page and place it in `target`. The model only
// supplies the region (page + normalized bbox); we render that page to an offscreen canvas
// and copy the bbox rectangle into a small visible canvas. Robust to loose/out-of-range
// bboxes (clamped) and to load/render failures (falls back to caption-only).
async function renderFigureImage(fig: Figure, target: HTMLElement): Promise<void> {
  if (!fig.bbox || !fig.page) return;
  try {
    const pdfDoc = await pdfDocPromise;
    // A later live-reload may have already replaced the summary DOM, detaching this holder.
    // Bail before the expensive page render (and free the semaphore slot for the fresh
    // render's figures). Safe here because the first await yields only after renderSummary's
    // synchronous replaceChildren has run, so a current figure's holder is connected.
    if (!target.isConnected) return;
    if (!pdfDoc || fig.page < 1 || fig.page > pdfDoc.numPages) {
      target.replaceChildren(); // PDF failed to load, or page out of range → caption-only
      return;
    }
    const page = await pdfDoc.getPage(fig.page);
    if (!target.isConnected) return; // a reload landed during getPage()
    // Normalize + clamp the bbox to [0,1] regardless of order the model emitted.
    const norm = normalizeBbox(fig.bbox);
    if (!norm) {
      target.replaceChildren();
      return;
    }

    // bbox is normalized against the page's UPRIGHT cropBox: getViewport applies the page
    // `/Rotate` and uses `page.view` (cropBox ∩ mediaBox), so a rotated or cropped page is
    // measured in its displayed orientation. This MUST match the frame the model grounded the
    // bbox in — the skill's crop_helper.py renders the same upright cropBox (pdfplumber
    // to_image, force_mediabox=False). Keep these two in lockstep. (See cropGeometry test.)
    const vp1 = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    // Aim for a crop roughly as wide as the summary column, crisp on HiDPI.
    const targetCss = Math.min(560, Math.max(280, (summaryRoot.clientWidth || 460) - 24));
    // Rasterize with extra headroom so the figure stays crisp when the summary is zoomed in
    // (it scales via CSS in lockstep with the text — see `.fig-image` / --summary-zoom). We
    // oversample to ~2x the display width regardless of DPR, then cap by the scale clamp.
    const headroom = Math.max(1, 2 / dpr);
    const scale = Math.max(
      1,
      Math.min(3, (targetCss * dpr * headroom) / (norm.wN * vp1.width))
    );
    const vp = page.getViewport({ scale });

    const full = document.createElement("canvas");
    full.width = Math.ceil(vp.width);
    full.height = Math.ceil(vp.height);
    const fctx = full.getContext("2d")!;
    fctx.fillStyle = "#fff"; // white backdrop so transparent regions read correctly
    fctx.fillRect(0, 0, full.width, full.height);
    await page.render({ canvasContext: fctx, viewport: vp }).promise;

    const { sx, sy, sw, sh } = sourceRect(norm, vp.width, vp.height, full.width, full.height);

    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    out.getContext("2d")!.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
    out.className = "fig-image";
    // Pin the display width (at zoom 1) so CSS can scale it by --summary-zoom in lockstep
    // with the surrounding text. Without this the canvas would show at its raw oversampled
    // pixel width. Divide out the headroom so zoom 1 still fits the column.
    out.style.setProperty("--fig-w", `${Math.round(sw / (dpr * headroom))}px`);
    target.replaceChildren(out); // replaces the "rendering…" placeholder
  } catch {
    target.replaceChildren(); // drop the placeholder; the figcaption stays
  }
}

function renderFigure(fig: Figure): HTMLElement {
  const figure = el("figure", "fig");
  if (fig.bbox && fig.page) {
    figure.dataset.figLabel = fig.label;
    const initialZoom = getFigZoom(fig.label); // restore a saved per-figure zoom
    figure.style.setProperty("--fig-zoom", String(initialZoom));

    const holder = el("div", "fig-image-holder");
    holder.title = "Click to focus, then Ctrl/Cmd + scroll — or drag the slider — to zoom";
    holder.addEventListener("click", () => toggleActiveFigure(figure));
    holder.appendChild(el("div", "figure-loading", "Rendering figure…"));
    figure.appendChild(holder);
    void withFigSlot(() => renderFigureImage(fig, holder));

    // Per-figure zoom slider.
    const bar = el("div", "fig-zoom-bar");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "fig-zoom-slider";
    slider.min = String(FIG_MIN_ZOOM);
    slider.max = String(FIG_MAX_ZOOM);
    slider.step = "0.05";
    slider.value = String(initialZoom);
    slider.setAttribute("aria-label", `Zoom ${fig.label}`);
    slider.addEventListener("input", () => setFigureZoom(figure, parseFloat(slider.value) || 1));
    bar.appendChild(slider);
    bar.appendChild(el("span", "fig-zoom-pct", `${Math.round(initialZoom * 100)}%`));
    figure.appendChild(bar);
  }
  const cap = document.createElement("figcaption");
  cap.appendChild(el("strong", undefined, fig.label));
  const badge = pageBadge(fig.page);
  if (badge) {
    cap.appendChild(document.createTextNode(" "));
    cap.appendChild(badge);
  }
  if (fig.caption) cap.appendChild(document.createTextNode(` — ${fig.caption}`));
  figure.appendChild(cap);
  return figure;
}

// Recursive list renderer: ordered (<ol>) or unordered (<ul>), with nested sub-lists for
// outline-style / tab-like indentation. Each item is a plain string or an object that
// carries its own (independently ordered) sub-items.
function renderList(items: ListItem[], ordered: boolean): HTMLElement {
  const list = document.createElement(ordered ? "ol" : "ul");
  for (const item of items) {
    const li = document.createElement("li");
    if (typeof item === "string") {
      inline(item, li);
    } else {
      inline(item.text, li);
      if (item.items && item.items.length) {
        li.appendChild(renderList(item.items, item.ordered ?? false));
      }
    }
    list.appendChild(li);
  }
  return list;
}

// Build a declarative data table (AIDoc `table` block). Cells carry the same inline emphasis
// as paragraphs (**bold**, `code`, $math$) via inline(), so no raw innerHTML touches agent text.
function renderTable(b: TableBlock): HTMLElement {
  const figure = el("figure", "block-table");
  const table = document.createElement("table");
  if (b.header && b.header.length) {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    for (const h of b.header) {
      const th = document.createElement("th");
      inline(h, th);
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }
  const tbody = document.createElement("tbody");
  for (const row of b.rows ?? []) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      inline(cell, td);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  figure.appendChild(table);
  if (b.caption) {
    const cap = document.createElement("figcaption");
    inline(b.caption, cap);
    figure.appendChild(cap);
  }
  return figure;
}

// Each Mermaid render needs a DOM id unique within the document; a monotonic counter avoids
// collisions across re-renders (Date.now()/random are intentionally avoided in this codebase).
let diagramSeq = 0;

// The page CSP nonce, read off any nonced element (the .nonce IDL property returns the real
// value even though the attribute is blanked in the DOM). Cached after first lookup.
let cachedNonce: string | undefined;
function pageNonce(): string {
  if (cachedNonce === undefined) {
    cachedNonce = document.querySelector<HTMLElement>("[nonce]")?.nonce ?? "";
  }
  return cachedNonce;
}

// Insert Mermaid's SVG into `holder`. Two jobs:
//  1. CSP: Mermaid emits a `<style>` INSIDE the SVG (its scoped theme CSS); under our
//     nonce-locked style-src that element would be blocked and the diagram render unstyled. We
//     parse the markup in an inert <template> (never CSP-evaluated) and swap each <style> for a
//     fresh one stamped with the page nonce. Inline style="…" attributes are already allowed by
//     style-src-attr 'unsafe-inline' (see getHtml).
//  2. Sizing: strip Mermaid's inline width/height and tag the <svg> as a `.fig-image` carrying
//     its natural width in --fig-w, so it scales with the per-figure + summary zoom exactly like
//     a cropped figure image (same CSS rule).
function injectMermaidSvg(holder: HTMLElement, svg: string): void {
  const tpl = document.createElement("template");
  tpl.innerHTML = svg; // template content is inert: parsed but not rendered / not CSP-checked
  const nonce = pageNonce();
  tpl.content.querySelectorAll("style").forEach((s) => {
    const fresh = document.createElement("style");
    if (nonce) fresh.nonce = nonce;
    fresh.textContent = s.textContent ?? "";
    s.replaceWith(fresh);
  });
  const svgEl = tpl.content.querySelector("svg");
  if (svgEl) {
    const vb = svgEl.getAttribute("viewBox");
    const naturalW = vb ? parseFloat(vb.split(/[ ,]+/)[2]) : NaN;
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.style.removeProperty("max-width");
    svgEl.classList.add("fig-image");
    if (Number.isFinite(naturalW)) svgEl.style.setProperty("--fig-w", `${Math.ceil(naturalW)}px`);
  }
  holder.replaceChildren(tpl.content);
}

// Render an AIDoc `diagram` block. It reuses the SAME `.fig` shell + per-figure zoom as cropped
// figures (slider, click-to-focus, Ctrl/Cmd+scroll, summary-zoom lockstep) — `key` is a stable
// per-diagram id so the zoom persists across live-reloads. Mermaid source -> SVG is injected
// async; on a parse/render error we fall back to the verbatim source in a <pre> (graceful
// degrade, like renderMath), so a slightly-off diagram still reads instead of breaking the pane.
function renderDiagram(b: DiagramBlock, key: string): HTMLElement {
  const figure = el("figure", "fig");
  figure.dataset.figLabel = key;
  const initialZoom = getFigZoom(key);
  figure.style.setProperty("--fig-zoom", String(initialZoom));

  const holder = el("div", "fig-image-holder");
  holder.title = "Click to focus, then Ctrl/Cmd + scroll — or drag the slider — to zoom";
  holder.addEventListener("click", () => toggleActiveFigure(figure));
  holder.appendChild(el("div", "figure-loading", "Rendering diagram…"));
  figure.appendChild(holder);

  // Per-figure zoom slider (identical to renderFigure's).
  const bar = el("div", "fig-zoom-bar");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "fig-zoom-slider";
  slider.min = String(FIG_MIN_ZOOM);
  slider.max = String(FIG_MAX_ZOOM);
  slider.step = "0.05";
  slider.value = String(initialZoom);
  slider.setAttribute("aria-label", `Zoom diagram`);
  slider.addEventListener("input", () => setFigureZoom(figure, parseFloat(slider.value) || 1));
  bar.appendChild(slider);
  bar.appendChild(el("span", "fig-zoom-pct", `${Math.round(initialZoom * 100)}%`));
  figure.appendChild(bar);

  if (b.caption) {
    const cap = document.createElement("figcaption");
    inline(b.caption, cap);
    figure.appendChild(cap);
  }

  const id = `mermaid-${diagramSeq++}`;
  loadMermaid()
    .then((m) => m.render(id, b.mermaid))
    .then(({ svg }) => {
      if (!holder.isConnected) return; // a live-reload may have replaced the pane already
      injectMermaidSvg(holder, svg);
    })
    .catch(() => {
      holder.replaceChildren(el("pre", "diagram-src", b.mermaid));
    });
  return figure;
}

// Render an AIDoc `chart` block (scatter / numeric-x line). Like renderDiagram it reuses the
// `.fig` zoom shell, but the SVG is built synchronously and CSP-safely (createElementNS, no
// innerHTML) by ./chart. An undrawable spec degrades to an inline message inside the shell.
function renderChart(b: ChartBlock, key: string): HTMLElement {
  const figure = el("figure", "fig");
  figure.dataset.figLabel = key;
  const initialZoom = getFigZoom(key);
  figure.style.setProperty("--fig-zoom", String(initialZoom));

  const holder = el("div", "fig-image-holder");
  holder.title = "Click to focus, then Ctrl/Cmd + scroll — or drag the slider — to zoom";
  holder.addEventListener("click", () => toggleActiveFigure(figure));
  try {
    holder.appendChild(renderChartSvg(b));
  } catch (err) {
    holder.appendChild(
      el("div", "diagram-src", `Chart could not be rendered: ${(err as Error).message}`)
    );
  }
  figure.appendChild(holder);

  // Per-figure zoom slider (identical to figures/diagrams).
  const bar = el("div", "fig-zoom-bar");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "fig-zoom-slider";
  slider.min = String(FIG_MIN_ZOOM);
  slider.max = String(FIG_MAX_ZOOM);
  slider.step = "0.05";
  slider.value = String(initialZoom);
  slider.setAttribute("aria-label", "Zoom chart");
  slider.addEventListener("input", () => setFigureZoom(figure, parseFloat(slider.value) || 1));
  bar.appendChild(slider);
  bar.appendChild(el("span", "fig-zoom-pct", `${Math.round(initialZoom * 100)}%`));
  figure.appendChild(bar);

  if (b.caption) {
    const cap = document.createElement("figcaption");
    inline(b.caption, cap);
    figure.appendChild(cap);
  }
  return figure;
}

function renderBlocks(
  blocks: DocBlock[],
  figuresByLabel: Map<string, Figure>,
  parent: HTMLElement,
  keyPrefix = ""
): void {
  blocks.forEach((b, i) => {
    if (b.type === "heading") {
      // Section title — same visual weight as a summary section heading.
      const h = el(b.level === 3 ? "h3" : "h2", b.level === 3 ? "doc-heading doc-h3" : "doc-heading doc-h2");
      inline(b.text, h);
      parent.appendChild(h);
    } else if (b.type === "paragraph") {
      const p = el("p", "block-para");
      inline(b.text, p);
      parent.appendChild(p);
    } else if (b.type === "bullets") {
      parent.appendChild(renderList(b.items, b.ordered ?? false));
    } else if (b.type === "formula") {
      const div = el("div", "formula");
      renderMath(b.text, div, true);
      parent.appendChild(div);
    } else if (b.type === "figure") {
      const fig = figuresByLabel.get(b.label);
      if (fig) parent.appendChild(renderFigure(fig));
      else parent.appendChild(el("div", "fig-missing", `[${b.label}]`));
    } else if (b.type === "table") {
      parent.appendChild(renderTable(b));
    } else if (b.type === "diagram") {
      // Stable per-diagram key (prefix = doc id) so its zoom persists across live-reloads.
      parent.appendChild(renderDiagram(b, `${keyPrefix}::diagram::${i}`));
    } else if (b.type === "chart") {
      parent.appendChild(renderChart(b, `${keyPrefix}::chart::${i}`));
    }
  });
}

function renderSummary(s: PaperSummary): void {
  setActiveFigure(null); // the figures are about to be rebuilt; drop any stale focus
  const root = document.createElement("div");
  const figuresByLabel = new Map(s.summary.figures.map((f) => [f.label, f]));

  // Header: title, optional date line, author · venue · year meta.
  const header = el("div", "summary-header");
  header.appendChild(el("h1", undefined, s.paper.title));
  if (s.paper.date) header.appendChild(el("div", "summary-date", s.paper.date));
  const metaBits: string[] = [];
  if (s.paper.authors.length) metaBits.push(s.paper.authors.join(", "));
  if (s.paper.venue) metaBits.push(s.paper.venue);
  if (s.paper.year !== null) metaBits.push(String(s.paper.year));
  header.appendChild(el("div", "summary-meta", metaBits.join(" · ")));
  root.appendChild(header);

  // Summary box (the blog's lead paragraph).
  if (s.summary.tldr) {
    const sec = section("Summary");
    sec.appendChild(el("div", "tldr", s.summary.tldr));
    root.appendChild(sec);
  }

  // Key contributions.
  if (s.summary.keyContributions.length) {
    const sec = section("Key Contributions");
    sec.appendChild(listOf(s.summary.keyContributions));
    root.appendChild(sec);
  }

  const sections = s.summary.sections;
  const ids = sections.map((sec, i) => slugify(sec.heading, i));

  // Auto Table of Contents (derived in the webview; not part of the schema).
  if (sections.length > 1) {
    const nav = el("nav", "toc");
    nav.appendChild(el("div", "toc-title", "Table of Contents"));
    const ul = document.createElement("ul");
    sections.forEach((sec, i) => {
      const li = document.createElement("li");
      const a = el("a", undefined, sec.heading) as HTMLAnchorElement;
      a.href = `#${ids[i]}`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById(ids[i])?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      li.appendChild(a);
      ul.appendChild(li);
    });
    nav.appendChild(ul);
    root.appendChild(nav);
  }

  // Sections: heading + prose blocks (figures appear inline within their section).
  for (let i = 0; i < sections.length; i++) {
    const secData = sections[i];
    const div = el("div", "section-block");
    div.id = ids[i];
    const h = el("h3");
    h.appendChild(document.createTextNode(secData.heading));
    const badge = pageBadge(secData.page);
    if (badge) h.appendChild(badge);
    div.appendChild(h);
    renderBlocks(secData.blocks, figuresByLabel, div);
    root.appendChild(div);
  }

  // Safety net: any catalog figure never referenced by an inline figure block still shows.
  const referenced = new Set<string>();
  for (const sec of sections) {
    for (const b of sec.blocks) if (b.type === "figure") referenced.add(b.label);
  }
  const leftover = s.summary.figures.filter((f) => !referenced.has(f.label));
  if (leftover.length) {
    const sec = section("Figures & Tables");
    for (const fig of leftover) sec.appendChild(renderFigure(fig));
    root.appendChild(sec);
  }

  // Glossary.
  if (s.summary.glossary.length) {
    const sec = section("Glossary");
    const dl = document.createElement("dl");
    for (const g of s.summary.glossary) {
      dl.appendChild(el("dt", undefined, g.term));
      dl.appendChild(el("dd", undefined, g.definition));
    }
    sec.appendChild(dl);
    root.appendChild(sec);
  }

  // Open questions.
  if (s.summary.openQuestions.length) {
    const sec = section("Open Questions");
    sec.appendChild(listOf(s.summary.openQuestions));
    root.appendChild(sec);
  }

  // Relevant citations (annotated references the paper builds on).
  if (s.summary.relevantCitations.length) {
    const sec = section("Relevant Citations");
    for (const c of s.summary.relevantCitations) {
      const cite = el("div", "citation");
      cite.appendChild(el("div", "citation-title", c.title));
      const metaBits2: string[] = [];
      if (c.authors && c.authors.length) metaBits2.push(c.authors.join(", "));
      if (c.venue) metaBits2.push(c.venue);
      if (metaBits2.length) cite.appendChild(el("div", "citation-meta", metaBits2.join(" · ")));
      cite.appendChild(el("div", "citation-note", c.note));
      sec.appendChild(cite);
    }
    root.appendChild(sec);
  }

  // Footer (provenance).
  const gb = s.generatedBy;
  const footer = el(
    "div",
    "summary-meta",
    `Generated by ${gb.agent}${gb.model ? ` (${gb.model})` : ""} · ${gb.timestamp}`
  );
  footer.style.marginTop = "24px";
  root.appendChild(footer);

  summaryRoot.className = "";
  summaryRoot.replaceChildren(root);
}

function renderGuidance(summaryRelPath: string, skillName: string): void {
  const card = el("div", "guidance");
  card.appendChild(el("h2", undefined, "No summary yet"));
  const p1 = el("p");
  p1.appendChild(document.createTextNode("Run the "));
  p1.appendChild(el("code", undefined, skillName));
  p1.appendChild(
    document.createTextNode(
      " skill with your own coding agent (Claude Code / Codex / Gemini CLI) on this PDF."
    )
  );
  card.appendChild(p1);
  const p2 = el("p");
  p2.appendChild(document.createTextNode("Expected output: "));
  p2.appendChild(el("code", undefined, summaryRelPath));
  card.appendChild(p2);
  card.appendChild(
    el(
      "p",
      undefined,
      "This pane updates automatically the moment the summary file appears."
    )
  );
  summaryRoot.className = "";
  summaryRoot.replaceChildren(card);
}

function renderInvalid(summaryRelPath: string, errors: string[]): void {
  const card = el("div", "guidance errors");
  card.appendChild(el("h2", undefined, "Summary failed schema validation"));
  card.appendChild(el("p", undefined, `File: ${summaryRelPath}`));
  card.appendChild(listOf(errors));
  summaryRoot.className = "";
  summaryRoot.replaceChildren(card);
}

// Render an AIDoc into the right pane. Reuses the summary block/figure pipeline wholesale —
// the only differences are the header (title/kind/description) and that figures come from the
// doc's own (optional) catalog.
function renderDoc(d: PaperDoc): void {
  setActiveFigure(null); // figures are about to be rebuilt; drop any stale focus
  const root = document.createElement("div");
  const figures = d.figures ?? [];
  const figuresByLabel = new Map(figures.map((f) => [f.label, f]));

  const header = el("div", "summary-header");
  header.appendChild(el("h1", undefined, d.doc.title));
  if (d.doc.description) header.appendChild(el("div", "summary-date", d.doc.description));
  if (d.doc.kind) header.appendChild(el("div", "summary-meta", d.doc.kind));
  root.appendChild(header);

  const body = el("div", "section-block");
  renderBlocks(d.blocks, figuresByLabel, body, d.doc.id);
  root.appendChild(body);

  // Safety net: any catalog figure never referenced inline still shows in a trailing list.
  const referenced = new Set<string>();
  for (const b of d.blocks) if (b.type === "figure") referenced.add(b.label);
  const leftover = figures.filter((f) => !referenced.has(f.label));
  if (leftover.length) {
    const sec = section("Figures & Tables");
    for (const fig of leftover) sec.appendChild(renderFigure(fig));
    root.appendChild(sec);
  }

  const gb = d.generatedBy;
  const footer = el(
    "div",
    "summary-meta",
    `Generated by ${gb.agent}${gb.model ? ` (${gb.model})` : ""} · ${gb.timestamp}`
  );
  footer.style.marginTop = "24px";
  root.appendChild(footer);

  summaryRoot.className = "";
  summaryRoot.replaceChildren(root);
}

function renderDocErrors(relPath: string, errors: string[]): void {
  const card = el("div", "guidance errors");
  card.appendChild(el("h2", undefined, "Document failed schema validation"));
  card.appendChild(el("p", undefined, `File: ${relPath}`));
  card.appendChild(listOf(errors));
  summaryRoot.className = "";
  summaryRoot.replaceChildren(card);
}

// --- AIDocs dropdown --------------------------------------------------------
// The AIDocs button opens a menu anchored beneath it: row 1 is the Summary (or its
// "Not yet summarized" label), the rest are agent-authored docs plus any that failed
// validation. Selecting a row opens the right pane and renders that artifact; re-selecting the
// active row while the pane is open collapses it (preserves the old single-button toggle feel).
const aidocsMenu = document.createElement("div");
aidocsMenu.id = "aidocs-menu";
aidocsMenu.hidden = true;
aidocsMenu.setAttribute("role", "menu");
// Keep clicks inside the menu from reaching the global dismiss handlers.
aidocsMenu.addEventListener("mousedown", (e) => e.stopPropagation());
document.body.appendChild(aidocsMenu);

function aidocsMenuOpen(): boolean {
  return !aidocsMenu.hidden;
}

function positionAidocsMenu(): void {
  const r = aidocsToggle.getBoundingClientRect();
  aidocsMenu.style.top = `${Math.round(r.bottom + 6)}px`;
  // The view controls sit at the top-right, so right-align the menu to the button.
  aidocsMenu.style.right = `${Math.round(window.innerWidth - r.right)}px`;
}

function setAidocsMenuOpen(open: boolean): void {
  aidocsMenu.hidden = !open;
  aidocsToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    positionAidocsMenu();
    renderAidocsMenu();
  }
}

// stopPropagation on mousedown so the document-level "click outside closes" handler below
// doesn't fire for the toggle itself (which would close-then-reopen on the following click).
aidocsToggle.addEventListener("mousedown", (e) => e.stopPropagation());
aidocsToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  setAidocsMenuOpen(aidocsMenu.hidden);
});
document.addEventListener("mousedown", () => {
  if (aidocsMenuOpen()) setAidocsMenuOpen(false);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && aidocsMenuOpen()) setAidocsMenuOpen(false);
});

function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "doc" && b.kind === "doc") return a.id === b.id;
  if (a.kind === "invalid" && b.kind === "invalid") return a.relPath === b.relPath;
  return true; // both summary
}

function selectArtifact(sel: Selection): void {
  // Re-selecting the active artifact while the pane is open collapses it (toggle feel).
  if (summaryOpen && sameSelection(sel, selection)) {
    setSummaryOpen(false);
    setAidocsMenuOpen(false);
    return;
  }
  selection = sel;
  setSummaryOpen(true);
  setAidocsMenuOpen(false);
  renderSelection();
}

// Render whatever artifact is currently selected into the right pane. Falls back to the
// Summary if a previously-selected doc/invalid entry has since disappeared. The wrapper runs
// refreshFindIfOpen() after EVERY render path — the doc/invalid branches return early, so an open
// summary-scoped find must re-match here too (else switching AIDocs leaves stale matches).
function renderSelection(): void {
  renderSelectionInner();
  refreshFindIfOpen();
}
function renderSelectionInner(): void {
  if (selection.kind === "doc") {
    const id = selection.id; // capture before the callback (TS won't narrow a mutable `let`)
    const doc = docsState.find((d) => d.doc.id === id);
    if (doc) {
      renderDoc(doc);
      return;
    }
    selection = { kind: "summary" };
  } else if (selection.kind === "invalid") {
    const relPath = selection.relPath;
    const bad = docsInvalidState.find((x) => x.relPath === relPath);
    if (bad) {
      renderDocErrors(bad.relPath, bad.errors);
      return;
    }
    selection = { kind: "summary" };
  }
  // Summary (the default / fallback).
  if (summaryState.kind === "ready") renderSummary(summaryState.summary);
  else if (summaryState.kind === "missing") renderGuidance(summaryState.relPath, summaryState.skillName);
  else if (summaryState.kind === "invalid") renderInvalid(summaryState.relPath, summaryState.errors);
  // "waiting" → leave the initial "Waiting for summary…" placeholder.
}

// Called whenever summary or docs state changes: keep the pane and (if open) the menu current.
function refreshAidocs(): void {
  renderSelection();
  if (aidocsMenuOpen()) renderAidocsMenu();
}

function aidocsItem(active: boolean, extraClass?: string): HTMLButtonElement {
  const row = document.createElement("button");
  row.className = "aidocs-item" + (extraClass ? ` ${extraClass}` : "") + (active ? " active" : "");
  row.setAttribute("role", "menuitem");
  return row;
}

// An inline icon control for a menu row. It's a <span> (not a <button>) so it can nest inside the
// row's <button> legally; its click is stopped from bubbling so it doesn't also select the row.
// Icons are inline SVG (stroke:currentColor) so CSS can color them — an emoji ignores `color`.
const SVGNS = "http://www.w3.org/2000/svg";
function iconControl(cls: string, title: string, paths: string[], onClick: () => void): HTMLElement {
  const ctl = el("span", cls);
  ctl.title = title;
  ctl.setAttribute("role", "button");
  ctl.setAttribute("aria-label", title);
  const svg = document.createElementNS(SVGNS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: "15",
    height: "15",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  for (const d of paths) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  ctl.appendChild(svg);
  ctl.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return ctl;
}

// Feather "trash-2": lid + can + two stripes.
function deleteControl(title: string, onDelete: () => void): HTMLElement {
  return iconControl(
    "aidocs-del",
    title,
    ["M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"],
    onDelete
  );
}

// Feather "rotate-cw": a circular arrow = recreate.
function recreateControl(title: string, onClick: () => void): HTMLElement {
  return iconControl("aidocs-recreate", title, ["M23 4v6h-6", "M20.49 15a9 9 0 1 1-2.12-9.36L23 10"], onClick);
}

// Ask the host to delete a doc, then close the menu (the host confirms; the watcher refreshes).
function deleteDocRequest(req: { docId?: string; relPath?: string; label?: string }): void {
  vscode.postMessage({ type: "doc-delete", ...req });
  setAidocsMenuOpen(false);
}

// Ask the host to delete this paper's summary (host confirms; the summary watcher refreshes).
function deleteSummaryRequest(): void {
  vscode.postMessage({ type: "summary-delete" });
  setAidocsMenuOpen(false);
}

function renderAidocsMenu(): void {
  const frag = document.createDocumentFragment();

  // Row 1: the special Summary. When a summary file exists (ready or invalid) the row carries a
  // delete (trash) control, like doc rows.
  const hasSummary = summaryState.kind === "ready" || summaryState.kind === "invalid";
  const summaryRow = aidocsItem(selection.kind === "summary", hasSummary ? "aidocs-item-has-del" : undefined);
  const sumMain = el("span", "aidocs-item-main");
  sumMain.appendChild(
    el("span", "aidocs-item-title", summaryState.kind === "missing" ? "Not yet summarized" : "Summary")
  );
  if (summaryState.kind === "invalid") sumMain.appendChild(el("span", "aidocs-badge", "invalid"));
  summaryRow.appendChild(sumMain);
  // When a summary exists: Recreate (copy prompt) + Delete, side by side at the row's right.
  if (hasSummary) {
    const actions = el("span", "aidocs-actions");
    actions.appendChild(
      recreateControl("Recreate summary (copy a prompt for your agent)", () => {
        copyNewSummaryPrompt();
        setAidocsMenuOpen(false);
      })
    );
    actions.appendChild(deleteControl("Delete the summary", deleteSummaryRequest));
    summaryRow.appendChild(actions);
  }
  summaryRow.addEventListener("click", () => selectArtifact({ kind: "summary" }));
  frag.appendChild(summaryRow);

  // When there's no summary yet, offer "+ New summary…" (mirrors "+ New doc…").
  if (summaryState.kind === "missing") {
    const newSum = aidocsItem(false, "aidocs-new");
    newSum.appendChild(el("span", "aidocs-item-title", "+ New summary…"));
    newSum.appendChild(el("span", "aidocs-item-desc", "Copy a prompt for your agent"));
    newSum.addEventListener("click", () => {
      copyNewSummaryPrompt();
      setAidocsMenuOpen(false);
    });
    frag.appendChild(newSum);
  }

  // Agent-authored docs (each row has a trash control to delete the underlying file).
  for (const d of docsState) {
    const row = aidocsItem(selection.kind === "doc" && selection.id === d.doc.id, "aidocs-item-has-del");
    const main = el("span", "aidocs-item-main");
    main.appendChild(el("span", "aidocs-item-title", d.doc.title)); // title only — no preview
    row.appendChild(main);
    row.appendChild(deleteControl(`Delete “${d.doc.title}”`, () => deleteDocRequest({ docId: d.doc.id, label: d.doc.title })));
    row.addEventListener("click", () => selectArtifact({ kind: "doc", id: d.doc.id }));
    frag.appendChild(row);
  }

  // Docs that failed validation — selectable so the user can see the errors, and deletable.
  for (const bad of docsInvalidState) {
    const name = bad.relPath.split("/").pop() ?? bad.relPath;
    const row = aidocsItem(
      selection.kind === "invalid" && selection.relPath === bad.relPath,
      "invalid aidocs-item-has-del"
    );
    const main = el("span", "aidocs-item-main");
    main.appendChild(el("span", "aidocs-item-title", name));
    main.appendChild(el("span", "aidocs-badge", "invalid"));
    row.appendChild(main);
    row.appendChild(deleteControl(`Delete ${name}`, () => deleteDocRequest({ relPath: bad.relPath, label: name })));
    row.addEventListener("click", () => selectArtifact({ kind: "invalid", relPath: bad.relPath }));
    frag.appendChild(row);
  }

  frag.appendChild(el("div", "aidocs-sep"));

  // "+ New doc…": copies a prompt template to the clipboard. It NEVER launches an agent — the
  // human pastes it into their own agent, same human-trigger boundary as the summary skill.
  const newRow = aidocsItem(false, "aidocs-new");
  newRow.appendChild(el("span", "aidocs-item-title", "+ New doc…"));
  newRow.appendChild(el("span", "aidocs-item-desc", "Copy a prompt for your agent"));
  newRow.addEventListener("click", () => {
    copyNewDocPrompt();
    setAidocsMenuOpen(false);
  });
  frag.appendChild(newRow);

  aidocsMenu.replaceChildren(frag);
}

function currentSourcePath(): string {
  if (summaryState.kind === "ready") return summaryState.summary.paper.sourcePath;
  if (docsState[0]) return docsState[0].doc.sourcePath;
  return openedPdfRelPath || "this PDF";
}

/** Last path segment of the (webview-resource) PDF URI, decoded — e.g. "skillopt.pdf". */
function pdfBasename(uri: string): string {
  try {
    const path = uri.split("?")[0].split("#")[0];
    return decodeURIComponent(path.split("/").pop() || "") || "this PDF";
  } catch {
    return "this PDF";
  }
}

// The copied prompts stay minimal: which skill, which PDF, and a blank line for the user's
// own style request. The save path + validation live INSIDE the skill (SKILL.md), so they
// don't need repeating here — the agent reads them when the skill runs.
function copyNewDocPrompt(): void {
  copyPrompt(
    `Use the ${docsSkillName} skill to create a BetaXiv AIDoc for ${currentSourcePath()}.\n` +
      `User-specified doc style:\n`
  );
}

function copyNewSummaryPrompt(): void {
  const skill = summaryState.kind === "missing" ? summaryState.skillName : "betaxiv-summarizer";
  copyPrompt(
    `Use the ${skill} skill to write the BetaXiv summary for ${currentSourcePath()}.\n` +
      `User-specified summary style:\n`
  );
}

function copyPrompt(text: string): void {
  const clip = navigator.clipboard;
  if (!clip) {
    showToast("Clipboard unavailable — copy the prompt from the docs manually.");
    return;
  }
  void clip.writeText(text).then(
    () => showToast("Prompt copied — paste it to your agent (Claude Code / Codex / Gemini CLI)."),
    () => showToast("Could not copy to clipboard.")
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string): void {
  let toast = document.getElementById("betaxiv-toast");
  if (!toast) {
    toast = el("div");
    toast.id = "betaxiv-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast?.classList.remove("show"), 3500);
}

// --- Annotations: highlights + notes UI -------------------------------------
// The webview owns editing in memory; the host owns the file. Highlights sit UNDER the
// transparent text layer (so text stays selectable everywhere) and are hit-tested by
// coordinate on click rather than via pointer events.

interface SelectionAnchor {
  page: number;
  rects: AnnotationRect[];
  text: string;
}

function genId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID
    ? c.randomUUID()
    : `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Editing a note fires per keystroke; coalesce before posting the full set to the host.
let annoSaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAnnoSave(items: Annotation[]): void {
  if (annoSaveTimer) clearTimeout(annoSaveTimer);
  const snapshot = items.map((a) => ({ ...a, rects: a.rects.map((r) => ({ ...r })) }));
  annoSaveTimer = setTimeout(
    () => vscode.postMessage({ type: "annotations-save", annotations: snapshot }),
    300
  );
}

// Paint one page's highlight rects into its overlay (px sizes from the normalized rects and
// the page's current rendered size).
function paintAnnoLayer(layer: HTMLElement, pageNum: number, width: number, height: number): void {
  // Fills go in an opacity-bearing wrapper so overlapping rects don't accumulate alpha (the
  // overlap reads at the same strength as the rest). Note markers go straight on the layer so
  // the layer opacity doesn't fade them out.
  const fills = document.createElement("div");
  fills.className = "anno-fills";
  const markers = document.createDocumentFragment();
  for (const a of annoStore.byPage(pageNum)) {
    a.rects.forEach((r) => {
      const box = denormRect(r, width, height);
      const div = document.createElement("div");
      div.className = `anno-rect anno-${a.color}`;
      div.style.left = `${box.left}px`;
      div.style.top = `${box.top}px`;
      div.style.width = `${box.width}px`;
      div.style.height = `${box.height}px`;
      fills.appendChild(div);
    });
    if (a.note && a.rects.length) {
      const last = denormRect(a.rects[a.rects.length - 1], width, height);
      const marker = document.createElement("div");
      marker.className = "anno-note-marker";
      marker.style.left = `${last.left + last.width - 3}px`;
      marker.style.top = `${last.top - 3}px`;
      markers.appendChild(marker);
    }
  }
  layer.replaceChildren(fills, markers);
}

// Repaint every currently-rendered page (after load, edit, delete, or recolor).
function repaintAllAnnotations(): void {
  for (const slotEl of Array.from(pdfPages.querySelectorAll<HTMLElement>(".page-slot"))) {
    const layer = slotEl.querySelector<HTMLElement>(".anno-layer");
    const canvas = slotEl.querySelector("canvas");
    const page = Number(slotEl.dataset.page);
    if (layer && canvas && page) {
      paintAnnoLayer(layer, page, canvas.clientWidth, canvas.clientHeight);
    }
  }
  refreshNotesPanelIfOpen(); // every edit path funnels through here, so the index stays live
}

// Build a SelectionAnchor from the live text selection, or null if empty / outside the PDF.
// A multi-page selection anchors to its START page (later-page rects are dropped); the quoted
// text keeps the whole selection.
function computeSelectionAnchor(): SelectionAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const startEl =
    range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as HTMLElement);
  const slotEl = startEl?.closest<HTMLElement>(".page-slot");
  if (!slotEl || !pdfPages.contains(slotEl)) return null;
  const canvas = slotEl.querySelector("canvas");
  const page = Number(slotEl.dataset.page);
  if (!canvas || !page) return null;
  const ref = canvas.getBoundingClientRect();
  // A selection can span pages; keep only the client rects whose center lands on this page.
  const onPage = Array.from(range.getClientRects()).filter((r) => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return cx >= ref.left && cx <= ref.right && cy >= ref.top && cy <= ref.bottom;
  });
  const rects = normalizeClientRects(onPage, ref);
  if (!rects.length) return null;
  return { page, rects, text: sel.toString() };
}

function createAnnotation(anchor: SelectionAnchor, color: string, note: string): Annotation {
  const now = new Date().toISOString();
  const a: Annotation = {
    id: genId(),
    page: anchor.page,
    rects: anchor.rects,
    text: anchor.text,
    note,
    color,
    createdAt: now,
    updatedAt: now,
  };
  annoStore.add(a);
  repaintAllAnnotations();
  return a;
}

function hitTestAnnotation(slotEl: HTMLElement, clientX: number, clientY: number): Annotation | null {
  const canvas = slotEl.querySelector("canvas");
  const page = Number(slotEl.dataset.page);
  if (!canvas || !page) return null;
  const ref = canvas.getBoundingClientRect();
  if (ref.width <= 0 || ref.height <= 0) return null;
  const px = (clientX - ref.left) / ref.width;
  const py = (clientY - ref.top) / ref.height;
  const list = annoStore.byPage(page);
  for (let i = list.length - 1; i >= 0; i--) {
    if (pointInRects(px, py, list[i].rects)) return list[i];
  }
  return null;
}

// Make `el` draggable by grabbing `handle`: live-updates el.style.left/top during the drag
// (clamped to the viewport) and calls onDrop with the final top-left once released. This is what
// lets the user shove the transient annotation windows out of the way; callers persist via onDrop.
function makeDraggable(
  el: HTMLElement,
  handle: HTMLElement,
  onDrop: (left: number, top: number) => void
): void {
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // keep any text selection alive; don't start a native drag
    e.stopPropagation(); // and don't let the global dismiss handler close the window mid-grab
    const start = el.getBoundingClientRect();
    const offX = e.clientX - start.left;
    const offY = e.clientY - start.top;
    handle.classList.add("dragging");
    const move = (ev: MouseEvent) => {
      const left = Math.max(6, Math.min(window.innerWidth - el.offsetWidth - 6, ev.clientX - offX));
      const top = Math.max(6, Math.min(window.innerHeight - el.offsetHeight - 6, ev.clientY - offY));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      handle.classList.remove("dragging");
      onDrop(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

// --- Notes panel: a searchable index of THIS PDF's highlights & notes --------
// A floating panel listing every annotation (quoted text + note), filterable by a search box.
// Clicking an entry scrolls the PDF to that highlight and opens its note for editing. The list
// is rebuilt from annoStore on open and on every edit (via refreshNotesPanelIfOpen).
const notesToggle = document.getElementById("notes-toggle") as HTMLButtonElement;
const notesPanel = document.createElement("div");
notesPanel.id = "notes-panel";
notesPanel.hidden = true;
const notesHeader = el("div", "notes-header");
const notesTitle = el("span", "notes-title", "Notes");
const notesClose = document.createElement("button");
notesClose.className = "notes-close";
notesClose.title = "Close";
notesClose.setAttribute("aria-label", "Close notes");
notesClose.textContent = "×";
notesClose.addEventListener("click", () => setNotesOpen(false));
notesHeader.append(notesTitle, notesClose);
const notesSearch = document.createElement("input");
notesSearch.className = "notes-search";
notesSearch.type = "search";
notesSearch.placeholder = "Search notes & highlights…";
notesSearch.addEventListener("input", () => renderNotesList());
const notesList = el("div", "notes-list");
notesPanel.append(notesHeader, notesSearch, notesList);
// Clicks inside the panel must not reach the global dismiss handler (which clears selections).
notesPanel.addEventListener("mousedown", (e) => e.stopPropagation());
document.body.appendChild(notesPanel);
// The header doubles as a drag handle so the panel itself can be moved aside.
makeDraggable(notesPanel, notesHeader, () => {});

function setNotesOpen(open: boolean): void {
  notesPanel.hidden = !open;
  notesToggle.setAttribute("aria-pressed", String(open));
  if (open) {
    renderNotesList();
    notesSearch.focus();
  }
}
notesToggle.addEventListener("click", () => setNotesOpen(notesPanel.hidden));

function refreshNotesPanelIfOpen(): void {
  if (!notesPanel.hidden) renderNotesList();
}

function renderNotesList(): void {
  const q = notesSearch.value.trim().toLowerCase();
  const all = annoStore.list();
  const items = all
    .filter((a) => !q || a.note.toLowerCase().includes(q) || a.text.toLowerCase().includes(q))
    .sort((a, b) => a.page - b.page || (a.rects[0]?.y0 ?? 0) - (b.rects[0]?.y0 ?? 0));
  notesTitle.textContent = `Notes · ${q ? `${items.length}/${all.length}` : all.length}`;

  if (!items.length) {
    notesList.replaceChildren(
      el("div", "notes-empty", all.length ? "No matches." : "No notes or highlights yet.")
    );
    return;
  }
  const frag = document.createDocumentFragment();
  for (const a of items) {
    const item = el("div", "notes-item");
    const top = el("div", "notes-item-top");
    top.appendChild(el("span", `notes-swatch anno-${a.color}`));
    top.appendChild(el("span", "notes-page", `p.${a.page}`));
    if (a.note) top.appendChild(el("span", "notes-badge", "note"));
    item.appendChild(top);
    // The quote's left rule mirrors the highlight's own color (set via the anno-<color> class).
    if (a.text) item.appendChild(el("div", `notes-quote anno-${a.color}`, a.text));
    if (a.note) item.appendChild(el("div", "notes-note", a.note));
    item.addEventListener("click", () => {
      setNotesOpen(false);
      goToAnnotation(a);
    });
    frag.appendChild(item);
  }
  notesList.replaceChildren(frag);
}

// Scroll the PDF to an annotation, then open its note for editing. The target page may still be
// a lazy placeholder; scrolling brings it into the IntersectionObserver's margin so it renders,
// and the popover opens once the smooth scroll settles.
function goToAnnotation(a: Annotation): void {
  const slotEl = pdfPages.querySelector<HTMLElement>(`.page-slot[data-page="${a.page}"]`);
  if (!slotEl) return;
  const rect = a.rects[0];
  const y0 = rect?.y0 ?? 0;
  const target = slotEl.offsetTop + y0 * slotEl.offsetHeight - 96;
  pdfPane.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  setTimeout(() => {
    // Anchor the note window just below the highlight's on-screen position (intuitive), rather
    // than screen-center. Computed after the smooth scroll settles so the rect is where it lands.
    if (rect) {
      const r = slotEl.getBoundingClientRect();
      openNotePopover(a, r.left + rect.x0 * r.width, r.top + rect.y1 * r.height);
    } else {
      openNotePopover(a);
    }
  }, 360);
}

// Floating selection toolbar: a drag grip, color swatches, and a Note action.
const selToolbar = document.createElement("div");
selToolbar.id = "sel-toolbar";
selToolbar.hidden = true;
const selGrip = document.createElement("span");
selGrip.className = "sel-grip";
selGrip.title = "Drag to move; double-click to re-anchor";
selGrip.setAttribute("aria-hidden", "true");
selGrip.textContent = "⠿";
selToolbar.appendChild(selGrip);
for (const color of ANNOTATION_COLORS) {
  const sw = document.createElement("button");
  sw.className = `swatch anno-${color}`;
  sw.title = `Highlight (${color})`;
  sw.setAttribute("aria-label", `Highlight ${color}`);
  sw.addEventListener("click", () => applyHighlight(color));
  selToolbar.appendChild(sw);
}
const selNoteBtn = document.createElement("button");
selNoteBtn.className = "sel-note-btn";
selNoteBtn.textContent = "Note";
selNoteBtn.title = "Highlight and add a note";
selNoteBtn.addEventListener("click", addNoteFromSelection);
selToolbar.appendChild(selNoteBtn);
// "Copy^p": copy the selection WITH its file path ("<relpath>\n<text>") for pasting as a quote
// with provenance — the superscript "p" reads as "copy, with path". Plain Ctrl/Cmd+C stays
// path-free.
const selCopyBtn = document.createElement("button");
selCopyBtn.className = "sel-copy-btn";
selCopyBtn.append(...copyWithPathLabel());
selCopyBtn.title = "Copy selection with file path & position";
selCopyBtn.addEventListener("click", copySelectionWithPath);
selToolbar.appendChild(selCopyBtn);
// Pressing a toolbar button must not collapse/blur the selection before the click lands.
selToolbar.addEventListener("mousedown", (e) => e.preventDefault());
document.body.appendChild(selToolbar);

let toolbarPos = { x: 0, y: 0 };
// The toolbar's un-shifted anchor position at the moment it was last shown — the baseline a
// drag's persisted offset is measured against (so the offset follows each new selection).
let selToolbarNatural = { x: 0, y: 0 };
function selOffset(): { dx: number; dy: number } {
  return ((vscode.getState() as SavedState) ?? {}).selToolbarOffset ?? { dx: 0, dy: 0 };
}
function showSelToolbar(): void {
  const sel = window.getSelection();
  const rects = sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects() : null;
  const last = rects && rects.length ? rects[rects.length - 1] : null;
  const anchorX = last ? last.right : window.innerWidth / 2;
  const anchorYTop = last ? last.top : window.innerHeight / 2;
  const anchorYBottom = last ? last.bottom : window.innerHeight / 2;
  selToolbar.hidden = false; // unhide before measuring
  const tb = selToolbar.getBoundingClientRect();
  const natX = Math.max(6, Math.min(window.innerWidth - tb.width - 6, anchorX - tb.width));
  // Default below the selection's last line; flip above only if there's no room below.
  let natY = anchorYBottom + 6;
  if (natY + tb.height > window.innerHeight - 6) natY = anchorYTop - tb.height - 6;
  selToolbarNatural = { x: natX, y: natY };
  // Shift by the user's persisted drag offset (if any), then re-clamp to the viewport.
  const off = selOffset();
  const left = Math.max(6, Math.min(window.innerWidth - tb.width - 6, natX + off.dx));
  const top = Math.max(6, Math.min(window.innerHeight - tb.height - 6, natY + off.dy));
  selToolbar.style.left = `${left}px`;
  selToolbar.style.top = `${top}px`;
  toolbarPos = { x: left, y: top };
}
// Dragging the grip persists an OFFSET from the natural anchor, so the toolbar keeps following
// the selection but lands where the user prefers; double-click re-anchors (clears the offset).
makeDraggable(selToolbar, selGrip, (left, top) =>
  saveState({ selToolbarOffset: { dx: left - selToolbarNatural.x, dy: top - selToolbarNatural.y } })
);
selGrip.addEventListener("dblclick", () => {
  saveState({ selToolbarOffset: { dx: 0, dy: 0 } });
  showSelToolbar();
});
function hideSelToolbar(): void {
  selToolbar.hidden = true;
}

function applyHighlight(color: string): void {
  if (!currentSelectionAnchor) return;
  createAnnotation(currentSelectionAnchor, color, "");
  window.getSelection()?.removeAllRanges();
  currentSelectionAnchor = null;
  hideSelToolbar();
}
function addNoteFromSelection(): void {
  if (!currentSelectionAnchor) return;
  const a = createAnnotation(currentSelectionAnchor, DEFAULT_COLOR, "");
  const pos = toolbarPos;
  window.getSelection()?.removeAllRanges();
  currentSelectionAnchor = null;
  hideSelToolbar();
  // Mark it provisional so closing without a note or a color choice discards it (see closeNotePopover).
  provisionalAnnoId = a.id;
  provisionalColorChosen = false;
  openNotePopover(a, pos.x, pos.y);
}

// Which cataloged figure (if any) the current PDF selection sits inside — so a label copied out of
// a figure says WHICH figure. The summary's figures[] carry a page + normalized bbox in the SAME
// upright-cropBox frame as the selection rects (see cropGeometry), so we just test the selection's
// center against each figure's bbox on its page and take the smallest (most specific) containing
// one. Empty when no summary is loaded, the figure has no bbox, or the selection isn't in a figure.
function pdfSelectionFigureLabel(): string {
  const anchor = currentSelectionAnchor;
  if (!anchor || summaryState.kind !== "ready") return "";
  const u = unionBbox(anchor.rects);
  if (!u) return "";
  return figureContainingPoint(
    summaryState.summary.summary.figures,
    anchor.page,
    (u.x0 + u.x1) / 2,
    (u.y0 + u.y1) / 2
  );
}

// --- "Ref" provenance line (Copy^p) -----------------------------------------
// Both Copy^p buttons prefix the copied text with one line — `Ref path=<file>, <typed keys…>` —
// then the selection on the following lines. Location keys are context-specific: `page` (PDF page),
// `fig` (the figure / diagram / table the text sits in), `sec` (nearest summary/AIDoc heading); the
// pure line assembly + quoting is buildRefLine (refLine.ts). These helpers extract the field values
// from the DOM. So a label copied out of a figure carries which file, page, and element it's from.
function refCollapse(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}
function refClip(s: string): string {
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}
// Page number from a `.page-badge` ("p.5") inside `el`, if any (kept as its own `page=` key, not
// left inside the fig/sec text).
function refPageFromBadge(el: Element | null): number | undefined {
  const m = el?.querySelector(".page-badge")?.textContent?.match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}
// `el`'s text with any `.page-badge` removed, collapsed and clipped.
function refTextWithoutBadge(el: Element | null): string {
  if (!el) return "";
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(".page-badge").forEach((b) => b.remove());
  return refClip(refCollapse(clone.textContent));
}

// Copy the PDF selection as a ===REFERENCE=== fence (`path=<pdf>, page=<N>[, fig="…"]`) then the
// text in a ===SELECTED TEXT=== fence. The page comes from the live selection anchor (a multi-page
// selection anchors to its start page); `fig` is added when the selection lands inside a cataloged
// figure. Uses the reflowed PDF text when available.
function copySelectionWithPath(): void {
  const text = reflowCurrentSelection() ?? window.getSelection()?.toString() ?? "";
  if (!text.trim()) return;
  const path = openedPdfRelPath.trim();
  const ref = path
    ? buildRefLine(path, [
        ["page", currentSelectionAnchor?.page],
        ["fig", pdfSelectionFigureLabel() || undefined],
      ])
    : "";
  const payload = buildCopyPayload(ref, text);
  const clip = navigator.clipboard;
  if (!clip) {
    showToast("Clipboard unavailable.");
    return;
  }
  void clip.writeText(payload).then(
    () => showToast(ref ? "Copied with Ref." : "Copied."),
    () => showToast("Could not copy to clipboard.")
  );
  window.getSelection()?.removeAllRanges();
  hideSelToolbar();
}

// Label nodes for a copy-with-path button: the word "Copy" plus a math-style superscript "p"
// (p = path). Returned as nodes so the <sup> renders as real superscript, not literal "^p".
function copyWithPathLabel(): Node[] {
  const sup = document.createElement("sup");
  sup.className = "copy-sup";
  sup.textContent = "p";
  return [document.createTextNode("Copy"), sup];
}

// --- Summary/AIDoc pane: copy-with-path -------------------------------------
// The PDF toolbar above is page-anchored (highlight/note need page rects). The right pane has no
// such anchors, so it gets its own minimal floating button: select text in the summary or an
// AIDoc and a "Copy^p" chip appears, copying "<artifact file path>\n<text>" for provenance.
const docCopyToolbar = document.createElement("div");
docCopyToolbar.id = "doc-copy-toolbar";
docCopyToolbar.hidden = true;
const docCopyBtn = document.createElement("button");
docCopyBtn.className = "sel-copy-btn";
docCopyBtn.append(...copyWithPathLabel());
docCopyBtn.title = "Copy selection with file path & position";
docCopyBtn.addEventListener("click", copyDocSelectionWithPath);
docCopyToolbar.appendChild(docCopyBtn);
// Pressing the button must not collapse the selection before the click lands.
docCopyToolbar.addEventListener("mousedown", (e) => e.preventDefault());
document.body.appendChild(docCopyToolbar);

// The workspace-relative file path of the artifact currently rendered in the right pane, or ""
// if none has one (e.g. the missing/waiting guidance). Used as the copy provenance prefix.
function currentArtifactRelPath(): string {
  if (selection.kind === "doc") return docRelPaths[selection.id] ?? "";
  if (selection.kind === "invalid") return selection.relPath;
  if (summaryState.kind === "ready") return summaryRelPathReady;
  return "";
}

// True when the live selection is non-empty and lives inside the summary/AIDoc pane.
function selectionInSummaryPane(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  if (!sel.toString().trim()) return false;
  const node = sel.getRangeAt(0).startContainer;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return !!el && summaryRoot.contains(el);
}

function showDocCopyToolbar(): void {
  const sel = window.getSelection();
  const rects = sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects() : null;
  const last = rects && rects.length ? rects[rects.length - 1] : null;
  docCopyToolbar.hidden = false; // unhide before measuring
  const tb = docCopyToolbar.getBoundingClientRect();
  const anchorX = last ? last.right : window.innerWidth / 2;
  const left = Math.max(6, Math.min(window.innerWidth - tb.width - 6, anchorX - tb.width));
  let top = (last ? last.bottom : window.innerHeight / 2) + 6;
  if (top + tb.height > window.innerHeight - 6) top = (last ? last.top : 0) - tb.height - 6;
  docCopyToolbar.style.left = `${left}px`;
  docCopyToolbar.style.top = `${Math.max(6, top)}px`;
}
function hideDocCopyToolbar(): void {
  docCopyToolbar.hidden = true;
}

// Structured location of the current summary/AIDoc selection, for the Ref line:
//   • inside a figure / diagram / chart / table → `fig` = its caption (label + caption; a
//     captionless diagram/chart/table degrades to a generic kind), `page` from the caption badge.
//   • otherwise → `sec` = nearest heading at/before the selection, `page` from its badge.
// The "p.N" page badge is pulled into its own `page` field rather than left inside fig/sec text.
function summarySelectionRef(): { fig?: string; sec?: string; page?: number } {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return {};
  const node = sel.getRangeAt(0).startContainer;
  const startEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  if (!startEl || !summaryRoot.contains(startEl)) return {};

  const figure = startEl.closest<HTMLElement>(".fig, .block-table");
  if (figure) {
    const cap = figure.querySelector("figcaption");
    const fig = refTextWithoutBadge(cap) || (figure.matches(".block-table") ? "Table" : "Figure");
    return { fig, page: refPageFromBadge(cap) };
  }

  // Nearest heading at/before the selection (querySelectorAll is in document order).
  let headingEl: HTMLElement | null = null;
  for (const h of Array.from(summaryRoot.querySelectorAll<HTMLElement>("h1, h2, h3, .doc-heading"))) {
    if (h.compareDocumentPosition(startEl) & Node.DOCUMENT_POSITION_FOLLOWING) headingEl = h;
    else break;
  }
  if (!headingEl) return {};
  return { sec: refTextWithoutBadge(headingEl) || undefined, page: refPageFromBadge(headingEl) };
}

// Copy the summary/AIDoc selection as a ===REFERENCE=== fence
// (`path=<artifact>[, fig="…"|sec="…"][, page=N]`) then text in a ===SELECTED TEXT=== fence.
function copyDocSelectionWithPath(): void {
  const text = window.getSelection()?.toString() ?? "";
  if (!text.trim()) return;
  const path = currentArtifactRelPath().trim();
  let ref = "";
  if (path) {
    const loc = summarySelectionRef();
    ref = buildRefLine(path, [
      ["fig", loc.fig],
      ["sec", loc.sec],
      ["page", loc.page],
    ]);
  }
  const payload = buildCopyPayload(ref, text);
  const clip = navigator.clipboard;
  if (!clip) {
    showToast("Clipboard unavailable.");
    return;
  }
  void clip.writeText(payload).then(
    () => showToast(ref ? "Copied with Ref." : "Copied."),
    () => showToast("Could not copy to clipboard.")
  );
  window.getSelection()?.removeAllRanges();
  hideDocCopyToolbar();
}

// Note popover: view/edit a highlight's note, recolor, or delete it.
let activePopoverId: string | null = null;
// A "provisional" annotation is one the Note button just created (default color, empty note)
// purely to host the popover. If the popover is closed with the note still empty and no color
// explicitly chosen, it's discarded — so a Note click that's abandoned leaves no stray highlight.
// Clicking an EXISTING highlight (or opening from the Notes panel) never sets this, so those are
// never auto-removed on close.
let provisionalAnnoId: string | null = null;
let provisionalColorChosen = false;
const popover = document.createElement("div");
popover.id = "note-popover";
popover.hidden = true;
// Draggable header: grabbing it moves the window and persists the spot; double-click re-docks.
const popHeader = el("div", "note-header");
const popTitles = el("div", "note-header-titles");
popTitles.appendChild(el("span", "note-header-title", "Note"));
popTitles.appendChild(el("span", "note-header-hint", "drag to move"));
popHeader.appendChild(popTitles);
// × close, top-right (mirrors the Notes panel). stopPropagation on mousedown so clicking it
// doesn't start a header drag.
const popClose = document.createElement("button");
popClose.className = "note-header-close";
popClose.title = "Close";
popClose.setAttribute("aria-label", "Close note");
popClose.textContent = "×";
popClose.addEventListener("mousedown", (e) => e.stopPropagation());
popClose.addEventListener("click", closeNotePopover);
popHeader.appendChild(popClose);
const popQuote = document.createElement("div");
popQuote.className = "note-quote";
const popText = document.createElement("textarea");
popText.className = "note-text";
popText.placeholder = "Add a note…";
popText.rows = 4;
popText.addEventListener("input", () => {
  if (!activePopoverId) return;
  annoStore.update(activePopoverId, { note: popText.value, updatedAt: new Date().toISOString() });
  repaintAllAnnotations(); // toggle the note marker live
});
const popColors = document.createElement("div");
popColors.className = "note-colors";
for (const color of ANNOTATION_COLORS) {
  const sw = document.createElement("button");
  sw.className = `swatch anno-${color}`;
  sw.title = `Recolor (${color})`;
  sw.addEventListener("click", () => {
    if (!activePopoverId) return;
    if (activePopoverId === provisionalAnnoId) provisionalColorChosen = true; // an explicit color commits it
    annoStore.update(activePopoverId, { color, updatedAt: new Date().toISOString() });
    repaintAllAnnotations();
  });
  popColors.appendChild(sw);
}
const popActions = document.createElement("div");
popActions.className = "note-actions";
const popDelete = document.createElement("button");
popDelete.className = "note-delete";
popDelete.textContent = "Delete";
popDelete.addEventListener("click", () => {
  if (!activePopoverId) return;
  annoStore.remove(activePopoverId);
  repaintAllAnnotations();
  closeNotePopover();
});
// Delete sits in the action row (where Close used to be); Close is now the × in the header.
popActions.append(popDelete);
popover.append(popHeader, popQuote, popText, popColors, popActions);
// Keep clicks inside the popover from reaching the global dismiss handler.
popover.addEventListener("mousedown", (e) => e.stopPropagation());
document.body.appendChild(popover);
// The window can be dragged aside while you work, but the move is NOT persisted: every open
// starts from a fixed, predictable anchor (the clicked highlight). Otherwise a window dragged
// somewhere odd in one session would reappear there — disorientingly — on the next.
makeDraggable(popover, popHeader, () => {});

// Open the note window for annotation `a` at a fixed anchor: the caller-supplied click/selection
// point, or screen-center when there's none (e.g. opened from the Notes panel). Never restores a
// previous drag position.
function openNotePopover(a: Annotation, x?: number, y?: number): void {
  activePopoverId = a.id;
  popQuote.textContent = a.text.length > 240 ? `${a.text.slice(0, 240)}…` : a.text;
  popText.value = a.note;
  popover.hidden = false; // unhide before measuring
  const pb = popover.getBoundingClientRect();
  let left: number;
  let top: number;
  if (typeof x === "number" && typeof y === "number") {
    left = x;
    top = y + 8;
  } else {
    left = (window.innerWidth - pb.width) / 2;
    top = (window.innerHeight - pb.height) / 2;
  }
  popover.style.left = `${Math.max(6, Math.min(window.innerWidth - pb.width - 6, left))}px`;
  popover.style.top = `${Math.max(6, Math.min(window.innerHeight - pb.height - 6, top))}px`;
  popText.focus();
}
function closeNotePopover(): void {
  const id = activePopoverId;
  popover.hidden = true;
  activePopoverId = null;
  // An abandoned Note: created by the Note button, closed with the note still empty and no color
  // explicitly chosen → discard it so no stray default highlight (or empty note) is left behind.
  if (id && id === provisionalAnnoId) {
    const a = annoStore.get(id);
    if (a && !a.note.trim() && !provisionalColorChosen) {
      annoStore.remove(id);
      repaintAllAnnotations();
    }
  }
  provisionalAnnoId = null;
  provisionalColorChosen = false;
}

// Starting any new gesture outside the transient UI dismisses it (the toolbar re-appears on
// mouseup if a selection was made; a highlight click re-opens the popover on mouseup).
document.addEventListener("mousedown", (e) => {
  const t = e.target as Node;
  if (selToolbar.contains(t) || popover.contains(t) || docCopyToolbar.contains(t)) return;
  hideSelToolbar();
  hideDocCopyToolbar();
  closeNotePopover();
});

document.addEventListener("mouseup", (e) => {
  const t = e.target as Node;
  if (selToolbar.contains(t) || popover.contains(t) || docCopyToolbar.contains(t)) return;
  // Let the browser finalize the selection before we read it.
  setTimeout(() => {
    const anchor = computeSelectionAnchor();
    if (anchor) {
      currentSelectionAnchor = anchor;
      showSelToolbar();
      return;
    }
    // A selection in the summary/AIDoc pane gets the copy-with-path chip instead.
    if (selectionInSummaryPane()) {
      showDocCopyToolbar();
      return;
    }
    // No selection → treat as a click: open a highlight's note if one was hit.
    const el = t instanceof Element ? t : null;
    const slotEl = el?.closest<HTMLElement>(".page-slot") ?? null;
    if (slotEl && pdfPages.contains(slotEl)) {
      const hit = hitTestAnnotation(slotEl, e.clientX, e.clientY);
      if (hit) openNotePopover(hit, e.clientX, e.clientY);
    }
  }, 0);
});

// Clearing the selection (collapsed) hides both toolbars.
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    hideSelToolbar();
    hideDocCopyToolbar();
  }
});

// Toolbar positions are viewport-fixed, so a scroll invalidates them — drop it (the popover
// is a modal editor and stays open).
pdfPane.addEventListener("scroll", hideSelToolbar);
summaryPane.addEventListener("scroll", hideDocCopyToolbar);

// Reflow copied PDF text (join wrapped lines within a paragraph, break at paragraph ends),
// overriding PDF.js's line-by-line copy. Installed once; it only acts on PDF text selections.
// Plain Ctrl/Cmd+C copies just the text — the file path is added only via the toolbar's
// "copy with path" button (see selToolbar), not on every copy.
enableCopyReflow();

// --- Find (Ctrl+F): pane-aware in-page search -------------------------------
// Replaces VS Code's native webview find (disabled host-side). Scope follows the focused pane:
//   • PDF (left)  → searches EVERY page. Page text is extracted once via getTextContent (cheap,
//     no rasterize); next/prev scroll to a match on any page, even one not currently rendered.
//   • Summary / AIDocs (right) → searches the rendered #summary-root.
// Matches are painted with the CSS Custom Highlight API (Range-based, no DOM mutation — coexists
// with the no-raw-innerHTML rendering). Highlights aren't retained across page eviction/zoom: we
// rebuild them from the live DOM on every relevant event (page render, nav, query change). The
// #bx-find styles + ::highlight(bx-find[-current]) rules live in webview.css.

type FindScope = "pdf" | "summary";

// CSS Custom Highlight API surface (typed loosely so we don't depend on the lib shipping it).
const findHighlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
const FindHighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
  .Highlight;

function setFindHighlights(all: Range[], current: Range | null): void {
  if (!findHighlightRegistry || !FindHighlightCtor) return;
  if (all.length) findHighlightRegistry.set("bx-find", new FindHighlightCtor(...all));
  else findHighlightRegistry.delete("bx-find");
  if (current) findHighlightRegistry.set("bx-find-current", new FindHighlightCtor(current));
  else findHighlightRegistry.delete("bx-find-current");
}
function clearFindHighlights(): void {
  findHighlightRegistry?.delete("bx-find");
  findHighlightRegistry?.delete("bx-find-current");
}

// Walk a subtree's text nodes into one string + a map of each node's start offset within it, so a
// match's [start,end) char range can be turned into a DOM Range. `skip(parentEl)` drops a node's
// whole subtree (used to keep KaTeX glyph spans out of the summary index).
interface FindTextSpan {
  node: Text;
  start: number;
}
function collectFindText(
  root: HTMLElement,
  skip?: (parent: Element) => boolean
): { text: string; spans: FindTextSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans: FindTextSpan[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    const parent = t.parentElement;
    if (!t.data || !parent || (skip && skip(parent))) continue;
    spans.push({ node: t, start: text.length });
    text += t.data;
  }
  return { text, spans };
}

// A DOM Range for the [start,end) slice of the concatenated text built by collectFindText.
function findRange(spans: FindTextSpan[], start: number, end: number): Range | null {
  if (end <= start) return null;
  const startSpan = spans.find((s) => start >= s.start && start < s.start + s.node.length);
  const last = end - 1;
  const endSpan = spans.find((s) => last >= s.start && last < s.start + s.node.length);
  if (!startSpan || !endSpan) return null;
  const r = document.createRange();
  r.setStart(startSpan.node, start - startSpan.start);
  r.setEnd(endSpan.node, end - endSpan.start);
  return r;
}

// All occurrence Ranges of an already-folded needle within `root` (in document order).
function findRangesIn(root: HTMLElement, needleFolded: string, skip?: (p: Element) => boolean): Range[] {
  const { text, spans } = collectFindText(root, skip);
  const ranges: Range[] = [];
  for (const start of locateAll(foldCase(text, false), needleFolded)) {
    const r = findRange(spans, start, start + needleFolded.length);
    if (r) ranges.push(r);
  }
  return ranges;
}

// Smooth-scroll a pane so a Range is comfortably in view — only if it's currently near/off an edge.
function scrollFindRangeIntoView(range: Range, pane: HTMLElement): void {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const pr = pane.getBoundingClientRect();
  const margin = 60;
  if (rect.top < pr.top + margin || rect.bottom > pr.bottom - margin) {
    const target = pane.scrollTop + (rect.top - pr.top) - pane.clientHeight / 3;
    pane.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }
}

// --- Active pane + scope ----------------------------------------------------
let activePane: FindScope = "pdf";
pdfPane.addEventListener("pointerdown", () => (activePane = "pdf"), true);
summaryPane.addEventListener("pointerdown", () => (activePane = "summary"), true);
function scopeForActivePane(): FindScope {
  // Only the PDF is searchable when the right pane is collapsed.
  return summaryOpen && activePane === "summary" ? "summary" : "pdf";
}

// --- Find state -------------------------------------------------------------
const findState = { open: false, scope: "pdf" as FindScope, query: "", count: 0, index: -1 };
let summaryFindRanges: Range[] = [];
let pdfFindMatches: PdfMatch[] = [];
let pdfCurrentRange: Range | null = null;

// PDF full-text index: built lazily on first PDF search (getTextContent over every page) and cached
// for the life of the (single) loaded document.
let pdfPageTexts: PageText[] | null = null;
let pdfIndexBuilding = false;
let pdfIndexPromise: Promise<PageText[]> | null = null;
async function ensurePdfIndex(): Promise<PageText[]> {
  if (pdfPageTexts) return pdfPageTexts;
  if (pdfIndexPromise) return pdfIndexPromise;
  pdfIndexBuilding = true;
  updateFindCount();
  pdfIndexPromise = (async () => {
    const doc = await pdfDocPromise;
    const pages: PageText[] = [];
    if (doc) {
      for (let i = 1; i <= doc.numPages; i++) {
        try {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          let text = "";
          for (const item of tc.items as Array<{ str?: string; hasEOL?: boolean }>) {
            if (typeof item.str === "string") {
              text += item.str;
              if (item.hasEOL) text += "\n";
            }
          }
          pages.push({ pageNum: i, text });
        } catch {
          pages.push({ pageNum: i, text: "" }); // a page that won't extract just contributes no hits
        }
      }
    }
    pdfPageTexts = pages;
    pdfIndexBuilding = false;
    // The caller (searchPdf) refreshes the count once it has computed matches — refreshing here
    // would flash "0/0" for a tick (matches aren't built yet).
    return pages;
  })();
  return pdfIndexPromise;
}

// --- Widget DOM -------------------------------------------------------------
const findWidget = document.createElement("div");
findWidget.id = "bx-find";
findWidget.hidden = true;
findWidget.addEventListener("mousedown", (e) => e.stopPropagation()); // don't trip body dismissers

const findScopeChip = document.createElement("button");
findScopeChip.className = "bx-find-scope";
findScopeChip.title = "Search scope — click to toggle PDF / summary";

const findInput = document.createElement("input");
findInput.id = "bx-find-input";
findInput.type = "text";
findInput.placeholder = "Find…";
findInput.setAttribute("aria-label", "Find");

const findCount = document.createElement("span");
findCount.id = "bx-find-count";

const findPrevBtn = document.createElement("button");
findPrevBtn.textContent = "‹";
findPrevBtn.title = "Previous match (Shift+Enter)";
findPrevBtn.setAttribute("aria-label", "Previous match");

const findNextBtn = document.createElement("button");
findNextBtn.textContent = "›";
findNextBtn.title = "Next match (Enter)";
findNextBtn.setAttribute("aria-label", "Next match");

const findCloseBtn = document.createElement("button");
findCloseBtn.textContent = "×";
findCloseBtn.title = "Close (Esc)";
findCloseBtn.setAttribute("aria-label", "Close find");

findWidget.append(findScopeChip, findInput, findCount, findPrevBtn, findNextBtn, findCloseBtn);
document.body.appendChild(findWidget);

findScopeChip.addEventListener("click", toggleFindScope);
findPrevBtn.addEventListener("click", findPrev);
findNextBtn.addEventListener("click", findNext);
findCloseBtn.addEventListener("click", closeFind);

let findDebounce: ReturnType<typeof setTimeout> | undefined;
findInput.addEventListener("input", () => {
  if (findDebounce) clearTimeout(findDebounce);
  findDebounce = setTimeout(runFindSearch, 160);
});
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) findPrev();
    else findNext();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});

function positionFindWidget(): void {
  const pane = findState.scope === "summary" ? summaryPane : pdfPane;
  const r = pane.getBoundingClientRect();
  const w = findWidget.getBoundingClientRect().width || 280;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + (r.width - w) / 2));
  findWidget.style.left = `${Math.round(left)}px`;
  findWidget.style.top = `${Math.round(r.top + 8)}px`;
}

function updateFindScopeChip(): void {
  findScopeChip.textContent = findState.scope === "summary" ? "Summary" : "PDF";
  findScopeChip.disabled = !summaryOpen; // nothing to switch to when the right pane is closed
}

function toggleFindScope(): void {
  if (!summaryOpen) return;
  findState.scope = findState.scope === "pdf" ? "summary" : "pdf";
  resetFindResults();
  updateFindScopeChip();
  positionFindWidget();
  runFindSearch();
  findInput.focus();
}

function resetFindResults(): void {
  clearFindHighlights();
  summaryFindRanges = [];
  pdfFindMatches = [];
  pdfCurrentRange = null;
  findState.count = 0;
  findState.index = -1;
}

function openFind(scope: FindScope): void {
  const wasOpen = findState.open;
  const scopeChanged = wasOpen && scope !== findState.scope;
  findState.open = true;
  findState.scope = scope;
  findWidget.hidden = false;
  // Switching scope on an already-open widget: drop the old scope's matches/highlights so the
  // count doesn't briefly show the previous pane's number while the new search runs.
  if (scopeChanged) resetFindResults();
  // On a FRESH open, seed from a short, single-line selection (mirrors VS Code's
  // find-from-selection). Don't clobber the query when Ctrl+F is pressed again while already open.
  if (!wasOpen) {
    const sel = window.getSelection()?.toString() ?? "";
    if (sel && sel.length <= 80 && !sel.includes("\n")) findInput.value = sel;
  }
  updateFindScopeChip();
  positionFindWidget();
  findInput.focus();
  findInput.select();
  runFindSearch();
}

function closeFind(): void {
  if (!findState.open) return;
  findState.open = false;
  findWidget.hidden = true;
  resetFindResults();
  findInput.blur();
}

function runFindSearch(): void {
  if (!findState.open) return;
  findState.query = findInput.value;
  if (findState.scope === "summary") searchSummary();
  else searchPdf();
}

// Called after the right pane re-renders (live-reload / artifact switch) so a summary-scoped find
// re-matches over the new DOM.
function refreshFindIfOpen(): void {
  if (findState.open && findState.scope === "summary") searchSummary();
}

// --- Summary-scoped search --------------------------------------------------
function searchSummary(): void {
  const needle = foldCase(findState.query, false);
  summaryFindRanges = needle.trim()
    ? findRangesIn(summaryRoot, needle, (p) => !!p.closest(".katex"))
    : [];
  findState.count = summaryFindRanges.length;
  findState.index = findState.count ? 0 : -1;
  paintSummaryFind();
}

function paintSummaryFind(): void {
  updateFindCount();
  if (!summaryFindRanges.length) {
    clearFindHighlights();
    return;
  }
  const cur = summaryFindRanges[findState.index] ?? null;
  const others = summaryFindRanges.filter((_, i) => i !== findState.index);
  setFindHighlights(others, cur);
  if (cur) scrollFindRangeIntoView(cur, summaryPane);
}

// --- PDF-scoped search (all pages) ------------------------------------------
function searchPdf(): void {
  const q = findState.query;
  pdfFindMatches = [];
  pdfCurrentRange = null;
  if (!q.trim()) {
    findState.count = 0;
    findState.index = -1;
    clearFindHighlights();
    updateFindCount();
    return;
  }
  updateFindCount(); // shows the indexing placeholder on the very first search
  void ensurePdfIndex().then((pages) => {
    // Drop a stale resolution (widget closed / pane switched / query moved on while indexing).
    if (!findState.open || findState.scope !== "pdf" || findState.query !== q) return;
    pdfFindMatches = buildPdfMatches(pages, q, false);
    findState.count = pdfFindMatches.length;
    findState.index = pdfFindMatches.length ? 0 : -1;
    updateFindCount();
    if (pdfFindMatches.length) goToPdfMatch(0);
    else clearFindHighlights();
  });
}

let pdfGoTimer: ReturnType<typeof setTimeout> | undefined;
function goToPdfMatch(i: number): void {
  if (i < 0 || i >= pdfFindMatches.length) return;
  findState.index = i;
  updateFindCount();
  const m = pdfFindMatches[i];
  const slot = pdfPages.querySelector<HTMLElement>(`.page-slot[data-page="${m.pageNum}"]`);
  if (!slot) {
    repaintPdfFindHighlights();
    return;
  }
  // Aim near the match using its offset within the page text (text isn't perfectly linear in y, but
  // this lands close enough to bring it on-screen). If the page is off-screen, jump instantly so the
  // IntersectionObserver renders its text layer; then, once rendered, repaint + smooth-nudge the
  // exact match into view. The onPageRendered hook is the safety net if the render outlasts the timer.
  const page = pdfPageTexts?.find((p) => p.pageNum === m.pageNum);
  const frac = page && page.text.length ? m.start / page.text.length : 0;
  const aim = slot.offsetTop + frac * slot.offsetHeight - pdfPane.clientHeight / 3;
  const onScreen =
    slot.offsetTop < pdfPane.scrollTop + pdfPane.clientHeight &&
    slot.offsetTop + slot.offsetHeight > pdfPane.scrollTop;
  if (!onScreen) pdfPane.scrollTo({ top: Math.max(0, aim) }); // instant: force the lazy render
  if (pdfGoTimer) clearTimeout(pdfGoTimer);
  pdfGoTimer = setTimeout(
    () => {
      repaintPdfFindHighlights();
      if (pdfCurrentRange) scrollFindRangeIntoView(pdfCurrentRange, pdfPane);
    },
    onScreen ? 30 : 320
  );
}

// Rebuild the PDF match highlights from whatever text layers are currently rendered. The globally
// selected match is identified by (page, per-page ordinal) so it survives the getTextContent ↔
// live-DOM offset differences — within a page the Nth occurrence is the Nth either way.
let pdfRepaintTimer: ReturnType<typeof setTimeout> | undefined;
function repaintPdfFindHighlights(): void {
  if (!findState.open || findState.scope !== "pdf") return;
  const needle = foldCase(findState.query, false);
  pdfCurrentRange = null;
  if (!needle.trim() || !pdfFindMatches.length) {
    clearFindHighlights();
    return;
  }
  const cur = pdfFindMatches[findState.index];
  const curOrdinal = ordinalInPage(pdfFindMatches, findState.index);
  const all: Range[] = [];
  for (const layer of Array.from(pdfPages.querySelectorAll<HTMLElement>(".textLayer"))) {
    const slot = layer.closest<HTMLElement>(".page-slot");
    const pageNum = slot ? Number(slot.dataset.page) : NaN;
    if (!pageNum) continue;
    const { text, spans } = collectFindText(layer);
    locateAll(foldCase(text, false), needle).forEach((start, ord) => {
      const r = findRange(spans, start, start + needle.length);
      if (!r) return;
      if (cur && pageNum === cur.pageNum && ord === curOrdinal) pdfCurrentRange = r;
      else all.push(r);
    });
  }
  setFindHighlights(all, pdfCurrentRange);
}

// --- Navigation + count -----------------------------------------------------
function gotoMatch(i: number): void {
  if (findState.scope === "pdf") {
    goToPdfMatch(i);
  } else {
    findState.index = i;
    paintSummaryFind();
  }
}
function findNext(): void {
  if (!findState.count) return;
  gotoMatch((findState.index + 1) % findState.count);
}
function findPrev(): void {
  if (!findState.count) return;
  gotoMatch((findState.index - 1 + findState.count) % findState.count);
}

function updateFindCount(): void {
  if (findState.scope === "pdf" && pdfIndexBuilding && findState.query.trim()) {
    findCount.textContent = "…";
    findCount.title = "Indexing pages…";
    findCount.classList.remove("none");
    return;
  }
  findCount.title = "";
  if (!findState.query.trim()) {
    findCount.textContent = "";
    findCount.classList.remove("none");
    return;
  }
  if (!findState.count) {
    findCount.textContent = "0/0";
    findCount.classList.add("none");
    return;
  }
  findCount.textContent = `${findState.index + 1}/${findState.count}`;
  findCount.classList.remove("none");
}

// A newly-rendered PDF page (or a zoom that re-rendered visible pages) should show its matches.
onPageRendered = () => {
  if (!findState.open || findState.scope !== "pdf") return;
  if (pdfRepaintTimer) clearTimeout(pdfRepaintTimer);
  pdfRepaintTimer = setTimeout(repaintPdfFindHighlights, 60); // coalesce render bursts
};

// Right pane opened/closed: reposition, and drop a now-unsearchable summary scope back to the PDF.
onSummaryToggle = () => {
  if (!findState.open) return;
  if (findState.scope === "summary" && !summaryOpen) {
    findState.scope = "pdf";
    resetFindResults();
    runFindSearch();
  }
  updateFindScopeChip();
  positionFindWidget();
};

// --- Keyboard + viewport ----------------------------------------------------
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    // Follow the pane the user last interacted with — EXCEPT when they're already in the find box
    // (clicking the input doesn't change activePane, so keep the current scope and just refocus).
    const scope = document.activeElement === findInput ? findState.scope : scopeForActivePane();
    openFind(scope);
    return;
  }
  if (e.key === "Escape" && findState.open) closeFind();
});
window.addEventListener("resize", () => {
  if (findState.open) positionFindWidget();
});

// Handshake: tell the host we're listening, so it posts bootstrap + summary.
vscode.postMessage({ type: "ready" });
