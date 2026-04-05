import React, { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { calculateEstimate, fmt, fmtInt } from '../../lib/estimateEngine';

/* ── theme tokens ───────────────────────────────────────────── */
const C = {
  dark: '#0f1923',
  navy: '#1a2937',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  green: '#10b981',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#2563eb',
  white: '#f0f4f8',
  gray: '#94a3b8',
  input: '#0f172a',
  radius: '10px',
};

/* ── inline style helpers ───────────────────────────────────── */
const sPanel = { background: C.card, border: `1px solid ${C.border}`, borderRadius: C.radius, padding: 22, marginBottom: 18 };
const sPanelTitle = { fontSize: 15, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: C.teal, marginBottom: 18, paddingBottom: 10, borderBottom: `1px solid ${C.border}` };
const sLabel = { display: 'block', fontSize: 13, fontWeight: 600, color: C.gray, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 };
const sInput = { width: '100%', padding: '12px 14px', background: C.input, border: `1px solid ${C.border}`, borderRadius: C.radius, color: C.white, fontFamily: "'DM Sans', sans-serif", fontSize: 16, minHeight: 46, boxSizing: 'border-box', outline: 'none' };
const sSelect = { ...sInput, cursor: 'pointer', WebkitAppearance: 'none', appearance: 'none', backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 14px center', paddingRight: 36 };
const sField = { marginBottom: 16 };
const sRow = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 };
const sRow3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 };
const sCheckbox = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, cursor: 'pointer', fontSize: 15, color: C.white };
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
const sTierName = { fontWeight: 700, color: C.white, fontSize: 15 };
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
    <div style={sTierRow(recommended, dimmed)}>
      <div style={sTierName}>{name}{recommended ? ' \u2605' : ''}</div>
      <div style={sTierDetail}>{detail}</div>
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
      {options.map(o => <option key={o.value} value={o.value} style={{ background: C.input, color: C.white }}>{o.label}</option>)}
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
        .pac-container { background: #1e293b !important; border: 1px solid #334155 !important; border-radius: 8px !important; margin-top: 4px !important; z-index: 99999 !important; font-family: 'DM Sans', sans-serif !important; box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important; }
        .pac-item { padding: 8px 12px !important; border-top: 1px solid #334155 !important; color: #e2e8f0 !important; cursor: pointer !important; font-size: 14px !important; }
        .pac-item:first-child { border-top: none !important; }
        .pac-item:hover, .pac-item-selected { background: #0f172a !important; }
        .pac-item-query { color: #f0f4f8 !important; font-weight: 600 !important; }
        .pac-matched { color: #0ea5e9 !important; font-weight: 700 !important; }
        .pac-icon { display: none !important; }
        .pac-item span { color: #94a3b8 !important; }
        .pac-item-query span { color: #f0f4f8 !important; }
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

  const [estimate, setEstimate] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [lookupStatus, setLookupStatus] = useState({ type: '', msg: '' });
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [showSendForm, setShowSendForm] = useState(false);

  const token = localStorage.getItem('waves_admin_token');
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  /* ── field setter ─────────────────────────────────────────── */
  const set = useCallback((key, val) => setForm(f => ({ ...f, [key]: val })), []);
  const toggle = useCallback((key) => setForm(f => ({ ...f, [key]: !f[key] })), []);

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

      // Satellite images
      if (data.satellite) {
        setSatelliteData({
          imageUrl: data.satellite.closeUrl,
          wideUrl: data.satellite.wideUrl,
          inServiceArea: data.satellite.inServiceArea,
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
        setLookupStatus(s => ({ ...s, type: 'loading', msg: 'Calculating estimate...' }));

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
          grassType: form.grassType || 'A',
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

        const r = await fetch('/api/admin/estimator/calculate-estimate', {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ profile, selectedServices, options }),
        });
        const result = await r.json();
        if (result.error) { alert(result.error); setLookupStatus(s => ({ ...s, type: 'err', msg: result.error })); return; }
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
    if (!estimate) return;
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
      setSavedId(d.id || d.estimateId);
    } catch (e) { alert(e.message); }
    setSaving(false);
  }

  /* ── send estimate ────────────────────────────────────────── */
  async function doSend() {
    if (!savedId) { alert('Save the estimate first.'); return; }
    setSending(true);
    try {
      const r = await fetch(`/api/admin/estimates/${savedId}/send`, {
        method: 'POST', headers: authHeaders,
      });
      if (!r.ok) throw new Error('Send failed: ' + r.status);
      alert('Estimate sent!');
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
    <div style={{ background: C.dark, color: C.white, maxWidth: 1440, margin: '0 auto', padding: 28, minHeight: '100vh', fontSize: 16, fontFamily: "'DM Sans', sans-serif" }}>
      {/* HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28, paddingBottom: 18, borderBottom: `2px solid ${C.border}` }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: C.teal, margin: 0 }}>Waves Estimating Engine</h1>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: C.gray, background: C.navy, padding: '6px 14px', borderRadius: 20 }}>v1.3 — Internal Use Only</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '440px 1fr', gap: 28 }}>
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
            {satelliteData && satelliteData.imageUrl && (
              <div style={{ marginBottom: 12 }}>
                <img src={satelliteData.imageUrl} alt="Satellite view" style={{ width: '100%', borderRadius: 10, border: `1px solid ${C.border}`, marginBottom: 8 }} />
                {satelliteData.fieldVerify?.length > 0 && (
                  <div style={{ fontSize: 12, color: C.red, fontWeight: 600, padding: '6px 10px', background: 'rgba(239,68,68,0.1)', borderRadius: 6 }}>
                    Field verify: {satelliteData.fieldVerify.map(f => f.replace(/_/g, ' ')).join(', ')}
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
                { value: 'Single Family', label: 'Single Family' },
                { value: 'Townhome', label: 'Townhome / Villa' },
                { value: 'Condo', label: 'Condo' },
                { value: 'Duplex', label: 'Duplex' },
                { value: 'Commercial', label: 'Commercial' },
              ]} />
            </Field>
            <div style={sRow}>
              <Field label="Home Sq Ft"><Input k="homeSqFt" type="number" placeholder="2000" /></Field>
              <Field label="Stories"><Input k="stories" type="number" min="1" max="4" /></Field>
            </div>
            <div style={sRow}>
              <Field label="Lot Sq Ft"><Input k="lotSqFt" type="number" placeholder="8000" /></Field>
              <Field label="Bed Area (optional)"><Input k="bedArea" type="number" placeholder="Auto-estimate" /></Field>
            </div>
            <div style={sRow}>
              <Field label="Palm Count (optional)"><Input k="palmCount" type="number" placeholder="Auto" /></Field>
              <Field label="Tree Count (optional)"><Input k="treeCount" type="number" placeholder="Auto" /></Field>
            </div>
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

          {/* Services */}
          <div style={sPanel}>
            <div style={sPanelTitle}>Services to Quote</div>

            <div style={sSvcSection}>Recurring Programs</div>
            <Checkbox k="svcLawn" label="Lawn Care" />
            <Checkbox k="svcPest" label="Pest Control" />
            {form.svcPest && (
              <div style={sSubOpts}>
                <div style={sRow}>
                  <Field label="Frequency"><Select k="pestFreq" options={[{ value: '4', label: 'Quarterly (4x/yr)' }, { value: '6', label: 'Bi-Monthly (6x/yr)' }, { value: '12', label: 'Monthly (12x/yr)' }]} /></Field>
                  <Field label="Cockroach Modifier"><Select k="roachModifier" options={[{ value: 'NONE', label: 'None' }, { value: 'REGULAR', label: 'Regular (+15%)' }, { value: 'GERMAN', label: 'German ($100+15%)' }]} /></Field>
                </div>
              </div>
            )}
            <Checkbox k="svcTs" label="Tree & Shrub (Spray)" />
            <Checkbox k="svcInjection" label="Palm Injection" />
            <Checkbox k="svcMosquito" label="Mosquito Program" />
            <Checkbox k="svcTermiteBait" label="Termite Bait Stations" />
            <Checkbox k="svcRodentBait" label="Rodent Bait Stations" />

            <div style={sSvcSection}>One-Time Services</div>
            <Checkbox k="svcOnetimePest" label="One-Time Pest" />
            <Checkbox k="svcOnetimeLawn" label="One-Time Lawn Treatment" />
            {form.svcOnetimeLawn && (
              <div style={sSubOpts}>
                <Field label="Type" style={{ marginBottom: 0 }}>
                  <Select k="otLawnType" options={[{ value: 'FERT', label: 'Fertilization (base)' }, { value: 'WEED', label: 'Weed Control (+12%)' }, { value: 'PEST', label: 'Lawn Pest (+30%)' }, { value: 'FUNGICIDE', label: 'Fungicide (+38%)' }]} />
                </Field>
              </div>
            )}
            <Checkbox k="svcOnetimeMosquito" label="One-Time Mosquito" />
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
            <Checkbox k="svcTrenching" label="Termite Trenching" />
            <Checkbox k="svcBoracare" label="Bora-Care Attic" />
            {form.svcBoracare && (
              <div style={sSubOpts}>
                <Field label="Attic Sq Ft (auto-estimated from home/stories)" style={{ marginBottom: 0 }}>
                  <Input k="boracareSqft" type="number" placeholder="Auto from RentCast" />
                </Field>
              </div>
            )}
            <Checkbox k="svcPreslab" label="Pre-Slab Termidor SC" />
            {form.svcPreslab && (
              <div style={sSubOpts}>
                <div style={sRow}>
                  <Field label="Slab Sq Ft"><Input k="preslabSqft" type="number" placeholder="From footprint" /></Field>
                  <Field label="Warranty"><Select k="preslabWarranty" options={[{ value: 'BASIC', label: 'Basic 1-yr (included)' }, { value: 'EXTENDED', label: 'Extended 5-yr (+$200)' }]} /></Field>
                </div>
                <Field label="Builder Volume"><Select k="preslabVolume" options={[{ value: 'NONE', label: 'No discount' }, { value: '5', label: '5+ homes (-10%)' }, { value: '10', label: '10+ homes (-15%)' }]} /></Field>
              </div>
            )}
            <Checkbox k="svcFoam" label="Termidor Foam Drill" />
            {form.svcFoam && (
              <div style={sSubOpts}>
                <Field label="Drill Points" style={{ marginBottom: 0 }}>
                  <Select k="foamPoints" options={[{ value: '5', label: '1-5 Spot' }, { value: '10', label: '6-10 Moderate' }, { value: '15', label: '11-15 Extensive' }, { value: '20', label: '15+ Full Perimeter' }]} />
                </Field>
              </div>
            )}
            <Checkbox k="svcRodentTrap" label="Rodent Trapping" />

            <div style={sSvcSection}>Specialty Pest</div>
            <Checkbox k="svcFlea" label="Flea (2-visit)" />
            <Checkbox k="svcWasp" label="Wasp/Bee Removal" />
            <Checkbox k="svcRoach" label="Cockroach Treatment" />
            {form.svcRoach && (
              <div style={sSubOpts}>
                <Field label="Type" style={{ marginBottom: 0 }}>
                  <Select k="roachType" options={[{ value: 'REGULAR', label: 'Regular (American/Smoky Brown)' }, { value: 'GERMAN', label: 'German (3-visit)' }]} />
                </Field>
              </div>
            )}
            <Checkbox k="svcBedbug" label="Bed Bug Treatment" />
            {form.svcBedbug && (
              <div style={sSubOpts}>
                <div style={sRow}>
                  <Field label="Rooms"><Input k="bedbugRooms" type="number" min="1" max="10" /></Field>
                  <Field label="Method"><Select k="bedbugMethod" options={[{ value: 'BOTH', label: 'Quote Both' }, { value: 'CHEMICAL', label: 'Chemical Only' }, { value: 'HEAT', label: 'Heat Only' }]} /></Field>
                </div>
              </div>
            )}
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
            <button style={{ ...sBtn(C.teal, C.dark), fontSize: 16, padding: '16px 28px' }} onClick={doGenerate}>GENERATE ESTIMATE</button>
            <button style={{ ...sBtn('#3b82f6', 'white'), fontSize: 16, padding: '16px 28px' }} onClick={() => {
              if (!estimate) { doGenerate(); }
              setShowSendForm(true);
            }}>SEND ESTIMATE</button>
          </div>

          {/* Send Estimate Form */}
          {showSendForm && (
            <div style={{ ...sPanel, borderColor: C.teal }}>
              <div style={sPanelTitle}>Send Estimate to Customer</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <Field label="Customer Name"><input type="text" value={form.customerName || ''} onChange={e => set('customerName', e.target.value)} placeholder="Full name" style={sInput} /></Field>
                <Field label="Phone"><input type="tel" value={form.customerPhone || ''} onChange={e => set('customerPhone', e.target.value)} placeholder="(941) 555-1234" style={sInput} /></Field>
              </div>
              <Field label="Email"><input type="email" value={form.customerEmail || ''} onChange={e => set('customerEmail', e.target.value)} placeholder="email@example.com" style={sInput} /></Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <button style={{ ...sBtn(C.green, 'white'), fontSize: 14, padding: '14px 20px' }} onClick={async () => {
                  if (!form.customerPhone && !form.customerEmail) { alert('Enter a phone number or email.'); return; }
                  if (!estimate) { doGenerate(); }
                  await doSave();
                  setTimeout(() => doSend(), 500);
                }} disabled={sending}>{sending ? 'Sending...' : 'SEND VIA SMS & EMAIL'}</button>
                <button style={{ ...sBtn('transparent', C.gray), fontSize: 14, padding: '14px 20px', border: `1px solid ${C.border}` }} onClick={() => setShowSendForm(false)}>Cancel</button>
              </div>
            </div>
          )}

          {savedId && (
            <div style={{ fontSize: 12, color: C.green, marginBottom: 12 }}>Saved — ID #{savedId}. Estimate sent via SMS{form.customerEmail ? ' and email' : ''}.</div>
          )}
        </div>

        {/* ═══ RIGHT COLUMN: RESULTS ═══ */}
        <div>
          {!estimate ? (
            <div style={{ ...sPanel, textAlign: 'center', padding: '80px 24px' }}>
              <div style={{ fontSize: 56, marginBottom: 18 }}>&#128203;</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10, color: C.white }}>No Estimate Generated</div>
              <div style={{ fontSize: 15, color: C.gray }}>Enter property data and select services, then click Generate Estimate</div>
            </div>
          ) : (
            <div style={sPanel}>
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
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 40, marginTop: 14, flexWrap: 'wrap' }}>
                        {E.oneTime.total > 0 && (
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: C.white }}>{fmtInt(E.oneTime.total)}</div>
                            <div style={{ fontSize: 12, color: C.gray, textTransform: 'uppercase', letterSpacing: 0.5 }}>One-Time{E.oneTime.tmInstall > 0 ? ` (incl ${fmtInt(E.oneTime.tmInstall)} install)` : ''}</div>
                          </div>
                        )}
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: C.white }}>{fmt(E.totals.year1)}</div>
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
                      if (R.lawn) parts.push('Enhanced Lawn');
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
                    {E.fieldVerify.length > 0 && (
                      <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '14px 18px', marginBottom: 20, fontSize: 14, color: C.gray, lineHeight: 1.6 }}>
                        <strong style={{ color: C.red }}>Field Verify:</strong> {E.fieldVerify.join(', ')} — estimated from satellite data, tech should confirm on-site.
                      </div>
                    )}
                  </>
                )}

                {/* ── Property Summary ──────────────────── */}
                <div style={{ marginBottom: 24 }}>
                  <div style={sSectionTitle}>Property Summary</div>
                  <div style={{ fontSize: 15, color: C.gray, lineHeight: 1.8 }}>
                    <strong style={{ color: C.white }}>{E.property?.type || E.property?.propertyType || 'Residential'}</strong> — {(E.property?.homeSqFt || 0).toLocaleString()} sf / {(E.property?.lotSqFt || 0).toLocaleString()} sf lot / {E.property?.stories || 1} story<br />
                    Footprint: <strong>{(E.property?.footprint || 0).toLocaleString()} sf</strong> | Pool: {E.property?.pool === 'YES' || E.property?.pool === true ? 'Yes' : 'No'}{E.property?.poolCage === 'YES' ? ' (caged)' : ''} | Driveway: {E.property?.largeDriveway === 'YES' || E.property?.largeDriveway === true ? 'Large' : 'Normal'}<br />
                    Shrubs: {E.property?.shrubDensity || E.property?.shrubs || '--'} | Trees: {E.property?.treeDensity || E.property?.trees || '--'} | Complexity: {E.property?.landscapeComplexity || E.property?.complexity || '--'} | Water: {E.property?.nearWater && E.property.nearWater !== 'NONE' ? E.property.nearWater.replace(/_/g, ' ') : 'No'}
                    {E.property?.yearBuilt && <><br />Built: {E.property.yearBuilt} | {E.property?.constructionMaterial} | {E.property?.foundationType} foundation | {E.property?.roofType} roof</>}
                    {E.property?.serviceZone && <span style={sTag('teal')}>Zone {E.property.serviceZone}</span>}
                    {E.urgency?.label && <><br /><span style={sTag('amber')}>{E.urgency.label}</span></>}
                    {E.recurringCustomer && <span style={sTag('green')}>Recurring -15% one-time</span>}
                  </div>
                </div>

                {/* ── Recurring Programs ────────────────── */}
                {E.hasRecurring && (
                  <>
                    <div style={sGroupHeader}>Recurring Programs</div>

                    {/* Lawn */}
                    {R.lawn && (
                      <div style={{ marginBottom: 24 }}>
                        <div style={sSectionTitle}>Lawn Care <span style={sTag('blue')}>{R.lawnMeta?.lsf?.toLocaleString()} sf turf</span></div>
                        <TierGrid>
                          {R.lawn.map((t, i) => (
                            <TierRow key={i} name={t.name} detail={`${fmt(t.pa)}/app x ${t.v}${t.hasLandscape ? ' (incl landscape)' : ''}`} price={`${fmt(t.mo)}/mo`} recommended={t.recommended} dimmed={t.dimmed} />
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
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 24 }}>
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
                              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: C.white, textAlign: 'right' }}>{fmt(s.mo)}/mo</div>
                            </React.Fragment>
                          ))}
                          <div style={{ fontWeight: 700, color: C.white, borderTop: `1px solid ${C.border}`, paddingTop: 6, marginTop: 4 }}>Total before discount</div>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, borderTop: `1px solid ${C.border}`, paddingTop: 6, marginTop: 4, textAlign: 'right', color: C.white }}>{fmt(Math.round(E.recurring.annualBeforeDiscount / 12 * 100) / 100)}/mo</div>
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
                              <span>{item.name}</span>
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
          )}
        </div>
      </div>
    </div>
    </FormCtx.Provider>
  );
}

// =========================================================================
// ESTIMATES PIPELINE VIEW — list of sent estimates with status tracking
// =========================================================================
const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
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

function EstimatePipelineView() {
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    adminFetch('/admin/estimates')
      .then(d => { setEstimates(d.estimates || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>Loading estimates...</div>;

  // Stats
  const total = estimates.length;
  const sent = estimates.filter(e => e.status === 'sent').length;
  const viewed = estimates.filter(e => e.status === 'viewed').length;
  const accepted = estimates.filter(e => e.status === 'accepted').length;
  const declined = estimates.filter(e => e.status === 'declined').length;
  const totalMonthly = estimates.filter(e => e.status === 'accepted').reduce((s, e) => s + (e.monthlyTotal || 0), 0);
  const conversionRate = (sent + viewed + accepted + declined) > 0
    ? Math.round(accepted / (sent + viewed + accepted + declined) * 100) : 0;

  const filtered = filter === 'all' ? estimates : estimates.filter(e => e.status === filter);

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
      {/* Conversion Funnel */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Total', value: total, color: C.white },
          { label: 'Sent', value: sent, color: C.teal },
          { label: 'Viewed', value: viewed, color: C.amber },
          { label: 'Accepted', value: accepted, color: C.green },
          { label: 'Declined', value: declined, color: C.red },
          { label: 'Conversion', value: `${conversionRate}%`, color: C.green },
          { label: 'MRR Won', value: `$${Math.round(totalMonthly)}`, color: C.green },
        ].map((s, i) => (
          <div key={i} style={{
            flex: '1 1 120px', background: C.card, borderRadius: 10, padding: '14px 16px',
            border: `1px solid ${C.border}`, textAlign: 'center',
          }}>
            <div style={{ fontSize: 10, color: C.gray, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {['all', 'draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: filter === f ? C.teal : C.card,
            color: filter === f ? C.dark : C.gray,
            fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
          }}>{f === 'all' ? `All (${total})` : `${f} (${estimates.filter(e => e.status === f).length})`}</button>
        ))}
      </div>

      {/* Estimates List */}
      {filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: C.gray }}>
          No estimates {filter !== 'all' ? `with status "${filter}"` : 'yet'}. Create one using the New Estimate tab.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(e => {
            const sc = STATUS_CONFIG[e.status] || STATUS_CONFIG.draft;
            return (
              <div key={e.id} style={{
                background: C.card, borderRadius: 10, padding: '16px 20px',
                border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 16,
              }}>
                {/* Status badge */}
                <span style={{
                  padding: '4px 10px', borderRadius: 8, fontSize: 10, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: 0.5,
                  background: sc.bg, color: sc.color, minWidth: 70, textAlign: 'center',
                }}>{sc.label}</span>

                {/* Customer info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.white }}>{e.customerName || 'Unknown'}</span>
                    {e.source === 'lead_webhook' && <span title="Website lead" style={{ fontSize: 14 }}>{'🌐'}</span>}
                    {e.source === 'voice_agent' && <span title="Voice agent lead" style={{ fontSize: 14 }}>{'🎙️'}</span>}
                    {e.isPriority && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: C.red + '22', color: C.red, fontWeight: 700 }}>PRIORITY</span>}
                  </div>
                  <div style={{ fontSize: 12, color: C.gray, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.address || '—'}{e.serviceInterest ? ` · ${e.serviceInterest}` : ''}
                  </div>
                </div>

                {/* Tier */}
                {e.tier && (
                  <span style={{
                    padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                    background: e.tier === 'Gold' ? `${C.amber}22` : e.tier === 'Platinum' ? `${C.white}15` : `${C.teal}22`,
                    color: e.tier === 'Gold' ? C.amber : e.tier === 'Platinum' ? C.white : C.teal,
                  }}>{e.tier}</span>
                )}

                {/* Monthly */}
                <div style={{ textAlign: 'right', minWidth: 80 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.green, fontFamily: "'JetBrains Mono', monospace" }}>
                    ${e.monthlyTotal?.toFixed(0) || '0'}<span style={{ fontSize: 11, fontWeight: 400 }}>/mo</span>
                  </div>
                </div>

                {/* Timeline */}
                <div style={{ textAlign: 'right', minWidth: 100 }}>
                  <div style={{ fontSize: 11, color: C.gray }}>Created {fmtDate(e.createdAt)}</div>
                  {e.sentAt && <div style={{ fontSize: 10, color: C.teal }}>Sent {timeAgo(e.sentAt)}</div>}
                  {e.viewedAt && <div style={{ fontSize: 10, color: C.amber }}>Viewed {timeAgo(e.viewedAt)}</div>}
                  {e.acceptedAt && <div style={{ fontSize: 10, color: C.green }}>Accepted {timeAgo(e.acceptedAt)}</div>}
                </div>

                {/* Created by */}
                <div style={{ fontSize: 11, color: C.gray, minWidth: 60 }}>{e.createdBy || ''}</div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6 }}>
                  {e.status === 'draft' && (
                    <button onClick={async () => {
                      await adminFetch(`/admin/estimates/${e.id}/send`, { method: 'POST' }).catch(() => {});
                      adminFetch('/admin/estimates').then(d => setEstimates(d.estimates || []));
                    }} style={{
                      padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
                      background: C.teal, color: C.dark, fontSize: 11, fontWeight: 600,
                    }}>Send</button>
                  )}
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
              <span style={{ fontSize: 14, fontWeight: 600, color: C.white }}>{e.customerName || 'Unknown'}</span>
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
export default function EstimatePage() {
  const [activeTab, setActiveTab] = useState('pipeline');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: C.white }}>Pipeline</div>
        <button onClick={() => setActiveTab(activeTab === 'new' ? 'pipeline' : 'new')} style={{
          padding: '10px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 600,
          background: activeTab === 'new' ? C.card : C.teal,
          color: activeTab === 'new' ? C.gray : C.dark,
          transition: 'all 0.15s',
        }}>{activeTab === 'new' ? '← Back to Pipeline' : '⚡ Create Estimate'}</button>
      </div>

      {activeTab === 'pipeline' && <EstimatePipelineView />}
      {activeTab === 'new' && <EstimateToolView />}
    </div>
  );
}
