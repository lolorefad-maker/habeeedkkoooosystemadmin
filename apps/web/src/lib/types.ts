import type { BranchSettings, CheckoutTotals, Segment, TimeBill } from '@lounge/core';

export interface Station {
  id: string;
  branchId: string;
  name: string;
  type: string;
  tier: string;
  zone: string;
  modes: string[];
  sort: number;
  maintenance: boolean;
  maintenanceNote: string | null;
  active: boolean;
}

export interface FloorSession {
  id: string;
  kind: 'open' | 'fixed';
  status: 'running' | 'ended';
  stationId: string;
  plannedMinutes: number | null;
  packageId: string | null;
  label: string | null;
  reservationId: string | null;
  startedAt: number;
  endedAt: number | null;
  itemsCount: number;
  itemsTotal: number;
  paid: number;
  paidByMethod: Record<string, number>;
  segments: Segment[];
  /** Already counted in an earlier day's income (it ran past that day's end) — the ledger only. */
  carried?: { time: number; items: number };
}

export interface Controller {
  id: string;
  number: number;
  stationId: string | null;
  status: 'ready' | 'charging' | 'broken';
  chargingSince: number | null;
  readyAt: number | null;
  note: string | null;
}

export type ReservationStatus = 'confirmed' | 'checked_in' | 'cancelled' | 'no_show' | 'completed';

export interface Reservation {
  id: string;
  stationId: string;
  customerName: string;
  customerPhone: string | null;
  startAt: number;
  minutes: number;
  mode: string;
  deposit: number;
  status: ReservationStatus;
  sessionId: string | null;
  fee: number;
  refunded: number;
  note: string | null;
}

export interface BranchInfo {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  currencyDecimals: number;
  locale: string;
  settings: BranchSettings;
}

export interface Shift {
  id: string;
  userId: string;
  userName: string;
  openedAt: string;
  openingFloat: number;
  byMethod: Record<string, number>;
  refunds: number;
  transactions: number;
  expectedCash: number;
  status: 'open' | 'closed';
}

export interface RawRule {
  id: string;
  /** manual = Settings → Pricing; quick = the owner's one-tap "discount now". */
  source?: 'manual' | 'quick';
  name: string;
  priority: number;
  active: boolean;
  match: Record<string, unknown>;
  effect: Record<string, unknown>;
}

export interface RawPackage {
  id: string;
  name: string;
  minutes: number;
  price: number;
  active: boolean;
  match: Record<string, unknown>;
}

export interface Floor {
  now: number;
  day: string;
  branch: BranchInfo;
  shift: Shift | null;
  stations: Station[];
  /** Drawers the day's end closed by itself (midnight) that nobody counted yet. */
  uncountedShifts?: { id: string; userName: string; businessDay: string; closedAt: number | null; expectedCash: number }[];
  /** Deleted stations (id + name only), so old bookings still name their station. */
  archivedStations?: { id: string; name: string }[];
  rules: RawRule[];
  packages: RawPackage[];
  reservations: Reservation[];
  sessions: FloorSession[];
  controllers: Controller[];
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  trackStock: boolean;
  stockQty: number;
  lowStockAt: number;
  packSize: number | null;
  active: boolean;
  sort: number;
}

export interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  delta: number;
  reason: 'sale' | 'void' | 'purchase' | 'adjust' | 'count';
  cartons: number | null;
  packSize: number | null;
  unitPrice: number | null;
  note: string | null;
  businessDay: string;
  createdByName: string | null;
  createdAt: number;
}

/** One paid device session in the daily log. */
export interface LedgerRow {
  billId: string;
  number: number;
  stationName: string | null;
  label: string | null;
  startedAt: number | null;
  endedAt: number | null;
  playedMs: number;
  timeCharge: number;
  items: { name: string; qty: number }[];
  itemsTotal: number;
  discount: number;
  total: number;
  paidByMethod: Record<string, number>;
  /** A cafeteria sale (no device). */
  counter?: boolean;
  /** Part of this bill already counted on an earlier day (it ran past that day's end). */
  carriedOutTime?: number;
  carriedOutItems?: number;
  /** Not a bill: this day's share of a session still open when the day ended. */
  carried?: boolean;
  /** For a carried share: when its session was paid (on a later day), the whole bill and how. */
  paidAt?: number | null;
  billTotal?: number | null;
  billPaidByMethod?: Record<string, number> | null;
  voided?: boolean;
}

export interface MonthDay {
  day: string;
  sessions: number;
  time: number;
  items: number;
  discounts: number;
  total: number;
  received: Record<string, number>;
}

export interface MonthReport {
  month: string;
  days: MonthDay[];
  totals: Omit<MonthDay, 'day'>;
}

/** "From day to day": the same rows and totals for any period. */
export interface RangeReport {
  from: string;
  to: string;
  days: MonthDay[];
  totals: Omit<MonthDay, 'day'>;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
  voided: boolean;
  voidReason: string | null;
}

export interface SessionBill {
  time: TimeBill;
  items: (OrderItem & { createdAt: string })[];
  paid: number;
  paidByMethod: Record<string, number>;
  totals: CheckoutTotals;
  session: { id: string; status: string; startedAt: number; endedAt: number | null; label: string | null; stationId: string };
  /** The phone number behind the session, and the free hour waiting for it (with what it is worth on this bill). */
  customer: { id: string; name: string; phone: string } | null;
  reward: { id: string; minutes: number; value: number } | null;
}

/** A free hour earned by a long session, kept for a phone number until it is used. */
export interface Reward {
  id: string;
  customerId: string;
  name: string;
  /** Digits with the country code. */
  phone: string;
  minutes: number;
  playedMinutes: number;
  status: 'available' | 'used' | 'void';
  earnedDay: string;
  earnedAt: number;
  usedAt: number | null;
  /** When WhatsApp was opened with the message (it cannot be known that it was sent). */
  notifiedAt: number | null;
  voidReason: string | null;
}

export interface Customer {
  id: string;
  name: string;
  /** Digits with the country code. */
  phone: string;
  notes: string | null;
  createdAt: number;
  visits: number;
  lastVisitAt: number | null;
  /** Free hours waiting for this number. */
  freeAvailable: number;
}

export interface CustomerLookup {
  phone: string;
  name: string | null;
  available: number;
}

export interface Bill {
  id: string;
  number: number;
  businessDay: string;
  sessionId: string | null;
  timeCharge: number;
  itemsTotal: number;
  discountAmount: number;
  discountReason: string | null;
  rounding: number;
  total: number;
  status: 'paid' | 'void';
  breakdown: {
    time: TimeBill | null;
    items: OrderItem[];
    totals: CheckoutTotals;
    payments: { method: string; amount: number }[];
    prepaidByMethod?: Record<string, number>;
    label?: string | null;
    stationName?: string | null;
    startedAt?: number;
    endedAt?: number;
  };
  createdAt: string;
}
