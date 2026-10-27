// The commander program: global options, help, and the command registry.
//
// plx is an adapter: argv in, @plexus-ms/lib does the work. Global options are
// read once into a lib Context, which is the only way a command touches the
// world; the prompt is the one thing the CLI adds to the Io. Adding a command
// is one module under commands/ exporting `register(program)`, listed in
// commands/index.ts.
import { createRequire } from 'node:module';
import { confirm } from '@inquirer/prompts';
import { Context, type Options, realIo } from '@plexus-ms/lib';
import { Command, Option } from 'commander';
import { commands } from './commands/index.ts';

const { version, description } = createRequire(import.meta.url)('../package.json') as {
  version: string;
  description: string;
};

export function buildProgram(): Command {
  const program = new Command('plx')
    .description(description)
    .version(version, '-V, --version')
    .showHelpAfterError('(run with --help for usage)')
    .showSuggestionAfterError()
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  // Globals, read into a Context by contextOf(). Flags win over PLX_* env vars
  // (precedence: flags > env > defaults; there is no config file, by design).
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
