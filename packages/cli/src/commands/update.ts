// plx update [dir]: this repo takes the train when it needs one (§ 3
// PLX-Updates), as a pull request on `plexus/<version>`: copier update at every
// site, the marker, the lockfile, the workflow refs. It needs one when it is
// asked (--now, or --train) or when the oldest train it has not taken is older
// than the backstop age; otherwise it rests and says why. Mounted by the
// presets' update.yml on a schedule in the tenant's own CI, and run by hand
// from a checkout otherwise; the checkout itself is never touched.
//
//   plx update                      # the newest train, if the repo needs it
//   plx update --now                # the newest train, whatever its triggers say
//   plx -n update --now             # preview in a worktree, push nothing
//   plx -y update --train 0.102.0   # unattended (CI): copier takes defaults
import { resolve } from 'node:path';
import { isClean, parseMaxAge, update } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';
import { renderSummary } from './ship.ts';

export function register(program: Command): void {
  program
    .command('update')
    .description(
      'bring this repo up to the newest train when it needs it (asked, or past the backstop age), as a pull request on plexus/<version>: copier update at every site, the marker, the lockfile, the workflow refs',
    )
    .argument('[dir]', 'a repo generated from the presets', '.')
    .option('--train <version>', "the train to take, whatever the triggers say (default: the preset's newest release)")
    .option('--now', 'take the newest train whatever the triggers say')
    .option(
      '--max-age <days>',
      "the backstop: take the newest train once the oldest one not taken is this old (default: the repo's answer update_max_age, else 30; 0 takes every train)",
      (v: string) => parseMaxAge(v, '--max-age'),
    )
    .action(async (dir: string, opts: { train?: string; now?: boolean; maxAge?: number }, command: Command) => {
      const ctx = contextOf(command);
      const result = await update(ctx, { repo: resolve(dir), train: opts.train, now: opts.now, maxAge: opts.maxAge });
      ctx.result(result, (r) => renderSummary(r, `plx -y update --train ${r.train} ${dir}`, 'update'));
      if (!isClean(result)) process.exitCode = 1;
    });
}
