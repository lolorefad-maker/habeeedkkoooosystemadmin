import { DomainError } from './errors';
import { MINUTE } from './time';

/**
 * A session is a list of contiguous segments. Every change (pause, resume, mode switch,
 * transfer to another station) closes the current segment and opens a new one, so the
 * bill can price each stretch of time with the rate that applied to it.
 */

export type SessionKind = 'open' | 'fixed';

export interface Segment {
  stationId: string;
  mode: string;
  paused: boolean;
  startedAt: number;
  endedAt: number | null;
}

export interface SessionTimeline {
  kind: SessionKind;
  /** Fixed sessions only: planned play time, excluding pauses. */
  plannedMinutes: number | null;
  /** A package the customer explicitly bought for this session. */
  packageId?: string | null;
  segments: Segment[];
}

export type SessionAction =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'mode'; mode: string }
  | { type: 'transfer'; stationId: string }
  | { type: 'end' };

export type LiveStatus = 'active' | 'paused' | 'ending' | 'overtime' | 'ended';

export function currentSegment(segments: readonly Segment[]): Segment | undefined {
  const last = segments.at(-1);
  return last && last.endedAt === null ? last : undefined;
}

/**
 * What an action does to the timeline: which segment closes at `now` and which one opens.
 * Pure — the server persists the result, the tests assert it.
 */
export function planAction(
  segments: readonly Segment[],
  action: SessionAction,
  now: number,
): { close: Segment; open: Segment | null } {
  const cur = currentSegment(segments);
  if (!cur) throw new DomainError('session_not_running', 'Session is not running');
  if (now < cur.startedAt) throw new DomainError('clock_skew', 'Action time is before the current segment start');

  const close: Segment = { ...cur, endedAt: now };
  const next = (patch: Partial<Segment>): Segment => ({ ...cur, ...patch, startedAt: now, endedAt: null });

  switch (action.type) {
    case 'pause':
      if (cur.paused) throw new DomainError('already_paused', 'Session is already paused');
      return { close, open: next({ paused: true }) };
    case 'resume':
      if (!cur.paused) throw new DomainError('not_paused', 'Session is not paused');
      return { close, open: next({ paused: false }) };
    case 'mode':
      if (action.mode === cur.mode) throw new DomainError('same_mode', 'Session is already in this mode');
      return { close, open: next({ mode: action.mode }) };
    case 'transfer':
      if (action.stationId === cur.stationId) throw new DomainError('same_station', 'Session is already on this station');
      return { close, open: next({ stationId: action.stationId }) };
    case 'end':
      return { close, open: null };
  }
}

/** Apply an action to an in-memory timeline (client previews and tests). */
export function applyAction(segments: readonly Segment[], action: SessionAction, now: number): Segment[] {
  const { close, open } = planAction(segments, action, now);
  const out = [...segments.slice(0, -1), close];
  if (open) out.push(open);
  return out;
}

export function playedAndPaused(segments: readonly Segment[], asOf: number): { playedMs: number; pausedMs: number } {
  let playedMs = 0;
  let pausedMs = 0;
  for (const s of segments) {
    const end = Math.min(s.endedAt ?? asOf, asOf);
    const len = Math.max(0, end - s.startedAt);
    if (s.paused) pausedMs += len;
    else playedMs += len;
  }
  return { playedMs, pausedMs };
}

export function liveState(
  timeline: SessionTimeline,
  asOf: number,
  endingSoonMinutes: number,
): { status: LiveStatus; playedMs: number; pausedMs: number; remainingMs: number | null; overtimeMs: number } {
  const { playedMs, pausedMs } = playedAndPaused(timeline.segments, asOf);
  const cur = currentSegment(timeline.segments);
  const remainingMs =
    timeline.kind === 'fixed' && timeline.plannedMinutes != null ? timeline.plannedMinutes * MINUTE - playedMs : null;
  const overtimeMs = remainingMs != null && remainingMs < 0 ? -remainingMs : 0;

  let status: LiveStatus;
  if (!cur) status = 'ended';
  else if (cur.paused) status = 'paused';
  else if (remainingMs != null && remainingMs <= 0) status = 'overtime';
  else if (remainingMs != null && remainingMs <= endingSoonMinutes * MINUTE) status = 'ending';
  else status = 'active';

  return { status, playedMs, pausedMs, remainingMs, overtimeMs };
}
