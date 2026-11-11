// The train bookkeeping as text transforms: every version number a train repo
// carries becomes the train version, so cross-repo pins are right by
// construction (§ 1.5 PLX). Pure functions from a file's text to its new text;
// `ship` reads, transforms and plans a write for each one that changed. The
// workflow refs are moved by the same transform a repo taking the train runs,
// `bumpWorkflowRefs` of @plexus-ms/lib.
//
// One writer per pin (§ 1 PLX-Updates): the pins below are the train's and
// nobody else's; the update bot is told to leave them alone.
import { setFrontmatterField } from '@plexus-ms/lib';

/** The four collections of `primitives`, each with a `galaxy.yml` of its own (§ 2 PLX-Platform). */
export const COLLECTIONS = ['host', 'platform', 'infrastructure', 'ci'] as const;

/** A collection's `galaxy.yml` in `primitives`. */
export const galaxyFile = (collection: string): string => `ansible/${collection}/galaxy.yml`;

/** `galaxy.yml` mirrors the tag: SCM installs record this version and reinstall on any different one. */
export const bumpGalaxyVersion = (text: string, train: string): string =>
  text.replace(/^(version: )\d+\.\d+\.\d+/m, `$1${train}`);

/** The git source of the `plexus.*` collections, as an operations repo's requirements name it. */
export const COLLECTION_SOURCE = 'plexus-ms/primitives.git';

/** The `plexus.*` collections' pins in an operations repo's requirements, every entry from `primitives`; a collection from elsewhere in the same file stays. */
export function bumpCollectionPin(text: string, train: string): string {
  const lines = text.split('\n');
  let ours = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*- /.test(line)) ours = line.includes(COLLECTION_SOURCE);
    const m = /^(\s*version: )v?[\d.]+$/.exec(line);
    if (ours && m) lines[i] = `${m[1]}${train}`;
  }
  return lines.join('\n');
}

/** Where the runner image of a runner host's slots is pinned: the role's defaults, in primitives. */
export const RUNNER_IMAGE_PIN_FILE = 'ansible/ci/roles/actions_runners/defaults/main.yml';

/** The runner image's tag, `ghcr.io/plexus-ms/ci-runner:<train>`, which runner-image.yml pushes from the train's release. */
export const bumpRunnerImagePin = (text: string, train: string): string =>
  text.replace(/(ghcr\.io\/plexus-ms\/ci-runner:)\d+\.\d+\.\d+/g, `$1${train}`);

/** A package manifest's own `version`: the first one in the file, which is the top-level field. */
export const bumpManifestVersion = (text: string, train: string): string =>
  text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${train}$2`);

/** The plx and plx-ci pins in a `mise.toml`, exact, in either spelling: `"npm:@plexus-ms/cli" = "N"` or `= { version = "N", ... }`. */
export const PLX_PIN = 'npm:@plexus-ms/cli';
export const bumpPlxPin = (text: string, train: string): string =>
  text.replace(/("npm:@plexus-ms\/cli(?:-ci)?"\s*=\s*(?:\{\s*version\s*=\s*)?")[^"]*(")/g, `$1${train}$2`);

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

/** Today as `YYYY-MM-DD` in local time, like `date +%F`. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
