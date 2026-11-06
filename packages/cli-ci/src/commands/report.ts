// plx-ci report --mode <mode> <matrix-json>: what the registry holds after a
// build run, every app's digest and, in repro mode, the two builds of each
// app compared layer by layer (§ 4 PLX-Delivery). Needs the registry
// reachable here (`plx-ci registry`). From the environment: CI_STRATEGY,
// CI_REGISTRY, GITHUB_RUN_ID.
//
//   plx-ci report --mode repro "$MATRIX"
import type { Command } from 'commander';
import { type Leg, type Mode, report } from '../core/plan.ts';
import { contextOf } from '../program.ts';
import { need, registryFor, settings, withStrategy } from './shared.ts';

export function register(program: Command): void {
  withStrategy(program.command('report'))
    .description('the digests the registry holds for a run’s matrix, and in repro mode the layer-by-layer comparison')
    .argument('<matrix>', 'the plan’s matrix, JSON')
    .requiredOption('--mode <mode>', 'build, force or repro')
    .action(async (matrix: string, opts: { strategy?: string; mode: Mode }, command: Command) => {
      const ctx = contextOf(command);
      const legs = JSON.parse(matrix) as Leg[];
      const result = await report(ctx, registryFor(settings(opts)), legs, opts.mode, need('GITHUB_RUN_ID'));
      // The report narrates every digest and difference as it reads them; the
      // result repeats nothing unless asked for as JSON.
      ctx.result(result, () => '');
    });
}
