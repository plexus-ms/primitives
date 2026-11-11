// The commander program of plx-dev: the global options plx has, and the
// upstream's verbs. plx-dev is the maintainers' half of the Plexus tooling
// (PLX-CLI § 1): what cuts a train, which works with no knowledge of any
// consumer. It is never published; the maintainers run it from the source of
// their primitives checkout (`mise ship` there), so the tool that releases the
// train is the code at main and never a release that lags behind it. Same
// shape as plx: argv in, a lib Context is the only way a command touches the
// world. Adding a command is one module under commands/ exporting
// `register(program)`, listed in commands/index.ts.
import { confirm } from '@inquirer/prompts';
import { Context, type Options, realIo } from '@plexus-ms/lib';
import { Command, Option } from 'commander';
import { commands } from './commands/index.ts';

export function buildProgram(): Command {
  const program = new Command('plx-dev')
    .description("the upstream's verbs of Plexus, run from the primitives checkout: cutting a train")
    .showHelpAfterError('(run with --help for usage)')
    .showSuggestionAfterError()
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  program
    .addOption(new Option('-n, --dry-run', 'print every effect this run would have, perform none').env('PLX_DRY_RUN'))
    .addOption(
      new Option('-v, --verbose', 'say more: once for reads and inputs, twice for command output')
        .argParser((_value, previous: number) => previous + 1)
        .default(0),
    )
    .addOption(new Option('-q, --quiet', 'say nothing but results and errors').env('PLX_QUIET'))
    .addOption(new Option('-y, --yes', 'answer every confirmation with yes (needed off a terminal)').env('PLX_YES'))
    .addOption(new Option('--json', 'print results as JSON').env('PLX_JSON'));

  for (const register of commands) register(program);
  return program;
}

/** The Context for a command's action, built from the root's global options. */
export function contextOf(command: Command): Context {
  const opts = command.optsWithGlobals() as Options;
  return new Context(
    opts,
    realIo((question) => confirm({ message: question, default: false })),
  );
}
