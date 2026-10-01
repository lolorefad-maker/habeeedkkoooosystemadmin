import { parseMoney } from '@lounge/core';
import { clsx } from 'clsx';
import { Banknote, CreditCard, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { can, useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/format';
import { useFloor } from '../../lib/queries';
import { Button } from '../ui/button';
import { useAction } from '../ui/feedback';
import { Modal } from '../ui/overlays';
import { Field, Input, Money, Num, Row } from '../ui/primitives';

/** Cash drawer shift: always visible, one tap to open/close. */
export function ShiftPill() {
  const { t } = useT();
  const role = useAuth((s) => s.user?.role);
  const floor = useFloor();
  const [open, setOpen] = useState(false);
  const shift = floor.data?.shift ?? null;
  if (!can.shift(role) || !floor.data) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={clsx(
          'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
          shift ? 'border-st-free/30 bg-st-free/10 text-st-free hover:bg-st-free/15' : 'border-st-ending/40 bg-st-ending/10 text-st-ending hover:bg-st-ending/15',
        )}
      >
        <Wallet className="size-3.5" />
        <span className="hidden sm:inline">{shift ? t('shift.title') : t('shift.none')}</span>
        {shift && <Money value={shift.expectedCash} className="hidden lg:inline-flex" />}
      </button>
      <ShiftDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function ShiftDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useT();
  const f = useFmt();
  const floor = useFloor();
  const shift = floor.data?.shift ?? null;
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  const minor = parseMoney(amount || '0', f.decimals);

  const submitOpen = async () => {
    if (minor == null) return;
    const ok = await run(() => post('/api/shifts/open', { openingFloat: minor }), { success: t('shift.opened') });
    if (ok) {
      setAmount('');
      onOpenChange(false);
    }
  };
  const submitClose = async () => {
    if (minor == null) return;
    const ok = await run(() => post('/api/shifts/close', { countedCash: minor, note: note || null }), { success: t('shift.closed') });
    if (ok) {
      setAmount('');
      setNote('');
      onOpenChange(false);
    }
  };

  const variance = shift && minor != null && amount !== '' ? minor - shift.expectedCash : null;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={shift ? t('shift.close') : t('shift.open')}
      description={shift ? t('shift.openedBy', { name: shift.userName, time: f.time(new Date(shift.openedAt).getTime()) }) : t('shift.noneHint')}
      size="sm"
      footer={
        <Button variant="primary" size="lg" block loading={busy} disabled={minor == null || amount === ''} onClick={shift ? submitClose : submitOpen}>
          {shift ? t('shift.close') : t('shift.open')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {shift && (
          <div className="rounded-card bg-surface-2 p-4">
            <div className="mb-2 text-xs font-medium text-faint">{t('shift.byMethod')}</div>
            <Row label={<span className="flex items-center gap-2"><Banknote className="size-4" /> {t('checkout.cash')}</span>} value={<Money value={shift.byMethod.cash ?? 0} />} />
            <Row label={<span className="flex items-center gap-2"><CreditCard className="size-4" /> {t('checkout.card')}</span>} value={<Money value={shift.byMethod.card ?? 0} />} />
            <Row label={t('shift.float')} value={<Money value={shift.openingFloat} />} muted />
            <div className="my-2 h-px bg-line" />
            <Row label={t('shift.expected')} value={<Money value={shift.expectedCash} currency />} strong />
            <div className="mt-1 text-xs text-faint">
              <Num>{shift.transactions}</Num> {t('shift.transactions')}
            </div>
          </div>
        )}
        <Field label={shift ? t('shift.counted') : t('shift.float')} htmlFor="shift-amount">
          <Input
            id="shift-amount"
            inputMode="decimal"
            autoFocus
            className="num h-14 text-center text-2xl font-semibold"
            placeholder={f.money(0)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (shift ? submitClose() : submitOpen())}
          />
        </Field>
        {variance != null && (
          <div
            data-status={variance === 0 ? 'free' : variance < 0 ? 'overtime' : 'ending'}
            className="st-soft flex items-center justify-between rounded-card px-4 py-3 text-sm font-semibold"
          >
            <span>{variance === 0 ? t('shift.balanced') : variance < 0 ? t('shift.short') : t('shift.over')}</span>
            <Money value={Math.abs(variance)} currency />
          </div>
        )}
        {shift && (
          <Field label={t('common.note')} htmlFor="shift-note">
            <Input id="shift-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('common.optional')} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
