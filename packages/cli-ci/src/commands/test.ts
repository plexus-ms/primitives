// plx-ci test <app> <build-hash> <test-hash>: the app's compose stack with the
// candidate image from the registry, migrate, up, the app's test script against
// it, and on success the tag test-<hash> (§ 8 PLX-Delivery). Runs on a large
// runner in a checkout with the app's dependencies installed. From the
// environment: CI_STRATEGY, CI_REGISTRY; PLEXUS_LOOPBACK_PORT (default 3000), the port the stack
// publishes the app on. Prints the tested digest, and writes it to
// GITHUB_OUTPUT when that is set.
//
//   plx-ci test vernier-app d135e9416e1cf4e8 5b052598a4d84145
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { test } from '../core/test.ts';
import { contextOf } from '../program.ts';
import { registryFor, settings, withStrategy } from './shared.ts';

export function register(program: Command): void {
  withStrategy(program.command('test'))
    .description('run one app’s tests against its compose stack on the candidate image, and tag the image tested')
    .argument('<app>', 'the app, apps/<app> in the checkout')
    .argument('<build>', 'Turbo’s hash of the app’s build task, the candidate’s tag')
    .argument('<hash>', 'Turbo’s hash of the app’s test task, the tag on success')
    .option('-C, --dir <dir>', 'the checkout to read', '.')
    .action(
      async (app: string, build: string, hash: string, opts: { strategy?: string; dir: string }, command: Command) => {
        const ctx = contextOf(command);
        const result = await test(ctx, {
          app,
          build,
          hash,
          dir: resolve(opts.dir),
          registry: registryFor(settings(opts)),
          port: process.env.PLEXUS_LOOPBACK_PORT ? Number(process.env.PLEXUS_LOOPBACK_PORT) : undefined,
        });
        ctx.result(result, (r) => r.digest ?? '');
        if (process.env.GITHUB_OUTPUT && result.digest)
          appendFileSync(process.env.GITHUB_OUTPUT, `digest=${result.digest}\n`);
      },
    );
}
