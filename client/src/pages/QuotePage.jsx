import { useState, useEffect } from 'react';
import AddressAutocomplete from '../components/AddressAutocomplete';
import BrandFooter from '../components/BrandFooter';
import { Button } from '../components/Button';

function captureAttribution() {
  if (typeof window === 'undefined') return null;
  try {
    const p = new URLSearchParams(window.location.search);
    const utm = {
      source: p.get('utm_source') || null,
      medium: p.get('utm_medium') || null,
      campaign: p.get('utm_campaign') || null,
      term: p.get('utm_term') || null,
      content: p.get('utm_content') || null,
    };
    const hasUtm = Object.values(utm).some(Boolean);
    const gclid = p.get('gclid') || null;
    const referrer = document.referrer || null;
    const landing_url = window.location.href || null;
    if (!hasUtm && !gclid && !referrer) return null;
    return { utm: hasUtm ? utm : null, gclid, referrer, landing_url };
  } catch {
    return null;
  }
}

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Mirrored from wavespestcontrol.com Astro @theme tokens (van-vinyl spec)
const BRAND = {
  navy: '#1B2C5B',
  teal: '#009CDE',
  tealDark: '#065A8C',
  tealLight: '#E3F5FD',
  warmWhite: '#FFFFFF',
  coral: '#C8102E',
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
  { id: 'quarterly', label: 'Quarterly', sub: '4 visits / yr' },
  { id: 'bimonthly', label: 'Bi-Monthly', sub: '6 visits / yr' },
  { id: 'monthly', label: 'Monthly', sub: '12 visits / yr' },
];

const GRASS_TYPES = [
  { id: 'st_augustine', label: 'St. Augustine' },
  { id: 'bahia', label: 'Bahia' },
  { id: 'bermuda', label: 'Bermuda' },
  { id: 'zoysia', label: 'Zoysia' },
];

export default function QuotePage() {
  const [step, setStep] = useState(1);
  const [contact, setContact] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [address, setAddress] = useState({ formatted: '', line1: '', city: '', state: 'FL', zip: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Lookup state
  const [lookupStatus, setLookupStatus] = useState('');
  const [lookupSub, setLookupSub] = useState('');
  const [leadId, setLeadId] = useState(null);
  const [enriched, setEnriched] = useState(null);
  const [satellite, setSatellite] = useState(null);
  const [aiSources, setAiSources] = useState(null);

  // Quote inputs
  const [svcPest, setSvcPest] = useState(true);
  const [svcLawn, setSvcLawn] = useState(false);
  const [pestFreq, setPestFreq] = useState('quarterly');
  const [grassType, setGrassType] = useState('st_augustine');
  const [homeSqFt, setHomeSqFt] = useState('');
  const [lotSqFt, setLotSqFt] = useState('');

  const [result, setResult] = useState(null);
  const [attribution] = useState(() => captureAttribution());

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

  function validateLeadForm() {
    if (!contact.firstName.trim()) return 'Enter your first name.';
    if (!contact.lastName.trim()) return 'Enter your last name.';
    if (!/^\S+@\S+\.\S+$/.test(contact.email)) return 'Enter a valid email.';
    if (contact.phone.length !== 10) return 'Enter a 10-digit phone number.';
    if (!address.formatted || address.formatted.trim().length < 5) return 'Enter your address.';
    return '';
  }

  async function runLookup() {
    const v = validateLeadForm();
    if (v) { setError(v); return; }
    setError('');
    setLookupStatus('Looking up property... (RentCast + AI Satellite Analysis)');
    setLookupSub('Running AI satellite analysis...');
    setStep(2);
    try {
      const r = await fetch(`${API_BASE}/public/estimator/property-lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: contact.firstName.trim(),
          lastName: contact.lastName.trim(),
          email: contact.email.trim(),
          phone: contact.phone,
          address: address.formatted,
          attribution: attribution || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Lookup failed.');
      setLeadId(d.lead_id || null);
      setEnriched(d.enriched || null);
      setSatellite(d.satellite || null);
      setAiSources(d.aiAnalysis?.sources || null);
      if (d.enriched?.homeSqFt) setHomeSqFt(String(d.enriched.homeSqFt));
      if (d.enriched?.lotSqFt) setLotSqFt(String(d.enriched.lotSqFt));
      setLookupStatus('Property analyzed');
      setLookupSub('');
      setStep(3);
    } catch (e) {
      setError(e.message || 'Lookup failed.');
      setLookupStatus('');
      setLookupSub('');
      setStep(1);
    }
  }

  async function generateQuote() {
    setError('');
    if (!svcPest && !svcLawn) { setError('Pick at least one service.'); return; }
    const sq = Number(homeSqFt);
    if (!sq || sq < 500) { setError('Confirm your home square footage (min 500).'); return; }

    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/public/quote/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: leadId || undefined,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          phone: contact.phone,
          address: address.line1 || address.formatted,
          city: address.city,
          zip: address.zip,
          homeSqFt: sq,
          lotSqFt: Number(lotSqFt) || undefined,
          stories: Number(enriched?.stories) || 1,
          propertyType: enriched?.propertyType || 'Single Family',
          enriched: enriched || undefined,
          services: {
            ...(svcPest ? { pest: { frequency: pestFreq } } : {}),
            ...(svcLawn ? { lawn: { track: grassType, tier: 'enhanced' } } : {}),
          },
          attribution: attribution || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not calculate.');
      setResult(d);
      setStep(4);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function resetAll() {
    setStep(1);
    setResult(null);
    setError('');
    setLookupStatus('');
    setLookupSub('');
    setLeadId(null);
    setEnriched(null);
    setSatellite(null);
    setAiSources(null);
    setHomeSqFt('');
    setLotSqFt('');
  }

  const sPage = { minHeight: '100vh', background: BRAND.gray100, fontFamily: "'Inter', system-ui, sans-serif", color: BRAND.gray800, display: 'flex', flexDirection: 'column' };
  const sWrap = { maxWidth: 680, margin: '0 auto', padding: '32px 20px', width: '100%', flex: 1, boxSizing: 'border-box' };
  const sCard = { background: BRAND.warmWhite, borderRadius: 16, padding: 28, boxShadow: '0 4px 20px rgba(27,44,91,0.08)', border: `1px solid ${BRAND.gray200}` };
  const sLabel = { display: 'block', fontSize: 13, fontWeight: 600, color: BRAND.gray800, marginBottom: 6 };
  const sInput = { width: '100%', padding: '12px 14px', border: `1.5px solid ${BRAND.gray300}`, borderRadius: 10, fontSize: 16, fontFamily: 'inherit', boxSizing: 'border-box', background: BRAND.warmWhite };
  const sChip = (on) => ({ padding: '14px 18px', borderRadius: 10, border: `2px solid ${on ? BRAND.teal : BRAND.gray300}`, background: on ? BRAND.tealLight : BRAND.warmWhite, cursor: 'pointer', fontSize: 15, fontWeight: on ? 700 : 500, color: on ? BRAND.navy : BRAND.gray800, textAlign: 'left', display: 'block', width: '100%' });

  const totalSteps = 4;
  const progress = (step / totalSteps) * 100;

  return (
    <div style={sPage}>
      <header style={{ background: BRAND.navy, color: BRAND.warmWhite, padding: '20px 20px' }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 0.2 }}>Get a Quote</div>
          <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>Instant pricing from Waves Pest Control &amp; Lawn Care · SWFL</div>
        </div>
      </header>

      <div style={sWrap}>
        <div style={{ height: 6, background: BRAND.gray200, borderRadius: 4, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${progress}%`, background: BRAND.teal, transition: 'width 0.3s' }} />
        </div>

        <div style={sCard}>
          {step === 1 && (
            <div>
              <h2 style={{ marginTop: 0, fontSize: 24, color: BRAND.navy }}>Tell us where to send your quote</h2>
              <p style={{ color: BRAND.gray600, fontSize: 14, marginBottom: 22 }}>Takes about 30 seconds. We serve Manatee, Sarasota, and Charlotte counties.</p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={sLabel}>First name</label>
                  <input style={sInput} value={contact.firstName} onChange={(e) => setContact(c => ({ ...c, firstName: e.target.value }))} autoComplete="given-name" />
                </div>
                <div>
                  <label style={sLabel}>Last name</label>
                  <input style={sInput} value={contact.lastName} onChange={(e) => setContact(c => ({ ...c, lastName: e.target.value }))} autoComplete="family-name" />
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={sLabel}>Mobile phone</label>
                <input style={sInput} type="tel" value={formatPhone(contact.phone)} onChange={(e) => setPhone(e.target.value)} placeholder="(941) 555-1234" autoComplete="tel" />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={sLabel}>Email</label>
                <input style={sInput} type="email" value={contact.email} onChange={(e) => setContact(c => ({ ...c, email: e.target.value }))} autoComplete="email" />
              </div>
              <div>
                <label style={sLabel}>Property address</label>
                <AddressAutocomplete
                  value={address.formatted}
                  onChange={(v) => setAddress(a => ({ ...a, formatted: v }))}
                  onSelect={(p) => setAddress({ formatted: p.formatted, line1: p.line1, city: p.city, state: p.state, zip: p.zip })}
                  placeholder="Start typing your address..."
                  style={sInput}
                />
              </div>

              {error && <div style={{ marginTop: 16, padding: 12, background: '#FEE2E2', color: BRAND.coral, borderRadius: 8, fontSize: 14 }}>{error}</div>}

              <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="primary" onClick={runLookup} style={{ fontSize: 16 }}>Continue</Button>
              </div>
              <p style={{ fontSize: 12, color: BRAND.gray600, marginTop: 16, lineHeight: 1.5 }}>
                By continuing you agree to receive texts and emails from Waves about your quote. Msg &amp; data rates may apply. Reply STOP to opt out.
              </p>
            </div>
          )}

          {step === 2 && (
            <LookupLoading status={lookupStatus} sub={lookupSub} satellite={satellite} aiSources={aiSources} address={address.formatted} BRAND={BRAND} />
          )}

          {step === 3 && (
            <div>
              <h2 style={{ marginTop: 0, fontSize: 22, color: BRAND.navy }}>Generate your quote</h2>
              <p style={{ color: BRAND.gray600, fontSize: 14, marginBottom: 16 }}>
                {enriched?.homeSqFt
                  ? <>We detected a <strong>{Number(enriched.homeSqFt).toLocaleString()} sq ft</strong> {enriched.propertyType || 'home'}{enriched.yearBuilt ? <> built in {enriched.yearBuilt}</> : null}. Confirm and pick your service below.</>
                  : <>Confirm your details and pick your service below.</>}
              </p>

              {satellite?.closeUrl && (
                <div style={{ marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: `1px solid ${BRAND.gray200}` }}>
                  <img src={satellite.closeUrl} alt="Property satellite view" style={{ width: '100%', height: 'auto', display: 'block' }} />
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={sLabel}>Home square footage</label>
                  <input style={sInput} type="number" inputMode="numeric" value={homeSqFt} onChange={(e) => setHomeSqFt(e.target.value)} placeholder="2000" />
                </div>
                <div>
                  <label style={sLabel}>Lot size (sq ft)</label>
                  <input style={sInput} type="number" inputMode="numeric" value={lotSqFt} onChange={(e) => setLotSqFt(e.target.value)} placeholder="8000" />
                </div>
              </div>

              <label style={sLabel}>Which services do you want?</label>
              <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
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
                <div style={{ marginBottom: 16 }}>
                  <label style={sLabel}>Grass type</label>
                  <select style={sInput} value={grassType} onChange={(e) => setGrassType(e.target.value)}>
                    {GRASS_TYPES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                  </select>
                </div>
              )}

              {error && <div style={{ marginTop: 8, padding: 12, background: '#FEE2E2', color: BRAND.coral, borderRadius: 8, fontSize: 14 }}>{error}</div>}

              <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
                <Button variant="secondary" onClick={() => setStep(1)} disabled={loading} style={{ fontSize: 16, padding: '14px 24px' }}>Back</Button>
                <Button variant="primary" onClick={generateQuote} disabled={loading} style={{ fontSize: 16 }}>{loading ? 'Calculating…' : 'Generate Quote'}</Button>
              </div>
            </div>
          )}

          {step === 4 && result && (
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
                <Button variant="primary" as="a" href="tel:+19413187612" style={{ fontSize: 16, textAlign: 'center', textDecoration: 'none', display: 'flex' }}>Call (941) 318-7612</Button>
                <Button variant="secondary" onClick={resetAll} style={{ fontSize: 16, padding: '14px 24px' }}>Start a new quote</Button>
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

function LookupLoading({ status, sub, satellite, aiSources, address, BRAND }) {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const t = setInterval(() => setDots(d => (d.length >= 3 ? '' : d + '.')), 400);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ textAlign: 'center', padding: '16px 0' }}>
      <div style={{ fontSize: 12, color: BRAND.gray600, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6 }}>Property Lookup</div>
      <h2 style={{ marginTop: 0, fontSize: 20, color: BRAND.navy, marginBottom: 8 }}>{status || 'Looking up property...'}{dots}</h2>
      {sub && <div style={{ fontSize: 14, color: BRAND.gray600, marginBottom: 20 }}>{sub}</div>}
      <div style={{ fontSize: 13, color: BRAND.gray600, marginBottom: 20 }}>{address}</div>

      <div style={{ width: 80, height: 80, margin: '24px auto', borderRadius: '50%', border: `4px solid ${BRAND.gray200}`, borderTopColor: BRAND.teal, animation: 'qp-spin 0.9s linear infinite' }} />
      <style>{`@keyframes qp-spin { to { transform: rotate(360deg); } }`}</style>

      {satellite?.closeUrl && (
        <div style={{ marginTop: 16, borderRadius: 10, overflow: 'hidden', border: `1px solid ${BRAND.gray200}` }}>
          <img src={satellite.closeUrl} alt="Property satellite view" style={{ width: '100%', height: 'auto', display: 'block' }} />
        </div>
      )}
      {aiSources && (
        <div style={{ fontSize: 12, color: BRAND.gray600, marginTop: 12 }}>
          AI sources: {aiSources.join(' + ')}
        </div>
      )}
    </div>
  );
}
