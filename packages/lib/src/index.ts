// @plexus-ms/lib: the core layer of plx, usable without the CLI.
//
// A verb here is a pure planner: given what was read, it returns a Plan
// (plan.ts). The Context (context.ts) reads through an injected Io (io.ts)
// and applies plans, narrating every step; the CLI package is an adapter that
// maps argv onto this. Conventions: compendium/miscellaneous/cli-design.md.
export { Context, type Options } from './context.ts';
export { ExecError, type ExecOptions, type Io, realIo, render } from './io.ts';
export { body, describe, type Plan, run, type Step, ssh, write } from './plan.ts';
