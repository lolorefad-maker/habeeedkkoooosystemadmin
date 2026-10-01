import { clsx } from 'clsx';
import { useT } from '../../i18n';

/** The shop's mark: a red tile with a controller. Used in the side bar, the phone header and the login screen. */
export function LogoMark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <div
      className={clsx(
        'grid shrink-0 place-items-center bg-gradient-to-br from-accent to-accent-strong text-accent-fg',
        size === 'lg' ? 'size-16 rounded-2xl shadow-[0_12px_44px_-10px_var(--accent)]' : 'size-9 rounded-xl shadow-[0_6px_20px_-6px_var(--accent)]',
      )}
    >
      <svg viewBox="0 0 24 24" className={size === 'lg' ? 'size-8' : 'size-5'} fill="currentColor" aria-hidden>
        <path d="M7 8h10a4 4 0 0 1 4 4v1.5a2.5 2.5 0 0 1-4.4 1.6L15.5 14h-7l-1.1 1.1A2.5 2.5 0 0 1 3 13.5V12a4 4 0 0 1 4-4Zm0 2.5a.9.9 0 0 0-.9.9v.6h-.6a.9.9 0 0 0 0 1.8h.6v.6a.9.9 0 0 0 1.8 0v-.6h.6a.9.9 0 0 0 0-1.8h-.6v-.6a.9.9 0 0 0-.9-.9Zm9.5.3a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
      </svg>
    </div>
  );
}

/** "HABEEDKO" wordmark. Latin brand name, so it is isolated and never mirrored. */
export function Wordmark({ className }: { className?: string }) {
  const { t } = useT();
  return (
    <bdi dir="ltr" className={clsx('font-extrabold uppercase tracking-[0.14em]', className)}>
      {t('app.name')}
    </bdi>
  );
}
