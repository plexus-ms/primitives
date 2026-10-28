// The requirements check (§ 1.8 PLX), the compendium's `requirements.sh`
// moved: a verb, not a system.
//
//   scanPage        one page: its defects, and for a standard module its
//                   requirement lines, `§ <section> <text>`, in page order
//   checkCompendium the map and every module page, plus the cross-page rules:
//                   unique codes, known dependencies, dependencies that respect
//                   the seams (§ 1.3 PLX)
//
// The map carries no requirements and no BCP 14 keyword. A module at standard
// maturity carries its requirements as blockquoted bullets ("> - ") under
// numbered section headings; a keyword anywhere else, a blockquote that is not
// such a bullet, or any keyword or blockquote in a module below standard
// maturity is a defect. The trailing "## Maintaining" section is prose
// throughout. Extraction is structural: no classification, no heuristics.
// `ship` compares a module's extracted lines across trains to stamp `changed`,
// so the extractor and the linter are one function and cannot disagree.
//
//   plx requirements <compendium>              # lint; exit 1 on any defect
//   plx requirements --extract contracts/app.md
import { join } from 'node:path';
import { CATALOG_DIRS } from './catalog.ts';
import type { Context } from './context.ts';

export type PageMode = 'map' | 'module';

export interface Scan {
  /** `✗ <name>: line N: ...`, in page order. */
  defects: string[];
  /** The requirement lines of a standard module; empty for anything else. */
  requirements: string[];
  /** The frontmatter fields the cross-page rules need. */
  code?: string;
  maturity?: string;
  binds?: string;
  depends: string[];
  consumes: string[];
}

const KEYWORD = /MUST|SHOULD|MAY/;

/** A BCP 14 keyword in a line, the informal plurals (MUSTs, SHOULDs, MAYs) not counting. */
const hasKeyword = (line: string): boolean => KEYWORD.test(line.replace(/MUSTs|SHOULDs|MAYs/g, ''));

/** A bracketed, comma-separated list as the frontmatter writes it: `[A, B]`. */
const list = (value: string): string[] =>
  value
    .replace(/^\s*\[/, '')
    .replace(/\].*$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function scanPage(text: string, name: string, mode: PageMode): Scan {
  const scan: Scan = { defects: [], requirements: [], depends: [], consumes: [] };
  const lines = text.split('\n');
  const defect = (n: number, msg: string) => scan.defects.push(`✗ ${name}: line ${n + 1}: ${msg}`);

  let i = 0;
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const line = lines[i] ?? '';
      const [key = '', ...rest] = line.split(/\s+/);
      const value = rest.join(' ');
      if (key === 'maturity:') scan.maturity = rest[0];
      else if (key === 'code:') scan.code = rest[0];
      else if (key === 'binds:') scan.binds = rest[0];
      else if (key === 'depends:') scan.depends = list(value);
      else if (key === 'consumes:') scan.consumes = list(value);
      else if (key === 'kind:') defect(i, 'kind is the folder, contracts/ or approaches/, not a field');
    }
    i++;
  }

  let inCode = false;
  let maintaining = false;
  let started = false;
  let section = '';
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (line === '## Maintaining') {
      maintaining = true;
      section = '';
      continue;
    }
    const heading = /^#+ § (\S+)/.exec(line);
    if (heading) {
      if (maintaining) defect(i, 'numbered section after Maintaining');
      section = heading[1] ?? '';
      started = true;
      continue;
    }
    if (line.startsWith('> - ')) {
      if (mode === 'map') defect(i, `requirement in the map: ${line}`);
      else if (scan.maturity !== 'standard') defect(i, `requirement in a module at ${scan.maturity} maturity: ${line}`);
      else if (maintaining) defect(i, `requirement under Maintaining: ${line}`);
      else if (!started) defect(i, 'requirement before the first § heading');
      else scan.requirements.push(`§ ${section} ${line.slice(4)}`);
      continue;
    }
    if (line.startsWith('>')) {
      defect(i, 'blockquote line is not a "> - " requirement bullet');
      continue;
    }
    if (hasKeyword(line)) defect(i, `BCP 14 keyword outside a requirement: ${line}`);
  }

  if (mode === 'module') {
    const { maturity = '', binds = '', code = '' } = scan;
    // Reported at the page's last line, like awk's NR at END.
    const n = text.endsWith('\n') ? lines.length - 1 : lines.length;
    if (!/^(note|candidate|standard)$/.test(maturity))
      defect(n - 1, `maturity must be note, candidate or standard, not "${maturity}"`);
    if (!/^(repo|app|host|organisation)$/.test(binds))
      defect(n - 1, `binds must be repo, app, host or organisation, not "${binds}"`);
    if (maturity === 'note' && code !== '') defect(n - 1, 'a note carries no code');
    if (maturity !== 'note' && !/^PLX-[A-Z][A-Za-z]+$/.test(code))
      defect(n - 1, `code must be PLX- plus one capitalised word, not "${code}"`);
  }
  return scan;
}

/** The requirement lines of a page, defects ignored: what `changed` compares across trains. */
export const extractRequirements = (text: string): string[] => scanPage(text, '', 'module').requirements;

export const MAP_PAGE = 'essentials/standard.md';

export interface CompendiumCheck {
  defects: string[];
  contracts: number;
  approaches: number;
}

/** Every module page of a compendium checkout: `<dir>/<file>`, sorted, index pages left out. */
export async function modulePages(ctx: Context, compendium: string): Promise<string[]> {
  const pages: string[] = [];
  for (const dir of Object.keys(CATALOG_DIRS)) {
    const entries = await ctx.readDir(join(compendium, dir));
    for (const e of entries.filter((e) => !e.directory && e.name.endsWith('.md') && e.name !== 'index.md').sort())
      pages.push(`${dir}/${e.name}`);
  }
  return pages;
}

export async function checkCompendium(ctx: Context, compendium: string): Promise<CompendiumCheck> {
  const defects: string[] = [];
  defects.push(...scanPage(await ctx.readFile(join(compendium, MAP_PAGE)), MAP_PAGE, 'map').defects);

  const pages = await modulePages(ctx, compendium);
  const scans = new Map<string, Scan>();
  for (const page of pages) {
    const scan = scanPage(await ctx.readFile(join(compendium, page)), page, 'module');
    defects.push(...scan.defects);
    scans.set(page, scan);
  }

  // Module codes are unique across pages.
  const byCode = new Map<string, string[]>();
  for (const [page, s] of scans) if (s.code) byCode.set(s.code, [...(byCode.get(s.code) ?? []), page]);
  for (const [code, where] of byCode) if (where.length > 1) defects.push(`✗ duplicate module code: ${code}`);

  // Every declared dependency names a module that exists.
  for (const s of scans.values())
    for (const dep of s.depends) if (!byCode.has(dep)) defects.push(`✗ unknown module in depends: ${dep}`);

  // Dependencies respect the seams (§ 1.3 PLX): a contract depends only on
  // contracts, a dependency never crosses from the dev side (repo, app) to the
  // ops side (host, organisation) or back, and what crosses a seam is listed
  // under consumes and is a contract.
  const kindOf = (page: string): 'contract' | 'approach' => (page.startsWith('contracts/') ? 'contract' : 'approach');
  const side = (binds: string) => (binds === 'repo' || binds === 'app' ? 'dev' : 'ops');
  const kinds = new Map([...byCode].map(([code, [page = '']]) => [code, kindOf(page)]));
  const binds = new Map([...byCode].map(([code, [page = '']]) => [code, scans.get(page)?.binds ?? '']));
  for (const [page, s] of scans) {
    const m = s.code ?? page.replace(/.*\//, '');
    const kind = kindOf(page);
    for (const c of s.consumes) {
      if (kind === 'contract')
        defects.push(`✗ ${m} is a contract and consumes ${c}; a contract has no other side to consume`);
      else if (kinds.has(c) && kinds.get(c) !== 'contract')
        defects.push(`✗ ${m} consumes ${c}, which is an approach; only a contract is consumed across a seam`);
      else if (!kinds.has(c)) defects.push(`✗ ${m} consumes unknown module ${c}`);
    }
    for (const d of s.depends) {
      if (!kinds.has(d)) continue;
      if (kind === 'contract' && kinds.get(d) !== 'contract')
        defects.push(`✗ ${m} is a contract and depends on the approach ${d}`);
      if (side(s.binds ?? '') !== side(binds.get(d) ?? '') && kinds.get(d) !== 'contract')
        defects.push(
          `✗ ${m} (${s.binds}) depends on ${d} (${binds.get(d)}) across the dev/ops seam; only a contract may be depended on across a seam`,
        );
    }
  }

  return {
    defects,
    contracts: pages.filter((p) => p.startsWith('contracts/')).length,
    approaches: pages.filter((p) => p.startsWith('approaches/')).length,
  };
}
