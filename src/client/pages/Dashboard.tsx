import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiClientError, DAY_NAMES, api, formatWhen, minutesToTime, timeToMinutes } from '../api';

type Host = { name: string; slug: string; email: string; timezone: string };
type EventType = {
  id: string;
  name: string;
  slug: string;
  durationMin: number;
  capacity: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  horizonDays: number;
};
type Rule = { dayOfWeek: number; startMin: number; endMin: number };
type Override = { date: string; unavailable: boolean; windows: { startMin: number; endMin: number }[] };
type Booking = {
  id: string;
  startsAt: string;
  endsAt: string;
  guestName: string;
  guestEmail: string;
  eventName: string;
};
type Note = { id: string; kind: string; createdAt: string; payload: { guestEmail?: string; startsAt?: string; reason?: string } };

const emptyEvent = {
  name: '',
  slug: '',
  durationMin: 30,
  capacity: 1,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 60,
  horizonDays: 30,
};

export function DashboardPage() {
  const navigate = useNavigate();
  const [host, setHost] = useState<Host | null>(null);
  const [zone, setZone] = useState('');
  const [events, setEvents] = useState<EventType[]>([]);
  const [draft, setDraft] = useState(emptyEvent);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [overrideDate, setOverrideDate] = useState('');
  const [overrideOff, setOverrideOff] = useState(true);
  const [overrideStart, setOverrideStart] = useState('10:00');
  const [overrideEnd, setOverrideEnd] = useState('14:00');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function reload(current: Host) {
    const [eventRes, ruleRes, overrideRes, bookingRes, noteRes] = await Promise.all([
      api<{ events: EventType[] }>('/api/host/events'),
      api<{ rules: Rule[] }>('/api/host/availability'),
      api<{ overrides: Override[] }>('/api/host/overrides'),
      api<{ bookings: Booking[] }>('/api/host/bookings'),
      api<{ notifications: Note[] }>('/api/host/notifications'),
    ]);
    setEvents(eventRes.events);
    setRules(ruleRes.rules);
    setOverrides(overrideRes.overrides);
    setBookings(bookingRes.bookings);
    setNotes(noteRes.notifications);
    setZone(current.timezone);
  }

  useEffect(() => {
    api<Host>('/api/auth/me')
      .then(async (me) => {
        setHost(me);
        await reload(me);
      })
      .catch(() => navigate('/login'));
  }, [navigate]);

  async function run(action: () => Promise<void>) {
    setError('');
    setMessage('');
    try {
      await action();
      setMessage('Saved.');
      if (host) await reload(host);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Request failed');
    }
  }

  if (!host) return <main className="shell">Loading…</main>;

  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1>{host.name}</h1>
          <p className="muted">/{host.slug}</p>
        </div>
        <button
          className="secondary"
          onClick={async () => {
            await api('/api/auth/logout', { method: 'POST' });
            navigate('/');
          }}
        >
          Log out
        </button>
      </header>
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}

      <section className="card grid">
        <h2>Home timezone</h2>
        <p className="muted">Weekly hours are interpreted in this timezone. Existing bookings stay at the same universal instant.</p>
        <label>
          IANA timezone
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            {Intl.supportedValuesOf('timeZone').map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => run(() => api('/api/host/settings', { method: 'PATCH', body: { timezone: zone } }))}>
          Save timezone
        </button>
      </section>

      <section className="card">
        <h2>Event types</h2>
        <ul>
          {events.map((event) => (
            <li key={event.id}>
              <Link to={`/${host.slug}/${event.slug}`}>{event.name}</Link> · {event.durationMin} min · capacity{' '}
              {event.capacity} · /{host.slug}/{event.slug}{' '}
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setEditingId(event.id);
                  setDraft(event);
                }}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
        <form
          className="grid two"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              if (editingId) await api(`/api/host/events/${editingId}`, { method: 'PATCH', body: draft });
              else await api('/api/host/events', { body: draft });
              setDraft(emptyEvent);
              setEditingId(null);
            });
          }}
        >
          <label>
            Name
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
          </label>
          <label>
            Slug
            <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} required />
          </label>
          <label>
            Duration (min)
            <input
              type="number"
              min={15}
              max={120}
              value={draft.durationMin}
              onChange={(e) => setDraft({ ...draft, durationMin: Number(e.target.value) })}
            />
          </label>
          <label>
            Capacity
            <input
              type="number"
              min={1}
              value={draft.capacity}
              onChange={(e) => setDraft({ ...draft, capacity: Number(e.target.value) })}
            />
          </label>
          <label>
            Buffer before
            <input
              type="number"
              min={0}
              max={30}
              value={draft.bufferBeforeMin}
              onChange={(e) => setDraft({ ...draft, bufferBeforeMin: Number(e.target.value) })}
            />
          </label>
          <label>
            Buffer after
            <input
              type="number"
              min={0}
              max={30}
              value={draft.bufferAfterMin}
              onChange={(e) => setDraft({ ...draft, bufferAfterMin: Number(e.target.value) })}
            />
          </label>
          <label>
            Minimum notice (min)
            <input
              type="number"
              min={0}
              value={draft.minNoticeMin}
              onChange={(e) => setDraft({ ...draft, minNoticeMin: Number(e.target.value) })}
            />
          </label>
          <label>
            Horizon (days)
            <input
              type="number"
              min={1}
              max={365}
              value={draft.horizonDays}
              onChange={(e) => setDraft({ ...draft, horizonDays: Number(e.target.value) })}
            />
          </label>
          <button type="submit">{editingId ? 'Update event type' : 'Create event type'}</button>
        </form>
      </section>

      <section className="card">
        <h2>Weekly availability</h2>
        {DAY_NAMES.map((name, index) => {
          const day = index + 1;
          const windows = rules.filter((rule) => rule.dayOfWeek === day);
          return (
            <div key={day} style={{ marginBottom: '0.8rem' }}>
              <strong>{name}</strong>
              {windows.map((window, windowIndex) => (
                <div className="row" key={`${day}-${windowIndex}`}>
                  <label>
                    Start
                    <input
                      type="time"
                      value={minutesToTime(window.startMin)}
                      onChange={(e) => {
                        const next = rules.map((rule) =>
                          rule === window ? { ...rule, startMin: timeToMinutes(e.target.value) } : rule,
                        );
                        setRules(next);
                      }}
                    />
                  </label>
                  <label>
                    End
                    <input
                      type="time"
                      value={minutesToTime(window.endMin === 1440 ? 0 : window.endMin)}
                      onChange={(e) => {
                        const mins = timeToMinutes(e.target.value);
                        const next = rules.map((rule) =>
                          rule === window ? { ...rule, endMin: mins === 0 ? 1440 : mins } : rule,
                        );
                        setRules(next);
                      }}
                    />
                  </label>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setRules(rules.filter((rule) => rule !== window))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                className="secondary"
                type="button"
                onClick={() => setRules([...rules, { dayOfWeek: day, startMin: 540, endMin: 1020 }])}
              >
                Add window
              </button>
            </div>
          );
        })}
        <button onClick={() => run(() => api('/api/host/availability', { method: 'PUT', body: { rules } }))}>
          Save weekly hours
        </button>
      </section>

      <section className="card grid">
        <h2>Date overrides</h2>
        <ul>
          {overrides.map((item) => (
            <li key={item.date}>
              {item.date}: {item.unavailable ? 'day off' : item.windows.map((w) => `${minutesToTime(w.startMin)}–${minutesToTime(w.endMin)}`).join(', ')}{' '}
              <button className="secondary" type="button" onClick={() => run(() => api(`/api/host/overrides/${item.date}`, { method: 'DELETE' }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <label>
            Date
            <input type="date" value={overrideDate} onChange={(e) => setOverrideDate(e.target.value)} />
          </label>
          <label>
            <span>Day off</span>
            <input type="checkbox" checked={overrideOff} onChange={(e) => setOverrideOff(e.target.checked)} />
          </label>
        </div>
        {!overrideOff && (
          <div className="row">
            <label>
              Start
              <input type="time" value={overrideStart} onChange={(e) => setOverrideStart(e.target.value)} />
            </label>
            <label>
              End
              <input type="time" value={overrideEnd} onChange={(e) => setOverrideEnd(e.target.value)} />
            </label>
          </div>
        )}
        <button
          onClick={() =>
            run(() =>
              api(`/api/host/overrides/${overrideDate}`, {
                method: 'PUT',
                body: overrideOff
                  ? { unavailable: true, windows: [] }
                  : {
                      unavailable: false,
                      windows: [{ startMin: timeToMinutes(overrideStart), endMin: timeToMinutes(overrideEnd) }],
                    },
              }),
            )
          }
        >
          Save override
        </button>
      </section>

      <section className="card">
        <h2>Upcoming bookings</h2>
        {bookings.length === 0 && <p className="muted">None yet.</p>}
        <table>
          <tbody>
            {bookings.map((booking) => (
              <tr key={booking.id}>
                <td>
                  {formatWhen(booking.startsAt, host.timezone)}
                  <div className="muted">{booking.eventName}</div>
                </td>
                <td>
                  {booking.guestName}
                  <div className="muted">{booking.guestEmail}</div>
                </td>
                <td>
                  <div className="row">
                    <input
                      placeholder="Reason"
                      value={reasons[booking.id] ?? ''}
                      onChange={(e) => setReasons({ ...reasons, [booking.id]: e.target.value })}
                    />
                    <button
                      className="danger"
                      onClick={() =>
                        run(() =>
                          api(`/api/host/bookings/${booking.id}/cancel`, {
                            body: { reason: reasons[booking.id] ?? '' },
                          }),
                        )
                      }
                    >
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Notification sink</h2>
        {notes.length === 0 && <p className="muted">Confirms, reschedules, and cancellations land here.</p>}
        <ul>
          {notes.map((note) => (
            <li key={note.id}>
              <code>{note.kind}</code> · {formatWhen(note.createdAt, host.timezone)} · {note.payload.guestEmail}
              {note.payload.reason ? ` · ${note.payload.reason}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
