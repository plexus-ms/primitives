// The train (§ 1.5 PLX) as a repo taking it sees it: one version, tagged
// identically on every train repo, plain semver. Cutting a train is the
// upstream's and lives in the unpublished `@plexus-ms/dev`; what is here is
// what tenant and operator verbs need to name a train and ask the forge.
import type { Context } from './context.ts';

/**
 * The repo whose releases are the trains as a repo outside the workspace sees
 * them: it is released last, so a train shows there once it is cut everywhere,
 * and its release carries the train manifest (manifest.ts).
 */
export const COMPENDIUM = 'compendium';

/** The repos stamped with the train tag, in release order; the presets among them are what a repo is generated from. */
export const TRAIN_REPOS = [
  'primitives',
  'preset-repo-turbo',
  'preset-app-nextjs',
  'preset-repo-operations',
  COMPENDIUM,
] as const;

/** A train version is plain semver, no `v` prefix (§ 1.5 PLX). */
export const isTrainVersion = (v: string): boolean => /^\d+\.\d+\.\d+$/.test(v);

/**
 * The forge CLI is what opens a pull request and creates a release; an expired
 * login is found here, before anything is written.
 */
export async function preflightForge(ctx: Context): Promise<void> {
  try {
    await ctx.read('gh', ['auth', 'status']);
  } catch {
    throw new Error('gh is not logged in (gh auth status failed) — run gh auth login first');
  }
}

/** A mistake in the arguments, as opposed to a failed run: exit code 2 in the CLI. */
export class UsageError extends Error {}
