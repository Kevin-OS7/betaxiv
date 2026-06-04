// Copy reflow for the PDF text layer. PDF.js's TextLayerBuilder copies one line per PDF line,
// which reads badly; here we rejoin wrapped lines within a paragraph (de-hyphenating split
// words) and break at paragraph ends. We listen in the CAPTURE phase so this runs before the
// builder's own copy handler and replaces it for PDF selections; summary-pane copy is untouched.

import { reflowLines, type ReflowLine } from "./textReflow";

let installed = false;

export function enableCopyReflow(): void {
  if (installed) return;
  installed = true;

  document.addEventListener(
    "copy",
    (event) => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const startEl =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as Element);
      const layer = startEl?.closest<HTMLElement>(".textLayer");
      // Only reflow selections that start inside a PDF text layer.
      if (!layer) return;
      const text = reflowSelectionInLayer(range, layer);
      if (text && event.clipboardData) {
        event.clipboardData.setData("text/plain", text);
        event.preventDefault();
        // Stop the builder's bubble-phase copy handler from overwriting our reflowed text.
        event.stopPropagation();
      }
    },
    true // capture: run ahead of the text layer's own copy listener
  );
}

interface Frag {
  text: string;
  left: number;
  right: number;
  top: number;
  height: number;
}

// Reconstruct the selected text within one text layer as reflowed paragraphs. We take the
// selected substring of each intersecting leaf span (in reading/DOM order), group them into
// lines by vertical position, then hand the lines to reflowLines.
function reflowSelectionInLayer(range: Range, layer: HTMLElement): string {
  const spans = Array.from(layer.querySelectorAll<HTMLElement>("span")).filter(
    (s) => s.firstChild?.nodeType === Node.TEXT_NODE && s.textContent
  );

  const frags: Frag[] = [];
  for (const span of spans) {
    if (!range.intersectsNode(span)) continue;
    const full = span.textContent ?? "";
    let from = 0;
    let to = full.length;
    if (span.contains(range.startContainer)) from = range.startOffset;
    if (span.contains(range.endContainer)) to = range.endOffset;
    const piece = full.slice(from, to);
    if (!piece) continue;
    const r = span.getBoundingClientRect();
    frags.push({ text: piece, left: r.left, right: r.right, top: r.top, height: r.height });
  }
  if (!frags.length) return "";

  frags.sort((a, b) => a.top - b.top || a.left - b.left);
  const tol = Math.max(2, frags[0].height * 0.5);
  const lines: ReflowLine[] = [];
  let cur: Frag[] = [];
  let curTop = frags[0].top;
  for (const f of frags) {
    if (cur.length && Math.abs(f.top - curTop) > tol) {
      lines.push(mergeLine(cur));
      cur = [];
    }
    if (!cur.length) curTop = f.top;
    cur.push(f);
  }
  if (cur.length) lines.push(mergeLine(cur));
  return reflowLines(lines);
}

function mergeLine(frags: Frag[]): ReflowLine {
  frags.sort((a, b) => a.left - b.left);
  let text = "";
  for (let i = 0; i < frags.length; i++) {
    const f = frags[i];
    if (i > 0) {
      const gap = f.left - frags[i - 1].right;
      // Add a space only when there's a real horizontal gap and neither side already has one.
      if (gap > f.height * 0.25 && !/\s$/.test(text) && !/^\s/.test(f.text)) text += " ";
    }
    text += f.text;
  }
  return {
    text,
    left: Math.min(...frags.map((f) => f.left)),
    right: Math.max(...frags.map((f) => f.right)),
  };
}
