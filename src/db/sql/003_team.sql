-- Round-robin assignments and the per-network hold cap.
-- A null assigned_host_id keeps the original event-wide capacity count.

ALTER TABLE bookings
  ADD COLUMN assigned_host_id uuid REFERENCES hosts (id),
  ADD COLUMN client_ip text;

CREATE INDEX bookings_assignee_idx ON bookings (assigned_host_id, starts_at)
  WHERE status IN ('held', 'confirmed');

CREATE INDEX bookings_hold_ip_idx ON bookings (client_ip)
  WHERE status = 'held';

CREATE TABLE event_members (
  event_type_id uuid NOT NULL REFERENCES event_types (id) ON DELETE CASCADE,
  host_id uuid NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  PRIMARY KEY (event_type_id, host_id)
);

CREATE OR REPLACE FUNCTION bookings_enforce_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  used integer;
BEGIN
  IF NEW.status NOT IN ('held', 'confirmed') THEN
    RETURN NEW;
  END IF;

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
        )
    AND (
      NEW.assigned_host_id IS NULL
      OR b.assigned_host_id = NEW.assigned_host_id
    );

  IF used >= cap THEN
    RAISE EXCEPTION 'capacity_exceeded' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
