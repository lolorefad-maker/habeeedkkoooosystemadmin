import type { DayReport } from '@lounge/core';
import { clsx } from 'clsx';
import {
  Banknote,
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  CalendarSearch,
  ChevronDown,
  Coffee,
  CreditCard,
  Gamepad2,
  Lock,
  Printer,
  Receipt,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { TypeIcon } from '../../components/station/status';
import { Button } from '../../components/ui/button';
import { Card, Money, Num, Row, SectionTitle, Skeleton } from '../../components/ui/primitives';
import { useT, type TKey } from '../../i18n';
import { can, useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/format';
import { useDayReport, useDays } from '../../lib/queries';
import { DailyLog } from './DailyLog';
import { CountOldShift } from '../../components/shell/ShiftPill';
import { Modal } from '../../components/ui/overlays';
import { EndDayDialog } from './EndDay';
import { MonthlyTab } from './MonthlyTab';
import { RangeTab } from './RangeTab';
import { Stepper } from './Stepper';

type Tab = 'daily' | 'monthly' | 'range';
const TABS: { id: Tab; label: TKey; icon: typeof Receipt }[] = [
  { id: 'daily', label: 'ledger.daily', icon: CalendarDays },
  { id: 'monthly', label: 'ledger.monthly', icon: CalendarRange },
  { id: 'range', label: 'ledger.range', icon: CalendarSearch },
];

/** The ledger ("الجرد"): daily device log + Z report, monthly totals per day, and goods stock. */
export function ReportsPage() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  // Goods moved to their own page ("المخزون"); old links still land there.
  if (params.get('tab') === 'goods') return <Navigate to="/stock" replace />;
  const tab = (params.get('tab') as Tab) || 'daily';
  const day = params.get('day');
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v == null ? p.delete(k) : p.set(k, v));
    setParams(p, { replace: true });
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-6">
      <div className="no-print flex gap-1 self-start rounded-card border border-line bg-surface-1 p-1 shadow-[var(--shadow-card)]" role="tablist">
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => go({ tab: x.id })}
            className={clsx(
              'flex h-10 items-center gap-2 rounded-control px-4 text-sm font-medium transition-colors',
              tab === x.id ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <x.icon className="size-4" />
            {t(x.label)}
          </button>
        ))}
      </div>

      {tab === 'daily' && (
        <DailyTab
          day={day}
          onDay={(d) => go({ day: d })}
          // "/reports?end=1" (from the user menu) opens "End the day" directly.
          endRequested={params.get('end') === '1'}
          // One URL update for both: two back-to-back updates would each start from the old URL.
          onEndHandled={() => go({ end: null, day: null })}
        />
      )}
      {tab === 'monthly' && <MonthlyTab month={month} onMonth={(m) => go({ month: m })} onPickDay={(d) => go({ tab: 'daily', day: d })} />}
      {tab === 'range' && (
        <RangeTab from={params.get('from')} to={params.get('to')} onRange={(from, to) => go({ from, to })} onPickDay={(d) => go({ tab: 'daily', day: d })} />
      )}
    </div>
  );
}

/**
 * Daily: step through business days with ‹ ›, see what came in first (total, cash, visa), then
 * which device was booked from when to when, then the details (Z report).
 */
function DailyTab({
  day,
  onDay,
  endRequested,
  onEndHandled,
}: {
  day: string | null;
  onDay: (d: string | null) => void;
  endRequested: boolean;
  onEndHandled: () => void;
}) {
  const { t } = useT();
  const f = useFmt();
  const role = useAuth((s) => s.user?.role);
  const days = useDays();
  const report = useDayReport(day);
  const [closing, setClosing] = useState(false);
  const [printDay, setPrintDay] = useState<string | null>(null);
  const r = report.data;

  useEffect(() => {
    if (!endRequested) return;
    onEndHandled(); // also switches to today
    if (can.isManager(role)) setClosing(true);
  }, [endRequested, onEndHandled, role]);

  // "Print the day's report" after ending it: show that day, then print once its report is loaded.
  useEffect(() => {
    if (!printDay || r?.day !== printDay || report.isFetching) return;
    setPrintDay(null);
    const id = setTimeout(() => window.print(), 400);
    return () => clearTimeout(id);
  }, [printDay, r?.day, report.isFetching]);

  // Business days oldest → newest; ‹ goes back a day, › forward. The open day is "today".
  const list = useMemo(() => [...(days.data ?? [])].sort((a, b) => a.day.localeCompare(b.day)), [days.data]);
  const current = r?.day ?? day;
  const idx = list.findIndex((d) => d.day === current);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  const go = (d: { day: string; status: string } | null) => d && onDay(d.status === 'open' ? null : d.day);

  return (
    <>
      <div className="no-print flex flex-wrap items-center gap-3">
        <Stepper
          label={r ? f.date(new Date(`${r.day}T12:00:00Z`).getTime()) : '…'}
          prevLabel={t('ledger.prevDay')}
          nextLabel={t('ledger.nextDay')}
          onPrev={prev ? () => go(prev) : undefined}
          onNext={next ? () => go(next) : undefined}
        />
        {r && (
          <span
            data-status={r.status === 'open' ? 'free' : 'off'}
            className="st-soft inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
          >
            {r.status === 'open' ? <CalendarCheck className="size-3.5" /> : <Lock className="size-3.5" />}
            {r.status === 'open' ? t('reports.open') : r.auto ? t('reports.autoClosed') : t('reports.closed')}
          </span>
        )}
        {r && r.status !== 'open' && (
          <Button variant="ghost" size="sm" onClick={() => onDay(null)}>
            {t('common.today')}
          </Button>
        )}
        <div className="flex-1" />
        <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
          {t('common.print')}
        </Button>
        {r?.status === 'open' && can.isManager(role) && (
          <Button variant="primary" icon={<Lock className="size-4" />} onClick={() => setClosing(true)}>
            {t('reports.closeDay')}
          </Button>
        )}
      </div>

      {report.isLoading || !r ? (
        <div className="grid gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
          <Skeleton className="h-64 md:col-span-4" />
        </div>
      ) : (
        <>
          <DaySummary r={r} />
          <DailyLog day={r.day} isOpenDay={r.status === 'open'} />
          <ReportView r={r} />
        </>
      )}

      {r && closing && (
        <EndDayDialog
          report={r}
          onClose={() => setClosing(false)}
          onPrintDay={(d) => {
            setClosing(false);
            onDay(d);
            setPrintDay(d);
          }}
        />
      )}
      <p className="print-only text-center text-xs">{f.dateTime(Date.now())}</p>
    </>
  );
}

/** What the owner asks first: how much came in, and how (cash / visa). */
function DaySummary({ r }: { r: DayReport }) {
  const { t } = useT();
  const f = useFmt();
  const carriedIn = r.revenue.carriedIn ?? 0;
  const carriedOut = r.revenue.carriedOut ?? 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.2fr] lg:gap-4">
      <Card className="relative overflow-hidden p-5">
        <span aria-hidden className="absolute inset-y-0 start-0 w-1 bg-accent" />
        <div className="text-sm text-muted">{t('ledger.dayIncome')}</div>
        <Money value={r.revenue.total} currency className="mt-2 text-4xl font-semibold tracking-tight" />
        <div className="mt-1.5 text-xs text-faint">
          <Num>{r.revenue.bills}</Num> {t('reports.bills')}
          {r.revenue.discounts > 0 && (
            <>
              {' · '}
              {t('reports.discounts')} <Money value={r.revenue.discounts} />
            </>
          )}
        </div>
        {/* A station that was playing when a day ended is split across the two days. */}
        {(carriedIn !== 0 || carriedOut !== 0 || (r.status === 'open' && r.openSessions.runningValue > 0)) && (
          <ul className="mt-2 flex flex-col gap-0.5 text-xs text-muted">
            {carriedIn !== 0 && <li>{t('reports.carriedIn', { amount: f.money(carriedIn) })}</li>}
            {carriedOut !== 0 && <li>{t('reports.carriedOut', { amount: f.money(carriedOut) })}</li>}
            {r.status === 'open' && r.openSessions.runningValue > 0 && (
              <li className="text-st-reserved">{t('reports.runningNow', { amount: f.money(r.openSessions.runningValue) })}</li>
            )}
          </ul>
        )}
      </Card>
      <SummaryTile icon={<Banknote />} label={t('checkout.cash')} value={r.payments.byMethod.cash ?? 0} />
      <SummaryTile icon={<CreditCard />} label={t('checkout.card')} value={r.payments.byMethod.card ?? 0} />
      <Card className="flex flex-col justify-center gap-2 p-5">
        <Row className="!py-0" label={<span className="flex items-center gap-2"><Gamepad2 className="size-4" />{t('reports.time')}</span>} value={<Money value={r.revenue.time} className="font-semibold text-fg" />} />
        <Row className="!py-0" label={<span className="flex items-center gap-2"><Coffee className="size-4" />{t('ledger.drinks')}</span>} value={<Money value={r.revenue.items} className="font-semibold text-fg" />} />
      </Card>
    </div>
  );
}

function SummaryTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-muted [&_svg]:size-4">
        {icon}
        {label}
      </div>
      <Money value={value} className="mt-2 text-2xl font-semibold" />
    </Card>
  );
}

/** The rest of the Z report: busiest devices and best sellers up front; the rarely needed parts on request. */
function ReportView({ r }: { r: DayReport }) {
  const { t, tk } = useT();
  const f = useFmt();
  const [more, setMore] = useState(false);
  const role = useAuth((s) => s.user?.role);
  // A drawer the day's end closed by itself: counted from here afterwards.
  const [counting, setCounting] = useState<DayReport['shifts'][number] | null>(null);
  const maxStation = Math.max(1, ...r.stations.map((s) => s.amount));

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle>{t('reports.stations')}</SectionTitle>
          {r.stations.length === 0 ? (
            <p className="text-sm text-faint">{t('reports.noData')}</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {r.stations.map((s) => (
                <div key={s.stationId} className="grid grid-cols-[96px_1fr_auto] items-center gap-3 text-sm">
                  <span className="flex items-center gap-2 truncate">
                    <TypeIcon type={s.type} className="size-4 text-muted" />
                    <span className="num font-medium">{s.name}</span>
                  </span>
                  <div className="h-2.5 overflow-hidden rounded-full bg-surface-3">
                    <div className={clsx('h-full rounded-full', s.tier === 'vip' ? 'bg-vip' : 'bg-accent')} style={{ width: `${(s.amount / maxStation) * 100}%` }} />
                  </div>
                  <span className="flex items-baseline gap-2">
                    <Num className="text-xs text-faint">{t('reports.minutes', { n: s.minutes })}</Num>
                    <Money value={s.amount} className="w-20 justify-end font-medium" />
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <SectionTitle>{t('reports.products')}</SectionTitle>
          {r.products.length === 0 ? (
            <p className="text-sm text-faint">{t('reports.noData')}</p>
          ) : (
            r.products.slice(0, 10).map((p) => (
              <Row key={p.productId} label={<span><Num className="text-faint">{p.qty}×</Num> {p.name}</span>} value={<Money value={p.amount} />} />
            ))
          )}
          {r.voids.count > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-control bg-danger/8 px-3 py-2 text-sm text-danger">
              <span>
                {t('reports.voids')} (<Num>{r.voids.count}</Num>)
              </span>
              <Money value={r.voids.amount} />
            </div>
          )}
        </Card>
      </div>

      <button
        type="button"
        onClick={() => setMore((v) => !v)}
        aria-expanded={more}
        className="no-print flex items-center justify-center gap-2 self-center rounded-full border border-line bg-surface-1 px-4 py-2 text-sm font-medium text-muted shadow-[var(--shadow-card)] hover:text-fg"
      >
        {more ? t('ledger.lessDetails') : t('ledger.moreDetails')}
        <ChevronDown className={clsx('size-4 transition-transform', more && 'rotate-180')} />
      </button>

      {/* Always printed; on screen only when asked for. */}
      <div className={clsx('flex-col gap-6', more ? 'flex' : 'hidden print:flex')}>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-5">
            <SectionTitle>{t('reports.payments')}</SectionTitle>
            <Row label={<span className="flex items-center gap-2"><Banknote className="size-4" />{t('checkout.cash')}</span>} value={<Money value={r.payments.byMethod.cash ?? 0} />} />
            <Row label={<span className="flex items-center gap-2"><CreditCard className="size-4" />{t('checkout.card')}</span>} value={<Money value={r.payments.byMethod.card ?? 0} />} />
            <Row muted label={t('reports.deposits')} value={<Money value={r.payments.deposits} />} />
            <Row muted label={t('reports.refunds')} value={<span>−<Money value={r.payments.refunds} /></span>} />
            <div className="my-2 h-px bg-line" />
            <Row strong label={t('reports.net')} value={<Money value={r.payments.net} currency />} />
          </Card>

          <Card className="p-5">
            <SectionTitle>{t('reports.shifts')}</SectionTitle>
            {r.shifts.length === 0 ? (
              <p className="text-sm text-faint">{t('reports.noData')}</p>
            ) : (
              r.shifts.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm last:border-0">
                  <div>
                    <div className="font-medium">{s.userName}</div>
                    <div className="text-xs tabular-nums text-faint">
                      {f.time(s.openedAt)} – {s.closedAt ? f.time(s.closedAt) : '…'}
                    </div>
                  </div>
                  {s.variance != null ? (
                    <span data-status={s.variance === 0 ? 'free' : s.variance < 0 ? 'overtime' : 'ending'} className="st-soft rounded-full px-2.5 py-1 text-xs font-semibold">
                      {s.variance === 0 ? t('shift.balanced') : s.variance < 0 ? t('shift.short') : t('shift.over')} {s.variance !== 0 && <Money value={Math.abs(s.variance)} />}
                    </span>
                  ) : s.auto ? (
                    <span className="flex max-w-[60%] flex-col items-end gap-1 text-end text-xs text-faint">
                      {t('reports.autoShift', { time: s.closedAt ? f.time(s.closedAt) : '…' })}
                      {can.shift(role) && (
                        <Button size="sm" variant="warning" onClick={() => setCounting(s)}>
                          {t('reports.countShift')}
                        </Button>
                      )}
                    </span>
                  ) : (
                    <span className="text-xs text-faint">{t('reports.open')}</span>
                  )}
                </div>
              ))
            )}
            <Modal open={!!counting} onOpenChange={(o) => !o && setCounting(null)} title={t('reports.countShift')} size="sm">
              {counting && <CountOldShift s={counting} onDone={() => setCounting(null)} />}
            </Modal>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-5">
            <SectionTitle>{t('reports.reservations')}</SectionTitle>
            <Row label={t('common.total')} value={<Num>{r.reservations.total}</Num>} />
            <Row label={t('reports.completed')} value={<Num>{r.reservations.completed}</Num>} />
            <Row label={t('reports.cancelled')} value={<Num>{r.reservations.cancelled}</Num>} />
            <Row label={t('reports.noShows')} value={<Num>{r.reservations.noShows}</Num>} />
            <Row label={t('reports.fees')} value={<Money value={r.reservations.fees} />} />
            {r.openSessions.count > 0 && (
              <div className="mt-3 rounded-control bg-surface-2 px-3 py-2 text-sm">
                {t('reports.openSessions')}: <Num className="font-semibold">{r.openSessions.count}</Num> · {t('reports.runningValue')} <Money value={r.openSessions.runningValue} />
              </div>
            )}
          </Card>
        </div>

        {r.stock.length > 0 && (
          <Card className="p-5">
            <SectionTitle>{t('reports.stock')}</SectionTitle>
            <table className="w-full text-sm">
              <thead className="text-xs text-faint">
                <tr>
                  <th className="py-1 text-start font-medium">{t('settings.product.name')}</th>
                  <th className="py-1 text-end font-medium">{t('reports.systemQty')}</th>
                  <th className="py-1 text-end font-medium">{t('reports.counted')}</th>
                  <th className="py-1 text-end font-medium">{t('shift.variance')}</th>
                </tr>
              </thead>
              <tbody>
                {r.stock.map((s) => (
                  <tr key={s.productId} className="border-t border-line">
                    <td className="py-2">{s.name}</td>
                    <td className="num py-2 text-end">{s.expected}</td>
                    <td className="num py-2 text-end">{s.counted}</td>
                    <td className={clsx('num py-2 text-end font-semibold', s.variance < 0 ? 'text-danger' : s.variance > 0 ? 'text-st-ending' : 'text-st-free')}>
                      {s.variance > 0 ? `+${s.variance}` : s.variance}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      <p className="text-center text-xs text-faint">
        {tk('status', r.status === 'open' ? 'active' : 'ended')} · {f.dateTime(r.generatedAt)}
      </p>
    </div>
  );
}
