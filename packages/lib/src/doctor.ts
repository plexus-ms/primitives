// doctor: the staleness check (§ 13.4 PLX), a verb, not a system.
//
// Every PLEXUS.md marker under a directory is read, and for each module it
// declares the module's `changed` train is compared with the marker's
// `plexus`; every `depends` entry of a declared module has to be declared
// where § 1.4 says it is satisfied: by the unit itself, by an enclosing
// declaration (an app's repo, a repo's tenant) or by a contained one (a
// repo's apps, a tenant's repos). What a module `consumes` is the other side
// of a seam and never this unit's to declare. Findings are reported, never
// fixed. A tenant is a directory whose repos sit side by side; the repo whose
// marker declares PLX-Tenancy is the tenant's declaration.
//
//   plx doctor                              # every marker, one line each
//   plx doctor ~/dev --compendium ~/dev/plexus-ms/compendium
import { relative } from 'node:path';
import type { Catalog } from './catalog.ts';
import type { Directory } from './model.ts';

export interface Diagnosis {
  /** The marker's directory, relative to the scanned root. */
  path: string;
  plexus?: string;
  modules: string[];
  findings: string[];
}

export interface Report {
  declarations: Diagnosis[];
  /** Declarations with at least one finding. */
  stale: number;
}

/** A scanned tree against a catalogue: pure, so a test compares reports. */
export function diagnose(root: Directory, catalog: Catalog): Report {
  const units = collect(root, []);
  const declarations = units.map((u) => diagnoseUnit(u, units, catalog, root.path));
  return { declarations, stale: declarations.filter((d) => d.findings.length > 0).length };
}

interface Unit {
  dir: Directory;
  /** Declared ancestors, nearest last. */
  ancestors: Directory[];
  /** The directory the unit sits in, for finding siblings. */
  parent?: Directory;
}

function collect(dir: Directory, ancestors: Directory[], parent?: Directory): Unit[] {
  const here =
    dir.declaration || dir.problems?.some((p) => p.startsWith('PLEXUS.md')) ? [{ dir, ancestors, parent }] : [];
  const below = dir.declaration ? [...ancestors, dir] : ancestors;
  return [...here, ...dir.children.flatMap((c) => collect(c, below, dir))];
}

function diagnoseUnit(unit: Unit, units: Unit[], catalog: Catalog, root: string): Diagnosis {
  const { dir } = unit;
  const path = relative(root, dir.path) || '.';
  const problem = dir.problems?.find((p) => p.startsWith('PLEXUS.md'));
  if (!dir.declaration)
    return { path, modules: [], findings: [problem?.replace(/^PLEXUS\.md: /, '') ?? 'unreadable marker'] };

  const { plexus, modules } = dir.declaration;
  const context = new Set(contextOf(unit, units).flatMap((d) => d.declaration?.modules ?? []));
  const findings: string[] = [];
  for (const code of modules) {
    const module = catalog.get(code);
    if (!module) {
      findings.push(`declares ${code}, which no module carries`);
      continue;
    }
    if (module.changed && compareTrains(module.changed, plexus) > 0)
      findings.push(`${code} changed in ${module.changed}, declared at ${plexus}`);
    for (const dep of module.depends)
      if (!modules.includes(dep) && !context.has(dep))
        findings.push(`${code} depends on ${dep}, declared neither here nor by an enclosing or contained declaration`);
  }
  return { path, plexus, modules, findings };
}

/** The declarations that may satisfy a unit's dependencies: enclosing and contained ones (§ 1.4 PLX). */
function contextOf(unit: Unit, units: Unit[]): Directory[] {
  const { dir, ancestors } = unit;
  const context = [...ancestors, ...descendants(dir)];
  // The tenant: the repo's siblings. A unit inside a repo belongs to that repo; a repo is its own.
  const repo = ancestors[0] ?? dir;
  const repoParent = units.find((u) => u.dir === repo)?.parent;
  const siblings = repoParent?.children.filter((c) => c !== repo && c.declaration) ?? [];
  const isTenancy = (d: Directory) => d.declaration?.modules.includes('PLX-Tenancy') ?? false;
  context.push(...siblings.filter(isTenancy));
  if (isTenancy(dir)) context.push(...siblings);
  return context;
}

function descendants(dir: Directory): Directory[] {
  return dir.children.flatMap((c) => [...(c.declaration ? [c] : []), ...descendants(c)]);
}

/** Numeric comparison of two train versions; suffixes ignored. */
export function compareTrains(a: string, b: string): number {
  const nums = (v: string) =>
    v
      .split('.')
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
}
