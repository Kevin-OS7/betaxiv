// Shared message protocol between the extension host (Node) and the webview (browser).
// Imported by both bundles so the two worlds agree on the wire format.

/** A normalized figure region on a page: [x0, y0, x1, y1] in 0..1, origin top-left. */
export type Bbox = [number, number, number, number];

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
      pdfWorkerUri: string;
      cMapUri: string;
      standardFontUri: string;
    }
  | { type: "summary"; summary: PaperSummary }
  | { type: "summary-missing"; summaryRelPath: string; skillName: string }
  | { type: "summary-invalid"; summaryRelPath: string; errors: string[] };

/** Webview -> host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "error"; message: string };
