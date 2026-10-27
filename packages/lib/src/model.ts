// The Plexus vocabulary (§ 1.2 PLX) as far as a verb needs it today: a
// directory and the facets it carries. A facet is present exactly when its
// marker file is. What a directory *is* (an app, a platform repo, a repo) is
// derived from what it declares, never stored.
import type { Answers } from './copier.ts';
import type { Declaration } from './marker.ts';

export interface Directory {
  name: string;
  path: string;
  git?: GitFacet;
  template?: TemplateFacet;
  copier?: Answers;
  declaration?: Declaration;
  /** Marker files that could not be read; shown, never fatal. */
  problems?: string[];
  children: Directory[];
}

export interface GitFacet {
  /** The checked-out branch, or the short commit when detached. */
  branch: string;
  /** Uncommitted tracked or untracked changes. */
  dirty: boolean;
  /** The most recent tag reachable from the default branch, if any. */
  tag?: string;
  /** The `origin` remote, shortened: `gh:org/repo` for GitHub. */
  remote?: string;
}

export interface TemplateFacet {
  /** The template repo's most recent tag, if any. */
  tag?: string;
}

export type Kind = 'app' | 'platform' | 'repo';

/** What a declaration makes a directory, by the modules it follows. */
export function kindOf(declaration: Declaration): Kind | undefined {
  const has = (code: string) => declaration.modules.includes(code);
  if (has('PLX-App')) return 'app';
  if (has('PLX-Platform')) return 'platform';
  if (has('PLX-Repo')) return 'repo';
  return undefined;
}

/** A git remote URL as a short handle: `gh:org/repo` for GitHub, the URL otherwise. */
export function shortRemote(url: string): string {
  const bare = url.replace(/\.git$/, '').replace(/\/$/, '');
  const m = /^(?:git@github\.com:|github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)(.+)$/.exec(bare);
  return m ? `gh:${m[1]}` : bare;
}

/** Whether a directory, or anything below it, carries a facet worth showing. */
export function isNotable(dir: Directory): boolean {
  return Boolean(dir.git || dir.template || dir.copier || dir.declaration || dir.problems?.length);
}
