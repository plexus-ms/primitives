// The candidates a repo's runs leave in the forge's registry (`ci_registry:
// ghcr`), pruned (§ 8 PLX-Delivery), for the packages of the repo's own apps
// and no other: a version of a container package whose every tag
// is `build-<hash>` or `test-<hash>` and that is older than thirty days goes.
// A version that carries any other tag stays, whatever its age: a commit's
// SHA marks a published image, which a rollback may ask for years later, and
// `cache` is the one moving tag BuildKit rewrites. An untagged version stays
// as well, since it may be part of an image this rule knows nothing about.
// Through GitHub's packages API with curl; the token goes to curl as a config
// on stdin, never on argv. That API takes no App token: the workflow's own
// token deletes versions of the packages its repo published, which is why
// the pruning is mounted in the app repo.
import type { Context } from '@plexus-ms/lib';
import { ExecError, run } from '@plexus-ms/lib';

export interface Version {
  id: number;
  /** `2026-11-04T10:40:27Z`. */
  createdAt: string;
  tags: string[];
}

export const PRUNE_AFTER_DAYS = 30;
const CANDIDATE_TAG = /^(build|test)-[0-9a-f]+$/;

/** The versions that go: tagged, with candidate tags only, created more than `days` ago. */
export function prunable(versions: Version[], now: Date, days = PRUNE_AFTER_DAYS): Version[] {
  const before = now.getTime() - days * 86_400_000;
  return versions.filter(
    (v) => v.tags.length > 0 && v.tags.every((t) => CANDIDATE_TAG.test(t)) && Date.parse(v.createdAt) < before,
  );
}

export class Packages {
  readonly ctx: Context;
  readonly org: string;
  private readonly token: string;

  constructor(ctx: Context, org: string, token: string) {
    this.ctx = ctx;
    this.org = org;
    this.token = token;
  }

  private config(method: string, path: string): string {
    return `${[
      `url = "https://api.github.com/orgs/${this.org}/packages${path}"`,
      `request = "${method}"`,
      'fail-with-body',
      'silent',
      'show-error',
      `header = "Authorization: Bearer ${this.token}"`,
      'header = "Accept: application/vnd.github+json"',
      'header = "X-GitHub-Api-Version: 2022-11-28"',
    ].join('\n')}\n`;
  }

  /** Every page of a list, a hundred entries each. */
  private async pages<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const out = await this.ctx.read('curl', ['-K', '-'], {
        input: this.config('GET', `${path}${sep}per_page=100&page=${page}`),
      });
      const items = JSON.parse(out) as T[];
      all.push(...items);
      if (items.length < 100) return all;
    }
  }

  async versions(name: string): Promise<Version[]> {
    const raw = await this.pages<{
      id: number;
      created_at: string;
      metadata?: { container?: { tags?: string[] } };
    }>(`/container/${encodeURIComponent(name)}/versions`);
    return raw.map((v) => ({ id: v.id, createdAt: v.created_at, tags: v.metadata?.container?.tags ?? [] }));
  }

  async deleteVersion(name: string, id: number): Promise<void> {
    await this.ctx.effect(
      run('curl', ['-K', '-'], {
        input: this.config('DELETE', `/container/${encodeURIComponent(name)}/versions/${id}`),
      }),
    );
  }
}

export interface Pruned {
  package: string;
  id: number;
  tags: string[];
}

/** The package an app's image is, under `ghcr.io/<owner>[/<path>]`: the path and the app. */
export function packageOf(prefix: string, app: string): string {
  const path = prefix.toLowerCase().replace(/\/$/, '').split('/').slice(2);
  return [...path, app].join('/');
}

/** Prune the named packages by the rule above; a package that does not exist yet has nothing to prune. */
export async function prune(ctx: Context, packages: Packages, names: string[], now = new Date()): Promise<Pruned[]> {
  const pruned: Pruned[] = [];
  for (const name of names) {
    let versions: Version[];
    try {
      versions = await packages.versions(name);
    } catch (error) {
      if (!(error instanceof ExecError)) throw error;
      ctx.say(`rotate: no package ${name} in ghcr.io/${packages.org}`);
      continue;
    }
    for (const v of prunable(versions, now)) {
      ctx.say(`rotate: ${name} ${v.tags.join(' ')} (${v.createdAt}) is older than ${PRUNE_AFTER_DAYS} days`);
      await packages.deleteVersion(name, v.id);
      pruned.push({ package: name, id: v.id, tags: v.tags });
    }
  }
  ctx.say(
    `rotate: ${pruned.length} candidate version(s) pruned from ${names.length} package(s) of ghcr.io/${packages.org}`,
  );
  return pruned;
}
