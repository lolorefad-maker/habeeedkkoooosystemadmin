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

  revenue: {
    bills: number;
    time: Minor;
    items: Minor;
    discounts: Minor;
    rounding: Minor;
    total: Minor;
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
  }[];
  stock: { productId: string; name: string; expected: number; counted: number; variance: number }[];
}
