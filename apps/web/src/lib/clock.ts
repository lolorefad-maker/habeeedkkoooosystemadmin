import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * One shared ticker for the whole app. Time shown everywhere is the *server's* time
 * (device clocks drift; the bill must not depend on a tablet's wrong clock).
 */
interface ClockState {
  offset: number;
  now: number;
  setOffset: (offset: number) => void;
  tick: () => void;
}

export const useClock = create<ClockState>((set, get) => ({
  offset: 0,
  now: Date.now(),
  setOffset: (offset) => set({ offset, now: Date.now() + offset }),
  tick: () => set({ now: Date.now() + get().offset }),
}));

export const serverNow = () => Date.now() + useClock.getState().offset;

/** Re-renders every second with the server-adjusted time. */
export function useNow(): number {
  return useClock((s) => s.now);
}

export function useClockTicker() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      useClock.getState().tick();
      // Align to the next whole second so every timer flips together.
      timer = setTimeout(loop, 1000 - (serverNow() % 1000) + 5);
    };
    loop();
    return () => clearTimeout(timer);
  }, []);
}

/** Update the offset from a server timestamp measured around a round trip. */
export function syncFromServer(serverTime: number, sentAt: number, receivedAt = Date.now()) {
  const rtt = receivedAt - sentAt;
  if (rtt > 5000) return; // too slow to be trustworthy
  useClock.getState().setOffset(serverTime - (sentAt + rtt / 2));
}
