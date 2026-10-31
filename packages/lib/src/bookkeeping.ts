// The train bookkeeping as text transforms: every version number a train repo
// carries becomes the train version, so cross-repo pins are right by
// construction (§ 1.5 PLX). Pure functions from a file's text to its new text;
// `ship` reads, transforms and plans a write for each one that changed.
//
// One writer per pin (§ 1 PLX-Updates): the pins below are the train's and
// nobody else's; the update bot is told to leave them alone.
import { setFrontmatterField } from './frontmatter.ts';

/** `galaxy.yml` mirrors the tag: SCM installs record this version and reinstall on any different one. */
export const bumpGalaxyVersion = (text: string, train: string): string =>
  text.replace(/^(version: )\d+\.\d+\.\d+/m, `$1${train}`);

/** The git source of the `plexus.platform` collection, as a platform repo's requirements name it. */
export const COLLECTION_SOURCE = 'plexus-ms/primitives.git';

/** The `plexus.platform` collection's pin in a platform repo's requirements; another collection in the same file stays. */
export function bumpCollectionPin(text: string, train: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes(COLLECTION_SOURCE));
  if (start === -1) return text;
  for (let i = start; i < lines.length; i++) {
    const m = /^(\s*version: )v?[\d.]+$/.exec(lines[i] ?? '');
    if (m) {
      lines[i] = `${m[1]}${train}`;
      break;
    }
  }
  return lines.join('\n');
}

export const WORKFLOW_REF = 'plexus-ms/primitives/.github/workflows/';

/** Every `uses: plexus-ms/primitives/.github/workflows/<file>@<ref>` pinned to the train. */
export const bumpWorkflowRefs = (text: string, train: string): string =>
  text.replace(/(plexus-ms\/primitives\/\.github\/workflows\/[A-Za-z0-9._-]+)@v?[0-9.]+/g, `$1@${train}`);

/** A package manifest's own `version`: the first one in the file, which is the top-level field. */
export const bumpManifestVersion = (text: string, train: string): string =>
  text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${train}$2`);

/** The plx pin in a `mise.toml`, exact, in either spelling: `"npm:@plexus-ms/cli" = "N"` or `= { version = "N", ... }`. */
export const PLX_PIN = 'npm:@plexus-ms/cli';
export const bumpPlxPin = (text: string, train: string): string =>
  text.replace(/("npm:@plexus-ms\/cli"\s*=\s*(?:\{\s*version\s*=\s*)?")[^"]*(")/g, `$1${train}$2`);

/**
 * The `@plexus-ms/config` dependency in a package manifest, exact and without
 * a caret: a workspace or catalog reference (the upstream repos' own) is not a pin and stays.
 */
export const CONFIG_PIN = '@plexus-ms/config';
export const bumpConfigPin = (text: string, train: string): string =>
  text.replace(/("@plexus-ms\/config":\s*")(?!workspace:|catalog:)[^"]*(")/g, `$1${train}$2`);

/**
 * The `@plexus-ms/config` entry of the `plexus` catalog in a workspace file
 * (`catalogs.plexus` in `pnpm-workspace.yaml`): the one place a web repo pins
 * the train-versioned config, every manifest saying `catalog:plexus`.
 */
export const bumpCatalogPin = (text: string, train: string): string =>
  text.replace(/^(\s+"@plexus-ms\/config":\s*)\S+$/m, `$1${train}`);

/** The map's frontmatter carries the train version and the date it was cut (§ 1.5 PLX). */
export const stampStandard = (text: string, train: string, today: string): string =>
  setFrontmatterField(setFrontmatterField(text, 'version', train), 'timestamp', today);

/** `changed: <train>` on a module page: replaced in place, or inserted after `binds:` (the field order of § 1.3 PLX). */
export const stampChanged = (text: string, train: string): string =>
  setFrontmatterField(text, 'changed', train, { after: 'binds' });

/** Leftovers of a three-way apply that did not go through. */
export const hasConflictMarkers = (text: string): boolean => /^<<<<<<< /m.test(text);

/** Whether `git status --porcelain` output shows unmerged entries. */
export const hasUnmergedEntries = (porcelain: string): boolean => /^(UU|AA|DU|UD)/m.test(porcelain);

/**
 * The marker says which train a unit was brought up to (§ 1.4 PLX). copier
 * re-renders it only when the preset's content changed, so a train that
 * touched nothing in a preset would leave `plexus:` behind while bumping the
 * answers file; this syncs it to the answers file's `_commit`, which copier
 * always writes. A marker with conflict markers is left to the human.
 */
export function syncMarker(marker: string, commit: string): string {
  if (hasConflictMarkers(marker)) return marker;
  return setFrontmatterField(marker, 'plexus', commit);
}

/** Today as `YYYY-MM-DD` in local time, like `date +%F`. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
