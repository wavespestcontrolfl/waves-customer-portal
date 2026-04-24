import Icon from '../components/Icon';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS as B, FONTS, BUTTON_BASE, HALFTONE_PATTERN, HALFTONE_SIZE } from '../theme-brand';
import BrandFooter from '../components/BrandFooter';
import SaveCardConsent from '../components/billing/SaveCardConsent';
import { etDateString } from '../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function loadStripeJs(publishableKey) {
  return new Promise((resolve) => {
    if (window.Stripe) return resolve(window.Stripe(publishableKey));
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.onload = () => resolve(window.Stripe(publishableKey));
    document.head.appendChild(script);
  });
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function ProgressDots({ current, total }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', padding: '16px 0' }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          width: i === current ? 24 : 10, height: 10, borderRadius: 5,
          background: i <= current ? B.yellow : 'rgba(255,255,255,0.25)',
          transition: 'all 0.3s ease',
        }} />
      ))}
    </div>
  );
}

function PillSelect({ options, value, onChange, wrap }) {
  return (
    <div style={{ display: 'flex', flexWrap: wrap ? 'wrap' : 'nowrap', gap: 6 }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)} style={{
          ...BUTTON_BASE, padding: '8px 14px', fontSize: 13, borderRadius: 20,
          background: value === o.value ? B.wavesBlue : B.blueSurface,
          color: value === o.value ? '#fff' : B.grayDark,
          border: 'none', flex: wrap ? 'none' : '1 1 auto',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

function ToggleSwitch({ value, onChange }) {
  return (
    <div onClick={() => onChange(!value)} style={{
      width: 48, height: 26, borderRadius: 13, cursor: 'pointer',
      background: value ? B.wavesBlue : B.grayLight,
      position: 'relative', transition: 'background 0.3s', flexShrink: 0,
    }}>
      <div style={{
        position: 'absolute', top: 3, width: 20, height: 20,
        borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
        left: value ? 25 : 3, transition: 'left 0.3s',
      }} />
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input type={show ? 'text' : 'password'} value={value || ''} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} style={{
          width: '100%', padding: '12px 40px 12px 14px', borderRadius: 12,
          border: `2px solid ${B.bluePale}`, fontSize: 16, fontFamily: FONTS.body,
          color: B.navy, outline: 'none', boxSizing: 'border-box',
        }}
        onFocus={e => e.target.style.borderColor = B.wavesBlue}
        onBlur={e => e.target.style.borderColor = B.bluePale}
      />
      <button onClick={() => setShow(!show)} style={{
        position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
        background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: B.grayMid,
      }}>{show ? '' : '️'}</button>
    </div>
  );
}

export default function OnboardingPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [screen, setScreen] = useState(0); // 0=welcome, 1=payment, 2=details, 3=done
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const debounceRef = useRef(null);

  // Form state
  const [prefs, setPrefs] = useState({
    preferredTime: 'no_preference', preferredDay: 'no_preference',
    contactPreference: 'text', typicallyHome: '',
    neighborhoodGateCode: '', propertyGateCode: '', garageCode: '', lockboxCode: '',
    interiorAccessMethod: '', interiorAccessDetails: '', parkingNotes: '',
    petCount: 0, petDetails: '', petsPlan: '',
    chemicalSensitivities: false, chemicalSensitivityDetails: '',
    specialFeatures: [], irrigationSystem: false,
    irrigationControllerLocation: '', irrigationZones: 0,
    hoaName: '', hoaRestrictions: '', specialInstructions: '',
  });
  const [referralSource, setReferralSource] = useState('');
  const [referredBy, setReferredBy] = useState('');
  const [hasGate, setHasGate] = useState(false);
  const [hasYardGate, setHasYardGate] = useState(false);
  const [needsInterior, setNeedsInterior] = useState(false);
  const [hasPets, setHasPets] = useState(false);
  const [hasHoa, setHasHoa] = useState(false);

  // Stripe payment state
  const [stripeReady, setStripeReady] = useState(false);
  const [stripeError, setStripeError] = useState('');

  // Reschedule flow state — we fetch zone-aware slots on demand so the
  // customer only sees days a tech is actually nearby.
  const [showReschedule, setShowReschedule] = useState(false);
  const [slotDays, setSlotDays] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [pickedDate, setPickedDate] = useState(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const paymentElementRef = useRef(null);
  const cardMountRef = useRef(null);
  const stripeInitRef = useRef(false);

  useEffect(() => {
    apiFetch(`/onboarding/${token}`)
      .then(d => {
        setData(d);
        if (d.preferences) setPrefs(prev => ({ ...prev, ...d.preferences }));
        // Customers who opted to pay at the visit during inline accept
        // never see the Stripe card capture screen. Treat them as if
        // payment is already satisfied so the resume-state logic jumps
        // straight to details.
        const payAtVisit = d.scheduledService?.paymentMethodPreference === 'pay_at_visit';
        if (d.status.current === 'complete') setScreen(3);
        else if (d.status.detailsCollected) setScreen(3);
        else if (d.status.serviceConfirmed) setScreen(2);
        else if (d.status.paymentCollected) setScreen(2);
        else if (payAtVisit) setScreen(0);  // welcome → skips to details (screen 2) via CTA below
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  const payAtVisit = data?.scheduledService?.paymentMethodPreference === 'pay_at_visit';

  const updatePref = useCallback((field, value) => {
    setPrefs(prev => ({ ...prev, [field]: value }));
  }, []);

  const autoSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        await apiFetch(`/onboarding/${token}/details`, {
          method: 'PUT',
          body: JSON.stringify({
            scheduling: { preferredTime: prefs.preferredTime, preferredDay: prefs.preferredDay, contactPreference: prefs.contactPreference, typicallyHome: prefs.typicallyHome },
            access: { neighborhoodGateCode: prefs.neighborhoodGateCode, propertyGateCode: prefs.propertyGateCode, garageCode: prefs.garageCode, lockboxCode: prefs.lockboxCode, interiorAccessMethod: prefs.interiorAccessMethod, interiorAccessDetails: prefs.interiorAccessDetails, parkingNotes: prefs.parkingNotes },
            pets: { petCount: prefs.petCount, petDetails: prefs.petDetails, petsPlan: prefs.petsPlan, chemicalSensitivities: prefs.chemicalSensitivities, chemicalSensitivityDetails: prefs.chemicalSensitivityDetails },
            property: { specialFeatures: prefs.specialFeatures, irrigationSystem: prefs.irrigationSystem, irrigationControllerLocation: prefs.irrigationControllerLocation, irrigationZones: prefs.irrigationZones, hoaName: prefs.hoaName, hoaRestrictions: prefs.hoaRestrictions, specialInstructions: prefs.specialInstructions },
            attribution: { referralSource, referredByPhone: referralSource === 'neighbor_referral' ? referredBy : null },
          }),
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch {}
    }, 1000);
  }, [token, prefs, referralSource, referredBy]);

  useEffect(() => { if (screen === 2) autoSave(); }, [prefs, referralSource, referredBy]);

  // Initialize Stripe when payment screen is shown.
  // Skipped entirely for pay-at-visit customers — their flow never
  // renders screen 1 so Stripe never needs to load.
  useEffect(() => {
    if (screen !== 1 || stripeInitRef.current || payAtVisit) return;
    stripeInitRef.current = true;
    (async () => {
      try {
        const setupData = await apiFetch(`/onboarding/${token}/setup-intent`, { method: 'POST' });
        const stripe = await loadStripeJs(setupData.publishableKey);
        stripeRef.current = stripe;
        const elements = stripe.elements({ clientSecret: setupData.clientSecret, appearance: { theme: 'stripe' } });
        elementsRef.current = elements;
        setTimeout(() => {
          if (cardMountRef.current) {
            const pe = elements.create('payment', {
              layout: { type: 'tabs' },
              paymentMethodOrder: ['us_bank_account', 'card', 'apple_pay', 'google_pay'],
            });
            pe.mount(cardMountRef.current);
            paymentElementRef.current = pe;
            pe.on('ready', () => setStripeReady(true));
          }
        }, 100);
      } catch (e) {
        setStripeError(e.message || 'Failed to load payment form');
      }
    })();
  }, [screen, token]);

  const handlePayment = async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setSubmitting(true);
    setStripeError('');
    try {
      const { error, setupIntent } = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        redirect: 'if_required',
      });
      if (error) {
        setStripeError(error.message);
        setSubmitting(false);
        return;
      }
      if (setupIntent && setupIntent.payment_method) {
        const result = await apiFetch(`/onboarding/${token}/save-card`, {
          method: 'POST',
          body: JSON.stringify({ paymentMethodId: setupIntent.payment_method }),
        });
        setData(prev => ({
          ...prev,
          status: { ...prev.status, paymentCollected: true },
          card: { brand: result.card?.card_brand || 'CARD', lastFour: result.card?.last_four || '****', autopay: true },
        }));
        setTimeout(() => setScreen(2), 1000);
      }
    } catch (e) { setStripeError(e.message || 'Payment setup failed'); }
    setSubmitting(false);
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await apiFetch(`/onboarding/${token}/confirm-service`, { method: 'PUT', body: JSON.stringify({ confirmed: true }) });
      setData(prev => ({ ...prev, status: { ...prev.status, serviceConfirmed: true }, scheduledService: prev.scheduledService ? { ...prev.scheduledService, confirmed: true } : null }));
    } catch (e) { setError(e.message); }
    setSubmitting(false);
  };

  const openReschedule = async () => {
    setShowReschedule(true);
    setSlotsLoading(true);
    setSlotsError('');
    try {
      const result = await apiFetch(`/onboarding/${token}/available-slots`);
      setSlotDays(result.days || []);
      if (!result.days || result.days.length === 0) {
        setSlotsError('No open slots in your area right now — call (941) 297-5749 and we\'ll sort it out.');
      }
    } catch (e) { setSlotsError(e.message || 'Could not load available days'); }
    setSlotsLoading(false);
  };

  const submitReschedule = async (date, startTime24) => {
    setSubmitting(true);
    try {
      await apiFetch(`/onboarding/${token}/reschedule-service`, {
        method: 'PUT',
        body: JSON.stringify({ date, startTime: startTime24 }),
      });
      // Refresh the onboarding state so the service card shows the new date.
      const fresh = await apiFetch(`/onboarding/${token}`);
      setData(fresh);
      setShowReschedule(false);
      setPickedDate(null);
    } catch (e) { setError(e.message || 'Reschedule failed'); }
    setSubmitting(false);
  };

  const handleComplete = async () => {
    setSubmitting(true);
    try {
      // Save details one final time
      await apiFetch(`/onboarding/${token}/details`, {
        method: 'PUT',
        body: JSON.stringify({
          scheduling: { preferredTime: prefs.preferredTime, preferredDay: prefs.preferredDay, contactPreference: prefs.contactPreference },
          access: { neighborhoodGateCode: prefs.neighborhoodGateCode, propertyGateCode: prefs.propertyGateCode },
          pets: { petCount: prefs.petCount, petDetails: prefs.petDetails, petsPlan: prefs.petsPlan },
          property: { specialFeatures: prefs.specialFeatures, irrigationSystem: prefs.irrigationSystem, specialInstructions: prefs.specialInstructions },
          attribution: { referralSource },
        }),
      });
      await apiFetch(`/onboarding/${token}/complete`, { method: 'POST' });
      setScreen(3);
    } catch (e) { setError(e.message); }
    setSubmitting(false);
  };

  const generateICS = () => {
    if (!data?.scheduledService) return;
    const s = data.scheduledService;
    const d = new Date(s.date + 'T12:00:00');
    const dateStr = etDateString(d).replace(/-/g, '');
    const start = s.windowStart ? `${dateStr}T${s.windowStart.replace(/:/g, '').slice(0, 4)}00` : `${dateStr}T080000`;
    const end = s.windowEnd ? `${dateStr}T${s.windowEnd.replace(/:/g, '').slice(0, 4)}00` : `${dateStr}T100000`;
    const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:Waves Pest Control — ${s.serviceType}\nLOCATION:${data.customer.address}\nDESCRIPTION:Tech: ${s.techName || 'TBD'}. Please ensure gates are unlocked and pets secured.\nBEGIN:VALARM\nTRIGGER:-PT60M\nACTION:DISPLAY\nDESCRIPTION:Waves service in 1 hour\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR`;
    const blob = new Blob([ics], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'waves-service.ics';
    a.click();
  };

  if (loading) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: '#fff', fontSize: 16, fontFamily: FONTS.body }}>Loading...</div>
    </div>
  );

  if (error && !data) return (
    <div style={{ minHeight: '100vh', background: B.blueDark, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 400, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}></div>
        <div style={{ fontSize: 16, fontWeight: 700, color: B.navy, marginTop: 8 }}>{error}</div>
        <a href="tel:+19412975749" style={{ ...BUTTON_BASE, marginTop: 16, padding: '10px 22px', borderRadius: 9999, background: B.yellow, color: B.blueDeeper, textDecoration: 'none', display: 'inline-flex', fontWeight: 800 }}>Call (941) 297-5749</a>
      </div>
    </div>
  );

  const c = data.customer;
  const q = data.quote;
  const svc = data.scheduledService;

  const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };

  const inputStyle = {
    width: '100%', padding: '12px 14px', borderRadius: 12,
    border: `2px solid ${B.bluePale}`, fontSize: 16, fontFamily: FONTS.body,
    color: B.navy, outline: 'none', boxSizing: 'border-box',
  };

  const sectionHead = (icon, title) => (
    <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginTop: 20, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span>{icon}</span> {title}
    </div>
  );

  const fieldLabel = (text) => (
    <div style={{ fontSize: 13, fontWeight: 600, color: B.grayDark, fontFamily: FONTS.ui, marginBottom: 6, marginTop: 12 }}>{text}</div>
  );

  return (
    <div style={{
      minHeight: '100vh',
      background: `linear-gradient(180deg, ${B.blueDark} 0%, ${B.wavesBlue} 100%)`,
      backgroundImage: `${HALFTONE_PATTERN}, linear-gradient(180deg, ${B.blueDark} 0%, ${B.wavesBlue} 100%)`,
      backgroundSize: `${HALFTONE_SIZE}, 100% 100%`,
      fontFamily: FONTS.body,
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Hero video — waves-hero-service.mp4 */}
      <video autoPlay muted loop playsInline preload="none" poster="/brand/waves-hero-service.webp"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.25, zIndex: 0, pointerEvents: 'none' }}
        aria-hidden="true">
        <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
      </video>
      {/* Header */}
      <div style={{ position: 'relative', zIndex: 1, padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <img src="/waves-logo.png" alt="" style={{ height: 28 }} />
        <div style={{ fontSize: 12, fontWeight: 700, color: B.blueLight, fontFamily: FONTS.heading }}>WAVES LAWN & PEST</div>
      </div>

      <div style={{ position: 'relative', zIndex: 1 }}><ProgressDots current={screen} total={4} /></div>

      {/* Save toast */}
      {saved && (
        <div style={{
          position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)',
          padding: '6px 16px', borderRadius: 20, background: B.green, color: '#fff',
          fontSize: 12, fontWeight: 600, zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}>Saved </div>
      )}

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 480, margin: '0 auto', padding: '0 20px 40px' }}>

        {/* SCREEN 0 — Welcome */}
        {screen === 0 && (
          <div style={{ textAlign: 'center' }}>
            <img src="/waves-logo.png" alt="" style={{ width: 80, height: 'auto', margin: '20px auto 12px' }} />
            <h1 style={{
              fontSize: 'clamp(36px, 7vw, 48px)', fontFamily: FONTS.display, fontWeight: 400,
              color: '#fff', letterSpacing: '0.02em', lineHeight: 1.05,
              margin: '0 0 8px', textShadow: '0 2px 12px rgba(0,0,0,0.25)',
            }}>
              Welcome, {c.firstName}! 
            </h1>
            <div style={{ fontSize: 16, color: B.blueLight, marginTop: 4 }}>
              Your {q.serviceType.split('—')[0].trim()} is confirmed.
            </div>

            <div style={{ background: '#fff', borderRadius: 16, padding: 24, marginTop: 24, textAlign: 'left' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>{q.serviceType}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: B.navy, fontFamily: FONTS.ui, marginTop: 8 }}>${q.monthlyRate.toFixed(2)}<span style={{ fontSize: 14, fontWeight: 400, color: B.grayMid }}>/mo</span></div>
              {q.tier && (
                <div style={{ fontSize: 13, fontWeight: 600, color: B.green, marginTop: 4 }}>
                  WaveGuard {q.tier} — {q.tier === 'Platinum' ? '20%' : q.tier === 'Gold' ? '15%' : q.tier === 'Silver' ? '10%' : '0%'} bundle savings
                </div>
              )}
              {q.depositAmount > 0 && !payAtVisit && (
                <div style={{ fontSize: 13, color: B.grayDark, marginTop: 6 }}>
                  50% deposit: ${q.depositAmount.toFixed(2)} due today
                </div>
              )}
              {payAtVisit && (
                <div style={{ fontSize: 13, color: B.grayDark, marginTop: 6 }}>
                  Payment at the visit — nothing due today.
                </div>
              )}
            </div>

            <button onClick={() => setScreen(payAtVisit ? 2 : 1)} style={{
              ...BUTTON_BASE, width: '100%', padding: 16, marginTop: 20,
              background: B.yellow, color: B.blueDeeper, fontSize: 16,
              boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
            }}>{payAtVisit ? "Finish Setting Up" : "Let's Get You Set Up"}</button>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 8 }}>Takes about 2 minutes</div>
          </div>
        )}

        {/* SCREEN 1 — Payment */}
        {screen === 1 && (
          <div>
            <div style={{ background: '#fff', borderRadius: 16, padding: 24 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Payment Setup</div>
              <div style={{ fontSize: 15, color: B.grayDark, marginTop: 4, lineHeight: 1.6 }}>
                Add a card and you're set — no more thinking about payments.
              </div>

              <div style={{ marginTop: 20 }}>
                <div ref={cardMountRef} style={{ minHeight: 120, marginBottom: 12 }} />

                {stripeError && (
                  <div style={{ padding: 10, background: '#FFEBEE', borderRadius: 8, fontSize: 13, color: B.red, marginBottom: 12 }}>
                    {stripeError}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <span style={{ fontSize: 14, color: B.navy, fontWeight: 500 }}>Auto-pay monthly on the 1st</span>
                  <ToggleSwitch value={true} onChange={() => {}} />
                </div>

                {/* Save-card authorization — locked because finishing
                    onboarding requires a card on file. Shown so the
                    consent record reflects the copy the customer saw. */}
                <div style={{ marginBottom: 16 }}>
                  <SaveCardConsent locked onChange={() => {}} />
                </div>

                {q.depositAmount > 0 && (
                  <div style={{ fontSize: 14, color: B.grayDark, fontWeight: 600, marginBottom: 12 }}>
                    Deposit of ${q.depositAmount.toFixed(2)} will be charged now
                  </div>
                )}

                <button onClick={handlePayment} disabled={submitting || !stripeReady} style={{
                  ...BUTTON_BASE, width: '100%', padding: 16, fontSize: 15,
                  background: stripeReady ? B.red : B.grayLight,
                  color: stripeReady ? '#fff' : B.grayMid,
                  opacity: submitting ? 0.7 : 1,
                }}>{submitting ? 'Processing...' : !stripeReady ? 'Loading payment form...' : 'Save Payment Method'}</button>

                <div style={{ fontSize: 11, color: B.textCaption, marginTop: 10, textAlign: 'center' }}>
                  Secured by Stripe. We never store your card details directly.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SCREEN 2 — Details */}
        {screen === 2 && (
          <div>
            <div style={{ background: '#fff', borderRadius: 16, padding: 24 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}> Set Up Your First Visit</div>
              <div style={{ fontSize: 15, color: B.grayDark, marginTop: 4, lineHeight: 1.6 }}>
                Help your tech nail it on day one. Takes about 60 seconds.
              </div>

              {/* Service confirmation */}
              {svc && (
                <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 12, borderLeft: `4px solid ${B.wavesBlue}`, background: B.blueSurface }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: B.grayMid, fontFamily: FONTS.ui }}>Your first service:</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginTop: 4 }}>
                    {new Date(svc.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                  </div>
                  <div style={{ fontSize: 14, color: B.grayDark, marginTop: 2 }}>
                    {svc.windowStart ? `${fmtTime(svc.windowStart)} – ${fmtTime(svc.windowEnd)}` : 'Time TBD'} · {svc.techName || 'Tech TBD'}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    {!svc.confirmed && !data.status.serviceConfirmed ? (
                      <>
                        <button onClick={handleConfirm} disabled={submitting} style={{ ...BUTTON_BASE, flex: 1, padding: '9px 14px', fontSize: 13, background: B.yellow, color: B.blueDeeper }}> Confirm</button>
                        <button onClick={openReschedule} disabled={submitting} style={{ ...BUTTON_BASE, flex: 1, padding: '9px 14px', fontSize: 13, background: 'transparent', color: B.wavesBlue, border: `1.5px solid ${B.wavesBlue}` }}> Reschedule</button>
                      </>
                    ) : (
                      <span style={{ fontSize: 13, fontWeight: 700, color: B.green }}> Confirmed</span>
                    )}
                  </div>
                  <button onClick={generateICS} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: B.wavesBlue, fontWeight: 600, marginTop: 8, padding: 0 }}>
                    Add to Calendar 
                  </button>
                </div>
              )}

              {/* Reschedule picker — shows real zone-aware availability */}
              {showReschedule && (
                <div style={{ marginTop: 12, padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${B.wavesBlue}`, background: '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Pick a new day</div>
                    <button onClick={() => { setShowReschedule(false); setPickedDate(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: B.grayMid }}></button>
                  </div>
                  <div style={{ fontSize: 12, color: B.grayDark, marginTop: 2 }}>
                    Only showing days a Waves tech is already in your neighborhood.
                  </div>

                  {slotsLoading && <div style={{ marginTop: 12, fontSize: 13, color: B.grayMid }}>Loading…</div>}
                  {slotsError && <div style={{ marginTop: 12, fontSize: 13, color: B.red }}>{slotsError}</div>}

                  {!slotsLoading && !slotsError && slotDays.length > 0 && !pickedDate && (
                    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 6 }}>
                      {slotDays.map(d => (
                        <button key={d.date} onClick={() => setPickedDate(d)} style={{
                          padding: '10px 8px', borderRadius: 10, border: `1.5px solid ${B.bluePale}`, background: '#fff',
                          cursor: 'pointer', textAlign: 'center',
                        }}>
                          <div style={{ fontSize: 11, color: B.grayMid, textTransform: 'uppercase', fontWeight: 600 }}>{d.dayOfWeek}</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: B.navy }}>{d.dayNum}</div>
                          <div style={{ fontSize: 11, color: B.grayMid }}>{d.month}</div>
                          <div style={{ fontSize: 10, color: B.wavesBlue, marginTop: 2 }}>{d.slots.length} open</div>
                        </button>
                      ))}
                    </div>
                  )}

                  {pickedDate && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 13, color: B.navy, fontWeight: 600, marginBottom: 8 }}>{pickedDate.fullDate}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6 }}>
                        {pickedDate.slots.map(s => (
                          <button key={s.startTime24} disabled={submitting} onClick={() => submitReschedule(pickedDate.date, s.startTime24)} style={{
                            padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${B.wavesBlue}`, background: B.blueSurface,
                            cursor: submitting ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, color: B.navy,
                          }}>
                            {s.start} – {s.end}
                          </button>
                        ))}
                      </div>
                      <button onClick={() => setPickedDate(null)} style={{ marginTop: 10, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: B.wavesBlue, fontWeight: 600, padding: 0 }}>← Different day</button>
                    </div>
                  )}
                </div>
              )}

              {/* Scheduling */}
              {sectionHead('⏰', 'Scheduling Preferences')}
              {fieldLabel('Preferred time?')}
              <PillSelect wrap options={[
                { value: 'early_morning', label: 'Early AM' }, { value: 'morning', label: 'Morning' },
                { value: 'midday', label: 'Midday' }, { value: 'afternoon', label: 'Afternoon' },
                { value: 'no_preference', label: 'Any' },
              ]} value={prefs.preferredTime} onChange={v => updatePref('preferredTime', v)} />

              {fieldLabel('Preferred day?')}
              <PillSelect wrap options={[
                { value: 'monday', label: 'Mon' }, { value: 'tuesday', label: 'Tue' },
                { value: 'wednesday', label: 'Wed' }, { value: 'thursday', label: 'Thu' },
                { value: 'friday', label: 'Fri' }, { value: 'no_preference', label: 'Any' },
              ]} value={prefs.preferredDay} onChange={v => updatePref('preferredDay', v)} />

              {fieldLabel('How should we reach you?')}
              <PillSelect wrap options={[
                { value: 'call', label: ' Call' }, { value: 'text', label: ' Text' }, { value: 'email', label: ' Email' },
              ]} value={prefs.contactPreference} onChange={v => updatePref('contactPreference', v)} />

              {/* Access */}
              {sectionHead('', 'Access & Gates')}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: B.navy }}>Community gate?</span>
                <ToggleSwitch value={hasGate} onChange={setHasGate} />
              </div>
              {hasGate && (
                <PasswordInput value={prefs.neighborhoodGateCode} onChange={v => updatePref('neighborhoodGateCode', v)} placeholder="e.g., Press #1234 at callbox" />
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: B.navy }}>Yard gate locked?</span>
                <ToggleSwitch value={hasYardGate} onChange={setHasYardGate} />
              </div>
              {hasYardGate && (
                <PasswordInput value={prefs.propertyGateCode} onChange={v => updatePref('propertyGateCode', v)} placeholder="e.g., Combo lock: 4821" />
              )}
              <div style={{ fontSize: 11, color: B.textCaption, marginTop: 8 }}> Only visible to your assigned tech on service day</div>

              {/* Pets */}
              {sectionHead('', 'Pets & Household')}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: B.navy }}>Any pets?</span>
                <ToggleSwitch value={hasPets} onChange={v => { setHasPets(v); updatePref('petCount', v ? 1 : 0); }} />
              </div>
              {hasPets && (
                <>
                  <textarea value={prefs.petDetails} onChange={e => updatePref('petDetails', e.target.value)} placeholder="e.g., 2 dogs: Golden retriever Max (friendly), Chihuahua Bella (barks but harmless)" rows={2} style={{ ...inputStyle, resize: 'vertical', marginBottom: 8 }} />
                  <textarea value={prefs.petsPlan} onChange={e => updatePref('petsPlan', e.target.value)} placeholder="e.g., Dogs will be inside. Please text 15 min before." rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
                </>
              )}

              {/* Property */}
              {sectionHead('', 'Property Notes')}
              {fieldLabel('Special features?')}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[
                  { value: 'pool', label: ' Pool/Spa' }, { value: 'koi_pond', label: ' Koi Pond' },
                  { value: 'vegetable_garden', label: ' Veggie Garden' }, { value: 'fruit_trees', label: ' Fruit Trees' },
                  { value: 'beehives', label: ' Beehives' }, { value: 'playground', label: ' Playground' },
                ].map(f => {
                  const selected = (prefs.specialFeatures || []).includes(f.value);
                  return (
                    <div key={f.value} onClick={() => {
                      const feats = prefs.specialFeatures || [];
                      updatePref('specialFeatures', selected ? feats.filter(x => x !== f.value) : [...feats, f.value]);
                    }} style={{
                      padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                      border: `2px solid ${selected ? B.wavesBlue : B.bluePale}`,
                      background: selected ? B.blueSurface : '#fff',
                      fontSize: 13, fontWeight: selected ? 600 : 400, color: B.navy,
                    }}>{f.label}</div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: B.navy }}>HOA?</span>
                <ToggleSwitch value={hasHoa} onChange={setHasHoa} />
              </div>
              {hasHoa && (
                <>
                  <input value={prefs.hoaName} onChange={e => updatePref('hoaName', e.target.value)} placeholder="HOA name" style={{ ...inputStyle, marginBottom: 8 }} />
                  <input value={prefs.hoaRestrictions} onChange={e => updatePref('hoaRestrictions', e.target.value)} placeholder="Restrictions (e.g., no signs, park in driveway)" style={inputStyle} />
                </>
              )}

              {fieldLabel('Anything else?')}
              <textarea value={prefs.specialInstructions} onChange={e => updatePref('specialInstructions', e.target.value)} placeholder="Anything else your tech should know..." rows={2} style={{ ...inputStyle, resize: 'vertical' }} />

              {/* Attribution */}
              {sectionHead('', 'How Did You Find Us?')}
              <PillSelect wrap options={[
                { value: 'google', label: 'Google' }, { value: 'facebook', label: 'Facebook' },
                { value: 'neighbor_referral', label: 'Neighbor' }, { value: 'nextdoor', label: 'Nextdoor' },
                { value: 'yard_sign', label: 'Yard Sign' }, { value: 'saw_van', label: 'Saw Van' },
                { value: 'newsletter', label: 'Newsletter' }, { value: 'other', label: 'Other' },
              ]} value={referralSource} onChange={setReferralSource} />
              {referralSource === 'neighbor_referral' && (
                <div style={{ marginTop: 8 }}>
                  <input value={referredBy} onChange={e => setReferredBy(e.target.value)} placeholder="Their name or phone — we'll credit them $25!" style={inputStyle} />
                  <div style={{ fontSize: 11, color: B.green, marginTop: 4 }}>Your neighbor gets $25 off and so do you </div>
                </div>
              )}

              {/* Complete button */}
              <button onClick={handleComplete} disabled={submitting || (!data.status.serviceConfirmed && !svc?.confirmed)} style={{
                ...BUTTON_BASE, width: '100%', padding: 16, marginTop: 24, fontSize: 15,
                background: (data.status.serviceConfirmed || svc?.confirmed) ? B.red : B.grayLight,
                color: (data.status.serviceConfirmed || svc?.confirmed) ? '#fff' : B.grayMid,
                opacity: submitting ? 0.7 : 1,
              }}>{submitting ? 'Finishing...' : (data.status.serviceConfirmed || svc?.confirmed) ? 'Almost Done →' : 'Confirm Your Service Above ↑'}</button>
            </div>
          </div>
        )}

        {/* SCREEN 3 — All Set */}
        {screen === 3 && (
          <div style={{ textAlign: 'center' }}>
            <style>{`@keyframes confetti-drop{0%{transform:translateY(-20px) rotate(0);opacity:1}100%{transform:translateY(400px) rotate(720deg);opacity:0}}`}</style>
            {[B.wavesBlue, B.yellow, B.red, B.green, B.blueLight, B.yellow].map((color, i) => (
              <div key={i} style={{
                position: 'fixed', top: 0, left: `${10 + i * 15}%`,
                width: 6 + i % 3 * 3, height: 6 + i % 3 * 3,
                borderRadius: i % 2 ? 2 : '50%', background: color,
                animation: `confetti-drop 3s ease-out ${i * 0.2}s forwards`,
                zIndex: 50,
              }} />
            ))}

            <div style={{ fontSize: 48, marginTop: 20 }}></div>
            <h1 style={{
              fontSize: 'clamp(36px, 7vw, 48px)', fontFamily: FONTS.display, fontWeight: 400,
              color: '#fff', letterSpacing: '0.02em', lineHeight: 1.05,
              margin: '8px 0 0', textShadow: '0 2px 12px rgba(0,0,0,0.25)',
            }}>
              You're all set, {c.firstName}!
            </h1>
            <div style={{ fontSize: 16, color: B.blueLight, marginTop: 4 }}>Welcome to the Waves family.</div>

            <div style={{ background: '#fff', borderRadius: 16, padding: 24, marginTop: 20, textAlign: 'left' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginBottom: 8 }}>Your Plan</div>
              <div style={{ fontSize: 13, color: B.grayDark }}>{q.serviceType}</div>
              {q.tier && <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 10, background: B.yellow, color: B.blueDeeper, marginTop: 4 }}>WaveGuard {q.tier}</span>}
              <div style={{ fontSize: 22, fontWeight: 800, color: B.navy, fontFamily: FONTS.ui, marginTop: 6 }}>${q.monthlyRate.toFixed(2)}/mo</div>

              {svc && (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginTop: 16, marginBottom: 4 }}>First Visit</div>
                  <div style={{ fontSize: 13, color: B.grayDark }}>
                    {new Date(svc.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                    {svc.windowStart && ` · ${fmtTime(svc.windowStart)} – ${fmtTime(svc.windowEnd)}`}
                    {svc.techName && ` · ${svc.techName}`}
                  </div>
                </>
              )}

              {data.card && (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginTop: 16, marginBottom: 4 }}>Payment</div>
                  <div style={{ fontSize: 13, color: B.grayDark }}>{data.card.brand} ····{data.card.lastFour} · Auto-pay {data.card.autopay ? 'enabled' : 'disabled'}</div>
                </>
              )}

              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading, marginTop: 16, marginBottom: 6 }}>Property</div>
              {[
                prefs.neighborhoodGateCode || prefs.propertyGateCode ? ' Gate codes on file' : ' No gate codes',
                prefs.petCount > 0 ? ' Pet info saved' : ' No pet info',
                prefs.preferredDay !== 'no_preference' ? ' Scheduling preferences set' : ' No scheduling prefs',
                (prefs.specialFeatures || []).length > 0 ? ' Property features noted' : ' No property features',
              ].map((line, i) => (
                <div key={i} style={{ fontSize: 12, color: line.startsWith('') ? B.grayDark : B.textCaption, marginBottom: 2 }}>{line}</div>
              ))}
            </div>

            <a href="/" style={{
              ...BUTTON_BASE, width: '100%', padding: 16, marginTop: 20,
              background: B.yellow, color: B.blueDeeper, fontSize: 16, textDecoration: 'none',
              display: 'flex', boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
            }}>Explore Your Portal →</a>

            {/* Referral card */}
            <div style={{ background: B.blueSurface, borderRadius: 16, padding: 18, marginTop: 16, textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: B.navy }}>Know someone who needs pest control? </div>
              <div style={{ fontSize: 12, color: B.grayDark, marginTop: 4 }}>Share your link — you both get $25</div>
              <a href={`sms:?body=${encodeURIComponent(`Hey! I just signed up with Waves Pest Control and they're awesome. Use my referral link and we both get $25 off: https://wavespestcontrol.com?ref=${c.referralCode}`)}`} style={{
                ...BUTTON_BASE, padding: '9px 20px', fontSize: 13, marginTop: 10,
                borderRadius: 9999, background: B.yellow, color: B.blueDeeper,
                textDecoration: 'none', display: 'inline-flex', fontWeight: 800,
              }}> Text a Friend</a>
            </div>

            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 20 }}>
              Questions? Call or text <a href="tel:+19412975749" style={{ color: '#fff', textDecoration: 'none', fontWeight: 600 }}>(941) 297-5749</a>
            </div>
          </div>
        )}

        <BrandFooter variant="dark" />
      </div>
    </div>
  );
}
