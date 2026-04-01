import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const { sendCode, verifyCode, error } = useAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('phone'); // 'phone' | 'code'
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
    if (code.length !== 6) return;
    const digits = phone.replace(/\D/g, '');

    setSending(true);
    await verifyCode(`+1${digits}`, code);
    setSending(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #0B2545 0%, #1B4965 50%, #2E8B8B 100%)',
      fontFamily: "'DM Sans', sans-serif",
      padding: 20,
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet" />

      <div style={{
        background: '#fff',
        borderRadius: 24,
        padding: '40px 32px',
        maxWidth: 400,
        width: '100%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 60, height: 60, borderRadius: 16, margin: '0 auto 12px',
            background: 'linear-gradient(135deg, #2E8B8B, #5DB7B7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 28, fontWeight: 800,
          }}>W</div>
          <h1 style={{
            fontSize: 22, fontWeight: 800, color: '#0B2545',
            fontFamily: "'Playfair Display', serif", margin: 0,
          }}>Waves Pest Control</h1>
          <p style={{ fontSize: 13, color: '#6B7C8D', marginTop: 4 }}>Customer Portal</p>
        </div>

        {step === 'phone' ? (
          <>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#0B2545', display: 'block', marginBottom: 6 }}>
              Enter your phone number
            </label>
            <p style={{ fontSize: 12, color: '#6B7C8D', marginBottom: 14 }}>
              We'll text you a verification code to sign in.
            </p>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(formatPhone(e.target.value))}
              placeholder="(941) 555-0147"
              style={{
                width: '100%', padding: '14px 16px', borderRadius: 12,
                border: '2px solid #E8ECF0', fontSize: 18, fontWeight: 600,
                fontFamily: "'DM Sans', sans-serif", color: '#0B2545',
                outline: 'none', boxSizing: 'border-box',
                letterSpacing: 1,
              }}
              onFocus={(e) => e.target.style.borderColor = '#2E8B8B'}
              onBlur={(e) => e.target.style.borderColor = '#E8ECF0'}
            />
            <button
              onClick={handleSendCode}
              disabled={phone.replace(/\D/g, '').length !== 10 || sending}
              style={{
                width: '100%', padding: 16, borderRadius: 12, border: 'none',
                background: phone.replace(/\D/g, '').length === 10
                  ? 'linear-gradient(135deg, #2E8B8B, #5DB7B7)' : '#E8ECF0',
                color: phone.replace(/\D/g, '').length === 10 ? '#fff' : '#6B7C8D',
                fontSize: 15, fontWeight: 700, cursor: 'pointer',
                fontFamily: "'DM Sans', sans-serif", marginTop: 16,
                opacity: sending ? 0.7 : 1,
                transition: 'all 0.3s ease',
              }}
            >
              {sending ? 'Sending...' : 'Send Verification Code'}
            </button>
          </>
        ) : (
          <>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#0B2545', display: 'block', marginBottom: 6 }}>
              Enter verification code
            </label>
            <p style={{ fontSize: 12, color: '#6B7C8D', marginBottom: 14 }}>
              We sent a 6-digit code to {phone}
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
                border: '2px solid #E8ECF0', fontSize: 28, fontWeight: 800,
                fontFamily: "'DM Sans', sans-serif", color: '#0B2545',
                outline: 'none', textAlign: 'center', letterSpacing: 12,
                boxSizing: 'border-box',
              }}
              onFocus={(e) => e.target.style.borderColor = '#2E8B8B'}
              onBlur={(e) => e.target.style.borderColor = '#E8ECF0'}
              autoFocus
            />
            <button
              onClick={handleVerify}
              disabled={code.length !== 6 || sending}
              style={{
                width: '100%', padding: 16, borderRadius: 12, border: 'none',
                background: code.length === 6
                  ? 'linear-gradient(135deg, #2E8B8B, #5DB7B7)' : '#E8ECF0',
                color: code.length === 6 ? '#fff' : '#6B7C8D',
                fontSize: 15, fontWeight: 700, cursor: 'pointer',
                fontFamily: "'DM Sans', sans-serif", marginTop: 16,
                opacity: sending ? 0.7 : 1,
              }}
            >
              {sending ? 'Verifying...' : 'Sign In'}
            </button>
            <button
              onClick={() => { setStep('phone'); setCode(''); }}
              style={{
                width: '100%', padding: 12, borderRadius: 12,
                border: 'none', background: 'transparent',
                color: '#2E8B8B', fontSize: 13, fontWeight: 600,
                cursor: 'pointer', marginTop: 8,
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              ← Use a different number
            </button>
          </>
        )}

        {error && (
          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 10,
            background: '#FEE2E2', color: '#C44B4B', fontSize: 13, fontWeight: 500,
          }}>
            {error}
          </div>
        )}

        <div style={{
          marginTop: 24, paddingTop: 16, borderTop: '1px solid #E8ECF0',
          textAlign: 'center', fontSize: 12, color: '#6B7C8D',
        }}>
          Need help? Call <a href="tel:+19415550100" style={{ color: '#2E8B8B', fontWeight: 600 }}>(941) 555-0100</a>
        </div>
      </div>
    </div>
  );
}
