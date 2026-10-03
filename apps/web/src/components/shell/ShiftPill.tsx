import { parseMoney } from '@lounge/core';
import { clsx } from 'clsx';
import { Banknote, CreditCard, Wallet } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { can, useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/format';
import { useFloor } from '../../lib/queries';
import { Button } from '../ui/button';
import { useAction } from '../ui/feedback';
import { Modal } from '../ui/overlays';
import { Field, Input, Money, Num, Row } from '../ui/primitives';
import { autoFocusField } from '../../lib/viewport';

/** Cash drawer shift: always visible, one tap to open/close. */
export function ShiftPill() {
  const { t } = useT();
  const role = useAuth((s) => s.user?.role);
  const floor = useFloor();
  const [open, setOpen] = useState(false);
  const shift = floor.data?.shift ?? null;
  const uncounted = floor.data?.uncountedShifts ?? [];
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
        {/* A drawer closed at midnight still waits to be counted. */}
        {uncounted.length > 0 && <span className="size-2 rounded-full bg-st-ending" aria-label={t('shift.oldUncountedShort')} />}
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
  // Devices still playing when the shift is closed are paid on the next day, whole.
  const running = (floor.data?.sessions ?? []).filter((s) => s.status === 'running').length;

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
        {(floor.data?.uncountedShifts ?? []).map((s) => (
          <CountOldShift key={s.id} s={s} />
        ))}
        {shift && (
          <div data-status="ending" className="tint rounded-card border p-3 text-sm">
            <div className="font-semibold">{t('shift.endsDay')}</div>
            {running > 0 && <div className="mt-1 text-xs text-muted">{t('shift.runningWarn', { n: running })}</div>}
          </div>
        )}
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
            autoFocus={autoFocusField()}
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

/**
 * Count, afterwards, the drawer of a shift that closed by itself at the day's end (midnight): its
 * cash stayed its own when the new shift started from zero. Once saved, the ledger shows the result.
 */
export function CountOldShift({ s, onDone }: { s: { id: string; userName: string; expectedCash: number | null; closedAt: number | null }; onDone?: () => void }) {
  const { t } = useT();
  const f = useFmt();
  const { busy, run } = useAction();
  const [amount, setAmount] = useState('');
  const fieldId = useId();
  const minor = amount.trim() ? parseMoney(amount, f.decimals) : null;
  const expected = s.expectedCash ?? 0;
  const variance = minor != null ? minor - expected : null;

  const save = async () => {
    if (minor == null) return;
    const ok = await run(() => post(`/api/shifts/${s.id}/count`, { countedCash: minor }), { success: t('shift.countSaved') });
    if (ok) {
      setAmount('');
      onDone?.();
    }
  };

  return (
    <div data-status="ending" className="tint flex flex-col gap-2.5 rounded-card border p-3.5">
      <div className="text-sm font-semibold">{t('shift.oldUncounted', { name: s.userName, time: s.closedAt ? f.time(s.closedAt) : '…' })}</div>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{t('shift.expected')}</span>
        <Money value={expected} currency className="font-semibold text-fg" />
      </div>
      <div className="flex gap-2">
        <Input
          id={fieldId}
          inputMode="decimal"
          aria-label={t('shift.counted')}
          className="num text-center text-lg"
          placeholder={f.money(expected)}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Button variant="primary" className="shrink-0" loading={busy} disabled={minor == null} onClick={save}>
          {t('shift.countSave')}
        </Button>
      </div>
      {variance != null && (
        <div data-status={variance === 0 ? 'free' : variance < 0 ? 'overtime' : 'ending'} className="st-soft flex items-center justify-between rounded-control px-3 py-2 text-sm font-semibold">
          <span>{variance === 0 ? t('shift.balanced') : variance < 0 ? t('shift.short') : t('shift.over')}</span>
          <Money value={Math.abs(variance)} currency />
        </div>
      )}
    </div>
  );
}
