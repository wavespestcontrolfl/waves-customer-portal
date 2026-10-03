import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { clearStaffDeviceData } from '../lib/adminAuth';
import { refetchFlags } from '../hooks/useFeatureFlag';

// Staff two-step sign-in (GATE_ADMIN_MFA): set up an authenticator app, make
// new recovery codes, replace the authenticator, or turn it off. Standalone
// like the change-password page, because GATE_ADMIN_MFA_ENFORCE holds an
// admin here (every other staff route answers 403) until setup is finished.

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  text: '#e2e8f0',
  muted: '#94a3b8',
  teal: '#0ea5e9',
  white: '#fff',
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
const labelStyle = { display: 'block', color: D.text, fontSize: 14, marginBottom: 6 };
const cardStyle = { background: D.card, borderRadius: 16, padding: 24, border: `1px solid ${D.border}`, marginBottom: 16 };
const primaryButton = (busy) => ({
  width: '100%',
  minHeight: 48,
  marginTop: 16,
  border: 0,
  borderRadius: 10,
  background: '#f4f4f5',
  color: '#18181B',
  fontSize: 15,
  fontWeight: 700,
  fontFamily: ADMIN_FONT,
  cursor: busy ? 'wait' : 'pointer',
  opacity: busy ? 0.7 : 1,
});
const linkButton = {
  display: 'block',
  width: '100%',
  minHeight: 44,
  marginTop: 8,
  background: 'none',
  border: 'none',
  color: D.teal,
  fontSize: 14,
  fontFamily: ADMIN_FONT,
  cursor: 'pointer',
};

function ErrorBox({ message }) {
  if (!message) return null;
  return (
    <div role="alert" style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8, background: '#7f1d1d', color: '#fca5a5', fontSize: 14 }}>
      {message}
    </div>
  );
}

function groupKey(secret) {
  return String(secret || '').match(/.{1,4}/g)?.join(' ') || '';
}

function destinationFor(user) {
  return user?.role === 'technician' ? '/admin/today' : '/admin';
}

export default function AdminTwoStepPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState(() => localStorage.getItem('waves_admin_token'));
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  // view: overview | setup | scan | codes
  const [view, setView] = useState('overview');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // The turn-off form has its own fields so typing in one overview form
  // never fills the other.
  const [offPassword, setOffPassword] = useState('');
  const [offCode, setOffCode] = useState('');
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [savedCodes, setSavedCodes] = useState(false);
  const [signedInUser, setSignedInUser] = useState(null);
  const [error, setError] = useState('');
  // Which overview form the error belongs to (regen | off).
  const [errorAt, setErrorAt] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${API_BASE}/admin/auth/mfa${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      localStorage.removeItem('waves_admin_token');
      localStorage.removeItem('waves_admin_user');
      clearStaffDeviceData();
      navigate('/admin/login', { replace: true });
      throw new Error(data.error || 'Sign in again.');
    }
    if (!response.ok) {
      const err = new Error(data.error || 'Something went wrong. Try again.');
      err.status = response.status;
      throw err;
    }
    return data;
  };

  const loadStatus = async () => {
    try {
      setStatus(await call(''));
      setLoadError('');
    } catch (err) {
      setLoadError(err.status === 404 ? 'Two-step sign-in is not turned on for Waves yet.' : err.message);
    }
  };

  useEffect(() => {
    if (token) loadStatus();
  }, []);

  useEffect(() => {
    if (!setup?.otpauthUrl) { setQr(''); return; }
    let cancelled = false;
    QRCode.toDataURL(setup.otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 220 })
      .then((url) => { if (!cancelled) setQr(url); })
      .catch(() => { if (!cancelled) setQr(''); });
    return () => { cancelled = true; };
  }, [setup]);

  if (!token) return <Navigate to="/admin/login" replace />;

  const resetForms = () => {
    setPassword('');
    setCode('');
    setOffPassword('');
    setOffCode('');
    setError('');
    setErrorAt('');
  };

  const startSetup = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await call('/totp/setup', {
        method: 'POST',
        body: { currentPassword: password, ...(status?.enabled ? { code: code.trim() } : {}) },
      });
      setSetup(data);
      setPassword('');
      setCode('');
      setView('scan');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await call('/totp/confirm', { method: 'POST', body: { code: code.trim() } });
      // This session passed the new code; keep it as the signed-in session.
      localStorage.setItem('waves_admin_token', data.token);
      localStorage.setItem('waves_admin_user', JSON.stringify(data.user));
      setToken(data.token);
      setSignedInUser(data.user);
      setRecoveryCodes(data.recoveryCodes || []);
      setSavedCodes(false);
      setSetup(null);
      setCode('');
      setView('codes');
      try { await refetchFlags(); } catch { /* flags fail closed */ }
    } catch (err) {
      setError(err.message);
      if (err.status === 409) setView('setup');
    } finally {
      setBusy(false);
    }
  };

  const newRecoveryCodes = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await call('/recovery-codes', { method: 'POST', body: { code: code.trim() } });
      setRecoveryCodes(data.recoveryCodes || []);
      setSavedCodes(false);
      setCode('');
      setView('codes');
    } catch (err) {
      setError(err.message);
      setErrorAt('regen');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (event) => {
    event.preventDefault();
    if (!window.confirm('Turn off two-step sign-in? Your account will be protected by its password alone.')) return;
    setBusy(true);
    setError('');
    try {
      await call('/disable', { method: 'POST', body: { currentPassword: offPassword, code: offCode.trim() } });
      resetForms();
      setNotice('Two-step sign-in is off.');
      setView('overview');
      await loadStatus();
    } catch (err) {
      setError(err.message);
      setErrorAt('off');
    } finally {
      setBusy(false);
    }
  };

  const finishCodes = async () => {
    setRecoveryCodes([]);
    setNotice('');
    if (signedInUser) {
      navigate(destinationFor(signedInUser), { replace: true });
      return;
    }
    setView('overview');
    await loadStatus();
  };

  const signOut = () => {
    localStorage.removeItem('waves_admin_token');
    localStorage.removeItem('waves_admin_user');
    clearStaffDeviceData();
    refetchFlags().catch(() => {});
    navigate('/admin/login', { replace: true });
  };

  const codesText = recoveryCodes.join('\n');
  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(codesText);
      setNotice('Recovery codes copied.');
    } catch {
      setNotice('Copy did not work here. Write the codes down or download them.');
    }
  };
  const downloadCodes = () => {
    const blob = new Blob([`Waves Pest Control staff recovery codes\nEach code works once.\n\n${codesText}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'waves-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const codeInput = (id, label, { allowRecovery = false, value = code, onChange = setCode } = {}) => (
    <>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode={allowRecovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={allowRecovery ? 19 : 7}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={allowRecovery ? '123456 or a recovery code' : '123456'}
        required
        style={{ ...inputStyle, letterSpacing: allowRecovery ? 1 : 4 }}
      />
    </>
  );

  const passwordInput = (id, { value = password, onChange = setPassword } = {}) => (
    <>
      <label htmlFor={id} style={labelStyle}>Current password</label>
      <input
        id={id}
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        style={{ ...inputStyle, marginBottom: 16 }}
      />
    </>
  );

  let body;
  if (loadError) {
    body = (
      <div style={cardStyle}>
        <p style={{ margin: 0, color: D.text, fontSize: 14, lineHeight: 1.5 }}>{loadError}</p>
        <Link to="/admin" style={{ ...linkButton, textAlign: 'center', lineHeight: '44px', textDecoration: 'none' }}>Back to Waves Admin</Link>
      </div>
    );
  } else if (!status) {
    body = <div style={{ ...cardStyle, color: D.muted, fontSize: 14 }}>Loading…</div>;
  } else if (view === 'codes') {
    body = (
      <div style={cardStyle}>
        <h2 style={{ fontSize: 18, margin: '0 0 6px', color: D.white }}>Save your recovery codes</h2>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '0 0 16px' }}>
          If you lose your phone, each of these codes signs you in once. They are shown only now. Keep them somewhere safe, away from your phone.
        </p>
        <ol style={{ margin: 0, padding: '14px 16px 14px 40px', background: D.bg, borderRadius: 10, border: `1px solid ${D.border}`, color: D.white, fontFamily: "'Roboto Mono', ui-monospace, monospace", fontSize: 16, lineHeight: 1.9 }}>
          {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
        </ol>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={copyCodes} style={{ ...linkButton, marginTop: 0, flex: 1, border: `1px solid ${D.border}`, borderRadius: 10 }}>Copy</button>
          <button type="button" onClick={downloadCodes} style={{ ...linkButton, marginTop: 0, flex: 1, border: `1px solid ${D.border}`, borderRadius: 10 }}>Download</button>
        </div>
        {notice && <p role="status" style={{ color: D.muted, fontSize: 14, margin: '10px 0 0' }}>{notice}</p>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, color: D.text, fontSize: 14, minHeight: 44 }}>
          <input type="checkbox" checked={savedCodes} onChange={(event) => setSavedCodes(event.target.checked)} style={{ width: 20, height: 20 }} />
          I saved these codes
        </label>
        <button type="button" disabled={!savedCodes} onClick={finishCodes} style={{ ...primaryButton(false), opacity: savedCodes ? 1 : 0.5, cursor: savedCodes ? 'pointer' : 'not-allowed' }}>
          Done
        </button>
      </div>
    );
  } else if (view === 'scan' && setup) {
    body = (
      <form onSubmit={confirmSetup} style={cardStyle}>
        <h2 style={{ fontSize: 18, margin: '0 0 6px', color: D.white }}>Scan with your authenticator app</h2>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '0 0 16px' }}>
          In Google Authenticator, Microsoft Authenticator, 1Password or a similar app, add an account and scan this code. Then enter the 6-digit code the app shows.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          {qr
            ? <img src={qr} alt="QR code for your authenticator app" width={220} height={220} style={{ borderRadius: 8, background: '#fff' }} />
            : <div style={{ width: 220, height: 220, borderRadius: 8, background: D.bg }} />}
        </div>
        <p style={{ fontSize: 14, color: D.muted, margin: '0 0 6px' }}>Can't scan? Enter this key in the app instead:</p>
        <div style={{ padding: '12px 14px', borderRadius: 10, background: D.bg, border: `1px solid ${D.border}`, color: D.white, fontFamily: "'Roboto Mono', ui-monospace, monospace", fontSize: 16, letterSpacing: 1, wordBreak: 'normal', overflowWrap: 'anywhere', marginBottom: 16, userSelect: 'all' }}>
          {groupKey(setup.secret)}
        </div>
        {codeInput('two-step-confirm-code', 'Code from the app')}
        <ErrorBox message={error} />
        <button type="submit" disabled={busy} style={primaryButton(busy)}>{busy ? 'Checking…' : 'Turn on two-step sign-in'}</button>
        <button type="button" onClick={() => { setSetup(null); resetForms(); setView(status.enabled ? 'overview' : 'setup'); }} style={{ ...linkButton, color: D.muted }}>Cancel</button>
      </form>
    );
  } else if (!status.enabled || view === 'setup') {
    const replacing = status.enabled;
    body = (
      <form onSubmit={startSetup} style={cardStyle}>
        <h2 style={{ fontSize: 18, margin: '0 0 6px', color: D.white }}>{replacing ? 'Replace your authenticator' : 'Set up two-step sign-in'}</h2>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '0 0 16px' }}>
          {replacing
            ? 'Use this when you get a new phone. Your old authenticator stops working once the new one is confirmed.'
            : 'After your password, Waves Admin will ask for a 6-digit code from an authenticator app on your phone. Confirm your password to start.'}
        </p>
        {passwordInput('two-step-setup-password')}
        {replacing && codeInput('two-step-setup-code', 'Code from your current authenticator', { allowRecovery: true })}
        <ErrorBox message={error} />
        <button type="submit" disabled={busy} style={primaryButton(busy)}>{busy ? 'Starting…' : 'Continue'}</button>
        {replacing && <button type="button" onClick={() => { resetForms(); setView('overview'); }} style={{ ...linkButton, color: D.muted }}>Cancel</button>}
      </form>
    );
  } else {
    body = (
      <>
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, margin: '0 0 6px', color: D.white }}>Two-step sign-in is on</h2>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: 0 }}>
            Signing in asks for a code from your authenticator app. {status.recoveryCodesRemaining} unused recovery {status.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left.
          </p>
          {notice && <p role="status" style={{ color: D.text, fontSize: 14, margin: '10px 0 0' }}>{notice}</p>}
          <button type="button" onClick={() => { resetForms(); setView('setup'); }} style={{ ...linkButton, textAlign: 'left', paddingLeft: 0 }}>Replace authenticator (new phone)</button>
        </div>
        <form onSubmit={newRecoveryCodes} style={cardStyle}>
          <h2 style={{ fontSize: 16, margin: '0 0 6px', color: D.white }}>New recovery codes</h2>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '0 0 16px' }}>Makes 10 new codes. Your old codes stop working.</p>
          {codeInput('two-step-regen-code', 'Code from your authenticator')}
          <ErrorBox message={errorAt === 'regen' ? error : ''} />
          <button type="submit" disabled={busy} style={primaryButton(busy)}>Make new codes</button>
        </form>
        {!status.enforced && (
          <form onSubmit={turnOff} style={cardStyle}>
            <h2 style={{ fontSize: 16, margin: '0 0 6px', color: D.white }}>Turn off</h2>
            {passwordInput('two-step-off-password', { value: offPassword, onChange: setOffPassword })}
            {codeInput('two-step-off-code', 'Code from your authenticator', { allowRecovery: true, value: offCode, onChange: setOffCode })}
            <ErrorBox message={errorAt === 'off' ? error : ''} />
            <button type="submit" disabled={busy} style={{ ...primaryButton(busy), background: 'transparent', color: D.text, border: `1px solid ${D.border}` }}>Turn off two-step sign-in</button>
          </form>
        )}
      </>
    );
  }

  return (
    <main className="admin-auth-page" style={{ background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: ADMIN_FONT }}>
      <div style={{ maxWidth: 440, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <h1 style={{ fontSize: 22, margin: 0, color: D.white }}>Two-step sign-in</h1>
          {status?.enrollmentRequired && view !== 'codes' && (
            <p style={{ fontSize: 14, lineHeight: 1.5, color: D.text, margin: '8px 0 0' }}>
              Your account needs two-step sign-in before Waves Admin opens.
            </p>
          )}
        </div>
        {body}
        <div style={{ textAlign: 'center' }}>
          {status?.enrollmentRequired && view !== 'codes'
            ? <button type="button" onClick={signOut} style={{ ...linkButton, color: D.muted }}>Sign out</button>
            : view === 'overview' && <Link to="/admin/settings" style={{ display: 'inline-block', minHeight: 44, lineHeight: '44px', fontSize: 14, color: D.teal, textDecoration: 'none' }}>Back to Settings</Link>}
        </div>
      </div>
    </main>
  );
}
