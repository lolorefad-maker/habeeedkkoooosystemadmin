import { Gift } from 'lucide-react';
import { Link } from 'react-router';
import { Num } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { useBranch, useRewards } from '../../lib/queries';

/** The floor's shortcut to the rewards list, with how many free hours are waiting to be used. */
export function RewardsLink() {
  const { t } = useT();
  const branch = useBranch();
  const waiting = useRewards('available').data?.length ?? 0;
  // Off and nothing left over: no reason to take room on the floor.
  if (!branch?.settings.rewards.enabled && waiting === 0) return null;
  return (
    <Link
      to="/rewards"
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-1 px-3.5 text-sm font-medium text-muted shadow-[var(--shadow-card)] hover:border-line-strong hover:text-fg"
    >
      <Gift className="size-4" />
      {t('nav.rewards')}
      {waiting > 0 && (
        <span data-status="free" className="st-soft grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-bold">
          <Num>{waiting}</Num>
        </span>
      )}
    </Link>
  );
}
