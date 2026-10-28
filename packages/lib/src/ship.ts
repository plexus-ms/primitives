// ship: the release train (§ 1.5 PLX). Every train repo ships under ONE
// version, tagged identically whether or not it changed:
//
//   preflight (every train repo on main, clean, not behind origin, the latest
//   tags in agreement) → write the train bookkeeping (bookkeeping.ts: galaxy
//   version, the preset's collection pin, workflow-ref examples, the map's
//   version and timestamp, `changed` on every standard module whose extracted
//   requirements moved) and commit it → tag every train repo → push →
//   propagate to every consumer (propagate.ts).
//
// Substance commits stay human; ship writes only the mechanical bookkeeping.
// A failure between the first tag and the last push leaves a half-tagged
// train; the recovery is a re-run naming the same version, which skips the
// repos already tagged and pushes the rest.
//
//   plx ship ~/dev                    # next train = minor+1 over the latest
//   plx ship ~/dev --train 1.0.0      # explicit train version
//   plx -n ship ~/dev                 # preview: list the bookkeeping, tags and
//                                     # the propagation in scratch clones
//   plx -y ship ~/dev                 # unattended: no prompt, copier takes defaults
import { join } from 'node:path';
import {
  bumpCollectionPin,
  bumpGalaxyVersion,
  bumpWorkflowRefs,
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
import { preflightRelease, readTrain, resolveVersion, type Train, type TrainRepo, UPSTREAM } from './train.ts';

export interface ShipOptions {
  /** The workspace: the upstream umbrella and the consumers sit under it. */
  workspace: string;
  /** The train version; default: minor+1 over the latest, or the current one when only propagating. */
  train?: string;
  /** Skip the release; only propagate to the consumers. */
  propagateOnly?: boolean;
  /** The date stamped on the map, `YYYY-MM-DD`; default: today. */
  today?: string;
}

export interface ShipResult extends Summary {
  /** The version released, or already current when only propagating. */
  released: boolean;
}

export async function ship(ctx: Context, options: ShipOptions): Promise<ShipResult> {
  const upstream = join(options.workspace, UPSTREAM);
  const propagateOnly = options.propagateOnly ?? false;
  const train = await readTrain(ctx, upstream);
  if (!propagateOnly) await preflightRelease(ctx, train);
  const next = resolveVersion(train, options.train, propagateOnly);
  if (!propagateOnly) await release(ctx, train, next, options.today ?? todayOf());
  const summary = await propagate(ctx, options.workspace, next);
  return { ...summary, released: !propagateOnly };
}

async function release(ctx: Context, train: Train, next: string, today: string): Promise<void> {
  ctx.say(`→ train ${train.last ?? 'none'} → ${next}`);
  for (const repo of train.repos) {
    if (repo.pending.length === 0) ctx.say(`  ${repo.name}: no changes since ${repo.latest} — tag only`);
    else {
      ctx.say(`  ${repo.name} (since ${repo.latest ?? 'the beginning'}):`);
      for (const line of repo.pending) ctx.say(`    ${line}`);
    }
  }
  if (!(await ctx.confirm(`tag all ${train.repos.length} repos as ${next} and push?`))) throw new Error('aborted');

  try {
    const plan = await planBookkeeping(ctx, train, next, today);
    await ctx.apply(plan);
    for (const repo of train.repos) {
      const tagged = await ctx
        .read('git', ['rev-parse', '-q', '--verify', `refs/tags/${next}`], { cwd: repo.path })
        .then(() => true)
        .catch(() => false);
      if (tagged) ctx.say(`• ${repo.name}: already tagged ${next}`);
      else await ctx.apply([run('git', ['tag', '-a', next, '-m', `train ${next}`], { cwd: repo.path })]);
      await ctx.apply([run('git', ['push', 'origin', 'main', next], { cwd: repo.path })]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}\n✗ ship stopped during the release; re-run with --train ${next} to finish it (tagged repos are skipped)`,
    );
  }
}

/** The bookkeeping writes, then one commit per train repo that has any. */
async function planBookkeeping(ctx: Context, train: Train, next: string, today: string): Promise<Plan> {
  const plan: Plan = [];
  const touched = new Set<TrainRepo>();
  const repo = (name: string): TrainRepo => {
    const r = train.repos.find((r) => r.name === name);
    if (!r) throw new Error(`${name} is not a train repo`);
    return r;
  };
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

  await edit(repo('platform'), 'ansible/galaxy.yml', `version → ${next}`, (t) => bumpGalaxyVersion(t, next));
  // Only the plexus.platform collection's pin: a second collection in the same file stays untouched.
  await edit(repo('preset-repo-platform'), 'template/requirements.yml', `plexus.platform pin → ${next}`, (t) =>
    bumpCollectionPin(t, next),
  );
  for (const r of train.repos) {
    const files = await ctx
      .read('git', ['grep', '-l', WORKFLOW_REF, '--', '*.yml', '*.yaml', '*.jinja'], { cwd: r.path })
      .catch(() => '');
    for (const f of files.split('\n').filter(Boolean))
      await edit(r, f, `ci-cd refs → @${next}`, (t) => bumpWorkflowRefs(t, next));
  }

  // The map carries the train version and the date it was cut (§ 1.5 PLX); a
  // standard module is stamped `changed` when its extracted requirement lines
  // differ from the previous train's, read with the same extractor the
  // compendium's check runs, so the two never disagree.
  const comp = repo('compendium');
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

  for (const r of train.repos) {
    if (!touched.has(r)) continue;
    plan.push(run('git', ['add', '-A'], { cwd: r.path }));
    plan.push(run('git', ['commit', '--quiet', '-m', `chore: train ${next} bookkeeping`], { cwd: r.path }));
  }
  return plan;
}
