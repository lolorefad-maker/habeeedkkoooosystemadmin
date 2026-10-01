import { defaultBranchSettings } from '@lounge/core';
import type { DB } from './db';
import { branches, controllers, organizations, packages, pricingRules, products, stations, users } from './db/schema';
import { hashPin } from './lib/auth';
import { newId } from './lib/ids';

/**
 * Demo data for a fresh install so the system is usable immediately.
 * Every value here (names, prices, currency, time zone, PINs) is editable later in Settings.
 *
 * Demo staff PINs — change them in Settings → Staff before real use:
 *   Owner 1234 · Manager 2222 · Cashier 1111 · Waiter 3333
 */
export const DEMO_STAFF = [
  { name: 'المالك', role: 'owner', pin: '1234' },
  { name: 'المدير', role: 'manager', pin: '2222' },
  { name: 'الكاشير', role: 'cashier', pin: '1111' },
  { name: 'الويتر', role: 'waiter', pin: '3333' },
] as const;

/**
 * First start only (empty database):
 * - demo → a full sample lounge with the demo staff above (for trying the system);
 * - real → an empty branch with a single owner whose PIN comes from the environment.
 *   Stations, prices, products and staff are then added from Settings.
 */
export async function seedIfEmpty(db: DB, opts: { demo: boolean; owner?: { name: string; pin: string } | null }): Promise<boolean> {
  const existing = await db.select({ id: organizations.id }).from(organizations).limit(1);
  if (existing.length > 0) return false;
  if (!opts.demo && !opts.owner) {
    throw new Error('First start without demo data: set LOUNGE_OWNER_PIN (and optionally LOUNGE_OWNER_NAME) for the owner account.');
  }

  const orgId = newId();
  const branchId = newId();
  const settings = defaultBranchSettings();
  settings.billing.graceMinutes = 3;
  settings.billing.roundingMinutes = 5;
  settings.checkout.cashRounding = 50; // round bills to 0.050
  settings.checkout.refundApprovalAbove = 2000;

  await db.transaction(async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: 'Habeedko' });
    await tx.insert(branches).values({
      id: branchId,
      orgId,
      name: 'Habeedko',
      timezone: 'Asia/Amman',
      currency: 'JOD',
      currencyDecimals: 3,
      locale: 'ar',
      settings,
    });

    if (!opts.demo) {
      await tx.insert(users).values({ id: newId(), orgId, branchId: null, name: opts.owner!.name, role: 'owner', pinHash: await hashPin(opts.owner!.pin) });
      return;
    }

    for (const s of DEMO_STAFF) {
      await tx.insert(users).values({
        id: newId(),
        orgId,
        branchId: s.role === 'owner' ? null : branchId,
        name: s.name,
        role: s.role,
        pinHash: await hashPin(s.pin),
      });
    }

    const st: (typeof stations.$inferInsert)[] = [];
    let sort = 0;
    for (let i = 1; i <= 10; i++) {
      st.push({ id: newId(), branchId, name: `PS-${String(i).padStart(2, '0')}`, type: 'ps5', tier: 'regular', zone: 'الصالة', modes: ['single', 'multi'], sort: sort++ });
    }
    for (let i = 1; i <= 4; i++) {
      st.push({ id: newId(), branchId, name: `VIP-${i}`, type: 'ps5', tier: 'vip', zone: 'غرف VIP', modes: ['single', 'multi'], sort: sort++ });
    }
    for (let i = 1; i <= 2; i++) {
      st.push({ id: newId(), branchId, name: `VR-${i}`, type: 'vr', tier: 'regular', zone: 'VR', modes: ['standard'], sort: sort++ });
    }
    await tx.insert(stations).values(st);

    // 30 numbered controllers on the shelf, handed out with each session.
    await tx.insert(controllers).values(Array.from({ length: 30 }, (_, i) => ({ id: newId(), branchId, number: i + 1 })));

    const rule = (name: string, priority: number, match: Record<string, unknown>, effect: Record<string, unknown>, active = true) => ({
      id: newId(),
      branchId,
      name,
      priority,
      active,
      match,
      effect,
    });
    await tx.insert(pricingRules).values([
      rule('PS5 فردي', 0, { stationTypes: ['ps5'], tiers: ['regular'], modes: ['single'] }, { kind: 'rate', perHour: 2000 }),
      rule('PS5 زوجي', 0, { stationTypes: ['ps5'], tiers: ['regular'], modes: ['multi'] }, { kind: 'rate', perHour: 3000 }),
      rule('VIP فردي', 0, { stationTypes: ['ps5'], tiers: ['vip'], modes: ['single'] }, { kind: 'rate', perHour: 4000 }),
      rule('VIP زوجي', 0, { stationTypes: ['ps5'], tiers: ['vip'], modes: ['multi'] }, { kind: 'rate', perHour: 5000 }),
      rule('VR', 0, { stationTypes: ['vr'] }, { kind: 'rate', perHour: 8000 }),
      // Sunday–Thursday afternoons (ISO weekdays: 7 = Sunday … 4 = Thursday)
      rule('Happy Hour', 10, { daysOfWeek: [7, 1, 2, 3, 4], timeFrom: '12:00', timeTo: '16:00' }, { kind: 'percent', percent: -20 }),
      rule('ليلة الويكند', 5, { stationTypes: ['ps5'], daysOfWeek: [4, 5], timeFrom: '20:00', timeTo: '02:00' }, { kind: 'percent', percent: 25 }, false),
    ]);

    await tx.insert(packages).values([
      { id: newId(), branchId, name: '3 ساعات فردي', minutes: 180, price: 5000, match: { stationTypes: ['ps5'], tiers: ['regular'], modes: ['single'] } },
      { id: newId(), branchId, name: '3 ساعات زوجي', minutes: 180, price: 7500, match: { stationTypes: ['ps5'], tiers: ['regular'], modes: ['multi'] } },
    ]);

    const p = (name: string, category: string, price: number, trackStock = false, stockQty = 0, sortN = 0) => ({
      id: newId(),
      branchId,
      name,
      category,
      price,
      trackStock,
      stockQty,
      lowStockAt: trackStock ? 10 : 0,
      sort: sortN,
    });
    await tx.insert(products).values([
      p('إسبريسو', 'مشروبات ساخنة', 1000, false, 0, 1),
      p('نسكافيه', 'مشروبات ساخنة', 1250, false, 0, 2),
      p('شاي', 'مشروبات ساخنة', 750, false, 0, 3),
      p('بيبسي', 'مشروبات باردة', 750, true, 48, 1),
      p('ريد بول', 'مشروبات باردة', 2000, true, 24, 2),
      p('مي', 'مشروبات باردة', 350, true, 60, 3),
      p('ناتشوز', 'أكل', 2500, false, 0, 1),
      p('إندومي', 'أكل', 1500, true, 30, 2),
      p('توست', 'أكل', 2000, false, 0, 3),
      p('شيبس', 'سناكس', 500, true, 40, 1),
      p('شوكولاتة', 'سناكس', 750, true, 36, 2),
    ]);
  });
  return true;
}
