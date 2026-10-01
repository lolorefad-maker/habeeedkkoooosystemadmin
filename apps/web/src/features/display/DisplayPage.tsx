import { clsx } from 'clsx';
import { Bell } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router';
import { STATUS_ICON, TypeIcon } from '../../components/station/status';
import { usePrefs, useT } from '../../i18n';
import { useTimeAlerts } from '../../lib/alerts';
import { useClockTicker, useNow } from '../../lib/clock';
import { installAudioUnlock, unlockAudio, useAudio } from '../../lib/sound';
import { useFmt } from '../../lib/format';
import { stationViews, useBillingContext } from '../../lib/live';
import { useFloor } from '../../lib/queries';
import { useRealtime } from '../../lib/realtime';

/**
 * Customer-facing screen for one station (a TV or tablet next to it): huge, calm, readable
 * from the couch. Open /display/<stationId> on that device.
 */
export function DisplayPage() {
  useRealtime();
  useClockTicker();
  const { stationId } = useParams();
  // The customer hears the chime/alarm of their own station only, without notices on screen.
  useTimeAlerts({ stationId, toasts: false });
  useEffect(() => installAudioUnlock(), []);
  const sound = usePrefs((s) => s.sound);
  const audio = useAudio((s) => s.state);
  const { t } = useT();
  const f = useFmt();
  const floor = useFloor();
  const now = useNow();
  const ctx = useBillingContext(floor.data);
  const view = useMemo(() => (floor.data && ctx ? stationViews(floor.data, ctx, now).find((v) => v.station.id === stationId) : null), [floor.data, ctx, now, stationId]);

  if (!view) return <div className="grid h-full place-items-center text-muted">{t('common.loading')}</div>;
  const { station, status, live, session } = view;
  const Icon = STATUS_ICON[status];
  const fixed = session?.kind === 'fixed' && live?.remainingMs != null;
  const big = live ? (fixed ? (live.remainingMs! >= 0 ? f.duration(live.remainingMs!) : `+${f.duration(-live.remainingMs!)}`) : f.duration(live.playedMs)) : f.time(now);

  return (
    <div data-status={status} className="relative flex h-full flex-col items-center justify-center gap-8 overflow-hidden p-8">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-50" style={{ background: 'radial-gradient(50rem 30rem at 50% 40%, color-mix(in oklab, var(--st) 28%, transparent), transparent 70%)' }} />
      <div className="relative flex items-center gap-4 text-3xl font-semibold text-muted">
        <TypeIcon type={station.type} className="size-10" />
        <span className="num">{station.name}</span>
      </div>
      <div className={clsx('num relative text-[min(22vw,14rem)] font-bold leading-none tracking-tight', status === 'overtime' && 'st-fg')}>{big}</div>
      <div className="st-soft relative flex items-center gap-3 rounded-full px-6 py-3 text-2xl font-medium">
        <Icon className="size-7" />
        {live ? (fixed ? (live.remainingMs! >= 0 ? t('floor.remaining') : t('floor.over')) : t('floor.elapsed')) : t(`status.${status}`)}
      </div>
      {/* Browsers block sound until the screen is tapped once. */}
      {sound && audio === 'locked' && (
        <button onClick={() => void unlockAudio()} className="absolute bottom-6 flex items-center gap-2 rounded-full bg-surface-2 px-4 py-2 text-sm text-muted">
          <Bell className="size-4" /> {t('alerts.tapToEnable')}
        </button>
      )}
    </div>
  );
}
