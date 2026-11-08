import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiClientError, api } from '../api';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('demo@slotbook.dev');
  const [password, setPassword] = useState('demo-password');
  const [error, setError] = useState('');

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/auth/login', { body: { email, password } });
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not log in');
    }
  }

  return (
    <main className="shell narrow">
      <h1>Host login</h1>
      <form className="card grid" onSubmit={onSubmit}>
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit">Log in</button>
      </form>
      <p>
        <Link to="/">Back</Link>
      </p>
    </main>
  );
}
