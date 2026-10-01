import { parseMoney } from '@lounge/core';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Pencil, Plus, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TypeIcon, VipBadge } from '../../components/station/status';
import { Button } from '../../components/ui/button';
import { DeleteButton } from '../../components/ui/DeleteButton';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Card, Field, Input, Money, Num, Select, Switch } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/format';
import type { SettingsBundle } from '../../lib/queries';
import type { Product, Station } from '../../lib/types';
import { StockPill } from '../cafe/products';
import { autoFocusField } from '../../lib/viewport';

export function ChipGroup({ options, value, onChange }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}
            className={clsx(
              'h-9 rounded-full border px-3.5 text-sm font-medium transition-colors',
              on ? 'border-accent/60 bg-accent/12 text-accent' : 'border-line text-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Header({ title, onAdd, addLabel }: { title?: string; onAdd: () => void; addLabel: string }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="font-semibold">{title}</h3>
      <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={onAdd}>
        {addLabel}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ stations

type StationForm = Omit<Station, 'id' | 'branchId'>;
const emptyStation: StationForm = { name: '', type: 'ps5', tier: 'regular', zone: '', modes: ['single', 'multi'], sort: 0, maintenance: false, maintenanceNote: '', active: true };

export function StationsTab({ data }: { data: SettingsBundle }) {
  const { t, tk } = useT();
  const [editing, setEditing] = useState<{ id: string | null; form: StationForm } | null>(null);
  const { busy, run } = useAction();
  const zones = [...new Set(data.stations.map((s) => s.zone).filter(Boolean))];

  const save = async () => {
    if (!editing) return;
    const body = { ...editing.form, maintenanceNote: editing.form.maintenanceNote || null };
    const ok = await run(() => (editing.id ? api('PATCH', `/api/settings/stations/${editing.id}`, body) : api('POST', '/api/settings/stations', body)), { success: t('common.saved') });
    if (ok) setEditing(null);
  };

  // Same grouping and order as the floor: by zone, then the owner's order inside each zone.
  const groups = useMemo(() => {
    const map = new Map<string, Station[]>();
    for (const s of data.stations) map.set(s.zone, [...(map.get(s.zone) ?? []), s]);
    return [...map.entries()];
  }, [data.stations]);

  /** Swap a station with its neighbour in the same zone, then renumber everyone 0…n in floor order. */
  const move = (s: Station, dir: -1 | 1) => {
    const zone = groups.find(([z]) => z === s.zone)?.[1] ?? [];
    const other = zone[zone.indexOf(s) + dir];
    if (!other) return;
    const list = [...data.stations];
    const a = list.indexOf(s);
    const b = list.indexOf(other);
    [list[a], list[b]] = [list[b]!, list[a]!];
    // Full fields on purpose: a PATCH with only `sort` would reset the station's other settings to defaults.
    const changes = list.map((x, sort) => ({ x, sort })).filter(({ x, sort }) => x.sort !== sort);
    return run(async () => {
      for (const { x, sort } of changes) {
        const { id, branchId: _b, ...fields } = x;
        await api('PATCH', `/api/settings/stations/${id}`, { ...fields, maintenanceNote: fields.maintenanceNote || null, sort });
      }
    });
  };

  return (
    <Card className="p-5">
      <Header title={t('settings.stations')} addLabel={t('settings.station.add')} onAdd={() => setEditing({ id: null, form: { ...emptyStation, sort: data.stations.length } })} />
      <p className="-mt-2 mb-4 text-xs text-faint">{t('settings.station.orderHint')}</p>
      <div className="flex flex-col gap-5">
        {groups.map(([zone, list]) => (
          <section key={zone || '_'} aria-label={zone || t('settings.station.noZone')}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted">
              {zone || t('settings.station.noZone')}
              <span className="num rounded-full bg-surface-3 px-2 text-xs font-medium text-faint">{list.length}</span>
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {list.map((s, i) => (
                <div key={s.id} className={clsx('flex items-stretch rounded-card border border-line bg-surface-2 hover:border-line-strong', !s.active && 'opacity-50')}>
                  <button
                    onClick={() => setEditing({ id: s.id, form: { ...s, maintenanceNote: s.maintenanceNote ?? '' } })}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-card p-3 text-start"
                  >
                    <TypeIcon type={s.type} className="size-5 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 font-medium">
                        <span className="num">{s.name}</span>
                        {s.tier === 'vip' && <VipBadge />}
                        {s.maintenance && <span className="rounded-full bg-st-off/20 px-2 text-[11px] text-muted">{t('status.off')}</span>}
                      </div>
                      <div className="truncate text-xs text-muted">{s.modes.map((m) => tk('modes', m)).join('، ')}</div>
                    </div>
                    <Pencil className="size-4 text-faint" />
                  </button>
                  <div className="flex flex-col border-s border-line">
                    <button
                      type="button"
                      disabled={busy || i === 0}
                      onClick={() => move(s, -1)}
                      aria-label={t('settings.station.moveUp', { name: s.name })}
                      title={t('settings.station.moveUp', { name: s.name })}
                      className="grid flex-1 place-items-center px-2.5 text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <ArrowUp className="size-4" />
                    </button>
                    <button
                      type="button"
                      disabled={busy || i === list.length - 1}
                      onClick={() => move(s, 1)}
                      aria-label={t('settings.station.moveDown', { name: s.name })}
                      title={t('settings.station.moveDown', { name: s.name })}
                      className="grid flex-1 place-items-center border-t border-line px-2.5 text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <ArrowDown className="size-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {editing && (
        <Modal
          open
          onOpenChange={(o) => !o && setEditing(null)}
          title={editing.id ? editing.form.name : t('settings.station.add')}
          footer={
            <>
              {editing.id && (
                <DeleteButton
                  className="sm:me-auto"
                  label={t('settings.station.delete')}
                  confirmTitle={t('settings.station.deleteConfirm', { name: editing.form.name })}
                  body={t('settings.station.deleteBody')}
                  path={`/api/settings/stations/${editing.id}`}
                  onDeleted={() => setEditing(null)}
                />
              )}
              <Button variant="primary" size="lg" loading={busy} disabled={!editing.form.name.trim() || editing.form.modes.length === 0} onClick={save}>
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('settings.station.name')} htmlFor="s-name">
              <Input id="s-name" dir="ltr" className="num" value={editing.form.name} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, name: e.target.value } })} />
            </Field>
            <Field label={t('settings.station.zone')} htmlFor="s-zone">
              <Input id="s-zone" list="zones" value={editing.form.zone} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, zone: e.target.value } })} />
              <datalist id="zones">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field label={t('settings.station.type')} htmlFor="s-type">
              <Select
                id="s-type"
                value={editing.form.type}
                onChange={(e) => {
                  const type = e.target.value;
                  setEditing({ ...editing, form: { ...editing.form, type, modes: type === 'vr' ? ['standard'] : ['single', 'multi'] } });
                }}
              >
                <option value="ps5">PS5</option>
                <option value="vr">VR</option>
                <option value="pc">PC</option>
              </Select>
            </Field>
            <Field label={t('settings.station.tier')} htmlFor="s-tier">
              <Select id="s-tier" value={editing.form.tier} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, tier: e.target.value } })}>
                <option value="regular">{tk('tiers', 'regular')}</option>
                <option value="vip">VIP</option>
              </Select>
            </Field>
            <Field label={t('settings.station.modes')} className="sm:col-span-2">
              <ChipGroup
                value={editing.form.modes}
                onChange={(modes) => setEditing({ ...editing, form: { ...editing.form, modes } })}
                options={['single', 'multi', 'standard'].map((m) => ({ value: m, label: tk('modes', m) }))}
              />
            </Field>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Switch checked={editing.form.maintenance} onChange={(v) => setEditing({ ...editing, form: { ...editing.form, maintenance: v } })} label={t('settings.station.maintenance')} />
              {editing.form.maintenance && (
                <Input value={editing.form.maintenanceNote ?? ''} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, maintenanceNote: e.target.value } })} placeholder={t('common.note')} />
              )}
              <Switch
                checked={editing.form.active}
                onChange={(v) => setEditing({ ...editing, form: { ...editing.form, active: v } })}
                label={t('common.active')}
                hint={t('settings.station.activeHint')}
              />
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ products

type ProductForm = {
  name: string;
  category: string;
  price: string;
  trackStock: boolean;
  /** Pieces on the shelf, as typed ('' = not counted). */
  stock: string;
  lowStockAt: string;
  active: boolean;
  sort: number;
};

/**
 * Add or edit a product — including how many pieces are on the shelf. Typing a count turns stock
 * tracking on; a new count is saved as a recorded stock movement (opening stock or recount).
 * Used by Settings → Products and by the Stock page.
 */
export function ProductModal({ product, categories, onClose }: { product: Product | null; categories: string[]; onClose: () => void }) {
  const { t } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const [form, setForm] = useState<ProductForm>(() =>
    product
      ? {
          name: product.name,
          category: product.category,
          price: f.money(product.price),
          trackStock: product.trackStock,
          stock: product.trackStock ? String(product.stockQty) : '',
          lowStockAt: product.lowStockAt ? String(product.lowStockAt) : '',
          active: product.active,
          sort: product.sort,
        }
      : { name: '', category: categories[0] ?? '', price: '', trackStock: true, stock: '', lowStockAt: '5', active: true, sort: 0 },
  );
  const set = (patch: Partial<ProductForm>) => setForm((cur) => ({ ...cur, ...patch }));
  const price = parseMoney(form.price || '', f.decimals);
  const stock = form.stock === '' ? null : Number(form.stock);
  const valid = !!form.name.trim() && !!form.category.trim() && price != null && price >= 0;

  const save = async () => {
    if (!valid || price == null) return;
    const body = {
      name: form.name.trim(),
      category: form.category.trim(),
      price,
      trackStock: form.trackStock,
      lowStockAt: form.trackStock ? Number(form.lowStockAt || 0) : 0,
      active: form.active,
      sort: form.sort,
      ...(form.trackStock && stock != null ? { stockQty: stock } : {}),
    };
    const ok = await run(() => (product ? api('PATCH', `/api/settings/products/${product.id}`, body) : api('POST', '/api/settings/products', body)), {
      success: t('common.saved'),
    });
    if (ok) onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={product ? product.name : t('settings.product.add')}
      footer={
        <>
          {product && (
            <DeleteButton
              label={t('settings.product.delete')}
              confirmTitle={t('settings.product.deleteConfirm', { name: product.name })}
              body={t('settings.product.deleteBody')}
              path={`/api/settings/products/${product.id}`}
              onDeleted={onClose}
            />
          )}
          <Button variant="primary" size="lg" className="flex-1" loading={busy} disabled={!valid} onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.product.name')} htmlFor="p-name">
          <Input id="p-name" autoFocus={!product && autoFocusField()} value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} />
        </Field>
        <Field label={t('settings.product.category')} htmlFor="p-cat" hint={t('settings.product.categoryHint')}>
          <Input id="p-cat" list="cats" value={form.category} onChange={(e) => set({ category: e.target.value })} maxLength={40} />
          <datalist id="cats">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field
          label={t('settings.product.price')}
          htmlFor="p-price"
          error={form.price.trim() !== '' && (price == null || price < 0) ? t('settings.product.priceInvalid', { example: f.money(1250) }) : undefined}
        >
          <Input id="p-price" inputMode="decimal" className="num" value={form.price} onChange={(e) => set({ price: e.target.value })} placeholder={f.money(0)} />
        </Field>
        <Field
          label={t('settings.product.stockNow')}
          htmlFor="p-stock"
          hint={product?.trackStock ? t('settings.product.stockNowHint', { n: product.stockQty }) : t('settings.product.stockNewHint')}
        >
          <Input
            id="p-stock"
            inputMode="numeric"
            className="num text-lg font-semibold"
            value={form.stock}
            placeholder={form.trackStock ? '0' : '—'}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 7);
              set({ stock: v, ...(v !== '' ? { trackStock: true } : {}) });
            }}
          />
        </Field>
        {form.trackStock && (
          <Field label={t('settings.product.lowStockAt')} hint={t('settings.product.lowStockHint')} htmlFor="p-low">
            <Input id="p-low" inputMode="numeric" className="num" value={form.lowStockAt} onChange={(e) => set({ lowStockAt: e.target.value.replace(/\D/g, '').slice(0, 5) })} />
          </Field>
        )}
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Switch
            checked={form.trackStock}
            onChange={(v) => set({ trackStock: v, ...(v ? {} : { stock: '' }) })}
            label={t('settings.product.trackStock')}
            hint={t('settings.product.trackStockHint')}
          />
          <Switch checked={form.active} onChange={(v) => set({ active: v })} label={t('common.active')} />
        </div>
      </div>
    </Modal>
  );
}

export function ProductsTab({ data }: { data: SettingsBundle }) {
  const { t } = useT();
  const [editing, setEditing] = useState<{ product: Product | null } | null>(null);
  const categories = [...new Set(data.products.map((p) => p.category))];
  const grouped = categories.map((c) => [c, data.products.filter((p) => p.category === c)] as const);

  return (
    <Card className="p-5">
      <Header title={t('settings.products')} addLabel={t('settings.product.add')} onAdd={() => setEditing({ product: null })} />
      <div className="flex flex-col gap-5">
        {grouped.map(([cat, list]) => (
          <div key={cat}>
            <div className="mb-2 text-xs font-semibold text-faint">{cat}</div>
            <div className="divide-y divide-line rounded-card border border-line">
              {list.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setEditing({ product: p })}
                  className={clsx('flex w-full items-center gap-3 px-3.5 py-2.5 text-start text-sm hover:bg-surface-2', !p.active && 'opacity-50')}
                >
                  <span className="flex-1 font-medium">{p.name}</span>
                  {p.trackStock && <StockPill left={p.stockQty} lowAt={p.lowStockAt} />}
                  <Money value={p.price} className="w-20 justify-end" />
                  <Pencil className="size-4 text-faint" />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {editing && <ProductModal product={editing.product} categories={categories} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ------------------------------------------------------------------ staff

type StaffForm = { name: string; role: 'owner' | 'manager' | 'cashier' | 'waiter'; pin: string; active: boolean };

export function StaffTab({ data }: { data: SettingsBundle }) {
  const { t, tk } = useT();
  const me = useAuth((s) => s.user);
  const [editing, setEditing] = useState<{ id: string | null; form: StaffForm } | null>(null);
  const { busy, run } = useAction();
  const roles: StaffForm['role'][] = me?.role === 'owner' ? ['owner', 'manager', 'cashier', 'waiter'] : ['cashier', 'waiter'];

  const save = async () => {
    if (!editing) return;
    const { pin, ...rest } = editing.form;
    const body = pin ? { ...rest, pin } : rest;
    const ok = await run(() => (editing.id ? api('PATCH', `/api/settings/staff/${editing.id}`, body) : api('POST', '/api/settings/staff', body)), { success: t('common.saved') });
    if (ok) setEditing(null);
  };
  const pinValid = editing ? (editing.form.pin === '' ? !!editing.id : /^\d{4,8}$/.test(editing.form.pin)) : false;

  return (
    <Card className="p-5">
      <Header title={t('settings.staff')} addLabel={t('settings.staffForm.add')} onAdd={() => setEditing({ id: null, form: { name: '', role: 'cashier', pin: '', active: true } })} />
      <div className="grid gap-2 sm:grid-cols-2">
        {data.staff.map((u) => (
          <button
            key={u.id}
            disabled={me?.role !== 'owner' && (u.role === 'owner' || u.role === 'manager')}
            onClick={() => setEditing({ id: u.id, form: { name: u.name, role: u.role, pin: '', active: u.active } })}
            className={clsx('flex items-center gap-3 rounded-card border border-line bg-surface-2 p-3 text-start hover:border-line-strong disabled:cursor-default disabled:hover:border-line', !u.active && 'opacity-50')}
          >
            <span className="grid size-9 place-items-center rounded-full bg-accent/15 text-accent">
              <UserRound className="size-4" />
            </span>
            <div className="flex-1">
              <div className="font-medium">{u.name}</div>
              <div className="text-xs text-muted">{tk('roles', u.role)}</div>
            </div>
          </button>
        ))}
      </div>
      {editing && (
        <Modal
          open
          onOpenChange={(o) => !o && setEditing(null)}
          title={editing.id ? editing.form.name : t('settings.staffForm.add')}
          footer={
            <Button variant="primary" loading={busy} disabled={!editing.form.name.trim() || !pinValid} onClick={save}>
              {t('common.save')}
            </Button>
          }
        >
          <div className="grid gap-4">
            <Field label={t('common.name')} htmlFor="u-name">
              <Input id="u-name" value={editing.form.name} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, name: e.target.value } })} />
            </Field>
            <Field label={t('settings.staffForm.role')} htmlFor="u-role">
              <Select id="u-role" value={editing.form.role} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, role: e.target.value as StaffForm['role'] } })}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {tk('roles', r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('settings.staffForm.pin')} hint={editing.id ? t('settings.staffForm.pinKeep') : undefined} htmlFor="u-pin">
              <Input
                id="u-pin"
                inputMode="numeric"
                type="password"
                autoComplete="new-password"
                className="num tracking-[0.4em]"
                maxLength={8}
                value={editing.form.pin}
                onChange={(e) => setEditing({ ...editing, form: { ...editing.form, pin: e.target.value.replace(/\D/g, '') } })}
              />
            </Field>
            <Switch checked={editing.form.active} onChange={(v) => setEditing({ ...editing, form: { ...editing.form, active: v } })} label={t('common.active')} />
          </div>
        </Modal>
      )}
    </Card>
  );
}
