// deploy-targets: where the deploy verb reaches each app a platform repo
// operates (§ 3 PLX-Platform), read from the repo's inventory.
//
// An inventory file, host_vars for a VM or group_vars for a group, carries
// `plexus_deploy_target` (ssh://<deploy user>@<address>[:<port>]) and the
// `plexus_apps` records it hosts, each with a `name`. The verb maps every app
// of a file that names a target to that target; an app whose file carries no
// target is left out, so the mount falls back to its one DEPLOY_HOST for it.
// An app declared in two files that both name a target has no one place to
// deploy to, and that is an error, never a pick.
//
//   plx deploy-targets [inventory]        # {"app": "ssh://...", ...}
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Context } from './context.ts';
import { UsageError } from './train.ts';

const VARS_DIRS = ['group_vars', 'host_vars'];

/** App name → deploy target. */
export type DeployTargets = Record<string, string>;

export interface InventoryFile {
  /** The file's path, for the error that names it. */
  path: string;
  target?: string;
  apps: string[];
}

/** The two keys the verb reads from an inventory file's text; anything else is ignored. */
export function parseInventoryFile(path: string, text: string): InventoryFile {
  const data: unknown = parse(text);
  const vars = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const target = typeof vars.plexus_deploy_target === 'string' ? vars.plexus_deploy_target : undefined;
  const records = Array.isArray(vars.plexus_apps) ? vars.plexus_apps : [];
  const apps = records
    .map((r) => (r !== null && typeof r === 'object' ? (r as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string');
  return { path, target, apps };
}

/** The map from the files read: deterministic, and loud about an app with two targets. */
export function selectDeployTargets(files: InventoryFile[]): DeployTargets {
  const targets: DeployTargets = {};
  const declaredIn: Record<string, string> = {};
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (file.target === undefined) continue;
    for (const app of file.apps) {
      if (app in targets)
        throw new Error(`app "${app}" is declared with a deploy target in both ${declaredIn[app]} and ${file.path}`);
      targets[app] = file.target;
      declaredIn[app] = file.path;
    }
  }
  return Object.fromEntries(Object.entries(targets).sort(([a], [b]) => a.localeCompare(b)));
}

/** Read every group_vars and host_vars file under the inventory directory and map the apps. */
export async function readDeployTargets(ctx: Context, inventory: string): Promise<DeployTargets> {
  const files: InventoryFile[] = [];
  let found = false;
  for (const sub of VARS_DIRS) {
    const dir = join(inventory, sub);
    const entries = await ctx.readDir(dir).catch(() => undefined);
    if (entries === undefined) continue;
    found = true;
    for (const e of entries) {
      if (e.directory || !/\.ya?ml$/.test(e.name)) continue;
      const path = join(dir, e.name);
      files.push(parseInventoryFile(path, await ctx.readFile(path)));
    }
  }
  if (!found && (await ctx.readDir(inventory).catch(() => undefined)) === undefined)
    throw new UsageError(`no inventory directory at ${inventory}`);
  return selectDeployTargets(files);
}
