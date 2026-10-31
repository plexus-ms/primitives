// plx ship [dir]: release the train and propagate it (§ 1.5 PLX).
//
// lib's `ship` does the work: preflight, bookkeeping, tags, releases, the
// wait for npm, then `propagate`, which opens one pull request per consumer.
// This file maps the arguments and renders the summary; the exit code is 0
// only when nothing needs a human but the pull requests. -n previews the
// release as its steps and the propagation in scratch clones; -y is required
// off a terminal.
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
      'release the train: tag and release every train repo identically, then open a pull request per consumer',
    )
    .argument('[dir]', 'the workspace: plexus-ms/ and the consumers sit under it', '.')
    .option('--train <version>', 'the train version, plain semver (default: minor+1 over the latest train)')
    .action(async (dir: string, opts: { train?: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await ship(ctx, { workspace: resolve(dir), train: opts.train, plx: version });
      ctx.result(result, (r) => renderSummary(r, `plx -y ship --train ${r.train} ${dir}`));
      if (!isClean(result)) process.exitCode = 1;
    });
}

/** The summary: one line per site, the pull requests, then the verdict. */
export function renderSummary(s: Summary, realCommand: string): string {
  const lines = ['── summary ──────────────────────────────────────────────────────────────'];
  for (const p of s.clean) lines.push(`  ✓ clean:      ${p}`);
  for (const p of s.conflicted) lines.push(`  ✗ conflicts:  ${p}`);
  for (const p of s.failed) lines.push(`  ✗ failed:     ${p}`);
  for (const { path, reason } of s.skipped) lines.push(`  ⚠ skipped:    ${path} (${reason})`);
  for (const url of s.pulls) lines.push(`  → pull:       ${url}`);
  const clean = isClean(s);
  if (s.preview) {
    lines.push('  (preview only — nothing was changed)');
    if (clean) lines.push(`✓ dry run clean — run it for real: ${realCommand}`);
  } else if (clean) {
    lines.push('✓ done — review and merge the pull requests');
  }
  if (!clean) lines.push('✗ needs attention — see above; fix the consumer, then re-run propagate');
  return lines.join('\n');
}
