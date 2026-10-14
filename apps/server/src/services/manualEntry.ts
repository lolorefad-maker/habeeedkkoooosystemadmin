import { businessDayOf, businessDayRange } from '@lounge/core';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Tx } from '../db';
import {
  bills,
  branches,
  businessDays,
  cashWithdrawals,
  dayCarries,
  events,
  payments,
  rewards,
  shifts,
  stations,
  stockMovements,
} from '../db/schema';
import type { Actor } from '../lib/auth';
import { newId } from '../lib/ids';
import { currentDay, getBranch, openShift, type Branch } from './common';
import { buildDayReport } from './days';

export const manualEntryInput = z.object({
  /** Business day this entry belongs to, YYYY-MM-DD. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Station name as shown on the ledger (e.g. "جهاز 1", "VIP 1"). */
  stationName: z.string().trim().min(1).max(80),
  /** Duration in minutes that was played. */
  durationMinutes: z.number().int().min(1).max(24 * 60),
  /** Total amount in minor currency units (e.g. JOD: 8350 = 8.350 JD). */
  total: z.number().int().min(1),
  /** Payment method. */
  method: z.enum(['cash', 'card']).default('cash'),
  /** Optional note shown on the ledger row. */
  note: z.string().trim().max(200).nullish(),
});

async function matchStationId(tx: Tx, branchId: string, stationName: string): Promise<string | null> {
  const rows = await tx.select({ id: stations.id, name: stations.name }).from(stations).where(eq(stations.branchId, branchId));
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const target = norm(stationName);
  for (const r of rows) {
    if (norm(r.name) === target) return r.id;
  }
  const numMatch = stationName.match(/(\d+)/);
  if (numMatch) {
    const num = Number(numMatch[1]);
    const isVip = /vip|في\s*اي\s*بي/i.test(stationName);
    for (const r of rows) {
      const rVip = /vip/i.test(r.name);
      const rNum = r.name.match(/(\d+)/);
      if (rNum && Number(rNum[1]) === num && rVip === isVip) return r.id;
    }
  }
  return null;
}

async function insertManualBill(
  tx: Tx,
  branch: Branch,
  now: number,
  actorId: string | null,
  entry: {
    day: string;
    stationName: string;
    durationMinutes: number;
    total: number;
    method: 'cash' | 'card';
    note?: string | null;
    paperSeedKey?: string;
  },
) {
  const openDay = await currentDay(tx, branch, now);
  let [dayRow] = await tx.select().from(businessDays).where(and(eq(businessDays.branchId, branch.id), eq(businessDays.day, entry.day)));

  if (!dayRow) {
    const range = businessDayRange(entry.day, branch.timezone, branch.settings.day.cutoff);
    const isPast = entry.day < openDay;
    const id = newId();
    await tx.insert(businessDays).values({
      id,
      branchId: branch.id,
      day: entry.day,
      status: isPast ? 'closed' : 'open',
      openedAt: new Date(range.start),
      closedAt: isPast ? new Date(range.end) : null,
      auto: isPast,
      archived: false,
    });
    [dayRow] = await tx.select().from(businessDays).where(eq(businessDays.id, id));
  } else if (dayRow.archived) {
    await tx.update(businessDays).set({ archived: false }).where(eq(businessDays.id, dayRow.id));
  }

  const shift = entry.day === openDay ? await openShift(tx, branch.id) : null;
  const stationId = await matchStationId(tx, branch.id, entry.stationName);

  const [seq] = await tx
    .update(branches)
    .set({ billSeq: sql`${branches.billSeq} + 1` })
    .where(eq(branches.id, branch.id))
    .returning({ number: branches.billSeq });

  const playedMs = entry.durationMinutes * 60 * 1000;
  const billId = newId();

  await tx.insert(bills).values({
    id: billId,
    branchId: branch.id,
    number: seq!.number,
    businessDay: entry.day,
    sessionId: null,
    shiftId: shift?.id ?? null,
    timeCharge: entry.total,
    itemsTotal: 0,
    discountAmount: 0,
    discountReason: null,
    rounding: 0,
    total: entry.total,
    paid: entry.total,
    status: 'paid',
    breakdown: {
      stationName: entry.stationName,
      label: entry.note ?? null,
      startedAt: null,
      endedAt: null,
      time: {
        playedMs,
        billableMs: playedMs,
        total: entry.total,
        lines: stationId
          ? [
              {
                stationId,
                mode: 'single',
                ms: playedMs,
                ratePerHour: Math.round((entry.total * 60) / entry.durationMinutes),
                amount: entry.total,
              },
            ]
          : [],
      },
      items: [],
      manual: true,
      ...(entry.paperSeedKey ? { paperSeedKey: entry.paperSeedKey } : {}),
    },
    createdBy: actorId,
    approvedBy: null,
  });

  await tx.insert(payments).values({
    id: newId(),
    branchId: branch.id,
    businessDay: entry.day,
    shiftId: shift?.id ?? null,
    billId,
    sessionId: null,
    reservationId: null,
    method: entry.method,
    kind: 'payment',
    amount: entry.total,
    note: entry.note ?? null,
    createdBy: actorId,
    approvedBy: null,
  });

  const [updatedDayRow] = await tx.select().from(businessDays).where(and(eq(businessDays.branchId, branch.id), eq(businessDays.day, entry.day)));
  if (updatedDayRow?.status === 'closed') {
    const report = await buildDayReport(tx, branch, entry.day, now);
    await tx.update(businessDays).set({ report: report as unknown as Record<string, unknown> }).where(eq(businessDays.id, updatedDayRow.id));
  }

  return { billId, number: seq!.number };
}

/**
 * Insert a manual session directly into the ledger for a specific business day.
 */
export async function addManualEntry(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = manualEntryInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const res = await insertManualBill(tx, branch, now, actor.id, input);
    await record({
      type: 'bill.manual_added',
      entity: 'bill',
      entityId: res.billId,
      payload: {
        day: input.day,
        stationName: input.stationName,
        durationMinutes: input.durationMinutes,
        total: input.total,
        method: input.method,
      },
    });
    return res;
  });
}

const DAY_11_PAPER_ENTRIES = [
  { key: 'day11-ps1-4h20m-8350', stationName: 'جهاز 1', durationMinutes: 4 * 60 + 20, total: 8350 },
  { key: 'day11-ps2-1h00m-1500', stationName: 'جهاز 2', durationMinutes: 1 * 60, total: 1500 },
  { key: 'day11-ps5-1h20m-2500', stationName: 'جهاز 5', durationMinutes: 1 * 60 + 20, total: 2500 },
  { key: 'day11-vip1-5h10m-10250', stationName: 'VIP 1', durationMinutes: 5 * 60 + 10, total: 10250 },
] as const;

/**
 * Ensures the 4 paper sessions for the 11th of the month are present in the ledger.
 */
export async function ensureDay11PaperSessions(ctx: AppContext) {
  const allBranches = await ctx.db.select({ id: branches.id }).from(branches);
  const now = ctx.clock.now();

  for (const b of allBranches) {
    await ctx.db.transaction(async (tx) => {
      const branch = await getBranch(tx, b.id);
      const todayIso = businessDayOf(now, branch.timezone, branch.settings.day.cutoff);
      const yearMonth = todayIso.slice(0, 7);
      const targetDay = `${yearMonth}-11`;

      const existingBills = await tx
        .select({ breakdown: bills.breakdown, status: bills.status })
        .from(bills)
        .where(and(eq(bills.branchId, branch.id), eq(bills.businessDay, targetDay)));

      const existingKeys = new Set(
        existingBills
          .map((row) => (row.breakdown as { paperSeedKey?: string } | null)?.paperSeedKey)
          .filter((k): k is string => !!k),
      );

      for (const item of DAY_11_PAPER_ENTRIES) {
        if (existingKeys.has(item.key)) continue;
        await insertManualBill(tx, branch, now, null, {
          day: targetDay,
          stationName: item.stationName,
          durationMinutes: item.durationMinutes,
          total: item.total,
          method: 'cash',
          paperSeedKey: item.key,
        });
      }
    });
  }
}

/**
 * Shifts ledger dates back by 1 day starting from 2026-10-13 up to today:
 * 2026-10-13 -> 2026-10-12
 * 2026-10-14 -> 2026-10-13
 * and so on.
 * Runs once safely (idempotent).
 */
export async function shiftLedgerDatesFromOct13(ctx: AppContext) {
  const allBranches = await ctx.db.select({ id: branches.id }).from(branches);
  const now = ctx.clock.now();

  for (const b of allBranches) {
    const [alreadyDone] = await ctx.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.branchId, b.id), eq(events.type, 'system.ledger_shifted_oct13_v1')));

    if (alreadyDone) continue;

    await ctx.db.transaction(async (tx) => {
      const branch = await getBranch(tx, b.id);

      // Collect all distinct days >= 2026-10-13 across all tables
      const [allBills, allPayments, allShifts, allDays] = await Promise.all([
        tx.select({ day: bills.businessDay }).from(bills).where(and(eq(bills.branchId, b.id), gte(bills.businessDay, '2026-10-13'))),
        tx.select({ day: payments.businessDay }).from(payments).where(and(eq(payments.branchId, b.id), gte(payments.businessDay, '2026-10-13'))),
        tx.select({ day: shifts.businessDay }).from(shifts).where(and(eq(shifts.branchId, b.id), gte(shifts.businessDay, '2026-10-13'))),
        tx.select({ day: businessDays.day }).from(businessDays).where(and(eq(businessDays.branchId, b.id), gte(businessDays.day, '2026-10-13'))),
      ]);

      const daysSet = new Set<string>();
      for (const r of allBills) if (r.day) daysSet.add(r.day);
      for (const r of allPayments) if (r.day) daysSet.add(r.day);
      for (const r of allShifts) if (r.day) daysSet.add(r.day);
      for (const r of allDays) if (r.day) daysSet.add(r.day);

      // Process in strictly ascending order: 2026-10-13 first, then 2026-10-14, etc.
      const sortedDays = [...daysSet].sort();
      const touchedTargetDays = new Set<string>();

      for (const oldDay of sortedDays) {
        const prevDay = DateTime.fromISO(oldDay).minus({ days: 1 }).toISODate()!;
        touchedTargetDays.add(prevDay);

        await tx.update(bills).set({ businessDay: prevDay }).where(and(eq(bills.branchId, b.id), eq(bills.businessDay, oldDay)));
        await tx.update(payments).set({ businessDay: prevDay }).where(and(eq(payments.branchId, b.id), eq(payments.businessDay, oldDay)));
        await tx.update(shifts).set({ businessDay: prevDay }).where(and(eq(shifts.branchId, b.id), eq(shifts.businessDay, oldDay)));
        await tx.update(cashWithdrawals).set({ businessDay: prevDay }).where(and(eq(cashWithdrawals.branchId, b.id), eq(cashWithdrawals.businessDay, oldDay)));
        await tx.update(stockMovements).set({ businessDay: prevDay }).where(and(eq(stockMovements.branchId, b.id), eq(stockMovements.businessDay, oldDay)));
        await tx.update(dayCarries).set({ businessDay: prevDay }).where(and(eq(dayCarries.branchId, b.id), eq(dayCarries.businessDay, oldDay)));
        await tx.update(rewards).set({ earnedDay: prevDay }).where(and(eq(rewards.branchId, b.id), eq(rewards.earnedDay, oldDay)));
      }

      // Ensure business_days rows exist for all touched target days
      for (const targetDay of touchedTargetDays) {
        const [existing] = await tx.select().from(businessDays).where(and(eq(businessDays.branchId, b.id), eq(businessDays.day, targetDay)));
        if (!existing) {
          const range = businessDayRange(targetDay, branch.timezone, branch.settings.day.cutoff);
          await tx.insert(businessDays).values({
            id: newId(),
            branchId: b.id,
            day: targetDay,
            status: 'closed',
            openedAt: new Date(range.start),
            closedAt: new Date(range.end),
            auto: true,
            archived: false,
          });
        }
      }

      // Adjust the open business day if it was shifted
      const [currentOpen] = await tx.select().from(businessDays).where(and(eq(businessDays.branchId, b.id), eq(businessDays.status, 'open')));
      if (currentOpen && currentOpen.day >= '2026-10-13') {
        const shiftedOpenDay = DateTime.fromISO(currentOpen.day).minus({ days: 1 }).toISODate()!;
        await tx.update(businessDays).set({ status: 'open' }).where(and(eq(businessDays.branchId, b.id), eq(businessDays.day, shiftedOpenDay)));
        // Close or remove the obsolete future day
        await tx.delete(businessDays).where(and(eq(businessDays.branchId, b.id), eq(businessDays.day, currentOpen.day)));
      }

      // Rebuild day reports for all touched days that are closed
      for (const targetDay of touchedTargetDays) {
        const [d] = await tx.select().from(businessDays).where(and(eq(businessDays.branchId, b.id), eq(businessDays.day, targetDay)));
        if (d && d.status === 'closed') {
          try {
            const report = await buildDayReport(tx, branch, targetDay, now);
            await tx.update(businessDays).set({ report: report as unknown as Record<string, unknown> }).where(eq(businessDays.id, d.id));
          } catch {
            /* ignore report rebuild errors */
          }
        }
      }

      // Mark migration as done
      await tx.insert(events).values({
        id: newId(),
        branchId: b.id,
        type: 'system.ledger_shifted_oct13_v1',
        entity: 'system',
        payload: {
          daysShifted: sortedDays,
          shiftedAt: new Date(now).toISOString(),
        },
        createdAt: new Date(now),
      });
    });
  }
}
