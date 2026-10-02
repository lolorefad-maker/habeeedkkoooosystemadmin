import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { jwtVerify, SignJWT } from 'jose';
import type { Role } from '../db/schema';
import { forbidden, unauthorized } from './errors';

const scrypt = promisify(scryptCb) as (pwd: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pin, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export interface Actor {
  id: string;
  orgId: string;
  branchId: string;
  role: Role;
  name: string;
}

/** Actor id used for automatic actions (scheduler). Shown as "System" in the audit log. */
export const SYSTEM_ID = '00000000-0000-0000-0000-000000000000';

export async function signToken(actor: Actor, secret: string): Promise<string> {
  return new SignJWT({ org: actor.orgId, br: actor.branchId, role: actor.role, name: actor.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(actor.id)
    .setIssuedAt()
    .setExpirationTime('14h')
    .sign(new TextEncoder().encode(secret));
}

export async function verifyToken(token: string, secret: string): Promise<Actor> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return {
      id: String(payload.sub),
      orgId: String(payload.org),
      branchId: String(payload.br),
      role: payload.role as Role,
      name: String(payload.name ?? ''),
    };
  } catch {
    throw unauthorized('Session expired, please log in again');
  }
}

const ALL: Role[] = ['owner', 'manager', 'cashier', 'waiter'];
const DESK: Role[] = ['owner', 'manager', 'cashier'];
const MGMT: Role[] = ['owner', 'manager'];

export const PERMISSIONS = {
  'floor.view': ALL,
  'session.manage': DESK,
  'order.create': ALL,
  'controllers.manage': ALL,
  checkout: DESK,
  'reservation.manage': DESK,
  'shift.manage': DESK,
  'stock.view': DESK,
  'stock.manage': DESK,
  'reports.view': MGMT,
  'day.close': MGMT,
  'settings.manage': MGMT,
  'staff.manage': MGMT,
  'audit.view': MGMT,
} as const satisfies Record<string, Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, perm: Permission): boolean {
  return (PERMISSIONS[perm] as readonly Role[]).includes(role);
}

export function requirePerm(actor: Actor, perm: Permission): void {
  if (!can(actor.role, perm)) throw forbidden();
}

export const isManager = (role: Role) => role === 'owner' || role === 'manager';

/** Simple brute-force protection for PIN logins (per user, in memory). */
const failures = new Map<string, { count: number; until: number }>();
export function checkLockout(userId: string, now: number): number {
  const f = failures.get(userId);
  return f && f.until > now ? f.until - now : 0;
}
export function recordFailure(userId: string, now: number): void {
  const f = failures.get(userId) ?? { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) {
    f.until = now + 60_000 * Math.min(15, 2 ** (f.count - 5));
  }
  failures.set(userId, f);
}
export function clearFailures(userId: string): void {
  failures.delete(userId);
}
