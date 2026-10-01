import { DomainError, isHolding } from '@lounge/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Q } from '../db';
import { reservations, sessions, stations } from '../db/schema';
import { notFound } from '../lib/errors';
import type { Branch } from './common';

export type StationRow = typeof stations.$inferSelect;

export async function getStation(q: Q, branchId: string, id: string): Promise<StationRow> {
  const [s] = await q.select().from(stations).where(and(eq(stations.id, id), eq(stations.branchId, branchId)));
  if (!s) throw notFound('station');
  return s;
}

export function assertUsable(st: StationRow, mode?: string) {
  if (!st.active) throw new DomainError('station_inactive', 'Station is not active');
  if (st.maintenance) throw new DomainError('station_maintenance', 'Station is under maintenance');
  if (mode && !st.modes.includes(mode)) throw new DomainError('invalid_mode', `Station does not offer mode "${mode}"`, { mode });
}

export async function assertFree(q: Q, stationId: string) {
  const [busy] = await q
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.stationId, stationId), eq(sessions.status, 'running')));
  if (busy) throw new DomainError('station_busy', 'Station already has a running session', { sessionId: busy.id });
}

/** A confirmed reservation currently holding this station (hold window → start + grace), if any. */
export async function holdingReservation(q: Q, branch: Branch, stationId: string, now: number) {
  const rows = await q
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.branchId, branch.id),
        eq(reservations.stationId, stationId),
        inArray(reservations.status, ['confirmed']),
      ),
    );
  return (
    rows.find((r) =>
      isHolding(
        { startAt: r.startAt.getTime(), minutes: r.minutes, deposit: r.deposit, status: r.status },
        now,
        branch.settings.reservations,
      ),
    ) ?? null
  );
}
