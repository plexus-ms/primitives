// plx update [dir]: this repo takes the train (§ 3 PLX-Updates), as the same
// pull request `ship` opens from the maintainers' workspace: copier update at
// every site, the marker, the lockfile, the workflow refs, on `plexus/<version>`.
// Mounted by the presets' update.yml on a schedule in the tenant's own CI, and
// run by hand from a checkout otherwise; the checkout itself is never touched.
//
//   plx update                      # to the newest train
//   plx -n update                   # preview in a worktree, push nothing
//   plx -y update --train 0.102.0   # unattended (CI): copier takes defaults
import { resolve } from 'node:path';
import { isClean, update } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';
import { renderSummary } from './ship.ts';

export function register(program: Command): void {
  program
    .command('update')
    .description(
      'bring this repo up to a train, as a pull request on plexus/<version>: copier update at every site, the marker, the lockfile, the workflow refs',
    )
    .argument('[dir]', 'a repo generated from the presets', '.')
    .option('--train <version>', "the train to take (default: the preset's newest release)")
    .action(async (dir: string, opts: { train?: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await update(ctx, { repo: resolve(dir), train: opts.train });
      ctx.result(result, (r) => renderSummary(r, `plx -y update --train ${r.train} ${dir}`, 'update'));
      if (!isClean(result)) process.exitCode = 1;
    });
}
