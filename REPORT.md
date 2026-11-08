# Slotbook report

## What is built

The core from the brief is in place:

- Seeded host login, home timezone, event types, weekly availability, and date overrides.
- Public booking page at `/{host}/{event-slug}` with a timezone switcher.
- Five-minute hold, confirm, private manage link, reschedule, and cancel with a reason.
- The host can see upcoming bookings and cancel one.
- Confirm, reschedule, and cancel write a row to `notifications` in the same transaction as the booking change.
- JSON API used by both surfaces, documented in the README.

A hold moves `held → confirmed → cancelled`. A hold that is not confirmed in time is stored as `expired`. Capacity counts confirmed bookings and holds whose `expires_at` is still in the future.

Extensions from the brief (all wired through the same locking and capacity rules):

| Extension | Implementation |
| --- | --- |
| Waitlist | Join when a slot is full; cancellation promotes the next waiter into a normal 5-minute hold (`waitlist_entries`, `promoteWaitlist`). |
| Reminders | Pending 24 h and 1 h rows; reschedule replaces them, cancel clears them; background tick sends `booking.reminder`. |
| Calendar invite | `.ics` on confirm and via `GET /api/bookings/{token}/invite.ics`; reschedule/cancel bump `ics_sequence`. |
| Host webhooks | Register URL + secret; HMAC-signed payloads, retries, `webhook_deliveries` log. |
| Round-robin team events | `event_members` and `assigned_host_id`; slot list only when a member is free; capacity per assignee. |
| External busy times | Upload or fetch `.ics` into `busy_blocks`; overlapping slots removed. |
| Daily cap and per-guest limit | `daily_cap` per local day; `guest_limit` blocks a second active booking per event type and email. |
| Observability | `x-request-id` on requests, structured JSON logs, `GET /api/health` with `metric_counters`. |
| End-to-end tests and CI | Playwright guest flow in `e2e/guest.spec.ts`; `.github/workflows/test.yml` runs API tests, typecheck, and e2e on push. |
| Load test | Artillery script `load/booking.yml` (slots → hold → confirm on `demo/workshop`). |

Public routes are rate-limited per IP (read vs write). Active holds per IP are capped via `HOLD_CAP` (default 8).

## How a seat stays single-occupied

Postgres is the source of truth. There is no Redis lock.

Every hold, confirm, reschedule, and cancel runs in one transaction. The application locks the host row, then the event-type row, then the booking row, always in that order. `now()` inside that transaction is the clock that decides expiry, minimum notice, and the booking horizon, so the application process clock is not consulted for those decisions.

An `AFTER` trigger on `bookings` takes the same event-type lock and counts overlapping active rows. A booking occupies `[starts_at - buffer_before, ends_at + buffer_after)`. Overlap is half-open, so a meeting that ends when the next one starts does not collide, and a buffer that touches the next meeting does. The trigger raises `capacity_exceeded` if the count would pass the event's capacity. That still holds if something inserts SQL without going through the route handlers. Expired holds (`expires_at <= now()`) and cancelled rows are not in the count.

Buffers are copied onto the booking. Changing the event type later does not rewrite a hold or a confirmed booking that already exists. Reschedule snapshots the current buffers because it is a new commitment.

The slot list can be stale for a moment. It does not grant the seat. `POST /api/holds` generates the grid again under the lock and inserts only if that instant is still an exact slot with a free seat. Retries send `Idempotency-Key`. The key is locked with `pg_advisory_xact_lock` before the host lock, and the stored response is written in the same transaction as the hold. A lost response replays the same hold instead of creating a second one. A reused key with a different body is rejected. Failed attempts are not stored, so a key that lost a race can succeed later if the seat frees.

Confirming the same hold again with the same guest does not write a second notification. A second cancel does not either. Reschedule to the current instant is a no-op. The countdown in the browser is the server's `expiresAt - now`, measured with `performance.now()`, so a wrong laptop clock does not extend the hold. Confirm after `expires_at` marks the row `expired` and commits that status before returning 409.

Slot starts step by the event duration from each availability window, in real UTC time. A spring-forward gap is not offered. A fall-back hour that happens twice produces two different instants. Window edges that land inside that repeated hour use Luxon's earlier offset; hosts should keep those edges outside the fold. Tests cover 8 March 2026 and 1 November 2026 in `America/New_York`, and 09:00 `Asia/Kolkata` as 03:30 UTC.

Availability is host-wide, which matches the brief listing it as a host setting rather than a field of each event type. Two event types can still be booked at the same time; they do not share capacity.

## Load test

Script: `pnpm load` (API must be running: `pnpm start` after Postgres is up).

Scenario: list `demo/workshop` slots, then for ~20 s at ~3 arrivals/s per vU, each virtual user holds a unique seat (group capacity 4) and confirms with a unique email. Each request uses a synthetic `x-forwarded-for` so holds do not share one IP cap.

After a run, record Artillery’s summary here:

| Metric | Value |
| --- | --- |
| Throughput (requests completed / s) | _run `pnpm load` and paste_ |
| p95 latency (hold + confirm) | _paste_ |
| Error rate | _paste_ |

## What is not built

- Real calendar sync (Google/Outlook), payments, and outbound email/SMS delivery (notifications table remains the sink).
- Guest-facing edit of name or email after confirm.
- A separate slot interval (starts still step by event duration).
- Per-event weekly schedules (overrides and weekly hours belong to the host).

`docker compose up --build` is the one-command path. Run `corepack pnpm install` (lockfile includes Playwright and Artillery), then `pnpm test`, `pnpm test:e2e`, and `pnpm load` with Postgres on `DATABASE_URL`.
