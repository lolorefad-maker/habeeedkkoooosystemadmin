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
 * Keeps this device in sync with every other device of the branch:
 * any committed change anywhere → refetch. The server is the single source of truth.
 */
export function useRealtime() {
  const token = useAuth((s) => s.token);
  const qc = useQueryClient();

  useEffect(() => {
    if (!token) return;
    const socket: Socket = io({ path: '/ws', auth: { token }, transports: ['websocket', 'polling'] });
    let pending: ReturnType<typeof setTimeout> | null = null;
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;

    const syncTime = () => {
      const sent = Date.now();
      socket.timeout(4000).emit('time', (err: unknown, serverTime: number) => {
        if (!err && typeof serverTime === 'number') syncFromServer(serverTime, sent);
      });
    };

    socket.on('connect', () => {
      if (offlineTimer) clearTimeout(offlineTimer);
      useConn.getState().set('online');
      syncTime();
      // We may have missed events while disconnected.
      void qc.invalidateQueries();
    });
    socket.on('disconnect', () => {
      useConn.getState().set('reconnecting');
      offlineTimer = setTimeout(() => useConn.getState().set('offline'), 6000);
    });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') useAuth.getState().logout();
      if (useConn.getState().status === 'online') useConn.getState().set('reconnecting');
      if (!offlineTimer) offlineTimer = setTimeout(() => useConn.getState().set('offline'), 6000);
    });
    socket.on('evt', (e: LiveEvent) => {
      for (const l of listeners) l(e);
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void qc.invalidateQueries(), 60);
    });

    const timeTimer = setInterval(syncTime, 60_000);
    return () => {
      clearInterval(timeTimer);
      if (pending) clearTimeout(pending);
      if (offlineTimer) clearTimeout(offlineTimer);
      socket.close();
    };
  }, [token, qc]);
}
