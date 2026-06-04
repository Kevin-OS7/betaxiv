# BetaXiv

Read papers in VS Code with the frontier model you **already pay for** — no second
subscription, no per-token API key. Left pane: the real PDF (PDF.js). Right pane: an
AI-generated structured summary. The summary is written by **your own coding agent**
(Claude Code / Codex / Gemini CLI) running a bundled Agent Skill. The extension itself is
a **pure renderer** — it never calls a model, touches OAuth/API keys, or launches an
agent. See [REQUIREMENTS.md](REQUIREMENTS.md) and [AGENTS.md](AGENTS.md).

## Layout

```
schema/            The contract: summary.schema.v2.json + a golden example
skill/             betaxiv-summarizer/SKILL.md — your agent runs this to write summaries
extension/         The VS Code extension (TypeScript, esbuild, PDF.js)
papers/            Drop your PDFs here (git-ignored)
.betaxiv/     Agent-written summaries land in summaries/ (git-ignored)
```

## How it works

```
papers/foo.pdf ──► your agent runs the betaxiv-summarizer skill
                          │  (reads the PDF, writes JSON)
                          ▼
   .betaxiv/summaries/foo.summary.json   ◄── the versioned contract
                          │  (validated by schema/summary.schema.v2.json)
                          ▼
   BetaXiv extension renders: PDF left, summary right (live-reloads on change)
```

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

A ready-made fixture is included: [papers/sample.pdf](papers/sample.pdf) plus
`.betaxiv/summaries/sample.summary.json` (a copy of the golden example). Open
`papers/sample.pdf` with **BetaXiv: Open** and you should immediately see the PDF on
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

## Generating a real summary

The skill (and the schema it validates against) ship inside the extension. Install it into
your workspace with the **BetaXiv: Install Summarizer Skill** command — it copies
`betaxiv-summarizer` into `.agents/skills/`, `.claude/skills/`, and `.gemini/skills/` (it
only writes files; it never launches an agent). From the repo you can also copy/symlink
`skill/betaxiv-summarizer/` directly.

Then drop a PDF in `papers/` and ask your agent to run **betaxiv-summarizer** on it. It
writes `.betaxiv/summaries/<basename>.summary.json`, and the open BetaXiv pane
updates live.

## Privacy & compliance

Everything is local. The extension makes **zero** model/network calls — inference happens
only inside your own agent, under your own login. No telemetry, no accounts, no API keys.
PDFs and summaries never leave your machine.
