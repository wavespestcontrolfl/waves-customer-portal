import { useState } from 'react';
import AddressAutocomplete from '../components/AddressAutocomplete';
import BrandFooter from '../components/BrandFooter';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const BRAND = {
  navy: '#04395E',
  teal: '#097ABD',
  tealDark: '#065A8C',
  tealLight: '#E3F5FD',
  warmWhite: '#FFFFFF',
  coral: '#C0392B',
  gold: '#FFD700',
  green: '#16A34A',
  greenLight: '#DCFCE7',
  gray100: '#F1F5F9',
  gray200: '#E2E8F0',
  gray300: '#CBD5E1',
  gray400: '#94A3B8',
  gray600: '#475569',
  gray800: '#1E293B',
};

const PEST_FREQS = [
  { id: 'quarterly', label: 'Quarterly', sub: '4 visits / year', recommended: true },
  { id: 'bimonthly', label: 'Bi-Monthly', sub: '6 visits / year' },
  { id: 'monthly', label: 'Monthly', sub: '12 visits / year' },
];

const GRASS_TYPES = [
  { id: 'st_augustine', label: 'St. Augustine' },
  { id: 'bahia', label: 'Bahia' },
  { id: 'bermuda', label: 'Bermuda' },
  { id: 'zoysia', label: 'Zoysia' },
];

export default function PestControlCalculatorPage() {
  const [step, setStep] = useState(1);
  const [address, setAddress] = useState({ formatted: '', line1: '', city: '', state: 'FL', zip: '' });
  const [svcPest, setSvcPest] = useState(true);
  const [svcLawn, setSvcLawn] = useState(false);
  const [pestFreq, setPestFreq] = useState('quarterly');
  const [grassType, setGrassType] = useState('st_augustine');
  const [homeSqFt, setHomeSqFt] = useState('2000');
  const [lotSqFt, setLotSqFt] = useState('');
  const [contact, setContact] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  function setPhone(raw) {
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    setContact(c => ({ ...c, phone: digits.slice(0, 10) }));
  }

  function formatPhone(d) {
    if (!d) return '';
    if (d.length <= 3) return `(${d}`;
    if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  async function submit() {
    setError('');
    if (!address.formatted) { setError('Enter your address.'); return; }
    if (!svcPest && !svcLawn) { setError('Pick at least one service.'); return; }
    if (!contact.firstName || !contact.lastName) { setError('Enter your name.'); return; }
    if (!/^\S+@\S+\.\S+$/.test(contact.email)) { setError('Enter a valid email.'); return; }
    if (contact.phone.length !== 10) { setError('Enter a 10-digit phone number.'); return; }

    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/public/quote/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone,
          address: address.line1 || address.formatted,
          city: address.city,
          zip: address.zip,
          homeSqFt: Number(homeSqFt) || 2000,
          lotSqFt: Number(lotSqFt) || undefined,
          propertyType: 'Single Family',
          services: {
            ...(svcPest ? { pest: { frequency: pestFreq } } : {}),
            ...(svcLawn ? { lawn: { track: grassType, tier: 'enhanced' } } : {}),
          },
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not calculate.');
      setResult(d);
      setStep(5);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const sPage = { minHeight: '100vh', background: BRAND.gray100, fontFamily: "'DM Sans', sans-serif", color: BRAND.gray800, display: 'flex', flexDirection: 'column' };
  const sWrap = { maxWidth: 640, margin: '0 auto', padding: '32px 20px', width: '100%', flex: 1 };
  const sCard = { background: BRAND.warmWhite, borderRadius: 16, padding: 28, boxShadow: '0 4px 20px rgba(4,57,94,0.08)', border: `1px solid ${BRAND.gray200}` };
  const sLabel = { display: 'block', fontSize: 14, fontWeight: 600, color: BRAND.gray800, marginBottom: 6 };
  const sInput = { width: '100%', padding: '12px 14px', border: `1px solid ${BRAND.gray300}`, borderRadius: 8, fontSize: 16, fontFamily: 'inherit', boxSizing: 'border-box', background: BRAND.warmWhite };
  const sBtn = { padding: '14px 24px', background: BRAND.teal, color: BRAND.warmWhite, border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };
  const sBtnGhost = { ...sBtn, background: 'transparent', color: BRAND.teal, border: `1px solid ${BRAND.teal}` };
  const sChip = (on) => ({ padding: '14px 18px', borderRadius: 10, border: `2px solid ${on ? BRAND.teal : BRAND.gray300}`, background: on ? BRAND.tealLight : BRAND.warmWhite, cursor: 'pointer', fontSize: 15, fontWeight: on ? 700 : 500, color: on ? BRAND.navy : BRAND.gray800, textAlign: 'left', display: 'block', width: '100%' });

  const totalSteps = 4;
  const progress = result ? 100 : (step / totalSteps) * 100;

  return (
    <div style={sPage}>
      <header style={{ background: BRAND.navy, color: BRAND.warmWhite, padding: '20px 20px' }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 0.2 }}>Pest Control Calculator</div>
          <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>Get an instant quote from Waves Pest Control · SWFL</div>
        </div>
      </header>

      <div style={sWrap}>
        <div style={{ height: 6, background: BRAND.gray200, borderRadius: 4, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progress}%`, background: BRAND.teal, transition: 'width 0.3s' }} />
        </div>

        <div style={sCard}>
          {step === 1 && (
            <div>
              <h2 style={{ marginTop: 0, fontSize: 22, color: BRAND.navy }}>What's your address?</h2>
              <p style={{ color: BRAND.gray600, fontSize: 14, marginBottom: 20 }}>We serve Manatee, Sarasota, and Charlotte counties.</p>
              <label style={sLabel}>Property address</label>
              <AddressAutocomplete
                value={address.formatted}
                onChange={(v) => setAddress(a => ({ ...a, formatted: v }))}
                onSelect={(p) => setAddress({ formatted: p.formatted, line1: p.line1, city: p.city, state: p.state, zip: p.zip })}
                placeholder="Start typing your address..."
                style={sInput}
              />
              <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
                <button style={sBtn} disabled={!address.formatted} onClick={() => setStep(2)}>Continue</button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 style={{ marginTop: 0, fontSize: 22, color: BRAND.navy }}>Which services do you want?</h2>
              <p style={{ color: BRAND.gray600, fontSize: 14, marginBottom: 20 }}>Pick one or both. Bundle for a loyalty discount.</p>

              <div style={{ display: 'grid', gap: 12, marginBottom: 20 }}>
                <button type="button" style={sChip(svcPest)} onClick={() => setSvcPest(!svcPest)}>
                  <div style={{ fontSize: 16 }}>Pest Control</div>
                  <div style={{ fontSize: 13, color: BRAND.gray600, fontWeight: 500, marginTop: 2 }}>Interior + exterior treatment, covered pests</div>
                </button>
                <button type="button" style={sChip(svcLawn)} onClick={() => setSvcLawn(!svcLawn)}>
                  <div style={{ fontSize: 16 }}>Lawn Care</div>
                  <div style={{ fontSize: 13, color: BRAND.gray600, fontWeight: 500, marginTop: 2 }}>Fertilization + weed control program</div>
                </button>
              </div>

              {svcPest && (
                <div style={{ marginBottom: 16 }}>
                  <label style={sLabel}>Pest treatment frequency</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {PEST_FREQS.map(f => (
                      <button key={f.id} type="button" style={sChip(pestFreq === f.id)} onClick={() => setPestFreq(f.id)}>
                        <div style={{ fontSize: 14 }}>{f.label}</div>
                        <div style={{ fontSize: 11, color: BRAND.gray600, fontWeight: 500, marginTop: 2 }}>{f.sub}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {svcLawn && (
                <div>
                  <label style={sLabel}>Grass type</label>
                  <select style={sInput} value={grassType} onChange={(e) => setGrassType(e.target.value)}>
                    {GRASS_TYPES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                  </select>
                </div>
              )}

              <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
                <button style={sBtnGhost} onClick={() => setStep(1)}>Back</button>
                <button style={sBtn} disabled={!svcPest && !svcLawn} onClick={() => setStep(3)}>Continue</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 style={{ marginTop: 0, fontSize: 22, color: BRAND.navy }}>How big is your home?</h2>
              <p style={{ color: BRAND.gray600, fontSize: 14, marginBottom: 20 }}>Not sure? A rough estimate is fine — we'll confirm before service.</p>

              <label style={sLabel}>Home square footage</label>
              <input style={sInput} type="number" inputMode="numeric" value={homeSqFt} onChange={(e) => setHomeSqFt(e.target.value)} placeholder="2000" />

              {svcLawn && (
                <div style={{ marginTop: 16 }}>
                  <label style={sLabel}>Lot size (square feet) — optional</label>
                  <input style={sInput} type="number" inputMode="numeric" value={lotSqFt} onChange={(e) => setLotSqFt(e.target.value)} placeholder="8000" />
                </div>
              )}

              <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
                <button style={sBtnGhost} onClick={() => setStep(2)}>Back</button>
                <button style={sBtn} disabled={!homeSqFt || Number(homeSqFt) < 500} onClick={() => setStep(4)}>Continue</button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <h2 style={{ marginTop: 0, fontSize: 22, color: BRAND.navy }}>Almost done — where should we send it?</h2>
              <p style={{ color: BRAND.gray600, fontSize: 14, marginBottom: 20 }}>We'll text your quote and a member of our team will follow up.</p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={sLabel}>First name</label>
                  <input style={sInput} value={contact.firstName} onChange={(e) => setContact(c => ({ ...c, firstName: e.target.value }))} />
                </div>
                <div>
                  <label style={sLabel}>Last name</label>
                  <input style={sInput} value={contact.lastName} onChange={(e) => setContact(c => ({ ...c, lastName: e.target.value }))} />
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={sLabel}>Email</label>
                <input style={sInput} type="email" value={contact.email} onChange={(e) => setContact(c => ({ ...c, email: e.target.value }))} />
              </div>
              <div>
                <label style={sLabel}>Mobile phone</label>
                <input style={sInput} type="tel" value={formatPhone(contact.phone)} onChange={(e) => setPhone(e.target.value)} placeholder="(941) 555-1234" />
              </div>

              {error && <div style={{ marginTop: 16, padding: 12, background: '#FEE2E2', color: BRAND.coral, borderRadius: 8, fontSize: 14 }}>{error}</div>}

              <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
                <button style={sBtnGhost} onClick={() => setStep(3)} disabled={loading}>Back</button>
                <button style={sBtn} onClick={submit} disabled={loading}>{loading ? 'Calculating…' : 'Get my quote'}</button>
              </div>
            </div>
          )}

          {step === 5 && result && (
            <div>
              <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
                <div style={{ fontSize: 14, color: BRAND.gray600, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.2 }}>Your estimated price</div>
                <div style={{ fontSize: 56, fontWeight: 800, color: BRAND.navy, fontFamily: "'JetBrains Mono', monospace", marginTop: 8 }}>${result.monthly_total}<span style={{ fontSize: 22, fontWeight: 600, color: BRAND.gray600 }}>/mo</span></div>
                <div style={{ fontSize: 14, color: BRAND.gray600, marginTop: 8 }}>Typical range: <strong>${result.variance_low} – ${result.variance_high}</strong> per month</div>
                <div style={{ fontSize: 13, color: BRAND.gray600, marginTop: 4 }}>${result.annual_total} per year · {result.service_interest}</div>
              </div>

              <div style={{ padding: 16, background: BRAND.greenLight, borderRadius: 10, color: BRAND.gray800, fontSize: 14, lineHeight: 1.55 }}>
                We just sent this to our team. <strong>A Waves specialist will text or call you shortly</strong> to confirm the final price and schedule your first visit.
              </div>

              <div style={{ marginTop: 24, display: 'grid', gap: 12 }}>
                <a href="tel:+19413187612" style={{ ...sBtn, textAlign: 'center', textDecoration: 'none', display: 'block' }}>Call (941) 318-7612</a>
                <button style={sBtnGhost} onClick={() => { setStep(1); setResult(null); setError(''); }}>Start a new quote</button>
              </div>
            </div>
          )}
        </div>

        <p style={{ textAlign: 'center', fontSize: 12, color: BRAND.gray600, marginTop: 20 }}>
          Prices based on property size and service selection. Final quote confirmed by a Waves specialist.
        </p>
      </div>

      <BrandFooter />
    </div>
  );
}
