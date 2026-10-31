// plx deploy-targets [inventory]: where the deploy verb reaches each app a
// platform repo operates (§ 3 PLX-Platform), as one JSON object.
//
// lib's `readDeployTargets` does the work; this file maps the argument and
// prints the map, the same JSON with or without --json, since the mount
// indexes it per matrix leg.
//
//   plx deploy-targets                    # in a platform repo's root
//   plx deploy-targets path/to/inventory
import { resolve } from 'node:path';
import { readDeployTargets } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  program
    .command('deploy-targets')
    .description('map each app of a platform repo to the deploy target of the inventory file that declares it')
    .argument('[inventory]', 'the inventory directory', 'inventory')
    .action(async (inventory: string, _opts: unknown, command: Command) => {
      const ctx = contextOf(command);
      const targets = await readDeployTargets(ctx, resolve(inventory));
      ctx.result(targets, (t) => JSON.stringify(t));
    });
}
