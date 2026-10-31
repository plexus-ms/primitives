// propagate: bring every consumer of the presets up to a train (§ 3 PLX-Updates),
// as one pull request per consumer.
//
// Each consumer is cloned from its origin at the branch the train lands on
// (consumers.ts) into a scratch directory; there `copier update` runs at the
// version plx pins (copier.ts) at every site (the repo root, then its apps/*),
// the marker is synced to the answers file, the lockfile refreshed where
// manifests moved, the hand-owned workflows pinned to the train; then one
// commit, pushed as `train/<version>`, and a pull request against the branch.
// A conflict is committed with its markers and reported, and the pull request
// is opened all the same: that is where it gets resolved. Propagation never
// aborts the run: a failing or conflicting consumer is recorded and the rest
// continues; the summary says what needs a human. Reviewing and merging the
// pull requests stays human.
//
// The dry run is an honest preview: the same clones, copier-updated from the
// LOCAL preset checkout at main, so the diff and any conflicts show before a
// tag exists; nothing is committed, pushed or opened. The scratch work goes
// through `Context.stage`: performed in every mode, since nothing the operator
// owns changes.
//
//   plx propagate ~/dev                   # to the current train
//   plx -n propagate ~/dev                # preview in scratch clones
//   plx -y propagate ~/dev --train 0.66.0 # unattended: copier takes defaults
import { join, relative } from 'node:path';
import { bumpWorkflowRefs, hasConflictMarkers, hasUnmergedEntries, syncMarker, WORKFLOW_REF } from './bookkeeping.ts';
import { type Consumer, findConsumers, presetSource, type Site } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, copierVia, parseAnswers } from './copier.ts';
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
  /** Sites whose update exited nonzero, consumers that could not be cloned or pushed, and lockfiles that failed to refresh. */
  failed: string[];
  /** Consumers left untouched, with the reason. */
  skipped: { path: string; reason: string }[];
  /** The pull requests opened or updated, one per consumer that changed. */
  pulls: string[];
}

/** True when nothing in the summary needs a human but the pull requests. */
export const isClean = (s: Summary): boolean =>
  s.conflicted.length === 0 && s.failed.length === 0 && s.skipped.length === 0;

const BASE_TAG = 'ship-base';
const trainBranch = (train: string): string => `train/${train}`;

/**
 * copier at the version plx pins, through mise, with the clone's own mise
 * config ignored: copier needs no project tool, and a root `mise.toml` left
 * with conflict markers by the root site's update would otherwise fail every
 * later mise call in the clone, the apps' updates first of all.
 */
const copierIn = (clone: string, args: string[]): [string, string[]] => [
  'env',
  [`MISE_IGNORED_CONFIG_PATHS=${clone}`, 'mise', ...copierVia(args)],
];

export async function propagate(ctx: Context, workspace: string, train: string): Promise<Summary> {
  const summary: Summary = {
    train,
    preview: ctx.dryRun,
    clean: [],
    conflicted: [],
    failed: [],
    skipped: [],
    pulls: [],
  };
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
  for (const preset of presets)
    if (!consumers.some((c) => c.sites.some((s) => s.preset === preset)))
      ctx.say(`• no consumers of ${presetSource(preset)} found under ${workspace}`);

  const scratch = (await ctx.stage(run('mktemp', ['-d'])))?.trim() ?? '';
  try {
    for (const consumer of consumers) {
      if (consumer.skipped || !consumer.origin) continue;
      const clone = join(scratch, consumer.rel);
      ctx.say(`→ ${consumer.rel}: clone ${consumer.origin} at ${consumer.branch}`);
      try {
        await ctx.stage(run('git', ['clone', '--quiet', '--branch', consumer.branch, consumer.origin, clone]));
        await ctx.stage(run('git', ['tag', BASE_TAG], { cwd: clone }));
      } catch (error) {
        ctx.say(`  ✗ FAILED — clone${detail(error)}`);
        summary.failed.push(consumer.rel);
        continue;
      }
      for (const site of consumer.sites) await updateSite(ctx, consumer, site, clone, upstream, summary);
      await refreshLockfile(ctx, consumer, clone, summary);
      await bumpConsumerRefs(ctx, consumer, clone, train);
      await openPull(ctx, consumer, clone, train, summary);
    }
  } finally {
    if (scratch) await ctx.stage(run('rm', ['-rf', scratch]));
  }
  return summary;
}

// Preview commits are plain plumbing on a throwaway clone: unsigned, no hooks, a stand-in identity.
const previewCommit = (ctx: Context, clone: string, message: string) =>
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

async function updateSite(
  ctx: Context,
  consumer: Consumer,
  site: Site,
  clone: string,
  upstream: string,
  summary: Summary,
): Promise<void> {
  const target = join(clone, relative(consumer.path, site.path));
  const localPreset = join(upstream, site.preset);
  try {
    if (ctx.dryRun) {
      ctx.say(`→ ${site.rel}: copier update (preview from ${localPreset}@main)`);
      // Point the clone's answers at the local preset so the preview reads it;
      // copier refuses a dirty subproject, hence the commit.
      const answers = await ctx.readFile(join(target, ANSWERS_FILE));
      await ctx.stage(
        write(join(target, ANSWERS_FILE), answers.replace(/^_src_path: .*$/m, `_src_path: ${localPreset}`)),
      );
      await previewCommit(ctx, clone, `plx preview: ${site.rel} reads ${localPreset} from the local checkout`);
      await ctx.stage(
        run(
          ...copierIn(clone, [
            'update',
            '--skip-answered',
            '--trust',
            '--defaults',
            '--skip-tasks',
            '--vcs-ref',
            'main',
          ]),
          {
            cwd: target,
          },
        ),
      );
    } else {
      ctx.say(`→ ${site.rel}: copier update`);
      // Template tasks (mise install, hook setup) serve a developer's checkout,
      // not a pull request. Unattended, a new question takes its default; on a
      // terminal copier asks.
      const args = ['update', '--skip-answered', '--trust', '--skip-tasks', ...(ctx.yes ? ['--defaults'] : [])];
      await ctx.apply([run(...copierIn(clone, args), { cwd: target, interactive: true })]);
    }
  } catch (error) {
    ctx.say(`  ✗ FAILED — copier update exited nonzero${detail(error)}`);
    summary.failed.push(site.rel);
    return;
  }

  // copier applies the template diff with `git apply --3way`, which leaves
  // unmerged index entries and inline markers when a hunk does not apply.
  // Scoped to the site: the root site's changes are still in the tree when
  // its apps are updated.
  const status = await ctx.read('git', ['status', '--porcelain', '--', '.'], { cwd: target });
  let conflict = hasUnmergedEntries(status);
  const changed = (await ctx.read('git', ['diff', '--name-only', '--relative', '--', '.'], { cwd: target }))
    .split('\n')
    .filter(Boolean);
  for (const f of changed) {
    const text = await ctx.readFile(join(target, f)).catch(() => '');
    if (hasConflictMarkers(text)) conflict = true;
  }

  await syncSiteMarker(ctx, site, target);

  if (conflict) {
    ctx.say('  ✗ CONFLICTS — committed with their <<<<<<< markers, to resolve in the pull request:');
    summary.conflicted.push(site.rel);
  } else {
    ctx.say('  ✓ merged clean:');
    summary.clean.push(site.rel);
  }
  for (const line of status.split('\n').filter(Boolean)) ctx.say(`    ${line}`);
  // Each preview site is committed so the next site's answers rewrite starts from a clean tree.
  if (ctx.dryRun) await previewCommit(ctx, clone, `plx preview: ${site.rel} updated`);
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
  await ctx.stage(write(join(target, MARKER_FILE), synced));
}

/** Refresh the lockfile when the updates touched a manifest (`mise exec` trusts the clone's config on its own). */
async function refreshLockfile(ctx: Context, consumer: Consumer, clone: string, summary: Summary): Promise<void> {
  if ((await ctx.readFile(join(clone, 'pnpm-workspace.yaml')).catch(() => undefined)) === undefined) return;
  const manifests = ['*package.json', 'pnpm-workspace.yaml'];
  const unchanged = await ctx
    .read('git', ['diff', '--quiet', BASE_TAG, '--', ...manifests], { cwd: clone })
    .then(() => true)
    .catch(() => false);
  if (unchanged) return;
  ctx.say(`→ ${consumer.rel}: pnpm install (manifests changed)`);
  try {
    await ctx.apply([run('mise', ['exec', '--', 'pnpm', 'install', '--reporter=silent'], { cwd: clone })]);
  } catch (error) {
    ctx.say(`  ✗ pnpm install failed${detail(error)}`);
    summary.failed.push(`${consumer.rel}/pnpm-lock.yaml`);
  }
}

/** Consumers' hand-owned workflows pin the reusable workflows by tag; lockstep them to the train. */
async function bumpConsumerRefs(ctx: Context, consumer: Consumer, clone: string, train: string): Promise<void> {
  const dir = join(clone, '.github', 'workflows');
  const entries = await ctx.readDir(dir).catch(() => []);
  const files = entries
    .filter((e) => !e.directory && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const f of files) {
    const text = await ctx.readFile(join(dir, f));
    if (!text.includes(WORKFLOW_REF)) continue;
    const bumped = bumpWorkflowRefs(text, train);
    if (bumped === text) continue;
    ctx.say(`→ ${consumer.rel}: ${f} workflow refs → @${train}`);
    await ctx.stage(write(join(dir, f), bumped));
  }
}

/**
 * One commit, the train branch pushed, and a pull request against the
 * consumer's branch: opened once, found again on a re-run. The branch is plx's
 * own, so a re-run may move it, with a lease on what it fetched.
 */
async function openPull(ctx: Context, consumer: Consumer, clone: string, train: string, summary: Summary) {
  const branch = trainBranch(train);
  if (ctx.dryRun) {
    ctx.say(
      `  (preview) ${consumer.rel}: would commit, push ${branch} and open a pull request against ${consumer.branch}`,
    );
    return;
  }
  if ((await ctx.read('git', ['status', '--porcelain'], { cwd: clone })).trim() === '') {
    ctx.say(`• ${consumer.rel}: nothing changed — no pull request`);
    return;
  }
  const head = `${consumer.origin} ${branch}`;
  try {
    await ctx.apply([
      run('git', ['add', '-A'], { cwd: clone }),
      run('git', ['commit', '--quiet', '--no-verify', '-m', `chore: train ${train}`], { cwd: clone }),
    ]);
    // The lease needs the remote-tracking ref; a fresh clone has none for a branch it did not check out.
    await ctx
      .read('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
        cwd: clone,
      })
      .catch(() => '');
    await ctx.apply([
      run('git', ['push', '--quiet', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`], { cwd: clone }),
    ]);
  } catch (error) {
    ctx.say(`  ✗ FAILED — push to ${head}${detail(error)}`);
    summary.failed.push(consumer.rel);
    return;
  }
  const existing = (
    await ctx
      .read(
        'gh',
        [
          'pr',
          'list',
          '--head',
          branch,
          '--base',
          consumer.branch,
          '--state',
          'open',
          '--json',
          'url',
          '--jq',
          '.[0].url',
        ],
        { cwd: clone },
      )
      .catch(() => '')
  ).trim();
  if (existing) {
    ctx.say(`• ${consumer.rel}: pull request updated: ${existing}`);
    summary.pulls.push(existing);
    return;
  }
  const sites = consumer.sites.map((s) => s.rel);
  const conflicted = sites.filter((s) => summary.conflicted.includes(s));
  const body = [
    `Train ${train} (§ 1.5 PLX): \`copier update\` at ${sites.join(', ')}, the marker, the lockfile where manifests moved, and the workflow refs.`,
    conflicted.length > 0
      ? `Conflicts to resolve, committed with their markers: ${conflicted.join(', ')}.`
      : 'Merged clean at every site.',
    'Opened by `plx ship`.',
  ].join('\n\n');
  try {
    await ctx.apply([
      run(
        'gh',
        [
          'pr',
          'create',
          '--base',
          consumer.branch,
          '--head',
          branch,
          '--title',
          `chore: train ${train}`,
          '--body',
          body,
        ],
        { cwd: clone },
      ),
    ]);
  } catch (error) {
    ctx.say(`  ✗ FAILED — pull request${detail(error)}`);
    summary.failed.push(consumer.rel);
    return;
  }
  const url = (
    await ctx
      .read(
        'gh',
        [
          'pr',
          'list',
          '--head',
          branch,
          '--base',
          consumer.branch,
          '--state',
          'open',
          '--json',
          'url',
          '--jq',
          '.[0].url',
        ],
        {
          cwd: clone,
        },
      )
      .catch(() => '')
  ).trim();
  ctx.say(`• ${consumer.rel}: pull request opened${url ? `: ${url}` : ''}`);
  summary.pulls.push(url || `${consumer.rel} ${branch}`);
}

const detail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const last = message.trim().split('\n').at(-1) ?? '';
  return last && !/exited with/.test(last) ? `: ${last}` : '';
};
