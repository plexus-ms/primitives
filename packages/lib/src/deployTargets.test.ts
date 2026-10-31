import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { parseInventoryFile, readDeployTargets, selectDeployTargets } from './deployTargets.ts';
import { fakeIo } from './testing/fakeIo.ts';
import { UsageError } from './train.ts';

const vm101 = `---
plexus_deploy_target: "ssh://deploy@vm101.example:22"
plexus_apps:
  - name: beszel
    source: plexus-ms-tenant/platform
    port: 3011
  - name: 'pocket-id'
    port: 3012
other_key: x
`;

test('parseInventoryFile reads the target and the app names, quoted or not, and nothing else', () => {
  assert.deepEqual(parseInventoryFile('inventory/host_vars/vm101.yml', vm101), {
    path: 'inventory/host_vars/vm101.yml',
    target: 'ssh://deploy@vm101.example:22',
    apps: ['beszel', 'pocket-id'],
  });
  assert.deepEqual(parseInventoryFile('g.yml', 'ansible_user: root\n'), { path: 'g.yml', target: undefined, apps: [] });
  assert.deepEqual(parseInventoryFile('e.yml', ''), { path: 'e.yml', target: undefined, apps: [] });
});

test('selectDeployTargets maps the apps of files with a target, sorted, and skips files without one', () => {
  const map = selectDeployTargets([
    { path: 'inventory/host_vars/vm102.yml', target: 'ssh://deploy@vm102', apps: ['website'] },
    { path: 'inventory/group_vars/all.yml', apps: ['beszel'] },
    { path: 'inventory/host_vars/vm101.yml', target: 'ssh://deploy@vm101', apps: ['beszel', 'pocket-id'] },
  ]);
  assert.deepEqual(Object.entries(map), [
    ['beszel', 'ssh://deploy@vm101'],
    ['pocket-id', 'ssh://deploy@vm101'],
    ['website', 'ssh://deploy@vm102'],
  ]);
});

test('an app declared with a target in two files is an error that names both', () => {
  assert.throws(
    () =>
      selectDeployTargets([
        { path: 'inventory/host_vars/vm101.yml', target: 'a', apps: ['beszel'] },
        { path: 'inventory/group_vars/apphosts.yml', target: 'b', apps: ['beszel'] },
      ]),
    /"beszel".*inventory\/group_vars\/apphosts\.yml and inventory\/host_vars\/vm101\.yml/,
  );
});

test('readDeployTargets reads group_vars and host_vars, .yml and .yaml, and nothing else', async () => {
  const io = fakeIo({
    inv: {
      group_vars: { 'all.yml': 'ansible_user: deploy\n', 'README.md': 'not yaml' },
      host_vars: { 'vm101.yml': vm101, 'vm102.yaml': 'plexus_deploy_target: ssh://x\nplexus_apps: [{name: web}]\n' },
    },
  });
  assert.deepEqual(await readDeployTargets(new Context({}, io), '/inv'), {
    beszel: 'ssh://deploy@vm101.example:22',
    'pocket-id': 'ssh://deploy@vm101.example:22',
    web: 'ssh://x',
  });
});

test('readDeployTargets: an inventory without vars dirs is empty, a missing one is a usage error', async () => {
  assert.deepEqual(await readDeployTargets(new Context({}, fakeIo({ inv: { 'hosts.yml': '' } })), '/inv'), {});
  await assert.rejects(readDeployTargets(new Context({}, fakeIo({})), '/nowhere'), UsageError);
});
