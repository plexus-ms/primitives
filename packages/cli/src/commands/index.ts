// Every command of plx, in the order `plx --help` lists them.
//
// A command module exports `register(program: Command): void` and declares its
// arguments and options with commander: explicit targets, never an implicit
// "current" one, and never a secret (env vars for those). Its action maps them
// onto a verb of @plexus-ms/lib through `contextOf(command)` (program.ts) and
// nothing more: the logic, the planning and the tests live in lib. --dry-run,
// --json, verbosity and --yes then apply without code of the command's own.
// Keep the module's header comment the hand-run form of the verb.
import type { Command } from 'commander';
import { register as changedApps } from './changed-apps.ts';
import { register as changeset } from './changeset.ts';
import { register as deploy } from './deploy.ts';
import { register as deployTargets } from './deploy-targets.ts';
import { register as doctor } from './doctor.ts';
import { register as overview } from './overview.ts';
import { register as propagate } from './propagate.ts';
import { register as requirements } from './requirements.ts';
import { register as ship } from './ship.ts';
import { register as update } from './update.ts';

export const commands: ((program: Command) => void)[] = [
  overview,
  doctor,
  ship,
  propagate,
  update,
  requirements,
  changeset,
  changedApps,
  deployTargets,
  deploy,
];
