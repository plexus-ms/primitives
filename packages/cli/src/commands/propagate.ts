// plx propagate [dir]: copier-update every consumer of the presets to the
// current train, without releasing one (§ 3 PLX-Updates). What `ship` runs
// after tagging, on its own: for a consumer that was skipped or failed, or a
// new consumer.
//
//   plx propagate ~/dev                   # to the current train
//   plx -n propagate ~/dev                # preview in scratch clones
//   plx -y propagate ~/dev --train 0.66.0 # unattended: copier takes defaults
import { resolve } from 'node:path';
import { isClean, ship } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf, version } from '../program.ts';
import { renderSummary } from './ship.ts';

export function register(program: Command): void {
  program
    .command('propagate')
    .description('copier-update every consumer of the presets to the current train, and pin their ci-cd workflow refs')
    .argument('[dir]', 'the workspace: plexus-ms/ and the consumers sit under it', '.')
    .option('--train <version>', 'the train to propagate (default: the current one)')
    .action(async (dir: string, opts: { train?: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await ship(ctx, { workspace: resolve(dir), train: opts.train, propagateOnly: true, plx: version });
      ctx.result(result, (r) => renderSummary(r, `plx -y propagate --train ${r.train} ${dir}`));
      if (!isClean(result)) process.exitCode = 1;
    });
}
