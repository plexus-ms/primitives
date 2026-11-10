// The offline harness for ship: a scratch workspace laid out like ~/dev — the
// five train repos with bare "origin" remotes (the compendium among them), a
// tenant with a web repo (root + one app, on develop) and a platform repo (on
// main), each with a bare origin of its own — plus fakes for `copier`, `mise`,
// `gh` and `npm` on PATH, and a scratch "forge" the gh and npm fakes share.
// Each scenario builds a fresh fixture, runs `ship`, `propagate` or `update`
// against it with the real Io, and asserts on tags, releases, the consumers'
// origins, the summary and the narration.
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
// `api repos/<o>/<r>/releases` lists that repo's published releases as
// "<tag> <date>", the date from `trainCut` (default: 2026-01-01, the fixture's
// epoch). A release created with --draft is a draft until `release edit
// --draft=false`: it takes uploads (kept as asset-<tag>-<name>) and is left
// out of the listing; a published one refuses them.
//   FAKE_GH_UPLOAD_FAIL=1             `gh release upload` fails
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
import { parseManifest } from './manifest.ts';
import { type PropagateOptions, propagate } from './propagate.ts';
import { type ShipOptions, type ShipResult, ship } from './ship.ts';
import type { Summary } from './take.ts';
import { TRAIN_REPOS } from './train.ts';
import { type UpdateOptions, update } from './update.ts';

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
  `echo "mise $* ignored=\${MISE_IGNORED_CONFIG_PATHS:-}" >> "$FAKE_LOG"
if [ "$1" = exec ] && [[ "$2" == copier@* ]] && [ "$3" = -- ]; then shift 3; exec "$@"; fi
`,
);
script(
  'gh',
  `repo="$(basename "$(git remote get-url origin 2>/dev/null || echo "$PWD")" .git)"
# \`gh api repos/<owner>/<repo>/...\` names its repo in the path.
case "$2" in repos/[!{]*/[!{]*/*) r="\${2#repos/*/}"; repo="\${r%%/*}" ;; esac
echo "gh[$repo] $*" >> "$FAKE_LOG"
dir="$FAKE_FORGE/$repo"; mkdir -p "$dir"
arg() { local k="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "$2"; return; }; shift; done; }
# \`-R <owner>/<repo>\` names the repo whatever the directory.
named="$(arg -R "$@")"; [ -z "$named" ] || { repo="\${named##*/}"; dir="$FAKE_FORGE/$repo"; mkdir -p "$dir"; }
case "$1 $2" in
  "auth status") [ -z "\${FAKE_GH_LOGGED_OUT:-}" ] || { echo "not logged in" >&2; exit 1; }; echo "logged in" ;;
  "release view") [ -f "$dir/release-$3" ] || { echo "release not found" >&2; exit 1; }
    case "$*" in *"--json isDraft"*) [ -f "$dir/draft-$3" ] && echo true || echo false ;; *) cat "$dir/release-$3" ;; esac ;;
  "release upload")
    [ -f "$dir/draft-$3" ] || { echo "release $3 is published: its assets are locked" >&2; exit 1; }
    [ -z "\${FAKE_GH_UPLOAD_FAIL:-}" ] || { echo "upload failed on purpose" >&2; exit 1; }
    cp "$4" "$dir/asset-$3-$(basename "$4")" ;;
  "release download")
    f="$dir/asset-$3-$(arg -p "$@")"; [ -f "$f" ] || { echo "no assets match the file pattern" >&2; exit 1; }; cat "$f" ;;
  "release edit") [ "$4" = "--draft=false" ] || { echo "fake gh: unexpected $*" >&2; exit 1; }; rm -f "$dir/draft-$3" ;;
  "release create")
    git ls-remote --exit-code --tags origin "refs/tags/$3" >/dev/null || { echo "tag $3 not on origin" >&2; exit 1; }
    [ -z "\${FAKE_GH_MUTABLE:-}" ] && echo true > "$dir/release-$3" || echo false > "$dir/release-$3"
    case "$*" in *" --draft"*) touch "$dir/draft-$3" ;; esac
    [ "$repo" != primitives ] || echo "$3" >> "$FAKE_FORGE/npm-published" ;;
  "api "*)
    case "$2" in
      *"/releases/tags/"*) cat "$dir/release-\${2##*/}" ;;
      *"/releases") for f in "$dir"/release-*; do [ -f "$f" ] || continue; v="\${f##*/release-}"; [ ! -f "$dir/draft-$v" ] || continue; echo "$v $(cat "$dir/date-$v" 2>/dev/null || echo 2026-01-01T00:00:00Z)"; done ;;
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
  for (const c of ['host', 'platform', 'infrastructure', 'ci'])
    put(join(prim, `ansible/${c}/galaxy.yml`), 'version: 0.1.0                # mirrors the release-train tag\n');
  for (const p of ['cli', 'cli-ci', 'lib', 'config'])
    put(join(prim, `packages/${p}/package.json`), `{\n  "name": "@plexus-ms/${p}",\n  "version": "0.1.0"\n}\n`);
  put(
    join(prim, 'package.json'),
    '{\n  "name": "primitives",\n  "devDependencies": { "@plexus-ms/config": "workspace:*" }\n}\n',
  );
  put(join(prim, '.github/workflows/pipeline.yml'), `jobs:\n  ci:\n    uses: ${PRIMITIVES_REF}ci.yml@0.1.0\n`);
  const web = up('preset-repo-turbo');
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
  put(
    join(web, 'template/pnpm-workspace.yaml'),
    'catalog:\n  typescript: ^6\ncatalogs:\n  plexus:\n    "@plexus-ms/config": 0.0.1\n',
  );
  const app = up('preset-app-nextjs');
  put(join(app, 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(app, 'template/package.json.jinja'),
    '{\n  "devDependencies": {\n    "@plexus-ms/config": "^0.0.1"\n  }\n}\n',
  );
  const plat = up('preset-repo-operations');
  put(join(plat, 'copier.yml'), '_answers_file: .copier-answers.yml\n');
  put(
    join(plat, 'template/requirements.yml'),
    'collections:\n  - name: https://github.com/plexus-ms/primitives.git#/ansible/host/\n    type: git\n    version: 0.1.0\n  - name: https://github.com/plexus-ms/primitives.git#/ansible/platform/\n    type: git\n    version: 0.1.0\n  - name: community.docker\n    version: 9.9.9\n',
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
  put(join(tweb, '.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-turbo\n');
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
  put(join(tplat, '.copier-answers.yml'), '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-operations\n');
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

interface UpdateRun {
  result?: Summary;
  error?: string;
  out: string;
}

/** `update` run from inside a tenant repo, like its CI or a developer would. */
async function runUpdate(options: Options, args: UpdateOptions): Promise<UpdateRun> {
  const stderr = new PassThrough();
  let out = '';
  stderr.on('data', (c: Buffer) => {
    out += c;
  });
  const io = { ...realIo(), stdout: new PassThrough(), stderr };
  const ctx = new Context(options, io);
  try {
    // The clock: two months past the fixture's epoch, so a release without a
    // date of its own is older than the backstop and the train is taken.
    return { result: await update(ctx, { today: '2026-03-01', ...args }), out };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), out };
  }
}

/** `propagate` over the workspace (or `dir`), on the clock `runUpdate` uses. */
async function runPropagate(options: Options, args: Partial<PropagateOptions> = {}): Promise<UpdateRun> {
  const stderr = new PassThrough();
  let out = '';
  stderr.on('data', (c: Buffer) => {
    out += c;
  });
  const io = { ...realIo(), stdout: new PassThrough(), stderr };
  const ctx = new Context(options, io);
  try {
    return { result: await propagate(ctx, { dir: WS, today: '2026-03-01', ...args }), out };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), out };
  }
}

/** A train as a repo sees it: a published release of the compendium, cut on `date`. */
const trainCut = (v: string, date?: string) => releaseOf('compendium', v, date);

/** The manifest on a train's release, as ship would have uploaded it: the given modules changed in that train. */
const manifestOf = (v: string, changed: string[], unchanged: string[] = []) => {
  const module = (code: string, at?: string) => ({
    code,
    kind: 'approach',
    maturity: at ? 'standard' : 'candidate',
    binds: 'repo',
    ...(at ? { changed: at } : {}),
    depends: [],
    consumes: [],
  });
  const modules = [...changed.map((c) => module(c, v)), ...unchanged.map((c) => module(c))];
  mkdirSync(join(FORGE(), 'compendium'), { recursive: true });
  writeFileSync(
    join(FORGE(), 'compendium', `asset-${v}-train.json`),
    JSON.stringify({ schema: 1, train: v, date: '2026-01-02', modules }),
  );
};

/** A release of a train repo on the fake forge, as ship would have created it. */
const releaseOf = (r: string, v: string, date?: string) => {
  mkdirSync(join(FORGE(), r), { recursive: true });
  writeFileSync(join(FORGE(), r, `release-${v}`), 'true\n');
  if (date) writeFileSync(join(FORGE(), r, `date-${v}`), `${date}T00:00:00Z\n`);
};

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
const onTrain = (r: string, v: string, file: string) => git(remote(r), 'show', `plexus/${v}:${file}`);
const pull = (r: string, v: string, suffix = '') => read(join(FORGE(), r, `pr-plexus-${v}${suffix}`)).trim();
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
  assert.match(read(join(up('primitives'), 'ansible/host/galaxy.yml')), /^version: 0\.1\.0/, 'galaxy.yml untouched');
  assert.match(read(join(up('compendium'), 'essentials/standard.md')), /^version: v0$/m, 'standard.md untouched');
  assert.doesNotMatch(read(join(up('compendium'), 'contracts/alpha.md')), /^changed:/m, 'modules untouched');
  assert.ok(has(out, '→ phase: primitives'), 'phase one announced');
  assert.ok(has(out, '→ phase: preset-repo-turbo, preset-app-nextjs, preset-repo-operations, compendium'), 'phase two');
  assert.ok(
    has(
      out,
      '⏳ [dry-run] would wait for @plexus-ms/cli@0.2.0, @plexus-ms/cli-ci@0.2.0, @plexus-ms/lib@0.2.0, @plexus-ms/config@0.2.0 on npm',
    ),
    'the wait is a step of the preview',
  );
  assert.ok(!fakeLog().some((l) => l.startsWith('npm ')), 'registry not polled');
  assert.ok(has(out, 'primitives: packages/cli/package.json: @plexus-ms/cli → 0.2.0'), 'preview lists package bumps');
  assert.ok(has(out, 'preset-repo-turbo: template/mise.toml: plx pin → 0.2.0'));
  assert.ok(has(out, 'preset-app-nextjs: template/package.json.jinja: @plexus-ms/config pin → 0.2.0'));
  assert.ok(has(out, 'compendium: mise.toml: plx pin → 0.2.0'));
  assert.ok(
    has(out, 'compendium: contracts/alpha.md: requirements changed since 0.1.0 → changed: 0.2.0'),
    'preview announces the stamps',
  );
  assert.ok(has(out, `[dry-run] > ${join(up('compendium'), 'contracts/alpha.md')}`), 'preview lists the write');
  assert.ok(has(out, `[dry-run] $ (cd ${up('primitives')} && gh release create 0.2.0 --verify-tag`), 'release step');
  assert.ok(
    has(out, /\[dry-run\] \$ \(cd \S+\/compendium && gh release upload 0\.2\.0 \S+\/train\.json --clobber\)/),
    'the manifest upload is a step of the preview',
  );
  assert.ok(has(out, `[dry-run] $ (cd ${up('compendium')} && gh release edit 0.2.0 --draft=false)`));
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
    fakeLog().filter((l) => l.startsWith('mise exec copier@') && / ignored=\/\S+\/acme\/(web|platform)$/.test(l))
      .length,
    3,
    "copier ran with the clone's mise config ignored",
  );
  assert.ok(
    runs.every((l) => !l.startsWith(`${WS}/`)),
    'copier ran outside the workspace (scratch clones)',
  );
  assert.ok(
    runs.some((l) => has(l, ` ${up('preset-repo-turbo')} `) && has(l, '--vcs-ref main')),
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
  assert.ok(has(out, '(preview) acme/web: would commit, push plexus/0.2.0 and open a pull request against develop'));
  assert.ok(has(out, '(preview) acme/platform: would commit, push plexus/0.2.0 and open a pull request against main'));
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request opened');
  assert.deepEqual(result, {
    train: '0.2.0',
    preview: true,
    clean: ['acme/platform', 'acme/web', 'acme/web/apps/site'],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: [],
    released: true,
  });
});

test('happy path: primitives first, the npm wait, the rest, and no pull request in any consumer', async () => {
  fixture('happy');
  process.env.FAKE_NPM_POLLS = '4';
  const { result, error, out } = await run({ yes: true });
  delete process.env.FAKE_NPM_POLLS;
  assert.equal(error, undefined, out);
  assert.ok(allTagged('0.2.0'), 'all five repos tagged 0.2.0 locally and on origin');
  assert.ok(allReleased('0.2.0'), 'a release on every train repo');

  // Phase one: primitives' bookkeeping, tag, release.
  const prim = up('primitives');
  assert.match(read(join(prim, 'ansible/host/galaxy.yml')), /^version: 0\.2\.0 /);
  for (const p of ['cli', 'cli-ci', 'lib', 'config'])
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
  const presetRelease = at('gh[preset-repo-turbo] release create 0.2.0');
  assert.ok(primRelease >= 0 && primRelease < firstPoll && firstPoll < presetRelease, `order in:\n${log.join('\n')}`);
  assert.ok(
    log.filter((l) => has(l, 'npm view @plexus-ms/cli@0.2.0')).length >= 2,
    'polled more than once, until the publish',
  );
  assert.ok(
    has(out, '✓ @plexus-ms/cli@0.2.0, @plexus-ms/cli-ci@0.2.0, @plexus-ms/lib@0.2.0, @plexus-ms/config@0.2.0 on npm'),
  );
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
  const reqs = read(join(up('preset-repo-operations'), 'template/requirements.yml'));
  assert.match(reqs, /^ {4}version: 0\.2\.0$/m, 'collection pin bumped');
  assert.match(reqs, /^ {4}version: 9\.9\.9$/m, 'the other collection keeps its version');
  assert.match(read(join(up('preset-repo-operations'), 'template/mise.toml.jinja')), /version = "0\.2\.0"/);
  assert.match(read(join(up('preset-repo-turbo'), 'template/mise.toml')), /version = "0\.2\.0"/);
  assert.match(
    read(join(up('preset-repo-turbo'), 'template/package.json.jinja')),
    /"@plexus-ms\/config": "0\.2\.0"/,
    'exact',
  );
  assert.match(read(join(up('preset-app-nextjs'), 'template/package.json.jinja')), /"@plexus-ms\/config": "0\.2\.0"/);
  assert.match(
    read(join(up('preset-repo-turbo'), 'template/pnpm-workspace.yaml')),
    /"@plexus-ms\/config": 0\.2\.0$/m,
    'the catalog entry',
  );
  assert.match(read(join(up('preset-repo-turbo'), 'template/.github/workflows/ci.yml.jinja')), /changes\.yml@0\.2\.0/);

  // The compendium's release: a draft, the manifest uploaded, then published; the others in one step.
  const drafted = at('gh[compendium] release create 0.2.0 --verify-tag --generate-notes --title 0.2.0 --draft');
  const uploaded = at('gh[compendium] release upload 0.2.0');
  const published = at('gh[compendium] release edit 0.2.0 --draft=false');
  assert.ok(presetRelease < drafted && drafted < uploaded && uploaded < published, `order in:\n${log.join('\n')}`);
  assert.ok(!existsSync(join(FORGE(), 'compendium', 'draft-0.2.0')), 'published');
  assert.ok(
    log.filter((l) => has(l, 'release create')).every((l) => has(l, 'gh[compendium]') === has(l, '--draft')),
    'only the compendium goes through a draft',
  );
  const manifest = parseManifest(read(join(FORGE(), 'compendium', 'asset-0.2.0-train.json')));
  assert.equal(manifest.train, '0.2.0');
  assert.equal(manifest.date, '2026-01-02');
  assert.deepEqual(
    manifest.modules.map((m) => `${m.code} ${m.maturity} ${m.changed ?? '-'}`),
    ['PLX-Alpha standard 0.2.0', 'PLX-Beta standard 0.1.0', 'PLX-Delta standard 0.2.0', 'PLX-Gamma candidate -'],
    'the catalogue as the train stamped it',
  );
  assert.ok(has(out, 'compendium: train.json: train 0.2.0, 4 modules'));

  // And there it ends: ship looks for no consumer and opens no pull request.
  consumersUntouched();
  assert.equal(copierRuns().length, 0, 'copier never ran');
  assert.ok(!fakeLog().some((l) => has(l, 'gh[acme-')), 'the forge was never asked about a consumer');
  assert.throws(() => onTrain('acme-web', '0.2.0', 'template-owned.txt'), 'no train branch on a consumer');
  assert.throws(() => onTrain('acme-platform', '0.2.0', 'template-owned.txt'));
  assert.ok(has(out, '• train 0.2.0 is cut; every repo takes it itself, when it needs it (plx update)'));
  assert.deepEqual(result, {
    train: '0.2.0',
    preview: false,
    clean: [],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: [],
    released: true,
  });
});

// ── the operator's loop over update: propagate ───────────────────────────────
test('propagate: every repo under the directory takes the train in a worktree of its branch, one pull request each', async () => {
  fixture('propagate');
  const shipped = await run({ yes: true });
  assert.equal(shipped.error, undefined, shipped.out);
  const { result, error, out } = await runPropagate({ yes: true });
  assert.equal(error, undefined, out);
  consumersUntouched();
  assert.deepEqual(
    copierRuns().map((l) => l.split(' ')[0]?.replace(/^.*\/acme\//, 'acme/')),
    ['acme/platform', 'acme/web', 'acme/web/apps/site'],
    'copier ran in the worktrees, repos in tree order, a repo root before its app',
  );
  assert.ok(
    copierRuns().every((l) => has(l, '--vcs-ref 0.2.0') && has(l, '--skip-tasks') && !l.startsWith(`${WS}/`)),
    'the published train, tasks skipped, outside the checkouts',
  );
  assert.equal(copierRuns().filter((l) => has(l, '--defaults')).length, 3, 'unattended run lets copier take defaults');
  assert.equal(
    fakeLog().filter((l) => l.startsWith('mise exec copier@') && / ignored=\/\S+\/acme\/(web|platform)$/.test(l))
      .length,
    3,
    "copier ran with the worktree's mise config ignored",
  );
  for (const [r, f] of [
    ['acme-web', 'template-owned.txt'],
    ['acme-web', 'apps/site/template-owned.txt'],
    ['acme-platform', 'template-owned.txt'],
  ] as const)
    assert.match(onTrain(r, '0.2.0', f), /updated from 0\.2\.0/, `${r}:${f}`);
  assert.match(onTrain('acme-web', '0.2.0', 'PLEXUS.md'), /^plexus: next$/m, 'marker follows the answers file');
  assert.match(onTrain('acme-platform', '0.2.0', 'PLEXUS.md'), /^plexus: next$/m);
  const ci = onTrain('acme-web', '0.2.0', '.github/workflows/ci.yml');
  assert.match(ci, /changes\.yml@0\.2\.0/);
  assert.match(ci, /pipeline\.yml@0\.2\.0/);
  assert.match(onTrain('acme-platform', '0.2.0', '.github/workflows/apps.yml'), /deploy\.yml@0\.2\.0/);
  assert.equal(git(remote('acme-web'), 'log', '-1', '--format=%s', 'plexus/0.2.0'), 'chore: train 0.2.0');
  assert.equal(
    git(remote('acme-web'), 'rev-list', '--count', 'develop..plexus/0.2.0'),
    '1',
    'one commit on the branch',
  );
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
  assert.match(pull('acme-web', '0.2.0', '.body'), /Opened by `plx update`: 0\.2\.0, the oldest train not taken/);
  assert.ok(has(out, 'acme/web: pull request opened: https://forge/acme-web/pull/1'));
  for (const r of ['acme/web', 'acme/platform'])
    assert.equal(git(join(WS, r), 'worktree', 'list').split('\n').length, 1, `${r}: worktree removed`);
  assert.deepEqual(result, {
    train: '0.2.0',
    preview: false,
    clean: ['acme/platform', 'acme/web', 'acme/web/apps/site'],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1'],
  });
});

test('propagate: a directory of tenant repos and no upstream checkout; a repo that needs no train rests until asked', async () => {
  fixture('propagate-tenant');
  trainCut('0.2.0', '2026-02-25');
  const acme = join(WS, 'acme');
  // The platform repo's answers set three days; the web repo's say nothing.
  put(
    join(acme, 'platform/.copier-answers.yml'),
    '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-operations\nupdate_max_age: 3\n',
  );
  commit(join(acme, 'platform'), 'three days at most');
  git(join(acme, 'platform'), 'push', '--quiet', 'origin', 'main');
  const { result, error, out } = await runPropagate({ yes: true }, { dir: acme });
  assert.equal(error, undefined, out);
  assert.ok(!fakeLog().some((l) => has(l, `${WS}/plexus-ms`)), 'nothing read from an upstream checkout');
  assert.ok(has(out, '• web: rests — 1 newer train, the oldest (0.2.0) cut 4 days ago; the backstop is 30 days'), out);
  assert.ok(
    has(out, '• platform: takes 0.2.0 — 0.2.0, the oldest train not taken, was cut 4 days ago (backstop: 3 days'),
    out,
  );
  assert.deepEqual(result?.resting, [
    { path: 'web', reason: '1 newer train, the oldest (0.2.0) cut 4 days ago; the backstop is 30 days' },
  ]);
  assert.deepEqual(result?.clean, ['platform']);
  assert.deepEqual(result?.pulls, ['https://forge/acme-platform/pull/1']);
  assert.throws(() => onTrain('acme-web', '0.2.0', 'template-owned.txt'), 'the resting repo has no train branch');

  // Asked, the resting repo takes it; the other has its branch on origin and is left alone.
  const now = await runPropagate({ yes: true }, { dir: acme, now: true });
  assert.equal(now.error, undefined, now.out);
  assert.ok(has(now.out, '• web: takes 0.2.0 — asked for (--now)'), now.out);
  assert.ok(has(now.out, 'platform: plexus/0.2.0 is already on origin (https://forge/acme-platform/pull/1)'));
  assert.deepEqual(now.result?.resting, []);
  assert.deepEqual(now.result?.pulls, ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1']);
});

test('propagate: a second run finds the train branches on origin and moves nothing', async () => {
  fixture('rerun');
  const shipped = await run({ yes: true });
  assert.equal(shipped.error, undefined, shipped.out);
  const first = await runPropagate({ yes: true });
  assert.equal(first.error, undefined, first.out);
  const tip = git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0');
  const second = await runPropagate({ yes: true }, { now: true });
  assert.equal(second.error, undefined, second.out);
  assert.equal(fakeLog().filter((l) => has(l, 'pr create')).length, 2, 'two repos, two pull requests in all');
  assert.ok(has(second.out, 'acme/web: plexus/0.2.0 is already on origin (https://forge/acme-web/pull/1)'));
  assert.equal(git(remote('acme-web'), 'rev-parse', 'plexus/0.2.0'), tip, 'the branch is where it was');
  assert.equal(copierRuns().length, 3, 'copier not run again');
  assert.deepEqual(second.result?.pulls, ['https://forge/acme-platform/pull/1', 'https://forge/acme-web/pull/1']);
});

test('propagate: the state of the checkouts does not matter', async () => {
  fixture('checkouts');
  put(join(WS, 'acme/web/notes.txt'), 'scratch\n'); // untracked
  put(join(WS, 'acme/platform/template-owned.txt'), 'generated\nedited\n'); // tracked modification
  git(join(WS, 'acme/web'), 'checkout', '--quiet', '-b', 'feature/x'); // wrong branch
  trainCut('0.2.0');
  const { result, error, out } = await runPropagate({ yes: true });
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
  assert.ok(!tagged('preset-repo-turbo', '0.2.0'), 'phase two not started');
});

test('a registry that never answers stops the run resumably; the re-run skips what exists', async () => {
  fixture('npm');
  process.env.FAKE_NPM_NEVER = '1';
  const first = await run({ yes: true });
  delete process.env.FAKE_NPM_NEVER;
  assert.match(
    first.error ?? '',
    /@plexus-ms\/cli, @plexus-ms\/cli-ci, @plexus-ms\/lib, @plexus-ms\/config not on npm at 0\.2\.0 after \d+ min/,
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

test("a run that stops at the manifest leaves the compendium's release a draft, which no repo sees; the re-run publishes it", async () => {
  fixture('draft');
  process.env.FAKE_GH_UPLOAD_FAIL = '1';
  const first = await run({ yes: true });
  delete process.env.FAKE_GH_UPLOAD_FAIL;
  assert.match(first.error ?? '', /upload failed on purpose/);
  assert.match(first.error ?? '', /re-run with --train 0\.2\.0/);
  assert.ok(remoteTagged('compendium', '0.2.0') && existsSync(join(FORGE(), 'compendium', 'draft-0.2.0')));
  assert.ok(released('preset-repo-operations', '0.2.0'), 'every other repo is released');
  // To a repo the train is not cut yet.
  const early = await runUpdate({ yes: true }, { repo: join(WS, 'acme/platform') });
  assert.match(early.error ?? '', /no release of plexus-ms\/compendium found/);

  const second = await run({ yes: true }, { train: '0.2.0' });
  assert.equal(second.error, undefined, second.out);
  assert.ok(has(second.out, '• compendium: release 0.2.0 is still a draft — finishing it'));
  assert.equal(fakeLog().filter((l) => has(l, 'gh[compendium] release create')).length, 1, 'never re-created');
  assert.ok(!existsSync(join(FORGE(), 'compendium', 'draft-0.2.0')), 'published');
  assert.equal(parseManifest(read(join(FORGE(), 'compendium', 'asset-0.2.0-train.json'))).train, '0.2.0');
  const late = await runUpdate({ yes: true }, { repo: join(WS, 'acme/platform') });
  assert.equal(late.error, undefined, late.out);
  assert.ok(has(late.out, '• platform: takes 0.2.0'), late.out);

  // A third run finds it published and uploads nothing.
  const third = await run({ yes: true }, { train: '0.2.0' });
  assert.equal(third.error, undefined, third.out);
  assert.ok(has(third.out, '• compendium: release 0.2.0 exists'));
  assert.equal(fakeLog().filter((l) => has(l, 'gh[compendium] release upload')).length, 2, 'one failed, one done');
});

test('disagreeing latest tags refuse a derived version and accept an explicit one', async () => {
  fixture('skew');
  git(up('primitives'), 'tag', '-a', '0.2.0', '-m', 'half train');
  git(up('primitives'), 'push', '--quiet', 'origin', '0.2.0');
  const first = await run({ yes: true });
  assert.match(first.error ?? '', /latest tags disagree/);
  assert.match(first.error ?? '', /^ {2}preset-repo-turbo: 0\.1\.0$/m, "shows each repo's latest tag");
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
  const hook = join(remote('preset-repo-turbo'), 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "rejected by the test" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const first = await run({ yes: true });
  assert.match(first.error ?? '', /ship stopped during the release; re-run with --train 0\.2\.0/);
  assert.ok(
    tagged('primitives', '0.2.0') && remoteTagged('primitives', '0.2.0') && released('primitives', '0.2.0'),
    'phase one done',
  );
  assert.ok(
    tagged('preset-repo-turbo', '0.2.0') &&
      !remoteTagged('preset-repo-turbo', '0.2.0') &&
      !released('preset-repo-turbo', '0.2.0'),
    'failing repo tagged locally only, no release',
  );
  assert.ok(
    !tagged('preset-app-nextjs', '0.2.0') && !tagged('preset-repo-operations', '0.2.0'),
    'repos after the failure untouched',
  );
  consumersUntouched();
  rmSync(hook);
  const second = await run({ yes: true });
  assert.match(second.error ?? '', /latest tags disagree/, 'version-less re-run refuses the skew');
  const third = await run({ yes: true }, { train: '0.2.0' });
  assert.equal(third.error, undefined, third.out);
  assert.ok(allTagged('0.2.0') && allReleased('0.2.0'));
  assert.ok(has(third.out, '• preset-repo-turbo: already tagged 0.2.0'));
  consumersUntouched();
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request, before or after');
});

test('propagate: a failing site does not stop the others, and the summary says so', async () => {
  fixture('failsite');
  trainCut('0.2.0');
  process.env.FAKE_COPIER_FAIL = 'acme/platform';
  const { result, error, out } = await runPropagate({ yes: true });
  delete process.env.FAKE_COPIER_FAIL;
  assert.equal(error, undefined, out);
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

test('propagate: a conflict is committed with its markers and the pull request says so', async () => {
  fixture('conflict');
  trainCut('0.2.0');
  process.env.FAKE_COPIER_CONFLICT = 'acme/web/apps';
  const { result, out } = await runPropagate({ yes: true });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.ok(has(out, '✗ CONFLICTS'));
  assert.deepEqual(result?.conflicted, ['acme/web/apps/site']);
  assert.deepEqual(result?.clean, ['acme/platform', 'acme/web']);
  assert.match(onTrain('acme-web', '0.2.0', 'apps/site/template-owned.txt'), /^<<<<<<< /m, 'markers in the branch');
  assert.match(pull('acme-web', '0.2.0', '.body'), /Conflicts to resolve.*acme\/web\/apps\/site/);
  assert.equal(result?.pulls.length, 2, 'the pull request is opened all the same');
});

test('propagate: a conflict at the repo root does not stop its apps', async () => {
  fixture('rootconflict');
  trainCut('0.2.0');
  process.env.FAKE_COPIER_CONFLICT = 'acme/web';
  const { result, out } = await runPropagate({ yes: true });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.deepEqual(result?.conflicted, ['acme/web', 'acme/web/apps/site'], out);
  assert.deepEqual(result?.failed, []);
  assert.match(
    onTrain('acme-web', '0.2.0', 'apps/site/template-owned.txt'),
    /^<<<<<<< /m,
    'the app was updated after the root conflicted',
  );
  assert.equal(git(remote('acme-web'), 'rev-list', '--count', 'develop..plexus/0.2.0'), '1', 'still one commit');
});

test('propagate: a named train is validated, and asks every repo for it without a release list', async () => {
  fixture('prop');
  const bad = await runPropagate({ yes: true }, { train: '1.2' });
  assert.match(bad.error ?? '', /'1\.2' is not plain semver/);
  const { result, error, out } = await runPropagate({ yes: true }, { train: '0.2.0' });
  assert.equal(error, undefined, out);
  assert.ok(noneTagged('0.2.0'), 'propagate cuts nothing');
  assert.ok(has(out, '• acme/web: takes 0.2.0 — asked for (--train 0.2.0)'), out);
  assert.ok(!fakeLog().some((l) => has(l, '/releases')), 'the forge is not asked for the trains');
  assert.match(onTrain('acme-web', '0.2.0', 'template-owned.txt'), /updated from 0\.2\.0/);
  assert.match(onTrain('acme-web', '0.2.0', '.github/workflows/ci.yml'), /changes\.yml@0\.2\.0/);
  assert.equal(result?.train, '0.2.0');
  assert.equal(result?.pulls.length, 2);
});

test('the confirmation aborts cleanly without a terminal', async () => {
  fixture('prompt');
  const { error, out } = await run({});
  assert.match(error ?? '', /cannot ask .* without a terminal; pass --yes/);
  assert.ok(noneTagged('0.2.0'));
  assert.ok(!has(out, 'stopped during the release'), 'no recovery hint (nothing was started)');
});

// ── the tenant-side pull: update ─────────────────────────────────────────────
test('update: a repo takes the newest train itself, in a worktree, and leaves its checkout alone', async () => {
  fixture('update');
  trainCut('0.1.0');
  trainCut('0.2.0');
  const web = join(WS, 'acme/web');
  git(web, 'checkout', '--quiet', '-b', 'feature/x');
  put(join(web, 'notes.txt'), 'scratch\n');
  const { result, error, out } = await runUpdate({ yes: true }, { repo: web });
  assert.equal(error, undefined, out);
  assert.ok(has(out, '→ web: worktree of origin/develop'));
  const runs = copierRuns();
  assert.equal(runs.length, 2, 'copier ran at the root and the app');
  assert.ok(
    runs.every(
      (l) => has(l, '--vcs-ref 0.2.0') && has(l, '--skip-tasks') && has(l, '--defaults') && !l.startsWith(`${WS}/`),
    ),
    `copier updated to the train, outside the checkout:\n${runs.join('\n')}`,
  );
  assert.ok(
    fakeLog().some((l) => l.startsWith('mise exec copier@') && !/ ignored=$/.test(l) && !has(l, `ignored=${WS}`)),
    "the worktree's mise config ignored",
  );
  assert.match(onTrain('acme-web', '0.2.0', 'template-owned.txt'), /updated from 0\.2\.0/);
  assert.match(onTrain('acme-web', '0.2.0', 'apps/site/template-owned.txt'), /updated from 0\.2\.0/);
  assert.match(onTrain('acme-web', '0.2.0', 'PLEXUS.md'), /^plexus: next$/m, 'marker synced');
  assert.match(onTrain('acme-web', '0.2.0', '.github/workflows/ci.yml'), /pipeline\.yml@0\.2\.0/, 'refs bumped');
  assert.equal(git(remote('acme-web'), 'rev-list', '--count', 'develop..plexus/0.2.0'), '1', 'one commit');
  assert.equal(pull('acme-web', '0.2.0', '.base'), 'develop');
  assert.match(
    pull('acme-web', '0.2.0', '.body'),
    /Opened by `plx update`: 0\.2\.0, the oldest train not taken, was cut 59 days ago \(backstop: 30 days; 1 newer train\)\./,
  );
  assert.equal(git(web, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x', 'checkout still on its branch');
  assert.match(read(join(web, 'template-owned.txt')), /^generated$/m, 'checkout not updated');
  assert.ok(existsSync(join(web, 'notes.txt')), 'local file kept');
  assert.equal(git(web, 'worktree', 'list').split('\n').length, 1, 'worktree removed');
  assert.deepEqual(result, {
    train: '0.2.0',
    preview: false,
    clean: ['web', 'web/apps/site'],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [],
    pulls: ['https://forge/acme-web/pull/1'],
  });

  // The next day: the branch is on origin, so nothing moves it.
  const again = await runUpdate({ yes: true }, { repo: web });
  assert.equal(again.error, undefined, again.out);
  assert.ok(has(again.out, 'web: plexus/0.2.0 is already on origin (https://forge/acme-web/pull/1) — nothing to do'));
  assert.equal(copierRuns().length, 2, 'copier not run again');
  assert.deepEqual(again.result?.pulls, ['https://forge/acme-web/pull/1']);
  assert.deepEqual(again.result?.clean, []);
});

test('update: a repo already at the train does nothing, and one without a release is told so', async () => {
  fixture('update-current');
  const plat = join(WS, 'acme/platform');
  const none = await runUpdate({ yes: true }, { repo: plat });
  assert.match(none.error ?? '', /no release of plexus-ms\/compendium found/);
  trainCut('0.1.0');
  const { result, error, out } = await runUpdate({ yes: true }, { repo: plat });
  assert.equal(error, undefined, out);
  assert.ok(has(out, '• platform: already at 0.1.0'));
  assert.equal(copierRuns().length, 0);
  assert.throws(() => onTrain('acme-platform', '0.1.0', 'template-owned.txt'), 'no branch pushed');
  assert.deepEqual(result?.pulls, []);
  const notConsumer = await runUpdate({ yes: true }, { repo: up('compendium') });
  assert.match(notConsumer.error ?? '', /not a repo generated from the presets/);
  const bad = await runUpdate({ yes: true }, { repo: plat, train: 'v1' });
  assert.match(bad.error ?? '', /'v1' is not plain semver/);
  const back = await runUpdate({ yes: true }, { repo: plat, train: '0.0.9' });
  assert.match(back.error ?? '', /platform is at 0\.1\.0, past 0\.0\.9/);
});

test('update: the dry run previews in the worktree and pushes nothing', async () => {
  fixture('update-dry');
  trainCut('0.2.0');
  const web = join(WS, 'acme/web');
  const { result, error, out } = await runUpdate({ dryRun: true, yes: true }, { repo: web });
  assert.equal(error, undefined, out);
  assert.equal(copierRuns().filter((l) => has(l, '--vcs-ref 0.2.0')).length, 2, 'copier previewed both sites');
  assert.ok(has(out, 'M template-owned.txt'), 'preview shows the change');
  assert.ok(has(out, '(preview) web: would commit, push plexus/0.2.0 and open a pull request against develop'));
  assert.throws(() => onTrain('acme-web', '0.2.0', 'template-owned.txt'), 'nothing pushed');
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request');
  assert.equal(git(web, 'status', '--porcelain'), '', 'checkout clean');
  assert.equal(git(web, 'worktree', 'list').split('\n').length, 1, 'worktree removed');
  assert.deepEqual(result?.clean, ['web', 'web/apps/site']);
  assert.equal(result?.preview, true);
});

test("update: after propagate opened the train's pull request, the repo's own run finds it", async () => {
  fixture('update-after-propagate');
  trainCut('0.2.0');
  const propagated = await runPropagate({ yes: true });
  assert.equal(propagated.error, undefined, propagated.out);
  const before = copierRuns().length;
  const { result, error, out } = await runUpdate({ yes: true }, { repo: join(WS, 'acme/platform') });
  assert.equal(error, undefined, out);
  assert.ok(has(out, 'platform: plexus/0.2.0 is already on origin (https://forge/acme-platform/pull/1)'));
  assert.equal(copierRuns().length, before);
  assert.deepEqual(result?.pulls, ['https://forge/acme-platform/pull/1']);
  assert.deepEqual(result?.failed, []);
});

test('update: a conflict is committed with its markers, the pull request opened, the exit nonzero', async () => {
  fixture('update-conflict');
  trainCut('0.2.0');
  process.env.FAKE_COPIER_CONFLICT = 'apps/site';
  const { result, error, out } = await runUpdate({ yes: true }, { repo: join(WS, 'acme/web') });
  delete process.env.FAKE_COPIER_CONFLICT;
  assert.equal(error, undefined, out);
  assert.deepEqual(result?.conflicted, ['web/apps/site']);
  assert.deepEqual(result?.clean, ['web']);
  assert.match(onTrain('acme-web', '0.2.0', 'apps/site/template-owned.txt'), /^<<<<<<< /m);
  assert.match(pull('acme-web', '0.2.0', '.body'), /Conflicts to resolve.*web\/apps\/site/);
});

test('update: a repo rests while no trigger holds, and takes the newest train once the backstop age is exceeded', async () => {
  fixture('update-rest');
  trainCut('0.1.0', '2026-01-01');
  trainCut('0.2.0', '2026-02-10');
  trainCut('0.3.0', '2026-02-25');
  const web = join(WS, 'acme/web');
  const rest = await runUpdate({ yes: true }, { repo: web });
  assert.equal(rest.error, undefined, rest.out);
  assert.ok(
    has(
      rest.out,
      '• web: rests — 2 newer trains, the oldest (0.2.0) cut 19 days ago; the backstop is 30 days (plx update --now takes 0.3.0)',
    ),
    rest.out,
  );
  assert.equal(copierRuns().length, 0, 'copier not run');
  assert.equal(git(web, 'worktree', 'list').split('\n').length, 1, 'no worktree made');
  assert.ok(!fakeLog().some((l) => has(l, 'pr create')), 'no pull request');
  assert.deepEqual(rest.result?.resting, [
    { path: 'web', reason: '2 newer trains, the oldest (0.2.0) cut 19 days ago; the backstop is 30 days' },
  ]);
  assert.deepEqual(rest.result?.pulls, []);

  // Eleven days on, the oldest train not taken is 30 days old: the newest is taken, over the one between.
  const due = await runUpdate({ yes: true }, { repo: web, today: '2026-03-12' });
  assert.equal(due.error, undefined, due.out);
  assert.ok(has(due.out, '• web: takes 0.3.0 — 0.2.0, the oldest train not taken, was cut 30 days ago'), due.out);
  assert.match(onTrain('acme-web', '0.3.0', 'template-owned.txt'), /updated from 0\.3\.0/);
  assert.throws(() => onTrain('acme-web', '0.2.0', 'template-owned.txt'), 'the train between is jumped');
  assert.match(pull('acme-web', '0.3.0', '.body'), /backstop: 30 days; 2 newer trains/);
  assert.deepEqual(due.result?.resting, []);
});

test('update: asking takes the train whatever its age, by --now or by naming it', async () => {
  fixture('update-asked');
  trainCut('0.2.0', '2026-02-28');
  const web = join(WS, 'acme/web');
  const rest = await runUpdate({ yes: true }, { repo: web });
  assert.ok(has(rest.out, '• web: rests — 1 newer train, the oldest (0.2.0) cut 1 day ago'), rest.out);
  const now = await runUpdate({ yes: true }, { repo: web, now: true });
  assert.equal(now.error, undefined, now.out);
  assert.ok(has(now.out, '• web: takes 0.2.0 — asked for (--now)'), now.out);
  assert.match(pull('acme-web', '0.2.0', '.body'), /Opened by `plx update`: asked for \(--now\)\./);

  const plat = join(WS, 'acme/platform');
  const listings = fakeLog().filter((l) => has(l, '/releases')).length;
  const named = await runUpdate({ yes: true }, { repo: plat, train: '0.2.0' });
  assert.equal(named.error, undefined, named.out);
  assert.equal(fakeLog().filter((l) => has(l, '/releases')).length, listings, 'a named train asks the forge for none');
  assert.match(pull('acme-platform', '0.2.0', '.body'), /asked for \(--train 0\.2\.0\)/);
});

test('update: the backstop age is the answer of the repo preset, zero takes every train, and the option overrides both', async () => {
  fixture('update-age');
  trainCut('0.2.0', '2026-02-20');
  // The platform repo's answers set a week: nine days is past it.
  const plat = join(WS, 'acme/platform');
  put(
    join(plat, '.copier-answers.yml'),
    '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-operations\nupdate_max_age: 7\n',
  );
  commit(plat, 'a week at most');
  git(plat, 'push', '--quiet', 'origin', 'main');
  const week = await runUpdate({ yes: true }, { repo: plat });
  assert.equal(week.error, undefined, week.out);
  assert.ok(has(week.out, 'was cut 9 days ago (backstop: 7 days; 1 newer train)'), week.out);

  // The web repo's say nothing: 30 days, so it rests; zero is the eager repo.
  const web = join(WS, 'acme/web');
  const rest = await runUpdate({ yes: true }, { repo: web });
  assert.ok(has(rest.out, 'the backstop is 30 days'), rest.out);
  const long = await runUpdate({ yes: true }, { repo: web, maxAge: 90, today: '2026-04-15' });
  assert.ok(has(long.out, 'cut 54 days ago; the backstop is 90 days'), long.out);
  // The repo is judged by what origin has on the branch the train lands on.
  put(
    join(web, '.copier-answers.yml'),
    '_commit: 0.1.0\n_src_path: gh:plexus-ms/preset-repo-turbo\nupdate_max_age: soon\n',
  );
  const local = await runUpdate({ yes: true }, { repo: web });
  assert.ok(has(local.out, 'the backstop is 30 days'), 'an edit in the checkout is not what origin says');
  commit(web, 'soon');
  git(web, 'push', '--quiet', 'origin', 'develop');
  const bad = await runUpdate({ yes: true }, { repo: web });
  assert.match(bad.error ?? '', /the answer update_max_age is 'soon', not a whole number of days/);

  const eager = await runUpdate({ yes: true }, { repo: web, maxAge: 0 });
  assert.equal(eager.error, undefined, eager.out);
  assert.ok(has(eager.out, '• web: takes 0.2.0 — a backstop age of zero takes every train (1 newer train)'), eager.out);
});

test('update: a module a site declares that changed in a newer train takes it at once; other repos rest', async () => {
  fixture('update-module');
  trainCut('0.2.0', '2026-02-28');
  // PLX-Platform changed in 0.2.0; PLX-Updates is in the catalogue without a change.
  manifestOf('0.2.0', ['PLX-Platform'], ['PLX-Updates']);
  const plat = join(WS, 'acme/platform');
  const web = join(WS, 'acme/web');
  // A marker outside any site is kept by hand: a pull would not cure it, so it is not a reason for one.
  put(join(web, 'docs/PLEXUS.md'), '---\nplexus: 0.0.1\nmodules: [PLX-Platform]\n---\n');
  commit(web, 'a marker of its own');
  git(web, 'push', '--quiet', 'origin', 'develop');

  const rest = await runUpdate({ yes: true }, { repo: web });
  assert.equal(rest.error, undefined, rest.out);
  assert.ok(has(rest.out, '• web: rests — 1 newer train, the oldest (0.2.0) cut 1 day ago'), rest.out);
  assert.ok(!has(rest.out, 'modules are not checked'), 'the manifest was read');

  const { result, error, out } = await runUpdate({ yes: true }, { repo: plat });
  assert.equal(error, undefined, out);
  assert.ok(
    has(out, '• platform: takes 0.2.0 — PLX-Platform changed in 0.2.0, declared at 0.1.0 in platform/PLEXUS.md'),
    out,
  );
  assert.match(
    pull('acme-platform', '0.2.0', '.body'),
    /Opened by `plx update`: PLX-Platform changed in 0\.2\.0, declared at 0\.1\.0 in platform\/PLEXUS\.md\./,
  );
  assert.deepEqual(result?.pulls, ['https://forge/acme-platform/pull/1']);
});

test('update: a train without a manifest says so and leaves the repo to its backstop', async () => {
  fixture('update-no-manifest');
  trainCut('0.2.0', '2026-02-28');
  const { result, error, out } = await runUpdate({ yes: true }, { repo: join(WS, 'acme/platform') });
  assert.equal(error, undefined, out);
  assert.ok(has(out, 'platform: train 0.2.0 carries no train.json that can be read; its modules are not checked'), out);
  assert.ok(has(out, '• platform: rests — 1 newer train'), out);
  assert.deepEqual(result?.pulls, []);

  // One that is not a manifest is an error, not a silent rest.
  writeFileSync(join(FORGE(), 'compendium', 'asset-0.2.0-train.json'), '{"schema": 2}');
  const bad = await runUpdate({ yes: true }, { repo: join(WS, 'acme/platform') });
  assert.match(bad.error ?? '', /the train manifest has schema 2; this plx reads 1/);
});

test('ship to update, end to end: the manifest ship uploads is what makes a repo take the train', async () => {
  fixture('e2e-module');
  // The platform repo declares a module of the fixture's compendium that this train changes.
  const plat = join(WS, 'acme/platform');
  put(join(plat, 'PLEXUS.md'), '---\nplexus: 0.1.0\nmodules: [PLX-Repo, PLX-Alpha]\n---\n');
  commit(plat, 'declares alpha');
  git(plat, 'push', '--quiet', 'origin', 'main');
  const shipped = await run({ yes: true });
  assert.equal(shipped.error, undefined, shipped.out);
  // The day after the train: far inside the backstop.
  const { error, out } = await runPropagate({ yes: true }, { today: '2026-01-02' });
  assert.equal(error, undefined, out);
  assert.ok(
    has(out, '• acme/platform: takes 0.2.0 — PLX-Alpha changed in 0.2.0, declared at 0.1.0 in acme/platform/PLEXUS.md'),
    out,
  );
  assert.ok(has(out, '• acme/web: rests — 1 newer train, the oldest (0.2.0) cut 1 day ago'), out);
});
