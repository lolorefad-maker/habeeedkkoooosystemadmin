import { DomainError } from './errors';
import { allocate, type Minor } from './money';
import type { BillingPolicy } from './policies';
import {
  packageMatches,
  quoteRate,
  rateBoundaries,
  type PricePackage,
  type PricingRule,
  type StationInfo,
} from './pricing';
import { currentSegment, playedAndPaused, type SessionTimeline } from './session';
import { HOUR, MINUTE } from './time';

export interface BillingContext {
  tz: string;
  stations: Record<string, StationInfo>;
  rules: PricingRule[];
  packages: PricePackage[];
  policy: BillingPolicy;
}

/** One stretch of play at a single hourly rate. */
export interface BillLine {
  stationId: string;
  mode: string;
  from: number;
  to: number;
  ms: number;
  perHour: number;
  amount: Minor;
  baseRuleId: string | null;
  percentRuleId: string | null;
}

export type AdjustmentReason = 'grace' | 'minimum' | 'rounding' | 'early_end';

export interface TimeBill {
  asOf: number;
  ended: boolean;
  playedMs: number;
  pausedMs: number;
  billableMs: number;
  lines: BillLine[];
  /** Difference between billable and played time (grace, minimum, rounding, early-end rule). */
  adjustment: { reason: AdjustmentReason | null; ms: number; amount: Minor };
  /** Hourly price of the time (lines + adjustment) before packages and caps. */
  subtotal: Minor;
  package: { id: string; name: string; minutes: number; price: Minor; forced: boolean } | null;
  capApplied: boolean;
  /** subtotal − total */
  savings: Minor;
  /** What the customer pays for time. */
  total: Minor;
  currentPerHour: number | null;
  missingRate: boolean;
  remainingMs: number | null;
  overtimeMs: number;
}

interface Piece {
  stationId: string;
  mode: string;
  from: number;
  to: number;
  perHour: number | null;
  baseRuleId: string | null;
  percentRuleId: string | null;
}

function roundMs(ms: number, unitMinutes: number, mode: BillingPolicy['roundingMode']): number {
  const unit = Math.max(1, unitMinutes) * MINUTE;
  const q = ms / unit;
  const eps = 1e-9;
  if (mode === 'down') return Math.floor(q + eps) * unit;
  if (mode === 'nearest') return Math.round(q) * unit;
  return Math.ceil(q - eps) * unit;
}

function station(ctx: BillingContext, id: string): StationInfo {
  const s = ctx.stations[id];
  if (!s) throw new DomainError('unknown_station', `Unknown station ${id}`);
  return s;
}

function buildPieces(timeline: SessionTimeline, ctx: BillingContext, asOf: number): Piece[] {
  const pieces: Piece[] = [];
  for (const seg of timeline.segments) {
    if (seg.paused) continue;
    const start = seg.startedAt;
    const end = Math.min(seg.endedAt ?? asOf, asOf);
    if (end <= start) continue;
    const st = station(ctx, seg.stationId);
    const cuts = [start, ...rateBoundaries(ctx.rules, start, end, ctx.tz), end];
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i]!;
      const to = cuts[i + 1]!;
      const q = quoteRate(ctx.rules, st, seg.mode, from, ctx.tz);
      const piece: Piece = {
        stationId: seg.stationId,
        mode: seg.mode,
        from,
        to,
        perHour: q?.perHour ?? null,
        baseRuleId: q?.baseRuleId ?? null,
        percentRuleId: q?.percentRuleId ?? null,
      };
      const prev = pieces.at(-1);
      if (
        prev &&
        prev.to === piece.from &&
        prev.stationId === piece.stationId &&
        prev.mode === piece.mode &&
        prev.perHour === piece.perHour &&
        prev.baseRuleId === piece.baseRuleId &&
        prev.percentRuleId === piece.percentRuleId
      ) {
        prev.to = piece.to;
      } else {
        pieces.push(piece);
      }
    }
  }
  return pieces;
}

/** Exact (float) cost of play time between offsets [fromMs, toMs); beyond played time, extrapolate at `tailRate`. */
function costOfPlayRange(pieces: Piece[], fromMs: number, toMs: number, tailRate: number): number {
  if (toMs <= fromMs) return 0;
  let offset = 0;
  let cost = 0;
  for (const p of pieces) {
    const len = p.to - p.from;
    const s = Math.max(fromMs, offset);
    const e = Math.min(toMs, offset + len);
    if (e > s) cost += ((p.perHour ?? 0) * (e - s)) / HOUR;
    offset += len;
  }
  if (toMs > offset) cost += (tailRate * (toMs - Math.max(fromMs, offset))) / HOUR;
  return cost;
}

/**
 * Price the time of a session "as if it ended at `asOf`".
 * Works for running sessions (live cost on the floor) and ended ones (the final bill).
 */
export function computeTimeBill(timeline: SessionTimeline, ctx: BillingContext, asOf: number): TimeBill {
  const p = ctx.policy;
  const pieces = buildPieces(timeline, ctx, asOf);
  const { playedMs, pausedMs } = playedAndPaused(timeline.segments, asOf);
  const last = timeline.segments.at(-1);
  const ended = !!last && last.endedAt !== null && last.endedAt <= asOf;
  const cur = currentSegment(timeline.segments);

  const quoteFor = (seg: { stationId: string; mode: string }, t: number) =>
    quoteRate(ctx.rules, station(ctx, seg.stationId), seg.mode, t, ctx.tz);

  // Rate used for time beyond what was actually played (minimums, rounding up, early-end fill).
  const lastPiece = pieces.at(-1);
  let tailRate = lastPiece?.perHour ?? null;
  if (tailRate == null && last) tailRate = quoteFor(last, Math.min(last.endedAt ?? asOf, asOf))?.perHour ?? null;
  let missingRate = pieces.some((x) => x.perHour == null) || (playedMs === 0 && last != null && tailRate == null);
  const rate = tailRate ?? 0;

  // ---- billable time -------------------------------------------------------
  let base = playedMs;
  let reason: AdjustmentReason | null = null;
  const plannedMs = timeline.kind === 'fixed' && timeline.plannedMinutes != null ? timeline.plannedMinutes * MINUTE : null;
  if (plannedMs != null && playedMs < plannedMs) {
    if (p.earlyEnd === 'charge_full') base = plannedMs;
    else if (p.earlyEnd === 'actual_with_min') base = Math.max(playedMs, p.earlyEndMinMinutes * MINUTE);
    if (base > playedMs) reason = 'early_end';
  }

  let billableMs: number;
  if (base === playedMs && p.graceMinutes > 0 && playedMs <= p.graceMinutes * MINUTE) {
    billableMs = 0;
    if (playedMs > 0) reason = 'grace';
  } else {
    const minMs = p.minimumMinutes * MINUTE;
    const withMin = Math.max(base, minMs);
    if (withMin > base && !reason) reason = 'minimum';
    // Rounding down must never undercut the minimum.
    billableMs = Math.max(roundMs(withMin, p.roundingMinutes, p.roundingMode), minMs);
    if (billableMs !== withMin && !reason) reason = 'rounding';
  }

  // ---- normal (hourly) price ------------------------------------------------
  const lineExact = pieces.map((x) => ((x.perHour ?? 0) * (x.to - x.from)) / HOUR);
  const playedExact = lineExact.reduce((a, b) => a + b, 0);
  const normalExact = costOfPlayRange(pieces, 0, billableMs, rate);
  const adjustmentExact = normalExact - playedExact;
  const subtotal = Math.max(0, Math.round(normalExact));
  const amounts = allocate(subtotal, [...lineExact, adjustmentExact]);

  const lines: BillLine[] = pieces.map((x, i) => ({
    stationId: x.stationId,
    mode: x.mode,
    from: x.from,
    to: x.to,
    ms: x.to - x.from,
    perHour: x.perHour ?? 0,
    amount: amounts[i] ?? 0,
    baseRuleId: x.baseRuleId,
    percentRuleId: x.percentRuleId,
  }));
  const adjustment = {
    reason: billableMs !== playedMs ? reason : null,
    ms: billableMs - playedMs,
    amount: amounts[pieces.length] ?? 0,
  };

  // ---- packages & caps ------------------------------------------------------
  let total = subtotal;
  let pkg: TimeBill['package'] = null;
  const withPackage = (pk: PricePackage) =>
    Math.round(pk.price + costOfPlayRange(pieces, pk.minutes * MINUTE, billableMs, rate));

  if (timeline.packageId) {
    const forced = ctx.packages.find((x) => x.id === timeline.packageId);
    if (!forced) throw new DomainError('unknown_package', `Unknown package ${timeline.packageId}`);
    total = withPackage(forced);
    pkg = { id: forced.id, name: forced.name, minutes: forced.minutes, price: forced.price, forced: true };
  } else if (p.autoBestPackage && pieces.length > 0) {
    for (const pk of ctx.packages) {
      if (!pk.active) continue;
      if (!pieces.every((x) => packageMatches(pk, station(ctx, x.stationId), x.mode))) continue;
      const candidate = withPackage(pk);
      if (candidate < total) {
        total = candidate;
        pkg = { id: pk.id, name: pk.name, minutes: pk.minutes, price: pk.price, forced: false };
      }
    }
  }

  let capApplied = false;
  if (p.sessionCap != null && total > p.sessionCap) {
    total = p.sessionCap;
    capApplied = true;
  }

  const currentPerHour = cur && !cur.paused && !ended ? (quoteFor(cur, asOf)?.perHour ?? null) : null;
  if (cur && !cur.paused && currentPerHour == null) missingRate = true;

  return {
    asOf,
    ended,
    playedMs,
    pausedMs,
    billableMs,
    lines,
    adjustment,
    subtotal,
    package: pkg,
    capApplied,
    savings: subtotal - total,
    total,
    currentPerHour,
    missingRate,
    remainingMs: plannedMs != null ? plannedMs - playedMs : null,
    overtimeMs: plannedMs != null ? Math.max(0, playedMs - plannedMs) : 0,
  };
}
