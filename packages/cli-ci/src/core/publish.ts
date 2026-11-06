// Publish one app's tested image under its commit, to the registry
// production pulls from (§ 8 PLX-Delivery). With a registry of the tenant's
// own: copy the manifest, by digest and without an index, from the sidecar to
// the forge's registry as build-<hash>, then tag it test-<hash> and <sha>; or,
// when it is there already (a promotion, a re-run), only add the tags. Where
// the candidates live in the forge's registry itself, nothing is copied: the
// tested manifest gets the tag <sha>. Either way the tag test-<hash> is the
// proof the tests passed, and an image without it is not published. crane
// does the copying and tagging, logged in to the forge's registry by the job.
import type { Context } from '@plexus-ms/lib';
import { run } from '@plexus-ms/lib';
import { craneDigest, findTag, imageName, type Registry } from './registry.ts';

export interface PublishOptions {
  app: string;
  /** Turbo's hash of the app's build task. */
  build: string;
  /** Turbo's hash of the app's test task when it has one; the tag the image is read from, proof the tests passed. */
  test?: string;
  sha: string;
  /** Where the published images live, `ghcr.io/<owner>`; lower-cased, as registries want. */
  prefix: string;
  /** Where the candidates live. */
  registry: Registry;
}

export interface Published {
  app: string;
  image: string;
  /** Whether the manifest was copied, or found there already. */
  copied: boolean;
  tags: string[];
}

export async function publish(ctx: Context, options: PublishOptions): Promise<Published> {
  const { app, build, test, sha, registry } = options;
  const image = imageName(options.prefix, app);
  const target = `${image}:build-${build}`;
  const source = test ? `test-${test}` : `build-${build}`;
  const missing = `${app}:${source} is in no registry here; ${test ? 'the tests did not pass on this build' : 'the build never ran'}`;

  if (registry.kind === 'ghcr') {
    const ref = `${image}:${source}`;
    if ((await craneDigest(ctx, ref)) === undefined && !ctx.dryRun) throw new Error(missing);
    ctx.say(`publish: ${ref} as ${sha}`);
    await ctx.apply([run('crane', ['tag', ref, sha])]);
    return { app, image, copied: false, tags: [`build-${build}`, ...(test ? [`test-${test}`] : []), sha] };
  }

  const copied = (await craneDigest(ctx, target)) === undefined;
  if (copied) {
    const from = await findTag(ctx, registry, app, source);
    if (from === undefined && !ctx.dryRun) throw new Error(missing);
    ctx.say(`publish: ${app}:${source} -> ${target}`);
    await ctx.apply([run('crane', ['copy', '--insecure', from ?? `localhost:5000/${app}:${source}`, target])]);
  } else ctx.say(`publish: ${target} is there already, tagging only`);
  const tags = [sha, ...(test ? [`test-${test}`] : [])];
  await ctx.apply(tags.map((t) => run('crane', ['tag', target, t])));
  return { app, image, copied, tags: [`build-${build}`, ...tags] };
}
