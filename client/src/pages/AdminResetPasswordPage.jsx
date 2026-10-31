import { useLayoutEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { refetchFlags } from '../hooks/useFeatureFlag';
import { clearStaffDeviceData } from '../lib/adminAuth';
import {
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
    const sessionAtSubmit = localStorage.getItem('waves_admin_token');
    try {
      const response = await fetch(`${API_BASE}/admin/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Password reset failed');
      if (data.signInRequired) {
        // Two-step sign-in is on for this account: the reset link proves the
        // inbox only, so sign in with the new password and the app code. The
        // reset revoked the session this device held when it started, so that
        // one goes too, but never a newer sign-in another tab made meanwhile.
        if (localStorage.getItem('waves_admin_token') === sessionAtSubmit) {
          localStorage.removeItem('waves_admin_token');
          localStorage.removeItem('waves_admin_user');
          clearStaffDeviceData();
        }
        navigate('/admin/login', { replace: true, state: { passwordReset: true } });
        return;
      }

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
          ? '/admin/today'
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
    <main className="admin-auth-page" style={authPageStyle}>
      <div style={{ maxWidth: 440, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <h1 style={authTitleStyle}>Choose a new staff password</h1>
          <p style={authIntroStyle}>
            Use at least 12 characters and three of: lowercase, uppercase, number, or symbol. Completing the reset signs out older sessions.
          </p>
        </div>

        <form onSubmit={submit} style={authCardStyle}>
          <label htmlFor="reset-new-password" style={authLabelStyle}>New password</label>
          <input id="reset-new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required style={{ ...authInputStyle, marginBottom: 16 }} />

          <label htmlFor="reset-confirm-password" style={authLabelStyle}>Confirm new password</label>
          <input id="reset-confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required style={authInputStyle} />

          {error && <div role="alert" style={authErrorStyle}>{error}</div>}

          <button type="submit" disabled={loading || !token} style={{ ...authPrimaryButton(loading), opacity: loading || !token ? 0.7 : 1 }}>
            {loading ? 'Resetting password…' : 'Reset password'}
          </button>

          {!token && (
            <Link to="/admin/forgot-password" style={{ ...authLinkStyle, display: 'block', minHeight: 44, lineHeight: '44px', marginTop: 12, textAlign: 'center' }}>
              Request a new reset link
            </Link>
          )}
        </form>
      </div>
    </main>
  );
}
