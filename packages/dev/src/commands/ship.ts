// plx-dev ship [dir]: cut the train (§ 1.5 PLX), and nothing after it.
//
// ../ship.ts does the work: preflight, bookkeeping, tags, releases, the wait
// for npm. It opens no pull request: a repo takes the train itself, when it
// needs it (`plx update`), and `plx propagate --now` asks many at once. This
// file maps the arguments and renders the outcome. -n previews the release as
// its steps and tries the unreleased presets on the workspace's consumers in
// scratch clones, with a summary; -y is required off a terminal.
//
//   plx-dev ship ~/dev                 # next train = minor+1 over the latest
//   plx-dev -n ship ~/dev              # preview, change nothing in the workspace
//   plx-dev -y ship ~/dev --train 1.0.0
//   mise ship -- -n                    # the same from primitives, built first
import { resolve } from 'node:path';
import { isClean, renderSummary } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';
import { ship } from '../ship.ts';

export function register(program: Command): void {
  program
    .command('ship')
    .description(
      'cut the train: tag and release every train repo identically; repos take it themselves (plx update, plx propagate)',
    )
    .argument('[dir]', 'the workspace: plexus-ms/ sits under it, and the consumers the dry run previews', '.')
    .option('--train <version>', 'the train version, plain semver (default: minor+1 over the latest train)')
    .action(async (dir: string, opts: { train?: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await ship(ctx, { workspace: resolve(dir), train: opts.train });
      ctx.result(result, (r) =>
        r.preview
          ? renderSummary(r, `plx-dev -y ship --train ${r.train} ${dir}`, 'ship')
          : `✓ train ${r.train} cut — repos take it themselves; to take it now where it matters: plx propagate --now ${dir}`,
      );
      if (!isClean(result)) process.exitCode = 1;
    });
}
