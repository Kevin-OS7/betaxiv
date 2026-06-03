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
      break;
    case "summary-missing":
      renderGuidance(msg.summaryRelPath, msg.skillName);
      break;
    case "summary-invalid":
      renderInvalid(msg.summaryRelPath, msg.errors);
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
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUri;

    const doc = await pdfjsLib.getDocument({
      url: pdfUri,
      cMapUrl: cMapUri,
      cMapPacked: true,
      standardFontDataUrl: standardFontUri,
    }).promise;
    pdfStatus.style.display = "none";
    pdfPages.replaceChildren();

    const containerWidth = pdfPages.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;

    // Lazy rendering: build correctly-sized placeholder slots up front (so scroll geometry
    // is stable), then rasterize a page to canvas only when it nears the viewport, and
    // release its canvas when it scrolls far away. This bounds memory on large PDFs
    // regardless of retainContextWhenHidden.
    interface Slot {
      el: HTMLElement;
      page: any;
      viewport: any;
      canvas?: HTMLCanvasElement;
      rendering?: boolean;
    }
    const slots: Slot[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, (containerWidth - 16) / base.width);
      const viewport = page.getViewport({ scale });

      const el = document.createElement("div");
      el.className = "page-slot";
      el.style.width = `${Math.floor(viewport.width)}px`;
      el.style.height = `${Math.floor(viewport.height)}px`;
      pdfPages.appendChild(el);
      slots.push({ el, page, viewport });
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
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      canvas.width = Math.floor(slot.viewport.width * dpr);
      canvas.height = Math.floor(slot.viewport.height * dpr);
      canvas.style.width = `${Math.floor(slot.viewport.width)}px`;
      canvas.style.height = `${Math.floor(slot.viewport.height)}px`;
      slot.el.replaceChildren(canvas);
      slot.canvas = canvas;
      try {
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
    const state = (vscode.getState() as SavedState) ?? {};
    if (typeof state.pdfScrollTop === "number") {
      pdfPane.scrollTop = state.pdfScrollTop;
    }
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
