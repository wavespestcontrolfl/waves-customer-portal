import { useLayoutEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { refetchFlags } from '../hooks/useFeatureFlag';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155', text: '#e2e8f0',
  muted: '#94a3b8', teal: '#0ea5e9', white: '#fff', red: '#A83B34',
};
const ADMIN_FONT = "'Roboto', Arial, sans-serif";

function resetTokenFromFragment() {
  const fragment = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(fragment).get('token') || '';
}

export default function AdminResetPasswordPage() {
  const navigate = useNavigate();
  const token = useMemo(resetTokenFromFragment, []);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Remove the one-time credential synchronously before the browser paints.
  // It remains only in component state long enough to submit the reset.
  useLayoutEffect(() => {
    if (!window.location.hash) return;
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    if (!token) {
      setError('This reset link is incomplete. Request a new one.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/admin/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Password reset failed');

      localStorage.setItem('waves_admin_token', data.token);
      localStorage.setItem('waves_admin_user', JSON.stringify(data.user));
      try {
        await refetchFlags();
      } catch {
        // Reset tokens are one-time credentials. Once the server commits the
        // reset, a flag refresh failure cannot safely be presented as though
        // the reset itself failed or leave the user on the consumed form.
      }
      navigate(
        data.user?.role === 'technician'
          ? '/tech'
          : '/admin/settings?passwordChanged=1',
        { replace: true },
      );
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
          <h1 style={{ fontSize: 22, margin: 0, color: D.white }}>Choose a new staff password</h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '8px 0 0' }}>
            Use at least 12 characters and three of: lowercase, uppercase, number, or symbol. Completing the reset signs out older sessions.
          </p>
        </div>

        <form onSubmit={submit} style={{ background: D.card, borderRadius: 16, padding: 28, border: `1px solid ${D.border}` }}>
          <label htmlFor="reset-new-password" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>New password</label>
          <input id="reset-new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: ADMIN_FONT, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }} />

          <label htmlFor="reset-confirm-password" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>Confirm new password</label>
          <input id="reset-confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: ADMIN_FONT, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box' }} />

          {error && <div role="alert" style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, background: '#7f1d1d', color: '#fca5a5', fontSize: 14 }}>{error}</div>}

          <button type="submit" disabled={loading || !token} style={{ width: '100%', minHeight: 48, marginTop: 18, border: 0, borderRadius: 10, background: D.red, color: D.white, fontSize: 15, fontWeight: 700, cursor: loading ? 'wait' : 'pointer', opacity: loading || !token ? 0.7 : 1 }}>
            {loading ? 'Resetting password…' : 'Reset password'}
          </button>

          {!token && (
            <Link to="/admin/forgot-password" style={{ display: 'block', minHeight: 44, lineHeight: '44px', marginTop: 12, textAlign: 'center', color: D.teal, fontSize: 14, textDecoration: 'none' }}>
              Request a new reset link
            </Link>
          )}
        </form>
      </div>
    </main>
  );
}
