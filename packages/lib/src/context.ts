// The Context is what a verb runs in: the options, the injected Io, and the
// three things a verb does with them.
//
//   read   look at the world; always performed, so a dry run sees real state
//   apply  perform a Plan (plan.ts); every step is narrated with its exact
//          shell line, and performed unless --dry-run
//   result print the command's product: human-readable, or JSON under --json
//
// Plan, then confirm, then apply: validation and every read happen while
// planning, so a failure there costs nothing, and by the time an effect runs
// the verb knows the whole of what it is about to do. Narration goes to
// stderr, results to stdout, so `plx <verb> | ...` composes like the script
// it replaces. Conventions: compendium/miscellaneous/cli-design.md.
import { type ExecOptions, type Io, realIo } from './io.ts';
import { body, describe, type Plan, type Step } from './plan.ts';

export interface Options {
  dryRun?: boolean;
  /** 0: every effect; 1: reads and inputs too; 2: subprocess output too. */
  verbose?: number;
  quiet?: boolean;
  yes?: boolean;
  json?: boolean;
}

export class Context {
  readonly dryRun: boolean;
  readonly verbose: number;
  readonly quiet: boolean;
  readonly yes: boolean;
  readonly json: boolean;
  readonly io: Io;

  constructor(options: Options, io: Io = realIo()) {
    this.io = io;
    this.dryRun = options.dryRun ?? false;
    this.quiet = options.quiet ?? false;
    this.verbose = this.quiet ? -1 : (options.verbose ?? 0);
    this.yes = options.yes ?? false;
    this.json = options.json ?? false;
  }

  // --- narration (stderr) ---------------------------------------------------

  /** One line, if the verbosity allows the level (0 normal, 1 verbose, 2 debug). */
  say(line: string, level = 0): void {
    if (this.verbose >= level) this.io.stderr.write(`${line}\n`);
  }

  /** A final outcome line, `✓ ...` or `✗ ...`; shown even under --quiet. */
  done(line: string, ok = true): void {
    this.io.stderr.write(`${ok ? '✓' : '✗'} ${line}\n`);
  }

  // --- results (stdout) -----------------------------------------------------

  /**
   * The command's product. `data` is what --json prints; `human` renders it
   * otherwise (default: strings as they are, arrays one item per line).
   */
  result<T>(data: T, human: (data: T) => string = renderHuman): void {
    const text = this.json ? JSON.stringify(data, null, 2) : human(data);
    this.io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  // --- reads: always performed ---------------------------------------------

  /** Run a command for its output. Changes nothing; narrated only when verbose. */
  read(command: string, args: string[] = [], options: Omit<ExecOptions, 'inherit'> = {}): Promise<string> {
    this.say(`? ${describe({ kind: 'run', command, args, ...options })}`, 1);
    return this.io.exec(command, args, options);
  }

  readFile(path: string): Promise<string> {
    this.say(`? read ${path}`, 1);
    return this.io.readFile(path);
  }

  // --- effects: narrated always, performed unless --dry-run -----------------

  /**
   * Ask before applying. `--yes` and `--dry-run` answer yes; off a terminal
   * without `--yes` the answer is an error, never a hang.
   */
  async confirm(question: string): Promise<boolean> {
    if (this.yes || this.dryRun) {
      this.say(`? ${question} yes (${this.yes ? '--yes' : '--dry-run'})`, 1);
      return true;
    }
    if (!this.io.prompt) throw new Error(`cannot ask "${question}" without a terminal; pass --yes`);
    return this.io.prompt(question);
  }

  /** Narrate and perform each step in order; the first failure stops the run. */
  async apply(plan: Plan): Promise<void> {
    for (const step of plan) {
      this.say(`${this.dryRun ? '[dry-run] ' : ''}${describe(step)}`);
      const input = body(step);
      if (input !== undefined) this.say(indent(input), step.kind === 'write' ? 2 : 1);
      if (!this.dryRun) await this.perform(step);
    }
  }

  private perform(step: Step): Promise<unknown> {
    const inherit = this.verbose >= 2;
    switch (step.kind) {
      case 'run':
        return this.io.exec(step.command, step.args, { cwd: step.cwd, input: step.input, inherit });
      case 'ssh':
        return this.io.exec('ssh', [step.host, 'bash', '-s'], { input: step.script, inherit });
      case 'write':
        return this.io.writeFile(step.path, step.content);
    }
  }
}

function renderHuman(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data.map(String).join('\n');
  return JSON.stringify(data, null, 2);
}

function indent(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}
