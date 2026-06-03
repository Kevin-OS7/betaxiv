// Shared message protocol between the extension host (Node) and the webview (browser).
// Imported by both bundles so the two worlds agree on the wire format.

/** Shape of a validated summary (mirrors schema/summary.schema.v1.json). */
export interface PaperSummary {
  schemaVersion: "1.0";
  paper: {
    sourcePath: string;
    title: string;
    authors: string[];
    year: number | null;
    venue: string | null;
  };
  summary: {
    tldr: string;
    keyContributions: string[];
    sections: { heading: string; page: number | null; points: string[] }[];
    figures: { label: string; caption: string; page: number | null }[];
    glossary: { term: string; definition: string }[];
    openQuestions: string[];
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
