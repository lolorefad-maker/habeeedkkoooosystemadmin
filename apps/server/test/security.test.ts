import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeConfig, loadConfig } from '../src/config';
import { createHarness } from './harness';

describe('online (cloud) install', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  const CODE = 'shop-7391';

  beforeAll(async () => {
    h = await createHarness('2026-09-25T15:00:00Z', {
      mode: 'cloud',
      accessCode: CODE,
      seedDemo: false,
      owner: { name: 'Omar', pin: '482915' },
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('starts empty with only the owner — no demo staff with known PINs', async () => {
    expect(h.staff).toEqual([expect.objectContaining({ name: 'Omar', role: 'owner' })]);
    expect(h.tokens.owner).toBeTruthy();
    const floor = (await h.api('GET', '/api/floor', undefined, h.tokens.owner)).json;
    expect(floor.stations).toHaveLength(0);
  });

  it('hides the login screen from devices without the shop code', async () => {
    const none = await h.api('GET', '/api/auth/branches', undefined, undefined, null);
    expect(none).toMatchObject({ status: 401, json: { code: 'access_code_required' } });
    const wrong = await h.api('GET', `/api/auth/staff?branchId=${h.branchId}`, undefined, undefined, 'guess-123');
    expect(wrong).toMatchObject({ status: 401, json: { code: 'access_code_invalid' } });
    const login = await h.api('POST', '/api/auth/login', { userId: h.staff[0].id, branchId: h.branchId, pin: '482915' }, undefined, null);
    expect(login.status).toBe(401);
  });

  it('requires 6+ digit PINs for owners and managers online', async () => {
    const weak = await h.api('POST', '/api/settings/staff', { name: 'Mgr', role: 'manager', pin: '1234' }, h.tokens.owner);
    expect(weak.json.code).toBe('weak_pin');
    const ok = await h.api('POST', '/api/settings/staff', { name: 'Mgr', role: 'manager', pin: '908172' }, h.tokens.owner);
    expect(ok.status).toBe(200);
    const cashier = await h.api('POST', '/api/settings/staff', { name: 'Cash', role: 'cashier', pin: '5501' }, h.tokens.owner);
    expect(cashier.status).toBe(200);
  });

  it('sends security headers', async () => {
    const res = await h.api('GET', '/api/health');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('slows down guessing on the login endpoints', async () => {
    let limited = false;
    for (let i = 0; i < 30 && !limited; i++) {
      const r = await h.api('GET', '/api/auth/branches', undefined, undefined, 'wrong-code');
      limited = r.status === 429;
    }
    expect(limited).toBe(true);
  });
});

describe('startup safety checks', () => {
  const base = { LOUNGE_MODE: 'cloud', LOUNGE_DATA_DIR: '.data-test-config', JWT_SECRET: 'x'.repeat(40) };

  it('refuses an unsafe online configuration and says what is missing', () => {
    const c = loadConfig({ ...base });
    expect(() => assertSafeConfig(c)).toThrow(/DATABASE_URL[\s\S]*LOUNGE_ACCESS_CODE/);
    expect(c.seedDemo).toBe(false);
    expect(c.trustProxy).toBe(true);
  });

  it('accepts a complete one', () => {
    const c = loadConfig({
      ...base,
      DATABASE_URL: 'postgres://u:p@db/lounge',
      LOUNGE_ACCESS_CODE: 'shop-7391',
      LOUNGE_OWNER_PIN: '482915',
    });
    expect(() => assertSafeConfig(c)).not.toThrow();
    expect(() => assertSafeConfig({ ...c, owner: { name: 'x', pin: '1234' } })).toThrow(/LOUNGE_OWNER_PIN/);
  });
});
