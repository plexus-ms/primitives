// Where a run's candidates live (§ 8 PLX-Delivery), behind one shape. `own`
// is the registry pair: `registry:2` on 127.0.0.1:5000 for this month's
// bucket, read-write, and on 127.0.0.1:5001 for the previous month's,
// read-only; both the same registry API over the tenant's object storage,
// nothing reads the bucket layout directly. A runner host keeps the pair
// running; a forge runner, a launched instance or a large slot starts it for
// the length of its job. In the first month the previous bucket does not
// exist and registry:2 answers 503 (its storage health check fails): that
// sidecar is optional, and a build names it as a cache source only when it
// answers 200. `ghcr` is the forge's registry itself, where the published
// images live too: nothing to start, the job logs in, and crane and docker
// reach it.
import type { Context } from '@plexus-ms/lib';
import { ExecError, run } from '@plexus-ms/lib';
import { sleep } from './exoscale.ts';
import { type ObjectStorage, S3 } from './s3.ts';
import type { RegistryKind } from './strategy.ts';
import { registryBuckets } from './time.ts';

/** The registry the candidates of a run live in; `prefix` is where the images of the forge's registry live, `ghcr.io/<owner>`. */
export type Registry = { kind: 'own' } | { kind: 'ghcr'; prefix: string };

export const imageName = (prefix: string, app: string): string => `${prefix.toLowerCase().replace(/\/$/, '')}/${app}`;

export function registryOf(kind: RegistryKind, prefix: string): Registry {
  return kind === 'own' ? { kind } : { kind, prefix };
}

export type { ObjectStorage };

export const CURRENT_PORT = 5000;
export const PREVIOUS_PORT = 5001;
export const REGISTRY_IMAGE = 'registry:2';
const ACCEPT =
  'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json';

/** The storage from the environment the vault item bucket-registry fills. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStorage | undefined {
  const { REGISTRY_ENDPOINT, REGISTRY_REGION, REGISTRY_ACCESS_KEY, REGISTRY_SECRET_KEY } = env;
  if (!REGISTRY_ENDPOINT || !REGISTRY_REGION || !REGISTRY_ACCESS_KEY || !REGISTRY_SECRET_KEY) return undefined;
  return {
    endpoint: REGISTRY_ENDPOINT,
    region: REGISTRY_REGION,
    accessKey: REGISTRY_ACCESS_KEY,
    secretKey: REGISTRY_SECRET_KEY,
  };
}

/** The `docker run` of one sidecar; the key on argv is the same exposure as the job's own secrets. */
export function sidecarArgs(
  name: string,
  port: number,
  bucket: string,
  storage: ObjectStorage,
  readOnly: boolean,
): string[] {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--restart',
    readOnly ? 'on-failure:3' : 'unless-stopped',
    '-p',
    `127.0.0.1:${port}:5000`,
    '-e',
    'REGISTRY_STORAGE=s3',
    '-e',
    `REGISTRY_STORAGE_S3_REGIONENDPOINT=${storage.endpoint}`,
    '-e',
    `REGISTRY_STORAGE_S3_REGION=${storage.region}`,
    '-e',
    `REGISTRY_STORAGE_S3_BUCKET=${bucket}`,
    '-e',
    `REGISTRY_STORAGE_S3_ACCESSKEY=${storage.accessKey}`,
    '-e',
    `REGISTRY_STORAGE_S3_SECRETKEY=${storage.secretKey}`,
    '-e',
    'REGISTRY_STORAGE_S3_FORCEPATHSTYLE=true',
    '-e',
    // registry:2 panics on the read-only flag as one nested variable
    // (…_READONLY_ENABLED=true): the map it builds from it has the wrong
    // type. The whole key as one YAML value is read as from a config file.
    readOnly ? 'REGISTRY_STORAGE_MAINTENANCE_READONLY={"enabled":true}' : 'REGISTRY_STORAGE_DELETE_ENABLED=true',
    REGISTRY_IMAGE,
  ];
}

/** Whether a sidecar answers `/v2/`. */
export async function answers(ctx: Context, port: number): Promise<boolean> {
  try {
    await ctx.read('curl', ['-fsS', '--max-time', '3', `http://127.0.0.1:${port}/v2/`]);
    return true;
  } catch {
    return false;
  }
}

export interface Sidecars {
  current: string;
  previous: string;
  /** Whether the previous month's sidecar answers. */
  previousAnswers: boolean;
}

/**
 * Create this month's bucket when it does not exist yet (the ci-storage key
 * may), start both sidecars, wait for the current one and briefly for the
 * previous one. Where the current one answers already, the machine runs the
 * pair for its jobs (a slot of a runner host, actions_runners, which keeps
 * the pair on this month's buckets and gives the slot no Docker socket):
 * nothing is started and no bucket is touched.
 */
export async function startSidecars(
  ctx: Context,
  storage: ObjectStorage | undefined,
  owner: string,
  now = new Date(),
): Promise<Sidecars> {
  const buckets = registryBuckets(owner, now);
  if (!ctx.dryRun && (await answers(ctx, CURRENT_PORT))) {
    const previousAnswers = await answers(ctx, PREVIOUS_PORT);
    ctx.say(`registry: :${CURRENT_PORT} answers already, the host's pair; nothing started`);
    return { current: buckets.current, previous: buckets.previous, previousAnswers };
  }
  if (!storage)
    throw new Error('REGISTRY_ENDPOINT, REGISTRY_REGION, REGISTRY_ACCESS_KEY and REGISTRY_SECRET_KEY are needed');
  const s3 = new S3(ctx, storage);
  if (!(await s3.bucketExists(buckets.current))) {
    ctx.say(`→ creating the bucket ${buckets.current}`);
    await s3.makeBucket(buckets.current);
  }
  await ctx.apply([
    run('docker', sidecarArgs('registry', CURRENT_PORT, buckets.current, storage, false)),
    run('docker', sidecarArgs('registry-previous', PREVIOUS_PORT, buckets.previous, storage, true)),
  ]);
  if (!ctx.dryRun) {
    for (let i = 0; i < 30 && !(await answers(ctx, CURRENT_PORT)); i++) await sleep(1000);
    for (let i = 0; i < 5 && !(await answers(ctx, PREVIOUS_PORT)); i++) await sleep(1000);
  }
  const previousAnswers = ctx.dryRun ? false : await answers(ctx, PREVIOUS_PORT);
  ctx.say(
    `registry: :${CURRENT_PORT} on ${buckets.current} (read-write), :${PREVIOUS_PORT} on ${buckets.previous} (${previousAnswers ? 'read-only' : 'not answering, bucket missing?'})`,
  );
  return { current: buckets.current, previous: buckets.previous, previousAnswers };
}

/** The HTTP status of a manifest HEAD against one sidecar, `000` when nothing answers. */
async function manifestStatus(ctx: Context, port: number, app: string, tag: string): Promise<string> {
  try {
    return (
      await ctx.read('curl', [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-I',
        '-H',
        `Accept: ${ACCEPT}`,
        `http://127.0.0.1:${port}/v2/${app}/manifests/${tag}`,
      ])
    ).trim();
  } catch {
    return '000';
  }
}

/** The port of the sidecar that holds `app:tag`, or undefined. */
export async function tagExists(ctx: Context, app: string, tag: string): Promise<number | undefined> {
  for (const port of [CURRENT_PORT, PREVIOUS_PORT]) {
    if ((await manifestStatus(ctx, port, app, tag)) === '200') return port;
  }
  return undefined;
}

/** The digest of `app:tag` on one sidecar, or undefined. */
export async function digest(ctx: Context, app: string, tag: string, port = CURRENT_PORT): Promise<string | undefined> {
  try {
    const head = await ctx.read('curl', [
      '-fsS',
      '-I',
      '-H',
      `Accept: ${ACCEPT}`,
      `http://127.0.0.1:${port}/v2/${app}/manifests/${tag}`,
    ]);
    return head.match(/^docker-content-digest:\s*(\S+)/im)?.[1];
  } catch {
    return undefined;
  }
}

export interface Layer {
  digest: string;
  size: number;
}

/** The layers of `app:tag`'s manifest on one sidecar, or undefined. */
export async function layers(
  ctx: Context,
  app: string,
  tag: string,
  port = CURRENT_PORT,
): Promise<Layer[] | undefined> {
  try {
    const body = await ctx.read('curl', [
      '-fsS',
      '-H',
      `Accept: ${ACCEPT}`,
      `http://127.0.0.1:${port}/v2/${app}/manifests/${tag}`,
    ]);
    const data = JSON.parse(body) as { layers?: Layer[] };
    return (data.layers ?? []).map((l) => ({ digest: l.digest, size: l.size }));
  } catch {
    return undefined;
  }
}

/** Where a run writes `app:tag`: this month's sidecar, or the forge's registry. */
export function candidateRef(registry: Registry, app: string, tag: string): string {
  return registry.kind === 'own'
    ? `localhost:${CURRENT_PORT}/${app}:${tag}`
    : `${imageName(registry.prefix, app)}:${tag}`;
}

/**
 * Whether `ref` resolves on a registry crane is logged in to. Only crane's
 * own answer means absent: crane that cannot run is the job's fault, and
 * reporting it as a missing image sends the reader after a build that ran.
 */
export async function craneDigest(ctx: Context, ref: string): Promise<string | undefined> {
  try {
    return (await ctx.read('crane', ['digest', ref])).trim() || undefined;
  } catch (error) {
    if (error instanceof ExecError) return undefined;
    throw new Error(`crane could not run to look up ${ref}; is it installed in this job?`, { cause: error });
  }
}

/** The ref under which the registry holds `app:tag`, either sidecar's under `own`, or undefined. */
export async function findTag(ctx: Context, registry: Registry, app: string, tag: string): Promise<string | undefined> {
  if (registry.kind === 'own') {
    const port = await tagExists(ctx, app, tag);
    return port === undefined ? undefined : `localhost:${port}/${app}:${tag}`;
  }
  const ref = candidateRef(registry, app, tag);
  return (await craneDigest(ctx, ref)) === undefined ? undefined : ref;
}

/** The digest of `app:tag` where a run writes, or undefined. */
export function digestOf(ctx: Context, registry: Registry, app: string, tag: string): Promise<string | undefined> {
  return registry.kind === 'own' ? digest(ctx, app, tag) : craneDigest(ctx, candidateRef(registry, app, tag));
}

/** The layers of `app:tag` where a run writes, or undefined. */
export async function layersOf(
  ctx: Context,
  registry: Registry,
  app: string,
  tag: string,
): Promise<Layer[] | undefined> {
  if (registry.kind === 'own') return layers(ctx, app, tag);
  try {
    const data = JSON.parse(await ctx.read('crane', ['manifest', candidateRef(registry, app, tag)])) as {
      layers?: Layer[];
    };
    return (data.layers ?? []).map((l) => ({ digest: l.digest, size: l.size }));
  } catch {
    return undefined;
  }
}

/**
 * Whether this machine holds a login for the forge's registry: an entry in
 * the Docker config crane and docker both read, or a credential store that
 * answers for it. Read from the file, so that no secret passes through here.
 */
export async function loggedIn(ctx: Context, host: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const file = `${env.DOCKER_CONFIG || `${env.HOME}/.docker`}/config.json`;
  try {
    const config = JSON.parse(await ctx.readFile(file)) as {
      auths?: Record<string, unknown>;
      credsStore?: string;
      credHelpers?: Record<string, string>;
    };
    return Boolean(config.auths?.[host] || config.credHelpers?.[host] || config.credsStore);
  } catch {
    return false;
  }
}

export interface Rotation {
  /** This month's bucket, when it had to be created. */
  created?: string;
  /** The bucket from two months ago, when it was still there. */
  removed?: string;
}

/**
 * Retention by rotation: this month's bucket exists, the one from two months
 * ago is deleted whole. Writes go to the current month, reads consult the
 * current and the previous, so nothing reads what goes.
 */
export async function rotateBuckets(
  ctx: Context,
  storage: ObjectStorage,
  owner: string,
  now = new Date(),
): Promise<Rotation> {
  const buckets = registryBuckets(owner, now);
  const s3 = new S3(ctx, storage);
  const result: Rotation = {};
  if (!(await s3.bucketExists(buckets.current))) {
    ctx.say(`rotate: creating the bucket ${buckets.current}`);
    await s3.makeBucket(buckets.current);
    result.created = buckets.current;
  }
  if (await s3.bucketExists(buckets.expired)) {
    ctx.say(`rotate: the registry bucket ${buckets.expired} is two months old`);
    await s3.removeBucket(buckets.expired);
    result.removed = buckets.expired;
  }
  return result;
}
