// plx changed-apps <from> [to]: the deployable apps whose sources changed
// between two refs, dependents included (§ 3 PLX-Delivery).
//
// lib's `readChangedApps` does the work; this file maps the arguments and
// prints one app dir name per line, or a JSON array under --json, for the
// mount's matrix. Empty when nothing changed.
//
//   plx changed-apps "$(git rev-parse HEAD~1)"       # in the repo's root
//   plx --json changed-apps <before-sha> <sha> .
import { resolve } from 'node:path';
import { readChangedApps } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  program
    .command('changed-apps')
    .description('list the apps whose sources changed between two refs, dependents of a changed package included')
    .argument('<from>', 'the base ref; empty, all zeros or unknown lists every app')
    .argument('[to]', 'the ref compared against', 'HEAD')
    .option('-C, --dir <dir>', 'the checkout to read', '.')
    .action(async (from: string, to: string, opts: { dir: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await readChangedApps(ctx, resolve(opts.dir), from, to);
      ctx.result(result.apps);
    });
}
