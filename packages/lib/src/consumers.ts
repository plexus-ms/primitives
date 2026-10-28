// The consumers of the presets: every copier-managed site in a workspace
// (tenant repo roots and their apps/*) and the repo each belongs to, with the
// rule that protects a consumer from an update it did not ask for: a repo is
// touched only on its expected branch and with no tracked modifications;
// untracked files do not block. The expected branch is read from the repo's
// marker (§ 1.4 PLX): a platform repo (declares PLX-Platform) rides main, an
// app repo (declares PLX-Repo) rides develop.
import { relative } from 'node:path';
import type { Context } from './context.ts';
import type { Declaration } from './marker.ts';
import type { Directory } from './model.ts';

export interface Site {
  path: string;
  /** Relative to the workspace. */
  rel: string;
  /** The preset the site is generated from, e.g. `preset-repo-web`. */
  preset: string;
}

export interface Consumer {
  path: string;
  rel: string;
  branch: string;
  expected?: 'main' | 'develop';
  /** Why the consumer is left untouched this run, if it is. */
  skipped?: string;
  /** Its sites in tree order: the repo root before its apps. */
  sites: Site[];
}

/** The branch a consumer must be on for an update to touch it; undefined when the marker says neither. */
export function expectedBranch(declaration?: Declaration): Consumer['expected'] {
  if (!declaration) return undefined;
  if (declaration.modules.includes('PLX-Platform')) return 'main';
  if (declaration.modules.includes('PLX-Repo')) return 'develop';
  return undefined;
}

/** The template source copier records for a preset of the upstream organisation. */
export const presetSource = (preset: string): string => `gh:plexus-ms/${preset}`;

/**
 * The consumers under a scanned workspace (`overview` with git facets), for
 * the given presets. A site inside a template directory is the template's own
 * and never a consumer; a site outside any git repo is reported, not updated.
 */
export async function findConsumers(ctx: Context, root: Directory, presets: readonly string[]): Promise<Consumer[]> {
  const sources = new Map(presets.map((p) => [presetSource(p), p]));
  const consumers = new Map<string, Consumer>();
  const orphans: Site[] = [];

  const visit = (dir: Directory, repo: Directory | undefined, inTemplate: boolean) => {
    const here = dir.git ? dir : repo;
    const template = inTemplate || Boolean(dir.template);
    const preset = dir.copier?.src ? sources.get(dir.copier.src) : undefined;
    if (preset && !template) {
      const site: Site = { path: dir.path, rel: relative(root.path, dir.path) || '.', preset };
      if (!here) orphans.push(site);
      else {
        let consumer = consumers.get(here.path);
        if (!consumer) {
          consumer = {
            path: here.path,
            rel: relative(root.path, here.path) || '.',
            branch: here.git?.branch ?? '?',
            expected: expectedBranch(here.declaration),
            sites: [],
          };
          consumers.set(here.path, consumer);
        }
        consumer.sites.push(site);
      }
    }
    for (const child of dir.children) visit(child, here, template);
  };
  visit(root, undefined, false);

  for (const site of orphans) ctx.say(`⚠ ${site.rel}: not inside a git repo — skipped`);
  for (const c of consumers.values()) {
    if (c.expected && c.branch !== c.expected) {
      c.skipped = `on '${c.branch}', expected '${c.expected}'`;
      continue;
    }
    const tracked = (await ctx.read('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: c.path })).trim();
    if (tracked !== '') c.skipped = 'has uncommitted changes';
  }
  return [...consumers.values()];
}
