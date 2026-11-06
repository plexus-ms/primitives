// Build one app's image from its pruned context, with the registry as
// BuildKit cache and candidate store (§§ 4 and 8 PLX-Delivery). Runs on a
// large runner, whichever the strategy gives it, in a checkout of the repo
// with node and docker on the PATH, and by hand the same way. BuildKit runs
// as a docker-container builder on the machine's network (the docker driver
// cannot export a registry cache, and localhost:5000 is the sidecar there); a
// launched instance has bootstrapped it by the time the job starts, anywhere
// else the build creates it.
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@plexus-ms/lib';
import { run, UsageError } from '@plexus-ms/lib';
import { packageName, turboOf } from './plan.ts';
import { answers, candidateRef, PREVIOUS_PORT, type Registry } from './registry.ts';

export interface BuildOptions {
  app: string;
  /** Turbo's hash of the app's build task; the image's primary tag and Next's build ID. */
  hash: string;
  sha: string;
  /** Further tags on the same image. */
  tags?: string[];
  /** The app's fixed key, a BuildKit secret; the Dockerfile reads it as next-server-actions-encryption-key. */
  encryptionKey: string;
  /** Build from scratch, the reproducibility measurement. */
  noCache?: boolean;
  /** The checkout; default the cwd. */
  dir?: string;
  /** Where the candidates live. */
  registry: Registry;
  builder?: string;
}

export interface Build {
  app: string;
  tags: string[];
  digest?: string;
  /** Seconds the prune and the build took. */
  pruneSeconds: number;
  buildSeconds: number;
}

export const PREVIOUS_REGISTRY = `localhost:${PREVIOUS_PORT}`;

/**
 * The tags a build pushes: build-<hash> and the extra ones, and the commit
 * where the candidates have a registry of their own. In the forge's registry
 * the commit's tag marks a published image, which only `publish` may set.
 */
export function tagsOf(options: BuildOptions): string[] {
  return [`build-${options.hash}`, ...(options.registry.kind === 'own' ? [options.sha] : []), ...(options.tags ?? [])];
}

/** The `docker buildx build` arguments, so that the tests pin them. */
export function buildArgs(
  options: BuildOptions,
  context: string,
  metadataFile: string,
  previousAnswers: boolean,
): string[] {
  const { app } = options;
  const ref = (tag: string) => candidateRef(options.registry, app, tag);
  const tags = tagsOf(options).flatMap((t) => ['--tag', ref(t)]);
  const cache = options.noCache
    ? ['--no-cache']
    : [
        '--cache-from',
        `type=registry,ref=${ref('cache')}`,
        ...(previousAnswers ? ['--cache-from', `type=registry,ref=${PREVIOUS_REGISTRY}/${app}:cache`] : []),
        '--cache-to',
        `type=registry,ref=${ref('cache')},mode=max`,
      ];
  return [
    'buildx',
    'build',
    context,
    '--file',
    `${context}/apps/${app}/docker/Dockerfile`,
    '--platform',
    'linux/amd64',
    '--build-arg',
    `APP=${app}`,
    '--build-arg',
    `BUILD_HASH=${options.hash}`,
    '--secret',
    'id=next-server-actions-encryption-key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY',
    ...cache,
    ...tags,
    // SOURCE_DATE_EPOCH and rewrite-timestamp flatten every timestamp the image
    // carries; provenance and SBOM off, so the manifest is the image and nothing else.
    '--output',
    'type=image,push=true,rewrite-timestamp=true,oci-mediatypes=true',
    '--provenance=false',
    '--sbom=false',
    '--metadata-file',
    metadataFile,
    '--progress',
    'plain',
  ];
}

/** The builder, created where the machine has none of the name yet. */
async function ensureBuilder(ctx: Context, name: string): Promise<void> {
  if (!ctx.dryRun) {
    try {
      await ctx.read('docker', ['buildx', 'inspect', name]);
      return;
    } catch {}
  }
  await ctx.apply([
    run('docker', [
      'buildx',
      'create',
      '--name',
      name,
      '--driver',
      'docker-container',
      '--driver-opt',
      'network=host',
      '--bootstrap',
    ]),
  ]);
}

export async function build(ctx: Context, options: BuildOptions): Promise<Build> {
  if (!options.encryptionKey) throw new UsageError('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is empty');
  const dir = options.dir ?? '.';
  const out = join(tmpdir(), `plx-ci-build-${randomBytes(4).toString('hex')}`);
  const context = join(out, 'full');
  const builder = options.builder ?? 'ci';
  const env = {
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: options.encryptionKey,
    BUILDX_BUILDER: builder,
    SOURCE_DATE_EPOCH: '0',
  };
  const name = await packageName(ctx, dir, options.app);
  await ensureBuilder(ctx, builder);

  // The pruned context: the app, the workspace packages it uses, a lockfile
  // reduced to them. turbo writes the lockfile beside `full`, and leaves out
  // the root .dockerignore and an empty packages/ when the app uses none; the
  // Dockerfile wants all three.
  let t = Date.now();
  await ctx.apply([
    run('npx', ['--yes', await turboOf(ctx, dir), 'prune', name, '--docker', '--out-dir', out], {
      cwd: dir,
    }),
    run('cp', [join(out, 'pnpm-lock.yaml'), join(context, 'pnpm-lock.yaml')]),
    run('cp', [join(dir, '.dockerignore'), join(context, '.dockerignore')]),
    run('mkdir', ['-p', join(context, 'packages')]),
  ]);
  const pruneSeconds = Math.round((Date.now() - t) / 1000);
  ctx.say(`build: prune ${pruneSeconds}s`);

  // The previous month's sidecar exists only when its bucket does, and only
  // with a registry of the tenant's own.
  const previousAnswers = options.registry.kind === 'own' && (ctx.dryRun ? true : await answers(ctx, PREVIOUS_PORT));
  if (options.registry.kind === 'own' && !previousAnswers)
    ctx.say(`build: no previous-month registry on ${PREVIOUS_REGISTRY}`);
  const metadataFile = join(out, 'metadata.json');
  t = Date.now();
  await ctx.apply([run('docker', buildArgs(options, context, metadataFile, previousAnswers), { env })]);
  const buildSeconds = Math.round((Date.now() - t) / 1000);
  ctx.say(`build: build${options.noCache ? ' no-cache' : ''} ${buildSeconds}s`);

  const tags = tagsOf(options);
  const result: Build = { app: options.app, tags, pruneSeconds, buildSeconds };
  if (!ctx.dryRun) {
    const meta = JSON.parse(await ctx.readFile(metadataFile)) as { 'containerimage.digest'?: string };
    result.digest = meta['containerimage.digest'];
    ctx.say(`build: ${options.app} ${tags.join(' ')} -> ${result.digest ?? '<no digest>'}`);
  }
  await ctx.apply([run('rm', ['-rf', out])]);
  return result;
}
