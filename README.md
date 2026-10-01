# Habeedko — Lounge OS

The Habeedko shop's management system (red and black theme): a management system for PlayStation / VR gaming lounges with a cafeteria. It runs **locally in the shop**, so it keeps working with no internet, and it is built to sync to a **cloud** later for remote owners and multiple branches.

- **Everything happens on the device.** Opening a station records all of this in one sheet: play time (open/fixed/package), the numbered controllers handed over, drinks and food, and any up-front payment (cash or visa). During play, the same sheet adds drinks and takes payments. It always shows: play time × hourly rate + drinks − paid (cash / visa) = what is left. There is no kitchen screen.
- **Cafeteria (كافيتيريا):** the cashier sells drinks and snacks to someone not on a device, paid on the spot in cash or visa. The stock goes down and the sale shows in the ledger as "Cafeteria".
- **A day that ends at midnight:** set the day start to 00:00. At midnight the day and the shift close by themselves (the drawer's cash carries into a new shift, uncounted; count it whenever you like). A station playing 9 pm → 3 am is split: the 3 hours before midnight are the old day's income, the rest the new day's. The money itself counts on the day and in the shift that received it.
- **Numbered controllers:** each controller has a number. You see which ones are with which device, and which are on the shelf. When a battery dies you tap "battery died" and swap in a ready one; after the charge time (1 hour by default) it becomes ready again by itself and every screen gets a notice. Controllers follow a session when it moves to another station, and return to the shelf when it ends (configurable).
- **Floor:** every station (PS5 / VR, Regular / VIP) live, with timers, running cost, controller numbers, reservations and status.
- **Time alerts (sound):**
  - A soft chime and a notice when a fixed session is about to end (the "ending soon" setting, 5 minutes by default).
  - An alarm when time is up, with a notice that stays until someone taps OK, or Open (which jumps to the station). The alarm repeats every 2 minutes while nobody reacts.
  - The sound is generated in the browser (no files, works offline), and each device has its own bell toggle in the header. The customer display rings for its own station.
- **Sessions:** open or fixed time, packages, pause/resume, single↔multi, move to another station, extend, end and pay later.
- **Dynamic pricing:** hourly rules by station type, tier, mode, day, time window and dates; discount/increase % rules (happy hour); packages and automatic best price; session cap.
  - **Price changes apply from the moment they are made.** Editing a rule ends the old version now and starts the new one now, so a customer already playing pays the old price for the time before the change. The bill shows both lines, and the old versions are kept for billing and audit.
  - **Discount now:** the owner taps "Discount" on the floor and picks a percent, the stations (all / a type / VIP), and a duration (until stopped / end of day / 1–2 h). A green strip shows while it is on, with Stop. It replaces any other running % rule (percents never stack) and only counts from the moment it starts.
- **Policies (all editable):** grace period, minimum charge, billing unit and rounding, early-end rule (pay actual / full / actual with minimum), cancellation fees, no-show, station hold, cash rounding, discount and refund approval limits, business-day cutoff.
- **Ledger (الجرد) page:**
  - **Daily:** every device of the business day, with from–to, duration, time charge, drinks, total and how it was paid (cash / visa). Devices still open are listed live. The Z summary and "close day" follow.
  - **Monthly:** revenue for each day of the month, with cash / visa received, the best day, and month totals.
- **Stock (المخزون) page** (its own page in the menu, owner/manager):
  - Every counted product with the pieces left, the ones running out on top.
  - Search, plus "running low" and "out" filters. The tiles double as filters.
  - Receive deliveries as cartons × pieces-per-carton at a price per piece, several products at once.
  - Fix a count; add a new product with its opening stock.
  - The full in/out history per product.
  - Every piece taken on a device lowers the stock, and voids put it back. A product can also be given its stock count in Settings → Products; each change is a recorded movement.
- **Phone bookings from the floor:**
  - "Book" in the floor toolbar, or "Book for later" on a free station, with one-tap times (in 30 min / 1 h / 2 h). Nothing starts until the customer arrives.
  - The card shows "Booked for Ahmad · 8:00 PM". Shortly before that time, the station turns "reserved" and then shows how late the customer is.
  - "Cancel booking" is on the station itself.
- **How many are left (chips, chocolate, drinks…):**
  - Every drink/food button on a device shows "N left".
  - After drinks go on a device, the notice says what is left of each item. It becomes a warning when an item is running low or ran out, and the other devices get that warning too.
  - The owner's **Stock** button on the floor lists every counted item with the pieces left, the ones running out on top.
  - A product created on a delivery warns at about a quarter of a carton; change it in Settings → Products.
- **Payments are recorded, not processed:** cash or visa is a label on each payment. The system does not charge cards.
- **Money control:** a cash-drawer shift must be open before any payment. Every discount or refund above the limit, and every void, needs a manager PIN. Nothing that touches money is ever deleted, and every action is in the audit log.
- **End of day ("إنهاء اليوم"):** one screen, from the ledger or the user menu (owner/manager):
  - It shows the day's income (total, cash, visa, play time, drinks) and warns about stations still playing or unpaid.
  - It counts the cash drawer, which closes the open shift, and can count stock (optional).
  - It saves the day's report, and a new day starts at zero. Nothing is deleted: the closed day stays in the ledger and can be printed.
  - The Z report has revenue, payments, stations, best sellers, voids, reservations, shifts with cash variance, and the stock count.
  - If nobody ends the day, it closes automatically at the cutoff.
- **Settings safety:**
  - The last active owner can't be deactivated or demoted.
  - Station and product names are unique.
  - Currency decimals are locked after the first payment, because amounts are stored in minor units.
- **Multi-device, real time:** cashier PC, tablets, owner phone, and a customer timer screen per station (`/display/<stationId>`).
- **Arabic-first (RTL) + English, dark + light.** The UI rules are in `.claude/skills/lounge-ui-ux/SKILL.md`.

## Run it (development)

```bash
npm install
npm run dev
```

- Web app: http://localhost:5173 (other devices on the Wi-Fi use `http://<this-PC-IP>:5173`)
- API: http://localhost:4000
- The first start creates demo data (16 stations, prices, products, staff). The demo staff PINs are listed in `apps/server/src/seed.ts`. **Change them in Settings → Staff before real use.**

## Run it in the shop (production)

```bash
npm run build
npm start
```

This runs one process on port 4000 that serves the web app and the API. Tablets and phones open `http://<shop-PC-IP>:4000`.

| Environment variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `DATABASE_URL` | *(none)* | Postgres URL. If it is not set, an embedded Postgres (PGlite) is stored in `apps/server/.data` |
| `LOUNGE_DATA_DIR` | `./.data` | Where the embedded DB and generated secrets live. **Back this folder up.** |
| `JWT_SECRET` | auto-generated | Token signing secret |
| `LOUNGE_MODE` | `local` | `local` (shop) or `cloud` |
| `LOUNGE_SEED_DEMO` | `true` | Create demo data on first start |

## Deploy online (Render)

`render.yaml` is a Blueprint. It creates one always-on web service (web app, API, realtime and scheduler) and a managed Postgres database, both in Frankfurt.

1. Push this repository to GitHub.
2. In Render, go to **New → Blueprint** and pick the repository.
3. Fill in the three values Render asks for:
   - `LOUNGE_ACCESS_CODE`: the shop code, 6+ characters.
   - `LOUNGE_OWNER_PIN`: 6–8 digits.
   - `LOUNGE_OWNER_NAME`
4. When the deploy is live, open the `onrender.com` URL (or add your domain; HTTPS is automatic). Enter the shop code and log in as the owner.
5. **Bring your setup:**
   - On the local install: Settings → General → "Download setup file".
   - Online: Settings → General → "Import setup file". This works once, on the empty install.
   - It carries stations, prices, packages, products, controllers and policies, but no sessions, bills, stock counts or staff.
   - Then add staff (Settings → Staff) and put the real stock in with a first delivery (Stock page).

The online mode refuses to start if it would be unsafe:
- no database;
- no shop code, or one shorter than 6 characters;
- demo data turned on;
- an owner PIN shorter than 6 digits.

Online, owners and managers need PINs of 6 or more digits. The login endpoints are rate-limited per IP, and the pages are served with a strict Content-Security-Policy and HSTS.

Keep **one instance**, because the scheduler runs inside it. `autoDeploy` is off so updates go out when the shop is closed. Take a database backup before deploying an update, because migrations run on start.

## Architecture

```
packages/core   Pure domain engine (no I/O): pricing rules, session segments, billing,
                policies, reservations, checkout, business day. Shared by server AND web,
                so the live cost on a tablet is computed by the same code that bills.
apps/server     Fastify API + Socket.IO realtime + scheduler. Drizzle ORM on Postgres
                (or embedded PGlite). Every write goes through mutate(): one transaction +
                an audit/outbox event, then pushed live to every device of the branch.
apps/web        React + Vite + Tailwind. TanStack Query, refetched on live events.
```

Layers: **Presentation** (web app on any device) → **API & realtime** (REST, WebSocket, PIN auth, roles) → **Domain** (`@lounge/core`) → **Data** (Postgres, events table = audit log + sync outbox) → **Scheduler** (day rollover, no-shows, auto-end) → *(planned)* **Edge/Hardware** and **Cloud sync**.

## Tests

```bash
npm test
```

- `packages/core`: 44 unit tests covering pricing, segments, rounding, grace, minimum, early-end policies, packages, caps, happy hour splits, overnight rules, reservations, checkout.
- `apps/server`: 24 end-to-end API flows on an in-memory database:
  - a full evening;
  - controllers: hand-over, battery swap, auto-ready after the charge time, follow on transfer, return on end;
  - opening a device with drinks and a visa payment in one step.

## Roadmap

- **Phase 2:** customers and wallet/loyalty, inventory recipes (a coffee consumes beans, milk and a cup), split payments, reports across date ranges.
- **Phase 3:**
  - Cloud sync worker. The `events` outbox and UUIDv7 ids are already in place.
  - Owner mobile dashboard.
  - Device pairing tokens for station screens.
  - Hardware control: smart plug, HDMI-CEC or TV API to switch screens on and off with the session.
  - ESC/POS receipt printing.
  - PWA offline shell.
- **Phase 4:** multi-branch/SaaS tenancy, online booking and payment, customer app, tournaments.
