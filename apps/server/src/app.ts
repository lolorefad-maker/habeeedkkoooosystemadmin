import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { DomainError, MINUTE } from '@lounge/core';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { AppContext } from './context';
import { bills, branches, events, users } from './db/schema';
import {
  checkLockout,
  clearFailures,
  recordFailure,
  requirePerm,
  signToken,
  verifyPin,
  verifyToken,
  type Actor,
  type Permission,
} from './lib/auth';
import { HttpError, notFound, unauthorized } from './lib/errors';
import { checkoutSession, counterSale, getBill, voidBill } from './services/checkout';
import { getBranch, getSession } from './services/common';
import { closeDay, dayReport, listDays } from './services/days';
import { floorSnapshot } from './services/floor';
import { monthReport, rangeReport, sessionsLog } from './services/ledger';
import { exportSetup, importSetup } from './services/setup';
import { createCustomer, listCustomers, updateCustomer } from './services/customers';
import { billCustomer, listRewards, lookupCustomer, markRewardNotified, voidReward } from './services/rewards';
import { adjustStock, listMovements, listStock, receiveStock } from './services/stock';
import { createOrder, voidOrderItem } from './services/orders';
import { cancelReservation, createReservation, deleteReservation, listReservations, refundReservation } from './services/reservations';
import {
  addControllers,
  assignController,
  chargeController,
  deleteController,
  listControllers,
  readyController,
  setControllerBroken,
} from './services/controllers';
import { addSessionPayment, reopenSession, sessionAction, sessionBill, setPlan, startSession, voidSession } from './services/sessions';
import {
  deleteProduct,
  deleteStation,
  listCurrentRules,
  listPackages,
  listProducts,
  listStaff,
  listStations,
  savePackage,
  saveProduct,
  saveRule,
  saveStaff,
  saveStation,
  startQuickDiscount,
  stopQuickDiscount,
  updateBranch,
} from './services/settings';
import { countClosedShift, currentShift, endShift, startShift } from './services/shifts';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

type Handler = (req: FastifyRequest, actor: Actor) => Promise<unknown>;

const idParam = z.object({ id: z.uuid() });

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    logger: ctx.config.mode === 'cloud' ? true : { level: 'warn' },
    bodyLimit: 1_000_000,
    // Behind Render's proxy the client IP is in X-Forwarded-For (needed for per-IP limits).
    trustProxy: ctx.config.trustProxy,
  });

  // Same-origin only (web app and API are served by this process), so no CORS at all.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    // HTTPS only exists online; on the shop LAN it is plain HTTP.
    hsts: ctx.config.mode === 'cloud' ? { maxAge: 15_552_000 } : false,
  });
  // Generous for normal use (every device of a shop shares one public IP); login routes are much stricter.
  await app.register(rateLimit, { max: 3000, timeWindow: '1 minute' });
  const strict = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { cause?: { code?: string }; code?: string; statusCode?: number; message?: string };
    if (err instanceof ZodError) {
      return reply.status(400).send({ code: 'validation', message: 'Invalid input', issues: err.issues });
    }
    if (err instanceof DomainError) {
      return reply.status(409).send({ code: err.code, message: err.message, details: err.details });
    }
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ code: err.code, message: err.message, details: err.details });
    }
    const pgCode = e.cause?.code ?? e.code;
    if (pgCode === '23505') {
      return reply.status(409).send({ code: 'conflict', message: 'This was changed by someone else at the same time. Try again.' });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ code: 'bad_request', message: e.message });
    }
    req.log.error(err);
    return reply.status(500).send({ code: 'internal', message: 'Unexpected server error' });
  });

  async function authenticate(req: FastifyRequest): Promise<Actor> {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw unauthorized();
    const actor = await verifyToken(h.slice(7), ctx.config.jwtSecret);
    // A deactivated employee is locked out immediately, not when their token expires.
    const [u] = await ctx.db.select({ active: users.active, role: users.role }).from(users).where(eq(users.id, actor.id));
    if (!u || !u.active) throw unauthorized('Account disabled');
    actor.role = u.role;
    req.actor = actor;
    return actor;
  }

  const route =
    (perm: Permission | null, handler: Handler) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = await authenticate(req);
      if (perm) requirePerm(actor, perm);
      const result = await handler(req, actor);
      return reply.send(result ?? { ok: true });
    };

  const id = (req: FastifyRequest) => idParam.parse(req.params).id;
  const now = () => ctx.clock.now();

  /**
   * The login screen (branch list, staff names, PIN check) is only reachable from a device that
   * knows the shop code. Online this keeps strangers from even seeing who works here.
   */
  const accessCode = ctx.config.accessCode ? Buffer.from(ctx.config.accessCode) : null;
  function requireAccess(req: FastifyRequest) {
    if (!accessCode) return;
    const given = req.headers['x-lounge-access'];
    if (typeof given !== 'string' || !given) throw new HttpError(401, 'access_code_required', 'Shop code required');
    const g = Buffer.from(given);
    if (g.length !== accessCode.length || !timingSafeEqual(g, accessCode)) {
      throw new HttpError(401, 'access_code_invalid', 'Wrong shop code');
    }
  }

  // ------------------------------------------------------------------ public
  app.get('/api/health', async () => ({ ok: true, mode: ctx.config.mode, now: now() }));
  app.get('/api/time', async () => ({ now: now() }));

  app.get('/api/auth/branches', strict, async (req) => {
    requireAccess(req);
    return ctx.db.select({ id: branches.id, name: branches.name }).from(branches).orderBy(branches.name);
  });

  app.get('/api/auth/staff', strict, async (req) => {
    requireAccess(req);
    const { branchId } = z.object({ branchId: z.uuid() }).parse(req.query);
    const [b] = await ctx.db.select({ orgId: branches.orgId }).from(branches).where(eq(branches.id, branchId));
    if (!b) throw notFound('branch');
    return ctx.db
      .select({ id: users.id, name: users.name, role: users.role })
      .from(users)
      .where(and(eq(users.orgId, b.orgId), eq(users.active, true), or(isNull(users.branchId), eq(users.branchId, branchId))))
      .orderBy(users.name);
  });

  app.post('/api/auth/login', strict, async (req) => {
    requireAccess(req);
    const input = z.object({ userId: z.uuid(), branchId: z.uuid(), pin: z.string().min(4).max(8) }).parse(req.body);
    const wait = checkLockout(input.userId, now());
    if (wait > 0) throw new HttpError(429, 'locked', 'Too many wrong PINs, try again later', { retryInMs: wait });
    const [u] = await ctx.db.select().from(users).where(eq(users.id, input.userId));
    const [b] = await ctx.db.select().from(branches).where(eq(branches.id, input.branchId));
    if (!u || !b || !u.active || u.orgId !== b.orgId || (u.branchId && u.branchId !== b.id)) throw unauthorized('Wrong PIN');
    if (!(await verifyPin(input.pin, u.pinHash))) {
      recordFailure(u.id, now());
      throw unauthorized('Wrong PIN');
    }
    clearFailures(u.id);
    const actor: Actor = { id: u.id, orgId: u.orgId, branchId: b.id, role: u.role, name: u.name };
    return { token: await signToken(actor, ctx.config.jwtSecret), user: actor };
  });

  // ------------------------------------------------------------------ me & floor
  app.get('/api/me', route(null, async (_req, actor) => actor));
  app.get('/api/floor', route('floor.view', async (_req, actor) => floorSnapshot(ctx.db, actor.branchId, now())));

  // ------------------------------------------------------------------ sessions
  app.post('/api/sessions', route('session.manage', async (req, actor) => startSession(ctx, actor, req.body)));
  app.post('/api/sessions/:id/action', route('session.manage', async (req, actor) => sessionAction(ctx, actor, id(req), req.body)));
  app.post('/api/sessions/:id/plan', route('session.manage', async (req, actor) => setPlan(ctx, actor, id(req), req.body)));
  app.post('/api/sessions/:id/reopen', route('session.manage', async (req, actor) => reopenSession(ctx, actor, id(req))));
  app.post('/api/sessions/:id/void', route('session.manage', async (req, actor) => voidSession(ctx, actor, id(req), req.body)));
  app.post('/api/sessions/:id/checkout', route('checkout', async (req, actor) => checkoutSession(ctx, actor, id(req), req.body)));
  app.post('/api/sessions/:id/payments', route('checkout', async (req, actor) => addSessionPayment(ctx, actor, id(req), req.body)));

  // ------------------------------------------------------------------ controllers
  app.get('/api/controllers', route('floor.view', async (_req, actor) => listControllers(ctx.db, actor.branchId)));
  app.post('/api/controllers', route('settings.manage', async (req, actor) => addControllers(ctx, actor, req.body)));
  app.delete('/api/controllers/:id', route('settings.manage', async (req, actor) => deleteController(ctx, actor, id(req))));
  app.post('/api/controllers/:id/charge', route('controllers.manage', async (req, actor) => chargeController(ctx, actor, id(req), req.body)));
  app.post('/api/controllers/:id/ready', route('controllers.manage', async (req, actor) => readyController(ctx, actor, id(req))));
  app.post('/api/controllers/:id/assign', route('controllers.manage', async (req, actor) => assignController(ctx, actor, id(req), req.body)));
  app.post('/api/controllers/:id/broken', route('controllers.manage', async (req, actor) => setControllerBroken(ctx, actor, id(req), req.body)));
  app.get(
    '/api/sessions/:id/bill',
    route('floor.view', async (req, actor) => {
      const branch = await getBranch(ctx.db, actor.branchId);
      const s = await getSession(ctx.db, branch.id, id(req));
      const { session: _s, timeline, ...bill } = await sessionBill(ctx.db, branch, s, now());
      const who = await billCustomer(ctx.db, branch, s, bill.time);
      return { ...bill, ...who, timeline, session: { ...s, startedAt: s.startedAt.getTime(), endedAt: s.endedAt?.getTime() ?? null } };
    }),
  );

  // ------------------------------------------------------------------ drinks & food (always on a device's account)
  app.get('/api/products', route('floor.view', async (_req, actor) => listProducts(ctx.db, actor.branchId)));
  app.post('/api/orders', route('order.create', async (req, actor) => createOrder(ctx, actor, req.body)));
  // Cafeteria: sell to someone who is not on a station, paid on the spot.
  app.post('/api/counter/sale', route('checkout', async (req, actor) => counterSale(ctx, actor, req.body)));
  app.post('/api/order-items/:id/void', route('order.create', async (req, actor) => voidOrderItem(ctx, actor, id(req), req.body)));

  // ------------------------------------------------------------------ bills
  app.post('/api/bills/:id/void', route('day.close', async (req, actor) => voidBill(ctx, actor, id(req), req.body)));
  app.get('/api/bills/:id', route('floor.view', async (req, actor) => getBill(ctx.db, actor.branchId, id(req))));
  app.get(
    '/api/bills',
    route('reports.view', async (req, actor) => {
      const { day } = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
      return ctx.db
        .select()
        .from(bills)
        .where(and(eq(bills.branchId, actor.branchId), eq(bills.businessDay, day)))
        .orderBy(desc(bills.number));
    }),
  );

  // ------------------------------------------------------------------ reservations
  app.get(
    '/api/reservations',
    route('floor.view', async (req, actor) => {
      const q = z
        .object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() })
        .parse(req.query);
      const from = q.from ?? now() - 12 * 60 * MINUTE;
      const to = q.to ?? from + 7 * 24 * 60 * MINUTE;
      const rows = await listReservations(ctx.db, actor.branchId, from, to);
      return rows.map((r) => ({ ...r, startAt: r.startAt.getTime() }));
    }),
  );
  app.post('/api/reservations', route('reservation.manage', async (req, actor) => createReservation(ctx, actor, req.body)));
  app.post('/api/reservations/:id/cancel', route('reservation.manage', async (req, actor) => cancelReservation(ctx, actor, id(req), req.body)));
  app.post('/api/reservations/:id/refund', route('reservation.manage', async (req, actor) => refundReservation(ctx, actor, id(req), req.body)));
  app.delete('/api/reservations/:id', route('reservation.manage', async (req, actor) => deleteReservation(ctx, actor, id(req))));

  // ------------------------------------------------------------------ shifts & days
  app.get('/api/shifts/current', route('floor.view', async (_req, actor) => ({ shift: await currentShift(ctx.db, actor.branchId) })));
  app.post('/api/shifts/open', route('shift.manage', async (req, actor) => startShift(ctx, actor, req.body)));
  app.post('/api/shifts/close', route('shift.manage', async (req, actor) => endShift(ctx, actor, req.body)));
  // Count, afterwards, a shift that closed by itself at the day's end.
  app.post('/api/shifts/:id/count', route('shift.manage', async (req, actor) => countClosedShift(ctx, actor, id(req), req.body)));

  app.get('/api/days', route('reports.view', async (_req, actor) => listDays(ctx.db, actor.branchId)));
  app.get(
    '/api/reports/day',
    route('reports.view', async (req, actor) => {
      const { day } = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
      return dayReport(ctx.db, actor.branchId, day ?? null, now());
    }),
  );
  app.post('/api/days/close', route('day.close', async (req, actor) => closeDay(ctx, actor, req.body)));

  // ------------------------------------------------------------------ ledger (daily / monthly)
  const dayQuery = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
  app.get(
    '/api/reports/sessions',
    route('reports.view', async (req, actor) => sessionsLog(ctx.db, actor.branchId, dayQuery.parse(req.query).day)),
  );
  app.get(
    '/api/reports/month',
    route('reports.view', async (req, actor) => {
      const { month } = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.query);
      return monthReport(ctx.db, actor.branchId, month);
    }),
  );
  // Any period, "from day to day": per-day rows and the period's totals.
  app.get(
    '/api/reports/range',
    route('reports.view', async (req, actor) => {
      const { from, to } = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
      return rangeReport(ctx.db, actor.branchId, from, to);
    }),
  );

  // ------------------------------------------------------------------ customer rewards
  app.get('/api/rewards', route('checkout', async (req, actor) => listRewards(ctx.db, actor.branchId, req.query)));
  app.post('/api/rewards/:id/notified', route('checkout', async (req, actor) => markRewardNotified(ctx, actor, id(req))));
  app.post('/api/rewards/:id/void', route('settings.manage', async (req, actor) => voidReward(ctx, actor, id(req), req.body)));
  app.get(
    '/api/customers/lookup',
    route('session.manage', async (req, actor) => lookupCustomer(ctx.db, actor.branchId, (req.query as { phone?: string }).phone)),
  );

  app.get('/api/customers', route('checkout', async (_req, actor) => listCustomers(ctx.db, actor.orgId, actor.branchId)));
  app.post('/api/customers', route('checkout', async (req, actor) => createCustomer(ctx, actor, req.body)));
  app.patch('/api/customers/:id', route('checkout', async (req, actor) => updateCustomer(ctx, actor, id(req), req.body)));

  // ------------------------------------------------------------------ goods (stock)
  app.get('/api/stock', route('stock.view', async (_req, actor) => listStock(ctx.db, actor.branchId)));
  app.post('/api/stock/receive', route('stock.manage', async (req, actor) => receiveStock(ctx, actor, req.body)));
  app.post('/api/stock/:id/adjust', route('stock.manage', async (req, actor) => adjustStock(ctx, actor, id(req), req.body)));
  app.get(
    '/api/stock/movements',
    route('stock.view', async (req, actor) => {
      const q = z
        .object({ productId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(req.query);
      return listMovements(ctx.db, actor.branchId, q);
    }),
  );

  // ------------------------------------------------------------------ settings
  app.get(
    '/api/settings',
    route('settings.manage', async (_req, actor) => {
      const [branch, stationRows, rules, pkgs, prods, staff] = await Promise.all([
        getBranch(ctx.db, actor.branchId),
        listStations(ctx.db, actor.branchId),
        listCurrentRules(ctx.db, actor.branchId, now()),
        listPackages(ctx.db, actor.branchId),
        listProducts(ctx.db, actor.branchId),
        listStaff(ctx.db, actor),
      ]);
      return { branch, stations: stationRows, rules, packages: pkgs, products: prods, staff };
    }),
  );
  app.patch('/api/settings/branch', route('settings.manage', async (req, actor) => updateBranch(ctx, actor, req.body)));
  // Move the shop's setup (stations, prices, products, controllers, policies) to another install.
  app.get('/api/settings/export', route('settings.manage', async (_req, actor) => exportSetup(ctx.db, actor, ctx.clock.now())));
  app.post('/api/settings/import', route('settings.manage', async (req, actor) => importSetup(ctx, actor, req.body)));
  app.post('/api/settings/stations', route('settings.manage', async (req, actor) => saveStation(ctx, actor, null, req.body)));
  app.patch('/api/settings/stations/:id', route('settings.manage', async (req, actor) => saveStation(ctx, actor, id(req), req.body)));
  app.delete('/api/settings/stations/:id', route('settings.manage', async (req, actor) => deleteStation(ctx, actor, id(req))));
  app.post('/api/settings/rules', route('settings.manage', async (req, actor) => saveRule(ctx, actor, null, req.body)));
  app.put('/api/settings/rules/:id', route('settings.manage', async (req, actor) => saveRule(ctx, actor, id(req), req.body)));
  app.post('/api/pricing/discount', route('settings.manage', async (req, actor) => startQuickDiscount(ctx, actor, req.body)));
  app.post('/api/pricing/discount/stop', route('settings.manage', async (_req, actor) => stopQuickDiscount(ctx, actor)));
  app.post('/api/settings/packages', route('settings.manage', async (req, actor) => savePackage(ctx, actor, null, req.body)));
  app.put('/api/settings/packages/:id', route('settings.manage', async (req, actor) => savePackage(ctx, actor, id(req), req.body)));
  app.post('/api/settings/products', route('stock.manage', async (req, actor) => saveProduct(ctx, actor, null, req.body)));
  app.patch('/api/settings/products/:id', route('stock.manage', async (req, actor) => saveProduct(ctx, actor, id(req), req.body)));
  app.delete('/api/settings/products/:id', route('stock.manage', async (req, actor) => deleteProduct(ctx, actor, id(req))));
  app.post('/api/settings/staff', route('staff.manage', async (req, actor) => saveStaff(ctx, actor, null, req.body)));
  app.patch('/api/settings/staff/:id', route('staff.manage', async (req, actor) => saveStaff(ctx, actor, id(req), req.body)));

  // ------------------------------------------------------------------ audit log
  app.get(
    '/api/audit',
    route('audit.view', async (req, actor) => {
      const { limit, before } = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() })
        .parse(req.query);
      const rows = await ctx.db
        .select()
        .from(events)
        .where(eq(events.branchId, actor.branchId))
        .orderBy(desc(events.createdAt))
        .limit(limit);
      const filtered = before ? rows.filter((r) => r.createdAt.getTime() < before) : rows;
      const ids = [...new Set(filtered.flatMap((r) => [r.actorId, r.approvedBy]).filter((x): x is string => !!x))];
      const names = ids.length ? await ctx.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
      const nameOf = new Map(names.map((n) => [n.id, n.name]));
      return filtered.map((r) => ({
        ...r,
        createdAt: r.createdAt.getTime(),
        actorName: r.actorId ? (nameOf.get(r.actorId) ?? null) : null,
        approverName: r.approvedBy ? (nameOf.get(r.approvedBy) ?? null) : null,
      }));
    }),
  );

  // ------------------------------------------------------------------ web app (one process serves everything)
  const dist = ctx.config.webDist;
  if (dist && existsSync(path.join(dist, 'index.html'))) {
    // The Android app (a Trusted Web Activity) checks this to open full screen, without a browser bar.
    // Static serving skips dot-folders, so it gets its own route.
    const assetLinks = path.join(dist, '.well-known', 'assetlinks.json');
    if (existsSync(assetLinks)) {
      const body = readFileSync(assetLinks, 'utf8');
      app.get('/.well-known/assetlinks.json', async (_req, reply) => reply.type('application/json').send(body));
    }
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.status(404).send({ code: 'not_found', message: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
