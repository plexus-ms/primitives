// Every command of plx-dev, in the order `plx-dev --help` lists them. Same
// rules as plx's (packages/cli/src/commands/index.ts): a module exports
// `register(program)`, its action maps the arguments onto a verb and nothing
// more, and its header comment is the hand-run form of the verb.
import type { Command } from 'commander';
import { register as ship } from './ship.ts';

export const commands: ((program: Command) => void)[] = [ship];
