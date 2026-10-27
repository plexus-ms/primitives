import assert from 'node:assert/strict';
import { test } from 'node:test';
import { style } from '../style.ts';
import { renderReport } from './doctor.ts';

test('renderReport lists findings per declaration and sums them up', () => {
  const report = {
    declarations: [
      { path: 't/web', plexus: '0.62.0', modules: ['PLX-Repo'], findings: [] },
      {
        path: 't/platform',
        plexus: '0.61.0',
        modules: ['PLX-Repo'],
        findings: ['PLX-Repo changed in 0.62.0, declared at 0.61.0'],
      },
    ],
    stale: 1,
  };
  assert.equal(
    renderReport(report, style(false), true),
    [
      '✓ t/web: 0.62.0 [PLX-Repo]',
      '✗ t/platform: PLX-Repo changed in 0.62.0, declared at 0.61.0',
      '✗ 1 of 2 declarations stale or incomplete',
    ].join('\n'),
  );
  assert.equal(renderReport(report, style(false), false).split('\n').length, 2);
  assert.equal(renderReport({ declarations: [], stale: 0 }, style(false), true), '✗ no PLEXUS.md marker found');
});
