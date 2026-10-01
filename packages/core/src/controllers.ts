/**
 * Numbered game controllers. A controller is on a station, on the shelf (spare), on charge,
 * or broken. Charging ends by itself: once `readyAt` passes it counts as ready everywhere,
 * even before the scheduler records it.
 */

export type ControllerStatus = 'ready' | 'charging' | 'broken';

export interface ControllerLike {
  status: ControllerStatus;
  stationId: string | null;
  readyAt: number | null;
}

export type ControllerState = 'at_station' | 'spare' | 'charging' | 'broken';

export function isCharged(c: ControllerLike, now: number): boolean {
  return c.status === 'charging' && c.readyAt != null && now >= c.readyAt;
}

export function controllerState(c: ControllerLike, now: number): ControllerState {
  if (c.status === 'broken') return 'broken';
  if (c.status === 'charging' && !isCharged(c, now)) return 'charging';
  return c.stationId ? 'at_station' : 'spare';
}

/** Milliseconds until a charging controller is ready (0 when ready or not charging). */
export function chargeRemainingMs(c: ControllerLike, now: number): number {
  if (c.status !== 'charging' || c.readyAt == null) return 0;
  return Math.max(0, c.readyAt - now);
}
