// plx-ci registry: make sure this machine reaches the registry the run's
// candidates live in (§ 8 PLX-Delivery). With a registry of the tenant's own
// (CI_REGISTRY=own), that is the pair on localhost: nothing where :5000
// answers already (a slot of a runner host), else the two sidecars are
// started, creating this month's bucket when it is missing. With the forge's
// registry (CI_REGISTRY=ghcr) it is a check that the job has logged in.
// `exists` asks whether a tag is there; `rotate` is the retention, run daily.
// From the environment: CI_STRATEGY, CI_REGISTRY; for the pair
// REGISTRY_ENDPOINT, REGISTRY_REGION, REGISTRY_ACCESS_KEY, REGISTRY_SECRET_KEY
// (the vault item bucket-registry), GITHUB_REPOSITORY (the owner names the
// buckets), ZONE; for `rotate` under ghcr, PACKAGES_TOKEN (may delete the
// organisation's package versions).
//
//   plx-ci registry
//   plx-ci registry exists website build-0f2a3f35123dfd73      # exit 0 when it is, 1 otherwise
//   plx-ci registry rotate
//   plx-ci -n registry rotate                                  # what would go
import type { Command } from 'commander';
import { Packages, prune } from '../core/ghcr.ts';
import { findTag, loggedIn, rotateBuckets, startSidecars, storageFromEnv } from '../core/registry.ts';
import { contextOf } from '../program.ts';
import { imagePrefix, need, ownerOf, registryFor, settings, withStrategy, zoneOf } from './shared.ts';

export function register(program: Command): void {
  const registry = withStrategy(program.command('registry'))
    .description(
      'make the candidates’ registry reachable here: the pair on localhost (started unless :5000 answers), or a login check for the forge’s',
    )
    .action(async (opts: { strategy?: string }, command: Command) => {
      const ctx = contextOf(command);
      const s = settings(opts);
      if (s.registry === 'ghcr') {
        const host = imagePrefix().split('/')[0] ?? 'ghcr.io';
        if (!(await loggedIn(ctx, host)) && !ctx.dryRun)
          throw new Error(`no login for ${host} here; the job logs in before it asks for the registry`);
        ctx.result(`registry: ${imagePrefix()}, logged in`);
        return;
      }
      const result = await startSidecars(ctx, storageFromEnv(), ownerOf(need('GITHUB_REPOSITORY')), zoneOf());
      ctx.result(
        result,
        (r) => `:5000 ${r.current}\n:5001 ${r.previous}${r.previousAnswers ? '' : ' (not answering)'}`,
      );
    });
  withStrategy(registry.command('exists'))
    .description('exit 0 when the registry holds the tag')
    .argument('<app>')
    .argument('<tag>')
    .action(async (app: string, tag: string, opts: { strategy?: string }, command: Command) => {
      const ctx = contextOf(command);
      const ref = await findTag(ctx, registryFor(settings(opts)), app, tag);
      if (ref === undefined) {
        ctx.say(`${app}:${tag} is in no registry here`);
        process.exitCode = 1;
      } else ctx.result(ref);
    });
  withStrategy(registry.command('rotate'))
    .description(
      'the retention: this month’s bucket exists and the one from two months ago goes; in the forge’s registry, candidates older than thirty days go',
    )
    .action(async (opts: { strategy?: string }, command: Command) => {
      const ctx = contextOf(command);
      const s = settings(opts);
      const owner = ownerOf(need('GITHUB_REPOSITORY'));
      if (s.registry === 'ghcr') {
        const result = await prune(ctx, new Packages(ctx, owner, need('PACKAGES_TOKEN')));
        ctx.result(result, (r) => r.map((v) => `${v.package} ${v.tags.join(' ')}`).join('\n'));
        return;
      }
      const storage = storageFromEnv();
      if (!storage)
        throw new Error('REGISTRY_ENDPOINT, REGISTRY_REGION, REGISTRY_ACCESS_KEY and REGISTRY_SECRET_KEY are needed');
      const result = await rotateBuckets(ctx, storage, owner, zoneOf());
      ctx.result(result, (r) =>
        [...(r.created ? [`created ${r.created}`] : []), ...(r.removed ? [`removed ${r.removed}`] : [])].join('\n'),
      );
    });
}
