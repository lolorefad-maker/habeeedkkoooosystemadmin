import { DEFAULT_REWARD_MESSAGE, parseMoney, type BranchSettings } from '@lounge/core';
import { clsx } from 'clsx';
import { Building2, Coffee, Download, History, Monitor, Scale, Tags, Upload, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Card, Field, Input, Segmented, Select, Skeleton, Switch, Textarea } from '../../components/ui/primitives';
import { useT, type TKey } from '../../i18n';
import { api, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/format';
import { useSettings, type SettingsBundle } from '../../lib/queries';
import { AuditTab } from './AuditTab';
import { ProductsTab, StaffTab, StationsTab } from './CatalogTabs';
import { PricingTab } from './PricingTab';

const TABS: { id: string; label: TKey; icon: ReactNode }[] = [
  { id: 'general', label: 'settings.general', icon: <Building2 className="size-4" /> },
  { id: 'policies', label: 'settings.policies', icon: <Scale className="size-4" /> },
  { id: 'stations', label: 'settings.stations', icon: <Monitor className="size-4" /> },
  { id: 'pricing', label: 'settings.pricing', icon: <Tags className="size-4" /> },
  { id: 'products', label: 'settings.products', icon: <Coffee className="size-4" /> },
  { id: 'staff', label: 'settings.staff', icon: <Users className="size-4" /> },
  { id: 'audit', label: 'settings.audit', icon: <History className="size-4" /> },
];

export function SettingsPage() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'general';
  const settings = useSettings();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:flex-row md:p-6">
      {/* Every tab visible on a phone (a grid), a side list from tablet up. */}
      <nav className="grid shrink-0 grid-cols-4 gap-1 md:flex md:w-52 md:flex-col" aria-label={t('nav.settings')}>
        {TABS.map((x) => (
          <button
            key={x.id}
            onClick={() => setParams({ tab: x.id })}
            className={clsx(
              'flex min-w-0 flex-col items-center justify-center gap-1 rounded-control px-1 py-2 text-center text-xs font-medium leading-tight transition-colors',
              'md:h-10 md:shrink-0 md:flex-row md:justify-start md:gap-2.5 md:px-3 md:py-0 md:text-start md:text-sm',
              tab === x.id ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
            aria-current={tab === x.id ? 'page' : undefined}
          >
            {x.icon}
            {t(x.label)}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {!settings.data ? (
          <Skeleton className="h-96" />
        ) : tab === 'general' ? (
          <GeneralTab data={settings.data} />
        ) : tab === 'policies' ? (
          <PoliciesTab data={settings.data} />
        ) : tab === 'stations' ? (
          <StationsTab data={settings.data} />
        ) : tab === 'pricing' ? (
          <PricingTab data={settings.data} />
        ) : tab === 'products' ? (
          <ProductsTab data={settings.data} />
        ) : tab === 'staff' ? (
          <StaffTab data={settings.data} />
        ) : (
          <AuditTab />
        )}
      </div>
    </div>
  );
}

const TIMEZONES = ['Asia/Amman', 'Asia/Damascus', 'Asia/Beirut', 'Asia/Jerusalem', 'Asia/Hebron', 'Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Baghdad', 'Africa/Cairo', 'Europe/Istanbul', 'Europe/London', 'UTC'];

function GeneralTab({ data }: { data: SettingsBundle }) {
  const { t } = useT();
  const { busy, run } = useAction();
  const [form, setForm] = useState({
    name: data.branch.name,
    currency: data.branch.currency,
    currencyDecimals: data.branch.currencyDecimals,
    timezone: data.branch.timezone,
    locale: data.branch.locale,
  });
  // Follow changes made elsewhere (another device, or an imported setup).
  useEffect(
    () =>
      setForm({
        name: data.branch.name,
        currency: data.branch.currency,
        currencyDecimals: data.branch.currencyDecimals,
        timezone: data.branch.timezone,
        locale: data.branch.locale,
      }),
    [data.branch.name, data.branch.currency, data.branch.currencyDecimals, data.branch.timezone, data.branch.locale],
  );
  return (
    <div className="flex flex-col gap-5">
    <Card className="p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.branchName')} htmlFor="b-name" className="sm:col-span-2">
          <Input id="b-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t('settings.currency')} htmlFor="b-cur" hint="ISO 4217 — JOD, SYP, LBP, ILS, SAR, USD…">
          <Input id="b-cur" dir="ltr" className="num uppercase" maxLength={3} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
        </Field>
        <Field label={t('settings.decimals')} hint={t('settings.decimalsHint')} htmlFor="b-dec">
          <Select id="b-dec" value={form.currencyDecimals} onChange={(e) => setForm({ ...form, currencyDecimals: Number(e.target.value) })}>
            {[0, 1, 2, 3].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('settings.timezone')} htmlFor="b-tz">
          <Input id="b-tz" dir="ltr" list="tz-list" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          <datalist id="tz-list">
            {TIMEZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
        <Field label={t('settings.locale')} htmlFor="b-locale">
          <Select id="b-locale" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </Select>
        </Field>
      </div>
      <div className="mt-6 flex justify-end">
        <Button
          variant="primary"
          loading={busy}
          disabled={!form.name.trim() || form.currency.length !== 3 || !form.timezone.trim()}
          onClick={() => run(() => api('PATCH', '/api/settings/branch', { ...form, name: form.name.trim(), timezone: form.timezone.trim() }), { success: t('common.saved') })}
        >
          {t('common.save')}
        </Button>
      </div>
    </Card>
    <SetupTransfer data={data} />
    </div>
  );
}

/**
 * "Move my setup": download this shop's setup as a file (stations, prices, packages, products,
 * controllers, policies — never money, stock or staff), and load such a file into a new, empty
 * install (the online server's first start). Owner only.
 */
function SetupTransfer({ data }: { data: SettingsBundle }) {
  const { t } = useT();
  const role = useAuth((s) => s.user?.role);
  const { busy, run } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const empty = data.stations.length === 0 && data.products.length === 0;
  if (role !== 'owner') return null;

  const download = () =>
    run(async () => {
      const file = await get<unknown>('/api/settings/export');
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${data.branch.name || 'shop'}-setup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

  const load = async (f: File) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await f.text());
    } catch {
      toast.error(t('settings.transfer.badFile'));
      return;
    }
    const res = await run(() => post<{ stations: number; products: number; controllers: number; rules: number; packages: number }>('/api/settings/import', parsed));
    if (res) toast.success(t('settings.transfer.imported', { s: res.stations, p: res.products, c: res.controllers, r: res.rules }));
  };

  return (
    <Card className="p-5">
      <h3 className="font-semibold">{t('settings.transfer.title')}</h3>
      <p className="mt-1 text-sm text-muted">{t('settings.transfer.hint')}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button icon={<Download className="size-4" />} loading={busy} onClick={download}>
          {t('settings.transfer.export')}
        </Button>
        <Button
          variant={empty ? 'primary' : 'secondary'}
          icon={<Upload className="size-4" />}
          disabled={busy || !empty}
          onClick={() => fileRef.current?.click()}
          title={empty ? undefined : t('settings.transfer.notEmpty')}
        >
          {t('settings.transfer.import')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void load(f);
          }}
        />
      </div>
      <p className="mt-2 text-xs text-faint">{empty ? t('settings.transfer.emptyHint') : t('settings.transfer.notEmpty')}</p>
    </Card>
  );
}

/**
 * A number or money field you can type into freely ("", "5.", "0.05") — it only reports a value
 * once it parses, and applies the limits when you leave the field, so nothing jumps while typing.
 */
function NumInput({
  id,
  value,
  onChange,
  min = 0,
  max,
  money,
  allowEmpty,
}: {
  id?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  money?: boolean;
  allowEmpty?: boolean;
}) {
  const f = useFmt();
  const show = (v: number | null) => (v == null ? '' : money ? f.money(v) : String(v));
  const parse = (s: string) => (s.trim() === '' ? null : money ? parseMoney(s, f.decimals) : /^\d+$/.test(s.trim()) ? Number(s) : null);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min, v));
  const [text, setText] = useState(() => show(value));
  // Follow changes from outside (another device saved), unless it is what is being typed.
  useEffect(() => {
    if (parse(text) !== value) setText(show(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Input
      id={id}
      inputMode={money ? 'decimal' : 'numeric'}
      className="num"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = parse(e.target.value);
        if (v != null) onChange(v);
        else if (allowEmpty && e.target.value.trim() === '') onChange(null);
      }}
      onBlur={() => {
        if (value == null) return setText(allowEmpty ? '' : show(clamp(0)));
        const c = clamp(value);
        if (c !== value) onChange(c);
        setText(show(c));
      }}
    />
  );
}

/** Every business rule, editable, with a sentence explaining what it does. This is what makes the system "dynamic". */
function PoliciesTab({ data }: { data: SettingsBundle }) {
  const { t } = useT();
  const { busy, run } = useAction();
  const [s, setS] = useState<BranchSettings>(data.branch.settings);
  useEffect(() => setS(data.branch.settings), [data.branch.settings]);

  const set = <K extends keyof BranchSettings>(group: K, patch: Partial<BranchSettings[K]>) => setS((prev) => ({ ...prev, [group]: { ...prev[group], ...patch } }));
  const n = (v: number | null) => v ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5">
        <h3 className="mb-4 font-semibold">{t('settings.policy.billing')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.policy.graceMinutes')} hint={t('settings.policy.graceHint')} htmlFor="p-grace">
            <NumInput id="p-grace" value={s.billing.graceMinutes} onChange={(v) => set('billing', { graceMinutes: n(v) })} />
          </Field>
          <Field label={t('settings.policy.minimumMinutes')} htmlFor="p-min">
            <NumInput id="p-min" value={s.billing.minimumMinutes} onChange={(v) => set('billing', { minimumMinutes: n(v) })} />
          </Field>
          <Field label={t('settings.policy.roundingMinutes')} hint={t('settings.policy.roundingHint')} htmlFor="p-round">
            <NumInput id="p-round" min={1} value={s.billing.roundingMinutes} onChange={(v) => set('billing', { roundingMinutes: n(v) })} />
          </Field>
          <Field label={t('settings.policy.roundingMode')}>
            <Segmented
              value={s.billing.roundingMode}
              onChange={(v) => set('billing', { roundingMode: v })}
              options={[
                { value: 'up', label: t('settings.policy.roundUp') },
                { value: 'nearest', label: t('settings.policy.roundNearest') },
                { value: 'down', label: t('settings.policy.roundDown') },
              ]}
            />
          </Field>
          <Field label={t('settings.policy.earlyEnd')} className="sm:col-span-2">
            <Select value={s.billing.earlyEnd} onChange={(e) => set('billing', { earlyEnd: e.target.value as BranchSettings['billing']['earlyEnd'] })}>
              <option value="charge_actual">{t('settings.policy.charge_actual')}</option>
              <option value="charge_full">{t('settings.policy.charge_full')}</option>
              <option value="actual_with_min">{t('settings.policy.actual_with_min')}</option>
            </Select>
          </Field>
          {s.billing.earlyEnd === 'actual_with_min' && (
            <Field label={t('settings.policy.earlyEndMinMinutes')} htmlFor="p-emin">
              <NumInput id="p-emin" value={s.billing.earlyEndMinMinutes} onChange={(v) => set('billing', { earlyEndMinMinutes: n(v) })} />
            </Field>
          )}
          <Field label={t('settings.policy.sessionCap')} hint={t('settings.policy.sessionCapHint')} htmlFor="p-cap">
            <NumInput id="p-cap" money allowEmpty value={s.billing.sessionCap} onChange={(v) => set('billing', { sessionCap: v })} />
          </Field>
          <Field label={t('settings.policy.endingSoonMinutes')} htmlFor="p-soon">
            <NumInput id="p-soon" min={1} value={s.billing.endingSoonMinutes} onChange={(v) => set('billing', { endingSoonMinutes: n(v) })} />
          </Field>
        </div>
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
          <Switch checked={s.billing.autoBestPackage} onChange={(v) => set('billing', { autoBestPackage: v })} label={t('settings.policy.autoBestPackage')} />
          <Switch checked={s.billing.autoEndFixed} onChange={(v) => set('billing', { autoEndFixed: v })} label={t('settings.policy.autoEndFixed')} />
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-4 font-semibold">{t('settings.policy.reservations')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.policy.freeCancelMinutes')} htmlFor="r-free">
            <NumInput id="r-free" value={s.reservations.freeCancelMinutes} onChange={(v) => set('reservations', { freeCancelMinutes: n(v) })} />
          </Field>
          <Field label={t('settings.policy.lateCancelFeeKind')}>
            <Segmented
              value={s.reservations.lateCancelFeeKind}
              onChange={(v) => set('reservations', { lateCancelFeeKind: v, lateCancelFeeValue: v === 'percent_deposit' ? 50 : 0 })}
              options={[
                { value: 'percent_deposit', label: t('settings.policy.feePercent') },
                { value: 'fixed', label: t('settings.policy.feeFixed') },
              ]}
            />
          </Field>
          <Field label={t('settings.policy.lateCancelFeeValue')} htmlFor="r-fee">
            {/* Remounts when the kind changes: a percent and an amount are different fields. */}
            <NumInput
              key={s.reservations.lateCancelFeeKind}
              id="r-fee"
              money={s.reservations.lateCancelFeeKind === 'fixed'}
              max={s.reservations.lateCancelFeeKind === 'fixed' ? undefined : 100}
              value={s.reservations.lateCancelFeeValue}
              onChange={(v) => set('reservations', { lateCancelFeeValue: n(v) })}
            />
          </Field>
          <Field label={t('settings.policy.noShowGraceMinutes')} htmlFor="r-ns">
            <NumInput id="r-ns" value={s.reservations.noShowGraceMinutes} onChange={(v) => set('reservations', { noShowGraceMinutes: n(v) })} />
          </Field>
          <Field label={t('settings.policy.holdMinutesBefore')} htmlFor="r-hold">
            <NumInput id="r-hold" value={s.reservations.holdMinutesBefore} onChange={(v) => set('reservations', { holdMinutesBefore: n(v) })} />
          </Field>
        </div>
        <div className="mt-4 border-t border-line pt-4">
          <Switch checked={s.reservations.noShowForfeitDeposit} onChange={(v) => set('reservations', { noShowForfeitDeposit: v })} label={t('settings.policy.noShowForfeitDeposit')} />
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-4 font-semibold">{t('settings.policy.checkout')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.policy.cashRounding')} hint={t('settings.policy.cashRoundingHint')} htmlFor="c-round">
            <NumInput id="c-round" money value={s.checkout.cashRounding} onChange={(v) => set('checkout', { cashRounding: n(v) })} />
          </Field>
          <Field label={t('settings.policy.maxCashierDiscountPercent')} htmlFor="c-disc">
            <NumInput id="c-disc" max={100} value={s.checkout.maxCashierDiscountPercent} onChange={(v) => set('checkout', { maxCashierDiscountPercent: n(v) })} />
          </Field>
          <Field label={t('settings.policy.refundApprovalAbove')} htmlFor="c-ref">
            <NumInput id="c-ref" money value={s.checkout.refundApprovalAbove} onChange={(v) => set('checkout', { refundApprovalAbove: n(v) })} />
          </Field>
        </div>
        <div className="mt-4 border-t border-line pt-4">
          <Switch checked={s.checkout.voidNeedsApproval} onChange={(v) => set('checkout', { voidNeedsApproval: v })} label={t('settings.policy.voidNeedsApproval')} />
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-4 font-semibold">{t('settings.policy.controllers')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.policy.chargeMinutes')} hint={t('settings.policy.chargeHint')} htmlFor="ctl-charge">
            <NumInput id="ctl-charge" min={5} value={s.controllers.chargeMinutes} onChange={(v) => set('controllers', { chargeMinutes: n(v) })} />
          </Field>
        </div>
        <div className="mt-4 border-t border-line pt-4">
          <Switch
            checked={s.controllers.returnOnEnd}
            onChange={(v) => set('controllers', { returnOnEnd: v })}
            label={t('settings.policy.returnOnEnd')}
            hint={t('settings.policy.returnOnEndHint')}
          />
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-4 font-semibold">{t('settings.policy.day')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.policy.cutoff')} hint={t('settings.policy.cutoffHint')} htmlFor="d-cut">
            <Input id="d-cut" type="time" className="num" value={s.day.cutoff} onChange={(e) => e.target.value && set('day', { cutoff: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-4 font-semibold">{t('settings.policy.rewards')}</h3>
        <Switch checked={s.rewards.enabled} onChange={(v) => set('rewards', { enabled: v })} label={t('settings.policy.rewardsEnabled')} hint={t('settings.policy.rewardsEnabledHint')} />
        {s.rewards.enabled && (
          <>
            <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
              <Field label={t('settings.policy.rewardsAfter')} hint={t('settings.policy.rewardsAfterHint')} htmlFor="rw-after">
                <NumInput id="rw-after" min={30} max={1440} value={s.rewards.afterMinutes} onChange={(v) => set('rewards', { afterMinutes: n(v) })} />
              </Field>
              <Field label={t('settings.policy.rewardsFree')} htmlFor="rw-free">
                <NumInput id="rw-free" min={5} max={1440} value={s.rewards.freeMinutes} onChange={(v) => set('rewards', { freeMinutes: n(v) })} />
              </Field>
              <Field label={t('settings.policy.rewardsCode')} hint={t('settings.policy.rewardsCodeHint')} htmlFor="rw-cc">
                <Input
                  id="rw-cc"
                  inputMode="numeric"
                  dir="ltr"
                  className="num text-start"
                  value={s.rewards.countryCode}
                  maxLength={4}
                  onChange={(e) => set('rewards', { countryCode: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
            </div>
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
              <Field label={t('settings.policy.rewardsMessage')} htmlFor="rw-msg" hint={t('settings.policy.rewardsMessageHint')}>
                <Textarea id="rw-msg" value={s.rewards.message} maxLength={600} onChange={(e) => set('rewards', { message: e.target.value })} />
              </Field>
              <div className="flex flex-wrap items-center gap-2" dir="ltr">
                {['{name}', '{played}', '{free}', '{shop}'].map((v) => (
                  <code key={v} className="rounded-control bg-surface-3 px-2 py-1 text-xs text-muted">
                    {v}
                  </code>
                ))}
                {s.rewards.message !== DEFAULT_REWARD_MESSAGE && (
                  <Button size="sm" variant="ghost" className="ms-auto" onClick={() => set('rewards', { message: DEFAULT_REWARD_MESSAGE })}>
                    {t('settings.policy.rewardsReset')}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </Card>

      <div className="sticky bottom-4 flex justify-end">
        <Button variant="primary" size="lg" loading={busy} onClick={() => run(() => api('PATCH', '/api/settings/branch', { settings: s }), { success: t('common.saved') })}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
