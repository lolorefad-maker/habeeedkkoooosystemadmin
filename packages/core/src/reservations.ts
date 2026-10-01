import type { Minor } from './money';
import type { ReservationPolicy } from './policies';
import { MINUTE } from './time';

export type ReservationStatus = 'confirmed' | 'checked_in' | 'cancelled' | 'no_show' | 'completed';

export interface ReservationLike {
  startAt: number;
  minutes: number;
  deposit: Minor;
  status: ReservationStatus;
}

export interface CancellationOutcome {
  late: boolean;
  fee: Minor;
  refund: Minor;
}

/** What cancelling now costs the customer, per the branch policy. */
export function evaluateCancellation(r: ReservationLike, now: number, policy: ReservationPolicy): CancellationOutcome {
  const late = r.startAt - now < policy.freeCancelMinutes * MINUTE;
  let fee = 0;
  if (late) {
    fee =
      policy.lateCancelFeeKind === 'fixed'
        ? policy.lateCancelFeeValue
        : Math.round((r.deposit * Math.min(100, policy.lateCancelFeeValue)) / 100);
  }
  // A fee is only ever taken out of the deposit; we never bill a customer who is not here.
  fee = Math.min(fee, r.deposit);
  return { late, fee, refund: r.deposit - fee };
}

export function isNoShow(r: ReservationLike, now: number, policy: ReservationPolicy): boolean {
  return r.status === 'confirmed' && now >= r.startAt + policy.noShowGraceMinutes * MINUTE;
}

export function noShowOutcome(r: ReservationLike, policy: ReservationPolicy): CancellationOutcome {
  const fee = policy.noShowForfeitDeposit ? r.deposit : 0;
  return { late: true, fee, refund: r.deposit - fee };
}

/** Is the station held for this reservation at `now` (from hold window until start + grace)? */
export function isHolding(r: ReservationLike, now: number, policy: ReservationPolicy): boolean {
  if (r.status !== 'confirmed') return false;
  return now >= r.startAt - policy.holdMinutesBefore * MINUTE && now < r.startAt + policy.noShowGraceMinutes * MINUTE;
}

export function overlaps(aStart: number, aMinutes: number, bStart: number, bMinutes: number): boolean {
  const aEnd = aStart + aMinutes * MINUTE;
  const bEnd = bStart + bMinutes * MINUTE;
  return aStart < bEnd && bStart < aEnd;
}
