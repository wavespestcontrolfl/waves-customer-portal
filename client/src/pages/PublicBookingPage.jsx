import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import AddressAutocomplete from '../components/AddressAutocomplete';
import BrandFooter from '../components/BrandFooter';
import { Button } from '../components/Button';
import { GOLD_CTA } from '../theme-brand';

const WAVES_PHONE_DISPLAY = '(941) 318-7612';
const WAVES_PHONE_TEL = '+19413187612';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Brand tokens (match existing BookingPage for visual consistency)
// Mirrored from wavespestcontrol.com — semantic keys preserved, values swapped to brand
const BRAND = {
  navy: '#1B2C5B',       // brand-blueDeeper (PMS 2766) — headings, dark surfaces
  teal: '#009CDE',       // brand-blue (PMS 2925) — primary accent
  tealDark: '#065A8C',   // brand-blueDark
  tealLight: '#E3F5FD',  // brand-blueLight
  sand: '#F8FAFC',       // slate-50 — cool neutral surface (van-wrap brand)
  warmWhite: '#FFFFFF',
  coral: '#C8102E',      // brand-red (PMS 186)
  gold: '#FFD700',       // brand-gold
  goldHover: '#FFF176',  // gold CTA hover
  green: '#16A34A',
  greenLight: '#DCFCE7',
  gray100: '#F1F5F9',    // slate-100
  gray200: '#E2E8F0',    // slate-200
  gray300: '#CBD5E1',    // slate-300
  gray400: '#94A3B8',    // slate-400
  gray600: '#475569',    // slate-600
  gray800: '#1E293B',    // slate-800
};

const SERVICES = [
  { id: 'pest_control', label: 'Pest Control', duration: 45, icon: '🐜', desc: 'Quarterly interior + exterior treatment' },
  { id: 'lawn_care', label: 'Lawn Care', duration: 60, icon: '🌱', desc: 'Fertilization + weed control program' },
  { id: 'mosquito', label: 'Mosquito Control', duration: 45, icon: '🦟', desc: 'WaveGuard barrier treatment' },
  { id: 'tree_shrub', label: 'Tree & Shrub', duration: 60, icon: '🌳', desc: 'Ornamental plant care' },
  { id: 'termite', label: 'Termite Inspection', duration: 90, icon: '🪵', desc: 'WDO inspection + treatment plan' },
  { id: 'rodent', label: 'Rodent Control', duration: 60, icon: '🐀', desc: 'Exclusion + monitoring stations' },
];

export default function PublicBookingPage() {
  const [searchParams] = useSearchParams();
  const source = searchParams.get('source') || 'direct';
  const serviceParam = searchParams.get('service') || 'pest_control';
  const initialService = SERVICES.find(s => s.id === serviceParam) || SERVICES[0];
  const isEmbedded = window !== window.parent;

  // Post height updates to parent when embedded in an iframe
  useEffect(() => {
    if (!isEmbedded) return;
    const postHeight = () => {
      const h = document.documentElement.scrollHeight;
      try { window.parent.postMessage({ type: 'waves-book-resize', height: h }, '*'); } catch { /* cross-origin */ }
    };
    postHeight();
    const ro = new ResizeObserver(postHeight);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [isEmbedded]);

  const [step, setStep] = useState(1);
  const [navOpen, setNavOpen] = useState(false);
  const [service, setService] = useState(initialService);
  const [address, setAddress] = useState({ line1: '', city: '', state: 'FL', zip: '' });
  const [coords, setCoords] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [contact, setContact] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [notes, setNotes] = useState('');
  const [existingCustomerId, setExistingCustomerId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confCode, setConfCode] = useState('');

  // Step 2 → load availability whenever we enter it
  const loadAvailability = useCallback(async () => {
    if (!service || !address.line1) return;
    setLoading(true);
    setError('');
    try {
      const fullAddress = `${address.line1}, ${address.city}, ${address.state} ${address.zip}`;
      const params = new URLSearchParams({
        address: fullAddress,
        city: address.city,
        service_type: service.id,
        duration_minutes: String(service.duration),
      });
      const res = await fetch(`${API_BASE}/booking/availability?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load availability');
      setAvailability(data.days || []);
      if (data.lat && data.lng) setCoords({ lat: data.lat, lng: data.lng });
      if (!data.days || data.days.length === 0) {
        setError('No times available in the next 2 weeks. Call (941) 877-9887 and we\'ll get you on the schedule.');
      }
    } catch (err) {
      setError(err.message);
      setAvailability([]);
    }
    setLoading(false);
  }, [service, address]);

  useEffect(() => {
    if (step === 2) loadAvailability();
  }, [step, loadAvailability]);

  // Detect existing customer by phone on step 3
  const checkExistingCustomer = useCallback(async (phone) => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) return;
    try {
      const res = await fetch(`${API_BASE}/booking/customer-lookup?phone=${digits}`);
      if (res.ok) {
        const data = await res.json();
        if (data.customer) {
          setExistingCustomerId(data.customer.id);
          setContact(c => ({
            ...c,
            firstName: c.firstName || data.customer.first_name || '',
            lastName: c.lastName || data.customer.last_name || '',
            email: c.email || data.customer.email || '',
          }));
        }
      }
    } catch { /* best-effort */ }
  }, []);

  const handleConfirm = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/booking/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: existingCustomerId || null,
          slot_date: selectedDate,
          slot_start: selectedSlot.start_time,
          slot_end: selectedSlot.end_time,
          technician_id: selectedSlot.technician_id,
          service_type: service.label,
          duration_minutes: service.duration,
          customer_notes: notes,
          source,
          referrer_url: document.referrer || null,
          // New-customer payload — server will create if no customer_id
          new_customer: existingCustomerId ? null : {
            first_name: contact.firstName,
            last_name: contact.lastName,
            phone: contact.phone.replace(/\D/g, ''),
            email: contact.email,
            address_line1: address.line1,
            city: address.city,
            state: address.state,
            zip: address.zip,
            lat: coords?.lat,
            lng: coords?.lng,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Booking failed');
      setConfCode(data.confirmationCode || 'WPC-????');
      setStep(4);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  // ── shared styles ──
  // CTAs use <Button variant="primary"|"tertiary"> (see usages below).
  const inputStyle = {
    width: '100%', padding: '12px 14px', borderRadius: 8,
    border: `1.5px solid ${BRAND.gray300}`, fontSize: 15,
    color: BRAND.gray800, background: '#fff',
    outline: 'none', transition: 'border-color 0.2s',
  };
  const labelStyle = {
    fontSize: 13, fontWeight: 500, color: BRAND.gray600,
    display: 'block', marginBottom: 6,
  };

  // Step-aware sticky bottom bar primary CTA
  const primaryCTA = (() => {
    if (step === 1) return { label: 'Find my times', onClick: () => setStep(2), disabled: !address.line1 || !address.city || !address.zip };
    if (step === 2) return { label: 'Continue', onClick: () => setStep(3), disabled: !selectedSlot };
    if (step === 3) return { label: loading ? 'Booking…' : 'Confirm booking', onClick: handleConfirm, disabled: loading || !contact.firstName || !contact.lastName || !contact.phone };
    return null;
  })();

  const phoneIcon = (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fill="currentColor" d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/>
    </svg>
  );

  return (
    <div style={{ minHeight: '100vh', background: BRAND.sand, fontFamily: "'Inter', system-ui, sans-serif", paddingTop: 56, paddingBottom: primaryCTA ? 88 : 0 }}>
      <style>{`
        /* Inter / Anton / Montserrat load globally via client/index.html */
        @keyframes slideUp { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
        @keyframes checkPop { 0% { transform:scale(0) } 60% { transform:scale(1.2) } 100% { transform:scale(1) } }
        @keyframes pulse { 0%,100% { transform:scale(1) } 50% { transform:scale(1.03) } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input, select, button, textarea { font-family: inherit; }
        input:focus { border-color: ${BRAND.teal} !important; }

        .pb-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 60; background: rgba(255,255,255,.94); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid ${BRAND.gray200}; padding: 4px 16px; display: flex; align-items: center; justify-content: space-between; height: 56px; box-sizing: border-box }
        .pb-nav .pb-brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: ${BRAND.navy}; font-family: Montserrat, sans-serif; font-weight: 700; font-size: 15px }
        .pb-nav .pb-brand img { height: 28px; width: auto }
        .pb-hamb { width: 48px; height: 48px; background: transparent; border: none; cursor: pointer; padding: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; border-radius: 8px; transition: background .15s; -webkit-tap-highlight-color: transparent }
        .pb-hamb:hover { background: rgba(15,23,42,.04) }
        .pb-hamb span { display: block; width: 22px; height: 2px; background: ${BRAND.navy}; border-radius: 2px; transition: transform .22s, opacity .22s }
        .pb-hamb.open span:nth-child(1) { transform: translateY(7px) rotate(45deg) }
        .pb-hamb.open span:nth-child(2) { opacity: 0 }
        .pb-hamb.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg) }
        .pb-menu { position: fixed; top: 56px; left: 0; right: 0; z-index: 55; background: #fff; border-bottom: 1px solid ${BRAND.gray200}; box-shadow: 0 8px 20px rgba(15,23,42,.08); transform: translateY(-110%); transition: transform .22s ease-out; padding: 8px 16px 16px }
        .pb-menu.open { transform: translateY(0) }
        .pb-menu a { display: flex; align-items: center; gap: 12px; padding: 14px 8px; color: ${BRAND.navy}; text-decoration: none; font-weight: 600; font-size: 15px; border-bottom: 1px solid ${BRAND.gray200}; min-height: 48px }
        .pb-menu a:last-child { border-bottom: none }
        .pb-menu a:hover { color: ${BRAND.teal} }
        .pb-menu svg { width: 18px; height: 18px; opacity: .6 }

        .pb-sticky { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; background: rgba(255,255,255,.96); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-top: 1px solid ${BRAND.gray200}; padding: 10px 16px calc(12px + env(safe-area-inset-bottom)); display: flex; align-items: center; gap: 10px; box-shadow: 0 -4px 12px rgba(15,23,42,.06) }
        .pb-sticky .pb-sb-cta { flex: 1 1 50%; min-height: 48px; padding: 14px 8px; font-size: 13px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; border-radius: 10px; border: 2px solid ${BRAND.navy}; cursor: pointer; box-shadow: 2px 2px 0 ${BRAND.navy}; display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-decoration: none; transition: background .15s }
        .pb-sticky .pb-sb-cta.gold { background: ${BRAND.gold}; color: ${BRAND.navy} }
        .pb-sticky .pb-sb-cta.gold:hover:not(:disabled) { background: ${BRAND.goldHover} }
        .pb-sticky .pb-sb-cta.gold:disabled { opacity: .55; cursor: not-allowed }
        .pb-sticky .pb-sb-cta.white { background: #fff; color: ${BRAND.navy} }
        .pb-sticky .pb-sb-cta.white:hover { background: ${BRAND.gray100} }
        @media (min-width: 768px) { .pb-sticky { display: none } }

        .pb-trust { list-style: none; padding: 0; margin: 24px 0 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px }
        .pb-trust li { display: flex; align-items: center; gap: 8px; padding: 12px 10px; background: ${BRAND.sand}; border: 1px solid ${BRAND.gray200}; border-radius: 10px; font-size: 13px; font-weight: 600; color: ${BRAND.navy}; line-height: 1.25 }
        .pb-trust svg { width: 16px; height: 16px; flex-shrink: 0; color: ${BRAND.green} }

        .pb-call-inline { display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: 100%; min-height: 48px; padding: 14px 16px; background: #fff; color: ${BRAND.navy}; border: 2px solid ${BRAND.navy}; border-radius: 10px; font-weight: 800; font-size: 14px; letter-spacing: .04em; text-transform: uppercase; text-decoration: none; box-shadow: 3px 3px 0 ${BRAND.navy}; margin-top: 12px }
        .pb-call-inline:hover { background: ${BRAND.gray100} }
      `}</style>

      {/* Fixed top nav + hamburger */}
      <header className="pb-nav">
        <a className="pb-brand" href="https://wavespestcontrol.com" aria-label="Waves Pest Control">
          <img src="/waves-logo.png" alt="" /><span>Waves</span>
        </a>
        <button className={`pb-hamb${navOpen ? ' open' : ''}`} aria-label="Menu" aria-expanded={navOpen} aria-controls="pb-menu" onClick={() => setNavOpen(v => !v)}>
          <span></span><span></span><span></span>
        </button>
      </header>
      <nav id="pb-menu" className={`pb-menu${navOpen ? ' open' : ''}`} aria-hidden={!navOpen} onClick={(e) => { if (e.target.tagName === 'A') setNavOpen(false); }}>
        <a href={`tel:${WAVES_PHONE_TEL}`}>{phoneIcon}Call {WAVES_PHONE_DISPLAY}</a>
        <a href="mailto:contact@wavespestcontrol.com"><svg viewBox="0 0 20 20"><path fill="currentColor" d="M3 4h14a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1zm.5 2l6.5 4.5L16.5 6v-.5H3.5V6z"/></svg>Email us</a>
        <a href="https://wavespestcontrol.com" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 20 20"><path fill="currentColor" d="M10 2a8 8 0 100 16 8 8 0 000-16zm-1 3.1V9H5.2A8 8 0 019 5.1zm2 0A8 8 0 0114.8 9H11V5.1zm-6.5 6H9v3.9A8 8 0 014.5 11zm6.5 0h4.5A8 8 0 0111 14.9z"/></svg>About Waves</a>
      </nav>

      {/* Progress bar — steps 1 (address) → 2 (time) → 3 (contact) → 4 (done) */}
      {step < 4 && (
        <div style={{ background: BRAND.gray200, height: 3 }}>
          <div style={{
            height: 3, background: BRAND.teal,
            width: `${(step / 3) * 100}%`,
            transition: 'width 0.5s cubic-bezier(.4,0,.2,1)',
          }} />
        </div>
      )}

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '40px 24px 60px' }}>

        {/* STEP 1 — Address */}
        {step === 1 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: BRAND.navy, marginBottom: 8, letterSpacing: '-0.5px' }}>
              Find a date &amp; time that works for you
            </h2>
            <p style={{ fontSize: 14, color: BRAND.gray600, marginBottom: 24, lineHeight: 1.5 }}>
              {service ? <>Booking <strong>{service.icon} {service.label}</strong>. </> : null}
              Drop your address and we'll show you the next available slots — see you soon!
            </p>
            <div style={{ display: 'grid', gap: 14, marginBottom: 24 }}>
              <div>
                <label style={labelStyle}>Street address</label>
                <AddressAutocomplete
                  autoFocus
                  value={address.line1}
                  onChange={(v) => setAddress(a => ({ ...a, line1: v }))}
                  onSelect={(parts) => {
                    setAddress(a => ({
                      line1: parts.line1 || parts.formatted || a.line1,
                      city: parts.city || a.city,
                      state: parts.state || a.state,
                      zip: parts.zip || a.zip,
                    }));
                    if (parts.lat && parts.lng) setCoords({ lat: parts.lat, lng: parts.lng });
                  }}
                  placeholder="Start typing your address…"
                  style={inputStyle}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle}>City</label>
                  <input
                    type="text"
                    placeholder="Bradenton"
                    value={address.city}
                    onChange={e => setAddress(a => ({ ...a, city: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>State</label>
                  <input
                    type="text"
                    value={address.state}
                    onChange={e => setAddress(a => ({ ...a, state: e.target.value.toUpperCase() }))}
                    style={inputStyle}
                    maxLength={2}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Zip</label>
                  <input
                    type="text"
                    placeholder="34203"
                    value={address.zip}
                    onChange={e => setAddress(a => ({ ...a, zip: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                    style={inputStyle}
                  />
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!address.line1 || !address.city || !address.zip}
                style={{ ...GOLD_CTA, width: '100%' }}
              >
                Find my best times →
              </button>
            </div>

            <a className="pb-call-inline" href={`tel:${WAVES_PHONE_TEL}`}>
              {phoneIcon} Call {WAVES_PHONE_DISPLAY}
            </a>

            <ul className="pb-trust" aria-label="Why Waves">
              <li><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.5 13.6 4.2 10.3l-1.4 1.4 4.7 4.7 10-10-1.4-1.4z"/></svg>Family-owned, local</li>
              <li><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.5 13.6 4.2 10.3l-1.4 1.4 4.7 4.7 10-10-1.4-1.4z"/></svg>No contracts, ever</li>
              <li><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.5 13.6 4.2 10.3l-1.4 1.4 4.7 4.7 10-10-1.4-1.4z"/></svg>Pet &amp; kid safe</li>
              <li><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.5 13.6 4.2 10.3l-1.4 1.4 4.7 4.7 10-10-1.4-1.4z"/></svg>100% guarantee</li>
            </ul>
          </div>
        )}

        {/* STEP 2 — Times */}
        {step === 2 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: BRAND.navy, marginBottom: 8, letterSpacing: '-0.5px' }}>
              Pick a time
            </h2>
            <p style={{ fontSize: 14, color: BRAND.gray600, marginBottom: 20, lineHeight: 1.5 }}>
              ⭐ Times marked "Best fit" are when we'll already be working near you.
            </p>

            {loading && (
              <div style={{ textAlign: 'center', padding: 40, color: BRAND.gray600 }}>
                <div style={{ fontSize: 13 }}>Checking the route map…</div>
              </div>
            )}

            {error && !loading && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 10, padding: 14, fontSize: 13, color: '#991B1B', marginBottom: 16,
              }}>{error}</div>
            )}

            {!loading && availability.length > 0 && (
              <div style={{ display: 'grid', gap: 14 }}>
                {availability.map(day => (
                  <div key={day.date} style={{
                    background: BRAND.warmWhite, border: `1px solid ${BRAND.gray200}`,
                    borderRadius: 12, padding: 14,
                  }}>
                    <div style={{
                      fontSize: 13, fontWeight: 600, color: BRAND.navy, marginBottom: 10,
                      display: 'flex', alignItems: 'baseline', gap: 8,
                    }}>
                      <span>{day.fullDate}</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                      {day.slots.map((slot, i) => {
                        const isSelected = selectedDate === day.date && selectedSlot?.start_time === slot.start_time;
                        return (
                          <button
                            key={i}
                            onClick={() => { setSelectedDate(day.date); setSelectedSlot(slot); }}
                            style={{
                              padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                              background: isSelected ? BRAND.teal : (slot.is_best_fit ? BRAND.greenLight : '#fff'),
                              color: isSelected ? '#fff' : BRAND.navy,
                              border: `1.5px solid ${isSelected ? BRAND.teal : (slot.is_best_fit ? BRAND.green : BRAND.gray200)}`,
                              textAlign: 'left', transition: 'all 0.15s',
                            }}
                          >
                            {slot.is_best_fit && (
                              <div style={{
                                fontSize: 10, fontWeight: 700, letterSpacing: '0.5px',
                                color: isSelected ? '#fff' : BRAND.green,
                                marginBottom: 2, textTransform: 'uppercase',
                              }}>⭐ Best fit</div>
                            )}
                            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>
                              {slot.start_label}
                            </div>
                            <div style={{
                              fontSize: 11,
                              color: isSelected ? 'rgba(255,255,255,0.85)' : BRAND.gray600,
                              lineHeight: 1.3,
                            }}>
                              {slot.reason}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <Button variant="tertiary" onClick={() => setStep(1)}>← Back</Button>
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={!selectedSlot}
                style={{ ...GOLD_CTA, flex: 1 }}
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* STEP 3 — Contact */}
        {step === 3 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: BRAND.navy, marginBottom: 8, letterSpacing: '-0.5px' }}>
              Your info
            </h2>
            <p style={{ fontSize: 14, color: BRAND.gray600, marginBottom: 20, lineHeight: 1.5 }}>
              We'll text you a confirmation right after you book.
            </p>

            {/* Selected time summary */}
            <div style={{
              background: BRAND.tealLight, border: `1px solid ${BRAND.teal}`,
              borderRadius: 10, padding: 14, marginBottom: 20,
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: BRAND.tealDark, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                Your selected time
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: BRAND.navy }}>
                {availability.find(d => d.date === selectedDate)?.fullDate} · {selectedSlot?.start_label}
              </div>
              <div style={{ fontSize: 12, color: BRAND.gray600, marginTop: 2 }}>
                {service?.label}
              </div>
            </div>

            <div style={{ display: 'grid', gap: 14, marginBottom: 20 }}>
              <div>
                <label style={labelStyle}>Phone number</label>
                <input
                  type="tel" autoFocus
                  placeholder="(941) 555-1234"
                  value={contact.phone}
                  onChange={e => setContact(c => ({ ...c, phone: e.target.value }))}
                  onBlur={() => checkExistingCustomer(contact.phone)}
                  style={inputStyle}
                />
                {existingCustomerId && (
                  <div style={{ fontSize: 12, color: BRAND.green, marginTop: 6 }}>
                    ✓ Welcome back! We have your info on file.
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle}>First name</label>
                  <input
                    type="text"
                    value={contact.firstName}
                    onChange={e => setContact(c => ({ ...c, firstName: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Last name</label>
                  <input
                    type="text"
                    value={contact.lastName}
                    onChange={e => setContact(c => ({ ...c, lastName: e.target.value }))}
                    style={inputStyle}
                  />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Email (optional)</label>
                <input
                  type="email"
                  value={contact.email}
                  onChange={e => setContact(c => ({ ...c, email: e.target.value }))}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Notes for the tech (optional)</label>
                <textarea
                  rows={3}
                  placeholder="Gate code, pets, access instructions…"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: "'Inter', system-ui, sans-serif" }}
                />
              </div>
            </div>

            {error && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 10, padding: 12, fontSize: 13, color: '#991B1B', marginBottom: 16,
              }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <Button variant="tertiary" onClick={() => setStep(2)}>← Back</Button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={loading || !contact.firstName || !contact.lastName || !contact.phone}
                style={{ ...GOLD_CTA, flex: 1 }}
              >
                {loading ? 'Booking…' : 'Confirm booking'}
              </button>
            </div>
          </div>
        )}

        {/* STEP 4 — Confirmation */}
        {step === 4 && (
          <div style={{ animation: 'slideUp 0.4s ease-out', textAlign: 'center', paddingTop: 20 }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%', background: BRAND.greenLight,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px', animation: 'checkPop 0.5s ease-out',
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={BRAND.green} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: BRAND.navy, marginBottom: 8, letterSpacing: '-0.5px' }}>
              You're booked!
            </h2>
            <p style={{ fontSize: 14, color: BRAND.gray600, marginBottom: 24, lineHeight: 1.5 }}>
              We just texted a confirmation to {contact.phone}.
            </p>
            <div style={{
              background: BRAND.warmWhite, border: `1px solid ${BRAND.gray200}`,
              borderRadius: 12, padding: 18, marginBottom: 20, textAlign: 'left',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: BRAND.gray400, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 10 }}>
                Confirmation
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: BRAND.teal, fontFamily: "'JetBrains Mono', monospace", marginBottom: 14 }}>
                {confCode}
              </div>
              <div style={{ fontSize: 13, color: BRAND.gray600, lineHeight: 1.6 }}>
                <div><strong style={{ color: BRAND.navy }}>{service?.label}</strong></div>
                <div>{availability.find(d => d.date === selectedDate)?.fullDate}</div>
                <div>{selectedSlot?.start_label} – {selectedSlot?.end_label}</div>
                <div style={{ marginTop: 6 }}>{address.line1}, {address.city} {address.zip}</div>
              </div>
            </div>
            <p style={{ fontSize: 12, color: BRAND.gray400 }}>
              Need to change it? Text us at (941) 877-9887 or reply RESCHEDULE to the confirmation text.
            </p>
          </div>
        )}

        <BrandFooter />
      </div>

      {primaryCTA && (
        <div className="pb-sticky" role="region" aria-label="Primary actions">
          <button
            type="button"
            className="pb-sb-cta gold"
            onClick={primaryCTA.onClick}
            disabled={primaryCTA.disabled}
          >
            {primaryCTA.label}
          </button>
          <a className="pb-sb-cta white" href={`tel:${WAVES_PHONE_TEL}`} aria-label="Call Waves Pest Control">
            {phoneIcon} Call
          </a>
        </div>
      )}
    </div>
  );
}
