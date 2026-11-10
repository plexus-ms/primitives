import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Catalog, Module } from './catalog.ts';
import { DEFAULT_MAX_AGE, maxAgeOf, needOf, parseMaxAge, type Release, staleModules } from './need.ts';

const releases: Release[] = [
  { train: '0.3.0', published: '2026-02-25T10:00:00Z' },
  { train: '0.1.0', published: '2026-01-01T10:00:00Z' },
  { train: '0.2.0', published: '2026-02-10T10:00:00Z' },
];
const on = (day: string) => new Date(`${day}T12:00:00Z`);
const base = { recorded: ['0.1.0'], releases, maxAge: 30, now: on('2026-03-01') };

test('a repo rests while the oldest train it has not taken is younger than the backstop age', () => {
  assert.deepEqual(needOf(base), {
    take: false,
    why: '2 newer trains, the oldest (0.2.0) cut 19 days ago; the backstop is 30 days',
  });
  assert.deepEqual(needOf({ ...base, recorded: ['0.3.0'] }), { take: false, why: 'no train newer than 0.3.0' });
});

test('the backstop is measured from the oldest train not taken, not from the newest', () => {
  const due = needOf({ ...base, now: on('2026-03-12') });
  assert.equal(due.take && due.trigger, 'backstop');
  assert.match(
    due.why,
    /^0\.2\.0, the oldest train not taken, was cut 30 days ago \(backstop: 30 days; 2 newer trains\)$/,
  );
  // On 0.2.0 only 0.3.0 is not taken, and it is 15 days old.
  assert.equal(needOf({ ...base, recorded: ['0.2.0'], now: on('2026-03-12') }).take, false);
});

test('the site furthest behind is the one the repo is measured by', () => {
  const need = needOf({ ...base, recorded: ['0.3.0', '0.1.0'], now: on('2026-03-12') });
  assert.equal(need.take, true);
  assert.equal(needOf({ ...base, recorded: ['0.3.0', '0.2.0'], now: on('2026-03-12') }).take, false);
});

test('asking takes the train whatever its age, and zero days takes every train', () => {
  assert.deepEqual(needOf({ ...base, asked: '--now' }), { take: true, trigger: 'asked', why: 'asked for (--now)' });
  assert.deepEqual(needOf({ ...base, maxAge: 0, now: on('2026-02-25') }), {
    take: true,
    trigger: 'backstop',
    why: 'a backstop age of zero takes every train (2 newer trains)',
  });
  assert.equal(needOf({ ...base, maxAge: 0, recorded: ['0.3.0'] }).take, false, 'nothing newer, nothing to take');
});

const module = (code: string, changed?: string): [string, Module] => [
  code,
  {
    code,
    kind: 'approach',
    maturity: changed ? 'standard' : 'candidate',
    binds: 'repo',
    changed,
    depends: [],
    consumes: [],
  },
];
const catalog: Catalog = new Map([module('PLX-Repo', '0.2.0'), module('PLX-JS', '0.3.0'), module('PLX-CLI')]);

test('a declared module is stale when its changed is newer than the marker that declares it', () => {
  const markers = [
    { where: 'web/PLEXUS.md', plexus: '0.2.0', modules: ['PLX-Repo', 'PLX-JS', 'PLX-CLI', 'PLX-Gone'] },
    { where: 'web/apps/site/PLEXUS.md', plexus: '0.1.0', modules: ['PLX-Repo'] },
    { where: 'web/apps/new/PLEXUS.md', plexus: '0.3.0', modules: ['PLX-Repo', 'PLX-JS'] },
    { where: 'web/apps/odd/PLEXUS.md', plexus: 'next', modules: ['PLX-JS'] },
  ];
  assert.deepEqual(staleModules(markers, catalog), [
    { code: 'PLX-JS', changed: '0.3.0', where: 'web/PLEXUS.md', declared: '0.2.0' },
    { code: 'PLX-Repo', changed: '0.2.0', where: 'web/apps/site/PLEXUS.md', declared: '0.1.0' },
  ]);
  assert.deepEqual(staleModules(markers, new Map()), [], 'no catalogue, nothing stale');
});

test('a stale module takes the train whatever its age; asking comes first and names itself', () => {
  const stale = staleModules(
    [
      { where: 'web/PLEXUS.md', plexus: '0.2.0', modules: ['PLX-JS'] },
      { where: 'web/apps/site/PLEXUS.md', plexus: '0.1.0', modules: ['PLX-Repo', 'PLX-JS'] },
    ],
    catalog,
  );
  assert.deepEqual(needOf({ ...base, stale }), {
    take: true,
    trigger: 'module',
    why: 'PLX-JS changed in 0.3.0, declared at 0.2.0 in web/PLEXUS.md, and 2 more',
  });
  assert.equal(
    needOf({ ...base, stale: stale.slice(0, 1) }).why,
    'PLX-JS changed in 0.3.0, declared at 0.2.0 in web/PLEXUS.md',
  );
  assert.equal(needOf({ ...base, stale, asked: '--now' }).why, 'asked for (--now)');
  assert.equal(needOf({ ...base, stale: [] }).take, false);
});

test('a site that records no train is brought onto one', () => {
  assert.match(needOf({ ...base, recorded: ['0.3.0', 'a1b2c3d'] }).why, /a site records 'a1b2c3d', not a train/);
  assert.match(needOf({ ...base, recorded: [undefined] }).why, /a site records no version/);
});

test('the backstop age of a repo is its answer, 30 days when the answers do not say', () => {
  assert.equal(maxAgeOf({}), DEFAULT_MAX_AGE);
  assert.equal(DEFAULT_MAX_AGE, 30);
  assert.equal(maxAgeOf({ update_max_age: 7 }), 7);
  assert.equal(maxAgeOf({ update_max_age: '0' }), 0);
  assert.throws(() => maxAgeOf({ update_max_age: -1 }), /not a whole number of days/);
  assert.throws(() => parseMaxAge('1.5', '--max-age'), /--max-age is '1.5', not a whole number of days/);
});

// The trains of the consolidated layout up to 2026-11-10, as the forge dates
// them; the 14 from 2026-11-01 on each opened a pull request in every
// consumer. plexus-ms/libraries had no change of its own in that time.
const NOVEMBER: Release[] = [
  ['0.100.0', '2026-10-31T19:14:26Z'],
  ['0.101.0', '2026-10-31T20:16:18Z'],
  ['0.102.0', '2026-10-31T21:43:50Z'],
  ['0.103.0', '2026-11-01T19:11:44Z'],
  ['0.104.0', '2026-11-01T20:47:11Z'],
  ['0.105.0', '2026-11-01T22:58:54Z'],
  ['0.106.0', '2026-11-05T10:51:34Z'],
  ['0.106.1', '2026-11-05T14:47:24Z'],
  ['0.107.0', '2026-11-05T15:55:28Z'],
  ['0.108.0', '2026-11-05T22:17:08Z'],
  ['0.109.0', '2026-11-05T22:53:37Z'],
  ['0.110.0', '2026-11-06T12:12:12Z'],
  ['0.111.0', '2026-11-08T09:37:08Z'],
  ['0.112.0', '2026-11-08T17:41:11Z'],
  ['0.113.0', '2026-11-09T14:56:31Z'],
  ['0.114.0', '2026-11-09T20:43:27Z'],
  ['0.115.0', '2026-11-10T17:31:32Z'],
].map(([train = '', published = '']) => ({ train, published }));

test('replay: a quiet repo on 0.102.0 rests through the trains of 2026-11-01 to 2026-11-10, and takes one a month on', () => {
  const daily = (from: string, days: number) =>
    Array.from({ length: days }, (_, i) => new Date(Date.parse(`${from}T06:23:00Z`) + i * 86_400_000));
  const known = (now: Date) => NOVEMBER.filter((r) => Date.parse(r.published) <= now.getTime());
  const taken = (runs: Date[]) =>
    runs.filter((now) => needOf({ recorded: ['0.102.0'], releases: known(now), maxAge: 30, now }).take);
  assert.equal(taken(daily('2026-11-01', 10)).length, 0, 'no pull request in the ten days');
  // 0.103.0 was cut on 2026-11-01 in the evening: the scheduled run of 2026-12-02 is the first past 30 days.
  const first = taken(daily('2026-11-01', 40))[0];
  assert.equal(first?.toISOString().slice(0, 10), '2026-12-02');
});
