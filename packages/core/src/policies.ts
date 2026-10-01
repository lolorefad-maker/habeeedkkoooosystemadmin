import { z } from 'zod';

/**
 * Every business rule the owner can change lives here as data, never in code.
 * Schemas give defaults so a fresh branch works out of the box and old settings
 * stay valid when new fields are added.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm');

export const billingPolicySchema = z.object({
  /** Played time ≤ grace is free ("changed their mind"). Only when no early-end rule forces a charge. */
  graceMinutes: z.number().int().min(0).max(60).default(0),
  /** Minimum billable time once past grace. */
  minimumMinutes: z.number().int().min(0).max(600).default(0),
  /** Billing unit: 1 = per minute, 15 = blocks of 15 minutes. */
  roundingMinutes: z.number().int().min(1).max(60).default(1),
  roundingMode: z.enum(['up', 'nearest', 'down']).default('up'),
  /** What a fixed (pre-booked) session pays when it ends before its planned time. */
  earlyEnd: z.enum(['charge_actual', 'charge_full', 'actual_with_min']).default('charge_actual'),
  earlyEndMinMinutes: z.number().int().min(0).max(600).default(30),
  /** Maximum time charge for a single session (minor units). null = no cap. */
  sessionCap: z.number().int().min(0).nullable().default(null),
  /** Automatically apply a package when it is cheaper than the hourly price. */
  autoBestPackage: z.boolean().default(true),
  /** Fixed sessions show "ending soon" this many minutes before the end. */
  endingSoonMinutes: z.number().int().min(1).max(60).default(5),
  /** End fixed sessions automatically at their planned time (otherwise they run into overtime). */
  autoEndFixed: z.boolean().default(false),
});

export const reservationPolicySchema = z.object({
  /** Cancelling at least this long before the start is free. */
  freeCancelMinutes: z.number().int().min(0).max(10_080).default(120),
  lateCancelFeeKind: z.enum(['fixed', 'percent_deposit']).default('percent_deposit'),
  /** Minor units for "fixed", 0–100 for "percent_deposit". */
  lateCancelFeeValue: z.number().int().min(0).default(50),
  /** After this many minutes without check-in the reservation becomes a no-show and the station is released. */
  noShowGraceMinutes: z.number().int().min(0).max(240).default(15),
  noShowForfeitDeposit: z.boolean().default(true),
  /** Station shows "reserved" this many minutes before the reservation starts. */
  holdMinutesBefore: z.number().int().min(0).max(240).default(15),
});

export const checkoutPolicySchema = z.object({
  /** Round bill totals to this many minor units (e.g. 50 = nearest 0.050). 0 = exact. */
  cashRounding: z.number().int().min(0).default(0),
  /** Cashiers may discount up to this percent without a manager PIN. */
  maxCashierDiscountPercent: z.number().min(0).max(100).default(10),
  /** Refunds above this amount (minor units) need a manager PIN. */
  refundApprovalAbove: z.number().int().min(0).default(0),
  /** Voiding an order item needs a manager PIN. */
  voidNeedsApproval: z.boolean().default(true),
});

export const dayPolicySchema = z.object({
  /** Local time the business day rolls over (a lounge open until 03:00 uses e.g. 06:00). */
  cutoff: hhmm.default('06:00'),
  /** Generate the end-of-day report automatically at the cutoff. */
  autoCloseDay: z.boolean().default(true),
});

export const controllerPolicySchema = z.object({
  /** A controller put on charge becomes ready again automatically after this long. */
  chargeMinutes: z.number().int().min(5).max(24 * 60).default(60),
  /** Controllers handed out with a session go back to the shelf when it ends. Off = they live at the station. */
  returnOnEnd: z.boolean().default(true),
});

export const branchSettingsSchema = z.object({
  billing: billingPolicySchema.prefault({}),
  reservations: reservationPolicySchema.prefault({}),
  checkout: checkoutPolicySchema.prefault({}),
  day: dayPolicySchema.prefault({}),
  controllers: controllerPolicySchema.prefault({}),
});

export type BillingPolicy = z.output<typeof billingPolicySchema>;
export type ReservationPolicy = z.output<typeof reservationPolicySchema>;
export type CheckoutPolicy = z.output<typeof checkoutPolicySchema>;
export type DayPolicy = z.output<typeof dayPolicySchema>;
export type ControllerPolicy = z.output<typeof controllerPolicySchema>;
export type BranchSettings = z.output<typeof branchSettingsSchema>;

export function parseBranchSettings(raw: unknown): BranchSettings {
  return branchSettingsSchema.parse(raw ?? {});
}

export const defaultBranchSettings = (): BranchSettings => branchSettingsSchema.parse({});
