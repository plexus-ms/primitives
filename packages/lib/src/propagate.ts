// propagate: bring every consumer of the presets up to a train (§ 3 PLX-Updates).
//
// `copier update` at every consumer site in the workspace (tenant repo roots
// and their apps/*), then the marker synced to the answers file, lockfiles
// refreshed where manifests moved, and the consumers' hand-owned workflows
// pinned to the train. A consumer is touched only on its expected branch and
// with no tracked modifications (consumers.ts). Propagation never aborts the
// run: a failing or conflicting site is recorded and the rest continues; the
// summary says what needs a human. Reviewing diffs and committing the
// consumers stays human.
//
// The dry run is an honest preview: each consumer is cloned into a scratch
// directory and copier-updated there from the LOCAL preset checkout at main,
// so the diff and any conflicts show before a tag exists. That scratch work
// goes through `Context.stage`: performed in every mode, since nothing the
// operator owns changes.
//
//   plx propagate ~/dev                   # to the current train
//   plx -n propagate ~/dev                # preview in scratch clones
//   plx -y propagate ~/dev --train 0.66.0 # unattended: copier takes defaults
import { join, relative } from 'node:path';
import { bumpWorkflowRefs, hasConflictMarkers, hasUnmergedEntries, syncMarker, WORKFLOW_REF } from './bookkeeping.ts';
import { type Consumer, findConsumers, presetSource, type Site } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, parseAnswers } from './copier.ts';
import { MARKER_FILE } from './marker.ts';
import { overview } from './overview.ts';
import { run, write } from './plan.ts';
import { TRAIN_REPOS, UPSTREAM } from './train.ts';

export interface Summary {
  train: string;
  /** True for a dry run: nothing in the workspace changed. */
  preview: boolean;
  /** Sites, relative to the workspace. */
  clean: string[];
  conflicted: string[];
  /** Sites whose update exited nonzero, and lockfiles that failed to refresh. */
  failed: string[];
  /** Consumers left untouched, with the reason. */
  skipped: { path: string; reason: string }[];
}

/** True when nothing in the summary needs a human. */
export const isClean = (s: Summary): boolean =>
  s.conflicted.length === 0 && s.failed.length === 0 && s.skipped.length === 0;

const PREVIEW_BASE = 'ship-base';

export async function propagate(ctx: Context, workspace: string, train: string): Promise<Summary> {
  const summary: Summary = { train, preview: ctx.dryRun, clean: [], conflicted: [], failed: [], skipped: [] };
  const upstream = join(workspace, UPSTREAM);
  const tree = await overview(ctx, workspace);
  const upstreamDir = tree.children.find((c) => c.path === upstream);
  const presets = TRAIN_REPOS.filter((r) => upstreamDir?.children.some((c) => c.name === r && c.template));

  const consumers = await findConsumers(ctx, tree, presets);
  for (const c of consumers) {
    if (!c.skipped) continue;
    ctx.say(`⚠ ${c.rel}: ${c.skipped} — skipped (fix it, then re-run propagate)`);
    summary.skipped.push({ path: c.rel, reason: c.skipped });
  }
  const active = consumers.filter((c) => !c.skipped);

  const scratch = ctx.dryRun ? (await ctx.stage(run('mktemp', ['-d'])))?.trim() : undefined;
  const clones = new Map<string, string>();
  /** The preview clone of a consumer, made on first use, with the base marked for diffing manifests. */
  const cloneOf = async (consumer: Consumer): Promise<string> => {
    let clone = clones.get(consumer.path);
    if (!clone) {
      clone = join(scratch ?? '', consumer.rel);
      await ctx.stage(run('git', ['clone', '--quiet', consumer.path, clone]));
      await ctx.stage(run('git', ['tag', PREVIEW_BASE], { cwd: clone }));
      clones.set(consumer.path, clone);
    }
    return clone;
  };
  // Preview commits are plain plumbing on a throwaway clone: unsigned, no hooks, a stand-in identity.
  const previewCommit = (clone: string, message: string) =>
    ctx
      .stage(run('git', ['add', '-A'], { cwd: clone }))
      .then(() =>
        ctx.stage(
          run(
            'git',
            [
              '-c',
              'commit.gpgsign=false',
              '-c',
              'user.name=plx',
              '-c',
              'user.email=plx@localhost',
              'commit',
              '--quiet',
              '--no-verify',
              '--allow-empty',
              '-m',
              message,
            ],
            { cwd: clone },
          ),
        ),
      );

  try {
    for (const preset of presets) {
      const sites = active.flatMap((c) => c.sites.filter((s) => s.preset === preset).map((s) => [c, s] as const));
      if (sites.length === 0) ctx.say(`• no consumers of ${presetSource(preset)} found under ${workspace}`);
      for (const [consumer, site] of sites)
        await updateSite(ctx, consumer, site, join(upstream, preset), summary, cloneOf, previewCommit);
    }
    await refreshLockfiles(ctx, active, summary, clones);
    await bumpConsumerRefs(ctx, consumers, train);
  } finally {
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
  return summary;
}

async function updateSite(
  ctx: Context,
  consumer: Consumer,
  site: Site,
  localPreset: string,
  summary: Summary,
  cloneOf: (c: Consumer) => Promise<string>,
  previewCommit: (clone: string, message: string) => Promise<unknown>,
): Promise<void> {
  // The repo the update lands in and the site inside it: the consumer and the
  // site themselves, or their counterparts in the preview clone.
  let repo = consumer.path;
  let target = site.path;
  try {
    if (ctx.dryRun) {
      ctx.say(`→ ${site.rel}: copier update (preview from ${localPreset}@main)`);
      repo = await cloneOf(consumer);
      target = join(repo, relative(consumer.path, site.path));
      // Point the clone's answers at the local preset so the preview reads it;
      // copier refuses a dirty subproject, hence the commit. Template tasks
      // (mise install, hook setup) are the real run's business.
      const answers = await ctx.readFile(join(site.path, ANSWERS_FILE));
      await ctx.stage(
        write(join(target, ANSWERS_FILE), answers.replace(/^_src_path: .*$/m, `_src_path: ${localPreset}`)),
      );
      await previewCommit(repo, `plx preview: ${site.rel} reads ${localPreset} from the local checkout`);
      await ctx.stage(
        run('copier', ['update', '--skip-answered', '--trust', '--defaults', '--skip-tasks', '--vcs-ref', 'main'], {
          cwd: target,
        }),
      );
    } else {
      ctx.say(`→ ${site.rel}: copier update`);
      // Unattended, a new question takes its default; on a terminal copier asks.
      const args = ['update', '--skip-answered', '--trust', ...(ctx.yes ? ['--defaults'] : [])];
      await ctx.apply([run('copier', args, { cwd: target, interactive: true })]);
    }
  } catch (error) {
    ctx.say(`  ✗ FAILED — copier update exited nonzero${detail(error)}`);
    summary.failed.push(site.rel);
    return;
  }

  // copier applies the template diff with `git apply --3way`, which leaves
  // unmerged index entries and inline markers when a hunk does not apply.
  const status = await ctx.read('git', ['status', '--porcelain'], { cwd: repo });
  let conflict = hasUnmergedEntries(status);
  const changed = (await ctx.read('git', ['diff', '--name-only'], { cwd: repo })).split('\n').filter(Boolean);
  for (const f of changed) {
    const text = await ctx.readFile(join(repo, f)).catch(() => '');
    if (hasConflictMarkers(text)) conflict = true;
  }

  await syncSiteMarker(ctx, site, target);

  if (conflict) {
    ctx.say('  ✗ CONFLICTS — resolve the <<<<<<< markers, then git add:');
    summary.conflicted.push(site.rel);
  } else {
    ctx.say('  ✓ merged clean:');
    summary.clean.push(site.rel);
  }
  for (const line of status.split('\n').filter(Boolean)) ctx.say(`    ${line}`);
  // Each preview site is committed in the clone so the next site's status lists only its own changes.
  if (ctx.dryRun) await previewCommit(repo, `plx preview: ${site.rel} updated`);
}

/** The marker's `plexus` follows the answers file's `_commit` after an update (bookkeeping.ts). */
async function syncSiteMarker(ctx: Context, site: Site, target: string): Promise<void> {
  const marker = await ctx.readFile(join(target, MARKER_FILE)).catch(() => undefined);
  if (marker === undefined) return;
  const { commit } = parseAnswers(await ctx.readFile(join(target, ANSWERS_FILE)));
  if (!commit) return;
  const synced = syncMarker(marker, commit);
  if (synced === marker) return;
  ctx.say(`  marker: plexus → ${commit} in ${site.rel}/${MARKER_FILE}`);
  const step = write(join(target, MARKER_FILE), synced);
  if (ctx.dryRun) await ctx.stage(step);
  else await ctx.apply([step]);
}

/** Refresh the lockfile once per consumer whose manifests the updates touched. */
async function refreshLockfiles(
  ctx: Context,
  consumers: Consumer[],
  summary: Summary,
  clones: Map<string, string>,
): Promise<void> {
  const manifests = ['*package.json', 'pnpm-workspace.yaml'];
  for (const c of consumers) {
    if ((await ctx.readFile(join(c.path, 'pnpm-workspace.yaml')).catch(() => undefined)) === undefined) continue;
    const repo = ctx.dryRun ? clones.get(c.path) : c.path;
    if (!repo) continue;
    const range = ctx.dryRun ? [PREVIEW_BASE] : [];
    const unchanged = await ctx
      .read('git', ['diff', '--quiet', ...range, '--', ...manifests], { cwd: repo })
      .then(() => true)
      .catch(() => false);
    if (unchanged) continue;
    ctx.say(`→ ${c.rel}: pnpm install (manifests changed)`);
    try {
      await ctx.apply([run('mise', ['exec', '--', 'pnpm', 'install', '--reporter=silent'], { cwd: c.path })]);
    } catch (error) {
      ctx.say(`  ✗ pnpm install failed${detail(error)}`);
      summary.failed.push(`${c.rel}/pnpm-lock.yaml`);
    }
  }
}

/** Consumers' hand-owned workflows pin ci-cd by tag; lockstep them to the train. */
async function bumpConsumerRefs(ctx: Context, consumers: Consumer[], train: string): Promise<void> {
  for (const c of consumers) {
    const dir = join(c.path, '.github', 'workflows');
    const entries = await ctx.readDir(dir).catch(() => []);
    const files = entries
      .filter((e) => !e.directory && /\.ya?ml$/.test(e.name))
      .map((e) => e.name)
      .sort();
    if (files.length === 0) continue;
    if (c.skipped) {
      ctx.say(`⚠ ${c.rel}: workflow refs not bumped (skipped above)`);
      continue;
    }
    for (const f of files) {
      const text = await ctx.readFile(join(dir, f));
      if (!text.includes(WORKFLOW_REF)) continue;
      const bumped = bumpWorkflowRefs(text, train);
      if (bumped === text) continue;
      ctx.say(`→ ${c.rel}: ${f} ci-cd refs → @${train}`);
      await ctx.apply([write(join(dir, f), bumped)]);
    }
  }
}

const detail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const last = message.trim().split('\n').at(-1) ?? '';
  return last && !/exited with/.test(last) ? `: ${last}` : '';
};
