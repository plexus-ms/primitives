// The release tool against its own newest release. A train cut or propagated
// by a stale plx writes the bookkeeping, and runs the copier, of an older
// release, so `ship` and `propagate` refuse to run behind the registry. Asked
// with `npm view`, the same question answered by hand; an unreachable registry
// only warns, because a release that cannot reach npm fails on its own soon
// enough, and a propagation offline is legitimate.
//
//   npm view @plexus-ms/cli version   # what plx compares itself with
import type { Context } from './context.ts';
import { compareTrains } from './doctor.ts';

export const SELF_PACKAGE = '@plexus-ms/cli';

/** Throws when `running` is older than the registry's latest plx; warns when the registry cannot be asked. */
export async function preflightSelf(ctx: Context, running: string): Promise<void> {
  const latest = (await ctx.read('npm', ['view', SELF_PACKAGE, 'version']).catch(() => '')).trim();
  if (!latest) {
    ctx.say(`⚠ could not ask the registry for the newest ${SELF_PACKAGE}; going on with plx ${running}`);
    return;
  }
  if (compareTrains(running, latest) < 0)
    throw new Error(
      `plx ${running} is behind ${latest}, the newest release; update it first: mise up npm:${SELF_PACKAGE}`,
    );
}
