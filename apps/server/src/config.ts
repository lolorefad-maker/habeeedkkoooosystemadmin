import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  /** Where the embedded database and generated secrets live. */
  dataDir: string;
  /** Postgres URL (cloud / production). null → embedded Postgres (PGlite) inside dataDir. */
  databaseUrl: string | null;
  jwtSecret: string;
  /** "local" = runs inside the shop on the LAN; "cloud" = hosted. Same code, different defaults. */
  mode: 'local' | 'cloud';
  /** Built web app to serve (so one process serves everything on the shop PC). */
  webDist: string | null;
  seedDemo: boolean;
  schedulerIntervalMs: number;
  /**
   * Shop code a device must enter once before it can even see the login screen.
   * Required online: without it anyone with the URL could list staff and guess PINs.
   */
  accessCode: string | null;
  /** First-run owner for a real (non-demo) install. */
  owner: { name: string; pin: string } | null;
  /** Behind a hosting proxy (Render…): trust X-Forwarded-For so rate limits see the real client IP. */
  trustProxy: boolean;
}

function loadOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'jwt-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(48).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.LOUNGE_DATA_DIR ?? path.join(process.cwd(), '.data'));
  mkdirSync(dataDir, { recursive: true });
  const mode = env.LOUNGE_MODE === 'cloud' ? 'cloud' : 'local';
  const webDist = env.LOUNGE_WEB_DIST ?? path.resolve(process.cwd(), '../web/dist');

  return {
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    databaseUrl: env.DATABASE_URL || null,
    jwtSecret: env.JWT_SECRET || loadOrCreateSecret(dataDir),
    mode,
    webDist: existsSync(webDist) ? webDist : null,
    // Demo data only where it is safe: on by default locally, off by default online.
    seedDemo: env.LOUNGE_SEED_DEMO ? env.LOUNGE_SEED_DEMO !== 'false' : mode === 'local',
    schedulerIntervalMs: Number(env.LOUNGE_TICK_MS ?? 10_000),
    accessCode: env.LOUNGE_ACCESS_CODE?.trim() || null,
    owner: env.LOUNGE_OWNER_PIN ? { name: env.LOUNGE_OWNER_NAME?.trim() || 'المالك', pin: env.LOUNGE_OWNER_PIN.trim() } : null,
    trustProxy: env.LOUNGE_TRUST_PROXY ? env.LOUNGE_TRUST_PROXY === 'true' : mode === 'cloud',
  };
}

/** Refuse to start an online install that would be unsafe, with a message saying exactly what to set. */
export function assertSafeConfig(c: Config): void {
  if (c.mode !== 'cloud') return;
  const problems: string[] = [];
  if (!c.databaseUrl) problems.push('DATABASE_URL is required online (the server disk is wiped on every deploy).');
  if (!c.accessCode || c.accessCode.length < 6) problems.push('LOUNGE_ACCESS_CODE (the shop code, at least 6 characters) is required online.');
  if (c.seedDemo) problems.push('LOUNGE_SEED_DEMO must be false online (demo staff have well-known PINs).');
  if (c.owner && !/^\d{6,8}$/.test(c.owner.pin)) problems.push('LOUNGE_OWNER_PIN must be 6–8 digits online.');
  if (problems.length) throw new Error(`Unsafe cloud configuration:\n - ${problems.join('\n - ')}`);
}
