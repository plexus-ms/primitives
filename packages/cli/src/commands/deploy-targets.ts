// plx deploy-targets [inventory]: where the deploy verb reaches each app a
// platform repo operates, per environment (§ 3 PLX-Platform), as one JSON object.
//
// lib's `readDeployTargets` does the work; this file maps the argument and
// prints the map, the same JSON with or without --json, since the mount
// indexes it per matrix leg. `--environment` flattens it to one environment,
// app → target, which is the shape a deploy mount asks for.
//
//   plx deploy-targets                              # in a platform repo's root
//   plx deploy-targets --environment staging ../platform/inventory
//   plx deploy-targets --environment production --apps apps    # the matrix of this repo's own apps
import { resolve } from 'node:path';
import { deployLegs, readDeployTargets, targetsIn, UsageError } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  program
    .command('deploy-targets')
    .description(
      'map each app of a platform repo, per environment, to the deploy target of the inventory file that declares it',
    )
    .argument('[inventory]', 'the inventory directory', 'inventory')
    .option('-e, --environment <name>', 'one environment only, as a flat app → target map')
    .option(
      '--apps <dir>',
      'with --environment: only the apps with a directory under <dir>, as a list of {app, host} for a matrix',
    )
    .action(async (inventory: string, opts: { environment?: string; apps?: string }, command: Command) => {
      const ctx = contextOf(command);
      const targets = await readDeployTargets(ctx, resolve(inventory));
      if (opts.apps !== undefined) {
        if (!opts.environment) throw new UsageError('--apps needs --environment');
        const dirs = (await ctx.readDir(resolve(opts.apps)).catch(() => []))
          .filter((e) => e.directory)
          .map((e) => e.name);
        const { legs, without } = deployLegs(targetsIn(targets, opts.environment), dirs);
        for (const app of without) ctx.say(`${app} has no deployment in ${opts.environment}; nothing to deploy`);
        ctx.result(legs, (l) => JSON.stringify(l));
        return;
      }
      const result = opts.environment ? targetsIn(targets, opts.environment) : targets;
      ctx.result(result, (t) => JSON.stringify(t));
    });
}
