import { clsx } from 'clsx';
import { Bell, BellOff } from 'lucide-react';
import { usePrefs, useT } from '../../i18n';
import { playChime, unlockAudio, useAudio } from '../../lib/sound';

/**
 * Per-device alert sound: on at the cashier PC, muted on a waiter tablet.
 * When the browser still blocks audio, the bell shows an amber dot — one tap enables it.
 */
export function SoundToggle() {
  const { t } = useT();
  const sound = usePrefs((s) => s.sound);
  const setSound = usePrefs((s) => s.setSound);
  const audio = useAudio((s) => s.state);
  if (audio === 'unsupported') return null;
  const locked = sound && audio === 'locked';
  const label = !sound ? t('alerts.soundOff') : locked ? t('alerts.tapToEnable') : t('alerts.soundOn');

  const onClick = async () => {
    if (!sound || locked) {
      setSound(true);
      if (await unlockAudio()) playChime(); // audible confirmation it works
    } else {
      setSound(false);
    }
  };

  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={sound}
      className={clsx(
        'relative grid size-9 place-items-center rounded-full border transition-colors',
        sound ? 'border-line text-muted hover:text-fg' : 'border-line text-faint hover:text-muted',
      )}
    >
      {sound ? <Bell className="size-4" /> : <BellOff className="size-4" />}
      {/* Static dot: only a real overtime alarm is allowed to pulse in this UI. */}
      {locked && <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-st-ending" aria-hidden />}
    </button>
  );
}
