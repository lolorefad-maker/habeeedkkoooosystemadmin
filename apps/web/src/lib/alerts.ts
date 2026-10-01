import { MINUTE } from '@lounge/core';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { usePrefs, useT } from '../i18n';
import { decideAlerts, type AlertMemory } from './alerts-core';
import { useNow } from './clock';
import { useFloor } from './queries';
import { playAlarm, playChime } from './sound';

const ACK_KEY = 'lounge-acks';
const REPEAT_MS = 2 * MINUTE;

/** "Time up" alerts someone already acknowledged on this device (so a reload does not ring again). */
function loadAcks(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ACK_KEY) || '{}') as Record<string, number>;
    const fresh = Object.entries(raw).filter(([, at]) => Date.now() - at < 24 * 60 * MINUTE);
    return new Set(fresh.map(([k]) => k));
  } catch {
    return new Set();
  }
}

function saveAck(key: string) {
  try {
    const raw = JSON.parse(localStorage.getItem(ACK_KEY) || '{}') as Record<string, number>;
    raw[key] = Date.now();
    localStorage.setItem(ACK_KEY, JSON.stringify(raw));
  } catch {
    /* storage unavailable: the ack lives until reload */
  }
}

/**
 * Rings when fixed time is about to end (soft chime) and when it is over (alarm, repeated every
 * 2 minutes until someone taps "OK" or opens the station). Screens pass `stationId` to follow one
 * station only (the customer display) and `toasts: false` to stay silent visually.
 */
export function useTimeAlerts(opts: { stationId?: string; toasts?: boolean } = {}) {
  const { t } = useT();
  const floor = useFloor();
  const now = useNow();
  const sound = usePrefs((s) => s.sound);
  const navigate = useNavigate();
  const memory = useRef(new Map<string, AlertMemory>());
  const acked = useRef<Set<string> | null>(null);
  const openToasts = useRef(new Set<string>());
  const showToasts = opts.toasts !== false;

  useEffect(() => {
    const data = floor.data;
    if (!data) return;
    acked.current ??= loadAcks();
    const ack = (key: string) => {
      acked.current!.add(key);
      openToasts.current.delete(key);
      saveAck(key);
    };

    const sessions = opts.stationId ? data.sessions.filter((s) => s.stationId === opts.stationId) : data.sessions;
    const actions = decideAlerts(sessions, memory.current, acked.current, now, {
      endingSoonMinutes: data.branch.settings.billing.endingSoonMinutes,
      repeatMs: showToasts ? REPEAT_MS : Number.POSITIVE_INFINITY,
    });

    for (const a of actions) {
      const station = data.stations.find((x) => x.id === a.stationId)?.name ?? '';
      const label = data.sessions.find((s) => s.id === a.sessionId)?.label ?? undefined;
      if (a.kind === 'soon') {
        if (sound) playChime();
        if (showToasts) {
          toast.info(t('alerts.endingSoon', { station, n: Math.max(1, Math.ceil(a.remainingMs / MINUTE)) }), { id: `soon:${a.key}`, description: label });
        }
        continue;
      }
      if (sound) playAlarm();
      if (a.kind === 'up' && showToasts) {
        openToasts.current.add(a.key);
        toast.warning(t('alerts.timeUp', { station }), {
          id: a.key,
          description: label,
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: t('alerts.open'),
            onClick: () => {
              ack(a.key);
              navigate(`/floor?station=${a.stationId}`);
            },
          },
          cancel: { label: t('alerts.ok'), onClick: () => ack(a.key) },
          onDismiss: () => ack(a.key),
        });
      }
    }

    // A session that was ended or extended no longer needs its "time up" notice.
    for (const key of openToasts.current) {
      if (!memory.current.has(key)) {
        openToasts.current.delete(key);
        toast.dismiss(key);
      }
    }
    // Every render re-evaluates from timestamps; nothing else to schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, floor.data, sound]);
}
