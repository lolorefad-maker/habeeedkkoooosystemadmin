import { History, ShieldCheck } from 'lucide-react';
import { Card, EmptyState, Num, Skeleton } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { useFmt } from '../../lib/format';
import { useAudit } from '../../lib/queries';

/** Who did what, when, approved by whom, and why. Append-only on the server. */
export function AuditTab() {
  const { t, tk } = useT();
  const f = useFmt();
  const audit = useAudit();
  if (audit.isLoading) return <Skeleton className="h-96" />;
  const list = audit.data ?? [];
  if (list.length === 0) return <EmptyState icon={<History />} title={t('settings.auditEmpty')} />;

  return (
    <Card className="divide-y divide-line">
      {list.map((e) => (
        <div key={e.id} className="flex items-start gap-3 px-4 py-3 text-sm">
          <Num className="w-24 shrink-0 text-xs text-faint">{f.dateTime(e.createdAt)}</Num>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{tk('events', e.type, e.type)}</div>
            <div className="text-xs text-muted">
              {e.actorName ?? t('common.system')}
              {e.approverName && (
                <span className="ms-2 inline-flex items-center gap-1 text-accent">
                  <ShieldCheck className="size-3" /> {e.approverName}
                </span>
              )}
              {e.reason && <span className="ms-2 text-faint">“{e.reason}”</span>}
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
}
