import { networkInterfaces } from 'node:os';
import { buildApp } from './app';
import { assertSafeConfig, loadConfig } from './config';
import { Bus, systemClock, type AppContext } from './context';
import { openDatabase } from './db';
import { attachRealtime } from './realtime';
import { startScheduler, tick } from './scheduler';
import { seedIfEmpty } from './seed';

const config = loadConfig();
assertSafeConfig(config);
const database = await openDatabase({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const seeded = await seedIfEmpty(database.db, { demo: config.seedDemo, owner: config.owner });

const ctx: AppContext = { db: database.db, clock: systemClock, bus: new Bus(), config };
const app = await buildApp(ctx);
const realtime = attachRealtime(app.server, ctx);

await app.listen({ port: config.port, host: config.host });

const log = (msg: string, err?: unknown) => (err ? console.error(`[scheduler] ${msg}`, err) : console.log(`[scheduler] ${msg}`));
await tick(ctx, log);
const stopScheduler = startScheduler(ctx, log);

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${config.port}`);

console.log(`
  Lounge OS server (${config.mode}) — database: ${database.driver}${seeded ? (config.seedDemo ? ' (demo data created)' : ' (owner account created)') : ''}
  This PC:        http://localhost:${config.port}
  Other devices:  ${lan.join('  ') || '(no network)'}
  Web app:        ${config.webDist ? 'served from ' + config.webDist : 'run the web dev server (npm run dev)'}
`);

async function shutdown() {
  stopScheduler();
  await realtime.close();
  await app.close();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
