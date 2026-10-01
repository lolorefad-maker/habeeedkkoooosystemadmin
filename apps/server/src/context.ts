import { EventEmitter } from 'node:events';
import type { Config } from './config';
import type { DB, Tx } from './db';
import { events } from './db/schema';
import type { Actor } from './lib/auth';
import { newId } from './lib/ids';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface DomainEvent {
  id: string;
  branchId: string;
  type: string;
  entity: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  actorId: string | null;
  approvedBy: string | null;
  reason: string | null;
  createdAt: Date;
}

/** In-process pub/sub. Realtime (Socket.IO) and, later, the cloud sync worker subscribe to it. */
export class Bus extends EventEmitter {
  publish(e: DomainEvent) {
    this.emit('event', e);
  }
  onEvent(fn: (e: DomainEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export interface AppContext {
  db: DB;
  clock: Clock;
  bus: Bus;
  config: Config;
}

export interface NewEvent {
  type: string;
  entity: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  approvedBy?: string | null;
  reason?: string | null;
  /** Defaults to the acting user's branch. */
  branchId?: string;
}

export type Record_ = (e: NewEvent) => Promise<void>;

/**
 * Run a write in one transaction. Every change records an event row (audit log + sync outbox)
 * in the same transaction; events are published to live clients only after the commit succeeds.
 */
export async function mutate<T>(
  ctx: AppContext,
  actor: Actor | { id: null; branchId: string },
  fn: (tx: Tx, record: Record_) => Promise<T>,
): Promise<T> {
  const pending: DomainEvent[] = [];
  const result = await ctx.db.transaction(async (tx) => {
    const record: Record_ = async (e) => {
      const row: DomainEvent = {
        id: newId(),
        branchId: e.branchId ?? actor.branchId,
        type: e.type,
        entity: e.entity,
        entityId: e.entityId ?? null,
        payload: e.payload ?? {},
        actorId: actor.id,
        approvedBy: e.approvedBy ?? null,
        reason: e.reason ?? null,
        createdAt: new Date(ctx.clock.now()),
      };
      await tx.insert(events).values(row);
      pending.push(row);
    };
    return fn(tx, record);
  });
  for (const e of pending) ctx.bus.publish(e);
  return result;
}
