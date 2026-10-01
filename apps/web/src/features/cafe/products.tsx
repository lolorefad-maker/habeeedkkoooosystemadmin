import { clsx } from 'clsx';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Money, Num } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { onLiveEvent } from '../../lib/realtime';
import type { Product } from '../../lib/types';

export function useCart() {
  const [lines, setLines] = useState<Map<string, number>>(new Map());
  const add = useCallback((id: string, delta = 1) => {
    setLines((prev) => {
      const next = new Map(prev);
      const q = (next.get(id) ?? 0) + delta;
      if (q <= 0) next.delete(id);
      else next.set(id, Math.min(99, q));
      return next;
    });
  }, []);
  const clear = useCallback(() => setLines(new Map()), []);
  const items = useMemo(() => [...lines.entries()].map(([productId, qty]) => ({ productId, qty })), [lines]);
  return { lines, items, add, clear, count: items.reduce((s, i) => s + i.qty, 0) };
}

export type Cart = ReturnType<typeof useCart>;

export function cartTotal(cart: Cart, products: Product[]) {
  return cart.items.reduce((s, i) => s + (products.find((p) => p.id === i.productId)?.price ?? 0) * i.qty, 0);
}

/**
 * Compact drinks & food picker that lives inside the device sheet: one tap adds one,
 * the badge shows how many are waiting to go on the device's account.
 */
export function QuickProducts({ products, cart }: { products: Product[]; cart: Cart }) {
  const { t } = useT();
  const active = products.filter((p) => p.active);
  const categories = useMemo(() => [...new Set(active.map((p) => p.category))], [active]);
  const [cat, setCat] = useState<string | null>(null);
  const current = cat && categories.includes(cat) ? cat : null;
  const list = current ? active.filter((p) => p.category === current) : active;
  if (active.length === 0) return <p className="text-sm text-faint">{t('cafe.noProducts')}</p>;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
        {[null, ...categories].map((c) => (
          <button
            key={c ?? '_all'}
            onClick={() => setCat(c)}
            className={clsx(
              'h-8 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors',
              current === c ? 'border-accent/50 bg-accent/12 text-accent' : 'border-line text-muted hover:text-fg',
            )}
          >
            {c ?? t('common.all')}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {list.map((p) => {
          const inCart = cart.lines.get(p.id) ?? 0;
          const out = p.trackStock && p.stockQty - inCart <= 0;
          return (
            <button
              key={p.id}
              disabled={out}
              onClick={() => cart.add(p.id)}
              className={clsx(
                'relative flex min-h-14 flex-col items-start justify-center rounded-control border px-2.5 py-1.5 text-start transition-all active:scale-[0.97] disabled:opacity-40',
                inCart ? 'border-accent/60 bg-accent/10' : 'border-line bg-surface-2 hover:border-line-strong',
              )}
            >
              <span className="w-full truncate text-sm font-medium">{p.name}</span>
              <span className="mt-0.5 flex w-full items-center justify-between gap-1">
                <Money value={p.price} className="text-xs text-muted" />
                {/* What is left on the shelf once this pick goes on the account. */}
                {p.trackStock && <StockPill left={p.stockQty - inCart} lowAt={p.lowStockAt} />}
              </span>
              {inCart > 0 && (
                <span className="num absolute -end-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-accent text-[11px] font-bold text-accent-fg">
                  {inCart}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export type StockLevel = 'ok' | 'low' | 'out';

/** "Low" only when the owner set an alert level for the product (Settings → Products, or on a delivery). */
export function stockLevel(left: number, lowAt: number): StockLevel {
  if (left <= 0) return 'out';
  return lowAt > 0 && left <= lowAt ? 'low' : 'ok';
}

/** "باقي 22" — amber when running low, red when out. */
export function StockPill({ left, lowAt, className }: { left: number; lowAt: number; className?: string }) {
  const { t } = useT();
  const level = stockLevel(left, lowAt);
  return (
    <span
      data-status={level === 'out' ? 'overtime' : level === 'low' ? 'ending' : undefined}
      className={clsx(
        'shrink-0 whitespace-nowrap rounded-full px-1.5 py-px text-[11px] font-semibold [font-variant-numeric:tabular-nums]',
        level === 'ok' ? 'bg-surface-3 text-muted' : 'st-soft',
        className,
      )}
    >
      {level === 'out' ? t('stock.out') : t('stock.left', { n: left })}
    </span>
  );
}

/** What the server says is left after drinks went on a device (tracked products only). */
export interface StockLeft {
  productId: string;
  name: string;
  left: number;
  lowAt: number;
}

type T = ReturnType<typeof useT>['t'];

/**
 * After drinks go on a device, tell whoever added them how many pieces are left of each
 * ("Pepsi: 43 left"). If something is running low or ran out, it becomes a warning that stays longer.
 */
export function announceStock(stock: StockLeft[] | undefined, t: T, title: string) {
  const list = stock ?? [];
  const worst = list.find((s) => stockLevel(s.left, s.lowAt) === 'out') ?? list.find((s) => stockLevel(s.left, s.lowAt) === 'low');
  // The warning's headline already names the worst item; the lines list the rest.
  const lines = list
    .filter((s) => s !== worst)
    .map((s) => (s.left <= 0 ? t('stock.outNow', { name: s.name }) : t('stock.leftLine', { name: s.name, n: s.left })));
  const description = lines.length ? (
    <span className="flex flex-col">
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </span>
  ) : undefined;
  if (worst) {
    const head = worst.left <= 0 ? t('stock.outNow', { name: worst.name }) : t('stock.low', { name: worst.name, n: worst.left });
    toast.warning(head, { description, duration: 8000 });
  } else {
    toast.success(title, { description });
  }
}

/**
 * Other devices: when someone else's order leaves an item low or out, warn here too.
 * (The device that added the order already got the full "what is left" notice.)
 */
export function useStockWarnings() {
  const { t } = useT();
  const me = useAuth((s) => s.user?.id);
  useEffect(
    () =>
      onLiveEvent((e) => {
        if (e.type !== 'order.created' || e.actorId === me) return;
        for (const s of (e.payload?.stock as StockLeft[] | undefined) ?? []) {
          const level = stockLevel(s.left, s.lowAt);
          if (level === 'ok') continue;
          // One notice per product, updated in place if it keeps going down.
          toast.warning(level === 'out' ? t('stock.outNow', { name: s.name }) : t('stock.low', { name: s.name, n: s.left }), {
            id: `stock-${s.productId}`,
            duration: 8000,
          });
        }
      }),
    [t, me],
  );
}

export function CartLines({ cart, products }: { cart: Cart; products: Product[] }) {
  const { t } = useT();
  if (cart.items.length === 0) return <p className="py-8 text-center text-sm text-faint">{t('cafe.emptyCart')}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line">
      {cart.items.map((i) => {
        const p = products.find((x) => x.id === i.productId);
        if (!p) return null;
        return (
          <li key={i.productId} className="flex items-center gap-2 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{p.name}</div>
              <Money value={p.price * i.qty} className="text-xs text-muted" />
            </div>
            <div className="flex items-center gap-1 rounded-control bg-surface-2 p-0.5">
              <Button size="icon" variant="ghost" className="size-8" onClick={() => cart.add(p.id, -1)} aria-label="-1">
                {i.qty === 1 ? <Trash2 className="size-4" /> : <Minus className="size-4" />}
              </Button>
              <Num className="w-6 text-center text-sm font-semibold">{i.qty}</Num>
              <Button size="icon" variant="ghost" className="size-8" onClick={() => cart.add(p.id, 1)} aria-label="+1">
                <Plus className="size-4" />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
