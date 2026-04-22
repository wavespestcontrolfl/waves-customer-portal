import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, KeyRound, ArrowLeft } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import {
  WavesShell,
  BrandCard,
  BrandButton,
  BrandInput,
  SerifHeading,
} from '../components/brand';

const VIDEO_SRC = '/brand/waves-hero-service.mp4';
const POSTER_SRC = '/brand/waves-hero-service.webp';

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e) => setReduced(e.matches);
    mql.addEventListener?.('change', handler);
    return () => mql.removeEventListener?.('change', handler);
  }, []);
  return reduced;
}

export default function LoginPageV2() {
  const { sendCode, verifyCode, error, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone');
  const [sending, setSending] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

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

  const errorMessage = !error
    ? null
    : error === 'No account found for this phone number'
    ? "We don't have that number on file. Call (941) 297-5749 and we'll get you set up."
    : error === 'Failed to fetch'
    ? "Can't reach the server right now. Check your connection or try again in a moment."
    : error;

  return (
    <WavesShell variant="customer" topBar="transparent" footerTone="light">
      <div
        style={{
          position: 'relative',
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px 20px 40px',
          overflow: 'hidden',
          minHeight: '100vh',
        }}
      >
        {/* Hero: looping video, or static poster when reduced-motion. */}
        {reducedMotion ? (
          <img
            src={POSTER_SRC}
            alt=""
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              zIndex: 0,
            }}
          />
        ) : (
          <video
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            poster={POSTER_SRC}
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              zIndex: 0,
              pointerEvents: 'none',
            }}
          >
            <source src={VIDEO_SRC} type="video/mp4" />
          </video>
        )}

        {/* brand-ink overlay: 0.72 → 0.88 */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            pointerEvents: 'none',
            background:
              'linear-gradient(180deg, rgba(10, 17, 40, 0.72) 0%, rgba(10, 17, 40, 0.88) 100%)',
          }}
        />

        {/* Card stack */}
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            width: '100%',
            maxWidth: 420,
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          <BrandCard elevation="modal" padding={36}>
            <SerifHeading style={{ marginBottom: 8 }}>
              {step === 'phone' ? 'Welcome back' : 'Check your texts'}
            </SerifHeading>
            <p
              style={{
                fontSize: 'var(--text-md)',
                color: 'var(--text-muted)',
                lineHeight: 1.55,
                margin: '0 0 24px',
              }}
            >
              {step === 'phone'
                ? "Enter the phone number on your Waves account. We'll text you a quick verification code."
                : (
                  <>
                    We sent a 6-digit code to{' '}
                    <strong style={{ color: 'var(--text)' }}>{phone}</strong>.
                  </>
                )}
            </p>

            {step === 'phone' ? (
              <>
                <BrandInput
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(formatPhone(e.target.value))}
                  placeholder="(941) 555-0147"
                  autoComplete="tel"
                  icon={<Phone size={16} strokeWidth={1.75} />}
                  aria-label="Phone number"
                />
                <BrandButton
                  variant="primary"
                  onClick={handleSendCode}
                  disabled={!phoneReady || sending}
                  fullWidth
                  style={{ marginTop: 16 }}
                >
                  {sending ? 'Sending…' : 'Send verification code'}
                </BrandButton>
              </>
            ) : (
              <>
                <BrandInput
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  maxLength={6}
                  autoComplete="one-time-code"
                  autoFocus
                  icon={<KeyRound size={16} strokeWidth={1.75} />}
                  aria-label="Verification code"
                  style={{ letterSpacing: '0.1em' }}
                />
                <BrandButton
                  variant="primary"
                  onClick={handleVerify}
                  disabled={!codeReady || sending}
                  fullWidth
                  style={{ marginTop: 16 }}
                >
                  {sending ? 'Verifying…' : 'Sign in'}
                </BrandButton>
                <BrandButton
                  variant="ghost"
                  onClick={() => { setStep('phone'); setCode(''); }}
                  fullWidth
                  leftIcon={<ArrowLeft size={16} strokeWidth={1.75} />}
                  style={{ marginTop: 8 }}
                >
                  Use a different number
                </BrandButton>
              </>
            )}

            {errorMessage && (
              <div
                role="alert"
                style={{
                  marginTop: 16,
                  padding: '12px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: 'rgba(200, 16, 46, 0.06)',
                  border: '1px solid rgba(200, 16, 46, 0.28)',
                  color: 'var(--danger)',
                  fontSize: 'var(--text-base)',
                  lineHeight: 1.5,
                }}
              >
                {errorMessage}
              </div>
            )}
          </BrandCard>

          <div
            style={{
              textAlign: 'center',
              color: 'rgba(255, 255, 255, 0.85)',
              fontSize: 'var(--text-md)',
              lineHeight: 1.6,
            }}
          >
            <a
              href="/forgot-password"
              style={{ color: 'rgba(255, 255, 255, 0.9)', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              Forgot password?
            </a>
            <span style={{ margin: '0 10px', opacity: 0.45 }}>·</span>
            <a
              href="/estimate"
              style={{ color: '#FFFFFF', fontWeight: 500, textDecoration: 'none' }}
            >
              New to Waves? Get a free quote →
            </a>
          </div>
        </div>
      </div>
    </WavesShell>
  );
}
