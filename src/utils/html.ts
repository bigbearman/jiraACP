const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ENTITIES[ch] ?? ch);
}

/** Wraps each line separately so a tag never spans a line break. */
export function wrapLines(text: string, tag: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `<${tag}>${line}</${tag}>` : line))
    .join("\n");
}

/**
 * Splits an HTML message into chunks that fit a Telegram message, cutting only
 * at line breaks. Callers must keep every tag opened and closed on one line.
 */
export function splitHtmlByLines(html: string, limit = 4000): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of html.split("\n").flatMap((l) => fitLine(l, limit))) {
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ponytail: a single line longer than the limit is re-cut as plain text and
// loses its formatting, because tags and entities cannot be cut mid-way.
function fitLine(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];
  const plain = line
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const size = Math.floor(limit / 5); // worst case: every char becomes "&amp;"
  const pieces: string[] = [];
  for (let i = 0; i < plain.length; i += size) {
    pieces.push(escapeHtml(plain.slice(i, i + size)));
  }
  return pieces;
}
