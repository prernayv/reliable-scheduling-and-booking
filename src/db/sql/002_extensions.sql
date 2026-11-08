-- Optional extensions. Capacity, holds, and expiry stay exactly as in 001_init.sql.
-- Daily caps and guest limits are checked under the same event-type lock.
-- A waitlist offer is an ordinary 5-minute hold, so it counts toward capacity.

ALTER TABLE event_types
  ADD COLUMN daily_cap integer,
  ADD COLUMN guest_limit boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT event_types_daily_cap CHECK (daily_cap IS NULL OR daily_cap >= 1);

ALTER TABLE bookings
  ADD COLUMN ics_sequence integer NOT NULL DEFAULT 0;

ALTER TABLE notifications DROP CONSTRAINT notifications_kind;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind CHECK (
  kind IN (
    'booking.confirmed',
    'booking.rescheduled',
    'booking.cancelled',
    'booking.reminder',
    'booking.waitlist_offered'
  )
);

CREATE TABLE busy_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  summary text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'ics',
  CONSTRAINT busy_blocks_span CHECK (ends_at > starts_at)
);

CREATE INDEX busy_blocks_host_idx ON busy_blocks (host_id, starts_at, ends_at);

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id uuid NOT NULL REFERENCES event_types (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  guest_name text NOT NULL,
  guest_email text NOT NULL,
  status text NOT NULL,
  claim_token text,
  hold_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_status CHECK (status IN ('waiting', 'offered', 'booked', 'expired', 'withdrawn')),
  CONSTRAINT waitlist_span CHECK (ends_at > starts_at)
);

CREATE UNIQUE INDEX waitlist_claim_token_key ON waitlist_entries (claim_token) WHERE claim_token IS NOT NULL;
CREATE UNIQUE INDEX waitlist_one_active_email ON waitlist_entries (event_type_id, starts_at, guest_email)
  WHERE status IN ('waiting', 'offered');
CREATE INDEX waitlist_offer_idx ON waitlist_entries (event_type_id, starts_at, created_at)
  WHERE status = 'waiting';

CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind text NOT NULL,
  fire_at timestamptz NOT NULL,
  status text NOT NULL,
  sent_at timestamptz,
  CONSTRAINT reminders_kind CHECK (kind IN ('24h', '1h')),
  CONSTRAINT reminders_status CHECK (status IN ('pending', 'sent', 'cancelled')),
  CONSTRAINT reminders_booking_kind UNIQUE (booking_id, kind)
);

CREATE INDEX reminders_due_idx ON reminders (fire_at) WHERE status = 'pending';

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhooks_host_url UNIQUE (host_id, url)
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  notification_id uuid NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  attempt integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  http_status integer,
  error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_status CHECK (status IN ('pending', 'delivered', 'failed'))
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE metric_counters (
  name text PRIMARY KEY,
  value bigint NOT NULL
);
