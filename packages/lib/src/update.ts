// update: a repo generated from the presets takes the train itself (§ 3
// PLX-Updates), from inside the repo: the same pull request `propagate` opens
// from the maintainers' workspace, opened by the tenant's own CI or by hand.
//
// The newest train is the preset's newest GitHub release (every train tag is
// locked by one, § 1.6 PLX), asked of the forge as an operator would
// (`gh api repos/plexus-ms/<preset>/releases/latest`). The work happens in a
// worktree of origin's branch, never in the checkout: a developer's branch and
// edits stay as they are, and in CI the worktree shares the checkout's
// credentials, so the push and the pull request need no second token. Then
// `takeTrain` (propagate.ts): copier update at every site, marker, lockfile,
// workflow refs, one commit on `train/<version>`, one pull request.
//
// The train is pulled once per repo: a `train/<version>` branch already on
// origin, from an earlier run, from `plx ship`, or from a human resolving its
// conflicts, is left alone, so a daily run never moves a branch somebody is
// working on; deleting the branch is how a pull is redone. A repo whose every
// site already records the train does nothing at all.
//
//   plx update                      # this repo, to the newest train
//   plx -n update                   # preview in a worktree, push nothing
//   plx -y update --train 0.102.0   # unattended, an explicit train
import { basename, join } from 'node:path';
import { findConsumers, presetSource } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, parseAnswers } from './copier.ts';
import { compareTrains } from './doctor.ts';
import { overview } from './overview.ts';
import { run } from './plan.ts';
import { detail, emptySummary, openPullUrl, type Summary, takeTrain, trainBranch } from './propagate.ts';
import { isTrainVersion, preflightForge, TRAIN_REPOS, UsageError } from './train.ts';

/** The train repos that are templates: what a repo can be generated from. */
export const PRESETS: readonly string[] = TRAIN_REPOS.filter((r) => r.startsWith('preset-'));

export interface UpdateOptions {
  /** The repo to update: a checkout whose root is a site of a repo preset. */
  repo: string;
  /** The train to take; default: the preset's newest release. */
  train?: string;
}

export async function update(ctx: Context, options: UpdateOptions): Promise<Summary> {
  const { repo } = options;
  const name = basename(repo);
  if (options.train !== undefined && !isTrainVersion(options.train))
    throw new UsageError(`'${options.train}' is not plain semver (X.Y.Z, no v)`);

  const tree = await overview(ctx, repo);
  const consumer = (await findConsumers(ctx, tree, PRESETS)).find((c) => c.path === tree.path);
  if (!consumer)
    throw new Error(
      `${repo} is not a repo generated from the presets: no ${ANSWERS_FILE} at its root naming one of ${PRESETS.map(presetSource).join(', ')}`,
    );
  if (consumer.skipped) throw new Error(`${name}: ${consumer.skipped}`);
  // Sites are named from the repo, not from a workspace.
  consumer.rel = name;
  for (const s of consumer.sites) s.rel = s.rel === '.' ? name : join(name, s.rel);
  const root = consumer.sites.find((s) => s.path === consumer.path);
  if (!root) throw new Error(`${name}: its root is not a site of a repo preset`);

  await preflightForge(ctx);
  const train = options.train ?? (await newestTrain(ctx, root.preset));
  const summary = emptySummary(train, ctx.dryRun);

  const recorded = await Promise.all(
    consumer.sites.map(async (s) => parseAnswers(await ctx.readFile(join(s.path, ANSWERS_FILE))).commit),
  );
  if (recorded.every((c) => c === train)) {
    ctx.say(`• ${name}: already at ${train}`);
    return summary;
  }
  // copier refuses a downgrade; say so before a worktree is made for nothing.
  const past = recorded.find((c) => c && isTrainVersion(c) && compareTrains(c, train) > 0);
  if (past) throw new Error(`${name} is at ${past}, past ${train}; a repo is never taken back to an older train`);

  const branch = trainBranch(train);
  const onOrigin = await ctx
    .read('git', ['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], { cwd: repo })
    .then(() => true)
    .catch(() => false);
  if (onOrigin) {
    const url = await openPullUrl(ctx, consumer, repo, train);
    ctx.say(
      `• ${name}: ${branch} is already on origin${url ? ` (${url})` : ''} — nothing to do; delete the branch to pull the train again`,
    );
    if (url) summary.pulls.push(url);
    return summary;
  }

  const scratch = (await ctx.stage(run('mktemp', ['-d'])))?.trim() ?? '';
  const dir = join(scratch, name);
  try {
    ctx.say(`→ ${name}: worktree of origin/${consumer.branch}`);
    try {
      await ctx.stage(run('git', ['fetch', '--quiet', 'origin', consumer.branch], { cwd: repo }));
      await ctx.stage(
        run('git', ['worktree', 'add', '--quiet', '--detach', dir, `origin/${consumer.branch}`], { cwd: repo }),
      );
    } catch (error) {
      ctx.say(`  ✗ FAILED — worktree of origin/${consumer.branch}${detail(error)}`);
      summary.failed.push(name);
      return summary;
    }
    await takeTrain(ctx, consumer, dir, { train, ref: train, opener: '`plx update`' }, summary);
  } finally {
    await ctx.stage(run('git', ['worktree', 'remove', '--force', dir], { cwd: repo })).catch(() => undefined);
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
  return summary;
}

/** The preset's newest release names the newest train (§ 1.6 PLX: every train tag has one). */
async function newestTrain(ctx: Context, preset: string): Promise<string> {
  const source = presetSource(preset).replace(/^gh:/, '');
  const tag = (
    await ctx.read('gh', ['api', `repos/${source}/releases/latest`, '--jq', '.tag_name']).catch(() => '')
  ).trim();
  if (!tag) throw new Error(`no release of ${source} found — pass the train explicitly (--train <version>)`);
  if (!isTrainVersion(tag)) throw new Error(`the newest release of ${source} is '${tag}', not a train`);
  return tag;
}
