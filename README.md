# Slotbook

Hosts publish when they are free. Guests book a slot. Postgres makes sure a seat is never given out twice, including when a request is retried, a hold expires, or two people click at the same time.

## Run

Docker (Postgres 16 and the app):

```bash
docker compose up --build
```

Open http://localhost:3000.

Without running the app in Docker, start only Postgres and use pnpm (Node 22+):

```bash
docker compose up postgres -d
pnpm install
pnpm dev
```

Open http://localhost:5173. The API listens on port 3000 and Vite proxies `/api`.

`pnpm dev` and `pnpm start` both migrate and seed before serving.

Demo host:

| | |
| --- | --- |
| Email | `demo@slotbook.dev` |
| Password | `demo-password` |
| Page | http://localhost:5173/demo/intro and `/demo/workshop` |
| Hours | Monday–Friday 09:00–12:00 and 13:00–17:00, `Asia/Kolkata` |

Copy `.env.example` to `.env` if `DATABASE_URL` is not already in the environment.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm test:e2e
```

`pnpm test` needs `DATABASE_URL`. It covers the slot grid across DST, concurrent holds, group capacity, buffers, idempotency keys, expired holds, reschedule conflicts, cancellations, and a timezone conversion.

`pnpm test:e2e` builds the client, starts the API, and runs the Playwright guest flow: pick a slot, confirm, open the private manage link, and cancel. GitHub Actions (`.github/workflows/test.yml`) runs `pnpm test`, `pnpm typecheck`, and `pnpm test:e2e` on every push.

Load test against a running API (`pnpm start` in another terminal):

```bash
pnpm load
```

That Artillery script lists workshop slots, then holds and confirms them. The summary (throughput, p95, error rate) is recorded in [REPORT.md](REPORT.md).

## API

All `/api` responses send `Cache-Control: no-store`. Times in request and response bodies are ISO-8601 instants. `tz` is an IANA name used to add local labels.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/hosts/{host}/events/{slug}/slots?from&to&tz` | Open slots in `[from, to)`, after minimum notice and inside the booking horizon |
| POST | `/api/holds` | Hold a slot for 5 minutes. Requires `Idempotency-Key` |
| POST | `/api/holds/{id}/confirm` | Confirm with `{ name, email }` |
| GET | `/api/bookings/{token}` | Read a booking |
| GET | `/api/bookings/{token}/slots?from&to&tz` | Slots for a reschedule (the current booking does not block itself) |
| POST | `/api/bookings/{token}/reschedule` | `{ startsAt }` |
| POST | `/api/bookings/{token}/cancel` | `{ reason }` |

Hold body: `{ "host", "eventSlug", "startsAt" }`. The same key and same body return the original hold. The same key with a different body returns `409 idempotency_key_reuse`.

Host routes (session cookie):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/logout` | Clear the session |
| GET | `/api/auth/me` | Current host |
| PATCH | `/api/host/settings` | `{ timezone }` |
| GET/POST | `/api/host/events` | List or create an event type |
| PATCH/DELETE | `/api/host/events/{id}` | Update, or delete if it has no bookings |
| GET/PUT | `/api/host/availability` | Replace weekly windows |
| GET | `/api/host/overrides` | List date overrides |
| PUT/DELETE | `/api/host/overrides/{YYYY-MM-DD}` | Day off or custom windows |
| GET | `/api/host/bookings` | Upcoming confirmed bookings |
| POST | `/api/host/bookings/{id}/cancel` | `{ reason }` |
| GET | `/api/host/notifications` | Notification sink |

Errors are `{ "error", "code" }` with a 4xx status.

Design notes and unfinished work are in [REPORT.md](REPORT.md).
