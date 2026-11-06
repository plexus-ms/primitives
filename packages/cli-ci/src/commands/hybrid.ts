// plx-ci hybrid: what only the hybrid strategy needs (§ 8 PLX-Delivery), the
// throwaway instances its large jobs run on.
//
// create-instances <matrix-json> [tests-json]: one instance per build and per
// test leg of the plan, at once, each waited for until its runner is online;
// one that misses is kept, stopped and mailed about, and replaced once. From
// the environment: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT;
// RUNNER_TOKEN (Administration: write on the repo); EXOSCALE_API_KEY/_SECRET
// (ci-launch); SELF_DELETE_KEY/_SECRET; SELF_LAYERS; SMTP_* and MAIL_*,
// REGISTRY_* (optional); NO_JOB_MINUTES, DEATH_MINUTES, POWEROFF_MINUTES;
// INSTANCE_TYPE, ZONE, ONLINE_SECONDS.
//
// destroy-instances: the run's cleanup, delete what this run and attempt
// created and the registrations nothing used; kept instances are left alone.
// From the environment: the run's identity, EXOSCALE_API_KEY/_SECRET,
// RUNNER_TOKEN (optional).
//
// sweep-instances: daily, delete every instance that is stopped or past its
// deadline and mail about it; a kept one is spared, mailed about again after
// seven days and deleted after fourteen. From the environment:
// EXOSCALE_API_KEY/_SECRET; SMTP_*, MAIL_* (optional, else no mail).
//
//   plx-ci hybrid create-instances "$MATRIX" "$TESTS"
//   plx-ci hybrid destroy-instances
//   plx-ci -n hybrid sweep-instances      # lists, deletes nothing
import type { Command } from 'commander';
import { createInstances, DEFAULTS, type InstanceLeg, type LaunchOptions } from '../core/createInstances.ts';
import { destroyInstances } from '../core/destroyInstances.ts';
import { smtpFromEnv } from '../core/mail.ts';
import type { Leg, TestLeg } from '../core/plan.ts';
import { storageFromEnv } from '../core/registry.ts';
import { sweepInstances } from '../core/sweepInstances.ts';
import { contextOf } from '../program.ts';
import { exoOf, githubOf, need, runIdentity, zoneOf } from './shared.ts';

/** The launch options the environment carries; label, app and kind come from the plan's legs. */
export function launchOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Omit<LaunchOptions, 'label' | 'app' | 'kind'> {
  const minutes = (name: string) => Number(need(name, env));
  return {
    run: runIdentity(env),
    runnerToken: need('RUNNER_TOKEN', env),
    selfDelete: { key: need('SELF_DELETE_KEY', env), secret: need('SELF_DELETE_SECRET', env) },
    selfLayers: env.SELF_LAYERS === 'off' ? 'off' : 'on',
    deadlines: {
      noJobMinutes: minutes('NO_JOB_MINUTES'),
      deathMinutes: minutes('DEATH_MINUTES'),
      poweroffMinutes: minutes('POWEROFF_MINUTES'),
    },
    smtp: smtpFromEnv(env),
    registry: storageFromEnv(env),
    zone: zoneOf(env),
    instanceType: env.INSTANCE_TYPE || DEFAULTS.instanceType,
    template: env.TEMPLATE || DEFAULTS.template,
    diskSize: DEFAULTS.diskSize,
    securityGroup: DEFAULTS.securityGroup,
    sshKey: DEFAULTS.sshKey,
    onlineSeconds: Number(env.ONLINE_SECONDS || DEFAULTS.onlineSeconds),
    tries: DEFAULTS.tries,
  };
}

/** The instances a plan's matrices ask for: one per leg, labelled as the leg's runner. */
export function instanceLegs(matrix: string, tests = '[]'): InstanceLeg[] {
  const builds = JSON.parse(matrix) as Leg[];
  const testLegs = JSON.parse(tests) as TestLeg[];
  return [
    ...builds.map((l): InstanceLeg => ({ kind: 'build', label: l.runner, app: l.app })),
    ...testLegs.map((l): InstanceLeg => ({ kind: 'test', label: l.runner, app: l.app })),
  ];
}

export function register(program: Command): void {
  const hybrid = program
    .command('hybrid')
    .description('the hybrid strategy’s own: the throwaway instances its large jobs run on');

  hybrid
    .command('create-instances')
    .description(
      'create one instance per build and test leg of the plan and wait for each runner; a miss is kept, stopped, mailed about and replaced once',
    )
    .argument('<matrix>', 'the plan’s build matrix, JSON')
    .argument('[tests]', 'the plan’s test matrix, JSON')
    .action(async (matrix: string, tests: string | undefined, _opts: unknown, command: Command) => {
      const ctx = contextOf(command);
      const github = githubOf(ctx);
      if (!github) throw new Error('RUNNER_TOKEN is empty');
      const legs = instanceLegs(matrix, tests);
      const result = await createInstances(ctx, exoOf(ctx), github, legs, launchOptionsFromEnv());
      ctx.result(result, (r) => r.map((l) => `${l.id} ${l.label} ${l.createdAt}`).join('\n'));
    });

  hybrid
    .command('destroy-instances')
    .description(
      'delete every instance this run created, kept ones excepted, and the runner registrations it never used',
    )
    .action(async (_opts: unknown, command: Command) => {
      const ctx = contextOf(command);
      const result = await destroyInstances(ctx, exoOf(ctx), githubOf(ctx), runIdentity());
      ctx.result(result, (r) => [...r.instances, ...r.registrations.map((n) => `registration ${n}`)].join('\n'));
    });

  hybrid
    .command('sweep-instances')
    .description(
      'delete every instance that is stopped or past its deadline and mail about it; a kept one goes after fourteen days',
    )
    .action(async (_opts: unknown, command: Command) => {
      const ctx = contextOf(command);
      const result = await sweepInstances(ctx, exoOf(ctx), { smtp: smtpFromEnv() });
      ctx.result(result, (r) => r.removed.map((x) => `${x.name} (${x.reason})`).join('\n'));
    });
}
