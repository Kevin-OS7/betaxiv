---
name: betaxiv-summarizer
description: Read a research PDF and write a structured, schema-validated summary JSON that the BetaXiv VS Code extension renders. Use when the user asks to summarize a paper in papers/, or says "run betaxiv-summarizer", or opens BetaXiv and sees the "no summary yet" guidance.
---

# betaxiv-summarizer

You produce the **structured summary** that BetaXiv shows in its right pane. The
extension is a pure renderer — **you** (the user's own agent) do all the reading and
writing. The contract between you and the extension is a single versioned JSON file.

## Inputs and outputs

- **Input:** a PDF, normally under `papers/` (e.g. `papers/attention.pdf`). If the user
  named a specific file, use that; otherwise summarize each PDF in `papers/` that does
  not yet have an up-to-date summary.
- **Output:** `.betaxiv/summaries/<id>.summary.json`, where `<id>` is the PDF's **content
  id** — the first 16 hex chars of the SHA-256 of its raw bytes. The extension keys data by
  content, not filename, so summaries and highlights follow the paper through any rename or
  move. Compute the id with the bundled helper (it lives next to this `SKILL.md` — see
  "Locating figures" for how to set `HELPER`):
  ```bash
  ID=$(python3 "$HELPER" hash papers/attention.pdf)   # e.g. 9f2c1ab34de7f001
  ```
  then write `.betaxiv/summaries/$ID.summary.json`. Create the directory if missing.
- **Index:** after writing the summary, upsert `.betaxiv/index.json` so a human browsing
  `.betaxiv/` can tell which file is which (the extension also maintains this, but write it
  yourself in case the user never opens the PDF in the extension first). It maps each PDF's
  workspace-relative path to its content id. **Read-modify-write — never overwrite it**, or
  you'll wipe other papers' entries:
  ```bash
  python3 - "$ID" papers/attention.pdf "Attention Is All You Need" <<'PY'
  import json, os, sys
  idx_id, pdf, title = sys.argv[1], sys.argv[2], sys.argv[3]
  path = ".betaxiv/index.json"
  try:
      with open(path) as f: data = json.load(f)
  except Exception:
      data = {}
  data.setdefault("version", 1)
  data["note"] = ("Rebuildable cache: maps each PDF's workspace-relative path to the "
                  "SHA-256 content id BetaXiv keys its summaries/annotations by. "
                  "Deterministic — safe to commit, delete, or regenerate by re-hashing the PDFs.")
  data.setdefault("entries", {})[pdf] = {"hash": idx_id, "size": os.path.getsize(pdf), "title": title}
  os.makedirs(".betaxiv", exist_ok=True)
  with open(path, "w") as f: json.dump(data, f, indent=2); f.write("\n")
  PY
  ```
- **Contract:** the output MUST validate against `schema/summary.schema.v2.json`. Read
  that schema and match it exactly. `schema/example.summary.json` is a filled-in example.
  Keep `paper.sourcePath` set to the PDF's path (e.g. `papers/attention.pdf`) — the content
  id keys the file, but `sourcePath` keeps the human-readable origin inside the summary.

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

The length, structure, and style guidance below is the **default** behavior — produce that
unless the user asks otherwise. If the user requests something different (shorter or longer,
more technical, a specific focus, more bullets, a particular language, etc.), follow their
request. The one thing you must **never** change is the output **format**: the result must
still be the same JSON file that validates against `schema/summary.schema.v2.json` (same
field names, block `type`s, and shape). Honor the user freely *within* that contract; never
break it.

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
    - `{ "type": "paragraph", "text": "…" }` — flowing prose. Inline emphasis: `**bold**`,
      `` `code` ``, and inline math `$…$` (LaTeX, rendered with KaTeX) are supported; nothing
      else (no headings/links/images in text). LaTeX backslashes are doubled in JSON just like
      in a `formula`, e.g. `{ "type": "paragraph", "text": "the loss $\\mathcal{L}$ is …" }`.
    - `{ "type": "bullets", "items": ["…", "…"] }` — a list where it genuinely helps. Set
      `"ordered": true` for a **numbered** list. An item is a string, **or**
      `{ "text": "…", "items": [...], "ordered"?: bool }` to nest a **sub-list** (outline /
      tab-like indentation); sub-lists can be ordered independently.
    - `{ "type": "formula", "text": "y = F(x, \\{W_i\\}) + x" }` — a **display equation in
      LaTeX**, rendered as real typeset math (KaTeX). Write the body only (no `$$`); use
      `\frac`, `^`, `_`, `\sqrt`, `\sum`, `\mathrm`, Greek (`\alpha`), etc. Remember JSON
      needs each LaTeX backslash doubled (`\\frac`, `\\sqrt`).
    - `{ "type": "figure", "label": "Figure 2" }` — places a figure inline **here**; `label`
      must match an entry in `figures[]`. This is how figures appear in the reading flow.
    Write real prose. Prefer paragraphs; reach for bullets only for genuinely enumerable
    points. Drop a `figure` block where the figure is first discussed.
    **Length:** Aim for a summary a reader can finish in about 5 minutes. Each section is
    roughly 2–4 short paragraphs; lead with the key points and favor readability over
    exhaustive coverage. This is a *summary*, not a section-by-section transcription of the
    paper.
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

**Do NOT eyeball coordinates** — estimating pixels from a PDF you "read natively" drifts and
swallows captions, author blocks, and neighboring columns. Use the bundled helper
`crop_helper.py` (needs `pdfplumber` — `pip install pdfplumber` if missing; Pillow ships with
it). It sits **next to this `SKILL.md`**; your cwd is usually the workspace root, so call it by
its full path — set `HELPER` to this skill dir's `crop_helper.py` (the directory this
`SKILL.md` was loaded from, e.g. `.claude/skills/betaxiv-summarizer/crop_helper.py` or
`.agents/skills/betaxiv-summarizer/crop_helper.py`), then use `python3 "$HELPER" …` below.

### Primary: `locate` (caption-anchored, automatic)

For most papers you don't place boxes at all — `locate` finds them. It detects each **caption**
("Figure N" / "Table N") on a page and returns a **tight** box around that figure or table,
excluding the caption, the page title/authors, and adjacent text columns (a port of Allen AI's
pdffigures2 algorithm — pure pdfplumber geometry, no rendering, no ML):

```bash
python3 "$HELPER" locate <pdf> --page N --out /tmp/pN.png --crop-prefix /tmp/figN_
```

It prints one line per detected figure — `<idx>⇥[x0,y0,x1,y1]⇥<caption text>` — draws every box
on `/tmp/pN.png`, and writes each crop to `/tmp/figN_<idx>.png`. Then:

1. **Read `/tmp/pN.png`** (all boxes drawn) to see what was found, plus the per-figure crops to
   confirm each is tight and complete.
2. **Map each box to a figure** by its printed caption text, and store that `[x0,y0,x1,y1]`
   **verbatim** as the figure's `bbox`. (You still author `label`, `caption`, `page` yourself.)

Run `locate` once per page that has figures/tables. It handles vector figures, text-labeled
schematics, and tables. It returns nothing on rotated pages or where no caption is detectable —
use the fallback there.

### Fallback: render + loose box + `tighten`

When `locate` misses a figure (no caption text, a scanned/rotated page, or a box that came out
wrong), place it yourself — you still don't need pixel-perfect edges:

1. **Render** the page in the extension's frame:
   ```bash
   python3 "$HELPER" render <pdf> --page N --out /tmp/pageN.png   # prints "W H" (px)
   ```
2. **Read it** and draw a **generous** pixel box around the right figure (include surrounding
   whitespace and even the caption — `tighten` strips them). Only rule: don't spill into a
   *different* figure or text column.
3. **Tighten + verify:**
   ```bash
   python3 "$HELPER" tighten <pdf> --page N --pixels X0 Y0 X1 Y1 \
       --out /tmp/overlay.png --crop /tmp/crop.png   # prints the [x0,y0,x1,y1] to store
   ```
   Read `/tmp/crop.png`: whole figure, snug, caption excluded. If it clips, widen and rerun;
   after ≤2 tries you can't get it clean, set `bbox` to `null` (extension shows caption + page).

Notes:
- `tighten` accepts `--bbox` (normalized) or `--pixels`, and `--pad P` (default 6px). On rotated
  pages it trims whitespace (pixel-based) but skips caption stripping.
- `candidates <pdf> --page N` prints raw pdfplumber graphic clusters — a low-level seed for
  `tighten`; `locate` supersedes it for normal use. `preview` / `normalize` place or normalize
  a box by hand without auto-trim.
- `page` is the 1-based page the figure appears on. Set `bbox` to `null` if you truly can't
  locate a figure — the extension then shows just the caption and page.

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
(installed at `<workspace>/.agents/skills/betaxiv-summarizer/`, mirrored under `.claude/` and
`.gemini/`; in the BetaXiv repo it's at `schema/summary.schema.v2.json`). The
extension performs the **authoritative** JSON Schema validation when it loads the file.

For a quick pre-write check you can run this **dependency-free** Node snippet (no `ajv`,
no `npm install` — works from any directory; set `SUMMARY` to the file you wrote):

```bash
SUMMARY=.betaxiv/summaries/$ID.summary.json node -e '
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

Then write the JSON to `.betaxiv/summaries/$ID.summary.json` (and upsert `.betaxiv/index.json`
as shown under "Inputs and outputs"). The extension's file watcher live-updates the right pane
the moment you save.

## Boundaries

- Write **only** the summary JSON and `.betaxiv/index.json` (and create their directory).
  Don't modify the PDF, the schema, or the extension.
- Don't call external summary APIs — the inference is you, running under the user's own
  login. That's the whole point of the project (no second subscription, no per-token key).

## Installing this skill across agents

A single `SKILL.md` works across Claude Code / Codex / Gemini CLI via the Agent Skills
standard. Place (or symlink) `skill/betaxiv-summarizer/` under the agent's skills dir:
`.claude/skills/`, `.agents/skills/`, or `.gemini/skills/`.
