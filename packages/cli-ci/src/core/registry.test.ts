import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@plexus-ms/lib';
import { fakeIo } from '../testing/fakeIo.ts';
import { candidateRef, findTag, imageName, loggedIn, registryOf, rotateBuckets, startSidecars } from './registry.ts';

const november = new Date('2026-11-06T12:00:00Z');

test('where :5000 answers already, nothing is started and no key is needed', async () => {
  const commands: string[] = [];
  const io = fakeIo({}, undefined, {
    curl: (_cwd, args) => {
      commands.push(`curl ${args.at(-1)}`);
      return args.at(-1)?.includes(':5000/') ? '{}' : undefined;
    },
    docker: () => {
      commands.push('docker');
      return '';
    },
    exo: () => {
      commands.push('exo');
      return '';
    },
  });
  const sidecars = await startSidecars(new Context({}, io), undefined, 'damage-ms', 'de-fra-1', november);
  assert.deepEqual(sidecars, {
    current: 'damage-ms-ci-registry-2026-11',
    previous: 'damage-ms-ci-registry-2026-10',
    previousAnswers: false,
  });
  assert.deepEqual(commands, ['curl http://127.0.0.1:5000/v2/', 'curl http://127.0.0.1:5001/v2/']);
});

test('where nothing answers, the key is needed', async () => {
  const io = fakeIo({}, undefined, { curl: () => undefined });
  await assert.rejects(
    startSidecars(new Context({}, io), undefined, 'damage-ms', 'de-fra-1', november),
    /REGISTRY_ENDPOINT, REGISTRY_REGION, REGISTRY_ACCESS_KEY and REGISTRY_SECRET_KEY are needed/,
  );
});

test('the image name is the lower-cased prefix and the app', () => {
  assert.equal(imageName('ghcr.io/Damage-MS/', 'website'), 'ghcr.io/damage-ms/website');
});

test('a candidate is written to this month’s sidecar, or to the forge’s registry', () => {
  assert.equal(candidateRef(registryOf('own', ''), 'website', 'build-0f2a'), 'localhost:5000/website:build-0f2a');
  assert.equal(
    candidateRef(registryOf('ghcr', 'ghcr.io/Plexus-MS-Tenant'), 'website', 'build-0f2a'),
    'ghcr.io/plexus-ms-tenant/website:build-0f2a',
  );
});

test('findTag answers with the ref that holds the tag: either sidecar, or the forge’s registry through crane', async () => {
  const previous = fakeIo({}, undefined, { curl: (_cwd, args) => (args.at(-1)?.includes(':5001/') ? '200' : '404') });
  assert.equal(
    await findTag(new Context({}, previous), { kind: 'own' }, 'website', 'build-x'),
    'localhost:5001/website:build-x',
  );
  const ghcr = fakeIo({}, undefined, {
    crane: (_cwd, args) => (args[1]?.endsWith(':build-x') ? 'sha256:a' : undefined),
  });
  const registry = { kind: 'ghcr', prefix: 'ghcr.io/o' } as const;
  assert.equal(await findTag(new Context({}, ghcr), registry, 'website', 'build-x'), 'ghcr.io/o/website:build-x');
  assert.equal(await findTag(new Context({}, ghcr), registry, 'website', 'build-y'), undefined);
});

test('a login is an entry for the host in the Docker config, or a credential store', async () => {
  const env = { DOCKER_CONFIG: '/cfg' };
  const config = (data: unknown) => new Context({}, fakeIo({ cfg: { 'config.json': JSON.stringify(data) } }));
  assert.equal(await loggedIn(config({ auths: { 'ghcr.io': { auth: 'x' } } }), 'ghcr.io', env), true);
  assert.equal(await loggedIn(config({ credsStore: 'osxkeychain' }), 'ghcr.io', env), true);
  assert.equal(await loggedIn(config({ auths: { 'docker.io': {} } }), 'ghcr.io', env), false);
  assert.equal(await loggedIn(new Context({}, fakeIo({})), 'ghcr.io', env), false);
});

test('rotate creates this month’s bucket when it is missing and removes the one from two months ago', async () => {
  const calls: string[] = [];
  const io = fakeIo({}, undefined, {
    exo: (_cwd, args) => {
      calls.push(args.join(' '));
      // 2026-11 is missing, 2026-09 is still there.
      if (args[1] === 'ls') return args[2]?.endsWith('2026-09') ? '' : undefined;
      return '';
    },
  });
  const storage = { endpoint: 'e', region: 'r', accessKey: 'k', secretKey: 's' };
  const result = await rotateBuckets(new Context({}, io), storage, 'damage-ms', 'de-fra-1', november);
  assert.deepEqual(result, { created: 'damage-ms-ci-registry-2026-11', removed: 'damage-ms-ci-registry-2026-09' });
  assert.deepEqual(calls, [
    'storage ls sos://damage-ms-ci-registry-2026-11',
    'storage mb sos://damage-ms-ci-registry-2026-11 -z de-fra-1',
    'storage ls sos://damage-ms-ci-registry-2026-09',
    'storage rb -r -f sos://damage-ms-ci-registry-2026-09',
  ]);
});
