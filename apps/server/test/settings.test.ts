import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
const settings = async () => (await h.api('GET', '/api/settings', undefined, h.tokens.owner)).json as Json;

beforeAll(async () => {
  h = await createHarness('2026-09-25T15:00:00Z');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('settings: every tab saves what it shows', () => {
  it('general: name, time zone, currency', async () => {
    const ok = await h.api('PATCH', '/api/settings/branch', { name: 'Habeedko', timezone: 'Asia/Amman', currency: 'jod', locale: 'ar' }, h.tokens.owner);
    expect(ok.status).toBe(200);
    expect((await settings()).branch).toMatchObject({ name: 'Habeedko', currency: 'JOD' });
    expect((await h.api('PATCH', '/api/settings/branch', { timezone: 'Mars/Olympus' }, h.tokens.owner)).json.code).toBe('invalid_timezone');
  });

  it('policies: a partial change keeps every other rule as it was', async () => {
    const before = (await settings()).branch.settings;
    const r = await h.api('PATCH', '/api/settings/branch', { settings: { billing: { graceMinutes: 7 } } }, h.tokens.owner);
    expect(r.status).toBe(200);
    const after = (await settings()).branch.settings;
    expect(after.billing.graceMinutes).toBe(7);
    expect({ ...after.billing, graceMinutes: before.billing.graceMinutes }).toEqual(before.billing);
    expect(after.checkout).toEqual(before.checkout);
    // Invalid values are refused, not saved half-way.
    expect((await h.api('PATCH', '/api/settings/branch', { settings: { billing: { roundingMinutes: -5 } } }, h.tokens.owner)).status).toBe(400);
    expect((await settings()).branch.settings.billing.roundingMinutes).toBe(before.billing.roundingMinutes);
  });

  it('stations: add, rename, and no two stations with the same name', async () => {
    const add = await h.api('POST', '/api/settings/stations', { name: 'PS-11', type: 'ps5', tier: 'regular', zone: 'الصالة', modes: ['single', 'multi'], sort: 99 }, h.tokens.owner);
    expect(add.status).toBe(200);
    expect((await h.floor()).stations.some((s: Json) => s.name === 'PS-11')).toBe(true);

    const dup = await h.api('POST', '/api/settings/stations', { name: 'ps-11', type: 'ps5', tier: 'regular', zone: '', modes: ['single'] }, h.tokens.owner);
    expect(dup.json.code).toBe('name_taken');
    const ps1 = (await settings()).stations.find((s: Json) => s.name === 'PS-01');
    const clash = await h.api('PATCH', `/api/settings/stations/${add.json.id}`, { name: 'PS-01' }, h.tokens.owner);
    expect(clash.json.code).toBe('name_taken');
    // Saving a station with its own name is fine.
    const same = await h.api('PATCH', `/api/settings/stations/${ps1.id}`, { ...ps1, id: undefined, branchId: undefined }, h.tokens.owner);
    expect(same.status).toBe(200);
  });

  it('pricing: a new hourly rule and a package', async () => {
    const rule = await h.api(
      'POST',
      '/api/settings/rules',
      { name: 'PS-11 خاص', priority: 50, active: true, effect: { kind: 'rate', perHour: 2500 }, match: { stationIds: null, stationTypes: ['ps5'], tiers: ['regular'], modes: ['single'] } },
      h.tokens.owner,
    );
    expect(rule.status).toBe(200);
    const pkg = await h.api('POST', '/api/settings/packages', { name: 'ساعتين', minutes: 120, price: 3500, active: true, match: { stationTypes: ['ps5'] } }, h.tokens.owner);
    expect(pkg.status).toBe(200);
    const s = await settings();
    expect(s.rules.some((r: Json) => r.name === 'PS-11 خاص')).toBe(true);
    expect(s.packages.some((p: Json) => p.name === 'ساعتين' && p.price === 3500)).toBe(true);
  });

  it('products: editing the price keeps the stock, and names are unique', async () => {
    const chips = (await settings()).products.find((p: Json) => p.name === 'شيبس');
    const r = await h.api('PATCH', `/api/settings/products/${chips.id}`, { name: 'شيبس', category: chips.category, price: 600, trackStock: true, lowStockAt: 5, active: true, sort: chips.sort }, h.tokens.owner);
    expect(r.status).toBe(200);
    const after = (await settings()).products.find((p: Json) => p.id === chips.id);
    expect(after).toMatchObject({ price: 600, lowStockAt: 5, stockQty: chips.stockQty });

    expect((await h.api('POST', '/api/settings/products', { name: 'شيبس', category: 'سناكس', price: 500 }, h.tokens.owner)).json.code).toBe('name_taken');
    const viaDelivery = await h.api('POST', '/api/stock/receive', { lines: [{ newProduct: { name: 'شيبس', category: 'سناكس' }, cartons: 1, packSize: 10 }] }, h.tokens.owner);
    expect(viaDelivery.json.code).toBe('name_taken');
  });

  it('products: a new product can start with its stock, and a recount is a recorded movement', async () => {
    const add = await h.api('POST', '/api/settings/products', { name: 'كيت كات', category: 'سناكس', price: 400, stockQty: 24, lowStockAt: 5 }, h.tokens.owner);
    expect(add.status).toBe(200);
    let p = (await settings()).products.find((x: Json) => x.id === add.json.id);
    expect(p).toMatchObject({ trackStock: true, stockQty: 24, lowStockAt: 5 });

    const recount = await h.api('PATCH', `/api/settings/products/${p.id}`, { name: 'كيت كات', category: 'سناكس', price: 400, trackStock: true, lowStockAt: 5, active: true, sort: 0, stockQty: 20 }, h.tokens.owner);
    expect(recount.status).toBe(200);
    // Editing without a count leaves the stock alone.
    await h.api('PATCH', `/api/settings/products/${p.id}`, { price: 450 }, h.tokens.owner);
    p = (await settings()).products.find((x: Json) => x.id === add.json.id);
    expect(p).toMatchObject({ stockQty: 20, price: 450 });

    const moves = (await h.api('GET', `/api/stock/movements?productId=${p.id}`, undefined, h.tokens.owner)).json as Json[];
    expect(moves.map((m) => [m.reason, m.delta])).toEqual([
      ['adjust', -4],
      ['purchase', 24],
    ]);
  });

  it('staff: the shop can never lose its last owner', async () => {
    const owner = (await settings()).staff.find((u: Json) => u.role === 'owner');
    expect((await h.api('PATCH', `/api/settings/staff/${owner.id}`, { name: owner.name, role: 'manager', active: true }, h.tokens.owner)).json.code).toBe('last_owner');
    expect((await h.api('PATCH', `/api/settings/staff/${owner.id}`, { name: owner.name, role: 'owner', active: false }, h.tokens.owner)).json.code).toBe('last_owner');

    const second = await h.api('POST', '/api/settings/staff', { name: 'شريك', role: 'owner', pin: '8642', active: true }, h.tokens.owner);
    expect(second.status).toBe(200);
    // With a second owner, the first one may step down…
    expect((await h.api('PATCH', `/api/settings/staff/${owner.id}`, { name: owner.name, role: 'manager', active: true }, h.tokens.owner)).status).toBe(200);
    // …but cannot promote themselves back; the other owner can.
    expect((await h.api('PATCH', `/api/settings/staff/${owner.id}`, { name: owner.name, role: 'owner', active: true }, h.tokens.owner)).status).toBe(403);
    const [branch] = (await h.api('GET', '/api/auth/branches')).json as Json[];
    const partner = (await h.api('POST', '/api/auth/login', { userId: second.json.id, branchId: branch!.id, pin: '8642' })).json.token;
    expect((await h.api('PATCH', `/api/settings/staff/${owner.id}`, { name: owner.name, role: 'owner', active: true }, partner)).status).toBe(200);
    // A manager cannot touch owners.
    expect((await h.api('PATCH', `/api/settings/staff/${second.json.id}`, { active: false }, h.tokens.manager)).status).toBe(403);
  });

  it('currency decimals are locked once money has moved', async () => {
    expect((await h.api('PATCH', '/api/settings/branch', { currencyDecimals: 2 }, h.tokens.owner)).status).toBe(200);
    expect((await h.api('PATCH', '/api/settings/branch', { currencyDecimals: 3 }, h.tokens.owner)).status).toBe(200);

    await h.api('POST', '/api/shifts/open', { openingFloat: 0 }, h.tokens.cashier);
    const floor = await h.floor();
    const st = floor.stations.find((s: Json) => s.name === 'PS-02');
    await h.api('POST', '/api/sessions', { stationId: st.id, mode: 'single', kind: 'open', prepaid: { amount: 1000, method: 'cash' } }, h.tokens.cashier);

    expect((await h.api('PATCH', '/api/settings/branch', { currencyDecimals: 2 }, h.tokens.owner)).json.code).toBe('decimals_locked');
    // Saving the same value (the general form sends everything) still works.
    expect((await h.api('PATCH', '/api/settings/branch', { currencyDecimals: 3, name: 'Habeedko' }, h.tokens.owner)).status).toBe(200);
  });

  it('audit: every change above is in the log with who did it', async () => {
    const log = (await h.api('GET', '/api/audit?limit=100', undefined, h.tokens.owner)).json as Json[];
    const types = new Set(log.map((e) => e.type));
    for (const t of ['settings.updated', 'station.created', 'pricing_rule.created', 'package.created', 'product.updated', 'staff.created', 'staff.updated']) {
      expect(types.has(t)).toBe(true);
    }
    expect(log.find((e) => e.type === 'staff.created').actorName).toBeTruthy();
  });
});
