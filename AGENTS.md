# AGENTS.md

Guidance for coding agents (Claude Code / Codex / Gemini CLI) working in this repo.
`CLAUDE.md` and `GEMINI.md` are symlinks to this file. See [README.md](README.md) for the
user-facing overview.

## What this is

BetaXiv is a VS Code extension for reading papers: the **real PDF on the left** (rendered by
PDF.js), an **AI-generated structured summary plus AIDocs on the right**. The summaries and
AIDocs are written by the user's *own* coding agent running a bundled Agent Skill — **not by
the extension**. The extension is a **pure renderer**: it reads JSON files and draws them. It
never calls a model, touches OAuth/API keys, launches an agent, or makes network calls.

The wedge: let people read papers with the frontier model they *already pay for* (their
Claude/Codex/Gemini subscription), with no second subscription and no per-token API key.

## Non-negotiable constraints

These are product-defining. Do not violate them, and flag any task that would.

1. **The extension never does inference or networking.** No model calls, no API keys, no
   OAuth, no telemetry, no launching agents. Inference happens only inside the user's own
   agent, under their own login. The "+ New doc…" / "run the skill" flows only ever copy a
   prompt to the clipboard or show guidance — they must not spawn anything.
2. **File-boundary architecture.** The skill (the agent) and the extension communicate
   *only* through validated JSON files on disk. Keep that boundary clean.
3. **Everything is local.** PDFs and summaries never leave the machine. No accounts, no cloud
   sync, no telemetry by default.
4. **License hygiene.** Own code is MIT / Apache-2.0. Allowed deps: `pdfplumber`/`docling`
   (MIT) for extraction, `pdf.js` (Apache), `KaTeX`, `mermaid` (MIT). **PyMuPDF, MinerU, and
   Marker are forbidden** (license). Vendor render-time libs locally; do not pull them from a
   CDN at runtime.
5. **Agents draw nothing raster.** Figures are declared by *bbox* and cropped from the actual
   PDF page by the extension. Diagrams are declared as Mermaid source and rendered to SVG
   locally. The model declares; the extension renders.

## Layout

```
schema/            The contracts: summary.schema.v2.json + document.schema.v1.json (+ golden examples)
skill/             betaxiv-summarizer/  — agent runs this to write summaries
                   betaxiv-documenter/  — agent runs this to write AIDocs
extension/         The VS Code extension (TypeScript, esbuild, PDF.js, Mermaid, KaTeX)
papers/            Drop PDFs here (git-ignored)
.betaxiv/          Agent-written output (git-ignored): summaries/, docs/<id>/, index.json
scripts/           Helpers, e.g. make_sample_pdf.py
```

Extension source ([extension/src/](extension/src/)):
- `extension.ts` — host entry: registers `betaxiv.open` and `betaxiv.installSkill`, owns the
  webview and file-watching.
- `getHtml.ts`, `protocol.ts` — webview HTML scaffold and host↔webview message protocol.
- `validateSummary.ts`, `validateDocument.ts` — Ajv validation against the schemas.
- `contentIndex.ts` / `contentIndexCore.ts` — content-id (PDF SHA-256) ↔ path mapping.
- `webview/` — runs in the webview: `webview.ts` (entry), `cropGeometry.ts` (figure crop math),
  `chart.ts`, `annotations.ts`, `findText.ts`, `textLayerSelection.ts`, `textReflow.ts`.

## Build, run, test

All commands run from `extension/`:

```bash
npm install
npm run build            # esbuild: bundles host + webview, vendors PDF.js into media/vendor/pdfjs/
npm run watch            # rebuild on change
npm run typecheck        # tsc --noEmit

npm run test:unit        # fast, no VS Code: node --test + tsx over src/test/unit/*.test.ts
npm run test:integration # downloads VS Code, launches a real Extension Host (needs a display;
                         #   on headless Linux run under xvfb-run)
npm test                 # both
npm run package          # vsce package
```

Press **F5** from the repo root (or from `extension/`) to launch an Extension Development
Host. The repo ships a smoke-test fixture: `papers/sample.pdf` plus its summary under
`.betaxiv/summaries/`, so **BetaXiv: Open** on it immediately shows PDF + summary.

## Data contracts

The skill↔extension interface is versioned JSON, validated on both sides.

- **Summary** — `schema/summary.schema.v2.json` (`schemaVersion: "2.0"`). One per paper at
  `.betaxiv/summaries/<id>.summary.json`, where `<id>` is the first 16 hex of the PDF's
  SHA-256, so the summary follows the paper through renames/moves. `blocks[]` is ordered prose:
  `paragraph` / `bullets` / `formula` / `figure`. `figure.bbox` is normalized `[x0,y0,x1,y1]`
  (0..1, top-left origin) — the model gives position only; the extension crops the real image.
  **v2.0 is a hard cut with no backward compatibility**; v1 summaries are rejected and must be
  regenerated.
- **AIDoc** — `schema/document.schema.v1.json` (`schemaVersion: "1.0"`). Many per paper at
  `.betaxiv/docs/<id>/<docId>.doc.json`. `blocks[]` is the summary's block set plus `table`
  (matrix data) and `diagram` (Mermaid source). The summary schema is never changed to
  accommodate AIDocs.

`.betaxiv/index.json` maps each PDF path → content id (a rebuildable cache).

When you change a schema, update its golden example in `schema/`, the validators, the unit
tests that guard the contract, and the relevant `skill/*/SKILL.md`.

## Conventions

- TypeScript throughout the extension; keep host vs webview code in their respective
  locations (`webview/` code runs in the sandboxed webview, no Node APIs).
- Match surrounding style; favor small, surgical changes. Run `npm run typecheck` and
  `npm run test:unit` before claiming done.
- The skills are portable: a single `SKILL.md` works across CC / Codex / Gemini CLI. When you
  touch skill behavior, edit `skill/*/SKILL.md` (and `crop_helper.py` where relevant), not a
  per-agent copy.
- Keep prose in code/docs aligned with the constraints above — especially the "pure renderer,
  never calls a model" framing, which is a compliance commitment, not just a description.
