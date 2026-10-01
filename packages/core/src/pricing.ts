import { z } from 'zod';
import { atLocalMinutes, minutesOfDay, parseHHmm, toLocal } from './time';

/**
 * Pricing is a list of rules the owner edits in the UI.
 *
 * At any instant, for a given station + play mode:
 *   1. the highest-priority matching `rate` rule sets the hourly price;
 *   2. the highest-priority matching `percent` rule (if any) adjusts it (e.g. happy hour −20%).
 * Ties break on specificity (more conditions wins), then id, so results are deterministic.
 */

const hhmm = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'HH:mm');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const ruleMatchSchema = z.object({
  stationIds: z.array(z.string()).nullish(),
  stationTypes: z.array(z.string()).nullish(),
  tiers: z.array(z.string()).nullish(),
  modes: z.array(z.string()).nullish(),
  /** ISO weekdays: 1 = Monday … 7 = Sunday. For windows crossing midnight, the day the window started. */
  daysOfWeek: z.array(z.number().int().min(1).max(7)).nullish(),
  /** Local time window [from, to). If to ≤ from the window crosses midnight. */
  timeFrom: hhmm.nullish(),
  timeTo: hhmm.nullish(),
  dateFrom: isoDate.nullish(),
  dateTo: isoDate.nullish(),
  /**
   * Validity in absolute time [startsAt, endsAt) (epoch ms). Set by the server: an edited price
   * ends the old version *now* and starts the new one *now*, so time already played keeps the
   * price it was played at. Also used by the owner's one-tap "discount now".
   */
  startsAt: z.number().int().nullish(),
  endsAt: z.number().int().nullish(),
});

export const ruleEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rate'), perHour: z.number().int().min(0) }),
  z.object({ kind: z.literal('percent'), percent: z.number().min(-100).max(500) }),
]);

export const pricingRuleSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  priority: z.number().int().default(0),
  active: z.boolean().default(true),
  match: ruleMatchSchema.prefault({}),
  effect: ruleEffectSchema,
});

export const packageMatchSchema = z.object({
  stationTypes: z.array(z.string()).nullish(),
  tiers: z.array(z.string()).nullish(),
  modes: z.array(z.string()).nullish(),
});

export const pricePackageSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  minutes: z.number().int().min(1),
  price: z.number().int().min(0),
  active: z.boolean().default(true),
  match: packageMatchSchema.prefault({}),
});

export type RuleMatch = z.output<typeof ruleMatchSchema>;
export type RuleEffect = z.output<typeof ruleEffectSchema>;
export type PricingRule = z.output<typeof pricingRuleSchema>;
export type PricePackage = z.output<typeof pricePackageSchema>;

export interface StationInfo {
  id: string;
  type: string;
  tier: string;
}

export interface RateQuote {
  /** Minor units per hour (may be fractional after a percent adjustment). */
  perHour: number;
  baseRuleId: string;
  percentRuleId: string | null;
}

const inList = <T>(list: readonly T[] | null | undefined, v: T) => !list || list.length === 0 || list.includes(v);

function specificity(m: RuleMatch): number {
  let n = 0;
  if (m.stationIds?.length) n += 4;
  if (m.stationTypes?.length) n++;
  if (m.tiers?.length) n++;
  if (m.modes?.length) n++;
  if (m.daysOfWeek?.length) n++;
  if (m.timeFrom || m.timeTo) n++;
  if (m.dateFrom || m.dateTo) n++;
  return n;
}

export function ruleAppliesAt(rule: PricingRule, station: StationInfo, mode: string, t: number, tz: string): boolean {
  const m = rule.match;
  if (!inList(m.stationIds, station.id)) return false;
  if (!inList(m.stationTypes, station.type)) return false;
  if (!inList(m.tiers, station.tier)) return false;
  if (!inList(m.modes, mode)) return false;
  if (m.startsAt != null && t < m.startsAt) return false;
  if (m.endsAt != null && t >= m.endsAt) return false;

  const dt = toLocal(t, tz);
  let anchor = dt;
  if (m.timeFrom || m.timeTo) {
    const from = parseHHmm(m.timeFrom ?? '00:00');
    const to = parseHHmm(m.timeTo ?? '24:00');
    const now = minutesOfDay(dt);
    if (from < to) {
      if (now < from || now >= to) return false;
    } else if (from > to) {
      if (now >= from) anchor = dt;
      else if (now < to) anchor = dt.minus({ days: 1 });
      else return false;
    }
    // from === to → whole day
  }

  if (m.daysOfWeek?.length && !m.daysOfWeek.includes(anchor.weekday)) return false;
  const date = anchor.toISODate()!;
  if (m.dateFrom && date < m.dateFrom) return false;
  if (m.dateTo && date > m.dateTo) return false;
  return true;
}

function pickTop(rules: PricingRule[]): PricingRule | undefined {
  return [...rules].sort(
    (a, b) => b.priority - a.priority || specificity(b.match) - specificity(a.match) || a.id.localeCompare(b.id),
  )[0];
}

export function quoteRate(
  rules: PricingRule[],
  station: StationInfo,
  mode: string,
  t: number,
  tz: string,
): RateQuote | null {
  const applicable = rules.filter((r) => r.active && ruleAppliesAt(r, station, mode, t, tz));
  const base = pickTop(applicable.filter((r) => r.effect.kind === 'rate'));
  if (!base || base.effect.kind !== 'rate') return null;
  const pct = pickTop(applicable.filter((r) => r.effect.kind === 'percent'));
  let perHour: number = base.effect.perHour;
  if (pct && pct.effect.kind === 'percent') perHour = perHour * (1 + pct.effect.percent / 100);
  return { perHour: Math.max(0, perHour), baseRuleId: base.id, percentRuleId: pct?.id ?? null };
}

/**
 * Instants inside (a, b) where a rule could start or stop applying: every rule's
 * time-window edge and every local midnight (weekday/date changes).
 */
export function rateBoundaries(rules: PricingRule[], a: number, b: number, tz: string): number[] {
  if (b <= a) return [];
  const edges = new Set<number>([0]);
  for (const r of rules) {
    if (!r.active) continue;
    if (r.match.timeFrom) edges.add(parseHHmm(r.match.timeFrom) % 1440);
    if (r.match.timeTo) edges.add(parseHHmm(r.match.timeTo) % 1440);
  }
  const out = new Set<number>();
  for (const r of rules) {
    if (!r.active) continue;
    for (const edge of [r.match.startsAt, r.match.endsAt]) if (edge != null && edge > a && edge < b) out.add(edge);
  }
  let day = toLocal(a, tz).startOf('day');
  while (day.toMillis() < b) {
    for (const minutes of edges) {
      const inst = atLocalMinutes(day, minutes).toMillis();
      if (inst > a && inst < b) out.add(inst);
    }
    day = day.plus({ days: 1 }).startOf('day');
  }
  return [...out].sort((x, y) => x - y);
}

export function packageMatches(pkg: PricePackage, station: StationInfo, mode: string): boolean {
  return (
    inList(pkg.match.stationTypes, station.type) && inList(pkg.match.tiers, station.tier) && inList(pkg.match.modes, mode)
  );
}
