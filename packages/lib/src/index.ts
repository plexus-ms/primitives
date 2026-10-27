// @plexus-ms/lib: the core layer of plx, usable without the CLI.
//
// A verb here is either a reader returning data, or a pure planner returning
// a Plan (plan.ts) from what was read. The Context (context.ts) reads through
// an injected Io (io.ts) and applies plans, narrating every step; the CLI
// package is an adapter that maps argv onto this. The parsers of Plexus's own
// file shapes (marker.ts, copier.ts) live here, once, for every verb.
// Conventions: compendium/miscellaneous/cli-design.md.
export { Context, type Options } from './context.ts';
export { ANSWERS_FILE, type Answers, parseAnswers, TEMPLATE_FILES } from './copier.ts';
export { type DirEntry, ExecError, type ExecOptions, type Io, realIo, render } from './io.ts';
export { type Declaration, MARKER_FILE, parseMarker, splitFrontmatter } from './marker.ts';
export {
  type Directory,
  type GitFacet,
  isNotable,
  type Kind,
  kindOf,
  shortRemote,
  type TemplateFacet,
} from './model.ts';
export { overview, PRUNED } from './overview.ts';
export { body, describe, type Plan, run, type Step, ssh, write } from './plan.ts';
