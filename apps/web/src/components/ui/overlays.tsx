import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { useT } from '../../i18n';

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra header content (badges, status) shown next to the title. */
  headerExtra?: ReactNode;
  children: ReactNode;
  /** Sticky bottom area: primary action goes last, full width (thumb reach). */
  footer?: ReactNode;
  className?: string;
}

/**
 * Side sheet docked at the inline-end (bottom sheet on phones). Used for station details
 * so the floor stays visible: context is never lost.
 */
export function Sheet({ open, onOpenChange, title, description, headerExtra, children, footer, className }: OverlayProps) {
  const { t } = useT();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content
          className={clsx(
            'anim-sheet fixed z-50 flex flex-col bg-surface-1 shadow-[var(--shadow-float)] focus:outline-none',
            'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-sheet border-t border-line',
            'md:inset-y-0 md:end-0 md:start-auto md:max-h-none md:w-[440px] md:rounded-none md:border-t-0 md:border-s',
            className,
          )}
          onOpenAutoFocus={focusDialogOrAutofocus}
          tabIndex={-1}
        >
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong md:hidden" aria-hidden />
          <header className="flex items-start gap-3 border-b border-line px-5 pb-4 pt-4 md:pt-5">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="flex flex-wrap items-center gap-2 text-xl font-semibold text-fg">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{typeof title === 'string' ? title : ''}</Dialog.Description>
              )}
            </div>
            {headerExtra}
            <Dialog.Close asChild>
              <button className="-me-2 rounded-control p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label={t('common.close')}>
                <X className="size-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="border-t border-line bg-surface-1 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Focus stays inside the dialog (keyboard users can Tab through it) without painting a focus ring
 * on the close button: an explicit `autoFocus` field wins, otherwise the dialog container.
 */
function focusDialogOrAutofocus(e: Event) {
  e.preventDefault();
  const root = e.currentTarget as HTMLElement;
  // React's autoFocus already focused a field inside: keep it.
  if (document.activeElement && document.activeElement !== root && root.contains(document.activeElement)) return;
  const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? root;
  target.focus({ preventScroll: true });
}

/** Centered dialog for focused tasks (checkout, forms, approvals). */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  size = 'md',
}: OverlayProps & { size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const { t } = useT();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={clsx(
            'anim-pop fixed inset-0 z-50 m-auto flex h-fit max-h-[94dvh] w-[calc(100vw-1.5rem)] flex-col rounded-sheet border border-line bg-surface-1 shadow-[var(--shadow-float)] focus:outline-none focus-visible:outline-none',
            size === 'sm' && 'max-w-sm',
            size === 'md' && 'max-w-lg',
            size === 'lg' && 'max-w-3xl',
            size === 'xl' && 'max-w-5xl',
            className,
          )}
          onOpenAutoFocus={focusDialogOrAutofocus}
          tabIndex={-1}
        >
          <header className="flex items-start gap-3 px-5 pb-3 pt-5">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold text-fg">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{typeof title === 'string' ? title : ''}</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button className="-me-2 -mt-1 rounded-control p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label={t('common.close')}>
                <X className="size-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
          {/* On a phone the footer actions span the width (thumb reach). */}
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4 max-sm:[&>*]:flex-1">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
