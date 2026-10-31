// The offline harness for ship: a scratch workspace laid out like ~/dev — the
// five train repos with bare "origin" remotes (the compendium among them), a
// tenant with a web repo (root + one app, on develop) and a platform repo (on
// main), each with a bare origin of its own — plus fakes for `copier`, `mise`,
// `gh` and `npm` on PATH, and a scratch "forge" the gh and npm fakes share.
// Each scenario builds a fresh fixture, runs `ship` against it with the real
// Io, and asserts on tags, releases, the consumers' origins, the summary and
// the narration.
//
// Fake copier: `copier update` writes "updated from <ref>" into
// template-owned.txt, bumps _commit in the answers file, and touches
// package.json at a web root (so the lockfile refresh triggers). Knobs:
//   FAKE_COPIER_FAIL=<substring>      exit 1 at a site whose path matches
//   FAKE_COPIER_CONFLICT=<substring>  leave <<<<<<< markers at a matching site
// Fake gh: releases and pull requests are files under the forge, keyed by the
// repo (the basename of origin); `release create` checks the tag is on origin
// and, on primitives, "publishes" the train to the fake registry. Knobs:
//   FAKE_GH_LOGGED_OUT=1              `gh auth status` fails
//   FAKE_GH_MUTABLE=1                 releases are created mutable
// Fake npm: `npm view <pkg>@<v> version` answers once primitives' release of
// v exists and FAKE_NPM_POLLS polls have gone by; FAKE_NPM_NEVER=1 never answers.
// Every invocation is appended to FAKE_LOG.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Context, type Options } from './context.ts';
import { COPIER_VERSION } from './copier.ts';
import { realIo } from './io.ts';
import { type ShipOptions, type ShipResult, ship } from './ship.ts';
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
// Fake mise: logs, and runs the pinned copier (`mise exec copier@X -- copier …`)
// as the fake copier above; anything else it only logs.
script(
  'mise',
  `echo "mise $*" >> "$FAKE_LOG"
if [ "$1" = exec ] && [[ "$2" == copier@* ]] && [ "$3" = -- ]; then shift 3; exec "$@"; fi
`,
);
script(
  'gh',
  `repo="$(basename "$(git remote get-url origin 2>/dev/null || echo "$PWD")" .git)"
echo "gh[$repo] $*" >> "$FAKE_LOG"
dir="$FAKE_FORGE/$repo"; mkdir -p "$dir"
arg() { local k="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "$2"; return; }; shift; done; }
case "$1 $2" in
  "auth status") [ -z "\${FAKE_GH_LOGGED_OUT:-}" ] || { echo "not logged in" >&2; exit 1; }; echo "logged in" ;;
  "release view") [ -f "$dir/release-$3" ] || { echo "release not found" >&2; exit 1; }; cat "$dir/release-$3" ;;
  "release create")
    git ls-remote --exit-code --tags origin "refs/tags/$3" >/dev/null || { echo "tag $3 not on origin" >&2; exit 1; }
    [ -z "\${FAKE_GH_MUTABLE:-}" ] && echo true > "$dir/release-$3" || echo false > "$dir/release-$3"
    [ "$repo" != primitives ] || echo "$3" >> "$FAKE_FORGE/npm-published" ;;
  "api "*)
    case "$2" in
      *"/releases/tags/"*) cat "$dir/release-\${2##*/}" ;;
      *) ls "$dir"/release-* 2>/dev/null | tail -1 | xargs -r cat ;;
    esac ;;
  "pr list") f="$dir/pr-$(arg --head "$@" | tr / -)"; [ ! -f "$f" ] || cat "$f" ;;
  "pr create")
    head="$(arg --head "$@")"; f="$dir/pr-$(echo "$head" | tr / -)"
    [ ! -f "$f" ] || { echo "a pull request for $head already exists" >&2; exit 1; }
    echo "https://forge/$repo/pull/$(( $(ls "$dir" | grep -c '^pr-') + 1 ))" > "$f"
    arg --body "$@" > "$f.body"; arg --base "$@" > "$f.base"; cat "$f" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
`,
);
script(
  'npm',
  `echo "npm $*" >> "$FAKE_LOG"
[ "$1 $3" = "view version" ] || { echo "fake npm: unexpected $*" >&2; exit 1; }
v="\${2##*@}"
polls=$(( $(cat "$FAKE_FORGE/npm-polls" 2>/dev/null || echo 0) + 1 )); echo "$polls" > "$FAKE_FORGE/npm-polls"
[ -z "\${FAKE_NPM_NEVER:-}" ] || exit 0
[ "$polls" -gt "\${FAKE_NPM_POLLS:-0}" ] || exit 0
grep -qx "$v" "$FAKE_FORGE/npm-published" 2>/dev/null && echo "$v" || true
`,
);
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
const PRIMITIVES_REF = 'plexus-ms/primitives/.github/workflows/';

let WS = '';
const FAKE_LOG = () => join(WS, 'fake.log');
const FORGE = () => join(WS, 'forge');
const fakeLog = () => read(FAKE_LOG()).split('\n').filter(Boolean);
const copierRuns = () => fakeLog().filter((l) => l.startsWith('/'));
const up = (r: string) => join(WS, 'plexus-ms', r);
const remote = (r: string) => join(WS, 'remotes', `${r}.git`);

/** A bare origin for a repo, with its branches and tags pushed. */
const withOrigin = (path: string, name: string) => {
  git(WS, 'init', '--quiet', '--bare', remote(name));
  git(path, 'remote', 'add', 'origin', remote(name));
  git(path, 'push', '--quiet', 'origin', '--all');
  git(path, 'push', '--quiet', 'origin', '--tags');
};

function fixture(name: string): void {
  WS = join(TMP, `ws-${name}`);
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, 'plexus-ms'), { recursive: true });
  mkdirSync(join(WS, 'remotes'));
  mkdirSync(join(WS, 'acme'));
  mkdirSync(FORGE());
  for (const r of TRAIN_REPOS) git(WS, 'init', '--quiet', up(r));
  const prim = up('primitives');
  put(join(prim, 'ansible/galaxy.yml'), 'version: 0.1.0                # mirrors the release-train tag\n');
  for (const p of ['cli', 'lib', 'config'])
    put(join(prim, `packages/${p}/package.json`), `{\n  "name": "@plexus-ms/${p}",\n  "version": "0.1.0"\n}\n`);
  put(
    join(prim, 'package.json'),
    '{\n  "name": "primitives",\n  "devDependencies": { "@plexus-ms/config": "workspace:*" }\n}\n',
  );
  put(join(prim, '.github/workflows/pipeline.yml'), `jobs:\n  ci:\n    uses: ${PRIMITIVES_REF}ci.yml@0.1.0\n`);
  const web = up('preset-repo-web');
  put(join(web, 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(web, 'template/.github/workflows/ci.yml.jinja'),
    `jobs:\n  changes:\n    uses: ${PRIMITIVES_REF}changes.yml@0.1.0\n`,
  );
  put(
    join(web, 'template/mise.toml'),
    '[tools]\n"npm:@plexus-ms/cli" = { version = "0.0.1", allow_low_downloads = true }\n',
  );
  put(
    join(web, 'template/package.json.jinja'),
    '{\n  "devDependencies": {\n    "@plexus-ms/config": "^0.0.1"\n  }\n}\n',
  );
  const app = up('preset-app-nextjs');
  put(join(app, 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(app, 'template/package.json.jinja'),
    '{\n  "devDependencies": {\n    "@plexus-ms/config": "^0.0.1"\n  }\n}\n',
  );
  const plat = up('preset-repo-platform');
  put(join(plat, 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(plat, 'template/requirements.yml'),
    'collections:\n  - name: https://github.com/plexus-ms/primitives.git#/ansible/\n    type: git\n    version: 0.1.0\n  - name: community.docker\n    version: 9.9.9\n',
  );
  put(
    join(plat, 'template/mise.toml.jinja'),
    '[tools]\n"npm:@plexus-ms/cli" = { version = "0.0.1", allow_low_downloads = true }\n',
  );
  // The compendium: the map with a draft version, two standard modules (a
  // contract, and an approach already stamped) and one candidate module.
  const comp = up('compendium');
  put(join(comp, 'mise.toml'), '[tools]\n"npm:@plexus-ms/cli" = { version = "0.0.1", allow_low_downloads = true }\n');
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
    withOrigin(up(r), r);
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

  // Tenant acme: web (develop) with one app, platform (main), each with an origin.
  const tweb = join(WS, 'acme/web');
  const tplat = join(WS, 'acme/platform');
  git(WS, 'init', '--quiet', tweb);
  git(tweb, 'checkout', '--quiet', '-b', 'develop');
  put(join(tweb, 'PLEXUS.md'), '---\nplexus: 0.1.0\nmodules: [PLX-Repo, PLX-JS, PLX-Delivery, PLX-Updates]\n---\n');
  put(join(tweb, '.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-web\n');
  put(join(tweb, 'apps/site/.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-app-nextjs\n');
  put(
    join(tweb, '.github/workflows/ci.yml'),
    `jobs:\n  changes:\n    uses: ${PRIMITIVES_REF}changes.yml@0.1.0\n  pipeline:\n    uses: ${PRIMITIVES_REF}pipeline.yml@0.1.0\n`,
  );
  put(join(tweb, 'pnpm-workspace.yaml'), 'packages: ["apps/*"]\n');
  put(join(tweb, 'package.json'), '{"name": "web"}\n');
  put(join(tweb, 'template-owned.txt'), 'generated\n');
  put(join(tweb, 'apps/site/template-owned.txt'), 'generated\n');
  commit(tweb, 'initial');
  withOrigin(tweb, 'acme-web');

  git(WS, 'init', '--quiet', tplat);
  put(
    join(tplat, 'PLEXUS.md'),
    '---\nplexus: 0.1.0\nmodules: [PLX-Repo, PLX-Tenancy, PLX-Platform, PLX-Updates]\n---\n',
  );
  put(join(tplat, '.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-platform\n');
  put(join(tplat, '.github/workflows/apps.yml'), `jobs:\n  apps:\n    uses: ${PRIMITIVES_REF}deploy.yml@0.1.0\n`);
  put(join(tplat, 'template-owned.txt'), 'generated\n');
  commit(tplat, 'initial');
  withOrigin(tplat, 'acme-platform');

  process.env.FAKE_LOG = FAKE_LOG();
  process.env.FAKE_FORGE = FORGE();
  writeFileSync(FAKE_LOG(), '');
}

// ── running ──────────────────────────────────────────────────────────────────
interface Run {
  result?: ShipResult;
  error?: string;
  /** Everything narrated on stderr. */
  out: string;
}

async function run(options: Options, args: Partial<ShipOptions> = {}): Promise<Run> {
  const stderr = new PassThrough();
  let out = '';
  stderr.on('data', (c: Buffer) => {
    out += c;
  });
  const io = { ...realIo(), stdout: new PassThrough(), stderr };
  const ctx = new Context(options, io);
  try {
    const result = await ship(ctx, {
      workspace: WS,
      today: '2026-01-02',
      wait: { interval: 1, timeout: 1500 },
      ...args,
    });
    return { result, out };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), out };
  }
}

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
    git(remote(r), 'rev-parse', '-q', '--verify', `refs/tags/${v}`);
    return true;
  } catch {
    return false;
  }
};
const released = (r: string, v: string) => existsSync(join(FORGE(), r, `release-${v}`));
const allTagged = (v: string) => TRAIN_REPOS.every((r) => tagged(r, v) && remoteTagged(r, v));
const allReleased = (v: string) => TRAIN_REPOS.every((r) => released(r, v));
const noneTagged = (v: string) => TRAIN_REPOS.every((r) => !tagged(r, v));
const has = (text: string, needle: string | RegExp) =>
  typeof needle === 'string' ? text.includes(needle) : needle.test(text);
/** A file as the consumer's origin has it on the train branch. */
const onTrain = (r: string, v: string, file: string) => git(remote(r), 'show', `train/${v}:${file}`);
const pull = (r: string, v: string, suffix = '') => read(join(FORGE(), r, `pr-train-${v}${suffix}`)).trim();
const consumersUntouched = () => {
  for (const r of ['acme/web', 'acme/platform']) {
    assert.equal(git(join(WS, r), 'status', '--porcelain'), '', `${r} checkout clean`);
    assert.match(read(join(WS, r, 'template-owned.txt')), /^generated$/m, `${r} checkout not updated`);
  }
};

// ── scenarios ────────────────────────────────────────────────────────────────
test('dry run previews both phases and the propagation in scratch clones, and changes nothing', async () => {
  fixture('dry');
  const { result, error, out } = await run({ dryRun: true, yes: true });
  assert.equal(error, undefined, out);
  assert.ok(noneTagged('0.2.0'), 'no 0.2.0 tag anywhere');
  assert.ok(!allReleased('0.2.0') && !released('primitives', '0.2.0'), 'no release created');
  assert.match(read(join(up('primitives'), 'ansible/galaxy.yml')), /^version: 0\.1\.0/, 'galaxy.yml untouched');
  assert.match(read(join(up('compendium'), 'essentials/standard.md')), /^version: v0$/m, 'standard.md untouched');
  assert.doesNotMatch(read(join(up('compendium'), 'contracts/alpha.md')), /^changed:/m, 'modules untouched');
  assert.ok(has(out, '→ phase: primitives'), 'phase one announced');
  assert.ok(has(out, '→ phase: preset-repo-web, preset-app-nextjs, preset-repo-platform, compendium'), 'phase two');
  assert.ok(
    has(out, '⏳ [dry-run] would wait for @plexus-ms/cli@0.2.0, @plexus-ms/lib@0.2.0, @plexus-ms/config@0.2.0 on npm'),
    'the wait is a step of the preview',
  );
  assert.ok(!fakeLog().some((l) => l.startsWith('npm ')), 'registry not polled');
  assert.ok(has(out, 'primitives: packages/cli/package.json: @plexus-ms/cli → 0.2.0'), 'preview lists package bumps');
  assert.ok(has(out, 'preset-repo-web: template/mise.toml: plx pin → 0.2.0'));
  assert.ok(has(out, 'preset-app-nextjs: template/package.json.jinja: @plexus-ms/config pin → 0.2.0'));
  assert.ok(has(out, 'compendium: mise.toml: plx pin → 0.2.0'));
  assert.ok(
    has(out, 'compendium: contracts/alpha.md: requirements changed since 0.1.0 → changed: 0.2.0'),
    'preview announces the stamps',
  );
  assert.ok(has(out, `[dry-run] > ${join(up('compendium'), 'contracts/alpha.md')}`), 'preview lists the write');
  assert.ok(has(out, `[dry-run] $ (cd ${up('primitives')} && gh release create 0.2.0 --verify-tag`), 'release step');
  consumersUntouched();
  assert.match(read(join(WS, 'acme/web/.github/workflows/ci.yml')), /@0\.1\.0/, 'consumer workflow refs untouched');
  assert.throws(() => onTrain('acme-web', '0.2.0', 'template-owned.txt'), 'no train branch pushed');
  const runs = copierRuns();
  assert.equal(runs.length, 3, 'copier ran for 3 sites');
  assert.equal(
    fakeLog().filter((l) => l.startsWith(`mise exec copier@${COPIER_VERSION} -- copier update`)).length,
    3,
    'copier ran at the version plx pins',
  );
  assert.equal(
    (out.match(/MISE_IGNORED_CONFIG_PATHS=\S+ mise exec copier@/g) ?? []).length,
    3,
    "copier ran with the clone's mise config ignored",
  );
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
  assert.equal(runs.filter((l) => has(l, '--skip-tasks')).length, 3, 'template tasks skipped in the clones');
  assert.ok(has(out, 'M template-owned.txt'), 'preview shows the template-owned change');
  assert.ok(
    has(out, /\[dry-run\] \$ \(cd \S+\/acme\/web && mise exec -- pnpm install/),
    'preview announces the lockfile refresh in the clone',
  );
  assert.ok(has(out, 'marker: plexus → next in acme/web/PLEXUS.md'), 'preview announces the marker sync');
  assert.ok(has(out, 'acme/platform: apps.yml workflow refs → @0.2.0'), 'preview lists the ref bumps');
  assert.ok(has(out, '(preview) acme/web: would commit, push train/0.2.0 and open a pull request against develop'));
  assert.ok(has(out, '(preview) acme/platform: would commit, push train/0.2.0 and open a pull request against main'));
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request opened');
  assert.deepEqual(result, {
    train: '0.2.0',
    preview: true,
    clean: ['acme/platform', 'acme/web', 'acme/web/apps/site'],
    conflicted: [],
    failed: [],
    skipped: [],
    pulls: [],
    released: true,
  });
});

test('happy path: primitives first, the npm wait, the rest, then one pull request per consumer', async () => {
  fixture('happy');
  process.env.FAKE_NPM_POLLS = '4';
  const { result, error, out } = await run({ yes: true });
  delete process.env.FAKE_NPM_POLLS;
  assert.equal(error, undefined, out);
  assert.ok(allTagged('0.2.0'), 'all five repos tagged 0.2.0 locally and on origin');
  assert.ok(allReleased('0.2.0'), 'a release on every train repo');

  // Phase one: primitives' bookkeeping, tag, release.
  const prim = up('primitives');
  assert.match(read(join(prim, 'ansible/galaxy.yml')), /^version: 0\.2\.0 /);
  for (const p of ['cli', 'lib', 'config'])
    assert.match(read(join(prim, `packages/${p}/package.json`)), /"version": "0\.2\.0"/, `${p} at the train number`);
  assert.match(read(join(prim, 'package.json')), /"workspace:\*"/, 'workspace reference left alone');
  assert.match(read(join(prim, '.github/workflows/pipeline.yml')), /ci\.yml@0\.2\.0/);
  assert.equal(git(prim, 'log', '-1', '--format=%s'), 'chore: train 0.2.0 bookkeeping');
  assert.equal(
    git(prim, 'rev-parse', '0.2.0^{commit}'),
    git(prim, 'rev-parse', 'main'),
    'tag on the bookkeeping commit',
  );
  assert.equal(git(prim, 'rev-parse', 'main'), git(remote('primitives'), 'rev-parse', 'main'), 'bookkeeping pushed');

  // The order: primitives released, the registry polled until it answers, only then the presets.
  const log = fakeLog();
  const at = (needle: string) => log.findIndex((l) => has(l, needle));
  const primRelease = at('gh[primitives] release create 0.2.0');
  const firstPoll = at('npm view @plexus-ms/cli@0.2.0 version');
  const presetRelease = at('gh[preset-repo-web] release create 0.2.0');
  assert.ok(primRelease >= 0 && primRelease < firstPoll && firstPoll < presetRelease, `order in:\n${log.join('\n')}`);
  assert.ok(
    log.filter((l) => has(l, 'npm view @plexus-ms/cli@0.2.0')).length >= 2,
    'polled more than once, until the publish',
  );
  assert.ok(has(out, '✓ @plexus-ms/cli@0.2.0, @plexus-ms/lib@0.2.0, @plexus-ms/config@0.2.0 on npm'));
  assert.ok(has(out, '→ phase: primitives\n'), 'phase one narrated');

  // Phase two: the presets and the compendium.
  const map = read(join(up('compendium'), 'essentials/standard.md'));
  assert.match(map, /^version: 0\.2\.0$/m);
  assert.match(map, /^timestamp: 2026-01-02$/m);
  assert.equal(
    read(join(up('compendium'), 'contracts/alpha.md'))
      .split('\n')
      .slice(3, 5)
      .join(' '),
    'binds: repo changed: 0.2.0',
    'moved module stamped after binds',
  );
  assert.match(read(join(up('compendium'), 'approaches/delta.md')), /^changed: 0\.2\.0$/m, 'new module stamped');
  assert.match(
    read(join(up('compendium'), 'approaches/beta.md')),
    /^changed: 0\.1\.0$/m,
    'unmoved module keeps its stamp',
  );
  assert.doesNotMatch(read(join(up('compendium'), 'approaches/gamma.md')), /^changed:/m, 'candidate never stamped');
  assert.match(read(join(up('compendium'), 'mise.toml')), /version = "0\.2\.0"/, "the compendium's plx pin");
  const reqs = read(join(up('preset-repo-platform'), 'template/requirements.yml'));
  assert.match(reqs, /^ {4}version: 0\.2\.0$/m, 'collection pin bumped');
  assert.match(reqs, /^ {4}version: 9\.9\.9$/m, 'the other collection keeps its version');
  assert.match(read(join(up('preset-repo-platform'), 'template/mise.toml.jinja')), /version = "0\.2\.0"/);
  assert.match(read(join(up('preset-repo-web'), 'template/mise.toml')), /version = "0\.2\.0"/);
  assert.match(
    read(join(up('preset-repo-web'), 'template/package.json.jinja')),
    /"@plexus-ms\/config": "0\.2\.0"/,
    'exact',
  );
  assert.match(read(join(up('preset-app-nextjs'), 'template/package.json.jinja')), /"@plexus-ms\/config": "0\.2\.0"/);
  assert.match(read(join(up('preset-repo-web'), 'template/.github/workflows/ci.yml.jinja')), /changes\.yml@0\.2\.0/);

  // Propagation: the workspace checkouts stay as they are; the origins get a train branch and a pull request.
  consumersUntouched();
  assert.deepEqual(
    copierRuns().map((l) => l.split(' ')[0]?.replace(/^.*\/acme\//, 'acme/')),
    ['acme/platform', 'acme/web', 'acme/web/apps/site'],
    'copier ran in the clones, consumers in tree order, a repo root before its app',
  );
  assert.ok(
    copierRuns().every((l) => !has(l, '--vcs-ref') && has(l, '--skip-tasks')),
    'no ref override against the published source; tasks skipped',
  );
  assert.equal(copierRuns().filter((l) => has(l, '--defaults')).length, 3, 'unattended run lets copier take defaults');
  for (const [r, f] of [
    ['acme-web', 'template-owned.txt'],
    ['acme-web', 'apps/site/template-owned.txt'],
    ['acme-platform', 'template-owned.txt'],
  ] as const)
    assert.match(onTrain(r, '0.2.0', f), /updated from/, `${r}:${f}`);
  assert.match(onTrain('acme-web', '0.2.0', 'PLEXUS.md'), /^plexus: next$/m, 'marker follows the answers file');
  assert.match(onTrain('acme-platform', '0.2.0', 'PLEXUS.md'), /^plexus: next$/m);
  const ci = onTrain('acme-web', '0.2.0', '.github/workflows/ci.yml');
  assert.match(ci, /changes\.yml@0\.2\.0/);
  assert.match(ci, /pipeline\.yml@0\.2\.0/);
  assert.match(onTrain('acme-platform', '0.2.0', '.github/workflows/apps.yml'), /deploy\.yml@0\.2\.0/);
  assert.equal(git(remote('acme-web'), 'log', '-1', '--format=%s', 'train/0.2.0'), 'chore: train 0.2.0');
  assert.equal(git(remote('acme-web'), 'rev-list', '--count', 'develop..train/0.2.0'), '1', 'one commit on the branch');
  assert.equal(
    git(remote('acme-web'), 'rev-parse', 'develop'),
    git(join(WS, 'acme/web'), 'rev-parse', 'develop'),
    'develop untouched',
  );
  assert.equal(fakeLog().filter((l) => l.startsWith('mise exec -- pnpm install')).length, 1, 'lockfile refreshed once');
  assert.equal(pull('acme-web', '0.2.0'), 'https://forge/acme-web/pull/1');
  assert.equal(pull('acme-web', '0.2.0', '.base'), 'develop');
  assert.equal(pull('acme-platform', '0.2.0', '.base'), 'main');
  assert.match(pull('acme-web', '0.2.0', '.body'), /Train 0\.2\.0 .*acme\/web, acme\/web\/apps\/site/);
  assert.match(pull('acme-web', '0.2.0', '.body'), /Merged clean/);
  assert.ok(has(out, 'acme/web: pull request opened: https://forge/acme-web/pull/1'));
  assert.deepEqual(result?.clean, ['acme/platform', 'acme/web', 'acme/web/apps/site']);
  assert.deepEqual(result?.pulls, ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1']);
  assert.equal(result?.preview, false);
});

test('a re-run of the propagation moves the train branch and reuses its pull request', async () => {
  fixture('rerun');
  const first = await run({ yes: true });
  assert.equal(first.error, undefined, first.out);
  const second = await run({ yes: true }, { propagateOnly: true });
  assert.equal(second.error, undefined, second.out);
  assert.equal(fakeLog().filter((l) => has(l, 'pr create')).length, 2, 'two consumers, two pull requests in all');
  assert.ok(has(second.out, 'acme/web: pull request updated: https://forge/acme-web/pull/1'));
  assert.equal(
    git(remote('acme-web'), 'rev-list', '--count', 'develop..train/0.2.0'),
    '1',
    'branch replaced, not stacked',
  );
  assert.deepEqual(second.result?.pulls, ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1']);
});

test('the state of the workspace checkouts does not matter to the propagation', async () => {
  fixture('checkouts');
  put(join(WS, 'acme/web/notes.txt'), 'scratch\n'); // untracked
  put(join(WS, 'acme/platform/template-owned.txt'), 'generated\nedited\n'); // tracked modification
  git(join(WS, 'acme/web'), 'checkout', '--quiet', '-b', 'feature/x'); // wrong branch
  const { result, error, out } = await run({ yes: true });
  assert.equal(error, undefined, out);
  assert.match(onTrain('acme-web', '0.2.0', 'template-owned.txt'), /updated from/, 'origin updated from develop');
  assert.match(onTrain('acme-platform', '0.2.0', 'template-owned.txt'), /updated from/);
  assert.equal(git(join(WS, 'acme/web'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x', 'checkout left alone');
  assert.match(read(join(WS, 'acme/platform/template-owned.txt')), /edited/, 'local edit left alone');
  assert.deepEqual(result?.skipped, []);
});

test('a train repo behind origin blocks the release', async () => {
  fixture('behind');
  const side = join(TMP, 'side');
  rmSync(side, { recursive: true, force: true });
  git(WS, 'clone', '--quiet', remote('primitives'), side);
  put(join(side, 'elsewhere'), 'x\n');
  commit(side, 'landed elsewhere');
  git(side, 'push', '--quiet', 'origin', 'main');
  const { error } = await run({ yes: true });
  assert.match(error ?? '', /primitives is 1 commit\(s\) behind origin\/main/);
  assert.ok(noneTagged('0.2.0'));
});

test('a logged-out gh and a mutable release both stop the train before anything is written', async () => {
  fixture('forge');
  process.env.FAKE_GH_LOGGED_OUT = '1';
  const out = await run({ yes: true });
  delete process.env.FAKE_GH_LOGGED_OUT;
  assert.match(out.error ?? '', /gh is not logged in/);
  assert.ok(noneTagged('0.2.0'));

  mkdirSync(join(FORGE(), 'compendium'), { recursive: true });
  writeFileSync(join(FORGE(), 'compendium', 'release-0.1.0'), 'false\n');
  const mutable = await run({ yes: true });
  assert.match(mutable.error ?? '', /compendium: its newest GitHub release is not immutable/);
  assert.ok(noneTagged('0.2.0'));
});

test('a release created mutable stops the run after primitives, with the recovery named', async () => {
  fixture('mutable');
  process.env.FAKE_GH_MUTABLE = '1';
  const { error } = await run({ yes: true });
  delete process.env.FAKE_GH_MUTABLE;
  assert.match(error ?? '', /primitives: release 0\.2\.0 was created mutable/);
  assert.match(error ?? '', /never delete one/);
  assert.match(error ?? '', /re-run with --train 0\.2\.0/);
  assert.ok(tagged('primitives', '0.2.0') && released('primitives', '0.2.0'));
  assert.ok(!tagged('preset-repo-web', '0.2.0'), 'phase two not started');
});

test('a registry that never answers stops the run resumably; the re-run skips what exists', async () => {
  fixture('npm');
  process.env.FAKE_NPM_NEVER = '1';
  const first = await run({ yes: true });
  delete process.env.FAKE_NPM_NEVER;
  assert.match(
    first.error ?? '',
    /@plexus-ms\/cli, @plexus-ms\/lib, @plexus-ms\/config not on npm at 0\.2\.0 after \d+ min/,
  );
  assert.match(first.error ?? '', /re-run with --train 0\.2\.0/);
  assert.ok(tagged('primitives', '0.2.0') && remoteTagged('primitives', '0.2.0') && released('primitives', '0.2.0'));
  assert.ok(!tagged('compendium', '0.2.0'), 'phase two not started');
  consumersUntouched();
  const second = await run({ yes: true }, { train: '0.2.0' });
  assert.equal(second.error, undefined, second.out);
  assert.ok(has(second.out, '• primitives: already tagged 0.2.0'));
  assert.ok(has(second.out, '• primitives: release 0.2.0 exists'), 'release never re-created');
  assert.equal(fakeLog().filter((l) => has(l, 'gh[primitives] release create')).length, 1);
  assert.ok(allTagged('0.2.0') && allReleased('0.2.0'));
});

test('disagreeing latest tags refuse a derived version and accept an explicit one', async () => {
  fixture('skew');
  git(up('primitives'), 'tag', '-a', '0.2.0', '-m', 'half train');
  git(up('primitives'), 'push', '--quiet', 'origin', '0.2.0');
  const first = await run({ yes: true });
  assert.match(first.error ?? '', /latest tags disagree/);
  assert.match(first.error ?? '', /^ {2}preset-repo-web: 0\.1\.0$/m, "shows each repo's latest tag");
  assert.match(first.error ?? '', /--train 0\.2\.0/, 'names the recovery');
  assert.ok(!tagged('compendium', '0.2.0') && !tagged('compendium', '0.3.0'));
  const second = await run({ yes: true }, { train: '0.2.0' });
  assert.equal(second.error, undefined, second.out);
  assert.ok(allTagged('0.2.0'));
  assert.ok(has(second.out, '• primitives: already tagged 0.2.0'), 'already-tagged repo reported, not re-tagged');
});

test('a push failure mid-release names the recovery, and the re-run finishes the train', async () => {
  fixture('midway');
  // origin keeps answering fetches but rejects every push, like a lost permission would.
  const hook = join(remote('preset-repo-web'), 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "rejected by the test" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const first = await run({ yes: true });
  assert.match(first.error ?? '', /ship stopped during the release; re-run with --train 0\.2\.0/);
  assert.ok(
    tagged('primitives', '0.2.0') && remoteTagged('primitives', '0.2.0') && released('primitives', '0.2.0'),
    'phase one done',
  );
  assert.ok(
    tagged('preset-repo-web', '0.2.0') &&
      !remoteTagged('preset-repo-web', '0.2.0') &&
      !released('preset-repo-web', '0.2.0'),
    'failing repo tagged locally only, no release',
  );
  assert.ok(
    !tagged('preset-app-nextjs', '0.2.0') && !tagged('preset-repo-platform', '0.2.0'),
    'repos after the failure untouched',
  );
  consumersUntouched();
  rmSync(hook);
  const second = await run({ yes: true });
  assert.match(second.error ?? '', /latest tags disagree/, 'version-less re-run refuses the skew');
  const third = await run({ yes: true }, { train: '0.2.0' });
  assert.equal(third.error, undefined, third.out);
  assert.ok(allTagged('0.2.0') && allReleased('0.2.0'));
  assert.ok(has(third.out, '• preset-repo-web: already tagged 0.2.0'));
  assert.match(onTrain('acme-platform', '0.2.0', 'template-owned.txt'), /updated from/, 're-run: consumers updated');
});

test('a failing site does not stop the others, and the summary says so', async () => {
  fixture('failsite');
  process.env.FAKE_COPIER_FAIL = 'acme/platform';
  const { result, error, out } = await run({ yes: true });
  delete process.env.FAKE_COPIER_FAIL;
  assert.equal(error, undefined, out);
  assert.ok(allTagged('0.2.0'), 'release completed');
  assert.match(onTrain('acme-web', '0.2.0', 'template-owned.txt'), /updated from/);
  assert.match(
    onTrain('acme-platform', '0.2.0', '.github/workflows/apps.yml'),
    /@0\.2\.0/,
    'workflow refs still bumped and proposed for the failed site',
  );
  assert.match(onTrain('acme-platform', '0.2.0', 'template-owned.txt'), /generated/, 'failed site left as it was');
  assert.ok(has(out, '✗ FAILED — copier update exited nonzero: fake copier: failing on purpose'));
  assert.deepEqual(result?.failed, ['acme/platform']);
  assert.deepEqual(result?.clean, ['acme/web', 'acme/web/apps/site']);
});

test('a conflict is committed with its markers and the pull request says so', async () => {
  fixture('conflict');
  process.env.FAKE_COPIER_CONFLICT = 'acme/web/apps';
  const { result, out } = await run({ yes: true });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.ok(has(out, '✗ CONFLICTS'));
  assert.deepEqual(result?.conflicted, ['acme/web/apps/site']);
  assert.deepEqual(result?.clean, ['acme/platform', 'acme/web']);
  assert.match(onTrain('acme-web', '0.2.0', 'apps/site/template-owned.txt'), /^<<<<<<< /m, 'markers in the branch');
  assert.match(pull('acme-web', '0.2.0', '.body'), /Conflicts to resolve.*acme\/web\/apps\/site/);
  assert.equal(result?.pulls.length, 2, 'the pull request is opened all the same');
});

test('propagate-only validates the version and bumps to the current train', async () => {
  fixture('prop');
  const bad = await run({ yes: true }, { propagateOnly: true, train: '1.2' });
  assert.match(bad.error ?? '', /'1\.2' is not plain semver/);
  const { result, error, out } = await run({ yes: true }, { propagateOnly: true });
  assert.equal(error, undefined, out);
  assert.ok(noneTagged('0.2.0'));
  assert.match(onTrain('acme-web', '0.1.0', 'template-owned.txt'), /updated from/);
  assert.match(
    onTrain('acme-web', '0.1.0', '.github/workflows/ci.yml'),
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
