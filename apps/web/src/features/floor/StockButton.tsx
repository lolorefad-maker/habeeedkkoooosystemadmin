import { clsx } from 'clsx';
import { Boxes, CircleCheck, PackagePlus, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/overlays';
import { Num } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { useProducts } from '../../lib/queries';
import { stockLevel, type StockLevel } from '../cafe/products';

const ORDER: Record<StockLevel, number> = { out: 0, low: 1, ok: 2 };

/**
 * Owner's shortcut on the floor: how many pieces are left of every counted item (chips, chocolate,
 * drinks…), with the ones running out on top. The badge shows how many need restocking.
 */
export function StockButton() {
  const { t } = useT();
  const navigate = useNavigate();
  const products = useProducts();
  const [open, setOpen] = useState(false);

  const list = useMemo(
    () =>
      (products.data ?? [])
        .filter((p) => p.active && p.trackStock)
        .map((p) => ({ ...p, level: stockLevel(p.stockQty, p.lowStockAt) }))
        .sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.stockQty - b.stockQty || a.name.localeCompare(b.name)),
    [products.data],
  );
  const attention = list.filter((p) => p.level !== 'ok').length;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-1 px-3.5 text-sm font-medium text-muted shadow-[var(--shadow-card)] hover:border-line-strong hover:text-fg"
      >
        <Boxes className="size-4" />
        {t('stock.button')}
        {attention > 0 && (
          <span data-status="ending" className="st-soft num grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-bold">
            {attention}
          </span>
        )}
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t('stock.title')}
        description={t('stock.hint')}
        size="md"
        footer={
          <div className="flex w-full flex-col gap-2 sm:flex-row">
            <Button size="lg" block icon={<Boxes className="size-5" />} onClick={() => navigate('/stock')}>
              {t('stock.openPage')}
            </Button>
            <Button variant="primary" size="lg" block icon={<PackagePlus className="size-5" />} onClick={() => navigate('/stock?receive=1')}>
              {t('goods.receive')}
            </Button>
          </div>
        }
      >
        {list.length === 0 ? (
          <p className="py-8 text-center text-sm text-faint">{t('stock.empty')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              data-status={attention > 0 ? 'ending' : 'free'}
              className="tint flex items-center gap-2.5 rounded-card border px-3.5 py-2.5 text-sm font-medium"
            >
              {attention > 0 ? <TriangleAlert className="st-fg size-4" /> : <CircleCheck className="st-fg size-4" />}
              {attention > 0 ? t('stock.attention', { n: attention }) : t('stock.allGood')}
            </div>
            <ul className="divide-y divide-line rounded-card border border-line">
              {list.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="truncate text-xs text-faint">{p.category}</div>
                  </div>
                  <div
                    data-status={p.level === 'out' ? 'overtime' : p.level === 'low' ? 'ending' : undefined}
                    className="flex min-w-14 flex-col items-center"
                  >
                    <Num className={clsx('text-2xl font-semibold leading-none', p.level === 'ok' ? 'text-fg' : 'st-fg')}>
                      {Math.max(0, p.stockQty)}
                    </Num>
                    <span className={clsx('mt-1 text-[11px] font-medium', p.level === 'ok' ? 'text-faint' : 'st-fg')}>
                      {p.level === 'out' ? t('goods.out') : p.level === 'low' ? t('goods.low') : t('goods.pieces')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </>
  );
}
