// propagate: `update` in every repo generated from the presets under a
// directory (§ 3 PLX-Updates). The operator's convenience over the verb, for
// whoever has many repos checked out side by side, the maintainers or a
// tenant's own operator: it needs no checkout of the upstream, reads the
// published trains like `update` does, and obeys the same triggers. A repo
// that needs no train rests; `now` or a named train asks for every repo at
// once, which is how a hotfix reaches the repos that need it.
//
// Each repo is handled by `update` (update.ts) in a worktree of the branch the
// train lands on, so the checkouts stay as they are. Nothing aborts the run: a
// repo that fails is recorded and the rest continues; the summary says what
// rests, what is clean, conflicted or failed, and the pull requests.
//
//   plx propagate ~/dev                  # every repo that needs the newest train
//   plx propagate ~/dev --now            # every repo, whatever its triggers say
//   plx -n propagate ~/dev --now         # preview in worktrees, push nothing
//   plx -y propagate ~/dev --train 0.66.0
import { findConsumers, PRESETS, presetSource } from './consumers.ts';
import type { Context } from './context.ts';
import { overview } from './overview.ts';
import { detail, emptySummary, mergeSummary, type Summary } from './take.ts';
import { isTrainVersion, UsageError } from './train.ts';
import { update } from './update.ts';

export interface PropagateOptions {
  /** The directory the repos sit under, at any depth. */
  dir: string;
  /** The train every repo takes, which is asking for it; default: each preset's newest release. */
  train?: string;
  /** Take the newest train whatever the triggers say. */
  now?: boolean;
  /** The backstop age in days for every repo; default: each repo's own answer, else 30. */
  maxAge?: number;
  /** The clock the backstop is measured against, as a date; default: now. */
  today?: string;
}

export async function propagate(ctx: Context, options: PropagateOptions): Promise<Summary> {
  const { dir, ...rest } = options;
  if (options.train !== undefined && !isTrainVersion(options.train))
    throw new UsageError(`'${options.train}' is not plain semver (X.Y.Z, no v)`);
  const summary = emptySummary(options.train ?? '', ctx.dryRun);
  const consumers = await findConsumers(ctx, await overview(ctx, dir), PRESETS);
  if (consumers.length === 0)
    ctx.say(`• no repo generated from ${PRESETS.map(presetSource).join(', ')} found under ${dir}`);
  for (const consumer of consumers) {
    if (consumer.skipped) {
      ctx.say(`⚠ ${consumer.rel}: ${consumer.skipped} — skipped (fix it, then re-run propagate)`);
      summary.skipped.push({ path: consumer.rel, reason: consumer.skipped });
      continue;
    }
    try {
      const one = await update(ctx, { repo: consumer.path, name: consumer.rel, ...rest });
      mergeSummary(summary, one);
      summary.train ||= one.train;
    } catch (error) {
      ctx.say(`  ✗ FAILED — ${consumer.rel}${detail(error)}`);
      summary.failed.push(consumer.rel);
    }
  }
  return summary;
}
