// Shared message protocol between the extension host (Node) and the webview (browser).
// Imported by both bundles so the two worlds agree on the wire format.

/** A normalized figure region on a page: [x0, y0, x1, y1] in 0..1, origin top-left. */
export type Bbox = [number, number, number, number];

/**
 * One highlight rectangle, normalized 0..1 against the page's UPRIGHT cropBox viewport
 * (the same frame as figure `Bbox` — see cropGeometry). A multi-line selection produces
 * several rects (one per text line), so a highlight follows the text rather than boxing it.
 */
export interface AnnotationRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A user-created highlight (optionally with a note), anchored to a page region. */
export interface Annotation {
  id: string;
  page: number; // 1-based source page
  rects: AnnotationRect[]; // normalized 0..1, upright cropBox frame
  text: string; // the quoted/selected text
  note: string; // free-form note; "" when the highlight has no note
  color: string; // palette key: "yellow" | "green" | "blue" | "pink"
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** A list item: a plain string, or an object with its own (optionally ordered) sub-list. */
export type ListItem = string | { text: string; ordered?: boolean; items?: ListItem[] };

/** One prose block inside a section. Figures appear inline via a `figure` block. */
export type Block =
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: ListItem[]; ordered?: boolean }
  | { type: "formula"; text: string }
  | { type: "figure"; label: string };

export interface Figure {
  label: string;
  caption: string;
  page: number | null;
  bbox: Bbox | null;
}

export interface Citation {
  title: string;
  authors?: string[];
  venue?: string | null;
  note: string;
}

/** Shape of a validated summary (mirrors schema/summary.schema.v2.json). */
export interface PaperSummary {
  schemaVersion: "2.0";
  paper: {
    sourcePath: string;
    title: string;
    authors: string[];
    year: number | null;
    venue: string | null;
    date: string | null;
  };
  summary: {
    tldr: string;
    keyContributions: string[];
    sections: { heading: string; page: number | null; blocks: Block[] }[];
    figures: Figure[];
    glossary: { term: string; definition: string }[];
    openQuestions: string[];
    relevantCitations: Citation[];
  };
  generatedBy: {
    agent: string;
    model: string | null;
    timestamp: string;
  };
}

/** Host -> webview messages. */
export type HostMessage =
  | {
      type: "bootstrap";
      pdfUri: string;
      pdfjsLibUri: string;
      pdfViewerLibUri: string;
      pdfWorkerUri: string;
      cMapUri: string;
      standardFontUri: string;
    }
  | { type: "summary"; summary: PaperSummary }
  | { type: "summary-missing"; summaryRelPath: string; skillName: string }
  | { type: "summary-invalid"; summaryRelPath: string; errors: string[] }
  | { type: "annotations"; annotations: Annotation[] };

/** Webview -> host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  // The webview owns annotation editing; it posts the full set after each change and the
  // host persists it to `.betaxiv/annotations/<contentId>.json` (the webview never
  // touches the filesystem — same boundary as the summary JSON).
  | { type: "annotations-save"; annotations: Annotation[] };
