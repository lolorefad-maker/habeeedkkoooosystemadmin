---
name: lounge-ui-ux
description: UI/UX design system and rules for Lounge OS (PlayStation / VR / cafeteria lounge management). Load before building or changing ANY screen, component, style, copy, or interaction in apps/web — covers personas, design tokens, status colors, RTL/Arabic rules, component patterns, motion, accessibility, and the pre-ship review checklist.
---

# Lounge OS — UI/UX System

The product runs a gaming lounge in real time: stations (PS5 / VR, Regular / VIP),
live timers, numbered controllers, reservations, shifts and end-of-day. **Everything happens on
the device**: opening a station takes time, controllers handed over, drinks/food and any
up-front payment (cash / visa) in one sheet; drinks are added later from the same sheet. There is
no kitchen screen — do not add one. The one exception is the **Cafeteria** page: the cashier sells to someone not on a device, paid on the spot. Staff use it for
8–12 hour shifts, often in dim rooms, often in a hurry, with customers waiting.
Every design decision serves **speed, glanceability, and trust in the money.**

## 1. Who we design for

| Persona | Device | What they need |
|---|---|---|
| Cashier | Desktop / laptop at the counter | Whole floor at a glance, keyboard shortcuts, fast checkout, zero ambiguity about money |
| Waiter | Tablet / phone, one hand | Big touch targets, add an order to a station in ≤ 3 taps |
| Manager | Any | Approvals (PIN), voids, shift close, end-of-day |
| Owner | Phone, remote | KPIs in 5 seconds: revenue today, busy stations, alerts |
| Customer | Station screen (TV / tablet), 2–3 m away | Remaining time, huge and calm |

## 2. Principles (in priority order)

1. **Money is never a surprise.** Before any charge, show the breakdown (time segments, orders,
   discounts, rounding). Totals use tabular numerals and the currency's exact decimals.
2. **Frequent actions ≤ 2 taps.** Start session, add order, end session. Rare or destructive
   actions may take more steps — that friction is intentional.
3. **Glanceable from 2 metres.** The floor view must read correctly from across the counter:
   status by color **and** icon **and** label; timers large, tabular, high contrast.
4. **Forgiving, never destructive.** No "delete" for money records — use *void with reason*.
   Prefer undo toasts over confirm dialogs for reversible actions. Confirm only the irreversible.
5. **Honest about connectivity.** Always show sync / connection state. If the server is
   unreachable, say so plainly and disable actions that would be lost — never fake success.
6. **RTL-first, bilingual.** Arabic is the default. Every screen must look intentional in
   both `dir="rtl"` (ar) and `dir="ltr"` (en).
7. **Calm under load.** Dark, low-glare surfaces; color is reserved for meaning (status,
   money, alerts). Nothing blinks except a true alarm (overtime).

## 3. Design tokens

All tokens live as CSS custom properties in `apps/web/src/styles/tokens.css` and are
exposed to Tailwind via `@theme`. **Never hard-code hex values in components.**

### Color — surfaces (red & white light theme is the default for Habeedko; dark mirrors roles)
- `--bg` app background · `--surface-1` cards · `--surface-2` raised / hover ·
  `--surface-3` inputs / wells · `--border` hairlines · `--border-strong` focus-adjacent
- `--text` primary · `--text-muted` secondary · `--text-faint` tertiary / disabled
- `--accent` brand action (Habeedko red on black) · `--accent-fg` text on accent

### Color — status (each has `-bg`, `-fg`, `-ring` variants)
| Status | Token | Meaning | Icon (lucide) |
|---|---|---|---|
| available | `--st-free` (emerald) | ready to start | `CircleCheck` |
| active | `--st-active` (silver — never red, red is the brand/action color) | session running | `Gamepad2` / `Glasses` for VR |
| ending | `--st-ending` (amber) | ≤ 5 min left on fixed session | `Hourglass` |
| overtime | `--st-over` (red) | fixed time exceeded | `AlarmClock` (subtle pulse) |
| paused | `--st-paused` (violet) | session paused | `Pause` |
| reserved | `--st-reserved` (cyan) | upcoming reservation | `CalendarClock` |
| maintenance | `--st-off` (slate) | out of service | `Wrench` |

Tier accents: **VIP = gold** (`--tier-vip`), used as a thin top border + crown badge, never as a
full fill (fills are for status). VR stations get the `Glasses` icon, not a new color.

Contrast: body text ≥ 4.5:1, large numerals/labels ≥ 3:1 against their surface, in both themes.

### Typography
- Family: `IBM Plex Sans Arabic` (bundled via @fontsource — the shop may be offline;
  **never load fonts from a CDN**). Fallback: system-ui.
- Numerals: timers, money and counters use `font-variant-numeric: tabular-nums` and are
  wrapped in `dir="ltr"` isolation (`<Num>` component) so they never jump or reorder in RTL.
- Scale (rem): 0.75 caption · 0.875 small · 1 body · 1.125 lead · 1.5 title · 2 display ·
  3 timer-hero (station screen up to 8rem).
- Weights: 400 body, 500 labels, 600 titles/numbers, 700 hero only.

### Space, shape, depth
- 4px grid. Common steps: 4, 8, 12, 16, 24, 32.
- Radius: 8 (controls), 12 (cards), 16 (sheets/dialogs), full (pills/badges).
- Elevation by lightness (surface-1 → surface-3), not heavy shadows. One soft shadow for
  floating layers (sheets, popovers, toasts).

### Motion
- Durations: 120ms (hover/press), 200ms (enter), 160ms (exit). Easing: `cubic-bezier(.2,.8,.2,1)`.
- Animate state changes of a station card (color cross-fade), sheet slide from the inline-end.
- Respect `prefers-reduced-motion`: disable transforms, keep opacity fades ≤ 120ms.
- Only overtime may pulse (2s, low amplitude). Never animate money values while the user reads them.

## 4. Layout by device

| Width | Layout |
|---|---|
| ≥ 1280 | Side nav (icons + labels) · floor grid · detail sheet docked at inline-end |
| 768–1279 | Collapsed icon rail · floor grid · sheet overlays |
| < 768 | Bottom tab bar · single-column list of stations (sorted: ending → overtime → active → free) · full-screen sheets |

Station grid: `repeat(auto-fill, minmax(220px, 1fr))`, group by room/zone with sticky headers.

## 5. Component patterns

- **StationCard**: name + type icon (top-start), tier badge (top-end), status label, hero timer,
  running cost, player mode, order count. Whole card is the tap target (min 120px tall).
  **Busy stations are filled solid** with their status (`.st-filled`: graphite playing, amber
  ending, red overtime, violet paused; text `--on-fill`) so "who is playing" reads from across the
  room; free stations are plain cards with a green "Available" pill and a visible "Start" button.
  Timers always show hours ("0:05:12", seconds smaller) — never an ambiguous "05:12".
  Durations in lists/bills are words (`f.span`: "1 س 25 د"). Times from `f.time` carry their own
  bidi isolates: put "from – to" ranges in a plain span, not `<Num>`.
- **Detail sheet** (not a modal): station context stays visible. Primary action is always the
  bottom-most full-width button (thumb reach). Secondary actions in a 2-column grid.
- **Money**: `<Money value={minor} />` formats from integer minor units using the branch
  currency/decimals. Never format money with floats or string concat.
- **Timer**: `<Timer />` derives from server timestamps (`startedAt`, segments) + the server
  clock offset. Never count with a local `setInterval` accumulator.
- **Numeric input / PIN pad**: on-screen keypad on touch devices, native input on desktop;
  keypad keys ≥ 56px.
- **Manager approval**: a PIN dialog that explains *what* is being approved and *why it needs
  approval* (e.g. "Refund 3.500 JOD — above cashier limit").
- **Time alerts**: chime at "ending soon", alarm at time-up + a sticky notice (Open / OK) that
  repeats the alarm every 2 min until acknowledged. Sound is per device (header bell), synthesized
  with Web Audio; never add audio files or autoplaying media. Logic lives in `lib/alerts-core.ts` (tested).
- **Toasts** (sonner): bottom-inline-**start** (the device sheet docks at inline-end — a toast
  must never cover its primary button). Success toasts auto-dismiss 3s; errors stay until
  dismissed and say what to do next.
- **Empty states**: one sentence + the single action that fixes it. **Loading**: skeletons that
  match final layout (no spinners for > 300ms content). **Error**: plain language + retry.

## 6. Keyboard (cashier desktop)

- `/` or `Ctrl+K` command palette (search stations, products, actions).
- `1…9` focus station by index on the floor, `Enter` open, `S` start, `E` end, `O` add order,
  `Esc` close sheet. Show shortcuts in tooltips and in the palette.
- Visible focus ring (`--accent` 2px + 2px offset) on every interactive element.

## 7. RTL & language rules

- Use logical utilities only: `ms-/me-/ps-/pe-`, `start-/end-`, `text-start/text-end`,
  `border-s/border-e`, `rounded-s/rounded-e`. **Never** `ml-/mr-/pl-/pr-/left-/right-` for layout.
- Mirror directional icons (arrows, chevrons, "back") with `rtl:-scale-x-100`. Do **not** mirror
  clocks, play/pause, gamepads, checkmarks, or brand-like glyphs.
- Mixed-direction strings (station "PS5-07", amounts, times) are isolated with `<bdi>` or `<Num>`.
- All user-facing text goes through `t()` with keys in `apps/web/src/i18n/{ar,en}.ts`. Arabic
  copy is short, plain, Modern Standard; verbs for buttons ("ابدأ", "أنهِ", "أضف طلب").
- Dates/times via `Intl` with the branch locale + time zone; 24h vs 12h follows the locale setting.

## 8. Accessibility checklist

- Every control reachable and operable by keyboard; logical tab order (matches visual in RTL).
- Status never conveyed by color alone (icon + text).
- Touch targets ≥ 44×44px (≥ 56px on keypad / primary tablet actions).
- `aria-live="polite"` for toasts and timer-milestone announcements (not every tick).
- Dialogs/sheets trap focus, restore focus on close, close on `Esc`.

## 9. Pre-ship review (run for every screen)

1. Does it work at 375px, 768px and 1440px without horizontal scroll?
2. Does it look intentional in **ar/RTL** and **en/LTR**, dark and light?
3. Are all money values `<Money>` and all timers `<Timer>` / `<Num>`?
4. Is every frequent action ≤ 2 taps and every destructive one guarded (reason / PIN / undo)?
5. Are loading, empty, error and offline states designed — not just the happy path?
6. Any hard-coded color, physical direction class, or un-translated string? → fix.
7. Keyboard-only pass: can you complete the flow without a mouse?
