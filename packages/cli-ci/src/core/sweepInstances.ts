// The daily sweep (§ 8 PLX-Delivery, the hybrid strategy), the last layer:
// delete every plexus-ci instance in the zone that is stopped or past its
// death deadline, and say so by mail. Nothing of the sweep's is clever: an
// instance the other layers left behind is one that something else already
// failed on, so it goes, and the mail says it went.
//
// An instance kept after a missed boot (createInstances.ts) is the exception:
// it is stopped on purpose and carries the label `kept` with the time. The
// sweep spares it, mails once more when it has been kept for seven days, and
// deletes it after fourteen. The reminder needs no memory: a daily sweep
// meets the eighth day exactly once.
import type { Context } from '@plexus-ms/lib';
import { KEPT_LABEL } from './destroyInstances.ts';
import type { Exo, Instance } from './exoscale.ts';
import { type Smtp, sendMail } from './mail.ts';
import { iso } from './time.ts';

export const REMIND_AFTER_DAYS = 7;
export const DELETE_KEPT_AFTER_DAYS = 14;
const DAY = 86_400_000;

export interface SweepOptions {
  smtp?: Smtp;
  now?: Date;
}

export interface Sweep {
  removed: { name: string; reason: string }[];
  /** Kept instances that reached seven days today. */
  reminded: string[];
  /** Instances left alone: running before their deadline, or kept. */
  stayed: string[];
}

export type Verdict = { action: 'remove'; reason: string } | { action: 'remind' | 'stay' };

/** What the sweep does with one instance. */
export function verdictOn(instance: Instance, now: Date): Verdict {
  const kept = instance.labels[KEPT_LABEL];
  if (kept !== undefined) {
    const days = (now.getTime() - Date.parse(kept)) / DAY;
    // A label that is no time is a kept instance all the same; it stays.
    if (days >= DELETE_KEPT_AFTER_DAYS)
      return { action: 'remove', reason: `kept since ${kept}, ${DELETE_KEPT_AFTER_DAYS} days` };
    if (days >= REMIND_AFTER_DAYS && days < REMIND_AFTER_DAYS + 1) return { action: 'remind' };
    return { action: 'stay' };
  }
  const reasons: string[] = [];
  if (instance.state === 'stopped') reasons.push('stopped');
  const deadline = instance.labels['death-deadline'];
  if (deadline && deadline < iso(now)) reasons.push(`past its deadline ${deadline}`);
  return reasons.length > 0 ? { action: 'remove', reason: reasons.join(', ') } : { action: 'stay' };
}

export async function sweepInstances(ctx: Context, exo: Exo, options: SweepOptions = {}): Promise<Sweep> {
  const now = options.now ?? new Date();
  const result: Sweep = { removed: [], reminded: [], stayed: [] };
  for (const i of await exo.listInstances()) {
    if (i.labels['plexus-ci'] !== 'true') continue;
    const verdict = verdictOn(i, now);
    if (verdict.action === 'remove') {
      ctx.say(`${i.name} (${i.id}): ${verdict.reason}`);
      await exo.deleteInstance(i.id);
      result.removed.push({ name: i.name, reason: verdict.reason });
      continue;
    }
    const kept = i.labels[KEPT_LABEL];
    ctx.say(
      `${i.name} (${i.id}): ${i.state}, ${kept ? `kept since ${kept}` : `until ${i.labels['death-deadline'] ?? '-'}`}, stays`,
    );
    result.stayed.push(i.name);
    if (verdict.action === 'remind') result.reminded.push(`${i.name} (${i.id}), kept since ${kept}`);
  }
  if (options.smtp && result.removed.length > 0) {
    const text = `The daily sweep removed ${result.removed.length} plexus-ci instance(s) in ${exo.zone} that the other layers left behind:\n\n${result.removed.map((r) => `${r.name} (${r.reason})`).join('\n')}\n`;
    await sendMail(ctx, options.smtp, 'plexus-ci: the sweep removed instances', text, now);
  }
  if (options.smtp && result.reminded.length > 0) {
    const text = `These plexus-ci instance(s) in ${exo.zone} have been kept for ${REMIND_AFTER_DAYS} days after a missed boot, stopped, their disks billed. The sweep deletes each ${DELETE_KEPT_AFTER_DAYS} days after it was kept:\n\n${result.reminded.join('\n')}\n`;
    await sendMail(ctx, options.smtp, 'plexus-ci: kept instances are still there', text, now);
  }
  ctx.say(`sweep-instances: ${result.removed.length} removed, ${result.reminded.length} reminded of`);
  return result;
}
