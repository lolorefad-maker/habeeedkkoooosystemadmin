import { ShieldCheck } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { translate, usePrefs, useT } from '../../i18n';
import { ApiError } from '../../lib/api';
import { Modal } from './overlays';
import { PinPad } from './pinpad';

/** Translate any thrown error into a message a cashier understands. */
export function errorMessage(err: unknown): string {
  const lang = usePrefs.getState().lang;
  if (err instanceof ApiError) {
    const msg = translate(lang, `errors.${err.code}`);
    return msg === `errors.${err.code}` ? err.message || translate(lang, 'errors.unknown') : msg;
  }
  return translate(lang, 'errors.unknown');
}

export function toastError(err: unknown) {
  toast.error(errorMessage(err));
}

// ------------------------------------------------------------------ manager approval

interface ApprovalState {
  open: boolean;
  what: string;
  resolve: ((pin: string | null) => void) | null;
  error: boolean;
  ask: (what: string, error?: boolean) => Promise<string | null>;
  finish: (pin: string | null) => void;
}

const useApprovalStore = create<ApprovalState>((set, get) => ({
  open: false,
  what: '',
  resolve: null,
  error: false,
  ask: (what, error = false) =>
    new Promise((resolve) => {
      set({ open: true, what, resolve, error });
    }),
  finish: (pin) => {
    get().resolve?.(pin);
    set({ open: false, resolve: null });
  },
}));

/**
 * Run a server action; if the server answers "approval_required", ask for a manager PIN
 * and retry with it. Wrong PIN → ask again. The server is the one that decides.
 */
export async function withApproval<T>(fn: (pin?: string) => Promise<T>, what = ''): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'approval_required') throw err;
  }
  let error = false;
  for (;;) {
    const pin = await useApprovalStore.getState().ask(what, error);
    if (!pin) throw new ApiError(0, 'cancelled');
    try {
      return await fn(pin);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'approval_invalid') {
        error = true;
        continue;
      }
      throw err;
    }
  }
}

export function ApprovalDialog() {
  const { t } = useT();
  const { open, what, error, finish } = useApprovalStore();
  const [pin, setPin] = useState('');
  const close = useCallback(
    (value: string | null) => {
      setPin('');
      finish(value);
    },
    [finish],
  );
  return (
    <Modal open={open} onOpenChange={(o) => !o && close(null)} title={t('approval.title')} size="sm">
      <div className="flex flex-col items-center gap-5 pt-2">
        <div className="flex items-center gap-3 rounded-card bg-surface-2 p-3 text-sm text-muted">
          <ShieldCheck className="size-5 shrink-0 text-accent" />
          <span>
            {t('approval.desc')} {what && <strong className="text-fg">{what}</strong>}
          </span>
        </div>
        {error && <p className="text-sm text-danger">{t('errors.approval_invalid')}</p>}
        {open && <PinPad value={pin} onChange={setPin} onSubmit={() => close(pin)} error={error && !pin} label={t('approval.pin')} />}
      </div>
    </Modal>
  );
}

/** Wrap a mutation with busy state, approval handling and error toasts. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: (pin?: string) => Promise<T>, opts: { what?: string; success?: string } = {}) => {
    setBusy(true);
    try {
      const result = await withApproval(fn, opts.what);
      if (opts.success) toast.success(opts.success);
      return result;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) toastError(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
