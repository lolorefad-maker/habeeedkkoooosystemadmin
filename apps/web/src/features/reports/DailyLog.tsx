import { clsx } from 'clsx';
import { Banknote, Coffee, CreditCard, Gamepad2, MoonStar, Trash2, UserRound } from 'lucide-react';
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

interface Row extends LedgerRow {
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
  // Any day, open or closed. A carried share belongs to its session's bill, so it has no button of its own.
  const canDelete = (r: Row) => !r.carried;

  const rows: Row[] = useMemo(() => {
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

  const totals = rows.reduce(
    (a, r) => ({ time: a.time + r.timeCharge, items: a.items + r.itemsTotal, total: a.total + r.total, played: a.played + r.playedMs }),
    { time: 0, items: 0, total: 0, played: 0 },
  );

  if (log.isLoading) return <Skeleton className="h-64" />;

  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-5">
        <SectionTitle>{t('ledger.sessionsLog')}</SectionTitle>
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
    </Card>
  );
}

function DeleteRowButton({ onClick }: { onClick: () => void }) {
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
function DeleteRowModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const { t } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const [reason, setReason] = useState('');
  const name = row.counter ? t('nav.cafe') : (row.stationName ?? '—');
  const confirm = async () => {
    const why = reason.trim() || t('ledger.deleteDefaultReason');
    const ok = await run(
      (pin) => (row.open ? post(`/api/sessions/${row.billId}/void`, { reason: why, approvalPin: pin }) : post(`/api/bills/${row.billId}/void`, { reason: why, approvalPin: pin })),
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
        <p className="text-sm leading-relaxed text-muted">{row.open ? t('ledger.deleteBodyOpen') : t('ledger.deleteBody')}</p>
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

function PaidChips({ paid }: { paid: Record<string, number> }) {
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
