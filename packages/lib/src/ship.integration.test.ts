// The toolbox's offline harness for ship.sh, moved: a scratch workspace laid
// out like ~/dev — the six train repos with bare "origin" remotes (the
// compendium among them), a tenant with a web repo (root + one app) and a
// platform repo — plus a fake `copier` and a fake `mise` on PATH. Each
// scenario builds a fresh fixture, runs `ship` against it with the real Io,
// and asserts on tags, files, the summary and the narration.
//
// Fake copier: `copier update` writes "updated from <ref>" into
// template-owned.txt, bumps _commit in the answers file, and touches
// package.json at a web root (so the lockfile refresh triggers). Knobs:
//   FAKE_COPIER_FAIL=<substring>      exit 1 at a site whose path matches
//   FAKE_COPIER_CONFLICT=<substring>  leave <<<<<<< markers at a matching site
// Every invocation is appended to FAKE_LOG as "<cwd> <src_path> <args>".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Context, type Options } from './context.ts';
import { realIo } from './io.ts';
import { type ShipResult, ship } from './ship.ts';
import { TRAIN_REPOS } from './train.ts';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'plx-ship-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Git must not reach the user's config: no signing (1Password would prompt),
// a stand-in identity, main as the default branch.
const gitconfig = join(TMP, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z';
process.env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z';
for (const [k, v] of [
  ['user.name', 'ship-test'],
  ['user.email', 'ship-test@localhost'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['init.defaultBranch', 'main'],
])
  execFileSync('git', ['config', '--file', gitconfig, k ?? '', v ?? '']);

const FAKE_BIN = join(TMP, 'bin');
mkdirSync(FAKE_BIN);
const script = (name: string, body: string) => {
  writeFileSync(join(FAKE_BIN, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  chmodSync(join(FAKE_BIN, name), 0o755);
};
script(
  'copier',
  `src="$(sed -n 's/^_src_path: //p' .copier-answers.yml)"
echo "$PWD $src $*" >> "$FAKE_LOG"
ref="latest-tag"
while [ $# -gt 0 ]; do [ "$1" = --vcs-ref ] && ref="$2"; shift; done
[ -z "\${FAKE_COPIER_FAIL:-}" ] || case "$PWD" in *"$FAKE_COPIER_FAIL"*) echo "fake copier: failing on purpose" >&2; exit 1 ;; esac
echo "updated from $ref" > template-owned.txt
sed -i.bak 's/^_commit: .*/_commit: next/' .copier-answers.yml && rm -f .copier-answers.yml.bak
[ ! -f package.json ] || echo '{"name": "touched"}' > package.json
[ -z "\${FAKE_COPIER_CONFLICT:-}" ] || case "$PWD" in *"$FAKE_COPIER_CONFLICT"*) printf '<<<<<<< before\\nx\\n=======\\ny\\n>>>>>>> after\\n' > template-owned.txt ;; esac
`,
);
script('mise', 'echo "mise $*" >> "$FAKE_LOG"\n');
process.env.PATH = `${FAKE_BIN}:${process.env.PATH}`;

// ── fixture ──────────────────────────────────────────────────────────────────
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, 'utf8');
const commit = (repo: string, message: string) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', message);
};

let WS = '';
const FAKE_LOG = () => join(WS, 'fake.log');
const fakeLog = () => read(FAKE_LOG()).split('\n').filter(Boolean);
const copierRuns = () => fakeLog().filter((l) => !l.startsWith('mise'));

function fixture(name: string): void {
  WS = join(TMP, `ws-${name}`);
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, 'plexus-ms'), { recursive: true });
  mkdirSync(join(WS, 'remotes'));
  mkdirSync(join(WS, 'acme'));
  const up = (r: string) => join(WS, 'plexus-ms', r);
  for (const r of TRAIN_REPOS) git(WS, 'init', '--quiet', up(r));
  put(join(up('platform'), 'ansible/galaxy.yml'), 'version: 0.1.0                # mirrors the release-train tag\n');
  put(
    join(up('ci-cd'), '.github/workflows/pipeline.yml'),
    'jobs:\n  ci:\n    uses: plexus-ms/ci-cd/.github/workflows/ci.yml@0.1.0\n',
  );
  put(join(up('preset-repo-web'), 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(up('preset-repo-web'), 'template/.github/workflows/ci.yml.jinja'),
    'jobs:\n  changes:\n    uses: plexus-ms/ci-cd/.github/workflows/changes.yml@0.1.0\n',
  );
  put(join(up('preset-app-nextjs'), 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(join(up('preset-repo-platform'), 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(up('preset-repo-platform'), 'template/requirements.yml'),
    'collections:\n  - name: https://github.com/plexus-ms/platform.git#/ansible/\n    type: git\n    version: 0.1.0\n  - name: community.docker\n    version: 9.9.9\n',
  );
  // The compendium: the map with a draft version, two standard modules (a
  // contract, and an approach already stamped) and one candidate module.
  const comp = up('compendium');
  put(
    join(comp, 'essentials/standard.md'),
    '---\ntitle: The Plexus Standard (PLX)\nversion: v0\ntimestamp: 2025-12-31\norder: 1\n---\n\nProse.\n',
  );
  put(
    join(comp, 'contracts/alpha.md'),
    '---\ncode: PLX-Alpha\nmaturity: standard\nbinds: repo\n---\n\n## § 1 One\n\n> - A repo MUST alpha.\n',
  );
  put(
    join(comp, 'approaches/beta.md'),
    '---\ncode: PLX-Beta\nmaturity: standard\nbinds: host\nchanged: 0.1.0\n---\n\n## § 1 One\n\n> - A host MUST beta.\n',
  );
  put(
    join(comp, 'approaches/gamma.md'),
    '---\ncode: PLX-Gamma\nmaturity: candidate\nbinds: host\n---\n\nProse only.\n',
  );
  for (const r of TRAIN_REPOS) {
    commit(up(r), 'initial');
    git(up(r), 'tag', '-a', '0.1.0', '-m', 'train 0.1.0');
    git(WS, 'init', '--quiet', '--bare', join(WS, 'remotes', `${r}.git`));
    git(up(r), 'remote', 'add', 'origin', join(WS, 'remotes', `${r}.git`));
    git(up(r), 'push', '--quiet', 'origin', 'main', '--tags');
  }
  // Since the last train: alpha's requirement moved, delta is new, beta is as it was.
  put(
    join(comp, 'contracts/alpha.md'),
    '---\ncode: PLX-Alpha\nmaturity: standard\nbinds: repo\n---\n\n## § 1 One\n\n> - A repo MUST alpha twice.\n',
  );
  put(
    join(comp, 'approaches/delta.md'),
    '---\ncode: PLX-Delta\nmaturity: standard\nbinds: app\n---\n\n## § 1 One\n\n> - An app MUST delta.\n',
  );
  commit(comp, 'alpha moves, delta arrives');
  git(comp, 'push', '--quiet', 'origin', 'main');

  // Tenant acme: web (develop) with one app, platform (main).
  const web = join(WS, 'acme/web');
  const plat = join(WS, 'acme/platform');
  git(WS, 'init', '--quiet', web);
  git(web, 'checkout', '--quiet', '-b', 'develop');
  put(join(web, 'PLEXUS.md'), '---\nplexus: 0.1.0\nmodules: [PLX-Repo, PLX-JS, PLX-Delivery, PLX-Updates]\n---\n');
  put(join(web, '.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-web\n');
  put(join(web, 'apps/site/.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-app-nextjs\n');
  put(
    join(web, '.github/workflows/ci.yml'),
    'jobs:\n  changes:\n    uses: plexus-ms/ci-cd/.github/workflows/changes.yml@0.1.0\n  pipeline:\n    uses: plexus-ms/ci-cd/.github/workflows/pipeline.yml@0.1.0\n',
  );
  put(join(web, 'pnpm-workspace.yaml'), 'packages: ["apps/*"]\n');
  put(join(web, 'package.json'), '{"name": "web"}\n');
  put(join(web, 'template-owned.txt'), 'generated\n');
  put(join(web, 'apps/site/template-owned.txt'), 'generated\n');
  commit(web, 'initial');

  git(WS, 'init', '--quiet', plat);
  put(
    join(plat, 'PLEXUS.md'),
    '---\nplexus: 0.1.0\nmodules: [PLX-Repo, PLX-Tenancy, PLX-Platform, PLX-Updates]\n---\n',
  );
  put(join(plat, '.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-platform\n');
  put(
    join(plat, '.github/workflows/apps.yml'),
    'jobs:\n  apps:\n    uses: plexus-ms/ci-cd/.github/workflows/deploy.yml@0.1.0\n',
  );
  put(join(plat, 'template-owned.txt'), 'generated\n');
  commit(plat, 'initial');

  process.env.FAKE_LOG = FAKE_LOG();
  writeFileSync(FAKE_LOG(), '');
}

// ── running ──────────────────────────────────────────────────────────────────
interface Run {
  result?: ShipResult;
  error?: string;
  /** Everything narrated on stderr. */
  out: string;
}

async function run(options: Options, args: { train?: string; propagateOnly?: boolean } = {}): Promise<Run> {
  const stderr = new PassThrough();
  let out = '';
  stderr.on('data', (c: Buffer) => {
    out += c;
  });
  const io = { ...realIo(), stdout: new PassThrough(), stderr };
  const ctx = new Context(options, io);
  try {
    const result = await ship(ctx, { workspace: WS, today: '2026-01-02', ...args });
    return { result, out };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), out };
  }
}

const up = (r: string) => join(WS, 'plexus-ms', r);
const tagged = (r: string, v: string) => {
  try {
    git(up(r), 'rev-parse', '-q', '--verify', `refs/tags/${v}`);
    return true;
  } catch {
    return false;
  }
};
const remoteTagged = (r: string, v: string) => {
  try {
    git(join(WS, 'remotes', `${r}.git`), 'rev-parse', '-q', '--verify', `refs/tags/${v}`);
    return true;
  } catch {
    return false;
  }
};
const allTagged = (v: string) => TRAIN_REPOS.every((r) => tagged(r, v) && remoteTagged(r, v));
const noneTagged = (v: string) => TRAIN_REPOS.every((r) => !tagged(r, v));
const has = (text: string, needle: string | RegExp) =>
  typeof needle === 'string' ? text.includes(needle) : needle.test(text);

// ── scenarios ────────────────────────────────────────────────────────────────
test('dry run previews propagation in scratch clones and changes nothing', async () => {
  fixture('dry');
  const { result, error, out } = await run({ dryRun: true, yes: true });
  assert.equal(error, undefined, out);
  assert.ok(noneTagged('0.2.0'), 'no 0.2.0 tag anywhere');
  assert.match(read(join(up('platform'), 'ansible/galaxy.yml')), /^version: 0\.1\.0/, 'galaxy.yml untouched');
  assert.match(read(join(up('compendium'), 'essentials/standard.md')), /^version: v0$/m, 'standard.md untouched');
  assert.doesNotMatch(read(join(up('compendium'), 'contracts/alpha.md')), /^changed:/m, 'modules untouched');
  assert.ok(
    has(out, 'compendium: contracts/alpha.md: requirements changed since 0.1.0 → changed: 0.2.0'),
    'preview announces the stamps',
  );
  assert.ok(has(out, `[dry-run] > ${join(up('compendium'), 'contracts/alpha.md')}`), 'preview lists the write');
  assert.match(read(join(WS, 'acme/web/.github/workflows/ci.yml')), /@0\.1\.0/, 'consumer workflow refs untouched');
  assert.equal(
    git(join(WS, 'acme/web'), 'status', '--porcelain') + git(join(WS, 'acme/platform'), 'status', '--porcelain'),
    '',
    'consumer trees untouched',
  );
  const runs = copierRuns();
  assert.equal(runs.length, 3, 'copier ran for 3 sites');
  assert.ok(
    runs.every((l) => !l.startsWith(`${WS}/`)),
    'copier ran outside the workspace (scratch clones)',
  );
  assert.ok(
    runs.some((l) => has(l, ` ${up('preset-repo-web')} `) && has(l, '--vcs-ref main')),
    'copier read the local preset at main',
  );
  assert.ok(runs.some((l) => has(l, ` ${up('preset-app-nextjs')} `) && has(l, '--vcs-ref main')));
  assert.equal(runs.filter((l) => has(l, '--defaults')).length, 3, 'copier took defaults (never prompts in a preview)');
  assert.ok(has(out, 'M template-owned.txt'), 'preview shows the template-owned change');
  assert.ok(
    has(out, `[dry-run] $ (cd ${join(WS, 'acme/web')} && mise exec -- pnpm install`),
    'preview announces the lockfile refresh',
  );
  assert.ok(has(out, 'marker: plexus → next in acme/web/PLEXUS.md'), 'preview announces the marker sync');
  assert.ok(has(out, 'acme/platform: apps.yml ci-cd refs → @0.2.0'), 'preview lists the ref bumps');
  assert.deepEqual(result, {
    train: '0.2.0',
    preview: true,
    clean: ['acme/web', 'acme/web/apps/site', 'acme/platform'],
    conflicted: [],
    failed: [],
    skipped: [],
    released: true,
  });
});

test('happy path tags, pushes, bumps bookkeeping and updates every consumer', async () => {
  fixture('happy');
  const { result, error, out } = await run({ yes: true });
  assert.equal(error, undefined, out);
  assert.ok(allTagged('0.2.0'), 'all six repos tagged 0.2.0 locally and on origin');
  const comp = up('compendium');
  const map = read(join(comp, 'essentials/standard.md'));
  assert.match(map, /^version: 0\.2\.0$/m);
  assert.match(map, /^timestamp: 2026-01-02$/m);
  assert.equal(
    read(join(comp, 'contracts/alpha.md')).split('\n').slice(3, 5).join(' '),
    'binds: repo changed: 0.2.0',
    'moved module stamped after binds',
  );
  assert.match(read(join(comp, 'approaches/delta.md')), /^changed: 0\.2\.0$/m, 'new module stamped');
  assert.match(read(join(comp, 'approaches/beta.md')), /^changed: 0\.1\.0$/m, 'unmoved module keeps its stamp');
  assert.doesNotMatch(read(join(comp, 'approaches/gamma.md')), /^changed:/m, 'candidate never stamped');
  assert.ok(has(out, 'compendium: contracts/alpha.md: requirements changed since 0.1.0 → changed: 0.2.0'));
  assert.equal(git(comp, 'log', '-1', '--format=%s'), 'chore: train 0.2.0 bookkeeping');
  assert.equal(
    git(comp, 'rev-parse', '0.2.0^{commit}'),
    git(comp, 'rev-parse', 'main'),
    'tag points at the bookkeeping commit',
  );
  assert.match(read(join(up('platform'), 'ansible/galaxy.yml')), /^version: 0\.2\.0 /);
  const reqs = read(join(up('preset-repo-platform'), 'template/requirements.yml'));
  assert.match(reqs, /^ {4}version: 0\.2\.0$/m, 'platform pin bumped');
  assert.match(reqs, /^ {4}version: 9\.9\.9$/m, 'the other collection keeps its version');
  assert.match(read(join(up('ci-cd'), '.github/workflows/pipeline.yml')), /ci\.yml@0\.2\.0/);
  assert.match(read(join(up('preset-repo-web'), 'template/.github/workflows/ci.yml.jinja')), /changes\.yml@0\.2\.0/);
  assert.equal(
    git(up('platform'), 'rev-parse', 'main'),
    git(join(WS, 'remotes/platform.git'), 'rev-parse', 'main'),
    'bookkeeping pushed',
  );
  assert.equal(
    git(up('preset-app-nextjs'), 'rev-list', '--count', 'main'),
    '1',
    'unchanged repo tagged without a bookkeeping commit',
  );
  assert.deepEqual(
    copierRuns().map((l) => l.split(' ')[0]),
    [join(WS, 'acme/web'), join(WS, 'acme/web/apps/site'), join(WS, 'acme/platform')],
    'copier ran in the real sites, repo root before its app',
  );
  assert.ok(
    copierRuns().every((l) => !has(l, '--vcs-ref')),
    'no ref override against the published source',
  );
  assert.equal(copierRuns().filter((l) => has(l, '--defaults')).length, 3, 'unattended run lets copier take defaults');
  for (const f of [
    'acme/web/template-owned.txt',
    'acme/web/apps/site/template-owned.txt',
    'acme/platform/template-owned.txt',
  ])
    assert.match(read(join(WS, f)), /updated from/, f);
  assert.match(read(join(WS, 'acme/web/PLEXUS.md')), /^plexus: next$/m, 'marker follows the answers file');
  assert.match(read(join(WS, 'acme/platform/PLEXUS.md')), /^plexus: next$/m);
  assert.equal(fakeLog().filter((l) => l.startsWith('mise exec -- pnpm install')).length, 1, 'lockfile refreshed once');
  const ci = read(join(WS, 'acme/web/.github/workflows/ci.yml'));
  assert.match(ci, /changes\.yml@0\.2\.0/);
  assert.match(ci, /pipeline\.yml@0\.2\.0/);
  assert.match(read(join(WS, 'acme/platform/.github/workflows/apps.yml')), /deploy\.yml@0\.2\.0/);
  assert.deepEqual(result?.clean, ['acme/web', 'acme/web/apps/site', 'acme/platform']);
  assert.equal(result?.preview, false);
});

test('a train repo behind origin blocks the release', async () => {
  fixture('behind');
  const side = join(TMP, 'side');
  rmSync(side, { recursive: true, force: true });
  git(WS, 'clone', '--quiet', join(WS, 'remotes/platform.git'), side);
  put(join(side, 'elsewhere'), 'x\n');
  commit(side, 'landed elsewhere');
  git(side, 'push', '--quiet', 'origin', 'main');
  const { error } = await run({ yes: true });
  assert.match(error ?? '', /platform is 1 commit\(s\) behind origin\/main/);
  assert.ok(noneTagged('0.2.0'));
});

test('disagreeing latest tags refuse a derived version and accept an explicit one', async () => {
  fixture('skew');
  git(up('platform'), 'tag', '-a', '0.2.0', '-m', 'half train');
  git(up('platform'), 'push', '--quiet', 'origin', '0.2.0');
  const first = await run({ yes: true });
  assert.match(first.error ?? '', /latest tags disagree/);
  assert.match(first.error ?? '', /^ {2}ci-cd: 0\.1\.0$/m, "shows each repo's latest tag");
  assert.match(first.error ?? '', /--train 0\.2\.0/, 'names the recovery');
  assert.ok(!tagged('ci-cd', '0.2.0') && !tagged('ci-cd', '0.3.0'));
  const second = await run({ yes: true }, { train: '0.2.0' });
  assert.equal(second.error, undefined, second.out);
  assert.ok(allTagged('0.2.0'));
  assert.ok(has(second.out, '• platform: already tagged 0.2.0'), 'already-tagged repo reported, not re-tagged');
});

test('a push failure mid-release names the recovery, and the re-run finishes the train', async () => {
  fixture('midway');
  // origin keeps answering fetches but rejects every push, like a lost permission would.
  const hook = join(WS, 'remotes/preset-repo-web.git/hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "rejected by the test" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const first = await run({ yes: true });
  assert.match(first.error ?? '', /ship stopped during the release; re-run with --train 0\.2\.0/);
  assert.ok(
    tagged('platform', '0.2.0') &&
      remoteTagged('platform', '0.2.0') &&
      tagged('ci-cd', '0.2.0') &&
      remoteTagged('ci-cd', '0.2.0'),
    'repos before the failure tagged and pushed',
  );
  assert.ok(
    tagged('preset-repo-web', '0.2.0') && !remoteTagged('preset-repo-web', '0.2.0'),
    'failing repo tagged locally only',
  );
  assert.ok(
    !tagged('preset-app-nextjs', '0.2.0') && !tagged('preset-repo-platform', '0.2.0'),
    'repos after the failure untouched',
  );
  assert.equal(git(join(WS, 'acme/web'), 'status', '--porcelain'), '', 'consumers untouched');
  rmSync(hook);
  const second = await run({ yes: true });
  assert.match(second.error ?? '', /latest tags disagree/, 'version-less re-run refuses the skew');
  const third = await run({ yes: true }, { train: '0.2.0' });
  assert.equal(third.error, undefined, third.out);
  assert.ok(allTagged('0.2.0'));
  assert.ok(has(third.out, '• preset-repo-web: already tagged 0.2.0'));
  assert.match(read(join(WS, 'acme/platform/template-owned.txt')), /updated from/, 're-run: consumers updated');
});

test('a failing site does not stop the others, and the summary says so', async () => {
  fixture('failsite');
  process.env.FAKE_COPIER_FAIL = 'acme/platform';
  const { result, error, out } = await run({ yes: true });
  delete process.env.FAKE_COPIER_FAIL;
  assert.equal(error, undefined, out);
  assert.ok(allTagged('0.2.0'), 'release completed');
  assert.match(read(join(WS, 'acme/web/template-owned.txt')), /updated from/);
  assert.match(read(join(WS, 'acme/platform/template-owned.txt')), /generated/, 'failed site left as it was');
  assert.match(
    read(join(WS, 'acme/platform/.github/workflows/apps.yml')),
    /@0\.2\.0/,
    'workflow refs still bumped everywhere',
  );
  assert.ok(has(out, '✗ FAILED — copier update exited nonzero: fake copier: failing on purpose'));
  assert.deepEqual(result?.failed, ['acme/platform']);
  assert.deepEqual(result?.clean, ['acme/web', 'acme/web/apps/site']);
});

test('a conflict is reported', async () => {
  fixture('conflict');
  process.env.FAKE_COPIER_CONFLICT = 'acme/web/apps';
  const { result, out } = await run({ yes: true });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.ok(has(out, '✗ CONFLICTS'));
  assert.deepEqual(result?.conflicted, ['acme/web/apps/site']);
  assert.deepEqual(result?.clean, ['acme/web', 'acme/platform']);
});

test('consumer protection: tracked changes and wrong branches skip, untracked files do not', async () => {
  fixture('dirty');
  put(join(WS, 'acme/web/notes.txt'), 'scratch\n'); // untracked: harmless
  put(join(WS, 'acme/platform/template-owned.txt'), 'generated\nedited\n'); // tracked modification: skipped
  const dirty = await run({ yes: true });
  assert.match(
    read(join(WS, 'acme/web/template-owned.txt')),
    /updated from/,
    'untracked file does not block the web repo',
  );
  assert.ok(!fakeLog().some((l) => has(l, join(WS, 'acme/platform'))), 'dirty platform repo not touched by copier');
  assert.match(
    read(join(WS, 'acme/platform/.github/workflows/apps.yml')),
    /deploy\.yml@0\.1\.0/,
    'keeps its workflow refs',
  );
  assert.ok(has(dirty.out, 'acme/platform: has uncommitted changes — skipped'));
  assert.deepEqual(dirty.result?.skipped, [{ path: 'acme/platform', reason: 'has uncommitted changes' }]);

  fixture('branch');
  git(join(WS, 'acme/web'), 'checkout', '--quiet', '-b', 'feature/x');
  const branch = await run({ yes: true });
  assert.ok(has(branch.out, "acme/web: on 'feature/x', expected 'develop' — skipped"));
  assert.ok(!fakeLog().some((l) => has(l, join(WS, 'acme/web'))), 'web repo not touched by copier');
  assert.match(
    read(join(WS, 'acme/platform/template-owned.txt')),
    /updated from/,
    'platform repo on main still updated',
  );
});

test('propagate-only validates the version and bumps to the current train', async () => {
  fixture('prop');
  const bad = await run({ yes: true }, { propagateOnly: true, train: '1.2' });
  assert.match(bad.error ?? '', /'1\.2' is not plain semver/);
  const { result, error, out } = await run({ yes: true }, { propagateOnly: true });
  assert.equal(error, undefined, out);
  assert.ok(noneTagged('0.2.0'));
  assert.match(read(join(WS, 'acme/web/template-owned.txt')), /updated from/);
  assert.match(
    read(join(WS, 'acme/web/.github/workflows/ci.yml')),
    /changes\.yml@0\.1\.0/,
    'refs stay at the current train',
  );
  assert.equal(result?.train, '0.1.0');
  assert.equal(result?.released, false);
});

test('the confirmation aborts cleanly without a terminal', async () => {
  fixture('prompt');
  const { error, out } = await run({});
  assert.match(error ?? '', /cannot ask .* without a terminal; pass --yes/);
  assert.ok(noneTagged('0.2.0'));
  assert.ok(!has(out, 'stopped during the release'), 'no recovery hint (nothing was started)');
});
