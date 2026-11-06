// The run's own cleanup (§ 8 PLX-Delivery, the hybrid strategy), by a job
// that needs every job an instance was created for and runs whatever they
// ended in. Deletes every plexus-ci instance in the zone that this run and
// attempt created, except those kept after a missed boot, and removes the
// runner registrations those instances never used. The instance's own layers
// stay as they are: this is for the cases the workflow sees and they do not, a
// build that failed before the runner exited cleanly, a runner that never
// came online.
import type { Context } from '@plexus-ms/lib';
import { type Exo, type Instance, sleep } from './exoscale.ts';
import type { GitHubRunners, Runner } from './github.ts';

export interface RunIdentity {
  /** `owner/repo`. */
  repo: string;
  runId: string;
  attempt: string;
}

/** The label `repo` carries, `owner-repo`. */
export const repoLabel = (repo: string): string => repo.replace('/', '-');

/** The label a kept instance carries, its value the time it was kept (createInstances.ts); the cleanup and the sweep spare it. */
export const KEPT_LABEL = 'kept';

/** The instances this run and attempt created, kept ones left out. */
export function selectRunInstances(instances: Instance[], run: RunIdentity): Instance[] {
  return instances.filter(
    (i) =>
      i.labels['plexus-ci'] === 'true' &&
      i.labels.repo === repoLabel(run.repo) &&
      i.labels.run === run.runId &&
      i.labels.attempt === run.attempt &&
      i.labels[KEPT_LABEL] === undefined,
  );
}

/** The registrations this run's launches minted: `exo-<kind>-<run>[-<app>…]-<attempt>[-<suffix>]`, not busy with a job. */
export function selectRunRegistrations(runners: Runner[], run: RunIdentity): Runner[] {
  const pattern = new RegExp(`^exo-[a-z]+-${run.runId}(-[^-]+)*-${run.attempt}(-[a-z0-9]+)?$`);
  return runners.filter((r) => !r.busy && pattern.test(r.name));
}

export interface Destroyed {
  instances: string[];
  kept: string[];
  registrations: string[];
}

export async function destroyInstances(
  ctx: Context,
  exo: Exo,
  github: GitHubRunners | undefined,
  run: RunIdentity,
  { retries = 12, wait = sleep }: { retries?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<Destroyed> {
  const all = await exo.listInstances();
  const mine = selectRunInstances(all, run);
  const kept = all
    .filter(
      (i) =>
        i.labels['plexus-ci'] === 'true' &&
        i.labels[KEPT_LABEL] !== undefined &&
        i.labels.repo === repoLabel(run.repo) &&
        i.labels.run === run.runId,
    )
    .map((i) => i.name);
  for (const name of kept) ctx.say(`${name}: kept after a missed boot, left alone`);
  // One instance's refusal never spares the others. Exoscale deletes only a
  // running or a stopped instance and answers 400 for one still starting, so
  // what was refused is asked again, for up to two minutes.
  let left = mine;
  for (let round = 0; left.length > 0 && round <= retries; round++) {
    if (round > 0) await wait(10_000);
    const refused: Instance[] = [];
    for (const i of left) {
      if (round === 0) ctx.say(`${i.name} (${i.id}): ${i.state}`);
      try {
        await exo.deleteInstance(i.id);
      } catch (error) {
        if (round === retries) ctx.say(`✗ ${i.name} (${i.id}) is not deleted: ${(error as Error).message}`);
        refused.push(i);
      }
    }
    left = refused;
  }
  ctx.say(
    `destroy-instances: ${mine.length - left.length} of ${mine.length} instance(s) of run ${run.runId} attempt ${run.attempt} deleted`,
  );
  const registrations: string[] = [];
  if (github) {
    // A JIT registration stays listed when no job consumed it, online while
    // its instance is still going down and offline afterwards; GitHub refuses
    // to delete only one that is busy with a job.
    for (const r of selectRunRegistrations(await github.list(), run)) {
      ctx.say(`runner ${r.name} (${r.id}): ${r.status}`);
      await github.deleteRunner(r.id);
      registrations.push(r.name);
    }
    ctx.say(`destroy-instances: ${registrations.length} registration(s) removed`);
  }
  if (left.length > 0)
    throw new Error(
      `${left.length} instance(s) could not be deleted: ${left.map((i) => i.name).join(', ')}; they power off on their own, and the sweep deletes them`,
    );
  return { instances: mine.map((i) => i.name), kept, registrations };
}
