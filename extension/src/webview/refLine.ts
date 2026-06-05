// Pure builder for the Copy^p "Ref" provenance line: `Ref path=<file>, key=value, …`. NO DOM —
// unit-testable like findText.ts / cropGeometry.ts. The DOM side (working out the page / figure /
// heading of a selection) lives in webview.ts and feeds the field values in.

/** Quote a value when it contains whitespace, a comma, or a quote; escape embedded quotes. */
export function refValue(v: string): string {
  return /[\s,"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/**
 * Assemble a Ref line: `Ref path=<path>, <k>=<v>, …`. `path` is always first. Fields with an
 * undefined or empty value are dropped, so the key set adapts to context (page / fig / sec).
 * Quoting is by type: numbers are bare (`page=4`), free-text string fields are always quoted
 * (`fig="Figure 2"`, `sec="Method"`) so the value boundary is unambiguous, and `path` is bare
 * unless it contains a space/comma. Embedded quotes are escaped.
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
  return `Ref ${parts.join(", ")}`;
}

/**
 * The full Copy^p clipboard payload: the (optional) Ref line, then the selection wrapped in
 * `===SELECTED TEXT===` / `===/SELECTED TEXT===` fences so the quoted text's boundaries are
 * unambiguous (it can span multiple lines). An empty `ref` yields just the fenced text.
 */
export function buildCopyPayload(ref: string, text: string): string {
  const body = `===SELECTED TEXT===\n${text}\n===/SELECTED TEXT===`;
  return ref ? `${ref}\n${body}` : body;
}
