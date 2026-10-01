import { computeCheckout, parseMoney } from '@lounge/core';
import { Banknote, Coffee, CreditCard, ShoppingBag } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Card, EmptyState, Field, Input, Money, Num, Segmented, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { useFmt } from '../../lib/format';
import { useFloor, useProducts } from '../../lib/queries';
import type { Product } from '../../lib/types';
import { announceStock, CartLines, QuickProducts, useCart, type Cart, type StockLeft } from './products';

/**
 * Cafeteria: drinks and snacks for someone who is not on a device, paid on the spot. Tap the items,
 * take cash or visa, done — the stock goes down and the sale is in the ledger as "cafeteria".
 */
export function CafePage() {
  const { t } = useT();
  const f = useFmt();
  const floor = useFloor();
  const products = useProducts();
  const cart = useCart();
  const [phoneOpen, setPhoneOpen] = useState(false);

  if (!floor.data || !products.data) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  const list = products.data.filter((p) => p.active);
  const total = saleTotal(cart, list, floor.data.branch.settings.checkout.cashRounding);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-4 md:p-6 lg:flex-row lg:items-start">
      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Coffee className="size-5 text-accent" /> {t('cafe.title')}
          </h1>
          <p className="mt-1 text-sm text-muted">{t('cafe.hint')}</p>
        </header>
        {list.length === 0 ? <EmptyState icon={<Coffee />} title={t('cafe.noProducts')} /> : <QuickProducts products={list} cart={cart} />}
      </section>

      {/* Tablet / computer: the order stays beside the items. */}
      <Card className="hidden w-96 shrink-0 p-4 lg:sticky lg:top-4 lg:block">
        <OrderPanel cart={cart} products={list} total={total} shiftOpen={!!floor.data.shift} />
      </Card>

      {/* Phone: a bar above the tabs with the total; it opens the order to pay. */}
      {cart.count > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-surface-1/95 p-3 backdrop-blur lg:hidden">
          <Button variant="primary" size="lg" block icon={<ShoppingBag className="size-5" />} onClick={() => setPhoneOpen(true)}>
            {t('cafe.order')} · <Num>{cart.count}</Num> · {f.money(total)}
          </Button>
        </div>
      )}
      {cart.count > 0 && <div className="h-20 lg:hidden" aria-hidden />}
      <Modal open={phoneOpen && cart.count > 0} onOpenChange={setPhoneOpen} title={t('cafe.order')} size="sm">
        <OrderPanel cart={cart} products={list} total={total} shiftOpen={!!floor.data.shift} onSold={() => setPhoneOpen(false)} />
      </Modal>
    </div>
  );
}

/** Same total the server will charge: items, then the shop's cash rounding. */
function saleTotal(cart: Cart, products: Product[], cashRounding: number) {
  const items = cart.items.flatMap((i) => {
    const p = products.find((x) => x.id === i.productId);
    return p ? [{ unitPrice: p.price, qty: i.qty, voided: false }] : [];
  });
  if (items.length === 0) return 0;
  return computeCheckout({ timeCharge: 0, items, discount: null, cashRounding, paid: 0 }).total;
}

function OrderPanel({ cart, products, total, shiftOpen, onSold }: { cart: Cart; products: Product[]; total: number; shiftOpen: boolean; onSold?: () => void }) {
  const { t } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const [method, setMethod] = useState<'cash' | 'card'>('cash');
  const [received, setReceived] = useState('');
  // The panel is drawn twice (beside the items on a computer, in a window on a phone): own ids.
  const receivedId = useId();
  const receivedMinor = received.trim() ? parseMoney(received, f.decimals) : null;
  const change = method === 'cash' && receivedMinor != null ? receivedMinor - total : null;

  const sell = async () => {
    const res = await run(() =>
      post<{ number: number; stock: StockLeft[] }>('/api/counter/sale', {
        items: cart.items,
        payments: total > 0 ? [{ method, amount: total }] : [],
        expectedTotal: total,
      }),
    );
    if (!res) return;
    announceStock(res.stock, t, t('cafe.sold', { n: res.number }));
    cart.clear();
    setReceived('');
    onSold?.();
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="hidden font-semibold lg:block">{t('cafe.order')}</h2>
      <CartLines cart={cart} products={products} />
      {cart.count > 0 && (
        <>
          <div className="flex items-baseline justify-between border-t border-line pt-3">
            <span className="text-sm text-muted">{t('cafe.total')}</span>
            <Money value={total} currency className="text-2xl font-bold" />
          </div>
          <Segmented
            value={method}
            onChange={setMethod}
            options={[
              { value: 'cash', label: <span className="flex items-center gap-2"><Banknote className="size-4" /> {t('checkout.cash')}</span> },
              { value: 'card', label: <span className="flex items-center gap-2"><CreditCard className="size-4" /> {t('checkout.card')}</span> },
            ]}
          />
          {method === 'cash' && (
            <Field
              label={t('cafe.received')}
              htmlFor={receivedId}
              error={received.trim() && receivedMinor == null ? t('settings.product.priceInvalid', { example: f.money(1000) }) : undefined}
            >
              <Input id={receivedId} inputMode="decimal" className="num text-lg" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={f.money(total)} />
            </Field>
          )}
          {change != null && change >= 0 && (
            <div data-status="free" className="st-soft flex items-center justify-between rounded-control px-3 py-2 font-semibold">
              <span>{t('checkout.change')}</span>
              <Money value={change} currency />
            </div>
          )}
          {change != null && change < 0 && <p className="text-sm text-danger">{t('checkout.insufficient')}</p>}
          {!shiftOpen && <p className="text-sm text-st-ending">{t('shift.noneHint')}</p>}
          <Button variant="primary" size="xl" block loading={busy} disabled={!shiftOpen || (change != null && change < 0)} onClick={sell}>
            {t('cafe.sell')} · {f.money(total)}
          </Button>
        </>
      )}
    </div>
  );
}
