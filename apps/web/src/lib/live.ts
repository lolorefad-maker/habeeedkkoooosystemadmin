import {
  computeTimeBill,
  isHolding,
  liveState,
  pricePackageSchema,
  pricingRuleSchema,
  quoteRate,
  type BillingContext,
  type LiveStatus,
  type TimeBill,
} from '@lounge/core';
import { useMemo } from 'react';
import type { Floor, FloorSession, Reservation, Station } from './types';

export type UiStatus = 'free' | 'active' | 'ending' | 'overtime' | 'paused' | 'reserved' | 'off';

export interface StationView {
  station: Station;
  status: UiStatus;
  session: FloorSession | null;
  bill: TimeBill | null;
  live: ReturnType<typeof liveState> | null;
  /** Reservation holding the station now, or the next one today. */
  reservation: Reservation | null;
  holding: boolean;
}

/** Billing context built once per floor snapshot (rules & packages validated by the same schemas as the server). */
export function useBillingContext(floor: Floor | undefined): BillingContext | null {
  return useMemo(() => {
    if (!floor) return null;
    const rules = floor.rules.flatMap((r) => {
      const p = pricingRuleSchema.safeParse(r);
      return p.success ? [p.data] : [];
    });
    const packages = floor.packages.flatMap((r) => {
      const p = pricePackageSchema.safeParse(r);
      return p.success ? [p.data] : [];
    });
    return {
      tz: floor.branch.timezone,
      stations: Object.fromEntries(floor.stations.map((s) => [s.id, { id: s.id, type: s.type, tier: s.tier }])),
      rules,
      packages,
      policy: floor.branch.settings.billing,
    };
  }, [floor]);
}

export function sessionBill(s: FloorSession, ctx: BillingContext, now: number): TimeBill | null {
  try {
    return computeTimeBill(
      { kind: s.kind, plannedMinutes: s.plannedMinutes, packageId: s.packageId, segments: s.segments },
      ctx,
      s.status === 'running' ? now : (s.endedAt ?? now),
    );
  } catch {
    return null;
  }
}

export function stationViews(floor: Floor, ctx: BillingContext, now: number): StationView[] {
  const policy = floor.branch.settings;
  return floor.stations
    .filter((s) => s.active)
    .map((station) => {
      const session = floor.sessions.find((x) => x.status === 'running' && x.stationId === station.id) ?? null;
      const upcoming = floor.reservations
        .filter((r) => r.stationId === station.id && r.status === 'confirmed')
        .sort((a, b) => a.startAt - b.startAt);
      const holdingRes = upcoming.find((r) => isHolding(r, now, policy.reservations)) ?? null;
      const nextRes = holdingRes ?? upcoming.find((r) => r.startAt > now) ?? null;

      let status: UiStatus = 'free';
      let bill: TimeBill | null = null;
      let live: StationView['live'] = null;
      if (station.maintenance) status = 'off';
      else if (session) {
        const tl = { kind: session.kind, plannedMinutes: session.plannedMinutes, packageId: session.packageId, segments: session.segments };
        live = liveState(tl, now, policy.billing.endingSoonMinutes);
        bill = sessionBill(session, ctx, now);
        status = mapLive(live.status);
      } else if (holdingRes) status = 'reserved';

      return { station, status, session, bill, live, reservation: nextRes, holding: !!holdingRes };
    });
}

function mapLive(s: LiveStatus): UiStatus {
  return s === 'ended' ? 'free' : s;
}

export function rateNow(ctx: BillingContext, station: Station, mode: string, now: number) {
  return quoteRate(ctx.rules, { id: station.id, type: station.type, tier: station.tier }, mode, now, ctx.tz);
}
