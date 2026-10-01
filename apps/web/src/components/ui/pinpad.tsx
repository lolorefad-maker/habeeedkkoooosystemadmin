import { clsx } from 'clsx';
import { Check, Delete } from 'lucide-react';
import { useEffect } from 'react';

/**
 * On-screen PIN pad (56px keys) that also accepts a physical keyboard.
 * Digits are shown as dots; Enter submits, Backspace deletes.
 */
export function PinPad({
  value,
  onChange,
  onSubmit,
  maxLength = 8,
  minLength = 4,
  error,
  busy,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  maxLength?: number;
  minLength?: number;
  error?: boolean;
  busy?: boolean;
  label?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (/^[0-9]$/.test(e.key) && value.length < maxLength) onChange(value + e.key);
      else if (e.key === 'Backspace') onChange(value.slice(0, -1));
      else if (e.key === 'Enter' && value.length >= minLength) onSubmit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [value, onChange, onSubmit, maxLength, minLength, busy]);

  const press = (d: string) => value.length < maxLength && onChange(value + d);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

  return (
    <div className="flex flex-col items-center gap-6" aria-label={label}>
      <div className={clsx('flex h-6 items-center gap-3', error && 'animate-[pop-in_200ms]')} dir="ltr" aria-live="polite">
        {Array.from({ length: Math.max(minLength, value.length) }).map((_, i) => (
          <span
            key={i}
            className={clsx(
              'size-3.5 rounded-full transition-all duration-150',
              i < value.length ? (error ? 'bg-danger' : 'scale-110 bg-accent') : 'bg-surface-3 ring-1 ring-line-strong',
            )}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3" dir="ltr">
        {keys.map((k) => (
          <PadKey key={k} onClick={() => press(k)} disabled={busy}>
            {k}
          </PadKey>
        ))}
        <PadKey onClick={() => onChange(value.slice(0, -1))} disabled={busy || !value} aria-label="Delete">
          <Delete className="size-6" />
        </PadKey>
        <PadKey onClick={() => press('0')} disabled={busy}>
          0
        </PadKey>
        <PadKey onClick={onSubmit} disabled={busy || value.length < minLength} primary aria-label="OK">
          <Check className="size-6" />
        </PadKey>
      </div>
    </div>
  );
}

function PadKey({ children, primary, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      className={clsx(
        'num flex size-[4.25rem] items-center justify-center rounded-2xl text-2xl font-medium transition-all duration-100 active:scale-95 disabled:opacity-35',
        primary ? 'bg-accent text-accent-fg hover:bg-accent-strong' : 'bg-surface-3 text-fg ring-1 ring-line hover:bg-surface-2',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
