import type { DayReport } from '@lounge/core';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import { useAuth } from './auth';
import type { CustomerLookup, Floor, LedgerRow, MonthReport, RangeReport, Product, Reservation, Reward, SessionBill, Shift, Station, StockMovement } from './types';

/** The floor snapshot is the heartbeat of the app: refetched on every live event. */
export function useFloor() {
  const token = useAuth((s) => s.token);
  return useQuery({
    queryKey: ['floor'],
    queryFn: () => get<Floor>('/api/floor'),
    enabled: !!token,
    refetchInterval: 60_000,
  });
}

export const useBranch = () => useFloor().data?.branch;

export function useProducts() {
  return useQuery({ queryKey: ['products'], queryFn: () => get<Product[]>('/api/products'), staleTime: 30_000 });
}

export function useSessionBill(id: string | null) {
  return useQuery({
    queryKey: ['session-bill', id],
    queryFn: () => get<SessionBill>(`/api/sessions/${id}/bill`),
    enabled: !!id,
  });
}

export function useRewards(status: 'all' | 'available' | 'used' | 'void' = 'all') {
  return useQuery({ queryKey: ['rewards', status], queryFn: () => get<Reward[]>(`/api/rewards?status=${status}`) });
}

/** Who is behind this number — and does a free hour wait for them? Only asks once the number looks complete. */
export function useCustomerLookup(phone: string, enabled: boolean) {
  const digits = phone.replace(/\D/g, '');
  return useQuery({
    queryKey: ['customer', digits],
    queryFn: () => get<CustomerLookup | null>(`/api/customers/lookup?phone=${encodeURIComponent(phone)}`),
    enabled: enabled && digits.length >= 9,
  });
}

export function useReservations(from: number, to: number) {
  return useQuery({
    queryKey: ['reservations', from, to],
    queryFn: () => get<Reservation[]>(`/api/reservations?from=${from}&to=${to}`),
  });
}

export function useShift() {
  return useQuery({ queryKey: ['shift'], queryFn: () => get<{ shift: Shift | null }>('/api/shifts/current') });
}

export function useDays(enabled = true) {
  return useQuery({
    queryKey: ['days'],
    queryFn: () => get<{ day: string; status: 'open' | 'closed'; auto: boolean; openedAt: string; closedAt: string | null }[]>('/api/days'),
    enabled,
  });
}

export function useDayReport(day: string | null, enabled = true) {
  return useQuery({
    queryKey: ['report', day],
    queryFn: () => get<DayReport>(`/api/reports/day${day ? `?day=${day}` : ''}`),
    enabled,
  });
}

/** All active products with their stock (tracked ones first). */
export function useStock(enabled = true) {
  return useQuery({ queryKey: ['stock'], queryFn: () => get<Product[]>('/api/stock'), enabled });
}

export function useMovements(productId: string | null, limit = 50) {
  return useQuery({
    queryKey: ['movements', productId, limit],
    queryFn: () => get<StockMovement[]>(`/api/stock/movements?limit=${limit}${productId ? `&productId=${productId}` : ''}`),
  });
}

export function useSessionsLog(day: string | null) {
  return useQuery({
    queryKey: ['sessions-log', day],
    queryFn: () => get<LedgerRow[]>(`/api/reports/sessions?day=${day}`),
    enabled: !!day,
  });
}

/** Any period of business days, both ends included (null = not ready yet). */
export function useRangeReport(from: string | null, to: string | null) {
  return useQuery({
    queryKey: ['range', from, to],
    queryFn: () => get<RangeReport>(`/api/reports/range?from=${from}&to=${to}`),
    enabled: !!from && !!to,
    placeholderData: (prev) => prev,
    retry: false,
  });
}

export function useMonthReport(month: string) {
  return useQuery({
    queryKey: ['month', month],
    queryFn: () => get<MonthReport>(`/api/reports/month?month=${month}`),
    placeholderData: (prev) => prev,
  });
}

export interface SettingsBundle {
  branch: Floor['branch'] & { settings: Floor['branch']['settings'] };
  stations: Station[];
  rules: Floor['rules'];
  packages: Floor['packages'];
  products: Product[];
  staff: { id: string; name: string; role: 'owner' | 'manager' | 'cashier' | 'waiter'; active: boolean; branchId: string | null }[];
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => get<SettingsBundle>('/api/settings') });
}

export interface AuditEntry {
  id: string;
  type: string;
  entity: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  actorId: string | null;
  actorName: string | null;
  approverName: string | null;
  reason: string | null;
  createdAt: number;
}

export function useAudit(enabled = true) {
  return useQuery({ queryKey: ['audit'], queryFn: () => get<AuditEntry[]>('/api/audit?limit=300'), enabled });
}
