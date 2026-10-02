import { clsx } from 'clsx';
import { Ban, CircleCheck, Gift } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useAction } from '../../components/ui/feedback';
import { Modal } from '../../components/ui/overlays';
import { Card, EmptyState, Input, Num, Segmented, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { can, useAuth } from '../../lib/auth';
import { useFmt } from '../../lib/format';
import { useBranch, useRewards } from '../../lib/queries';
import type { Reward } from '../../lib/types';
import { WhatsAppButton } from './WhatsAppButton';

type Filter = 'available' | 'used' | 'all';

/**
 * Customer rewards: who earned free time (a session of more than the policy's hours, registered with
 * a number), whether they were told on WhatsApp, and whether they used it. The owner voids a mistake.
 */
export function RewardsPage() {
  const { t } = useT();
  const f = useFmt();
  const role = useAuth((s) => s.user?.role);
  const branch = useBranch();
  const list = useRewards('all');
  const [filter, setFilter] = useState<Filter>('available');
  const [voiding, setVoiding] = useState<Reward | null>(null);

  const rows = list.data ?? [];
  const counts = useMemo(
    () => ({ available: rows.filter((r) => r.status === 'available').length, used: rows.filter((r) => r.status === 'used').length, all: rows.length }),
    [rows],
  );
  const shown = rows.filter((r) => filter === 'all' || r.status === filter);
  const policy = branch?.settings.rewards;
  const vars = policy ? { after: f.span(policy.afterMinutes * 60_000), free: f.span(policy.freeMinutes * 60_000) } : { after: '', free: '' };

  if (list.isLoading || !branch) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
        <Skeleton className="h-20" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold">{t('rewards.title')}</h1>
        <p className="text-sm text-muted">{t('rewards.hint', vars)}</p>
      </div>

      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'available', label: <span className="flex items-center gap-1.5">{t('rewards.available')} <Num className="text-xs opacity-70">{counts.available}</Num></span> },
          { value: 'used', label: <span className="flex items-center gap-1.5">{t('rewards.used')} <Num className="text-xs opacity-70">{counts.used}</Num></span> },
          { value: 'all', label: t('rewards.all') },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState icon={<Gift />} title={t('rewards.empty', vars)} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Gift />} title={t('rewards.emptyAvailable')} action={<Button onClick={() => setFilter('all')}>{t('rewards.all')}</Button>} />
      ) : (
        <Card className="divide-y divide-line">
          {shown.map((r) => (
            <RewardRow key={r.id} r={r} canVoid={can.settings(role)} onVoid={() => setVoiding(r)} />
          ))}
        </Card>
      )}

      {voiding && <VoidModal reward={voiding} onClose={() => setVoiding(null)} />}
    </div>
  );
}

function RewardRow({ r, canVoid, onVoid }: { r: Reward; canVoid: boolean; onVoid: () => void }) {
  const { t } = useT();
  const f = useFmt();
  const open = r.status === 'available';
  const status = r.status === 'available' ? 'free' : r.status === 'used' ? 'active' : 'off';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
      <span data-status={status} className="tint grid size-10 shrink-0 place-items-center rounded-full border">
        {r.status === 'void' ? <Ban className="st-fg size-5" aria-hidden /> : r.status === 'used' ? <CircleCheck className="st-fg size-5" aria-hidden /> : <Gift className="st-fg size-5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate font-semibold">{r.name === r.phone ? '—' : r.name}</span>
          <Num className="text-sm text-muted">+{r.phone}</Num>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="font-medium text-fg">{t('rewards.freeAmount', { span: f.span(r.minutes * 60_000) })}</span>
          <span>· {t('rewards.played', { span: f.span(r.playedMinutes * 60_000) })}</span>
          <span>· {t('rewards.earnedOn', { day: r.earnedDay })}</span>
        </div>
        <div className={clsx('mt-0.5 text-xs', open && !r.notifiedAt ? 'font-medium text-st-ending' : 'text-faint')}>
          {r.status === 'used' && r.usedAt
            ? t('rewards.usedAt', { time: f.dateTime(r.usedAt) })
            : r.status === 'void'
              ? t('rewards.voidedWhy', { reason: r.voidReason ?? '' })
              : r.notifiedAt
                ? t('rewards.sentAt', { time: f.dateTime(r.notifiedAt) })
                : t('rewards.notSent')}
        </div>
      </div>
      {open && (
        <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
          <WhatsAppButton reward={r} again={!!r.notifiedAt} variant={r.notifiedAt ? 'outline' : 'success'} block />
          {canVoid && (
            <Button variant="ghost" onClick={onVoid} className="shrink-0">
              {t('rewards.void')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function VoidModal({ reward, onClose }: { reward: Reward; onClose: () => void }) {
  const { t } = useT();
  const { busy, run } = useAction();
  const [reason, setReason] = useState('');
  const confirm = async () => {
    const ok = await run(() => post(`/api/rewards/${reward.id}/void`, { reason: reason.trim() }), { success: t('rewards.voidDone') });
    if (ok) onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('rewards.voidTitle')}
      description={`${reward.name === reward.phone ? '' : `${reward.name} · `}+${reward.phone}`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" size="lg" loading={busy} disabled={reason.trim().length < 3} onClick={confirm}>
            {t('rewards.voidConfirm')}
          </Button>
        </>
      }
    >
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('rewards.voidWhy')} aria-label={t('rewards.voidWhy')} maxLength={200} />
    </Modal>
  );
}
