// The declaration marker, PLEXUS.md (§ 1.4 PLX): YAML frontmatter with the
// Plexus version and the declared modules, then free-form prose. This is the
// one reader of that shape; every verb that needs a marker parses it here.
import { parse } from 'yaml';

export interface Declaration {
  /** The Plexus version the unit was last brought up to, e.g. `0.62.0`. */
  plexus: string;
  /** The module codes it follows, e.g. `PLX-Repo`. */
  modules: string[];
  /** The prose after the frontmatter: what the unit is, and its owned deviations. */
  body: string;
}

export const MARKER_FILE = 'PLEXUS.md';

export function parseMarker(text: string): Declaration {
  const { data, body } = splitFrontmatter(text);
  const plexus = data.plexus;
  const modules = data.modules;
  if (typeof plexus !== 'string' && typeof plexus !== 'number') throw new Error('marker: `plexus` must be a version');
  if (!Array.isArray(modules) || !modules.every((m) => typeof m === 'string'))
    throw new Error('marker: `modules` must be a list of module codes');
  return { plexus: String(plexus), modules, body };
}

/** The YAML between the leading `---` lines, as a plain object, and the rest. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error('no frontmatter: expected a `---` block at the top');
  const data: unknown = parse(match[1] ?? '');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter is not a mapping');
  return { data: data as Record<string, unknown>, body: match[2] ?? '' };
}
