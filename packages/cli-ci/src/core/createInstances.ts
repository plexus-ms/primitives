// Create the throwaway instances a run's large jobs need (§ 8 PLX-Delivery,
// the hybrid strategy), one per build and per test leg of the plan, at once.
// For each: a JIT config from GitHub, the raw create-instance call with the
// labels the cleanup and the sweep read, user-data that arms the teardown
// layers first, then a wait for the runner to show online, since a boot that
// stalls arms no timer and would leave the job queued for a day.
//
// The trap: an instance whose runner is not online in time is kept, never
// deleted. It is stopped at once, so that a boot that merely runs late cannot
// start the runner and delete itself; renamed `<name>-kept` and labelled
// `kept=<time>`, which the cleanup and the sweep spare; and the alerts address
// is mailed at once with its id. One replacement is created from a fresh JIT
// config; a second miss is kept the same way and fails the launch.
import { gzipSync } from 'node:zlib';
import type { Context } from '@plexus-ms/lib';
import { UsageError } from '@plexus-ms/lib';
import { KEPT_LABEL, type RunIdentity, repoLabel } from './destroyInstances.ts';
import { type CreateInstance, type Exo, sleep } from './exoscale.ts';
import type { GitHubRunners } from './github.ts';
import { type Smtp, sendMail } from './mail.ts';
import type { ObjectStorage } from './registry.ts';
import { deadline, iso, registryBuckets } from './time.ts';
import { RUNNER_USER_DATA, render } from './userData.ts';

export type Kind = 'build' | 'test';

/** What a runner's user-data is told. */
export interface Deadlines {
  noJobMinutes: number;
  deathMinutes: number;
  poweroffMinutes: number;
}

export interface LaunchOptions {
  kind: Kind;
  label: string;
  app?: string;
  run: RunIdentity;
  runnerToken: string;
  selfDelete: { key: string; secret: string };
  /** `off` disarms layers 1, 1b and 2b on the instance while the boot stall is read. */
  selfLayers: 'on' | 'off';
  deadlines: Deadlines;
  smtp?: Smtp;
  registry?: ObjectStorage;
  zone: string;
  instanceType: string;
  template: string;
  diskSize: number;
  securityGroup: string;
  sshKey: string;
  /** Seconds to wait for the runner to show online. */
  onlineSeconds: number;
  /** Instances tried before the launch gives up: the first and one replacement. */
  tries: number;
  /** The wait between two looks at the runner; the tests pass none. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export const DEFAULTS = {
  zone: 'de-fra-1',
  instanceType: 'cpu.extra-large',
  template: 'Linux Debian 13 (Trixie) 64-bit',
  diskSize: 100,
  securityGroup: 'runners',
  sshKey: 'runners',
  onlineSeconds: 120,
  tries: 2,
  runnerVersion: '2.338.2',
  runnerSha256: 'baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40',
  exoVersion: '1.103.2',
  /** What the API accepts, base64 characters. */
  userDataLimit: 32768,
} as const;

export interface Launch {
  id: string;
  label: string;
  createdAt: string;
  noJobDeadline: string;
  deathDeadline: string;
  /** Instances created, the last one being the launched one. */
  tries: number;
  /** The ids of the missed instances, kept and stopped. */
  kept: string[];
}

/** The runner's user-data for one launch, rendered: the values written as they are. */
export function renderUserData(options: LaunchOptions, jitconfig: string, now: Date): string {
  const owner = options.run.repo.split('/')[0] ?? options.run.repo;
  const buckets = registryBuckets(owner, now);
  return render(RUNNER_USER_DATA, {
    POWEROFF_MINUTES: String(options.deadlines.poweroffMinutes),
    NO_JOB_MINUTES: String(options.deadlines.noJobMinutes),
    DEATH_MINUTES: String(options.deadlines.deathMinutes),
    ZONE: options.zone,
    LABEL: options.label,
    KIND: options.kind,
    APP: options.app ?? '',
    REPO: options.run.repo,
    RUN: options.run.runId,
    RUNNER_VERSION: DEFAULTS.runnerVersion,
    RUNNER_SHA256: DEFAULTS.runnerSha256,
    EXO_VERSION: DEFAULTS.exoVersion,
    JITCONFIG: jitconfig,
    SELF_DELETE_KEY: options.selfDelete.key,
    SELF_DELETE_SECRET: options.selfDelete.secret,
    SELF_LAYERS: options.selfLayers,
    SMTP_HOST: options.smtp?.host ?? '',
    SMTP_PORT: options.smtp?.port ?? '',
    SMTP_USER: options.smtp?.user ?? '',
    SMTP_PASSWORD: options.smtp?.password ?? '',
    MAIL_FROM: options.smtp?.from ?? '',
    MAIL_TO: options.smtp?.to ?? '',
    REGISTRY_ENDPOINT: options.registry?.endpoint ?? '',
    REGISTRY_REGION: options.registry?.region ?? '',
    REGISTRY_BUCKET: buckets.current,
    REGISTRY_PREVIOUS_BUCKET: buckets.previous,
    REGISTRY_ACCESS_KEY: options.registry?.accessKey ?? '',
    REGISTRY_SECRET_KEY: options.registry?.secretKey ?? '',
  });
}

/** gzip, then base64: plain base64 stalled the template's boot (the Exoscale field notes, § 3). */
export function encodeUserData(text: string): string {
  const encoded = gzipSync(Buffer.from(text), { level: 9 }).toString('base64');
  if (encoded.length > DEFAULTS.userDataLimit)
    throw new UsageError(`user-data too large: ${encoded.length} bytes base64, ${DEFAULTS.userDataLimit} allowed`);
  return encoded;
}

/** The labels the cleanup and the sweep read. */
export function instanceLabels(
  options: LaunchOptions,
  noJobDeadline: string,
  deathDeadline: string,
): Record<string, string> {
  return {
    'plexus-ci': 'true',
    repo: repoLabel(options.run.repo),
    run: options.run.runId,
    attempt: options.run.attempt,
    app: options.app || 'none',
    kind: options.kind,
    'no-job-deadline': noJobDeadline,
    'death-deadline': deathDeadline,
  };
}

export async function launch(ctx: Context, exo: Exo, github: GitHubRunners, options: LaunchOptions): Promise<Launch> {
  const now = options.now ?? (() => new Date());
  const { label } = options;
  if (options.deadlines.poweroffMinutes <= options.deadlines.deathMinutes)
    throw new UsageError('the power-off must come after the death deadline');
  const t0 = now();
  const noJobDeadline = deadline(t0, options.deadlines.noJobMinutes);
  const deathDeadline = deadline(t0, options.deadlines.deathMinutes);
  const labels = instanceLabels(options, noJobDeadline, deathDeadline);

  const [templateId, instanceTypeId, securityGroupId] = await Promise.all([
    exo.templateId(options.template),
    exo.instanceTypeId(options.instanceType),
    exo.securityGroupId(options.securityGroup),
  ]);
  const result: Launch = {
    id: '<instance-id>',
    label,
    createdAt: iso(t0),
    noJobDeadline,
    deathDeadline,
    tries: 0,
    kept: [],
  };
  ctx.say(`→ creating ${label} (${options.instanceType}, ${options.zone})`);
  for (let attempt = 1; attempt <= options.tries; attempt++) {
    // One JIT config registers one runner for exactly one job; the runner
    // exits after it, which is what layer 1 keys on. Every instance gets a
    // config of its own: a kept one may have read its config before it was
    // stopped. If no instance comes to claim it, the registration is removed
    // again instead of lingering offline.
    const registration = await github.generateJitConfig(label, label);
    const unregister = async () => {
      if (registration) await github.deleteRunner(registration.runnerId).catch(() => undefined);
    };
    try {
      const request: CreateInstance = {
        name: label,
        templateId,
        instanceTypeId,
        securityGroupId,
        sshKey: options.sshKey,
        diskSize: options.diskSize,
        userDataBase64: encodeUserData(renderUserData(options, registration?.encodedJitConfig ?? '<jitconfig>', t0)),
        labels,
      };
      const operation = await exo.createInstance(request);
      result.tries = attempt;
      if (operation === undefined) {
        ctx.say(
          `  (then: wait up to ${options.onlineSeconds}s for the runner to show online; on a miss keep the instance stopped as ${label}-kept, mail, and create one replacement)`,
        );
        return result;
      }
      if (!operation.reference) throw new Error(`create-instance returned no instance: ${JSON.stringify(operation)}`);
      result.id = operation.reference;
      result.createdAt = iso(now());
      const state = await exo.waitOperation(operation.id);
      if (state !== 'success') throw new Error(`create-instance ended in state ${state}`);
      ctx.say(`created ${label} (${result.id}) in ${options.zone}, try ${attempt}`);
    } catch (error) {
      ctx.say(`launch failed, removing the runner registration ${label}`);
      await unregister();
      throw error;
    }

    const waited = await waitOnline(github, label, options.onlineSeconds, options.sleep ?? sleep);
    if (waited !== undefined) {
      ctx.say(`runner ${label} online after ${waited}s`);
      ctx.say(
        `launched ${label} (${result.id}): no job by ${noJobDeadline}, dies at ${deathDeadline}, powers off ${options.deadlines.poweroffMinutes} minutes after creation`,
      );
      return result;
    }
    ctx.say(`✗ ${label} (${result.id}) did not come online within ${options.onlineSeconds}s`);
    await keep(ctx, exo, options, result.id, labels, now());
    result.kept.push(result.id);
    await unregister();
  }
  throw new Error(`${options.tries} instance(s) of ${label} failed to come online and are kept, giving up`);
}

/** Seconds until the runner showed online, or undefined after `seconds`. */
async function waitOnline(
  github: GitHubRunners,
  label: string,
  seconds: number,
  wait: (ms: number) => Promise<void>,
): Promise<number | undefined> {
  for (let waited = 0; waited < seconds; waited += 5) {
    await wait(5000);
    if ((await github.status(label)) === 'online') return waited + 5;
  }
  return undefined;
}

/** What the mail about a kept instance says. */
export function keptMail(options: LaunchOptions, id: string): { subject: string; text: string } {
  const { label, run } = options;
  return {
    subject: `plexus-ci: ${label} did not come online and is kept`,
    text: [
      `The instance ${label} (${options.kind}, app ${options.app ?? 'none'}) of ${run.repo} run ${run.runId} attempt ${run.attempt} did not register its runner within ${options.onlineSeconds} seconds.`,
      '',
      `It is stopped and kept as ${label}-kept:`,
      `  id    ${id}`,
      `  zone  ${options.zone}`,
      '',
      'Its disk holds the boot it stalled in. Snapshot it to read it; the daily sweep mails again after seven days and deletes the instance after fourteen.',
      '',
    ].join('\n'),
  };
}

/**
 * Keep a missed instance: stop it first, which is what cannot wait, then mark
 * it, then say so. Each step is tried whatever the one before did: a stopped
 * instance without the label is deleted by the cleanup, a labelled one that
 * would not stop may still delete itself, and the log says which it was.
 */
async function keep(
  ctx: Context,
  exo: Exo,
  options: LaunchOptions,
  id: string,
  labels: Record<string, string>,
  now: Date,
): Promise<void> {
  const { label } = options;
  const stopped = await exo.stopInstance(id).then(
    () => true,
    () => false,
  );
  if (!stopped) ctx.say(`  stop-instance refused for ${id}; the instance may delete itself`);
  const marked = await exo.updateInstance(id, `${label}-kept`, { ...labels, [KEPT_LABEL]: iso(now) }).then(
    () => true,
    () => false,
  );
  if (!marked) ctx.say(`  update-instance refused for ${id}; unmarked, the cleanup will delete it`);
  ctx.say(`kept ${label} (${id}) as ${label}-kept${stopped ? ', stopped' : ''}`);
  if (!options.smtp) return;
  const mail = keptMail(options, id);
  await sendMail(ctx, options.smtp, mail.subject, mail.text, now).catch(() =>
    ctx.say(`  the mail about ${id} could not be sent`),
  );
}

/** One instance to create: what its job is, the one label that job asks for, and its app. */
export interface InstanceLeg {
  kind: Kind;
  label: string;
  app: string;
}

/** Create every instance at once: each launch waits for its runner, and the waits overlap. */
export async function createInstances(
  ctx: Context,
  exo: Exo,
  github: GitHubRunners,
  legs: InstanceLeg[],
  shared: Omit<LaunchOptions, 'label' | 'app' | 'kind'>,
): Promise<Launch[]> {
  const launches = await Promise.allSettled(legs.map((leg) => launch(ctx, exo, github, { ...shared, ...leg })));
  const failed = launches.filter((l) => l.status === 'rejected');
  if (failed.length > 0) {
    for (const f of failed) ctx.say(`✗ ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);
    throw new Error(`${failed.length} launch(es) failed`);
  }
  return launches.flatMap((l) => (l.status === 'fulfilled' ? [l.value] : []));
}
