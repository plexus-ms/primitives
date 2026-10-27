// The module catalogue: what the compendium's `contracts/` and `approaches/`
// pages declare in their frontmatter (§ 1.3 PLX). Only pages with a `code`
// are modules a marker can declare; notes have none and are skipped.
import { join } from 'node:path';
import type { Context } from './context.ts';
import { splitFrontmatter } from './marker.ts';

export interface Module {
  code: string;
  kind: 'contract' | 'approach';
  maturity: string;
  binds: string;
  /** The train in which the module's requirements last changed; standard modules only. */
  changed?: string;
  /** Codes on the same side of every seam that a declaration of this module has to accompany. */
  depends: string[];
  /** Contracts on the other side of a seam; never the declaring unit's to satisfy. */
  consumes: string[];
}

export type Catalog = Map<string, Module>;

export const CATALOG_DIRS = { contracts: 'contract', approaches: 'approach' } as const;

/** The module a page declares, or undefined for a note. */
export function parseModule(text: string, kind: Module['kind']): Module | undefined {
  const { data } = splitFrontmatter(text);
  if (typeof data.code !== 'string') return undefined;
  return {
    code: data.code,
    kind,
    maturity: String(data.maturity ?? ''),
    binds: String(data.binds ?? ''),
    changed: data.changed === undefined ? undefined : String(data.changed),
    depends: codes(data.depends),
    consumes: codes(data.consumes),
  };
}

function codes(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Every module of a compendium checkout, by code. */
export async function readCatalog(ctx: Context, compendium: string): Promise<Catalog> {
  const catalog: Catalog = new Map();
  for (const [dir, kind] of Object.entries(CATALOG_DIRS)) {
    const entries = await ctx.readDir(join(compendium, dir));
    for (const e of entries.filter((e) => !e.directory && e.name.endsWith('.md') && e.name !== 'index.md').sort()) {
      const module = parseModule(await ctx.readFile(join(compendium, dir, e.name)), kind);
      if (module) catalog.set(module.code, module);
    }
  }
  return catalog;
}
