import { useState, useEffect, useRef } from 'react';
import AddressAutocomplete from '../components/AddressAutocomplete';
import BrandFooter from '../components/BrandFooter';
import { Button } from '../components/Button';
import { COLORS, FONTS, SHADOWS } from '../theme-brand';

// ───────── Step config ─────────
function OptionIcon({ name }) {
  const common = {
    width: 28,
    height: 28,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };
  switch (name) {
    case 'shield': return <svg {...common}><path d="M12 3l8 3v6c0 4.5-3.4 8.6-8 9-4.6-.4-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>;
    case 'leaf':   return <svg {...common}><path d="M5 21c0-8 6-14 16-16-.5 10-6 16-14 16"/><path d="M5 21c4-4 8-6 12-8"/></svg>;
    case 'home':   return <svg {...common}><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>;
    case 'repeat': return <svg {...common}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>;
    case 'one':    return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M10 9l2-1v8"/></svg>;
    case 'help':   return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>;
    case 'chat':   return <svg {...common}><path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z"/></svg>;
    case 'bug':    return <svg {...common}><ellipse cx="12" cy="13" rx="4" ry="6"/><line x1="12" y1="7" x2="12" y2="4"/><line x1="10" y1="5" x2="9" y2="3"/><line x1="14" y1="5" x2="15" y2="3"/><line x1="8" y1="11" x2="5" y2="10"/><line x1="16" y1="11" x2="19" y2="10"/><line x1="8" y1="15" x2="5" y2="17"/><line x1="16" y1="15" x2="19" y2="17"/></svg>;
    case 'mosquito': return <svg {...common}><ellipse cx="12" cy="14" rx="2" ry="4"/><line x1="12" y1="10" x2="12" y2="5"/><path d="M5 8c2 0 5 1 7 3"/><path d="M19 8c-2 0-5 1-7 3"/><line x1="12" y1="18" x2="10" y2="21"/><line x1="12" y1="18" x2="14" y2="21"/></svg>;
    case 'rodent': return <svg {...common}><circle cx="9" cy="7" r="2"/><circle cx="15" cy="7" r="2"/><path d="M5 17c0-3 3-7 7-7s7 4 7 7c0 1-1 2-2 2H7c-1 0-2-1-2-2z"/><path d="M19 18c1 1 2 2 3 3"/></svg>;
    default:       return null;
  }
}

const INTEREST_OPTIONS = [
  { value: 'pest',  label: 'Pest Control',   icon: 'shield' },
  { value: 'lawn',  label: 'Lawn Care',      icon: 'leaf'   },
  { value: 'both',  label: 'Pest + Lawn',    icon: 'home'   },
  { value: 'other', label: 'Other Services', icon: 'chat'   },
];

const OTHER_OPTIONS = [
  { value: 'termite',     label: 'Termite',      icon: 'bug'      },
  { value: 'mosquito',    label: 'Mosquito',     icon: 'mosquito' },
  { value: 'rodent',      label: 'Rodent',       icon: 'rodent'   },
  { value: 'flea',        label: 'Flea',         icon: 'bug'      },
  { value: 'cockroach',   label: 'Cockroach',    icon: 'bug'      },
  { value: 'bed_bug',     label: 'Bed Bug',      icon: 'bug'      },
  { value: 'dethatching', label: 'Dethatching',  icon: 'leaf'     },
  { value: 'top_dressing', label: 'Top Dressing', icon: 'leaf'    },
  { value: 'overseeding', label: 'Overseeding',  icon: 'leaf'     },
];

const SERVICE_LANDING_CONFIGS = {
  mosquito: {
    title: 'Get a Mosquito Control Estimate.',
    subtitle: 'Monthly yard treatments for mosquitoes, fleas, ticks, and no-see-ums around the places you actually use.',
    leftTitle: 'Take Your Yard Back.',
    leftSubtitle: 'Tell us where you need service and a Waves specialist will price the right mosquito plan for your property.',
    interest: 'other',
    otherService: 'mosquito',
    startKey: 'name',
  },
  termite: {
    title: 'Get a Termite Estimate.',
    subtitle: 'Treatment and protection quotes for active termite concerns, inspections, and long-term prevention.',
    leftTitle: 'Protect the Structure First.',
    leftSubtitle: 'Send the basics and a Waves specialist will match the right termite option to the property.',
    interest: 'other',
    otherService: 'termite',
    startKey: 'name',
  },
  lawn: {
    title: 'Get a Lawn Care Estimate in 60 Seconds.',
    subtitle: 'Fertilization, weed control, and seasonal treatments built for Southwest Florida lawns.',
    leftTitle: 'A Healthier Lawn Without Guesswork.',
    leftSubtitle: 'We measure your property, confirm your grass type, and price the right recurring lawn plan.',
    interest: 'lawn',
    startKey: 'frequency',
  },
  flea: {
    title: 'Get a Flea Control Estimate.',
    subtitle: 'Targeted service for flea pressure indoors, outdoors, and around pets.',
    leftTitle: 'Stop the Flea Cycle.',
    leftSubtitle: 'Send your property details and a Waves specialist will quote the right treatment plan.',
    interest: 'other',
    otherService: 'flea',
    startKey: 'name',
  },
  cockroach: {
    title: 'Get a Cockroach Control Estimate.',
    subtitle: 'Treatment plans for roach activity inside, outside, kitchens, garages, and entry points.',
    leftTitle: 'Fast Roach Control, Done Properly.',
    leftSubtitle: 'Tell us where the activity is and a Waves specialist will price the right treatment.',
    interest: 'other',
    otherService: 'cockroach',
    startKey: 'name',
  },
  'bed-bug': {
    title: 'Get a Bed Bug Estimate.',
    subtitle: 'Inspection-led bed bug quotes for bedrooms, furniture, rentals, and urgent treatment needs.',
    leftTitle: 'Handle Bed Bugs Quickly.',
    leftSubtitle: 'Share the basics and a Waves specialist will follow up with the next step and pricing.',
    interest: 'other',
    otherService: 'bed_bug',
    startKey: 'name',
  },
  dethatching: {
    title: 'Get a Dethatching Estimate.',
    subtitle: 'Lawn dethatching quotes for thick thatch, weak growth, and turf recovery.',
    leftTitle: 'Give Your Lawn Room to Breathe.',
    leftSubtitle: 'Send the property details and we will quote the right dethatching approach for the turf.',
    interest: 'other',
    otherService: 'dethatching',
    startKey: 'name',
  },
  'top-dressing': {
    title: 'Get a Top Dressing Estimate.',
    subtitle: 'Top dressing quotes to improve soil contact, smooth uneven areas, and support turf recovery.',
    leftTitle: 'Improve the Lawn From the Soil Up.',
    leftSubtitle: 'Tell us where you need work and a Waves specialist will quote the right top dressing plan.',
    interest: 'other',
    otherService: 'top_dressing',
    startKey: 'name',
  },
  overseeding: {
    title: 'Get an Overseeding Estimate.',
    subtitle: 'Seasonal overseeding quotes for fuller turf and better lawn recovery.',
    leftTitle: 'Fill In Thin Turf.',
    leftSubtitle: 'Share the property details and we will quote the right overseeding plan for your lawn.',
    interest: 'other',
    otherService: 'overseeding',
    startKey: 'name',
  },
};
SERVICE_LANDING_CONFIGS.dehatching = SERVICE_LANDING_CONFIGS.dethatching;

function createInitialIntake(serviceConfig) {
  return {
    interest: serviceConfig?.interest || '',
    frequency: serviceConfig?.frequency || '',
    otherService: serviceConfig?.otherService || '',
    name: '',
    email: '',
    phone: '',
    address: '',
  };
}

function initialIndexFor(serviceConfig) {
  if (!serviceConfig?.startKey) return 0;
  const steps = serviceConfig.interest === 'other' ? STEPS_OTHER : STEPS_PRICED;
  return Math.max(0, steps.indexOf(serviceConfig.startKey));
}

const FREQUENCY_OPTIONS = [
  { value: 'ongoing',  label: 'Ongoing Service', icon: 'repeat' },
  { value: 'one-time', label: 'One-Time',        icon: 'one'    },
  { value: 'not-sure', label: 'Not Sure Yet',    icon: 'help'   },
];

const PEST_FREQS = [
  { id: 'quarterly', label: 'Quarterly', sub: 'Most popular' },
  { id: 'bimonthly', label: 'Bi-Monthly', sub: 'Heavy pressure areas' },
  { id: 'monthly',   label: 'Monthly',    sub: 'Restaurants / pet-heavy' },
];

const GRASS_TYPES = [
  { id: 'st_augustine', label: 'St. Augustine' },
  { id: 'bahia',        label: 'Bahia' },
  { id: 'bermuda',      label: 'Bermuda' },
  { id: 'zoysia',       label: 'Zoysia' },
];

// Upsell catalog — IDs must match UPSELL_LABELS in server/routes/public-quote.js.
// Specialist quotes these on the confirmation call, so no price shown here.
const UPSELL_OPTIONS = {
  mosquito:     { title: 'Mosquito & No-See-Um Control', desc: 'Monthly yard treatments so you can use your lanai again. Covers mosquitoes, fleas, ticks.' },
  lawn_care:    { title: 'Lawn Care',                    desc: 'Fertilization, weed control, and seasonal treatments dialed in for your grass type.' },
  pest_control: { title: 'Pest Control',                 desc: 'Inside + outside every visit. 30+ pests covered with our money-back guarantee.' },
  tree_shrub:   { title: 'Tree & Shrub Care',            desc: 'Feed and protect your landscape — fertilizer, fungicide, and pest defense for ornamentals.' },
  termite:      { title: 'Termite Protection',           desc: 'Annual termite monitoring and guarantee — protect your biggest asset.' },
};

function getUpsellRecs(svcPest, svcLawn) {
  if (svcPest && svcLawn) return ['mosquito'];
  if (svcPest)            return ['lawn_care'];
  if (svcLawn)            return ['pest_control'];
  return ['pest_control'];
}

const STEPS_PRICED = ['interest', 'frequency',    'name', 'email', 'phone', 'address'];
const STEPS_OTHER  = ['interest', 'otherService', 'name', 'email', 'phone', 'address'];
const TOTAL_STAGES_PRICED = STEPS_PRICED.length + 3; // + lookup + confirm + result
const TOTAL_STAGES_OTHER  = STEPS_OTHER.length  + 1; // + result-other

const NEXT_STEPS = [
  { n: 1, text: <><strong>You tell us who you are</strong> — takes about 30 seconds</> },
  { n: 2, text: <><strong>We measure your property</strong> — lot size, landscape, and complexity from satellite</> },
  { n: 3, text: <><strong>We generate your price</strong> — instant, honest, no haggling</> },
  { n: 4, text: <><strong>A Waves specialist confirms</strong> — text or call to lock it in same-day</> },
];

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const SWFL_GEOCODE_BOUNDS = {
  north: 27.95,
  south: 26.75,
  east: -81.75,
  west: -83.05,
};

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

function splitName(full) {
  const parts = (full || '').trim().split(/\s+/);
  if (parts.length < 2) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function addressPartsFromGoogleResult(result, fallback = '') {
  const components = result?.address_components || [];
  const get = (type) => components.find(c => c.types.includes(type))?.long_name || '';
  const getShort = (type) => components.find(c => c.types.includes(type))?.short_name || '';
  const line1 = [get('street_number'), get('route')].filter(Boolean).join(' ');
  return {
    formatted: result?.formatted_address || fallback,
    line1,
    city: get('locality') || get('sublocality') || get('postal_town'),
    state: getShort('administrative_area_level_1') || 'FL',
    zip: get('postal_code'),
    lat: result?.geometry?.location?.lat?.() ?? null,
    lng: result?.geometry?.location?.lng?.() ?? null,
  };
}

function formatPhoneDigits(d) {
  if (!d) return '';
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function QuotePage({ serviceSlug = '' }) {
  const normalizedServiceSlug = String(serviceSlug || '').toLowerCase();
  const serviceConfig = SERVICE_LANDING_CONFIGS[normalizedServiceSlug] || null;
  const startingIntake = createInitialIntake(serviceConfig);
  const minIntakeIdx = initialIndexFor(serviceConfig);

  const [stage, setStage] = useState('intake'); // intake | lookup | confirm | result
  const [intakeIdx, setIntakeIdx] = useState(minIntakeIdx);
  const [dir, setDir] = useState('next');
  const [intake, setIntake] = useState(startingIntake);
  const [address, setAddress] = useState({ formatted: '', line1: '', city: '', state: 'FL', zip: '' });

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [lookupStatus, setLookupStatus] = useState('');
  const [lookupSub, setLookupSub] = useState('');
  const [leadId, setLeadId] = useState(null);
  const [enriched, setEnriched] = useState(null);
  const [satellite, setSatellite] = useState(null);
  const [aiSources, setAiSources] = useState(null);

  const [svcPest, setSvcPest] = useState(false);
  const [svcLawn, setSvcLawn] = useState(false);
  const [pestFreq, setPestFreq] = useState('quarterly');
  const [grassType, setGrassType] = useState('st_augustine');
  const [homeSqFt, setHomeSqFt] = useState('');
  const [lotSqFt, setLotSqFt] = useState('');

  const [result, setResult] = useState(null);
  const [attribution] = useState(() => captureAttribution());

  const [upsellSelected, setUpsellSelected] = useState({});
  const [upsellLoading, setUpsellLoading] = useState(false);
  const [upsellError, setUpsellError] = useState('');

  // Newsletter opt-in — default unchecked. Only dual-writes to SendGrid when
  // user explicitly consents. The beehiiv lead drip is separate (see
  // server/routes/public-quote.js); this controls the ongoing newsletter only.
  const [newsletterOptIn, setNewsletterOptIn] = useState(false);

  // Deferred-subscribe CTA — shown on the non-priced result page (one-time /
  // not-sure / termite / mosquito / rodent). Those flows bypass /calculate so
  // the checkbox never rendered; this is the self-serve opt-in for users who
  // landed on result-other and still want the newsletter. One-click because
  // intake.email is already captured from the form they just submitted.
  const [subscribeStatus, setSubscribeStatus] = useState('idle'); // idle | loading | success | error

  // Addons variant is URL-gated so the original /estimate flow stays untouched
  // for all traffic except explicit opt-ins (/estimate?addons=1). Locked at mount.
  const [showUpsell] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return new URLSearchParams(window.location.search).get('addons') === '1'; }
    catch { return false; }
  });

  const inputRef = useRef(null);
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    setStage('intake');
    setIntakeIdx(minIntakeIdx);
    setIntake(createInitialIntake(serviceConfig));
    setAddress({ formatted: '', line1: '', city: '', state: 'FL', zip: '' });
    setResult(null);
    setError('');
    setLookupStatus(''); setLookupSub('');
    setLeadId(null); setEnriched(null); setSatellite(null); setAiSources(null);
    setSvcPest(false); setSvcLawn(false);
    setHomeSqFt(''); setLotSqFt('');
    setUpsellSelected({}); setUpsellLoading(false); setUpsellError('');
    setNewsletterOptIn(false);
    setSubscribeStatus('idle');
  }, [normalizedServiceSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!serviceConfig) {
      document.title = 'Waves — Customer Portal';
      return;
    }
    document.title = `${serviceConfig.title.replace(/\.$/, '')} | Waves Pest Control`;
  }, [serviceConfig]);

  // Step list + total stages depend on whether the user picked "other".
  const isOtherFlow = intake.interest === 'other';
  const INTAKE_STEPS = isOtherFlow ? STEPS_OTHER : STEPS_PRICED;
  const TOTAL_STAGES = isOtherFlow ? TOTAL_STAGES_OTHER : TOTAL_STAGES_PRICED;
  const currentKey = INTAKE_STEPS[intakeIdx];

  useEffect(() => {
    if (stage !== 'intake') return;
    if (currentKey !== 'interest' && currentKey !== 'frequency' && currentKey !== 'otherService' && currentKey !== 'address') {
      inputRef.current?.focus();
    }
  }, [stage, intakeIdx, currentKey]);

  function setIntakeField(key, value) {
    setIntake(prev => ({ ...prev, [key]: value }));
  }

  function applyAddressParts(parts) {
    const formatted = parts.formatted || parts.line1 || intake.address;
    setIntakeField('address', formatted);
    setAddress({
      formatted,
      line1: parts.line1 || formatted,
      city: parts.city || '',
      state: parts.state || 'FL',
      zip: parts.zip || '',
    });
  }

  async function resolveAddressForSubmit() {
    const typed = (address.formatted || intake.address || '').trim();
    if (!typed) return address;
    if ((address.city || address.zip) && address.formatted) return address;
    if (!window.google?.maps?.Geocoder) {
      return { ...address, formatted: typed, line1: address.line1 || typed };
    }

    try {
      const geocoder = new window.google.maps.Geocoder();
      const results = await new Promise((resolve, reject) => {
        geocoder.geocode({
          address: typed,
          bounds: SWFL_GEOCODE_BOUNDS,
          componentRestrictions: { country: 'US', administrativeArea: 'FL' },
        }, (geocodeResults, status) => {
          if (status === 'OK' && geocodeResults?.[0]) resolve(geocodeResults);
          else reject(new Error(status || 'Geocode failed'));
        });
      });
      const parts = addressPartsFromGoogleResult(results[0], typed);
      const next = {
        formatted: parts.formatted || typed,
        line1: parts.line1 || typed,
        city: parts.city || '',
        state: parts.state || 'FL',
        zip: parts.zip || '',
      };
      setIntakeField('address', next.formatted);
      setAddress(next);
      return next;
    } catch {
      return { ...address, formatted: typed, line1: address.line1 || typed };
    }
  }

  function validateCurrent() {
    const v = (intake[currentKey] || '').trim();
    if (currentKey === 'interest' && !v) return 'Pick what we can help with.';
    if (currentKey === 'frequency' && !v) return 'Pick a frequency.';
    if (currentKey === 'otherService' && !v) return 'Pick which service you need.';
    if (currentKey === 'name') {
      const parts = v.split(/\s+/);
      if (parts.length < 2 || !parts[0] || !parts[1]) return 'Enter your first and last name.';
    }
    if (currentKey === 'email' && !/^\S+@\S+\.\S+$/.test(v)) return 'Enter a valid email.';
    if (currentKey === 'phone' && v.replace(/\D/g, '').length !== 10) return 'Enter a 10-digit phone number.';
    if (currentKey === 'address' && v.length < 5) return 'Enter your address.';
    return '';
  }

  function advance() {
    const err = validateCurrent();
    if (err) { setError(err); return; }
    setError('');
    setDir('next');
    if (intakeIdx < INTAKE_STEPS.length - 1) setIntakeIdx(i => i + 1);
    else submitIntake();
  }

  function pickTile(key, value) {
    // Picking "other" on the interest tile flips the step list; recompute length
    // off the post-pick value so we advance past `interest` into `otherService`.
    const nextSteps = (key === 'interest' ? value === 'other' : isOtherFlow) ? STEPS_OTHER : STEPS_PRICED;
    setIntakeField(key, value);
    setError('');
    setDir('next');
    setTimeout(() => {
      if (intakeIdx < nextSteps.length - 1) setIntakeIdx(i => i + 1);
      else submitIntake();
    }, 180);
  }

  function goBack() {
    setError('');
    setDir('prev');
    if (intakeIdx > minIntakeIdx) setIntakeIdx(i => i - 1);
  }

  async function submitIntake() {
    setError('');
    if (isOtherFlow) { return submitOther(); }
    // Only "ongoing" gets priced. One-time and not-sure both divert to
    // /api/leads — one-time needs site-visit triage, not-sure needs a
    // consultation. lead-webhook handles business-hours call / after-hours SMS.
    if (intake.frequency !== 'ongoing') { return submitOneTime(); }
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setLoading(true);
    const { firstName, lastName } = splitName(intake.name);
    const phoneDigits = intake.phone.replace(/\D/g, '');
    try {
      const resolvedAddress = await resolveAddressForSubmit();

      setStage('lookup');
      setLookupStatus('Measuring your property');
      setLookupSub('Checking lot size, landscape, and complexity...');
      const r = await fetch(`${API_BASE}/public/estimator/property-lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          lastName,
          email: intake.email.trim(),
          phone: phoneDigits,
          address: resolvedAddress.formatted || intake.address,
          attribution: attribution || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Lookup failed.');
      setLeadId(d.lead_id || null);
      setEnriched(d.enriched || null);
      setSatellite(d.satellite || null);
      setAiSources(d.aiAnalysis?.sources || null);
      // Always seed the confirm step with a real value — the input's placeholder
      // is easy to mistake for a prefilled value, and the user gets a "min 500"
      // error on submit. Defaults are SWFL median-ish and editable.
      setHomeSqFt(d.enriched?.homeSqFt ? String(d.enriched.homeSqFt) : '2000');
      setLotSqFt(d.enriched?.lotSqFt   ? String(d.enriched.lotSqFt)   : '8000');
      setSvcPest(intake.interest === 'pest' || intake.interest === 'both');
      setSvcLawn(intake.interest === 'lawn' || intake.interest === 'both');
      setPestFreq('quarterly');
      setLookupStatus('Property measured');
      setLookupSub('');
      setStage('confirm');
    } catch (e) {
      setError(e.message || 'Lookup failed.');
      setStage('intake');
      setIntakeIdx(INTAKE_STEPS.length - 1);
    } finally {
      submitInFlightRef.current = false;
      setLoading(false);
    }
  }

  // Termite/Mosquito/Rodent skip the public pricing engine (it doesn't price
  // them) and route to lead capture so a Waves specialist can quote by hand.
  async function submitOther() {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setError('');
    setLoading(true);
    try {
      const { firstName, lastName } = splitName(intake.name);
      const phoneDigits = intake.phone.replace(/\D/g, '');
      const otherLabel = OTHER_OPTIONS.find(o => o.value === intake.otherService)?.label || intake.otherService;
      const resolvedAddress = await resolveAddressForSubmit();
      const res = await fetch(`${API_BASE}/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: intake.name,
          firstName,
          lastName,
          email: intake.email.trim(),
          phone: phoneDigits,
          address: resolvedAddress.formatted || intake.address,
          interest: 'other',
          otherService: intake.otherService,
          service_interest: otherLabel,
          source: normalizedServiceSlug ? `quote-page-${normalizedServiceSlug}` : 'quote-page-divert',
          attribution: attribution || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStage('result-other');
    } catch (e) {
      setError(e?.message || 'Could not send your request. Please call us.');
    } finally {
      submitInFlightRef.current = false;
      setLoading(false);
    }
  }

  // Non-ongoing quote requests (one-time OR not-sure) skip the pricing engine
  // and route to /api/leads so lead-webhook handles the business-hours admin
  // call / after-hours SMS. Reuses the result-other success stage.
  async function submitOneTime() {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setError('');
    setLoading(true);
    try {
      const { firstName, lastName } = splitName(intake.name);
      const phoneDigits = intake.phone.replace(/\D/g, '');
      const resolvedAddress = await resolveAddressForSubmit();
      const interestLabel = intake.interest === 'pest' ? 'Pest Control'
        : intake.interest === 'lawn' ? 'Lawn Care'
        : 'Pest Control & Lawn Care';
      const freqSuffix = intake.frequency === 'one-time' ? 'One-Time' : 'Consult';
      const res = await fetch(`${API_BASE}/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: intake.name,
          firstName,
          lastName,
          email: intake.email.trim(),
          phone: phoneDigits,
          address: resolvedAddress.formatted || intake.address,
          interest: intake.interest,
          frequency: intake.frequency,
          service_interest: `${interestLabel} (${freqSuffix})`,
          source: `quote-page-${intake.frequency}`,
          attribution: attribution || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStage('result-other');
    } catch (e) {
      setError(e?.message || 'Could not send your request. Please call us.');
    } finally {
      submitInFlightRef.current = false;
      setLoading(false);
    }
  }

  // Deferred newsletter subscribe from the result-other page. Email already
  // lives in intake state, so this is a one-click POST — no re-entry, no
  // separate page. Mirrors the SendGrid dual-write pattern in /calculate but
  // goes through the public newsletter endpoint (no beehiiv drip here — that
  // would double-enroll anyone who already got hit by the lead-webhook drip).
  async function handleDeferredSubscribe() {
    if (subscribeStatus === 'loading' || subscribeStatus === 'success') return;
    setSubscribeStatus('loading');
    try {
      const { firstName, lastName } = splitName(intake.name);
      const res = await fetch(`${API_BASE}/public/newsletter/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: intake.email.trim(),
          firstName, lastName,
          source: 'quote_wizard_deferred',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSubscribeStatus('success');
    } catch {
      setSubscribeStatus('error');
    }
  }

  async function generateQuote() {
    setError('');
    if (!svcPest && !svcLawn) { setError('Pick at least one service.'); return; }
    const sq = Number(homeSqFt);
    if (!sq || sq < 500) { setError('Confirm your home square footage (min 500).'); return; }

    setLoading(true);
    try {
      const { firstName, lastName } = splitName(intake.name);
      const r = await fetch(`${API_BASE}/public/quote/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: leadId || undefined,
          firstName,
          lastName,
          email: intake.email,
          phone: intake.phone.replace(/\D/g, ''),
          address: address.line1 || address.formatted || intake.address,
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
          newsletter_opt_in: newsletterOptIn,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not calculate.');
      setResult(d);
      setStage(showUpsell ? 'upsell' : 'result');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function resetAll() {
    setStage('intake');
    setIntakeIdx(minIntakeIdx);
    setIntake(createInitialIntake(serviceConfig));
    setAddress({ formatted: '', line1: '', city: '', state: 'FL', zip: '' });
    setResult(null);
    setError('');
    setLookupStatus(''); setLookupSub('');
    setLeadId(null); setEnriched(null); setSatellite(null); setAiSources(null);
    setSvcPest(false); setSvcLawn(false);
    setHomeSqFt(''); setLotSqFt('');
    setUpsellSelected({}); setUpsellLoading(false); setUpsellError('');
    setNewsletterOptIn(false);
    setSubscribeStatus('idle');
  }

  async function submitUpsell() {
    const selected = Object.keys(upsellSelected).filter(k => upsellSelected[k]);
    // Skip path: nothing checked, advance to result without a network round-trip.
    if (selected.length === 0 || !result?.lead_id) {
      setStage('result');
      return;
    }
    setUpsellError('');
    setUpsellLoading(true);
    try {
      const r = await fetch(`${API_BASE}/public/quote/upsell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: result.lead_id,
          email: intake.email,
          addOns: selected,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not add to your plan.');
      // Merge server's canonical service_interest so the result screen reflects
      // the plan the customer just confirmed, not the pre-upsell snapshot.
      if (d.service_interest) {
        setResult(prev => prev ? { ...prev, service_interest: d.service_interest } : prev);
      }
      setStage('result');
    } catch (e) {
      setUpsellError(e.message || 'Could not add to your plan.');
    } finally {
      setUpsellLoading(false);
    }
  }

  // ───── Progress ─────
  // When the addons flag is on the priced flow gains one extra stage (upsell),
  // pushing TOTAL_STAGES from +3 to +4 past INTAKE_STEPS.
  const totalStagesAdjusted = (!isOtherFlow && showUpsell) ? TOTAL_STAGES + 1 : TOTAL_STAGES;
  let progressStep = 0;
  if (stage === 'intake')       progressStep = intakeIdx + 1;
  if (stage === 'lookup')       progressStep = INTAKE_STEPS.length + 1;
  if (stage === 'confirm')      progressStep = INTAKE_STEPS.length + 2;
  if (stage === 'upsell')       progressStep = INTAKE_STEPS.length + 3;
  if (stage === 'result')       progressStep = totalStagesAdjusted;
  if (stage === 'result-other') progressStep = totalStagesAdjusted;
  const progress = (progressStep / totalStagesAdjusted) * 100;

  // ───── Styles ─────
  const sPage = { minHeight: '100vh', background: COLORS.white, fontFamily: FONTS.body, color: COLORS.navy, display: 'flex', flexDirection: 'column' };
  const sHero = { position: 'relative', background: COLORS.blueDeeper, color: COLORS.white, padding: 'clamp(64px, 8vw, 112px) 24px', textAlign: 'center', overflow: 'hidden' };
  const sHeroOverlay = { position: 'absolute', inset: 0, background: `linear-gradient(135deg, ${COLORS.blueDeeper}E6 0%, ${COLORS.blueDark}B3 55%, ${COLORS.wavesBlue}80 100%)`, pointerEvents: 'none' };
  const sH1 = { fontFamily: FONTS.display, fontSize: 'clamp(36px, 6vw, 60px)', fontWeight: 400, lineHeight: 1.05, letterSpacing: '0.02em', margin: '0 0 16px', color: COLORS.white };
  const sHeroSub = { fontSize: 'clamp(16px, 2vw, 20px)', lineHeight: 1.55, margin: '0 auto 24px', maxWidth: 640, color: COLORS.white };

  const sFormSection = { background: COLORS.wavesBlue, padding: 'clamp(56px, 7vw, 96px) 24px' };
  const sFormWrap = { maxWidth: 1120, margin: '0 auto', display: 'grid', gap: 48, gridTemplateColumns: '1fr', alignItems: 'start' };
  const sLeft = { color: COLORS.white };
  const sLeftH2 = { fontFamily: FONTS.display, fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 400, lineHeight: 1.1, letterSpacing: '0.02em', margin: '0 0 12px', color: COLORS.white };
  const sLeftSub = { fontFamily: FONTS.body, fontSize: 18, lineHeight: 1.55, margin: '0 0 28px', color: COLORS.white, opacity: 0.95 };
  const sLeftH3 = { fontFamily: FONTS.display, fontSize: 22, fontWeight: 400, letterSpacing: '0.02em', margin: '0 0 16px', color: COLORS.white };
  const sStepBadge = { flexShrink: 0, width: 32, height: 32, borderRadius: 9999, background: COLORS.yellow, color: COLORS.blueDeeper, fontFamily: FONTS.ui, fontWeight: 800, fontSize: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };

  const sCard = { background: COLORS.white, borderRadius: 16, padding: 'clamp(24px, 3vw, 40px)', boxShadow: SHADOWS.goldRing, minHeight: 420 };
  const sLabel = { display: 'block', fontFamily: FONTS.ui, fontSize: 15, fontWeight: 600, color: COLORS.navy, marginBottom: 8 };
  const sInput = { width: '100%', padding: '14px 16px', border: `1.5px solid ${COLORS.grayLight}`, borderRadius: 12, fontSize: 16, fontFamily: FONTS.body, color: COLORS.navy, boxSizing: 'border-box', background: COLORS.white, outline: 'none', minHeight: 52 };
  const sChip = (on) => ({
    padding: '14px 18px', borderRadius: 12,
    border: `2px solid ${on ? COLORS.wavesBlue : COLORS.slate200}`,
    background: on ? COLORS.blueLight : COLORS.white,
    cursor: 'pointer', fontFamily: FONTS.body, fontSize: 15,
    fontWeight: on ? 700 : 500,
    color: on ? COLORS.blueDeeper : COLORS.textBody,
    textAlign: 'left', display: 'block', width: '100%',
    transition: 'transform 0.15s cubic-bezier(0.4,0,0.2,1), background 0.15s, border-color 0.15s',
  });
  const sTile = (on) => ({
    padding: '16px 12px', borderRadius: 14,
    border: `2px solid ${on ? COLORS.wavesBlue : COLORS.slate200}`,
    background: on ? COLORS.blueLight : COLORS.white,
    cursor: 'pointer', fontFamily: FONTS.body, fontSize: 14, fontWeight: 700,
    color: on ? COLORS.blueDeeper : COLORS.textBody,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    minHeight: 110, width: '100%',
    transition: 'transform 0.15s cubic-bezier(0.4,0,0.2,1), background 0.15s, border-color 0.15s',
  });
  const sCardH2 = { fontFamily: FONTS.heading, fontSize: 26, fontWeight: 700, color: COLORS.blueDeeper, margin: '0 0 8px', lineHeight: 1.2 };
  const sCardSub = { fontFamily: FONTS.body, fontSize: 16, color: COLORS.textBody, margin: '0 0 22px', lineHeight: 1.55 };
  const sError = { marginTop: 14, padding: 12, background: '#FEE2E2', color: COLORS.red, borderRadius: 10, fontSize: 14, fontFamily: FONTS.body };

  return (
    <div style={sPage}>
      <style>{`
        @keyframes qp-spin { to { transform: rotate(360deg); } }
        @keyframes qp-slideInRight { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes qp-slideInLeft  { from { opacity: 0; transform: translateX(-24px); } to { opacity: 1; transform: translateX(0); } }
        @media (min-width: 900px) {
          .qp-form-grid { grid-template-columns: 1fr 1fr !important; gap: 64px !important; }
        }
        .qp-chip:hover, .qp-tile:hover { transform: scale(1.02); }
      `}</style>

      <section style={sHero}>
        <div style={sHeroOverlay} aria-hidden />
        <div style={{ position: 'relative', maxWidth: 880, margin: '0 auto' }}>
          <h1 style={sH1}>{serviceConfig?.title || 'Get a Free Quote in 60 Seconds.'}</h1>
          <p style={sHeroSub}>
            {serviceConfig?.subtitle || "Tell us about your property — we'll analyze it with satellite + records and send a price same-day. Serving Manatee, Sarasota, and Charlotte counties."}
          </p>
          <Button variant="primary" as="a" href="tel:+19412975749" style={{ fontSize: 16 }}>
            Call (941) 297-5749
          </Button>
          <p style={{ fontSize: 14, marginTop: 12, color: COLORS.white, opacity: 0.85 }}>
            Prefer to call? Most quotes go out same-day.
          </p>
        </div>
      </section>

      <section style={sFormSection}>
        <div className="qp-form-grid" style={sFormWrap}>
          <div style={sLeft}>
            <h2 style={sLeftH2}>{serviceConfig?.leftTitle || 'Get Your Price. Keep Your Saturday.'}</h2>
            <p style={sLeftSub}>
              {serviceConfig?.leftSubtitle || "Tell us what's going on. We'll handle the rest — most quotes go out same-day."}
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

          <div style={sCard}>
            <div style={{ height: 6, background: COLORS.offWhite, borderRadius: 4, marginBottom: 22, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progress}%`, background: COLORS.wavesBlue, transition: 'width 0.3s' }} />
            </div>

            {stage === 'intake' && (
              <div
                key={`${stage}-${intakeIdx}`}
                style={{ animation: dir === 'next' ? 'qp-slideInRight 0.3s ease-out' : 'qp-slideInLeft 0.3s ease-out' }}
              >
                {currentKey === 'interest' && (
                  <>
                    <h2 style={sCardH2}>What's Bugging You?</h2>
                    <p style={sCardSub}>30 seconds. No obligation. Most quotes same-day.</p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                      {INTEREST_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          type="button"
                          className="qp-tile"
                          style={sTile(intake.interest === opt.value)}
                          onClick={() => pickTile('interest', opt.value)}
                        >
                          <OptionIcon name={opt.icon} />
                          <span style={{ textAlign: 'center' }}>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {currentKey === 'otherService' && (
                  <>
                    <h2 style={sCardH2}>Which Service Do You Need?</h2>
                    <p style={sCardSub}>These need a quick site visit, so a Waves specialist will quote you direct.</p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                      {OTHER_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          type="button"
                          className="qp-tile"
                          style={sTile(intake.otherService === opt.value)}
                          onClick={() => pickTile('otherService', opt.value)}
                        >
                          <OptionIcon name={opt.icon} />
                          <span style={{ textAlign: 'center' }}>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {currentKey === 'frequency' && (
                  <>
                    <h2 style={sCardH2}>Ongoing or One-Time?</h2>
                    <p style={sCardSub}>Helps us tailor the right plan for your property.</p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                      {FREQUENCY_OPTIONS.map(opt => (
                        <button
                          key={opt.value}
                          type="button"
                          className="qp-tile"
                          style={sTile(intake.frequency === opt.value)}
                          onClick={() => pickTile('frequency', opt.value)}
                        >
                          <OptionIcon name={opt.icon} />
                          <span style={{ textAlign: 'center' }}>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {currentKey === 'name' && (
                  <>
                    <h2 style={sCardH2}>What's Your Name?</h2>
                    <p style={sCardSub}>So we know who to write the estimate for.</p>
                    <label style={sLabel}>Full name</label>
                    <input
                      ref={inputRef}
                      type="text"
                      value={intake.name}
                      onChange={e => setIntakeField('name', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); advance(); } }}
                      placeholder="Your first and last name"
                      autoComplete="name"
                      style={sInput}
                    />
                  </>
                )}

                {currentKey === 'email' && (
                  <>
                    <h2 style={sCardH2}>Best Email?</h2>
                    <p style={sCardSub}>We'll send your quote here same-day.</p>
                    <label style={sLabel}>Email</label>
                    <input
                      ref={inputRef}
                      type="email"
                      value={intake.email}
                      onChange={e => setIntakeField('email', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); advance(); } }}
                      placeholder="you@example.com"
                      autoComplete="email"
                      style={sInput}
                    />
                  </>
                )}

                {currentKey === 'phone' && (
                  <>
                    <h2 style={sCardH2}>Where Can We Reach You?</h2>
                    <p style={sCardSub}>We'll text or call only to confirm your quote.</p>
                    <label style={sLabel}>Mobile phone</label>
                    <input
                      ref={inputRef}
                      type="tel"
                      value={formatPhoneDigits(intake.phone.replace(/\D/g, '').slice(0, 10))}
                      onChange={e => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                        setIntakeField('phone', digits);
                      }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); advance(); } }}
                      placeholder="(941) 555-0100"
                      autoComplete="tel"
                      style={sInput}
                    />
                  </>
                )}

                {currentKey === 'address' && (
                  <>
                    <h2 style={sCardH2}>Property Address</h2>
                    <p style={sCardSub}>Last one — we'll pull records and satellite imagery to build your quote.</p>
                    <label style={sLabel}>Service address</label>
                    <AddressAutocomplete
                      value={intake.address}
                      onChange={(v) => {
                        setIntakeField('address', v);
                        setAddress({ formatted: v, line1: v, city: '', state: 'FL', zip: '' });
                      }}
                      onSelect={applyAddressParts}
                      placeholder="Start typing your address..."
                      style={sInput}
                    />
                  </>
                )}

                {error && <div style={sError}>{error}</div>}

                <div style={{
                  marginTop: 24,
                  display: 'flex',
                  justifyContent: intakeIdx > minIntakeIdx ? 'space-between' : 'flex-end',
                  gap: 12,
                }}>
                  {intakeIdx > minIntakeIdx && (
                    <Button variant="tertiary" onClick={goBack} style={{ textTransform: 'none' }}>← Back</Button>
                  )}
                  {currentKey !== 'interest' && currentKey !== 'frequency' && currentKey !== 'otherService' && (
                    <Button
                      variant="primary"
                      onClick={advance}
                      disabled={loading}
                      style={{ fontSize: 16, textTransform: 'none' }}
                    >
                      {loading ? 'Sending...' : (intakeIdx === INTAKE_STEPS.length - 1 ? (isOtherFlow ? 'Send My Request' : 'Get My Quote') : 'Next →')}
                    </Button>
                  )}
                </div>

                {intakeIdx === INTAKE_STEPS.length - 1 && intake.frequency === 'ongoing' && !isOtherFlow && (
                  <label style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    marginTop: 16, fontSize: 14, color: COLORS.textBody,
                    lineHeight: 1.5, cursor: 'pointer',
                  }}>
                    <input
                      type="checkbox"
                      checked={newsletterOptIn}
                      onChange={(e) => setNewsletterOptIn(e.target.checked)}
                      style={{ marginTop: 3, flexShrink: 0, cursor: 'pointer' }}
                    />
                    <span>
                      Send me Waves' monthly email — seasonal pest pressure alerts,
                      lawn care reminders, local SWFL tips. Unsubscribe anytime.
                    </span>
                  </label>
                )}
                {intakeIdx === INTAKE_STEPS.length - 1 && (
                  <p style={{ fontSize: 12, color: COLORS.textCaption, marginTop: 16, lineHeight: 1.5 }}>
                    By completing this form, you agree to the Waves{' '}
                    <a href="https://wavespestcontrol.com/terms-of-service/" style={{ textDecoration: 'underline', color: 'inherit' }}>Terms of Service</a>
                    {' '}and{' '}
                    <a href="https://wavespestcontrol.com/privacy-policy/" style={{ textDecoration: 'underline', color: 'inherit' }}>Privacy Policy</a>,
                    {' '}and consent to receive automated service notifications and promotional offers via SMS.
                    Consent is not a condition of purchase. Message frequency varies. Msg &amp; data rates may apply.
                    Text HELP for help, STOP to unsubscribe.
                  </p>
                )}
              </div>
            )}

            {stage === 'lookup' && (
              <LookupLoading
                status={lookupStatus}
                sub={lookupSub}
                satellite={satellite}
                aiSources={aiSources}
                address={address.formatted || intake.address}
              />
            )}

            {stage === 'confirm' && (
              <div>
                <h2 style={sCardH2}>Confirm Your Property</h2>
                <p style={sCardSub}>
                  {enriched?.homeSqFt
                    ? <>Looks like a <strong>{Number(enriched.homeSqFt).toLocaleString()} sq ft</strong> {enriched.propertyType || 'home'}{enriched.yearBuilt ? <> built in {enriched.yearBuilt}</> : null}. Confirm the details and pick your services — we'll quote in seconds.</>
                    : <>Confirm your details and pick your services — we'll quote in seconds.</>}
                </p>

                {satellite?.closeUrl && (
                  <div style={{ marginBottom: 16, borderRadius: 12, overflow: 'hidden', border: `1px solid ${COLORS.slate200}` }}>
                    <img
                      src={satellite.closeUrl}
                      alt="Property satellite view"
                      style={{ width: '100%', maxHeight: 220, objectFit: 'cover', objectPosition: 'center', display: 'block' }}
                    />
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
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
                <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
                  <button type="button" className="qp-chip" style={sChip(svcPest)} onClick={() => setSvcPest(!svcPest)}>
                    <div style={{ fontSize: 16 }}>Pest Control</div>
                    <div style={{ fontSize: 14, color: COLORS.textCaption, fontWeight: 500, marginTop: 2 }}>Inside + outside, every visit. 30+ pests covered, money-back guarantee.</div>
                  </button>
                  <button type="button" className="qp-chip" style={sChip(svcLawn)} onClick={() => setSvcLawn(!svcLawn)}>
                    <div style={{ fontSize: 16 }}>Lawn Care</div>
                    <div style={{ fontSize: 14, color: COLORS.textCaption, fontWeight: 500, marginTop: 2 }}>Fertilization, weed control, and seasonal treatments dialed in for your grass type.</div>
                  </button>
                </div>

                {svcPest && intake.frequency !== 'one-time' && (
                  <div style={{ marginBottom: 18 }}>
                    <label style={sLabel}>Pest treatment frequency</label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                      {PEST_FREQS.map(f => (
                        <button key={f.id} type="button" className="qp-chip" style={sChip(pestFreq === f.id)} onClick={() => setPestFreq(f.id)}>
                          <div style={{ fontSize: 14 }}>{f.label}</div>
                          <div style={{ fontSize: 12, color: COLORS.textCaption, fontWeight: 500, marginTop: 2 }}>{f.sub}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {svcLawn && (
                  <div style={{ marginBottom: 18 }}>
                    <label style={sLabel}>Grass type</label>
                    <select style={sInput} value={grassType} onChange={(e) => setGrassType(e.target.value)}>
                      {GRASS_TYPES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                    </select>
                  </div>
                )}

                {error && <div style={sError}>{error}</div>}

                <div style={{ marginTop: 24, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <Button variant="secondary" onClick={resetAll} disabled={loading} style={{ fontSize: 16, textTransform: 'none' }}>Start Over</Button>
                  <Button variant="primary" onClick={generateQuote} disabled={loading} style={{ fontSize: 16, textTransform: 'none' }}>
                    {loading ? 'Calculating...' : 'See My Price'}
                  </Button>
                </div>
              </div>
            )}

            {stage === 'upsell' && result && (
              <div>
                <div style={{ textAlign: 'center', padding: '4px 0 20px' }}>
                  <div style={{ fontSize: 14, color: COLORS.textCaption, fontWeight: 600, marginBottom: 6, fontFamily: FONTS.ui }}>Your price is ready</div>
                  <h2 style={sCardH2}>Level up your plan.</h2>
                  <p style={sCardSub}>Most homes in your area add one of these. Pick what you want and your specialist will include it on your confirmation call.</p>
                </div>

                <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
                  {getUpsellRecs(svcPest, svcLawn).map(id => {
                    const opt = UPSELL_OPTIONS[id];
                    if (!opt) return null;
                    const on = !!upsellSelected[id];
                    return (
                      <button
                        key={id}
                        type="button"
                        className="qp-chip"
                        style={sChip(on)}
                        onClick={() => setUpsellSelected(s => ({ ...s, [id]: !s[id] }))}
                      >
                        <div style={{ fontSize: 16 }}>{opt.title}</div>
                        <div style={{ fontSize: 14, color: COLORS.textCaption, fontWeight: 500, marginTop: 2 }}>{opt.desc}</div>
                      </button>
                    );
                  })}
                </div>

                {upsellError && <div style={sError}>{upsellError}</div>}

                <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
                  <Button variant="primary" onClick={submitUpsell} disabled={upsellLoading} style={{ fontSize: 16, textTransform: 'none' }}>
                    {upsellLoading ? 'Saving...' : (Object.values(upsellSelected).some(Boolean) ? 'Add to my plan →' : 'Continue to my quote →')}
                  </Button>
                  {Object.values(upsellSelected).some(Boolean) && (
                    <Button variant="tertiary" onClick={() => { setUpsellSelected({}); setStage('result'); }} disabled={upsellLoading} style={{ textTransform: 'none' }}>
                      No thanks, just show my price
                    </Button>
                  )}
                </div>
              </div>
            )}

            {stage === 'result' && result && (
              <div>
                <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
                  <div style={{ fontSize: 14, color: COLORS.textCaption, fontWeight: 600 }}>Your Waves Price</div>
                  <div style={{ fontSize: 56, fontWeight: 800, color: COLORS.blueDeeper, fontFamily: FONTS.mono, marginTop: 8, lineHeight: 1 }}>
                    ${Number(result.monthly_total).toLocaleString()}
                    <span style={{ fontSize: 22, fontWeight: 600, color: COLORS.textCaption }}>/mo</span>
                  </div>
                  <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 12 }}>{result.confidence === 'low' ? 'Estimated range' : 'Typical range'}: <strong>${Number(result.variance_low).toLocaleString()} – ${Number(result.variance_high).toLocaleString()}</strong> per month</div>
                  {result.confidence === 'low' && (
                    <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 4, fontStyle: 'italic' }}>We didn't have full satellite data for your property — we'll confirm on-site.</div>
                  )}
                  <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 4 }}>${Number(result.annual_total).toLocaleString()}/yr · {result.service_interest}</div>
                  {result.has_setup_fee && (
                    <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 10, padding: '8px 12px', background: '#FEF3C7', borderRadius: 8, display: 'inline-block' }}>
                      + $99 one-time setup <em style={{ color: COLORS.textCaption }}>(waived with annual prepay)</em>
                    </div>
                  )}
                </div>

                <div style={{ padding: 16, background: '#DCFCE7', borderRadius: 12, color: COLORS.navy, fontSize: 15, lineHeight: 1.55 }}>
                  We already texted your local Waves team. <strong>They'll confirm the final number and book your first visit</strong> — usually within the hour.
                </div>

                <div style={{ marginTop: 12, padding: 14, borderRadius: 12, background: '#FFF8E1', color: COLORS.navy, fontSize: 16, lineHeight: 1.55 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>100% Satisfaction Guarantee</div>
                  <div>If pests return between visits, so do we — free. No contracts, cancel anytime. Licensed &amp; Insured Florida Pest Control Operator.</div>
                </div>

                <div style={{ marginTop: 24, display: 'grid', gap: 12 }}>
                  <Button variant="primary" as="a" href="tel:+19412975749" style={{ fontSize: 16, textAlign: 'center', textDecoration: 'none', textTransform: 'none' }}>Call (941) 297-5749</Button>
                  <Button variant="secondary" onClick={resetAll} style={{ fontSize: 16, textTransform: 'none' }}>Start a New Quote</Button>
                </div>
              </div>
            )}

            {stage === 'result-other' && (() => {
              const firstName = (intake.name || '').trim().split(/\s+/)[0] || '';
              const isNotSure = intake.frequency === 'not-sure';
              const isOneTime = intake.frequency === 'one-time';
              const otherLabel = isOneTime
                ? (intake.interest === 'pest' ? 'One-time pest control'
                   : intake.interest === 'lawn' ? 'One-time lawn treatment'
                   : 'One-time service')
                : (OTHER_OPTIONS.find(o => o.value === intake.otherService)?.label || 'service');
              const body = isNotSure
                ? `Thanks${firstName ? `, ${firstName}` : ''}. Every property is different — a Waves specialist will text or call you shortly to walk through your options and dial in the right plan.`
                : `Thanks${firstName ? `, ${firstName}` : ''}. ${otherLabel} jobs need a quick site visit so we can quote you accurately — a Waves specialist will text or call you shortly to set it up.`;
              return (
                <div>
                  <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 56, height: 56, borderRadius: '50%',
                      background: 'rgba(255, 215, 0, 0.2)', color: COLORS.blueDeeper, marginBottom: 16,
                    }}>
                      <svg width="28" height="28" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <h2 style={sCardH2}>Request Received</h2>
                    <p style={sCardSub}>{body}</p>
                  </div>

                  <div style={{ padding: 16, background: '#DCFCE7', borderRadius: 12, color: COLORS.navy, fontSize: 15, lineHeight: 1.55 }}>
                    No contracts. No call centers. Just a local team that picks up the phone and gets it done.
                  </div>

                  <div style={{ marginTop: 12, padding: 14, borderRadius: 12, background: '#FFF8E1', color: COLORS.navy, fontSize: 16, lineHeight: 1.55 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>100% Satisfaction Guarantee</div>
                    <div>If the fix doesn't hold, we come back — free. Licensed &amp; Insured Florida Pest Control Operator.</div>
                  </div>

                  {intake.email && (
                    <div style={{
                      marginTop: 12, padding: 14, borderRadius: 12,
                      background: COLORS.blueSurface, border: `1px solid ${COLORS.slate200}`,
                      color: COLORS.navy, fontSize: 16, lineHeight: 1.55,
                    }}>
                      {subscribeStatus === 'success' ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <svg width="16" height="16" fill="none" stroke={COLORS.green} strokeWidth={3} viewBox="0 0 24 24" aria-hidden>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          <span>Subscribed — watch for the next issue in your inbox.</span>
                        </div>
                      ) : (
                        <>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>Not ready to book? Get SWFL pest &amp; lawn tips monthly.</div>
                          <div style={{ fontSize: 14, color: COLORS.textBody, marginBottom: 10 }}>
                            Seasonal pressure alerts, timing advice, local SWFL guidance. No sales pitches.
                          </div>
                          <button
                            type="button"
                            onClick={handleDeferredSubscribe}
                            disabled={subscribeStatus === 'loading'}
                            style={{
                              padding: '6px 14px', fontSize: 14, fontWeight: 600,
                              background: 'transparent', color: COLORS.blueDeeper,
                              border: `1.5px solid ${COLORS.blueDeeper}`, borderRadius: 6,
                              cursor: subscribeStatus === 'loading' ? 'default' : 'pointer',
                              opacity: subscribeStatus === 'loading' ? 0.6 : 1,
                              fontFamily: FONTS.ui,
                            }}
                          >
                            {subscribeStatus === 'loading' ? 'Subscribing…' : 'Subscribe →'}
                          </button>
                          {subscribeStatus === 'error' && (
                            <div style={{ fontSize: 12, color: COLORS.red, marginTop: 6 }}>
                              Couldn't subscribe — try again or email contact@wavespestcontrol.com
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  <div style={{ marginTop: 24, display: 'grid', gap: 12 }}>
                    <Button variant="primary" as="a" href="tel:+19412975749" style={{ fontSize: 16, textAlign: 'center', textDecoration: 'none', textTransform: 'none' }}>Call (941) 297-5749</Button>
                    <Button variant="secondary" onClick={resetAll} style={{ fontSize: 16, textTransform: 'none' }}>Start a New Request</Button>
                  </div>
                </div>
              );
            })()}
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
      <div style={{ fontSize: 14, color: COLORS.textCaption, fontWeight: 600, marginBottom: 6, fontFamily: FONTS.ui }}>Property Lookup</div>
      <h2 style={{ margin: '0 0 8px', fontFamily: FONTS.heading, fontSize: 24, fontWeight: 700, color: COLORS.blueDeeper, lineHeight: 1.2 }}>
        {status || 'Measuring your property'}{dots}
      </h2>
      {sub && <div style={{ fontSize: 15, color: COLORS.textBody, marginBottom: 20 }}>{sub}</div>}
      <div style={{ fontSize: 14, color: COLORS.textCaption, marginBottom: 20 }}>{address}</div>

      <div style={{ width: 80, height: 80, margin: '24px auto', borderRadius: '50%', border: `4px solid ${COLORS.offWhite}`, borderTopColor: COLORS.wavesBlue, animation: 'qp-spin 0.9s linear infinite' }} />

      {satellite?.closeUrl && (
        <div style={{ marginTop: 16, borderRadius: 12, overflow: 'hidden', border: `1px solid ${COLORS.slate200}` }}>
          <img
            src={satellite.closeUrl}
            alt="Property satellite view"
            style={{ width: '100%', maxHeight: 220, objectFit: 'cover', objectPosition: 'center', display: 'block' }}
          />
        </div>
      )}
      {aiSources && (
        <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 12 }}>
          AI sources: {aiSources.join(' + ')}
        </div>
      )}
    </div>
  );
}
