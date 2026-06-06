// Pure helpers for the "copy papers (with their summary / AIDocs / notes) into another workspace"
// command. NO `vscode` import — unit-testable in plain Node like contentIndexCore.ts. The host
// (extension.ts) does the actual filesystem copy; this only computes the paths and names.

/**
 * The `.betaxiv` artifacts a paper's data lives under, as workspace-relative POSIX paths keyed by
 * the PDF's content id. Mirrors the layout openReader() reads from, so a copy of these alongside
 * the PDF re-links automatically in the destination workspace (the id is recomputed from bytes).
 */
export function betaxivDataPaths(id: string): {
  summary: string;
  docsDir: string;
  annotations: string;
} {
  return {
    summary: `.betaxiv/summaries/${id}.summary.json`,
    docsDir: `.betaxiv/docs/${id}`,
    annotations: `.betaxiv/annotations/${id}.json`,
  };
}

/**
 * The pre-content-id (filename-keyed) layout a paper's summary/annotations may still live under if
 * it hasn't been opened since the content-id migration ran. Only summary + annotations existed back
 * then — AIDocs are always content-id keyed — so there's no legacy docs dir. Used as a non-mutating
 * copy fallback so "Copy with Data" still carries un-migrated notes/summary across (openReader's
 * migrateLegacy() upgrades the source lazily on open, but this command may run before that).
 */
export function legacyDataPaths(basename: string): {
  summary: string;
  annotations: string;
} {
  return {
    summary: `.betaxiv/summaries/${basename}.summary.json`,
    annotations: `.betaxiv/annotations/${basename}.json`,
  };
}

/**
 * A filename that doesn't collide with `existing`: returns `base+ext` when free, otherwise
 * `base (2)+ext`, `base (3)+ext`, … so copying into a folder never clobbers an unrelated file of
 * the same name. `base` is the name without extension; `ext` includes the leading dot (e.g. ".pdf").
 */
export function uniqueFileName(existing: Set<string>, base: string, ext: string): string {
  let name = `${base}${ext}`;
  for (let n = 2; existing.has(name); n++) {
    name = `${base} (${n})${ext}`;
  }
  return name;
}
