import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Json } from './harness';

// The shop configured locally (demo data), and a brand-new online install with only an owner.
let local: Awaited<ReturnType<typeof createHarness>>;
let online: Awaited<ReturnType<typeof createHarness>>;

beforeAll(async () => {
  local = await createHarness('2026-09-25T15:00:00Z');
  online = await createHarness('2026-10-02T09:00:00Z', {
    mode: 'cloud',
    seedDemo: false,
    accessCode: 'habeedko-123',
    owner: { name: 'المالك', pin: '246810' },
  });
}, 60_000);

afterAll(async () => {
  await local?.close();
  await online?.close();
});

describe('moving the setup to the online server', () => {
  let file: Json;

  it('exports stations, prices, packages, products, controllers and policies — no money, no staff', async () => {
    // Some local history that must NOT travel: a session, a sale, stock.
    const floor = await local.floor();
    await local.api('POST', '/api/sessions', { stationId: floor.stations[0].id, mode: 'single', kind: 'open' }, local.tokens.cashier);
    await local.api('PATCH', '/api/settings/branch', { name: 'Habeedko', settings: { billing: { graceMinutes: 4 } } }, local.tokens.owner);

    const r = await local.api('GET', '/api/settings/export', undefined, local.tokens.owner);
    expect(r.status).toBe(200);
    file = r.json;
    expect(file).toMatchObject({ format: 'lounge-setup', version: 1, branch: { name: 'Habeedko' } });
    expect(file.stations.length).toBe(floor.stations.length);
    expect(file.products.length).toBeGreaterThan(0);
    expect(file.controllers.length).toBeGreaterThan(0);
    expect(file.rules.length).toBeGreaterThan(0);
    const text = JSON.stringify(file);
    for (const secret of ['pin', 'Hash', 'stockQty', 'sessions', 'payments']) expect(text).not.toContain(secret);
    // Cashiers cannot read it.
    expect((await local.api('GET', '/api/settings/export', undefined, local.tokens.cashier)).status).toBe(403);
  });

  it('imports into the empty online shop, once, owner only', async () => {
    const owner = online.tokens.owner!;
    expect((await online.floor('owner')).stations).toHaveLength(0);

    const r = await online.api('POST', '/api/settings/import', file, owner);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ stations: file.stations.length, products: file.products.length, controllers: file.controllers.length });

    const s = (await online.api('GET', '/api/settings', undefined, owner)).json;
    expect(s.branch.name).toBe('Habeedko');
    expect(s.branch.settings.billing.graceMinutes).toBe(4);
    expect(s.stations.map((x: Json) => x.name).sort()).toEqual(file.stations.map((x: Json) => x.name).sort());
    // Stock starts at zero online; prices and alert levels come along.
    const chips = s.products.find((p: Json) => p.name === 'شيبس');
    expect(chips).toMatchObject({ stockQty: 0, trackStock: true, price: file.products.find((p: Json) => p.name === 'شيبس').price });

    // Same price on the same station, priced by the same engine.
    const ps1Local = (await local.floor()).stations.find((x: Json) => x.name === 'PS-01');
    const ps1Online = (await online.floor('owner')).stations.find((x: Json) => x.name === 'PS-01');
    expect(ps1Online).toBeTruthy();
    expect(s.rules.length).toBe(file.rules.length);
    expect(s.packages.length).toBe(file.packages.length);
    expect(ps1Local.modes).toEqual(ps1Online.modes);

    // A second import would duplicate everything: refused.
    expect((await online.api('POST', '/api/settings/import', file, owner)).json.code).toBe('import_not_empty');
  });

  it('refuses a file that is not a setup file', async () => {
    const r = await online.api('POST', '/api/settings/import', { hello: 'world' }, online.tokens.owner);
    expect(r.status).toBe(400);
  });
});
