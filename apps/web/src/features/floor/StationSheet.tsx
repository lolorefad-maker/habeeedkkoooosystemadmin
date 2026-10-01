import { liveState } from '@lounge/core';
import { useMemo } from 'react';
import { useNow } from '../../lib/clock';
import { sessionBill, stationViews, useBillingContext } from '../../lib/live';
import { useFloor } from '../../lib/queries';
import type { Reservation } from '../../lib/types';
import { SessionSheet } from './SessionSheet';
import { StartSheet } from './StartSheet';

/**
 * Opens the right sheet for what was tapped: a running/unpaid session, or a free station.
 * The target is resolved live, so when a session starts the sheet flips to the session view.
 */
export function StationSheet({
  target,
  onClose,
  onCheckout,
  onBook,
  onReservation,
}: {
  target: { stationId?: string; sessionId?: string } | null;
  onClose: () => void;
  onCheckout: (sessionId: string) => void;
  /** "Book for later" on a free station (a phone booking). */
  onBook: (stationId: string) => void;
  /** Open a station's booking (check in / cancel). */
  onReservation: (r: Reservation) => void;
}) {
  const floor = useFloor();
  const now = useNow();
  const ctx = useBillingContext(floor.data);

  const view = useMemo(() => {
    if (!target || !floor.data || !ctx) return null;
    const views = stationViews(floor.data, ctx, now);
    if (target.sessionId) {
      const session = floor.data.sessions.find((s) => s.id === target.sessionId);
      if (!session) return null;
      const base = views.find((v) => v.station.id === session.stationId);
      if (!base) return null;
      // An ended (unpaid) session: its own numbers, not whatever now runs on that station.
      const tl = { kind: session.kind, plannedMinutes: session.plannedMinutes, packageId: session.packageId, segments: session.segments };
      return {
        ...base,
        session,
        bill: sessionBill(session, ctx, now),
        live: liveState(tl, session.endedAt ?? now, floor.data.branch.settings.billing.endingSoonMinutes),
      };
    }
    return views.find((v) => v.station.id === target.stationId) ?? null;
  }, [target, floor.data, ctx, now]);

  if (!target || !view || !floor.data || !ctx) return null;
  if (view.session) {
    return <SessionSheet key={view.session.id} view={view} floor={floor.data} ctx={ctx} onClose={onClose} onCheckout={onCheckout} />;
  }
  return <StartSheet key={view.station.id} view={view} floor={floor.data} ctx={ctx} onClose={onClose} onBook={onBook} onReservation={onReservation} />;
}
