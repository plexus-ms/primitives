// The summary of a run that takes a train in one or more repos (update,
// propagate) or previews one (the dry run of `plx-dev ship`), rendered for a
// human: one line per site, the pull requests, the line that merges the clean
// ones, then the verdict. Every tool that prints a Summary prints it this way.
import { isClean, type Summary } from './take.ts';

/**
 * One line to paste that merges the given pull requests, each with a merge
 * commit and its branch deleted: `gh pr merge -md -R <org>/<repo> <number>`,
 * chained so that the first refusal stops the rest. plx merges nothing itself.
 */
export function mergeLine(urls: string[]): string {
  return urls
    .map((url) => /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url))
    .filter((m) => m !== null)
    .map((m) => `gh pr merge -md -R ${m[1]} ${m[2]}`)
    .join(' && ');
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
  const merge = s.preview ? '' : mergeLine(s.mergeable);
  if (merge) lines.push('  the clean ones, to merge once their checks pass:', `  ${merge}`);
  const clean = isClean(s);
  // A run that took no train (resting, already there, its branch on origin already) has nothing to run for real.
  const idle = clean && s.clean.length === 0;
  if (s.preview && !idle) {
    lines.push('  (preview only — nothing was changed)');
    if (clean) lines.push(`✓ dry run clean — run it for real: ${realCommand}`);
  } else if (clean) {
    lines.push(s.pulls.length > 0 ? '✓ done — review and merge the pull requests' : '✓ done — no pull request');
  }
  if (!clean) lines.push(`✗ needs attention — see above; fix the repo, then re-run ${verb}`);
  return lines.join('\n');
}
