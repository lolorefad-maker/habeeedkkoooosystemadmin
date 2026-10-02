import { arabicDuration, fillMessage, whatsappUrl, type RewardPolicy } from '@lounge/core';

/**
 * The WhatsApp chat for a reward, with the owner's message filled in. The message belongs to the
 * customer, so it is always in the owner's words (Arabic by default), whatever language the screen is in.
 */
export function rewardWhatsappUrl(
  policy: RewardPolicy,
  shop: string,
  r: { name: string; phone: string; minutes: number; playedMinutes: number },
): string {
  const text = fillMessage(policy.message, {
    // A number first seen without a name is stored under the number itself.
    name: r.name === r.phone ? 'صديقنا' : r.name,
    shop,
    played: arabicDuration(r.playedMinutes),
    free: arabicDuration(r.minutes),
  });
  return whatsappUrl(r.phone, text);
}
