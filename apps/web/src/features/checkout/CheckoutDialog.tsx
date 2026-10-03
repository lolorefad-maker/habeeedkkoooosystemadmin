import { computeCheckout, earnsReward, normalizePhone, parseMoney, roundToUnit, type DiscountInput } from '@lounge/core';
import { clsx } from 'clsx';
import { Banknote, CircleCheck, CreditCard, Gift, Printer, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { errorMessage, withApproval } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Field, Input, Money, Num, Row, Segmented, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { ApiError, get, post } from '../../lib/api';
import { useFmt } from '../../lib/format';
import { useFloor, useSessionBill } from '../../lib/queries';
import type { Bill } from '../../lib/types';
import { PhoneField } from '../rewards/PhoneField';
import { WhatsAppButton } from '../rewards/WhatsAppButton';

/** What a checkout answers: the bill, and the part an earlier day's drawer took (it played past that day's end). */
interface CheckoutDone {
  billId: string;
  number: number;
  late?: { amount: number; cash: number; shiftId: string; userName: string; closedAt: number | null } | null;
  /** A free hour this checkout earned for the customer (ready to tell them on WhatsApp). */
  reward?: { id: string; minutes: number; playedMinutes: number; name: string; phone: string } | null;
}
import { TimeLines } from './BillBreakdown';
import { printReceipt } from './receipt';

/**
 * The moment of truth for money. Everything is visible before confirming: play time, every
 * drink, discount, rounding, what was already paid (cash / visa), what is left, and the change.
 */
export function CheckoutDialog({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  return sessionId ? <CheckoutInner key={sessionId} sessionId={sessionId} onClose={onClose} /> : null;
}

function CheckoutInner({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t, lang } = useT();
  const f = useFmt();
  const floor = useFloor();
  const sessionBill = useSessionBill(sessionId);
  const [discountKind, setDiscountKind] = useState<'final' | 'percent' | 'amount'>('final');
  const [discountValue, setDiscountValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [rewardOn, setRewardOn] = useState(false);
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CheckoutDone | null>(null);

  const settings = floor.data?.branch.settings;
  const data = sessionBill.data ?? null;
  const policy = settings?.rewards;
  // The customer's free time replaces a hand-made discount (the server prices it the same way).
  const reward = rewardOn && data?.reward ? data.reward : null;
  const phoneOk = !!policy && normalizePhone(phone, policy.countryCode) != null;
  // Played long enough for a free hour but nobody's number is registered yet.
  const askPhone = !!policy?.enabled && !!data && !data.customer && earnsReward(data.time.playedMs, policy.afterMinutes);

  // What the bill comes to before any discount: the "amount to charge" box works down from it.
  const subtotal = useMemo(
    () => (data && settings ? computeCheckout({ timeCharge: data.time?.total ?? 0, items: data.items, discount: null, cashRounding: settings.checkout.cashRounding, paid: 0 }).subtotal : 0),
    [data, settings],
  );

  const discount: DiscountInput | null = useMemo(() => {
    if (reward) return { kind: 'amount', value: reward.value };
    if (!discountValue) return null;
    if (discountKind === 'percent') {
      const v = Number(discountValue);
      return Number.isFinite(v) && v > 0 ? { kind: 'percent', value: Math.min(100, v) } : null;
    }
    const m = parseMoney(discountValue, f.decimals);
    if (!m || m <= 0) return null;
    if (discountKind === 'final') {
      // The cashier says what to charge; the rest is the shop's own discount.
      const charge = roundToUnit(m, settings?.checkout.cashRounding ?? 0);
      return charge < subtotal ? { kind: 'amount', value: subtotal - charge } : null;
    }
    return { kind: 'amount', value: m };
  }, [reward, discountKind, discountValue, f.decimals, settings, subtotal]);

  const totals = useMemo(
    () =>
      data && settings
        ? computeCheckout({ timeCharge: data.time?.total ?? 0, items: data.items, discount, cashRounding: settings.checkout.cashRounding, paid: data.paid })
        : null,
    [data, discount, settings],
  );

  const due = totals?.due ?? 0;
  const receivedMinor = received ? parseMoney(received, f.decimals) : null;
  const change = method === 'cash' && due > 0 && receivedMinor != null ? receivedMinor - due : null;
  const quick = useMemo(() => quickAmounts(due, f.decimals), [due, f.decimals]);

  useEffect(() => setError(null), [discount, method, received]);

  const confirm = async () => {
    if (!totals) return;
    if (method === 'cash' && due > 0 && receivedMinor != null && receivedMinor < due) {
      setError(t('checkout.insufficient'));
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      // A free hour is priced by the server; it is sent as the reward, not as a hand-made discount.
      discount: reward ? null : discount,
      discountReason: !reward && discount ? discountReason.trim() || t('checkout.houseDiscount') : null,
      rewardId: reward?.id ?? null,
      customerPhone: askPhone && phoneOk ? phone.trim() : null,
      payments: due === 0 ? [] : [{ method, amount: due }],
      expectedTotal: totals.total,
    };
    try {
      const res = await withApproval(
        (pin) => post<CheckoutDone>(`/api/sessions/${sessionId}/checkout`, { ...body, approvalPin: pin }),
        discount && !reward ? `${t('checkout.discount')} ${discount.kind === 'percent' ? `${discount.value}%` : f.money(discount.value)}` : due < 0 ? `${t('checkout.refund')} ${f.money(-due)}` : '',
      );
      setDone(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === 'bill_changed') void sessionBill.refetch();
    } finally {
      setBusy(false);
    }
  };

  const print = async () => {
    if (!done || !floor.data) return;
    const bill = await get<Bill>(`/api/bills/${done.billId}`);
    printReceipt(bill, { branchName: floor.data.branch.name, lang, f, stations: floor.data.stations });
  };

  if (done) {
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} title={t('checkout.title')} size="sm">
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-st-free/15 text-st-free">
            <CircleCheck className="size-9" />
          </span>
          <p className="text-lg font-semibold">{t('checkout.success', { n: done.number })}</p>
          {change != null && change > 0 && (
            <p className="text-muted">
              {t('checkout.change')}: <Money value={change} currency className="font-semibold text-fg" />
            </p>
          )}
          {/* It played past the day's end: the old day's part goes to that day's drawer. */}
          {done.late && done.late.amount > 0 && (
            <div data-status="ending" className="tint w-full rounded-card border p-3.5 text-start text-sm">
              <div className="font-semibold">
                {done.late.cash > 0
                  ? t('checkout.lateCash', { amount: f.money(done.late.cash), name: done.late.userName, time: done.late.closedAt ? f.time(done.late.closedAt) : '…' })
                  : t('checkout.lateCard', { amount: f.money(done.late.amount), name: done.late.userName })}
              </div>
              <div className="mt-1 text-xs text-muted">{t('checkout.lateHint')}</div>
            </div>
          )}
          {/* A long session: the customer earned free time — tell them on WhatsApp. */}
          {done.reward && policy && (
            <div data-status="free" className="tint flex w-full flex-col gap-3 rounded-card border p-3.5 text-start">
              <div className="flex items-center gap-2 font-semibold">
                <Gift className="size-5 shrink-0" aria-hidden />
                {t('rewards.earned', { free: f.span(done.reward.minutes * 60_000) })}
              </div>
              <div className="text-sm text-muted">
                {done.reward.name !== done.reward.phone && <span className="font-medium text-fg">{done.reward.name} · </span>}
                <Num>+{done.reward.phone}</Num>
                <div className="mt-1 text-xs">{t('rewards.earnedHint')}</div>
              </div>
              <WhatsAppButton reward={done.reward} size="lg" block />
            </div>
          )}
          <div className="mt-2 flex w-full gap-2">
            <Button block size="lg" icon={<Printer className="size-5" />} onClick={print}>
              {t('checkout.printReceipt')}
            </Button>
            <Button block size="lg" variant="primary" onClick={onClose} autoFocus>
              {t('common.done')}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const s = floor.data?.sessions.find((x) => x.id === sessionId);
  const stationName = floor.data?.stations.find((x) => x.id === s?.stationId)?.name;
  const title = [t('checkout.title'), [stationName, s?.label].filter(Boolean).join(' · ')].filter(Boolean).join(' — ');

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      size="lg"
      footer={
        <div className="flex w-full flex-col gap-2">
          {error && (
            <div role="alert" className="flex items-center gap-2 rounded-control bg-danger/10 px-3 py-2 text-sm text-danger">
              <TriangleAlert className="size-4 shrink-0" /> {error}
            </div>
          )}
          <Button variant={due < 0 ? 'danger' : 'primary'} size="xl" block loading={busy} disabled={!totals || (askPhone && phone.trim() !== '' && !phoneOk)} onClick={confirm}>
            {due < 0 ? t('checkout.confirmRefund') : t('checkout.confirm')}
            {totals && due !== 0 && (
              <span className="ms-1">
                · <Money value={Math.abs(due)} />
              </span>
            )}
          </Button>
        </div>
      }
    >
      {!data || !totals ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-[1fr_300px]">
          {/* Bill */}
          <div className="flex flex-col gap-3">
            {data.time && floor.data && (
              <section className="rounded-card border border-line p-4">
                <div className="mb-1 text-xs font-semibold text-faint">{t('session.timeCharge')}</div>
                <TimeLines time={data.time} stations={floor.data.stations} />
              </section>
            )}
            {data.items.length > 0 && (
              <section className="rounded-card border border-line p-4">
                <div className="mb-1 text-xs font-semibold text-faint">{t('session.items')}</div>
                {data.items.map((i) => (
                  <div key={i.id} className={clsx('flex items-baseline justify-between gap-3 py-1 text-sm', i.voided && 'text-faint line-through')}>
                    <span className="truncate">
                      <Num className="text-muted">{i.qty}×</Num> {i.name}
                    </span>
                    <Money value={i.qty * i.unitPrice} />
                  </div>
                ))}
              </section>
            )}
            <section className="rounded-card bg-surface-2 p-4">
              <Row label={t('checkout.subtotal')} value={<Money value={totals.subtotal} />} />
              {totals.discountAmount > 0 && <Row label={t('checkout.discount')} value={<span className="text-st-free">−<Money value={totals.discountAmount} /></span>} />}
              {totals.rounding !== 0 && <Row muted label={t('checkout.rounding')} value={<Money value={totals.rounding} />} />}
              <Row label={t('common.total')} value={<Money value={totals.total} />} className="text-fg" />
              {(data.paidByMethod.cash ?? 0) !== 0 && (
                <Row label={t('session.paidCash')} value={<span className="text-st-free">−<Money value={data.paidByMethod.cash!} /></span>} />
              )}
              {(data.paidByMethod.card ?? 0) !== 0 && (
                <Row label={t('session.paidCard')} value={<span className="text-st-free">−<Money value={data.paidByMethod.card!} /></span>} />
              )}
            </section>
          </div>

          {/* Payment */}
          <div className="flex flex-col gap-4">
            <div data-status={due < 0 ? 'overtime' : due === 0 ? 'free' : 'active'} className="tint rounded-card border p-4 text-center">
              <div className="text-sm text-muted">{due < 0 ? t('checkout.refund') : due === 0 ? t('checkout.nothingDue') : t('checkout.totalDue')}</div>
              <Money value={Math.abs(due)} currency className="mt-1 justify-center text-4xl font-bold" />
            </div>

            {/* The customer's free time, when one is waiting for this number. */}
            {data.reward && (
              <button
                type="button"
                role="switch"
                aria-checked={rewardOn}
                onClick={() => {
                  setRewardOn((v) => !v);
                  setDiscountValue('');
                  setDiscountReason('');
                }}
                data-status={rewardOn ? 'free' : undefined}
                className={clsx(
                  'flex items-center gap-3 rounded-card border p-3 text-start transition-colors',
                  rewardOn ? 'tint-strong' : 'border-line hover:border-line-strong hover:bg-surface-2',
                )}
              >
                <Gift className={clsx('size-5 shrink-0', rewardOn ? 'st-fg' : 'text-muted')} aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-semibold">{t('rewards.use')}</span>
                  <span className="text-xs text-muted">{t('rewards.useHint', { amount: f.money(data.reward.value) })}</span>
                </span>
                <span className="text-xs font-medium text-muted">{f.span(data.reward.minutes * 60_000)}</span>
              </button>
            )}

            {askPhone && policy && (
              <PhoneField
                id="checkout-phone"
                value={phone}
                onChange={setPhone}
                hint={t('rewards.checkoutHint', { after: f.span(policy.afterMinutes * 60_000), free: f.span(policy.freeMinutes * 60_000) })}
              />
            )}

            {/* "How much do you charge this customer?" — a regular's special price is the shop's own discount. */}
            {!rewardOn && (
              <div className="flex flex-col gap-3 rounded-card border border-line p-3">
                <Segmented
                  size="sm"
                  value={discountKind}
                  onChange={(k) => {
                    setDiscountKind(k);
                    setDiscountValue('');
                  }}
                  options={[
                    { value: 'final', label: t('checkout.charge') },
                    { value: 'percent', label: t('checkout.percent') },
                    { value: 'amount', label: t('checkout.amount') },
                  ]}
                />
                <Input
                  inputMode="decimal"
                  className="num text-center"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountKind === 'percent' ? '10' : discountKind === 'final' ? f.money(subtotal) : f.money(0)}
                  aria-label={discountKind === 'final' ? t('checkout.charge') : t('checkout.discount')}
                />
                {discountKind === 'final' && <p className="text-xs text-muted">{discountValue && !discount ? t('checkout.chargeTooHigh') : t('checkout.chargeHint')}</p>}
                {discount && <Input value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} placeholder={t('checkout.houseDiscount')} aria-label={t('checkout.discountReason')} />}
              </div>
            )}

            {due !== 0 && (
              <Field label={t('checkout.method')}>
                <Segmented
                  size="lg"
                  value={method}
                  onChange={setMethod}
                  options={[
                    { value: 'cash', label: <span className="flex items-center gap-2"><Banknote className="size-4" /> {t('checkout.cash')}</span> },
                    { value: 'card', label: <span className="flex items-center gap-2"><CreditCard className="size-4" /> {t('checkout.card')}</span> },
                  ]}
                />
              </Field>
            )}

            {method === 'cash' && due > 0 && (
              <div className="flex flex-col gap-2">
                <Field label={t('checkout.received')} htmlFor="received">
                  <Input
                    id="received"
                    inputMode="decimal"
                    className="num h-12 text-center text-xl font-semibold"
                    value={received}
                    onChange={(e) => setReceived(e.target.value)}
                    placeholder={f.money(due)}
                    onKeyDown={(e) => e.key === 'Enter' && confirm()}
                  />
                </Field>
                <div className="grid grid-cols-3 gap-2">
                  {quick.map((q) => (
                    <button
                      key={q}
                      onClick={() => setReceived(String(f.toMajor(q)))}
                      className={clsx(
                        'num h-10 rounded-control border text-sm font-medium transition-colors',
                        receivedMinor === q ? 'border-accent bg-accent/12 text-accent' : 'border-line bg-surface-2 hover:border-line-strong',
                      )}
                    >
                      {q === due ? t('checkout.exact') : f.money(q)}
                    </button>
                  ))}
                </div>
                {change != null && change >= 0 && (
                  <div className="flex items-center justify-between rounded-card bg-st-free/10 px-4 py-3 text-st-free">
                    <span className="text-sm font-medium">{t('checkout.change')}</span>
                    <Money value={change} className="text-xl font-bold" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Exact amount + the next round banknote amounts above it. */
function quickAmounts(due: number, decimals: number): number[] {
  if (due <= 0) return [];
  const unit = 10 ** decimals;
  const out = new Set<number>([due]);
  for (const step of [1, 5, 10, 20, 50]) {
    const v = Math.ceil(due / (step * unit)) * step * unit;
    if (v > due) out.add(v);
    if (out.size >= 6) break;
  }
  return [...out].sort((a, b) => a - b).slice(0, 6);
}
