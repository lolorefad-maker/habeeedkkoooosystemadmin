import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import { Bus, type AppContext, type DomainEvent } from '../src/context';
import { openDatabase } from '../src/db';
import { DEMO_STAFF, seedIfEmpty } from '../src/seed';

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fresh in-memory lounge with demo data, a controllable clock and logged-in staff. */
export async function createHarness(startIso: string, overrides: Partial<Config> = {}) {
  let t = Date.parse(startIso);
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    dataDir: '',
    databaseUrl: null,
    jwtSecret: 'test-secret-test-secret-test-secret',
    mode: 'local',
    webDist: null,
    seedDemo: true,
    schedulerIntervalMs: 1_000_000,
    accessCode: null,
    owner: null,
    trustProxy: false,
    ...overrides,
  };
  const database = await openDatabase({ databaseUrl: null, dataDir: null });
  await seedIfEmpty(database.db, { demo: config.seedDemo, owner: config.owner });
  const published: DomainEvent[] = [];
  const ctx: AppContext = { db: database.db, clock: { now: () => t }, bus: new Bus(), config };
  ctx.bus.onEvent((e) => published.push(e));
  const app = await buildApp(ctx);
  await app.ready();

  /** Calls the API; the shop code is sent automatically unless `access` says otherwise. */
  async function api(
    method: string,
    url: string,
    body?: unknown,
    token?: string,
    access: string | null = config.accessCode,
  ): Promise<{ status: number; json: Json; headers: Record<string, unknown> }> {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: body as Record<string, unknown> | undefined,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(access ? { 'x-lounge-access': access } : {}) },
    });
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  }

  const branchId = (await api('GET', '/api/auth/branches')).json[0].id as string;
  const staff = (await api('GET', `/api/auth/staff?branchId=${branchId}`)).json as Json[];
  const tokens: Record<string, string> = {};
  const accounts = config.seedDemo ? DEMO_STAFF : config.owner ? [{ role: 'owner', pin: config.owner.pin }] : [];
  for (const s of accounts) {
    const u = staff.find((x) => x.role === s.role);
    tokens[s.role] = (await api('POST', '/api/auth/login', { userId: u.id, branchId, pin: s.pin })).json.token;
  }

  return {
    ctx,
    api,
    tokens,
    published,
    branchId,
    staff,
    pin: (role: string) => DEMO_STAFF.find((s) => s.role === role)!.pin,
    advance: (minutes: number) => {
      t += minutes * 60_000;
    },
    now: () => t,
    floor: async (role = 'cashier') => (await api('GET', '/api/floor', undefined, tokens[role])).json as Json,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}
