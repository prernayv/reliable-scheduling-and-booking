import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiClientError, api, formatWhen } from '../api';

type Booking = {
  status: string;
  startsAt: string;
  endsAt: string;
  guestName: string | null;
  eventName: string;
  hostName: string;
  hostTimezone: string;
  cancelReason: string | null;
};
type Slot = { startsAt: string; endsAt: string; remaining: number };

export function ManagePage() {
  const { token = '' } = useParams();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function loadBooking() {
    setBooking(await api<Booking>(`/api/bookings/${token}`));
  }

  useEffect(() => {
    loadBooking().catch((err) => setError(err instanceof ApiClientError ? err.message : 'Booking not found'));
  }, [token]);

  useEffect(() => {
    if (!booking || booking.status !== 'confirmed') return;
    const from = new Date();
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), tz });
    api<{ slots: Slot[] }>(`/api/bookings/${token}/slots?${params}`)
      .then((data) => setSlots(data.slots))
      .catch(() => setSlots([]));
  }, [booking?.status, booking?.startsAt, token, tz]);

  async function move(startsAt: string) {
    setError('');
    setMessage('');
    try {
      const next = await api<Booking>(`/api/bookings/${token}/reschedule`, { body: { startsAt } });
      setBooking(next);
      setMessage('Rescheduled.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not reschedule');
    }
  }

  async function cancel(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      setBooking(await api<Booking>(`/api/bookings/${token}/cancel`, { body: { reason } }));
      setMessage('Cancelled.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not cancel');
    }
  }

  if (!booking) {
    return (
      <main className="shell narrow">
        <p>{error || 'Loading booking…'}</p>
      </main>
    );
  }

  return (
    <main className="shell narrow">
      <p>
        <Link to="/">Slotbook</Link>
      </p>
      <h1>{booking.eventName}</h1>
      <p>
        {booking.guestName} with {booking.hostName}
      </p>
      <p>
        <strong>{booking.status}</strong> · {formatWhen(booking.startsAt, tz)} – {formatWhen(booking.endsAt, tz)}
      </p>
      <label>
        Show times in
        <select value={tz} onChange={(e) => setTz(e.target.value)}>
          {Intl.supportedValuesOf('timeZone').map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">Host timezone: {booking.hostTimezone}</p>
      {booking.cancelReason && <p>Reason: {booking.cancelReason}</p>}
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}
      {booking.status === 'confirmed' && (
        <>
          <section className="card">
            <h2>Move to another time</h2>
            <div className="slots">
              {slots
                .filter((slot) => slot.startsAt !== booking.startsAt)
                .slice(0, 24)
                .map((slot) => (
                  <button key={slot.startsAt} type="button" onClick={() => move(slot.startsAt)}>
                    {formatWhen(slot.startsAt, tz)}
                  </button>
                ))}
            </div>
            {slots.length === 0 && <p className="muted">No other open times.</p>}
          </section>
          <form className="card grid" onSubmit={cancel}>
            <h2>Cancel</h2>
            <label>
              Reason
              <input value={reason} onChange={(e) => setReason(e.target.value)} required />
            </label>
            <button className="danger" type="submit">
              Cancel booking
            </button>
          </form>
        </>
      )}
    </main>
  );
}
