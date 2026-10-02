import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { useAuth } from './auth';
import { syncFromServer } from './clock';

export type ConnStatus = 'online' | 'reconnecting' | 'offline';

export const useConn = create<{ status: ConnStatus; set: (s: ConnStatus) => void }>((set) => ({
  status: 'reconnecting',
  set: (status) => set({ status }),
}));

export interface LiveEvent {
  id: string;
  type: string;
  entity: string;
  entityId: string | null;
  actorId: string | null;
  at: number;
  payload?: Record<string, unknown> & { number?: number };
}

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
export function onLiveEvent(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The red "lost connection" strip only appears after the connection has been gone this long while
 * the screen is in use. A phone waking up, a switch from Wi-Fi to 4G, or a server restart blip must
 * not alarm anyone: the socket reconnects by itself within a few seconds.
 */
export const OFFLINE_AFTER_MS = 15_000;

/**
 * Keeps this device in sync with every other device of the branch:
 * any committed change anywhere → refetch. The server is the single source of truth.
 */
export function useRealtime() {
  const token = useAuth((s) => s.token);
  const qc = useQueryClient();

  useEffect(() => {
    if (!token) return;
    const socket: Socket = io({ path: '/ws', auth: { token }, transports: ['websocket', 'polling'] });
    const conn = () => useConn.getState();
    let pending: ReturnType<typeof setTimeout> | null = null;
    let watch: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    /** When the connection was lost while the screen was in use; null while connected. */
    let lostAt: number | null = null;

    const syncTime = () => {
      const sent = Date.now();
      socket.timeout(4000).emit('time', (err: unknown, serverTime: number) => {
        if (!err && typeof serverTime === 'number') syncFromServer(serverTime, sent);
      });
    };

    // Status = how long it has been lost *in front of the user*. Time spent in the background
    // (screen locked, another app) never counts, and the clock restarts when the app comes back.
    const judge = () => {
      watch = null;
      if (closed || lostAt === null) return;
      if (!document.hidden) conn().set(Date.now() - lostAt >= OFFLINE_AFTER_MS ? 'offline' : 'reconnecting');
      watch = setTimeout(judge, 1000);
    };
    const lose = () => {
      if (closed) return;
      lostAt ??= Date.now();
      conn().set('reconnecting');
      if (!watch) watch = setTimeout(judge, 1000);
    };
    const found = () => {
      lostAt = null;
      if (watch) clearTimeout(watch);
      watch = null;
      conn().set('online');
    };

    socket.on('connect', () => {
      found();
      syncTime();
      // We may have missed events while disconnected.
      void qc.invalidateQueries();
    });
    socket.on('disconnect', lose);
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') useAuth.getState().logout();
      lose();
    });
    socket.on('evt', (e: LiveEvent) => {
      for (const l of listeners) l(e);
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void qc.invalidateQueries(), 60);
    });

    // Back in the app (phone unlocked, tab shown) or the network is back: try right now, and start
    // counting "lost" from this moment. A socket that looks connected may be dead after a long sleep,
    // so it is asked something: an answer proves it lives (and refreshes the numbers); silence
    // restarts the connection.
    const wake = () => {
      if (closed || document.hidden) return;
      if (!socket.connected) {
        lostAt = Date.now();
        conn().set('reconnecting');
        if (!watch) watch = setTimeout(judge, 1000);
        socket.connect();
        return;
      }
      const sent = Date.now();
      socket.timeout(4000).emit('time', (err: unknown, serverTime: number) => {
        if (closed) return;
        if (err || typeof serverTime !== 'number') {
          lose();
          socket.disconnect();
          socket.connect();
          return;
        }
        syncFromServer(serverTime, sent);
        found();
        void qc.invalidateQueries();
      });
    };
    // The device itself says it has no network: do not keep saying "connected".
    const deviceOffline = () => lose();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    window.addEventListener('offline', deviceOffline);

    const timeTimer = setInterval(syncTime, 60_000);
    return () => {
      closed = true;
      clearInterval(timeTimer);
      if (pending) clearTimeout(pending);
      if (watch) clearTimeout(watch);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', deviceOffline);
      socket.close();
    };
  }, [token, qc]);
}
