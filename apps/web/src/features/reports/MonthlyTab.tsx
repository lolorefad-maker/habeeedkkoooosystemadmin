import { clsx } from 'clsx';
import { Banknote, CreditCard, Trophy } from 'lucide-react';
import { DateTime } from 'luxon';
import { useMemo } from 'react';
import { Button } from '../../components/ui/button';
import { Card, EmptyState, Money, Num, SectionTitle, Skeleton } from '../../components/ui/primitives';
import { intlLocale, usePrefs, useT } from '../../i18n';
import { useFmt } from '../../lib/format';
import { useMonthReport } from '../../lib/queries';
import type { MonthDay } from '../../lib/types';
import { Stepper } from './Stepper';

/** Round an axis maximum up to a clean number whose quarters are also clean (4 gridlines). */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Monthly ledger: what came in each day of the month, with the month's totals. */
export function MonthlyTab({ month, onMonth, onPickDay }: { month: string; onMonth: (m: string) => void; onPickDay: (day: string) => void }) {
  const { t } = useT();
  const f = useFmt();
  const lang = usePrefs((s) => s.lang);
  const report = useMonthReport(month);
  const start = DateTime.fromISO(`${month}-01`);
  const monthLabel = new Intl.DateTimeFormat(intlLocale(lang), { month: 'long', year: 'numeric' }).format(start.toJSDate());
  const shift = (n: number) => onMonth(start.plus({ months: n }).toFormat('yyyy-MM'));
  const thisMonth = DateTime.now().setZone(f.tz).toFormat('yyyy-MM');

  // Every calendar day of the month (up to today for the current month), filled with data where it exists.
  const series: MonthDay[] = useMemo(() => {
    const byDay = new Map((report.data?.days ?? []).map((d) => [d.day, d]));
    const today = DateTime.now().toISODate()!;
    const out: MonthDay[] = [];
    for (let d = start; d.month === start.month; d = d.plus({ days: 1 })) {
      const iso = d.toISODate()!;
      if (iso > today && !byDay.has(iso)) break;
      out.push(byDay.get(iso) ?? { day: iso, sessions: 0, time: 0, items: 0, discounts: 0, total: 0, received: {} });
    }
    return out;
  }, [report.data, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = report.data?.totals;
  const withData = series.filter((d) => d.sessions > 0 || d.total > 0);
  const best = withData.reduce<MonthDay | null>((b, d) => (!b || d.total > b.total ? d : b), null);
  const avg = withData.length ? Math.round((totals?.total ?? 0) / withData.length) : 0;
  const dayName = (iso: string) => f.date(DateTime.fromISO(iso, { zone: f.tz }).set({ hour: 12 }).toMillis());

  return (
    <div className={clsx('flex flex-col gap-6', report.isFetching && report.data && 'opacity-70 transition-opacity')}>
      {/* ‹ September 2026 › — no future months */}
      <div className="flex flex-wrap items-center gap-3">
        <Stepper
          label={monthLabel}
          prevLabel={t('ledger.prevMonth')}
          nextLabel={t('ledger.nextMonth')}
          onPrev={() => shift(-1)}
          onNext={month < thisMonth ? () => shift(1) : undefined}
        />
        {month !== thisMonth && (
          <Button variant="ghost" size="sm" onClick={() => onMonth(thisMonth)}>
            {t('ledger.thisMonth')}
          </Button>
        )}
      </div>

      {!report.data ? (
        <Skeleton className="h-72" />
      ) : withData.length === 0 ? (
        <EmptyState title={t('ledger.noMonth')} />
      ) : (
        <>
          {/* Hero + tiles */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:gap-4">
            <Card className="relative overflow-hidden p-5">
              <span aria-hidden className="absolute inset-y-0 start-0 w-1 bg-accent" />
              <div className="text-sm text-muted">{t('ledger.monthTotal')}</div>
              <Money value={totals!.total} currency className="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl" />
              <div className="mt-2 text-xs text-faint">
                <Num>{totals!.sessions}</Num> {t('ledger.sessions')}
              </div>
            </Card>
            <Tile icon={<Banknote />} label={t('checkout.cash')} value={<Money value={totals!.received.cash ?? 0} />} />
            <Tile icon={<CreditCard />} label={t('checkout.card')} value={<Money value={totals!.received.card ?? 0} />} />
            <Tile
              icon={<Trophy />}
              label={t('ledger.bestDay')}
              value={best ? <Money value={best.total} /> : '—'}
              sub={best ? `${dayName(best.day)} · ${t('ledger.average')} ${f.money(avg)}` : undefined}
            />
          </div>

          {/* Daily revenue, one column per day */}
          <Card className="p-5">
            <SectionTitle>{t('ledger.dailyRevenue')}</SectionTitle>
            <DailyColumns series={series} onPick={onPickDay} dayName={dayName} />
          </Card>

          {/* Table view: every number reachable without hovering */}
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-2 text-xs text-faint">
                <tr>
                  <th className="px-4 py-2.5 text-start font-medium">{t('ledger.day')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('ledger.sessions')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('ledger.time')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('ledger.drinks')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('ledger.total')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('checkout.cash')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('checkout.card')}</th>
                </tr>
              </thead>
              <tbody>
                {withData.map((d) => (
                  <tr key={d.day} onClick={() => onPickDay(d.day)} className="cursor-pointer border-b border-line/70 hover:bg-surface-2">
                    <td className="px-4 py-2.5 font-medium">{dayName(d.day)}</td>
                    <td className="num px-4 py-2.5 text-end">{d.sessions}</td>
                    <td className="px-4 py-2.5 text-end"><Money value={d.time} className="justify-end" /></td>
                    <td className="px-4 py-2.5 text-end"><Money value={d.items} className="justify-end" /></td>
                    <td className="px-4 py-2.5 text-end font-semibold"><Money value={d.total} className="justify-end" /></td>
                    <td className="px-4 py-2.5 text-end text-muted"><Money value={d.received.cash ?? 0} className="justify-end" /></td>
                    <td className="px-4 py-2.5 text-end text-muted"><Money value={d.received.card ?? 0} className="justify-end" /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-surface-2 font-semibold">
                <tr>
                  <td className="px-4 py-3">{t('common.total')}</td>
                  <td className="num px-4 py-3 text-end">{totals!.sessions}</td>
                  <td className="px-4 py-3 text-end"><Money value={totals!.time} className="justify-end" /></td>
                  <td className="px-4 py-3 text-end"><Money value={totals!.items} className="justify-end" /></td>
                  <td className="px-4 py-3 text-end"><Money value={totals!.total} currency className="justify-end" /></td>
                  <td className="px-4 py-3 text-end"><Money value={totals!.received.cash ?? 0} className="justify-end" /></td>
                  <td className="px-4 py-3 text-end"><Money value={totals!.received.card ?? 0} className="justify-end" /></td>
                </tr>
              </tfoot>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function Tile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-muted [&_svg]:size-4">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-1 truncate text-xs text-faint">{sub}</div>}
    </Card>
  );
}

/**
 * Single-series column chart: one accent hue (no legend — the title names it), ≤24px columns
 * with a 4px rounded top on a shared baseline, hairline grid, and a hover/focus readout per day.
 */
function DailyColumns({ series, onPick, dayName }: { series: MonthDay[]; onPick: (day: string) => void; dayName: (iso: string) => string }) {
  const f = useFmt();
  const { t } = useT();
  const max = niceCeil(Math.max(...series.map((d) => d.total), 1));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => r * max);
  const H = 200;

  return (
    <div className="flex gap-3">
      {/* Y axis (inline-start), clean tick values */}
      <div className="relative w-14 shrink-0 text-end text-[11px] text-faint" style={{ height: H }}>
        {ticks.map((v) => (
          <span key={v} className="num absolute end-0" style={{ bottom: `${(v / max) * 100}%`, transform: 'translateY(50%)' }}>
            {f.money(Math.round(v))}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height: H }}>
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 h-px bg-line" style={{ bottom: `${(v / max) * 100}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end">
            {series.map((d) => {
              const h = (d.total / max) * H;
              return (
                <button
                  key={d.day}
                  type="button"
                  onClick={() => onPick(d.day)}
                  className="group relative flex h-full flex-1 items-end justify-center outline-none"
                  aria-label={`${dayName(d.day)}: ${f.money(d.total)}`}
                >
                  {d.total > 0 && (
                    <span
                      className="block w-full max-w-6 rounded-t-[4px] bg-accent transition-[filter] group-hover:brightness-125 group-focus-visible:brightness-125"
                      style={{ height: Math.max(2, h), marginInline: 1 }}
                    />
                  )}
                  {/* Readout: value leads, day follows */}
                  <span className="pointer-events-none absolute bottom-full z-10 mb-1 hidden min-w-28 flex-col items-center rounded-control border border-line bg-surface-1 px-2.5 py-1.5 text-xs shadow-[var(--shadow-float)] group-hover:flex group-focus-visible:flex">
                    <Money value={d.total} className="text-sm font-semibold text-fg" />
                    <span className="text-muted">{dayName(d.day)}</span>
                    {d.sessions > 0 && (
                      <span className="text-faint">
                        <Num>{d.sessions}</Num> {t('ledger.sessions')}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {/* X axis: a few day numbers only */}
        <div className="mt-1.5 flex text-[11px] text-faint">
          {series.map((d, i) => {
            const n = Number(d.day.slice(8));
            const show = n === 1 || n % 5 === 0 || i === series.length - 1;
            return (
              <span key={d.day} className="num flex-1 text-center">
                {show ? n : ''}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
