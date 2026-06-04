// Webview (browser world). Receives messages from the host, renders the PDF on the
// left via vendored PDF.js, and the validated summary on the right. No network, no
// browser storage — state goes through the VS Code webview state API (rules 1 & 5).

import katex from "katex";
import type {
  HostMessage,
  PaperSummary,
  Block,
  Figure,
  ListItem,
  Annotation,
  AnnotationRect,
} from "../protocol";
import { normalizeBbox, sourceRect } from "./cropGeometry";
import {
  AnnotationStore,
  ANNOTATION_COLORS,
  DEFAULT_COLOR,
  normalizeClientRects,
  denormRect,
  pointInRects,
} from "./annotations";
import { enableCopyReflow } from "./textLayerSelection";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

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

interface SavedState {
  pdfScrollTop?: number;
  zoom?: number;
  summaryOpen?: boolean;
  splitCols?: string;
  summaryZoom?: number;
}
function saveState(patch: Partial<SavedState>): void {
  const cur = (vscode.getState() as SavedState) ?? {};
  vscode.setState({ ...cur, ...patch });
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "bootstrap":
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
      renderSummary(msg.summary);
      setSummaryStatus("ready");
      break;
    case "summary-missing":
      renderGuidance(msg.summaryRelPath, msg.skillName);
      setSummaryStatus("missing");
      break;
    case "summary-invalid":
      renderInvalid(msg.summaryRelPath, msg.errors);
      setSummaryStatus("invalid");
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
const summaryToggle = document.getElementById("summary-toggle") as HTMLButtonElement;
const summaryStatus = document.getElementById("summary-status") as HTMLElement;

const viewState = (vscode.getState() as SavedState) ?? {};
if (viewState.splitCols) app.style.setProperty("--split-cols", viewState.splitCols);

// Summary is collapsed by default; the user opens it with the toggle (choice persists).
let summaryOpen = viewState.summaryOpen ?? false;
function setSummaryOpen(open: boolean): void {
  summaryOpen = open;
  app.classList.toggle("summary-open", open);
  summaryToggle.setAttribute("aria-pressed", String(open));
  saveState({ summaryOpen: open });
}
setSummaryOpen(summaryOpen);
summaryToggle.addEventListener("click", () => setSummaryOpen(!summaryOpen));

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
summaryPane.addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    applySummaryZoom(summaryZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false }
);

// Top-right notice so the user knows a summary is missing/invalid even while collapsed.
type SummaryStatus = "ready" | "missing" | "invalid";
function setSummaryStatus(status: SummaryStatus): void {
  if (status === "missing") {
    summaryStatus.textContent = "Not yet summarized";
    summaryStatus.hidden = false;
  } else if (status === "invalid") {
    summaryStatus.textContent = "Summary invalid";
    summaryStatus.hidden = false;
  } else {
    summaryStatus.hidden = true;
  }
}

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
    let containerWidth = pdfPages.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;

    // User zoom, relative to the fit-to-width baseline (zoom 1 == 100% == fits the pane).
    const MIN_ZOOM = 0.5;
    const MAX_ZOOM = 3;
    const savedState = (vscode.getState() as SavedState) ?? {};
    let zoom =
      typeof savedState.zoom === "number"
        ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, savedState.zoom))
        : 1;
    const scaleFor = (baseWidth: number) =>
      Math.min(2, (containerWidth - 16) / baseWidth) * zoom;

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

    const zoomLevel = document.getElementById("zoom-level");
    const updateZoomLabel = () => {
      if (zoomLevel) zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
    };

    // Re-scale every slot to the current zoom/containerWidth: drop stale canvases,
    // recompute viewports (loaded pages) or reset to the new placeholder estimate
    // (not-yet-loaded pages).
    const rescaleAll = () => {
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

    const applyZoom = (target: number) => {
      const prev = zoom;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target));
      if (Math.abs(next - prev) < 0.001) return;
      const oldScrollTop = pdfPane.scrollTop;
      zoom = next;
      rescaleAll();
      // Heights scale linearly with zoom, so scaling scrollTop keeps the same content
      // anchored near the top of the viewport.
      pdfPane.scrollTop = oldScrollTop * (next / prev);
      updateZoomLabel();
      renderVisible();
      saveState({ zoom: next });
    };

    // Re-fit to the pane width when it changes (summary toggle/resize, window resize),
    // preserving the scroll position proportionally. Debounced so a splitter drag doesn't
    // trigger a re-render storm.
    const relayout = () => {
      const w = pdfPages.clientWidth;
      if (!w || w === containerWidth) return;
      const frac = pdfPane.scrollTop / (pdfPages.scrollHeight || 1);
      containerWidth = w;
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

    document.getElementById("zoom-in")?.addEventListener("click", () => applyZoom(zoom * 1.2));
    document.getElementById("zoom-out")?.addEventListener("click", () => applyZoom(zoom / 1.2));
    document.getElementById("zoom-reset")?.addEventListener("click", () => applyZoom(1));

    window.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        applyZoom(zoom * 1.2);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        applyZoom(zoom / 1.2);
      } else if (e.key === "0") {
        e.preventDefault();
        applyZoom(1);
      }
    });

    pdfPane.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        applyZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
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
    const holder = el("div", "fig-image-holder");
    holder.appendChild(el("div", "figure-loading", "Rendering figure…"));
    figure.appendChild(holder);
    void withFigSlot(() => renderFigureImage(fig, holder));
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

function renderBlocks(
  blocks: Block[],
  figuresByLabel: Map<string, Figure>,
  parent: HTMLElement
): void {
  for (const b of blocks) {
    if (b.type === "paragraph") {
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
    }
  }
}

function renderSummary(s: PaperSummary): void {
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

// Floating selection toolbar: color swatches + a Note action.
const selToolbar = document.createElement("div");
selToolbar.id = "sel-toolbar";
selToolbar.hidden = true;
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
// Pressing a toolbar button must not collapse/blur the selection before the click lands.
selToolbar.addEventListener("mousedown", (e) => e.preventDefault());
document.body.appendChild(selToolbar);

let toolbarPos = { x: 0, y: 0 };
function showSelToolbar(): void {
  const sel = window.getSelection();
  const rects = sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects() : null;
  const last = rects && rects.length ? rects[rects.length - 1] : null;
  const anchorX = last ? last.right : window.innerWidth / 2;
  const anchorYTop = last ? last.top : window.innerHeight / 2;
  const anchorYBottom = last ? last.bottom : window.innerHeight / 2;
  selToolbar.hidden = false; // unhide before measuring
  const tb = selToolbar.getBoundingClientRect();
  const left = Math.max(6, Math.min(window.innerWidth - tb.width - 6, anchorX - tb.width));
  // Default below the selection's last line; flip above only if there's no room below.
  let top = anchorYBottom + 6;
  if (top + tb.height > window.innerHeight - 6) top = anchorYTop - tb.height - 6;
  selToolbar.style.left = `${left}px`;
  selToolbar.style.top = `${top}px`;
  toolbarPos = { x: left, y: top };
}
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
  openNotePopover(a, pos.x, pos.y);
}

// Note popover: view/edit a highlight's note, recolor, or delete it.
let activePopoverId: string | null = null;
const popover = document.createElement("div");
popover.id = "note-popover";
popover.hidden = true;
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
const popClose = document.createElement("button");
popClose.className = "note-close";
popClose.textContent = "Close";
popClose.addEventListener("click", closeNotePopover);
popActions.append(popDelete, popClose);
popover.append(popQuote, popText, popColors, popActions);
// Keep clicks inside the popover from reaching the global dismiss handler.
popover.addEventListener("mousedown", (e) => e.stopPropagation());
document.body.appendChild(popover);

function openNotePopover(a: Annotation, x: number, y: number): void {
  activePopoverId = a.id;
  popQuote.textContent = a.text.length > 240 ? `${a.text.slice(0, 240)}…` : a.text;
  popText.value = a.note;
  popover.hidden = false; // unhide before measuring
  const pb = popover.getBoundingClientRect();
  const left = Math.max(6, Math.min(window.innerWidth - pb.width - 6, x));
  const top = Math.max(6, Math.min(window.innerHeight - pb.height - 6, y + 8));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popText.focus();
}
function closeNotePopover(): void {
  popover.hidden = true;
  activePopoverId = null;
}

// Starting any new gesture outside the transient UI dismisses it (the toolbar re-appears on
// mouseup if a selection was made; a highlight click re-opens the popover on mouseup).
document.addEventListener("mousedown", (e) => {
  const t = e.target as Node;
  if (selToolbar.contains(t) || popover.contains(t)) return;
  hideSelToolbar();
  closeNotePopover();
});

document.addEventListener("mouseup", (e) => {
  const t = e.target as Node;
  if (selToolbar.contains(t) || popover.contains(t)) return;
  // Let the browser finalize the selection before we read it.
  setTimeout(() => {
    const anchor = computeSelectionAnchor();
    if (anchor) {
      currentSelectionAnchor = anchor;
      showSelToolbar();
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

// Clearing the selection (collapsed) hides the toolbar.
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) hideSelToolbar();
});

// Toolbar positions are viewport-fixed, so a scroll invalidates them — drop it (the popover
// is a modal editor and stays open).
pdfPane.addEventListener("scroll", hideSelToolbar);

// Reflow copied PDF text (join wrapped lines within a paragraph, break at paragraph ends),
// overriding PDF.js's line-by-line copy. Installed once; it only acts on PDF text selections.
enableCopyReflow();

// Handshake: tell the host we're listening, so it posts bootstrap + summary.
vscode.postMessage({ type: "ready" });
