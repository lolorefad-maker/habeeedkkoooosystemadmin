# Lounge OS — working notes

Monorepo (npm workspaces): `packages/core` (pure domain engine), `apps/server` (Fastify + Drizzle + Socket.IO), `apps/web` (React + Vite + Tailwind v4).

## How the shop works (owner's words — design around it)

Everything is on the **device (station)**: when a station is opened the owner records time, the numbered controllers handed over, drinks/food, and what was paid (cash or visa, just recorded). Drinks are added later from the same device sheet. **No kitchen.** The **Cafeteria** page (cashier) sells to someone not on a device, paid on the spot (`POST /api/counter/sale`). The bill is play time × hourly rate + drinks − paid.

**The day is the shift**: a day starts when the shift is opened and ends when the shift is closed by hand (`POST /api/shifts/close` counts the drawer and ends the day with it), even after midnight — a night from 4 pm to 6 am is one day. Nothing closes by itself at 00:00 and nothing is split: a device still playing when the shift is closed is counted whole on the day it is paid (the cashier is warned). The old midnight mode (`day.autoCloseDay`, day carries, late shares, uncounted auto-closed shifts) is still in the code for old data and is off by default and by migration; the settings screen no longer offers it. The ledger's daily page shows, in one look: when the shift opened and its opening value, the increase (cash/visa), the day's profit so far and how many devices played, then the devices with their drinks and the cafeteria's purchases. A paid entry can be deleted from the ledger on any day, with a confirmation (`POST /api/bills/:id/void`, owner/manager): the bill is voided (row kept, audit-logged), its money is reversed with refund rows in the same shift/day, the saved report of a closed day is rebuilt — devices, stock and rewards are untouched, and a device still playing has no delete button. The owner can "start from zero" (`POST /api/ledger/reset`): the current shift and day close uncounted, every day so far is hidden (`business_days.archived`, nothing is deleted), a fresh day opens.

**Customer rewards** ("People Rewards"): a session of more than 4 hours (`rewards.afterMinutes`, pauses excluded) registered with a phone number earns a free hour (`rewards` table, one per session) for that number (`customers`, unique per org + normalized phone: digits with the country code, `normalizePhone`). The number is typed when opening a device, comes from the booking, or is asked for at checkout. The next bill of that number can take it off (`rewardId` at checkout; priced by `freeTimeValue` at the session's average price per billed minute, no manager PIN, never together with a hand-made discount). The WhatsApp message is a `wa.me` link the cashier presses send on — nothing is sent by the server. A reward is voided with a reason, never deleted.

## Rules that keep the system correct

- **Money is integer minor units** everywhere (`Minor`). Never floats in storage or APIs. Format only via `formatMoney` / `useFmt()`.
- **Business rules live in `@lounge/core`** and are validated by its zod schemas (`branchSettingsSchema`, `pricingRuleSchema`…). Server and web both import them — never re-implement pricing in one side only.
- **Sessions are segments.** Every change closes the current segment and opens a new one (`planAction`). Billing (`computeTimeBill`) prices each segment and each rule window.
- **Every server write uses `mutate(ctx, actor, fn)`**: one DB transaction + an `events` row (audit log + future sync outbox), published to live clients after commit.
- **Nothing that touches money is deleted**: void with reason; manager approval via `resolveApproval` (manager PIN).
- **Business day** = the open row in `business_days` (not the calendar date). Transactions record `currentDay()`.
- IDs are UUIDv7 (`newId()`), every row carries its branch/org — required for the cloud sync phase.
- Schema changes: edit `apps/server/src/db/schema.ts`, then `npm run db:generate` (commits a SQL migration in `apps/server/drizzle`). Migrations run on startup.

## UI

Before changing anything in `apps/web`, load the project skill **`lounge-ui-ux`** (`.claude/skills/lounge-ui-ux/SKILL.md`): tokens only (no hex in components), logical RTL utilities only (`ms-/me-/start-/end-`), numbers/timers/money through `<Num>`/`<Money>`, every string through `t()` in both `i18n/ar.ts` and `i18n/en.ts`.

## Commands

- `npm run dev` — server (:4000) + web (:5173) with demo data in `apps/server/.data`
- `npm test` — core unit tests + server end-to-end flows (in-memory PGlite)
- `npm run typecheck` — all workspaces (TypeScript 7)
- `npm run build && npm start` — single process serving web + API on :4000
