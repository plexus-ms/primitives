import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@plexus-ms/lib';
import { fakeIo } from '../testing/fakeIo.ts';
import { Exo, type Instance } from './exoscale.ts';
import { sweepInstances, verdictOn } from './sweepInstances.ts';

const now = new Date('2026-11-20T12:00:00Z');
const at = (state: string, labels: Record<string, string> = {}): Instance => ({
  id: 'x',
  name: 'x',
  state,
  createdAt: '2026-11-04T10:00:00Z',
  labels: { 'plexus-ci': 'true', ...labels },
});

test('a stopped instance goes, a running one past its deadline goes, a running one before it stays', () => {
  assert.deepEqual(verdictOn(at('stopped', { 'death-deadline': '2026-11-20T13:00:00Z' }), now), {
    action: 'remove',
    reason: 'stopped',
  });
  assert.deepEqual(verdictOn(at('running', { 'death-deadline': '2026-11-20T11:00:00Z' }), now), {
    action: 'remove',
    reason: 'past its deadline 2026-11-20T11:00:00Z',
  });
  assert.deepEqual(verdictOn(at('stopped', { 'death-deadline': '2026-11-20T11:00:00Z' }), now), {
    action: 'remove',
    reason: 'stopped, past its deadline 2026-11-20T11:00:00Z',
  });
  assert.deepEqual(verdictOn(at('running', { 'death-deadline': '2026-11-20T13:00:00Z' }), now), { action: 'stay' });
  assert.deepEqual(verdictOn(at('running'), now), { action: 'stay' });
});

test('a kept instance is spared though stopped and past its deadline, reminded of on the eighth day only, and goes after fourteen', () => {
  const kept = (since: string) => at('stopped', { 'death-deadline': '2026-11-01T00:00:00Z', kept: since });
  assert.deepEqual(verdictOn(kept('2026-11-20T09:00:00Z'), now), { action: 'stay' });
  assert.deepEqual(verdictOn(kept('2026-11-13T13:00:00Z'), now), { action: 'stay' });
  assert.deepEqual(verdictOn(kept('2026-11-13T11:00:00Z'), now), { action: 'remind' });
  assert.deepEqual(verdictOn(kept('2026-11-12T13:00:00Z'), now), { action: 'remind' });
  assert.deepEqual(verdictOn(kept('2026-11-12T11:00:00Z'), now), { action: 'stay' });
  assert.deepEqual(verdictOn(kept('2026-11-06T11:00:00Z'), now), {
    action: 'remove',
    reason: 'kept since 2026-11-06T11:00:00Z, 14 days',
  });
  assert.deepEqual(verdictOn(kept('yes'), now), { action: 'stay' });
});

test('the sweep deletes what goes, leaves foreign and kept instances, and mails once for each kind', async () => {
  const raw = (name: string, state: string, labels?: Record<string, string>) => ({
    id: `id-${name}`,
    name,
    state,
    'created-at': '2026-11-04T10:00:00Z',
    labels,
  });
  const deleted: string[] = [];
  const mails: string[] = [];
  const io = fakeIo({}, undefined, {
    exo: (_cwd, args) => {
      if (args[1] === 'list-instances')
        return JSON.stringify({
          instances: [
            raw('gone', 'stopped', { 'plexus-ci': 'true' }),
            raw('fresh-kept', 'stopped', { 'plexus-ci': 'true', kept: '2026-11-19T12:00:00Z' }),
            raw('week-kept', 'stopped', { 'plexus-ci': 'true', kept: '2026-11-13T10:00:00Z' }),
            raw('old-kept', 'stopped', { 'plexus-ci': 'true', kept: '2026-11-01T10:00:00Z' }),
            raw('someone-elses', 'stopped'),
          ],
        });
      if (args[1] === 'delete-instance') {
        deleted.push(args[2] ?? '');
        return JSON.stringify({ id: 'op', state: 'pending' });
      }
      return undefined;
    },
    curl: (_cwd, _args, input = '') => {
      mails.push(input.match(/upload-file = "([^"]+)"/)?.[1] ? 'mail' : 'other');
      return '';
    },
  });
  const ctx = new Context({}, io);
  const smtp = { host: 'h', port: '587', user: 'u', password: 'p', from: 'ci@x', to: 'ops@x' };
  const result = await sweepInstances(ctx, new Exo(ctx, 'de-fra-1'), { smtp, now });
  assert.deepEqual(deleted, ['id-gone', 'id-old-kept']);
  assert.deepEqual(
    result.removed.map((r) => r.name),
    ['gone', 'old-kept'],
  );
  assert.deepEqual(result.stayed, ['fresh-kept', 'week-kept']);
  assert.deepEqual(result.reminded, ['week-kept (id-week-kept), kept since 2026-11-13T10:00:00Z']);
  assert.deepEqual(mails, ['mail', 'mail']);
});
