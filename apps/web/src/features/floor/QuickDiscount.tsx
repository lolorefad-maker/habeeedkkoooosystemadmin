import { clsx } from 'clsx';
import { ArrowRight, BadgePercent, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Field, Input, Money, Num, Segmented } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { useFmt } from '../../lib/format';
import { rateNow } from '../../lib/live';
import { quoteRate, type BillingContext, type PricingRule } from '@lounge/core';
import type { Floor, RawRule } from '../../lib/types';

type Win = { startsAt?: number | null; endsAt?: number | null; stationTypes?: string[] | null; tiers?: string[] | null };

/** The owner's "discount now" currently in force, if any. */
export function activeQuickDiscount(floor: Floor, now: number): RawRule | null {
  return (
    floor.rules.find((r) => {
      const m = r.match as Win;
      return r.source === 'quick' && r.active && (m.startsAt ?? 0) <= now && (m.endsAt == null || m.endsAt > now);
    }) ?? null
  );
}

/**
 * One tap from the floor: "20% off, on PS5, until I stop it". Shows as a green strip while on,
 * with Stop. Prices on every card and every running bill follow immediately (from now on).
 */
export function QuickDiscountBar({ floor, now }: { floor: Floor; now: number }) {
  const { t, tk } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const active = activeQuickDiscount(floor, now);
  if (!active) return null;
  const m = active.match as Win;
  const percent = Math.abs((active.effect as { percent?: number }).percent ?? 0);
  const scope = m.tiers?.includes('vip') ? 'VIP' : m.stationTypes?.length ? m.stationTypes.map((x) => tk('types', x)).join('، ') : t('common.all');

  return (
    <div data-status="free" className="tint flex flex-wrap items-center gap-3 rounded-card border px-4 py-3">
      <BadgePercent className="st-fg size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{t('discount.activeTitle', { n: percent })}</div>
        <div className="text-xs text-muted">
          {scope} · {m.endsAt ? t('discount.until', { time: f.time(m.endsAt) }) : t('discount.untilStopped')}
        </div>
      </div>
      <Button size="sm" variant="outline" loading={busy} icon={<Square className="size-3.5 fill-current" />} onClick={() => run(() => post('/api/pricing/discount/stop'), { success: t('discount.stopped') })}>
        {t('discount.stop')}
      </Button>
    </div>
  );
}

const PERCENTS = [10, 15, 20, 25, 30, 50];

export function QuickDiscountButton({ floor, ctx, now }: { floor: Floor; ctx: BillingContext; now: number }) {
  const { t, tk } = useT();
  const f = useFmt();
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState('20');
  const [scope, setScope] = useState('all');
  const [until, setUntil] = useState<'manual' | 'day_end' | '60' | '120'>('manual');
  const { busy, run } = useAction();
  const active = activeQuickDiscount(floor, now);

  const scopes = useMemo(() => {
    const out = [{ value: 'all', label: t('common.all') }];
    for (const type of [...new Set(floor.stations.map((s) => s.type))]) out.push({ value: `type:${type}`, label: tk('types', type) });
    if (floor.stations.some((s) => s.tier === 'vip')) out.push({ value: 'tier:vip', label: 'VIP' });
    return out;
  }, [floor.stations, t, tk]);

  const p = Number(percent);
  const valid = Number.isInteger(p) && p >= 1 && p <= 100;
  // "2.000 → 1.600 an hour" on a station in scope, so the owner sees what customers will pay.
  // Priced by the real engine with the discount added as it will be saved (it replaces any other
  // running % rule such as a happy hour — percents never stack).
  const example = useMemo(() => {
    const st = floor.stations.find((s) => s.active && (scope === 'all' || (scope.startsWith('type:') ? s.type === scope.slice(5) : s.tier === scope.slice(5))));
    if (!st || !valid) return null;
    const mode = st.modes[0] ?? 'single';
    const before = rateNow(ctx, st, mode, now);
    const preview: PricingRule = {
      id: 'preview',
      name: 'preview',
      priority: 100,
      active: true,
      match: {
        stationTypes: scope.startsWith('type:') ? [scope.slice(5)] : null,
        tiers: scope.startsWith('tier:') ? [scope.slice(5)] : null,
      },
      effect: { kind: 'percent', percent: -p },
    };
    const after = quoteRate([...ctx.rules, preview], st, mode, now, ctx.tz);
    return before && after ? { name: st.name, before: Math.round(before.perHour), after: Math.round(after.perHour) } : null;
  }, [floor.stations, scope, ctx, now, p, valid]);

  if (active) return null;

  const start = async () => {
    const body = {
      percent: p,
      stationTypes: scope.startsWith('type:') ? [scope.slice(5)] : null,
      tiers: scope.startsWith('tier:') ? [scope.slice(5)] : null,
      until: until === 'manual' ? { kind: 'manual' } : until === 'day_end' ? { kind: 'day_end' } : { kind: 'minutes', minutes: Number(until) },
    };
    if (await run(() => post('/api/pricing/discount', body), { success: t('discount.started', { n: p }) })) setOpen(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-1 px-3.5 text-sm font-medium text-muted shadow-[var(--shadow-card)] hover:border-st-free/50 hover:text-st-free"
      >
        <BadgePercent className="size-4" />
        {t('discount.button')}
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t('discount.title')}
        description={t('discount.hint')}
        size="md"
        footer={
          <Button variant="success" size="lg" block loading={busy} disabled={!valid} onClick={start} icon={<BadgePercent className="size-5" />}>
            {t('discount.start', { n: valid ? p : 0 })}
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label={t('discount.percent')}>
            <div className="flex flex-wrap gap-2">
              {PERCENTS.map((x) => (
                <button
                  key={x}
                  onClick={() => setPercent(String(x))}
                  className={clsx(
                    'num h-11 min-w-14 rounded-control border px-3 text-base font-semibold transition-colors',
                    p === x ? 'border-st-free bg-st-free/12 text-st-free' : 'border-line bg-surface-2 text-muted hover:text-fg',
                  )}
                >
                  {x}%
                </button>
              ))}
              <div className="w-20">
                <Input
                  inputMode="numeric"
                  className="num h-11 text-center"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  aria-label={t('discount.percent')}
                />
              </div>
            </div>
          </Field>
          <Field label={t('discount.on')}>
            <Segmented value={scope} onChange={setScope} options={scopes} />
          </Field>
          <Field label={t('discount.duration')}>
            <Segmented
              value={until}
              onChange={setUntil}
              options={[
                { value: 'manual', label: t('discount.untilStoppedShort') },
                { value: 'day_end', label: t('discount.dayEnd') },
                { value: '60', label: f.minutes(60) },
                { value: '120', label: f.minutes(120) },
              ]}
            />
          </Field>
          {example && valid && (
            <div data-status="free" className="tint flex items-center justify-between rounded-card border px-4 py-3 text-sm">
              <span className="num text-muted">{example.name}</span>
              <span className="flex items-center gap-2">
                <Money value={example.before} className="text-faint line-through" />
                <ArrowRight className="size-4 text-faint rtl:-scale-x-100" aria-hidden />
                <Money value={example.after} className="st-fg text-base font-semibold" />
                <span className="text-xs text-muted">{t('common.perHour')}</span>
              </span>
            </div>
          )}
          <p className="text-xs text-faint">
            {t('discount.fromNowNote')} <Num>{f.time(now)}</Num>
          </p>
        </div>
      </Modal>
    </>
  );
}
