// A Plan is what a command decides to do, as data: the effects, in order.
//
// A command's core computes a Plan from what it read (pure, testable by
// comparing plans), the Context applies it (context.ts). Printing a plan is
// the dry run; applying it is the real run; both come from the one Plan, so
// they cannot drift. Describing a step gives the exact shell a stranded
// operator would type instead.
import { render } from './io.ts';

export type Step =
  | { kind: 'run'; command: string; args: string[]; cwd?: string; input?: string; interactive?: boolean }
  | { kind: 'write'; path: string; content: string };

export type Plan = Step[];

export const run = (
  command: string,
  args: string[] = [],
  options: { cwd?: string; input?: string; interactive?: boolean } = {},
): Step => ({
  kind: 'run',
  command,
  args,
  ...options,
});

export const write = (path: string, content: string): Step => ({ kind: 'write', path, content });

/** One line, the shell equivalent of the step. */
export function describe(step: Step): string {
  switch (step.kind) {
    case 'run':
      return `$ ${step.cwd ? `(cd ${step.cwd} && ` : ''}${render(step.command, step.args)}${step.cwd ? ')' : ''}`;
    case 'write':
      return `> ${step.path} (${Buffer.byteLength(step.content)} bytes)`;
  }
}

/** What a step feeds in, shown at higher verbosity under its description. */
export function body(step: Step): string | undefined {
  switch (step.kind) {
    case 'run':
      return step.input;
    case 'write':
      return step.content;
  }
}
