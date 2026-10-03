import { parseMoney, type BillingContext } from '@lounge/core';
import { clsx } from 'clsx';
import {
  ArrowLeftRight,
  Ban,
  Banknote,
  ChevronDown,
  Coffee,
  CreditCard,
  Gamepad,
  Pause,
  Play,
  Plus,
  Repeat,
  Square,
  Timer as TimerIcon,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { StatusBadge, TypeIcon, VipBadge } from '../../components/station/status';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal, Sheet } from '../../components/ui/overlays';
import { Field, Input, Money, Num, Row, Segmented } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { can, useAuth } from '../../lib/auth';
import { useNow } from '../../lib/clock';
import { useFmt } from '../../lib/format';
import type { StationView } from '../../lib/live';
import { useProducts, useSessionBill } from '../../lib/queries';
import type { Floor } from '../../lib/types';
import { TimeLines } from '../checkout/BillBreakdown';
import { announceStock, CartLines, cartTotal, QuickProducts, useCart, type StockLeft } from '../cafe/products';
import { ControllerActions, ControllerChip, stateOf } from '../controllers/parts';
import { autoFocusField } from '../../lib/viewport';

export function SessionSheet({
  view,
  floor,
  ctx: _ctx,
  onClose,
  onCheckout,
}: {
  view: StationView;
  floor: Floor;
  ctx: BillingContext;
  onClose: () => void;
  onCheckout: (sessionId: string) => void;
}) {
  const { t, tk } = useT();
  const f = useFmt();
  const role = useAuth((s) => s.user?.role);
  const session = view.session!;
  const station = floor.stations.find((s) => s.id === session.stationId) ?? view.station;
  const bill = useSessionBill(session.id);
  const { busy, run } = useAction();
  const [showLines, setShowLines] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [ctrlId, setCtrlId] = useState<string | null>(null);
  const [addCtrlOpen, setAddCtrlOpen] = useState(false);
  const now = useNow();
  const atStation = floor.controllers.filter((c) => c.stationId === session.stationId);
  const ctrl = floor.controllers.find((c) => c.id === ctrlId) ?? null;

  const ended = session.status === 'ended';
  const cur = session.segments.find((s) => s.endedAt === null);
  const paused = !!cur?.paused;
  const mode = cur?.mode ?? session.segments.at(-1)?.mode ?? '';
  const live = view.live;
  const time = view.bill;
  const manage = can.manageSessions(role);

  const timeTotal = time?.total ?? 0;
  const due = timeTotal + session.itemsTotal - session.paid;
  // "1:25 × 2.000" only makes sense when one hourly rate applied the whole time.
  const rates = [...new Set((time?.lines ?? []).map((l) => l.perHour))];
  const singleRate = rates.length === 1 ? rates[0]! : rates.length === 0 ? (time?.currentPerHour ?? null) : null;

  const act = (body: Record<string, unknown>) => run(() => post(`/api/sessions/${session.id}/action`, body));
  const setPlan = (plannedMinutes: number | null) => run(() => post(`/api/sessions/${session.id}/plan`, { plannedMinutes }));
  const playedMin = Math.ceil((live?.playedMs ?? 0) / 60_000);

  let hero = '';
  let caption = '';
  if (live) {
    if (session.kind === 'fixed' && live.remainingMs != null) {
      hero = live.remainingMs >= 0 ? f.duration(live.remainingMs) : `+${f.duration(-live.remainingMs)}`;
      caption = live.remainingMs >= 0 ? t('floor.remaining') : t('floor.over');
    } else {
      hero = f.duration(live.playedMs);
      caption = t('floor.elapsed');
    }
  }
  const status = ended ? 'unpaid' : view.status;

  return (
    <>
      <Sheet
        open
        onOpenChange={(o) => !o && onClose()}
        title={
          <>
            <TypeIcon type={station.type} className="size-5 text-muted" />
            <span className="num">{station.name}</span>
            {station.tier === 'vip' && <VipBadge />}
          </>
        }
        description={[station.zone, tk('modes', mode)].filter(Boolean).join(' · ')}
        headerExtra={<StatusBadge status={status} />}
        footer={
          manage && (
            <div className="flex flex-col gap-2">
              {ended ? (
                <>
                  {/* Ended by mistake: carry on playing, or delete it if it should never have been opened. */}
                  <div className="grid grid-cols-[auto_1fr] gap-2">
                    <Button size="xl" loading={busy} onClick={() => run(() => post(`/api/sessions/${session.id}/reopen`))} icon={<Play className="size-5" />}>
                      {t('session.reopen')}
                    </Button>
                    <Button variant="primary" size="xl" onClick={() => onCheckout(session.id)}>
                      {t('floor.pay')} · <Money value={Math.abs(due)} />
                    </Button>
                  </div>
                  <Button variant="ghost" className="text-danger" icon={<Ban className="size-4" />} onClick={() => setVoidOpen(true)}>
                    {t('session.void')}
                  </Button>
                </>
              ) : (
                <div className="grid grid-cols-[auto_1fr] gap-2">
                  <Button
                    size="xl"
                    loading={busy}
                    onClick={async () => {
                      if (await act({ type: 'end' })) onClose();
                    }}
                    title={t('session.endOnly')}
                    icon={<Square className="size-4 fill-current" />}
                  >
                    {t('session.endShort')}
                  </Button>
                  <Button
                    variant="primary"
                    size="xl"
                    loading={busy}
                    onClick={async () => {
                      if (await act({ type: 'end' })) onCheckout(session.id);
                    }}
                  >
                    {t('session.endPay')}
                  </Button>
                </div>
              )}
            </div>
          )
        }
      >
        <div className="flex flex-col gap-5">
          {/* Hero timer */}
          <div data-status={status} className="tint relative overflow-hidden rounded-sheet border p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className={clsx('num text-5xl font-semibold leading-none tracking-tight', status === 'overtime' && 'st-fg')}>{ended ? f.duration(live?.playedMs ?? 0) : hero}</div>
                <div className="mt-2 flex items-center gap-1.5 text-sm text-muted">
                  {paused && <Pause className="size-4" />}
                  {ended ? t('session.ended', { time: f.time(session.endedAt!) }) : caption}
                </div>
              </div>
              <div className="text-end">
                <Money value={Math.abs(due)} currency className={clsx('text-2xl font-semibold', due < 0 && 'text-st-ending')} />
                <div className="mt-1 text-xs text-muted">{due < 0 ? t('session.change') : t('session.remaining')}</div>
              </div>
            </div>
            {session.kind === 'fixed' && session.plannedMinutes && live && (
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div className="st-bg h-full rounded-full transition-[width] duration-1000" style={{ width: `${Math.min(100, (live.playedMs / (session.plannedMinutes * 60_000)) * 100)}%` }} />
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span>{t('session.started', { time: f.time(session.startedAt) })}</span>
              {session.plannedMinutes && <span>{t('session.planned', { d: f.minutes(session.plannedMinutes) })}</span>}
              {session.label && (
                <span className="flex items-center gap-1">
                  <UserRound className="size-3.5" /> {session.label}
                </span>
              )}
            </div>
          </div>

          {/* Session account: play time × rate + cafeteria − what was paid (cash / visa) = what is left */}
          <div className="rounded-card border border-line">
            <div className="flex items-center justify-between gap-3 px-4 pt-3">
              <span className="text-sm font-semibold">{t('session.account')}</span>
              {time && time.lines.length > 0 && (
                <button onClick={() => setShowLines((v) => !v)} className="flex items-center gap-1 text-xs text-muted hover:text-fg" aria-expanded={showLines}>
                  {t('session.breakdown')}
                  <ChevronDown className={clsx('size-3.5 transition-transform', showLines && 'rotate-180')} />
                </button>
              )}
            </div>
            <div className="px-4 py-2">
              {showLines && time && (
                <div className="mb-2 border-b border-dashed border-line pb-2">
                  <TimeLines time={time} stations={floor.stations} />
                </div>
              )}
              <Row
                label={
                  <span>
                    {t('session.played')}{' '}
                    <Num className="text-faint">
                      {f.duration(live?.playedMs ?? 0)}
                      {singleRate != null && ` × ${f.rate(singleRate)}`}
                    </Num>
                  </span>
                }
                value={<Money value={timeTotal} />}
              />
              <Row
                label={
                  <span>
                    {t('session.drinks')} {session.itemsCount > 0 && <Num className="text-faint">({session.itemsCount})</Num>}
                  </span>
                }
                value={<Money value={session.itemsTotal} />}
              />
              <div className="my-1 h-px bg-line" />
              <Row label={t('common.total')} value={<Money value={timeTotal + session.itemsTotal} />} className="text-fg" />
              {(session.paidByMethod.cash ?? 0) !== 0 && (
                <Row label={t('session.paidCash')} value={<span className="text-st-free">−<Money value={session.paidByMethod.cash!} /></span>} />
              )}
              {(session.paidByMethod.card ?? 0) !== 0 && (
                <Row label={t('session.paidCard')} value={<span className="text-st-free">−<Money value={session.paidByMethod.card!} /></span>} />
              )}
              <div className="my-1 h-px bg-line" />
              <Row strong label={due < 0 ? t('session.change') : t('session.remaining')} value={<Money value={Math.abs(due)} currency />} />
            </div>
            {can.checkout(role) && (
              <div className="border-t border-line px-4 py-3">
                <Button block icon={<Wallet className="size-4" />} onClick={() => setPayOpen(true)} disabled={!floor.shift} title={!floor.shift ? t('shift.noneHint') : undefined}>
                  {t('pay.receive')}
                </Button>
              </div>
            )}
          </div>

          {/* Controllers handed to this customer */}
          {!ended && station.type !== 'vr' && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted">
                <Gamepad className="size-4" /> {t('controllers.handed')}
              </div>
              <div className="flex flex-wrap gap-2">
                {atStation.map((c) => (
                  <ControllerChip key={c.id} c={c} now={now} onClick={() => setCtrlId(c.id)} />
                ))}
                <button
                  onClick={() => setAddCtrlOpen(true)}
                  className="flex h-11 items-center gap-1.5 rounded-control border border-dashed border-line-strong px-3 text-sm text-muted hover:border-accent hover:text-accent"
                >
                  <Plus className="size-4" /> {t('controllers.addOne')}
                </button>
              </div>
            </div>
          )}

          {/* Actions */}
          {manage && !ended && (
            <div className="grid grid-cols-2 gap-2">
              <ActionButton
                icon={paused ? <Play className="size-5" /> : <Pause className="size-5" />}
                label={paused ? t('session.resume') : t('session.pause')}
                onClick={() => act({ type: paused ? 'resume' : 'pause' })}
                disabled={busy}
              />
              {station.modes
                .filter((m) => m !== mode)
                .map((m) => (
                  <ActionButton key={m} icon={<Repeat className="size-5" />} label={t('session.changeMode', { mode: tk('modes', m) })} onClick={() => act({ type: 'mode', mode: m })} disabled={busy} />
                ))}
              <ActionButton icon={<ArrowLeftRight className="size-5" />} label={t('session.transfer')} onClick={() => setTransferOpen(true)} disabled={busy} />
            </div>
          )}

          {manage && !ended && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-muted">
                <TimerIcon className="size-4" /> {session.kind === 'fixed' ? t('session.extend') : t('session.toFixed')}
              </div>
              <div className="flex flex-wrap gap-2">
                {[15, 30, 60, 120].map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setPlan(session.kind === 'fixed' && session.plannedMinutes ? session.plannedMinutes + m : playedMin + m)}
                  >
                    {session.kind === 'fixed' ? t('session.extendBy', { n: m }) : f.minutes(m)}
                  </Button>
                ))}
                {session.kind === 'fixed' && !session.packageId && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)}>
                    {t('session.toOpen')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Drinks & food go straight on this device's account */}
          <DeviceDrinks sessionId={session.id} items={bill.data?.items ?? []} canAdd={!ended || can.checkout(role)} />

          {manage && !ended && (
            <Button variant="ghost" className="self-start text-danger" icon={<Ban className="size-4" />} onClick={() => setVoidOpen(true)}>
              {t('session.void')}
            </Button>
          )}
        </div>
      </Sheet>

      <TransferModal open={transferOpen} onOpenChange={setTransferOpen} floor={floor} sessionId={session.id} mode={mode} currentStationId={station.id} />
      <VoidSessionModal open={voidOpen} onOpenChange={setVoidOpen} sessionId={session.id} onDone={onClose} />
      <PaymentModal open={payOpen} onOpenChange={setPayOpen} sessionId={session.id} suggested={Math.max(0, due)} />
      {ctrl && <ControllerActions c={ctrl} floor={floor} onClose={() => setCtrlId(null)} />}
      <HandControllerModal open={addCtrlOpen} onOpenChange={setAddCtrlOpen} floor={floor} stationId={session.stationId} />
    </>
  );
}

/** "He paid 2.000 now": cash or visa, recorded against the session; the rest is paid at the end. */
function PaymentModal({ open, onOpenChange, sessionId, suggested }: { open: boolean; onOpenChange: (o: boolean) => void; sessionId: string; suggested: number }) {
  const { t } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const minor = amount === '' ? suggested : parseMoney(amount, f.decimals);
  const submit = async () => {
    if (!minor || minor <= 0) return;
    const ok = await run(() => post(`/api/sessions/${sessionId}/payments`, { amount: minor, method }), { success: t('pay.added') });
    if (ok) {
      setAmount('');
      onOpenChange(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('pay.receive')}
      size="sm"
      footer={
        <Button variant="primary" size="lg" block loading={busy} disabled={!minor || minor <= 0} onClick={submit}>
          {t('common.confirm')} {minor ? <>· <Money value={minor} /></> : null}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('pay.amount')} htmlFor="pay-amount">
          <Input
            id="pay-amount"
            autoFocus={autoFocusField()}
            inputMode="decimal"
            className="num h-14 text-center text-2xl font-semibold"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={f.money(suggested)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </Field>
        <Segmented
          size="lg"
          value={method}
          onChange={setMethod}
          options={[
            { value: 'cash', label: <span className="flex items-center gap-2"><Banknote className="size-4" /> {t('checkout.cash')}</span> },
            { value: 'card', label: <span className="flex items-center gap-2"><CreditCard className="size-4" /> {t('checkout.card')}</span> },
          ]}
        />
      </div>
    </Modal>
  );
}

/** Hand one more controller from the shelf to this station. */
function HandControllerModal({ open, onOpenChange, floor, stationId }: { open: boolean; onOpenChange: (o: boolean) => void; floor: Floor; stationId: string }) {
  const { t } = useT();
  const now = useNow();
  const { busy, run } = useAction();
  const spares = floor.controllers.filter((c) => stateOf(c, now) === 'spare');
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('controllers.addOne')} size="sm">
      {spares.length === 0 ? (
        <p className="py-6 text-center text-sm text-faint">{t('controllers.noneReady')}</p>
      ) : (
        <div className="flex flex-wrap gap-2 pb-2">
          {spares.map((c) => (
            <ControllerChip
              key={c.id}
              c={c}
              now={now}
              disabled={busy}
              onClick={async () => {
                if (await run(() => post(`/api/controllers/${c.id}/assign`, { stationId }))) onOpenChange(false);
              }}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

function ActionButton({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-14 items-center gap-3 rounded-card border border-line bg-surface-2 px-3.5 text-start text-sm font-medium transition-colors hover:border-line-strong hover:bg-surface-3 disabled:opacity-50"
    >
      <span className="text-muted">{icon}</span>
      <span className="leading-tight">{label}</span>
    </button>
  );
}

/**
 * What this device ordered, and one-tap adding of more drinks/food. Taps collect in a small
 * pending list first (so a mis-tap costs nothing), then one button puts them on the account.
 */
function DeviceDrinks({
  sessionId,
  items,
  canAdd,
}: {
  sessionId: string;
  items: { id: string; name: string; qty: number; unitPrice: number; voided: boolean }[];
  canAdd: boolean;
}) {
  const { t } = useT();
  const { busy, run } = useAction();
  const products = useProducts();
  const productList = products.data ?? [];
  const cart = useCart();
  const [voiding, setVoiding] = useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = useState('');

  const addToAccount = async () => {
    const res = await run(() => post<{ id: string; stock: StockLeft[] }>('/api/orders', { sessionId, items: cart.items }));
    if (res) {
      cart.clear();
      announceStock(res.stock, t, t('cafe.sent'));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-muted">
        <Coffee className="size-4" /> {t('session.drinks')}
      </div>
      {items.length > 0 && (
        <ul className="divide-y divide-line rounded-card border border-line">
          {items.map((i) => (
            <li key={i.id} className={clsx('flex items-center gap-3 px-3.5 py-2.5 text-sm', i.voided && 'opacity-50')}>
              <Num className="w-7 text-muted">{i.qty}×</Num>
              <span className={clsx('flex-1 truncate', i.voided && 'line-through')}>{i.name}</span>
              {i.voided ? <span className="text-xs text-faint">{t('session.itemVoided')}</span> : <Money value={i.qty * i.unitPrice} />}
              {!i.voided && (
                <button onClick={() => setVoiding({ id: i.id, name: i.name })} className="rounded p-1 text-faint hover:bg-danger/10 hover:text-danger" aria-label={t('session.voidItem')}>
                  <X className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <>
          <QuickProducts products={productList} cart={cart} />
          {cart.count > 0 && (
            <div className="rounded-card border border-accent/40 bg-accent/5 px-3">
              <CartLines cart={cart} products={productList} />
              <div className="flex gap-2 border-t border-line py-2.5">
                <Button variant="ghost" size="md" onClick={cart.clear}>
                  {t('cafe.clear')}
                </Button>
                <Button variant="primary" size="md" block loading={busy} onClick={addToAccount}>
                  {t('session.addToAccount')} · <Money value={cartTotal(cart, productList)} />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      <Modal
        open={!!voiding}
        onOpenChange={(o) => !o && setVoiding(null)}
        title={`${t('session.voidItem')} — ${voiding?.name ?? ''}`}
        size="sm"
        footer={
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const id = voiding!.id;
              const ok = await run((pin) => post(`/api/order-items/${id}/void`, { reason, approvalPin: pin }), { what: voiding!.name });
              if (ok) {
                setVoiding(null);
                setReason('');
              }
            }}
          >
            {t('session.voidItem')}
          </Button>
        }
      >
        <Field label={t('common.reason')} htmlFor="void-reason">
          <Input id="void-reason" autoFocus={autoFocusField()} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Modal>
    </div>
  );
}

function TransferModal({
  open,
  onOpenChange,
  floor,
  sessionId,
  mode,
  currentStationId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  floor: Floor;
  sessionId: string;
  mode: string;
  currentStationId: string;
}) {
  const { t, tk } = useT();
  const { busy, run } = useAction();
  const busyStations = new Set(floor.sessions.filter((s) => s.status === 'running').map((s) => s.stationId));
  const candidates = floor.stations.filter((s) => s.active && !s.maintenance && s.id !== currentStationId && !busyStations.has(s.id) && s.modes.includes(mode));

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('session.pickStation')} size="lg">
      {candidates.length === 0 ? (
        <p className="py-8 text-center text-muted">{t('session.noFreeStations')}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {candidates.map((s) => (
            <button
              key={s.id}
              disabled={busy}
              onClick={async () => {
                const ok = await run(() => post(`/api/sessions/${sessionId}/action`, { type: 'transfer', stationId: s.id }));
                if (ok) onOpenChange(false);
              }}
              className="flex flex-col items-start gap-1 rounded-card border border-line bg-surface-2 p-3 text-start hover:border-accent/60 hover:bg-accent/8"
            >
              <span className="flex items-center gap-2 font-semibold">
                <TypeIcon type={s.type} className="size-4 text-muted" />
                <span className="num">{s.name}</span>
                {s.tier === 'vip' && <VipBadge />}
              </span>
              <span className="text-xs text-muted">
                {s.zone} · {tk('tiers', s.tier)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function VoidSessionModal({ open, onOpenChange, sessionId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; sessionId: string; onDone: () => void }) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('session.void')}
      size="sm"
      footer={
        <Button
          variant="danger"
          loading={busy}
          disabled={reason.trim().length < 3}
          onClick={async () => {
            const ok = await run((pin) => post(`/api/sessions/${sessionId}/void`, { reason, approvalPin: pin }));
            if (ok) {
              onOpenChange(false);
              onDone();
            }
          }}
        >
          {t('session.void')}
        </Button>
      }
    >
      <Field label={t('session.voidReason')} htmlFor="void-session-reason">
        <Input id="void-session-reason" autoFocus={autoFocusField()} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
