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
- **Contract:** the output MUST validate against `schema/summary.schema.v1.json`. Read
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

Fill every field in the schema:

- `schemaVersion`: exactly `"1.0"`.
- `paper`: `sourcePath` (path to the PDF, relative to the workspace root, e.g.
  `papers/attention.pdf`), `title`, `authors[]`, `year` (integer or `null`), `venue`
  (string or `null`).
- `summary`:
  - `tldr` — one tight paragraph: what the paper does and why it matters.
  - `keyContributions[]` — the concrete contributions, one per item.
  - `sections[]` — `{ heading, page, points[] }` for the meaningful sections. `page` is
    the 1-based source page where the section starts; use `null` only if genuinely unknown.
  - `figures[]` — `{ label, caption, page }` for important figures/tables.
  - `glossary[]` — `{ term, definition }` for non-obvious terms a reader would want.
  - `openQuestions[]` — limitations or questions the paper leaves open.
- `generatedBy`: `agent` (your harness, e.g. `"Claude Code"`), `model` (model id or
  `null`), `timestamp` — **must be an ISO 8601 date-time** (e.g. `2026-06-03T12:00:00Z`);
  the extension validates this format and rejects free-form dates.

`page` values are **required keys** even though the value may be `null`. They let the
extension add page jumps later without a schema change — fill them whenever you can.

## Validate before writing

The summary file is a contract; a malformed file shows an error in the extension. Before
writing, **self-check against the schema**: confirm `schemaVersion` is `"1.0"`, every
required key is present at each level, arrays are arrays, `page`/`year` are integers or
`null`, and `generatedBy.timestamp` is a real ISO 8601 date-time.

The full schema is `summary.schema.v1.json`, shipped **in this skill's own directory**
(installed at `<workspace>/.agents/skills/paper-summarizer/`, mirrored under `.claude/` and
`.gemini/`; in the Paper Reader repo it's at `schema/summary.schema.v1.json`). The
extension performs the **authoritative** JSON Schema validation when it loads the file.

For a quick pre-write check you can run this **dependency-free** Node snippet (no `ajv`,
no `npm install` — works from any directory; set `SUMMARY` to the file you wrote):

```bash
SUMMARY=.paper-reader/summaries/<basename>.summary.json node -e '
const fs=require("fs"); const e=[];
let d; try { d=JSON.parse(fs.readFileSync(process.env.SUMMARY,"utf8")); }
catch(x){ console.log("INVALID: not JSON - "+x.message); process.exit(1); }
if(d.schemaVersion!=="1.0") e.push("schemaVersion must be \"1.0\"");
for(const k of ["paper","summary","generatedBy"]) if(!d[k]) e.push("missing "+k);
const s=d.summary||{};
for(const k of ["tldr","keyContributions","sections","figures","glossary","openQuestions"])
  if(!(k in s)) e.push("summary."+k+" missing");
for(const k of ["keyContributions","sections","figures","glossary","openQuestions"])
  if(s[k]&&!Array.isArray(s[k])) e.push("summary."+k+" must be an array");
(s.sections||[]).forEach((x,i)=>{ if(!("page" in x)) e.push("sections["+i+"].page key required");
  if(x.page!==null&&!Number.isInteger(x.page)) e.push("sections["+i+"].page must be int|null"); });
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
