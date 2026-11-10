// The consumers of the presets: every copier-managed site under a directory
// (tenant repo roots and their apps/*) and the repo each belongs to. A
// consumer is updated in a scratch checkout of its origin's branch, never in
// its own checkout, on the branch the train lands on: a platform repo (declares
// PLX-Platform) rides main, an app repo (declares PLX-Repo) rides develop
// (§ 3 PLX-Delivery), and a package repo (its root answers say
// `publishes_packages`) is trunk-based on main (§ 5 PLX-Delivery). A repo
// whose marker says neither is taken on the branch its checkout is on.
import { relative } from 'node:path';
import type { Context } from './context.ts';
import type { Declaration } from './marker.ts';
import type { Directory } from './model.ts';
import { TRAIN_REPOS } from './train.ts';

/** The train repos that are templates: what a repo can be generated from. */
export const PRESETS: readonly string[] = TRAIN_REPOS.filter((r) => r.startsWith('preset-'));

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
  /** The branch the train lands on: the expected one, or the checkout's own when the marker names none. */
  branch: string;
  expected?: 'main' | 'develop';
  /** The URL of `origin`, which the scratch clone is made from. */
  origin?: string;
  /** Why the consumer is left untouched this run, if it is. */
  skipped?: string;
  /** Its sites in tree order: the repo root before its apps. */
  sites: Site[];
}

/** The branch a consumer is updated on; undefined when the marker says neither. */
export function expectedBranch(declaration?: Declaration, answers: Record<string, unknown> = {}): Consumer['expected'] {
  if (!declaration) return undefined;
  if (declaration.modules.includes('PLX-Platform')) return 'main';
  if (declaration.modules.includes('PLX-Repo')) return answers.publishes_packages === true ? 'main' : 'develop';
  return undefined;
}

/** The template source copier records for a preset of the upstream organisation. */
export const presetSource = (preset: string): string => `gh:plexus-ms/${preset}`;

/**
 * Presets renamed on a train, old name → current (0.114.0: the web preset
 * became the Turborepo preset, the platform repo the operations repo). A
 * consumer whose answers still name the old one is a consumer of the current
 * one, and its next update points the answers at the new name.
 */
export const RENAMED_PRESETS: Readonly<Record<string, string>> = {
  'preset-repo-web': 'preset-repo-turbo',
  'preset-repo-platform': 'preset-repo-operations',
};

/** The current preset a recorded template source stands for, or undefined when it is none of the given presets. */
export function presetOf(src: string, presets: readonly string[]): string | undefined {
  for (const p of presets) if (presetSource(p) === src) return p;
  for (const [old, current] of Object.entries(RENAMED_PRESETS))
    if (presetSource(old) === src && presets.includes(current)) return current;
  return undefined;
}

/**
 * The consumers under a scanned workspace (`overview` with git facets), for
 * the given presets. A site inside a template directory is the template's own
 * and never a consumer; a site outside any git repo is reported, not updated;
 * a repo without an origin has nowhere to clone from and is skipped.
 */
export async function findConsumers(ctx: Context, root: Directory, presets: readonly string[]): Promise<Consumer[]> {
  const consumers = new Map<string, Consumer>();
  const orphans: Site[] = [];

  const visit = (dir: Directory, repo: Directory | undefined, inTemplate: boolean) => {
    const here = dir.git ? dir : repo;
    const template = inTemplate || Boolean(dir.template);
    const preset = dir.copier?.src ? presetOf(dir.copier.src, presets) : undefined;
    if (preset && !template) {
      const site: Site = { path: dir.path, rel: relative(root.path, dir.path) || '.', preset };
      if (!here) orphans.push(site);
      else {
        let consumer = consumers.get(here.path);
        if (!consumer) {
          const expected = expectedBranch(here.declaration, here.copier?.answers);
          consumer = {
            path: here.path,
            rel: relative(root.path, here.path) || '.',
            branch: expected ?? here.git?.branch ?? 'main',
            expected,
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
    const origin = (await ctx.read('git', ['remote', 'get-url', 'origin'], { cwd: c.path }).catch(() => '')).trim();
    if (origin === '') c.skipped = 'no origin remote';
    else c.origin = origin;
  }
  return [...consumers.values()];
}
