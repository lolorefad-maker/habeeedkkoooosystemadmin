import { liveState, type Segment } from '@lounge/core';

/**
 * Which time alerts to fire, decided purely from timestamps (no timers of its own).
 * Keyed by session + planned minutes, so extending a session re-arms its alerts.
 */

export interface AlertSession {
  id: string;
  kind: 'open' | 'fixed';
  status: 'running' | 'ended';
  plannedMinutes: number | null;
  packageId?: string | null;
  stationId: string;
  segments: Segment[];
}

export interface AlertMemory {
  seen: boolean;
  soon: boolean;
  up: boolean;
  lastAlarmAt: number | null;
}

export type AlertAction = { kind: 'soon' | 'up' | 'repeat'; key: string; sessionId: string; stationId: string; remainingMs: number };

export const alertKey = (s: { id: string; plannedMinutes: number | null }) => `${s.id}:${s.plannedMinutes ?? 'open'}`;

export function decideAlerts(
  sessions: AlertSession[],
  memory: Map<string, AlertMemory>,
  acked: ReadonlySet<string>,
  now: number,
  opts: { endingSoonMinutes: number; repeatMs: number },
): AlertAction[] {
  const actions: AlertAction[] = [];
  const live = new Set<string>();

  for (const s of sessions) {
    if (s.status !== 'running' || s.kind !== 'fixed' || s.plannedMinutes == null) continue;
    const key = alertKey(s);
    live.add(key);
    const state = liveState({ kind: s.kind, plannedMinutes: s.plannedMinutes, packageId: s.packageId, segments: s.segments }, now, opts.endingSoonMinutes);
    const mem = memory.get(key) ?? { seen: false, soon: false, up: false, lastAlarmAt: null };
    const firstSight = !mem.seen;
    mem.seen = true;
    memory.set(key, mem);
    const base = { key, sessionId: s.id, stationId: s.stationId, remainingMs: state.remainingMs ?? 0 };

    if (state.status === 'ending' && !mem.soon) {
      mem.soon = true;
      // Opening the app when a session is already ending should not chime; only live transitions do.
      if (!firstSight) actions.push({ kind: 'soon', ...base });
    } else if (state.status === 'overtime') {
      mem.soon = true;
      if (acked.has(key)) continue;
      if (!mem.up) {
        mem.up = true;
        mem.lastAlarmAt = now;
        actions.push({ kind: 'up', ...base });
      } else if (mem.lastAlarmAt != null && now - mem.lastAlarmAt >= opts.repeatMs) {
        mem.lastAlarmAt = now;
        actions.push({ kind: 'repeat', ...base });
      }
    }
  }

  for (const key of memory.keys()) if (!live.has(key)) memory.delete(key);
  return actions;
}
