import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSummary } from './ship.ts';

test('renderSummary lists every site and ends with the verdict', () => {
  const base = {
    train: '0.2.0',
    preview: false,
    clean: ['acme/web'],
    conflicted: [],
    failed: [],
    skipped: [],
    resting: [] as { path: string; reason: string }[],
    pulls: ['https://github.com/acme/web/pull/7'],
  };
  assert.equal(
    renderSummary(base, 'plx -y ship --train 0.2.0 .').split('\n').slice(1).join('\n'),
    '  ✓ clean:      acme/web\n  → pull:       https://github.com/acme/web/pull/7\n✓ done — review and merge the pull requests',
  );
  assert.equal(
    renderSummary({ ...base, preview: true }, 'plx -y ship --train 0.2.0 .')
      .split('\n')
      .slice(1)
      .join('\n'),
    '  ✓ clean:      acme/web\n  → pull:       https://github.com/acme/web/pull/7\n  (preview only — nothing was changed)\n✓ dry run clean — run it for real: plx -y ship --train 0.2.0 .',
  );
  const bad = renderSummary(
    {
      ...base,
      conflicted: ['acme/web/apps/site'],
      skipped: [{ path: 'acme/platform', reason: 'has uncommitted changes' }],
    },
    '',
  );
  assert.match(bad, /^ {2}✗ conflicts: {2}acme\/web\/apps\/site$/m);
  assert.match(bad, /^ {2}⚠ skipped: {4}acme\/platform \(has uncommitted changes\)$/m);
  assert.match(bad, /^✗ needs attention/m);
  assert.doesNotMatch(bad, /✓ done/);
  const resting = renderSummary(
    {
      ...base,
      clean: [],
      pulls: [],
      resting: [{ path: 'web', reason: '1 newer train, the oldest (0.2.0) cut 3 days ago' }],
    },
    '',
  );
  assert.match(resting, /^ {2}• resting: {4}web \(1 newer train, the oldest \(0\.2\.0\) cut 3 days ago\)$/m);
  assert.match(resting, /^✓ done — no pull request$/m, 'a resting repo needs nobody');
  assert.doesNotMatch(
    renderSummary({ ...base, preview: true, clean: [], pulls: [], resting: [{ path: 'web', reason: 'r' }] }, 'real'),
    /run it for real/,
    'a resting dry run names no command that would take the train',
  );
});
