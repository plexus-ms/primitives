// The clock, in one place: deadlines as absolute UTC times (what the instance
// labels and the sweep compare), and the registry's month names (§ 8
// PLX-Delivery: writes to this month's bucket, reads this and the previous,
// the one before is deleted whole). Pure, so that the tests pin the arithmetic.

/** `2026-11-04T10:40:27Z`, the shape every label and log line uses. */
export function iso(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The absolute time `minutes` from `now`. */
export function deadline(now: Date, minutes: number): string {
  return iso(new Date(now.getTime() + minutes * 60_000));
}

/** `YYYY-MM` of the month `offset` months from `now`'s (0 this month, -1 the previous). */
export function month(now: Date, offset = 0): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The registry bucket names of one owner: by convention `<owner>-ci-registry-<YYYY-MM>`. */
export function registryBuckets(owner: string, now: Date): { current: string; previous: string; expired: string } {
  const name = (offset: number) => `${owner}-ci-registry-${month(now, offset)}`;
  return { current: name(0), previous: name(-1), expired: name(-2) };
}

/** The Turbo cache bucket of one owner, `<owner>-ci-turbo`. */
export const turboBucket = (owner: string): string => `${owner}-ci-turbo`;
