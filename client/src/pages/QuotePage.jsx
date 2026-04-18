import { useState, useEffect } from 'react';
import AddressAutocomplete from '../components/AddressAutocomplete';
import BrandFooter from '../components/BrandFooter';
import { Button } from '../components/Button';
import { COLORS, FONTS } from '../theme-brand';

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

const NEXT_STEPS = [
  { n: 1, text: <><strong>You tell us who you are</strong> — takes about 30 seconds</> },
  { n: 2, text: <><strong>We analyze your property</strong> — RentCast records + AI satellite imagery</> },
  { n: 3, text: <><strong>We generate your price</strong> — instant, honest, no haggling</> },
  { n: 4, text: <><strong>A Waves specialist confirms</strong> — text or call to lock it in same-day</> },
];

export default function QuotePage() {
  const [step, setStep] = useState(1);
  const [contact, setContact] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [address, setAddress] = useState({ formatted: '', line1: '', city: '', state: 'FL', zip: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [lookupStatus, setLookupStatus] = useState('');
  const [lookupSub, setLookupSub] = useState('');
  const [leadId, setLeadId] = useState(null);
  const [enriched, setEnriched] = useState(null);
  const [satellite, setSatellite] = useState(null);
  const [aiSources, setAiSources] = useState(null);

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

  // ---------- Style tokens (mirrors Astro homepage) ----------
  const sPage = {
    minHeight: '100vh',
    background: COLORS.white,
    fontFamily: FONTS.body,
    color: COLORS.navy,
    display: 'flex',
    flexDirection: 'column',
  };

  const sHero = {
    position: 'relative',
    background: COLORS.blueDeeper,
    color: COLORS.white,
    padding: 'clamp(64px, 8vw, 112px) 24px',
    textAlign: 'center',
    overflow: 'hidden',
  };

  const sHeroOverlay = {
    position: 'absolute',
    inset: 0,
    background: `linear-gradient(135deg, ${COLORS.blueDeeper}E6 0%, ${COLORS.blueDark}B3 55%, ${COLORS.wavesBlue}80 100%)`,
    pointerEvents: 'none',
  };

  const sH1 = {
    fontFamily: FONTS.display,
    fontSize: 'clamp(36px, 6vw, 60px)',
    fontWeight: 400,
    lineHeight: 1.05,
    letterSpacing: '0.02em',
    margin: '0 0 16px',
    color: COLORS.white,
  };

  const sHeroSub = {
    fontSize: 'clamp(16px, 2vw, 20px)',
    lineHeight: 1.55,
    margin: '0 auto 24px',
    maxWidth: 640,
    color: COLORS.white,
  };

  const sFormSection = {
    background: COLORS.wavesBlue,
    padding: 'clamp(56px, 7vw, 96px) 24px',
  };

  const sFormWrap = {
    maxWidth: 1120,
    margin: '0 auto',
    display: 'grid',
    gap: 48,
    gridTemplateColumns: '1fr',
    alignItems: 'start',
  };

  const sLeft = { color: COLORS.white };

  const sLeftH2 = {
    fontFamily: FONTS.display,
    fontSize: 'clamp(28px, 4vw, 42px)',
    fontWeight: 400,
    lineHeight: 1.1,
    letterSpacing: '0.02em',
    margin: '0 0 12px',
    color: COLORS.white,
  };

  const sLeftSub = {
    fontFamily: FONTS.body,
    fontSize: 18,
    lineHeight: 1.55,
    margin: '0 0 28px',
    color: COLORS.white,
    opacity: 0.95,
  };

  const sLeftH3 = {
    fontFamily: FONTS.display,
    fontSize: 22,
    fontWeight: 400,
    letterSpacing: '0.02em',
    margin: '0 0 16px',
    color: COLORS.white,
  };

  const sStepBadge = {
    flexShrink: 0,
    width: 32,
    height: 32,
    borderRadius: 9999,
    background: COLORS.yellow,
    color: COLORS.blueDeeper,
    fontFamily: FONTS.ui,
    fontWeight: 800,
    fontSize: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  const sCard = {
    background: COLORS.white,
    borderRadius: 16,
    padding: 'clamp(24px, 3vw, 40px)',
    boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
    minHeight: 420,
  };

  const sLabel = {
    display: 'block',
    fontFamily: FONTS.ui,
    fontSize: 13,
    fontWeight: 600,
    color: COLORS.navy,
    marginBottom: 6,
  };

  const sInput = {
    width: '100%',
    padding: '12px 14px',
    border: `1.5px solid ${COLORS.grayLight}`,
    borderRadius: 10,
    fontSize: 16,
    fontFamily: FONTS.body,
    color: COLORS.navy,
    boxSizing: 'border-box',
    background: COLORS.white,
    outline: 'none',
  };

  const sChip = (on) => ({
    padding: '14px 18px',
    borderRadius: 12,
    border: `2px solid ${on ? COLORS.wavesBlue : COLORS.slate200}`,
    background: on ? COLORS.blueLight : COLORS.white,
    cursor: 'pointer',
    fontFamily: FONTS.body,
    fontSize: 15,
    fontWeight: on ? 700 : 500,
    color: on ? COLORS.blueDeeper : COLORS.textBody,
    textAlign: 'left',
    display: 'block',
    width: '100%',
    transition: 'transform 0.15s cubic-bezier(0.4,0,0.2,1), background 0.15s, border-color 0.15s',
  });

  const sCardH2 = {
    fontFamily: FONTS.heading,
    fontSize: 22,
    fontWeight: 700,
    color: COLORS.blueDeeper,
    margin: '0 0 6px',
  };

  const sCardSub = {
    fontFamily: FONTS.body,
    fontSize: 14,
    color: COLORS.textBody,
    margin: '0 0 22px',
    lineHeight: 1.55,
  };

  const sError = {
    marginTop: 16,
    padding: 12,
    background: '#FEE2E2',
    color: COLORS.red,
    borderRadius: 8,
    fontSize: 14,
    fontFamily: FONTS.body,
  };

  const totalSteps = 4;
  const progress = (step / totalSteps) * 100;

  return (
    <div style={sPage}>
      <style>{`
        @keyframes qp-spin { to { transform: rotate(360deg); } }
        @media (min-width: 900px) {
          .qp-form-grid { grid-template-columns: 1fr 1fr !important; gap: 64px !important; }
        }
        .qp-chip:hover { transform: scale(1.02); }
      `}</style>

      {/* Hero */}
      <section style={sHero}>
        <div style={sHeroOverlay} aria-hidden />
        <div style={{ position: 'relative', maxWidth: 880, margin: '0 auto' }}>
          <h1 style={sH1}>Get a Free Quote in 60 Seconds.</h1>
          <p style={sHeroSub}>
            Tell us about your property — we'll analyze it with satellite + records and send a price same-day. Serving Manatee, Sarasota, and Charlotte counties.
          </p>
          <Button variant="primary" as="a" href="tel:+19413187612" style={{ fontSize: 16 }}>
            Call (941) 318-7612
          </Button>
          <p style={{ fontSize: 14, marginTop: 12, color: COLORS.white, opacity: 0.85 }}>
            Prefer to call? Most quotes go out same-day.
          </p>
        </div>
      </section>

      {/* Form section */}
      <section style={sFormSection}>
        <div className="qp-form-grid" style={sFormWrap}>
          {/* Left: next-steps explainer */}
          <div style={sLeft}>
            <h2 style={sLeftH2}>Get Your Price. Keep Your Saturday.</h2>
            <p style={sLeftSub}>
              Tell us what's going on. We'll handle the rest — most quotes go out same-day.
            </p>
            <h3 style={sLeftH3}>Here's what happens next</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 16 }}>
              {NEXT_STEPS.map(({ n, text }) => (
                <li key={n} style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  <span style={sStepBadge}>{n}</span>
                  <span style={{ fontSize: 16, lineHeight: 1.55, color: COLORS.white }}>{text}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Right: card */}
          <div style={sCard}>
            {/* Progress bar */}
            <div style={{ height: 6, background: COLORS.offWhite, borderRadius: 4, marginBottom: 20, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progress}%`, background: COLORS.wavesBlue, transition: 'width 0.3s' }} />
            </div>

            {step === 1 && (
              <div>
                <h2 style={sCardH2}>Tell us where to send your quote</h2>
                <p style={sCardSub}>Takes about 30 seconds. We serve Manatee, Sarasota, and Charlotte counties.</p>

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

                {error && <div style={sError}>{error}</div>}

                <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="primary" onClick={runLookup} style={{ fontSize: 16 }}>Continue</Button>
                </div>
                <p style={{ fontSize: 12, color: COLORS.textCaption, marginTop: 16, lineHeight: 1.5 }}>
                  By continuing you agree to receive texts and emails from Waves about your quote. Msg &amp; data rates may apply. Reply STOP to opt out.
                </p>
              </div>
            )}

            {step === 2 && (
              <LookupLoading status={lookupStatus} sub={lookupSub} satellite={satellite} aiSources={aiSources} address={address.formatted} />
            )}

            {step === 3 && (
              <div>
                <h2 style={sCardH2}>Generate your quote</h2>
                <p style={sCardSub}>
                  {enriched?.homeSqFt
                    ? <>We detected a <strong>{Number(enriched.homeSqFt).toLocaleString()} sq ft</strong> {enriched.propertyType || 'home'}{enriched.yearBuilt ? <> built in {enriched.yearBuilt}</> : null}. Confirm and pick your service below.</>
                    : <>Confirm your details and pick your service below.</>}
                </p>

                {satellite?.closeUrl && (
                  <div style={{ marginBottom: 16, borderRadius: 12, overflow: 'hidden', border: `1px solid ${COLORS.slate200}` }}>
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
                  <button type="button" className="qp-chip" style={sChip(svcPest)} onClick={() => setSvcPest(!svcPest)}>
                    <div style={{ fontSize: 16 }}>Pest Control</div>
                    <div style={{ fontSize: 13, color: COLORS.textCaption, fontWeight: 500, marginTop: 2 }}>Interior + exterior treatment, covered pests</div>
                  </button>
                  <button type="button" className="qp-chip" style={sChip(svcLawn)} onClick={() => setSvcLawn(!svcLawn)}>
                    <div style={{ fontSize: 16 }}>Lawn Care</div>
                    <div style={{ fontSize: 13, color: COLORS.textCaption, fontWeight: 500, marginTop: 2 }}>Fertilization + weed control program</div>
                  </button>
                </div>

                {svcPest && (
                  <div style={{ marginBottom: 16 }}>
                    <label style={sLabel}>Pest treatment frequency</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                      {PEST_FREQS.map(f => (
                        <button key={f.id} type="button" className="qp-chip" style={sChip(pestFreq === f.id)} onClick={() => setPestFreq(f.id)}>
                          <div style={{ fontSize: 14 }}>{f.label}</div>
                          <div style={{ fontSize: 11, color: COLORS.textCaption, fontWeight: 500, marginTop: 2 }}>{f.sub}</div>
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

                {error && <div style={sError}>{error}</div>}

                <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <Button variant="secondary" onClick={() => setStep(1)} disabled={loading} style={{ fontSize: 16 }}>Back</Button>
                  <Button variant="primary" onClick={generateQuote} disabled={loading} style={{ fontSize: 16 }}>{loading ? 'Calculating…' : 'Generate Quote'}</Button>
                </div>
              </div>
            )}

            {step === 4 && result && (
              <div>
                <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
                  <div style={{ fontSize: 13, color: COLORS.textCaption, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.2 }}>Your estimated price</div>
                  <div style={{ fontSize: 56, fontWeight: 800, color: COLORS.blueDeeper, fontFamily: FONTS.mono, marginTop: 8, lineHeight: 1 }}>
                    ${result.monthly_total}
                    <span style={{ fontSize: 22, fontWeight: 600, color: COLORS.textCaption }}>/mo</span>
                  </div>
                  <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 12 }}>Typical range: <strong>${result.variance_low} – ${result.variance_high}</strong> per month</div>
                  <div style={{ fontSize: 13, color: COLORS.textCaption, marginTop: 4 }}>${result.annual_total} per year · {result.service_interest}</div>
                </div>

                <div style={{ padding: 16, background: '#DCFCE7', borderRadius: 12, color: COLORS.navy, fontSize: 14, lineHeight: 1.55 }}>
                  We just sent this to our team. <strong>A Waves specialist will text or call you shortly</strong> to confirm the final price and schedule your first visit.
                </div>

                <div style={{ marginTop: 24, display: 'grid', gap: 12 }}>
                  <Button variant="primary" as="a" href="tel:+19413187612" style={{ fontSize: 16, textAlign: 'center', textDecoration: 'none' }}>Call (941) 318-7612</Button>
                  <Button variant="secondary" onClick={resetAll} style={{ fontSize: 16 }}>Start a new quote</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <BrandFooter />
    </div>
  );
}

function LookupLoading({ status, sub, satellite, aiSources, address }) {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const t = setInterval(() => setDots(d => (d.length >= 3 ? '' : d + '.')), 400);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ textAlign: 'center', padding: '16px 0' }}>
      <div style={{ fontSize: 12, color: COLORS.textCaption, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6, fontFamily: FONTS.ui }}>Property Lookup</div>
      <h2 style={{ margin: '0 0 8px', fontFamily: FONTS.heading, fontSize: 22, fontWeight: 700, color: COLORS.blueDeeper }}>
        {status || 'Looking up property...'}{dots}
      </h2>
      {sub && <div style={{ fontSize: 14, color: COLORS.textBody, marginBottom: 20 }}>{sub}</div>}
      <div style={{ fontSize: 13, color: COLORS.textCaption, marginBottom: 20 }}>{address}</div>

      <div style={{ width: 80, height: 80, margin: '24px auto', borderRadius: '50%', border: `4px solid ${COLORS.offWhite}`, borderTopColor: COLORS.wavesBlue, animation: 'qp-spin 0.9s linear infinite' }} />

      {satellite?.closeUrl && (
        <div style={{ marginTop: 16, borderRadius: 12, overflow: 'hidden', border: `1px solid ${COLORS.slate200}` }}>
          <img src={satellite.closeUrl} alt="Property satellite view" style={{ width: '100%', height: 'auto', display: 'block' }} />
        </div>
      )}
      {aiSources && (
        <div style={{ fontSize: 12, color: COLORS.textCaption, marginTop: 12 }}>
          AI sources: {aiSources.join(' + ')}
        </div>
      )}
    </div>
  );
}
