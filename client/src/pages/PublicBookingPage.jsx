import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import AddressAutocomplete from '../components/AddressAutocomplete';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Brand tokens (match existing BookingPage for visual consistency)
// Mirrored from wavespestcontrol.com — semantic keys preserved, values swapped to brand
const BRAND = {
  navy: '#04395E',       // brand-blueDeeper
  teal: '#097ABD',       // brand-blue (primary accent)
  tealDark: '#065A8C',   // brand-blueDark
  tealLight: '#E3F5FD',  // brand-blueLight
  sand: '#FEF7E0',       // brand-gold light
  warmWhite: '#FFFFFF',
  coral: '#C0392B',      // brand-red
  gold: '#FFD700',       // brand-gold
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
  const btnPrimary = (disabled) => ({
    width: '100%', padding: '14px 20px', borderRadius: 9999,
    background: disabled ? BRAND.gray300 : '#FFD700',
    color: disabled ? '#fff' : BRAND.navy,
    border: 'none', fontSize: 15, fontWeight: 800,
    letterSpacing: '0.02em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 0.15s cubic-bezier(0.4,0,0.2,1)',
    fontFamily: "'Baloo 2', 'Nunito', sans-serif",
  });
  const btnSecondary = {
    padding: '10px 16px', borderRadius: 8, background: 'transparent',
    border: `1px solid ${BRAND.gray300}`, color: BRAND.gray600,
    fontSize: 13, fontWeight: 500, cursor: 'pointer',
  };
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

  return (
    <div style={{ minHeight: '100vh', background: BRAND.sand, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        @keyframes slideUp { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
        @keyframes checkPop { 0% { transform:scale(0) } 60% { transform:scale(1.2) } 100% { transform:scale(1) } }
        @keyframes pulse { 0%,100% { transform:scale(1) } 50% { transform:scale(1.03) } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input, select, button, textarea { font-family: inherit; }
        input:focus { border-color: ${BRAND.teal} !important; }
      `}</style>

      {/* Header */}
      <div style={{ background: BRAND.navy, padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%', background: BRAND.teal,
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
          fontWeight: 700, fontSize: 16,
        }}>W</div>
        <div>
          <h1 style={{
            color: '#fff',
            fontFamily: "'Luckiest Guy', 'Baloo 2', cursive",
            fontWeight: 400, fontSize: 22,
            letterSpacing: '0.02em', lineHeight: 1,
            margin: 0,
          }}>
            Waves Pest Control
          </h1>
          <div style={{ color: BRAND.gray400, fontSize: 12, marginTop: 4 }}>Book your service online</div>
        </div>
      </div>

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

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '24px 20px 60px' }}>

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
                onClick={() => setStep(2)}
                disabled={!address.line1 || !address.city || !address.zip}
                style={btnPrimary(!address.line1 || !address.city || !address.zip)}
              >
                Find my best times →
              </button>
            </div>
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
              <button onClick={() => setStep(1)} style={btnSecondary}>← Back</button>
              <button
                onClick={() => setStep(3)}
                disabled={!selectedSlot}
                style={btnPrimary(!selectedSlot)}
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
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: "'DM Sans', sans-serif" }}
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
              <button onClick={() => setStep(2)} style={btnSecondary}>← Back</button>
              <button
                onClick={handleConfirm}
                disabled={loading || !contact.firstName || !contact.lastName || !contact.phone}
                style={btnPrimary(loading || !contact.firstName || !contact.lastName || !contact.phone)}
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
      </div>
    </div>
  );
}
