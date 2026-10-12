import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Banknote, Coffee, CreditCard, Gamepad2, MoonStar, Plus, Trash2, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Card, EmptyState, Input, Money, Num, SectionTitle, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { useNow } from '../../lib/clock';
import { useFmt } from '../../lib/format';
import { sessionBill, useBillingContext } from '../../lib/live';
import { useFloor, useSessionsLog } from '../../lib/queries';
import type { LedgerRow } from '../../lib/types';

export interface Row extends LedgerRow {
  open: boolean;
  /** Ended but not paid yet (open = still playing or waiting for payment). */
  unpaid: boolean;
}

/**
 * "The device was booked from 6:05 to 7:40": every session of the business day, one line each,
 * with what they took and how they paid. Sessions still running today are listed too, live.
 */
export function DailyLog({ day, isOpenDay }: { day: string; isOpenDay: boolean }) {
  const { t } = useT();
  const f = useFmt();
  const log = useSessionsLog(day);
  const floor = useFloor();
  const now = useNow();
  const ctx = useBillingContext(floor.data);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  // Any day, open or closed, but only an entry that was paid: a device still playing is never touched from here.
  const canDelete = (r: Row) => !r.carried && !r.open;

  const allRows: Row[] = useMemo(() => {
    // Every row shows this day's share: a bill whose session ran past an earlier day's end leaves
    // out what that day already counted, so the column totals equal the day's income.
    const paid = (log.data ?? []).map((r) => {
      const outTime = r.carriedOutTime ?? 0;
      const outItems = r.carriedOutItems ?? 0;
      return {
        ...r,
        timeCharge: r.timeCharge - outTime,
        itemsTotal: r.itemsTotal - outItems,
        total: r.total - outTime - outItems,
        open: false,
        unpaid: false,
      };
    });
    if (!isOpenDay || !floor.data || !ctx) return paid;
    const open = floor.data.sessions.map((s): Row => {
      const bill = sessionBill(s, ctx, now);
      const carried = s.carried ?? { time: 0, items: 0 };
      return {
        billId: s.id,
        number: 0,
        stationName: floor.data!.stations.find((x) => x.id === s.stationId)?.name ?? null,
        label: s.label,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        playedMs: bill?.playedMs ?? 0,
        timeCharge: (bill?.total ?? 0) - carried.time,
        items: [],
        itemsTotal: s.itemsTotal - carried.items,
        discount: 0,
        total: (bill?.total ?? 0) + s.itemsTotal - carried.time - carried.items,
        carriedOutTime: carried.time,
        carriedOutItems: carried.items,
        paidByMethod: s.paidByMethod,
        open: true,
        unpaid: s.status === 'ended',
      };
    });
    return [...paid, ...open.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))];
  }, [log.data, isOpenDay, floor.data, ctx, now]);
  // Devices here; the cafeteria's sales have their own list below.
  const rows = useMemo(() => allRows.filter((r) => !r.counter), [allRows]);

  const totals = rows.reduce(
    (a, r) => ({ time: a.time + r.timeCharge, items: a.items + r.itemsTotal, total: a.total + r.total, played: a.played + r.playedMs }),
    { time: 0, items: 0, total: 0, played: 0 },
  );

  if (log.isLoading) return <Skeleton className="h-64" />;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <SectionTitle>{t('ledger.sessionsLog')}</SectionTitle>
        <Button size="sm" variant="secondary" className="no-print mb-3" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
          إضافة جلسة
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyState icon={<Gamepad2 />} title={t('ledger.noSessions')} />
        </div>
      ) : (
        <>
          {/* Desktop: a real table (columns align, tabular numbers) */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="border-y border-line bg-surface-2 text-xs text-faint">
                <tr>
                  <th className="px-4 py-2.5 text-start font-medium">{t('ledger.device')}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t('ledger.fromTo')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('ledger.duration')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('ledger.time')}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t('ledger.drinks')}</th>
                  <th className="px-4 py-2.5 text-end font-medium">{t('ledger.total')}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t('ledger.paidBy')}</th>
                  <th className="px-2 py-2.5"><span className="sr-only">{t('common.delete')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.billId} className={clsx('border-b border-line/70 align-top', r.open && 'bg-surface-2/70')}>
                    <td className="px-4 py-3">
                      <RowName r={r} />
                      {r.label && (
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                          <UserRound className="size-3" /> {r.label}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {/* Not <Num>: each time is isolated already, and the range must read in the page's direction. */}
                      <span className="whitespace-nowrap tabular-nums">
                        {r.startedAt ? f.time(r.startedAt) : '—'} – {r.endedAt ? f.time(r.endedAt) : '…'}
                      </span>
                      {r.open && (
                        <div data-status={r.unpaid ? 'unpaid' : 'active'} className="st-fg mt-0.5 flex items-center gap-1 text-xs font-medium">
                          <span className="st-bg size-1.5 rounded-full" /> {r.unpaid ? t('status.unpaid') : t('ledger.stillOpen')}
                        </div>
                      )}
                      <SplitNote r={r} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">{f.span(r.playedMs)}</td>
                    <td className="px-4 py-3 text-end">
                      <Money value={r.timeCharge} className="justify-end" />
                    </td>
                    <td className="px-4 py-3">
                      {r.itemsTotal > 0 ? (
                        <div>
                          <Money value={r.itemsTotal} />
                          {r.items.length > 0 && (
                            <div className="mt-0.5 text-xs text-muted">
                              {r.items.map((i) => (
                                <span key={i.name} className="me-2 inline-block">
                                  <Num>{i.qty}×</Num> {i.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-end font-semibold">
                      <Money value={r.total} className="justify-end" />
                    </td>
                    <td className="px-4 py-3">
                      <PaidChips paid={r.paidByMethod} />
                    </td>
                    <td className="px-2 py-2 text-end">{canDelete(r) && <DeleteRowButton onClick={() => setDeleting(r)} />}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-surface-2 font-semibold">
                <tr>
                  <td className="px-4 py-3" colSpan={2}>
                    {t('common.total')} · <Num>{rows.length}</Num>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-end">{f.span(totals.played)}</td>
                  <td className="px-4 py-3 text-end">
                    <Money value={totals.time} className="justify-end" />
                  </td>
                  <td className="px-4 py-3">
                    <Money value={totals.items} />
                  </td>
                  <td className="px-4 py-3 text-end">
                    <Money value={totals.total} currency className="justify-end" />
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Phone: one card per session */}
          <ul className="flex flex-col divide-y divide-line border-t border-line md:hidden">
            {rows.map((r) => (
              <li key={r.billId} className={clsx('flex flex-col gap-1.5 px-4 py-3', r.open && 'bg-surface-2/70')}>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">
                    <RowName r={r} inline />
                  </span>
                  <Money value={r.total} className="font-semibold" />
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-muted">
                  <span className="tabular-nums">
                    {r.startedAt ? f.time(r.startedAt) : '—'} – {r.endedAt ? f.time(r.endedAt) : '…'} · {f.span(r.playedMs)}
                  </span>
                  <PaidChips paid={r.paidByMethod} />
                </div>
                {canDelete(r) && (
                  <div className="flex justify-end">
                    <DeleteRowButton onClick={() => setDeleting(r)} />
                  </div>
                )}
                {r.items.length > 0 && (
                  <div className="text-xs text-faint">
                    {r.items.map((i) => `${i.qty}× ${i.name}`).join('، ')}
                  </div>
                )}
                <SplitNote r={r} />
              </li>
            ))}
          </ul>
        </>
      )}
      {deleting && <DeleteRowModal row={deleting} onClose={() => setDeleting(null)} />}
      {adding && <AddManualEntryModal day={day} stations={floor.data?.stations.map((s) => s.name) ?? []} onClose={() => setAdding(false)} />}
    </Card>
  );
}

const PAPER_PRESETS = [
  { stationName: 'جهاز 1', hours: 4, minutes: 20, jd: '8.35' },
  { stationName: 'جهاز 2', hours: 1, minutes: 0, jd: '1.50' },
  { stationName: 'جهاز 5', hours: 1, minutes: 20, jd: '2.50' },
  { stationName: 'VIP 1', hours: 5, minutes: 10, jd: '10.25' },
] as const;

function AddManualEntryModal({ day, stations, onClose }: { day: string; stations: string[]; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const [stationName, setStationName] = useState(stations[0] ?? 'جهاز 1');
  const [hours, setHours] = useState('1');
  const [minutes, setMinutes] = useState('0');
  const [amountJd, setAmountJd] = useState('');
  const [method, setMethod] = useState<'cash' | 'card'>('cash');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sessions-log'] });
    qc.invalidateQueries({ queryKey: ['day-report'] });
    qc.invalidateQueries({ queryKey: ['days'] });
    qc.invalidateQueries({ queryKey: ['month-report'] });
    qc.invalidateQueries({ queryKey: ['range-report'] });
  };

  const submitSingle = async () => {
    const dur = (parseInt(hours || '0', 10) || 0) * 60 + (parseInt(minutes || '0', 10) || 0);
    const totalMinor = Math.round(parseFloat(amountJd.replace(',', '.') || '0') * 1000);
    if (!stationName.trim() || dur <= 0 || totalMinor <= 0) return;
    const ok = await run(
      () =>
        post('/api/ledger/manual-entry', {
          day,
          stationName: stationName.trim(),
          durationMinutes: dur,
          total: totalMinor,
          method,
        }),
      { what: stationName, success: 'تمت إضافة الجلسة للجرد' },
    );
    if (ok) {
      refresh();
      onClose();
    }
  };

  const submitPaperBatch = async () => {
    const ok = await run(
      async () => {
        for (const p of PAPER_PRESETS) {
          await post('/api/ledger/manual-entry', {
            day,
            stationName: p.stationName,
            durationMinutes: p.hours * 60 + p.minutes,
            total: Math.round(parseFloat(p.jd) * 1000),
            method: 'cash',
          });
        }
      },
      { what: 'جلسات الورقة (4 أجهزة)', success: 'تمت إضافة الـ 4 أجهزة للجرد' },
    );
    if (ok) {
      refresh();
      onClose();
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`إضافة جلسة يدوية للجرد (${day})`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="lg" loading={busy} icon={<Plus className="size-4" />} onClick={submitSingle}>
            إضافة للجرد
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 text-sm">
        <div className="rounded-card border border-line bg-surface-2 p-3">
          <div className="mb-2 text-xs font-medium text-muted">إضافة سريعة لجلسات الورقة (جهاز 1، جهاز 2، جهاز 5، VIP 1):</div>
          <Button variant="secondary" size="sm" loading={busy} onClick={submitPaperBatch} className="w-full justify-center">
            + إضافة الـ 4 أجهزة دفعة واحدة (22.600 د.أ)
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted">اسم الجهاز</label>
          <Input value={stationName} onChange={(e) => setStationName(e.target.value)} placeholder="مثال: جهاز 1 أو VIP 1" />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {['جهاز 1', 'جهاز 2', 'جهاز 5', 'VIP 1', ...stations.slice(0, 6)].map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setStationName(name)}
                className={clsx(
                  'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                  stationName === name ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface-2 text-muted hover:text-fg',
                )}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">الساعات</label>
            <Input type="number" min={0} max={24} value={hours} onChange={(e) => setHours(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">الدقائق</label>
            <Input type="number" min={0} max={59} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted">الحساب (بالدينار، مثال: 8.35)</label>
          <Input type="number" step="0.05" min={0} value={amountJd} onChange={(e) => setAmountJd(e.target.value)} placeholder="8.35" />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMethod('cash')}
            className={clsx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-control border py-2 text-xs font-medium',
              method === 'cash' ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface-2 text-muted',
            )}
          >
            <Banknote className="size-4" /> {t('checkout.cash')}
          </button>
          <button
            type="button"
            onClick={() => setMethod('card')}
            className={clsx(
              'flex flex-1 items-center justify-center gap-1.5 rounded-control border py-2 text-xs font-medium',
              method === 'card' ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface-2 text-muted',
            )}
          >
            <CreditCard className="size-4" /> {t('checkout.card')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DeleteRowButton({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={onClick}>
      {t('common.delete')}
    </Button>
  );
}

/**
 * Asks before anything disappears. A paid entry is voided as a bill (its money is given back in
 * the same shift); a device still open or waiting for payment is cancelled as a session.
 */
export function DeleteRowModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const { t } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const [reason, setReason] = useState('');
  const name = row.counter ? t('nav.cafe') : (row.stationName ?? '—');
  const confirm = async () => {
    const why = reason.trim() || t('ledger.deleteDefaultReason');
    const ok = await run(
      (pin) => post(`/api/bills/${row.billId}/void`, { reason: why, approvalPin: pin }),
      { what: name, success: t('common.deleted') },
    );
    if (ok) onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('ledger.deleteTitle')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="lg" loading={busy} icon={<Trash2 className="size-4" />} onClick={confirm}>
            {t('ledger.deleteConfirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-card bg-surface-2 p-3 text-sm">
          <div className="flex items-center justify-between gap-3 font-semibold">
            <span>
              <span className="num">{name}</span>
              {row.label && <span className="ms-2 font-normal text-muted">{row.label}</span>}
            </span>
            <Money value={row.total} />
          </div>
          <div className="mt-0.5 text-xs text-muted tabular-nums">{row.startedAt ? f.time(row.startedAt) : '—'} – {row.endedAt ? f.time(row.endedAt) : '…'}</div>
        </div>
        <p className="text-sm leading-relaxed text-muted">{t('ledger.deleteBody')}</p>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('ledger.deleteReason')} aria-label={t('ledger.deleteReason')} maxLength={200} />
      </div>
    </Modal>
  );
}

/** "PS-01 · Ahmad", or "Cafeteria" for a sale with no device. */
function RowName({ r, inline }: { r: Row; inline?: boolean }) {
  const { t } = useT();
  const name = r.counter ? (
    <span className="inline-flex items-center gap-1.5">
      <Coffee className="size-4 text-muted" /> {t('nav.cafe')}
    </span>
  ) : (
    <span className="num">{r.stationName ?? '—'}</span>
  );
  if (inline) {
    return (
      <>
        {name}
        {r.label && <span className="ms-2 font-normal text-muted">{r.label}</span>}
      </>
    );
  }
  return (
    <>
      <div className="font-semibold">{name}</div>
      {r.label && (
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
          <UserRound className="size-3" /> {r.label}
        </div>
      )}
    </>
  );
}

/** Why a row shows only part of a session: the day ended while it was playing. */
function SplitNote({ r }: { r: Row }) {
  const { t } = useT();
  const f = useFmt();
  const out = (r.carriedOutTime ?? 0) + (r.carriedOutItems ?? 0);
  if (r.carried) {
    return (
      <div className="mt-0.5 flex flex-col gap-0.5 text-xs">
        <span className="flex items-center gap-1 text-st-reserved">
          <MoonStar className="size-3" /> {r.voided ? t('ledger.carriedVoid') : t('ledger.carriedRow', { time: r.endedAt ? f.time(r.endedAt) : '…' })}
        </span>
        {!r.voided &&
          (r.paidAt ? (
            <span className="flex flex-wrap items-center gap-1 text-st-free">
              {t('ledger.carriedPaid', { time: f.time(r.paidAt) })} <Money value={r.billTotal ?? 0} />
            </span>
          ) : (
            <span className="text-st-ending">{t('ledger.carriedUnpaid')}</span>
          ))}
      </div>
    );
  }
  if (out === 0) return null;
  return (
    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
      <MoonStar className="size-3" /> {t('ledger.carriedOutLabel')} <Money value={out} />
    </div>
  );
}

export function PaidChips({ paid }: { paid: Record<string, number> }) {
  const { t } = useT();
  const entries = Object.entries(paid).filter(([, v]) => v !== 0);
  if (entries.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {entries.map(([m, v]) => (
        <span key={m} className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-xs text-muted">
          {m === 'card' ? <CreditCard className="size-3" /> : <Banknote className="size-3" />}
          {t(m === 'card' ? 'checkout.card' : 'checkout.cash')} <Money value={v} className="text-fg" />
        </span>
      ))}
    </span>
  );
}

/** What was bought at the cafeteria counter (no device): one line per sale, with what was taken and how it was paid. */
export function CafeLog({ day }: { day: string }) {
  const { t } = useT();
  const f = useFmt();
  const log = useSessionsLog(day);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const sales = (log.data ?? []).filter((r) => r.counter);
  const total = sales.reduce((a, r) => a + r.total, 0);
  if (log.isLoading || sales.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 pt-5">
        <SectionTitle>{t('ledger.cafeLog')}</SectionTitle>
        <Money value={total} className="mb-3 font-semibold" />
      </div>
      <ul className="flex flex-col divide-y divide-line border-t border-line">
        {sales.map((r) => (
          <li key={r.billId} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3">
            <div className="min-w-0 flex-1 basis-56">
              <div className="flex flex-wrap items-center gap-x-2 text-sm">
                <Coffee className="size-4 text-muted" aria-hidden />
                <span className="tabular-nums text-muted">{r.startedAt ? f.time(r.startedAt) : '—'}</span>
                {r.label && <span className="font-medium">{r.label}</span>}
              </div>
              <div className="mt-0.5 text-xs text-muted">{r.items.map((i) => `${i.qty}× ${i.name}`).join('، ')}</div>
            </div>
            <PaidChips paid={r.paidByMethod} />
            <Money value={r.total} className="font-semibold" />
            <DeleteRowButton onClick={() => setDeleting({ ...r, open: false, unpaid: false })} />
          </li>
        ))}
      </ul>
      {deleting && <DeleteRowModal row={deleting} onClose={() => setDeleting(null)} />}
    </Card>
  );
}

