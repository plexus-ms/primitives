// ship: the release train (§ 1.5 PLX). Every train repo ships under ONE
// version, tagged identically whether or not it changed, in two phases:
//
//   preflight (plx itself not behind its newest release, self.ts; every train
//   repo on main, clean, not behind origin, the latest tags in agreement; gh
//   logged in; no mutable release on any train repo)
//   → phase one: primitives' bookkeeping (galaxy version, the train-versioned
//     packages' manifests, its own workflow refs), commit, tag, push, GitHub
//     release — which locks the tag and runs primitives' release workflow
//   → wait until the three packages are on npm at the train number
//   → phase two: the presets' and the compendium's bookkeeping (collection
//     pin, workflow refs, plx and config pins, the map's version and
//     timestamp, `changed` on every standard module whose requirements moved),
//     commit, tag, push, release, repo by repo
//   → propagate to every consumer as pull requests (propagate.ts).
//
// The wait is what lets phase two pin the train number: the compendium's
// commit hook installs plx at that pin, and the presets hand it to every
// consumer. Substance commits stay human; ship writes only the mechanical
// bookkeeping. A failure between the first tag and the last release leaves a
// half-tagged train; the recovery is a re-run naming the same version, which
// skips the repos already tagged and the releases that exist. A release is
// never deleted: a deleted immutable release burns its number for good.
//
//   plx ship ~/dev                    # next train = minor+1 over the latest
//   plx ship ~/dev --train 1.0.0      # explicit train version
//   plx -n ship ~/dev                 # preview: list the bookkeeping, tags and
//                                     # the propagation in scratch clones
//   plx -y ship ~/dev                 # unattended: no prompt, copier takes defaults
import { join } from 'node:path';
import {
  bumpCollectionPin,
  bumpConfigPin,
  bumpGalaxyVersion,
  bumpManifestVersion,
  bumpPlxPin,
  bumpWorkflowRefs,
  CONFIG_PIN,
  PLX_PIN,
  stampChanged,
  stampStandard,
  today as todayOf,
  WORKFLOW_REF,
} from './bookkeeping.ts';
import type { Context } from './context.ts';
import { frontmatterField } from './frontmatter.ts';
import { type Plan, run, write } from './plan.ts';
import { propagate, type Summary } from './propagate.ts';
import { extractRequirements, MAP_PAGE, modulePages } from './requirements.ts';
import { preflightSelf } from './self.ts';
import {
  PRIMITIVES,
  phasesOf,
  preflightForge,
  preflightRelease,
  readTrain,
  resolveVersion,
  TRAIN_PACKAGES,
  type Train,
  type TrainRepo,
  UPSTREAM,
} from './train.ts';

/** How the wait for npm between the phases behaves, in milliseconds. */
export interface PublishWait {
  /** Between two polls of the registry. */
  interval: number;
  /** After which the run stops, resumable. */
  timeout: number;
}

const DEFAULT_WAIT: PublishWait = { interval: 15_000, timeout: 20 * 60_000 };

export interface ShipOptions {
  /** The workspace: the upstream umbrella and the consumers sit under it. */
  workspace: string;
  /** The train version; default: minor+1 over the latest, or the current one when only propagating. */
  train?: string;
  /** Skip the release; only propagate to the consumers. */
  propagateOnly?: boolean;
  /** The date stamped on the map, `YYYY-MM-DD`; default: today. */
  today?: string;
  /** The running plx's version: when given, refuse to run behind its newest release (self.ts). */
  plx?: string;
  /** The publish wait's pacing; the defaults suit a real registry, tests shorten them. */
  wait?: Partial<PublishWait>;
}

export interface ShipResult extends Summary {
  /** The version released, or already current when only propagating. */
  released: boolean;
}

export async function ship(ctx: Context, options: ShipOptions): Promise<ShipResult> {
  const upstream = join(options.workspace, UPSTREAM);
  const propagateOnly = options.propagateOnly ?? false;
  if (options.plx) await preflightSelf(ctx, options.plx);
  const train = await readTrain(ctx, upstream);
  await preflightForge(ctx);
  if (!propagateOnly) {
    await preflightRelease(ctx, train);
    await preflightImmutable(ctx, train);
  }
  const next = resolveVersion(train, options.train, propagateOnly);
  if (!propagateOnly) await release(ctx, train, next, options.today ?? todayOf(), { ...DEFAULT_WAIT, ...options.wait });
  const summary = await propagate(ctx, options.workspace, next);
  return { ...summary, released: !propagateOnly };
}

/**
 * The immutable-releases setting is not readable through the API, but every
 * release says whether it is immutable: a train repo whose newest release is
 * mutable had the setting off when it was cut, and the train stops before
 * another number is spent. A repo with no release yet is checked on its first
 * one, right after creation (tagAndRelease).
 */
async function preflightImmutable(ctx: Context, train: Train): Promise<void> {
  for (const repo of train.repos) {
    const newest = (
      await ctx
        .read('gh', ['api', 'repos/{owner}/{repo}/releases?per_page=1', '--jq', '.[0].immutable'], { cwd: repo.path })
        .catch(() => '')
    ).trim();
    if (newest === 'false') throw new Error(mutableRelease(`${repo.name}: its newest GitHub release is not immutable`));
  }
}

const mutableRelease = (what: string): string =>
  `${what} — enable immutable releases on the plexus-ms organisation (Settings → General → Releases); existing releases stay as they are (never delete one: a deleted immutable release burns its number)`;

async function release(ctx: Context, train: Train, next: string, today: string, wait: PublishWait): Promise<void> {
  ctx.say(`→ train ${train.last ?? 'none'} → ${next}`);
  for (const repo of train.repos) {
    if (repo.pending.length === 0) ctx.say(`  ${repo.name}: no changes since ${repo.latest} — tag only`);
    else {
      ctx.say(`  ${repo.name} (since ${repo.latest ?? 'the beginning'}):`);
      for (const line of repo.pending.slice(0, PENDING_SHOWN)) ctx.say(`    ${line}`);
      if (repo.pending.length > PENDING_SHOWN) ctx.say(`    … and ${repo.pending.length - PENDING_SHOWN} more`);
    }
  }
  if (!(await ctx.confirm(`tag all ${train.repos.length} repos as ${next}, release them and push?`)))
    throw new Error('aborted');

  const [one = [], two = []] = phasesOf(train);
  try {
    await releasePhase(ctx, train, one, next, today);
    await awaitPublished(ctx, next, wait);
    await releasePhase(ctx, train, two, next, today);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n✗ ship stopped during the release; re-run with --train ${next} to finish it (tagged repos and existing releases are skipped; if the registry already has ${next}, update plx first: it is the same code, built from the commit phase one tagged)`,
    );
  }
}

/** A repo never tagged lists its whole history as pending; this many lines of it are shown. */
const PENDING_SHOWN = 20;

/** One phase: the bookkeeping of its repos, then each tagged, pushed and released. */
async function releasePhase(ctx: Context, train: Train, repos: TrainRepo[], next: string, today: string) {
  ctx.say(`→ phase: ${repos.map((r) => r.name).join(', ')}`);
  await ctx.apply(await planBookkeeping(ctx, train, repos, next, today));
  for (const repo of repos) await tagAndRelease(ctx, repo, next);
}

async function tagAndRelease(ctx: Context, repo: TrainRepo, next: string): Promise<void> {
  const tagged = await ctx
    .read('git', ['rev-parse', '-q', '--verify', `refs/tags/${next}`], { cwd: repo.path })
    .then(() => true)
    .catch(() => false);
  if (tagged) ctx.say(`• ${repo.name}: already tagged ${next}`);
  else await ctx.apply([run('git', ['tag', '-a', next, '-m', `train ${next}`], { cwd: repo.path })]);
  await ctx.apply([run('git', ['push', 'origin', 'main', next], { cwd: repo.path })]);

  // The GitHub release is what makes the tag immutable, and on primitives it
  // is what triggers the publish: nothing is ever published from a tag that
  // can still move. --verify-tag refuses to create a tag of its own.
  const released = await ctx
    .read('gh', ['release', 'view', next], { cwd: repo.path })
    .then(() => true)
    .catch(() => false);
  if (released) {
    ctx.say(`• ${repo.name}: release ${next} exists`);
    return;
  }
  await ctx.apply([
    run('gh', ['release', 'create', next, '--verify-tag', '--generate-notes', '--title', next], { cwd: repo.path }),
  ]);
  if (ctx.dryRun) return;
  const immutable = (
    await ctx.read('gh', ['api', `repos/{owner}/{repo}/releases/tags/${next}`, '--jq', '.immutable'], {
      cwd: repo.path,
    })
  ).trim();
  if (immutable !== 'true')
    throw new Error(mutableRelease(`${repo.name}: release ${next} was created mutable, and its tag can still move`));
}

/**
 * Between the phases: primitives' release workflow publishes the three
 * train-versioned packages, and phase two pins them. Polled with the same
 * question an operator would ask (`npm view <name>@<train> version`); the dry
 * run names the wait and moves on.
 */
async function awaitPublished(ctx: Context, next: string, wait: PublishWait): Promise<void> {
  const names: string[] = TRAIN_PACKAGES.map((p) => p.name);
  const list = names.map((n) => `${n}@${next}`).join(', ');
  if (ctx.dryRun) {
    ctx.say(`⏳ [dry-run] would wait for ${list} on npm (${PRIMITIVES}' release workflow publishes them)`);
    return;
  }
  ctx.say(`⏳ waiting for ${list} on npm (${PRIMITIVES}' release workflow publishes them)`);
  const started = Date.now();
  let missing = [...names];
  for (;;) {
    const still: string[] = [];
    for (const name of missing) {
      const seen = (await ctx.read('npm', ['view', `${name}@${next}`, 'version']).catch(() => '')).trim();
      if (seen !== next) still.push(name);
    }
    missing = still;
    if (missing.length === 0) break;
    if (Date.now() - started >= wait.timeout)
      throw new Error(
        `${missing.join(', ')} not on npm at ${next} after ${Math.round(wait.timeout / 60_000)} min — check the release workflow (gh run list -R plexus-ms/${PRIMITIVES})`,
      );
    await new Promise((resolve) => setTimeout(resolve, wait.interval));
  }
  ctx.say(`  ✓ ${list} on npm`);
}

/** The bookkeeping writes of the given repos, then one commit per repo that has any. */
async function planBookkeeping(
  ctx: Context,
  train: Train,
  repos: TrainRepo[],
  next: string,
  today: string,
): Promise<Plan> {
  const plan: Plan = [];
  const touched = new Set<TrainRepo>();
  const repo = (name: string): TrainRepo | undefined => repos.find((r) => r.name === name);
  /** Plan a write when the transform changes the file, saying what it does; a missing file is left alone. */
  const edit = async (r: TrainRepo, rel: string, what: string, transform: (text: string) => string): Promise<void> => {
    const path = join(r.path, rel);
    const text = await ctx.readFile(path).catch(() => undefined);
    if (text === undefined) return;
    const edited = transform(text);
    if (edited === text) return;
    ctx.say(`  ${r.name}: ${rel}: ${what}`);
    plan.push(write(path, edited));
    touched.add(r);
  };
  /** The tracked files of a repo containing a string, by pathspec. */
  const grep = async (r: TrainRepo, needle: string, pathspecs: string[]): Promise<string[]> =>
    (await ctx.read('git', ['grep', '-l', needle, '--', ...pathspecs], { cwd: r.path }).catch(() => ''))
      .split('\n')
      .filter(Boolean);

  const primitives = repo(PRIMITIVES);
  if (primitives) {
    await edit(primitives, 'ansible/galaxy.yml', `version → ${next}`, (t) => bumpGalaxyVersion(t, next));
    for (const p of TRAIN_PACKAGES)
      await edit(primitives, `${p.dir}/package.json`, `${p.name} → ${next}`, (t) => bumpManifestVersion(t, next));
  }
  // Only the plexus.platform collection's pin: a second collection in the same file stays untouched.
  const platformPreset = repo('preset-repo-platform');
  if (platformPreset)
    await edit(platformPreset, 'template/requirements.yml', `plexus.platform pin → ${next}`, (t) =>
      bumpCollectionPin(t, next),
    );
  for (const r of repos) {
    for (const f of await grep(r, WORKFLOW_REF, ['*.yml', '*.yaml', '*.jinja']))
      await edit(r, f, `workflow refs → @${next}`, (t) => bumpWorkflowRefs(t, next));
    for (const f of await grep(r, PLX_PIN, ['*.toml', '*.toml.jinja']))
      await edit(r, f, `plx pin → ${next}`, (t) => bumpPlxPin(t, next));
    for (const f of await grep(r, `"${CONFIG_PIN}"`, ['*package.json', '*package.json.jinja']))
      await edit(r, f, `${CONFIG_PIN} pin → ${next}`, (t) => bumpConfigPin(t, next));
  }

  // The map carries the train version and the date it was cut (§ 1.5 PLX); a
  // standard module is stamped `changed` when its extracted requirement lines
  // differ from the previous train's, read with the same extractor the
  // compendium's check runs, so the two never disagree.
  const comp = repo('compendium');
  if (comp) {
    await edit(comp, MAP_PAGE, `version → ${next}, timestamp → ${today}`, (t) => stampStandard(t, next, today));
    for (const page of await modulePages(ctx, comp.path)) {
      const text = await ctx.readFile(join(comp.path, page));
      if (frontmatterField(text, 'maturity') !== 'standard') continue;
      const previous = comp.tag
        ? await ctx.read('git', ['show', `${comp.tag}:${page}`], { cwd: comp.path }).catch(() => '')
        : '';
      if (extractRequirements(text).join('\n') === extractRequirements(previous).join('\n')) continue;
      await edit(comp, page, `requirements changed since ${comp.latest ?? 'the beginning'} → changed: ${next}`, (t) =>
        stampChanged(t, next),
      );
    }
  }

  for (const r of train.repos) {
    if (!touched.has(r)) continue;
    plan.push(run('git', ['add', '-A'], { cwd: r.path }));
    plan.push(run('git', ['commit', '--quiet', '-m', `chore: train ${next} bookkeeping`], { cwd: r.path }));
  }
  return plan;
}
