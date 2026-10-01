import { clsx } from 'clsx';
import { Banknote, Coffee, CreditCard, Gamepad2 } from 'lucide-react';
import { DateTime } from 'luxon';
import { Card, EmptyState, Field, Input, Money, Num, Row, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { ApiError } from '../../lib/api';
import { useFmt } from '../../lib/format';
import { useRangeReport } from '../../lib/queries';
import { DaysTable, Tile } from './MonthlyTab';

/**
 * Any period — "from the 1st to the 15th", "last week": what came in each day and the period's
 * totals (income, cash, visa, play time, drinks). Days are business days, both ends included.
 */
export function RangeTab({
  from,
  to,
  onRange,
  onPickDay,
}: {
  from: string | null;
  to: string | null;
  onRange: (from: string, to: string) => void;
  onPickDay: (day: string) => void;
}) {
  const { t } = useT();
  const f = useFmt();
  const today = DateTime.now().setZone(f.tz).startOf('day');
  const iso = (d: DateTime) => d.toISODate()!;
  // Default: the last 7 days, today included.
  const start = from ?? iso(today.minus({ days: 6 }));
  const end = to ?? iso(today);
  const valid = start <= end;
  const report = useRangeReport(valid ? start : null, valid ? end : null);
  const dayName = (d: string) => f.date(DateTime.fromISO(d, { zone: f.tz }).set({ hour: 12 }).toMillis());

  const presets = [
    { label: t('ledger.last7'), from: iso(today.minus({ days: 6 })), to: iso(today) },
    { label: t('ledger.thisMonth'), from: iso(today.startOf('month')), to: iso(today) },
    { label: t('ledger.lastMonth'), from: iso(today.minus({ months: 1 }).startOf('month')), to: iso(today.minus({ months: 1 }).endOf('month')) },
    { label: t('ledger.thisYear'), from: iso(today.startOf('year')), to: iso(today) },
  ];

  const data = report.data;
  const withData = (data?.days ?? []).filter((d) => d.sessions > 0 || d.total !== 0);
  const avg = withData.length ? Math.round((data?.totals.total ?? 0) / withData.length) : 0;
  const error = report.error instanceof ApiError ? report.error.code : null;

  return (
    <div className={clsx('flex flex-col gap-6', report.isFetching && data && 'opacity-70 transition-opacity')}>
      {/* From … to …, plus one-tap periods */}
      <Card className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-2 gap-3 sm:max-w-md">
          <Field label={t('ledger.from')} htmlFor="range-from">
            <Input id="range-from" type="date" className="num" value={start} max={iso(today)} onChange={(e) => e.target.value && onRange(e.target.value, end)} />
          </Field>
          <Field label={t('ledger.to')} htmlFor="range-to">
            <Input id="range-to" type="date" className="num" value={end} max={iso(today)} onChange={(e) => e.target.value && onRange(start, e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onRange(p.from, p.to)}
              className={clsx(
                'h-9 rounded-full border px-3.5 text-sm font-medium transition-colors',
                p.from === start && p.to === end ? 'border-accent/50 bg-accent/12 text-accent' : 'border-line text-muted hover:text-fg',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        {!valid && <p className="text-sm text-danger">{t('ledger.rangeInvalid')}</p>}
        {error === 'range_too_long' && <p className="text-sm text-danger">{t('ledger.rangeTooLong')}</p>}
      </Card>

      {!valid || error ? null : !data ? (
        <Skeleton className="h-72" />
      ) : withData.length === 0 ? (
        <EmptyState title={t('ledger.noRange')} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.2fr] lg:gap-4">
            <Card className="relative overflow-hidden p-5">
              <span aria-hidden className="absolute inset-y-0 start-0 w-1 bg-accent" />
              <div className="text-sm text-muted">{t('ledger.rangeTotal')}</div>
              <Money value={data.totals.total} currency className="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl" />
              <div className="mt-2 text-xs text-faint">
                <Num>{withData.length}</Num> {t('ledger.daysWithIncome')} · <Num>{data.totals.sessions}</Num> {t('ledger.sessions')} · {t('ledger.average')} {f.money(avg)}
              </div>
            </Card>
            <Tile icon={<Banknote />} label={t('checkout.cash')} value={<Money value={data.totals.received.cash ?? 0} />} />
            <Tile icon={<CreditCard />} label={t('checkout.card')} value={<Money value={data.totals.received.card ?? 0} />} />
            <Card className="flex flex-col justify-center gap-2 p-5">
              <Row className="!py-0" label={<span className="flex items-center gap-2"><Gamepad2 className="size-4" />{t('reports.time')}</span>} value={<Money value={data.totals.time} className="font-semibold text-fg" />} />
              <Row className="!py-0" label={<span className="flex items-center gap-2"><Coffee className="size-4" />{t('ledger.drinks')}</span>} value={<Money value={data.totals.items} className="font-semibold text-fg" />} />
              {data.totals.discounts > 0 && <Row className="!py-0" muted label={t('reports.discounts')} value={<Money value={data.totals.discounts} />} />}
            </Card>
          </div>
          <DaysTable days={withData} totals={data.totals} onPickDay={onPickDay} dayName={dayName} />
        </>
      )}
    </div>
  );
}
