import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import AddressAutocomplete from '../components/AddressAutocomplete';
import { Button } from '../components/Button';
import { WavesShell } from '../components/brand';
import { COLORS, FONTS } from '../theme-brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const SERVICES = [
  { id: 'pest_control', label: 'Pest Control', duration: 45, icon: 'bug', desc: 'Quarterly interior + exterior treatment' },
  { id: 'lawn_care', label: 'Lawn Care', duration: 60, icon: 'sprout', desc: 'Fertilization + weed control program' },
  { id: 'mosquito', label: 'Mosquito Control', duration: 45, icon: 'bug', desc: 'WaveGuard barrier treatment' },
  { id: 'tree_shrub', label: 'Tree & Shrub', duration: 60, icon: 'tree', desc: 'Ornamental plant care' },
  { id: 'termite', label: 'Termite Inspection', duration: 90, icon: 'shield', desc: 'WDO inspection + treatment plan' },
  { id: 'rodent', label: 'Rodent Control', duration: 60, icon: 'mouse', desc: 'Exclusion + monitoring stations' },
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
  const [address, setAddress] = useState({ line1: '', formatted: '', city: '', state: 'FL', zip: '' });
  const [coords, setCoords] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [curatedSlots, setCuratedSlots] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [contact, setContact] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [notes, setNotes] = useState('');
  const [existingCustomerId, setExistingCustomerId] = useState(null);
  const [addressMayMatchCustomer, setAddressMayMatchCustomer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confCode, setConfCode] = useState('');

  const updateAddress = useCallback((updater) => {
    setAddress((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      return next;
    });
    setAvailability([]);
    setCuratedSlots([]);
    setSelectedDate(null);
    setSelectedSlot(null);
    setExistingCustomerId(null);
    setAddressMayMatchCustomer(false);
    setError('');
  }, []);

  // Step 2 → load availability whenever we enter it
  const loadAvailability = useCallback(async () => {
    if (!service || !address.line1) return;
    setLoading(true);
    setError('');
    try {
      const fullAddress = address.formatted || address.line1;
      const params = new URLSearchParams({
        address: fullAddress,
        service_type: service.id,
        duration_minutes: String(service.duration),
      });
      if (coords?.lat && coords?.lng) {
        params.set('lat', String(coords.lat));
        params.set('lng', String(coords.lng));
      }
      const res = await fetch(`${API_BASE}/booking/availability?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load availability');
      setAvailability(data.days || []);
      setCuratedSlots(data.slots || []);
      if (data.lat && data.lng) setCoords({ lat: data.lat, lng: data.lng });
      if ((!data.slots || data.slots.length === 0) && (!data.days || data.days.length === 0)) {
        setError('No times available in the next 2 weeks. Call (941) 297-5749 and we\'ll get you on the schedule.');
      }
    } catch (err) {
      setError(err.message);
      setAvailability([]);
      setCuratedSlots([]);
    }
    setLoading(false);
  }, [service, address, coords]);

  const applyCustomer = useCallback((customer) => {
    setExistingCustomerId(customer.id);
    setContact(c => ({
      ...c,
      firstName: c.firstName || customer.first_name || '',
      lastName: c.lastName || customer.last_name || '',
      phone: c.phone || customer.phone || '',
      email: c.email || customer.email || '',
    }));
  }, []);

  const checkExistingCustomerByAddress = useCallback(async (nextAddress) => {
    const lookupAddress = nextAddress.formatted || nextAddress.line1;
    if (!lookupAddress) return;
    try {
      const params = new URLSearchParams({ address: lookupAddress });
      if (nextAddress.city) params.set('city', nextAddress.city);
      if (nextAddress.zip) params.set('zip', nextAddress.zip);
      const res = await fetch(`${API_BASE}/booking/customer-lookup?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setAddressMayMatchCustomer(!!data.possible_match);
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => {
    if (step === 2) loadAvailability();
  }, [step, loadAvailability]);

  // Detect existing customer by phone on step 3
  const checkExistingCustomer = useCallback(async (phone) => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) return;
    try {
      const params = new URLSearchParams({ phone: digits });
      const lookupAddress = address.formatted || address.line1;
      if (lookupAddress) params.set('address', lookupAddress);
      if (address.city) params.set('city', address.city);
      if (address.zip) params.set('zip', address.zip);
      const res = await fetch(`${API_BASE}/booking/customer-lookup?${params}`);
      if (res.ok) {
        const data = await res.json();
        if (data.customer) {
          applyCustomer(data.customer);
        }
      }
    } catch { /* best-effort */ }
  }, [address, applyCustomer]);

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
          new_customer: contact.phone ? {
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
          } : null,
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
    border: `1.5px solid ${COLORS.grayLight}`, fontSize: 15,
    color: COLORS.navy, background: '#fff',
    outline: 'none', transition: 'border-color 0.2s',
  };
  const labelStyle = {
    fontSize: 14, fontWeight: 500, color: COLORS.slate600,
    display: 'block', marginBottom: 6,
  };
  const stepTwoSlots = curatedSlots.length > 0
    ? curatedSlots
    : availability.flatMap(day => (day.slots || []).map(slot => ({
      ...slot,
      date: day.date,
      fullDate: day.fullDate,
      dayOfWeek: day.dayOfWeek,
      dayNum: day.dayNum,
      month: day.month,
    }))).slice(0, 4);

  return (
    <WavesShell variant="customer" topBar="solid">
      <style>{`
        @keyframes slideUp { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }
        @keyframes checkPop { 0% { transform:scale(0) } 60% { transform:scale(1.2) } 100% { transform:scale(1) } }
        @keyframes pulse { 0%,100% { transform:scale(1) } 50% { transform:scale(1.03) } }
        input:focus { border-color: ${COLORS.wavesBlue} !important; }
      `}</style>

      {/* Progress bar — steps 1 (address) → 2 (time) → 3 (contact) → 4 (done) */}
      {step < 4 && (
        <div style={{ background: COLORS.slate200, height: 3 }}>
          <div style={{
            height: 3, background: COLORS.wavesBlue,
            width: `${(step / 3) * 100}%`,
            transition: 'width 0.5s cubic-bezier(.4,0,.2,1)',
          }} />
        </div>
      )}

      <div style={{ maxWidth: 480, margin: '0 auto', padding: '24px 20px 60px' }}>

        {/* STEP 1 — Address */}
        {step === 1 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.blueDeeper, marginBottom: 8, letterSpacing: '-0.5px' }}>
              Find a date &amp; time that works for you
            </h2>
            <div style={{ display: 'grid', gap: 14, marginBottom: 24, marginTop: 18 }}>
              <div>
                <label style={labelStyle}>Start typing your address</label>
                <AddressAutocomplete
                  autoFocus
                  value={address.line1}
                  onChange={(v) => updateAddress(a => ({ ...a, line1: v, formatted: '' }))}
                  onSelect={(parts) => {
                    const nextAddress = {
                      line1: parts.formatted || parts.line1 || address.line1,
                      formatted: parts.formatted || parts.line1 || address.formatted,
                      city: parts.city || address.city,
                      state: parts.state || address.state,
                      zip: parts.zip || address.zip,
                    };
                    updateAddress(a => ({
                      ...a,
                      ...nextAddress,
                    }));
                    if (parts.lat && parts.lng) setCoords({ lat: parts.lat, lng: parts.lng });
                    checkExistingCustomerByAddress(nextAddress);
                  }}
                  placeholder="Start typing your address"
                  style={inputStyle}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button
                variant="primary"
                onClick={() => setStep(2)}
                disabled={!address.line1}
                style={{ width: '100%' }}
              >
                Find my best times →
              </Button>
            </div>
          </div>
        )}

        {/* STEP 2 — Times */}
        {step === 2 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.blueDeeper, marginBottom: 8, letterSpacing: '-0.5px' }}>
              {stepTwoSlots.length > 0 && stepTwoSlots.length < 4 ? 'Your best times' : 'Your best 4 times'}
            </h2>
            <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 20, lineHeight: 1.5 }}>
              These are the windows when we'll already be working in your neighborhood — pick whichever fits.
            </p>

            {loading && (
              <div style={{ textAlign: 'center', padding: 40, color: COLORS.slate600 }}>
                <div style={{ fontSize: 14 }}>Checking the route map…</div>
              </div>
            )}

            {error && !loading && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 10, padding: 14, fontSize: 14, color: '#991B1B', marginBottom: 16,
              }}>{error}</div>
            )}

            {!loading && stepTwoSlots.length > 0 && (
              <div style={{ display: 'grid', gap: 10 }}>
                {stepTwoSlots.map((slot, i) => {
                  const isSelected = selectedDate === slot.date && selectedSlot?.start_time === slot.start_time;
                  return (
                    <button
                      key={`${slot.date}-${slot.start_time}-${i}`}
                      onClick={() => { setSelectedDate(slot.date); setSelectedSlot(slot); }}
                      style={{
                        width: '100%',
                        padding: '14px 16px',
                        borderRadius: 12,
                        cursor: 'pointer',
                        background: isSelected ? COLORS.wavesBlue : COLORS.white,
                        color: isSelected ? '#fff' : COLORS.blueDeeper,
                        border: `1.5px solid ${isSelected ? COLORS.wavesBlue : COLORS.slate200}`,
                        textAlign: 'left',
                        transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
                      }}
                    >
                      <div style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: isSelected ? 'rgba(255,255,255,0.82)' : COLORS.slate600,
                        marginBottom: 5,
                      }}>
                        {slot.fullDate}
                      </div>
                      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
                        {slot.start_label}
                      </div>
                      <div style={{
                        fontSize: 14,
                        color: isSelected ? 'rgba(255,255,255,0.86)' : COLORS.slate600,
                        lineHeight: 1.35,
                      }}>
                        {slot.reason}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <Button variant="tertiary" onClick={() => setStep(1)}>← Back</Button>
              <Button
                variant="primary"
                onClick={() => setStep(3)}
                disabled={!selectedSlot}
                style={{ flex: 1 }}
              >
                Continue →
              </Button>
            </div>
          </div>
        )}

        {/* STEP 3 — Contact */}
        {step === 3 && (
          <div style={{ animation: 'slideUp 0.4s ease-out' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.blueDeeper, marginBottom: 8, letterSpacing: '-0.5px' }}>
              Your info
            </h2>
            <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 20, lineHeight: 1.5 }}>
              We'll text you a confirmation right after you book.
            </p>

            {/* Selected time summary */}
            <div style={{
              background: COLORS.blueLight, border: `1px solid ${COLORS.wavesBlue}`,
              borderRadius: 10, padding: 14, marginBottom: 20,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.blueDark, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                Your selected time
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.blueDeeper }}>
                {selectedSlot?.fullDate || availability.find(d => d.date === selectedDate)?.fullDate} · {selectedSlot?.start_label}
              </div>
              <div style={{ fontSize: 12, color: COLORS.slate600, marginTop: 2 }}>
                {service?.label}
              </div>
            </div>

            {addressMayMatchCustomer && !existingCustomerId && (
              <div style={{
                background: COLORS.blueLight,
                border: `1px solid ${COLORS.wavesBlue}`,
                borderRadius: 10,
                padding: 12,
                fontSize: 14,
                color: COLORS.blueDark,
                marginBottom: 14,
              }}>
                This address may already be on file. Enter your phone number and we'll link the appointment to that customer profile.
              </div>
            )}

            {existingCustomerId && (
              <div style={{
                background: COLORS.greenLight,
                border: `1px solid ${COLORS.green}`,
                borderRadius: 10,
                padding: 12,
                fontSize: 14,
                color: COLORS.green,
                marginBottom: 14,
              }}>
                We found your customer profile. We'll send the confirmation to the phone number on file.
              </div>
            )}

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
                  disabled={!!existingCustomerId}
                />
              </div>
              {!existingCustomerId && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
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
              </div>}
              {!existingCustomerId && <div>
                <label style={labelStyle}>Email (optional)</label>
                <input
                  type="email"
                  value={contact.email}
                  onChange={e => setContact(c => ({ ...c, email: e.target.value }))}
                  style={inputStyle}
                />
              </div>}
              <div>
                <label style={labelStyle}>Notes for the tech (optional)</label>
                <textarea
                  rows={3}
                  placeholder="Gate code, pets, access instructions…"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: FONTS.body }}
                />
              </div>
            </div>

            {error && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 10, padding: 12, fontSize: 14, color: '#991B1B', marginBottom: 16,
              }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <Button variant="tertiary" onClick={() => setStep(2)}>← Back</Button>
              <Button
                variant="primary"
                onClick={handleConfirm}
                disabled={loading || (!existingCustomerId && (!contact.firstName || !contact.lastName || !contact.phone))}
                style={{ flex: 1 }}
              >
                {loading ? 'Booking…' : 'Confirm booking'}
              </Button>
            </div>
          </div>
        )}

        {/* STEP 4 — Confirmation */}
        {step === 4 && (
          <div style={{ animation: 'slideUp 0.4s ease-out', textAlign: 'center', paddingTop: 20 }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%', background: COLORS.greenLight,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px', animation: 'checkPop 0.5s ease-out',
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={COLORS.green} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 600, color: COLORS.blueDeeper, marginBottom: 8, letterSpacing: '-0.5px' }}>
              You're booked!
            </h2>
            <p style={{ fontSize: 16, color: COLORS.slate600, marginBottom: 24, lineHeight: 1.5 }}>
              We just texted a confirmation to {contact.phone || 'the phone number on file'}.
            </p>
            <div style={{
              background: COLORS.white, border: `1px solid ${COLORS.slate200}`,
              borderRadius: 12, padding: 18, marginBottom: 20, textAlign: 'left',
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.slate400, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 10 }}>
                Confirmation
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: COLORS.wavesBlue, fontFamily: FONTS.mono, marginBottom: 14 }}>
                {confCode}
              </div>
              <div style={{ fontSize: 16, color: COLORS.slate600, lineHeight: 1.6 }}>
                <div><strong style={{ color: COLORS.blueDeeper }}>{service?.label}</strong></div>
                <div>{selectedSlot?.fullDate || availability.find(d => d.date === selectedDate)?.fullDate}</div>
                <div>{selectedSlot?.start_label} – {selectedSlot?.end_label}</div>
                <div style={{ marginTop: 6 }}>{address.line1}, {address.city} {address.zip}</div>
              </div>
            </div>
            <p style={{ fontSize: 12, color: COLORS.slate400 }}>
              Need to change it? Text us at (941) 297-5749 or reply RESCHEDULE to the confirmation text.
            </p>
          </div>
        )}

      </div>
    </WavesShell>
  );
}
