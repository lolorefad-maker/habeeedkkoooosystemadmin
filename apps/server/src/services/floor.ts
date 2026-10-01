import { MINUTE } from '@lounge/core';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Q } from '../db';
import { orderItems, orders, payments, reservations, sessions } from '../db/schema';
import { carriedSoFar } from './carries';
import { currentDay, getBranch, loadSegments } from './common';
import { listControllers } from './controllers';
import { currentShift, uncountedShifts } from './shifts';
import { listArchivedStations, listPackages, listRules, listStations } from './settings';

/**
 * Everything a floor screen needs in one round trip. Clients compute live timers and
 * running costs locally with @lounge/core from these timestamps, so a tablet can refresh
 * or reconnect without losing a second — the server's data is the truth.
 */
export async function floorSnapshot(q: Q, branchId: string, now: number) {
  const branch = await getBranch(q, branchId);
  const [day, stationRows, archivedStations, rules, pkgs, shift, uncounted, controllerRows] = await Promise.all([
    currentDay(q, branch, now),
    listStations(q, branchId),
    listArchivedStations(q, branchId),
    listRules(q, branchId),
    listPackages(q, branchId),
    currentShift(q, branchId),
    uncountedShifts(q, branchId),
    listControllers(q, branchId),
  ]);

  const live = await q
    .select()
    .from(sessions)
    .where(and(eq(sessions.branchId, branchId), inArray(sessions.status, ['running', 'ended'])));
  const ids = live.map((s) => s.id);
  const segs = await loadSegments(q, ids);
  const carried = await carriedSoFar(q, ids);

  const items = ids.length
    ? await q
        .select({ sessionId: orders.sessionId, qty: orderItems.qty, unitPrice: orderItems.unitPrice, voided: orderItems.voided })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(and(inArray(orders.sessionId, ids), eq(orders.status, 'open')))
    : [];

  const resIds = live.map((s) => s.reservationId).filter((x): x is string => !!x);
  const paidRows = ids.length
    ? await q
        .select({ sessionId: payments.sessionId, method: payments.method, amount: payments.amount, billId: payments.billId })
        .from(payments)
        .where(and(eq(payments.branchId, branchId), inArray(payments.sessionId, ids)))
    : [];
  const depositRows = resIds.length
    ? await q
        .select({ reservationId: payments.reservationId, method: payments.method, amount: payments.amount, billId: payments.billId })
        .from(payments)
        .where(and(inArray(payments.reservationId, resIds), eq(payments.kind, 'deposit')))
    : [];

  const upcoming = await q
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.branchId, branchId),
        inArray(reservations.status, ['confirmed']),
        gte(reservations.startAt, new Date(now - 6 * 60 * MINUTE)),
        lt(reservations.startAt, new Date(now + 24 * 60 * MINUTE)),
      ),
    );

  return {
    now,
    day,
    branch: {
      id: branch.id,
      name: branch.name,
      timezone: branch.timezone,
      currency: branch.currency,
      currencyDecimals: branch.currencyDecimals,
      locale: branch.locale,
      settings: branch.settings,
    },
    shift,
    /** Drawers the day's end closed by itself and nobody counted yet. */
    uncountedShifts: uncounted,
    stations: stationRows,
    /** Deleted stations (id + name), so past sessions in the ledger still name their station. */
    archivedStations,
    rules,
    packages: pkgs,
    reservations: upcoming.map((r) => ({ ...r, startAt: r.startAt.getTime() })),
    controllers: controllerRows.map((c) => ({
      id: c.id,
      number: c.number,
      stationId: c.stationId,
      status: c.status,
      chargingSince: c.chargingSince?.getTime() ?? null,
      readyAt: c.readyAt?.getTime() ?? null,
      note: c.note,
    })),
    sessions: live.map((s) => {
      const its = items.filter((i) => i.sessionId === s.id && !i.voided);
      const paidByMethod: Record<string, number> = {};
      for (const p of [
        ...paidRows.filter((p) => p.sessionId === s.id && !p.billId),
        ...depositRows.filter((p) => p.reservationId === s.reservationId && !p.billId),
      ]) {
        paidByMethod[p.method] = (paidByMethod[p.method] ?? 0) + p.amount;
      }
      const paid = Object.values(paidByMethod).reduce((a, b) => a + b, 0);
      return {
        id: s.id,
        kind: s.kind,
        status: s.status,
        stationId: s.stationId,
        plannedMinutes: s.plannedMinutes,
        packageId: s.packageId,
        label: s.label,
        reservationId: s.reservationId,
        startedAt: s.startedAt.getTime(),
        endedAt: s.endedAt?.getTime() ?? null,
        itemsCount: its.reduce((a, i) => a + i.qty, 0),
        itemsTotal: its.reduce((a, i) => a + i.qty * i.unitPrice, 0),
        paid,
        paidByMethod,
        /** Already counted in an earlier day's income (it ran past that day's end) — for the ledger only. */
        carried: { time: carried.get(s.id)?.time ?? 0, items: carried.get(s.id)?.items ?? 0 },
        segments: (segs.get(s.id) ?? []).map((g) => ({
          stationId: g.stationId,
          mode: g.mode,
          paused: g.paused,
          startedAt: g.startedAt.getTime(),
          endedAt: g.endedAt?.getTime() ?? null,
        })),
      };
    }),
  };
}

export type FloorSnapshot = Awaited<ReturnType<typeof floorSnapshot>>;
