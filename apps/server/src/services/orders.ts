import { DomainError } from '@lounge/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mutate, type AppContext, type Record_ } from '../context';
import type { Q } from '../db';
import { orderItems, orders, products, sessions, stockMovements } from '../db/schema';
import type { Actor } from '../lib/auth';
import { notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import { currentDay, getBranch, resolveApproval, type Branch } from './common';

export const createOrderInput = z.object({
  /** null/absent → walk-in (counter) order. */
  sessionId: z.uuid().nullish(),
  label: z.string().trim().max(80).nullish(),
  note: z.string().trim().max(300).nullish(),
  items: z
    .array(z.object({ productId: z.uuid(), qty: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50),
});

export const voidItemInput = z.object({
  reason: z.string().trim().min(3).max(200),
  approvalPin: z.string().nullish(),
});

export const orderItemsInput = createOrderInput.shape.items;

export async function createOrder(ctx: AppContext, actor: Actor, raw: unknown) {
  const input = createOrderInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);

    if (input.sessionId) {
      const [s] = await tx
        .select({ status: sessions.status })
        .from(sessions)
        .where(and(eq(sessions.id, input.sessionId), eq(sessions.branchId, branch.id)));
      if (!s) throw notFound('session');
      if (s.status !== 'running' && s.status !== 'ended') throw new DomainError('session_closed', 'Session is already closed');
    }
    return insertOrder(tx, record, branch, actor, input, now);
  });
}

/** Put drinks/food on a device's account (or a walk-in tab): price snapshot + stock movement + audit. */
export async function insertOrder(
  tx: Q,
  record: Record_,
  branch: Branch,
  actor: Actor,
  input: { sessionId?: string | null; label?: string | null; note?: string | null; items: { productId: string; qty: number }[] },
  now: number,
) {
  const ids = [...new Set(input.items.map((i) => i.productId))];
  const prods = await tx
    .select()
    .from(products)
    .where(and(inArray(products.id, ids), eq(products.branchId, branch.id)));
  const byId = new Map(prods.map((p) => [p.id, p]));
  for (const it of input.items) {
    const p = byId.get(it.productId);
    if (!p) throw notFound('product');
    if (!p.active) throw new DomainError('product_inactive', `${p.name} is not available`, { productId: p.id });
  }

  const id = newId();
  const day = await currentDay(tx, branch, now);
  await tx.insert(orders).values({
    id,
    branchId: branch.id,
    sessionId: input.sessionId ?? null,
    status: 'open',
    label: input.label ?? null,
    note: input.note ?? null,
    createdBy: actor.id,
  });
  await tx.insert(orderItems).values(
    input.items.map((it) => {
      const p = byId.get(it.productId)!;
      return { id: newId(), orderId: id, productId: p.id, name: p.name, unitPrice: p.price, qty: it.qty };
    }),
  );

  // What is left on the shelf after this order, so the device that added it (and, for low items,
  // every other device) can tell the owner "Pepsi: 43 left".
  const stock = new Map<string, StockLeft>();
  for (const it of input.items) {
    const p = byId.get(it.productId)!;
    if (!p.trackStock) continue;
    const [left] = await tx
      .update(products)
      .set({ stockQty: sql`${products.stockQty} - ${it.qty}` })
      .where(eq(products.id, p.id))
      .returning({ qty: products.stockQty });
    stock.set(p.id, { productId: p.id, name: p.name, left: left?.qty ?? 0, lowAt: p.lowStockAt });
    await tx.insert(stockMovements).values({
      id: newId(),
      branchId: branch.id,
      productId: p.id,
      delta: -it.qty,
      reason: 'sale',
      refId: id,
      businessDay: day,
      createdBy: actor.id,
    });
  }

  await record({
    type: 'order.created',
    entity: 'order',
    entityId: id,
    payload: { sessionId: input.sessionId ?? null, items: input.items, stock: [...stock.values()] },
  });
  return { id, stock: [...stock.values()] };
}

export interface StockLeft {
  productId: string;
  name: string;
  left: number;
  lowAt: number;
}

export async function voidOrderItem(ctx: AppContext, actor: Actor, itemId: string, raw: unknown) {
  const input = voidItemInput.parse(raw);
  return mutate(ctx, actor, async (tx, record) => {
    const now = ctx.clock.now();
    const branch = await getBranch(tx, actor.branchId);
    const [row] = await tx
      .select({ item: orderItems, order: orders })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orderItems.id, itemId), eq(orders.branchId, branch.id)));
    if (!row) throw notFound('order item');
    if (row.item.voided) throw new DomainError('already_voided', 'Item is already voided');
    if (row.order.status !== 'open') throw new DomainError('order_closed', 'Order is already billed');

    const approvedBy = await resolveApproval(
      tx,
      actor,
      branch.settings.checkout.voidNeedsApproval,
      input.approvalPin,
      `void ${row.item.qty}× ${row.item.name}`,
    );

    await tx
      .update(orderItems)
      .set({ voided: true, voidReason: input.reason, voidedBy: actor.id, voidedAt: new Date(now) })
      .where(eq(orderItems.id, itemId));

    const [p] = await tx.select().from(products).where(eq(products.id, row.item.productId));
    if (p?.trackStock) {
      await tx
        .update(products)
        .set({ stockQty: sql`${products.stockQty} + ${row.item.qty}` })
        .where(eq(products.id, p.id));
      await tx.insert(stockMovements).values({
        id: newId(),
        branchId: branch.id,
        productId: p.id,
        delta: row.item.qty,
        reason: 'void',
        refId: row.order.id,
        businessDay: await currentDay(tx, branch, now),
        createdBy: actor.id,
      });
    }

    // An order whose items are all voided is itself void.
    const remaining = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, row.order.id), eq(orderItems.voided, false)));
    if (remaining.length === 0) {
      await tx.update(orders).set({ status: 'void', updatedAt: new Date(now) }).where(eq(orders.id, row.order.id));
    }

    await record({
      type: 'order.item_voided',
      entity: 'order',
      entityId: row.order.id,
      payload: { itemId, name: row.item.name, qty: row.item.qty, amount: row.item.qty * row.item.unitPrice },
      approvedBy,
      reason: input.reason,
    });
    return { id: itemId };
  });
}
