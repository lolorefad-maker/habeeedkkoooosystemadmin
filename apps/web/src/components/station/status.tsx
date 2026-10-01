import { clsx } from 'clsx';
import { AlarmClock, CalendarClock, CircleCheck, Crown, Gamepad2, Glasses, Hourglass, Monitor, Pause, Wrench, type LucideIcon } from 'lucide-react';
import { useT } from '../../i18n';
import type { UiStatus } from '../../lib/live';

export const STATUS_ICON: Record<UiStatus, LucideIcon> = {
  free: CircleCheck,
  active: Gamepad2,
  ending: Hourglass,
  overtime: AlarmClock,
  paused: Pause,
  reserved: CalendarClock,
  off: Wrench,
};

export function TypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon = type === 'vr' ? Glasses : type === 'pc' ? Monitor : Gamepad2;
  return <Icon className={className} aria-hidden />;
}

/** Status is always icon + label + color (never color alone). */
export function StatusBadge({ status, className, label }: { status: UiStatus | 'unpaid'; className?: string; label?: string }) {
  const { t } = useT();
  const Icon = status === 'unpaid' ? Hourglass : STATUS_ICON[status];
  return (
    <span data-status={status} className={clsx('st-soft inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', className)}>
      <Icon className="size-3.5" aria-hidden />
      {label ?? t(`status.${status}`)}
    </span>
  );
}

/** `onFill`: sitting on a solid status-filled card, so it takes the card's text color instead of gold. */
export function VipBadge({ className, onFill }: { className?: string; onFill?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        onFill ? 'bg-on-fill/20 text-on-fill' : 'bg-vip/15 text-vip',
        className,
      )}
    >
      <Crown className="size-3" aria-hidden />
      VIP
    </span>
  );
}
