import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiClientError, api, dayKey, dayLabel, formatTime } from '../api';

type Slot = { startsAt: string; endsAt: string; remaining: number };
type SlotsResponse = {
  hostName: string;
  hostTimezone: string;
  timezone: string;
  roundRobin?: boolean;
  full?: Slot[];
  event: {
    name: string;
    durationMin: number;
    capacity: number;
    minNoticeMin: number;
    horizonDays: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
  };
  slots: Slot[];
};
type Hold = { id: string; startsAt: string; endsAt: string; expiresAt: string; now: string };
type Confirmed = {
  manageUrl: string;
  startsAt: string;
  endsAt: string;
  guestName: string;
  calendarUrl?: string | null;
  assignedHostName?: string | null;
};

const zones = Intl.supportedValuesOf('timeZone');

export function BookPage({ embedded = false }: { embedded?: boolean }) {
  const { host = '', slug = '' } = useParams();
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [data, setData] = useState<SlotsResponse | null>(null);
  const [error, setError] = useState('');
  const [hold, setHold] = useState<Hold | null>(null);
  const [holdKey, setHoldKey] = useState<string | null>(null);
  const [leftMs, setLeftMs] = useState(0);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null);
  const [waitSlot, setWaitSlot] = useState<Slot | null>(null);
  const [waitNote, setWaitNote] = useState('');
  const [company, setCompany] = useState('');
  const holdRef = useRef<HTMLFormElement>(null);

  async function load(zone: string) {
    const from = new Date();
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      tz: zone,
    });
    const next = await api<SlotsResponse>(`/api/hosts/${host}/events/${slug}/slots?${params}`);
    setData(next);
  }

  useEffect(() => {
    let cancel = false;
    setError('');
    load(tz).catch((err) => {
      if (!cancel) setError(err instanceof ApiClientError ? err.message : 'Could not load times');
    });
    return () => {
      cancel = true;
    };
  }, [host, slug, tz]);

  useEffect(() => {
    document.title = data ? `Book ${data.event.name}` : 'Book a time';
  }, [data]);

  useEffect(() => {
    if (!embedded) return;
    const send = () => window.parent.postMessage({ type: 'slotbook-height', height: document.body.scrollHeight }, '*');
    send();
    const observer = new ResizeObserver(send);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [embedded, data, hold, confirmed, waitSlot, error]);

  useEffect(() => {
    if (hold) holdRef.current?.querySelector('input')?.focus();
  }, [hold?.id]);

  useEffect(() => {
    if (!hold) return;
    const total = Date.parse(hold.expiresAt) - Date.parse(hold.now);
    const started = performance.now();
    const tick = () => setLeftMs(total - (performance.now() - started));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [hold]);

  const groups = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const slot of data?.slots ?? []) {
      const key = dayKey(slot.startsAt, tz);
      const list = map.get(key) ?? [];
      list.push(slot);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [data, tz]);

  async function pick(slot: Slot) {
    setError('');
    setConfirmed(null);
    const key = crypto.randomUUID();
    setHoldKey(key);
    setPending(true);
    try {
      let last: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const next = await api<Hold>('/api/holds', {
            headers: { 'Idempotency-Key': key },
            body: { host, eventSlug: slug, startsAt: slot.startsAt, company },
          });
          setHold(next);
          await load(tz);
          return;
        } catch (err) {
          last = err;
          if (err instanceof ApiClientError && err.status !== 0) break;
        }
      }
      throw last;
    } catch (err) {
      setHold(null);
      setError(err instanceof ApiClientError ? err.message : 'Could not hold that time');
      load(tz).catch(() => undefined);
    } finally {
      setPending(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!hold || !holdKey) return;
    setPending(true);
    setError('');
    try {
      const booking = await api<{ manageUrl: string; startsAt: string; endsAt: string; guestName: string }>(
        `/api/holds/${hold.id}/confirm`,
        { body: { name, email, company } },
      );
      setConfirmed(booking);
      setHold(null);
      await load(tz);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not confirm');
      if (err instanceof ApiClientError && err.code === 'hold_expired') setHold(null);
      load(tz).catch(() => undefined);
    } finally {
      setPending(false);
    }
  }

  async function joinWaitlist(event: FormEvent) {
    event.preventDefault();
    if (!waitSlot) return;
    setPending(true);
    setError('');
    setWaitNote('');
    try {
      await api('/api/waitlist', {
        body: { host, eventSlug: slug, startsAt: waitSlot.startsAt, name, email, company },
      });
      setWaitNote('You are on the waitlist. If the seat opens, it is held for you for 5 minutes.');
      setWaitSlot(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not join the waitlist');
    } finally {
      setPending(false);
    }
  }

  const notice = data ? Math.round(data.event.minNoticeMin / 60) : 0;
  const fullGroups = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const slot of data?.full ?? []) {
      const key = dayKey(slot.startsAt, tz);
      const list = map.get(key) ?? [];
      list.push(slot);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [data, tz]);

  return (
    <main id="content" className="shell narrow">
      <a className="skip" href="#content">
        Skip to content
      </a>
      {!embedded && (
        <p>
          <Link to="/">Slotbook</Link>
        </p>
      )}
      <h1>{data?.event.name ?? slug}</h1>
      <p className="muted">
        {data ? (
          <>
            {data.event.durationMin} min with {data.hostName}
            {data.event.capacity > 1 ? ` · ${data.event.capacity} seats` : ''}
            {' · '}
            book at least {notice}h ahead, up to {data.event.horizonDays} days
            {(data.event.bufferBeforeMin > 0 || data.event.bufferAfterMin > 0) &&
              ` · buffer ${data.event.bufferBeforeMin}/${data.event.bufferAfterMin} min`}
            {data.roundRobin ? ' · round-robin: you meet whoever is free' : ''}
          </>
        ) : (
          'Loading times'
        )}
      </p>
      <label>
        Show times in
        <select value={tz} onChange={(e) => setTz(e.target.value)}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      {data && <p className="muted">Host works in {data.hostTimezone}. The booking itself is an absolute instant.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {waitNote && (
        <p className="ok" role="status">
          {waitNote}
        </p>
      )}
      {confirmed && (
        <div className="banner" role="status">
          <strong>You are booked, {confirmed.guestName}.</strong>
          <p>
            {formatTime(confirmed.startsAt, tz)}–{formatTime(confirmed.endsAt, tz)}
          </p>
          <p>
            Save this private link to view, reschedule, or cancel:{' '}
            <Link to={confirmed.manageUrl}>{confirmed.manageUrl}</Link>
          </p>
          {confirmed.calendarUrl && (
            <p>
              <a href={confirmed.calendarUrl}>Add to calendar</a>
              {confirmed.assignedHostName ? ` · meeting ${confirmed.assignedHostName}` : ''}
            </p>
          )}
        </div>
      )}
      {hold && (
        <form ref={holdRef} className="card grid" onSubmit={confirm} aria-labelledby="hold-title">
          <strong id="hold-title" aria-live="polite">
            Held for {Math.max(0, Math.ceil(leftMs / 1000))}s — {formatTime(hold.startsAt, tz)} to{' '}
            {formatTime(hold.endsAt, tz)}
          </strong>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label className="hp" aria-hidden="true">
            Company
            <input tabIndex={-1} autoComplete="off" value={company} onChange={(e) => setCompany(e.target.value)} />
          </label>
          <button type="submit" disabled={pending || leftMs <= 0}>
            Confirm booking
          </button>
        </form>
      )}
      {groups.length === 0 && data && <p>No open times in the next 30 days.</p>}
      {groups.map(([day, slots]) => (
        <section key={day} className="card">
          <h2>{dayLabel(slots[0].startsAt, tz)}</h2>
          <div className="slots">
            {slots.map((slot) => (
              <button
                key={slot.startsAt}
                type="button"
                aria-pressed={hold?.startsAt === slot.startsAt}
                disabled={pending}
                onClick={() => pick(slot)}
              >
                {formatTime(slot.startsAt, tz)}
                {data && data.event.capacity > 1 ? ` · ${slot.remaining} left` : ''}
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
