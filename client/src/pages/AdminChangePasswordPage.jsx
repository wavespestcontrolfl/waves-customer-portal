import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { refetchFlags } from '../hooks/useFeatureFlag';
import {
  authCardStyle,
  authErrorStyle,
  authInputStyle,
  authIntroStyle,
  authLabelStyle,
  authPageStyle,
  authPrimaryButton,
  authTitleStyle,
} from '../components/admin/adminAuthStyles';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

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
          <h1 style={authTitleStyle}>Change your password</h1>
          <p style={authIntroStyle}>
            Use at least 12 characters and three of: lowercase, uppercase, number, or symbol. Your other staff sessions will be signed out.
          </p>
        </div>

        <form onSubmit={submit} style={authCardStyle}>
          <label htmlFor="current-password" style={authLabelStyle}>
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            style={{ ...authInputStyle, marginBottom: 16 }}
          />

          <label htmlFor="new-password" style={authLabelStyle}>
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
            style={{ ...authInputStyle, marginBottom: 16 }}
          />

          <label htmlFor="confirm-password" style={authLabelStyle}>
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
            style={authInputStyle}
          />

          {error && (
            <div role="alert" style={authErrorStyle}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={authPrimaryButton(loading)}
          >
            {loading ? 'Updating password…' : 'Update password'}
          </button>
        </form>
      </div>
    </main>
  );
}
