import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Context, type Options } from './context.ts';
import { deploy, q, renderCompose } from './deploy.ts';
import { fakeIo, type Tree } from './testing/fakeIo.ts';
import { UsageError } from './train.ts';

const COMPOSE = 'services:\n  web:\n    image: ${PLEXUS_DEPLOYMENT_IMAGE:?set}\n';
const PINNED = 'services:\n  web:\n    image: ghcr.io/x/beszel:1.0\n';

test('renderCompose pins the placeholder once, with or without a message, and refuses a mismatch', () => {
  assert.equal(renderCompose(COMPOSE, 'ghcr.io/x/web:abc', 'c'), 'services:\n  web:\n    image: ghcr.io/x/web:abc\n');
  assert.equal(
    renderCompose('a: ${PLEXUS_DEPLOYMENT_IMAGE}\nb: ${PLEXUS_DEPLOYMENT_IMAGE}\n', 'i', 'c'),
    'a: i\nb: i\n',
  );
  assert.equal(renderCompose(PINNED, undefined, 'c'), PINNED);
  assert.throws(() => renderCompose(PINNED, 'ghcr.io/x/web:abc', 'apps/x/compose.yaml'), UsageError);
  assert.throws(() => renderCompose(COMPOSE, undefined, 'apps/x/compose.yaml'), UsageError);
});

test('q quotes for a remote shell', () => {
  assert.equal(q('/opt/stacks/t/a'), "'/opt/stacks/t/a'");
  assert.equal(q("it's"), "'it'\\''s'");
});

/** The remote command of an ssh call, and what was fed to it. */
const remoteOf = (args: string[]) => args[args.indexOf('--') + 1] ?? args.join(' ');

interface Host {
  /** Answers a remote command: output, or undefined to fail it. */
  answer: (command: string, input?: string) => string | undefined;
}

function harness(tree: Tree, host: Host, options: Options = {}) {
  const commands: string[] = [];
  const io = fakeIo(tree, undefined, {
    ssh: (_cwd, args, input) => {
      if (args.includes('-O')) return '';
      const command = remoteOf(args);
      commands.push(command);
      return host.answer(command, input);
    },
  });
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (c: Buffer) => {
    err += c;
  });
  io.stderr = stderr;
  return { ctx: new Context(options, io), commands, err: () => err };
}

const checkout: Tree = { repo: { apps: { web: { docker: { 'compose.yaml': COMPOSE } } } } };
const D = "'/opt/stacks/t/web'";

/** A host serving `previous`, declaring migrate, healthy unless the live image contains "bad". */
function host(previous: string | undefined, { migrate = true } = {}): Host & { live?: string; staged?: string } {
  const h: Host & { live?: string; staged?: string } = {
    live: previous,
    answer(command, input) {
      if (command.startsWith('rm -rf') && command.includes('cat >')) {
        h.staged = input;
        return '';
      }
      if (command.includes("inspect --format '{{.Config.Image}}'")) return h.live ?? '';
      if (command.includes('grep -qx migrate')) return migrate ? '' : undefined;
      if (command.includes('test -f')) return previous === undefined ? undefined : '';
      if (command.includes('mv .incoming/compose.yaml compose.yaml')) {
        h.live = /image: (\S+)/.exec(h.staged ?? '')?.[1];
        return '';
      }
      if (command.includes('cp -p .incoming/compose.yaml.prev compose.yaml')) {
        h.live = previous;
        return '';
      }
      if (command.includes('curl')) return h.live?.includes('bad') ? undefined : '';
      if (command.includes('cmp -s')) return '';
      if (command.includes('PLEXUS_LOOPBACK_PORT')) return '3011\n';
      if (command.includes('plexus.healthz')) return '/api/health\n';
      if (command.includes('logs')) return 'boom\n';
      return '';
    },
  };
  return h;
}

test('happy path: stage, pull, migrate, keep the previous file, swap, up, poll the resolved URL', async () => {
  const h = host('ghcr.io/x/web:old');
  const { ctx, commands, err } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',
    tenant: 't',
    app: 'web',
    image: 'ghcr.io/x/web:new',
    dir: '/repo',
  });
  assert.equal(h.staged, 'services:\n  web:\n    image: ghcr.io/x/web:new\n');
  assert.deepEqual(
    commands.filter((c) => !c.includes('inspect') && !c.includes('PLEXUS_LOOPBACK_PORT')),
    [
      `rm -rf ${D}/.incoming && mkdir -p ${D}/.incoming && cat > ${D}/.incoming/compose.yaml`,
      `cd ${D} && docker compose --project-directory . -f .incoming/compose.yaml pull`,
      `cd ${D} && docker compose --project-directory . -f .incoming/compose.yaml --profile migrate config --services 2>/dev/null | grep -qx migrate`,
      `cd ${D} && docker compose --project-directory . -f .incoming/compose.yaml run --rm migrate </dev/null`,
      `test -f ${D}/compose.yaml`,
      `cd ${D} && cp -p compose.yaml .incoming/compose.yaml.prev`,
      `cd ${D} && mv .incoming/compose.yaml compose.yaml`,
      `cd ${D} && docker compose up -d`,
      `cd ${D} && for _ in $(seq 1 30); do curl -fsS --max-time 5 -o /dev/null 'http://127.0.0.1:3011/api/health' && exit 0; sleep 2; done; exit 1`,
      `rm -rf ${D}/.incoming`,
    ],
  );
  assert.deepEqual(result, {
    host: 'deploy@h',
    appDir: '/opt/stacks/t/web',
    compose: 'apps/web/docker/compose.yaml',
    image: 'ghcr.io/x/web:new',
    previous: 'ghcr.io/x/web:old',
    live: 'ghcr.io/x/web:new',
    healthy: true,
    rolledBack: false,
  });
  assert.match(err(), /✓ ghcr.io\/x\/web:new is live and healthy/);
});

test('no migrate service, a given health URL and a third-party file: fewer steps, nothing rendered', async () => {
  const h = host(undefined, { migrate: false });
  const tree: Tree = { repo: { apps: { beszel: { 'compose.yaml': PINNED } } } };
  const { ctx, commands } = harness(tree, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',
    tenant: 't',
    app: 'beszel',
    image: '',
    healthUrl: 'http://127.0.0.1:8090/',
    retries: 3,
    dir: '/repo',
  });
  assert.equal(h.staged, PINNED);
  assert.ok(!commands.some((c) => c.includes('run --rm migrate')));
  assert.ok(!commands.some((c) => c.includes('cp -p compose.yaml')));
  assert.ok(!commands.some((c) => c.includes('PLEXUS_LOOPBACK_PORT')));
  assert.ok(commands.some((c) => c.includes('for _ in $(seq 1 3); do curl') && c.includes("'http://127.0.0.1:8090/'")));
  assert.equal(result.compose, 'apps/beszel/compose.yaml');
  assert.equal(result.previous, undefined);
  assert.equal(result.live, 'ghcr.io/x/beszel:1.0');
  assert.equal(result.healthy, true);
});

test('an unhealthy app rolls back to the previous file and reports it', async () => {
  const h = host('ghcr.io/x/web:old');
  const { ctx, commands, err } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',
    tenant: 't',
    app: 'web',
    image: 'ghcr.io/x/web:bad',
    dir: '/repo',
  });
  const ups = commands.filter((c) => c.endsWith('docker compose up -d')).length;
  assert.equal(ups, 2);
  assert.ok(commands.some((c) => c.includes('logs --no-color --tail 50 web')));
  assert.ok(commands.some((c) => c.includes('cp -p .incoming/compose.yaml.prev compose.yaml')));
  assert.equal(commands.at(-1), `rm -rf ${D}/.incoming`);
  assert.equal(result.healthy, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.live, 'ghcr.io/x/web:old');
  assert.match(err(), /✗ healthcheck failed/);
  assert.match(err(), / {4}boom/);
  assert.match(err(), /↩ rolling back to ghcr.io\/x\/web:old/);
  assert.match(err(), /✓ rolled back to ghcr.io\/x\/web:old/);
});

test('a first deploy that is unhealthy has nothing to roll back to', async () => {
  const h = host(undefined);
  const { ctx, commands, err } = harness(checkout, h);
  const result = await deploy(ctx, {
    host: 'deploy@h',
    tenant: 't',
    app: 'web',
    image: 'ghcr.io/x/web:bad',
    dir: '/repo',
  });
  assert.equal(commands.filter((c) => c.endsWith('docker compose up -d')).length, 1);
  assert.equal(result.healthy, false);
  assert.equal(result.rolledBack, false);
  assert.match(err(), /✗ nothing to roll back to/);
});

test('a failing pull leaves the host as it was, cleans the staging dir and rethrows', async () => {
  const h = host('ghcr.io/x/web:old');
  const base = h.answer.bind(h);
  h.answer = (c, i) => (c.endsWith(' pull') ? undefined : base(c, i));
  const { ctx, commands } = harness(checkout, h);
  await assert.rejects(
    deploy(ctx, { host: 'deploy@h', tenant: 't', app: 'web', image: 'ghcr.io/x/web:new', dir: '/repo' }),
  );
  assert.ok(!commands.some((c) => c.includes('mv .incoming')));
  assert.ok(!commands.some((c) => c.endsWith('up -d')));
  assert.equal(commands.at(-1), `rm -rf ${D}/.incoming`);
  assert.equal(h.live, 'ghcr.io/x/web:old');
});

test('no compose file under the source is a usage error before anything reaches the host', async () => {
  const { ctx, commands } = harness({ repo: { apps: {} } }, host(undefined));
  await assert.rejects(
    deploy(ctx, { host: 'deploy@h', tenant: 't', app: 'web', image: 'i', dir: '/repo' }),
    UsageError,
  );
  assert.deepEqual(commands, []);
});

test('a dry run reaches no host and prints every ssh line of the happy path, placeholders for what the host would say', async () => {
  const { ctx, commands, err } = harness(checkout, host('x'), { dryRun: true });
  const result = await deploy(ctx, {
    host: 'deploy@h',
    tenant: 't',
    app: 'web',
    image: 'ghcr.io/x/web:new',
    dir: '/repo',
  });
  assert.deepEqual(commands, []);
  const lines = err();
  assert.match(lines, /previous: <read on host>/);
  assert.match(
    lines,
    /\[dry-run\] \$ ssh -o ControlMaster=auto -o ControlPath=\S+ -o ControlPersist=60 -o StrictHostKeyChecking=accept-new deploy@h -- 'cd '\\''\/opt\/stacks\/t\/web'\\'' && docker compose up -d'/,
  );
  assert.match(lines, /\(if compose.yaml declares a migrate service:\)/);
  assert.match(lines, /\$\{PLEXUS_LOOPBACK_PORT:-3000\}\$\{plexus.healthz:-\/healthz\}/);
  assert.match(
    lines,
    /\[dry-run\] \$ ssh deploy@h -- 'cd .* && for _ in \$\(seq 1 30\); do curl -fsS --max-time 5 -o \/dev\/null/,
  );
  assert.match(lines, /on failure: restore the previous compose.yaml/);
  assert.match(lines, /\[dry-run\] \$ ssh -o ControlPath=\S+ -O exit deploy@h/);
  assert.equal(result.healthy, true);
  assert.equal(result.live, 'ghcr.io/x/web:new');
});
