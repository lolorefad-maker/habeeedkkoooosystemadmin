import { Gift, Pencil, Plus, Search, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Card, EmptyState, Field, Input, Num, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { api, post } from '../../lib/api';
import { useFmt } from '../../lib/format';
import { useCustomers } from '../../lib/queries';
import type { Customer } from '../../lib/types';
import { PhoneField } from '../rewards/PhoneField';

/**
 * The customers' numbers. A number typed when a device is opened lands here by itself; the cashier
 * (or owner) can also add a number by hand and fix a name. Same page, same powers, for both.
 */
export function CustomersPage() {
  const { t } = useT();
  const f = useFmt();
  const list = useCustomers();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);

  const rows = list.data ?? [];
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const digits = term.replace(/\D/g, '');
    if (!term) return rows;
    return rows.filter((c) => c.name.toLowerCase().includes(term) || (digits.length > 0 && c.phone.includes(digits.replace(/^0+/, ''))));
  }, [rows, q]);

  if (list.isLoading) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-20" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t('customers.title')}</h1>
          <p className="text-sm text-muted">{t('customers.hint')}</p>
        </div>
        <Button variant="primary" size="lg" icon={<Plus className="size-5" />} onClick={() => setEditing('new')}>
          {t('customers.add')}
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-faint" aria-hidden />
        <Input className="ps-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('customers.search')} aria-label={t('customers.search')} />
      </div>
      <div className="text-xs text-muted">{t('customers.count', { n: shown.length })}</div>

      {rows.length === 0 ? (
        <EmptyState icon={<Users />} title={t('customers.empty')} action={<Button onClick={() => setEditing('new')}>{t('customers.add')}</Button>} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Search />} title={t('customers.noMatch')} />
      ) : (
        <Card className="divide-y divide-line">
          {shown.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="truncate font-semibold">{c.name === c.phone ? t('customers.noName') : c.name}</span>
                  <Num className="text-sm text-muted">+{c.phone}</Num>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  <span>{c.visits > 0 ? t('customers.visits', { n: c.visits }) : t('customers.noVisits')}</span>
                  {c.lastVisitAt && <span>· {t('customers.last', { time: f.dateTime(c.lastVisitAt) })}</span>}
                </div>
                {c.notes && <div className="mt-0.5 text-xs text-faint">{c.notes}</div>}
              </div>
              {c.freeAvailable > 0 && (
                <span data-status="free" className="tint inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold">
                  <Gift className="size-3.5" aria-hidden />
                  {t('customers.free', { n: c.freeAvailable })}
                </span>
              )}
              <Button variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(c)}>
                {t('customers.edit')}
              </Button>
            </div>
          ))}
        </Card>
      )}

      {editing && <CustomerModal customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CustomerModal({ customer, onClose }: { customer: Customer | null; onClose: () => void }) {
  const { t } = useT();
  const { busy, run } = useAction();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState(customer && customer.name !== customer.phone ? customer.name : '');
  const [notes, setNotes] = useState(customer?.notes ?? '');

  const save = async () => {
    const ok = await run(
      () =>
        customer
          ? api('PATCH', `/api/customers/${customer.id}`, { name: name.trim() || customer.phone, notes: notes.trim() || null })
          : post('/api/customers', { phone: phone.trim(), name: name.trim() || null, notes: notes.trim() || null }),
      { success: t('customers.saved') },
    );
    if (ok) onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={customer ? t('customers.editTitle') : t('customers.addTitle')}
      description={customer ? `+${customer.phone}` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="lg" loading={busy} disabled={!customer && phone.replace(/\D/g, '').length < 7} onClick={save}>
            {t('customers.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!customer && <PhoneField id="customer-phone" value={phone} onChange={setPhone} autoFocus />}
        <Field label={t('customers.name')} htmlFor="customer-name">
          <Input id="customer-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <Field label={t('customers.notes')} htmlFor="customer-notes">
          <Input id="customer-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}
