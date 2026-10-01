import { DateTime } from 'luxon';
import type { BillingContext } from '../src/billing';
import { billingPolicySchema, type BillingPolicy } from '../src/policies';
import type { PricePackage, PricingRule, StationInfo } from '../src/pricing';

export const TZ = 'Asia/Amman';

/** Local wall-clock time in the test zone → epoch ms. */
export const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis();

export const stations: Record<string, StationInfo> = {
  'ps-1': { id: 'ps-1', type: 'ps5', tier: 'regular' },
  'ps-2': { id: 'ps-2', type: 'ps5', tier: 'regular' },
  'vip-1': { id: 'vip-1', type: 'ps5', tier: 'vip' },
  'vr-1': { id: 'vr-1', type: 'vr', tier: 'regular' },
};

// JOD has 3 decimals: 3000 = 3.000 JOD per hour.
export const baseRules: PricingRule[] = [
  { id: 'ps5-single', name: 'PS5 single', priority: 0, active: true, match: { stationTypes: ['ps5'], modes: ['single'] }, effect: { kind: 'rate', perHour: 3000 } },
  { id: 'ps5-multi', name: 'PS5 multi', priority: 0, active: true, match: { stationTypes: ['ps5'], modes: ['multi'] }, effect: { kind: 'rate', perHour: 5000 } },
  { id: 'vip', name: 'VIP room', priority: 10, active: true, match: { tiers: ['vip'] }, effect: { kind: 'rate', perHour: 8000 } },
  { id: 'vr', name: 'VR', priority: 0, active: true, match: { stationTypes: ['vr'] }, effect: { kind: 'rate', perHour: 12000 } },
];

export function policy(overrides: Partial<BillingPolicy> = {}): BillingPolicy {
  return { ...billingPolicySchema.parse({}), autoBestPackage: false, ...overrides };
}

export function ctx(
  overrides: { rules?: PricingRule[]; packages?: PricePackage[]; policy?: Partial<BillingPolicy> } = {},
): BillingContext {
  return {
    tz: TZ,
    stations,
    rules: overrides.rules ?? baseRules,
    packages: overrides.packages ?? [],
    policy: policy(overrides.policy),
  };
}
