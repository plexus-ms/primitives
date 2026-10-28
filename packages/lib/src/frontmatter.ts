// Line-based edits of a page's YAML frontmatter: the marker's `plexus`, the
// map's `version` and `timestamp`, a module's `changed`. Pages are authored by
// hand, so an edit replaces or inserts one line and leaves everything else,
// comments and order included, exactly as written; re-serialising the YAML
// would not. Reading frontmatter is marker.ts's `splitFrontmatter`.

/** The index range of the frontmatter's inner lines, or undefined when the page has none. */
function frontmatterLines(lines: string[]): { start: number; end: number } | undefined {
  if (lines[0] !== '---') return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l === '---');
  return end === -1 ? undefined : { start: 1, end };
}

export interface SetFieldOptions {
  /** When the field is absent, insert it after this key; at the end of the frontmatter otherwise. */
  after?: string;
}

/** The page with `key: value` set in its frontmatter; the same text when already so. */
export function setFrontmatterField(text: string, key: string, value: string, options: SetFieldOptions = {}): string {
  const lines = text.split('\n');
  const fm = frontmatterLines(lines);
  if (!fm) throw new Error('no frontmatter: expected a `---` block at the top');
  const line = `${key}: ${value}`;
  const isKey = (l: string) => l.startsWith(`${key}:`);
  const existing = lines.findIndex((l, i) => i >= fm.start && i < fm.end && isKey(l));
  if (existing !== -1) {
    lines[existing] = line;
  } else {
    const anchor = options.after
      ? lines.findIndex((l, i) => i >= fm.start && i < fm.end && l.startsWith(`${options.after}:`))
      : -1;
    lines.splice(anchor === -1 ? fm.end : anchor + 1, 0, line);
  }
  return lines.join('\n');
}

/** The value of a frontmatter field as written, trimmed; undefined when absent. */
export function frontmatterField(text: string, key: string): string | undefined {
  const lines = text.split('\n');
  const fm = frontmatterLines(lines);
  if (!fm) return undefined;
  const line = lines.slice(fm.start, fm.end).find((l) => l.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim();
}
