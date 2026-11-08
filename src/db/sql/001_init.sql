-- Slotbook schema. Postgres is the source of truth for "never double-book".
--
-- A booking occupies [starts_at - buffer_before, ends_at + buffer_after).
-- Holds and confirmed rows count toward capacity. Expired holds and
-- cancellations do not. Buffers are copied onto the booking so a later
-- edit to the event type does not rewrite a promise already made.
--
-- Writes take the host row lock, then the event-type row lock, then
-- insert or update. The trigger takes the same event-type lock and
-- counts overlapping active rows, so a raw INSERT cannot bypass the app.

CREATE TABLE hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  timezone text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  duration_min integer NOT NULL,
  capacity integer NOT NULL,
  buffer_before_min integer NOT NULL,
  buffer_after_min integer NOT NULL,
  min_notice_min integer NOT NULL,
  horizon_days integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_types_host_slug UNIQUE (host_id, slug),
  CONSTRAINT event_types_duration CHECK (duration_min BETWEEN 15 AND 120),
  CONSTRAINT event_types_capacity CHECK (capacity BETWEEN 1 AND 500),
  CONSTRAINT event_types_buffer_before CHECK (buffer_before_min BETWEEN 0 AND 30),
  CONSTRAINT event_types_buffer_after CHECK (buffer_after_min BETWEEN 0 AND 30),
  CONSTRAINT event_types_notice CHECK (min_notice_min BETWEEN 0 AND 43200),
  CONSTRAINT event_types_horizon CHECK (horizon_days BETWEEN 1 AND 365)
);

-- day_of_week uses ISO: 1 = Monday … 7 = Sunday. Minutes are local to hosts.timezone.
CREATE TABLE availability_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  day_of_week integer NOT NULL,
  start_min integer NOT NULL,
  end_min integer NOT NULL,
  CONSTRAINT availability_rules_day CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT availability_rules_span CHECK (
    start_min >= 0 AND end_min <= 1440 AND start_min < end_min
  )
);

CREATE INDEX availability_rules_host_idx ON availability_rules (host_id, day_of_week);

CREATE TABLE date_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  override_date date NOT NULL,
  unavailable boolean NOT NULL,
  CONSTRAINT date_overrides_host_date UNIQUE (host_id, override_date)
);

CREATE TABLE override_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  override_id uuid NOT NULL REFERENCES date_overrides (id) ON DELETE CASCADE,
  start_min integer NOT NULL,
  end_min integer NOT NULL,
  CONSTRAINT override_windows_span CHECK (
    start_min >= 0 AND end_min <= 1440 AND start_min < end_min
  )
);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id uuid NOT NULL REFERENCES event_types (id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  buffer_before_min integer NOT NULL,
  buffer_after_min integer NOT NULL,
  status text NOT NULL,
  expires_at timestamptz,
  guest_name text,
  guest_email text,
  manage_token text,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_status CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
  CONSTRAINT bookings_time CHECK (ends_at > starts_at),
  CONSTRAINT bookings_buffers CHECK (
    buffer_before_min BETWEEN 0 AND 30 AND buffer_after_min BETWEEN 0 AND 30
  ),
  CONSTRAINT bookings_shape CHECK (
    (
      status = 'held'
      AND expires_at IS NOT NULL
      AND guest_name IS NULL
      AND guest_email IS NULL
      AND manage_token IS NULL
      AND cancel_reason IS NULL
    )
    OR (
      status = 'confirmed'
      AND expires_at IS NULL
      AND guest_name IS NOT NULL
      AND guest_email IS NOT NULL
      AND manage_token IS NOT NULL
      AND cancel_reason IS NULL
    )
    OR (
      status = 'cancelled'
      AND expires_at IS NULL
      AND manage_token IS NOT NULL
      AND cancel_reason IS NOT NULL
    )
    OR (
      status = 'expired'
      AND guest_name IS NULL
      AND guest_email IS NULL
      AND manage_token IS NULL
      AND cancel_reason IS NULL
    )
  )
);

CREATE UNIQUE INDEX bookings_manage_token_key ON bookings (manage_token) WHERE manage_token IS NOT NULL;

CREATE INDEX bookings_event_span_idx ON bookings (event_type_id, starts_at, ends_at)
  WHERE status IN ('held', 'confirmed');

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_kind CHECK (
    kind IN ('booking.confirmed', 'booking.rescheduled', 'booking.cancelled')
  )
);

CREATE INDEX notifications_host_idx ON notifications (host_id, created_at DESC);

CREATE OR REPLACE FUNCTION bookings_enforce_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  used integer;
BEGIN
  IF NEW.status NOT IN ('held', 'confirmed') THEN
    RETURN NEW;
  END IF;

  -- Same lock the application takes before writing. Concurrent inserts queue here.
  SELECT capacity INTO cap
  FROM event_types
  WHERE id = NEW.event_type_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'event_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO used
  FROM bookings b
  WHERE b.event_type_id = NEW.event_type_id
    AND b.id <> NEW.id
    AND (
      b.status = 'confirmed'
      OR (b.status = 'held' AND b.expires_at > now())
    )
    AND tstzrange(
          b.starts_at - (b.buffer_before_min * interval '1 minute'),
          b.ends_at + (b.buffer_after_min * interval '1 minute'),
          '[)'
        ) && tstzrange(
          NEW.starts_at - (NEW.buffer_before_min * interval '1 minute'),
          NEW.ends_at + (NEW.buffer_after_min * interval '1 minute'),
          '[)'
        );

  IF used >= cap THEN
    RAISE EXCEPTION 'capacity_exceeded' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_capacity_trg
AFTER INSERT OR UPDATE OF status, starts_at, ends_at, buffer_before_min, buffer_after_min, expires_at
ON bookings
FOR EACH ROW
EXECUTE FUNCTION bookings_enforce_capacity();
