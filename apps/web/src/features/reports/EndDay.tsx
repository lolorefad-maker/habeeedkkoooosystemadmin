import { parseMoney, type DayReport } from '@lounge/core';
import { clsx } from 'clsx';
import { Banknote, Boxes, ChevronDown, CircleCheck, CreditCard, Gamepad2, Hourglass, Lock, Printer, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Input, Money, Num, Row } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { useFmt } from '../../lib/format';
import { useFloor, useStock } from '../../lib/queries';

interface Closed {
  day: string;
  next: string;
  report: DayReport;
}

/**
 * "We're done for today": one screen that shows what the day made, counts the cash drawer
 * (closing the shift), optionally counts stock, then saves the day and starts the next one at zero.
 */
export function EndDayDialog({ report, onClose, onPrintDay }: { report: DayReport; onClose: () => void; onPrintDay: (day: string) => void }) {
  const { t } = useT();
  const f = useFmt();
  const navigate = useNavigate();
  const floor = useFloor();
  const stock = useStock();
  const { busy, run } = useAction();
  const [cash, setCash] = useState('');
  const [showStock, setShowStock] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Closed | null>(null);

  const shift = floor.data?.shift ?? null;
  const running = floor.data?.sessions.filter((s) => s.status === 'running') ?? [];
  const unpaid = floor.data?.sessions.filter((s) => s.status === 'ended') ?? [];
  const stationName = (id: string) => floor.data?.stations.find((s) => s.id === id)?.name ?? '';
  const tracked = (stock.data ?? []).filter((p) => p.trackStock);
  const cashMinor = cash.trim() === '' ? null : parseMoney(cash, f.decimals);
  const variance = shift && cashMinor != null ? cashMinor - shift.expectedCash : null;
  const dayLabel = (day: string) => f.date(new Date(`${day}T12:00:00Z`).getTime());

  const submit = async () => {
    const payload = {
      counts: Object.entries(counts)
        .filter(([, v]) => v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0)
        .map(([productId, v]) => ({ productId, countedQty: Number(v) })),
      shift: shift && cashMinor != null ? { countedCash: cashMinor } : null,
    };
    const res = await run(() => post<Closed>('/api/days/close', payload));
    if (res) setDone(res);
  };

  if (done) {
    return (
      <Modal
        open
        onOpenChange={(o) => !o && onClose()}
        title={t('endDay.doneTitle')}
        size="md"
        footer={
          <div className="flex w-full flex-col gap-2 sm:flex-row">
            <Button size="lg" block icon={<Printer className="size-5" />} onClick={() => onPrintDay(done.day)}>
              {t('endDay.printReport')}
            </Button>
            <Button variant="primary" size="lg" block onClick={onClose}>
              {t('common.done')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <span data-status="free" className="st-soft grid size-16 place-items-center rounded-full">
            <CircleCheck className="size-9" />
          </span>
          <div>
            <div className="text-sm text-muted">{t('endDay.dayIncome', { day: dayLabel(done.day) })}</div>
            <Money value={done.report.revenue.total} currency className="mt-1 text-4xl font-bold" />
          </div>
          <p className="max-w-sm text-sm text-muted">{t('endDay.doneBody', { next: dayLabel(done.next) })}</p>
          <p data-status="ending" className="st-soft rounded-control px-3 py-2 text-xs font-medium">
            {t('endDay.openShiftNext')}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('endDay.title', { day: dayLabel(report.day) })}
      description={t('endDay.hint')}
      size="md"
      footer={
        <Button variant="primary" size="xl" block loading={busy} disabled={!!shift && cashMinor == null} onClick={submit} icon={<Lock className="size-5" />}>
          {t('endDay.confirm')}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {/* 1. What the day made */}
        <section className="rounded-card border border-line p-4">
          <div className="text-sm text-muted">{t('ledger.dayIncome')}</div>
          <Money value={report.revenue.total} currency className="mt-1 text-4xl font-bold tracking-tight" />
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1">
            <Row label={<span className="flex items-center gap-2"><Banknote className="size-4" />{t('checkout.cash')}</span>} value={<Money value={report.payments.byMethod.cash ?? 0} className="font-semibold text-fg" />} />
            <Row label={<span className="flex items-center gap-2"><CreditCard className="size-4" />{t('checkout.card')}</span>} value={<Money value={report.payments.byMethod.card ?? 0} className="font-semibold text-fg" />} />
            <Row label={<span className="flex items-center gap-2"><Gamepad2 className="size-4" />{t('reports.time')}</span>} value={<Money value={report.revenue.time} />} />
            <Row label={t('ledger.drinks')} value={<Money value={report.revenue.items} />} />
          </div>
          <div className="mt-2 text-xs text-faint">
            <Num>{report.revenue.bills}</Num> {t('reports.bills')}
          </div>
        </section>

        {/* 2. Anything still open */}
        {(running.length > 0 || unpaid.length > 0) && (
          <section className="flex flex-col gap-2">
            {unpaid.length > 0 && (
              <div data-status="unpaid" className="tint rounded-card border p-3.5 text-sm">
                <div className="flex items-center gap-2 font-semibold">
                  <Hourglass className="st-fg size-4" />
                  {t('endDay.unpaid', { n: unpaid.length })}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {unpaid.map((s) => stationName(s.stationId)).join('، ')} — {t('endDay.unpaidHint')}
                </div>
              </div>
            )}
            {running.length > 0 && (
              <div data-status="ending" className="tint rounded-card border p-3.5 text-sm">
                <div className="flex items-center gap-2 font-semibold">
                  <TriangleAlert className="st-fg size-4" />
                  {t('endDay.running', { n: running.length })}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {running.map((s) => stationName(s.stationId)).join('، ')} — {t('endDay.runningHint')}
                </div>
              </div>
            )}
            <Button variant="ghost" size="sm" className="self-start" onClick={() => navigate('/floor')}>
              {t('endDay.goFloor')}
            </Button>
          </section>
        )}

        {/* 3. The cash drawer (closes the shift) */}
        {shift && (
          <section className="rounded-card border border-line p-4">
            <div className="flex items-center gap-2 font-semibold">
              <Banknote className="size-5 text-muted" />
              {t('endDay.cash')}
            </div>
            <p className="mt-1 text-sm text-muted">
              {t('endDay.cashHint')} <Money value={shift.expectedCash} currency className="font-semibold text-fg" />
            </p>
            <Input
              autoFocus
              inputMode="decimal"
              aria-label={t('shift.counted')}
              className="num mt-3 h-14 text-center text-2xl font-semibold"
              placeholder={f.money(shift.expectedCash)}
              value={cash}
              onChange={(e) => setCash(e.target.value)}
            />
            {variance != null && (
              <div
                data-status={variance === 0 ? 'free' : variance < 0 ? 'overtime' : 'ending'}
                className="st-soft mt-2 flex items-center justify-between rounded-control px-3 py-2 text-sm font-semibold"
              >
                <span>{variance === 0 ? t('shift.balanced') : variance < 0 ? t('shift.short') : t('shift.over')}</span>
                <Money value={Math.abs(variance)} currency />
              </div>
            )}
          </section>
        )}

        {/* 4. Stock count — optional */}
        {tracked.length > 0 && (
          <section className="rounded-card border border-line">
            <button
              type="button"
              onClick={() => setShowStock((v) => !v)}
              aria-expanded={showStock}
              className="flex min-h-12 w-full items-center gap-2 px-4 text-start font-semibold"
            >
              <Boxes className="size-5 text-muted" />
              <span className="flex-1">{t('endDay.stock')}</span>
              <ChevronDown className={clsx('size-4 text-faint transition-transform', showStock && 'rotate-180')} />
            </button>
            {showStock && (
              <div className="flex flex-col divide-y divide-line border-t border-line">
                {tracked.map((p) => (
                  <label key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="flex-1 truncate">{p.name}</span>
                    <span className="text-xs text-faint">
                      {t('reports.systemQty')} <Num className="font-medium text-muted">{p.stockQty}</Num>
                    </span>
                    <Input
                      inputMode="numeric"
                      className="num h-9 w-20 text-center"
                      placeholder={String(p.stockQty)}
                      value={counts[p.id] ?? ''}
                      onChange={(e) => setCounts((c) => ({ ...c, [p.id]: e.target.value.replace(/[^\d]/g, '') }))}
                      aria-label={`${t('reports.counted')} ${p.name}`}
                    />
                  </label>
                ))}
              </div>
            )}
          </section>
        )}

        <p className="text-center text-xs text-faint">{t('endDay.afterNote')}</p>
      </div>
    </Modal>
  );
}
