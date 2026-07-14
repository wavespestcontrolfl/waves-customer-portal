import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { refetchFlags } from '../hooks/useFeatureFlag';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  text: '#e2e8f0',
  muted: '#94a3b8',
  white: '#fff',
  red: '#A83B34',
};
const ADMIN_FONT = "'Roboto', Arial, sans-serif";

const inputStyle = {
  width: '100%',
  padding: '14px 16px',
  borderRadius: 10,
  border: `2px solid ${D.border}`,
  fontSize: 16,
  fontFamily: ADMIN_FONT,
  color: D.white,
  background: D.bg,
  outline: 'none',
  boxSizing: 'border-box',
};

export default function AdminChangePasswordPage() {
  const navigate = useNavigate();
  const token = localStorage.getItem('waves_admin_token');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!token) return <Navigate to="/admin/login" replace />;

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/admin/auth/change-password`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Password change failed');

      localStorage.setItem('waves_admin_token', data.token);
      localStorage.setItem('waves_admin_user', JSON.stringify(data.user));
      try {
        await refetchFlags();
      } catch {
        // The password is already committed and the replacement session is
        // stored. A transient flag refresh must not turn that success into a
        // misleading password-change failure or strand the user on this form.
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
    <main
      style={{
        minHeight: '100vh',
        background: D.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: ADMIN_FONT,
        padding: 20,
      }}
    >
      <div style={{ maxWidth: 440, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <h1 style={{ fontSize: 22, margin: 0, color: D.white }}>Change your password</h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '8px 0 0' }}>
            Use at least 12 characters and three of: lowercase, uppercase, number, or symbol. Your other staff sessions will be signed out.
          </p>
        </div>

        <form
          onSubmit={submit}
          style={{ background: D.card, borderRadius: 16, padding: 28, border: `1px solid ${D.border}` }}
        >
          <label htmlFor="current-password" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            style={{ ...inputStyle, marginBottom: 16 }}
          />

          <label htmlFor="new-password" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>
            New password
          </label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            style={{ ...inputStyle, marginBottom: 16 }}
          />

          <label htmlFor="confirm-password" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>
            Confirm new password
          </label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            style={inputStyle}
          />

          {error && (
            <div role="alert" style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, background: '#7f1d1d', color: '#fca5a5', fontSize: 14 }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              minHeight: 48,
              marginTop: 18,
              border: 0,
              borderRadius: 10,
              background: D.red,
              color: D.white,
              fontSize: 15,
              fontWeight: 700,
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Updating password…' : 'Update password'}
          </button>
        </form>
      </div>
    </main>
  );
}
