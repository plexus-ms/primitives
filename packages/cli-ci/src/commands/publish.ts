// plx-ci publish <app> <build-hash> <sha> [--test <test-hash>]: put the tested
// image under its commit in the registry production pulls from: copied from
// the sidecar, or tagged where it is there already (§ 8 PLX-Delivery). Needs
// the registry reachable here (`plx-ci registry`) and crane on the PATH,
// logged in to the forge's registry. From the environment: CI_STRATEGY,
// CI_REGISTRY; IMAGE_PREFIX, where the images live (default ghcr.io/<owner
// of GITHUB_REPOSITORY>). Prints the image, and writes image= to
// GITHUB_OUTPUT when that is set.
//
//   plx-ci publish website 0f2a3f35123dfd73 "$GITHUB_SHA"
//   plx-ci publish vernier-app d135e9416e1cf4e8 "$GITHUB_SHA" --test 5b052598a4d84145
import { appendFileSync } from 'node:fs';
import type { Command } from 'commander';
import { publish } from '../core/publish.ts';
import { contextOf } from '../program.ts';
import { imagePrefix, registryFor, settings, withStrategy } from './shared.ts';

export function register(program: Command): void {
  withStrategy(program.command('publish'))
    .description('publish one app’s tested image as <sha> in the forge’s registry, beside build-<hash> and test-<hash>')
    .argument('<app>', 'the app')
    .argument('<build>', 'Turbo’s hash of the app’s build task')
    .argument('<sha>', 'the commit, the tag a deploy takes')
    .option('--test <hash>', 'Turbo’s hash of the app’s test task; the image is read from test-<hash>')
    .action(
      async (app: string, build: string, sha: string, opts: { strategy?: string; test?: string }, command: Command) => {
        const ctx = contextOf(command);
        const result = await publish(ctx, {
          app,
          build,
          test: opts.test || undefined,
          sha,
          prefix: imagePrefix(),
          registry: registryFor(settings(opts)),
        });
        ctx.result(result, (r) => `${r.image}:${sha}${r.copied ? '' : ' (was there)'}`);
        if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `image=${result.image}:${sha}\n`);
      },
    );
}
