// Reflow PDF text-layer lines into readable text for copy. A raw text-layer selection copies
// one line per PDF line, which reads badly. Here we join wrapped lines within a paragraph
// (de-hyphenating words split across the break) and start a new line where a paragraph ends.
// Paragraph ends are detected geometrically: a line that stops well short of the column's
// right margin is treated as the last line of its paragraph. Pure (no DOM) → unit-testable.

export interface ReflowLine {
  text: string;
  left: number;
  right: number;
}

export function reflowLines(lines: ReflowLine[]): string {
  const cleaned = lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }))
    .filter((l) => l.text.length > 0);
  if (cleaned.length === 0) return "";

  const maxRight = Math.max(...cleaned.map((l) => l.right));
  const minLeft = Math.min(...cleaned.map((l) => l.left));
  const colWidth = Math.max(1, maxRight - minLeft);
  // A line ending more than ~5% of the column short of the right margin is a paragraph end.
  const margin = colWidth * 0.05;

  let out = cleaned[0].text;
  for (let i = 1; i < cleaned.length; i++) {
    const prev = cleaned[i - 1];
    const cur = cleaned[i];
    // A word split across the line break ("repre-" / "sentation") rejoins with no space and
    // no hyphen. (A trailing hyphen after punctuation/space isn't a split word, so it's left.)
    if (/[A-Za-zÀ-ɏ]-$/.test(prev.text)) {
      out = `${out.slice(0, -1)}${cur.text}`;
      continue;
    }
    const paragraphEnd = prev.right < maxRight - margin;
    out += (paragraphEnd ? "\n" : " ") + cur.text;
  }
  return out;
}
