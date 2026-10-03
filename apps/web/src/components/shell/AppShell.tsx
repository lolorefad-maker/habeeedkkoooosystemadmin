import { clsx } from 'clsx';
import {
  BarChart3,
  BatteryFull,
  Boxes,
  Gift,
  Contact,
  Coffee,
  CalendarDays,
  Gamepad,
  Globe,
  LayoutGrid,
  Lock,
  LogOut,
  Moon,
  Settings,
  Sun,
  UserRound,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { usePrefs, useT, type TKey } from '../../i18n';
import { can, useAuth, type Role } from '../../lib/auth';
import { useClockTicker, useNow } from '../../lib/clock';
import { useFmt } from '../../lib/format';
import { useFloor } from '../../lib/queries';
import { useTimeAlerts } from '../../lib/alerts';
import { onLiveEvent, useConn, useRealtime } from '../../lib/realtime';
import { installAudioUnlock } from '../../lib/sound';
import { useStockWarnings } from '../../features/cafe/products';
import { Num } from '../ui/primitives';
import { LogoMark, Wordmark } from './Brand';
import { ShiftPill } from './ShiftPill';
import { SoundToggle } from './SoundToggle';

interface NavItem {
  to: string;
  label: TKey;
  icon: LucideIcon;
  allow?: (r?: Role) => boolean;
  mobile?: boolean;
}

const NAV: NavItem[] = [
  { to: '/floor', label: 'nav.floor', icon: LayoutGrid, mobile: true },
  { to: '/cafe', label: 'nav.cafe', icon: Coffee, allow: can.checkout, mobile: true },
  { to: '/controllers', label: 'nav.controllers', icon: Gamepad, mobile: true },
  { to: '/reservations', label: 'nav.reservations', icon: CalendarDays, allow: can.reservations, mobile: true },
  { to: '/stock', label: 'nav.stock', icon: Boxes, allow: can.stock, mobile: true },
  { to: '/customers', label: 'nav.customers', icon: Contact, allow: can.checkout },
  { to: '/rewards', label: 'nav.rewards', icon: Gift, allow: can.checkout },
  { to: '/reports', label: 'nav.reports', icon: BarChart3, allow: can.reports, mobile: true },
  { to: '/settings', label: 'nav.settings', icon: Settings, allow: can.settings, mobile: true },
];

export function AppShell() {
  useRealtime();
  useClockTicker();
  useControllerToasts();
  useTimeAlerts();
  useStockWarnings();
  useEffect(() => installAudioUnlock(), []);
  const { t } = useT();
  const user = useAuth((s) => s.user);
  const floor = useFloor();
  const conn = useConn((s) => s.status);
  const items = NAV.filter((n) => !n.allow || n.allow(user?.role));
  const mobileCount = items.filter((n) => n.mobile).length;

  return (
    <div className="flex h-full min-h-0">
      {/* Side navigation: icon rail on tablets, labels on wide screens */}
      <aside className="no-print hidden shrink-0 flex-col border-e border-line bg-surface-1 md:flex md:w-[84px] xl:w-[216px]">
        <div className="flex h-16 items-center gap-2.5 px-4 xl:px-5">
          <LogoMark />
          <Wordmark className="hidden text-base xl:inline" />
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-2.5 py-2 xl:px-3">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                clsx(
                  'group flex flex-col items-center gap-1 rounded-card px-2 py-2.5 text-[11px] font-medium transition-colors xl:flex-row xl:gap-3 xl:px-3 xl:text-sm',
                  isActive ? 'bg-accent text-accent-fg shadow-[0_6px_16px_-8px_var(--accent)]' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              <n.icon className="size-5 shrink-0" aria-hidden />
              <span className="truncate">{t(n.label)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="p-3 text-center text-[10px] text-faint xl:text-start">v0.1</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface-1/80 px-4 backdrop-blur md:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="md:hidden">
              <LogoMark />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{floor.data?.branch.name ?? '…'}</div>
              {floor.data && <BusinessDay day={floor.data.day} />}
            </div>
          </div>
          <ShiftPill />
          <SoundToggle />
          <ConnectionDot status={conn} />
          <HeaderClock />
          <UserMenu />
        </header>

        {conn === 'offline' && (
          <div role="alert" className="no-print flex items-center gap-2 bg-danger/12 px-4 py-2 text-sm font-medium text-danger md:px-6">
            <WifiOff className="size-4" />
            {t('conn.offline')}
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto pb-20 md:pb-0">
          <Outlet />
        </main>

        {/* Bottom tabs on phones */}
        <nav className="no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface-1/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          {items
            .filter((n) => n.mobile)
            .map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  clsx(
                    'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-0.5 font-medium',
                    mobileCount > 5 ? 'text-[10px]' : 'text-[11px]',
                    isActive ? 'text-accent' : 'text-muted',
                  )
                }
              >
                <n.icon className="size-5 shrink-0" aria-hidden />
                <span className="max-w-full truncate">{t(n.label)}</span>
              </NavLink>
            ))}
        </nav>
      </div>
    </div>
  );
}

/** "Controller 3 is charged" pops up on every device when its charge time ends. */
function useControllerToasts() {
  const { t } = useT();
  useEffect(
    () =>
      onLiveEvent((e) => {
        if (e.type === 'controller.charged' && typeof e.payload?.number === 'number') {
          toast.success(t('controllers.chargedToast', { n: e.payload.number }), { icon: <BatteryFull className="size-4" /> });
        }
      }),
    [t],
  );
}

function BusinessDay({ day }: { day: string }) {
  const f = useFmt();
  const { t } = useT();
  const d = new Date(`${day}T12:00:00Z`).getTime();
  return (
    <div className="truncate text-xs text-faint">
      {t('reports.day')}: {f.date(d)}
    </div>
  );
}

function ConnectionDot({ status }: { status: 'online' | 'reconnecting' | 'offline' }) {
  const { t } = useT();
  const label = status === 'online' ? t('conn.online') : status === 'reconnecting' ? t('conn.reconnecting') : t('conn.offline');
  return (
    <span className="hidden items-center gap-2 text-xs text-muted sm:flex" title={label} aria-label={label} role="status">
      <span
        className={clsx(
          'size-2.5 rounded-full',
          status === 'online' && 'bg-st-free shadow-[0_0_0_3px_color-mix(in_oklab,var(--st-free)_25%,transparent)]',
          status === 'reconnecting' && 'animate-pulse bg-st-ending',
          status === 'offline' && 'bg-danger',
        )}
      />
    </span>
  );
}

function HeaderClock() {
  const now = useNow();
  const f = useFmt();
  return <Num className="hidden text-sm font-medium text-muted lg:inline">{f.time(now)}</Num>;
}

function UserMenu() {
  const { t, lang } = useT();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const setLang = usePrefs((s) => s.setLang);
  const navigate = useNavigate();
  const itemCls = 'flex cursor-pointer items-center gap-3 rounded-control px-3 py-2.5 text-sm outline-none data-[highlighted]:bg-surface-2';

  return (
    <DropdownMenu.Root dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <DropdownMenu.Trigger asChild>
        <button className="flex items-center gap-2 rounded-full border border-line bg-surface-2 py-1 pe-3 ps-1 text-sm hover:border-line-strong">
          <span className="grid size-7 place-items-center rounded-full bg-accent/15 text-accent">
            <UserRound className="size-4" />
          </span>
          <span className="hidden max-w-28 truncate font-medium sm:inline">{user?.name}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="anim-pop z-50 min-w-56 rounded-card border border-line bg-surface-1 p-1.5 shadow-[var(--shadow-float)]"
        >
          <div className="px-3 py-2">
            <div className="font-semibold">{user?.name}</div>
            <div className="text-xs text-muted">{user && t(`roles.${user.role}`)}</div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {can.reports(user?.role) && (
            <DropdownMenu.Item className={clsx(itemCls, 'md:hidden')} onSelect={() => navigate('/reports')}>
              <BarChart3 className="size-4 text-muted" /> {t('nav.reports')}
            </DropdownMenu.Item>
          )}
          {can.settings(user?.role) && (
            <DropdownMenu.Item className={clsx(itemCls, 'md:hidden')} onSelect={() => navigate('/settings')}>
              <Settings className="size-4 text-muted" /> {t('nav.settings')}
            </DropdownMenu.Item>
          )}
          {can.isManager(user?.role) && (
            <DropdownMenu.Item className={itemCls} onSelect={() => navigate('/reports?tab=daily&end=1')}>
              <Lock className="size-4 text-muted" /> {t('endDay.button')}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className={itemCls} onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun className="size-4 text-muted" /> : <Moon className="size-4 text-muted" />}
            {theme === 'dark' ? t('common.light') : t('common.dark')}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={itemCls} onSelect={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
            <Globe className="size-4 text-muted" />
            {lang === 'ar' ? 'English' : 'العربية'}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item
            className={clsx(itemCls, 'text-danger')}
            onSelect={() => {
              logout();
              navigate('/login');
            }}
          >
            <LogOut className="size-4" /> {t('login.switchUser')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
