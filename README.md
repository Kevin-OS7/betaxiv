# BetaXiv

Read papers in VS Code with the frontier model you **already pay for** — no second
subscription, no per-token API key. Left pane: the real PDF (PDF.js). Right pane: an
AI-generated structured summary **plus any AIDocs** — extra documents (comparison tables,
method flowcharts, derivations) your agent writes on demand. Both are written by **your own
coding agent** (Claude Code / Codex / Gemini CLI) running a bundled Agent Skill. The
extension itself is a **pure renderer** — it never calls a model, touches OAuth/API keys, or
launches an agent. See [REQUIREMENTS.md](REQUIREMENTS.md) and [AGENTS.md](AGENTS.md).

## Layout

```
schema/            The contracts: summary.schema.v2.json + document.schema.v1.json (+ golden examples)
skill/             betaxiv-summarizer/  — your agent runs this to write summaries
                   betaxiv-documenter/  — your agent runs this to write AIDocs
extension/         The VS Code extension (TypeScript, esbuild, PDF.js, Mermaid)
papers/            Drop your PDFs here (git-ignored)
.betaxiv/          Agent-written output (git-ignored): summaries/, docs/<id>/, index.json
```

## How it works

```
papers/foo.pdf ──► your agent runs the betaxiv-summarizer skill
                          │  (reads the PDF, writes JSON)
                          ▼
   .betaxiv/summaries/<id>.summary.json   ◄── the versioned contract
                          │  <id> = first 16 hex of the PDF's SHA-256, so the
                          │  summary + highlights follow the paper through any
                          │  rename/move (validated by schema/summary.schema.v2.json)
                          ▼
   BetaXiv extension renders: PDF left, summary right (live-reloads on change)
```

`.betaxiv/index.json` maps each PDF's path to its content id (a rebuildable cache, so a person
browsing `.betaxiv/` can tell which `<id>` file is which paper).

### AIDocs — more than a summary

The **summary** is one fixed artifact. **AIDocs** are open-ended documents your agent writes
on request — a results table with extra models it fetched, a method flowchart, a derivation,
a glossary of a subfield. They live next to the summary:

```
papers/foo.pdf ──► "make a comparison table with Llama-3 and GPT-4" ──► your agent runs
                   the betaxiv-documenter skill (reads/fetches, writes JSON)
                          ▼
   .betaxiv/docs/<id>/<docId>.doc.json   ◄── validated by schema/document.schema.v1.json
                          ▼
   BetaXiv renders it in the right pane (live-reloads on change)
```

In the reader, the right pane's **AIDocs** button opens a dropdown: the **Summary** (or a
"not yet summarized" entry) on top, every AIDoc below. Docs are authored declaratively — the
agent writes prose, **tables**, and **Mermaid diagrams** (flowcharts, sequence/state diagrams,
`pie`/`xychart` charts), which the extension renders to SVG locally. As with figures, the
agent never draws raster images: it declares, the extension renders. "**+ New doc…**" in the
dropdown copies a ready-made prompt to your clipboard to paste into your agent — the extension
still never launches anything.

## Build & run the extension

```bash
cd extension
npm install
npm run build        # bundles host + webview, vendors PDF.js into media/vendor/pdfjs/
```

Then press **F5** to launch an Extension Development Host. F5 needs a workspace that has a
launch config:

- **Open this repo's root folder** (recommended): the root `.vscode/launch.json` builds the
  extension and opens the repo as the dev-host workspace, so `papers/sample.pdf` and its
  fixture summary are already there.
- Or **open the `extension/` folder** directly — it has its own `.vscode/launch.json`.

> If F5 does nothing, you've opened a folder with no launch config (e.g. a parent dir).
> Open the repo root or `extension/`.

In the dev host:

1. Open or select a PDF (e.g. `papers/sample.pdf`).
2. Run **BetaXiv: Open** from the Command Palette, or right-click the PDF in the
   Explorer → **BetaXiv: Open**.
3. Left pane renders the PDF; right pane renders the summary if one exists.

## Smoke test (no agent needed)

A ready-made fixture is included: [papers/sample.pdf](papers/sample.pdf) plus its summary
under `.betaxiv/summaries/` (a copy of the golden example, keyed by the PDF's content id).
Open `papers/sample.pdf` with **BetaXiv: Open** and you should immediately see the PDF on
the left and a structured summary on the right. Edit the summary JSON and the right pane
live-updates; delete it and the right pane shows the "run the skill" guidance.

To regenerate the placeholder PDF: `python3 scripts/make_sample_pdf.py papers/sample.pdf`.

## Tests

```bash
cd extension
npm run test:unit          # fast, no VS Code: contract validation (schema × fixtures)
npm run test:integration   # launches a real Extension Host: activation, command, webview tab
npm test                   # both
```

- **Unit** ([src/test/unit/](extension/src/test/unit/)) — runs in plain Node via
  `node --test` + `tsx`. Guards the schema contract: the golden fixture validates, and
  malformed summaries (wrong `schemaVersion`, missing fields, extra keys, bad JSON) are
  rejected.
- **Integration** ([src/test/integration/](extension/src/test/integration/)) — runs in a
  downloaded VS Code via `@vscode/test-cli`. Asserts the extension activates, registers
  **betaxiv.open**, and that opening `papers/sample.pdf` creates a BetaXiv
  webview tab. Needs a display; on headless Linux run under `xvfb-run`.

## Generating summaries & AIDocs

The skills (and the schemas they validate against) ship inside the extension. Install them
into your workspace with the **BetaXiv: Install Skills** command — it copies **both**
`betaxiv-summarizer` and `betaxiv-documenter` into `.agents/skills/`, `.claude/skills/`, and
`.gemini/skills/` (it only writes files; it never launches an agent). From the repo you can
also copy/symlink `skill/betaxiv-summarizer/` and `skill/betaxiv-documenter/` directly.

Then drop a PDF in `papers/` and ask your agent:

- **Summary:** run **betaxiv-summarizer** on it → writes
  `.betaxiv/summaries/<id>.summary.json` (`<id>` = the PDF's content id) and upserts
  `.betaxiv/index.json`. The open BetaXiv pane updates live.
- **An AIDoc:** run **betaxiv-documenter** with what you want (e.g. "a table comparing this to
  Llama-3/GPT-4 by params and FLOPs", "a flowchart of the training pipeline") → writes
  `.betaxiv/docs/<id>/<docId>.doc.json`. It appears in the right pane's **AIDocs** dropdown.

## Privacy & compliance

Everything is local. The extension makes **zero** model/network calls — inference happens
only inside your own agent, under your own login. No telemetry, no accounts, no API keys.
PDFs and summaries never leave your machine.
