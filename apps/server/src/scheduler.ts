import { liveState } from '@lounge/core';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from './context';
import { branches, sessions } from './db/schema';
import { SYSTEM_ID } from './lib/auth';
import { getBranch, loadSegments, toTimeline } from './services/common';
import { sweepCharged } from './services/controllers';
import { autoRollover } from './services/days';
import { sweepNoShows } from './services/reservations';
import { sessionAction } from './services/sessions';

/**
 * Background duties that must happen even when nobody is clicking:
 * - end-of-day at the cutoff (report generated, next day opened);
 * - reservations that never showed up become no-shows and free their station;
 * - fixed sessions auto-end at their planned time when the branch policy says so.
 * Runs on the shop's local server, so it works with no internet.
 */
export async function tick(ctx: AppContext, log: (msg: string, err?: unknown) => void = () => {}) {
  const all = await ctx.db.select({ id: branches.id, orgId: branches.orgId }).from(branches);
  for (const b of all) {
    try {
      if (await autoRollover(ctx, b.id)) log(`day rolled over for branch ${b.id}`);
      const n = await sweepNoShows(ctx, b.id);
      if (n) log(`${n} reservation(s) marked no-show`);
      await sweepCharged(ctx, b.id);
      await autoEndFixed(ctx, b.id, b.orgId);
    } catch (err) {
      log(`scheduler failed for branch ${b.id}`, err);
    }
  }
}

async function autoEndFixed(ctx: AppContext, branchId: string, orgId: string) {
  const branch = await getBranch(ctx.db, branchId);
  if (!branch.settings.billing.autoEndFixed) return;
  const now = ctx.clock.now();
  const running = await ctx.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.branchId, branchId), eq(sessions.status, 'running'), eq(sessions.kind, 'fixed')));
  const segs = await loadSegments(ctx.db, running.map((s) => s.id));
  for (const s of running) {
    const state = liveState(toTimeline(s, segs.get(s.id) ?? []), now, branch.settings.billing.endingSoonMinutes);
    if (state.status === 'overtime') {
      await sessionAction(ctx, { id: SYSTEM_ID, orgId, branchId, role: 'manager', name: 'system' }, s.id, { type: 'end' });
    }
  }
}

export function startScheduler(ctx: AppContext, log: (msg: string, err?: unknown) => void) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(ctx, log);
    } finally {
      running = false;
    }
  }, ctx.config.schedulerIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
