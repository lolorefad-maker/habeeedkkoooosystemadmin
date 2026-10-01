import { chargeRemainingMs, controllerState, type ControllerState } from '@lounge/core';
import { clsx } from 'clsx';
import { BatteryCharging, BatteryWarning, Check, Gamepad, Plus, Undo2, Wrench, Zap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Num, Select } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { useNow } from '../../lib/clock';
import { useFmt } from '../../lib/format';
import type { Controller, Floor } from '../../lib/types';

/** Controller state → status token (color + icon), same system as stations. */
export const CTRL_TONE: Record<ControllerState, string> = {
  spare: 'free',
  at_station: 'active',
  charging: 'ending',
  broken: 'off',
};

export const CTRL_ICON: Record<ControllerState, typeof Gamepad> = {
  spare: Check,
  at_station: Gamepad,
  charging: BatteryCharging,
  broken: Wrench,
};

export function stateOf(c: Controller, now: number): ControllerState {
  return controllerState(c, now);
}

/** Compact number badge ("3") colored by state. */
export function ControllerChip({
  c,
  now,
  selected,
  onClick,
  disabled,
  size = 'md',
  plain,
}: {
  c: Controller;
  now: number;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Number only (in pickers where the state is obvious from context). */
  plain?: boolean;
}) {
  const { t } = useT();
  const f = useFmt();
  const state = stateOf(c, now);
  const Icon = CTRL_ICON[state];
  const label = t('controllers.number', { n: c.number });
  return (
    <button
      type="button"
      data-status={CTRL_TONE[state]}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={label}
      title={state === 'charging' ? t('controllers.readyIn', { d: f.duration(chargeRemainingMs(c, now)) }) : label}
      className={clsx(
        'inline-flex items-center justify-center gap-1 rounded-control border font-semibold transition-all disabled:opacity-40',
        size === 'sm' ? 'h-10 min-w-11 px-2 text-sm' : 'h-11 min-w-14 px-3 text-base',
        selected ? 'border-accent bg-accent text-accent-fg shadow-[0_4px_16px_-6px_var(--accent)]' : 'tint st-fg hover:brightness-110',
      )}
    >
      {!selected && !plain && <Icon className="size-3.5" aria-hidden />}
      <Num>{c.number}</Num>
    </button>
  );
}

/**
 * Pick the controllers handed to a customer: ready ones on the shelf plus the ones
 * already at this station. Charging and broken ones are visible but disabled, with the wait.
 */
export function ControllerPicker({
  floor,
  stationId,
  value,
  onChange,
}: {
  floor: Floor;
  stationId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useT();
  const now = useNow();
  const usable = floor.controllers.filter((c) => {
    const s = stateOf(c, now);
    return s === 'spare' || (s === 'at_station' && c.stationId === stationId);
  });
  const charging = floor.controllers.filter((c) => stateOf(c, now) === 'charging');

  if (usable.length === 0 && charging.length === 0) return <p className="text-sm text-faint">{t('controllers.noneReady')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1.5">
        {usable.map((c) => (
          <ControllerChip
            key={c.id}
            c={c}
            now={now}
            size="sm"
            plain
            selected={value.includes(c.id)}
            onClick={() => onChange(value.includes(c.id) ? value.filter((x) => x !== c.id) : [...value, c.id])}
          />
        ))}
      </div>
      {charging.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {charging.map((c) => (
            <ControllerChip key={c.id} c={c} now={now} size="sm" disabled />
          ))}
        </div>
      )}
    </div>
  );
}

/** Everything you can do with one controller, including the "battery died → swap" flow. */
export function ControllerActions({ c, floor, onClose }: { c: Controller; floor: Floor; onClose: () => void }) {
  const { t } = useT();
  const f = useFmt();
  const now = useNow();
  const { busy, run } = useAction();
  const state = stateOf(c, now);
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [giveTo, setGiveTo] = useState('');
  const stationName = (id: string | null) => floor.stations.find((s) => s.id === id)?.name ?? '';
  const spares = floor.controllers.filter((x) => x.id !== c.id && stateOf(x, now) === 'spare');

  const charge = async () => {
    const from = c.stationId;
    const res = await run(() => post<{ readyAt: number }>(`/api/controllers/${c.id}/charge`, {}));
    if (!res) return;
    toast.success(t('controllers.chargingToast', { n: c.number, time: f.time(res.readyAt) }));
    if (from && spares.length) setSwapFor(from);
    else onClose();
  };

  if (swapFor) {
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} title={t('controllers.swapHint')} description={stationName(swapFor)} size="sm">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {spares.map((x) => (
              <ControllerChip
                key={x.id}
                c={x}
                now={now}
                onClick={async () => {
                  if (await run(() => post(`/api/controllers/${x.id}/assign`, { stationId: swapFor }))) onClose();
                }}
                disabled={busy}
              />
            ))}
          </div>
          <Button variant="ghost" onClick={onClose}>
            {t('controllers.skip')}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('controllers.number', { n: c.number })}
      description={
        state === 'at_station'
          ? t('controllers.atStation', { station: stationName(c.stationId) })
          : state === 'charging'
            ? t('controllers.readyIn', { d: f.duration(chargeRemainingMs(c, now)) })
            : t(`controllers.${state === 'spare' ? 'spare' : 'broken'}`)
      }
      size="sm"
    >
      <div className="flex flex-col gap-2 pb-1">
        {(state === 'at_station' || state === 'spare') && (
          <Button size="lg" block variant="warning" loading={busy} onClick={charge} icon={<BatteryWarning className="size-5" />}>
            {t('controllers.charge')}
          </Button>
        )}
        {state === 'charging' && (
          <Button size="lg" block variant="success" loading={busy} icon={<Zap className="size-5" />} onClick={async () => (await run(() => post(`/api/controllers/${c.id}/ready`))) && onClose()}>
            {t('controllers.chargedNow')}
          </Button>
        )}
        {state === 'at_station' && (
          <Button size="lg" block loading={busy} icon={<Undo2 className="size-5 rtl:-scale-x-100" />} onClick={async () => (await run(() => post(`/api/controllers/${c.id}/assign`, { stationId: null }))) && onClose()}>
            {t('controllers.toShelf')}
          </Button>
        )}
        {(state === 'spare' || state === 'at_station') && (
          <div className="flex gap-2">
            <Select value={giveTo} onChange={(e) => setGiveTo(e.target.value)} aria-label={t('controllers.giveTo')}>
              <option value="">{t('controllers.giveTo')}…</option>
              {floor.stations
                .filter((s) => s.active && s.id !== c.stationId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
            <Button
              variant="primary"
              size="lg"
              disabled={!giveTo}
              loading={busy}
              icon={<Plus className="size-4" />}
              onClick={async () => (await run(() => post(`/api/controllers/${c.id}/assign`, { stationId: giveTo }))) && onClose()}
              aria-label={t('controllers.giveTo')}
            />
          </div>
        )}
        {state !== 'broken' ? (
          <Button variant="ghost" block loading={busy} icon={<Wrench className="size-4" />} onClick={async () => (await run(() => post(`/api/controllers/${c.id}/broken`, { broken: true }))) && onClose()}>
            {t('controllers.markBroken')}
          </Button>
        ) : (
          <Button size="lg" block variant="success" loading={busy} icon={<Check className="size-5" />} onClick={async () => (await run(() => post(`/api/controllers/${c.id}/broken`, { broken: false }))) && onClose()}>
            {t('controllers.markFixed')}
          </Button>
        )}
      </div>
    </Modal>
  );
}
