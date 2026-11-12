import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, ExecError } from '@plexus-ms/lib';
import { fakeIo, notThere } from '../testing/fakeIo.ts';
import {
  candidateRef,
  digestOf,
  findTag,
  imageName,
  layersOf,
  loggedIn,
  registryOf,
  rotateBuckets,
  startSidecars,
} from './registry.ts';

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
  const sidecars = await startSidecars(new Context({}, io), undefined, 'damage-ms', november);
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
    startSidecars(new Context({}, io), undefined, 'damage-ms', november),
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
  const previous = fakeIo({}, undefined, {
    curl: (_cwd, args) => (args.at(-1)?.includes(':5001/') ? '' : notThere('curl')),
  });
  assert.equal(
    await findTag(new Context({}, previous), { kind: 'own' }, 'website', 'build-x'),
    'localhost:5001/website:build-x',
  );
  const ghcr = fakeIo({}, undefined, {
    crane: (_cwd, args) => (args[1]?.endsWith(':build-x') ? 'sha256:a' : notThere('crane')),
  });
  const registry = { kind: 'ghcr', prefix: 'ghcr.io/o' } as const;
  assert.equal(await findTag(new Context({}, ghcr), registry, 'website', 'build-x'), 'ghcr.io/o/website:build-x');
  assert.equal(await findTag(new Context({}, ghcr), registry, 'website', 'build-y'), undefined);
});

test('crane that cannot run is an error, never a missing tag', async () => {
  const missing = fakeIo({}, undefined, {
    crane: () => {
      throw Object.assign(new Error('spawn crane ENOENT'), { code: 'ENOENT' });
    },
  });
  const registry = { kind: 'ghcr', prefix: 'ghcr.io/o' } as const;
  await assert.rejects(findTag(new Context({}, missing), registry, 'website', 'build-x'), /crane could not run/);
  await assert.rejects(layersOf(new Context({}, missing), registry, 'website', 'build-x'), /crane could not run/);
});

test('only the registry’s “not there” is a missing tag; a refused login or a silent sidecar is an error', async () => {
  const ghcr = { kind: 'ghcr', prefix: 'ghcr.io/o' } as const;
  const refused = fakeIo({}, undefined, {
    crane: () => {
      throw new ExecError(
        'crane digest',
        1,
        'Error: GET https://ghcr.io/token: UNAUTHORIZED: authentication required\n',
      );
    },
  });
  await assert.rejects(
    findTag(new Context({}, refused), ghcr, 'website', 'build-x'),
    /could not look up ghcr.io\/o\/website:build-x: .*UNAUTHORIZED/s,
  );

  const down = (port: string) =>
    fakeIo({}, undefined, {
      curl: (_cwd, args) => {
        if (args.at(-1)?.includes(`:${port}/`)) throw new ExecError('curl', 7, 'curl: (7) Failed to connect\n');
        return notThere('curl');
      },
    });
  await assert.rejects(
    findTag(new Context({}, down('5000')), { kind: 'own' }, 'website', 'build-x'),
    /could not look up localhost:5000\/website:build-x/,
  );
  await assert.rejects(
    digestOf(new Context({}, down('5000')), { kind: 'own' }, 'website', 'build-x'),
    /Failed to connect/,
  );
  // Last month's sidecar is optional: its silence is absence.
  assert.equal(await findTag(new Context({}, down('5001')), { kind: 'own' }, 'website', 'build-x'), undefined);
});

test('a login is an entry for the host in the Docker config, or a credential store', async () => {
  const env = { DOCKER_CONFIG: '/cfg' };
  const config = (data: unknown) => new Context({}, fakeIo({ cfg: { 'config.json': JSON.stringify(data) } }));
  assert.equal(await loggedIn(config({ auths: { 'ghcr.io': { auth: 'x' } } }), 'ghcr.io', env), true);
  assert.equal(await loggedIn(config({ credsStore: 'osxkeychain' }), 'ghcr.io', env), true);
  assert.equal(await loggedIn(config({ auths: { 'docker.io': {} } }), 'ghcr.io', env), false);
  assert.equal(await loggedIn(new Context({}, fakeIo({})), 'ghcr.io', env), false);
});

test('rotate creates this month’s bucket when it is missing and removes the one from two months ago, objects first', async () => {
  const calls: string[] = [];
  let objects = ['docker/registry/v2/a', 'docker/registry/v2/b&c'];
  const io = fakeIo({}, undefined, {
    curl: (_cwd, _args, input = '') => {
      const url = (input.match(/url = "([^"]+)"/)?.[1] ?? '').replace('https://s3.example', '');
      const method = /^head$/m.test(input) ? 'HEAD' : (input.match(/request = "(\w+)"/)?.[1] ?? '');
      calls.push(`${method} ${url}`);
      assert.match(input, /aws-sigv4 = "aws:amz:r1:s3"/);
      assert.match(input, /user = "k:s"/);
      // 2026-11 is missing, 2026-09 is still there.
      if (method === 'HEAD') return url.endsWith('2026-09') ? '\n200' : '\n404';
      if (method === 'GET' && url.includes('list-type=2')) {
        const xml = `<ListBucketResult>${objects.map((k) => `<Contents><Key>${k.replace('&', '&amp;')}</Key></Contents>`).join('')}</ListBucketResult>`;
        return `${xml}\n200`;
      }
      if (method === 'POST') {
        assert.match(input, /<Key>docker\/registry\/v2\/b&amp;c<\/Key>/);
        assert.match(input, /Content-MD5: /);
        objects = [];
        return '\n200';
      }
      if (method === 'GET' && url.includes('uploads='))
        return '<R><Upload><Key>docker/x y</Key><UploadId>u1</UploadId></Upload></R>\n200';
      return method === 'DELETE' ? '\n204' : '\n200';
    },
  });
  const storage = { endpoint: 'https://s3.example/', region: 'r1', accessKey: 'k', secretKey: 's' };
  const result = await rotateBuckets(new Context({}, io), storage, 'damage-ms', november);
  assert.deepEqual(result, { created: 'damage-ms-ci-registry-2026-11', removed: 'damage-ms-ci-registry-2026-09' });
  assert.deepEqual(calls, [
    'HEAD /damage-ms-ci-registry-2026-11',
    'PUT /damage-ms-ci-registry-2026-11',
    'HEAD /damage-ms-ci-registry-2026-09',
    'GET /damage-ms-ci-registry-2026-09?list-type=2&max-keys=1000',
    'POST /damage-ms-ci-registry-2026-09?delete=',
    'GET /damage-ms-ci-registry-2026-09?list-type=2&max-keys=1000',
    'GET /damage-ms-ci-registry-2026-09?uploads=',
    'DELETE /damage-ms-ci-registry-2026-09/docker/x%20y?uploadId=u1',
    'DELETE /damage-ms-ci-registry-2026-09',
  ]);
});

test('a dry run of rotate lists once and deletes nothing; an answer outside 2xx is an error', async () => {
  const calls: string[] = [];
  const io = (status: string) =>
    fakeIo({}, undefined, {
      curl: (_cwd, _args, input = '') => {
        const method = /^head$/m.test(input) ? 'HEAD' : (input.match(/request = "(\w+)"/)?.[1] ?? '');
        calls.push(method);
        if (method === 'HEAD') return '\n200';
        if (method === 'GET') return '<R><Contents><Key>a</Key></Contents></R>\n200';
        return `<Error><Message>no</Message></Error>\n${status}`;
      },
    });
  const storage = { endpoint: 'https://s3.example', region: 'r1', accessKey: 'k', secretKey: 's' };
  await rotateBuckets(new Context({ dryRun: true }, io('200')), storage, 'damage-ms', november);
  assert.deepEqual(calls, ['HEAD', 'HEAD', 'GET']);
  await assert.rejects(
    rotateBuckets(new Context({}, io('403')), storage, 'damage-ms', november),
    /deleting 1 objects of damage-ms-ci-registry-2026-09 answered 403/,
  );
});
