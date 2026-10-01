import type { Minor } from './money';

/** End-of-day (Z) report. Built by the server, rendered by the web app, stored when the day closes. */
export interface DayReport {
  day: string;
  status: 'open' | 'closed';
  generatedAt: number;
  openedAt: number;
  closedAt: number | null;
  auto: boolean;
  currency: { code: string; decimals: number };

  /**
   * What the shop earned on this day. A session that runs past the day's end is split: what it had
   * played and taken by the end counts here (`carriedIn`), the rest on the day it is paid — where
   * that day's bills leave out what was already counted (`carriedOut`). Money itself (`payments`)
   * is always the day it was received.
   */
  revenue: {
    bills: number;
    time: Minor;
    items: Minor;
    discounts: Minor;
    rounding: Minor;
    total: Minor;
    /** Earned here by sessions still open when the day closed (paid on a later day). */
    carriedIn?: Minor;
    /** Part of this day's bills already counted on an earlier day. */
    carriedOut?: Minor;
  };
  payments: {
    byMethod: Record<string, Minor>;
    deposits: Minor;
    refunds: Minor;
    /** Money that actually moved today (all methods, deposits included, refunds subtracted). */
    net: Minor;
  };
  stations: { stationId: string; name: string; type: string; tier: string; minutes: number; amount: Minor }[];
  products: { productId: string; name: string; qty: number; amount: Minor }[];
  voids: { count: number; amount: Minor };
  reservations: { total: number; completed: number; cancelled: number; noShows: number; fees: Minor };
  openSessions: { count: number; runningValue: Minor };
  shifts: {
    id: string;
    userName: string;
    openedAt: number;
    closedAt: number | null;
    openingFloat: Minor;
    expectedCash: Minor | null;
    countedCash: Minor | null;
    variance: Minor | null;
    /** Closed by the system at the day's end (drawer not counted; the cash carried to the next shift). */
    auto?: boolean;
  }[];
  stock: { productId: string; name: string; expected: number; counted: number; variance: number }[];
}
