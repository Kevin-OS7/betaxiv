---
name: betaxiv-documenter
description: Write a structured, schema-validated AIDoc JSON (tables, Mermaid diagrams/flowcharts, prose, figures) that the BetaXiv VS Code extension renders alongside a paper's summary. Use when the user asks to document something about a paper — "make a comparison table", "draw a method flowchart", "add a derivation doc" — or says "run betaxiv-documenter".
---

# betaxiv-documenter

You produce **AIDocs**: lightweight, agent-authored documents shown alongside a paper's
summary in BetaXiv's right pane (in the **AIDocs** dropdown). Where the summary is one fixed
artifact, AIDocs are open-ended — a comparison table with extra models, a method flowchart, a
derivation, a glossary of a subfield, anything the user asks for. The extension is a pure
renderer: **you** (the user's own agent) do all the reading, fetching, and writing. The
contract between you and the extension is a single versioned JSON file per doc.

This skill is the sibling of `betaxiv-summarizer` and shares its discipline (content-id keys,
`.betaxiv/index.json` upsert, schema self-check). The differences: a **different schema**
(`document.schema.v1.json`), a **different output path**, and **two extra block types**
(`table`, `diagram`).

## Inputs and outputs

- **Input:** a paper (normally a PDF under `papers/`) plus the user's instruction for what to
  document. The user may also ask you to **fetch** information that isn't in the paper (e.g.
  "add Llama-3 and GPT-4 to the results table") — go get it (web, other files, the repo) and
  structure it into the doc. That open-endedness is the point.
  - **When the target is unclear, ask — don't guess.** A doc is keyed to one PDF's content
    id, so resolve **which paper** before computing `$ID` or writing anything. If the
    reference is ambiguous (a partial/fuzzy name matching **several** PDFs), the named file
    **doesn't exist** (typo, wrong folder, or outside `papers/`), or no file is named and
    `papers/` holds many candidates with no obvious one — stop and throw the question back:
    list the candidate paths (or note none were found) and ask which paper they mean. Don't
    document the wrong PDF. Likewise, if **what to document** is too vague to act on (e.g.
    just "make a doc" with no kind/scope), ask a quick clarifying question — what to compare,
    which sections, what to fetch — rather than inventing a doc they didn't want. Proceed
    only once both the paper and the ask are unambiguous.
- **Output:** `.betaxiv/docs/<id>/<docId>.doc.json`, where:
  - `<id>` is the PDF's **content id** — the first 16 hex chars of the SHA-256 of its raw
    bytes (the SAME key the summarizer uses, so docs follow the paper through any rename/move).
    Compute it with the bundled helper (it lives next to this `SKILL.md` — see "Locating
    figures" for how to set `HELPER`):
    ```bash
    ID=$(python3 "$HELPER" hash papers/attention.pdf)   # e.g. 9f2c1ab34de7f001
    ```
  - `<docId>` is the doc's own slug (kebab-case, matching `doc.id`), e.g. `model-comparison`.
  - So a doc lands at `.betaxiv/docs/$ID/model-comparison.doc.json`. Create the directory if
    missing. One file per doc; a paper can have many.
- **Index:** after writing, upsert `.betaxiv/index.json` exactly as the summarizer does so a
  human browsing `.betaxiv/` can map paths to content ids. **Read-modify-write — never
  overwrite it**:
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
                  "SHA-256 content id BetaXiv keys its summaries/annotations/docs by. "
                  "Deterministic — safe to commit, delete, or regenerate by re-hashing the PDFs.")
  data.setdefault("entries", {})[pdf] = {"hash": idx_id, "size": os.path.getsize(pdf), "title": title}
  os.makedirs(".betaxiv", exist_ok=True)
  with open(path, "w") as f: json.dump(data, f, indent=2); f.write("\n")
  PY
  ```
- **Contract:** the output MUST validate against `schema/document.schema.v1.json` (shipped in
  this skill's own directory). Read it and match it exactly. `schema/example.document.json` is
  a filled-in example.

## Reading & gathering

- **Read the PDF** the same way the summarizer does: prefer native PDF reading; fall back to
  `pdfplumber` (MIT). **Never** use `PyMuPDF`/`MinerU`/`Marker` (license rule — this project
  stays redistributable OSS).
- **Fetch external data** when the user asks for it (other models' numbers, related work,
  benchmark results). Put fetched data into `table`/`diagram`/`paragraph` blocks. You may
  only crop **figures from the source PDF itself** (see below) — never from elsewhere.
- Don't call external summary/doc APIs. The inference is **you**, running under the user's own
  login — that's the whole point of the project (no second subscription, no per-token key).

## Building the doc

A doc is `{ schemaVersion, doc, blocks, figures?, generatedBy }`. Honor the user's request
freely **within** this contract; never break the format.

- `schemaVersion`: exactly `"1.0"`.
- `doc`:
  - `id` — kebab-case slug, unique within this paper's docs dir. Becomes the filename
    (`<id>.doc.json`). Reuse the same `id` to **update** a doc; pick a new one to add another.
  - `title` — shown in the AIDocs dropdown and as the document heading.
  - `kind` — free-form category hint (`note` | `report` | `comparison` | `derivation` | …).
  - `sourcePath` — the PDF this doc is about, relative to the workspace root.
  - `description` — one-line summary shown under the title in the dropdown, or `null`.
- `blocks[]` — ordered content rendered top-to-bottom. Each block is one of:
  - `{ "type": "heading", "text": "…", "level"?: 2|3 }` — a **section title** (level 2, the
    default) or subsection (level 3). The document title comes from `doc.title` (level 1), so
    headings start at 2. **Use this for every section heading — do NOT fake a heading with a
    bold paragraph** (`{ "type":"paragraph", "text":"**Section**" }`); that renders as small
    inline bold text, not a real heading.
  - `{ "type": "paragraph", "text": "…" }` — flowing prose. Inline emphasis: `**bold**`,
    `` `code` ``, and inline math `$…$` (KaTeX). JSON doubles LaTeX backslashes (`$\\alpha$`).
  - `{ "type": "bullets", "items": [...], "ordered"?: bool }` — a list; items are strings or
    `{ "text": "…", "items": [...], "ordered"?: bool }` for nested sub-lists.
  - `{ "type": "formula", "text": "y = F(x) + x" }` — a display equation in LaTeX (KaTeX),
    body only (no `$$`). Double each backslash in JSON (`\\frac`, `\\sqrt`).
  - `{ "type": "figure", "label": "Figure 1" }` — places a figure from `figures[]` inline.
  - **`{ "type": "table", "header": [...], "rows": [[...], ...], "caption"?: "…" }`** — a data
    table. `header` is an array of column titles; `rows` is row-major arrays of string cells.
    Cells support the same inline emphasis as `paragraph` (`**bold**`, `` `code` ``, `$math$`).
    This is the natural home for fetched comparison data.
  - **`{ "type": "diagram", "mermaid": "…", "caption"?: "…" }`** — a diagram drawn from
    **Mermaid** source (rendered to SVG client-side). See the Mermaid rules below.
  - **`{ "type": "chart", "kind": "scatter"|"line", "xAxis": {...}, "yAxis": {...}, "series": [...] }`**
    — a **scientific plot** the extension draws as a crisp vector SVG. See "Charts" below. Use
    this for **scatter plots**, numeric-x line plots, **log axes**, and **error bars** — things
    Mermaid can't do. (For categorical **bar** charts, use a `diagram` with `xychart-beta`.)
- `figures[]` — optional catalog of figures/tables cropped from the **source PDF** (same
  `{ label, caption, page, bbox }` shape and bbox workflow as the summarizer). Omit or `[]` if
  the doc has no PDF figures. You never draw figures — you only locate them; the extension
  crops the real pixels (see "Locating figures").
- `generatedBy`: `agent` (your harness), `model` (id or `null`), `timestamp` — an ISO 8601
  date-time (e.g. `2026-06-05T12:00:00Z`); the extension validates the format.

### Mermaid diagrams (flowcharts, simple charts)

The `diagram` block is how you draw **flowcharts**, pipelines, sequence/state diagrams, and
**simple charts**. Write Mermaid source in the `mermaid` field. Newlines are real `\n` inside
the JSON string.

**Use ONLY these built-in diagram types** (so nothing is lazily fetched — the renderer stays
offline and CSP-safe):
- `flowchart` / `graph` — boxes-and-arrows flowcharts and pipelines.
- `sequenceDiagram`, `classDiagram`, `stateDiagram`, `erDiagram` — structural diagrams.
- `pie`, `xychart-beta` — simple pie and bar/line charts when a `table` isn't visual enough.

Do **not** use third-party/experimental diagrams (mindmap-with-icons, architecture-beta,
external integrations) — they require lazy chunk loading that the offline renderer blocks.

**No HTML tags in labels.** The renderer uses `htmlLabels:false` + `securityLevel:strict`, so
tags like `<b>`, `<br>`, `<i>` are **not** formatted — they leak through as literal `<b>…</b>`
text in the diagram. Keep node labels plain text; if a label is too long, shorten it or split
it across nodes rather than reaching for `<br>`. (This is deliberate hardening, not a bug — do
not try to bold or line-break labels with HTML.)

Examples (note the doubled-up `\n` inside JSON):
```json
{ "type": "diagram",
  "mermaid": "flowchart LR\n  I[Input tokens] --> E[Encoder x6] --> A[Cross-attn] --> D[Decoder x6] --> O[Output]",
  "caption": "Transformer data flow." }
```
```json
{ "type": "diagram",
  "mermaid": "xychart-beta\n  title \"BLEU by model\"\n  x-axis [GNMT, ConvS2S, T-base, T-big]\n  y-axis \"BLEU\" 22 --> 29\n  bar [24.6, 25.16, 27.3, 28.4]" }
```
Keep diagrams legible: a handful of nodes/series, short labels. If a diagram fails to render,
the extension shows the source verbatim — but aim to get it right.

### Charts (scatter / line — scientific plots)

The `chart` block is for **data plots** the extension renders as a crisp vector SVG from your
declarative numbers — the scientific niche Mermaid can't cover: **scatter plots**, numeric-x
**line** plots, **log axes**, **error bars**, multiple series, and a legend.

Shape:
```jsonc
{
  "type": "chart",
  "kind": "scatter",                 // "scatter" (markers) or "line" (markers joined, sorted by x)
  "title": "Accuracy vs. parameters",
  "caption": "…",                    // optional, shown under the chart
  "alt": "…",                        // optional plain-language description (accessibility)
  "legend": true,                     // optional; defaults true when >1 series
  "xAxis": { "label": "Parameters", "scale": "log",    "domain": "auto" },
  "yAxis": { "label": "Top-1 (%)",  "scale": "linear", "domain": [60, 90] },
  "series": [
    { "name": "Baseline", "marker": "circle", "points": [
        { "x": 1e7, "y": 68.2, "yError": 0.4 },
        { "x": 1e8, "y": 74.8, "yError": { "low": 74.1, "high": 75.3 } }
    ]},
    { "name": "Proposed", "marker": "diamond", "points": [
        { "x": 1e7, "y": 71.5 }, { "x": 1e8, "y": 79.2 }
    ]}
  ]
}
```
Rules & tips:
- **Axes**: `scale` is `"linear"` or `"log"` (log needs strictly-positive values on that axis).
  `domain` is `"auto"` (derive from the data, incl. error bars) or an explicit `[min, max]`.
  Optional `tickCount` (2–10) hints the linear tick density.
- **Points**: each `{ x, y }` (finite numbers), optional `label`, and optional `xError`/`yError`.
  An error bar is either a **symmetric** number (±value) or an **interval** `{ "low", "high" }`
  in data units — prefer the interval form on log axes so it never crosses zero.
- **Series**: up to 12; `marker` is `circle|square|triangle|diamond|cross` (auto-assigned per
  series if omitted, so shape — not just color — distinguishes them). `color` is optional — a
  **hex** code (`#rgb` or `#rrggbb`) to match a paper's figure; omit it to use the auto palette.
  (Only hex is accepted; other formats fall back to the palette.)
- **Don't** put categorical bar charts here — use a `diagram` (`xychart-beta`) for those.
- Points that are non-finite, or ≤ 0 on a log axis, are dropped with a small "N off-scale"
  note; if a chart is too dense (cap 1000 pts/series), aggregate rather than dumping raw data.

## Locating figures (bbox)

Only if your doc references a figure/table **from the source PDF**. The workflow is identical
to the summarizer: you specify the **position**, the extension crops the real image.

> **You never render or embed images.** You only supply a figure's `page` + `bbox`; the BetaXiv
> extension crops the real pixels from the PDF with PDF.js. So:
> - **Do NOT reach for `pdf2image` / `pdftoppm` / poppler, or PyMuPDF.** They are not needed and
>   not part of this skill. Use the bundled `crop_helper.py` (pdfplumber + the already-installed
>   `pypdfium2`); **poppler is NOT required** to show figures.
> - A missing local renderer does **not** mean figures are unavailable. `locate`'s box
>   *coordinates* come from pure pdfplumber geometry (no rendering at all); rendering is only for
>   your own visual verification.
> - If you truly cannot verify a box visually, still emit the figure with `page` + a best-effort
>   `bbox` (from `locate`'s printed coordinates or native PDF reading), or `bbox: null` (the
>   extension then shows caption + page). **Never silently drop figures** or downgrade to a
>   hand-drawn "concept" diagram because a tool didn't run — try the bundled helper first.

`bbox` is `[x0, y0, x1, y1]`, **normalized 0..1**, origin **top-left**, measured against the
page's **upright cropBox** (PDF.js `view`, rotation applied). **Do NOT eyeball coordinates** —
use the bundled helper `crop_helper.py` (needs `pdfplumber`; Pillow ships with it). It sits
**next to this `SKILL.md`**; set `HELPER` to its full path (the dir this `SKILL.md` loaded
from, e.g. `.claude/skills/betaxiv-documenter/crop_helper.py` or
`.agents/skills/betaxiv-documenter/crop_helper.py`), then:

```bash
# Caption-anchored auto-detection (handles most figures/tables):
python3 "$HELPER" locate <pdf> --page N --out /tmp/pN.png --crop-prefix /tmp/figN_
# Or place a loose pixel box and tighten it:
python3 "$HELPER" render  <pdf> --page N --out /tmp/pageN.png
python3 "$HELPER" tighten <pdf> --page N --pixels X0 Y0 X1 Y1 --out /tmp/overlay.png --crop /tmp/crop.png
```
Read the overlay/crop PNGs to confirm each box is tight and complete, then store the printed
`[x0,y0,x1,y1]` verbatim as the figure's `bbox`. Set `bbox` to `null` if you truly can't
locate it (the extension then shows caption + page only). (Full helper docs mirror the
summarizer skill's "Locating figures" section.)

## Validate before writing

The doc file is a contract; a malformed file shows an error in the AIDocs list. Self-check
against the schema before writing: `schemaVersion` is `"1.0"`; `doc` has `id`/`title`/`kind`/
`sourcePath`/`description`; every block has a valid `type` and its required fields (`table` →
`header`+`rows`, `diagram` → `mermaid`); each `figures[]` entry has a `bbox` of 4 numbers in
0..1 or `null`; `generatedBy.timestamp` is a real ISO 8601 date-time.

Quick dependency-free Node check (no `ajv`, no install; set `DOC` to the file you wrote):
```bash
DOC=.betaxiv/docs/$ID/model-comparison.doc.json node -e '
const fs=require("fs"); const e=[];
let d; try { d=JSON.parse(fs.readFileSync(process.env.DOC,"utf8")); }
catch(x){ console.log("INVALID: not JSON - "+x.message); process.exit(1); }
if(d.schemaVersion!=="1.0") e.push("schemaVersion must be \"1.0\"");
for(const k of ["doc","blocks","generatedBy"]) if(!d[k]) e.push("missing "+k);
const doc=d.doc||{};
for(const k of ["id","title","kind","sourcePath","description"]) if(!(k in doc)) e.push("doc."+k+" missing");
if(doc.id!==undefined && !/^[a-z0-9][a-z0-9-]*$/.test(doc.id)) e.push("doc.id must be a kebab-case slug");
if(!Array.isArray(d.blocks)) e.push("blocks must be an array");
const BT=new Set(["heading","paragraph","bullets","formula","figure","table","diagram","chart"]);
const labels=new Set((d.figures||[]).map(f=>f&&f.label));
(d.blocks||[]).forEach((b,i)=>{ if(!b||!BT.has(b.type)){e.push("blocks["+i+"].type invalid");return;}
  if(b.type==="figure"&&!labels.has(b.label)) e.push("blocks["+i+"] figure label not in figures[]");
  if(b.type==="table"&&(!Array.isArray(b.header)||!Array.isArray(b.rows))) e.push("blocks["+i+"] table needs header[] and rows[][]");
  if(b.type==="diagram"&&typeof b.mermaid!=="string") e.push("blocks["+i+"] diagram needs a mermaid string");
  if(b.type==="chart"){ if(!["scatter","line"].includes(b.kind)) e.push("blocks["+i+"] chart.kind must be scatter|line");
    if(!b.xAxis||!b.yAxis) e.push("blocks["+i+"] chart needs xAxis and yAxis");
    if(!Array.isArray(b.series)||!b.series.length) e.push("blocks["+i+"] chart needs series[]"); } });
(d.figures||[]).forEach((f,i)=>{ if(!("bbox" in f)) e.push("figures["+i+"].bbox key required");
  if(f.bbox!==null&&!(Array.isArray(f.bbox)&&f.bbox.length===4&&f.bbox.every(n=>typeof n==="number"&&n>=0&&n<=1)))
    e.push("figures["+i+"].bbox must be 4 numbers in 0..1, or null"); });
const ts=(d.generatedBy||{}).timestamp||"";
const m=/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(ts);
const cal=m&&new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
if(!m||Number.isNaN(Date.parse(ts))||cal.getUTCFullYear()!=+m[1]||cal.getUTCMonth()+1!=+m[2]||cal.getUTCDate()!=+m[3])
  e.push("generatedBy.timestamp must be a real ISO 8601 date-time");
console.log(e.length?("INVALID:\n- "+e.join("\n- ")):"OK");'
```
Then write the JSON to `.betaxiv/docs/$ID/<docId>.doc.json` and upsert `.betaxiv/index.json`.
The extension's file watcher live-updates the AIDocs list the moment you save.

## Boundaries

- Write **only** doc JSON under `.betaxiv/docs/<id>/` and the `.betaxiv/index.json` entry
  (create their directories). Don't modify the PDF, the schema, the summary, or the extension.
- Don't call external summary/doc APIs — the inference is you, under the user's own login.

## Installing this skill across agents

A single `SKILL.md` works across Claude Code / Codex / Gemini CLI via the Agent Skills
standard. Place (or symlink) `skill/betaxiv-documenter/` under the agent's skills dir:
`.claude/skills/`, `.agents/skills/`, or `.gemini/skills/`. BetaXiv's "Install Skill" command
installs this alongside `betaxiv-summarizer`.
