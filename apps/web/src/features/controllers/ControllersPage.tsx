import { chargeRemainingMs, type ControllerState } from '@lounge/core';
import { clsx } from 'clsx';
import { Gamepad, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { EmptyState, Field, Input, Num, Skeleton } from '../../components/ui/primitives';
import { useT, type TKey } from '../../i18n';
import { post } from '../../lib/api';
import { can, useAuth } from '../../lib/auth';
import { useNow } from '../../lib/clock';
import { useFmt } from '../../lib/format';
import { useFloor } from '../../lib/queries';
import { ControllerActions, CTRL_ICON, CTRL_TONE, stateOf } from './parts';

const FILTERS: { value: ControllerState | 'all'; label: TKey }[] = [
  { value: 'all', label: 'common.all' },
  { value: 'spare', label: 'controllers.ready' },
  { value: 'at_station', label: 'controllers.inUse' },
  { value: 'charging', label: 'controllers.charging' },
  { value: 'broken', label: 'controllers.broken' },
];

/** Every numbered controller at a glance: on the shelf, at a station, charging (with countdown), broken. */
export function ControllersPage() {
  const { t } = useT();
  const f = useFmt();
  const floor = useFloor();
  const now = useNow();
  const role = useAuth((s) => s.user?.role);
  const [filter, setFilter] = useState<ControllerState | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const list = floor.data?.controllers ?? [];
  const counts = useMemo(() => {
    const c: Record<ControllerState, number> = { spare: 0, at_station: 0, charging: 0, broken: 0 };
    for (const x of list) c[stateOf(x, now)]++;
    return c;
  }, [list, now]);

  if (floor.isLoading || !floor.data) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 p-4 sm:grid-cols-[repeat(auto-fill,minmax(130px,1fr))] sm:gap-3 md:p-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-24 sm:h-32" />
        ))}
      </div>
    );
  }

  const visible = list.filter((c) => filter === 'all' || stateOf(c, now) === filter);
  const selected = list.find((c) => c.id === openId);
  const stationName = (id: string | null) => floor.data!.stations.find((s) => s.id === id)?.name ?? '';

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((x) => (
          <button
            key={x.value}
            onClick={() => setFilter(x.value)}
            data-status={x.value === 'all' ? undefined : CTRL_TONE[x.value]}
            className={clsx(
              'flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors',
              filter === x.value ? 'border-accent/50 bg-accent/12 text-accent' : 'border-line text-muted hover:text-fg',
            )}
          >
            {x.value !== 'all' && <span className="st-bg size-2 rounded-full" />}
            {t(x.label)}
            <Num className="text-faint">{x.value === 'all' ? list.length : counts[x.value]}</Num>
          </button>
        ))}
        <div className="flex-1" />
        {can.settings(role) && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            {t('controllers.add')}
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <EmptyState icon={<Gamepad />} title={t('controllers.empty')} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(130px,1fr))] sm:gap-3">
          {visible.map((c) => {
            const state = stateOf(c, now);
            const Icon = CTRL_ICON[state];
            const remaining = chargeRemainingMs(c, now);
            const total = c.readyAt && c.chargingSince ? c.readyAt - c.chargingSince : 1;
            return (
              <button
                key={c.id}
                data-status={CTRL_TONE[state]}
                onClick={() => setOpenId(c.id)}
                className="tint flex min-h-24 flex-col justify-between rounded-card border p-3 text-start transition-transform hover:-translate-y-0.5 sm:min-h-32 sm:p-3.5"
                aria-label={t('controllers.number', { n: c.number })}
              >
                <div className="flex items-start justify-between">
                  <Num className="text-2xl font-bold leading-none sm:text-3xl">{c.number}</Num>
                  <Icon className="st-fg size-5" aria-hidden />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="st-fg truncate text-xs font-semibold">
                    {state === 'at_station' ? <span className="num">{stationName(c.stationId)}</span> : t(`controllers.${state === 'spare' ? 'ready' : state}`)}
                  </span>
                  {state === 'charging' && (
                    <>
                      <Num className="text-sm font-semibold">{f.duration(remaining)}</Num>
                      <div className="h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                        <div className="st-bg h-full rounded-full transition-[width] duration-1000" style={{ width: `${Math.min(100, (1 - remaining / total) * 100)}%` }} />
                      </div>
                    </>
                  )}
                  {state === 'broken' && c.note && <span className="truncate text-xs text-faint">{c.note}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected && <ControllerActions c={selected} floor={floor.data} onClose={() => setOpenId(null)} />}
      <AddControllers open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function AddControllers({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useT();
  const [count, setCount] = useState('4');
  const { busy, run } = useAction();
  const n = Number(count);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('controllers.add')}
      size="sm"
      footer={
        <Button
          variant="primary"
          block
          loading={busy}
          disabled={!Number.isInteger(n) || n < 1 || n > 50}
          onClick={async () => {
            const res = await run(() => post<{ from: number; to: number }>('/api/controllers', { count: n }));
            if (res) {
              onOpenChange(false);
              toast.success(t('controllers.added', { from: res.from, to: res.to }));
            }
          }}
        >
          {t('common.add')}
        </Button>
      }
    >
      <Field label={t('controllers.addCount')} htmlFor="ctrl-count">
        <Input id="ctrl-count" autoFocus inputMode="numeric" className="num text-center text-xl" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />
      </Field>
    </Modal>
  );
}
