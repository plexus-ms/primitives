import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@plexus-ms/lib';
import { fakeIo } from '../testing/fakeIo.ts';
import {
  createInstances,
  DEFAULTS,
  encodeUserData,
  instanceLabels,
  keptMail,
  type LaunchOptions,
  launch,
  renderUserData,
} from './createInstances.ts';
import { Exo } from './exoscale.ts';
import { GitHubRunners } from './github.ts';

const now = new Date('2026-11-04T10:40:27Z');
const options: LaunchOptions = {
  kind: 'build',
  label: 'exo-build-41-website-1',
  app: 'website',
  run: { repo: 'damage-ms/web', runId: '41', attempt: '1' },
  runnerToken: 'ghs_x',
  selfDelete: { key: 'EXOsd', secret: 'sd' },
  selfLayers: 'off',
  deadlines: { noJobMinutes: 10, deathMinutes: 45, poweroffMinutes: 50 },
  zone: 'de-fra-1',
  instanceType: 'cpu.extra-large',
  template: DEFAULTS.template,
  diskSize: 100,
  securityGroup: 'runners',
  sshKey: 'runners',
  onlineSeconds: 5,
  tries: 2,
  now: () => now,
  sleep: async () => {},
};

test('the user-data is rendered with the run’s facts and the month’s buckets, and fits the API', () => {
  const text = renderUserData(options, 'JIT', now);
  assert.match(text, /^hostname: exo-build-41-website-1$/m);
  assert.match(text, /REGISTRY_BUCKET=damage-ms-ci-registry-2026-11/);
  assert.match(text, /REGISTRY_PREVIOUS_BUCKET=damage-ms-ci-registry-2026-10/);
  assert.match(text, /SELF_LAYERS=off/);
  assert.match(text, /content: "JIT"/);
  assert.ok(encodeUserData(text).length < DEFAULTS.userDataLimit);
});

test('the labels carry what the cleanup and the sweep read', () => {
  assert.deepEqual(instanceLabels(options, '2026-11-04T10:50:27Z', '2026-11-04T11:25:27Z'), {
    'plexus-ci': 'true',
    repo: 'damage-ms-web',
    run: '41',
    attempt: '1',
    app: 'website',
    kind: 'build',
    'no-job-deadline': '2026-11-04T10:50:27Z',
    'death-deadline': '2026-11-04T11:25:27Z',
  });
});

test('launch: three lookups, JIT config, create, wait, online; the instance id comes back', async () => {
  const calls: string[] = [];
  const io = fakeIo({}, () => undefined, {
    curl: (_cwd, _args, input = '') => {
      calls.push(`curl ${input.match(/request = "(\w+)"/)?.[1]} ${input.match(/url = "([^"]+)"/)?.[1]}`);
      if (input.includes('generate-jitconfig')) return JSON.stringify({ encoded_jit_config: 'JIT', runner: { id: 7 } });
      return JSON.stringify({ runners: [{ id: 7, name: 'exo-build-41-website-1', status: 'online', busy: false }] });
    },
    exo: (_cwd, args, input) => {
      calls.push(`exo ${args[1]}`);
      switch (args[1]) {
        case 'list-templates':
          return JSON.stringify({ templates: [{ id: 't1', name: DEFAULTS.template, visibility: 'public' }] });
        case 'list-instance-types':
          return JSON.stringify({ 'instance-types': [{ id: 'i1', family: 'cpu', size: 'extra-large' }] });
        case 'list-security-groups':
          return JSON.stringify({ 'security-groups': [{ id: 'g1', name: 'runners' }] });
        case 'create-instance': {
          const body = JSON.parse(input ?? '{}') as { name: string; labels: Record<string, string> };
          assert.equal(body.name, 'exo-build-41-website-1');
          assert.equal(body.labels.app, 'website');
          return JSON.stringify({ id: 'op1', state: 'pending', reference: { id: 'inst1' } });
        }
        case 'get-operation':
          return JSON.stringify({ id: 'op1', state: 'success' });
      }
      return undefined;
    },
  });
  const ctx = new Context({}, io);
  const result = await launch(ctx, new Exo(ctx, 'de-fra-1'), new GitHubRunners(ctx, 'damage-ms/web', 'ghs_x'), options);
  assert.equal(result.id, 'inst1');
  assert.equal(result.tries, 1);
  assert.deepEqual(result.kept, []);
  assert.equal(result.noJobDeadline, '2026-11-04T10:50:27Z');
  assert.deepEqual(calls.slice(0, 5), [
    'exo list-templates',
    'exo list-instance-types',
    'exo list-security-groups',
    'curl POST https://api.github.com/repos/damage-ms/web/actions/runners/generate-jitconfig',
    'exo create-instance',
  ]);
  assert.ok(calls.includes('exo get-operation'));
  assert.ok(calls.some((c) => c.startsWith('curl GET') && c.includes('name=exo-build-41-website-1')));
});

test('launch under --dry-run performs nothing and reports the placeholder id', async () => {
  const io = fakeIo({}, () => undefined, {
    exo: (_cwd, args) => {
      switch (args[1]) {
        case 'list-templates':
          return JSON.stringify({ templates: [{ id: 't1', name: DEFAULTS.template, visibility: 'public' }] });
        case 'list-instance-types':
          return JSON.stringify({ 'instance-types': [{ id: 'i1', family: 'cpu', size: 'extra-large' }] });
        case 'list-security-groups':
          return JSON.stringify({ 'security-groups': [{ id: 'g1', name: 'runners' }] });
      }
      throw new Error(`an effect ran under --dry-run: exo ${args[1]}`);
    },
    curl: () => {
      throw new Error('an effect ran under --dry-run: curl');
    },
  });
  const ctx = new Context({ dryRun: true }, io);
  const result = await launch(ctx, new Exo(ctx, 'de-fra-1'), new GitHubRunners(ctx, 'damage-ms/web', 'ghs_x'), options);
  assert.equal(result.id, '<instance-id>');
});

/** A cloud and a forge where the runners named in `online` come online, by the number of their creation. */
function world(online: (created: number) => boolean) {
  const calls: string[] = [];
  const updates: { id: string; name: string; labels: Record<string, string> }[] = [];
  const mails: string[] = [];
  let created = 0;
  let registered = 0;
  const io = fakeIo({}, () => undefined, {
    curl: (_cwd, _args, input = '') => {
      const url = input.match(/url = "([^"]+)"/)?.[1] ?? '';
      if (url.startsWith('smtp')) {
        mails.push(url);
        return '';
      }
      const method = input.match(/request = "(\w+)"/)?.[1];
      calls.push(`curl ${method} ${url.replace('https://api.github.com/repos/damage-ms/web/actions/runners', '')}`);
      if (url.includes('generate-jitconfig')) {
        registered += 1;
        return JSON.stringify({ encoded_jit_config: `JIT${registered}`, runner: { id: 70 + registered } });
      }
      if (method === 'DELETE') return '';
      return JSON.stringify({
        runners: [
          { id: 70 + registered, name: options.label, status: online(created) ? 'online' : 'offline', busy: false },
        ],
      });
    },
    exo: (_cwd, args, input) => {
      calls.push(`exo ${args[1]}${args[2]?.startsWith('inst') ? ` ${args[2]}` : ''}`);
      switch (args[1]) {
        case 'list-templates':
          return JSON.stringify({ templates: [{ id: 't1', name: DEFAULTS.template, visibility: 'public' }] });
        case 'list-instance-types':
          return JSON.stringify({ 'instance-types': [{ id: 'i1', family: 'cpu', size: 'extra-large' }] });
        case 'list-security-groups':
          return JSON.stringify({ 'security-groups': [{ id: 'g1', name: 'runners' }] });
        case 'create-instance':
          created += 1;
          return JSON.stringify({ id: `op${created}`, state: 'pending', reference: { id: `inst${created}` } });
        case 'get-operation':
          return JSON.stringify({ id: 'op', state: 'success' });
        case 'stop-instance':
          return JSON.stringify({ id: 'ops', state: 'pending' });
        case 'update-instance':
          updates.push({
            id: args[2] ?? '',
            ...(JSON.parse(input ?? '{}') as { name: string; labels: Record<string, string> }),
          });
          return JSON.stringify({ id: 'opu', state: 'pending' });
      }
      return undefined;
    },
  });
  const ctx = new Context({}, io);
  return {
    ctx,
    exo: new Exo(ctx, 'de-fra-1'),
    github: new GitHubRunners(ctx, 'damage-ms/web', 'ghs_x'),
    calls,
    updates,
    mails,
  };
}

const smtp = { host: 'smtp.x', port: '587', user: 'u', password: 'p', from: 'ci@x', to: 'ops@x' };

test('a miss is kept: stopped, renamed and labelled, mailed about, its registration removed, and replaced from a fresh JIT config', async () => {
  const w = world((created) => created === 2);
  const result = await launch(w.ctx, w.exo, w.github, { ...options, smtp });
  assert.equal(result.id, 'inst2');
  assert.equal(result.tries, 2);
  assert.deepEqual(result.kept, ['inst1']);
  const after = w.calls.slice(w.calls.indexOf('exo stop-instance inst1'));
  assert.deepEqual(after.slice(0, 4), [
    'exo stop-instance inst1',
    'exo update-instance inst1',
    'curl DELETE /71',
    'curl POST /generate-jitconfig',
  ]);
  assert.ok(!w.calls.some((c) => c.startsWith('exo delete-instance')));
  assert.equal(w.updates.length, 1);
  assert.equal(w.updates[0]?.name, 'exo-build-41-website-1-kept');
  assert.equal(w.updates[0]?.labels.kept, '2026-11-04T10:40:27Z');
  assert.equal(w.updates[0]?.labels.run, '41');
  assert.deepEqual(w.mails, ['smtp://smtp.x:587']);
});

test('a second miss is kept as well and fails the launch; nothing is deleted', async () => {
  const w = world(() => false);
  await assert.rejects(
    launch(w.ctx, w.exo, w.github, options),
    /2 instance\(s\) of exo-build-41-website-1 failed to come online and are kept, giving up/,
  );
  assert.deepEqual(
    w.updates.map((u) => u.id),
    ['inst1', 'inst2'],
  );
  assert.ok(!w.calls.some((c) => c.startsWith('exo delete-instance')));
  assert.equal(w.calls.filter((c) => c.startsWith('curl DELETE')).length, 2);
  assert.deepEqual(w.mails, []);
});

test('the mail about a kept instance names it, its id and its zone', () => {
  const mail = keptMail(options, 'inst1');
  assert.match(mail.subject, /exo-build-41-website-1 did not come online and is kept/);
  assert.match(mail.text, /kept as exo-build-41-website-1-kept/);
  assert.match(mail.text, /id {4}inst1/);
  assert.match(mail.text, /zone {2}de-fra-1/);
  assert.match(mail.text, /damage-ms\/web run 41 attempt 1/);
});

test('createInstances launches every leg and fails as one when a launch does', async () => {
  const w = world(() => true);
  const { label: _label, app: _app, kind: _kind, ...shared } = options;
  const launches = await createInstances(
    w.ctx,
    w.exo,
    w.github,
    [
      { kind: 'build', label: 'exo-build-41-website-1', app: 'website' },
      { kind: 'test', label: 'exo-build-41-website-1', app: 'website' },
    ],
    shared,
  );
  assert.equal(launches.length, 2);
  const none = world(() => false);
  await assert.rejects(
    createInstances(none.ctx, none.exo, none.github, [{ kind: 'build', label: options.label, app: 'website' }], shared),
    /1 launch\(es\) failed/,
  );
});
