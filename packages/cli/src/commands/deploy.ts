// plx deploy <host> <tenant> <app>: launch a released artifact into an
// execution environment (§ 6 PLX-Delivery), from a checkout of the app's
// source repo.
//
// lib's `deploy` does the work; this file maps the arguments and prints the
// live image. Exit code 1 when the app is not healthy at the end, rolled back
// or not. An empty option value is the same as an absent one, so a mount can
// always pass the flag. `-n` prints every ssh line the deploy would run.
//
//   plx deploy deploy@1.2.3.4 plexus website --image ghcr.io/org/website:<sha>
//   plx deploy deploy@1.2.3.4 plexus beszel            # third-party: image pinned in the file
import { resolve } from 'node:path';
import { type Deploy, deploy } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

interface Opts {
  image?: string;
  healthUrl?: string;
  retries: string;
  appDir?: string;
  source?: string;
  dir: string;
}

export function register(program: Command): void {
  program
    .command('deploy')
    .description(
      'render the app’s compose file with the image pinned, stage it on the host, pull, migrate, swap, up, poll readiness, roll back on failure',
    )
    .argument('<host>', 'ssh target, deploy@host')
    .argument('<tenant>', 'tenant slug, the first segment of the app dir on the host')
    .argument('<app>', 'the app, apps/<app> in the checkout')
    .option('--image <ref>', 'the image ref to pin; absent for a third-party app whose compose.yaml pins its own')
    .option(
      '--health-url <url>',
      'readiness URL polled on the host (default: /healthz, or the plexus.healthz label, on the loopback port)',
    )
    .option('--retries <n>', 'poll attempts, two seconds apart', '30')
    .option('--app-dir <path>', 'the app dir on the host (default: /opt/stacks/<tenant>/<app>)')
    .option('--source <path>', 'the app’s dir in the checkout (default: apps/<app>)')
    .option('-C, --dir <dir>', 'the checkout to read', '.')
    .action(async (host: string, tenant: string, app: string, opts: Opts, command: Command) => {
      const ctx = contextOf(command);
      const result = await deploy(ctx, {
        host,
        tenant,
        app,
        image: opts.image,
        healthUrl: opts.healthUrl,
        retries: Number(opts.retries),
        appDir: opts.appDir,
        source: opts.source,
        dir: resolve(opts.dir),
      });
      ctx.result(result, renderDeploy);
      if (!result.healthy) process.exitCode = 1;
    });
}

export function renderDeploy(d: Deploy): string {
  if (d.healthy) return d.live ?? '';
  return d.rolledBack ? `rolled back to ${d.live ?? 'the previous compose.yaml'}` : 'not healthy';
}
