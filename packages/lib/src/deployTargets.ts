// deploy-targets: where the deploy verb reaches each app a platform repo
// operates (§ 3 PLX-Platform), read from the repo's inventory.
//
// An inventory file, host_vars for a VM or group_vars for a group, carries
// `plexus_deploy_target` (ssh://<deploy user>@<address>[:<port>]) and the
// `plexus_apps` records it hosts, each with a `name` and an optional
// `environment` (`production` when absent). The verb maps every deployment, an app in
// an environment, of a file that names a target to that target; a deployment
// whose file carries no target is left out, so the mount falls back to its one
// DEPLOY_HOST for it. The same app may have one record per environment, on
// the same VM or on two; the same app in the same environment declared in two
// files that both name a target has no one place to deploy to, and that is an
// error, never a pick.
//
//   plx deploy-targets [inventory]                    # {"app": {"production": "ssh://...", "staging": "ssh://..."}, ...}
//   plx deploy-targets --environment production [inventory] # {"app": "ssh://...", ...}, one environment, flat
//   plx deploy-targets --environment production --apps apps # [{"app": "...", "host": "ssh://..."}], the apps under apps/, for a matrix
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Context } from './context.ts';
import { UsageError } from './train.ts';

const VARS_DIRS = ['group_vars', 'host_vars'];

/** The environment a record without one is in. */
export const DEFAULT_ENVIRONMENT = 'production';

/** App name → environment → deploy target. */
export type DeployTargets = Record<string, Record<string, string>>;

/** App name → deploy target, for one environment. */
export type EnvironmentTargets = Record<string, string>;

export interface Deployment {
  app: string;
  environment: string;
}

export interface InventoryFile {
  /** The file's path, for the error that names it. */
  path: string;
  target?: string;
  apps: Deployment[];
}

/**
 * The slug a deployment has on the host, the directory under the deploy root
 * and the compose project's suffix: the app's name in production, `<app>-<environment>`
 * elsewhere, so that a prod record changes nothing (§ 3 PLX-Platform).
 */
export function deploymentSlug(app: string, environment: string = DEFAULT_ENVIRONMENT): string {
  return environment === DEFAULT_ENVIRONMENT ? app : `${app}-${environment}`;
}

/** The keys the verb reads from an inventory file's text; anything else is ignored. */
export function parseInventoryFile(path: string, text: string): InventoryFile {
  const data: unknown = parse(text);
  const vars = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const target = typeof vars.plexus_deploy_target === 'string' ? vars.plexus_deploy_target : undefined;
  const records = Array.isArray(vars.plexus_apps) ? vars.plexus_apps : [];
  const apps = records.flatMap((r): Deployment[] => {
    if (r === null || typeof r !== 'object') return [];
    const { name, environment } = r as { name?: unknown; environment?: unknown };
    if (typeof name !== 'string') return [];
    return [{ app: name, environment: typeof environment === 'string' ? environment : DEFAULT_ENVIRONMENT }];
  });
  return { path, target, apps };
}

/** The map from the files read: deterministic, and loud about a deployment with two targets. */
export function selectDeployTargets(files: InventoryFile[]): DeployTargets {
  const targets: DeployTargets = {};
  const declaredIn: Record<string, string> = {};
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (file.target === undefined) continue;
    for (const { app, environment } of file.apps) {
      const key = `${app}@${environment}`;
      if (key in declaredIn)
        throw new Error(
          `app "${app}" in ${environment} is declared with a deploy target in both ${declaredIn[key]} and ${file.path}`,
        );
      const envs = targets[app] ?? {};
      envs[environment] = file.target;
      targets[app] = envs;
      declaredIn[key] = file.path;
    }
  }
  return Object.fromEntries(
    Object.entries(targets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([app, envs]) => [app, Object.fromEntries(Object.entries(envs).sort(([a], [b]) => a.localeCompare(b)))]),
  );
}

/** The flat map of one environment: the apps that have a deployment there, and their targets. */
export function targetsIn(targets: DeployTargets, environment: string): EnvironmentTargets {
  const flat: EnvironmentTargets = {};
  for (const [app, envs] of Object.entries(targets)) {
    const target = envs[environment];
    if (target !== undefined) flat[app] = target;
  }
  return flat;
}

/** One deploy of a matrix: an app and where it deploys. */
export interface DeployLeg {
  app: string;
  host: string;
}

/**
 * The deploys of the apps a repo holds itself, in one environment: a leg per
 * app with a target there, and the apps without one, which have no
 * deployment in it. A platform repo fans its deploy over the legs, so that
 * the inventory's records of apps built elsewhere start nothing here.
 */
export function deployLegs(targets: EnvironmentTargets, apps: string[]): { legs: DeployLeg[]; without: string[] } {
  const legs: DeployLeg[] = [];
  const without: string[] = [];
  for (const app of [...apps].sort()) {
    const host = targets[app];
    if (host === undefined) without.push(app);
    else legs.push({ app, host });
  }
  return { legs, without };
}

/** Read every group_vars and host_vars file under the inventory directory and map the deployments. */
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
