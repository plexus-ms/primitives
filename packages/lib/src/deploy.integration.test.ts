// The offline harness of the deploy verb, reborn from ci-cd's bash days: a
// fake `ssh` on PATH that runs each remote one-liner locally with bash, in a
// scratch app dir standing in for /opt/stacks/<tenant>/<app>, with a fake
// `docker` and a fake `curl` next to it. Every docker call is appended to
// FAKE_LOG; the fake docker keeps "what runs" in <app dir>/.running, read by
// `compose ps`/`inspect`, written by `compose up`, so reality on the fake host
// is a file the verb never reads itself.
//
//   FAKE_PULL_FAIL=1   `docker compose pull` exits 1
//   an image containing "bad" never answers the fake curl
import assert from 'node:assert/strict';
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
import { deploy } from './deploy.ts';
import { realIo } from './io.ts';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'plx-deploy-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

const BIN = join(TMP, 'bin');
mkdirSync(BIN);
const fake = (name: string, script: string) => {
  writeFileSync(join(BIN, name), `#!/usr/bin/env bash\nset -euo pipefail\n${script}`);
  chmodSync(join(BIN, name), 0o755);
};

// ssh: skip the options, run what follows `--` locally; `-O exit` is a no-op.
fake(
  'ssh',
  `
for a in "$@"; do [ "$a" = -O ] && exit 0; done
while [ "$1" != -- ]; do shift; done; shift
exec bash -c "$1"
`,
);

// docker: compose pull/run/up/ps/config/logs and inspect, against the cwd's
// compose file (or the -f one), state in .running.
fake(
  'docker',
  `
echo "docker $*" >> "$FAKE_LOG"
file=compose.yaml
if [ "$1" = inspect ]; then
  # inspect --format <fmt> <cid>
  case "$3" in
    *Config.Image*) cat .running ;;
    *plexus.healthz*) echo "" ;;
  esac
  exit 0
fi
shift  # compose
while [ "$1" = --project-directory ] || [ "$1" = -f ] || [ "$1" = --profile ]; do
  [ "$1" = -f ] && file="$2"; shift 2
done
case "$1" in
  pull) [ -z "\${FAKE_PULL_FAIL:-}" ] || { echo "pull failed" >&2; exit 1; } ;;
  run) : ;;
  up) sed -n 's/^ *image: *//p' compose.yaml | head -1 > .running ;;
  ps) [ -f .running ] && echo cid || true ;;
  config) sed -n 's/^  \\([a-z]*\\):$/\\1/p' "$file" ;;
  logs) echo "fake log line" ;;
esac
`,
);

fake(
  'curl',
  `
[ -f .running ] || exit 7
grep -q bad .running && exit 22 || exit 0
`,
);

const COMPOSE = `services:
  web:
    image: \${PLEXUS_DEPLOYMENT_IMAGE:?set}
    ports: ["127.0.0.1:3011:3000"]
  migrate:
    image: \${PLEXUS_DEPLOYMENT_IMAGE:?set}
    command: pnpm migrate
    profiles: ["migrate"]
`;

function fixture(previous?: string) {
  const root = mkdtempSync(join(TMP, 'case-'));
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'apps/web/docker'), { recursive: true });
  writeFileSync(join(checkout, 'apps/web/docker/compose.yaml'), COMPOSE);
  const appDir = join(root, 'host', 'web');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, '.env'), 'PLEXUS_LOOPBACK_PORT=3011\n');
  if (previous) {
    writeFileSync(join(appDir, 'compose.yaml'), COMPOSE.replaceAll('${PLEXUS_DEPLOYMENT_IMAGE:?set}', previous));
    writeFileSync(join(appDir, '.running'), `${previous}\n`);
  }
  const log = join(root, 'docker.log');
  writeFileSync(log, '');
  return { checkout, appDir, log };
}

function run(options: Options, checkout: string, appDir: string, image: string, env: Record<string, string> = {}) {
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (c: Buffer) => {
    err += c;
  });
  const io = realIo();
  io.stderr = stderr;
  const saved = { ...process.env };
  process.env.PATH = `${BIN}:${process.env.PATH}`;
  Object.assign(process.env, env);
  const ctx = new Context(options, io);
  return deploy(ctx, { host: 'deploy@fake', tenant: 't', app: 'web', image, appDir, dir: checkout, retries: 1 })
    .finally(() => {
      process.env = saved;
    })
    .then(
      (result) => ({ result, err }),
      (error: unknown) => Promise.reject(Object.assign(error as Error, { err })),
    );
}

const dockerLog = (log: string) =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.replace(/ --project-directory \. -f \.incoming\/compose\.yaml/, ' [staged]'));

test('happy path on the fake host: pull and migrate against the staged file, swap, up, healthy, staging gone', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old');
  const { result, err } = await run({}, checkout, appDir, 'ghcr.io/x/web:new', { FAKE_LOG: log });
  assert.equal(result.healthy, true);
  assert.equal(result.previous, 'ghcr.io/x/web:old');
  assert.equal(result.live, 'ghcr.io/x/web:new');
  assert.equal(readFileSync(join(appDir, '.running'), 'utf8').trim(), 'ghcr.io/x/web:new');
  assert.match(readFileSync(join(appDir, 'compose.yaml'), 'utf8'), /image: ghcr.io\/x\/web:new/);
  assert.ok(!existsSync(join(appDir, '.incoming')));
  const actions = dockerLog(log).filter((l) => /pull|run|up/.test(l));
  assert.deepEqual(actions, [
    'docker compose [staged] pull',
    'docker compose [staged] run --rm migrate',
    'docker compose up -d',
  ]);
  assert.match(err, /health: {3}http:\/\/127.0.0.1:3011\/healthz/);
  assert.match(err, /✓ ghcr.io\/x\/web:new is live and healthy/);
});

test('an unhealthy image is rolled back to the previous compose file and image', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old');
  const { result, err } = await run({}, checkout, appDir, 'ghcr.io/x/web:bad', { FAKE_LOG: log });
  assert.equal(result.healthy, false);
  assert.equal(result.rolledBack, true);
  assert.equal(readFileSync(join(appDir, '.running'), 'utf8').trim(), 'ghcr.io/x/web:old');
  assert.match(readFileSync(join(appDir, 'compose.yaml'), 'utf8'), /image: ghcr.io\/x\/web:old/);
  assert.ok(!existsSync(join(appDir, '.incoming')));
  assert.equal(dockerLog(log).filter((l) => l === 'docker compose up -d').length, 2);
  assert.match(err, /✗ healthcheck failed after \d+s/);
  assert.match(err, / {4}fake log line/);
  assert.match(err, /✓ rolled back to ghcr.io\/x\/web:old/);
});

test('a failed pull changes nothing on the host and the error names the command', async () => {
  const { checkout, appDir, log } = fixture('ghcr.io/x/web:old');
  await assert.rejects(
    run({}, checkout, appDir, 'ghcr.io/x/web:new', { FAKE_LOG: log, FAKE_PULL_FAIL: '1' }),
    /pull failed/,
  );
  assert.equal(readFileSync(join(appDir, '.running'), 'utf8').trim(), 'ghcr.io/x/web:old');
  assert.match(readFileSync(join(appDir, 'compose.yaml'), 'utf8'), /image: ghcr.io\/x\/web:old/);
  assert.ok(!existsSync(join(appDir, '.incoming')));
  assert.ok(!dockerLog(log).some((l) => /run|up/.test(l)));
});

test('a first deploy on an empty app dir works, and an unhealthy one fails without a rollback', async () => {
  const ok = fixture();
  const { result } = await run({}, ok.checkout, ok.appDir, 'ghcr.io/x/web:new', { FAKE_LOG: ok.log });
  assert.equal(result.healthy, true);
  assert.equal(result.previous, undefined);
  const bad = fixture();
  const { result: r, err } = await run({}, bad.checkout, bad.appDir, 'ghcr.io/x/web:bad', { FAKE_LOG: bad.log });
  assert.equal(r.healthy, false);
  assert.equal(r.rolledBack, false);
  assert.match(err, /nothing to roll back to/);
  assert.ok(!existsSync(join(bad.appDir, 'compose.yaml.prev')));
});
