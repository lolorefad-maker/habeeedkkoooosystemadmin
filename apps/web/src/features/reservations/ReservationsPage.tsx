import { businessDayOf, businessDayRange, evaluateCancellation, parseMoney } from '@lounge/core';
import { clsx } from 'clsx';
import { CalendarClock, CalendarPlus, ChevronLeft, ChevronRight, Phone, UserRound } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useRef, useState } from 'react';
import { TypeIcon, VipBadge } from '../../components/station/status';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { EmptyState, Field, Input, Money, Num, Row, Segmented, Select, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { useNow } from '../../lib/clock';
import { isolate, useFmt } from '../../lib/format';
import { useFloor, useReservations } from '../../lib/queries';
import type { Floor, Reservation } from '../../lib/types';

const HOUR_PX = 84;
const STATUS_TONE: Record<Reservation['status'], string> = {
  confirmed: 'reserved',
  checked_in: 'active',
  completed: 'free',
  cancelled: 'off',
  no_show: 'overtime',
};

export function ReservationsPage() {
  const { t } = useT();
  const f = useFmt();
  const floor = useFloor();
  const now = useNow();
  const tz = floor.data?.branch.timezone ?? f.tz;
  const cutoff = floor.data?.branch.settings.day.cutoff ?? '06:00';
  const [day, setDay] = useState<string | null>(null);
  const today = businessDayOf(now, tz, cutoff);
  const current = day ?? today;
  const range = businessDayRange(current, tz, cutoff);
  const res = useReservations(range.start, range.end);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const shift = (days: number) => setDay(DateTime.fromISO(current).plus({ days }).toISODate()!);
  const list = res.data ?? [];
  const selected = list.find((r) => r.id === openId) ?? null;

  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-card border border-line bg-surface-1 p-1">
          <Button variant="ghost" size="icon" onClick={() => shift(-1)} aria-label="-1">
            <ChevronRight className="size-5 ltr:rotate-180" />
          </Button>
          <input
            type="date"
            value={current}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="num h-10 rounded-control bg-transparent px-2 text-base font-medium focus:outline-none sm:text-sm"
            aria-label={t('reservations.date')}
          />
          <Button variant="ghost" size="icon" onClick={() => shift(1)} aria-label="+1">
            <ChevronLeft className="size-5 ltr:rotate-180" />
          </Button>
        </div>
        {current !== today && (
          <Button variant="ghost" onClick={() => setDay(null)}>
            {t('common.today')}
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="primary" icon={<CalendarPlus className="size-4" />} onClick={() => setCreating(true)}>
          {t('reservations.new')}
        </Button>
      </div>

      {res.isLoading || !floor.data ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          <Timeline floor={floor.data} list={list} start={range.start} now={now} onOpen={setOpenId} />
          <AgendaList floor={floor.data} list={list} onOpen={setOpenId} />
        </>
      )}

      {floor.data && creating && (
        <NewReservation open onOpenChange={setCreating} floor={floor.data} day={current === today ? undefined : current} />
      )}
      {floor.data && selected && <ReservationDetails r={selected} floor={floor.data} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** Stations × hours. Where the gaps are is obvious at a glance. */
function Timeline({ floor, list, start, now, onOpen }: { floor: Floor; list: Reservation[]; start: number; now: number; onOpen: (id: string) => void }) {
  const { t } = useT();
  const f = useFmt();
  const scroller = useRef<HTMLDivElement>(null);
  const hours = Array.from({ length: 24 }, (_, i) => start + i * 3_600_000);
  const x = (ms: number) => ((ms - start) / 3_600_000) * HOUR_PX;
  const nowX = now >= start && now < start + 24 * 3_600_000 ? x(now) : null;
  const stations = floor.stations.filter((s) => s.active);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = Math.max(0, (nowX ?? x(start + 10 * 3_600_000)) - 160);
    el.scrollLeft = document.documentElement.dir === 'rtl' ? -target : target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  return (
    <div className="hidden overflow-hidden rounded-card border border-line bg-surface-1 md:block">
      <div ref={scroller} className="overflow-x-auto">
        <div className="relative" style={{ width: 160 + 24 * HOUR_PX }}>
          <div className="sticky top-0 z-10 flex border-b border-line bg-surface-1">
            <div className="sticky start-0 z-20 w-40 shrink-0 border-e border-line bg-surface-1" />
            {hours.map((h) => (
              <div key={h} className="shrink-0 border-e border-line/60 px-2 py-2 text-start text-xs text-faint" style={{ width: HOUR_PX }}>
                <Num>{f.time(h)}</Num>
              </div>
            ))}
          </div>
          {stations.map((s) => (
            <div key={s.id} className="relative flex h-14 border-b border-line/60 last:border-0">
              <div className="sticky start-0 z-10 flex w-40 shrink-0 items-center gap-2 border-e border-line bg-surface-1 px-3">
                <TypeIcon type={s.type} className="size-4 text-muted" />
                <span className="num text-sm font-medium">{s.name}</span>
                {s.tier === 'vip' && <VipBadge />}
              </div>
              <div className="relative flex-1">
                {hours.map((h, i) => (
                  <div key={h} className="absolute inset-y-0 border-e border-line/40" style={{ insetInlineStart: (i + 1) * HOUR_PX }} />
                ))}
                {list
                  .filter((r) => r.stationId === s.id)
                  .map((r) => (
                    <button
                      key={r.id}
                      data-status={STATUS_TONE[r.status]}
                      onClick={() => onOpen(r.id)}
                      className={clsx(
                        'tint-strong absolute inset-y-1.5 flex flex-col justify-center overflow-hidden rounded-control border px-2 text-start text-xs transition-transform hover:z-10 hover:scale-[1.02]',
                        (r.status === 'cancelled' || r.status === 'no_show') && 'opacity-55',
                      )}
                      style={{ insetInlineStart: x(r.startAt), width: Math.max(28, (r.minutes / 60) * HOUR_PX - 4) }}
                      title={`${r.customerName} · ${f.time(r.startAt)}`}
                    >
                      <span className="truncate font-semibold">{r.customerName}</span>
                      <span className="num truncate text-[10px] opacity-80">
                        {f.time(r.startAt)} · {t(`reservations.statuses.${r.status}`)}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          ))}
          {nowX != null && (
            <div className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-danger" style={{ insetInlineStart: 160 + nowX }}>
              <span className="absolute start-1 top-9 rounded bg-danger px-1 text-[10px] font-semibold text-white">{t('common.now')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgendaList({ floor, list, onOpen }: { floor: Floor; list: Reservation[]; onOpen: (id: string) => void }) {
  const { t } = useT();
  const f = useFmt();
  if (list.length === 0) return <EmptyState icon={<CalendarClock />} title={t('reservations.empty')} />;
  return (
    <ul className="flex flex-col gap-2 md:hidden">
      {list.map((r) => {
        const st = floor.stations.find((s) => s.id === r.stationId);
        return (
          <li key={r.id}>
            <button data-status={STATUS_TONE[r.status]} onClick={() => onOpen(r.id)} className="tint flex w-full items-center gap-3 rounded-card border p-3 text-start">
              <Num className="st-fg w-14 text-lg font-semibold">{f.time(r.startAt)}</Num>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.customerName}</div>
                <div className="text-xs text-muted">
                  <span className="num">{st?.name}</span> · {f.minutes(r.minutes)}
                </div>
              </div>
              <span className="st-soft rounded-full px-2 py-0.5 text-xs">{t(`reservations.statuses.${r.status}`)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The next quarter hour at least 15 minutes from now, in the shop's time zone. */
function nextSlot(tz: string, plusMinutes = 15) {
  const d = DateTime.now().setZone(tz).plus({ minutes: plusMinutes }).set({ second: 0, millisecond: 0 });
  return d.plus({ minutes: (15 - (d.minute % 15)) % 15 });
}

/**
 * A phone booking: station, when, how long, name. The station is held for the customer (it shows
 * "reserved" on the floor shortly before) — nothing starts until they arrive and are checked in.
 */
export function NewReservation({
  open,
  onOpenChange,
  floor,
  day,
  initialStationId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  floor: Floor;
  /** A business day picked on the reservations page; otherwise the next free slot today. */
  day?: string;
  initialStationId?: string;
}) {
  const { t, tk } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const tz = floor.branch.timezone;
  const stations = floor.stations.filter((s) => s.active && !s.maintenance);
  const [stationId, setStationId] = useState(initialStationId ?? stations[0]?.id ?? '');
  const station = stations.find((s) => s.id === stationId);
  const slot = nextSlot(tz);
  const [date, setDate] = useState(day && day !== slot.toISODate() ? day : slot.toISODate()!);
  const [time, setTime] = useState(day && day !== slot.toISODate() ? '20:00' : slot.toFormat('HH:mm'));
  const setFromNow = (minutes: number) => {
    const at = nextSlot(tz, minutes);
    setDate(at.toISODate()!);
    setTime(at.toFormat('HH:mm'));
  };
  const [minutes, setMinutes] = useState(60);
  const [mode, setMode] = useState(station?.modes[0] ?? 'single');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [deposit, setDeposit] = useState('');
  const [method, setMethod] = useState<'cash' | 'card'>('cash');

  useEffect(() => {
    if (day) setDate(day);
  }, [day]);
  useEffect(() => {
    if (station && !station.modes.includes(mode)) setMode(station.modes[0] ?? 'single');
  }, [station, mode]);

  const depositMinor = deposit ? parseMoney(deposit, f.decimals) : null;
  const startAt = DateTime.fromISO(`${date}T${time}`, { zone: floor.branch.timezone }).toMillis();
  const valid = !!station && name.trim() && Number.isFinite(startAt) && (deposit === '' || (depositMinor != null && depositMinor > 0));

  const submit = async () => {
    const ok = await run(
      () =>
        post('/api/reservations', {
          stationId,
          startAt,
          minutes,
          mode,
          customerName: name.trim(),
          customerPhone: phone.trim() || null,
          deposit: depositMinor ? { amount: depositMinor, method } : null,
        }),
      { success: t('reservations.created') },
    );
    if (ok) {
      setName('');
      setPhone('');
      setDeposit('');
      onOpenChange(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('reservations.new')}
      size="md"
      footer={
        <Button variant="primary" size="lg" block loading={busy} disabled={!valid} onClick={submit}>
          {t('reservations.create')}
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {/* A phone booking starts with who is coming. */}
        <Field label={t('start.customer')} htmlFor="r-name">
          <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" />
        </Field>
        <Field label={t('common.phone')} htmlFor="r-phone">
          <Input id="r-phone" type="tel" dir="ltr" className="num text-start" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t('common.optional')} />
        </Field>
        <Field label={t('reservations.station')} htmlFor="r-station" className="sm:col-span-2">
          <Select id="r-station" value={stationId} onChange={(e) => setStationId(e.target.value)}>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {isolate(s.name)} · {tk('types', s.type)} · {tk('tiers', s.tier)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('reservations.date')} htmlFor="r-date">
          <Input id="r-date" type="date" className="num" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t('reservations.time')} htmlFor="r-time">
          <Input id="r-time" type="time" className="num" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        {/* "He'll come in half an hour": one tap instead of typing a time. */}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          {[30, 60, 120].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setFromNow(m)}
              className="h-9 rounded-full border border-line px-3.5 text-sm font-medium text-muted hover:border-accent/50 hover:text-accent"
            >
              {t('reservations.inMinutes', { d: f.minutes(m) })}
            </button>
          ))}
        </div>
        <Field label={t('reservations.duration')} className="sm:col-span-2">
          <Segmented
            value={String(minutes)}
            onChange={(v) => setMinutes(Number(v))}
            options={[30, 60, 90, 120, 180].map((m) => ({ value: String(m), label: f.minutes(m) }))}
          />
        </Field>
        {station && station.modes.length > 1 && (
          <Field label={t('start.mode')} className="sm:col-span-2">
            <Segmented value={mode} onChange={setMode} options={station.modes.map((m) => ({ value: m, label: tk('modes', m) }))} />
          </Field>
        )}
        <Field label={t('reservations.deposit')} htmlFor="r-deposit" hint={!floor.shift && deposit ? t('shift.noneHint') : undefined}>
          <Input id="r-deposit" inputMode="decimal" className="num" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder={t('reservations.depositNone')} />
        </Field>
        {deposit && (
          <Field label={t('checkout.method')}>
            <Segmented value={method} onChange={setMethod} options={[{ value: 'cash', label: t('checkout.cash') }, { value: 'card', label: t('checkout.card') }]} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function ReservationDetails({ r, floor, onClose }: { r: Reservation; floor: Floor; onClose: () => void }) {
  const { t, tk } = useT();
  const f = useFmt();
  const now = useNow();
  const { busy, run } = useAction();
  const st = floor.stations.find((s) => s.id === r.stationId);
  const cancel = evaluateCancellation(r, now, floor.branch.settings.reservations);
  const owed = r.deposit - r.fee - r.refunded;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={r.customerName}
      description={t(`reservations.statuses.${r.status}`)}
      size="sm"
      footer={
        <div className="flex w-full flex-col gap-2">
          {r.status === 'confirmed' && (
            <>
              <Button
                variant="primary"
                size="lg"
                block
                loading={busy}
                onClick={async () => {
                  const ok = await run(() => post('/api/sessions', { stationId: r.stationId, mode: r.mode, kind: 'fixed', plannedMinutes: r.minutes, reservationId: r.id, label: r.customerName }));
                  if (ok) onClose();
                }}
              >
                {t('reservations.checkIn')}
              </Button>
              <p className="text-center text-xs text-muted">
                {r.deposit > 0 &&
                  (cancel.late
                    ? t('reservations.cancelLate', { fee: f.money(cancel.fee), refund: f.money(cancel.refund) })
                    : t('reservations.cancelFree', { amount: f.money(cancel.refund) }))}
              </p>
              <Button
                variant="danger"
                block
                loading={busy}
                onClick={async () => {
                  const ok = await run(() => post(`/api/reservations/${r.id}/cancel`, { refundMethod: 'cash' }));
                  if (ok) onClose();
                }}
              >
                {t('reservations.cancel')}
              </Button>
            </>
          )}
          {(r.status === 'no_show' || r.status === 'cancelled') && owed > 0 && (
            <Button block loading={busy} onClick={() => run(() => post(`/api/reservations/${r.id}/refund`, { method: 'cash' }))}>
              {t('reservations.refund')} · <Money value={owed} />
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col">
        <Row label={t('reservations.station')} value={<span className="num">{st?.name}</span>} />
        <Row label={t('reservations.time')} value={<Num>{f.dateTime(r.startAt)}</Num>} />
        <Row label={t('reservations.duration')} value={f.minutes(r.minutes)} />
        <Row label={t('start.mode')} value={tk('modes', r.mode)} />
        {r.customerPhone && (
          <Row
            label={t('common.phone')}
            value={
              <a href={`tel:${r.customerPhone}`} className="num flex items-center gap-1 text-accent">
                <Phone className="size-3.5" /> {r.customerPhone}
              </a>
            }
          />
        )}
        <Row label={t('reservations.deposit')} value={<Money value={r.deposit} />} />
        {r.fee > 0 && <Row label={t('reports.fees')} value={<Money value={r.fee} />} />}
        {r.refunded > 0 && <Row label={t('reports.refunds')} value={<Money value={r.refunded} />} />}
        <div className="mt-2 flex items-center gap-2 text-xs text-faint">
          <UserRound className="size-3.5" /> {r.customerName}
        </div>
      </div>
    </Modal>
  );
}
