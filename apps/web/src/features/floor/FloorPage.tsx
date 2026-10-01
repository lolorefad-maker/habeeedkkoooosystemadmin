import { controllerState } from '@lounge/core';
import { clsx } from 'clsx';
import { AlarmClock, BatteryCharging, CalendarPlus, CircleCheck, Gamepad, Gamepad2, Hourglass, LayoutGrid, Search, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { TypeIcon } from '../../components/station/status';
import { Button } from '../../components/ui/button';
import { EmptyState, Kbd, Money, Num, Skeleton } from '../../components/ui/primitives';
import { toast } from 'sonner';
import { toastError } from '../../components/ui/feedback';
import { useT, type TKey } from '../../i18n';
import { post } from '../../lib/api';
import { can, useAuth } from '../../lib/auth';
import { useNow } from '../../lib/clock';
import { useFmt } from '../../lib/format';
import { rateNow, sessionBill, stationViews, useBillingContext, type StationView } from '../../lib/live';
import { useFloor } from '../../lib/queries';
import type { FloorSession } from '../../lib/types';
import { CheckoutDialog } from '../checkout/CheckoutDialog';
import { NewReservation, ReservationDetails } from '../reservations/ReservationsPage';
import { QuickDiscountBar, QuickDiscountButton } from './QuickDiscount';
import { StationCard } from './StationCard';
import { StationSheet } from './StationSheet';
import { StockButton } from './StockButton';

type Filter = 'all' | string;
type StatusFilter = 'all' | 'playing' | 'free' | 'ending' | 'overtime';
const NONE: number[] = [];
const PLAYING = new Set(['active', 'paused', 'ending', 'overtime']);

const matchesStatus = (f: StatusFilter, status: string) =>
  f === 'all' || (f === 'playing' ? PLAYING.has(status) : status === f);

export function FloorPage() {
  const { t, tk } = useT();
  const role = useAuth((s) => s.user?.role);
  const f = useFmt();
  const floor = useFloor();
  const now = useNow();
  const ctx = useBillingContext(floor.data);
  const [selected, setSelected] = useState<{ stationId?: string; sessionId?: string } | null>(null);
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  // Phone bookings from the floor: a new one (optionally for a station), or an existing one to check in / cancel.
  const [booking, setBooking] = useState<{ stationId?: string } | null>(null);
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();

  // Deep link from a "time's up" alert: /floor?station=<id> opens that station's sheet.
  useEffect(() => {
    const stationId = params.get('station');
    if (!stationId) return;
    setSelected({ stationId });
    const next = new URLSearchParams(params);
    next.delete('station');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const views = useMemo(() => (floor.data && ctx ? stationViews(floor.data, ctx, now) : []), [floor.data, ctx, now]);
  const unpaid = useMemo(() => floor.data?.sessions.filter((s) => s.status === 'ended') ?? [], [floor.data]);

  // "/" focuses search (cashier keyboard flow), Esc clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filterOptions = useMemo(() => {
    const stations = floor.data?.stations ?? [];
    const opts: { value: Filter; label: string; icon?: string }[] = [{ value: 'all', label: t('common.all') }];
    for (const type of [...new Set(stations.map((s) => s.type))]) opts.push({ value: `type:${type}`, label: tk('types', type), icon: type });
    if (stations.some((s) => s.tier === 'vip')) opts.push({ value: 'tier:vip', label: 'VIP' });
    return opts;
  }, [floor.data, t, tk]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return views.filter((v) => {
      if (filter.startsWith('type:') && v.station.type !== filter.slice(5)) return false;
      if (filter.startsWith('tier:') && v.station.tier !== filter.slice(5)) return false;
      if (!matchesStatus(statusFilter, v.status)) return false;
      if (needle && !v.station.name.toLowerCase().includes(needle) && !(v.session?.label ?? '').toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [views, filter, statusFilter, q]);

  const zones = useMemo(() => {
    const map = new Map<string, StationView[]>();
    for (const v of visible) {
      const z = v.station.zone || '';
      map.set(z, [...(map.get(z) ?? []), v]);
    }
    return [...map.entries()];
  }, [visible]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: views.length, playing: 0, free: 0, ending: 0, overtime: 0 };
    for (const v of views) {
      for (const k of ['playing', 'free', 'ending', 'overtime'] as const) if (matchesStatus(k, v.status)) c[k]++;
    }
    return c;
  }, [views]);

  const rateLabels = useMemo(() => {
    if (!ctx || !floor.data) return new Map<string, string | null>();
    // The exact time, not the start of the minute: a discount started mid-minute must show at once.
    return new Map(
      floor.data.stations.map((s) => {
        const q = rateNow(ctx, s, s.modes[0] ?? 'single', now);
        return [s.id, q ? f.rate(q.perHour) : null];
      }),
    );
    // Every tick: a rule that starts or ends (a discount, a happy hour) must show within a second.
  }, [ctx, floor.data, now, f]);

  const open = useCallback((stationId: string) => setSelected({ stationId }), []);

  // Pause / resume straight from the card. Reversible, so no confirm — an "undo" on the notice instead.
  const togglePause = useCallback(
    async (v: StationView) => {
      if (!v.session) return;
      const id = v.session.id;
      const name = v.station.name;
      const pausing = v.status !== 'paused';
      try {
        await post(`/api/sessions/${id}/action`, { type: pausing ? 'pause' : 'resume' });
        if (pausing) {
          toast(t('floor.pausedToast', { name }), {
            action: { label: t('common.undo'), onClick: () => void post(`/api/sessions/${id}/action`, { type: 'resume' }).catch(toastError) },
          });
        } else {
          toast.success(t('floor.resumedToast', { name }));
        }
      } catch (err) {
        toastError(err);
      }
    },
    [t],
  );
  const canPause = can.manageSessions(role);

  const controllersByStation = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const c of floor.data?.controllers ?? []) {
      if (!c.stationId) continue;
      map.set(c.stationId, [...(map.get(c.stationId) ?? []), c.number].sort((a, b) => a - b));
    }
    return map;
  }, [floor.data]);

  const ctrlCounts = useMemo(() => {
    let ready = 0;
    let charging = 0;
    for (const c of floor.data?.controllers ?? []) {
      const s = controllerState(c, now);
      if (s === 'spare') ready++;
      else if (s === 'charging') charging++;
    }
    return { ready, charging };
  }, [floor.data, now]);

  if (floor.isLoading || !ctx) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 p-4 md:p-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-[148px]" />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-5 p-4 md:p-6">
      {floor.data && <QuickDiscountBar floor={floor.data} now={now} />}

      {/* The floor at a glance; each number is also a filter (tap "Overtime" to see only those). */}
      <div role="radiogroup" aria-label={t('common.status')} className="grid grid-cols-3 gap-2 sm:grid-cols-5 sm:gap-3">
        {STATUS_CHIPS.map((c) => (
          <StatusChip
            key={c.id}
            icon={<c.icon />}
            status={c.status}
            label={t(c.label)}
            count={counts[c.id]}
            on={statusFilter === c.id}
            onClick={() => setStatusFilter(statusFilter === c.id ? 'all' : c.id)}
          />
        ))}
      </div>

      {/* Awaiting payment */}
      {unpaid.length > 0 && (
        <section aria-label={t('floor.unpaidTitle')}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <span data-status="unpaid" className="st-fg flex shrink-0 items-center gap-1.5 text-sm font-semibold">
              <Wallet className="size-4" />
              {t('floor.unpaidTitle')}
              <Num className="st-soft rounded-full px-2 text-xs">{unpaid.length}</Num>
            </span>
            <div className="flex min-w-0 gap-3 overflow-x-auto pb-1">
              {unpaid.map((s) => (
                <UnpaidChip
                  key={s.id}
                  session={s}
                  stationName={floor.data!.stations.find((x) => x.id === s.stationId)?.name ?? ''}
                  total={(sessionBill(s, ctx, now)?.total ?? 0) + s.itemsTotal - s.paid}
                  onOpen={() => setSelected({ sessionId: s.id })}
                  onPay={() => setCheckoutId(s.id)}
                />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Toolbar: find & filter on one side, the owner's tools on the other */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative sm:w-72 sm:shrink-0">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (setQ(''), e.currentTarget.blur())}
              placeholder={t('floor.searchPlaceholder')}
              className="h-10 w-full rounded-control border border-line bg-surface-1 pe-10 ps-9 text-base shadow-[var(--shadow-card)] placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 sm:text-sm"
            />
            <span className="absolute end-3 top-1/2 hidden -translate-y-1/2 md:block">
              <Kbd>/</Kbd>
            </span>
          </div>
          {filterOptions.length > 2 && (
            <div className="flex max-w-full items-center gap-1 self-start overflow-x-auto rounded-full border border-line bg-surface-1 p-1 shadow-[var(--shadow-card)] sm:self-auto">
              {filterOptions.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setFilter(o.value)}
                  aria-pressed={filter === o.value}
                  className={clsx(
                    'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors',
                    filter === o.value ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
                  )}
                >
                  {o.icon && <TypeIcon type={o.icon} className="size-4" />}
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          {can.reservations(role) && (
            <button
              onClick={() => setBooking({})}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-1 px-3.5 text-sm font-medium text-muted shadow-[var(--shadow-card)] hover:border-st-reserved/60 hover:text-st-reserved"
            >
              <CalendarPlus className="size-4" />
              {t('floor.book')}
            </button>
          )}
          <Link
            to="/controllers"
            className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-line bg-surface-1 px-3.5 text-sm font-medium text-muted shadow-[var(--shadow-card)] hover:text-fg"
          >
            <Gamepad className="size-4" />
            <span data-status="free" className="st-fg">
              <Num>{ctrlCounts.ready}</Num> {t('controllers.ready')}
            </span>
            {ctrlCounts.charging > 0 && (
              <span data-status="ending" className="st-fg flex items-center gap-1">
                · <BatteryCharging className="size-3.5" />
                <Num>{ctrlCounts.charging}</Num>
              </span>
            )}
          </Link>
          {can.reports(role) && <StockButton />}
          {can.settings(role) && floor.data && <QuickDiscountButton floor={floor.data} ctx={ctx} now={now} />}
        </div>
      </div>

      {/* Stations by zone */}
      {views.length === 0 ? (
        <EmptyState icon={<LayoutGrid />} title={t('floor.empty')} />
      ) : visible.length === 0 ? (
        <EmptyState icon={<Search />} title={t('floor.noMatch')} action={<Button onClick={() => (setQ(''), setFilter('all'), setStatusFilter('all'))}>{t('common.all')}</Button>} />
      ) : (
        zones.map(([zone, list]) => (
          <section key={zone || '_'} aria-label={zone}>
            {zone && (
              <h2 className="sticky top-0 z-10 -mx-1 mb-2 flex items-center gap-3 bg-bg/85 px-1 py-1.5 backdrop-blur">
                <span className="text-base font-bold">{zone}</span>
                <span className="text-xs font-medium text-muted">
                  {t('floor.zoneSummary', {
                    busy: list.filter((v) => PLAYING.has(v.status)).length,
                    free: list.filter((v) => v.status === 'free').length,
                  })}
                </span>
              </h2>
            )}
            {/* Phones: two per row so the whole shop fits in a short scroll. */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))] sm:gap-3">
              {list.map((v) => (
                <StationCard
                  key={v.station.id}
                  view={v}
                  rateLabel={rateLabels.get(v.station.id) ?? null}
                  controllers={controllersByStation.get(v.station.id) ?? NONE}
                  onOpen={open}
                  onTogglePause={canPause ? togglePause : undefined}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <StationSheet
        target={selected}
        onClose={() => setSelected(null)}
        onCheckout={(sessionId) => {
          setSelected(null);
          setCheckoutId(sessionId);
        }}
        onBook={(stationId) => {
          setSelected(null);
          setBooking({ stationId });
        }}
        onReservation={(r) => {
          setSelected(null);
          setBookingId(r.id);
        }}
      />
      <CheckoutDialog sessionId={checkoutId} onClose={() => setCheckoutId(null)} />
      {floor.data && booking && (
        <NewReservation open onOpenChange={(o) => !o && setBooking(null)} floor={floor.data} initialStationId={booking.stationId} />
      )}
      {floor.data && bookingId && floor.data.reservations.some((r) => r.id === bookingId) && (
        <ReservationDetails r={floor.data.reservations.find((r) => r.id === bookingId)!} floor={floor.data} onClose={() => setBookingId(null)} />
      )}
    </div>
  );
}

const STATUS_CHIPS: { id: StatusFilter; status: string | null; label: TKey; icon: typeof LayoutGrid }[] = [
  { id: 'all', status: null, label: 'floor.kpiAll', icon: LayoutGrid },
  { id: 'playing', status: 'active', label: 'floor.kpiActive', icon: Gamepad2 },
  { id: 'free', status: 'free', label: 'floor.kpiFree', icon: CircleCheck },
  { id: 'ending', status: 'ending', label: 'floor.kpiEnding', icon: Hourglass },
  { id: 'overtime', status: 'overtime', label: 'floor.kpiOver', icon: AlarmClock },
];

/** A count you can read from across the counter, and a one-tap filter for it. */
function StatusChip({
  icon,
  status,
  label,
  count,
  on,
  onClick,
}: {
  icon: React.ReactNode;
  status: string | null;
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-status={status ?? undefined}
      onClick={onClick}
      className={clsx(
        'flex min-h-14 items-center gap-2.5 rounded-card border px-3 py-2 text-start transition-colors sm:gap-3 sm:px-3.5',
        on
          ? status
            ? 'tint-strong'
            : 'border-accent bg-accent/8'
          : 'border-line bg-surface-1 shadow-[var(--shadow-card)] hover:border-line-strong',
        !on && status && count === 0 && 'opacity-60',
      )}
    >
      <span
        className={clsx(
          'hidden size-9 shrink-0 place-items-center rounded-lg sm:grid [&_svg]:size-[18px]',
          // Same look as the cards: busy states filled solid, "available" green.
          status && status !== 'free' ? 'bg-[var(--fill)] text-on-fill' : status ? 'st-soft' : on ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-muted',
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <Num className={clsx('text-xl font-semibold', status && count > 0 && status !== 'active' && 'st-fg')}>{count}</Num>
        <span className="truncate text-xs text-muted">{label}</span>
      </span>
    </button>
  );
}

function UnpaidChip({
  session,
  stationName,
  total,
  onOpen,
  onPay,
}: {
  session: FloorSession;
  stationName: string;
  total: number;
  onOpen: () => void;
  onPay: () => void;
}) {
  const { t } = useT();
  const f = useFmt();
  return (
    <div data-status="unpaid" className="tint flex shrink-0 items-center gap-3 rounded-card border py-2 pe-2 ps-3.5">
      <button onClick={onOpen} className="flex flex-col items-start text-start">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <Hourglass className="st-fg size-3.5" />
          <span className="num">{stationName}</span>
          {session.label && <span className="font-normal text-muted">· {session.label}</span>}
        </span>
        <span className="text-xs text-muted">{session.endedAt && t('session.ended', { time: f.time(session.endedAt) })}</span>
      </button>
      <Money value={Math.max(0, total)} className="text-base font-semibold" />
      <Button size="sm" variant="primary" onClick={onPay}>
        {t('floor.pay')}
      </Button>
    </div>
  );
}
