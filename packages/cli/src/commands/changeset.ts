// plx changeset [dir]: the changeset a dependency bump owes (§ 5 PLX-Delivery).
//
// lib's `readChangeset` reads what the branch changed since its merge base and
// plans the one file; this file maps the arguments, applies the plan and
// prints the result: the releases owed, or that nothing is. Deterministic, so
// the bot's rebase and a rerun are no-ops; `-n` prints the file it would write.
//
//   plx changeset                              # in a package repo, on the bot's branch
//   plx changeset --base origin/main -n .
import { resolve } from 'node:path';
import { type Changeset, readChangeset } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  program
    .command('changeset')
    .description('write the changeset a dependency bump owes: a patch per package whose runtime dependencies moved')
    .argument('[dir]', 'a checkout of the package repo, on the bump branch', '.')
    .option('--base <ref>', 'the trunk the branch is diffed against, at the merge base', 'origin/main')
    .option('--branch <name>', 'the branch name that names the file (default: the checked-out branch)')
    .action(async (dir: string, opts: { base: string; branch?: string }, command: Command) => {
      const ctx = contextOf(command);
      const changeset = await readChangeset(ctx, resolve(dir), opts.base, opts.branch);
      await ctx.apply(changeset.plan);
      ctx.result(changeset, renderChangeset);
    });
}

export function renderChangeset(c: Changeset): string {
  const releases = Object.entries(c.releases);
  if (releases.length === 0) return `✓ nothing owed; no ${c.path}`;
  return [`✓ ${c.path}`, ...releases.map(([name, bump]) => `  ${name}: ${bump}`)].join('\n');
}
