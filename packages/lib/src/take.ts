// take: one repo takes a train (§ 3 PLX-Updates), in a scratch checkout of the
// branch the train lands on (consumers.ts). `copier update` runs at the
// version plx pins (copier.ts) at every site (the repo root, then its apps/*),
// the marker is synced to the answers file, the lockfile refreshed where
// manifests moved, the hand-owned workflows pinned to the train; then one
// commit, pushed as `plexus/<version>`, and a pull request against the branch.
// A conflict is committed with its markers and reported, and the pull request
// is opened all the same: that is where it gets resolved. Nothing here aborts
// a run: a failing or conflicting site is recorded in the summary, which says
// what needs a human. Reviewing and merging the pull request stays human.
//
// `update` (update.ts) is the verb on top of it, and the only thing that
// opens a train's pull request; `propagate` (propagate.ts) runs that verb over
// many repos. The maintainers' preview of an unreleased train (preview.ts of
// @plexus-ms/dev) uses the same steps against the local preset checkouts, and opens nothing.
import { join, relative } from 'node:path';
import { bumpWorkflowRefs, hasConflictMarkers, hasUnmergedEntries, syncMarker, WORKFLOW_REF } from './bookkeeping.ts';
import { type Consumer, presetSource, RENAMED_PRESETS, type Site } from './consumers.ts';
import type { Context } from './context.ts';
import { ANSWERS_FILE, copierVia, parseAnswers } from './copier.ts';
import { run, write } from './effects.ts';
import { MARKER_FILE } from './marker.ts';

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
  /** Repos that need no train yet and rest on the one they have (need.ts), with what would end the rest. */
  resting: { path: string; reason: string }[];
  /** The pull requests opened or updated, one per consumer that changed. */
  pulls: string[];
  /** Those of `pulls` whose repo merged clean at every site and failed nowhere: ready to merge once their checks pass. */
  mergeable: string[];
}

/** True when nothing in the summary needs a human but the pull requests. */
export const isClean = (s: Summary): boolean =>
  s.conflicted.length === 0 && s.failed.length === 0 && s.skipped.length === 0;

/** Add what one repo's run found to the summary of a run over many. */
export function mergeSummary(into: Summary, from: Summary): void {
  into.clean.push(...from.clean);
  into.conflicted.push(...from.conflicted);
  into.failed.push(...from.failed);
  into.skipped.push(...from.skipped);
  into.resting.push(...from.resting);
  into.pulls.push(...from.pulls);
  into.mergeable.push(...from.mergeable);
}

export const emptySummary = (train: string, preview: boolean): Summary => ({
  train,
  preview,
  clean: [],
  conflicted: [],
  failed: [],
  skipped: [],
  resting: [],
  pulls: [],
  mergeable: [],
});

/** What a pull request's body says when nothing in it needs a hand; read back to tell a clean one found on origin. */
export const CLEAN_BODY = 'Merged clean at every site.';

/** The entries of a summary list that belong to a consumer: itself, its sites, its lockfile. */
const ofConsumer = (list: string[], consumer: Consumer): string[] =>
  list.filter((p) => p === consumer.rel || p.startsWith(`${consumer.rel}/`));

export const trainBranch = (train: string): string => `plexus/${train}`;

/** How a consumer takes the train: the knobs the preview and update set differently. */
export interface Take {
  train: string;
  /**
   * Preview from the local preset checkouts under this upstream directory at
   * main (preview.ts of @plexus-ms/dev), instead of the published template.
   */
  previewFrom?: string;
  /** The template ref copier updates to; unset, copier takes the newest tag, which the train just cut. */
  ref?: string;
  /** Who opened the pull request, named in its body. */
  opener: string;
  /** Why the repo takes the train now (need.ts), named in the body beside the opener. */
  why?: string;
}

/**
 * copier at the version plx pins, through mise, with the consumer's own mise
 * config ignored: copier needs no project tool, and a root `mise.toml` left
 * with conflict markers by the root site's update would otherwise fail every
 * later mise call in the directory, the apps' updates first of all.
 */
const copierIn = (dir: string, args: string[]): [string, string[]] => [
  'env',
  [`MISE_IGNORED_CONFIG_PATHS=${dir}`, 'mise', ...copierVia(args)],
];

/**
 * One consumer takes the train in `dir`, a scratch checkout of its branch:
 * every site updated, the lockfile refreshed, the workflow refs bumped, then
 * the commit, the branch and the pull request.
 */
export async function takeTrain(ctx: Context, consumer: Consumer, dir: string, take: Take, summary: Summary) {
  const base = (await ctx.read('git', ['rev-parse', 'HEAD'], { cwd: dir })).trim();
  for (const site of consumer.sites) await updateSite(ctx, consumer, site, dir, take, summary);
  await refreshLockfile(ctx, consumer, dir, base, summary);
  await bumpConsumerRefs(ctx, consumer, dir, take.train);
  await openPull(ctx, consumer, dir, take, summary);
}

// Preview commits are plain plumbing on a throwaway clone: unsigned, no hooks, a stand-in identity.
const previewCommit = (ctx: Context, dir: string, message: string) =>
  ctx
    .stage(run('git', ['add', '-A'], { cwd: dir }))
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
          { cwd: dir },
        ),
      ),
    );

async function updateSite(
  ctx: Context,
  consumer: Consumer,
  site: Site,
  dir: string,
  take: Take,
  summary: Summary,
): Promise<void> {
  const target = join(dir, relative(consumer.path, site.path));
  try {
    if (take.previewFrom) {
      const localPreset = join(take.previewFrom, site.preset);
      ctx.say(`→ ${site.rel}: copier update (preview from ${localPreset}@main)`);
      // Point the answers at the local preset so the preview reads it; copier
      // refuses a dirty subproject, hence the commit.
      const answers = await ctx.readFile(join(target, ANSWERS_FILE));
      await ctx.stage(
        write(join(target, ANSWERS_FILE), answers.replace(/^_src_path: .*$/m, `_src_path: ${localPreset}`)),
      );
      await previewCommit(ctx, dir, `plx preview: ${site.rel} reads ${localPreset} from the local checkout`);
      await ctx.stage(
        run(
          ...copierIn(dir, ['update', '--skip-answered', '--trust', '--defaults', '--skip-tasks', '--vcs-ref', 'main']),
          { cwd: target },
        ),
      );
    } else {
      ctx.say(`→ ${site.rel}: copier update${take.ref ? ` to ${take.ref}` : ''}`);
      // A preset renamed on a train: the answers still name the old source,
      // which copier would clone through the forge's redirect; point them at
      // the current name first, committed because copier refuses a dirty
      // subproject.
      const answers = await ctx.readFile(join(target, ANSWERS_FILE));
      const current = presetSource(site.preset);
      const recorded = /^_src_path: (.*)$/m.exec(answers)?.[1];
      if (
        recorded &&
        recorded !== current &&
        Object.keys(RENAMED_PRESETS).some((old) => presetSource(old) === recorded)
      ) {
        ctx.say(`  ${site.rel}: the preset is ${current} now; the answers follow`);
        await ctx.stage(
          write(join(target, ANSWERS_FILE), answers.replace(/^_src_path: .*$/m, `_src_path: ${current}`)),
        );
        await previewCommit(ctx, dir, `plx: ${site.rel} reads ${current}, the preset's name since its rename`);
      }
      // Template tasks (mise install, hook setup) serve a developer's checkout,
      // not a pull request. Unattended, a new question takes its default; on a
      // terminal copier asks. A dry run previews on the scratch checkout, so
      // the step is staged there rather than only announced.
      const args = [
        'update',
        '--skip-answered',
        '--trust',
        '--skip-tasks',
        ...(take.ref ? ['--vcs-ref', take.ref] : []),
        ...(ctx.yes || ctx.dryRun ? ['--defaults'] : []),
      ];
      const step = run(...copierIn(dir, args), { cwd: target, interactive: !ctx.dryRun });
      if (ctx.dryRun) await ctx.stage(step);
      else await ctx.apply([step]);
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
  // Each preview-from-local site is committed so the next site's answers
  // rewrite starts from a clean tree. Otherwise the site is staged: a conflict
  // leaves unmerged index entries, and copier's own git plumbing (`git
  // write-tree`) refuses an index with those, so the next site's update would
  // fail; staged, the markers are in the tree and the index is whole.
  if (take.previewFrom) await previewCommit(ctx, dir, `plx preview: ${site.rel} updated`);
  else await ctx.stage(run('git', ['add', '-A'], { cwd: dir }));
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

/** Refresh the lockfile when the updates touched a manifest (`mise exec` trusts the directory's own config). */
async function refreshLockfile(ctx: Context, consumer: Consumer, dir: string, base: string, summary: Summary) {
  if ((await ctx.readFile(join(dir, 'pnpm-workspace.yaml')).catch(() => undefined)) === undefined) return;
  const manifests = ['*package.json', 'pnpm-workspace.yaml'];
  const unchanged = await ctx
    .read('git', ['diff', '--quiet', base, '--', ...manifests], { cwd: dir })
    .then(() => true)
    .catch(() => false);
  if (unchanged) return;
  ctx.say(`→ ${consumer.rel}: pnpm install (manifests changed)`);
  try {
    await ctx.apply([run('mise', ['exec', '--', 'pnpm', 'install', '--reporter=silent'], { cwd: dir })]);
  } catch (error) {
    ctx.say(`  ✗ pnpm install failed${detail(error)}`);
    summary.failed.push(`${consumer.rel}/pnpm-lock.yaml`);
  }
}

/** Consumers' hand-owned workflows pin the reusable workflows by tag; lockstep them to the train. */
async function bumpConsumerRefs(ctx: Context, consumer: Consumer, dir: string, train: string): Promise<void> {
  const workflows = join(dir, '.github', 'workflows');
  const entries = await ctx.readDir(workflows).catch(() => []);
  const files = entries
    .filter((e) => !e.directory && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const f of files) {
    const text = await ctx.readFile(join(workflows, f));
    if (!text.includes(WORKFLOW_REF)) continue;
    const bumped = bumpWorkflowRefs(text, train);
    if (bumped === text) continue;
    ctx.say(`→ ${consumer.rel}: ${f} workflow refs → @${train}`);
    await ctx.stage(write(join(workflows, f), bumped));
  }
}

/** The URL of the open pull request from the train branch against the consumer's branch, if any. */
export async function openPullUrl(ctx: Context, consumer: Consumer, dir: string, train: string): Promise<string> {
  const args = ['pr', 'list', '--head', trainBranch(train), '--base', consumer.branch, '--state', 'open'];
  return (await ctx.read('gh', [...args, '--json', 'url', '--jq', '.[0].url'], { cwd: dir }).catch(() => '')).trim();
}

/**
 * One commit, the train branch pushed, and a pull request against the
 * consumer's branch: opened once, found again on a re-run. The branch is plx's
 * own, so a re-run may move it, with a lease on what it fetched. Hooks are
 * skipped: the checks are the pull request's job, and the mount's own
 * checkout may carry the repo's hooks.
 */
async function openPull(ctx: Context, consumer: Consumer, dir: string, take: Take, summary: Summary) {
  const { train } = take;
  const branch = trainBranch(train);
  if (ctx.dryRun) {
    ctx.say(
      `  (preview) ${consumer.rel}: would commit, push ${branch} and open a pull request against ${consumer.branch}`,
    );
    return;
  }
  if ((await ctx.read('git', ['status', '--porcelain'], { cwd: dir })).trim() === '') {
    ctx.say(`• ${consumer.rel}: nothing changed — no pull request`);
    return;
  }
  const head = `${consumer.origin ?? 'origin'} ${branch}`;
  try {
    await ctx.apply([
      run('git', ['add', '-A'], { cwd: dir }),
      run('git', ['commit', '--quiet', '--no-verify', '-m', `chore: train ${train}`], { cwd: dir }),
    ]);
    // The lease needs the remote-tracking ref; a fresh clone has none for a branch it did not check out.
    await ctx
      .read('git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
        cwd: dir,
      })
      .catch(() => '');
    await ctx.apply([
      run('git', ['push', '--quiet', '--no-verify', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`], {
        cwd: dir,
      }),
    ]);
  } catch (error) {
    ctx.say(`  ✗ FAILED — push to ${head}${detail(error)}`);
    summary.failed.push(consumer.rel);
    return;
  }
  const conflicted = ofConsumer(summary.conflicted, consumer);
  const failed = ofConsumer(summary.failed, consumer);
  const clean = conflicted.length === 0 && failed.length === 0;
  const existing = await openPullUrl(ctx, consumer, dir, train);
  if (existing) {
    ctx.say(`• ${consumer.rel}: pull request updated: ${existing}`);
    summary.pulls.push(existing);
    if (clean) summary.mergeable.push(existing);
    return;
  }
  const sites = consumer.sites.map((s) => s.rel);
  const body = [
    `Train ${train} (§ 1.5 PLX): \`copier update\` at ${sites.join(', ')}, the marker, the lockfile where manifests moved, and the workflow refs.`,
    ...(conflicted.length > 0 ? [`Conflicts to resolve, committed with their markers: ${conflicted.join(', ')}.`] : []),
    ...(failed.length > 0 ? [`Failed, and left as it was: ${failed.join(', ')}.`] : []),
    ...(clean ? [CLEAN_BODY] : []),
    `Opened by ${take.opener}${take.why ? `: ${take.why}` : ''}.`,
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
        { cwd: dir },
      ),
    ]);
  } catch (error) {
    ctx.say(`  ✗ FAILED — pull request${detail(error)}`);
    summary.failed.push(consumer.rel);
    return;
  }
  const url = await openPullUrl(ctx, consumer, dir, train);
  ctx.say(`• ${consumer.rel}: pull request opened${url ? `: ${url}` : ''}`);
  summary.pulls.push(url || `${consumer.rel} ${branch}`);
  if (url && clean) summary.mergeable.push(url);
}

export const detail = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const last = message.trim().split('\n').at(-1) ?? '';
  return last && !/exited with/.test(last) ? `: ${last}` : '';
};
