// Pure text-search helpers for the in-webview find (Ctrl+F). NO DOM / vscode imports, so this
// stays unit-testable in plain Node — same split as contentIndexCore.ts / textReflow.ts. The DOM
// side (building Ranges over the PDF text layer or the summary DOM and painting them via the CSS
// Custom Highlight API, plus scrolling) lives in webview.ts.

export interface PageText {
  /** 1-based PDF page number. */
  pageNum: number;
  /** The page's concatenated text (from PDF.js getTextContent). */
  text: string;
}

export interface PdfMatch {
  pageNum: number;
  /** Start offset of the match within that page's `text`. */
  start: number;
}

/**
 * Case-fold for matching. We deliberately avoid Unicode normalization (NFKC / diacritic folding):
 * those can change a string's length, which would break the 1:1 offset↔text mapping the
 * highlighter relies on (the same `start` is used to build a DOM Range against the original text).
 * `toLowerCase` keeps length stable for the scripts papers use in practice. `caseSensitive`
 * returns the input unchanged.
 */
export function foldCase(s: string, caseSensitive: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

/**
 * Start indices of every NON-overlapping occurrence of `needleFolded` in `haystackFolded`. Both
 * arguments must already be case-folded the same way (see {@link foldCase}). Empty needle → [].
 */
export function locateAll(haystackFolded: string, needleFolded: string): number[] {
  const out: number[] = [];
  if (!needleFolded) return out;
  let i = haystackFolded.indexOf(needleFolded);
  while (i !== -1) {
    out.push(i);
    i = haystackFolded.indexOf(needleFolded, i + needleFolded.length);
  }
  return out;
}

/**
 * Flatten every match of `query` across `pages` into a single list, ordered by page then by
 * position within the page — the order the find widget's next/prev walks. `pages` must already be
 * in page order. Returns [] for an empty/whitespace query.
 */
export function buildPdfMatches(
  pages: PageText[],
  query: string,
  caseSensitive = false
): PdfMatch[] {
  const needle = foldCase(query, caseSensitive);
  if (!needle.trim()) return [];
  const matches: PdfMatch[] = [];
  for (const p of pages) {
    for (const start of locateAll(foldCase(p.text, caseSensitive), needle)) {
      matches.push({ pageNum: p.pageNum, start });
    }
  }
  return matches;
}

/**
 * Ordinal (0-based) of the match at `index` among the matches on its OWN page. Used to map the
 * globally-selected match to the N-th occurrence found when re-scanning that page's live DOM
 * (offsets from getTextContent and from the rendered text layer need not be identical, but the
 * per-page occurrence ORDER is). Returns 0 for an out-of-range index.
 */
export function ordinalInPage(matches: PdfMatch[], index: number): number {
  if (index < 0 || index >= matches.length) return 0;
  const pn = matches[index].pageNum;
  let ord = 0;
  for (let j = 0; j < index; j++) {
    if (matches[j].pageNum === pn) ord++;
  }
  return ord;
}
