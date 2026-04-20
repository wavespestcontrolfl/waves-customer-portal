import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const { sendCode, verifyCode, error, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone');
  const [sending, setSending] = useState(false);

  const formatPhone = (value) => {
    const digits = value.replace(/\D/g, '').slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  const handleSendCode = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) return;
    setSending(true);
    const success = await sendCode(`+1${digits}`);
    setSending(false);
    if (success) setStep('code');
  };

  const handleVerify = async () => {
    if (code.length !== 6 || sending) return;
    const digits = phone.replace(/\D/g, '');
    setSending(true);
    const success = await verifyCode(`+1${digits}`, code);
    if (success) {
      navigate('/', { replace: true });
    } else {
      setSending(false);
    }
  };

  if (isAuthenticated) {
    navigate('/', { replace: true });
    return null;
  }

  const phoneReady = phone.replace(/\D/g, '').length === 10;
  const codeReady = code.length === 6;

  const errorCopy =
    !error ? null
    : error === 'No account found for this phone number'
      ? "We don't have that number on file. Call us at (941) 318-7612 and we'll get you set up."
    : error === 'Failed to fetch'
      ? "Can't reach the server right now. Check your connection or try again in a moment."
    : error;

  return (
    <div className="wp-page" style={pageStyle}>
      <WaveMotif />

      <main className="wp-col wp-col--narrow" style={mainStyle}>
        <header style={headerStyle}>
          <img
            src="/waves-logo.png"
            alt="Waves Lawn & Pest"
            width={88}
            height={88}
            style={{ width: 88, height: 'auto', marginBottom: 12 }}
          />
          <h1 className="wp-display" style={wordmarkStyle}>Waves</h1>
          <p className="wp-label wp-label--tide" style={sublabelStyle}>
            Client Services Portal
          </p>
        </header>

        <section className="wp-card wp-card--stripe" aria-labelledby="login-card-title">
          <div className="wp-card__body wp-stack">
            {step === 'phone' ? (
              <>
                <div className="wp-stack-sm">
                  <h2 id="login-card-title" className="wp-headline">Sign in</h2>
                  <p className="wp-body wp-muted">
                    Enter the phone number on your Waves account. We'll text you a quick verification code.
                  </p>
                </div>

                <div>
                  <label htmlFor="wp-login-phone" className="wp-field-label">Phone number</label>
                  <input
                    id="wp-login-phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    className="wp-field"
                    value={phone}
                    onChange={(e) => setPhone(formatPhone(e.target.value))}
                    onKeyDown={(e) => e.key === 'Enter' && phoneReady && handleSendCode()}
                    placeholder="(941) 555-0147"
                  />
                </div>

                <button
                  type="button"
                  className="wp-btn wp-btn--primary wp-btn--block"
                  onClick={handleSendCode}
                  disabled={!phoneReady || sending}
                >
                  {sending ? 'Sending…' : 'Send verification code'}
                </button>
              </>
            ) : (
              <>
                <div className="wp-stack-sm">
                  <h2 id="login-card-title" className="wp-headline">Check your texts</h2>
                  <p className="wp-body wp-muted">
                    We sent a 6-digit code to <strong style={{ color: 'var(--wp-ink)' }}>{phone}</strong>.
                  </p>
                </div>

                <div>
                  <label htmlFor="wp-login-code" className="wp-field-label">Verification code</label>
                  <input
                    id="wp-login-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="wp-field wp-field--otp"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={(e) => e.key === 'Enter' && codeReady && handleVerify()}
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                  />
                </div>

                <button
                  type="button"
                  className="wp-btn wp-btn--primary wp-btn--block"
                  onClick={handleVerify}
                  disabled={!codeReady || sending}
                >
                  {sending ? 'Verifying…' : 'Sign in'}
                </button>

                <button
                  type="button"
                  className="wp-btn wp-btn--ghost wp-btn--block"
                  onClick={() => { setStep('phone'); setCode(''); }}
                >
                  ← Use a different number
                </button>
              </>
            )}

            {errorCopy && (
              <div className="wp-alert wp-alert--coral" role="alert">
                {errorCopy}
              </div>
            )}
          </div>
        </section>

        <nav style={bottomLinksStyle} aria-label="Portal help">
          <p className="wp-body" style={{ textAlign: 'center', color: 'var(--wp-ink)' }}>
            New customer? <a href="/estimate" className="wp-link">Get a quote</a>
          </p>
          <p className="wp-body" style={{ textAlign: 'center', color: 'var(--wp-ink)' }}>
            Need help? <a href="tel:+19413187612" className="wp-link">Call (941) 318-7612</a>
          </p>

          <ul style={socialListStyle}>
            {SOCIALS.map((s) => (
              <li key={s.name}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={s.name}
                  aria-label={s.name}
                  style={socialLinkStyle}
                >
                  <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden="true">
                    <path d={s.path} />
                  </svg>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </main>
    </div>
  );
}

/* ─────────────────────────── Layout styles ─────────────────────────── */

const pageStyle = {
  position: 'relative',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '40px 0 48px',
  paddingBottom: 'max(48px, env(safe-area-inset-bottom))',
};

const mainStyle = {
  position: 'relative',
  zIndex: 2,
  display: 'flex',
  flexDirection: 'column',
  gap: 28,
};

const headerStyle = {
  textAlign: 'center',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
};

const wordmarkStyle = {
  fontSize: 64,
  margin: 0,
  letterSpacing: '0.04em',
};

const sublabelStyle = {
  marginTop: 8,
  fontSize: 12,
  letterSpacing: '0.18em',
};

const bottomLinksStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  alignItems: 'center',
  marginTop: 8,
};

const socialListStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  gap: 10,
  justifyContent: 'center',
  marginTop: 12,
};

const socialLinkStyle = {
  width: 36,
  height: 36,
  borderRadius: '50%',
  background: 'var(--wp-surface)',
  color: 'var(--wp-tide-ink)',
  border: '1px solid var(--wp-surface-mute)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  textDecoration: 'none',
  transition: 'color 180ms, border-color 180ms, transform 180ms',
};

/* ─────────────────────────── Wave motif (SVG, margins) ─────────────────────────── */

function WaveMotif() {
  return (
    <svg
      viewBox="0 0 1440 320"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0, right: 0, bottom: 0,
        width: '100%',
        height: 220,
        opacity: 0.35,
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      <path
        fill="var(--wp-tide-wash)"
        d="M0,192 C240,256 480,128 720,160 C960,192 1200,288 1440,224 L1440,320 L0,320 Z"
      />
      <path
        fill="var(--wp-tide)"
        fillOpacity="0.12"
        d="M0,240 C240,192 480,288 720,256 C960,224 1200,160 1440,208 L1440,320 L0,320 Z"
      />
    </svg>
  );
}

/* ─────────────────────────── Social icon paths ─────────────────────────── */

const SOCIALS = [
  { name: 'Facebook',  url: 'https://facebook.com/wavespestcontrol',  path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
  { name: 'Instagram', url: 'https://instagram.com/wavespestcontrol', path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
  { name: 'YouTube',   url: 'https://youtube.com/@wavespestcontrol',  path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  { name: 'TikTok',    url: 'https://tiktok.com/@wavespestcontrol',   path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  { name: 'X',         url: 'https://x.com/wavespest',                path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
];
