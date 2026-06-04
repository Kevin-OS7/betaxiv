---
name: paper-summarizer
description: Read a research PDF and write a structured, schema-validated summary JSON that the Paper Reader VS Code extension renders. Use when the user asks to summarize a paper in papers/, or says "run paper-summarizer", or opens Paper Reader and sees the "no summary yet" guidance.
---

# paper-summarizer

You produce the **structured summary** that Paper Reader shows in its right pane. The
extension is a pure renderer — **you** (the user's own agent) do all the reading and
writing. The contract between you and the extension is a single versioned JSON file.

## Inputs and outputs

- **Input:** a PDF, normally under `papers/` (e.g. `papers/attention.pdf`). If the user
  named a specific file, use that; otherwise summarize each PDF in `papers/` that does
  not yet have an up-to-date summary.
- **Output:** `.paper-reader/summaries/<basename>.summary.json`, where `<basename>` is the
  PDF filename without its `.pdf` extension (e.g. `papers/attention.pdf` →
  `.paper-reader/summaries/attention.summary.json`). Create the directory if missing.
- **Contract:** the output MUST validate against `schema/summary.schema.v2.json`. Read
  that schema and match it exactly. `schema/example.summary.json` is a filled-in example.

## How to read the PDF

1. **Prefer native PDF reading.** If your harness can read PDFs directly (Claude Code can
   pass a PDF to the model), read it natively — it preserves figures and layout context.
2. **Fallback: `pdfplumber` (MIT).** If native reading is unavailable or fails, extract
   text with pdfplumber:
   ```bash
   python3 -c "import pdfplumber" 2>/dev/null || pip install pdfplumber
   ```
   then iterate pages with `pdfplumber.open(path)` and read `page.extract_text()`.
   `docling` (MIT) is an acceptable alternative for richer structure.
3. **License rule — never use `PyMuPDF` / `PyMuPDF4LLM` (AGPL), `MinerU` (AGPL deps), or
   `Marker` (commercial restriction).** This project must stay redistributable as OSS.
4. **Large PDFs:** read in page ranges rather than loading everything at once, to keep
   token/context usage down. Note the source page number as you go — you'll need it for
   the `page` anchors.

## Building the summary

The goal is an **alphaXiv-style blog**: a Summary box, flowing prose sections (not bare
bullet points), figures shown inline, and annotated citations. Fill every field:

- `schemaVersion`: exactly `"2.0"`.
- `paper`: `sourcePath` (path to the PDF, relative to the workspace root, e.g.
  `papers/attention.pdf`), `title`, `authors[]`, `year` (integer or `null`), `venue`
  (string or `null`), `date` (the human-readable date line under the title, e.g.
  `"December 11, 2015"`, or `null`).
- `summary`:
  - `tldr` — one tight paragraph: what the paper does and why it matters (the Summary box).
  - `keyContributions[]` — the concrete contributions, one per item.
  - `sections[]` — `{ heading, page, blocks[] }` for the meaningful sections. `page` is the
    1-based source page where the section starts; use `null` only if genuinely unknown.
    `blocks[]` is **ordered prose**, each block one of:
    - `{ "type": "paragraph", "text": "…" }` — flowing prose. Inline emphasis: `**bold**`
      and `` `code` `` are supported; nothing else (no headings/links/images in text).
    - `{ "type": "bullets", "items": ["…", "…"] }` — a list where it genuinely helps. Set
      `"ordered": true` for a **numbered** list. An item is a string, **or**
      `{ "text": "…", "items": [...], "ordered"?: bool }` to nest a **sub-list** (outline /
      tab-like indentation); sub-lists can be ordered independently.
    - `{ "type": "formula", "text": "y = F(x, {W_i}) + x" }` — shown verbatim in a mono box.
    - `{ "type": "figure", "label": "Figure 2" }` — places a figure inline **here**; `label`
      must match an entry in `figures[]`. This is how figures appear in the reading flow.
    Write real prose. Prefer paragraphs; reach for bullets only for genuinely enumerable
    points. Drop a `figure` block where the figure is first discussed.
  - `figures[]` — `{ label, caption, page, bbox }` for important figures/tables. **You do
    not draw figures.** You only LOCATE each one; the extension crops the real image out of
    the rendered PDF page. See "Locating figures" below for `bbox`.
  - `glossary[]` — `{ term, definition }` for non-obvious terms a reader would want.
  - `openQuestions[]` — limitations or questions the paper leaves open.
  - `relevantCitations[]` — `{ title, authors?, venue?, note }` for key references the paper
    builds on (like alphaXiv's "Relevant Citations"). `note` says why it matters. May be `[]`.
- `generatedBy`: `agent` (your harness, e.g. `"Claude Code"`), `model` (model id or
  `null`), `timestamp` — **must be an ISO 8601 date-time** (e.g. `2026-06-03T12:00:00Z`);
  the extension validates this format and rejects free-form dates.

`page` (and `paper.date`/`year`/`venue`) values are **required keys** even though the value
may be `null`. Fill them whenever you can.

## Locating figures (bbox)

You never render figures — you tell the extension **where** each figure sits and it crops
the real pixels from the PDF page. The extension renders the page's **upright cropBox** (via
PDF.js, with `/Rotate` applied) and slices the `bbox` rectangle out of it. So `bbox` is
`[x0, y0, x1, y1]`, **normalized 0..1**, origin **top-left**, measured **against that same
upright cropBox page**.

**Do NOT eyeball coordinates.** Estimating pixel coordinates from a PDF you "read natively"
is unreliable — you reconstruct the layout instead of grounding on the actual image, so boxes
drift and swallow author blocks / captions / neighboring text. Instead, **ground each box on
the exact page image the extension crops**, using the bundled helper `crop_helper.py`
(needs `pdfplumber` — `pip install pdfplumber` if missing; Pillow ships with it).

`crop_helper.py` sits **next to this `SKILL.md`**. Your cwd is usually the workspace root, not
the skill dir, so **call it by its full path** — set `HELPER` to the `crop_helper.py` in this
skill's own directory (the directory this `SKILL.md` was loaded from, e.g.
`.claude/skills/paper-summarizer/crop_helper.py` or `.agents/skills/paper-summarizer/crop_helper.py`),
then use `python3 "$HELPER" …` in every call below. For each figure:

**You do not need pixel-perfect edges — give a loose box, let `tighten` snap it.** Don't fuss
over exact margins or where the caption ends. Draw a **generous** box that fully contains the
figure, then run `tighten`: it auto-removes the caption line and trims the whitespace down to
the real ink, so your box just has to surround the **right figure** without bleeding into a
neighboring figure/column. For each figure:

1. **Render the page** in the extension's frame:
   ```bash
   python3 "$HELPER" render <pdf> --page N --out /tmp/pageN.png   # prints "W H" (px)
   ```
2. **Read `/tmp/pageN.png`** and find the figure on *that* image — match it to its caption
   number so you box the **right one** (don't grab the title, an author block, or the wrong
   figure). Return a **generous** box around it in **pixel coordinates on the PNG**, origin
   top-left. Err big: include surrounding whitespace and even the caption — `tighten` strips
   those. Only hard rule: don't let the box spill into a *different* figure, table, or text
   column.
3. **Tighten + self-verify** — auto-strip the caption, trim margins, and emit the final bbox:
   ```bash
   python3 "$HELPER" tighten <pdf> --page N --pixels X0 Y0 X1 Y1 \
       --out /tmp/overlay.png --crop /tmp/crop.png   # prints the [x0,y0,x1,y1] to store
   ```
   `tighten` prints the normalized `bbox` (use it verbatim) and writes `/tmp/crop.png`.
   **Read `/tmp/crop.png`:** it must be the whole figure, centred, snug, **caption excluded**
   (you already restate the caption as text, so it must not appear in the image). If it clips
   the figure, widen the input box and rerun; if it still grabbed the wrong region, re-find it
   on the page (step 2). After ≤2 tries you can't get a clean crop, set `bbox` to `null` — the
   extension then shows just the caption and page.

Notes:
- `tighten` also accepts `--bbox X0 Y0 X1 Y1` (normalized) instead of `--pixels`, and `--pad P`
  to change the breathing room (default 6px). On rotated pages it still trims whitespace
  (pixel-based); caption stripping is skipped there but the caption is usually outside a tight
  ink box anyway.
- `page` is the 1-based page the figure appears on.
- Optional seed: `python3 "$HELPER" candidates <pdf> --page N` prints pdfplumber-derived boxes
  (exact for embedded images; clustered for vector figures/tables). Feed one straight into
  `tighten` as the loose box. (Prints nothing on rotated pages — just ground via `render`.)
- `preview` / `normalize` remain available if you want to place a box by hand without the
  auto-trim, but `tighten` is the default and handles the margin/centre/caption issues for you.

Reference each figure once from a section via a `{ "type": "figure", "label": … }` block so
it renders in context. (Any figure you list but never reference still appears in a trailing
"Figures & Tables" list, so nothing is lost.)

## Validate before writing

The summary file is a contract; a malformed file shows an error in the extension. Before
writing, **self-check against the schema**: confirm `schemaVersion` is `"2.0"`, every
required key is present at each level, arrays are arrays, `page`/`year` are integers or
`null`, each section has `blocks[]` whose items have a valid `type`, each figure has a
`bbox` (4 numbers in 0..1, or `null`), and `generatedBy.timestamp` is a real ISO 8601
date-time.

The full schema is `summary.schema.v2.json`, shipped **in this skill's own directory**
(installed at `<workspace>/.agents/skills/paper-summarizer/`, mirrored under `.claude/` and
`.gemini/`; in the Paper Reader repo it's at `schema/summary.schema.v2.json`). The
extension performs the **authoritative** JSON Schema validation when it loads the file.

For a quick pre-write check you can run this **dependency-free** Node snippet (no `ajv`,
no `npm install` — works from any directory; set `SUMMARY` to the file you wrote):

```bash
SUMMARY=.paper-reader/summaries/<basename>.summary.json node -e '
const fs=require("fs"); const e=[];
let d; try { d=JSON.parse(fs.readFileSync(process.env.SUMMARY,"utf8")); }
catch(x){ console.log("INVALID: not JSON - "+x.message); process.exit(1); }
if(d.schemaVersion!=="2.0") e.push("schemaVersion must be \"2.0\"");
for(const k of ["paper","summary","generatedBy"]) if(!d[k]) e.push("missing "+k);
const s=d.summary||{};
for(const k of ["tldr","keyContributions","sections","figures","glossary","openQuestions","relevantCitations"])
  if(!(k in s)) e.push("summary."+k+" missing");
for(const k of ["keyContributions","sections","figures","glossary","openQuestions","relevantCitations"])
  if(s[k]&&!Array.isArray(s[k])) e.push("summary."+k+" must be an array");
const BT=new Set(["paragraph","bullets","formula","figure"]);
const labels=new Set((s.figures||[]).map(f=>f&&f.label));
(s.sections||[]).forEach((x,i)=>{ if(!("page" in x)) e.push("sections["+i+"].page key required");
  if(x.page!==null&&!Number.isInteger(x.page)) e.push("sections["+i+"].page must be int|null");
  if(!Array.isArray(x.blocks)) e.push("sections["+i+"].blocks must be an array");
  (x.blocks||[]).forEach((b,j)=>{ if(!b||!BT.has(b.type)) e.push("sections["+i+"].blocks["+j+"].type invalid");
    if(b&&b.type==="figure"&&!labels.has(b.label)) e.push("sections["+i+"].blocks["+j+"] figure label not in figures[]"); }); });
(s.figures||[]).forEach((f,i)=>{ if(!("bbox" in f)) e.push("figures["+i+"].bbox key required");
  if(f.bbox!==null&&!(Array.isArray(f.bbox)&&f.bbox.length===4&&f.bbox.every(n=>typeof n==="number"&&n>=0&&n<=1)))
    e.push("figures["+i+"].bbox must be 4 numbers in 0..1, or null"); });
const ts=(d.generatedBy||{}).timestamp||"";
const m=/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(ts);
const cal=m&&new Date(Date.UTC(+m[1],+m[2]-1,+m[3])); // verify the calendar date is real (no 02-31 rollover)
if(!m||Number.isNaN(Date.parse(ts))||cal.getUTCFullYear()!=+m[1]||cal.getUTCMonth()+1!=+m[2]||cal.getUTCDate()!=+m[3])
  e.push("generatedBy.timestamp must be a real ISO 8601 date-time");
console.log(e.length?("INVALID:\n- "+e.join("\n- ")):"OK");'
```

Then write the JSON to `.paper-reader/summaries/<basename>.summary.json`. The extension's
file watcher live-updates the right pane the moment you save.

## Boundaries

- Write **only** the summary JSON (and create its directory). Don't modify the PDF, the
  schema, or the extension.
- Don't call external summary APIs — the inference is you, running under the user's own
  login. That's the whole point of the project (no second subscription, no per-token key).

## Installing this skill across agents

A single `SKILL.md` works across Claude Code / Codex / Gemini CLI via the Agent Skills
standard. Place (or symlink) `skill/paper-summarizer/` under the agent's skills dir:
`.claude/skills/`, `.agents/skills/`, or `.gemini/skills/`.
