import { MessageCircle } from 'lucide-react';
import { buttonClass } from '../../components/ui/button';
import { useT } from '../../i18n';
import { post } from '../../lib/api';
import { useBranch } from '../../lib/queries';
import { rewardWhatsappUrl } from '../../lib/rewards';

/**
 * Opens WhatsApp on the customer's number with the owner's message ready; the cashier only presses
 * send. Nothing is sent by the system — opening the chat is recorded so the list shows who was told.
 */
export function WhatsAppButton({
  reward,
  again,
  size = 'md',
  block,
  variant = 'success',
}: {
  reward: { id: string; name: string; phone: string; minutes: number; playedMinutes: number };
  again?: boolean;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  variant?: 'success' | 'outline';
}) {
  const { t } = useT();
  const branch = useBranch();
  if (!branch) return null;
  return (
    <a
      href={rewardWhatsappUrl(branch.settings.rewards, branch.name, reward)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => void post(`/api/rewards/${reward.id}/notified`, {}).catch(() => undefined)}
      className={buttonClass({ variant, size, block, className: size === 'sm' ? 'gap-1.5' : 'gap-2' })}
    >
      <MessageCircle className="size-4" aria-hidden />
      {again ? t('rewards.resend') : t('rewards.whatsapp')}
    </a>
  );
}
