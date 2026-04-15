import React, { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext, Component } from 'react';
import { calculateEstimate, fmt, fmtInt } from '../../lib/estimateEngine';
import { LeadsSection } from './LeadsTabs';
import PricingLogicPanel from '../../components/admin/PricingLogicPanel';
import ESTIMATE_PRESETS, { ALL_SVC_KEYS } from '../../config/estimate-presets';

class EstimateErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[EstimatePage crash]', error, info.componentStack); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, background: '#FFFFFF', border: '1px solid #C0392B', borderRadius: 12, textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#C0392B', marginBottom: 12 }}>Estimate Render Error</div>
          <div style={{ fontSize: 13, color: '#64748B', marginBottom: 16, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'pre-wrap', textAlign: 'left', maxHeight: 200, overflow: 'auto' }}>{this.state.error.message}{'\n'}{this.state.error.stack}</div>
          <button onClick={() => this.setState({ error: null })} style={{ padding: '8px 20px', background: '#0A7EC2', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}>Try Again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── theme tokens ───────────────────────────────────────────── */
const C = {
  dark: '#F1F5F9',
  navy: '#F0F7FC',
  card: '#FFFFFF',
  border: '#E2E8F0',
  teal: '#0A7EC2',
  green: '#16A34A',
  amber: '#F0A500',
  red: '#C0392B',
  blue: '#2563eb',
  white: '#334155',
  gray: '#64748B',
  input: '#FFFFFF',
  heading: '#0F172A',
  inputBorder: '#CBD5E1',
  radius: '10px',
};

/* ── inline style helpers ───────────────────────────────────── */
const sPanel = { background: C.card, border: `1px solid ${C.border}`, borderRadius: C.radius, padding: 22, marginBottom: 18 };
const sPanelTitle = { fontSize: 15, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: C.teal, marginBottom: 18, paddingBottom: 10, borderBottom: `1px solid ${C.border}` };
const sLabel = { display: 'block', fontSize: 13, fontWeight: 600, color: C.gray, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 };
const sInput = { width: '100%', padding: '12px 14px', background: C.input, border: `1px solid ${C.inputBorder}`, borderRadius: C.radius, color: C.heading, fontFamily: "'DM Sans', sans-serif", fontSize: 16, minHeight: 46, boxSizing: 'border-box', outline: 'none' };
const sSelect = { ...sInput, cursor: 'pointer', WebkitAppearance: 'none', appearance: 'none', backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 14px center', paddingRight: 36 };
const sField = { marginBottom: 16 };
const sRow = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 };
const sRow3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 };
const sCheckbox = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, cursor: 'pointer', fontSize: 15, color: C.heading };
const sCb = { width: 20, height: 20, accentColor: C.teal, cursor: 'pointer', flexShrink: 0 };
const sSvcSection = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.2, color: C.amber, margin: '18px 0 10px 0', paddingBottom: 6, borderBottom: `1px solid rgba(245,158,11,0.2)` };
const sSubOpts = { margin: '6px 0 10px 30px', padding: '10px 14px', background: C.input, borderRadius: 8, border: `1px solid ${C.border}` };
const sBtn = (bg, fg) => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '14px 28px', border: 'none', borderRadius: C.radius, fontFamily: "'DM Sans', sans-serif", fontSize: 16, fontWeight: 700, cursor: 'pointer', width: '100%', textDecoration: 'none', background: bg, color: fg, transition: 'all 0.2s' });
const sBtnSm = (bg, fg) => ({ ...sBtn(bg, fg), padding: '10px 18px', fontSize: 14 });

/* ── result display helpers ─────────────────────────────────── */
const sTierRow = (rec, dim) => ({
  display: 'grid', gridTemplateColumns: '120px 1fr 110px', alignItems: 'center',
  background: rec ? 'rgba(16,185,129,0.06)' : C.navy,
  border: rec ? `2px solid ${C.green}` : `1px solid ${C.border}`,
  borderRadius: 8, padding: '14px 18px', fontSize: 15, transition: 'all 0.2s',
  opacity: dim ? 0.5 : 1,
});
const sTierName = { fontWeight: 700, color: C.heading, fontSize: 15 };
const sTierDetail = { fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: C.gray };
const sTierPrice = { fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 16, color: C.green, textAlign: 'right' };
const sSpecCard = { background: C.navy, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 };
const sSpecName = { fontSize: 13, fontWeight: 700, color: C.gray, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 };
const sSpecPrice = { fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: C.green };
const sSpecDet = { fontSize: 13, color: C.gray, marginTop: 4 };
const sModNote = { fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: C.amber, marginTop: 4 };
const sSeasonal = { fontSize: 12, color: C.teal, fontStyle: 'italic', marginTop: 4 };
const sGroupHeader = { fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: C.teal, margin: '28px 0 16px 0', paddingBottom: 8, borderBottom: `2px solid rgba(14,165,233,0.25)` };
const sSectionTitle = { fontSize: 16, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: C.amber, marginBottom: 12 };
const sTag = (c) => ({ display: 'inline-block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, padding: '3px 10px', borderRadius: 12, verticalAlign: 'middle', marginLeft: 8, background: c === 'green' ? 'rgba(16,185,129,0.15)' : c === 'amber' ? 'rgba(245,158,11,0.15)' : c === 'red' ? 'rgba(239,68,68,0.15)' : 'rgba(14,165,233,0.15)', color: c === 'green' ? C.green : c === 'amber' ? C.amber : c === 'red' ? C.red : C.teal });
const sFieldVerify = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: C.red, padding: '2px 8px', background: 'rgba(239,68,68,0.1)', borderRadius: 8, display: 'inline-block', marginLeft: 6 };
const sDiscBadge = { display: 'inline-block', background: 'rgba(16,185,129,0.15)', color: C.green, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, marginLeft: 6, fontFamily: "'JetBrains Mono', monospace" };

/* ── TierGrid ───────────────────────────────────────────────── */
function TierGrid({ children }) { return <div style={{ display: 'grid', gap: 10 }}>{children}</div>; }
function TierRow({ name, detail, price, recommended, dimmed }) {
  return (
    <div className="estimate-tier-row" style={sTierRow(recommended, dimmed)}>
      <div style={sTierName}>{name}{recommended ? ' \u2605' : ''}</div>
      <div style={{ ...sTierDetail, wordWrap: 'break-word', overflowWrap: 'break-word' }}>{detail}</div>
      <div style={sTierPrice}>{price}</div>
    </div>
  );
}

/* ── Form context + helpers (outside component = stable React identity) ── */
const FormCtx = createContext({});

function Field({ label, children, style: sx }) {
  return <div style={{ ...sField, ...sx }}><label style={sLabel}>{label}</label>{children}</div>;
}
function Input({ k, type = 'text', placeholder, min, max }) {
  const { form, set } = useContext(FormCtx);
  return <input type={type} value={form[k]} onChange={e => set(k, e.target.value)} placeholder={placeholder} min={min} max={max} style={sInput} />;
}
function Select({ k, options }) {
  const { form, set } = useContext(FormCtx);
  return (
    <select value={form[k]} onChange={e => set(k, e.target.value)} style={sSelect}>
      {options.map(o => <option key={o.value} value={o.value} style={{ background: C.input, color: C.heading }}>{o.label}</option>)}
    </select>
  );
}
function Checkbox({ k, label }) {
  const { form, toggle } = useContext(FormCtx);
  return (
    <label style={sCheckbox}>
      <input type="checkbox" checked={form[k]} onChange={() => toggle(k)} style={sCb} />
      {label}
    </label>
  );
}
function statusStyle(type) {
  if (type === 'ok') return { fontFamily: "'JetBrains Mono', monospace", fontSize: 13, padding: '10px 14px', borderRadius: C.radius, marginBottom: 16, background: 'rgba(16,185,129,0.1)', color: C.green, border: '1px solid rgba(16,185,129,0.2)' };
  if (type === 'err') return { fontFamily: "'JetBrains Mono', monospace", fontSize: 13, padding: '10px 14px', borderRadius: C.radius, marginBottom: 16, background: 'rgba(239,68,68,0.1)', color: C.red, border: '1px solid rgba(239,68,68,0.2)' };
  if (type === 'loading') return { fontFamily: "'JetBrains Mono', monospace", fontSize: 13, padding: '10px 14px', borderRadius: C.radius, marginBottom: 16, background: 'rgba(14,165,233,0.1)', color: C.teal, border: '1px solid rgba(14,165,233,0.2)' };
  return { display: 'none' };
}

/* ═══════════════════════════════════════════════════════════════
   ESTIMATE PAGE COMPONENT
   ═══════════════════════════════════════════════════════════════ */

function EstimateToolView() {
  /* ── Google Maps script ───────────────────────────────────── */
  const addressRef = useRef(null);
  const autocompleteRef = useRef(null);

  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || 'AIzaSyCvzQ84QWUKMby5YcbM8MhDBlEZ2oF7Bsk';
    if (!apiKey) return;

    // Inject dark-theme styles for the Google autocomplete dropdown
    if (!document.getElementById('pac-dark-style')) {
      const style = document.createElement('style');
      style.id = 'pac-dark-style';
      style.textContent = `
        .pac-container { background: #FFFFFF !important; border: 1px solid #E2E8F0 !important; border-radius: 8px !important; margin-top: 4px !important; z-index: 99999 !important; font-family: 'DM Sans', sans-serif !important; box-shadow: 0 8px 24px rgba(0,0,0,0.1) !important; }
        .pac-item { padding: 8px 12px !important; border-top: 1px solid #E2E8F0 !important; color: #334155 !important; cursor: pointer !important; font-size: 14px !important; }
        .pac-item:first-child { border-top: none !important; }
        .pac-item:hover, .pac-item-selected { background: #F0F7FC !important; }
        .pac-item-query { color: #0F172A !important; font-weight: 600 !important; }
        .pac-matched { color: #0A7EC2 !important; font-weight: 700 !important; }
        .pac-icon { display: none !important; }
        .pac-item span { color: #64748B !important; }
        .pac-item-query span { color: #0F172A !important; }
        .pac-logo::after { display: none !important; }
      `;
      document.head.appendChild(style);
    }

    function tryInit() {
      if (window.google && window.google.maps && window.google.maps.places && addressRef.current) {
        initAutocomplete();
        return true;
      }
      return false;
    }

    if (tryInit()) return;

    // Check if script is already loading
    if (document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')) {
      const interval = setInterval(() => { if (tryInit()) clearInterval(interval); }, 300);
      return () => clearInterval(interval);
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&loading=async`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const interval = setInterval(() => { if (tryInit()) clearInterval(interval); }, 200);
      setTimeout(() => clearInterval(interval), 5000);
    };
    document.head.appendChild(script);
    // Don't remove the script on unmount — it breaks Google Maps global state
  }, []);

  function initAutocomplete() {
    if (!addressRef.current || !window.google?.maps?.places) return;
    if (autocompleteRef.current) return; // Already initialized
    const ac = new window.google.maps.places.Autocomplete(addressRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: ['formatted_address', 'address_components', 'geometry'],
    });
    ac.addListener('place_changed', () => {
      const p = ac.getPlace();
      if (p && p.formatted_address) {
        setForm(f => ({ ...f, address: p.formatted_address }));
      }
    });
    autocompleteRef.current = ac;
  }

  /* ── fonts ────────────────────────────────────────────────── */
  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;600&family=Montserrat:wght@600;700;800&family=Poppins:wght@400;500;600&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    return () => { if (link.parentNode) link.parentNode.removeChild(link); };
  }, []);

  /* ── form state ───────────────────────────────────────────── */
  const [form, setForm] = useState({
    address: '',
    homeSqFt: '', stories: '1', lotSqFt: '', propertyType: 'Single Family',
    hasPool: 'NO', hasPoolCage: 'NO', hasLargeDriveway: 'NO',
    shrubDensity: 'MODERATE', treeDensity: 'MODERATE', landscapeComplexity: 'MODERATE',
    nearWater: 'NO', urgency: 'ROUTINE', isAfterHours: 'NO', isRecurringCustomer: 'NO',
    bedArea: '', palmCount: '', treeCount: '',
    roachModifier: 'NONE', pestFreq: '4', plugArea: '', plugSpacing: '12',
    grassType: 'st_augustine',
    otLawnType: 'FERT',
    exclSimple: '0', exclModerate: '0', exclAdvanced: '0', exclWaive: 'NO',
    bedbugRooms: '1', bedbugMethod: 'BOTH',
    boracareSqft: '', preslabSqft: '', preslabWarranty: 'BASIC', preslabVolume: 'NONE',
    foamPoints: '5', roachType: 'REGULAR',
    // services
    svcLawn: true, svcPest: true, svcTs: false, svcInjection: false, svcMosquito: false,
    svcTermiteBait: false, svcRodentBait: false,
    svcOnetimePest: false, svcOnetimeLawn: false, svcOnetimeMosquito: false,
    svcPlugging: false, svcTopdress: false, svcDethatch: false, svcTrenching: false,
    svcBoracare: false, svcPreslab: false, svcFoam: false, svcRodentTrap: false,
    svcFlea: false, svcWasp: false, svcRoach: false, svcBedbug: false, svcExclusion: false,
  });

  /* ── live pricing preview (approximate from form state) ──── */
  const livePreview = useMemo(() => {
    // Count recurring services
    const recurringKeys = ['svcLawn', 'svcPest', 'svcTs', 'svcInjection', 'svcMosquito', 'svcTermiteBait', 'svcRodentBait'];
    const recurringCount = recurringKeys.filter(k => form[k]).length;

    // Tier logic
    const tierMap = { 0: { name: 'None', discount: 0 }, 1: { name: 'Bronze', discount: 0 }, 2: { name: 'Silver', discount: 0.10 }, 3: { name: 'Gold', discount: 0.15 } };
    const tier = recurringCount >= 4 ? { name: 'Platinum', discount: 0.18 } : (tierMap[recurringCount] || tierMap[0]);

    // Approximate monthly costs for recurring (rough averages based on typical property)
    const sqft = Number(form.homeSqFt) || 2000;
    const lotSqft = Number(form.lotSqFt) || 8000;
    const approx = {};
    if (form.svcLawn) approx.lawn = Math.max(55, Math.round(sqft * 0.028 + 10));
    if (form.svcPest) {
      const freqMult = { '4': 1, '6': 1.3, '12': 2.2 };
      approx.pest = Math.max(35, Math.round((sqft * 0.022 + 20) * (freqMult[form.pestFreq] || 1)));
    }
    if (form.svcTs) approx.ts = Math.max(45, Math.round((Number(form.bedArea) || lotSqft * 0.15) * 0.012 + 30));
    if (form.svcInjection) approx.injection = Math.round((Number(form.palmCount) || 3) * 35 * 3 / 12);
    if (form.svcMosquito) approx.mosquito = Math.max(40, Math.round(lotSqft * 0.005 + 15));
    if (form.svcTermiteBait) approx.termiteBait = 50;
    if (form.svcRodentBait) approx.rodentBait = sqft > 2500 ? 55 : 45;

    const recurringMonthlyBefore = Object.values(approx).reduce((s, v) => s + v, 0);
    const recurringMonthly = Math.round(recurringMonthlyBefore * (1 - tier.discount));
    const annualRecurring = recurringMonthly * 12;
    const annualSavings = Math.round(recurringMonthlyBefore * tier.discount * 12);

    // Count one-time services
    const onetimeKeys = ['svcOnetimePest', 'svcOnetimeLawn', 'svcOnetimeMosquito', 'svcPlugging', 'svcTopdress', 'svcDethatch', 'svcTrenching', 'svcBoracare', 'svcPreslab', 'svcFoam', 'svcRodentTrap', 'svcFlea', 'svcWasp', 'svcRoach', 'svcBedbug', 'svcExclusion'];
    const onetimeCount = onetimeKeys.filter(k => form[k]).length;
    const anySelected = recurringCount > 0 || onetimeCount > 0;

    return { recurringCount, onetimeCount, tier, recurringMonthly, annualRecurring, annualSavings, anySelected };
  }, [form]);

  const [estimate, setEstimate] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [lookupStatus, setLookupStatus] = useState({ type: '', msg: '' });
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [showSendForm, setShowSendForm] = useState(false);
  const [sendSearch, setSendSearch] = useState('');
  const [sendCustomerResults, setSendCustomerResults] = useState([]);
  const searchSendCustomers = useCallback(async (q) => {
    if (!q || q.length < 2) { setSendCustomerResults([]); return; }
    try {
      const r = await fetch(`/api/admin/customers?search=${encodeURIComponent(q)}&limit=5`, { headers: authHeaders });
      if (r.ok) { const d = await r.json(); setSendCustomerResults(d.customers || d || []); }
    } catch { /* ignore */ }
  }, []);

  const token = localStorage.getItem('waves_admin_token');
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  /* ── field setter ─────────────────────────────────────────── */
  const set = useCallback((key, val) => setForm(f => ({ ...f, [key]: val })), []);
  const toggle = useCallback((key) => {
    setForm(f => ({ ...f, [key]: !f[key] }));
    // Reset generated estimate so bottom preview bar updates
    if (key.startsWith('svc')) { setEstimate(null); setSavedId(null); }
  }, []);

  /* ── auto-estimate attic / preslab ────────────────────────── */
  useEffect(() => {
    const sqft = Number(form.homeSqFt) || 0;
    const st = Math.max(1, Number(form.stories) || 1);
    if (sqft > 0) {
      const attic = Math.round(sqft / st * 0.85);
      const fp = Math.round(sqft / st);
      setForm(f => {
        const upd = {};
        if (!f.boracareSqft || f._boracareAuto) upd.boracareSqft = String(attic);
        if (!f.preslabSqft || f._preslabAuto) upd.preslabSqft = String(fp);
        if (Object.keys(upd).length === 0) return f;
        return { ...f, ...upd, _boracareAuto: true, _preslabAuto: true };
      });
    }
  }, [form.homeSqFt, form.stories]);

  /* ── customer search ──────────────────────────────────────── */
  const searchCustomers = useCallback(async (q) => {
    if (!q || q.length < 2) { setCustomers([]); return; }
    try {
      const r = await fetch(`/api/admin/customers?search=${encodeURIComponent(q)}`, { headers: authHeaders });
      if (r.ok) { const d = await r.json(); setCustomers(d.customers || d || []); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);

  function selectCustomer(c) {
    setForm(f => ({
      ...f,
      address: c.address || '',
      homeSqFt: c.homeSqFt ? String(c.homeSqFt) : f.homeSqFt,
      lotSqFt: c.lotSqFt ? String(c.lotSqFt) : f.lotSqFt,
      stories: c.stories ? String(c.stories) : f.stories,
    }));
    setCustomerSearch('');
    setCustomers([]);
  }

  /* ── v2 Property Lookup — RentCast + Satellite + Claude AI in one call ── */
  const [enrichedProfile, setEnrichedProfile] = useState(null);
  const [existingCustomerMatch, setExistingCustomerMatch] = useState(null);

  async function doLookup() {
    const address = form.address.trim();
    if (!address) { setLookupStatus({ type: 'err', msg: 'Enter an address' }); return; }
    setLookupStatus({ type: 'loading', msg: 'Looking up property... (RentCast + AI Satellite Analysis)' });
    setSatelliteStatus({ type: 'loading', msg: 'Running AI satellite analysis...' });
    try {
      const r = await fetch('/api/admin/estimator/property-lookup', {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ address }),
      });
      if (!r.ok) throw new Error('API ' + r.status);
      const data = await r.json();

      if (data.errors?.length > 0 && !data.enriched) {
        setLookupStatus({ type: 'err', msg: data.errors.map(e => e.message).join(', ') });
        setSatelliteStatus({ type: '', msg: '' });
        return;
      }

      const ep = data.enriched;
      setEnrichedProfile(ep);

      // Fill form from enriched profile
      const upd = {};
      if (ep.homeSqFt) upd.homeSqFt = String(ep.homeSqFt);
      if (ep.lotSqFt) upd.lotSqFt = String(ep.lotSqFt);
      if (ep.stories) upd.stories = String(ep.stories);
      if (ep.propertyType) {
        const pt = ep.propertyType.toLowerCase();
        if (pt.includes('single')) upd.propertyType = 'Single Family';
        else if (pt.includes('town')) upd.propertyType = 'Townhome';
        else if (pt.includes('condo')) upd.propertyType = 'Condo';
        else if (pt.includes('duplex')) upd.propertyType = 'Duplex';
        else if (pt.includes('commercial')) upd.propertyType = 'Commercial';
      }
      if (ep.pool === 'YES' || ep.pool === 'POSSIBLE') upd.hasPool = 'YES';
      if (ep.poolCage === 'YES') upd.hasPoolCage = 'YES';
      if (ep.largeDriveway) upd.hasLargeDriveway = 'YES';
      if (ep.shrubDensity) upd.shrubDensity = ep.shrubDensity;
      if (ep.treeDensity) upd.treeDensity = ep.treeDensity;
      if (ep.landscapeComplexity) upd.landscapeComplexity = ep.landscapeComplexity;
      if (ep.nearWater && ep.nearWater !== 'NONE') upd.nearWater = 'YES';
      if (ep.estimatedBedAreaSf) upd.bedArea = String(ep.estimatedBedAreaSf);
      if (ep.estimatedPalmCount) upd.palmCount = String(ep.estimatedPalmCount);
      if (ep.estimatedTreeCount) upd.treeCount = String(ep.estimatedTreeCount);

      setForm(f => ({ ...f, ...upd, _boracareAuto: true, _preslabAuto: true }));

      // Auto-detect existing customer by address
      try {
        const addrSearch = address.split(',')[0].trim();
        const custR = await fetch(`/api/admin/customers?search=${encodeURIComponent(addrSearch)}&limit=3`, { headers: authHeaders });
        if (custR.ok) {
          const custData = await custR.json();
          const custs = custData.customers || custData || [];
          const match = custs.find(c => c.address && address.toLowerCase().includes(c.address.split(',')[0].trim().toLowerCase()));
          if (match) {
            setExistingCustomerMatch(match);
            // Only apply loyalty discount if they have an active WaveGuard tier
            const hasActivePlan = match.tier && match.tier !== 'null' && match.monthlyRate > 0;
            setForm(f => ({ ...f, isRecurringCustomer: hasActivePlan ? 'YES' : 'NO', customerName: `${match.firstName || ''} ${match.lastName || ''}`.trim(), customerPhone: match.phone || f.customerPhone || '', customerEmail: match.email || f.customerEmail || '' }));
          } else {
            setExistingCustomerMatch(null);
          }
        }
      } catch { /* ignore customer lookup errors */ }

      // Satellite images
      if (data.satellite) {
        setSatelliteData({
          imageUrl: data.satellite.closeUrl,
          ultraCloseUrl: data.satellite.ultraCloseUrl,
          superCloseUrl: data.satellite.superCloseUrl,
          closeUrl: data.satellite.closeUrl,
          wideUrl: data.satellite.wideUrl,
          inServiceArea: data.satellite.inServiceArea,
          aiSources: data.aiAnalysis?._sources,
        });
      }

      // Build status messages
      const rc = data.rentcast;
      const ai = data.aiAnalysis;
      const lines = [];
      if (rc) lines.push(`${rc.formattedAddress} — ${rc.squareFootage || '?'} sf / ${rc.lotSize || '?'} sf lot / ${rc.stories || 1} story`);
      if (ep.yearBuilt) lines.push(`Built ${ep.yearBuilt} · ${ep.constructionMaterial} · ${ep.foundationType} foundation · ${ep.roofType} roof`);
      if (ep.serviceZone) lines.push(`Service Zone ${ep.serviceZone}`);
      setLookupStatus({ type: 'ok', msg: lines.join('\n') });

      if (ai) {
        const conf = ep.aiConfidence >= 70 ? 'HIGH' : ep.aiConfidence >= 40 ? 'MEDIUM' : 'LOW';
        const flags = ep.fieldVerifyFlags?.length || 0;
        setSatelliteStatus({
          type: 'ok',
          msg: `AI Analysis complete — Confidence: ${conf} (${ep.aiConfidence}%)${flags > 0 ? ` · ${flags} field(s) flagged` : ''}\nPest pressure: ${ep.overallPestPressure} · Water: ${ep.nearWater} · Turf: ${ep.estimatedTurfSf} sf`,
        });
      } else {
        setSatelliteStatus({ type: 'err', msg: 'AI satellite analysis unavailable' });
      }

      if (data.errors?.length > 0) {
        console.warn('[estimate] Partial errors:', data.errors);
      }
    } catch (e) {
      setLookupStatus({ type: 'err', msg: e.message });
      setSatelliteStatus({ type: '', msg: '' });
    }
  }

  /* ── Satellite AI analysis (Claude + Gemini dual vision) ──── */
  const [satelliteStatus, setSatelliteStatus] = useState({ type: '', msg: '' });
  const [satelliteData, setSatelliteData] = useState(null);

  async function doSatelliteAnalysis() {
    const address = form.address.trim();
    if (!address) { setSatelliteStatus({ type: 'err', msg: 'Enter an address first' }); return; }
    setSatelliteStatus({ type: 'loading', msg: 'Analyzing satellite imagery with AI...' });
    setSatelliteData(null);
    try {
      const r = await fetch('/api/admin/lookup/satellite-ai', {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ address }),
      });
      const data = await r.json();
      if (data.error) { setSatelliteStatus({ type: 'err', msg: data.error }); return; }

      setSatelliteData(data);

      // Auto-fill form fields from AI analysis
      const upd = {};
      if (data.lot_sqft) upd.lotSqFt = String(Math.round(data.lot_sqft));
      if (data.bed_area_sqft) upd.bedArea = String(Math.round(data.bed_area_sqft));
      if (data.palm_count) upd.palmCount = String(data.palm_count);
      if (data.tree_count) upd.treeCount = String(data.tree_count);
      if (data.shrub_density) upd.shrubDensity = data.shrub_density;
      if (data.tree_density) upd.treeDensity = data.tree_density;
      if (data.landscape_complexity) upd.landscapeComplexity = data.landscape_complexity;
      if (data.has_pool) upd.hasPool = 'YES';
      if (data.has_pool_cage) upd.hasPoolCage = 'YES';
      if (data.has_large_driveway) upd.hasLargeDriveway = 'YES';
      if (data.near_water) upd.nearWater = 'YES';
      if (data.property_type) upd.propertyType = data.property_type;
      if (data.perimeter_linear_ft) upd.boracareSqft = String(Math.round(data.perimeter_linear_ft));

      setForm(f => ({ ...f, ...upd }));

      const verify = (data.fieldVerify || []).length;
      const conf = data.confidence === 'high' ? '🟢 HIGH' : data.confidence === 'medium' ? '🟡 MEDIUM' : '🔴 LOW';
      setSatelliteStatus({
        type: 'ok',
        msg: `AI Analysis complete — Confidence: ${conf} (${data.agreementPct || '?'}% model agreement)${verify > 0 ? ` · ${verify} field(s) flagged for field verification` : ''}`,
      });
    } catch (e) {
      setSatelliteStatus({ type: 'err', msg: e.message });
    }
  }

  /* ── generate estimate ────────────────────────────────────── */
  async function doGenerate() {
    // If we have an enriched profile from v2 lookup, use server-side calculation
    if (enrichedProfile) {
      try {
        // Don't overwrite lookup status — keep property specs visible

        // Build selected services array from form checkboxes
        const selectedServices = [];
        if (form.svcLawn) selectedServices.push('LAWN');
        if (form.svcPest) selectedServices.push('PEST');
        if (form.svcTs) selectedServices.push('TREE_SHRUB');
        if (form.svcInjection) selectedServices.push('PALM_INJECTION');
        if (form.svcMosquito) selectedServices.push('MOSQUITO');
        if (form.svcTermiteBait) selectedServices.push('TERMITE_BAIT');
        if (form.svcRodentBait) selectedServices.push('RODENT_BAIT');
        if (form.svcOnetimePest) selectedServices.push('ONETIME_PEST');
        if (form.svcOnetimeLawn) selectedServices.push('ONETIME_LAWN');
        if (form.svcOnetimeMosquito) selectedServices.push('ONETIME_MOSQUITO');
        if (form.svcPlugging) selectedServices.push('PLUGGING');
        if (form.svcTopdress) selectedServices.push('TOPDRESS');
        if (form.svcDethatch) selectedServices.push('DETHATCH');
        if (form.svcTrenching) selectedServices.push('TRENCHING');
        if (form.svcBoracare) selectedServices.push('BORACARE');
        if (form.svcPreslab) selectedServices.push('PRESLAB');
        if (form.svcFoam) selectedServices.push('FOAM');
        if (form.svcRodentTrap) selectedServices.push('RODENT_TRAP');
        if (form.svcFlea) selectedServices.push('FLEA');
        if (form.svcWasp) selectedServices.push('STING');
        if (form.svcRoach) selectedServices.push('ROACH');
        if (form.svcBedbug) selectedServices.push('BEDBUG');
        if (form.svcExclusion) selectedServices.push('EXCLUSION');

        const options = {
          grassType: form.grassType || 'st_augustine',
          pestFreq: parseInt(form.pestFreq) || 4,
          roachModifier: form.roachModifier || 'NONE',
          urgency: form.urgency || 'ROUTINE',
          afterHours: form.isAfterHours === 'YES',
          recurringCustomer: form.isRecurringCustomer === 'YES',
          plugArea: parseInt(form.plugArea) || 0,
          plugSpacing: parseInt(form.plugSpacing) || 12,
          boracareSqft: parseInt(form.boracareSqft) || 0,
          preslabSqft: parseInt(form.preslabSqft) || 0,
          preslabWarranty: form.preslabWarranty || 'BASIC',
          preslabVolume: form.preslabVolume || 'NONE',
          foamPoints: parseInt(form.foamPoints) || 5,
          bedbugRooms: parseInt(form.bedbugRooms) || 1,
          bedbugMethod: form.bedbugMethod || 'BOTH',
          exclSimple: parseInt(form.exclSimple) || 0,
          exclModerate: parseInt(form.exclModerate) || 0,
          exclAdvanced: parseInt(form.exclAdvanced) || 0,
          exclWaiveInspection: form.exclWaive === 'YES',
          roachType: form.roachType || 'REGULAR',
          onetimeLawnType: form.otLawnType || 'FERT',
        };

        // Override enriched profile with any manual form edits
        const profile = { ...enrichedProfile };
        if (form.homeSqFt) profile.homeSqFt = parseInt(form.homeSqFt);
        if (form.lotSqFt) profile.lotSqFt = parseInt(form.lotSqFt);
        if (form.stories) profile.stories = parseInt(form.stories);
        if (form.bedArea) profile.estimatedBedAreaSf = parseInt(form.bedArea);
        if (form.palmCount) profile.estimatedPalmCount = parseInt(form.palmCount);
        if (form.treeCount) profile.estimatedTreeCount = parseInt(form.treeCount);
        profile.footprint = Math.round(profile.homeSqFt / (profile.stories || 1));
        // Override property features from form dropdowns
        profile.pool = form.hasPool === 'YES' ? 'YES' : 'NO';
        profile.poolCage = form.hasPoolCage === 'YES' ? 'YES' : 'NO';
        profile.hasLargeDriveway = form.hasLargeDriveway === 'YES';
        profile.shrubDensity = form.shrubDensity || profile.shrubDensity;
        profile.treeDensity = form.treeDensity || profile.treeDensity;
        profile.landscapeComplexity = form.landscapeComplexity || profile.landscapeComplexity;
        profile.nearWater = form.nearWater === 'YES' ? 'YES' : 'NO';
        profile.propertyType = form.propertyType || profile.propertyType;

        const r = await fetch('/api/admin/estimator/calculate-estimate', {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ profile, selectedServices, options }),
        });
        const result = await r.json();
        if (result.error) { alert(result.error); setLookupStatus(s => ({ ...s, type: 'err', msg: result.error })); return; }

        // Add pricing modifiers from property data if not returned by server
        if (!result.modifiers) {
          const p = result.property || profile || {};
          const mods = [];
          const add = (svc, label, impact, type) => mods.push({ service: svc, label, impact, type });

          // Round-down lookup (same as estimateEngine)
          const interp = (v, b) => {
            if (v <= b[0].at) return b[0].adj;
            if (v >= b[b.length - 1].at) return b[b.length - 1].adj;
            for (let i = 1; i < b.length; i++) {
              if (v <= b[i].at) return b[i - 1].adj;
            }
            return 0;
          };

          const homeSf = p.homeSqFt || p.squareFootage || 0;
          const stories = p.stories || 1;
          const fp = p.footprint || Math.round(homeSf / stories);

          const fpAdj = interp(fp, [{ at: 800, adj: -20 }, { at: 1200, adj: -12 }, { at: 1500, adj: -6 }, { at: 2000, adj: 0 }, { at: 2500, adj: 6 }, { at: 3000, adj: 12 }, { at: 4000, adj: 20 }, { at: 5500, adj: 28 }]);

          add('property', `Home: ${homeSf.toLocaleString()} sq ft · ${stories} story`, 0, 'info');
          add('pest', `Footprint: ${fp.toLocaleString()} sq ft → ${fpAdj >= 0 ? '+' : ''}$${fpAdj}/visit`, fpAdj, fpAdj > 0 ? 'up' : fpAdj < 0 ? 'down' : 'info');
          if (p.poolCage === 'YES') add('pest', 'Pool cage: +$10/visit', 10, 'up');
          else if (p.pool === 'YES') add('pest', 'Pool (no cage): +$5/visit', 5, 'up');
          else add('pest', 'No pool: $0/visit', 0, 'info');
          const sd = p.shrubDensity || p.shrubs;
          if (sd === 'HEAVY') add('pest', 'Heavy shrubs: +$10/visit', 10, 'up');
          else if (sd === 'MODERATE') add('pest', 'MODERATE shrubs: +$5/visit', 5, 'up');
          else add('pest', 'Light shrubs: $0/visit', 0, 'info');
          const td = p.treeDensity || p.trees;
          if (td === 'HEAVY') add('pest', 'Heavy trees: +$10/visit', 10, 'up');
          else if (td === 'MODERATE') add('pest', 'MODERATE trees: +$5/visit', 5, 'up');
          else add('pest', 'Light trees: $0/visit', 0, 'info');
          const lc = p.landscapeComplexity || p.complexity;
          if (lc === 'COMPLEX') add('pest', 'Complex landscape: +$5/visit', 5, 'up');
          else add('pest', `${lc || 'Simple'} landscape: $0/visit`, 0, 'info');
          const nw = p.nearWater || p.waterProximity;
          if (nw && nw !== 'NONE' && nw !== 'NO' && nw !== false) add('pest', 'Near water: +$5/visit', 5, 'up');
          else add('pest', 'No water nearby: $0/visit', 0, 'info');
          if (p.hasLargeDriveway) add('pest', 'Large driveway: +$5/visit', 5, 'up');
          if (p.yearBuilt) add('property', `Built: ${p.yearBuilt} · ${p.constructionMaterial || 'CBS'} · ${p.foundationType || 'Slab'} · ${p.roofType || 'Shingle'}`, 0, 'info');
          result.modifiers = mods;
        }

        setEstimate(result);
        setSavedId(null);
        setLookupStatus(s => ({ ...s, type: 'ok' }));
      } catch (e) {
        alert('Estimate calculation failed: ' + e.message);
      }
      return;
    }

    // Fallback: use v1 client-side calculation
    const yesNo = v => v === 'YES' || v === true;
    const inputs = {
      ...form,
      hasPool: yesNo(form.hasPool),
      hasPoolCage: yesNo(form.hasPoolCage),
      hasLargeDriveway: yesNo(form.hasLargeDriveway),
      nearWater: yesNo(form.nearWater),
      isAfterHours: yesNo(form.isAfterHours),
      isRecurringCustomer: yesNo(form.isRecurringCustomer),
      exclWaive: yesNo(form.exclWaive),
      boracareSqftAuto: form._boracareAuto || false,
    };
    const result = calculateEstimate(inputs);
    if (result.error) { alert(result.error); return; }
    setEstimate(result);
    setSavedId(null);
  }

  /* ── save estimate ────────────────────────────────────────── */
  async function doSave() {
    if (!estimate) return null;
    setSaving(true);
    try {
      const E = estimate;
      const r = await fetch('/api/admin/estimates', {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({
          address: form.address,
          customerName: customerSearch || form.customerName || '',
          customerPhone: form.customerPhone || '',
          customerEmail: form.customerEmail || '',
          estimateData: { inputs: form, result: E },
          monthlyTotal: E.recurring?.grandTotal || 0,
          annualTotal: (E.recurring?.grandTotal || 0) * 12,
          onetimeTotal: E.oneTime?.total || 0,
          waveguardTier: E.recurring?.tier || 'Bronze',
          notes: form.notes || '',
          satelliteUrl: satelliteData?.imageUrl || null,
        }),
      });
      if (!r.ok) throw new Error('Save failed: ' + r.status);
      const d = await r.json();
      const id = d.id || d.estimateId;
      setSavedId(id);
      return id;
    } catch (e) { alert(e.message); return null; }
    finally { setSaving(false); }
  }

  /* ── send estimate ────────────────────────────────────────── */
  async function doSend(id, method) {
    const useId = id || savedId;
    if (!useId) { alert('Save the estimate first.'); return; }
    const sendMethod = method || 'both';
    const scheduled = form.scheduleSend && form.scheduledAt ? form.scheduledAt : null;
    setSending(true);
    try {
      const r = await fetch(`/api/admin/estimates/${useId}/send`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ sendMethod, scheduledAt: scheduled }),
      });
      if (!r.ok) throw new Error('Send failed: ' + r.status);
      const d = await r.json();
      const label = sendMethod === 'sms' ? 'SMS' : sendMethod === 'email' ? 'email' : 'SMS & email';
      if (d.scheduled) {
        const when = new Date(d.scheduledAt).toLocaleString();
        alert(`Estimate scheduled via ${label} for ${when}`);
      } else {
        alert(`Estimate sent via ${label}!`);
      }
    } catch (e) { alert(e.message); }
    setSending(false);
  }

  const E = estimate; // shorthand
  const formCtx = { form, set, toggle };
  const R = E?.results || {};

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */
  return (
    <FormCtx.Provider value={formCtx}>
    <div style={{ background: C.dark, color: C.white, maxWidth: 1440, margin: '0 auto', padding: typeof window !== 'undefined' && window.innerWidth < 640 ? 12 : 28, paddingBottom: livePreview.anySelected && !estimate ? 80 : (typeof window !== 'undefined' && window.innerWidth < 640 ? 12 : 28), minHeight: '100vh', fontSize: 16, fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @media (max-width: 640px) {
          .estimate-layout { grid-template-columns: 1fr !important; }
          .estimate-header { flex-direction: column !important; align-items: flex-start !important; gap: 8px !important; }
          .estimate-header h1 { font-size: 20px !important; }
          .estimate-tier-row { grid-template-columns: 100px 1fr 80px !important; padding: 10px 12px !important; font-size: 13px !important; }
          .estimate-spec-grid { grid-template-columns: 1fr !important; }
          .estimate-summary-flex { gap: 16px !important; }
          .estimate-summary-flex > div { min-width: 80px; }
          .estimate-actions { grid-template-columns: 1fr !important; }
          .estimate-send-grid { grid-template-columns: 1fr !important; }
          .estimate-sticky-bar { flex-direction: column !important; gap: 8px !important; padding: 10px 16px !important; }
        }
      `}</style>
      {/* HEADER */}
      <div className="estimate-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28, paddingBottom: 18, borderBottom: `2px solid ${C.border}` }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: C.teal, margin: 0 }}>Waves Estimating Engine</h1>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: C.gray, background: C.navy, padding: '6px 14px', borderRadius: 20 }}>v1.3 — Internal Use Only</span>
      </div>

      <div className="estimate-layout" style={{ display: 'grid', gridTemplateColumns: '440px 1fr', gap: 28 }}>
        {/* ═══ LEFT COLUMN: FORM ═══ */}
        <div>
          {/* Property Lookup */}
          <div style={sPanel}>
            <div style={sPanelTitle}>Property Lookup</div>
            <Field label="Address">
              <input ref={addressRef} type="text" value={form.address} onChange={e => set('address', e.target.value)} placeholder="Start typing an address..." style={sInput} />
            </Field>
            {lookupStatus.type && <div style={statusStyle(lookupStatus.type)}>{lookupStatus.msg}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <button style={sBtnSm(C.blue, 'white')} onClick={doLookup}>Property Lookup</button>
              <button style={sBtnSm('transparent', C.gray)} onClick={() => { setForm(f => ({ ...f, address: '', homeSqFt: '', lotSqFt: '', stories: '1', propertyType: 'Single Family', hasPool: 'NO', hasPoolCage: 'NO', hasLargeDriveway: 'NO', shrubDensity: 'MODERATE', treeDensity: 'MODERATE', landscapeComplexity: 'MODERATE', nearWater: 'NO', bedArea: '', palmCount: '', treeCount: '' })); setLookupStatus({ type: '', msg: '' }); setSatelliteStatus({ type: '', msg: '' }); setSatelliteData(null); setEstimate(null); }}>Clear All</button>
            </div>
            {satelliteStatus.type && <div style={statusStyle(satelliteStatus.type)}>{satelliteStatus.msg}</div>}
            {/* AI analysis inline flags */}
            {enrichedProfile?.fieldVerifyFlags?.length > 0 && (
              <div style={{ marginBottom: 10, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8 }}>
                {enrichedProfile.fieldVerifyFlags.map((flag, i) => (
                  <div key={i} style={{ fontSize: 12, color: C.red, marginBottom: i < enrichedProfile.fieldVerifyFlags.length - 1 ? 4 : 0 }}>
                    {'\u26A0\uFE0F'} {typeof flag === 'string' ? flag.replace(/_/g, ' ') : (flag.field || flag.name || '').replace(/_/g, ' ')}{flag.reason ? ` \u2014 ${flag.reason}` : ''}
                  </div>
                ))}
              </div>
            )}
            {/* Existing customer match */}
            {existingCustomerMatch && (
              <div style={{ marginBottom: 10, padding: '10px 14px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 8, fontSize: 13, color: C.green }}>
                Existing customer: <strong>{existingCustomerMatch.firstName} {existingCustomerMatch.lastName}</strong>
                {existingCustomerMatch.tier && existingCustomerMatch.tier !== 'null' ? ` · WaveGuard ${existingCustomerMatch.tier}` : ' · No active plan'}
                {existingCustomerMatch.tier && existingCustomerMatch.tier !== 'null' && existingCustomerMatch.monthlyRate > 0 ? ' · 15% loyalty discount applied' : ''}
              </div>
            )}
            {satelliteData && (satelliteData.imageUrl || satelliteData.closeUrl) && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 8 }}>
                  {satelliteData.ultraCloseUrl && (
                    <div>
                      <img src={satelliteData.ultraCloseUrl} alt="Ultra close" style={{ width: '100%', borderRadius: 8, border: `2px solid ${C.teal}`, aspectRatio: '1', objectFit: 'cover' }} />
                      <div style={{ fontSize: 9, color: C.teal, textAlign: 'center', marginTop: 2, fontWeight: 600 }}>Ultra</div>
                    </div>
                  )}
                  {satelliteData.superCloseUrl && (
                    <div>
                      <img src={satelliteData.superCloseUrl} alt="Super close" style={{ width: '100%', borderRadius: 8, border: `1px solid ${C.border}`, aspectRatio: '1', objectFit: 'cover' }} />
                      <div style={{ fontSize: 9, color: C.gray, textAlign: 'center', marginTop: 2 }}>Detail</div>
                    </div>
                  )}
                  <div>
                    <img src={satelliteData.closeUrl || satelliteData.imageUrl} alt="Close view" style={{ width: '100%', borderRadius: 8, border: `1px solid ${C.border}`, aspectRatio: '1', objectFit: 'cover' }} />
                    <div style={{ fontSize: 9, color: C.gray, textAlign: 'center', marginTop: 2 }}>Property</div>
                  </div>
                  {satelliteData.wideUrl && (
                    <div>
                      <img src={satelliteData.wideUrl} alt="Area view" style={{ width: '100%', borderRadius: 8, border: `1px solid ${C.border}`, aspectRatio: '1', objectFit: 'cover' }} />
                      <div style={{ fontSize: 9, color: C.gray, textAlign: 'center', marginTop: 2 }}>Area</div>
                    </div>
                  )}
                </div>
                {satelliteData.aiSources && (
                  <div style={{ fontSize: 10, color: C.teal, marginBottom: 4 }}>
                    AI Analysis: {satelliteData.aiSources.join(' + ')} {satelliteData.aiSources.length > 1 ? '(dual-model)' : ''}
                  </div>
                )}
                {satelliteData.fieldVerify?.length > 0 && (
                  <div style={{ fontSize: 12, color: C.red, fontWeight: 600, padding: '6px 10px', background: 'rgba(239,68,68,0.1)', borderRadius: 6 }}>
                    Field verify: {satelliteData.fieldVerify.map(f => typeof f === 'string' ? f.replace(/_/g, ' ') : (f.field || '')).join(', ')}
                  </div>
                )}
                {satelliteData.notes && (
                  <div style={{ fontSize: 11, color: C.gray, marginTop: 4, fontStyle: 'italic' }}>{satelliteData.notes}</div>
                )}
              </div>
            )}
          </div>

          {/* Property Data */}
          <div style={sPanel}>
            <div style={sPanelTitle}>Property Data</div>
            <Field label="Property Type">
              <Select k="propertyType" options={[
                { value: 'Single Family', label: 'Single Family ($0)' },
                { value: 'Townhome', label: 'Townhome — End Unit (-$8)' },
                { value: 'Townhome Interior', label: 'Townhome — Interior Unit (-$15)' },
                { value: 'Duplex', label: 'Duplex (-$10)' },
                { value: 'Condo', label: 'Condo — Ground Floor (-$20)' },
                { value: 'Condo Upper', label: 'Condo — Upper Floor (-$25)' },
                { value: 'Commercial', label: 'Commercial' },
              ]} />
            </Field>
            <div style={sRow}>
              <Field label="Home Sq Ft"><Input k="homeSqFt" type="number" placeholder="2000" /></Field>
              <Field label="Stories"><Input k="stories" type="number" min="1" max="4" /></Field>
            </div>
            <Field label="Lot Sq Ft"><Input k="lotSqFt" type="number" placeholder="8000" /></Field>
            {form.svcTs && (
              <div style={sRow}>
                <Field label="Bed Area (sq ft)"><Input k="bedArea" type="number" placeholder="Auto-estimate" /></Field>
                <Field label="Palm Count"><Input k="palmCount" type="number" placeholder="Auto" /></Field>
              </div>
            )}
            {form.svcTs && (
              <Field label="Tree Count"><Input k="treeCount" type="number" placeholder="Auto" /></Field>
            )}
          </div>

          {/* Property Features */}
          <div style={sPanel}>
            <div style={sPanelTitle}>Property Features</div>
            <div style={sRow3}>
              <Field label="Pool"><Select k="hasPool" options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} /></Field>
              <Field label="Pool Cage"><Select k="hasPoolCage" options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} /></Field>
              <Field label="Large Driveway"><Select k="hasLargeDriveway" options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} /></Field>
            </div>
            <div style={sRow3}>
              <Field label="Shrub Density"><Select k="shrubDensity" options={[{ value: 'LIGHT', label: 'Light' }, { value: 'MODERATE', label: 'Moderate' }, { value: 'HEAVY', label: 'Heavy' }]} /></Field>
              <Field label="Tree Density"><Select k="treeDensity" options={[{ value: 'LIGHT', label: 'Light' }, { value: 'MODERATE', label: 'Moderate' }, { value: 'HEAVY', label: 'Heavy' }]} /></Field>
              <Field label="Complexity"><Select k="landscapeComplexity" options={[{ value: 'SIMPLE', label: 'Simple' }, { value: 'MODERATE', label: 'Moderate' }, { value: 'COMPLEX', label: 'Complex' }]} /></Field>
            </div>
            <div style={sRow}>
              <Field label="Near Water"><Select k="nearWater" options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} /></Field>
              <Field label="Urgency"><Select k="urgency" options={[{ value: 'ROUTINE', label: 'Routine' }, { value: 'SOON', label: 'Soon (same/next day)' }, { value: 'URGENT', label: 'Urgent (within 12 hrs)' }]} /></Field>
            </div>
            <div style={sRow}>
              <Field label="After Hours"><Select k="isAfterHours" options={[{ value: 'NO', label: 'No — business hours' }, { value: 'YES', label: 'Yes — evenings/weekends/holidays' }]} /></Field>
              <Field label="Recurring Customer"><Select k="isRecurringCustomer" options={[{ value: 'NO', label: 'No — new customer' }, { value: 'YES', label: 'Yes — 15% off one-time' }]} /></Field>
            </div>
          </div>

          {/* Preset Selector */}
          <div style={sPanel}>
            <div style={sPanelTitle}>Quick Start</div>
            <div style={{ fontSize: 12, color: C.gray, marginBottom: 10 }}>Pick a template to pre-fill services, or build from scratch below.</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
              {ESTIMATE_PRESETS.map(preset => (
                <div key={preset.id} onClick={() => {
                  setForm(f => {
                    const upd = { ...f };
                    ALL_SVC_KEYS.forEach(k => upd[k] = false);
                    Object.entries(preset.services).forEach(([k, v]) => upd[k] = v);
                    if (preset.defaults) Object.entries(preset.defaults).forEach(([k, v]) => upd[k] = v);
                    return upd;
                  });
                  setEstimate(null);
                  setSavedId(null);
                }} style={{
                  padding: '10px 8px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${C.border}`, background: C.navy,
                  textAlign: 'center', transition: 'border-color 0.15s',
                }} onMouseEnter={e => e.currentTarget.style.borderColor = C.teal}
                   onMouseLeave={e => e.currentTarget.style.borderColor = C.border}>
                  <div style={{ fontSize: 22 }}>{preset.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.white, marginTop: 4, lineHeight: 1.3 }}>{preset.name}</div>
                  {preset.popular && <div style={{ fontSize: 9, color: C.teal, fontWeight: 700, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>Popular</div>}
                  {preset.tier && <div style={{ fontSize: 9, color: C.green, fontWeight: 600, marginTop: 1 }}>{preset.tier}</div>}
                </div>
              ))}
            </div>
          </div>

          {/* Services */}
          <div style={sPanel}>
            <div style={sPanelTitle}>Services to Quote</div>

            <div style={sSvcSection}>Recurring Programs</div>
            <Checkbox k="svcLawn" label="Lawn Care" />
            {form.svcLawn && (
              <div style={sSubOpts}>
                <Field label="Grass Type / Track">
                  <Select k="grassType" options={[
                    { value: 'st_augustine', label: 'St. Augustine' },
                    { value: 'bermuda', label: 'Bermuda' },
                    { value: 'zoysia', label: 'Zoysia' },
                    { value: 'bahia', label: 'Bahia' },
                  ]} />
                </Field>
              </div>
            )}
            <Checkbox k="svcPest" label="Pest Control" />
            {form.svcPest && (
              <div style={sSubOpts}>
                <div style={sRow}>
                  <Field label="Frequency"><Select k="pestFreq" options={[{ value: '4', label: 'Quarterly (4x/yr)' }, { value: '6', label: 'Bi-Monthly (6x/yr)' }, { value: '12', label: 'Monthly (12x/yr)' }]} /></Field>
                  <Field label="Cockroach Modifier"><Select k="roachModifier" options={[{ value: 'NONE', label: 'None' }, { value: 'REGULAR', label: 'Regular (+15%)' }, { value: 'GERMAN', label: 'German ($100+15%)' }]} /></Field>
                </div>
              </div>
            )}
            <Checkbox k="svcTs" label="Tree & Shrub" />
            <Checkbox k="svcInjection" label="Palm Injection" />
            <Checkbox k="svcMosquito" label="Mosquito Program" />
            <Checkbox k="svcTermiteBait" label="Termite Bait Stations" />
            <Checkbox k="svcRodentBait" label="Rodent Bait Stations" />

            {/* Dynamic tier badge */}
            {livePreview.recurringCount > 0 && (
              <div style={{
                margin: '12px 0 6px 0', padding: '8px 14px', borderRadius: 8,
                background: livePreview.tier.discount > 0 ? 'rgba(16,185,129,0.08)' : 'rgba(14,165,233,0.08)',
                border: `1px solid ${livePreview.tier.discount > 0 ? 'rgba(16,185,129,0.25)' : 'rgba(14,165,233,0.2)'}`,
                fontSize: 13, color: livePreview.tier.discount > 0 ? C.green : C.teal,
              }}>
                {livePreview.recurringCount} service{livePreview.recurringCount > 1 ? 's' : ''} selected {'\u2192'} <strong>WaveGuard {livePreview.tier.name}</strong>
                {livePreview.tier.discount > 0 ? ` (${Math.round(livePreview.tier.discount * 100)}% bundle discount)` : ' (no discount \u2014 add 1 more for Silver 10%)'}
              </div>
            )}

            <div style={sSvcSection}>One-Time Services</div>

            {/* -- Lawn Services -- */}
            <div style={{ ...sSvcSection, color: C.green, fontSize: 11 }}>Lawn</div>
            <Checkbox k="svcOnetimeLawn" label="Lawn Treatment" />
            {form.svcOnetimeLawn && (
              <div style={sSubOpts}>
                <Field label="Type" style={{ marginBottom: 0 }}>
                  <Select k="otLawnType" options={[{ value: 'FERT', label: 'Fertilization (base)' }, { value: 'WEED', label: 'Weed Control (+12%)' }, { value: 'PEST', label: 'Lawn Pest (+30%)' }, { value: 'FUNGICIDE', label: 'Fungicide (+38%)' }]} />
                </Field>
              </div>
            )}
            <Checkbox k="svcPlugging" label="Lawn Plugging" />
            {form.svcPlugging && (
              <div style={sSubOpts}>
                <div style={sRow}>
                  <Field label="Plug Area (sq ft)"><Input k="plugArea" type="number" placeholder="e.g. 1000" /></Field>
                  <Field label="Spacing"><Select k="plugSpacing" options={[{ value: '12', label: '12" Economy' }, { value: '9', label: '9" Standard' }, { value: '6', label: '6" Premium' }]} /></Field>
                </div>
              </div>
            )}
            <Checkbox k="svcTopdress" label="Top Dressing" />
            <Checkbox k="svcDethatch" label="Dethatching" />
            <Checkbox k="svcOverseed" label="Overseeding" />

            {/* -- Termite Services -- */}
            <div style={{ ...sSvcSection, color: C.red, fontSize: 11 }}>Termite</div>
            <Checkbox k="svcTrenching" label="Termite Trenching" />
            <Checkbox k="svcBoracare" label="Termite Attic Remediation" />
            {form.svcBoracare && (
              <div style={sSubOpts}>
                <Field label="Attic Sq Ft (auto-estimated from home/stories)" style={{ marginBottom: 0 }}>
                  <Input k="boracareSqft" type="number" placeholder="Auto from RentCast" />
                </Field>
              </div>
            )}
            <Checkbox k="svcPreslab" label="Pre-Slab Termite Treatment" />
            {form.svcPreslab && (
              <div style={sSubOpts}>
                <div style={sRow}>
                  <Field label="Slab Sq Ft"><Input k="preslabSqft" type="number" placeholder="From footprint" /></Field>
                  <Field label="Warranty"><Select k="preslabWarranty" options={[{ value: 'BASIC', label: 'Basic 1-yr (included)' }, { value: 'EXTENDED', label: 'Extended 5-yr (+$200)' }]} /></Field>
                </div>
                <Field label="Builder Volume"><Select k="preslabVolume" options={[{ value: 'NONE', label: 'No discount' }, { value: '5', label: '5+ homes (-10%)' }, { value: '10', label: '10+ homes (-15%)' }]} /></Field>
              </div>
            )}
            <Checkbox k="svcFoam" label="Termite Foam Treatment" />
            {form.svcFoam && (
              <div style={sSubOpts}>
                <Field label="Drill Points" style={{ marginBottom: 0 }}>
                  <Select k="foamPoints" options={[{ value: '5', label: '1-5 Spot' }, { value: '10', label: '6-10 Moderate' }, { value: '15', label: '11-15 Extensive' }, { value: '20', label: '15+ Full Perimeter' }]} />
                </Field>
              </div>
            )}

            {/* -- Pest Services -- */}
            <div style={{ ...sSvcSection, color: C.amber, fontSize: 11 }}>Pest</div>
            <Checkbox k="svcOnetimePest" label="Pest Treatment" />
            <Checkbox k="svcOnetimeMosquito" label="Mosquito Treatment" />
            <Checkbox k="svcFlea" label="Flea Treatment" />
            <Checkbox k="svcRoach" label="Cockroach Treatment" />
            {form.svcRoach && (
              <div style={sSubOpts}>
                <Field label="Type" style={{ marginBottom: 0 }}>
                  <Select k="roachType" options={[{ value: 'REGULAR', label: 'Regular (American/Smoky Brown)' }, { value: 'GERMAN', label: 'German (3-visit)' }]} />
                </Field>
              </div>
            )}
            <Checkbox k="svcWasp" label="Wasp/Bee/Stinging Insect" />
            <Checkbox k="svcBedbug" label="Bed Bug Treatment" />
            {form.svcBedbug && (
              <div style={sSubOpts}>
                <div style={sRow}>
                  <Field label="Rooms"><Input k="bedbugRooms" type="number" min="1" max="10" /></Field>
                  <Field label="Method"><Select k="bedbugMethod" options={[{ value: 'BOTH', label: 'Quote Both' }, { value: 'CHEMICAL', label: 'Chemical Only' }, { value: 'HEAT', label: 'Heat Only' }]} /></Field>
                </div>
              </div>
            )}

            {/* -- Rodent Services -- */}
            <div style={{ ...sSvcSection, color: C.gray, fontSize: 11 }}>Rodent</div>
            <Checkbox k="svcRodentTrap" label="Rodent Trapping" />
            <Checkbox k="svcRodentSanitation" label="Rodent Sanitation" />
            <Checkbox k="svcExclusion" label="Rodent Exclusion" />
            {form.svcExclusion && (
              <div style={sSubOpts}>
                <div style={sRow3}>
                  <Field label="Simple Seals"><Input k="exclSimple" type="number" min="0" /></Field>
                  <Field label="Moderate"><Input k="exclModerate" type="number" min="0" /></Field>
                  <Field label="Advanced/Roof"><Input k="exclAdvanced" type="number" min="0" /></Field>
                </div>
                <Field label="Waive Inspection ($85)?"><Select k="exclWaive" options={[{ value: 'NO', label: 'No — charge $85' }, { value: 'YES', label: 'Yes — booking work' }]} /></Field>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="estimate-actions" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
            <button style={{ ...sBtn(C.teal, '#fff'), fontSize: 16, padding: '16px 28px' }} onClick={doGenerate}>GENERATE ESTIMATE</button>
            <button style={{ ...sBtn(C.blue, '#fff'), fontSize: 16, padding: '16px 28px' }} onClick={() => {
              if (!estimate) { doGenerate(); }
              setShowSendForm(true);
            }}>SEND ESTIMATE</button>
          </div>

          {/* Send Estimate Form */}
          {showSendForm && (
            <div style={{ ...sPanel, borderColor: C.teal }}>
              <div style={sPanelTitle}>Send Estimate</div>
              <Field label="Customer Phone Number">
                <input type="tel" value={form.customerPhone || ''} onChange={async (e) => {
                  const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                  set('customerPhone', digits);
                  if (digits.length >= 7) {
                    try {
                      const r = await fetch(`/api/admin/customers?search=${encodeURIComponent(digits)}&limit=1`, { headers: authHeaders });
                      if (r.ok) {
                        const d = await r.json();
                        const c = (d.customers || d)?.[0];
                        if (c) {
                          set('customerName', `${c.firstName} ${c.lastName}`);
                          set('customerEmail', c.email || '');
                        }
                      }
                    } catch { /* ignore */ }
                  }
                }} placeholder="9415551234" style={{ ...sInput, fontSize: 20, fontWeight: 700, letterSpacing: 1 }} />
              </Field>
              {form.customerName && (
                <div style={{ fontSize: 14, color: C.green, marginBottom: 12, padding: '8px 12px', background: 'rgba(16,185,129,0.1)', borderRadius: 8 }}>
                  Found: <strong>{form.customerName}</strong>{form.customerEmail ? ` · ${form.customerEmail}` : ''}
                </div>
              )}
              {!form.customerName && form.customerPhone?.length >= 7 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <Field label="Name"><input type="text" value={form.customerName || ''} onChange={e => set('customerName', e.target.value)} placeholder="Full name" style={sInput} /></Field>
                    <Field label="Email"><input type="email" value={form.customerEmail || ''} onChange={e => set('customerEmail', e.target.value)} placeholder="email@example.com" style={sInput} /></Field>
                  </div>
                </div>
              )}
              {/* Schedule toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: C.gray }}>
                  <input type="checkbox" checked={form.scheduleSend || false} onChange={e => set('scheduleSend', e.target.checked)} style={{ accentColor: C.teal }} />
                  Schedule for later
                </label>
                {form.scheduleSend && (
                  <input type="datetime-local" value={form.scheduledAt || ''} onChange={e => set('scheduledAt', e.target.value)}
                    style={{ ...sInput, width: 'auto', padding: '6px 10px', fontSize: 13 }} />
                )}
              </div>
              {form.scheduleSend && !form.scheduledAt && (
                <div style={{ fontSize: 11, color: C.amber, marginBottom: 8 }}>
                  Quick: <button onClick={() => {
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    tomorrow.setHours(8, 0, 0, 0);
                    set('scheduledAt', tomorrow.toISOString().slice(0, 16));
                  }} style={{ background: 'none', border: 'none', color: C.teal, cursor: 'pointer', fontSize: 11, fontWeight: 600, textDecoration: 'underline' }}>Tomorrow 8:00 AM</button>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <button style={{ ...sBtn(C.green, 'white'), fontSize: 13, padding: '12px 10px' }} onClick={async () => {
                    if (!form.customerPhone) { alert('Enter a phone number.'); return; }
                    if (form.scheduleSend && !form.scheduledAt) { alert('Pick a send time.'); return; }
                    if (!estimate) { doGenerate(); }
                    const id = await doSave();
                    if (id) await doSend(id, 'sms');
                  }} disabled={sending}>{sending ? '...' : form.scheduleSend ? 'Schedule SMS' : 'SMS Only'}</button>
                  <button style={{ ...sBtn(C.blue, '#fff'), fontSize: 13, padding: '12px 10px' }} onClick={async () => {
                    if (!form.customerEmail) { alert('Enter an email.'); return; }
                    if (form.scheduleSend && !form.scheduledAt) { alert('Pick a send time.'); return; }
                    if (!estimate) { doGenerate(); }
                    const id = await doSave();
                    if (id) await doSend(id, 'email');
                  }} disabled={sending}>{sending ? '...' : form.scheduleSend ? 'Schedule Email' : 'Email Only'}</button>
                  <button style={{ ...sBtn(C.teal, 'white'), fontSize: 13, padding: '12px 10px' }} onClick={async () => {
                    if (!form.customerPhone && !form.customerEmail) { alert('Enter phone or email.'); return; }
                    if (form.scheduleSend && !form.scheduledAt) { alert('Pick a send time.'); return; }
                    if (!estimate) { doGenerate(); }
                    const id = await doSave();
                    if (id) await doSend(id, 'both');
                  }} disabled={sending}>{sending ? '...' : form.scheduleSend ? 'Schedule Both' : 'Both'}</button>
                </div>
                <button style={{ ...sBtn('transparent', C.gray), fontSize: 13, padding: '10px 16px', border: `1px solid ${C.border}` }} onClick={() => setShowSendForm(false)}>Cancel</button>
              </div>
            </div>
          )}

          {savedId && (
            <div style={{ fontSize: 12, color: C.green, marginBottom: 12 }}>Saved — ID #{savedId}.</div>
          )}
        </div>

        {/* ═══ RIGHT COLUMN: RESULTS ═══ */}
        <div>
          {!estimate ? (
            <div style={{ ...sPanel, textAlign: 'center', padding: '60px 24px' }}>
              <div style={{ fontSize: 56, marginBottom: 18 }}>{livePreview.anySelected ? '\u26A1' : '\uD83D\uDCCB'}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10, color: C.heading }}>
                {!livePreview.anySelected ? 'Select Services to Get Started' : 'Ready to Generate'}
              </div>
              <div style={{ fontSize: 15, color: C.gray, marginBottom: 16 }}>
                {!livePreview.anySelected
                  ? 'Select at least one service to see pricing'
                  : `${livePreview.recurringCount} recurring + ${livePreview.onetimeCount} one-time selected \u2014 click Generate Estimate`}
              </div>
              {/* Mini property summary if lookup done */}
              {enrichedProfile && (
                <div style={{ textAlign: 'left', padding: '12px 16px', background: C.navy, borderRadius: 8, border: `1px solid ${C.border}`, marginTop: 10, fontSize: 13, color: C.gray, lineHeight: 1.7 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.teal, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Property Loaded</div>
                  <div>{form.address}</div>
                  <div>{(Number(form.homeSqFt) || 0).toLocaleString()} sf home {'\u00B7'} {(Number(form.lotSqFt) || 0).toLocaleString()} sf lot {'\u00B7'} {form.stories || 1} story</div>
                  {form.hasPool === 'YES' && <div>Pool: Yes{form.hasPoolCage === 'YES' ? ' (caged)' : ''}</div>}
                  <div>Shrubs: {form.shrubDensity} {'\u00B7'} Trees: {form.treeDensity} {'\u00B7'} Complexity: {form.landscapeComplexity}</div>
                </div>
              )}
            </div>
          ) : (
            <EstimateErrorBoundary key={JSON.stringify(estimate).slice(0, 100)}>
            <div style={sPanel}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button style={{ padding: '6px 14px', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, color: C.gray, fontSize: 12, fontWeight: 600, cursor: 'pointer' }} onClick={() => { setEstimate(null); setSavedId(null); setShowSendForm(false); }}>New Estimate</button>
              </div>
              <div style={{ maxHeight: 'calc(100vh - 120px)', overflowY: 'auto', paddingRight: 10 }}>
                {/* ── Summary Card ──────────────────────── */}
                {(E.recurring.serviceCount > 0 || E.oneTime.total > 0) && (
                  <>
                    <div style={{ background: 'linear-gradient(135deg, rgba(14,165,233,0.15), rgba(16,185,129,0.10))', border: `2px solid ${C.teal}`, borderRadius: C.radius, padding: 24, marginBottom: 24, textAlign: 'center' }}>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 36, fontWeight: 700, color: C.green }}>
                        {fmt(E.recurring.monthlyTotal + (E.recurring.rodentBaitMo || 0))}/mo
                      </div>
                      <div style={{ fontSize: 14, color: C.gray, marginTop: 4 }}>
                        Recurring monthly{E.recurring.savings > 0 ? ` (WaveGuard ${E.recurring.waveGuardTier} pricing)` : ''}
                      </div>
                      <div className="estimate-summary-flex" style={{ display: 'flex', justifyContent: 'center', gap: 40, marginTop: 14, flexWrap: 'wrap' }}>
                        {E.oneTime.total > 0 && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: C.heading }}>{fmtInt(E.oneTime.total)}</div>
                            <div style={{ fontSize: 12, color: C.gray, textTransform: 'uppercase', letterSpacing: 0.5 }}>{E.oneTime.tmInstall > 0 ? `One-Time (incl ${fmtInt(E.oneTime.tmInstall)} install)` : 'WaveGuard Membership'}</div>
                          </div>
                        )}
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: C.heading }}>{fmt(E.totals.year1)}</div>
                          <div style={{ fontSize: 12, color: C.gray, textTransform: 'uppercase', letterSpacing: 0.5 }}>Year 1 Total</div>
                        </div>
                        {E.recurring.savings > 0 && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: C.green }}>-{fmt(E.recurring.savings)}</div>
                            <div style={{ fontSize: 12, color: C.gray, textTransform: 'uppercase', letterSpacing: 0.5 }}>Bundle Savings/yr</div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Recommendation */}
                    {E.recurring.serviceCount >= 2 && (() => {
                      const parts = [];
                      if (R.lawn) parts.push('Lawn Care');
                      if (R.pest) parts.push(R.pest.label + ' Pest');
                      if (R.mq) { const ri = E.results.mqMeta?.ri ?? 1; parts.push(R.mq[ri].n + ' Mosquito'); }
                      if (R.tmBait) parts.push('Trelona Premier');
                      if (parts.length < 2) return null;
                      return (
                        <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 8, padding: '14px 18px', marginBottom: 20, fontSize: 14, color: C.gray, lineHeight: 1.6 }}>
                          <strong style={{ color: C.green }}>Recommended:</strong> {parts.join(' + ')} for comprehensive coverage at {fmt(E.recurring.monthlyTotal)}/mo recurring.
                        </div>
                      );
                    })()}

                    {/* Field verify */}
                    {E.fieldVerify?.length > 0 && (
                      <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '14px 18px', marginBottom: 20, fontSize: 14, color: C.gray, lineHeight: 1.6 }}>
                        <strong style={{ color: C.red }}>Field Verify:</strong> {E.fieldVerify.map(f => typeof f === 'string' ? f : (f.field || f.name || JSON.stringify(f))).join(', ')} — estimated from satellite data, tech should confirm on-site.
                      </div>
                    )}
                  </>
                )}

                {/* ── Property Summary ──────────────────── */}
                <div style={{ marginBottom: 24 }}>
                  <div style={sSectionTitle}>Property Summary</div>
                  <div style={{ fontSize: 15, color: C.gray, lineHeight: 1.8 }}>
                    <strong style={{ color: C.heading }}>{E.property?.type || E.property?.propertyType || 'Residential'}</strong> — {(E.property?.homeSqFt || 0).toLocaleString()} sf / {(E.property?.lotSqFt || 0).toLocaleString()} sf lot / {E.property?.stories || 1} story<br />
                    Footprint: <strong>{(E.property?.footprint || 0).toLocaleString()} sf</strong> | Pool: {E.property?.pool === 'YES' || E.property?.pool === true ? 'Yes' : 'No'}{E.property?.poolCage === 'YES' ? ' (caged)' : ''} | Driveway: {E.property?.largeDriveway === 'YES' || E.property?.largeDriveway === true ? 'Large' : 'Normal'}<br />
                    Shrubs: {E.property?.shrubDensity || E.property?.shrubs || '--'} | Trees: {E.property?.treeDensity || E.property?.trees || '--'} | Complexity: {E.property?.landscapeComplexity || E.property?.complexity || '--'} | Water: {E.property?.nearWater && E.property.nearWater !== 'NONE' ? E.property.nearWater.replace(/_/g, ' ') : 'No'}
                    {E.property?.yearBuilt && <><br />Built: {E.property.yearBuilt} | {E.property?.constructionMaterial} | {E.property?.foundationType} foundation | {E.property?.roofType} roof</>}
                    {E.property?.serviceZone && <span style={sTag('teal')}>Zone {E.property.serviceZone}</span>}
                    {E.urgency?.label && <><br /><span style={sTag('amber')}>{E.urgency.label}</span></>}
                    {E.recurringCustomer && <span style={sTag('green')}>Recurring -15% one-time</span>}
                  </div>
                </div>

                {/* ── Pricing Modifiers ────────────────── */}
                {E.modifiers?.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={sSectionTitle}>Pricing Modifiers</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {E.modifiers.map((m, i) => (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                        background: m.type === 'up' ? 'rgba(239,68,68,0.06)' : m.type === 'down' ? 'rgba(16,185,129,0.06)' : 'rgba(14,165,233,0.06)',
                        borderRadius: 6, border: `1px solid ${m.type === 'up' ? 'rgba(239,68,68,0.15)' : m.type === 'down' ? 'rgba(16,185,129,0.15)' : 'rgba(14,165,233,0.15)'}`,
                      }}>
                        <span style={{ fontSize: 12, flexShrink: 0 }}>
                          {m.type === 'up' ? '▲' : m.type === 'down' ? '▼' : '●'}
                        </span>
                        <span style={{ fontSize: 12, color: m.type === 'up' ? C.red : m.type === 'down' ? C.green : C.gray, flex: 1 }}>
                          {m.label}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", color: m.type === 'up' ? C.red : m.type === 'down' ? C.green : C.gray }}>{m.impact != null ? (m.impact >= 0 ? '+$' + m.impact : '-$' + Math.abs(m.impact)) : '$0'}</span>
                      </div>
                    ))}
                  </div>
                </div>
                )}

                {/* ── Recurring Programs ────────────────── */}
                {E.hasRecurring && (
                  <>
                    <div style={sGroupHeader}>Recurring Programs</div>

                    {/* Lawn */}
                    {R.lawn && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={sSectionTitle}>Lawn Care <span style={sTag('blue')}>{R.lawnMeta?.lsf?.toLocaleString()} sf turf</span>{R.lawnMeta?.grassName && <span style={sTag('green')}>{R.lawnMeta.grassName}</span>}</div>
                        <TierGrid>
                          {R.lawn.map((t, i) => (
                            <TierRow key={i} name={t.name} detail={`${fmt(t.pa)}/app x ${t.v}`} price={`${fmt(t.mo)}/mo`} recommended={t.recommended} dimmed={t.dimmed} />
                          ))}
                        </TierGrid>
                      </div>
                    )}

                    {/* Pest */}
                    {R.pestTiers && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={sSectionTitle}>Pest Control</div>
                        <TierGrid>
                          {R.pestTiers.map((t, i) => (
                            <TierRow key={i} name={t.label} detail={`${fmt(t.pa)}/app x ${t.apps}${R.pest?.rOG > 0 ? ' (incl roach +15%)' : ''}`} price={`${fmt(t.mo)}/mo`} recommended={t.recommended} dimmed={t.dimmed} />
                          ))}
                        </TierGrid>
                        {R.pest?.rOG > 0 && <div style={sModNote}>Roach modifier: +{fmt(R.pest.rOG)}/visit ({R.pestRoachMod === 'GERMAN' ? 'German' : 'Regular'})</div>}
                      </div>
                    )}

                    {/* Tree & Shrub */}
                    {R.ts && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={sSectionTitle}>
                          Tree &amp; Shrub <span style={sTag('blue')}>{R.tsMeta?.eb} sf beds | {R.tsMeta?.et} trees</span>
                          {R.tsMeta?.bedAreaIsEstimated && <span style={sFieldVerify}>FIELD VERIFY</span>}
                        </div>
                        <TierGrid>
                          {R.ts.map((t, i) => (
                            <TierRow key={i} name={t.name} detail={`${fmt(t.pa)}/app x ${t.v}`} price={`${fmt(t.mo)}/mo`} recommended={t.recommended} dimmed={t.dimmed} />
                          ))}
                        </TierGrid>
                      </div>
                    )}

                    {/* Palm Injection */}
                    {R.injection && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={sSectionTitle}>Palm Injection <span style={sTag('blue')}>{R.injection.palms} palms</span></div>
                        <TierGrid>
                          <TierRow name="Arborjet" detail={`${R.injection.palms} palms x $35 x 3/yr`} price={`${fmt(R.injection.mo)}/mo`} recommended />
                        </TierGrid>
                      </div>
                    )}

                    {/* Mosquito */}
                    {R.mq && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={sSectionTitle}>Mosquito <span style={sTag('amber')}>Pressure {R.mqMeta?.pr}x</span></div>
                        <TierGrid>
                          {R.mq.map((t, i) => (
                            <TierRow key={i} name={t.n} detail={`$${t.pv}/visit x ${t.v}`} price={`${fmt(t.mo)}/mo`} recommended={t.recommended} dimmed={t.dimmed} />
                          ))}
                        </TierGrid>
                      </div>
                    )}

                    {/* Termite Bait */}
                    {R.tmBait && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={sSectionTitle}>Termite Bait <span style={sTag('blue')}>{R.tmBait.sta} sta | {R.tmBait.perim} ft</span></div>
                        <TierGrid>
                          <TierRow name="Advance" detail={`${fmtInt(R.tmBait.ai)} install | Basic $35 | Premier $65/mo`} price="$35-65" dimmed />
                          <TierRow name="Trelona" detail={`${fmtInt(R.tmBait.ti)} install | Basic $35 | Premier $65/mo`} price="$35-65" recommended />
                        </TierGrid>
                        <div style={sModNote}>Install cost is a one-time setup fee, not a recurring charge</div>
                      </div>
                    )}

                    {/* Rodent Bait */}
                    {R.rodBaitMo && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={sSectionTitle}>Rodent Bait Stations</div>
                        <TierGrid>
                          <TierRow name="Monthly" detail={`${R.rodBaitSize} property`} price={`$${R.rodBaitMo}/mo`} recommended />
                        </TierGrid>
                        <div style={sModNote}>Not included in WaveGuard bundle discount — priced separately</div>
                      </div>
                    )}
                  </>
                )}

                {/* ── One-Time Services ────────────────── */}
                {E.hasOneTime && (
                  <>
                    <div style={sGroupHeader}>One-Time Services</div>
                    {E.oneTime.items.map((item, i) => {
                      // Top Dressing has tiers
                      if (item.name === 'Top Dressing' && R.tdTiers) {
                        return (
                          <div key={i} style={{ marginBottom: 24 }}>
                            <div style={sSectionTitle}>Top Dressing{E.isRecurringCustomer && <span style={sDiscBadge}>-15%</span>}</div>
                            <TierGrid>
                              {R.tdTiers.map((t, j) => <TierRow key={j} name={t.name} detail={t.detail} price={fmtInt(t.price)} />)}
                            </TierGrid>
                          </div>
                        );
                      }
                      // Trenching has renewal row
                      if (item.name === 'Trenching' && R.trench) {
                        return (
                          <div key={i} style={{ marginBottom: 24 }}>
                            <div style={sSectionTitle}>Trenching{E.isRecurringCustomer && <span style={sDiscBadge}>-15%</span>}</div>
                            <TierGrid>
                              <TierRow name="Treatment" detail={item.detail} price={fmtInt(item.price)} />
                              <TierRow name="Renewal" detail="Annual warranty" price="$325/yr" dimmed />
                            </TierGrid>
                            <div style={sSeasonal}>Best scheduled before rainy season (Apr-May)</div>
                          </div>
                        );
                      }
                      // Bora-Care
                      if (item.name === 'Bora-Care') {
                        return (
                          <div key={i} style={{ marginBottom: 24 }}>
                            <div style={sSectionTitle}>
                              Bora-Care Attic{E.isRecurringCustomer && <span style={sDiscBadge}>-15%</span>}
                              {item.atticIsEstimated && <span style={sFieldVerify}>FIELD VERIFY ATTIC</span>}
                            </div>
                            <TierGrid>
                              <TierRow name="Treatment" detail={item.detail} price={fmtInt(item.price)} />
                            </TierGrid>
                            <div style={sSeasonal}>Best time: Oct-Mar (cooler attic temps)</div>
                          </div>
                        );
                      }
                      // Pre-Slab
                      if (item.name === 'Pre-Slab') {
                        return (
                          <div key={i} style={{ marginBottom: 24 }}>
                            <div style={sSectionTitle}>Pre-Slab Termidor{E.isRecurringCustomer && <span style={sDiscBadge}>-15%</span>}</div>
                            <TierGrid>
                              <TierRow name="Treatment" detail={item.detail} price={fmtInt(item.basePrice || item.price)} />
                              {item.warrAdd > 0 && <TierRow name="5yr Warranty" detail="Extended transferable" price="+$200" />}
                            </TierGrid>
                            {!item.warrAdd && <div style={sModNote}>Includes 1-yr builder warranty | $225/yr renewal after</div>}
                          </div>
                        );
                      }
                      // Foam Drill
                      if (item.name === 'Foam Drill') {
                        return (
                          <div key={i} style={{ marginBottom: 24 }}>
                            <div style={sSectionTitle}>Foam Drill{E.isRecurringCustomer && <span style={sDiscBadge}>-15%</span>}</div>
                            <TierGrid>
                              <TierRow name={item.tierName} detail={item.detail} price={fmtInt(item.price)} />
                            </TierGrid>
                            <div style={sModNote}>For localized drywood, wall voids, door/window frames</div>
                          </div>
                        );
                      }
                      // Plugging
                      if (item.name === 'Plugging') {
                        return (
                          <div key={i} style={{ marginBottom: 24 }}>
                            <div style={sSectionTitle}>Plugging{E.isRecurringCustomer && <span style={sDiscBadge}>-15%</span>}</div>
                            <TierGrid>
                              <TierRow name={item.spacing} detail={item.detail} price={fmtInt(item.price)} />
                            </TierGrid>
                            {item.warn6 && <div style={sModNote}>Sod may be more cost-effective at 6"</div>}
                          </div>
                        );
                      }
                      // Generic one-time
                      const nameMap = { 'OT Pest': 'One-Time Pest', 'OT Mosquito': 'One-Time Mosquito', 'German Roach': 'German Roach Initial' };
                      const displayName = item.lawnType ? `One-Time Lawn (${item.lawnType})` : (nameMap[item.name] || item.name);
                      return (
                        <div key={i} style={{ marginBottom: 24 }}>
                          <div style={sSectionTitle}>{displayName}{E.isRecurringCustomer && <span style={sDiscBadge}>-15%</span>}</div>
                          <TierGrid>
                            <TierRow name={item.lawnType || (item.name === 'OT Pest' ? 'Full Spray' : item.name === 'OT Mosquito' ? 'Event Spray' : item.name === 'German Roach' ? '3-Visit' : item.name === 'Trapping' ? 'Trapping' : 'Standalone')} detail={item.detail} price={fmtInt(item.price)} />
                          </TierGrid>
                        </div>
                      );
                    })}
                  </>
                )}

                {/* ── Specialty Pest ───────────────────── */}
                {E.specItems && E.specItems.length > 0 && (
                  <>
                    <div style={sGroupHeader}>Specialty Pest</div>
                    <div className="estimate-spec-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 24 }}>
                      {E.specItems.map((s, i) => (
                        <div key={i} style={sSpecCard}>
                          <div style={sSpecName}>{s.name}</div>
                          <div style={sSpecPrice}>{s.onProg ? '$0 — Included' : fmtInt(s.price)}</div>
                          <div style={sSpecDet}>{s.det}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* ── WaveGuard + Totals ───────────────── */}
                {(E.recurring.serviceCount > 0 || E.oneTime.total > 0 || E.recurring.rodentBaitMo > 0) && (
                  <>
                    <div style={{ height: 1, background: C.border, margin: '18px 0' }} />

                    {/* WaveGuard card */}
                    {E.recurring.serviceCount > 0 && (
                      <div style={{ background: 'linear-gradient(135deg, rgba(14,165,233,0.12), rgba(37,99,235,0.12))', border: '2px solid rgba(14,165,233,0.35)', borderRadius: C.radius, padding: '20px 24px', marginBottom: 24 }}>
                        <div style={{ fontSize: 24, fontWeight: 700, color: C.teal }}>WaveGuard {E.recurring.waveGuardTier}</div>
                        <div style={{ fontSize: 15, color: C.gray, marginTop: 4 }}>{E.recurring.serviceCount} recurring service{E.recurring.serviceCount > 1 ? 's' : ''} — {Math.round(E.recurring.discount * 100)}% bundle discount</div>
                        {E.recurring.savings > 0 && (
                          <div style={{ color: C.green, fontSize: 18, fontWeight: 700, marginTop: 4 }}>Bundling saves {fmt(E.recurring.savings)}/year</div>
                        )}
                        {/* Breakdown */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 16px', fontSize: 14, marginTop: 10, padding: '12px 16px', background: 'rgba(14,165,233,0.06)', borderRadius: 8 }}>
                          {E.recurring.services.map((s, i) => (
                            <React.Fragment key={i}>
                              <div style={{ color: C.gray }}>{s.name}</div>
                              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: C.heading, textAlign: 'right' }}>{fmt(s.mo)}/mo</div>
                            </React.Fragment>
                          ))}
                          <div style={{ fontWeight: 700, color: C.heading, borderTop: `1px solid ${C.border}`, paddingTop: 6, marginTop: 4 }}>Total before discount</div>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, borderTop: `1px solid ${C.border}`, paddingTop: 6, marginTop: 4, textAlign: 'right', color: C.heading }}>{fmt(Math.round(E.recurring.annualBeforeDiscount / 12 * 100) / 100)}/mo</div>
                          {E.recurring.discount > 0 && (
                            <>
                              <div style={{ color: C.green }}>{E.recurring.waveGuardTier} discount (-{Math.round(E.recurring.discount * 100)}%)</div>
                              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: C.green, textAlign: 'right' }}>-{fmt(Math.round(E.recurring.savings / 12 * 100) / 100)}/mo</div>
                            </>
                          )}
                          <div style={{ fontWeight: 700, color: C.teal }}>Your monthly rate</div>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: C.teal, textAlign: 'right' }}>{fmt(E.recurring.monthlyTotal)}/mo</div>
                        </div>
                      </div>
                    )}

                    {/* Totals */}
                    <div style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.08), rgba(14,165,233,0.08))', border: '2px solid rgba(16,185,129,0.3)', borderRadius: C.radius, padding: 24 }}>
                      {E.recurring.serviceCount > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 16 }}>
                          <span>Recurring (after WaveGuard)</span>
                          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: C.green }}>{fmt(E.recurring.annualAfterDiscount)}/yr ({fmt(E.recurring.monthlyTotal)}/mo)</span>
                        </div>
                      )}
                      {E.recurring.rodentBaitMo > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 16 }}>
                          <span>Rodent bait (separate)</span>
                          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: C.green }}>{fmtInt(E.recurring.rodentBaitMo * 12)}/yr (${E.recurring.rodentBaitMo}/mo)</span>
                        </div>
                      )}
                      {E.oneTime.tmInstall > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 16 }}>
                          <span>Termite bait install (Trelona)</span>
                          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: C.green }}>{fmtInt(E.oneTime.tmInstall)}</span>
                        </div>
                      )}
                      {E.oneTime.otSubtotal > 0 && (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 16, borderTop: `1px solid ${C.border}`, marginTop: 6, paddingTop: 10 }}>
                            <span style={{ fontWeight: 700 }}>One-Time Services</span>
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: C.green }}>{fmtInt(E.oneTime.otSubtotal)}</span>
                          </div>
                          {E.oneTime.items.map((item, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0 3px 16px', fontSize: 14, color: C.gray }}>
                              <span>{item.name}{item.waivedWithPrepay ? <span style={{ fontSize: 11, color: C.green, marginLeft: 6 }}>waived with annual prepay</span> : ''}</span>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: C.green }}>{fmtInt(item.price)}</span>
                            </div>
                          ))}
                          {E.oneTime.specItems.map((s, i) => (
                            <div key={`sp-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0 3px 16px', fontSize: 14, color: C.gray }}>
                              <span>{s.name}</span>
                              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: C.green }}>{fmtInt(s.price)}</span>
                            </div>
                          ))}
                        </>
                      )}
                      {/* Big totals */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', fontSize: 22, fontWeight: 700, borderTop: `2px solid ${C.border}`, marginTop: 10 }}>
                        <span>Year 1 Total</span>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: C.green }}>{fmt(E.totals.year1)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 16 }}>
                        <span>Year 2+ Annual</span>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: C.green }}>{fmt(E.totals.year2)}/yr ({fmt(E.totals.year2mo)}/mo)</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
            </EstimateErrorBoundary>
          )}
        </div>
      </div>
    </div>

    {/* ── Sticky bottom bar — live pricing preview ──────── */}
    {livePreview.anySelected && !estimate && (
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 1000,
        background: 'linear-gradient(135deg, #FFFFFF 0%, #F1F5F9 100%)',
        borderTop: `2px solid ${C.teal}`,
        padding: '12px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexWrap: 'wrap',
        fontFamily: "'JetBrains Mono', monospace",
        boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
      }}>
        <div style={{ fontSize: 11, color: C.gray, textTransform: 'uppercase', letterSpacing: 1 }}>Approx</div>
        {livePreview.recurringCount > 0 && (
          <>
            <div style={{ fontSize: 15, color: C.heading }}>
              Monthly: <strong style={{ color: C.green }}>${livePreview.recurringMonthly}</strong>
            </div>
            <div style={{ fontSize: 13, color: C.gray }}>{'\u00B7'}</div>
            <div style={{ fontSize: 15, color: C.heading }}>
              Annual: <strong style={{ color: C.green }}>${livePreview.annualRecurring.toLocaleString()}</strong>
            </div>
            {livePreview.annualSavings > 0 && (
              <>
                <div style={{ fontSize: 13, color: C.gray }}>{'\u00B7'}</div>
                <div style={{ fontSize: 14, color: C.green }}>
                  Savings: <strong>${livePreview.annualSavings}/yr</strong> ({livePreview.tier.name} {Math.round(livePreview.tier.discount * 100)}%)
                </div>
              </>
            )}
          </>
        )}
        {livePreview.recurringCount === 0 && livePreview.onetimeCount > 0 && (
          <div style={{ fontSize: 14, color: C.gray }}>{livePreview.onetimeCount} one-time service{livePreview.onetimeCount > 1 ? 's' : ''} selected</div>
        )}
        <button onClick={doGenerate} style={{
          marginLeft: 10, padding: '8px 20px', background: C.teal, color: '#fff',
          border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer',
          fontFamily: "'DM Sans', sans-serif",
        }}>Generate</button>
      </div>
    )}
    </FormCtx.Provider>
  );
}

// =========================================================================
// ESTIMATES PIPELINE VIEW — list of sent estimates with status tracking
// =========================================================================
const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const STATUS_CONFIG = {
  draft: { label: 'Draft', color: C.gray, bg: `${C.gray}22` },
  sent: { label: 'Sent', color: C.teal, bg: `${C.teal}22` },
  viewed: { label: 'Viewed', color: C.amber, bg: `${C.amber}22` },
  accepted: { label: 'Accepted', color: C.green, bg: `${C.green}22` },
  declined: { label: 'Declined', color: C.red, bg: `${C.red}22` },
  expired: { label: 'Expired', color: C.gray, bg: `${C.gray}15` },
};

/* ── Competitor detection for intel badge ──────────────────── */
const COMPETITORS = ['trugreen', 'massey', 'turner', 'all u need', 'terminix', 'orkin'];
function detectCompetitor(notes) {
  if (!notes) return null;
  const lower = notes.toLowerCase();
  for (const c of COMPETITORS) {
    if (lower.includes(c)) {
      // Capitalize for display
      return c.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    }
  }
  return null;
}

/* ── Urgency indicator logic based on timestamps ──────────── */
function getUrgencyIndicator(e) {
  const now = Date.now();
  const HOUR = 3600000;

  if (e.status === 'sent' && !e.viewedAt && e.sentAt) {
    const hoursSinceSent = (now - new Date(e.sentAt).getTime()) / HOUR;
    if (hoursSinceSent >= 72) return { label: 'Going cold', color: C.red, bg: `${C.red}18` };
    if (hoursSinceSent >= 24) return { label: 'Not opened', color: C.amber, bg: `${C.amber}18` };
  }

  if (e.status === 'viewed' && e.viewedAt) {
    const hoursSinceViewed = (now - new Date(e.viewedAt).getTime()) / HOUR;
    if (hoursSinceViewed >= 168) return { label: 'Final follow-up', color: C.red, bg: `${C.red}18` };
    if (hoursSinceViewed >= 48) return { label: 'Follow up', color: C.amber, bg: `${C.amber}18` };
  }

  return null;
}

/* ── Decline reason options ────────────────────────────────── */
const DECLINE_REASONS = [
  'Too expensive',
  'Went with competitor',
  'Not ready',
  'Service not needed',
  'No response',
];

/* ── Follow-Up Modal ──────────────────────────────────────── */
function FollowUpModal({ estimate, onClose, onSent }) {
  const firstName = estimate.customerName?.split(' ')[0] || 'there';
  const addrShort = estimate.address?.split(',')[0] || 'your property';
  const [message, setMessage] = useState(
    `Hi ${firstName}, just checking in on the estimate I sent for ${addrShort}. Any questions? — Adam, Waves`
  );
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}/follow-up`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      onSent();
    } catch (err) {
      alert('Follow-up failed: ' + err.message);
    }
    setSending(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: 24, maxWidth: 480, width: '100%' }}
        onClick={ev => ev.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.heading, marginBottom: 4 }}>Follow Up — {estimate.customerName}</div>
        <div style={{ fontSize: 12, color: C.gray, marginBottom: 16 }}>{estimate.address}</div>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.gray, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, display: 'block' }}>SMS Message</label>
        <textarea value={message} onChange={ev => setMessage(ev.target.value)} rows={4}
          style={{ ...sInput, resize: 'vertical', minHeight: 90, marginBottom: 16 }} />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '10px 20px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.gray, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSend} disabled={sending}
            style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: C.amber, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: sending ? 0.6 : 1 }}>
            {sending ? 'Sending...' : 'Send Follow-Up SMS'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Decline Reason Modal ─────────────────────────────────── */
function DeclineModal({ estimate, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!reason) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'declined', declineReason: reason }),
      });
      onSaved();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
    setSaving(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, padding: 24, maxWidth: 400, width: '100%' }}
        onClick={ev => ev.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.heading, marginBottom: 4 }}>Mark as Lost</div>
        <div style={{ fontSize: 12, color: C.gray, marginBottom: 16 }}>{estimate.customerName} — {estimate.address?.split(',')[0]}</div>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.gray, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, display: 'block' }}>Reason</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
          {DECLINE_REASONS.map(r => (
            <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, color: reason === r ? C.heading : C.gray, padding: '8px 12px', borderRadius: 8, background: reason === r ? `${C.red}18` : 'transparent', border: `1px solid ${reason === r ? C.red : C.border}`, transition: 'all 0.15s' }}>
              <input type="radio" name="declineReason" checked={reason === r} onChange={() => setReason(r)}
                style={{ accentColor: C.red, width: 16, height: 16 }} />
              {r}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '10px 20px', borderRadius: 8, border: `1px solid ${C.border}`, background: 'transparent', color: C.gray, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !reason}
            style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: C.red, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: (saving || !reason) ? 0.5 : 1 }}>
            {saving ? 'Saving...' : 'Mark as Lost'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Action-oriented filter logic ─────────────────────────── */
const PIPELINE_FILTERS = [
  { key: 'all', label: 'All', color: C.heading },
  { key: 'needs_estimate', label: 'Needs Estimate', color: C.amber },
  { key: 'ready_to_send', label: 'Ready to Send', color: C.teal },
  { key: 'awaiting', label: 'Awaiting Response', color: C.blue },
  { key: 'follow_up', label: 'Follow Up Now', color: C.amber },
  { key: 'won', label: 'Won', color: C.green },
  { key: 'lost', label: 'Lost', color: C.red },
];

function classifyEstimate(e) {
  if (e.status === 'accepted') return 'won';
  if (e.status === 'declined' || e.status === 'expired') return 'lost';
  if (e.status === 'draft' && (!e.monthlyTotal || e.monthlyTotal === 0)) return 'needs_estimate';
  if (e.status === 'draft' && e.monthlyTotal > 0) return 'ready_to_send';
  if (e.status === 'sent' && !e.viewedAt) return 'awaiting';
  if (e.status === 'viewed') return 'follow_up';
  if (e.status === 'sent' && e.viewedAt) return 'follow_up';
  return 'all';
}

function EstimatePipelineView() {
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [followUpTarget, setFollowUpTarget] = useState(null);
  const [declineTarget, setDeclineTarget] = useState(null);

  const refreshEstimates = useCallback(() => {
    adminFetch('/admin/estimates')
      .then(d => { setEstimates(d.estimates || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { refreshEstimates(); }, [refreshEstimates]);

  const togglePriority = useCallback(async (e) => {
    const newVal = !e.isPriority;
    try {
      await adminFetch(`/admin/estimates/${e.id}`, { method: 'PATCH', body: JSON.stringify({ isPriority: newVal }) });
      setEstimates(prev => prev.map(est => est.id === e.id ? { ...est, isPriority: newVal } : est));
    } catch (err) { alert('Failed to update priority'); }
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>Loading estimates...</div>;

  // Classify each estimate
  const classified = estimates.map(e => ({ ...e, _class: classifyEstimate(e) }));

  // Sort: priority first, then by created date desc
  const sorted = [...classified].sort((a, b) => {
    if (a.isPriority && !b.isPriority) return -1;
    if (!a.isPriority && b.isPriority) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  // Stats
  const total = estimates.length;
  const accepted = estimates.filter(e => e.status === 'accepted').length;
  const sent = estimates.filter(e => ['sent', 'viewed'].includes(e.status)).length;
  const declined = estimates.filter(e => e.status === 'declined' || e.status === 'expired').length;
  const totalMRRWon = estimates.filter(e => e.status === 'accepted').reduce((s, e) => s + (e.monthlyTotal || 0), 0);
  const pipelineValue = estimates.filter(e => !['accepted', 'declined', 'expired'].includes(e.status)).reduce((s, e) => s + (e.monthlyTotal || 0), 0);
  const conversionRate = (sent + accepted + declined) > 0
    ? Math.round(accepted / (sent + accepted + declined) * 100) : 0;
  const avgEstimateValue = total > 0
    ? Math.round(estimates.reduce((s, e) => s + (e.monthlyTotal || 0), 0) / total) : 0;

  // Follow-up overdue: viewed > 48h or sent > 72h without action
  const HOUR = 3600000;
  const now = Date.now();
  const followUpOverdue = estimates.filter(e => {
    if (e.status === 'sent' && !e.viewedAt && e.sentAt && (now - new Date(e.sentAt).getTime()) > 72 * HOUR) return true;
    if (e.status === 'viewed' && e.viewedAt && (now - new Date(e.viewedAt).getTime()) > 48 * HOUR) return true;
    return false;
  }).length;

  // Filter counts
  const filterCounts = {};
  for (const f of PIPELINE_FILTERS) {
    filterCounts[f.key] = f.key === 'all' ? total : classified.filter(e => e._class === f.key).length;
  }

  const filtered = filter === 'all' ? sorted : sorted.filter(e => e._class === filter);

  const fmtDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const timeAgo = (d) => {
    if (!d) return '';
    const mins = Math.floor((Date.now() - new Date(d)) / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  return (
    <div>
      {/* Follow-Up Modal */}
      {followUpTarget && (
        <FollowUpModal estimate={followUpTarget} onClose={() => setFollowUpTarget(null)}
          onSent={() => { setFollowUpTarget(null); refreshEstimates(); }} />
      )}
      {/* Decline Modal */}
      {declineTarget && (
        <DeclineModal estimate={declineTarget} onClose={() => setDeclineTarget(null)}
          onSaved={() => { setDeclineTarget(null); refreshEstimates(); }} />
      )}

      {/* Enhanced Stats Bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Pipeline Value', value: `$${Math.round(pipelineValue)}`, sub: '/mo potential', color: C.teal },
          { label: 'MRR Won', value: `$${Math.round(totalMRRWon)}`, sub: '/mo closed', color: C.green },
          { label: 'Conversion', value: `${conversionRate}%`, sub: `${accepted} of ${sent + accepted + declined}`, color: conversionRate >= 50 ? C.green : conversionRate >= 25 ? C.amber : C.red },
          { label: 'Avg Estimate', value: `$${avgEstimateValue}`, sub: '/mo', color: C.heading },
          { label: 'Follow-Up Overdue', value: followUpOverdue, sub: followUpOverdue > 0 ? 'need attention' : 'all clear', color: followUpOverdue > 0 ? C.red : C.green },
          { label: 'Total', value: total, sub: `${accepted} won · ${declined} lost`, color: C.heading },
        ].map((s, i) => (
          <div key={i} style={{
            flex: '1 1 140px', background: C.card, borderRadius: 10, padding: '14px 16px',
            border: `1px solid ${C.border}`, textAlign: 'center',
          }}>
            <div style={{ fontSize: 10, color: C.gray, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
            {s.sub && <div style={{ fontSize: 10, color: C.gray, marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>

      {/* Action-Oriented Filter Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {PIPELINE_FILTERS.map(f => {
          const count = filterCounts[f.key];
          const isActive = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: isActive ? f.color : C.card,
              color: isActive ? '#fff' : f.color,
              fontSize: 12, fontWeight: 600, transition: 'all 0.15s',
              border: `1px solid ${isActive ? f.color : C.border}`,
            }}>
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Estimates List */}
      {filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>
          No estimates {filter !== 'all' ? `in "${PIPELINE_FILTERS.find(f => f.key === filter)?.label}"` : 'yet'}. Create one using the Create Estimate button.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(e => {
            const sc = STATUS_CONFIG[e.status] || STATUS_CONFIG.draft;
            const urgency = getUrgencyIndicator(e);
            const competitor = detectCompetitor(e.notes || e.description);

            return (
              <div key={e.id} style={{
                background: C.card, borderRadius: 10, padding: '16px 20px',
                border: e.isPriority ? `2px solid ${C.red}` : `1px solid ${C.border}`,
                display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                position: 'relative',
              }}>
                {/* Priority flag indicator */}
                {e.isPriority && (
                  <div style={{ position: 'absolute', top: -1, right: 16, background: C.red, color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: '0 0 6px 6px', textTransform: 'uppercase', letterSpacing: 0.5 }}>Urgent</div>
                )}

                {/* Status badge */}
                <span style={{
                  padding: '4px 10px', borderRadius: 8, fontSize: 10, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: 0.5,
                  background: sc.bg, color: sc.color, minWidth: 70, textAlign: 'center', flexShrink: 0,
                }}>{sc.label}</span>

                {/* Customer info */}
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.heading }}>{e.customerName || 'Unknown'}</span>
                    {e.source === 'lead_webhook' && <span title="Website lead" style={{ fontSize: 14 }}>{'🌐'}</span>}
                    {e.source === 'voice_agent' && <span title="Voice agent lead" style={{ fontSize: 14 }}>{'🎙️'}</span>}
                    {e.source === 'referral' && <span title="Referral" style={{ fontSize: 14 }}>{'🤝'}</span>}
                    {/* Urgency indicator */}
                    {urgency && (
                      <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: urgency.bg, color: urgency.color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>{urgency.label}</span>
                    )}
                    {/* Competitor intel badge */}
                    {competitor && (
                      <span title={`Switching from ${competitor}`} style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: `${C.blue}22`, color: C.blue, fontWeight: 600 }}>Switching from: {competitor}</span>
                    )}
                    {/* Decline reason badge */}
                    {e.declineReason && (
                      <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, background: `${C.red}15`, color: C.red, fontWeight: 600 }}>{e.declineReason}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: C.gray, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.address || '—'}{e.serviceInterest ? ` · ${e.serviceInterest}` : ''}
                  </div>
                </div>

                {/* Tier */}
                {e.tier && (
                  <span style={{
                    padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700, flexShrink: 0,
                    background: e.tier === 'Gold' ? `${C.amber}22` : e.tier === 'Platinum' ? `${C.heading}15` : `${C.teal}22`,
                    color: e.tier === 'Gold' ? C.amber : e.tier === 'Platinum' ? C.heading : C.teal,
                  }}>{e.tier}</span>
                )}

                {/* Monthly */}
                <div style={{ textAlign: 'right', minWidth: 80, flexShrink: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: e.monthlyTotal > 0 ? C.green : C.gray, fontFamily: "'JetBrains Mono', monospace" }}>
                    ${e.monthlyTotal?.toFixed(0) || '0'}<span style={{ fontSize: 11, fontWeight: 400 }}>/mo</span>
                  </div>
                </div>

                {/* Timeline */}
                <div style={{ textAlign: 'right', minWidth: 100, flexShrink: 0 }}>
                  <div style={{ fontSize: 11, color: C.gray }}>Created {fmtDate(e.createdAt)}</div>
                  {e.sentAt && <div style={{ fontSize: 10, color: C.teal }}>Sent {timeAgo(e.sentAt)}</div>}
                  {e.viewedAt && <div style={{ fontSize: 10, color: C.amber }}>Viewed {timeAgo(e.viewedAt)}</div>}
                  {e.acceptedAt && <div style={{ fontSize: 10, color: C.green }}>Accepted {timeAgo(e.acceptedAt)}</div>}
                  {e.declinedAt && <div style={{ fontSize: 10, color: C.red }}>Declined {timeAgo(e.declinedAt)}</div>}
                  {e.followUpCount > 0 && <div style={{ fontSize: 10, color: C.gray }}>Follow-ups: {e.followUpCount}</div>}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                  {/* Priority toggle */}
                  <button onClick={() => togglePriority(e)} title={e.isPriority ? 'Remove priority' : 'Flag as urgent'}
                    style={{
                      padding: '6px 8px', borderRadius: 6, border: `1px solid ${e.isPriority ? C.red : C.border}`, cursor: 'pointer',
                      background: e.isPriority ? `${C.red}22` : 'transparent', color: e.isPriority ? C.red : C.gray, fontSize: 13, lineHeight: 1,
                    }}>{'⚑'}</button>

                  {/* Send button for drafts with pricing */}
                  {e.status === 'draft' && e.monthlyTotal > 0 && (
                    <button onClick={async () => {
                      await adminFetch(`/admin/estimates/${e.id}/send`, { method: 'POST' }).catch(() => {});
                      refreshEstimates();
                    }} style={{
                      padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                      background: C.teal, color: '#fff', fontSize: 11, fontWeight: 600,
                    }}>Send</button>
                  )}

                  {/* Follow-up button for sent/viewed — opens modal with pre-filled SMS */}
                  {(e.status === 'sent' || e.status === 'viewed') && (
                    <button onClick={() => setFollowUpTarget(e)} style={{
                      padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                      background: urgency ? `${urgency.color}22` : `${C.amber}22`,
                      color: urgency ? urgency.color : C.amber,
                      fontSize: 11, fontWeight: 600,
                    }}>Follow Up</button>
                  )}

                  {/* Mark as Lost button for sent/viewed */}
                  {(e.status === 'sent' || e.status === 'viewed') && (
                    <button onClick={() => setDeclineTarget(e)} style={{
                      padding: '6px 12px', borderRadius: 6, border: `1px solid ${C.border}`, cursor: 'pointer',
                      background: 'transparent', color: C.red, fontSize: 11, fontWeight: 600,
                    }}>Mark Lost</button>
                  )}

                  {/* Copy link for sent/viewed */}
                  {(e.status === 'sent' || e.status === 'viewed') && (
                    <button onClick={() => {
                      const link = `${window.location.origin}/estimate/${e.token || e.id}`;
                      navigator.clipboard?.writeText(link);
                    }} style={{
                      padding: '6px 12px', borderRadius: 6, border: `1px solid ${C.border}`, cursor: 'pointer',
                      background: 'transparent', color: C.gray, fontSize: 11, fontWeight: 600,
                    }}>Copy Link</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// =========================================================================
// WEBSITE QUOTES VIEW — leads from website forms, voice agent, referrals
// =========================================================================
function WebsiteQuotesView() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/estimates?source=website,voice_agent,lead_webhook,referral')
      .then(d => { setLeads(d.estimates || []); setLoading(false); })
      .catch(() => {
        // Fallback — get all estimates and filter client-side
        adminFetch('/admin/estimates').then(d => {
          const webLeads = (d.estimates || []).filter(e =>
            ['new', 'draft'].includes(e.status) || e.source === 'voice_agent' || e.source === 'lead_webhook'
          );
          setLeads(webLeads.length > 0 ? webLeads : d.estimates || []);
          setLoading(false);
        }).catch(() => setLoading(false));
      });
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>Loading quotes...</div>;

  const newLeads = leads.filter(e => e.status === 'new' || e.status === 'draft');
  const inProgress = leads.filter(e => e.status === 'sent' || e.status === 'viewed');
  const resolved = leads.filter(e => ['accepted', 'declined', 'expired'].includes(e.status));

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

  const sourceIcon = (src) => {
    const icons = { voice_agent: '🎙️', lead_webhook: '🌐', website: '🌐', referral: '🤝', manual: '✏️' };
    return icons[src] || '📋';
  };

  const LeadCard = ({ e }) => {
    const sc = STATUS_CONFIG[e.status] || STATUS_CONFIG.draft;
    return (
      <div style={{
        background: C.card, borderRadius: 10, padding: '14px 18px',
        border: `1px solid ${C.border}`, marginBottom: 8,
        borderLeft: `3px solid ${e.status === 'new' ? C.amber : sc.color}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.heading }}>{e.customerName || 'Unknown'}</span>
              <span style={{ fontSize: 16 }}>{sourceIcon(e.source)}</span>
              <span style={{
                padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                background: sc.bg, color: sc.color, textTransform: 'uppercase',
              }}>{sc.label}</span>
              {e.isPriority && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: C.red + '22', color: C.red, fontWeight: 700 }}>PRIORITY</span>}
            </div>
            <div style={{ fontSize: 12, color: C.gray }}>{e.address || '—'}</div>
            {e.serviceType && <div style={{ fontSize: 11, color: C.teal, marginTop: 2 }}>{e.serviceType?.replace(/_/g, ' ')}</div>}
            {e.description && <div style={{ fontSize: 11, color: C.gray, marginTop: 2, fontStyle: 'italic' }}>"{(e.description || '').substring(0, 80)}"</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            {e.monthlyTotal > 0 && <div style={{ fontSize: 16, fontWeight: 700, color: C.green, fontFamily: "'JetBrains Mono', monospace" }}>${e.monthlyTotal?.toFixed(0)}/mo</div>}
            <div style={{ fontSize: 10, color: C.gray, marginTop: 2 }}>{fmtDate(e.createdAt)}</div>
            {e.source && <div style={{ fontSize: 10, color: C.gray }}>{e.source?.replace(/_/g, ' ')}</div>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Summary */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 120px', background: C.card, borderRadius: 10, padding: '14px 16px', border: `1px solid ${C.border}`, textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: C.gray, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>New Leads</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.amber, fontFamily: "'JetBrains Mono', monospace" }}>{newLeads.length}</div>
        </div>
        <div style={{ flex: '1 1 120px', background: C.card, borderRadius: 10, padding: '14px 16px', border: `1px solid ${C.border}`, textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: C.gray, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>In Progress</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.teal, fontFamily: "'JetBrains Mono', monospace" }}>{inProgress.length}</div>
        </div>
        <div style={{ flex: '1 1 120px', background: C.card, borderRadius: 10, padding: '14px 16px', border: `1px solid ${C.border}`, textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: C.gray, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Resolved</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.green, fontFamily: "'JetBrains Mono', monospace" }}>{resolved.length}</div>
        </div>
      </div>

      {/* New leads section */}
      {newLeads.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.amber, marginBottom: 8 }}>{'🔔'} New — Needs Estimate ({newLeads.length})</div>
          {newLeads.map(e => <LeadCard key={e.id} e={e} />)}
        </div>
      )}

      {/* In progress */}
      {inProgress.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.teal, marginBottom: 8 }}>Sent / Viewed ({inProgress.length})</div>
          {inProgress.map(e => <LeadCard key={e.id} e={e} />)}
        </div>
      )}

      {/* Resolved */}
      {resolved.length > 0 && (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.gray, marginBottom: 8 }}>Resolved ({resolved.length})</div>
          {resolved.map(e => <LeadCard key={e.id} e={e} />)}
        </div>
      )}

      {leads.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>
          No website quotes yet. Leads from your website forms, voice agent, and referrals will appear here.
        </div>
      )}
    </div>
  );
}

// =========================================================================
// WRAPPER — tabs between Pipeline view and New Estimate tool
// =========================================================================
// PricingLogicTab replaced by PricingLogicPanel component

export default function EstimatePage() {
  const [activeTab, setActiveTab] = useState('leads');

  const tabs = [
    { key: 'leads', label: '📈 Leads' },
    { key: 'estimates', label: '📋 Estimates' },
    { key: 'new', label: '⚡ Create Estimate' },
    { key: 'pricing', label: '💰 Pricing Logic' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: C.heading }}>Pipeline</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
              padding: '10px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600,
              background: activeTab === t.key ? (t.key === 'pricing' ? C.amber : C.teal) : C.card,
              color: activeTab === t.key ? '#fff' : C.gray,
              transition: 'all 0.15s',
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {activeTab === 'leads' && <LeadsSection />}
      {activeTab === 'estimates' && <EstimatePipelineView />}
      {activeTab === 'new' && <EstimateToolView />}
      {activeTab === 'pricing' && <PricingLogicPanel />}
    </div>
  );
}
