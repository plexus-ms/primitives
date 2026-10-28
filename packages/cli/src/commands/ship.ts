// plx ship [dir]: release the train and propagate it (§ 1.5 PLX).
//
// lib's `ship` does the work: preflight, bookkeeping, tags, pushes, then
// `propagate`. This file maps the arguments and renders the summary; the exit
// code is 0 only when nothing needs a human. -n previews the release as its
// steps and the propagation in scratch clones; -y is required off a terminal.
//
//   plx ship ~/dev                 # next train = minor+1 over the latest
//   plx -n ship ~/dev              # preview, change nothing in the workspace
//   plx -y ship ~/dev --train 1.0.0
import { resolve } from 'node:path';
import { isClean, type Summary, ship } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';

export function register(program: Command): void {
  program
    .command('ship')
    .description('release the train: tag every train repo identically, then copier-update every consumer')
    .argument('[dir]', 'the workspace: plexus-ms/ and the consumers sit under it', '.')
    .option('--train <version>', 'the train version, plain semver (default: minor+1 over the latest train)')
    .action(async (dir: string, opts: { train?: string }, command: Command) => {
      const ctx = contextOf(command);
      const result = await ship(ctx, { workspace: resolve(dir), train: opts.train });
      ctx.result(result, (r) => renderSummary(r, `plx -y ship --train ${r.train} ${dir}`));
      if (!isClean(result)) process.exitCode = 1;
    });
}

/** The summary as ship.sh printed it, one line per site, then the verdict. */
export function renderSummary(s: Summary, realCommand: string): string {
  const lines = ['── summary ──────────────────────────────────────────────────────────────'];
  for (const p of s.clean) lines.push(`  ✓ clean:      ${p}`);
  for (const p of s.conflicted) lines.push(`  ✗ conflicts:  ${p}`);
  for (const p of s.failed) lines.push(`  ✗ failed:     ${p}`);
  for (const { path, reason } of s.skipped) lines.push(`  ⚠ skipped:    ${path} (${reason})`);
  const clean = isClean(s);
  if (s.preview) {
    lines.push('  (preview only — nothing was changed)');
    if (clean) lines.push(`✓ dry run clean — run it for real: ${realCommand}`);
  } else if (clean) {
    lines.push('✓ done — review consumer diffs, commit (web repos on develop, platform repos on main), push');
  }
  if (!clean) lines.push('✗ needs attention — see above; fix the consumer, then re-run propagate');
  return lines.join('\n');
}
