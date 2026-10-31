// overview: the map of a folder of repos (the toolbox's overview.sh, moved).
//
// Walk a directory, note for every directory whether it is a git repo, a
// copier template, a copier-managed project, or a declared Plexus unit, and
// return the tree of directories that carry such a facet, with the ancestors
// needed to reach them. Reads only: there is nothing to plan or apply.
//
//   plx overview            # map the current directory
//   plx overview ~/dev      # map somewhere else
//   plx overview --sync     # fetch every repo first, to show what is behind
import { join } from 'node:path';
import type { Context } from './context.ts';
import { ANSWERS_FILE, parseAnswers, TEMPLATE_FILES } from './copier.ts';
import { MARKER_FILE, parseMarker } from './marker.ts';
import { type Directory, type GitFacet, isNotable, shortRemote, type TemplateFacet } from './model.ts';

/** Heavy or generated directories never descended into. `.git` is the repo marker and is handled apart. */
export const PRUNED = new Set([
  'node_modules',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  '.output',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.cache',
  '.pnpm-store',
  'coverage',
  'vendor',
  '.terraform',
  '.gradle',
]);

export interface ScanOptions {
  /** Read the git facets (four git calls per repo); off for verbs that only need markers. */
  git?: boolean;
  /** Fetch every repo's remotes, then count commits ahead of and behind the upstream; slow, so opt-in. */
  fetch?: boolean;
}

/** Fetches in flight at once: enough to hide network latency, few enough not to trip a host's rate limit. */
const FETCHES = 8;

export async function overview(ctx: Context, root: string, options: ScanOptions = {}): Promise<Directory> {
  const opts = { git: true, fetch: false, ...options };
  const tree = await walk(ctx, root, root.replace(/\/+$/, '').split('/').pop() || root, opts);
  if (opts.git && opts.fetch) await syncAll(ctx, repos(tree));
  return tree;
}

function repos(dir: Directory): Directory[] {
  return [...(dir.git ? [dir] : []), ...dir.children.flatMap(repos)];
}

async function syncAll(ctx: Context, dirs: Directory[]): Promise<void> {
  const queue = [...dirs];
  const worker = async () => {
    for (let dir = queue.shift(); dir; dir = queue.shift()) await sync(ctx, dir);
  };
  await Promise.all(Array.from({ length: Math.min(FETCHES, queue.length) }, worker));
}

/** Fetch all remotes (only remote-tracking refs change), then compare the branch with its upstream. */
async function sync(ctx: Context, dir: Directory): Promise<void> {
  const facet = dir.git;
  if (!facet) return;
  try {
    await ctx.read('git', ['fetch', '--all', '--quiet'], { cwd: dir.path });
  } catch (error) {
    dir.problems ??= [];
    dir.problems.push(`git fetch: ${error instanceof Error ? error.message : String(error)}`);
  }
  // No upstream (detached, or a branch never pushed) leaves nothing to compare against.
  const counts = await git(ctx, dir.path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  const [ahead, behind] = (counts ?? '').split(/\s+/).map(Number);
  if (ahead === undefined || behind === undefined || Number.isNaN(ahead) || Number.isNaN(behind)) return;
  facet.ahead = ahead;
  facet.behind = behind;
}

async function walk(ctx: Context, path: string, name: string, options: Required<ScanOptions>): Promise<Directory> {
  const entries = await ctx.readDir(path);
  const files = new Set(entries.filter((e) => !e.directory).map((e) => e.name));
  const names = new Set(entries.map((e) => e.name));
  const dir: Directory = { name, path, children: [] };

  // `.git` is a directory for a checkout and a file for a worktree or submodule.
  if (names.has('.git') && options.git) dir.git = await gitFacet(ctx, path);
  if (TEMPLATE_FILES.some((f) => files.has(f))) dir.template = options.git ? await templateFacet(ctx, path) : {};
  if (files.has(ANSWERS_FILE)) {
    await facet(ctx, dir, ANSWERS_FILE, (text) => {
      dir.copier = parseAnswers(text);
    });
  }
  if (files.has(MARKER_FILE)) {
    await facet(ctx, dir, MARKER_FILE, (text) => {
      dir.declaration = parseMarker(text);
    });
  }

  const subdirs = entries
    .filter((e) => e.directory && e.name !== '.git' && !PRUNED.has(e.name))
    .map((e) => e.name)
    .sort();
  for (const sub of subdirs) {
    const child = await walk(ctx, join(path, sub), sub, options);
    if (isNotable(child) || child.children.length > 0) dir.children.push(child);
  }
  return dir;
}

async function facet(ctx: Context, dir: Directory, file: string, read: (text: string) => void) {
  try {
    read(await ctx.readFile(join(dir.path, file)));
  } catch (error) {
    dir.problems ??= [];
    dir.problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A git read that may legitimately fail (no remote, no tag, detached): undefined then. */
async function git(ctx: Context, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const out = (await ctx.read('git', args, { cwd })).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

async function gitFacet(ctx: Context, cwd: string): Promise<GitFacet> {
  const branch =
    (await git(ctx, cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])) ??
    (await git(ctx, cwd, ['rev-parse', '--short', 'HEAD'])) ??
    '?';
  const dirty = (await git(ctx, cwd, ['status', '--porcelain'])) !== undefined;
  const remote = await git(ctx, cwd, ['remote', 'get-url', 'origin']);
  // The most recent tag reachable from the default branch: origin/HEAD, else a local main or master.
  let defaultRef = await git(ctx, cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  for (const b of ['main', 'master']) {
    if (defaultRef) break;
    if (await git(ctx, cwd, ['rev-parse', '--verify', '-q', `refs/heads/${b}`])) defaultRef = b;
  }
  const tag = defaultRef ? await git(ctx, cwd, ['describe', '--tags', '--abbrev=0', defaultRef]) : undefined;
  const facet: GitFacet = { branch, dirty };
  if (tag) facet.tag = tag;
  if (remote) facet.remote = shortRemote(remote);
  return facet;
}

async function templateFacet(ctx: Context, cwd: string): Promise<TemplateFacet> {
  const tag =
    (await git(ctx, cwd, ['describe', '--tags', '--abbrev=0'])) ??
    (await git(ctx, cwd, ['tag', '--list', '--sort=-v:refname']))?.split('\n')[0];
  return tag ? { tag } : {};
}
