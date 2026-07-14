import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155', text: '#e2e8f0',
  muted: '#94a3b8', teal: '#0ea5e9', white: '#fff', red: '#A83B34',
};
const ADMIN_FONT = "'Roboto', Arial, sans-serif";

export default function AdminForgotPasswordPage() {
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email || '');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/admin/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not request a reset link');
      setSubmitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: ADMIN_FONT, padding: 20 }}>
      <div style={{ maxWidth: 440, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <h1 style={{ fontSize: 22, margin: 0, color: D.white }}>
            {location.state?.resetRequired ? 'Reset required' : 'Reset staff password'}
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '8px 0 0' }}>
            {location.state?.resetRequired
              ? 'This account needs a secure password reset before it can sign in.'
              : 'We will email a short-lived, one-time reset link to the staff address on file.'}
          </p>
        </div>

        <div style={{ background: D.card, borderRadius: 16, padding: 28, border: `1px solid ${D.border}` }}>
          {submitted ? (
            <div role="status" style={{ color: D.text, fontSize: 14, lineHeight: 1.6 }}>
              If that address belongs to an active staff account, a reset link is on its way. The link expires shortly and can be used once.
            </div>
          ) : (
            <form onSubmit={submit}>
              <label htmlFor="reset-email" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>
                Staff email address
              </label>
              <input
                id="reset-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: ADMIN_FONT, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box' }}
              />
              {error && (
                <div role="alert" style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, background: '#7f1d1d', color: '#fca5a5', fontSize: 14 }}>
                  {error}
                </div>
              )}
              <button type="submit" disabled={loading} style={{ width: '100%', minHeight: 48, marginTop: 18, border: 0, borderRadius: 10, background: D.red, color: D.white, fontSize: 15, fontWeight: 700, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.7 : 1 }}>
                {loading ? 'Sending reset link…' : 'Email reset link'}
              </button>
            </form>
          )}
          <Link to="/admin/login" style={{ display: 'block', minHeight: 44, lineHeight: '44px', marginTop: 12, textAlign: 'center', color: D.teal, fontSize: 14, textDecoration: 'none' }}>
            Back to staff sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
