import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@plexus-ms/lib';
import { fakeIo, notThere } from '../testing/fakeIo.ts';
import { deployLegsOf, environmentOf, hashesOf, legsOf, plan, readHashes, testLegsOf } from './plan.ts';

const dryRun = JSON.stringify({
  tasks: [
    { taskId: '@damage-ms/website#build', package: '@damage-ms/website', hash: '0f2a', command: 'next build' },
    { taskId: '@damage-ms/website#test', package: '@damage-ms/website', hash: 'dc97', command: '<NONEXISTENT>' },
    { taskId: '@damage-ms/vernier-core#build', package: '@damage-ms/vernier-core', hash: '4b6a' },
    { taskId: '@damage-ms/vernier-app#build', package: '@damage-ms/vernier-app', hash: 'c51b', command: 'next build' },
    { taskId: '@damage-ms/vernier-app#test', package: '@damage-ms/vernier-app', hash: '5b05', command: 'pnpm test' },
    { taskId: '@other/x#build', package: '@other/x', hash: 'ffff', command: 'x' },
  ],
});
const packages = { website: '@damage-ms/website', 'vernier-app': '@damage-ms/vernier-app' };
const hashes = hashesOf(dryRun, packages);
const run = { runId: '41', attempt: '1' };

test('hashesOf keeps the build hash of each app’s package, and the test hash where the script exists', () => {
  assert.deepEqual(hashes, [
    { app: 'website', hash: '0f2a' },
    { app: 'vernier-app', hash: 'c51b', test: '5b05' },
  ]);
  assert.deepEqual(hashesOf(dryRun, { nope: '@damage-ms/nope' }), []);
});

test('readHashes asks each app’s package.json for the name Turbo knows it by', async () => {
  const io = fakeIo(
    {
      repo: {
        'package.json': JSON.stringify({ devDependencies: { turbo: '2.9.0' } }),
        apps: { site: { 'package.json': JSON.stringify({ name: '@damage-ms/website' }) } },
      },
    },
    undefined,
    {
      npx: (_cwd, args) => {
        assert.deepEqual(args, ['--yes', 'turbo@2.9.0', 'run', 'build', 'test', '--dry-run=json']);
        return dryRun;
      },
    },
  );
  assert.deepEqual(await readHashes(new Context({}, io), '/repo', ['site']), [{ app: 'site', hash: '0f2a' }]);
});

test('a leg names its runner from the strategy: the forge’s, a large slot, or an instance of its own', () => {
  assert.deepEqual(legsOf(['website'], hashes, 'build', 'hybrid', run), [
    { app: 'website', hash: '0f2a', runner: 'exo-build-41-website-1', n: 1 },
  ]);
  assert.equal(legsOf(['website'], hashes, 'build', 'github', run)[0]?.runner, 'ubuntu-latest');
  assert.equal(legsOf(['website'], hashes, 'build', 'on-prem', run)[0]?.runner, 'ci-large');
  assert.deepEqual(
    legsOf(['vernier-app'], hashes, 'repro', 'hybrid', { runId: '41', attempt: '2' }).map((l) => l.runner),
    ['exo-build-41-vernier-app-2-1', 'exo-build-41-vernier-app-2-2'],
  );
  assert.throws(() => legsOf(['nope'], hashes, 'build', 'hybrid', run), /no build hash for nope/);
});

test('testLegsOf: one leg per app with a test task, carrying the build it tests', () => {
  assert.deepEqual(testLegsOf(['website', 'vernier-app'], hashes, 'hybrid', run), [
    { app: 'vernier-app', hash: '5b05', build: 'c51b', runner: 'exo-test-41-vernier-app-1' },
  ]);
  assert.equal(testLegsOf(['vernier-app'], hashes, 'on-prem', run)[0]?.runner, 'ci-large');
});

test('the environment follows the branch on a push or a run by hand, and a given one stands in', () => {
  assert.equal(environmentOf('push', 'main'), 'production');
  assert.equal(environmentOf('workflow_dispatch', 'develop'), 'staging');
  assert.equal(environmentOf('push', 'feature'), '');
  assert.equal(environmentOf('pull_request', 'main'), '');
  assert.equal(environmentOf('pull_request', '12/merge', 'staging'), 'staging');
});

test('deployLegsOf: an app with a target deploys the commit’s image there, one without is named', () => {
  assert.deepEqual(
    deployLegsOf(['website', 'vernier-app'], { website: 'ssh://plexus@vm101' }, 'ghcr.io/Damage-MS', 'abc'),
    {
      legs: [{ app: 'website', host: 'ssh://plexus@vm101', image: 'ghcr.io/damage-ms/website:abc' }],
      without: ['vernier-app'],
    },
  );
});

test('the plan skips what the registry holds, per build and per test, and plans the deploys of an environment', async () => {
  // The pair holds website's build and nothing of vernier-app.
  const io = fakeIo({}, undefined, {
    curl: (_cwd, args) => (args.at(-1)?.endsWith(':5000/v2/website/manifests/build-0f2a') ? '' : notThere('curl')),
  });
  const result = await plan(new Context({}, io), {
    apps: ['website', 'vernier-app'],
    mode: 'build',
    tests: true,
    hashes,
    strategy: 'hybrid',
    registry: { kind: 'own' },
    run,
    deploy: {
      environment: 'staging',
      targets: { 'vernier-app': 'ssh://plexus@vm101' },
      prefix: 'ghcr.io/damage-ms',
      sha: 'abc',
    },
  });
  assert.deepEqual(result.legs, [{ app: 'vernier-app', hash: 'c51b', runner: 'exo-build-41-vernier-app-1', n: 1 }]);
  assert.deepEqual(result.tests, [
    { app: 'vernier-app', hash: '5b05', build: 'c51b', runner: 'exo-test-41-vernier-app-1' },
  ]);
  assert.deepEqual(result.skipped, [{ app: 'website', hash: '0f2a', ref: 'localhost:5000/website:build-0f2a' }]);
  assert.deepEqual(result.apps, hashes);
  assert.equal(result.environment, 'staging');
  assert.deepEqual(result.deploys, [
    { app: 'vernier-app', host: 'ssh://plexus@vm101', image: 'ghcr.io/damage-ms/vernier-app:abc' },
  ]);
});

test('with the forge’s registry the look-up is crane’s, and without an environment nothing deploys', async () => {
  const asked: string[] = [];
  const io = fakeIo({}, undefined, {
    crane: (_cwd, args) => {
      asked.push(args.join(' '));
      return args[1]?.endsWith(':build-0f2a') ? 'sha256:abc' : notThere('crane');
    },
  });
  const result = await plan(new Context({}, io), {
    apps: ['website'],
    mode: 'build',
    tests: true,
    hashes,
    strategy: 'github',
    registry: { kind: 'ghcr', prefix: 'ghcr.io/plexus-ms-tenant' },
    run,
  });
  assert.deepEqual(asked, ['digest ghcr.io/plexus-ms-tenant/website:build-0f2a']);
  assert.deepEqual(result.legs, []);
  assert.deepEqual(result.deploys, []);
  assert.equal(result.environment, '');
});
