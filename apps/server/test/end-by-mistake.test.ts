import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Json } from './harness';

let h: Awaited<ReturnType<typeof createHarness>>;
let station: (name: string) => Json;

beforeAll(async () => {
  h = await createHarness('2026-09-25T15:00:00Z');
  await h.api('POST', '/api/shifts/open', { openingFloat: 0 }, h.tokens.cashier);
  const floor = await h.floor();
  station = (name) => floor.stations.find((s: Json) => s.name === name);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const cashier = () => h.tokens.cashier;
const start = (name: string) => h.api('POST', '/api/sessions', { stationId: station(name).id, mode: 'single', kind: 'open' }, cashier());
const end = (id: string) => h.api('POST', `/api/sessions/${id}/action`, { type: 'end' }, cashier());

describe('a session ended by mistake', () => {
  it('can be resumed, and the unpaid list is empty again', async () => {
    const s = await start('PS-01');
    h.advance(10);
    expect((await end(s.json.id)).status).toBe(200);
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)?.status).toBe('ended');
    expect((await h.api('POST', `/api/sessions/${s.json.id}/reopen`, {}, cashier())).status).toBe(200);
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)?.status).toBe('running');
  });

  it('can be deleted; the cashier needs the manager PIN, the manager does not', async () => {
    const s = await start('PS-02');
    h.advance(5);
    await end(s.json.id);
    const denied = await h.api('POST', `/api/sessions/${s.json.id}/void`, { reason: 'ended by mistake' }, cashier());
    expect(denied.json.code).toBe('approval_required');
    const done = await h.api('POST', `/api/sessions/${s.json.id}/void`, { reason: 'ended by mistake' }, h.tokens.manager);
    expect(done.status).toBe(200);
    expect(((await h.floor()).sessions as Json[]).find((x) => x.id === s.json.id)).toBeUndefined();
  });
});
