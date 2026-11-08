import { Link } from 'react-router-dom';

export function HomePage() {
  return (
    <main className="shell narrow">
      <h1>Slotbook</h1>
      <p className="muted">
        Hosts publish when they are free. Guests book a slot. A seat is held, confirmed, or released — and it is never given out twice.
      </p>
      <div className="card grid">
        <div>
          <strong>Demo host</strong>
          <p className="muted">Asia/Kolkata · weekdays 09:00–12:00 and 13:00–17:00</p>
          <p>
            <Link to="/demo/intro">Intro call</Link>
            {' · '}
            <Link to="/demo/workshop">Group workshop</Link>
          </p>
        </div>
        <div>
          <Link to="/login">Host login</Link>
          <p className="muted">
            <code>demo@slotbook.dev</code> / <code>demo-password</code>
          </p>
        </div>
      </div>
    </main>
  );
}
