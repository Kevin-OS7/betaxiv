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

/** A section heading inside a doc (the doc title is level 1; headings are level 2 or 3). */
export interface HeadingBlock {
  type: "heading";
  text: string;
  level?: 2 | 3;
}

/** A declarative data table. Cells are inline-markup strings (**bold**, `code`, $math$). */
export interface TableBlock {
  type: "table";
  caption?: string | null;
  header: string[];
  rows: string[][];
}

/** A declarative diagram: Mermaid source the webview renders to SVG (the agent never draws). */
export interface DiagramBlock {
  type: "diagram";
  mermaid: string;
  caption?: string | null;
}

/** Symmetric ± error (a number) or an absolute interval {low, high}, in data units. */
export type ChartErrorBar = number | { low: number; high: number };

export interface ChartPoint {
  x: number;
  y: number;
  label?: string | null;
  xError?: ChartErrorBar;
  yError?: ChartErrorBar;
}

export interface ChartSeries {
  name: string;
  marker?: "circle" | "square" | "triangle" | "diamond" | "cross";
  /** Optional hex color (#rgb or #rrggbb); falls back to the auto-assigned palette color. */
  color?: string;
  points: ChartPoint[];
}

export interface ChartAxis {
  label: string;
  scale: "linear" | "log";
  domain?: "auto" | [number, number];
  tickCount?: number;
}

/**
 * A scientific plot (scatter or numeric-x line) the extension draws as a crisp vector SVG from
 * declarative data: log axes, error bars, multiple series, legend. Categorical BAR charts use a
 * Mermaid `diagram` (xychart-beta) instead.
 */
export interface ChartBlock {
  type: "chart";
  kind: "scatter" | "line";
  title?: string | null;
  caption?: string | null;
  alt?: string | null;
  legend?: boolean;
  xAxis: ChartAxis;
  yAxis: ChartAxis;
  series: ChartSeries[];
}

/**
 * Blocks allowed inside an AIDoc: the summary block union plus the doc-only declarative
 * `table` and `diagram` blocks. Summaries keep using the narrower `Block`.
 */
export type DocBlock = Block | HeadingBlock | TableBlock | DiagramBlock | ChartBlock;

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

/** A validated AIDoc (mirrors schema/document.schema.v1.json). */
export interface PaperDoc {
  schemaVersion: "1.0";
  doc: {
    id: string;
    title: string;
    kind: string;
    sourcePath: string;
    description: string | null;
  };
  blocks: DocBlock[];
  figures?: Figure[];
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
      pdfRelPath: string; // PDF path relative to the workspace root (for copy provenance); "" if none
      pdfjsLibUri: string;
      pdfViewerLibUri: string;
      pdfWorkerUri: string;
      cMapUri: string;
      standardFontUri: string;
    }
  | { type: "summary"; summary: PaperSummary }
  | { type: "summary-missing"; summaryRelPath: string; skillName: string }
  | { type: "summary-invalid"; summaryRelPath: string; errors: string[] }
  // The full set of validated AIDocs for this paper, rebuilt and re-sent on any change.
  // `invalid` carries docs that failed schema validation so the UI can surface them.
  | {
      type: "docs";
      docs: PaperDoc[];
      invalid: { relPath: string; errors: string[] }[];
      docsSkillName: string;
    }
  | { type: "annotations"; annotations: Annotation[] };

/** Webview -> host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  // The webview owns annotation editing; it posts the full set after each change and the
  // host persists it to `.betaxiv/annotations/<contentId>.json` (the webview never
  // touches the filesystem — same boundary as the summary JSON).
  | { type: "annotations-save"; annotations: Annotation[] }
  // User asked to delete an AIDoc. The host resolves the file (by content id-keyed docId for a
  // valid doc, or by relPath for an invalid one), confirms, and deletes it (to the trash). The
  // webview never touches the filesystem — same boundary as summaries/annotations.
  | { type: "doc-delete"; docId?: string; relPath?: string; label?: string }
  // User asked to delete this paper's summary file (same boundary/flow as doc-delete).
  | { type: "summary-delete" };
