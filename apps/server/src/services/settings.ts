import {
  DomainError,
  MINUTE,
  branchSettingsSchema,
  businessDayRange,
  packageMatchSchema,
  parseBranchSettings,
  ruleEffectSchema,
  ruleMatchSchema,
} from '@lounge/core';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Q } from '../db';
import { branches, packages, payments, pricingRules, products, sessions, stations, stockMovements, users } from '../db/schema';
import { hashPin, type Actor } from '../lib/auth';
import { forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { currentDay, getBranch } from './common';

// ---------------------------------------------------------------- branch & policies

export const branchInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().min(3).max(60).optional(),
  currency: z.string().length(3).optional(),
  currencyDecimals: z.number().int().min(0).max(3).optional(),
  locale: z.string().min(2).max(10).optional(),
  settings: z.unknown().optional(),
});

export async function updateBranch(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = branchInput.parse(raw);
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone });
    } catch {
      throw new DomainError('invalid_timezone', 'Unknown time zone');
    }
  }
  return mutate(ctx, actor, async (tx, record) => {
    const [cur] = await tx.select().from(branches).where(eq(branches.id, actor.branchId));
    if (!cur) throw notFound('branch');
    // Money is stored in minor units: once money has moved, changing the number of decimals would
    // silently turn 2.000 into 20.00 in every bill and report. Only allowed before the first payment.
    if (input.currencyDecimals !== undefined && input.currencyDecimals !== cur.currencyDecimals) {
      const [paid] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.branchId, cur.id)).limit(1);
      if (paid) throw new DomainError('decimals_locked', 'Currency decimals cannot change after payments exist');
    }
    // Merge partial policy changes onto current settings, then validate the whole thing.
    const settings =
      input.settings !== undefined
        ? branchSettingsSchema.parse(deepMerge(parseBranchSettings(cur.settings), input.settings as Record<string, unknown>))
        : undefined;
    await tx
      .update(branches)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
        ...(input.currencyDecimals !== undefined ? { currencyDecimals: input.currencyDecimals } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(settings ? { settings } : {}),
        updatedAt: new Date(ctx.clock.now()),
      })
      .where(eq(branches.id, actor.branchId));
    await record({ type: 'settings.updated', entity: 'branch', entityId: actor.branchId, payload: { ...input } });
    return { id: actor.branchId };
  });
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    const b = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
        ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}

// ---------------------------------------------------------------- stations

export const stationInput = z.object({
  name: z.string().trim().min(1).max(40),
  type: z.string().trim().min(1).max(20),
  tier: z.string().trim().min(1).max(20),
  zone: z.string().trim().max(40).default(''),
  modes: z.array(z.string().trim().min(1).max(40)).min(1).max(6),
  sort: z.number().int().default(0),
  maintenance: z.boolean().default(false),
  maintenanceNote: z.string().trim().max(200).nullish(),
  active: z.boolean().default(true),
});

export async function listStations(q: Q, branchId: string) {
  return q.select().from(stations).where(eq(stations.branchId, branchId)).orderBy(asc(stations.sort), asc(stations.name));
}

export async function saveStation(ctx: AppContext, actor: Actor, id: string | null, raw: unknown) {
  const input = id ? stationInput.partial().parse(raw) : stationInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = new Date(ctx.clock.now());
    // Two stations called "PS-03" would make every alert, bill and report ambiguous.
    if (input.name) {
      const same = await tx
        .select({ id: stations.id })
        .from(stations)
        .where(and(eq(stations.branchId, actor.branchId), sql`lower(${stations.name}) = lower(${input.name})`));
      if (same.some((s) => s.id !== id)) throw new DomainError('name_taken', 'Another station already has this name');
    }
    if (id) {
      const [cur] = await tx.select().from(stations).where(and(eq(stations.id, id), eq(stations.branchId, actor.branchId)));
      if (!cur) throw notFound('station');
      if (input.active === false || input.maintenance === true) {
        const [busy] = await tx.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.stationId, id), eq(sessions.status, 'running')));
        if (busy) throw new DomainError('station_busy', 'End the running session first');
      }
      await tx.update(stations).set({ ...input, updatedAt: now }).where(eq(stations.id, id));
      await record({ type: 'station.updated', entity: 'station', entityId: id, payload: input });
      return { id };
    }
    const newStation = stationInput.parse(raw);
    const sid = newId();
    await tx.insert(stations).values({ ...newStation, id: sid, branchId: actor.branchId });
    await record({ type: 'station.created', entity: 'station', entityId: sid, payload: newStation });
    return { id: sid };
  });
}

// ---------------------------------------------------------------- pricing rules & packages

export const ruleInput = z.object({
  name: z.string().trim().min(1).max(80),
  priority: z.number().int().min(-1000).max(1000).default(0),
  active: z.boolean().default(true),
  match: ruleMatchSchema.prefault({}),
  effect: ruleEffectSchema,
});

type RuleRow = typeof pricingRules.$inferSelect;
type Window = { startsAt?: number | null; endsAt?: number | null };
const windowOf = (r: RuleRow) => r.match as Window;
const isCurrent = (r: RuleRow, now: number) => {
  const w = windowOf(r);
  return w.endsAt == null || w.endsAt > now;
};

/** Every rule version ever: billing needs the old ones to price time already played. */
export async function listRules(q: Q, branchId: string) {
  return q.select().from(pricingRules).where(eq(pricingRules.branchId, branchId)).orderBy(asc(pricingRules.createdAt));
}

/** What the owner edits in Settings → Pricing: manual rules that have not ended. */
export async function listCurrentRules(q: Q, branchId: string, now: number) {
  return (await listRules(q, branchId)).filter((r) => r.source === 'manual' && isCurrent(r, now));
}

/**
 * Prices change *from now*. Editing a rule closes its current version at this instant and starts
 * a new version at this instant, so a customer already playing pays the old price for the time
 * before the change and the new price after it — the bill shows both lines.
 */
export async function saveRule(ctx: AppContext, actor: Actor, id: string | null, raw: unknown) {
  const input = ruleInput.parse(raw);
  // The validity window is decided here, never by the client.
  const { startsAt: _s, endsAt: _e, ...match } = input.match;
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    if (id) {
      const [cur] = await tx.select().from(pricingRules).where(and(eq(pricingRules.id, id), eq(pricingRules.branchId, actor.branchId)));
      if (!cur) throw notFound('pricing rule');
      if (!isCurrent(cur, now)) throw new DomainError('rule_ended', 'This price has already been replaced');
      const w = windowOf(cur);

      if (w.startsAt != null && w.startsAt > now) {
        // Not in force yet: nothing has been billed with it, edit in place.
        await tx
          .update(pricingRules)
          .set({ ...input, match: { ...match, startsAt: w.startsAt, endsAt: null }, updatedAt: new Date(now) })
          .where(eq(pricingRules.id, id));
        await record({ type: 'pricing_rule.updated', entity: 'pricing_rule', entityId: id, payload: input });
        return { id };
      }

      await tx
        .update(pricingRules)
        .set({ match: { ...(cur.match as object), endsAt: now }, updatedAt: new Date(now) })
        .where(eq(pricingRules.id, id));
      // Switching a rule off = ending it now; no new version.
      let nextId: string | null = null;
      if (input.active) {
        nextId = newId();
        await tx.insert(pricingRules).values({ ...input, id: nextId, branchId: actor.branchId, source: 'manual', match: { ...match, startsAt: now } });
      }
      await record({ type: 'pricing_rule.updated', entity: 'pricing_rule', entityId: nextId ?? id, payload: { ...input, replaces: id } });
      return { id: nextId ?? id };
    }
    const rid = newId();
    await tx.insert(pricingRules).values({ ...input, id: rid, branchId: actor.branchId, source: 'manual', match: { ...match, startsAt: now } });
    await record({ type: 'pricing_rule.created', entity: 'pricing_rule', entityId: rid, payload: input });
    return { id: rid };
  });
}

// ---------------------------------------------------------------- one-tap discount ("خصم الآن")

export const quickDiscountInput = z.object({
  percent: z.number().int().min(1).max(100),
  /** Empty = every station. */
  stationTypes: z.array(z.string().min(1).max(20)).max(10).nullish(),
  tiers: z.array(z.string().min(1).max(20)).max(5).nullish(),
  until: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }),
    z.object({ kind: z.literal('day_end') }),
    z.object({ kind: z.literal('minutes'), minutes: z.number().int().min(15).max(24 * 60) }),
  ]),
});

async function endQuickDiscounts(tx: Q, branchId: string, now: number) {
  const rows = (await tx.select().from(pricingRules).where(and(eq(pricingRules.branchId, branchId), eq(pricingRules.source, 'quick')))).filter(
    (r) => isCurrent(r, now),
  );
  for (const r of rows) {
    await tx
      .update(pricingRules)
      .set({ match: { ...(r.match as object), endsAt: now }, updatedAt: new Date(now) })
      .where(eq(pricingRules.id, r.id));
  }
  return rows.length;
}

/**
 * The owner decides "20% off, from now": a top-priority percent rule valid from this instant
 * until they stop it (or the business day ends, or N minutes). Running sessions get the discount
 * for the time after it started; one quick discount at a time (a new one replaces the old).
 */
export async function startQuickDiscount(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = quickDiscountInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    await endQuickDiscounts(tx, branch.id, now);
    let endsAt: number | null = null;
    if (input.until.kind === 'minutes') endsAt = now + input.until.minutes * MINUTE;
    if (input.until.kind === 'day_end') {
      endsAt = businessDayRange(await currentDay(tx, branch, now), branch.timezone, branch.settings.day.cutoff).end;
    }
    const id = newId();
    await tx.insert(pricingRules).values({
      id,
      branchId: branch.id,
      source: 'quick',
      name: `خصم ${input.percent}%`,
      priority: 100,
      active: true,
      match: {
        stationTypes: input.stationTypes?.length ? input.stationTypes : null,
        tiers: input.tiers?.length ? input.tiers : null,
        startsAt: now,
        endsAt,
      },
      effect: { kind: 'percent', percent: -input.percent },
    });
    await record({ type: 'discount.started', entity: 'pricing_rule', entityId: id, payload: { ...input, endsAt } });
    return { id, endsAt };
  });
}

export async function stopQuickDiscount(ctx: AppContext, actor: Actor) {
  return mutate(ctx, actor, async (tx, record) => {
    const ended = await endQuickDiscounts(tx, actor.branchId, ctx.clock.now());
    if (ended) await record({ type: 'discount.stopped', entity: 'pricing_rule', payload: { ended } });
    return { ended };
  });
}

export const packageInput = z.object({
  name: z.string().trim().min(1).max(80),
  minutes: z.number().int().min(15).max(24 * 60),
  price: z.number().int().min(0),
  active: z.boolean().default(true),
  match: packageMatchSchema.prefault({}),
});

export async function listPackages(q: Q, branchId: string) {
  return q.select().from(packages).where(eq(packages.branchId, branchId)).orderBy(asc(packages.minutes));
}

export async function savePackage(ctx: AppContext, actor: Actor, id: string | null, raw: unknown) {
  const input = packageInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    if (id) {
      const res = await tx
        .update(packages)
        .set({ ...input, updatedAt: new Date(ctx.clock.now()) })
        .where(and(eq(packages.id, id), eq(packages.branchId, actor.branchId)))
        .returning({ id: packages.id });
      if (!res.length) throw notFound('package');
      await record({ type: 'package.updated', entity: 'package', entityId: id, payload: input });
      return { id };
    }
    const pid = newId();
    await tx.insert(packages).values({ ...input, id: pid, branchId: actor.branchId });
    await record({ type: 'package.created', entity: 'package', entityId: pid, payload: input });
    return { id: pid };
  });
}

// ---------------------------------------------------------------- products

export const productInput = z.object({
  name: z.string().trim().min(1).max(60),
  category: z.string().trim().min(1).max(40),
  price: z.number().int().min(0),
  trackStock: z.boolean().default(false),
  lowStockAt: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
  /**
   * Pieces on the shelf: the opening count of a new product, or a recount when editing. Never a
   * default (a partial update must not reset the stock); every change is a stock movement.
   */
  stockQty: z.number().int().min(0).max(1_000_000).optional(),
});

export async function listProducts(q: Q, branchId: string) {
  return q.select().from(products).where(eq(products.branchId, branchId)).orderBy(asc(products.category), asc(products.sort), asc(products.name));
}

export async function saveProduct(ctx: AppContext, actor: Actor, id: string | null, raw: unknown) {
  return mutate(ctx, actor, async (tx, record) => {
    const now = new Date(ctx.clock.now());
    // One name per product, so stock, deliveries and the "N left" notices are never ambiguous.
    const name = (raw as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim()) {
      const same = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.branchId, actor.branchId), sql`lower(${products.name}) = lower(${name.trim()})`));
      if (same.some((p) => p.id !== id)) throw new DomainError('name_taken', 'Another product already has this name');
    }
    const branch = await getBranch(tx, actor.branchId);
    const movement = async (productId: string, delta: number, reason: 'purchase' | 'adjust', unitPrice: number | null) =>
      tx.insert(stockMovements).values({
        id: newId(),
        branchId: branch.id,
        productId,
        delta,
        reason,
        unitPrice,
        businessDay: await currentDay(tx, branch, now.getTime()),
        createdBy: actor.id,
      });

    if (id) {
      const { stockQty, ...input } = productInput.partial().parse(raw);
      const [cur] = await tx.select().from(products).where(and(eq(products.id, id), eq(products.branchId, actor.branchId)));
      if (!cur) throw notFound('product');
      const recount = stockQty !== undefined && stockQty !== cur.stockQty;
      await tx
        .update(products)
        .set({ ...input, ...(recount ? { stockQty, trackStock: true } : {}), updatedAt: now })
        .where(eq(products.id, id));
      if (recount) await movement(id, stockQty - cur.stockQty, 'adjust', null);
      await record({ type: 'product.updated', entity: 'product', entityId: id, payload: { ...input, ...(recount ? { stockQty, from: cur.stockQty } : {}) } });
      return { id };
    }
    const { stockQty = 0, ...input } = productInput.parse(raw);
    const pid = newId();
    await tx.insert(products).values({ ...input, trackStock: input.trackStock || stockQty > 0, stockQty, id: pid, branchId: actor.branchId });
    if (stockQty > 0) await movement(pid, stockQty, 'purchase', input.price);
    await record({ type: 'product.created', entity: 'product', entityId: pid, payload: { ...input, stockQty } });
    return { id: pid };
  });
}

// ---------------------------------------------------------------- staff

const pin = z.string().regex(/^\d{4,8}$/, '4–8 digits');

export const staffInput = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.enum(['owner', 'manager', 'cashier', 'waiter']),
  pin: pin.optional(),
  active: z.boolean().default(true),
});

export async function listStaff(q: Q, actor: Actor) {
  return q
    .select({ id: users.id, name: users.name, role: users.role, active: users.active, branchId: users.branchId })
    .from(users)
    .where(and(eq(users.orgId, actor.orgId), or(isNull(users.branchId), eq(users.branchId, actor.branchId))))
    .orderBy(asc(users.name));
}

export async function saveStaff(ctx: AppContext, actor: Actor, id: string | null, raw: unknown) {
  const input = id ? staffInput.partial().parse(raw) : staffInput.extend({ pin }).parse(raw);
  // Only an owner can create or promote owners/managers.
  if (actor.role !== 'owner' && (input.role === 'owner' || input.role === 'manager')) throw forbidden();
  // Online, the accounts that can see all the money log in from anywhere: they need a longer PIN.
  const assertStrongPin = (role: string | undefined) => {
    if (ctx.config.mode === 'cloud' && input.pin && (role === 'owner' || role === 'manager') && input.pin.length < 6) {
      throw new DomainError('weak_pin', 'Owner and manager PINs must be at least 6 digits online');
    }
  };
  if (!id) assertStrongPin(input.role);
  return mutate(ctx, actor, async (tx, record) => {
    const now = new Date(ctx.clock.now());
    const pinHash = input.pin ? await hashPin(input.pin) : undefined;
    if (id) {
      const [cur] = await tx.select().from(users).where(and(eq(users.id, id), eq(users.orgId, actor.orgId)));
      if (!cur) throw notFound('staff member');
      if (actor.role !== 'owner' && (cur.role === 'owner' || cur.role === 'manager')) throw forbidden();
      assertStrongPin(input.role ?? cur.role);
      // Never lock the shop out of its settings: at least one active owner must remain.
      const losesOwner = cur.role === 'owner' && cur.active && ((input.role && input.role !== 'owner') || input.active === false);
      if (losesOwner) {
        const owners = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.orgId, actor.orgId), eq(users.role, 'owner'), eq(users.active, true)));
        if (owners.filter((o) => o.id !== id).length === 0) throw new DomainError('last_owner', 'The last active owner cannot be removed or demoted');
      }
      const { pin: _pin, ...rest } = input;
      await tx
        .update(users)
        .set({ ...rest, ...(pinHash ? { pinHash } : {}), updatedAt: now })
        .where(eq(users.id, id));
      await record({ type: 'staff.updated', entity: 'user', entityId: id, payload: { ...rest, pinChanged: !!pinHash } });
      return { id };
    }
    const uid = newId();
    await tx.insert(users).values({
      id: uid,
      orgId: actor.orgId,
      branchId: input.role === 'owner' ? null : actor.branchId,
      name: input.name!,
      role: input.role!,
      pinHash: pinHash!,
      active: input.active ?? true,
    });
    await record({ type: 'staff.created', entity: 'user', entityId: uid, payload: { name: input.name, role: input.role } });
    return { id: uid };
  });
}
