# Lounge OS — working notes

Monorepo (npm workspaces): `packages/core` (pure domain engine), `apps/server` (Fastify + Drizzle + Socket.IO), `apps/web` (React + Vite + Tailwind v4).

## How the shop works (owner's words — design around it)

Everything is on the **device (station)**: when a station is opened the owner records time, the numbered controllers handed over, drinks/food, and what was paid (cash or visa, just recorded). Drinks are added later from the same device sheet. **No kitchen.** The **Cafeteria** page (cashier) sells to someone not on a device, paid on the spot (`POST /api/counter/sale`). The bill is play time × hourly rate + drinks − paid.

**The day ends at midnight** (cutoff `00:00`, closes by itself): a station playing then is split — what it earned by midnight is that day's income (`day_carries`), the rest counts on the day it is paid; the money is always the day/shift that received it. At the automatic close an open shift is closed uncounted and its cash carried into a new shift.

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
