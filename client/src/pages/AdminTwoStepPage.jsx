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

function CodeField({ id, label, value, onChange, allowRecovery = false }) {
  return (
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
}

function PasswordField({ id, value, onChange }) {
  return (
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
}

const headingStyle = { fontSize: 18, margin: '0 0 6px', color: D.white };
const introStyle = { fontSize: 14, lineHeight: 1.5, color: D.muted, margin: '0 0 16px' };
const monoBox = { background: D.bg, borderRadius: 10, border: `1px solid ${D.border}`, color: D.white, fontFamily: "'Roboto Mono', ui-monospace, monospace", fontSize: 16 };
const outlineButton = { ...linkButton, marginTop: 0, flex: 1, border: `1px solid ${D.border}`, borderRadius: 10 };

// Shown once after setup or regeneration; the codes live only in this state.
function RecoveryCodesCard({ codes, onDone }) {
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState('');
  const text = codes.join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Recovery codes copied.');
    } catch {
      setNotice('Copy did not work here. Write the codes down or download them.');
    }
  };
  const download = () => {
    const blob = new Blob([`Waves Pest Control staff recovery codes\nEach code works once.\n\n${text}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'waves-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div style={cardStyle}>
      <h2 style={headingStyle}>Save your recovery codes</h2>
      <p style={introStyle}>
        If you lose your phone, each of these codes signs you in once. They are shown only now. Keep them somewhere safe, away from your phone.
      </p>
      <ol style={{ ...monoBox, margin: 0, padding: '14px 16px 14px 40px', lineHeight: 1.9 }}>
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={copy} style={outlineButton}>Copy</button>
        <button type="button" onClick={download} style={outlineButton}>Download</button>
      </div>
      {notice && <p role="status" style={{ color: D.muted, fontSize: 14, margin: '10px 0 0' }}>{notice}</p>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, color: D.text, fontSize: 14, minHeight: 44 }}>
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} style={{ width: 20, height: 20 }} />
        I saved these codes
      </label>
      <button type="button" disabled={!saved} onClick={onDone} style={{ ...primaryButton(false), opacity: saved ? 1 : 0.5, cursor: saved ? 'pointer' : 'not-allowed' }}>
        Done
      </button>
    </div>
  );
}

function ScanCard({ setup, code, setCode, error, busy, onSubmit, onCancel }) {
  const [qr, setQr] = useState('');
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(setup.otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 220 })
      .then((url) => { if (!cancelled) setQr(url); })
      .catch(() => { if (!cancelled) setQr(''); });
    return () => { cancelled = true; };
  }, [setup]);
  return (
    <form onSubmit={onSubmit} style={cardStyle}>
      <h2 style={headingStyle}>Scan with your authenticator app</h2>
      <p style={introStyle}>
        In Google Authenticator, Microsoft Authenticator, 1Password or a similar app, add an account and scan this code. Then enter the 6-digit code the app shows.
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        {qr
          ? <img src={qr} alt="QR code for your authenticator app" width={220} height={220} style={{ borderRadius: 8, background: '#fff' }} />
          : <div style={{ width: 220, height: 220, borderRadius: 8, background: D.bg }} />}
      </div>
      <p style={{ fontSize: 14, color: D.muted, margin: '0 0 6px' }}>Can't scan? Enter this key in the app instead:</p>
      <div style={{ ...monoBox, padding: '12px 14px', letterSpacing: 1, wordBreak: 'normal', overflowWrap: 'anywhere', marginBottom: 16, userSelect: 'all' }}>
        {groupKey(setup.secret)}
      </div>
      <CodeField id="two-step-confirm-code" label="Code from the app" value={code} onChange={setCode} />
      <ErrorBox message={error} />
      <button type="submit" disabled={busy} style={primaryButton(busy)}>{busy ? 'Checking…' : 'Turn on two-step sign-in'}</button>
      <button type="button" onClick={onCancel} style={{ ...linkButton, color: D.muted }}>Cancel</button>
    </form>
  );
}

const SETUP_COPY = {
  first: {
    title: 'Set up two-step sign-in',
    intro: 'After your password, Waves Admin will ask for a 6-digit code from an authenticator app on your phone. Confirm your password to start.',
  },
  replace: {
    title: 'Replace your authenticator',
    intro: 'Use this when you get a new phone. Your old authenticator stops working once the new one is confirmed.',
  },
};

function SetupCard({ replacing, form, setField, error, busy, onSubmit, onCancel }) {
  const copy = SETUP_COPY[replacing ? 'replace' : 'first'];
  return (
    <form onSubmit={onSubmit} style={cardStyle}>
      <h2 style={headingStyle}>{copy.title}</h2>
      <p style={introStyle}>{copy.intro}</p>
      <PasswordField id="two-step-setup-password" value={form.password} onChange={setField('password')} />
      {replacing && <CodeField id="two-step-setup-code" label="Code from your current authenticator" allowRecovery value={form.code} onChange={setField('code')} />}
      <ErrorBox message={error} />
      <button type="submit" disabled={busy} style={primaryButton(busy)}>{busy ? 'Starting…' : 'Continue'}</button>
      {replacing && <button type="button" onClick={onCancel} style={{ ...linkButton, color: D.muted }}>Cancel</button>}
    </form>
  );
}

function OverviewCards({ status, notice, form, setField, errorFor, busy, onReplace, onRegenerate, onTurnOff }) {
  const remaining = status.recoveryCodesRemaining;
  return (
    <>
      <div style={cardStyle}>
        <h2 style={headingStyle}>Two-step sign-in is on</h2>
        <p style={{ ...introStyle, margin: 0 }}>
          Signing in asks for a code from your authenticator app. {remaining} unused recovery {remaining === 1 ? 'code' : 'codes'} left.
        </p>
        {notice && <p role="status" style={{ color: D.text, fontSize: 14, margin: '10px 0 0' }}>{notice}</p>}
        <button type="button" onClick={onReplace} style={{ ...linkButton, textAlign: 'left', paddingLeft: 0 }}>Replace authenticator (new phone)</button>
      </div>
      <form onSubmit={onRegenerate} style={cardStyle}>
        <h2 style={{ ...headingStyle, fontSize: 16 }}>New recovery codes</h2>
        <p style={introStyle}>Makes 10 new codes. Your old codes stop working.</p>
        <CodeField id="two-step-regen-code" label="Code from your authenticator" value={form.code} onChange={setField('code')} />
        <ErrorBox message={errorFor('regen')} />
        <button type="submit" disabled={busy} style={primaryButton(busy)}>Make new codes</button>
      </form>
      {!status.enforced && (
        <form onSubmit={onTurnOff} style={cardStyle}>
          <h2 style={{ ...headingStyle, fontSize: 16 }}>Turn off</h2>
          <PasswordField id="two-step-off-password" value={form.offPassword} onChange={setField('offPassword')} />
          <CodeField id="two-step-off-code" label="Code from your authenticator" allowRecovery value={form.offCode} onChange={setField('offCode')} />
          <ErrorBox message={errorFor('off')} />
          <button type="submit" disabled={busy} style={{ ...primaryButton(busy), background: 'transparent', color: D.text, border: `1px solid ${D.border}` }}>Turn off two-step sign-in</button>
        </form>
      )}
    </>
  );
}

const EMPTY_FORM = { password: '', code: '', offPassword: '', offCode: '' };

export default function AdminTwoStepPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState(() => localStorage.getItem('waves_admin_token'));
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  // view: overview | setup | scan | codes
  const [view, setView] = useState('overview');
  // The turn-off form has its own fields so typing in one form never fills another.
  const [form, setForm] = useState(EMPTY_FORM);
  const [setup, setSetup] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [signedInUser, setSignedInUser] = useState(null);
  // The error and the form it belongs to (setup | scan | regen | off).
  const [failure, setFailure] = useState({ at: '', message: '' });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const setField = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const errorFor = (at) => (failure.at === at ? failure.message : '');
  const show = (next) => {
    setForm(EMPTY_FORM);
    setFailure({ at: '', message: '' });
    setView(next);
  };

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
    // Only an authentication failure ends the session; a wrong code is a 400.
    if (response.status === 401) {
      localStorage.removeItem('waves_admin_token');
      localStorage.removeItem('waves_admin_user');
      clearStaffDeviceData();
      navigate('/admin/login', { replace: true });
      throw new Error(data.error || 'Sign in again.');
    }
    if (!response.ok) {
      throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: response.status });
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

  if (!token) return <Navigate to="/admin/login" replace />;

  // One submit path for every form: busy state, and the error kept with the
  // form that raised it.
  const submit = (at, action) => async (event) => {
    event.preventDefault();
    setBusy(true);
    setFailure({ at: '', message: '' });
    try {
      await action();
    } catch (err) {
      setFailure({ at, message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const startSetup = submit('setup', async () => {
    const data = await call('/totp/setup', {
      method: 'POST',
      body: { currentPassword: form.password, ...(status.enabled ? { code: form.code.trim() } : {}) },
    });
    setSetup(data);
    show('scan');
  });

  const confirmSetup = submit('scan', async () => {
    let data;
    try {
      data = await call('/totp/confirm', { method: 'POST', body: { code: form.code.trim() } });
    } catch (err) {
      if (err.status === 409) show('setup');
      throw err;
    }
    // The server signed out every earlier session; this one continues on the
    // fresh two-step token.
    localStorage.setItem('waves_admin_token', data.token);
    localStorage.setItem('waves_admin_user', JSON.stringify(data.user));
    setToken(data.token);
    setSignedInUser(data.user);
    setRecoveryCodes(data.recoveryCodes || []);
    setSetup(null);
    show('codes');
    try { await refetchFlags(); } catch { /* flags fail closed */ }
  });

  const newRecoveryCodes = submit('regen', async () => {
    const data = await call('/recovery-codes', { method: 'POST', body: { code: form.code.trim() } });
    setRecoveryCodes(data.recoveryCodes || []);
    show('codes');
  });

  const turnOff = async (event) => {
    if (!window.confirm('Turn off two-step sign-in? Your account will be protected by its password alone.')) {
      event.preventDefault();
      return;
    }
    await submit('off', async () => {
      await call('/disable', { method: 'POST', body: { currentPassword: form.offPassword, code: form.offCode.trim() } });
      show('overview');
      setNotice('Two-step sign-in is off.');
      await loadStatus();
    })(event);
  };

  const finishCodes = async () => {
    setRecoveryCodes([]);
    setNotice('');
    if (signedInUser) {
      navigate(destinationFor(signedInUser), { replace: true });
      return;
    }
    show('overview');
    await loadStatus();
  };

  const signOut = () => {
    localStorage.removeItem('waves_admin_token');
    localStorage.removeItem('waves_admin_user');
    clearStaffDeviceData();
    refetchFlags().catch(() => {});
    navigate('/admin/login', { replace: true });
  };

  const renderBody = () => {
    if (loadError) {
      return (
        <div style={cardStyle}>
          <p style={{ margin: 0, color: D.text, fontSize: 14, lineHeight: 1.5 }}>{loadError}</p>
          <Link to="/admin" style={{ ...linkButton, textAlign: 'center', lineHeight: '44px', textDecoration: 'none' }}>Back to Waves Admin</Link>
        </div>
      );
    }
    if (!status) return <div style={{ ...cardStyle, color: D.muted, fontSize: 14 }}>Loading…</div>;
    if (view === 'codes') return <RecoveryCodesCard codes={recoveryCodes} onDone={finishCodes} />;
    if (view === 'scan' && setup) {
      return (
        <ScanCard
          setup={setup}
          code={form.code}
          setCode={setField('code')}
          error={errorFor('scan')}
          busy={busy}
          onSubmit={confirmSetup}
          onCancel={() => { setSetup(null); show(status.enabled ? 'overview' : 'setup'); }}
        />
      );
    }
    if (!status.enabled || view === 'setup') {
      return (
        <SetupCard
          replacing={status.enabled}
          form={form}
          setField={setField}
          error={errorFor('setup')}
          busy={busy}
          onSubmit={startSetup}
          onCancel={() => show('overview')}
        />
      );
    }
    return (
      <OverviewCards
        status={status}
        notice={notice}
        form={form}
        setField={setField}
        errorFor={errorFor}
        busy={busy}
        onReplace={() => show('setup')}
        onRegenerate={newRecoveryCodes}
        onTurnOff={turnOff}
      />
    );
  };

  const held = status?.enrollmentRequired && view !== 'codes';
  return (
    <main className="admin-auth-page" style={{ background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: ADMIN_FONT }}>
      <div style={{ maxWidth: 440, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 48, marginBottom: 12 }} />
          <h1 style={{ fontSize: 22, margin: 0, color: D.white }}>Two-step sign-in</h1>
          {held && (
            <p style={{ fontSize: 14, lineHeight: 1.5, color: D.text, margin: '8px 0 0' }}>
              Your account needs two-step sign-in before Waves Admin opens.
            </p>
          )}
        </div>
        {renderBody()}
        <div style={{ textAlign: 'center' }}>
          {held && <button type="button" onClick={signOut} style={{ ...linkButton, color: D.muted }}>Sign out</button>}
          {!held && view === 'overview' && <Link to="/admin/settings" style={{ display: 'inline-block', minHeight: 44, lineHeight: '44px', fontSize: 14, color: D.teal, textDecoration: 'none' }}>Back to Settings</Link>}
        </div>
      </div>
    </main>
  );
}
