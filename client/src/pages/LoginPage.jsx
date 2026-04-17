import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { COLORS as B, FONTS, BUTTON_BASE } from '../theme-brand';

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

  return (
    <div style={{
      position: 'relative',
      minHeight: '100vh',
      overflow: 'hidden',
      background: B.sky,                              // brand-sky base (matches Astro Hero)
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONTS.body,
      padding: 20,
    }}>
      {/* Hero video background — matches wavespestcontrol.com Hero.astro */}
      <video
        autoPlay
        muted
        loop
        playsInline
        preload="none"
        poster="/brand/waves-hero-service.webp"
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'cover', opacity: 0.3, zIndex: 0, pointerEvents: 'none',
        }}
        aria-hidden="true"
      >
        <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
      </video>
      {/* Gradient overlay: brand-sky/90 → brand-blue/60 → brand-blueLight/40 */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
        background: 'linear-gradient(135deg, rgba(77,201,246,0.9) 0%, rgba(9,122,189,0.6) 55%, rgba(227,245,253,0.4) 100%)',
      }} />

      {/* Hero branding block — Luckiest Guy title like wavespestcontrol.com heroes */}
      <div style={{ position: 'relative', zIndex: 2, textAlign: 'center', marginBottom: 32 }}>
        <img
          src="/waves-logo.png"
          alt="Waves Lawn & Pest"
          style={{ width: 140, height: 'auto', marginBottom: 14, filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.3))' }}
        />
        <h1 style={{
          fontSize: 48,                      // matches Astro H1 (--text-5xl)
          fontFamily: FONTS.display,         // Luckiest Guy
          fontWeight: 400,                   // Luckiest Guy only has 400
          color: B.white,
          letterSpacing: '0.02em',           // 0.96px at 48px
          lineHeight: 1.05,
          margin: '0 0 24px',                // Astro H1 mb-6
          textShadow: '0 2px 12px rgba(0,0,0,0.25)',
        }}>
          Client Services Portal
        </h1>
      </div>

      {/* Login card */}
      <div style={{
        position: 'relative', zIndex: 2,
        background: B.white,
        borderRadius: 20,
        padding: '32px 28px',
        maxWidth: 380,
        width: '100%',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
      }}>
        {step === 'phone' ? (
          <>
            <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>
              Sign in to your account
            </div>
            <p style={{ fontSize: 14, color: B.grayDark, fontWeight: 600, marginBottom: 18, lineHeight: 1.65 }}>
              Enter the phone number on your Waves account. We'll text you a quick verification code.
            </p>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(formatPhone(e.target.value))}
              placeholder="(941) 555-0147"
              style={{
                width: '100%', padding: '14px 16px', borderRadius: 12,
                border: `2px solid ${B.grayLight}`, fontSize: 18, fontWeight: 600,
                fontFamily: FONTS.body, color: B.navy,
                outline: 'none', boxSizing: 'border-box', letterSpacing: 1,
              }}
              onFocus={(e) => e.target.style.borderColor = B.wavesBlue}
              onBlur={(e) => e.target.style.borderColor = B.grayLight}
            />
            <button
              onClick={handleSendCode}
              disabled={!phoneReady || sending}
              style={{
                ...BUTTON_BASE, width: '100%', padding: 16,
                background: B.yellow,
                color: B.blueDeeper,
                fontSize: 15, marginTop: 16,
                opacity: sending ? 0.7 : 1,
                boxShadow: '0 4px 14px rgba(0,0,0,0.15)',
              }}
            >
              {sending ? 'Sending...' : 'Send Verification Code'}
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 18, fontWeight: 800, color: B.navy, fontFamily: FONTS.heading, marginBottom: 4 }}>
              Check your texts
            </div>
            <p style={{ fontSize: 14, color: B.grayDark, marginBottom: 18, lineHeight: 1.65 }}>
              We sent a 6-digit code to <strong>{phone}</strong>
            </p>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              style={{
                width: '100%', padding: '14px 16px', borderRadius: 12,
                border: `2px solid ${B.grayLight}`, fontSize: 28, fontWeight: 800,
                fontFamily: FONTS.ui, color: B.navy,
                outline: 'none', textAlign: 'center', letterSpacing: 12,
                boxSizing: 'border-box',
              }}
              onFocus={(e) => e.target.style.borderColor = B.wavesBlue}
              onBlur={(e) => e.target.style.borderColor = B.grayLight}
              autoFocus
            />
            <button
              onClick={handleVerify}
              disabled={!codeReady || sending}
              style={{
                ...BUTTON_BASE, width: '100%', padding: 16,
                background: B.yellow,
                color: B.blueDeeper,
                fontSize: 15, marginTop: 16,
                opacity: sending ? 0.7 : 1,
                boxShadow: '0 4px 14px rgba(0,0,0,0.15)',
              }}
            >
              {sending ? 'Verifying...' : 'Sign In'}
            </button>
            <button
              onClick={() => { setStep('phone'); setCode(''); }}
              style={{
                ...BUTTON_BASE, width: '100%', padding: 12,
                background: 'transparent', color: B.wavesBlue,
                fontSize: 13, fontWeight: 600, marginTop: 8,
              }}
            >
              ← Use a different number
            </button>
          </>
        )}

        {error && (
          <div style={{
            marginTop: 14, padding: '12px 14px', borderRadius: 10,
            background: '#FFEBEE', color: B.red, fontSize: 13, fontWeight: 500, lineHeight: 1.5,
          }}>
            {error === 'No account found for this phone number'
              ? "Hmm, we don't have that number on file. Give us a call at (941) 318-7612 and we'll get you set up."
              : error === 'Failed to fetch'
              ? "Can't reach the server right now. Check your connection or try again in a moment."
              : error}
          </div>
        )}
      </div>

      {/* Bottom links */}
      <div style={{ position: 'relative', zIndex: 2, marginTop: 28, textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', fontFamily: FONTS.heading }}>
          Looking for new service?{' '}
          <a href="https://wavespestcontrol.com" target="_blank" rel="noopener noreferrer"
            style={{ color: B.yellow, fontWeight: 800, textDecoration: 'none' }}>
            Get a Quote
          </a>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginTop: 12, fontFamily: FONTS.heading }}>
          Need help?{' '}
          <a href="tel:+19413187612" style={{ color: B.yellow, fontWeight: 800, textDecoration: 'none' }}>
            Call (941) 318-7612
          </a>
        </div>
      {/* Social icons */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20 }}>
        {[
          { name: 'Facebook', url: 'https://facebook.com/wavespestcontrol', path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
          { name: 'Instagram', url: 'https://instagram.com/wavespestcontrol', path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
          { name: 'YouTube', url: 'https://youtube.com/@wavespestcontrol', path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
          { name: 'TikTok', url: 'https://tiktok.com/@wavespestcontrol', path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
          { name: 'X', url: 'https://x.com/wavespest', path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
        ].map(s => (
          <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" title={s.name} style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'rgba(255,255,255,0.15)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            textDecoration: 'none', transition: 'all 0.2s ease',
          }}>
            <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor"><path d={s.path} /></svg>
          </a>
        ))}
      </div>
      </div>
    </div>
  );
}
