// Every command of plx-ci, in the order `plx-ci --help` lists them. Same rule
// as plx: a command module maps argv onto core/ and nothing more, and the
// logic, the planning and the tests live in core/. The universal commands
// come first, in the order a run uses them, and read the strategy; `hybrid`
// holds what only that strategy needs.
import type { Command } from 'commander';
import { register as build } from './build.ts';
import { register as hybrid } from './hybrid.ts';
import { register as plan } from './plan.ts';
import { register as publish } from './publish.ts';
import { register as registry } from './registry.ts';
import { register as report } from './report.ts';
import { register as test } from './test.ts';

export const commands: ((program: Command) => void)[] = [registry, plan, build, test, publish, report, hybrid];
