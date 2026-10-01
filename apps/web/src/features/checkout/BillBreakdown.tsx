import type { TimeBill } from '@lounge/core';
import { Money, Num, Row } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { useFmt } from '../../lib/format';
import type { Station } from '../../lib/types';

/** Every line of a time charge: which station, which mode, how long, at what rate. No surprises. */
export function TimeLines({ time, stations }: { time: TimeBill; stations: Station[] }) {
  const { t, tk } = useT();
  const f = useFmt();
  const name = (id: string) => stations.find((s) => s.id === id)?.name ?? '—';

  return (
    <div className="flex flex-col">
      {time.lines.map((l, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
          <div className="min-w-0">
            <div className="truncate text-fg">
              <span className="num">{name(l.stationId)}</span> · {tk('modes', l.mode)}
            </div>
            <div className="text-xs text-faint">
              <span className="tabular-nums">
                {f.time(l.from)} – {f.time(l.to)}
              </span>{' '}
              · {f.span(l.ms)} · <Num>{f.rate(l.perHour)}</Num>
              {t('common.perHour')}
            </div>
          </div>
          <Money value={l.amount} className="shrink-0 text-fg" />
        </div>
      ))}
      {time.pausedMs > 0 && <Row muted label={t('session.paused')} value={<Num>{f.duration(time.pausedMs)}</Num>} />}
      {time.adjustment.reason && time.adjustment.amount !== 0 && (
        <Row
          label={
            <span>
              {t(`session.adjustment.${time.adjustment.reason}`)}{' '}
              <Num className="text-faint">
                ({time.adjustment.ms > 0 ? '+' : '−'}
                {f.duration(Math.abs(time.adjustment.ms))})
              </Num>
            </span>
          }
          value={<Money value={time.adjustment.amount} />}
        />
      )}
      {time.package && (
        <Row
          label={t('session.package', { name: time.package.name })}
          value={
            <span className="text-st-free">
              −<Money value={time.savings} />
            </span>
          }
        />
      )}
      {time.capApplied && !time.package && (
        <Row
          label={t('session.cap')}
          value={
            <span className="text-st-free">
              −<Money value={time.savings} />
            </span>
          }
        />
      )}
    </div>
  );
}
