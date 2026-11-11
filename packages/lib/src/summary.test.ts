import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeLine, renderSummary } from './summary.ts';

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
    mergeable: [] as string[],
  };
  assert.equal(
    renderSummary(base, 'plx-dev -y ship --train 0.2.0 .').split('\n').slice(1).join('\n'),
    '  ✓ clean:      acme/web\n  → pull:       https://github.com/acme/web/pull/7\n✓ done — review and merge the pull requests',
  );
  assert.equal(
    renderSummary({ ...base, preview: true }, 'plx-dev -y ship --train 0.2.0 .')
      .split('\n')
      .slice(1)
      .join('\n'),
    '  ✓ clean:      acme/web\n  → pull:       https://github.com/acme/web/pull/7\n  (preview only — nothing was changed)\n✓ dry run clean — run it for real: plx-dev -y ship --train 0.2.0 .',
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

test('the summary ends the pull requests with one line that merges the clean ones', () => {
  const s = {
    train: '0.2.0',
    preview: false,
    clean: ['acme/web', 'acme/platform'],
    conflicted: ['acme/docs'],
    failed: [],
    skipped: [],
    resting: [],
    pulls: [
      'https://github.com/acme/web/pull/7',
      'https://github.com/acme/platform/pull/12',
      'https://github.com/acme/docs/pull/3',
    ],
    mergeable: ['https://github.com/acme/web/pull/7', 'https://github.com/acme/platform/pull/12'],
  };
  const out = renderSummary(s, '');
  assert.match(out, /^ {2}the clean ones, to merge once their checks pass:$/m);
  assert.match(out, /^ {2}gh pr merge -md -R acme\/web 7 && gh pr merge -md -R acme\/platform 12$/m);
  assert.doesNotMatch(out, /acme\/docs 3/, 'a conflicted one is not offered');
  assert.doesNotMatch(renderSummary({ ...s, preview: true }, ''), /gh pr merge/, 'a preview opened nothing');
  assert.doesNotMatch(renderSummary({ ...s, mergeable: [] }, ''), /clean ones/);
  assert.doesNotMatch(
    renderSummary({ ...s, preview: true, clean: [], conflicted: [] }, 'real'),
    /run it for real/,
    'a dry run that only found pull requests has nothing to run',
  );
  assert.equal(
    mergeLine(['acme/web plexus/0.2.0', 'https://forge/x/pull/1']),
    '',
    'what is no pull request URL is left out',
  );
});
