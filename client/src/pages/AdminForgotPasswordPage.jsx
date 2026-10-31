import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  AUTH,
  authCardStyle,
  authErrorStyle,
  authInputStyle,
  authIntroStyle,
  authLabelStyle,
  authLinkStyle,
  authPageStyle,
  authPrimaryButton,
  authTitleStyle,
} from '../components/admin/adminAuthStyles';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

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
    <main className="admin-auth-page" style={authPageStyle}>
      <div style={{ maxWidth: 440, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <h1 style={authTitleStyle}>
            {location.state?.resetRequired ? 'Reset required' : 'Reset staff password'}
          </h1>
          <p style={authIntroStyle}>
            {location.state?.resetRequired
              ? 'This account needs a secure password reset before it can sign in.'
              : 'We will email a short-lived, one-time reset link to the staff address on file.'}
          </p>
        </div>

        <div style={authCardStyle}>
          {submitted ? (
            <div role="status" style={{ color: AUTH.text, fontSize: 14, lineHeight: 1.6 }}>
              If that address belongs to an active staff account, a reset link is on its way. The link expires shortly and can be used once.
            </div>
          ) : (
            <form onSubmit={submit}>
              <label htmlFor="reset-email" style={authLabelStyle}>
                Staff email address
              </label>
              <input
                id="reset-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                style={authInputStyle}
              />
              {error && (
                <div role="alert" style={authErrorStyle}>
                  {error}
                </div>
              )}
              <button type="submit" disabled={loading} style={authPrimaryButton(loading)}>
                {loading ? 'Sending reset link…' : 'Email reset link'}
              </button>
            </form>
          )}
          <Link to="/admin/login" style={{ ...authLinkStyle, display: 'block', minHeight: 44, lineHeight: '44px', marginTop: 12, textAlign: 'center' }}>
            Back to staff sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
