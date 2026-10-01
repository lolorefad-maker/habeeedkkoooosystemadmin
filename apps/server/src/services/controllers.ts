import { DomainError, MINUTE, isCharged } from '@lounge/core';
import { and, asc, eq, inArray, lte, max } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext, type Record_ } from '../context';
import type { Q } from '../db';
import { controllers } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { getBranch, type Branch } from './common';
import { getStation } from './stations';

export const addControllersInput = z.object({ count: z.number().int().min(1).max(50) });
export const chargeInput = z.object({ minutes: z.number().int().min(5).max(24 * 60).optional() });
export const assignInput = z.object({ stationId: z.uuid().nullable() });
export const brokenInput = z.object({ broken: z.boolean(), note: z.string().trim().max(200).nullish() });

type ControllerRow = typeof controllers.$inferSelect;

export async function listControllers(q: Q, branchId: string) {
  return q
    .select()
    .from(controllers)
    .where(and(eq(controllers.branchId, branchId), eq(controllers.active, true)))
    .orderBy(asc(controllers.number));
}

async function getController(q: Q, branchId: string, id: string): Promise<ControllerRow> {
  const [c] = await q.select().from(controllers).where(and(eq(controllers.id, id), eq(controllers.branchId, branchId)));
  if (!c) throw notFound('controller');
  return c;
}

const like = (c: ControllerRow) => ({ status: c.status, stationId: c.stationId, readyAt: c.readyAt?.getTime() ?? null });

/** Add N controllers numbered after the highest existing number. */
export async function addControllers(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = addControllersInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const [{ top } = { top: 0 }] = await tx
      .select({ top: max(controllers.number) })
      .from(controllers)
      .where(eq(controllers.branchId, actor.branchId));
    const first = (top ?? 0) + 1;
    const rows = Array.from({ length: input.count }, (_, i) => ({ id: newId(), branchId: actor.branchId, number: first + i }));
    await tx.insert(controllers).values(rows);
    await record({ type: 'controller.added', entity: 'controller', payload: { from: first, to: first + input.count - 1 } });
    return { from: first, to: first + input.count - 1 };
  });
}

/**
 * Delete a controller for good (lost, broken beyond repair). Nothing about money points at a
 * controller, so the row goes; its number is free to be added again. Not while a customer has it.
 */
export async function deleteController(ctx: AppContext, actor: Actor, id: string) {
  return mutate(ctx, actor, async (tx, record) => {
    const c = await getController(tx, actor.branchId, id);
    if (c.stationId) throw new DomainError('controller_in_use', `Controller ${c.number} is with a station — put it back on the shelf first`, { number: c.number });
    await tx.delete(controllers).where(eq(controllers.id, id));
    await record({ type: 'controller.deleted', entity: 'controller', entityId: id, payload: { number: c.number } });
    return { id, number: c.number };
  });
}

/** "The battery died": off the station, onto the charger, ready again after the branch's charge time. */
export async function chargeController(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = chargeInput.parse(raw ?? {});
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const c = await getController(tx, branch.id, id);
    if (c.status === 'broken') throw new DomainError('controller_broken', 'Controller is marked broken');
    const minutes = input.minutes ?? branch.settings.controllers.chargeMinutes;
    const readyAt = now + minutes * MINUTE;
    await tx
      .update(controllers)
      .set({ status: 'charging', stationId: null, chargingSince: new Date(now), readyAt: new Date(readyAt), updatedAt: new Date(now) })
      .where(eq(controllers.id, id));
    await record({
      type: 'controller.charging',
      entity: 'controller',
      entityId: id,
      payload: { number: c.number, fromStationId: c.stationId, readyAt, minutes },
    });
    return { id, readyAt };
  });
}

/** Charged earlier than planned. */
export async function readyController(ctx: AppContext, actor: Actor, id: string) {
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const c = await getController(tx, actor.branchId, id);
    if (c.status !== 'charging') throw new DomainError('controller_not_charging', 'Controller is not charging');
    await tx
      .update(controllers)
      .set({ status: 'ready', chargingSince: null, readyAt: null, updatedAt: new Date(now) })
      .where(eq(controllers.id, id));
    await record({ type: 'controller.charged', entity: 'controller', entityId: id, payload: { number: c.number, early: true } });
    return { id };
  });
}

/** Hand a controller to a station, or back to the shelf (stationId = null). */
export async function assignController(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = assignInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const c = await getController(tx, actor.branchId, id);
    if (c.status === 'broken') throw new DomainError('controller_broken', 'Controller is marked broken');
    if (c.status === 'charging' && !isCharged(like(c), now)) {
      throw new DomainError('controller_charging', 'Controller is still charging', { readyAt: c.readyAt?.getTime() ?? null });
    }
    if (input.stationId) await getStation(tx, actor.branchId, input.stationId);
    await tx
      .update(controllers)
      .set({ status: 'ready', stationId: input.stationId, chargingSince: null, readyAt: null, updatedAt: new Date(now) })
      .where(eq(controllers.id, id));
    await record({
      type: 'controller.assigned',
      entity: 'controller',
      entityId: id,
      payload: { number: c.number, stationId: input.stationId, fromStationId: c.stationId },
    });
    return { id };
  });
}

export async function setControllerBroken(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = brokenInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const c = await getController(tx, actor.branchId, id);
    await tx
      .update(controllers)
      .set({
        status: input.broken ? 'broken' : 'ready',
        stationId: input.broken ? null : c.stationId,
        chargingSince: null,
        readyAt: null,
        note: input.broken ? (input.note ?? null) : null,
        updatedAt: new Date(now),
      })
      .where(eq(controllers.id, id));
    await record({
      type: input.broken ? 'controller.broken' : 'controller.fixed',
      entity: 'controller',
      entityId: id,
      payload: { number: c.number },
      reason: input.note ?? null,
    });
    return { id };
  });
}

// ---------------------------------------------------------------- used by sessions

/** Controllers handed to the customer when a session starts: they go to that station. */
export async function handOverControllers(tx: Q, record: Record_, branchId: string, stationId: string, ids: string[], now: number, sessionId: string) {
  if (ids.length === 0) return;
  const rows = await tx
    .select()
    .from(controllers)
    .where(and(eq(controllers.branchId, branchId), inArray(controllers.id, ids)));
  if (rows.length !== new Set(ids).size) throw notFound('controller');
  for (const c of rows) {
    if (!c.active || c.status === 'broken') throw new DomainError('controller_broken', `Controller ${c.number} is broken`, { number: c.number });
    if (c.status === 'charging' && !isCharged(like(c), now)) {
      throw new DomainError('controller_charging', `Controller ${c.number} is still charging`, { number: c.number });
    }
  }
  await tx
    .update(controllers)
    .set({ status: 'ready', stationId, chargingSince: null, readyAt: null, updatedAt: new Date(now) })
    .where(inArray(controllers.id, ids));
  await record({
    type: 'controller.assigned',
    entity: 'session',
    entityId: sessionId,
    payload: { numbers: rows.map((c) => c.number), stationId },
  });
}

/** A session moved to another station: its controllers go with it. */
export async function moveStationControllers(tx: Q, from: string, to: string, now: number) {
  await tx.update(controllers).set({ stationId: to, updatedAt: new Date(now) }).where(eq(controllers.stationId, from));
}

/** Session ended: controllers come back to the shelf (if the branch works that way). */
export async function returnStationControllers(tx: Q, record: Record_, branch: Branch, stationId: string, now: number, sessionId: string) {
  if (!branch.settings.controllers.returnOnEnd) return;
  const back = await tx
    .update(controllers)
    .set({ stationId: null, updatedAt: new Date(now) })
    .where(and(eq(controllers.branchId, branch.id), eq(controllers.stationId, stationId)))
    .returning({ number: controllers.number });
  if (back.length) {
    await record({ type: 'controller.returned', entity: 'session', entityId: sessionId, payload: { numbers: back.map((c) => c.number) } });
  }
}

/** Scheduler: charging time is over → ready (every screen gets told). */
export async function sweepCharged(ctx: AppContext, branchId: string) {
  const now = ctx.clock.now();
  const due = await ctx.db
    .select()
    .from(controllers)
    .where(and(eq(controllers.branchId, branchId), eq(controllers.status, 'charging'), lte(controllers.readyAt, new Date(now))));
  for (const c of due) {
    await mutate(ctx, { id: null, branchId }, async (tx, record) => {
      const res = await tx
        .update(controllers)
        .set({ status: 'ready', chargingSince: null, readyAt: null, updatedAt: new Date(now) })
        .where(and(eq(controllers.id, c.id), eq(controllers.status, 'charging')))
        .returning({ id: controllers.id });
      if (res.length) await record({ type: 'controller.charged', entity: 'controller', entityId: c.id, payload: { number: c.number } });
    });
  }
  return due.length;
}
