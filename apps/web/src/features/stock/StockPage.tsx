import { parseMoney } from '@lounge/core';
import { clsx } from 'clsx';
import { ChevronDown, CircleCheck, PackageOpen, PackagePlus, Pencil, Plus, Search, Settings2, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Card, EmptyState, Field, Input, Money, Num, SectionTitle, Select, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { can, useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/format';
import { useMovements, useStock } from '../../lib/queries';
import type { Product, StockMovement } from '../../lib/types';
import { stockLevel, type StockLevel } from '../cafe/products';
import { ProductModal } from '../settings/CatalogTabs';
import { autoFocusField } from '../../lib/viewport';

type Filter = 'all' | 'low' | 'out';
const ORDER: Record<StockLevel, number> = { out: 0, low: 1, ok: 2 };

/**
 * The stock page ("المخزون"): every counted product with how many pieces are left, the ones
 * running out on top; deliveries in (cartons), counts, new products with their opening stock,
 * and the full in/out history of each product.
 */
export function StockPage() {
  const { t } = useT();
  const role = useAuth((s) => s.user?.role);
  const stock = useStock();
  const [params, setParams] = useSearchParams();
  const [receiving, setReceiving] = useState<string | null | false>(false);
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [editing, setEditing] = useState<{ product: Product | null } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const manage = can.settings(role);

  // "/stock?receive=1" (from the floor's Stock panel) opens "Receive goods" straight away.
  useEffect(() => {
    if (params.get('receive') !== '1') return;
    setReceiving(null);
    setParams({}, { replace: true });
  }, [params, setParams]);

  const list = stock.data ?? [];
  const categories = useMemo(() => [...new Set(list.map((p) => p.category))], [list]);
  const tracked = useMemo(
    () =>
      list
        .filter((p) => p.trackStock)
        .map((p) => ({ ...p, level: stockLevel(p.stockQty, p.lowStockAt) }))
        .sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
    [list],
  );
  const untracked = list.filter((p) => !p.trackStock);
  const counts = { low: tracked.filter((p) => p.level === 'low').length, out: tracked.filter((p) => p.level === 'out').length };
  const value = tracked.reduce((s, p) => s + Math.max(0, p.stockQty) * p.price, 0);
  const needle = q.trim().toLowerCase();
  const shown = tracked.filter(
    (p) => (filter === 'all' || p.level === filter) && (!needle || p.name.toLowerCase().includes(needle) || p.category.toLowerCase().includes(needle)),
  );

  if (stock.isLoading) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 md:p-6">
      {/* Title + the two actions the owner needs most */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="me-auto">
          <h1 className="text-xl font-bold">{t('nav.stock')}</h1>
          <p className="text-sm text-muted">{t('stock.pageHint')}</p>
        </div>
        {manage && (
          <>
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ product: null })}>
              {t('settings.product.add')}
            </Button>
            <Button variant="primary" size="lg" icon={<PackagePlus className="size-5" />} onClick={() => setReceiving(null)}>
              {t('goods.receive')}
            </Button>
          </>
        )}
      </div>

      {/* At a glance — the counts are also filters */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t('stock.items')} value={<Num>{tracked.length}</Num>} on={filter === 'all'} onClick={() => setFilter('all')} />
        <Tile
          label={t('stock.lowItems')}
          value={<Num>{counts.low}</Num>}
          status={counts.low ? 'ending' : undefined}
          on={filter === 'low'}
          onClick={() => setFilter(filter === 'low' ? 'all' : 'low')}
        />
        <Tile
          label={t('stock.outItems')}
          value={<Num>{counts.out}</Num>}
          status={counts.out ? 'overtime' : undefined}
          on={filter === 'out'}
          onClick={() => setFilter(filter === 'out' ? 'all' : 'out')}
        />
        <Tile label={t('goods.value')} value={<Money value={value} />} />
      </div>

      {tracked.length > 0 && (
        <div className="relative sm:max-w-sm">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('stock.search')}
            aria-label={t('stock.search')}
            className="h-10 w-full rounded-control border border-line bg-surface-1 pe-3 ps-9 text-base shadow-[var(--shadow-card)] placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 sm:text-sm"
          />
        </div>
      )}

      {tracked.length === 0 ? (
        <EmptyState
          icon={<PackageOpen />}
          title={t('goods.empty')}
          action={manage && <Button variant="primary" onClick={() => setReceiving(null)}>{t('goods.receive')}</Button>}
        />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Search />} title={t('floor.noMatch')} action={<Button onClick={() => (setQ(''), setFilter('all'))}>{t('common.all')}</Button>} />
      ) : (
        <Card className="divide-y divide-line">
          {shown.map((p) => {
            const open = openId === p.id;
            return (
              <div key={p.id}>
                {/* On a phone the actions drop to their own line so the name and price stay readable. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <button onClick={() => setOpenId(open ? null : p.id)} className="flex min-w-0 flex-1 items-center gap-3 text-start" aria-expanded={open}>
                    <ChevronDown className={clsx('size-4 shrink-0 text-faint transition-transform', open && 'rotate-180')} />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{p.name}</div>
                      <div className="text-xs text-faint">
                        {p.category} · <Money value={p.price} /> / {t('goods.pieces')}
                        {p.packSize ? <> · <Num>{p.packSize}</Num> {t('goods.perCarton')}</> : null}
                      </div>
                    </div>
                  </button>
                  <div
                    data-status={p.level === 'out' ? 'overtime' : p.level === 'low' ? 'ending' : undefined}
                    className="flex w-16 shrink-0 flex-col items-center"
                    aria-label={`${t('goods.inStock')}: ${p.stockQty}`}
                  >
                    <Num className={clsx('text-2xl font-bold leading-none', p.level !== 'ok' && 'st-fg')}>{Math.max(0, p.stockQty)}</Num>
                    <span className={clsx('mt-1 text-[11px]', p.level !== 'ok' ? 'st-fg font-semibold' : 'text-faint')}>
                      {p.level === 'out' ? t('goods.out') : p.level === 'low' ? t('goods.low') : t('goods.pieces')}
                    </span>
                  </div>
                  {manage && (
                    <div className="flex shrink-0 justify-end gap-1 max-sm:basis-full max-sm:border-t max-sm:border-line/60 max-sm:pt-1">
                      <Button size="icon" variant="ghost" onClick={() => setReceiving(p.id)} aria-label={t('goods.receive')} title={t('goods.receive')}>
                        <Plus className="size-5" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => setAdjusting(p)} aria-label={t('goods.adjust')} title={t('goods.adjust')}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => setEditing({ product: p })} aria-label={t('stock.editProduct')} title={t('stock.editProduct')}>
                        <Settings2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </div>
                {open && (
                  <div className="bg-surface-2/60 px-4 pb-3 pt-1">
                    <Movements productId={p.id} />
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {untracked.length > 0 && manage && (
        <div>
          <SectionTitle>{t('goods.notTracked')}</SectionTitle>
          <p className="-mt-2 mb-3 text-xs text-faint">{t('stock.notTrackedHint')}</p>
          <div className="flex flex-wrap gap-2">
            {untracked.map((p) => (
              <button
                key={p.id}
                onClick={() => setEditing({ product: p })}
                className="flex h-9 items-center gap-1.5 rounded-full border border-dashed border-line-strong px-3 text-sm text-muted hover:border-accent hover:text-accent"
              >
                <Plus className="size-3.5" /> {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <Card className="p-5">
        <SectionTitle>{t('goods.lastMoves')}</SectionTitle>
        <Movements productId={null} showProduct />
      </Card>

      {receiving !== false && <ReceiveModal products={list} initialProductId={receiving} onClose={() => setReceiving(false)} />}
      {adjusting && <AdjustModal product={adjusting} onClose={() => setAdjusting(null)} />}
      {editing && <ProductModal product={editing.product} categories={categories} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Tile({ label, value, status, on, onClick }: { label: string; value: React.ReactNode; status?: string; on?: boolean; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick, 'aria-pressed': on } : {})}
      data-status={status}
      className={clsx(
        'flex flex-col items-start rounded-card border p-4 text-start shadow-[var(--shadow-card)] transition-colors',
        on ? (status ? 'tint-strong' : 'border-accent bg-accent/5') : status ? 'tint' : 'border-line bg-surface-1',
        onClick && 'hover:border-line-strong',
      )}
    >
      <span className="flex items-center gap-1.5 text-sm text-muted">
        {status === 'ending' && <TriangleAlert className="st-fg size-4" />}
        {status === 'overtime' && <TriangleAlert className="st-fg size-4" />}
        {!status && onClick && <CircleCheck className="size-4 text-faint" />}
        {label}
      </span>
      <span className={clsx('mt-1 text-2xl font-bold', status && 'st-fg')}>{value}</span>
    </Tag>
  );
}

function Movements({ productId, showProduct }: { productId: string | null; showProduct?: boolean }) {
  const { t } = useT();
  const f = useFmt();
  const moves = useMovements(productId, showProduct ? 30 : 20);
  if (moves.isLoading) return <Skeleton className="h-20" />;
  const list = moves.data ?? [];
  if (list.length === 0) return <p className="py-2 text-sm text-faint">—</p>;
  return (
    <ul className="flex flex-col">
      {list.map((m: StockMovement) => (
        <li key={m.id} className="flex items-center gap-3 border-b border-line/60 py-2 text-sm last:border-0">
          <span className="w-28 shrink-0 text-xs tabular-nums text-faint">{f.dateTime(m.createdAt)}</span>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{t(`goods.reasons.${m.reason}`)}</span>
            {showProduct && <span className="text-muted"> · {m.productName}</span>}
            {m.reason === 'purchase' && m.cartons && m.packSize && <span className="text-faint"> · {t('goods.cartonsOf', { c: m.cartons, p: m.packSize })}</span>}
            {m.note && <span className="text-faint"> · {m.note}</span>}
            {m.createdByName && <span className="text-faint"> · {m.createdByName}</span>}
          </span>
          <Num className={clsx('shrink-0 font-semibold', m.delta > 0 ? 'text-st-free' : m.delta < 0 ? 'text-muted' : 'text-faint')}>
            {m.delta > 0 ? `+${m.delta}` : m.delta}
          </Num>
        </li>
      ))}
    </ul>
  );
}

const NEW = '__new';

interface Line {
  key: number;
  productId: string;
  name: string;
  category: string;
  cartons: string;
  packSize: string;
  price: string;
}

/**
 * A delivery, as the owner says it: "2 cartons of chips, 24 in each, 0.500 a piece" —
 * several products in one go. The last carton size and price are remembered.
 */
function ReceiveModal({ products, initialProductId, onClose }: { products: Product[]; initialProductId: string | null; onClose: () => void }) {
  const { t } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const [note, setNote] = useState('');
  const categories = useMemo(() => [...new Set(products.map((p) => p.category))], [products]);

  const lineFor = (productId: string, key: number): Line => {
    const p = products.find((x) => x.id === productId);
    return {
      key,
      productId,
      name: '',
      category: categories[0] ?? '',
      cartons: '1',
      packSize: p?.packSize ? String(p.packSize) : '',
      price: p ? f.money(p.price) : '',
    };
  };
  const [lines, setLines] = useState<Line[]>(() => [lineFor(initialProductId ?? '', 1)]);
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const parsed = lines.map((l) => {
    const cartons = Number(l.cartons);
    const packSize = Number(l.packSize);
    const price = l.price === '' ? null : parseMoney(l.price, f.decimals);
    const isNew = l.productId === NEW;
    const ok =
      (isNew ? l.name.trim() && l.category.trim() : !!l.productId) &&
      Number.isInteger(cartons) && cartons >= 1 &&
      Number.isInteger(packSize) && packSize >= 1 &&
      (l.price === '' ? !isNew : price != null);
    return { l, cartons, packSize, price, isNew, ok, pieces: ok ? cartons * packSize : 0 };
  });
  const valid = parsed.length > 0 && parsed.every((p) => p.ok);
  const total = parsed.reduce((s, p) => s + p.pieces, 0);

  const submit = async () => {
    const body = {
      note: note.trim() || null,
      lines: parsed.map((p) => ({
        ...(p.isNew ? { newProduct: { name: p.l.name.trim(), category: p.l.category.trim() } } : { productId: p.l.productId }),
        cartons: p.cartons,
        packSize: p.packSize,
        price: p.price,
      })),
    };
    if (await run(() => post('/api/stock/receive', body), { success: t('goods.received') })) onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('goods.receive')}
      description={t('stock.receiveHint')}
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => setLines((ls) => [...ls, lineFor('', Math.max(...ls.map((x) => x.key)) + 1)])}>
            {t('goods.addLine')}
          </Button>
          <Button variant="primary" size="lg" loading={busy} disabled={!valid} onClick={submit}>
            {t('goods.receive')}
            {total > 0 && <span className="ms-1 opacity-80">· {t('goods.willAdd', { n: total })}</span>}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {parsed.map(({ l, pieces }) => (
          <div key={l.key} className="rounded-card border border-line p-3">
            <div className="grid gap-3 sm:grid-cols-[1.6fr_1fr_1fr_1fr_auto] sm:items-end">
              <Field label={t('goods.product')} htmlFor={`g-p-${l.key}`}>
                <Select
                  id={`g-p-${l.key}`}
                  value={l.productId}
                  onChange={(e) => {
                    const next = lineFor(e.target.value, l.key);
                    update(l.key, { productId: e.target.value, packSize: next.packSize || l.packSize, price: e.target.value === NEW ? '' : next.price });
                  }}
                >
                  <option value="">{t('goods.chooseProduct')}</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value={NEW}>{t('goods.newProduct')}</option>
                </Select>
              </Field>
              <Field label={t('goods.cartons')} htmlFor={`g-c-${l.key}`}>
                <Input id={`g-c-${l.key}`} inputMode="numeric" className="num text-center" value={l.cartons} onChange={(e) => update(l.key, { cartons: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label={t('goods.perCarton')} htmlFor={`g-s-${l.key}`}>
                <Input id={`g-s-${l.key}`} inputMode="numeric" className="num text-center" value={l.packSize} onChange={(e) => update(l.key, { packSize: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label={t('goods.pricePerPiece')} htmlFor={`g-r-${l.key}`}>
                <Input id={`g-r-${l.key}`} inputMode="decimal" className="num text-center" value={l.price} onChange={(e) => update(l.key, { price: e.target.value })} placeholder={f.money(0)} />
              </Field>
              {lines.length > 1 ? (
                <Button variant="ghost" size="icon" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={t('common.cancel')}>
                  <Trash2 className="size-4" />
                </Button>
              ) : (
                <span className="hidden w-10 sm:block" />
              )}
            </div>
            {l.productId === NEW && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={t('goods.name')} htmlFor={`g-n-${l.key}`}>
                  <Input id={`g-n-${l.key}`} value={l.name} onChange={(e) => update(l.key, { name: e.target.value })} maxLength={60} />
                </Field>
                <Field label={t('goods.category')} htmlFor={`g-k-${l.key}`}>
                  <Input id={`g-k-${l.key}`} list="goods-cats" value={l.category} onChange={(e) => update(l.key, { category: e.target.value })} maxLength={40} />
                </Field>
              </div>
            )}
            {pieces > 0 && (
              <div data-status="free" className="st-fg mt-2 text-sm font-semibold">
                {t('goods.willAdd', { n: pieces })}
              </div>
            )}
          </div>
        ))}
        <datalist id="goods-cats">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <Field label={t('goods.note')} htmlFor="g-note">
          <Input id="g-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('common.optional')} maxLength={200} />
        </Field>
      </div>
    </Modal>
  );
}

function AdjustModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const { t } = useT();
  const { busy, run } = useAction();
  const [count, setCount] = useState(String(product.stockQty));
  const [reason, setReason] = useState('');
  const n = Number(count);
  const valid = count !== '' && Number.isInteger(n) && n >= 0;
  const diff = valid ? n - product.stockQty : 0;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${t('goods.adjust')} — ${product.name}`}
      description={t('stock.adjustHint')}
      size="sm"
      footer={
        <Button
          variant="primary"
          size="lg"
          block
          loading={busy}
          disabled={!valid || diff === 0}
          onClick={async () => {
            if (await run(() => post(`/api/stock/${product.id}/adjust`, { countedQty: n, reason: reason.trim() || null }), { success: t('goods.adjusted') })) onClose();
          }}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('goods.counted')} htmlFor="adj-count" hint={`${t('reports.systemQty')}: ${product.stockQty}`}>
          <Input id="adj-count" autoFocus={autoFocusField()} inputMode="numeric" className="num h-14 text-center text-2xl font-semibold" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />
        </Field>
        {diff !== 0 && (
          <div data-status={diff < 0 ? 'overtime' : 'free'} className="st-soft rounded-control px-3 py-2 text-sm font-semibold">
            <Num>{diff > 0 ? `+${diff}` : diff}</Num> {t('goods.pieces')}
          </div>
        )}
        <Field label={t('common.reason')} htmlFor="adj-reason">
          <Input id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('common.optional')} maxLength={200} />
        </Field>
      </div>
    </Modal>
  );
}
