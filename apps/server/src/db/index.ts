import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import * as schema from './schema';

export { schema };

/** Both drivers expose the same query API; we type against node-postgres. */
export type DB = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
/** Anything that can run queries: the db itself or an open transaction. */
export type Q = DB | Tx;

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export interface Database {
  db: DB;
  driver: 'pg' | 'pglite';
  close(): Promise<void>;
}

/**
 * Open the database and bring the schema up to date.
 * - `databaseUrl` set → real Postgres (cloud, or a shop PC running Postgres).
 * - otherwise → embedded Postgres (PGlite) stored in `dataDir`, or in memory when dataDir is null (tests).
 */
export async function openDatabase(opts: { databaseUrl: string | null; dataDir: string | null }): Promise<Database> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    const db = drizzlePg({ client: pool, schema });
    await migratePg(db, { migrationsFolder });
    return { db, driver: 'pg', close: () => pool.end() };
  }

  const client = opts.dataDir ? new PGlite(path.join(opts.dataDir, 'pgdata')) : new PGlite();
  const db = drizzlePglite({ client, schema });
  await migratePglite(db, { migrationsFolder });
  return { db: db as unknown as DB, driver: 'pglite', close: () => client.close() };
}
