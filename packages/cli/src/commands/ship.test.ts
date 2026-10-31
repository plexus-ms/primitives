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
});
