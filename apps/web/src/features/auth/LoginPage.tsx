import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowRight, Globe, KeyRound, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { LogoMark, Wordmark } from '../../components/shell/Brand';
import { Button } from '../../components/ui/button';
import { errorMessage } from '../../components/ui/feedback';
import { PinPad } from '../../components/ui/pinpad';
import { Input, Skeleton } from '../../components/ui/primitives';
import { usePrefs, useT } from '../../i18n';
import { ApiError, get, post } from '../../lib/api';
import { useAuth, type Role, type User } from '../../lib/auth';

interface StaffCard {
  id: string;
  name: string;
  role: Role;
}

/** First meaningful letter: skip the Arabic article "ال" so "الكاشير" → "ك", not "ا". */
const initial = (name: string) => {
  const n = name.trim();
  return (n.startsWith('ال') && n.length > 2 ? n.charAt(2) : n.charAt(0)).toUpperCase();
};

/** Tap your name, type your PIN. Fast shift changes at a shared counter device. */
export function LoginPage() {
  const { t, tk, lang } = useT();
  const navigate = useNavigate();
  const { user, deviceBranchId, login, setDeviceBranch, accessCode, setAccessCode } = useAuth();
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const setLang = usePrefs((s) => s.setLang);
  const [picked, setPicked] = useState<StaffCard | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const branches = useQuery({
    queryKey: ['auth-branches', accessCode],
    queryFn: () => get<{ id: string; name: string }[]>('/api/auth/branches'),
  });
  // Online installs: this device must know the shop code before the login screen is shown.
  const accessError =
    branches.error instanceof ApiError && branches.error.code.startsWith('access_code') ? branches.error.code : null;
  const branchId = deviceBranchId && branches.data?.some((b) => b.id === deviceBranchId) ? deviceBranchId : branches.data?.[0]?.id;
  const staff = useQuery({
    queryKey: ['auth-staff', branchId],
    queryFn: () => get<StaffCard[]>(`/api/auth/staff?branchId=${branchId}`),
    enabled: !!branchId,
  });

  if (user) return <Navigate to="/floor" replace />;
  if (accessError) {
    return <ShopCodeScreen invalid={accessError === 'access_code_invalid' && !!accessCode} onSubmit={setAccessCode} />;
  }

  const submit = async () => {
    if (!picked || !branchId || pin.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ token: string; user: User }>('/api/auth/login', { userId: picked.id, branchId, pin });
      login(res.token, res.user);
      navigate('/floor', { replace: true });
    } catch (err) {
      setPin('');
      // The shop code was changed by the owner: ask for the new one.
      if (err instanceof ApiError && err.code.startsWith('access_code')) {
        setAccessCode(null);
        return;
      }
      setError(err instanceof ApiError && err.status === 401 ? t('login.wrongPin') : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(60rem 30rem at 50% -10%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 70%), radial-gradient(40rem 24rem at 90% 110%, color-mix(in oklab, var(--accent-strong) 16%, transparent), transparent 70%)',
        }}
      />
      <div className="absolute end-4 top-4 flex gap-2">
        <Button variant="ghost" size="icon" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} aria-label={t('common.language')}>
          <Globe className="size-5" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={t('common.theme')}>
          {theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
        </Button>
      </div>

      <div className="relative w-full max-w-3xl">
        <div className="mb-10 flex flex-col items-center gap-3 text-center">
          <LogoMark size="lg" />
          <Wordmark className="text-3xl" />
          <h1 className="mt-2 text-xl font-semibold tracking-tight">{picked ? picked.name : t('login.title')}</h1>
          {branches.data && branches.data.length > 1 && !picked && (
            <select
              className="rounded-control border border-line bg-surface-2 px-3 py-1.5 text-base sm:text-sm"
              value={branchId}
              onChange={(e) => setDeviceBranch(e.target.value)}
              aria-label={t('login.branch')}
            >
              {branches.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          {branches.data?.length === 1 && !picked && branches.data[0]!.name.trim().toLowerCase() !== t('app.name').toLowerCase() && (
            <p className="text-sm text-muted">{branches.data[0]!.name}</p>
          )}
          {picked && <p className="text-sm text-muted">{t('login.enterPin')}</p>}
        </div>

        {!picked ? (
          <div className="mx-auto grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {(staff.isLoading || branches.isLoading) &&
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36" />)}
            {staff.data?.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setPicked(s);
                  setPin('');
                  setError(null);
                }}
                className="group flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface-1/80 p-5 backdrop-blur transition-all hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface-2 hover:shadow-[var(--shadow-float)]"
              >
                <span
                  className={clsx(
                    'grid size-16 place-items-center rounded-full text-2xl font-bold',
                    // The owner stands out in brand red; everyone else is black with a red ring.
                    s.role === 'owner' ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-fg ring-2 ring-accent/50',
                  )}
                >
                  {initial(s.name)}
                </span>
                <span className="flex flex-col items-center">
                  <span className="font-semibold">{s.name}</span>
                  <span className="text-xs text-muted">{tk('roles', s.role)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mx-auto flex max-w-xs flex-col items-center gap-6">
            <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onSubmit={submit} error={!!error} busy={busy} label={t('login.enterPin')} />
            <p className={clsx('h-5 text-sm', error ? 'text-danger' : 'text-transparent')} role="alert">
              {error ?? '.'}
            </p>
            <Button variant="ghost" onClick={() => setPicked(null)} icon={<ArrowRight className="size-4 ltr:rotate-180" />}>
              {t('common.back')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Asked once per device on an online install; the code is then remembered on this device. */
function ShopCodeScreen({ invalid, onSubmit }: { invalid: boolean; onSubmit: (code: string) => void }) {
  const { t } = useT();
  const [code, setCode] = useState('');
  const submit = () => code.trim() && onSubmit(code.trim());
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <form
        className="flex w-full max-w-sm flex-col items-center gap-5 rounded-sheet border border-line bg-surface-1 p-6 text-center shadow-[var(--shadow-float)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
          <KeyRound className="size-7" />
        </span>
        <div>
          <h1 className="text-xl font-bold">{t('login.shopCode')}</h1>
          <p className="mt-1 text-sm text-muted">{t('login.shopCodeHint')}</p>
        </div>
        <Input
          autoFocus
          type="password"
          autoComplete="off"
          dir="ltr"
          className="h-12 text-center text-lg tracking-widest"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label={t('login.shopCode')}
          aria-invalid={invalid}
        />
        <p className={clsx('h-5 text-sm', invalid ? 'text-danger' : 'text-transparent')} role="alert">
          {invalid ? t('errors.access_code_invalid') : '.'}
        </p>
        <Button type="submit" variant="primary" size="lg" block disabled={!code.trim()}>
          {t('login.continue')}
        </Button>
      </form>
    </div>
  );
}
