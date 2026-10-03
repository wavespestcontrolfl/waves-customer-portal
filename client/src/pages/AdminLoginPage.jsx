import { clearStaffDeviceData } from '../lib/adminAuth';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
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
// The retired /tech entry (with its one trailing slash before ?, # or the end)
// and the /admin paths a technician may be returned to.
const TECH_ENTRY = /^\/tech(?:\/(?=[?#]|$))?(?=[/?#]|$)/i;
const ADMIN_PATH = /^\/admin(?:[/?#]|$)/i;

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Two-step sign-in (GATE_ADMIN_MFA): the password step returns a short-lived
  // challenge instead of a session for an enrolled account.
  const [challengeToken, setChallengeToken] = useState('');
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

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
      if (data.mfaRequired && data.challengeToken) {
        setChallengeToken(data.challengeToken);
        setPassword('');
        setCode('');
        setUseRecoveryCode(false);
        return;
      }
      await completeSignIn(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCode = async (event) => {
    event?.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/admin/auth/login/mfa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, code: code.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      // An expired or no-longer-valid sign-in answers the generic 404: start
      // again at the password step.
      if (res.status === 404) {
        setChallengeToken('');
        setCode('');
        throw new Error('Your sign-in expired. Enter your email and password again.');
      }
      if (!res.ok) throw new Error(data.error || 'That code did not work');
      await completeSignIn(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const backToPassword = () => {
    setChallengeToken('');
    setCode('');
    setError('');
  };

  const completeSignIn = async (data) => {
    if (data.user?.mustChangePassword) {
      localStorage.removeItem('waves_admin_token');
      localStorage.removeItem('waves_admin_user');
      clearStaffDeviceData();
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
    if (data.user?.twoStep?.enrollmentRequired) {
      // GATE_ADMIN_MFA_ENFORCE: an admin with no authenticator sets one up
      // before anything else opens.
      clearStaffDeviceData();
      try { await refetchFlags(); } catch { /* flags fail closed */ }
      navigate('/admin/two-step', { replace: true });
      return;
    }
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
    // Honor a ?next= return target. Technicians default to their field
    // workspace inside Waves Admin (/admin/today): the retired /tech entry
    // points (?next=/tech/...) are rewritten to their /admin/today
    // equivalents, and any other target must be an /admin path (the
    // layout's role guard redirects a technician off an owner-only one, so
    // an internal /admin target is safe to honor here). Defaults to /admin
    // for the normal admin sign-in.
    const next = searchParams.get('next');
    const internalNext = isInternalPath(next) ? next : '';
    const techNext = internalNext.replace(TECH_ENTRY, '/admin/today');
    const destination = data.user?.role === 'technician'
      ? (ADMIN_PATH.test(techNext) ? techNext : '/admin/today')
      : (internalNext || '/admin');
    navigate(destination, { replace: true });
  };

  const inputStyle = { width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: ADMIN_FONT, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box' };

  return (
    <main className="admin-auth-page" style={{ background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: ADMIN_FONT }}>
      <div style={{ maxWidth: 400, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <div style={{ fontSize: 18, fontWeight: 800, color: D.white, fontFamily: ADMIN_FONT }}>Staff Portal</div>
          <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>Waves Pest Control Admin</div>
        </div>

        {location.state?.passwordReset && !challengeToken && (
          <div role="status" style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: D.card, border: `1px solid ${D.border}`, color: D.text, fontSize: 14 }}>
            Password updated. Sign in with your new password and your authenticator code.
          </div>
        )}
        {challengeToken ? (
          <form onSubmit={handleCode} style={{ background: D.card, borderRadius: 16, padding: 28, border: `1px solid ${D.border}` }}>
            <h1 style={{ fontSize: 18, margin: '0 0 6px', color: D.white }}>Two-step sign-in</h1>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '0 0 16px' }}>
              {useRecoveryCode
                ? 'Enter one of your saved recovery codes. Each code works once.'
                : 'Open your authenticator app and enter the 6-digit code for Waves Pest Control.'}
            </p>
            <label htmlFor="staff-mfa-code" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>
              {useRecoveryCode ? 'Recovery code' : 'Authentication code'}
            </label>
            {useRecoveryCode ? (
              <input id="staff-mfa-code" key="recovery" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" required autoFocus
                style={inputStyle}
                onFocus={e => e.target.style.borderColor = D.teal} onBlur={e => e.target.style.borderColor = D.border} />
            ) : (
              <input id="staff-mfa-code" key="totp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} value={code} onChange={e => setCode(e.target.value)} placeholder="123456" required autoFocus
                style={{ ...inputStyle, letterSpacing: 4 }}
                onFocus={e => e.target.style.borderColor = D.teal} onBlur={e => e.target.style.borderColor = D.border} />
            )}

            {error && <div role="alert" style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: '#7f1d1d', color: '#fca5a5', fontSize: 14 }}>{error}</div>}

            <button type="submit" disabled={loading} style={{
              ...BUTTON_BASE, width: '100%', padding: 16, marginTop: 16, fontSize: 15, fontFamily: ADMIN_FONT,
              background: '#f4f4f5', color: '#18181B', opacity: loading ? 0.7 : 1,
            }}>{loading ? 'Checking...' : 'Verify'}</button>

            <button type="button" onClick={() => { setUseRecoveryCode(v => !v); setCode(''); setError(''); }}
              style={{ display: 'block', width: '100%', marginTop: 12, minHeight: 44, background: 'none', border: 'none', fontSize: 14, color: D.teal, cursor: 'pointer', fontFamily: ADMIN_FONT }}>
              {useRecoveryCode ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
            </button>
            <button type="button" onClick={backToPassword}
              style={{ display: 'block', width: '100%', minHeight: 44, background: 'none', border: 'none', fontSize: 14, color: D.muted, cursor: 'pointer', fontFamily: ADMIN_FONT }}>
              Back to email and password
            </button>
          </form>
        ) : (
        <form onSubmit={handleLogin} style={{ background: D.card, borderRadius: 16, padding: 28, border: `1px solid ${D.border}` }}>
          <label htmlFor="staff-email" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>Email address</label>
          <input id="staff-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" required
            style={{ width: '100%', padding: '14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: ADMIN_FONT, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box', marginBottom: 12 }}
            onFocus={e => e.target.style.borderColor = D.teal} onBlur={e => e.target.style.borderColor = D.border} />

          <label htmlFor="staff-password" style={{ display: 'block', color: D.text, fontSize: 14, marginBottom: 6 }}>Password</label>
          <div style={{ position: 'relative' }}>
            <input id="staff-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required
              style={{ width: '100%', padding: '14px 48px 14px 16px', borderRadius: 10, border: `2px solid ${D.border}`, fontSize: 16, fontFamily: ADMIN_FONT, color: D.white, background: D.bg, outline: 'none', boxSizing: 'border-box' }}
              onFocus={e => e.target.style.borderColor = D.teal} onBlur={e => e.target.style.borderColor = D.border} />
            <button type="button" onClick={() => setShowPassword(s => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}
              style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: D.muted }}>
              {showPassword ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
            </button>
          </div>

          {error && <div role="alert" style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, background: '#7f1d1d', color: '#fca5a5', fontSize: 14 }}>{error}</div>}

          <button type="submit" disabled={loading} style={{
            ...BUTTON_BASE, width: '100%', padding: 16, marginTop: 16, fontSize: 15, fontFamily: ADMIN_FONT,
            background: '#f4f4f5', color: '#18181B', opacity: loading ? 0.7 : 1,
          }}>{loading ? 'Signing in...' : 'Sign In'}</button>

          <Link to="/admin/forgot-password" style={{ display: 'block', marginTop: 16, minHeight: 44, lineHeight: '44px', textAlign: 'center', fontSize: 14, color: D.teal, textDecoration: 'none' }}>
            Forgot password?
          </Link>
        </form>
        )}

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <a href="/login" style={{ fontSize: 14, color: D.teal, textDecoration: 'none' }}>← Back to Customer Portal</a>
        </div>
      </div>
    </main>
  );
}
