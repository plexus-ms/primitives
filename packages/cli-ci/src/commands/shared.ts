// What the commands read from the environment, in one place: the run's
// identity (set by Actions), the three answers of the repo (set by the
// reusable workflow from its inputs), the keys (from the vault, loaded by the
// job), and the clients built from them. A missing value is a usage error
// that names it.
import { type Context, UsageError } from '@plexus-ms/lib';
import type { Command } from 'commander';
import type { RunIdentity } from '../core/destroyInstances.ts';
import { Exo } from '../core/exoscale.ts';
import { GitHubRunners } from '../core/github.ts';
import { type Registry, registryOf } from '../core/registry.ts';
import { type Settings, settingsOf } from '../core/strategy.ts';

export function need(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new UsageError(`${name} is empty`);
  return v;
}

export function runIdentity(env: NodeJS.ProcessEnv = process.env): RunIdentity {
  return {
    repo: need('GITHUB_REPOSITORY', env),
    runId: need('GITHUB_RUN_ID', env),
    attempt: env.GITHUB_RUN_ATTEMPT || '1',
  };
}

export const zoneOf = (env: NodeJS.ProcessEnv = process.env): string => env.ZONE || 'de-fra-1';

export const exoOf = (ctx: Context, env: NodeJS.ProcessEnv = process.env): Exo => new Exo(ctx, zoneOf(env));

/** The runner client when RUNNER_TOKEN is set, else undefined. */
export function githubOf(ctx: Context, env: NodeJS.ProcessEnv = process.env): GitHubRunners | undefined {
  return env.RUNNER_TOKEN ? new GitHubRunners(ctx, need('GITHUB_REPOSITORY', env), env.RUNNER_TOKEN) : undefined;
}

/** The owner of the repo, the prefix of the bucket names. */
export const ownerOf = (repo: string): string => repo.split('/')[0] ?? repo;

/** The option every universal command takes; the environment answers without it. */
export function withStrategy(command: Command): Command {
  return command.option('--strategy <strategy>', 'github, on-prem or hybrid (default: CI_STRATEGY, else github)');
}

/** The repo's three answers: --strategy before CI_STRATEGY, then CI_REGISTRY and CI_OVERLAY. */
export function settings(opts: { strategy?: string }, env: NodeJS.ProcessEnv = process.env): Settings {
  return settingsOf(env, opts.strategy);
}

/** Where the published images live: IMAGE_PREFIX, else ghcr.io/<owner of GITHUB_REPOSITORY>. */
export function imagePrefix(env: NodeJS.ProcessEnv = process.env): string {
  return env.IMAGE_PREFIX || `ghcr.io/${ownerOf(need('GITHUB_REPOSITORY', env))}`;
}

/** Where the candidates live, from the settings. */
export function registryFor(s: Settings, env: NodeJS.ProcessEnv = process.env): Registry {
  return registryOf(s.registry, s.registry === 'ghcr' ? imagePrefix(env) : '');
}
