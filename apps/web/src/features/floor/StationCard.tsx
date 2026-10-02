import { clsx } from 'clsx';
import { CalendarClock, Coffee, Gamepad, Pause, Play, TriangleAlert, UserRound, Wallet, Wrench } from 'lucide-react';
import { memo } from 'react';
import { STATUS_ICON, TypeIcon, VipBadge } from '../../components/station/status';
import { Money, Num } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { serverNow } from '../../lib/clock';
import { useFmt } from '../../lib/format';
import type { StationView } from '../../lib/live';

/** Open or paused for longer than this → probably forgotten; the card says since when. */
const STALE_MS = 12 * 60 * 60_000;
/** Bookings this close are shown on the card. */
const BOOKED_AHEAD_MS = 12 * 60 * 60_000;

const PHONE_ORDER: Record<StationView['status'], string> = {
  overtime: 'max-sm:order-1',
  ending: 'max-sm:order-2',
  active: 'max-sm:order-3',
  paused: 'max-sm:order-4',
  reserved: 'max-sm:order-5',
  free: 'max-sm:order-6',
  off: 'max-sm:order-7',
};

/** A clock that can't be misread: always hours:minutes, with the seconds smaller ("0:58" + ":12"). */
function clock(ms: number) {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return { hm: `${h}:${String(m).padStart(2, '0')}`, ss: `:${String(s).padStart(2, '0')}` };
}

/**
 * The floor tile, readable from across the room:
 * - a device someone is playing on is FILLED solid (graphite playing, amber ending soon,
 *   red time's up, violet paused) with a big clock;
 * - a free device is a white card with a green "Available" pill and a Start button.
 * Status is always color + icon + words.
 */
export const StationCard = memo(function StationCard({
  view,
  rateLabel,
  controllers,
  onOpen,
  onTogglePause,
}: {
  view: StationView;
  rateLabel: string | null;
  /** Numbers of the controllers at this station. */
  controllers: number[];
  onOpen: (stationId: string) => void;
  /** One-tap pause / resume right on the card (staff who can manage sessions). */
  onTogglePause?: (view: StationView) => void;
}) {
  const { t, tk } = useT();
  const f = useFmt();
  const { station, status, session, bill, live, reservation } = view;
  const Icon = STATUS_ICON[status];
  const busy = !!session;
  const fixed = session?.kind === 'fixed' && session.plannedMinutes != null && live;
  const progress = fixed ? Math.min(1, live.playedMs / (session.plannedMinutes! * 60_000)) : 0;
  const mode = session?.segments.at(-1)?.mode;
  const running = (bill?.total ?? 0) + (session?.itemsTotal ?? 0);
  // A session left open or paused since another day must be obvious (it is usually forgotten):
  // its caption carries the date, with a warning mark.
  const stale = !!session && serverNow() - session.startedAt > STALE_MS;
  const when = (ms: number) => (serverNow() - ms > STALE_MS ? f.dateTime(ms) : f.time(ms));
  // A phone booking later today: shown on the card (free or busy) so nobody gives the station away.
  const booked = reservation && status !== 'reserved' && reservation.startAt - serverNow() < BOOKED_AHEAD_MS ? reservation : null;
  const lateMin = status === 'reserved' && reservation ? Math.floor((serverNow() - reservation.startAt) / 60_000) : 0;
  const quickPause = !!onTogglePause && session?.status === 'running';
  const paused = status === 'paused';

  return (
    // Phones: what needs attention first (time's up, ending, playing), free ones after.
    <div className={clsx('relative', PHONE_ORDER[status])}>
      <button
        type="button"
        data-status={status}
        onClick={() => onOpen(station.id)}
        className={clsx(
          'group relative flex h-full min-h-[156px] w-full flex-col overflow-hidden rounded-card border p-3 text-start shadow-[var(--shadow-card)] transition-[transform,box-shadow,background,border-color] duration-200 sm:p-4',
          'hover:-translate-y-0.5 hover:shadow-[var(--shadow-float)] focus-visible:-translate-y-0.5',
          busy
            ? 'st-filled'
            : status === 'reserved'
              ? 'tint'
              : status === 'off'
                ? 'border-dashed border-line-strong bg-surface-2'
                : 'border-line bg-surface-1 hover:border-st-free/60',
          status === 'overtime' && 'pulse-over',
        )}
        aria-label={`${station.name} — ${t(`status.${status}`)}`}
      >
        {station.tier === 'vip' && <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-vip/0 via-vip to-vip/0" />}

        {/* Name + VIP (the top-end corner is kept for the pause button) */}
        <div className={clsx('flex min-w-0 items-center gap-2', quickPause && 'pe-10')}>
          <TypeIcon type={station.type} className={clsx('size-5 shrink-0', busy ? 'text-on-fill/80' : 'text-muted')} />
          <span className="num truncate text-lg font-bold tracking-tight">{station.name}</span>
          {station.tier === 'vip' && <VipBadge onFill={busy} className="shrink-0" />}
        </div>

        {/* Status in words, always */}
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className={clsx(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
              busy ? 'bg-on-fill/18 text-on-fill' : status === 'off' ? 'bg-surface-3 text-muted' : 'st-soft',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {t(`status.${status}`)}
          </span>
          {mode && <span className="truncate text-xs text-on-fill/75">{tk('modes', mode)}</span>}
        </div>

        <div className="flex flex-1 flex-col justify-center py-2">
          {busy && live ? (
            <BusyClock
              ms={fixed && live.remainingMs != null ? live.remainingMs : live.playedMs}
              over={!!fixed && live.remainingMs != null && live.remainingMs < 0}
              stale={stale}
              caption={
                status === 'paused'
                  ? t('floor.pausedSince', { time: when(session.segments.at(-1)?.startedAt ?? session.startedAt) })
                  : fixed && live.remainingMs != null
                    ? live.remainingMs >= 0
                      ? t('floor.leftOf', { d: f.minutes(session.plannedMinutes!) })
                      : t('floor.timeUp')
                    : t('floor.openSince', { time: when(session.startedAt) })
              }
            />
          ) : status === 'reserved' && reservation ? (
            <div className="flex items-center gap-2">
              <CalendarClock className="st-fg size-5 shrink-0" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{reservation.customerName}</div>
                <div className="text-xs tabular-nums text-muted">{f.time(reservation.startAt)}</div>
                {lateMin > 0 && (
                  <div data-status="ending" className="st-fg text-xs font-semibold">
                    {t('floor.lateBy', { n: lateMin })}
                  </div>
                )}
              </div>
            </div>
          ) : status === 'off' ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Wrench className="size-4 shrink-0" />
              <span className="truncate">{station.maintenanceNote || t('status.off')}</span>
            </div>
          ) : (
            // Looks like a button so nobody wonders how to start; the whole card is the real target.
            <span className="flex h-10 items-center justify-center gap-2 rounded-control bg-surface-2 text-sm font-semibold text-fg ring-1 ring-line transition-colors group-hover:bg-accent group-hover:text-accent-fg group-hover:ring-accent group-focus-visible:bg-accent group-focus-visible:text-accent-fg">
              <Play className="size-4 fill-current" aria-hidden />
              {t('floor.start')}
            </span>
          )}
        </div>

        {booked && (
          <div
            data-status="reserved"
            className={clsx(
              'mb-2 flex items-center gap-1.5 rounded-control px-2 py-1 text-xs font-semibold',
              busy ? 'bg-on-fill/15 text-on-fill' : 'st-soft',
            )}
          >
            <CalendarClock className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{t('floor.bookedFor', { name: booked.customerName, time: f.time(booked.startAt) })}</span>
          </div>
        )}

        {fixed && (
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-on-fill/20" aria-hidden>
            <div className="h-full rounded-full bg-on-fill transition-[width] duration-1000 ease-linear" style={{ width: `${progress * 100}%` }} />
          </div>
        )}

        {/* Footer: who, what they have, what it costs so far — or the price per hour when free */}
        {/* The name takes its own line when controllers + drinks + prepayment leave it no room (a phone card). */}
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
          {busy ? (
            <>
              <span className="flex min-w-[5rem] flex-1 items-center gap-1 text-on-fill/85">
                {session.label && (
                  <>
                    <UserRound className="size-3.5 shrink-0" />
                    <span className="truncate">{session.label}</span>
                  </>
                )}
              </span>
              <span className="ms-auto flex shrink-0 items-center gap-2 text-on-fill/85">
                {controllers.length > 0 && (
                  <span className="flex items-center gap-0.5" aria-label={controllers.map((n) => t('controllers.number', { n })).join(', ')}>
                    <Gamepad className="size-3.5" aria-hidden />
                    <Num>{controllers.join('·')}</Num>
                  </span>
                )}
                {session.itemsCount > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Coffee className="size-3.5" />
                    <Num>{session.itemsCount}</Num>
                  </span>
                )}
                {session.paid > 0 && (
                  <span title={t('session.prepaid', { amount: f.money(session.paid) })}>
                    <Wallet className="size-3.5" aria-label={t('session.prepaid', { amount: f.money(session.paid) })} />
                  </span>
                )}
                {running > 0 && <Money value={running} className="text-sm font-bold text-on-fill" />}
              </span>
            </>
          ) : (
            rateLabel && (
              <span className="text-muted">
                <Num className="font-semibold text-fg">{rateLabel}</Num> {t('common.perHour')}
              </span>
            )
          )}
        </div>
      </button>
      {/* Pause / resume in one tap, without opening the station. A sibling of the card (not inside it). */}
      {quickPause && (
        <button
          type="button"
          onClick={() => onTogglePause!(view)}
          aria-label={paused ? t('floor.resumeNamed', { name: station.name }) : t('floor.pauseNamed', { name: station.name })}
          title={paused ? t('session.resume') : t('session.pause')}
          className="absolute end-2.5 top-2.5 z-10 grid size-9 place-items-center rounded-full bg-on-fill/15 text-on-fill transition-colors hover:bg-on-fill/30 focus-visible:bg-on-fill/30 sm:end-3 sm:top-3"
        >
          {paused ? <Play className="size-4 fill-current" aria-hidden /> : <Pause className="size-4 fill-current" aria-hidden />}
        </button>
      )}
    </div>
  );
});

function BusyClock({ ms, over, stale, caption }: { ms: number; over: boolean; stale: boolean; caption: string }) {
  const c = clock(ms);
  return (
    <div className="flex max-w-full flex-col items-start">
      <span className="num flex items-baseline leading-none" dir="ltr">
        {over && <span className="text-2xl font-bold">+</span>}
        <span className="text-[2rem] font-bold tracking-tight sm:text-[2.25rem]">{c.hm}</span>
        <span className="text-base font-semibold text-on-fill/70">{c.ss}</span>
      </span>
      <span className={clsx('mt-1 flex max-w-full items-center gap-1 text-xs', stale ? 'font-semibold text-on-fill' : 'text-on-fill/80')}>
        {stale && <TriangleAlert className="size-3.5 shrink-0" aria-hidden />}
        <span className="truncate">{caption}</span>
      </span>
    </div>
  );
}
