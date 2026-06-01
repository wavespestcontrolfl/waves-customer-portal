import Icon from '../components/Icon';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { FONTS } from '../theme-brand';
import {
  WavesShell,
  BrandCard,
  BrandButton,
  SerifHeading,
  HelpPhoneLink,
} from '../components/brand';
import SaveCardConsent from '../components/billing/SaveCardConsent';
import { etDateString } from '../lib/timezone';
import {
  buildSetupIntentReturnUrl,
  clearReturnedSetupIntent,
  getReturnedSetupIntent,
  redirectToSetupIntentAction,
  setupIntentIncompleteMessage,
} from '../lib/stripeSetupActions';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const STEPS = [
  { label: 'Plan', icon: 'shield' },
  { label: 'Payment', icon: 'card' },
  { label: 'Visit', icon: 'calendar' },
  { label: 'Done', icon: 'checkCircle' },
];

let stripePromise = null;
function loadStripeJs(publishableKey) {
  if (stripePromise) return stripePromise;
  stripePromise = new Promise((resolve, reject) => {
    if (window.Stripe) {
      resolve(window.Stripe(publishableKey));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.async = true;
    script.onload = () => resolve(window.Stripe(publishableKey));
    script.onerror = () => reject(new Error('Failed to load Stripe'));
    document.head.appendChild(script);
  });
  return stripePromise;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.message || err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function normalizeFeatures(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return value.split(',').map(v => v.trim()).filter(Boolean);
    }
  }
  return [];
}

function money(value) {
  const n = Number(value || 0);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function billingDisplay(quote) {
  const billing = quote?.billing || {};
  return {
    amount: billing.amount ?? quote?.monthlyRate ?? 0,
    suffix: billing.displaySuffix || '/ mo',
    planLabel: billing.planLabel || 'Monthly plan',
    periodText: billing.periodLabel ? `per ${billing.periodLabel}` : 'per month',
    visitChargeLabel: billing.visitChargeLabel || 'Charged after each visit',
  };
}

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtVisitDate(value, includeYear = true) {
  if (!value) return 'Date TBD';
  const dateOnly = String(value).slice(0, 10);
  return new Date(`${dateOnly}T12:00:00`).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
  });
}

function serviceName(value) {
  return String(value || 'Waves service').split('—')[0].trim();
}

function StepProgress({ current, payAtVisit }) {
  return (
    <div className="waves-onboarding-steps" aria-label="Onboarding progress">
      {STEPS.map((step, idx) => {
        const skippedPayment = payAtVisit && idx === 1;
        const complete = idx < current || (current === 2 && skippedPayment);
        const active = idx === current || (current === 2 && skippedPayment);
        return (
          <div
            key={step.label}
            className="waves-onboarding-step"
            style={{
              borderColor: active || complete ? 'var(--brand)' : 'var(--border)',
              background: active ? 'var(--brand-soft)' : 'var(--surface)',
              color: active || complete ? 'var(--brand)' : 'var(--text-muted)',
            }}
          >
            <span style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: complete ? 'var(--brand)' : 'transparent',
              color: complete ? '#fff' : 'currentColor',
            }}>
              <Icon name={complete ? 'check' : step.icon} size={14} strokeWidth={2.2} />
            </span>
            <span>{skippedPayment ? 'Skipped' : step.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusPill({ tone = 'neutral', children }) {
  const tones = {
    neutral: { bg: '#FAF8F3', color: 'var(--text)', border: '#E7E2D7' },
    success: { bg: '#F0FDF4', color: '#047857', border: '#BBF7D0' },
    attention: { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
    brand: { bg: 'var(--brand-soft)', color: 'var(--brand)', border: 'var(--brand-ring)' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      minHeight: 28,
      padding: '5px 9px',
      borderRadius: 8,
      background: t.bg,
      border: `1px solid ${t.border}`,
      color: t.color,
      fontSize: 12,
      fontWeight: 850,
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontSize: 14, fontWeight: 700, textAlign: 'right' }}>{value || 'Not set'}</span>
    </div>
  );
}

function PlanSummary({ customer, quote, service, payAtVisit, card, paymentStep = false, style }) {
  const billing = billingDisplay(quote);
  return (
    <BrandCard
      padding={paymentStep ? 28 : 24}
      style={{
        position: paymentStep ? 'static' : 'sticky',
        top: 20,
        ...(paymentStep ? {
          background: '#F2EEE0',
          border: '1px solid #D9D3C4',
          borderRadius: 12,
          boxShadow: '0 6px 18px rgba(15,23,42,.10),0 2px 4px rgba(15,23,42,.06)',
        } : {}),
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: paymentStep ? 22 : 15, fontWeight: paymentStep ? 600 : 850, color: '#1B2C5B', fontFamily: paymentStep ? 'Inter, system-ui, sans-serif' : undefined, lineHeight: 1.2 }}>
            {paymentStep ? 'Review Auto Pay setup' : 'Setup Summary'}
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>{customer?.firstName} {customer?.lastName}</div>
        </div>
      </div>

      <div style={{ fontSize: paymentStep ? 34 : 24, lineHeight: 1.05, fontWeight: 850, color: '#1B2C5B', marginBottom: 4 }}>
        {money(billing.amount)}<span style={{ fontSize: 14, color: 'var(--text-muted)', fontWeight: 650 }}> {billing.suffix}</span>
      </div>
      <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: 14 }}>
        {quote?.serviceType || 'Waves service'}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {quote?.tier && <StatusPill tone="brand">WaveGuard {quote.tier}</StatusPill>}
        {payAtVisit ? <StatusPill tone="attention">Pay at visit</StatusPill> : <StatusPill tone={card ? 'success' : 'neutral'}>{card ? 'Auto Pay active' : 'Auto Pay after completed visits'}</StatusPill>}
      </div>

      <DetailRow label="First visit" value={service ? fmtVisitDate(service.date, false) : 'To be scheduled'} />
      <DetailRow label="Window" value={service?.windowStart ? `${fmtTime(service.windowStart)} - ${fmtTime(service.windowEnd)}` : 'Time TBD'} />
      <DetailRow label="Technician" value={service?.techName || 'TBD'} />
      <DetailRow label="Address" value={customer?.address} />

      <div style={{ marginTop: 16, fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Need help? <HelpPhoneLink tone="dark" inline />
      </div>
    </BrandCard>
  );
}

function ToggleSwitch({ value, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!value}
      aria-label={label}
      onClick={() => onChange(!value)}
      style={{
        width: 48,
        height: 28,
        borderRadius: 999,
        border: `1px solid ${value ? 'var(--brand)' : 'var(--border-strong)'}`,
        background: value ? 'var(--brand)' : '#FAF8F3',
        position: 'relative',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 140ms ease, border-color 140ms ease',
      }}
    >
      <span style={{
        position: 'absolute',
        top: 3,
        left: value ? 23 : 3,
        width: 20,
        height: 20,
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 3px rgba(15,23,42,0.18)',
        transition: 'left 140ms ease',
      }} />
    </button>
  );
}

function PillSelect({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map(o => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              minHeight: 38,
              padding: '0 13px',
              borderRadius: 8,
              border: `1px solid ${active ? 'var(--brand)' : 'var(--border)'}`,
              background: active ? 'var(--brand-soft)' : '#fff',
              color: active ? 'var(--brand)' : 'var(--text)',
              fontSize: 14,
              fontWeight: 750,
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SectionHeader({ icon, title, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '26px 0 12px' }}>
      <span style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--brand-soft)',
        color: 'var(--brand)',
        flexShrink: 0,
      }}>
        <Icon name={icon} size={17} strokeWidth={2} />
      </span>
      <div>
        <div style={{ fontSize: 16, fontWeight: 850, color: 'var(--text)' }}>{title}</div>
        {sub && <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{sub}</div>}
      </div>
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <div style={{
      fontSize: 12,
      color: 'var(--text-muted)',
      fontWeight: 850,
      textTransform: 'uppercase',
      marginBottom: 7,
      marginTop: 14,
    }}>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  minHeight: 44,
  padding: '11px 12px',
  borderRadius: 8,
  border: '1px solid var(--border-strong)',
  background: '#fff',
  fontSize: 14,
  fontFamily: FONTS.body,
  color: 'var(--text)',
  outline: 'none',
  boxSizing: 'border-box',
};

function TextArea({ name, value, onChange, placeholder, rows = 2 }) {
  return (
    <textarea
      name={name}
      value={value || ''}
      onChange={onChange}
      placeholder={placeholder}
      rows={rows}
      style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
    />
  );
}

function PasswordInput({ name, value, onChange, placeholder }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={show ? 'text' : 'password'}
        name={name}
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 44 }}
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        aria-label={show ? 'Hide code' : 'Show code'}
        style={{
          position: 'absolute',
          right: 8,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 32,
          height: 32,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-muted)',
          cursor: 'pointer',
        }}
      >
        <Icon name={show ? 'eyeOff' : 'eye'} size={17} />
      </button>
    </div>
  );
}

function FeatureTile({ selected, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 44,
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${selected ? 'var(--brand)' : 'var(--border)'}`,
        background: selected ? 'var(--brand-soft)' : '#fff',
        color: selected ? 'var(--brand)' : 'var(--text)',
        fontSize: 14,
        fontWeight: 750,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {label}
    </button>
  );
}

function ToggleRow({ label, value, onChange, sub }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 14,
      padding: '13px 0',
      borderTop: '1px solid var(--border)',
    }}>
      <div>
        <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 750 }}>{label}</div>
        {sub && <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <ToggleSwitch value={value} onChange={onChange} label={label} />
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
  const detailsDirtyRef = useRef(false);
  const detailsSaveVersionRef = useRef(0);

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
  const [hasPets, setHasPets] = useState(false);
  const [hasHoa, setHasHoa] = useState(false);

  const [stripeReady, setStripeReady] = useState(false);
  const [stripeError, setStripeError] = useState('');
  const [stripeFatalError, setStripeFatalError] = useState(false);
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
  const processedSetupReturnRef = useRef(false);

  useEffect(() => {
    apiFetch(`/onboarding/${token}`)
      .then(d => {
        const existingPrefs = d.preferences || {};
        setData(d);
        setPrefs(prev => ({
          ...prev,
          ...existingPrefs,
          petsPlan: existingPrefs.petsPlan ?? existingPrefs.petSecuredPlan ?? prev.petsPlan,
          specialFeatures: normalizeFeatures(existingPrefs.specialFeatures),
        }));
        setHasGate(!!existingPrefs.neighborhoodGateCode);
        setHasYardGate(!!existingPrefs.propertyGateCode);
        setHasPets(Number(existingPrefs.petCount || 0) > 0);
        setHasHoa(!!(existingPrefs.hoaName || existingPrefs.hoaRestrictions));

        const payAtVisitChoice = d.scheduledService?.paymentMethodPreference === 'pay_at_visit';
        if (d.status.current === 'complete') setScreen(3);
        else if (d.status.detailsCollected) setScreen(3);
        else if (d.status.serviceConfirmed) setScreen(2);
        else if (d.status.paymentCollected) setScreen(2);
        else if (payAtVisitChoice) setScreen(0);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  useEffect(() => {
    if (processedSetupReturnRef.current) return;
    const returned = getReturnedSetupIntent('onboarding_autopay');
    if (!returned) return;

    processedSetupReturnRef.current = true;
    setSubmitting(true);
    setStripeError('');
    apiFetch(`/onboarding/${token}/save-card`, {
      method: 'POST',
      body: JSON.stringify({ setupIntentId: returned.setupIntentId }),
    })
      .then((result) => {
        clearReturnedSetupIntent();
        setData(prev => (prev ? {
          ...prev,
          status: { ...prev.status, paymentCollected: true },
          card: {
            brand: result.card?.card_brand || result.card?.brand || 'CARD',
            lastFour: result.card?.last_four || result.card?.lastFour || '****',
            autopay: result.card?.autopay_enabled === true || result.card?.autopay === true,
          },
        } : prev));
        setTimeout(() => setScreen(2), 300);
      })
      .catch((e) => {
        setStripeError(e.message || 'Failed to finish bank account setup');
      })
      .finally(() => setSubmitting(false));
  }, [token]);

  const payAtVisit = data?.scheduledService?.paymentMethodPreference === 'pay_at_visit';

  const markDetailsDirty = useCallback(() => {
    detailsDirtyRef.current = true;
    detailsSaveVersionRef.current += 1;
  }, []);

  const updatePref = useCallback((field, value) => {
    markDetailsDirty();
    setPrefs(prev => ({ ...prev, [field]: value }));
  }, [markDetailsDirty]);

  const updateReferralSource = useCallback((value) => {
    markDetailsDirty();
    setReferralSource(value);
  }, [markDetailsDirty]);

  const updateReferredBy = useCallback((value) => {
    markDetailsDirty();
    setReferredBy(value);
  }, [markDetailsDirty]);

  const updateHasGate = useCallback((value) => {
    setHasGate(value);
    if (!value) updatePref('neighborhoodGateCode', '');
  }, [updatePref]);

  const updateHasYardGate = useCallback((value) => {
    setHasYardGate(value);
    if (!value) updatePref('propertyGateCode', '');
  }, [updatePref]);

  const buildDetailsPayload = useCallback(() => ({
    scheduling: {
      preferredTime: prefs.preferredTime,
      preferredDay: prefs.preferredDay,
      contactPreference: prefs.contactPreference,
      typicallyHome: prefs.typicallyHome,
    },
    access: {
      neighborhoodGateCode: prefs.neighborhoodGateCode,
      propertyGateCode: prefs.propertyGateCode,
      garageCode: prefs.garageCode,
      lockboxCode: prefs.lockboxCode,
      interiorAccessMethod: prefs.interiorAccessMethod,
      interiorAccessDetails: prefs.interiorAccessDetails,
      parkingNotes: prefs.parkingNotes,
    },
    pets: {
      petCount: prefs.petCount,
      petDetails: prefs.petDetails,
      petsPlan: prefs.petsPlan,
      chemicalSensitivities: prefs.chemicalSensitivities,
      chemicalSensitivityDetails: prefs.chemicalSensitivityDetails,
    },
    property: {
      specialFeatures: prefs.specialFeatures,
      irrigationSystem: prefs.irrigationSystem,
      irrigationControllerLocation: prefs.irrigationControllerLocation,
      irrigationZones: prefs.irrigationZones,
      hoaName: prefs.hoaName,
      hoaRestrictions: prefs.hoaRestrictions,
      specialInstructions: prefs.specialInstructions,
    },
    attribution: {
      referralSource,
      referredByPhone: referralSource === 'neighbor_referral' ? referredBy : null,
    },
  }), [prefs, referralSource, referredBy]);

  const autoSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const saveVersion = detailsSaveVersionRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        await apiFetch(`/onboarding/${token}/details`, {
          method: 'PUT',
          body: JSON.stringify(buildDetailsPayload()),
        });
        if (detailsSaveVersionRef.current === saveVersion) {
          detailsDirtyRef.current = false;
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch {}
    }, 1000);
  }, [token, buildDetailsPayload]);

  useEffect(() => {
    if (screen === 2 && detailsDirtyRef.current) autoSave();
  }, [prefs, referralSource, referredBy, screen, autoSave]);

  useEffect(() => {
    if (screen !== 1 || stripeInitRef.current || payAtVisit) return;
    stripeInitRef.current = true;
    (async () => {
      try {
        setStripeFatalError(false);
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
            pe.on('change', () => setStripeError(''));
          }
        }, 100);
      } catch (e) {
        setStripeFatalError(true);
        setStripeError(e.message || 'Failed to load payment form');
      }
    })();
  }, [screen, token, payAtVisit]);

  const handlePayment = async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setSubmitting(true);
    setStripeError('');
    try {
      const { error: setupError, setupIntent } = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        confirmParams: { return_url: buildSetupIntentReturnUrl('onboarding_autopay') },
        redirect: 'if_required',
      });
      if (setupError) {
        setStripeError(setupError.message);
        setSubmitting(false);
        return;
      }
      if (redirectToSetupIntentAction(setupIntent)) return;
      if (!setupIntent || setupIntent.status !== 'succeeded') {
        setStripeError(setupIntentIncompleteMessage('enabling Auto Pay'));
        setSubmitting(false);
        return;
      }
      if (setupIntent && setupIntent.payment_method) {
        const result = await apiFetch(`/onboarding/${token}/save-card`, {
          method: 'POST',
          body: JSON.stringify({
            paymentMethodId: setupIntent.payment_method,
            setupIntentId: setupIntent.id,
          }),
        });
        setData(prev => ({
          ...prev,
          status: { ...prev.status, paymentCollected: true },
          card: {
            brand: result.card?.card_brand || 'CARD',
            lastFour: result.card?.last_four || '****',
            autopay: result.card?.autopay_enabled === true || result.card?.autopay === true,
          },
        }));
        setTimeout(() => setScreen(2), 700);
      }
    } catch (e) {
      setStripeError(e.message || 'Payment setup failed');
    }
    setSubmitting(false);
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setError('');
    try {
      await apiFetch(`/onboarding/${token}/confirm-service`, { method: 'PUT', body: JSON.stringify({ confirmed: true }) });
      setData(prev => ({
        ...prev,
        status: { ...prev.status, serviceConfirmed: true },
        scheduledService: prev.scheduledService ? { ...prev.scheduledService, confirmed: true } : null,
      }));
    } catch (e) {
      setError(e.message);
    }
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
        setSlotsError('No open slots in your area right now. Call (941) 297-5749 and we will sort it out.');
      }
    } catch (e) {
      setSlotsError(e.message || 'Could not load available days');
    }
    setSlotsLoading(false);
  };

  const submitReschedule = async (date, startTime24) => {
    setSubmitting(true);
    setError('');
    try {
      await apiFetch(`/onboarding/${token}/reschedule-service`, {
        method: 'PUT',
        body: JSON.stringify({ date, startTime: startTime24 }),
      });
      const fresh = await apiFetch(`/onboarding/${token}`);
      setData(fresh);
      setShowReschedule(false);
      setPickedDate(null);
    } catch (e) {
      setError(e.message || 'Reschedule failed');
    }
    setSubmitting(false);
  };

  const handleComplete = async () => {
    setSubmitting(true);
    setError('');
    try {
      await apiFetch(`/onboarding/${token}/details`, {
        method: 'PUT',
        body: JSON.stringify(buildDetailsPayload()),
      });
      await apiFetch(`/onboarding/${token}/complete`, { method: 'POST' });
      setScreen(3);
    } catch (e) {
      setError(e.message);
    }
    setSubmitting(false);
  };

  const generateICS = () => {
    if (!data?.scheduledService) return;
    const s = data.scheduledService;
    const dateOnly = String(s.date).slice(0, 10);
    const d = new Date(`${dateOnly}T12:00:00`);
    const dateStr = etDateString(d).replace(/-/g, '');
    const start = s.windowStart ? `${dateStr}T${s.windowStart.replace(/:/g, '').slice(0, 4)}00` : `${dateStr}T080000`;
    const end = s.windowEnd ? `${dateStr}T${s.windowEnd.replace(/:/g, '').slice(0, 4)}00` : `${dateStr}T100000`;
    const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:Waves Pest Control - ${s.serviceType}\nLOCATION:${data.customer.address}\nDESCRIPTION:Tech: ${s.techName || 'TBD'}. Please ensure gates are unlocked and pets secured.\nBEGIN:VALARM\nTRIGGER:-PT60M\nACTION:DISPLAY\nDESCRIPTION:Waves service in 1 hour\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR`;
    const blob = new Blob([ics], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'waves-service.ics';
    a.click();
  };

  if (loading) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div className="waves-onboarding-page">
          <BrandCard padding={28}>
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading setup...</div>
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  if (error && !data) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div className="waves-onboarding-page waves-onboarding-single">
          <BrandCard padding={28}>
            <StatusPill tone="attention">Link unavailable</StatusPill>
            <SerifHeading style={{ marginTop: 14, marginBottom: 10 }}>We could not open setup</SerifHeading>
            <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.6 }}>
              {error} Give us a call and we can help - <HelpPhoneLink tone="dark" inline />.
            </p>
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  const c = data.customer;
  const q = data.quote;
  const svc = data.scheduledService;
  const billing = billingDisplay(q);
  const serviceConfirmed = data.status.serviceConfirmed || svc?.confirmed;

  const headerTitle = screen === 0
    ? `Welcome, ${c.firstName}`
    : screen === 1
      ? 'Set up Auto Pay'
      : screen === 2
        ? 'Set up your first visit'
        : `You are all set, ${c.firstName}`;
  const headerCopy = screen === 0
    ? `Your ${serviceName(q.serviceType)} plan is ready. Finish the details below so your first service starts cleanly.`
    : screen === 1
      ? 'Save a payment method to turn on Auto Pay for future service visits and invoices as agreed.'
      : screen === 2
        ? 'Confirm the appointment and leave the access notes your technician needs before arriving.'
        : 'Your plan, first visit, and property notes are saved.';

  return (
    <WavesShell variant="customer" topBar="solid">
      <div
        className="waves-onboarding-page"
        style={screen === 1 ? { width: 'min(100% - 48px, 1040px)', margin: '0 auto 56px', paddingTop: 34 } : undefined}
      >
        {saved && (
          <div style={{
            position: 'fixed',
            top: 74,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
          }}>
            <StatusPill tone="success">Saved</StatusPill>
          </div>
        )}

        <div
          className="waves-flow-header"
          style={screen === 1 ? { display: 'block', marginBottom: 28 } : undefined}
        >
          <div style={screen === 1 ? { order: 2 } : undefined}>
            <StatusPill tone={screen === 3 ? 'success' : 'brand'}>{screen === 3 ? 'Setup complete' : 'New customer setup'}</StatusPill>
            <SerifHeading
              style={screen === 1
                ? { marginTop: 14, marginBottom: 12, fontSize: 'clamp(40px,6vw,64px)', lineHeight: 1.04, maxWidth: 860, fontWeight: 500 }
                : { marginTop: 14, marginBottom: 8 }}
            >
              {headerTitle}
            </SerifHeading>
            <p style={screen === 1
              ? { margin: 0, color: '#3F4A65', fontSize: 17, lineHeight: 1.55, maxWidth: 760 }
              : { margin: 0, color: 'var(--text-muted)', fontSize: 16, lineHeight: 1.55, maxWidth: 660 }}
            >
              {headerCopy}
            </p>
          </div>
          {screen === 1 ? null : <StepProgress current={screen} payAtVisit={payAtVisit} />}
        </div>

        <div
          className={screen === 3 ? 'waves-onboarding-single' : 'waves-onboarding-grid'}
          style={screen === 1 ? { display: 'grid', gridTemplateColumns: '1fr', gap: 16, maxWidth: 760 } : undefined}
        >
          <div>
            {screen === 0 && (
              <BrandCard padding={30}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                  <span style={{
                    width: 44,
                    height: 44,
                    borderRadius: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--brand-soft)',
                    color: 'var(--brand)',
                  }}>
                    <Icon name="shield" size={22} strokeWidth={2} />
                  </span>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 850, color: 'var(--text)' }}>{q.serviceType}</div>
                    <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 2 }}>{c.address}</div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 22 }}>
                  <div style={{ padding: '14px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase' }}>{billing.planLabel}</div>
                    <div style={{ fontSize: 28, fontWeight: 850, color: 'var(--text)', marginTop: 6 }}>{money(billing.amount)}</div>
                    <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 3 }}>{billing.periodText}</div>
                  </div>
                  <div style={{ padding: '14px 0', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase' }}>Payment</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginTop: 9 }}>
                      {payAtVisit ? 'At the visit' : q.depositAmount > 0 ? `${money(q.depositAmount)} visit-day hold` : 'Auto Pay setup'}
                    </div>
                  </div>
                </div>

                {q.tier && (
                  <div style={{
                    border: '1px solid var(--border)',
                    background: '#FAF8F3',
                    borderRadius: 8,
                    padding: 14,
                    marginBottom: 20,
                    color: 'var(--text)',
                    fontSize: 14,
                    lineHeight: 1.55,
                  }}>
                    WaveGuard {q.tier} includes bundled savings and ongoing protection for the services in your accepted estimate.
                  </div>
                )}

                <BrandButton
                  onClick={() => setScreen(payAtVisit ? 2 : 1)}
                  fullWidth
                  rightIcon={<Icon name="arrowRight" size={16} />}
                >
                  {payAtVisit ? 'Finish Setup' : 'Continue to Auto Pay'}
                </BrandButton>
                <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 12, textAlign: 'center' }}>
                  Most customers finish this in about two minutes.
                </div>
              </BrandCard>
            )}

            {screen === 1 && (
              <BrandCard
                padding={28}
                style={{
                  background: '#F3EEE1',
                  border: '1px solid #D8D1C3',
                  borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(15,23,42,.08)',
                }}
              >
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontFamily: FONTS.heading, fontSize: 22, fontWeight: 600, color: '#1B2C5B', lineHeight: 1.2, letterSpacing: 0 }}>
                    Secure payment setup
                  </div>
                  <div style={{ fontSize: 14, color: '#6B7280', marginTop: 8, lineHeight: 1.55 }}>
                    Nothing is charged today unless your accepted plan says otherwise. Choose card or Bank account (ACH); we use Stripe for secure storage.
                  </div>
                </div>
                <div style={{ marginTop: 16 }}>
                  <div style={{
                    padding: 14,
                    borderRadius: 8,
                    background: '#F8FCFE',
                    border: '1px solid #CFE7F5',
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: '#1B2C5B',
                    marginBottom: 16,
                  }}>
                    <span>
                      A credit card surcharge of up to 3.99% may apply. The exact surcharge and total will be shown before payment.
                      Debit cards, prepaid cards, and bank transfers have no added card surcharge.
                    </span>
                  </div>

                  <div style={{ fontSize: 12, color: '#6B7280', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', lineHeight: 1.35, marginBottom: 8 }}>
                    Payment method
                  </div>
                  <div style={{ fontSize: 14, color: '#6B7280', marginBottom: 10, lineHeight: 1.5 }}>
                    Choose card, wallet, or Bank account (ACH).
                  </div>
                  <div ref={cardMountRef} style={{
                    minHeight: 132,
                    padding: 14,
                    border: '1px solid #D4CBB8',
                    borderRadius: 8,
                    background: '#fff',
                    marginBottom: 14,
                  }} />

                  {stripeError && (
                    <div style={{ padding: 12, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 14, color: '#991B1B', marginBottom: 14 }}>
                      {stripeError}
                    </div>
                  )}

                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '13px 0',
                    borderTop: '1px solid var(--border)',
                    borderBottom: '1px solid var(--border)',
                    marginBottom: 16,
                  }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: '#1B2C5B' }}>Auto Pay after completed visits</div>
                      <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4, lineHeight: 1.45 }}>
                        {billing.visitChargeLabel}: {money(billing.amount)} {billing.suffix}. Auto Pay becomes active when this method is saved.
                      </div>
                    </div>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      minHeight: 28,
                      padding: '5px 9px',
                      borderRadius: 999,
                      background: '#F8FCFE',
                      border: '1px solid #CFE7F5',
                      color: '#1B2C5B',
                      fontSize: 12,
                      fontWeight: 800,
                      textTransform: 'uppercase',
                      letterSpacing: '.06em',
                      whiteSpace: 'nowrap',
                    }}>Visit-day charge</span>
                  </div>

                  <SaveCardConsent locked onChange={() => {}} />

                  {q.depositAmount > 0 && (
                    <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.5, margin: '14px 0 0' }}>
                      We will charge {money(q.depositAmount)} on your visit day. No payment is collected during this setup step.
                    </div>
                  )}

                  <BrandButton
                    onClick={handlePayment}
                    disabled={submitting || !stripeReady || stripeFatalError}
                    fullWidth
                    style={{
                      marginTop: 18,
                      minHeight: 42,
                      borderRadius: 8,
                      background: '#1B2C5B',
                      border: '1px solid #1B2C5B',
                      fontSize: 14,
                      fontWeight: 800,
                      lineHeight: 1.2,
                    }}
                  >
                    {submitting ? 'Saving...' : stripeFatalError ? 'Payment Form Unavailable' : !stripeReady ? 'Loading payment form...' : 'Save Payment Method & Turn On Auto Pay'}
                  </BrandButton>
                  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 7, fontSize: 12, color: '#6B7280', marginTop: 12, lineHeight: 1.5 }}>
                    <span>256-bit encrypted · Processed by Stripe</span>
                  </div>
                </div>
              </BrandCard>
            )}

            {screen === 2 && (
              <BrandCard padding={30}>
                {error && (
                  <div style={{ padding: 12, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 14, color: '#991B1B', marginBottom: 18 }}>
                    {error}
                  </div>
                )}

                {svc && (
                  <div style={{ border: '1px solid #E7E2D7', borderRadius: 8, padding: 16, background: '#FAF8F3' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
                      <div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase' }}>First service</div>
                        <div style={{ fontSize: 20, color: 'var(--text)', fontWeight: 850, marginTop: 5, lineHeight: 1.25 }}>
                          {fmtVisitDate(svc.date)}
                        </div>
                        <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 5 }}>
                          {svc.windowStart ? `${fmtTime(svc.windowStart)} - ${fmtTime(svc.windowEnd)}` : 'Time TBD'} · {svc.techName || 'Tech TBD'}
                        </div>
                      </div>
                      <StatusPill tone={serviceConfirmed ? 'success' : 'attention'}>{serviceConfirmed ? 'Confirmed' : 'Needs confirmation'}</StatusPill>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
                      {!serviceConfirmed ? (
                        <>
                          <BrandButton onClick={handleConfirm} disabled={submitting} style={{ minWidth: 140 }}>
                            Confirm Visit
                          </BrandButton>
                          <BrandButton variant="secondary" onClick={openReschedule} disabled={submitting} style={{ minWidth: 140 }}>
                            Reschedule
                          </BrandButton>
                        </>
                      ) : (
                        <BrandButton variant="secondary" onClick={generateICS} leftIcon={<Icon name="calendar" size={16} />}>
                          Add to Calendar
                        </BrandButton>
                      )}
                    </div>

                    {showReschedule && (
                      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                          <div>
                            <div style={{ fontSize: 15, fontWeight: 850, color: 'var(--text)' }}>Pick a new day</div>
                            <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 2 }}>Only showing days with a Waves route nearby.</div>
                          </div>
                          <button type="button" onClick={() => { setShowReschedule(false); setPickedDate(null); }} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 6 }}>
                            <Icon name="x" size={18} />
                          </button>
                        </div>

                        {slotsLoading && <div style={{ marginTop: 12, fontSize: 14, color: 'var(--text-muted)' }}>Loading available days...</div>}
                        {slotsError && <div style={{ marginTop: 12, fontSize: 14, color: '#991B1B' }}>{slotsError}</div>}

                        {!slotsLoading && !slotsError && slotDays.length > 0 && !pickedDate && (
                          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 }}>
                            {slotDays.map(day => (
                              <button
                                key={day.date}
                                type="button"
                                onClick={() => setPickedDate(day)}
                                style={{
                                  padding: '10px 8px',
                                  borderRadius: 8,
                                  border: '1px solid var(--border)',
                                  background: '#fff',
                                  cursor: 'pointer',
                                  textAlign: 'center',
                                }}
                              >
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 850 }}>{day.dayOfWeek}</div>
                                <div style={{ fontSize: 20, fontWeight: 850, color: 'var(--text)', marginTop: 2 }}>{day.dayNum}</div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{day.month}</div>
                                <div style={{ fontSize: 12, color: 'var(--brand)', fontWeight: 800, marginTop: 4 }}>{day.slots.length} open</div>
                              </button>
                            ))}
                          </div>
                        )}

                        {pickedDate && (
                          <div style={{ marginTop: 12 }}>
                            <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 800, marginBottom: 8 }}>{pickedDate.fullDate}</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(142px, 1fr))', gap: 8 }}>
                              {pickedDate.slots.map(slot => (
                                <button
                                  key={slot.startTime24}
                                  type="button"
                                  disabled={submitting}
                                  onClick={() => submitReschedule(pickedDate.date, slot.startTime24)}
                                  style={{
                                    padding: '10px 12px',
                                    borderRadius: 8,
                                    border: '1px solid var(--brand)',
                                    background: 'var(--brand-soft)',
                                    cursor: submitting ? 'default' : 'pointer',
                                    fontSize: 14,
                                    fontWeight: 800,
                                    color: 'var(--brand)',
                                  }}
                                >
                                  {slot.start} - {slot.end}
                                </button>
                              ))}
                            </div>
                            <button type="button" onClick={() => setPickedDate(null)} style={{ marginTop: 10, background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--brand)', fontWeight: 800, padding: 0 }}>
                              Choose a different day
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <SectionHeader icon="calendar" title="Scheduling Preferences" />
                <FieldLabel>Preferred time</FieldLabel>
                <PillSelect options={[
                  { value: 'early_morning', label: 'Early AM' }, { value: 'morning', label: 'Morning' },
                  { value: 'midday', label: 'Midday' }, { value: 'afternoon', label: 'Afternoon' },
                  { value: 'no_preference', label: 'Any time' },
                ]} value={prefs.preferredTime} onChange={v => updatePref('preferredTime', v)} />

                <FieldLabel>Preferred day</FieldLabel>
                <PillSelect options={[
                  { value: 'monday', label: 'Mon' }, { value: 'tuesday', label: 'Tue' },
                  { value: 'wednesday', label: 'Wed' }, { value: 'thursday', label: 'Thu' },
                  { value: 'friday', label: 'Fri' }, { value: 'no_preference', label: 'Any day' },
                ]} value={prefs.preferredDay} onChange={v => updatePref('preferredDay', v)} />

                <FieldLabel>Contact preference</FieldLabel>
                <PillSelect options={[
                  { value: 'call', label: 'Call' }, { value: 'text', label: 'Text' }, { value: 'email', label: 'Email' },
                ]} value={prefs.contactPreference} onChange={v => updatePref('contactPreference', v)} />

                <SectionHeader icon="key" title="Access & Gates" sub="Only your assigned technician sees access details on service day." />
                <ToggleRow label="Community gate" value={hasGate} onChange={updateHasGate} />
                {hasGate && <PasswordInput name="neighborhoodGateCode" value={prefs.neighborhoodGateCode} onChange={v => updatePref('neighborhoodGateCode', v)} placeholder="e.g. Press #1234 at callbox" />}
                <ToggleRow label="Yard gate locked" value={hasYardGate} onChange={updateHasYardGate} />
                {hasYardGate && <PasswordInput name="propertyGateCode" value={prefs.propertyGateCode} onChange={v => updatePref('propertyGateCode', v)} placeholder="e.g. Combo lock: 4821" />}

                <SectionHeader icon="paw" title="Pets & Household" />
                <ToggleRow
                  label="Any pets?"
                  value={hasPets}
                  onChange={v => { setHasPets(v); updatePref('petCount', v ? Math.max(1, Number(prefs.petCount || 1)) : 0); }}
                />
                {hasPets && (
                  <div style={{ display: 'grid', gap: 8 }}>
                    <TextArea name="petDetails" value={prefs.petDetails} onChange={e => updatePref('petDetails', e.target.value)} placeholder="e.g. 2 dogs: Max is friendly, Bella barks but is harmless" />
                    <TextArea name="petsPlan" value={prefs.petsPlan} onChange={e => updatePref('petsPlan', e.target.value)} placeholder="e.g. Dogs will be inside. Please text 15 min before." />
                  </div>
                )}

                <SectionHeader icon="home" title="Property Notes" />
                <FieldLabel>Special features</FieldLabel>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                  {[
                    { value: 'pool', label: 'Pool / spa' }, { value: 'koi_pond', label: 'Koi pond' },
                    { value: 'vegetable_garden', label: 'Vegetable garden' }, { value: 'fruit_trees', label: 'Fruit trees' },
                    { value: 'beehives', label: 'Beehives' }, { value: 'playground', label: 'Playground' },
                  ].map(f => {
                    const selected = (prefs.specialFeatures || []).includes(f.value);
                    return (
                      <FeatureTile
                        key={f.value}
                        label={f.label}
                        selected={selected}
                        onClick={() => {
                          const feats = prefs.specialFeatures || [];
                          updatePref('specialFeatures', selected ? feats.filter(x => x !== f.value) : [...feats, f.value]);
                        }}
                      />
                    );
                  })}
                </div>

                <ToggleRow label="HOA or community rules" value={hasHoa} onChange={setHasHoa} />
                {hasHoa && (
                  <div style={{ display: 'grid', gap: 8 }}>
                    <input name="hoaName" value={prefs.hoaName || ''} onChange={e => updatePref('hoaName', e.target.value)} placeholder="HOA name" style={inputStyle} />
                    <input name="hoaRestrictions" value={prefs.hoaRestrictions || ''} onChange={e => updatePref('hoaRestrictions', e.target.value)} placeholder="Restrictions, parking notes, sign rules" style={inputStyle} />
                  </div>
                )}

                <FieldLabel>Anything else your tech should know?</FieldLabel>
                <TextArea name="specialInstructions" value={prefs.specialInstructions} onChange={e => updatePref('specialInstructions', e.target.value)} placeholder="Doorbell, parking, locked areas, or special instructions..." rows={3} />

                <SectionHeader icon="megaphone" title="How Did You Find Us?" />
                <PillSelect options={[
                  { value: 'google', label: 'Google' }, { value: 'facebook', label: 'Facebook' },
                  { value: 'neighbor_referral', label: 'Neighbor' }, { value: 'nextdoor', label: 'Nextdoor' },
                  { value: 'yard_sign', label: 'Yard sign' }, { value: 'saw_van', label: 'Saw van' },
                  { value: 'newsletter', label: 'Newsletter' }, { value: 'other', label: 'Other' },
                ]} value={referralSource} onChange={updateReferralSource} />
                {referralSource === 'neighbor_referral' && (
                  <div style={{ marginTop: 10 }}>
                    <input name="referredBy" value={referredBy} onChange={e => updateReferredBy(e.target.value)} placeholder="Their name or phone so we can credit them" style={inputStyle} />
                    <div style={{ fontSize: 14, color: '#047857', marginTop: 6 }}>Your neighbor gets credit after verification.</div>
                  </div>
                )}

                <BrandButton
                  onClick={handleComplete}
                  disabled={submitting || !serviceConfirmed}
                  fullWidth
                  rightIcon={<Icon name="arrowRight" size={16} />}
                  style={{ marginTop: 24 }}
                >
                  {submitting ? 'Finishing...' : serviceConfirmed ? 'Finish Setup' : 'Confirm Your Service Above'}
                </BrandButton>
              </BrandCard>
            )}
          </div>

          {screen !== 3 && (
            <PlanSummary
              customer={c}
              quote={q}
              service={svc}
              payAtVisit={payAtVisit}
              card={data.card}
              paymentStep={screen === 1}
              style={screen === 1 ? { order: 1 } : undefined}
            />
          )}

          {screen === 3 && (
            <BrandCard padding={30}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                <span style={{
                  width: 46,
                  height: 46,
                  borderRadius: 8,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#F0FDF4',
                  color: '#047857',
                }}>
                  <Icon name="checkCircle" size={24} strokeWidth={2} />
                </span>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 850, color: 'var(--text)' }}>Setup complete</div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 2 }}>Welcome to Waves.</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 18, borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: '18px 0' }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase' }}>Plan</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginTop: 6 }}>{q.serviceType}</div>
                  {q.tier && <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 3 }}>WaveGuard {q.tier}</div>}
                  <div style={{ fontSize: 20, fontWeight: 850, color: 'var(--text)', marginTop: 6 }}>{money(billing.amount)} {billing.suffix}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase' }}>First visit</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginTop: 6 }}>{svc ? fmtVisitDate(svc.date, false) : 'To be scheduled'}</div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 3 }}>
                    {svc?.windowStart ? `${fmtTime(svc.windowStart)} - ${fmtTime(svc.windowEnd)}` : 'Time TBD'}{svc?.techName ? ` · ${svc.techName}` : ''}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 850, textTransform: 'uppercase' }}>Payment</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginTop: 6 }}>
                    {data.card ? `${data.card.brand} ending ${data.card.lastFour}` : payAtVisit ? 'Pay at visit' : 'On file'}
                  </div>
                  <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 3 }}>
                    {data.card?.autopay ? 'Auto Pay enabled' : data.card ? 'Card saved for visit-day charges' : 'No card saved'}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 18, display: 'grid', gap: 7 }}>
                {[
                  prefs.neighborhoodGateCode || prefs.propertyGateCode ? 'Gate access saved' : 'No gate codes saved',
                  prefs.petCount > 0 ? 'Pet notes saved' : 'No pet notes saved',
                  prefs.preferredDay !== 'no_preference' || prefs.preferredTime !== 'no_preference' ? 'Scheduling preference saved' : 'No scheduling preference saved',
                  (prefs.specialFeatures || []).length > 0 ? 'Property features saved' : 'No property features saved',
                ].map((line) => (
                  <div key={line} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--text)' }}>
                    <Icon name="check" size={15} strokeWidth={2.2} style={{ color: '#047857' }} />
                    {line}
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 24 }}>
                <a href="/" style={{
                  minHeight: 46,
                  padding: '0 20px',
                  borderRadius: 8,
                  background: 'var(--brand)',
                  color: '#fff',
                  border: '1px solid transparent',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: 700,
                  flex: '1 1 220px',
                }}>
                  Explore Your Portal
                </a>
                <a
                  href={`sms:?body=${encodeURIComponent(`Hey! I just signed up with Waves Pest Control. Use my referral link and we both get account credit: https://wavespestcontrol.com?ref=${c.referralCode}`)}`}
                  style={{
                    minHeight: 46,
                    padding: '0 20px',
                    borderRadius: 8,
                    background: '#fff',
                    color: 'var(--brand)',
                    border: '1px solid var(--border-strong)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    textDecoration: 'none',
                    fontSize: 14,
                    fontWeight: 700,
                    flex: '1 1 220px',
                  }}
                >
                  <Icon name="share" size={16} />
                  Text a Friend
                </a>
              </div>
            </BrandCard>
          )}
        </div>
      </div>
    </WavesShell>
  );
}
