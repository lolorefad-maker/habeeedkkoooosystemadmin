import { computeTimeBill, packageMatches, parseMoney, type BillingContext } from '@lounge/core';
import { clsx } from 'clsx';
import {
  Banknote,
  CalendarClock,
  CalendarPlus,
  ChevronDown,
  Coffee,
  CreditCard,
  Gamepad,
  Minus,
  Package,
  Play,
  Plus,
  TriangleAlert,
  UserRound,
  Wallet,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { StatusBadge, TypeIcon, VipBadge } from '../../components/station/status';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Sheet } from '../../components/ui/overlays';
import { Field, Input, Money, Num, Segmented } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { can, useAuth } from '../../lib/auth';
import { useNow } from '../../lib/clock';
import { useFmt } from '../../lib/format';
import { rateNow, type StationView } from '../../lib/live';
import { useProducts } from '../../lib/queries';
import type { Floor, Reservation } from '../../lib/types';
import { announceStock, CartLines, cartTotal, QuickProducts, useCart, type StockLeft } from '../cafe/products';
import { ControllerPicker } from '../controllers/parts';

type Kind = 'open' | 'fixed' | 'package';
const QUICK_MINUTES = [30, 60, 90, 120, 180];

export function StartSheet({
  view,
  floor,
  ctx,
  onClose,
  onBook,
  onReservation,
}: {
  view: StationView;
  floor: Floor;
  ctx: BillingContext;
  onClose: () => void;
  onBook: (stationId: string) => void;
  onReservation: (r: Reservation) => void;
}) {
  const { t, tk } = useT();
  const f = useFmt();
  const now = useNow();
  const role = useAuth((s) => s.user?.role);
  const { station, reservation, holding } = view;
  const [mode, setMode] = useState(reservation && holding && station.modes.includes(reservation.mode) ? reservation.mode : (station.modes[0] ?? 'single'));
  const [kind, setKind] = useState<Kind>('open');
  const [minutes, setMinutes] = useState(60);
  const [packageId, setPackageId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [showName, setShowName] = useState(false);
  const [showDrinks, setShowDrinks] = useState(false);
  const [prepaid, setPrepaid] = useState(false);
  const [paidInput, setPaidInput] = useState('');
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  // Controllers already sitting at this station are pre-selected; the rest come from the shelf.
  const products = useProducts();
  const productList = products.data ?? [];
  const cart = useCart();
  const [controllerIds, setControllerIds] = useState<string[]>(() =>
    floor.controllers.filter((c) => c.stationId === station.id && c.status === 'ready').map((c) => c.id),
  );
  const [override, setOverride] = useState(false);
  const { busy, run } = useAction();

  const matchingPackages = useMemo(
    () => ctx.packages.filter((p) => p.active && packageMatches(p, { id: station.id, type: station.type, tier: station.tier }, mode)),
    [ctx.packages, station, mode],
  );

  const quote = rateNow(ctx, station, mode, now);
  const selectedPkg = matchingPackages.find((p) => p.id === packageId) ?? null;

  // Price of the planned time, computed by the same engine the server uses.
  const estimate = useMemo(() => {
    if (kind === 'package') return selectedPkg?.price ?? null;
    if (kind !== 'fixed') return null;
    const start = now; // exact time, so a discount started a moment ago is already in the estimate
    try {
      return computeTimeBill(
        { kind: 'fixed', plannedMinutes: minutes, segments: [{ stationId: station.id, mode, paused: false, startedAt: start, endedAt: start + minutes * 60_000 }] },
        ctx,
        start + minutes * 60_000,
      ).total;
    } catch {
      return null;
    }
  }, [kind, minutes, mode, selectedPkg, ctx, station.id, now]);

  const plannedMinutes = kind === 'fixed' ? minutes : kind === 'package' ? (selectedPkg?.minutes ?? null) : null;
  const endsAt = plannedMinutes ? now + plannedMinutes * 60_000 : null;
  const reservedByOther = holding && reservation && !override;
  const noShift = !floor.shift;
  // Typed amount wins; for fixed time / packages the estimate is the default.
  const paidMinor = paidInput !== '' ? parseMoney(paidInput, f.decimals) : kind !== 'open' ? estimate : null;
  const prepaidValid = !prepaid || (paidMinor != null && paidMinor > 0);

  const start = async (withReservation: boolean) => {
    const body = {
      stationId: station.id,
      mode,
      kind: kind === 'package' ? 'fixed' : kind,
      plannedMinutes: kind === 'fixed' ? minutes : null,
      packageId: kind === 'package' ? packageId : null,
      label: label.trim() || null,
      reservationId: withReservation && reservation ? reservation.id : null,
      overrideReservation: !withReservation && holding ? true : undefined,
      prepaid: prepaid && !noShift && paidMinor ? { amount: paidMinor, method } : null,
      controllerIds,
      items: cart.items,
    };
    const res = await run(() => post<{ id: string; stock: StockLeft[] }>('/api/sessions', body));
    if (res?.stock.length) announceStock(res.stock, t, t('cafe.sent'));
  };

  const disabled = station.maintenance || !quote || (kind === 'package' && !selectedPkg) || !prepaidValid;

  return (
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
      description={[station.zone, tk('types', station.type), tk('tiers', station.tier)].filter(Boolean).join(' · ')}
      headerExtra={<StatusBadge status={view.status} />}
      footer={
        reservedByOther ? (
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="xl" block loading={busy} onClick={() => start(true)} icon={<CalendarClock className="size-5" />}>
              {t('start.checkIn', { name: reservation.customerName })}
            </Button>
            <Button variant="ghost" block onClick={() => setOverride(true)}>
              {t('start.override')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              size="xl"
              block
              loading={busy}
              disabled={disabled}
              onClick={() => start(false)}
              icon={<Play className="size-5 fill-current" />}
            >
              {t('start.start')}
              {estimate != null && kind !== 'open' && (
                <span className="ms-1 opacity-80">
                  · <Money value={estimate} />
                </span>
              )}
            </Button>
            {/* A phone booking: hold the station for later without starting anything. */}
            {can.reservations(role) && !station.maintenance && (
              <Button variant="ghost" block onClick={() => onBook(station.id)} icon={<CalendarPlus className="size-4" />}>
                {t('start.bookLater')}
              </Button>
            )}
          </div>
        )
      }
    >
      <div className="flex flex-col gap-6">
        {station.maintenance && (
          <Banner status="off" icon={<Wrench className="size-5" />}>
            {t('start.maintenance')}
            {station.maintenanceNote && <span className="block text-muted">{station.maintenanceNote}</span>}
          </Banner>
        )}

        {reservation && (
          <Banner status="reserved" icon={<CalendarClock className="size-5" />}>
            {t('start.reservedBanner', { name: reservation.customerName, time: f.time(reservation.startAt) })}
            <span className="block text-xs text-muted">
              {f.minutes(reservation.minutes)} · {tk('modes', reservation.mode)}
              {reservation.deposit > 0 && (
                <>
                  {' · '}
                  {t('reservations.deposit')} <Money value={reservation.deposit} />
                </>
              )}
            </span>
            {now > reservation.startAt && (
              <span data-status="ending" className="st-fg mt-1 block text-xs font-semibold">
                {t('floor.lateBy', { n: Math.floor((now - reservation.startAt) / 60_000) })}
              </span>
            )}
            {can.reservations(role) && (
              <Button size="sm" variant="ghost" className="-ms-2 mt-1 text-danger" onClick={() => onReservation(reservation)}>
                {t('start.cancelBooking')}
              </Button>
            )}
          </Banner>
        )}

        {station.modes.length > 1 && (
          <Field label={t('start.mode')}>
            <Segmented
              size="lg"
              value={mode}
              onChange={setMode}
              options={station.modes.map((m) => {
                const q = rateNow(ctx, station, m, now);
                return { value: m, label: tk('modes', m), hint: q ? `${f.rate(q.perHour)} ${t('common.perHour')}` : '—' };
              })}
            />
          </Field>
        )}

        {!quote && !station.maintenance && (
          <Banner status="overtime" icon={<TriangleAlert className="size-5" />}>
            {t('start.noPrice')}
          </Banner>
        )}

        <Field label={t('start.time')}>
          <Segmented
            value={kind}
            onChange={(k) => {
              setKind(k);
              if (k === 'package' && !packageId) setPackageId(matchingPackages[0]?.id ?? null);
              if (k === 'open') setPrepaid(false);
            }}
            options={[
              { value: 'open', label: t('kinds.open') },
              { value: 'fixed', label: t('kinds.fixed') },
              ...(matchingPackages.length ? [{ value: 'package' as const, label: t('kinds.package') }] : []),
            ]}
          />
        </Field>

        {kind === 'fixed' && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {QUICK_MINUTES.map((m) => (
                <button
                  key={m}
                  onClick={() => setMinutes(m)}
                  className={clsx(
                    'h-11 min-w-16 flex-1 rounded-control border px-3 text-sm font-medium transition-colors',
                    minutes === m ? 'border-accent bg-accent/12 text-accent' : 'border-line bg-surface-2 text-muted hover:text-fg',
                  )}
                >
                  {f.minutes(m)}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between rounded-card bg-surface-2 p-2">
              <Button variant="ghost" size="icon" onClick={() => setMinutes((m) => Math.max(15, m - 15))} aria-label="-15">
                <Minus className="size-5" />
              </Button>
              <div className="flex flex-col items-center">
                <span className="text-lg font-semibold">{f.minutes(minutes)}</span>
                {endsAt && <span className="text-xs tabular-nums text-muted">{t('start.endsAt', { time: f.time(endsAt) })}</span>}
              </div>
              <Button variant="ghost" size="icon" onClick={() => setMinutes((m) => Math.min(24 * 60, m + 15))} aria-label="+15">
                <Plus className="size-5" />
              </Button>
            </div>
          </div>
        )}

        {kind === 'package' && (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label={t('start.packages')}>
            {matchingPackages.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={packageId === p.id}
                onClick={() => setPackageId(p.id)}
                className={clsx(
                  'flex items-center gap-3 rounded-card border p-3.5 text-start transition-colors',
                  packageId === p.id ? 'border-accent bg-accent/10' : 'border-line bg-surface-2 hover:border-line-strong',
                )}
              >
                <Package className={clsx('size-5', packageId === p.id ? 'text-accent' : 'text-muted')} />
                <span className="flex-1">
                  <span className="block font-medium">{p.name}</span>
                  <span className="text-xs text-muted">{f.minutes(p.minutes)}</span>
                </span>
                <Money value={p.price} currency className="font-semibold" />
              </button>
            ))}
          </div>
        )}

        {kind !== 'open' && estimate != null && (
          <div className="flex items-center justify-between rounded-card border border-line bg-surface-2 px-4 py-3">
            <span className="text-sm text-muted">{t('start.estimate')}</span>
            <Money value={estimate} currency className="text-xl font-semibold" />
          </div>
        )}

        {station.type !== 'vr' && (
          <Field label={<span className="flex items-center gap-2"><Gamepad className="size-4" /> {t('controllers.handed')}</span>}>
            <ControllerPicker floor={floor} stationId={station.id} value={controllerIds} onChange={setControllerIds} />
          </Field>
        )}

        {/* The rest is optional: one short row each, opened only when needed. */}
        <div className="flex flex-col gap-2">
          <OptionRow
            icon={<UserRound />}
            label={t('start.customer')}
            summary={label.trim() || t('common.optional')}
            open={showName}
            onToggle={() => setShowName((v) => !v)}
          >
            <Input
              autoFocus
              aria-label={t('start.customer')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('start.customerPh')}
              maxLength={80}
            />
          </OptionRow>

          <OptionRow
            icon={<Coffee />}
            label={t('session.drinks')}
            summary={
              cart.count > 0 ? (
                <span className="flex items-center gap-1.5 font-medium text-fg">
                  <Num>{cart.count}×</Num> · <Money value={cartTotal(cart, productList)} />
                </span>
              ) : (
                t('common.optional')
              )
            }
            open={showDrinks}
            onToggle={() => setShowDrinks((v) => !v)}
          >
            <QuickProducts products={productList} cart={cart} />
            {cart.count > 0 && (
              <div className="mt-2 rounded-card border border-line px-3">
                <CartLines cart={cart} products={productList} />
                <div className="flex items-center justify-between border-t border-line py-2 text-sm">
                  <span className="text-muted">{t('common.total')}</span>
                  <Money value={cartTotal(cart, productList)} className="font-semibold" />
                </div>
              </div>
            )}
          </OptionRow>

          <OptionRow
            icon={<Wallet />}
            label={t('start.prepaid')}
            hint={noShift ? t('shift.noneHint') : undefined}
            disabled={noShift}
            summary={
              !prepaid || noShift ? (
                t('start.noPrepaid')
              ) : paidMinor ? (
                <span className="flex items-center gap-1.5 font-medium text-fg">
                  <Money value={paidMinor} /> · {method === 'cash' ? t('checkout.cash') : t('checkout.card')}
                </span>
              ) : null
            }
            open={prepaid && !noShift}
            onToggle={() => setPrepaid((v) => !v)}
          >
            <div className="flex flex-col gap-3">
              <Field label={t('start.prepaidAmount')} htmlFor="start-paid">
                <Input
                  id="start-paid"
                  inputMode="decimal"
                  className="num h-12 text-center text-xl font-semibold"
                  value={paidInput}
                  onChange={(e) => setPaidInput(e.target.value)}
                  placeholder={kind !== 'open' && estimate != null ? f.money(estimate) : f.money(0)}
                />
              </Field>
              <Segmented
                value={method}
                onChange={setMethod}
                options={[
                  { value: 'cash', label: <span className="flex items-center gap-2"><Banknote className="size-4" /> {t('checkout.cash')}</span> },
                  { value: 'card', label: <span className="flex items-center gap-2"><CreditCard className="size-4" /> {t('checkout.card')}</span> },
                ]}
              />
            </div>
          </OptionRow>
        </div>
      </div>
    </Sheet>
  );
}

/** A one-line optional part of opening a device: label + what is filled in; tap to open it. */
function OptionRow({
  icon,
  label,
  summary,
  hint,
  open,
  disabled,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  summary: React.ReactNode;
  hint?: string;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={clsx('rounded-card border transition-colors', open ? 'border-line-strong bg-surface-2/40' : 'border-line')}>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center gap-3 rounded-card px-3.5 py-2 text-start transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <span className="shrink-0 text-muted [&_svg]:size-4">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{label}</span>
          {hint && <span className="text-xs text-faint">{hint}</span>}
        </span>
        <span className="min-w-0 truncate text-sm text-muted">{summary}</span>
        <ChevronDown className={clsx('size-4 shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && <div className="border-t border-line p-3.5">{children}</div>}
    </div>
  );
}

export function Banner({ status, icon, children }: { status: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div data-status={status} className="tint flex items-start gap-3 rounded-card border p-3.5 text-sm font-medium">
      <span className="st-fg mt-0.5">{icon}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}
