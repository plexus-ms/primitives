// The train (§ 1.5 PLX): one version, tagged identically on every train repo
// whether or not it changed. This file reads the train's state from the
// upstream umbrella (the `plexus-ms` directory of a workspace) and decides the
// next version; `ship` acts on it.
import { join } from 'node:path';
import type { Context } from './context.ts';
import { compareTrains } from './doctor.ts';

/** The repos stamped with the train tag, in release order. */
export const TRAIN_REPOS = [
  'platform',
  'ci-cd',
  'preset-repo-web',
  'preset-app-nextjs',
  'preset-repo-platform',
  'compendium',
] as const;

/** The umbrella directory holding the train repos, relative to the workspace. */
export const UPSTREAM = 'plexus-ms';

/** A train version is plain semver, no `v` prefix (§ 1.5 PLX). */
export const isTrainVersion = (v: string): boolean => /^\d+\.\d+\.\d+$/.test(v);

export function nextMinor(version: string): string {
  const [major = '0', minor = '0'] = version.split('.');
  return `${major}.${Number(minor) + 1}.0`;
}

/**
 * The newest tag of a repo across both eras (`v0.21` and `0.22.0`), compared
 * numerically on the v-stripped form: a plain version sort would rank every
 * v-tag above every plain tag.
 */
export function latestTag(tags: string[]): string | undefined {
  return tags
    .filter((t) => /^v?\d/.test(t))
    .sort((a, b) => compareTrains(a.replace(/^v/, ''), b.replace(/^v/, '')))
    .at(-1);
}

export interface TrainRepo {
  name: string;
  path: string;
  /** The latest tag as git has it; undefined for a repo never tagged. */
  tag?: string;
  /** The same, v-stripped: the train version it names. */
  latest?: string;
  /** `git log --oneline` since the latest tag. */
  pending: string[];
}

export interface Train {
  repos: TrainRepo[];
  /** The highest tag across all repos, v-stripped. */
  last?: string;
  /** True when the repos' latest tags disagree: a run that stopped mid-tag. */
  skew: boolean;
}

/** Fetch every train repo and read its tags and pending commits. */
export async function readTrain(ctx: Context, upstream: string): Promise<Train> {
  const repos: TrainRepo[] = [];
  const all = new Set<string>();
  for (const name of TRAIN_REPOS) {
    const path = join(upstream, name);
    try {
      await ctx.read('git', ['rev-parse', '--git-dir'], { cwd: path });
    } catch {
      throw new Error(`${path} is not a git repo`);
    }
    try {
      await ctx.read('git', ['fetch', 'origin', '--tags', '--quiet'], { cwd: path });
    } catch {
      throw new Error(`${name}: fetch from origin failed`);
    }
    const tags = (await ctx.read('git', ['tag', '--list', 'v*', '[0-9]*'], { cwd: path })).split('\n').filter(Boolean);
    for (const t of tags) all.add(t.replace(/^v/, ''));
    const tag = latestTag(tags);
    const range = tag ? `${tag}..HEAD` : 'HEAD';
    const pending = (await ctx.read('git', ['log', '--oneline', range], { cwd: path })).split('\n').filter(Boolean);
    repos.push({ name, path, tag, latest: tag?.replace(/^v/, ''), pending });
  }
  const latest = repos.map((r) => r.latest);
  return { repos, last: latestTag([...all]), skew: latest.some((l) => l !== latest[0]) };
}

/** Every train repo on main, clean, and not behind origin; throws naming the first offender. */
export async function preflightRelease(ctx: Context, train: Train): Promise<void> {
  for (const { name, path } of train.repos) {
    const branch = (await ctx.read('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path })).trim();
    if (branch !== 'main') throw new Error(`${name} is on '${branch}', trains cut from main`);
    if ((await ctx.read('git', ['status', '--porcelain'], { cwd: path })).trim() !== '')
      throw new Error(`${name} has uncommitted changes — commit first`);
    const behind = (await ctx.read('git', ['rev-list', '--count', 'main..origin/main'], { cwd: path })).trim();
    if (behind !== '0')
      throw new Error(
        `${name} is ${behind} commit(s) behind origin/main — pull first, or the tag lands on a stale commit`,
      );
  }
}

/**
 * The version a run releases or propagates. `propagateOnly` takes the current
 * train; a release takes the explicit version or the next minor, refusing to
 * derive one while the repos' tags disagree.
 */
export function resolveVersion(train: Train, explicit: string | undefined, propagateOnly: boolean): string {
  if (explicit !== undefined && !isTrainVersion(explicit))
    throw new UsageError(`'${explicit}' is not plain semver (X.Y.Z, no v)`);
  if (propagateOnly) {
    const v = explicit ?? train.last;
    if (!v) throw new Error('no train version found to propagate');
    return v;
  }
  if (explicit) return explicit;
  if (train.skew) {
    const report = train.repos.map((r) => `  ${r.name}: ${r.latest ?? 'none'}`).join('\n');
    throw new Error(
      `the train repos' latest tags disagree:\n${report}\npass the version explicitly (--train ${train.last}) to finish the half-tagged train, or a higher one to start a new one`,
    );
  }
  return train.last ? nextMinor(train.last) : '0.1.0';
}

/** A mistake in the arguments, as opposed to a failed run: exit code 2 in the CLI. */
export class UsageError extends Error {}
