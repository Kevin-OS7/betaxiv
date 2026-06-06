// Pure builder for the Copy^p provenance: a `path=<file>, key=value, …` line wrapped, alongside
// the selection, in matching `===…===` fences. NO DOM — unit-testable like findText.ts /
// cropGeometry.ts. The DOM side (working out the page / figure / heading of a selection) lives in
// webview.ts and feeds the field values in.

/** Quote a value when it contains whitespace, a comma, or a quote; escape embedded quotes. */
export function refValue(v: string): string {
  return /[\s,"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/**
 * Assemble the reference line: `path=<path>, <k>=<v>, …`. `path` is always first. Fields with an
 * undefined or empty value are dropped, so the key set adapts to context (page / fig / sec).
 * Quoting is by type: numbers are bare (`page=4`), free-text string fields are always quoted
 * (`fig="Figure 2"`, `sec="Method"`) so the value boundary is unambiguous, and `path` is bare
 * unless it contains a space/comma. Embedded quotes are escaped. The caller wraps this in
 * `===REFERENCE===` fences via buildCopyPayload, so no `Ref ` prefix is emitted here.
 */
export function buildRefLine(
  path: string,
  fields: Array<[string, string | number | undefined]>,
): string {
  const parts = [`path=${refValue(path)}`];
  for (const [k, v] of fields) {
    if (v === undefined || v === "") continue;
    const val = typeof v === "number" ? String(v) : `"${v.replace(/"/g, '\\"')}"`;
    parts.push(`${k}=${val}`);
  }
  return parts.join(", ");
}

/**
 * The full Copy^p clipboard payload: the (optional) reference wrapped in `===REFERENCE===` /
 * `===/REFERENCE===` fences, then the selection wrapped in `===SELECTED TEXT===` /
 * `===/SELECTED TEXT===` fences — symmetric so both boundaries are unambiguous (each can span
 * multiple lines). The closing fence is followed by a blank line so the payload ends cleanly and
 * separates from anything pasted after it. An empty `ref` yields just the fenced text.
 */
export function buildCopyPayload(ref: string, text: string): string {
  const body = `===SELECTED TEXT===\n${text}\n===/SELECTED TEXT===\n\n`;
  return ref ? `===REFERENCE===\n${ref}\n===/REFERENCE===\n${body}` : body;
}
