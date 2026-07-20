import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { refetchFlags } from '../hooks/useFeatureFlag';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// Frozen copy of the retired theme.js BUTTON_BASE (this page was its last
// importer) — theme-brand's BUTTON_BASE is a pill (radius 9999, weight 800)
// and would restyle the login button. fontFamily is overridden at the use
// site (ADMIN_FONT), so it is omitted here.
const BUTTON_BASE = {
  borderRadius: 12,
  fontWeight: 700,
  fontSize: 14,
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.3s ease',
};
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', red: '#A83B34' };
const ADMIN_FONT = "'Roboto', Arial, sans-serif";

// Only honor same-origin relative redirect targets (block //host and schemes).
const isInternalPath = (p) => typeof p === 'string' && /^\/(?![/\\])/.test(p);

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event) => {
    event?.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login failed');
      if (data.user?.mustChangePassword) {
        localStorage.removeItem('waves_admin_token');
        localStorage.removeItem('waves_admin_user');
        try {
          await refetchFlags();
        } catch {
          // The server response already established the required reset path.
          // Flag availability must not strand the user on the login form.
        }
        navigate('/admin/forgot-password', {
          replace: true,
          state: { email: data.user.email, resetRequired: true },
        });
        return;
      }
      localStorage.setItem('waves_admin_token', data.token);
      localStorage.setItem('waves_admin_user', JSON.stringify(data.user));
      // Flag cache is keyed by user_id on the server and session-cached in
      // memory on the client. If this tab previously loaded flags (as a
      // different user, or token-less → fail-closed {}), that stale cache
      // will decide gated surfaces on the next render. Invalidate + refetch
      // with the new token before we navigate so flag reads see truth.
      try {
        await refetchFlags();
      } catch {
        // Authentication is already committed and stored. Feature flags fail
        // closed independently, so continue to the authenticated destination.
      }
      // Honor a ?next= return target (e.g. the tech entry point sends
      // ?next=/tech) so techs land in Field Tools rather than the admin-only
      // dashboard. Defaults to /admin for the normal admin sign-in.
      const next = searchParams.get('next');
      const techNext = isInternalPath(next)
        && (next === '/tech' || next.startsWith('/tech/'));
      const destination = data.user?.role === 'technician'
        ? (techNext ? next : '/tech')
        : (isInternalPath(next) ? next : '/admin');
      navigate(destination, { replace: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: ADMIN_FONT, padding: 20 }}>
      <div style={{ maxWidth: 400, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <div style={{ fontSize: 18, fontWeight: 800, color: D.white, fontFamily: ADMIN_FONT }}>Staff Portal</div>
          <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>Waves Pest Control Admin</div>
        </div>

        <form onSubmit={handleLogin} style={{ background: D.card, borderRadius: 16, padding: 28, border: `1px solid ${D.border}` }}>
          <label htmlFor="staff-email" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>Email address</label>
          <input id="staff-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" required
            style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: ADMIN_FONT, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box', marginBottom: 12 }}
            onFocus={e => e.target.style.borderColor = D.teal} onBlur={e => e.target.style.borderColor = D.border} />

          <label htmlFor="staff-password" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>Password</label>
          <input id="staff-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required
            style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: ADMIN_FONT, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box' }}
            onFocus={e => e.target.style.borderColor = D.teal} onBlur={e => e.target.style.borderColor = D.border} />

          {error && <div role="alert" style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: '#7f1d1d', color: '#fca5a5', fontSize: 14 }}>{error}</div>}

          <button type="submit" disabled={loading} style={{
            ...BUTTON_BASE, width: '100%', padding: 16, marginTop: 16, fontSize: 15, fontFamily: ADMIN_FONT,
            background: D.red, color: D.white, opacity: loading ? 0.7 : 1,
          }}>{loading ? 'Signing in...' : 'Sign In'}</button>

          <Link to="/admin/forgot-password" style={{ display: 'block', marginTop: 16, minHeight: 44, lineHeight: '44px', textAlign: 'center', fontSize: 14, color: D.teal, textDecoration: 'none' }}>
            Forgot password?
          </Link>
        </form>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <a href="/login" style={{ fontSize: 14, color: D.teal, textDecoration: 'none' }}>← Back to Customer Portal</a>
        </div>
      </div>
    </main>
  );
}
