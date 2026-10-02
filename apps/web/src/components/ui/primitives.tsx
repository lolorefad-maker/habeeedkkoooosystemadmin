import { clsx } from 'clsx';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useFmt } from '../../lib/format';

/** Numbers, times and codes: tabular, isolated LTR so they never jump or reorder inside Arabic text. */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('num', className)}>{children}</span>;
}

export function Money({ value, currency, className }: { value: number; currency?: boolean; className?: string }) {
  const f = useFmt();
  return (
    <span className={clsx('inline-flex items-baseline gap-1', className)}>
      <span className="num">{f.money(value)}</span>
      {currency && <span className="text-[0.75em] font-normal text-muted">{f.currencyLabel}</span>}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="num rounded border border-line-strong bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-muted">{children}</kbd>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-muted">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

const inputCls =
  'h-11 w-full rounded-control border border-line bg-surface-3 px-3 text-fg placeholder:text-faint transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(inputCls, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx(inputCls, 'h-auto min-h-28 py-2.5 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={clsx(inputCls, 'appearance-none bg-no-repeat pe-9', className)} {...rest}>
      {children}
    </select>
  );
});

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={clsx('flex cursor-pointer items-start justify-between gap-4 py-1', disabled && 'opacity-50')}>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-fg">{label}</span>
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="h-6 w-11 rounded-full bg-surface-3 ring-1 ring-line-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent" />
        <span className="absolute top-0.5 start-0.5 size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5 rtl:peer-checked:-translate-x-5" />
      </span>
    </label>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    // Options share the row equally, never squeeze below their text: on a phone they wrap to a second row.
    <div role="radiogroup" aria-label={ariaLabel} className={clsx('flex flex-wrap gap-1 rounded-card bg-surface-3 p-1', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={clsx(
              'flex min-w-max flex-1 flex-col items-center justify-center whitespace-nowrap rounded-control px-3 font-medium transition-all duration-150 disabled:opacity-40',
              size === 'sm' ? 'h-8 text-xs' : size === 'lg' ? 'min-h-14 py-2 text-base' : 'min-h-10 py-1.5 text-sm',
              on ? 'bg-surface-1 text-fg shadow-sm ring-1 ring-line-strong' : 'text-muted hover:text-fg',
            )}
          >
            <span>{o.label}</span>
            {o.hint && <span className={clsx('text-[11px] font-normal', on ? 'text-muted' : 'text-faint')}>{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton rounded-card', className)} aria-hidden />;
}

export function EmptyState({ icon, title, action }: { icon?: ReactNode; title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-card border border-dashed border-line px-6 py-14 text-center">
      {icon && <div className="text-faint [&_svg]:size-10">{icon}</div>}
      <p className="max-w-sm text-muted">{title}</p>
      {action}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('rounded-card border border-line bg-surface-1 shadow-[var(--shadow-card)]', className)}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-wide text-muted">{children}</h2>
      {action}
    </div>
  );
}

/** Label/value row for bills and summaries. */
export function Row({ label, value, strong, muted, className }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean; className?: string }) {
  return (
    <div className={clsx('flex items-baseline justify-between gap-3 py-1', strong ? 'text-base font-semibold text-fg' : muted ? 'text-sm text-faint' : 'text-sm text-muted', className)}>
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0">{value}</span>
    </div>
  );
}
