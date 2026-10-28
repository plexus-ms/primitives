// changeset: the changeset a dependency bump owes (§ 5 PLX-Delivery), a verb,
// not a system.
//
// The update bot writes no changesets, so a bump that changes what a
// published package ships would never reach a release. This verb reads what
// the branch changed since its merge base and writes the one changeset the
// bump owes, deterministically: the same diff always yields the same file,
// so a rerun after the bot's rebase changes nothing, and a diff that owes
// nothing removes the file an earlier run left.
//
// The rule is the ecosystem's (pnpm's `update --changeset`, Renovate's
// proposed `changesets` option): every workspace package whose
// `dependencies`, `optionalDependencies` or `peerDependencies` changed,
// directly or through a catalog entry it consumes, gets a bump: patch, or
// major when a peer range moved. `devDependencies` and the lockfile never
// reach a consumer and owe nothing; private packages, nameless packages and
// the `ignore` list of `.changeset/config.json` are skipped. A package that
// inlines a devDependency into its artifact is outside the rule and says so
// where it is published.
//
//   plx changeset                             # on a bot branch, in the repo's root
//   plx changeset --base origin/main -n .     # what it would write
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Context } from './context.ts';
import { ExecError } from './io.ts';
import { type Plan, run, write } from './plan.ts';

export const CHANGESET_DIR = '.changeset';

const FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
type Field = (typeof FIELDS)[number];

/** The part of a package.json the verb reads. */
export interface Manifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** pnpm's catalogs: the default one and the named ones, each name → range. */
export interface Catalogs {
  default: Record<string, string>;
  named: Record<string, Record<string, string>>;
}

export interface PackageDiff {
  /** The manifest's path, relative to the repo's root. */
  path: string;
  before?: Manifest;
  after?: Manifest;
}

export interface DependencyChange {
  package: string;
  dependency: string;
  field: Field;
  from?: string;
  to?: string;
}

export interface ChangesetInput {
  /** The branch the bump rides, naming the file. */
  branch: string;
  packages: PackageDiff[];
  catalogsBefore: Catalogs;
  catalogsAfter: Catalogs;
  /** Package names changesets is told to ignore. */
  ignore: string[];
  /** Whether the file this branch names exists already. */
  exists: boolean;
  /** The repo's root, which the plan's steps are addressed to; the cwd when absent. */
  root?: string;
}

export interface Changeset {
  /** The changeset file, relative to the repo's root. */
  path: string;
  /** Package name → bump; empty when nothing is owed. */
  releases: Record<string, 'patch' | 'major'>;
  changes: DependencyChange[];
  /** The file's text, or undefined when nothing is owed. */
  content?: string;
  plan: Plan;
}

/** The name of the changeset file a branch owns: one per branch, so reruns overwrite. */
export function changesetPath(branch: string): string {
  const slug = branch
    .replace(/^(renovate|dependabot)\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `${CHANGESET_DIR}/bot-${slug || 'branch'}.md`;
}

/** The changeset a set of manifest diffs owes: pure, so a test compares outputs. */
export function planChangeset(input: ChangesetInput): Changeset {
  const path = changesetPath(input.branch);
  const changes: DependencyChange[] = [];
  const releases: Record<string, 'patch' | 'major'> = {};
  for (const diff of input.packages) {
    const { before, after } = diff;
    if (!before || !after?.name || after.private || input.ignore.includes(after.name)) continue;
    for (const field of FIELDS) {
      const names = new Set([...Object.keys(before[field] ?? {}), ...Object.keys(after[field] ?? {})]);
      for (const dependency of [...names].sort()) {
        const from = resolveRange(before[field]?.[dependency], dependency, input.catalogsBefore);
        const to = resolveRange(after[field]?.[dependency], dependency, input.catalogsAfter);
        if (from === to) continue;
        changes.push({ package: after.name, dependency, field, from, to });
        const bump = field === 'peerDependencies' ? 'major' : 'patch';
        if (releases[after.name] !== 'major') releases[after.name] = bump;
      }
    }
  }

  const root = input.root;
  if (changes.length === 0) {
    const remove = run('rm', ['-f', path], root ? { cwd: root } : {});
    return { path, releases, changes, plan: input.exists ? [remove] : [] };
  }
  const header = Object.entries(releases)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bump]) => `'${name}': ${bump}`);
  const lines = [...new Set(changes.map(describeChange))].sort((a, b) => a.localeCompare(b));
  const content = `---\n${header.join('\n')}\n---\n\n${lines.join('\n')}\n`;
  return { path, releases, changes, content, plan: [write(root ? join(root, path) : path, content)] };
}

function describeChange(c: DependencyChange): string {
  const peer = c.field === 'peerDependencies' ? ' (peer)' : '';
  if (c.from === undefined) return `Add \`${c.dependency}\`${peer} at ${c.to}`;
  if (c.to === undefined) return `Remove \`${c.dependency}\`${peer}`;
  return `Update \`${c.dependency}\`${peer} from ${c.from} to ${c.to}`;
}

/** A `catalog:` or `catalog:<name>` value resolved through the catalogs; anything else as written. */
function resolveRange(value: string | undefined, dependency: string, catalogs: Catalogs): string | undefined {
  if (value === undefined) return undefined;
  if (value === 'catalog:' || value === 'catalog:default') return catalogs.default[dependency] ?? value;
  if (value.startsWith('catalog:')) return catalogs.named[value.slice('catalog:'.length)]?.[dependency] ?? value;
  return value;
}

/** The catalogs of a pnpm-workspace.yaml; empty when the file or the keys are absent. */
export function parseCatalogs(text: string | undefined): Catalogs {
  const data: unknown = text === undefined ? undefined : parse(text);
  const ws = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const map = (v: unknown): Record<string, string> =>
    v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, r]) => [k, String(r)]))
      : {};
  const named = ws.catalogs !== null && typeof ws.catalogs === 'object' ? (ws.catalogs as Record<string, unknown>) : {};
  return {
    default: map(ws.catalog),
    named: Object.fromEntries(Object.entries(named).map(([name, entries]) => [name, map(entries)])),
  };
}

/** The workspace's package directories from the `packages` globs; one level of `*` is understood. */
export function workspaceGlobs(text: string | undefined): string[] {
  const data: unknown = text === undefined ? undefined : parse(text);
  const globs = data !== null && typeof data === 'object' ? (data as { packages?: unknown }).packages : undefined;
  return Array.isArray(globs) ? globs.map(String).filter((g) => !g.startsWith('!')) : [];
}

/**
 * Read the branch's diff since its merge base with `base` and plan the
 * changeset. Reads only; the plan is applied by the caller.
 */
export async function readChangeset(ctx: Context, dir: string, base: string, branch?: string): Promise<Changeset> {
  const git = (args: string[]) => ctx.read('git', args, { cwd: dir });
  const head = branch ?? (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const mergeBase = (await git(['merge-base', base, 'HEAD'])).trim();
  const show = async (path: string): Promise<string | undefined> => {
    try {
      return await git(['show', `${mergeBase}:${path}`]);
    } catch (error) {
      if (error instanceof ExecError) return undefined;
      throw error;
    }
  };
  const current = async (path: string): Promise<string | undefined> => {
    try {
      return await ctx.readFile(join(dir, path));
    } catch {
      return undefined;
    }
  };

  const workspaceAfter = await current('pnpm-workspace.yaml');
  const packages: PackageDiff[] = [];
  for (const glob of workspaceGlobs(workspaceAfter)) {
    for (const pkgDir of await expand(ctx, dir, glob)) {
      const path = `${pkgDir}/package.json`;
      const [before, after] = await Promise.all([show(path), current(path)]);
      packages.push({ path, before: manifest(before), after: manifest(after) });
    }
  }

  const config = await current(`${CHANGESET_DIR}/config.json`);
  const ignore = config ? ((JSON.parse(config) as { ignore?: string[] }).ignore ?? []) : [];
  const entries = await ctx.readDir(join(dir, CHANGESET_DIR)).catch(() => []);
  const path = changesetPath(head);
  return planChangeset({
    branch: head,
    packages,
    catalogsBefore: parseCatalogs(await show('pnpm-workspace.yaml')),
    catalogsAfter: parseCatalogs(workspaceAfter),
    ignore,
    exists: entries.some((e) => !e.directory && `${CHANGESET_DIR}/${e.name}` === path),
    root: dir,
  });
}

function manifest(text: string | undefined): Manifest | undefined {
  return text === undefined ? undefined : (JSON.parse(text) as Manifest);
}

/** `dir/*` lists the directories under dir; a glob without `*` is the path itself. */
async function expand(ctx: Context, root: string, glob: string): Promise<string[]> {
  const star = glob.indexOf('*');
  if (star < 0) return [glob.replace(/\/$/, '')];
  const parent = glob.slice(0, star).replace(/\/$/, '');
  const entries = await ctx.readDir(join(root, parent)).catch(() => []);
  return entries
    .filter((e) => e.directory && !e.name.startsWith('.'))
    .map((e) => (parent ? `${parent}/${e.name}` : e.name))
    .sort();
}
