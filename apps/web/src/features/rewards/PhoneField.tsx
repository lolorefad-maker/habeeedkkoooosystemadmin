import { normalizePhone } from '@lounge/core';
import { Gift } from 'lucide-react';
import { Field, Input, Num } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { useFmt } from '../../lib/format';
import { useBranch, useCustomerLookup } from '../../lib/queries';

/**
 * The customer's WhatsApp number, with who it belongs to (and whether free time waits for them)
 * once it looks complete. Shared by opening a device and by the checkout.
 */
export function PhoneField({
  id,
  value,
  onChange,
  hint,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  autoFocus?: boolean;
}) {
  const { t } = useT();
  const f = useFmt();
  const branch = useBranch();
  const policy = branch?.settings.rewards;
  const normalized = normalizePhone(value, policy?.countryCode ?? '962');
  const bad = value.replace(/\D/g, '').length >= 7 && !normalized;
  const who = useCustomerLookup(value, !!normalized);

  return (
    <Field label={t('rewards.phone')} htmlFor={id} hint={hint} error={bad ? t('rewards.phoneBad') : undefined}>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        dir="ltr"
        autoFocus={autoFocus}
        className="num text-start"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('start.phonePh')}
        maxLength={30}
        aria-invalid={bad || undefined}
      />
      {normalized && who.data && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {who.data.name ? <span className="font-medium">{who.data.name}</span> : <span className="text-muted">{t('rewards.newNumber')}</span>}
          {who.data.available > 0 && policy && (
            <span data-status="free" className="tint inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold">
              <Gift className="size-3.5" aria-hidden />
              {t('rewards.waiting', { span: f.span(policy.freeMinutes * 60_000) })}
              {who.data.available > 1 && <Num>×{who.data.available}</Num>}
            </span>
          )}
        </div>
      )}
    </Field>
  );
}
