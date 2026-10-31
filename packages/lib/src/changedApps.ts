// changed-apps: the deployable apps whose sources changed between two git
// refs (§ 3 PLX-Delivery), dependents of a changed workspace package included,
// as a verb that reads git and the workspace manifests and nothing else.
//
// The dependents walk is pnpm's (`--filter "...[from...to]"`): the tool that
// owns the workspace graph answers for it. What pnpm cannot know is held here:
//
//   - bookkeeping is not source: the declaration marker and copier's answers
//     file change on every train, and a change to them alone deploys nothing;
//   - workspace-global inputs feed every app's build (the lockfile pins each
//     app's dependency tree, the root manifests shape every install), so a
//     change to one of them deploys every app, where pnpm's filter, which sees
//     only files inside project dirs, would deploy none;
//   - a platform repo hosts third-party apps as bare apps/<name>/ compose dirs
//     with no workspace at all; there an app changed exactly when a file under
//     its own dir did;
//   - no usable base ref (first push, force-push, new branch) means "cannot
//     diff", which degrades to "every app changed", the never-skip-a-deploy
//     default.
//
//   plx changed-apps <from> [to]          # one app per line; --json for the array
import { join } from 'node:path';
import type { Context } from './context.ts';

/** Files whose change alone deploys nothing. */
const BOOKKEEPING = /(^|\/)(PLEXUS\.md|\.copier-answers\.yml)$/;
/** Workspace-global inputs: a change to one of them deploys every app. */
const GLOBALS = /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|turbo\.json|mise\.toml|\.npmrc|\.node-version)$/;
const NO_REF = /^0*$/;

export type Reason =
  | 'no base ref: every app counts as changed'
  | 'nothing but bookkeeping changed'
  | 'a workspace-global input changed: every app counts as changed'
  | 'files under the apps changed'
  | 'sources or their dependencies changed';

export interface ChangedApps {
  apps: string[];
  reason: Reason;
}

export interface ChangedAppsInput {
  /** Whether the repo is a pnpm workspace (an app repo) or a bare platform repo. */
  workspace: boolean;
  /** Every deployable app, by dir name under apps/. */
  all: string[];
  /** The files the diff names, or undefined when the base ref is unusable. */
  changed?: string[];
  /** The apps pnpm's range filter lists as changed or depending on a change; asked only when needed. */
  dependents?: () => Promise<string[]>;
}

/** The changed set from what was read: the rules above, in order. */
export async function selectChangedApps(input: ChangedAppsInput): Promise<ChangedApps> {
  const all = [...input.all].sort();
  if (input.changed === undefined) return { apps: all, reason: 'no base ref: every app counts as changed' };
  const changed = input.changed.filter((f) => !BOOKKEEPING.test(f));
  const under = (app: string) => changed.some((f) => f.startsWith(`apps/${app}/`));

  if (!input.workspace) return { apps: all.filter(under), reason: 'files under the apps changed' };
  if (changed.length === 0) return { apps: [], reason: 'nothing but bookkeeping changed' };
  if (changed.some((f) => GLOBALS.test(f)))
    return { apps: all, reason: 'a workspace-global input changed: every app counts as changed' };

  // pnpm sees every file in a project dir, bookkeeping included, so an app it
  // lists is kept only when a counted file changed under its own dir, or when
  // something outside apps/ changed (a package it may depend on; pnpm's graph
  // walk is the authority there).
  const outside = changed.some((f) => !f.startsWith('apps/'));
  const listed = new Set((await input.dependents?.()) ?? []);
  return {
    apps: all.filter((app) => listed.has(app) && (outside || under(app))),
    reason: 'sources or their dependencies changed',
  };
}

/** The apps whose sources changed between `from` and `to` in the checkout at `dir`. */
export async function readChangedApps(ctx: Context, dir: string, from: string, to = 'HEAD'): Promise<ChangedApps> {
  const git = (args: string[]) => ctx.read('git', args, { cwd: dir });
  const workspace = await exists(ctx, join(dir, 'pnpm-workspace.yaml'));
  const all = await deployableApps(ctx, dir, workspace);

  let changed: string[] | undefined;
  if (from !== '' && !NO_REF.test(from) && (await isCommit(git, from)))
    changed = (await git(['diff', '--name-only', from, to])).split('\n').filter(Boolean);

  const dependents = async (): Promise<string[]> => {
    const out = await ctx.read('pnpm', ['--filter', `...[${from}...${to}]`, 'ls', '--depth', '-1', '--parseable'], {
      cwd: dir,
    });
    return out
      .split('\n')
      .map((line) => /(?:^|\/)apps\/([^/]+)$/.exec(line.trim())?.[1])
      .filter((app): app is string => app !== undefined);
  };
  const result = await selectChangedApps({ workspace, all, changed, dependents });
  ctx.say(`→ ${result.reason}`, 1);
  return result;
}

async function isCommit(git: (args: string[]) => Promise<string>, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every apps/<name>/ that is deployable: in a workspace, a member (a
 * package.json marks one; the same set pnpm can ever list, and a bare dir is
 * not buildable); without one, a dir carrying a compose file.
 */
async function deployableApps(ctx: Context, dir: string, workspace: boolean): Promise<string[]> {
  const entries = await ctx.readDir(join(dir, 'apps')).catch(() => []);
  const apps: string[] = [];
  for (const e of entries) {
    if (!e.directory) continue;
    const marks = workspace ? ['package.json'] : ['docker/compose.yaml', 'compose.yaml'];
    for (const mark of marks) {
      if (await exists(ctx, join(dir, 'apps', e.name, mark))) {
        apps.push(e.name);
        break;
      }
    }
  }
  return apps.sort();
}

async function exists(ctx: Context, path: string): Promise<boolean> {
  try {
    await ctx.readFile(path);
    return true;
  } catch {
    return false;
  }
}
