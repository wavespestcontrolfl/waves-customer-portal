import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { COLORS as B, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import Icon from '../components/Icon';
import BrandFooter from '../components/BrandFooter';
import { TrustFooter, WavesShellContext } from '../components/brand';
import { useGlassSurface } from '../glass/glass-engine';
import { isNativeApp } from '../native/platform';

const SUPPORT_LINKS = [
  { label: 'Call', href: 'tel:+19412975749', icon: 'phone' },
  { label: 'Text', href: 'sms:+19412975749', icon: 'chat' },
  { label: 'Estimate', href: '/estimate', icon: 'clipboard' },
];

function safeNextPath(search) {
  try {
    const next = new URLSearchParams(search || '').get('next') || '/';
    if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/admin')) return '/';
    return next;
  } catch {
    return '/';
  }
}

function normalizeAuthError(error) {
  if (!error) return '';
  if (error === 'No account found for this phone number') {
    return "We do not have that number on file. Call Waves at (941) 297-5749 and we will get it corrected.";
  }
  if (error === 'Failed to fetch' || error === 'Network request failed') {
    return "We cannot reach the server right now. Check your connection and try again.";
  }
  return error;
}

export default function LoginPage() {
  const { sendCode, verifyCode, error, isAuthenticated, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const nextPath = safeNextPath(location.search);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone');
  const [sending, setSending] = useState(false);
  useGlassSurface(true, 'full');

  useEffect(() => {
    if (isAuthenticated) navigate(nextPath, { replace: true });
  }, [isAuthenticated, navigate, nextPath]);

  const formatPhone = (value) => {
    const digits = value.replace(/\D/g, '').slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  const handleSendCode = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10 || sending) return;
    setSending(true);
    const success = await sendCode(`+1${digits}`);
    setSending(false);
    if (success) {
      setCode('');
      setStep('code');
    }
  };

  const handleVerify = async () => {
    if (code.length !== 6 || sending) return;
    const digits = phone.replace(/\D/g, '');
    setSending(true);
    const success = await verifyCode(`+1${digits}`, code);
    if (success) {
      navigate(nextPath, { replace: true });
    } else {
      setSending(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (step === 'phone') handleSendCode();
    else handleVerify();
  };

  const phoneReady = phone.replace(/\D/g, '').length === 10;
  const codeReady = code.length === 6;
  const submitDisabled = step === 'phone' ? !phoneReady || sending : !codeReady || sending;
  const friendlyError = normalizeAuthError(error);
  const busyLabel = step === 'phone' ? 'Sending code...' : 'Verifying code...';

  if (isAuthenticated) return null;

  return (
    <>
    <main
      className="portal-login-page"
      style={{
        '--login-blue': B.blueDeeper,
        '--login-brand': B.wavesBlue,
        '--login-text': '#3F4A65',
        '--login-muted': CUSTOMER_SURFACE.muted,
        '--login-border': '#E7E2D7',
        '--login-border-strong': '#D8D0C0',
        '--login-soft': '#F8FCFE',
        '--login-soft-border': '#CFE7F5',
        // Under glass the fixed scene on <html> is the backdrop.
        '--login-bg': 'transparent',
        '--login-card': B.white,
        '--login-red': B.red,
        fontFamily: FONTS.body,
      }}
    >
      <style>{`
        .portal-login-page {
          min-height: 100vh;
          background: var(--login-bg);
          color: var(--login-text);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 28px;
          box-sizing: border-box;
        }
        .portal-login-shell {
          width: min(1060px, 100%);
          display: grid;
          grid-template-columns: minmax(280px, 0.9fr) minmax(340px, 420px);
          gap: 28px;
          align-items: center;
        }
        .portal-login-brand {
          min-width: 0;
          padding: 8px 0;
        }
        .portal-login-logo {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          text-decoration: none;
          color: var(--login-blue);
        }
        .portal-login-logo img {
          width: 42px;
          height: 42px;
          object-fit: contain;
        }
        .portal-login-logo span {
          font-family: ${FONTS.body};
          font-size: 15px;
          font-weight: 800;
          letter-spacing: 0;
        }
        .portal-login-eyebrow {
          margin-top: 28px;
          display: flex;
          width: fit-content;
          max-width: 100%;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 999px;
          background: var(--login-soft);
          color: var(--login-blue);
          font-size: 14px;
          font-weight: 800;
          border: 1px solid var(--login-soft-border);
        }
        .portal-login-brand h1 {
          margin: 14px 0 12px;
          color: var(--login-blue);
          font-family: ${FONTS.serif};
          font-size: 44px;
          line-height: 1.06;
          letter-spacing: 0;
          font-weight: 500;
        }
        .portal-login-brand p {
          margin: 0;
          max-width: 480px;
          color: var(--login-muted);
          font-size: 16px;
          line-height: 1.55;
          font-weight: 500;
        }
        .portal-login-tools {
          margin-top: 22px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          max-width: 520px;
        }
        .portal-login-tool {
          min-width: 0;
          border: 1px solid var(--login-border);
          border-radius: 16px;
          background: var(--login-card);
          padding: 12px;
          box-shadow: none;
          display: flex;
          gap: 10px;
          align-items: flex-start;
        }
        .portal-login-tool-icon {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          background: var(--login-soft);
          color: var(--login-blue);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .portal-login-tool-title {
          display: block;
          color: var(--login-blue);
          font-family: ${FONTS.body};
          font-size: 14px;
          font-weight: 800;
          line-height: 1.2;
        }
        .portal-login-tool-text {
          display: block;
          color: var(--login-muted);
          font-size: 12px;
          line-height: 1.35;
          margin-top: 2px;
        }
        .portal-login-panel {
          min-width: 0;
        }
        .portal-login-card,
        .portal-login-help {
          background: var(--login-card);
          border: 1px solid var(--login-border);
          border-radius: 16px;
          box-shadow: none;
        }
        .portal-login-card {
          padding: 22px;
        }
        .portal-login-card-header {
          display: flex;
          gap: 12px;
          align-items: flex-start;
          margin-bottom: 20px;
        }
        .portal-login-icon {
          width: 42px;
          height: 42px;
          border-radius: 10px;
          background: var(--login-soft);
          color: var(--login-blue);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }
        .portal-login-title {
          margin: 0;
          color: var(--login-blue);
          font-family: ${FONTS.serif};
          font-size: 20px;
          line-height: 1.2;
          font-weight: 500;
          letter-spacing: 0;
        }
        .portal-login-subtitle {
          margin: 4px 0 0;
          color: var(--login-muted);
          font-size: 14px;
          line-height: 1.45;
          font-weight: 500;
        }
        .portal-login-step {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          margin-bottom: 18px;
          padding: 4px;
          border: 1px solid var(--login-border);
          border-radius: 12px;
          background: var(--login-bg);
        }
        .portal-login-step-item {
          min-height: 34px;
          border-radius: 9px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          color: var(--login-muted);
          font-family: ${FONTS.body};
          font-size: 12px;
          font-weight: 800;
        }
        .portal-login-step-item.active {
          background: var(--login-card);
          color: var(--login-blue);
          box-shadow: none;
        }
        .portal-login-field {
          display: grid;
          gap: 7px;
        }
        .portal-login-field label {
          color: var(--login-blue);
          font-size: 14px;
          font-weight: 800;
          letter-spacing: 0;
          font-family: ${FONTS.body};
        }
        .portal-login-input {
          width: 100%;
          height: 52px;
          box-sizing: border-box;
          border: 1px solid var(--login-border-strong);
          border-radius: 10px;
          background: var(--login-soft);
          color: var(--login-blue);
          font-family: ${FONTS.body};
          font-size: 18px;
          font-weight: 700;
          outline: none;
          padding: 0 14px;
          transition: border-color 150ms ease, box-shadow 150ms ease;
        }
        .portal-login-input:focus {
          border-color: var(--login-brand);
          box-shadow: 0 0 0 3px rgba(0, 156, 222, 0.16);
        }
        .portal-login-input.code {
          text-align: center;
          font-size: 26px;
          letter-spacing: 0.2em;
          font-family: ${FONTS.ui};
          padding-left: 0.2em;
        }
        .portal-login-submit,
        .portal-login-secondary {
          width: 100%;
          min-height: 48px;
          border-radius: 10px;
          font-family: ${FONTS.body};
          font-size: 14px;
          font-weight: 800;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          cursor: pointer;
          transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
        }
        .portal-login-submit {
          margin-top: 16px;
          border: none;
          background: var(--login-blue);
          color: #fff;
        }
        .portal-login-submit:not(:disabled):hover {
          background: #14234C;
        }
        .portal-login-submit:disabled {
          cursor: not-allowed;
          background: #D8D0C0;
          color: #fff;
        }
        .portal-login-secondary {
          margin-top: 8px;
          border: 1px solid var(--login-border-strong);
          background: #fff;
          color: var(--login-blue);
        }
        .portal-login-submit:focus-visible,
        .portal-login-secondary:focus-visible,
        .portal-login-help a:focus-visible {
          outline: 3px solid rgba(0, 156, 222, 0.2);
          outline-offset: 2px;
        }
        .portal-login-secondary:hover {
          border-color: #94A3B8;
          background: var(--login-soft);
        }
        .portal-login-note {
          margin-top: 12px;
          padding: 10px 12px;
          border-radius: 10px;
          background: var(--login-soft);
          border: 1px solid var(--login-soft-border);
          color: var(--login-blue);
          font-size: 13px;
          line-height: 1.45;
          font-weight: 700;
          display: flex;
          gap: 8px;
          align-items: flex-start;
        }
        .portal-login-error {
          margin-top: 14px;
          padding: 12px;
          border-radius: 10px;
          background: #FEF2F2;
          border: 1px solid #FECACA;
          color: var(--login-red);
          font-size: 14px;
          line-height: 1.45;
          font-weight: 700;
          display: flex;
          gap: 9px;
          align-items: flex-start;
        }
        .portal-login-help {
          margin-top: 12px;
          padding: 12px;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .portal-login-help a {
          min-height: 42px;
          border-radius: 10px;
          border: 1px solid var(--login-border);
          color: var(--login-blue);
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-family: ${FONTS.body};
          font-size: 14px;
          font-weight: 800;
          background: #fff;
        }
        .portal-login-help a:hover {
          border-color: #94A3B8;
          background: var(--login-soft);
        }
        .portal-login-footer {
          margin-top: 18px;
          color: var(--login-muted);
          font-size: 14px;
          line-height: 1.5;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .portal-login-footer a {
          color: inherit;
          text-decoration: none;
        }
        .portal-login-footer a:hover {
          color: var(--login-blue);
        }
        .portal-login-footer-brand {
          color: var(--login-blue);
          font-weight: 800;
        }
        .portal-login-footer-cities {
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
          flex-wrap: wrap;
        }
        .portal-login-footer-city {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-weight: 800;
        }
        @media (max-width: 820px) {
          .portal-login-page {
            align-items: flex-start;
            padding: 16px;
          }
          .portal-login-shell {
            grid-template-columns: 1fr;
            gap: 18px;
          }
          .portal-login-brand {
            padding-top: 0;
          }
          .portal-login-eyebrow {
            margin-top: 20px;
          }
          .portal-login-brand h1 {
            font-size: 32px;
          }
          .portal-login-brand p {
            font-size: 15px;
          }
          .portal-login-tools {
            grid-template-columns: 1fr;
            margin-top: 16px;
          }
          .portal-login-card {
            padding: 18px;
          }
          .portal-login-help {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="portal-login-shell">
        <section className="portal-login-brand" aria-labelledby="portal-login-heading">
          <a className="portal-login-logo" href="https://wavespestcontrol.com">
            <img src="/waves-logo.png" alt="Waves" />
            <span>Waves</span>
          </a>
          <div className="portal-login-eyebrow" data-glass="chip" style={{ position: 'relative' }}>
            <Icon name="lock" size={15} strokeWidth={2.2} />
            Secure customer access
          </div>
          <h1 id="portal-login-heading">Customer Portal</h1>
          <p>Sign in with the phone number on your Waves account to manage service, billing, documents, and property details.</p>
        </section>

        <section className="portal-login-panel" aria-label="Sign in">
          <div className="portal-login-card" data-glass="card" style={{ position: 'relative' }}>
            <div className="portal-login-card-header">
              <span className="portal-login-icon">
                <Icon name={step === 'phone' ? 'smartphone' : 'key'} size={20} strokeWidth={2.1} />
              </span>
              <div>
                <h2 className="portal-login-title">
                  {step === 'phone' ? 'Sign In' : 'Enter Code'}
                </h2>
                <p className="portal-login-subtitle">
                  {step === 'phone'
                    ? 'We will text a verification code to your account phone.'
                    : `Code sent to ${phone}.`}
                </p>
              </div>
            </div>

            <div className="portal-login-step" aria-label="Sign in progress">
              <span className={`portal-login-step-item ${step === 'phone' ? 'active' : ''}`}>
                <Icon name="smartphone" size={14} strokeWidth={2} />
                Phone
              </span>
              <span className={`portal-login-step-item ${step === 'code' ? 'active' : ''}`}>
                <Icon name="key" size={14} strokeWidth={2} />
                Code
              </span>
            </div>

            {loading ? (
              <div className="portal-login-note" role="status">
                <Icon name="waves" size={16} strokeWidth={2} style={{ marginTop: 1 }} />
                <span>Checking your saved session...</span>
              </div>
            ) : (
            <form onSubmit={onSubmit}>
              {step === 'phone' ? (
                <div className="portal-login-field">
                  <label htmlFor="waves-login-phone">Phone number</label>
                  <input
                    id="waves-login-phone"
                    name="phone"
                    className="portal-login-input"
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(formatPhone(e.target.value))}
                    placeholder="(941) 555-0147"
                    aria-describedby="waves-login-phone-help"
                  />
                  <span id="waves-login-phone-help" style={{ fontSize: 12, color: 'var(--login-muted)', lineHeight: 1.35 }}>
                    Use the mobile number linked to your Waves account.
                  </span>
                </div>
              ) : (
                <div className="portal-login-field">
                  <label htmlFor="waves-login-code">Verification code</label>
                  <input
                    id="waves-login-code"
                    name="code"
                    className="portal-login-input code"
                    type="text"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                    aria-describedby="waves-login-code-help"
                  />
                  <span id="waves-login-code-help" style={{ fontSize: 12, color: 'var(--login-muted)', lineHeight: 1.35 }}>
                    Codes are 6 digits and usually arrive within a few seconds.
                  </span>
                </div>
              )}

              <button
                type="submit"
                className="portal-login-submit"
                data-glass-accent=""
                style={{ position: 'relative' }}
                disabled={submitDisabled}
                aria-live="polite"
              >
                {sending
                  ? busyLabel
                  : (step === 'phone' ? 'Send Code' : 'Sign In')}
              </button>

              {step === 'code' && (
                <>
                  <button
                    type="button"
                    className="portal-login-secondary"
                    onClick={handleSendCode}
                    disabled={sending}
                  >
                    <Icon name="refresh" size={15} strokeWidth={2} />
                    Resend Code
                  </button>
                  <button
                    type="button"
                    className="portal-login-secondary"
                    onClick={() => { setStep('phone'); setCode(''); }}
                  >
                    Use Different Number
                  </button>
                </>
              )}
            </form>
            )}

            {friendlyError && (
              <div className="portal-login-error" role="alert">
                <Icon name="warning" size={16} strokeWidth={2} style={{ marginTop: 1 }} />
                <span>{friendlyError}</span>
              </div>
            )}
          </div>

          <div className="portal-login-help" aria-label="Support links" data-glass="soft" style={{ position: 'relative' }}>
            {SUPPORT_LINKS.map(link => (
              <a key={link.label} href={link.href} data-glass-accent="" style={{ position: 'relative' }}>
                <Icon name={link.icon} size={15} strokeWidth={2} />
                {link.label}
              </a>
            ))}
          </div>

          {/* Store badges — hidden inside the native apps (isNativeApp),
              where the customer already has the app. */}
          {!isNativeApp() && (
            <section data-glass="card" aria-label="Get the Waves app" style={{
              position: 'relative',
              marginTop: 14,
              padding: 24,
              borderRadius: 16,
              background: '#FFFFFF',
              border: '1px solid #E7E2D7',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 12, fontWeight: 850, color: CUSTOMER_SURFACE.muted, textTransform: 'uppercase', letterSpacing: 0 }}>
                The Waves App
              </div>
              <div style={{ marginTop: 6, fontSize: 20, fontWeight: 850, color: B.blueDeeper, fontFamily: FONTS.heading }}>
                Your home team, one tap away.
              </div>
              <div style={{ marginTop: 6, fontSize: 14, color: '#3F4A65', lineHeight: 1.5, maxWidth: 420, marginLeft: 'auto', marginRight: 'auto' }}>
                See when we're coming, read every report the moment it's ready, and pay in seconds.
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center' }}>
                <a href="https://apps.apple.com/us/app/waves-pest-control/id6782775654" target="_blank" rel="noopener noreferrer" aria-label="Download the Waves app on the App Store">
                  <img src="/app-email/apple-app-store-badge.png" alt="Download on the App Store" style={{ height: 44, display: 'block' }} />
                </a>
                <a href="https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal" target="_blank" rel="noopener noreferrer" aria-label="Get the Waves app on Google Play">
                  <img src="/app-email/google-play-badge-tight.png" alt="Get it on Google Play" style={{ height: 44, display: 'block' }} />
                </a>
              </div>
            </section>
          )}
        </section>
      </div>
    </main>
    {/* Standard identity footer — every glass surface carries the same
        footer stack as /track (owner 2026-07-08): BrandFooter identity
        block + TrustFooter legal strip, added beneath the locked login
        layout without touching it. */}
    <WavesShellContext.Provider value={{ variant: 'customer', inShell: true }}>
      <BrandFooter />
    </WavesShellContext.Provider>
    <TrustFooter />
    </>
  );
}
