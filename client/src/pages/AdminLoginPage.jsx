import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FONTS, BUTTON_BASE } from '../theme';
import { refetchFlags } from '../hooks/useFeatureFlag';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', red: '#A83B34' };

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      localStorage.setItem('waves_admin_token', data.token);
      localStorage.setItem('waves_admin_user', JSON.stringify(data.user));
      // Flag cache is keyed by user_id on the server and session-cached in
      // memory on the client. If this tab previously loaded flags (as a
      // different user, or token-less → fail-closed {}), that stale cache
      // will decide gated surfaces on the next render. Invalidate + refetch
      // with the new token before we navigate so flag reads see truth.
      await refetchFlags();
      navigate('/admin', { replace: true });
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONTS.body, padding: 20 }}>
      <div style={{ maxWidth: 400, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <div style={{ fontSize: 18, fontWeight: 800, color: D.white, fontFamily: FONTS.heading }}>Staff Portal</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>Waves Pest Control Admin</div>
        </div>

        <div style={{ background: D.card, borderRadius: 16, padding: 28, border: `1px solid ${D.border}` }}>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address"
            style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: FONTS.body, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box', marginBottom: 12 }}
            onFocus={e => e.target.style.borderColor = D.teal} onBlur={e => e.target.style.borderColor = D.border} />

          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: FONTS.body, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box' }}
            onFocus={e => e.target.style.borderColor = D.teal} onBlur={e => e.target.style.borderColor = D.border} />

          {error && <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: '#7f1d1d', color: '#fca5a5', fontSize: 13 }}>{error}</div>}

          <button onClick={handleLogin} disabled={loading} style={{
            ...BUTTON_BASE, width: '100%', padding: 16, marginTop: 16, fontSize: 15,
            background: D.red, color: D.white, opacity: loading ? 0.7 : 1,
          }}>{loading ? 'Signing in...' : 'Sign In'}</button>
        </div>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <a href="/login" style={{ fontSize: 13, color: D.teal, textDecoration: 'none' }}>← Back to Customer Portal</a>
        </div>
      </div>
    </div>
  );
}
