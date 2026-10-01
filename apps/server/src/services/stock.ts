import { DomainError } from '@lounge/core';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext } from '../context';
import type { Q } from '../db';
import { products, stockMovements, users } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { currentDay, getBranch } from './common';

const receiveLine = z
  .object({
    /** An existing product… */
    productId: z.uuid().nullish(),
    /** …or a new one created on the spot. */
    newProduct: z.object({ name: z.string().trim().min(1).max(60), category: z.string().trim().min(1).max(40) }).nullish(),
    cartons: z.number().int().min(1).max(500),
    /** Pieces in one carton. */
    packSize: z.number().int().min(1).max(1000),
    /** Selling price per piece (minor units). Absent = keep the current price. */
    price: z.number().int().min(0).nullish(),
  })
  .refine((l) => !!l.productId !== !!l.newProduct, { message: 'Choose a product or name a new one' });

export const receiveStockInput = z.object({
  lines: z.array(receiveLine).min(1).max(50),
  note: z.string().trim().max(200).nullish(),
});

export const adjustStockInput = z.object({
  countedQty: z.number().int().min(0).max(1_000_000),
  reason: z.string().trim().max(200).nullish(),
});

/** Every product with its stock, tracked ones first (for the goods page and the day-close count). */
export async function listStock(q: Q, branchId: string) {
  return q
    .select()
    .from(products)
    .where(and(eq(products.branchId, branchId), eq(products.active, true), isNull(products.archivedAt)))
    .orderBy(desc(products.trackStock), asc(products.category), asc(products.sort), asc(products.name));
}

/**
 * A delivery: "2 cartons of chips, 24 pieces each, 0.500 a piece" — for one or many products at once.
 * Stock goes up by cartons × pieces, the product starts being tracked, and the price per piece is updated.
 */
export async function receiveStock(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = receiveStockInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const day = await currentDay(tx, branch, now);
    const received: { productId: string; name: string; added: number; stockQty: number }[] = [];

    for (const line of input.lines) {
      let productId = line.productId ?? null;
      if (!productId) {
        const [same] = await tx
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.branchId, branch.id), isNull(products.archivedAt), sql`lower(${products.name}) = lower(${line.newProduct!.name})`));
        if (same) throw new DomainError('name_taken', 'A product with this name already exists — pick it from the list');
        productId = newId();
        await tx.insert(products).values({
          id: productId,
          branchId: branch.id,
          name: line.newProduct!.name,
          category: line.newProduct!.category,
          price: line.price ?? 0,
          trackStock: true,
          stockQty: 0,
          // Warn when about a quarter of a carton is left (editable in Settings → Products).
          lowStockAt: Math.max(3, Math.round(line.packSize / 4)),
        });
        await record({ type: 'product.created', entity: 'product', entityId: productId, payload: { ...line.newProduct, price: line.price ?? 0 } });
      }
      const [p] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, productId), eq(products.branchId, branch.id), isNull(products.archivedAt)));
      if (!p) throw notFound('product');

      const added = line.cartons * line.packSize;
      // Increment in SQL (a sale on another device at the same moment must not be lost);
      // a product that was not tracked before starts from this delivery.
      const [{ stockQty } = { stockQty: 0 }] = await tx
        .update(products)
        .set({
          stockQty: p.trackStock ? sql`${products.stockQty} + ${added}` : added,
          trackStock: true,
          active: true,
          packSize: line.packSize,
          ...(line.price != null ? { price: line.price } : {}),
          updatedAt: new Date(now),
        })
        .where(eq(products.id, p.id))
        .returning({ stockQty: products.stockQty });
      await tx.insert(stockMovements).values({
        id: newId(),
        branchId: branch.id,
        productId: p.id,
        delta: added,
        reason: 'purchase',
        cartons: line.cartons,
        packSize: line.packSize,
        unitPrice: line.price ?? p.price,
        note: input.note ?? null,
        businessDay: day,
        createdBy: actor.id,
      });
      received.push({ productId: p.id, name: p.name, added, stockQty });
    }

    await record({ type: 'stock.received', entity: 'product', payload: { lines: received, note: input.note ?? null } });
    return { received };
  });
}

/** "I counted, there are really 17": sets the stock and records the difference. */
export async function adjustStock(ctx: AppContext, actor: Actor, productId: string, raw: unknown) {
  const input = adjustStockInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const [p] = await tx.select().from(products).where(and(eq(products.id, productId), eq(products.branchId, branch.id)));
    if (!p) throw notFound('product');
    const delta = input.countedQty - p.stockQty;
    await tx.update(products).set({ stockQty: input.countedQty, trackStock: true, updatedAt: new Date(now) }).where(eq(products.id, p.id));
    await tx.insert(stockMovements).values({
      id: newId(),
      branchId: branch.id,
      productId: p.id,
      delta,
      reason: 'adjust',
      note: input.reason ?? null,
      businessDay: await currentDay(tx, branch, now),
      createdBy: actor.id,
    });
    await record({
      type: 'stock.adjusted',
      entity: 'product',
      entityId: p.id,
      payload: { name: p.name, from: p.stockQty, to: input.countedQty, delta },
      reason: input.reason ?? null,
    });
    return { id: p.id, delta };
  });
}

/** Recent ins and outs (deliveries, sales, voids, counts), newest first. */
export async function listMovements(q: Q, branchId: string, opts: { productId?: string; limit: number }) {
  const rows = await q
    .select({
      id: stockMovements.id,
      productId: stockMovements.productId,
      productName: products.name,
      delta: stockMovements.delta,
      reason: stockMovements.reason,
      cartons: stockMovements.cartons,
      packSize: stockMovements.packSize,
      unitPrice: stockMovements.unitPrice,
      note: stockMovements.note,
      businessDay: stockMovements.businessDay,
      createdBy: stockMovements.createdBy,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .innerJoin(products, eq(products.id, stockMovements.productId))
    .where(
      and(
        eq(stockMovements.branchId, branchId),
        ...(opts.productId ? [eq(stockMovements.productId, opts.productId)] : []),
      ),
    )
    .orderBy(desc(stockMovements.createdAt))
    .limit(opts.limit);
  const ids = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  const names = ids.length ? await q.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime(), createdByName: r.createdBy ? (nameOf.get(r.createdBy) ?? null) : null }));
}
