// plx requirements [dir]: the compendium's requirements check (§ 1.8 PLX).
//
// Lint the map and every module page, or print one module's requirement
// lines. lib's `checkCompendium` and `scanPage` do the work; defects are the
// result, one per line, and the exit code is 1 when there is any.
//
//   plx requirements .                         # lint; the compendium's `mise check`
//   plx requirements . --extract contracts/app.md
import { join, resolve } from 'node:path';
import { type CompendiumCheck, checkCompendium, extractRequirements } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  program
    .command('requirements')
    .description("lint the standard's map and module pages, or extract one module's requirement lines")
    .argument('[dir]', 'a checkout of the compendium', '.')
    .option('--extract <page>', "print a module page's requirement lines instead of linting (path relative to dir)")
    .action(async (dir: string, opts: { extract?: string }, command: Command) => {
      const ctx = contextOf(command);
      const compendium = resolve(dir);
      if (opts.extract) {
        ctx.result(extractRequirements(await ctx.readFile(join(compendium, opts.extract))));
        return;
      }
      const check = await checkCompendium(ctx, compendium);
      ctx.result(check, renderCheck);
      if (check.defects.length > 0) process.exitCode = 1;
    });
}

export function renderCheck(c: CompendiumCheck): string {
  if (c.defects.length > 0) return c.defects.join('\n');
  return `✓ the map, ${c.contracts} contracts and ${c.approaches} approaches are well-formed`;
}
