// The candidates a run leaves in the forge's registry (`ci_registry: ghcr`),
// pruned (§ 8 PLX-Delivery): a version of a container package whose every tag
// is `build-<hash>` or `test-<hash>` and that is older than thirty days goes.
// A version that carries any other tag stays, whatever its age: a commit's
// SHA marks a published image, which a rollback may ask for years later, and
// `cache` is the one moving tag BuildKit rewrites. An untagged version stays
// as well, since it may be part of an image this rule knows nothing about.
// Through GitHub's packages API with curl; the token goes to curl as a config
// on stdin, never on argv.
import type { Context } from '@plexus-ms/lib';
import { run } from '@plexus-ms/lib';

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

  /** The organisation's container packages, by name. */
  async names(): Promise<string[]> {
    return (await this.pages<{ name: string }>('?package_type=container')).map((p) => p.name);
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

/** Prune every container package of the organisation by the rule above. */
export async function prune(ctx: Context, packages: Packages, now = new Date()): Promise<Pruned[]> {
  const pruned: Pruned[] = [];
  for (const name of await packages.names()) {
    for (const v of prunable(await packages.versions(name), now)) {
      ctx.say(`rotate: ${name} ${v.tags.join(' ')} (${v.createdAt}) is older than ${PRUNE_AFTER_DAYS} days`);
      await packages.deleteVersion(name, v.id);
      pruned.push({ package: name, id: v.id, tags: v.tags });
    }
  }
  ctx.say(`rotate: ${pruned.length} candidate version(s) pruned from ghcr.io/${packages.org}`);
  return pruned;
}
