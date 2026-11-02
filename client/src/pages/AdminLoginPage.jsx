import { clearStaffDeviceData } from '../lib/adminAuth';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { refetchFlags } from '../hooks/useFeatureFlag';
import {
  fetchGoogleSignInEnabled,
  finishGoogleSignIn,
  googleSignInMessage,
  googleSignInWorksHere,
  readGoogleRedirect,
  startGoogleSignIn,
} from '../native/wavesAdminGoogleSignIn';
import {
  AUTH,
  authCardStyle,
  authErrorStyle,
  authInputStyle,
  authLabelStyle,
  authLinkStyle,
  authNoticeStyle,
  authPageStyle,
  authPrimaryButton,
} from '../components/admin/adminAuthStyles';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Only honor same-origin relative redirect targets (block //host and schemes).
const isInternalPath = (p) => typeof p === 'string' && /^\/(?![/\\])/.test(p);
// The retired /tech entry (with its one trailing slash before ?, # or the end)
// and the /admin paths a technician may be returned to.
const TECH_ENTRY = /^\/tech(?:\/(?=[?#]|$))?(?=[/?#]|$)/i;
const ADMIN_PATH = /^\/admin(?:[/?#]|$)/i;

function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

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
  // Sign in with Google (GATE_STAFF_GOOGLE_SIGNIN): shown only when the server
  // says it is on and this browser or app version can run it.
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const googleRedirectHandled = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (googleSignInWorksHere()) {
      fetchGoogleSignInEnabled().then((enabled) => { if (!cancelled) setGoogleEnabled(enabled); });
    }
    return () => { cancelled = true; };
  }, []);

  // Back from Google: the callback left a one-time result in the hash.
  useEffect(() => {
    if (googleRedirectHandled.current) return;
    const outcome = readGoogleRedirect(location.hash);
    if (!outcome) return;
    googleRedirectHandled.current = true;
    navigate(`/admin/login${outcome.next ? `?next=${encodeURIComponent(outcome.next)}` : ''}`, { replace: true });
    handleGoogleOutcome(outcome);
    // Mount-only: it runs once, on the page the callback opened.
  }, []);

  const handleGoogleOutcome = async (outcome) => {
    if (outcome.error) {
      setError(googleSignInMessage(outcome.error));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await finishGoogleSignIn(outcome.result);
      if (data.error) throw new Error(googleSignInMessage(data.error));
      // A Google sign-in never asks for the authenticator code (owner
      // 2026-11-02): /google/finish answers with the session itself.
      await completeSignIn(data, { next: outcome.next });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    setError('');
    const outcome = await startGoogleSignIn({ next: searchParams.get('next') });
    // null: the browser is on its way to Google.
    if (!outcome) return;
    setLoading(false);
    await handleGoogleOutcome({ ...outcome, next: searchParams.get('next') });
  };

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
      await completeSignIn(data, { viaTwoStep: true });
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

  const completeSignIn = async (data, { viaTwoStep = false, next: nextTarget } = {}) => {
    // A two-step sign-in (possibly with the last recovery code) keeps its
    // session for the signed-in change-password page, which carries the
    // recovery window over; the email reset would revoke it.
    const keepForChange = viaTwoStep && Boolean(data.token);
    if (data.user?.mustChangePassword && !keepForChange) {
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
    // A forced password change (kept two-step session) or, under
    // GATE_ADMIN_MFA_ENFORCE, an admin with no authenticator: that page first.
    const user = data.user || {};
    const holdingPage = [
      [user.mustChangePassword, '/admin/change-password'],
      [user.twoStep && user.twoStep.enrollmentRequired, '/admin/two-step'],
    ].find(([applies]) => applies)?.[1];
    if (holdingPage) {
      clearStaffDeviceData();
      try { await refetchFlags(); } catch { /* flags fail closed */ }
      navigate(holdingPage, { replace: true });
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
    // A Google sign-in carries the ?next= its starting page had.
    const next = nextTarget === undefined ? searchParams.get('next') : nextTarget;
    const internalNext = isInternalPath(next) ? next : '';
    const techNext = internalNext.replace(TECH_ENTRY, '/admin/today');
    const destination = data.user?.role === 'technician'
      ? (ADMIN_PATH.test(techNext) ? techNext : '/admin/today')
      : (internalNext || '/admin');
    navigate(destination, { replace: true });
  };

  return (
    <main className="admin-auth-page" style={authPageStyle}>
      <div style={{ maxWidth: 400, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <div style={{ fontSize: 18, fontWeight: 500, color: AUTH.text }}>Staff Portal</div>
          <div style={{ fontSize: 14, color: AUTH.muted, marginTop: 4 }}>Waves Pest Control Admin</div>
        </div>

        {location.state?.passwordReset && !challengeToken && (
          <div role="status" style={authNoticeStyle}>
            Password updated. Sign in with your new password and your authenticator code.
          </div>
        )}
        {challengeToken ? (
          <form onSubmit={handleCode} style={authCardStyle}>
            <h1 style={{ fontSize: 18, fontWeight: 500, margin: '0 0 6px', color: AUTH.text }}>Two-step sign-in</h1>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: AUTH.muted, margin: '0 0 16px' }}>
              {useRecoveryCode
                ? 'Enter one of your saved recovery codes. Each code works once.'
                : 'Open your authenticator app and enter the 6-digit code for Waves Pest Control.'}
            </p>
            <label htmlFor="staff-mfa-code" style={authLabelStyle}>
              {useRecoveryCode ? 'Recovery code' : 'Authentication code'}
            </label>
            {useRecoveryCode ? (
              <input id="staff-mfa-code" key="recovery" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" required autoFocus
                style={authInputStyle} />
            ) : (
              <input id="staff-mfa-code" key="totp" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} value={code} onChange={e => setCode(e.target.value)} placeholder="123456" required autoFocus
                style={{ ...authInputStyle, letterSpacing: 4 }} />
            )}

            {error && <div role="alert" style={{ ...authErrorStyle, marginTop: 12 }}>{error}</div>}

            <button type="submit" disabled={loading} style={{ ...authPrimaryButton(loading), marginTop: 16 }}>{loading ? 'Checking...' : 'Verify'}</button>

            <button type="button" onClick={() => { setUseRecoveryCode(v => !v); setCode(''); setError(''); }}
              style={{ ...authLinkStyle, display: 'block', width: '100%', marginTop: 12, minHeight: 44, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              {useRecoveryCode ? 'Use my authenticator app instead' : 'Use a recovery code instead'}
            </button>
            <button type="button" onClick={backToPassword}
              style={{ ...authLinkStyle, color: AUTH.muted, display: 'block', width: '100%', minHeight: 44, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              Back to email and password
            </button>
          </form>
        ) : (
        <>
        {googleEnabled && (
          <div style={{ ...authCardStyle, marginBottom: 12 }}>
            <button type="button" onClick={handleGoogle} disabled={loading}
              style={{ width: '100%', minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, background: '#fff', color: '#1f1f1f', border: '1px solid #747775', borderRadius: 8, fontSize: 16, fontWeight: 500, fontFamily: 'inherit', cursor: loading ? 'default' : 'pointer' }}>
              <GoogleMark />
              Sign in with Google
            </button>
            <p style={{ fontSize: 14, color: AUTH.muted, textAlign: 'center', margin: '10px 0 0' }}>Use your company Google account.</p>
          </div>
        )}
        {googleEnabled && (
          <p style={{ fontSize: 14, color: AUTH.muted, textAlign: 'center', margin: '0 0 12px' }}>or sign in with email and password</p>
        )}
        <form onSubmit={handleLogin} style={authCardStyle}>
          <label htmlFor="staff-email" style={authLabelStyle}>Email address</label>
          <input id="staff-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address" required
            style={{ ...authInputStyle, marginBottom: 12 }} />

          <label htmlFor="staff-password" style={authLabelStyle}>Password</label>
          <div style={{ position: 'relative' }}>
            <input id="staff-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" required
              style={{ ...authInputStyle, paddingRight: 48 }} />
            <button type="button" onClick={() => setShowPassword(s => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}
              style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: AUTH.muted }}>
              {showPassword ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
            </button>
          </div>

          {error && <div role="alert" style={{ ...authErrorStyle, marginTop: 12 }}>{error}</div>}

          <button type="submit" disabled={loading} style={{ ...authPrimaryButton(loading), marginTop: 16 }}>{loading ? 'Signing in...' : 'Sign In'}</button>

          <Link to="/admin/forgot-password" style={{ ...authLinkStyle, display: 'block', marginTop: 16, minHeight: 44, lineHeight: '44px', textAlign: 'center' }}>
            Forgot password?
          </Link>
        </form>
        </>
        )}

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <a href="/login" style={{ ...authLinkStyle, color: AUTH.muted }}>← Back to Customer Portal</a>
        </div>
      </div>
    </main>
  );
}
