import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderChangeset } from './changeset.ts';

test('renderChangeset lists the releases owed, or that none is', () => {
  const path = '.changeset/bot-tailwind-merge-3-x.md';
  assert.equal(
    renderChangeset({ path, releases: { '@x/std': 'patch', '@x/ui': 'major' }, changes: [], plan: [] }),
    `✓ ${path}\n  @x/std: patch\n  @x/ui: major`,
  );
  assert.equal(renderChangeset({ path, releases: {}, changes: [], plan: [] }), `✓ nothing owed; no ${path}`);
});
