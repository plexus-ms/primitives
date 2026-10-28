import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frontmatterField, setFrontmatterField } from './frontmatter.ts';

const page = '---\ncode: PLX-Alpha\nmaturity: standard\nbinds: repo\n---\n\n## § 1 One\n\n> - A repo MUST alpha.\n';

test('setFrontmatterField replaces a present field in place', () => {
  const out = setFrontmatterField(page, 'maturity', 'candidate');
  assert.equal(out, page.replace('maturity: standard', 'maturity: candidate'));
});

test('setFrontmatterField inserts after the anchor, else at the end of the frontmatter', () => {
  assert.equal(
    setFrontmatterField(page, 'changed', '0.2.0', { after: 'binds' }).split('\n').slice(0, 6).join('\n'),
    '---\ncode: PLX-Alpha\nmaturity: standard\nbinds: repo\nchanged: 0.2.0\n---',
  );
  assert.equal(
    setFrontmatterField(page, 'changed', '0.2.0', { after: 'nowhere' }).split('\n').slice(0, 6).join('\n'),
    '---\ncode: PLX-Alpha\nmaturity: standard\nbinds: repo\nchanged: 0.2.0\n---',
  );
  // A field only matches as a key, never as a value or a prefix of a longer key.
  const out = setFrontmatterField('---\nchanged_by: x\nnote: changed\n---\n', 'changed', '1');
  assert.equal(out, '---\nchanged_by: x\nnote: changed\nchanged: 1\n---\n');
});

test('setFrontmatterField leaves the body alone and refuses a page without frontmatter', () => {
  const out = setFrontmatterField(page, 'changed', '0.2.0');
  assert.ok(out.endsWith('\n> - A repo MUST alpha.\n'));
  assert.throws(() => setFrontmatterField('# no frontmatter\n', 'x', 'y'), /no frontmatter/);
});

test('frontmatterField reads a value as written', () => {
  assert.equal(frontmatterField(page, 'binds'), 'repo');
  assert.equal(frontmatterField(page, 'changed'), undefined);
  assert.equal(frontmatterField('version: 1\n', 'version'), undefined);
});
