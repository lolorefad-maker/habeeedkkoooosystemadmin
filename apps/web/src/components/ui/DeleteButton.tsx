import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import { Button } from './button';
import { useAction } from './feedback';
import { Modal } from './overlays';

/**
 * "Delete" inside an edit window. It asks first — saying what disappears and what stays — then
 * deletes and closes. The server refuses anything that would lose money or history, with a plain
 * reason (e.g. "end the session on this station first").
 */
export function DeleteButton({
  label,
  confirmTitle,
  body,
  path,
  onDeleted,
  className,
}: {
  label: string;
  confirmTitle: string;
  body: ReactNode;
  /** The API path answering DELETE. */
  path: string;
  onDeleted: () => void;
  className?: string;
}) {
  const { t } = useT();
  const { busy, run } = useAction();
  const [asking, setAsking] = useState(false);

  const confirm = async () => {
    const ok = await run(() => api('DELETE', path), { success: t('common.deleted') });
    setAsking(false);
    if (ok) onDeleted();
  };

  return (
    <>
      <Button variant="danger" size="lg" className={className} icon={<Trash2 className="size-4" />} onClick={() => setAsking(true)}>
        {label}
      </Button>
      <Modal
        open={asking}
        onOpenChange={setAsking}
        title={confirmTitle}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="lg" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" size="lg" loading={busy} icon={<Trash2 className="size-4" />} onClick={confirm}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">{body}</p>
      </Modal>
    </>
  );
}
