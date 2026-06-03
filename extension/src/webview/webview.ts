// Webview (browser world). Receives messages from the host, renders the PDF on the
// left via vendored PDF.js, and the validated summary on the right. No network, no
// browser storage — state goes through the VS Code webview state API (rules 1 & 5).

import type { HostMessage, PaperSummary } from "../protocol";

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

interface SavedState {
  pdfScrollTop?: number;
  zoom?: number;
  summaryOpen?: boolean;
  splitCols?: string;
}
function saveState(patch: Partial<SavedState>): void {
  const cur = (vscode.getState() as SavedState) ?? {};
  vscode.setState({ ...cur, ...patch });
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "bootstrap":
      void renderPdf(msg.pdfUri, msg.pdfjsLibUri, msg.pdfWorkerUri, msg.cMapUri, msg.standardFontUri);
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
  workerUri: string,
  cMapUri: string,
  standardFontUri: string
): Promise<void> {
  try {
    // pdf.js is a vendored .mjs loaded from a local, CSP-pinned URI (not bundled).
    const pdfjsLib: any = await import(/* @vite-ignore */ libUri);

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
        victim.canvas?.remove();
        victim.canvas = undefined;
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

function renderSummary(s: PaperSummary): void {
  const root = document.createElement("div");

  // Header
  const header = el("div", "summary-header");
  header.appendChild(el("h1", undefined, s.paper.title));
  const metaBits: string[] = [];
  if (s.paper.authors.length) metaBits.push(s.paper.authors.join(", "));
  if (s.paper.venue) metaBits.push(s.paper.venue);
  if (s.paper.year !== null) metaBits.push(String(s.paper.year));
  header.appendChild(el("div", "summary-meta", metaBits.join(" · ")));
  root.appendChild(header);

  // TL;DR
  if (s.summary.tldr) {
    const sec = section("TL;DR");
    sec.appendChild(el("div", "tldr", s.summary.tldr));
    root.appendChild(sec);
  }

  // Key contributions
  if (s.summary.keyContributions.length) {
    const sec = section("Key Contributions");
    sec.appendChild(listOf(s.summary.keyContributions));
    root.appendChild(sec);
  }

  // Sections
  if (s.summary.sections.length) {
    const sec = section("Sections");
    for (const block of s.summary.sections) {
      const div = el("div", "section-block");
      const h = el("h3");
      h.appendChild(document.createTextNode(block.heading));
      const badge = pageBadge(block.page);
      if (badge) h.appendChild(badge);
      div.appendChild(h);
      if (block.points.length) div.appendChild(listOf(block.points));
      sec.appendChild(div);
    }
    root.appendChild(sec);
  }

  // Figures
  if (s.summary.figures.length) {
    const sec = section("Figures & Tables");
    for (const fig of s.summary.figures) {
      const figure = el("figure", "fig");
      const cap = document.createElement("figcaption");
      const label = el("strong", undefined, fig.label);
      cap.appendChild(label);
      const badge = pageBadge(fig.page);
      if (badge) {
        cap.appendChild(document.createTextNode(" "));
        cap.appendChild(badge);
      }
      cap.appendChild(document.createTextNode(` — ${fig.caption}`));
      figure.appendChild(cap);
      sec.appendChild(figure);
    }
    root.appendChild(sec);
  }

  // Glossary
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

  // Open questions
  if (s.summary.openQuestions.length) {
    const sec = section("Open Questions");
    sec.appendChild(listOf(s.summary.openQuestions));
    root.appendChild(sec);
  }

  // Footer (provenance)
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

// Handshake: tell the host we're listening, so it posts bootstrap + summary.
vscode.postMessage({ type: "ready" });
