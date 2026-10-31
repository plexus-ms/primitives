// plx doctor [dir]: the staleness check (§ 13.4 PLX).
//
// lib's `diagnose` does the work; this file finds the compendium, maps the
// arguments and renders the report: one line per declaration, `✓` when
// current and complete, `✗` with its findings otherwise, and a summary. Exit
// code 1 when anything is stale. -q keeps the findings and the summary only.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diagnose, overview, type Report, readCatalog } from '@plexus-ms/lib';
import type { Command } from 'commander';
import { contextOf } from '../program.ts';
import { colorByDefault, type Style, style } from '../style.ts';

/** Where the compendium sits in the maintainers' workspace, relative to the scanned directory. */
const WORKSPACE_COMPENDIUM = 'plexus-ms/compendium';

export function register(program: Command): void {
  program
    .command('doctor')
    .description('check every PLEXUS.md under a directory for modules that changed since and dependencies not declared')
    .argument('[dir]', 'directory to check', '.')
    .option(
      '--compendium <path>',
      `compendium checkout to read the modules from (default: <dir>/${WORKSPACE_COMPENDIUM})`,
    )
    .option('--color', 'colour the report even when piped')
    .option('--no-color', 'never colour the report')
    .action(async (dir: string, opts: { compendium?: string; color?: boolean }, command: Command) => {
      const ctx = contextOf(command);
      const root = resolve(dir);
      const compendium = resolve(opts.compendium ?? join(root, WORKSPACE_COMPENDIUM));
      if (!existsSync(join(compendium, 'contracts')))
        throw new Error(
          `no compendium at ${compendium}; pass --compendium <path to a checkout of plexus-ms/compendium>`,
        );
      const catalog = await readCatalog(ctx, compendium);
      const report = diagnose(await overview(ctx, root, { git: false }), catalog);
      const s = style(opts.color ?? colorByDefault());
      ctx.result(report, (r) => renderReport(r, s, !ctx.quiet));
      if (report.stale > 0 || report.declarations.length === 0) process.exitCode = 1;
    });
}

export function renderReport(report: Report, s: Style, showCurrent: boolean): string {
  const lines: string[] = [];
  for (const d of report.declarations) {
    if (d.findings.length === 0) {
      if (showCurrent) lines.push(`${s.ok('✓')} ${d.path}: ${d.plexus} ${s.dim(`[${d.modules.join(', ')}]`)}`);
      continue;
    }
    for (const f of d.findings) lines.push(`${s.warn('✗')} ${d.path}: ${f}`);
  }
  const n = report.declarations.length;
  if (n === 0) lines.push(s.warn('✗ no PLEXUS.md marker found'));
  else if (report.stale > 0) lines.push(s.warn(`✗ ${report.stale} of ${n} declarations stale or incomplete`));
  else lines.push(s.ok(`✓ ${n} declarations current and complete`));
  return lines.join('\n');
}
