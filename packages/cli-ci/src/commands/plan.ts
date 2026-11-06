// plx-ci plan [--test] [--deploy] [apps...]: the hashes and the look-ups
// (§ 8 PLX-Delivery), printed as the matrices the build and the test jobs fan
// out over, each leg naming its runner from the strategy, and the apps with
// their hashes for the publish. With --deploy, the environment the run
// releases into and each app's target there, from a checkout of the platform
// repo's inventory. Launches nothing: under hybrid, `plx-ci hybrid
// create-instances` reads the matrices next. Writes matrix=, tests=, apps=,
// deploys=, environment= and overlay-join= to GITHUB_OUTPUT when that is set.
// From the environment: CI_STRATEGY, CI_REGISTRY, CI_OVERLAY; GITHUB_RUN_ID
// and GITHUB_RUN_ATTEMPT (they name the instances under hybrid); for
// --deploy GITHUB_EVENT_NAME, GITHUB_REF_NAME, GITHUB_SHA and IMAGE_PREFIX.
//
//   plx-ci --json plan --test
//   plx-ci plan --test --deploy --inventory platform/inventory
//   plx-ci plan --mode repro website
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readDeployTargets, targetsIn } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { environmentOf, type Mode, plan, readHashes } from '../core/plan.ts';
import { joinsOverlay } from '../core/strategy.ts';
import { contextOf } from '../program.ts';
import { imagePrefix, need, registryFor, settings, withStrategy } from './shared.ts';

interface Opts {
  strategy?: string;
  mode: Mode;
  test?: boolean;
  deploy?: boolean;
  environment?: string;
  inventory: string;
  dir: string;
}

export function register(program: Command): void {
  withStrategy(program.command('plan'))
    .description(
      'compute the build and test hashes, look them up in the registry, and print the builds, tests and deploys the run needs',
    )
    .argument('[apps...]', 'the apps (default: every directory under apps/)')
    .option(
      '--mode <mode>',
      'build (skip what the registry holds), force (build all), repro (two no-cache builds per app)',
      'build',
    )
    .option('--test', 'plan the tests too, for the apps with a test task')
    .option('--deploy', 'plan the deploys too: the environment and each app’s target in it')
    .option('--environment <name>', 'the environment to release into (default: from the branch, main or develop)')
    .option('--inventory <dir>', 'the platform repo’s inventory, for --deploy', 'platform/inventory')
    .option('-C, --dir <dir>', 'the checkout to read', '.')
    .action(async (apps: string[], opts: Opts, command: Command) => {
      const ctx = contextOf(command);
      const s = settings(opts);
      const dir = resolve(opts.dir);
      const env = process.env;
      const all =
        apps.length > 0
          ? apps
          : (await ctx.readDir(`${dir}/apps`))
              .filter((e) => e.directory)
              .map((e) => e.name)
              .sort();
      const environment = opts.deploy
        ? environmentOf(env.GITHUB_EVENT_NAME ?? '', env.GITHUB_REF_NAME ?? '', opts.environment)
        : '';
      const result = await plan(ctx, {
        apps: all,
        mode: opts.mode,
        tests: opts.test ?? false,
        hashes: await readHashes(ctx, dir, all),
        strategy: s.strategy,
        registry: registryFor(s),
        // Only hybrid names anything after the run: its instances.
        run:
          s.strategy === 'hybrid'
            ? { runId: need('GITHUB_RUN_ID'), attempt: env.GITHUB_RUN_ATTEMPT || '1' }
            : { runId: env.GITHUB_RUN_ID || '0', attempt: env.GITHUB_RUN_ATTEMPT || '1' },
        deploy: environment
          ? {
              environment,
              targets: targetsIn(await readDeployTargets(ctx, resolve(opts.inventory)), environment),
              prefix: imagePrefix(),
              sha: need('GITHUB_SHA'),
            }
          : undefined,
      });
      ctx.result(result, (r) =>
        [
          ...r.legs.map((l) => `build ${l.app} ${l.hash} ${l.runner}`),
          ...r.tests.map((l) => `test ${l.app} ${l.hash} ${l.runner}`),
          ...r.deploys.map((l) => `deploy ${l.app} ${l.host} ${l.image}`),
        ].join('\n'),
      );
      if (env.GITHUB_OUTPUT)
        appendFileSync(
          env.GITHUB_OUTPUT,
          [
            `matrix=${JSON.stringify(result.legs)}`,
            `tests=${JSON.stringify(result.tests)}`,
            `apps=${JSON.stringify(result.apps)}`,
            `deploys=${JSON.stringify(result.deploys)}`,
            `environment=${result.environment}`,
            `overlay-join=${joinsOverlay(s)}`,
            '',
          ].join('\n'),
        );
    });
}
