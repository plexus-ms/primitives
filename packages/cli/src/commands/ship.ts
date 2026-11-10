// plx ship [dir]: cut the train (§ 1.5 PLX), and nothing after it.
//
// lib's `ship` does the work: preflight, bookkeeping, tags, releases, the
// wait for npm. It opens no pull request: a repo takes the train itself, when
// it needs it (`plx update`), and `plx propagate --now` asks many at once.
// This file maps the arguments and renders the outcome. -n previews the
// release as its steps and tries the unreleased presets on the workspace's
// consumers in scratch clones, with a summary; -y is required off a terminal.
//
//   plx ship ~/dev                 # next train = minor+1 over the latest
//   plx -n ship ~/dev              # preview, change nothing in the workspace
//   plx -y ship ~/dev --train 1.0.0
import { resolve } from 'node:path';
import { isClean, type Summary, ship } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf, version } from '../program.ts';

export function register(program: Command): void {
  program
    .command('ship')
    .description(
      'cut the train: tag and release every train repo identically; repos take it themselves (update, propagate)',
    )
    .argument('[dir]', 'the workspace: plexus-ms/ sits under it, and the consumers the dry run previews', '.')
    .option('--train <version>', 'the train version, plain semver (default: minor+1 over the latest train)')
    .action(async (dir: string, opts: { train?: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await ship(ctx, { workspace: resolve(dir), train: opts.train, plx: version });
      ctx.result(result, (r) =>
        r.preview
          ? renderSummary(r, `plx -y ship --train ${r.train} ${dir}`, 'ship')
          : `✓ train ${r.train} cut — repos take it themselves; to take it now where it matters: plx propagate --now ${dir}`,
      );
      if (!isClean(result)) process.exitCode = 1;
    });
}

/** The summary: one line per site, the pull requests, then the verdict. */
export function renderSummary(s: Summary, realCommand: string, verb = 'propagate'): string {
  const lines = ['── summary ──────────────────────────────────────────────────────────────'];
  for (const p of s.clean) lines.push(`  ✓ clean:      ${p}`);
  for (const p of s.conflicted) lines.push(`  ✗ conflicts:  ${p}`);
  for (const p of s.failed) lines.push(`  ✗ failed:     ${p}`);
  for (const { path, reason } of s.skipped) lines.push(`  ⚠ skipped:    ${path} (${reason})`);
  for (const { path, reason } of s.resting) lines.push(`  • resting:    ${path} (${reason})`);
  for (const url of s.pulls) lines.push(`  → pull:       ${url}`);
  const clean = isClean(s);
  // A run that took no train (resting, already there) has nothing to run for real.
  const idle = clean && s.clean.length === 0 && s.pulls.length === 0;
  if (s.preview && !idle) {
    lines.push('  (preview only — nothing was changed)');
    if (clean) lines.push(`✓ dry run clean — run it for real: ${realCommand}`);
  } else if (clean) {
    lines.push(s.pulls.length > 0 ? '✓ done — review and merge the pull requests' : '✓ done — no pull request');
  }
  if (!clean) lines.push(`✗ needs attention — see above; fix the repo, then re-run ${verb}`);
  return lines.join('\n');
}
