import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from './context.ts';
import { fakeIo } from './testing/fakeIo.ts';
import { latestTag, nextMinor, preflightRelease, readTrain, resolveVersion, TRAIN_REPOS, UsageError } from './train.ts';

test('latestTag compares across both tag eras', () => {
  assert.equal(latestTag(['v0.21', '0.22.0', 'v0.9', '0.10.0']), '0.22.0');
  assert.equal(latestTag(['v0.21', 'v0.9']), 'v0.21');
  assert.equal(latestTag([]), undefined);
  assert.equal(nextMinor('0.22.0'), '0.23.0');
});

/** A fake upstream where every repo answers the same tags, except as overridden. */
function upstream(
  tags: Record<string, string[]>,
  extra: (cwd: string, args: string[]) => string | undefined = () => undefined,
) {
  const git = (cwd: string, args: string[]): string | undefined => {
    const name = cwd.split('/').pop() ?? '';
    const sub = args[0];
    if (sub === 'rev-parse' && args[1] === '--git-dir') return '.git\n';
    if (sub === 'fetch') return '';
    if (sub === 'tag') return `${(tags[name] ?? tags['*'] ?? []).join('\n')}\n`;
    if (sub === 'log') return name === 'ci-cd' ? 'abc fix: thing\n' : '';
    return extra(cwd, args);
  };
  return new Context({}, fakeIo({}, git));
}

test('readTrain reads tags and pending commits and detects skew', async () => {
  const train = await readTrain(upstream({ '*': ['0.1.0', 'v0.0.9'] }), '/ws/plexus-ms');
  assert.deepEqual(
    train.repos.map((r) => r.name),
    [...TRAIN_REPOS],
  );
  assert.equal(train.last, '0.1.0');
  assert.equal(train.skew, false);
  assert.deepEqual(train.repos.find((r) => r.name === 'ci-cd')?.pending, ['abc fix: thing']);
  assert.equal(resolveVersion(train, undefined, false), '0.2.0');
  assert.equal(resolveVersion(train, undefined, true), '0.1.0');
  assert.equal(resolveVersion(train, '1.0.0', false), '1.0.0');

  const skewed = await readTrain(upstream({ '*': ['0.1.0'], platform: ['0.1.0', '0.2.0'] }), '/ws/plexus-ms');
  assert.equal(skewed.skew, true);
  assert.equal(skewed.last, '0.2.0');
  assert.throws(
    () => resolveVersion(skewed, undefined, false),
    /latest tags disagree:\n {2}platform: 0.2.0\n {2}ci-cd: 0.1.0[\s\S]*--train 0.2.0/,
  );
  assert.equal(resolveVersion(skewed, '0.2.0', false), '0.2.0');
  assert.equal(resolveVersion(skewed, undefined, true), '0.2.0');
  assert.throws(() => resolveVersion(skewed, '1.2', true), UsageError);
});

test('preflightRelease names the first offending repo', async () => {
  const state = { branch: 'main', status: '', behind: '0' };
  const ctx = upstream({ '*': ['0.1.0'] }, (cwd, args) => {
    if (!cwd.endsWith('/ci-cd')) return args[0] === 'rev-list' ? '0\n' : args[0] === 'status' ? '' : 'main\n';
    if (args[0] === 'rev-parse') return `${state.branch}\n`;
    if (args[0] === 'status') return state.status;
    if (args[0] === 'rev-list') return `${state.behind}\n`;
    return undefined;
  });
  const train = await readTrain(ctx, '/ws/plexus-ms');
  await preflightRelease(ctx, train);
  state.behind = '2';
  await assert.rejects(preflightRelease(ctx, train), /ci-cd is 2 commit\(s\) behind origin\/main/);
  state.status = ' M x\n';
  await assert.rejects(preflightRelease(ctx, train), /ci-cd has uncommitted changes/);
  state.branch = 'feature';
  await assert.rejects(preflightRelease(ctx, train), /ci-cd is on 'feature'/);
});
