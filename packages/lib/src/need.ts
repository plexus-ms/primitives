// need: does a repo need the newest train (§ 3 PLX-Updates)? Cutting a train
// and a repo taking it are separate events: that a newer train exists is not
// a need. Three triggers are, and this file decides two of them:
//
//   asked     somebody told the verb to take the train now, or named one
//   backstop  the oldest train the repo has not taken was cut longer ago than
//             the tenant's maximum age (30 days unless its answers say
//             otherwise; zero takes every train as it is cut)
//
// The third, a declared module whose `changed` is newer than the marker,
// waits for the data a train publishes about itself. While none holds the
// repo rests on the train it has, which its immutable pins make safe (§ 1.6
// PLX). Pure: the caller reads the releases and the clock.
import { compareTrains } from './doctor.ts';
import { isTrainVersion } from './train.ts';

/** The backstop age, in days, of a repo whose answers do not set one. */
export const DEFAULT_MAX_AGE = 30;
/** The answer of the repo presets that sets the backstop age, in days. */
export const MAX_AGE_ANSWER = 'update_max_age';

/** A train as the forge knows it: its number and when its release was published. */
export interface Release {
  train: string;
  /** ISO 8601, as the forge gives it. */
  published: string;
}

export type Trigger = 'asked' | 'backstop';

export type Need =
  /** Take the newest train; `why` is a clause for the narration and the pull request. */
  | { take: true; trigger: Trigger; why: string }
  /** Rest on the train the repo has; `why` says what would end the rest. */
  | { take: false; why: string };

export interface NeedInput {
  /** What each site of the repo records as its train (the answers' `_commit`). */
  recorded: (string | undefined)[];
  /** The preset's releases, in any order. */
  releases: Release[];
  /** How the run was asked, if it was: `--now`, `--train 0.2.0`. */
  asked?: string;
  /** The backstop age in days. */
  maxAge: number;
  now: Date;
}

const DAY = 24 * 60 * 60 * 1000;
const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

export function needOf({ recorded, releases, asked, maxAge, now }: NeedInput): Need {
  if (asked) return { take: true, trigger: 'asked', why: `asked for (${asked})` };
  // A site that records no train (a commit, a branch) cannot be placed among
  // the releases; it is brought onto the train rather than left there.
  const odd = recorded.findIndex((r) => !r || !isTrainVersion(r));
  if (recorded.length === 0 || odd >= 0)
    return {
      take: true,
      trigger: 'backstop',
      why: `a site records ${recorded[odd] ? `'${recorded[odd]}'` : 'no version'}, not a train`,
    };

  const trains = recorded as string[];
  const oldest = trains.reduce((a, b) => (compareTrains(a, b) <= 0 ? a : b));
  const untaken = releases
    .filter((r) => isTrainVersion(r.train) && compareTrains(r.train, oldest) > 0)
    .sort((a, b) => Date.parse(a.published) - Date.parse(b.published));
  const first = untaken[0];
  if (!first) return { take: false, why: `no train newer than ${oldest}` };

  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(first.published)) / DAY));
  const count = `${untaken.length} newer train${untaken.length === 1 ? '' : 's'}`;
  if (maxAge === 0)
    return { take: true, trigger: 'backstop', why: `a backstop age of zero takes every train (${count})` };
  if (age >= maxAge)
    return {
      take: true,
      trigger: 'backstop',
      why: `${first.train}, the oldest train not taken, was cut ${days(age)} ago (backstop: ${days(maxAge)}; ${count})`,
    };
  return {
    take: false,
    why: `${count}, the oldest (${first.train}) cut ${days(age)} ago; the backstop is ${days(maxAge)}`,
  };
}

/** The backstop age a repo's answers set, or the default; a value that is not a whole number of days is refused. */
export function maxAgeOf(answers: Record<string, unknown>): number {
  const value = answers[MAX_AGE_ANSWER];
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_AGE;
  return parseMaxAge(String(value), `the answer ${MAX_AGE_ANSWER}`);
}

export function parseMaxAge(value: string, what: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`${what} is '${value}', not a whole number of days`);
  return Number(value.trim());
}
