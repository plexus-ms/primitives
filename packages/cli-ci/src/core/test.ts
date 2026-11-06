// Test one app's candidate image (§ 8 PLX-Delivery): on a large runner, the
// app's own compose.yaml with the CI override beside it, the candidate
// pulled from the registry, `migrate` once, `up --wait`, then the
// app's test script against the running stack, and on success the tag
// test-<hash> on the very manifest that was tested. The specs run on the
// runner, outside the containers: the override's `x-plexus-ci.env` says how
// they reach the stack (the database's published port), beside what every
// app gets: CI, PLEXUS_LOOPBACK_PORT and E2E_BASE_URL, the app's /healthz host.
import { join } from 'node:path';
import type { Context } from '@plexus-ms/lib';
import { run, UsageError } from '@plexus-ms/lib';
import { parse } from 'yaml';
import { candidateRef, digestOf, findTag, type Registry } from './registry.ts';

export const OVERRIDE = 'compose.ci.yaml';

export interface TestOptions {
  app: string;
  /** Turbo's hash of the app's test task; the tag the tested image gets. */
  hash: string;
  /** Turbo's hash of the app's build task; the candidate's tag. */
  build: string;
  /** The port the stack publishes the app on; the override reads it as PLEXUS_LOOPBACK_PORT. */
  port?: number;
  /** The checkout; default the cwd. */
  dir?: string;
  /** Where the candidates live. */
  registry: Registry;
}

export interface TestResult {
  app: string;
  hash: string;
  image: string;
  tag: string;
  digest?: string;
  /** Seconds the stack took to come up, and the tests to run. */
  stackSeconds: number;
  testSeconds: number;
}

/** What the override tells the runner side: `x-plexus-ci.env`, the specs' environment. */
export function overrideEnv(text: string): Record<string, string> {
  // The override may carry compose's own tags (`!override`), which are not ours to resolve.
  const data: unknown = parse(text, { logLevel: 'silent' });
  const x = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)['x-plexus-ci'] : undefined;
  const env = x !== null && typeof x === 'object' ? (x as Record<string, unknown>).env : undefined;
  if (env === undefined) return {};
  if (env === null || typeof env !== 'object') throw new UsageError(`${OVERRIDE}: x-plexus-ci.env is not a map`);
  return Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** The `docker compose` prefix every stack command shares: the project, both files. */
export function composeArgs(project: string): string[] {
  return ['compose', '--project-name', project, '--file', 'compose.yaml', '--file', OVERRIDE];
}

/** The environment the specs run with. */
export function specEnv(port: number, fromOverride: Record<string, string>): NodeJS.ProcessEnv {
  return {
    CI: '1',
    PLEXUS_LOOPBACK_PORT: String(port),
    E2E_BASE_URL: `http://127.0.0.1:${port}`,
    ...fromOverride,
  };
}

export async function test(ctx: Context, options: TestOptions): Promise<TestResult> {
  const { app, hash, build, registry } = options;
  const dir = options.dir ?? '.';
  const port = options.port ?? 3000;
  const appDir = join(dir, 'apps', app);
  const composeDir = join(appDir, 'docker');
  const project = `ci-${app}`;

  const image =
    (await findTag(ctx, registry, app, `build-${build}`)) ??
    (ctx.dryRun ? candidateRef(registry, app, `build-${build}`) : undefined);
  if (image === undefined)
    throw new Error(`${app}:build-${build} is in no registry here; the build failed or never ran`);
  const tag = `test-${hash}`;

  const fromOverride = overrideEnv(await ctx.readFile(join(composeDir, OVERRIDE)));
  const composeEnv = { PLEXUS_DEPLOYMENT_IMAGE: image, PLEXUS_LOOPBACK_PORT: String(port) };
  const compose = (args: string[]) =>
    run('docker', [...composeArgs(project), ...args], { cwd: composeDir, env: composeEnv });

  let stackSeconds = 0;
  let testSeconds = 0;
  let t = Date.now();
  try {
    ctx.say(`test: ${app} ${image} as ${project} on :${port}`);
    await ctx.apply([
      compose(['--profile', 'migrate', 'pull', '--quiet']),
      compose(['run', '--rm', '--quiet-pull', 'migrate']),
      compose(['up', '--detach', '--wait', '--quiet-pull']),
    ]);
    stackSeconds = Math.round((Date.now() - t) / 1000);
    ctx.say(`test: stack up ${stackSeconds}s`);
    t = Date.now();
    // The specs' output is the job's log: inherited, not captured.
    await ctx.apply([run('pnpm', ['test'], { cwd: appDir, env: specEnv(port, fromOverride), interactive: true })]);
    testSeconds = Math.round((Date.now() - t) / 1000);
    ctx.say(`test: tests ${testSeconds}s`);
  } catch (error) {
    if (!ctx.dryRun) {
      const logs = await ctx
        .read('docker', [...composeArgs(project), 'logs', '--no-color', '--tail', '200'], {
          cwd: composeDir,
          env: composeEnv,
        })
        .catch(() => '');
      if (logs) ctx.say(`test: the stack's last lines\n${logs}`);
    }
    throw error;
  } finally {
    await ctx.apply([compose(['--profile', 'migrate', 'down', '--volumes', '--remove-orphans', '--timeout', '10'])]);
  }

  // The tag goes on the manifest that was tested, copied into this month's
  // registry when the candidate came from the previous one.
  await ctx.apply([
    run('docker', ['buildx', 'imagetools', 'create', '--tag', candidateRef(registry, app, tag), image]),
  ]);
  const result: TestResult = { app, hash, image, tag, stackSeconds, testSeconds };
  if (!ctx.dryRun) {
    result.digest = await digestOf(ctx, registry, app, tag);
    ctx.say(`test: ${app} ${tag} -> ${result.digest ?? '<no digest>'}`);
  }
  return result;
}
