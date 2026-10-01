import { DomainError, branchSettingsSchema, packageMatchSchema, parseBranchSettings, ruleEffectSchema, ruleMatchSchema } from '@lounge/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Q } from '../db';
import { branches, controllers, packages, payments, pricingRules, products, sessions, stations } from '../db/schema';
import { forbidden } from '../lib/errors';
import type { Actor } from '../lib/auth';
import { newId } from '../lib/ids';
import { getBranch } from './common';
import { listCurrentRules } from './settings';

/**
 * "Move my setup to the online server": the shop's configuration as one file — stations, prices,
 * packages, products, controllers and policies. Never any money, sessions, stock counts or staff
 * (online, staff log in with new PINs). Stations are referenced by name so the file is portable.
 */
export const SETUP_FORMAT = 'lounge-setup';

const stationRow = z.object({
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

/** Station ids inside a rule/package match are written as station names in the file. */
const stationNames = z.array(z.string()).nullish();

export const setupFileSchema = z.object({
  format: z.literal(SETUP_FORMAT),
  version: z.literal(1),
  exportedAt: z.number().int(),
  branch: z.object({
    name: z.string().trim().min(1).max(80),
    timezone: z.string().min(3).max(60),
    currency: z.string().length(3),
    currencyDecimals: z.number().int().min(0).max(3),
    locale: z.string().min(2).max(10),
    settings: z.unknown(),
  }),
  stations: z.array(stationRow).max(500),
  rules: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        priority: z.number().int().min(-1000).max(1000),
        active: z.boolean(),
        effect: ruleEffectSchema,
        match: ruleMatchSchema.omit({ stationIds: true, startsAt: true, endsAt: true }),
        stationNames,
      }),
    )
    .max(500),
  packages: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        minutes: z.number().int().min(1),
        price: z.number().int().min(0),
        active: z.boolean(),
        match: packageMatchSchema,
        stationNames,
      }),
    )
    .max(200),
  products: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        category: z.string().trim().min(1).max(40),
        price: z.number().int().min(0),
        trackStock: z.boolean(),
        lowStockAt: z.number().int().min(0),
        packSize: z.number().int().min(1).nullish(),
        active: z.boolean(),
        sort: z.number().int(),
      }),
    )
    .max(1000),
  controllers: z.array(z.object({ number: z.number().int().min(1).max(9999), note: z.string().max(200).nullish(), active: z.boolean() })).max(500),
});
export type SetupFile = z.infer<typeof setupFileSchema>;

export async function exportSetup(q: Q, actor: Actor, now: number): Promise<SetupFile> {
  const branch = await getBranch(q, actor.branchId);
  const [st, rules, pkgs, prods, ctrls] = await Promise.all([
    q.select().from(stations).where(and(eq(stations.branchId, branch.id), isNull(stations.archivedAt))),
    listCurrentRules(q, branch.id, now),
    q.select().from(packages).where(eq(packages.branchId, branch.id)),
    q.select().from(products).where(and(eq(products.branchId, branch.id), isNull(products.archivedAt))),
    q.select().from(controllers).where(eq(controllers.branchId, branch.id)),
  ]);
  const nameOf = new Map(st.map((s) => [s.id, s.name]));
  const split = (match: Record<string, unknown>) => {
    const { stationIds, startsAt: _s, endsAt: _e, ...rest } = match as { stationIds?: string[] | null } & Record<string, unknown>;
    return { match: rest, stationNames: stationIds?.length ? stationIds.map((id) => nameOf.get(id)).filter((n): n is string => !!n) : null };
  };
  return {
    format: SETUP_FORMAT,
    version: 1,
    exportedAt: now,
    branch: {
      name: branch.name,
      timezone: branch.timezone,
      currency: branch.currency,
      currencyDecimals: branch.currencyDecimals,
      locale: branch.locale,
      settings: branch.settings,
    },
    stations: st
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
      .map((s) => ({ name: s.name, type: s.type, tier: s.tier, zone: s.zone, modes: s.modes, sort: s.sort, maintenance: s.maintenance, maintenanceNote: s.maintenanceNote, active: s.active })),
    rules: rules.map((r) => ({ name: r.name, priority: r.priority, active: r.active, effect: r.effect as SetupFile['rules'][number]['effect'], ...split(r.match) })) as SetupFile['rules'],
    packages: pkgs.map((p) => ({ name: p.name, minutes: p.minutes, price: p.price, active: p.active, ...split(p.match) })) as SetupFile['packages'],
    products: prods.map((p) => ({ name: p.name, category: p.category, price: p.price, trackStock: p.trackStock, lowStockAt: p.lowStockAt, packSize: p.packSize, active: p.active, sort: p.sort })),
    controllers: ctrls.sort((a, b) => a.number - b.number).map((c) => ({ number: c.number, note: c.note, active: c.active })),
  };
}

/**
 * Load a setup file into a fresh install (online first start). Refused once the shop has any
 * stations, products or money, so it can never duplicate or overwrite a running shop.
 */
export async function importSetup(ctx: AppContext, actor: Actor, raw: unknown) {
  if (actor.role !== 'owner') throw forbidden();
  const file = setupFileSchema.parse(raw);
  const settings = branchSettingsSchema.parse(parseBranchSettings(file.branch.settings));
  try {
    new Intl.DateTimeFormat('en', { timeZone: file.branch.timezone });
  } catch {
    throw new DomainError('invalid_timezone', 'Unknown time zone');
  }

  return mutate(ctx, actor, async (tx, record) => {
    const now = new Date(ctx.clock.now());
    const branchId = actor.branchId;
    const [hasStation] = await tx
      .select({ id: stations.id })
      .from(stations)
      .where(and(eq(stations.branchId, branchId), isNull(stations.archivedAt)))
      .limit(1);
    const [hasProduct] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.branchId, branchId), isNull(products.archivedAt)))
      .limit(1);
    const [hasSession] = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.branchId, branchId)).limit(1);
    const [hasPayment] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.branchId, branchId)).limit(1);
    if (hasStation || hasProduct || hasSession || hasPayment) {
      throw new DomainError('import_not_empty', 'Setup can only be imported into an empty shop');
    }

    await tx
      .update(branches)
      .set({
        name: file.branch.name,
        timezone: file.branch.timezone,
        currency: file.branch.currency.toUpperCase(),
        currencyDecimals: file.branch.currencyDecimals,
        locale: file.branch.locale,
        settings,
        updatedAt: now,
      })
      .where(eq(branches.id, branchId));

    const idOf = new Map<string, string>();
    if (file.stations.length) {
      const rows = file.stations.map((s) => {
        const id = newId();
        idOf.set(s.name.toLowerCase(), id);
        return { ...s, maintenanceNote: s.maintenanceNote ?? null, id, branchId };
      });
      if (new Set(rows.map((r) => r.name.toLowerCase())).size !== rows.length) throw new DomainError('name_taken', 'Two stations in the file have the same name');
      await tx.insert(stations).values(rows);
    }
    const ids = (names: string[] | null | undefined) => {
      if (!names?.length) return null;
      const out = names.map((n) => idOf.get(n.toLowerCase())).filter((x): x is string => !!x);
      return out.length ? out : null;
    };

    if (file.rules.length) {
      await tx.insert(pricingRules).values(
        file.rules.map((r) => ({
          id: newId(),
          branchId,
          source: 'manual' as const,
          name: r.name,
          priority: r.priority,
          active: r.active,
          // Prices are valid from the moment of the import.
          match: { ...r.match, stationIds: ids(r.stationNames), startsAt: now.getTime(), endsAt: null },
          effect: r.effect,
        })),
      );
    }
    if (file.packages.length) {
      await tx.insert(packages).values(
        file.packages.map((p) => ({ id: newId(), branchId, name: p.name, minutes: p.minutes, price: p.price, active: p.active, match: { ...p.match, stationIds: ids(p.stationNames) } })),
      );
    }
    if (file.products.length) {
      if (new Set(file.products.map((p) => p.name.toLowerCase())).size !== file.products.length) throw new DomainError('name_taken', 'Two products in the file have the same name');
      // Stock starts at zero online: the first delivery (or a count) puts the real numbers in.
      await tx.insert(products).values(file.products.map((p) => ({ ...p, packSize: p.packSize ?? null, stockQty: 0, id: newId(), branchId })));
    }
    if (file.controllers.length) {
      const numbers = file.controllers.map((c) => c.number);
      const existing = await tx.select({ n: controllers.number }).from(controllers).where(and(eq(controllers.branchId, branchId), inArray(controllers.number, numbers)));
      const taken = new Set(existing.map((e) => e.n));
      const fresh = file.controllers.filter((c) => !taken.has(c.number));
      if (fresh.length) {
        await tx.insert(controllers).values(fresh.map((c) => ({ id: newId(), branchId, number: c.number, note: c.note ?? null, active: c.active, status: 'ready' as const })));
      }
    }

    const counts = { stations: file.stations.length, rules: file.rules.length, packages: file.packages.length, products: file.products.length, controllers: file.controllers.length };
    await record({ type: 'setup.imported', entity: 'branch', entityId: branchId, payload: counts });
    return counts;
  });
}
