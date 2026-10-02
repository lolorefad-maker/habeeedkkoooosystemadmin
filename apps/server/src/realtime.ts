import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { AppContext } from './context';
import { verifyToken } from './lib/auth';

/**
 * Pushes every committed domain event to the devices of that branch. Clients refetch what
 * changed, so every screen (cashier, waiter tablet, kitchen, owner phone) stays in sync.
 */
export function attachRealtime(server: HttpServer, ctx: AppContext) {
  const io = new Server(server, {
    path: '/ws',
    // Same origin only: the web app is served by this server.
    // Gentle on phones: a weak signal that stalls for a few seconds must not drop the connection
    // (a dead one is still noticed within pingInterval + pingTimeout).
    pingInterval: 12_000,
    pingTimeout: 20_000,
  });

  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const actor = await verifyToken(token, ctx.config.jwtSecret);
      socket.data.actor = actor;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { branchId } = socket.data.actor as { branchId: string };
    void socket.join(`branch:${branchId}`);
    socket.emit('hello', { now: ctx.clock.now() });
    socket.on('time', (ack: unknown) => {
      if (typeof ack === 'function') ack(ctx.clock.now());
    });
  });

  const off = ctx.bus.onEvent((e) => {
    io.to(`branch:${e.branchId}`).emit('evt', {
      id: e.id,
      type: e.type,
      entity: e.entity,
      entityId: e.entityId,
      actorId: e.actorId,
      at: e.createdAt.getTime(),
      // Small, branch-scoped details so screens can say *what* happened ("controller 3 is charged").
      payload: e.payload,
    });
  });

  return {
    io,
    close: async () => {
      off();
      await io.close();
    },
  };
}
