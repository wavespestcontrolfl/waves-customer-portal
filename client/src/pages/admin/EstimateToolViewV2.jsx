// client/src/pages/admin/EstimateToolViewV2.jsx
// Monochrome V2 of EstimateToolView. Strict 1:1 on state, refs, effects,
// callbacks, and API calls — all copied verbatim from V1. Only the render
// chrome is reskinned (panels -> Card, tier rows -> zinc, color accents
// collapsed to zinc ramp + alert-fg reserved for real alerts).
//
// Endpoints preserved:
//   POST /admin/estimator/property-lookup
//   POST /admin/lookup/satellite-ai
//   POST /admin/estimator/calculate-estimate
//   POST /admin/estimates           (save)
//   POST /admin/estimates/:id/send  (+ scheduledAt)
//   GET  /admin/customers?search=   (lookup + send-form lookup)
//   GET  /admin/discounts           (manual-discount presets)
//
// Monochrome rules applied:
// - All panels = Card
// - All primary buttons = Button variant="primary" (zinc-900)
// - Supporting buttons = secondary (white + hairline) or ghost
// - Status lines: "ok" => zinc, "err" => alert-fg, "loading" => zinc
// - Field-verify banners and critical confidence flags use alert-fg
// - Tier rows: selected = zinc-900 ring, recommended = zinc-900 dot,
//   dimmed = opacity-50 (no green/teal tint)
// - "Recurring -15% one-time" chip = neutral Badge
// - Manual discount panel = neutral Card
// - JetBrains Mono preserved for numeric columns via u-nums + font-mono
// - Existing customer banner = neutral Card with dot indicator
import React, {
  useState, useEffect, useRef, useCallback, useMemo, createContext, useContext, Component,
} from 'react';
import { calculateEstimate, fmt, fmtInt } from '../../lib/estimateEngine';
import { Button, Badge, Card, cn } from '../../components/ui';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

// ── Error Boundary ──────────────────────────────────────────────
class EstimateErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[EstimateToolViewV2 crash]', error, info.componentStack); }
  render() {
    if (this.state.error) {
      return (
        <Card className="p-10 text-center border-alert-fg">
          <div className="text-18 font-medium text-alert-fg mb-3">Estimate Render Error</div>
          <pre className="text-12 text-ink-secondary mb-4 whitespace-pre-wrap text-left max-h-48 overflow-auto font-mono">
            {this.state.error.message}{'\n'}{this.state.error.stack}
          </pre>
          <Button onClick={() => this.setState({ error: null })}>Try Again</Button>
        </Card>
      );
    }
    return this.props.children;
  }
}

// ── Form context + local V2 helpers ─────────────────────────────
const FormCtx = createContext({});

function FieldV2({ label, children, className }) {
  return (
    <div className={cn('mb-4', className)}>
      <label className="block text-13 font-bold text-zinc-900 tracking-normal mb-2 md:text-11 md:font-medium md:text-ink-secondary md:uppercase md:tracking-label md:mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

const INPUT_CLS =
  'w-full h-10 px-3 text-14 text-zinc-900 bg-white border-hairline border-zinc-300 ' +
  'rounded-sm u-focus-ring placeholder:text-ink-disabled';

function InputV2({ k, type = 'text', placeholder, min, max, className }) {
  const { form, set } = useContext(FormCtx);
  return (
    <input
      type={type}
      value={form[k] ?? ''}
      onChange={(e) => set(k, e.target.value)}
      placeholder={placeholder}
      min={min}
      max={max}
      className={cn(INPUT_CLS, className)}
    />
  );
}

function SelectV2({ k, options }) {
  const { form, set } = useContext(FormCtx);
  return (
    <select
      value={form[k] ?? ''}
      onChange={(e) => set(k, e.target.value)}
      className={cn(INPUT_CLS, 'cursor-pointer appearance-none pr-8 bg-no-repeat bg-[right_0.75rem_center]')}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%2371717A' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")" }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function CheckboxV2({ k, label }) {
  const { form, toggle } = useContext(FormCtx);
  const checked = !!form[k];
  return (
    <label className="flex items-center gap-2.5 mb-2.5 cursor-pointer text-14 text-zinc-900 select-none">
      <span
        className={cn(
          'flex-shrink-0 w-4 h-4 border-hairline rounded-xs flex items-center justify-center transition-colors',
          checked ? 'bg-zinc-900 border-zinc-900' : 'bg-white border-zinc-300',
        )}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M1.5 5L4 7.5L8.5 2.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => toggle(k)}
        className="sr-only"
      />
      {label}
    </label>
  );
}

// H3 — section header within a Card (e.g. "Property Lookup", "Property Data").
// Mobile: Square-style big bold non-uppercase; desktop: Montserrat 12/500 uppercase.
function PanelTitle({ children, description }) {
  return (
    <>
      <h3
        className="md:hidden text-zinc-900 mt-0 mb-2"
        style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.15 }}
      >
        {children}
      </h3>
      {description && (
        <p className="md:hidden text-14 text-zinc-600 mb-5 leading-snug">{description}</p>
      )}
      <h3
        className="hidden md:block text-zinc-900 mt-0 pb-2.5 mb-4 border-b border-hairline border-zinc-200"
        style={{
          fontFamily: "'Montserrat', sans-serif",
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: '0.02em',
        }}
      >
        {children}
      </h3>
    </>
  );
}

// H4 — sub-group header inside the Services panel (Recurring / One-Time /
// Lawn / Termite / Pest / Rodent). Same Montserrat 12/500 treatment as
// PanelTitle so the whole Create Estimate form reads as one visual family.
function SubGroupLabel({ children, className }) {
  return (
    <>
      <h4
        className={cn('md:hidden text-zinc-900 mt-5 mb-3', className)}
        style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.005em' }}
      >
        {children}
      </h4>
      <h4
        className={cn('hidden md:block text-zinc-900 mt-4 mb-2 pb-1 border-b border-hairline border-zinc-200', className)}
        style={{
          fontFamily: "'Montserrat', sans-serif",
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: '0.02em',
        }}
      >
        {children}
      </h4>
    </>
  );
}

function StatusLine({ status }) {
  if (!status?.type) return null;
  const isErr = status.type === 'err';
  return (
    <div
      className={cn(
        'font-mono text-12 px-3 py-2 rounded-xs mb-3 whitespace-pre-line border-hairline',
        isErr ? 'bg-alert-bg text-alert-fg border-alert-fg' : 'bg-zinc-50 text-ink-secondary border-zinc-200',
      )}
    >
      {status.msg}
    </div>
  );
}

// Tier grid + row (monochrome).
function TierGridV2({ children }) {
  return <div className="grid gap-2">{children}</div>;
}

function TierRowV2({ name, detail, price, recommended, dimmed, onSelect, selected }) {
  const clickable = !!onSelect;
  return (
    <div
      onClick={onSelect}
      title={clickable ? 'Click to select this frequency' : undefined}
      className={cn(
        'grid items-center rounded-sm transition-colors px-4 py-3 border-hairline',
        'grid-cols-[120px_1fr_110px] gap-3',
        selected ? 'bg-zinc-50 border-zinc-900 ring-2 ring-zinc-900' : 'bg-white border-zinc-200',
        clickable ? 'cursor-pointer hover:bg-zinc-50' : 'cursor-default',
        dimmed && !selected ? 'opacity-50' : '',
      )}
    >
      <div className="text-14 font-medium text-zinc-900 flex items-center gap-1.5">
        {name}
        {selected && <span className="text-11 u-nums">✓</span>}
        {!selected && recommended && <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-900" title="Recommended" />}
      </div>
      <div className="font-mono text-12 text-ink-secondary break-words">{detail}</div>
      <div className="font-mono text-14 font-medium text-zinc-900 text-right u-nums">{price}</div>
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="inline-block text-11 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-zinc-100 text-ink-secondary ml-2 align-middle">
      {children}
    </span>
  );
}

function FieldVerifyTag({ children }) {
  return (
    <span className="inline-block text-11 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-alert-bg text-alert-fg ml-2 align-middle font-mono">
      {children}
    </span>
  );
}

function DiscBadge({ children }) {
  return (
    <span className="inline-block text-11 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-zinc-900 text-white ml-2 align-middle font-mono u-nums">
      {children}
    </span>
  );
}

function GroupHeader({ children }) {
  return (
    <div className="text-22 font-bold tracking-tight text-zinc-900 mt-7 mb-3 md:text-12 md:font-medium md:uppercase md:tracking-label md:mb-4 md:pb-2 md:border-b-hairline md:border-zinc-300">
      {children}
    </div>
  );
}

function SectionTitle({ children, className }) {
  return (
    <div className={cn('text-14 font-medium uppercase tracking-label text-zinc-900 mb-3', className)}>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT — EstimateToolViewV2
// State, refs, effects, callbacks all copied verbatim from V1.
// ═══════════════════════════════════════════════════════════════
export default function EstimateToolViewV2({ initialAddress = '' } = {}) {
  // ── Google Maps script (verbatim from V1) ─────────────────────
  const addressRef = useRef(null);
  const autocompleteRef = useRef(null);

  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || 'AIzaSyCvzQ84QWUKMby5YcbM8MhDBlEZ2oF7Bsk';
    if (!apiKey) return;

    if (!document.getElementById('pac-dark-style')) {
      const style = document.createElement('style');
      style.id = 'pac-dark-style';
      style.textContent = `
        .pac-container { background: #FFFFFF !important; border: 1px solid #E4E4E7 !important; border-radius: 4px !important; margin-top: 4px !important; z-index: 99999 !important; font-family: 'Inter', sans-serif !important; box-shadow: 0 8px 24px rgba(0,0,0,0.1) !important; }
        .pac-item { padding: 8px 12px !important; border-top: 1px solid #E4E4E7 !important; color: #3F3F46 !important; cursor: pointer !important; font-size: 14px !important; }
        .pac-item:first-child { border-top: none !important; }
        .pac-item:hover, .pac-item-selected { background: #FAFAFA !important; }
        .pac-item-query { color: #18181B !important; font-weight: 500 !important; }
        .pac-matched { color: #18181B !important; font-weight: 500 !important; }
        .pac-icon { display: none !important; }
        .pac-item span { color: #71717A !important; }
        .pac-item-query span { color: #18181B !important; }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function initAutocomplete() {
    if (!addressRef.current || !window.google?.maps?.places) return;
    if (autocompleteRef.current) return;
    const ac = new window.google.maps.places.Autocomplete(addressRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
      fields: ['formatted_address', 'address_components', 'geometry'],
    });
    ac.addListener('place_changed', () => {
      const p = ac.getPlace();
      if (p && p.formatted_address) {
        setForm((f) => ({ ...f, address: p.formatted_address }));
      }
    });
    autocompleteRef.current = ac;
  }

  // ── form state (verbatim from V1) ─────────────────────────────
  const [form, setForm] = useState({
    address: initialAddress || '',
    homeSqFt: '', stories: '1', lotSqFt: '', propertyType: 'Single Family',
    hasPool: 'NO', hasPoolCage: 'NO', hasLargeDriveway: 'NO',
    shrubDensity: 'MODERATE', treeDensity: 'MODERATE', landscapeComplexity: 'MODERATE',
    nearWater: 'NO', urgency: 'ROUTINE', isAfterHours: 'NO', isRecurringCustomer: 'NO',
    bedArea: '', palmCount: '', treeCount: '',
    roachModifier: 'NONE', lawnFreq: '9', pestFreq: '4', plugArea: '', plugSpacing: '12',
    manualDiscountPreset: '', manualDiscountType: 'NONE', manualDiscountValue: '', manualDiscountLabel: '',
    grassType: 'st_augustine',
    otLawnType: 'FERT',
    exclSimple: '0', exclModerate: '0', exclAdvanced: '0', exclWaive: 'NO',
    bedbugRooms: '1', bedbugMethod: 'BOTH',
    boracareSqft: '', preslabSqft: '', preslabWarranty: 'BASIC', preslabVolume: 'NONE',
    foamPoints: '5', roachType: 'REGULAR',
    svcLawn: true, svcPest: true, svcTs: false, svcInjection: false, svcMosquito: false,
    svcTermiteBait: false, svcRodentBait: false,
    svcOnetimePest: false, svcOnetimeLawn: false, svcOnetimeMosquito: false,
    svcPlugging: false, svcTopdress: false, svcDethatch: false, svcTrenching: false,
    svcBoracare: false, svcPreslab: false, svcFoam: false, svcRodentTrap: false,
    svcFlea: false, svcWasp: false, svcRoach: false, svcBedbug: false, svcExclusion: false,
  });

  // ── live preview (verbatim from V1) ───────────────────────────
  const livePreview = useMemo(() => {
    const recurringKeys = ['svcLawn', 'svcPest', 'svcTs', 'svcInjection', 'svcMosquito', 'svcTermiteBait', 'svcRodentBait'];
    const recurringCount = recurringKeys.filter((k) => form[k]).length;

    const tierMap = { 0: { name: 'None', discount: 0 }, 1: { name: 'Bronze', discount: 0 }, 2: { name: 'Silver', discount: 0.10 }, 3: { name: 'Gold', discount: 0.15 } };
    const tier = recurringCount >= 4 ? { name: 'Platinum', discount: 0.18 } : (tierMap[recurringCount] || tierMap[0]);

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

    const onetimeKeys = ['svcOnetimePest', 'svcOnetimeLawn', 'svcOnetimeMosquito', 'svcPlugging', 'svcTopdress', 'svcDethatch', 'svcTrenching', 'svcBoracare', 'svcPreslab', 'svcFoam', 'svcRodentTrap', 'svcFlea', 'svcWasp', 'svcRoach', 'svcBedbug', 'svcExclusion'];
    const onetimeCount = onetimeKeys.filter((k) => form[k]).length;
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
  const token = localStorage.getItem('waves_admin_token');
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const set = useCallback((key, val) => setForm((f) => ({ ...f, [key]: val })), []);
  const toggle = useCallback((key) => {
    setForm((f) => ({ ...f, [key]: !f[key] }));
    if (key.startsWith('svc')) { setEstimate(null); setSavedId(null); }
  }, []);

  const searchSendCustomers = useCallback(async (q) => {
    if (!q || q.length < 2) { setSendCustomerResults([]); return; }
    try {
      const r = await fetch(`/api/admin/customers?search=${encodeURIComponent(q)}&limit=5`, { headers: authHeaders });
      if (r.ok) { const d = await r.json(); setSendCustomerResults(d.customers || d || []); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // auto-estimate attic / preslab
  useEffect(() => {
    const sqft = Number(form.homeSqFt) || 0;
    const st = Math.max(1, Number(form.stories) || 1);
    if (sqft > 0) {
      const attic = Math.round(sqft / st * 0.85);
      const fp = Math.round(sqft / st);
      setForm((f) => {
        const upd = {};
        if (!f.boracareSqft || f._boracareAuto) upd.boracareSqft = String(attic);
        if (!f.preslabSqft || f._preslabAuto) upd.preslabSqft = String(fp);
        if (Object.keys(upd).length === 0) return f;
        return { ...f, ...upd, _boracareAuto: true, _preslabAuto: true };
      });
    }
  }, [form.homeSqFt, form.stories]);

  const searchCustomers = useCallback(async (q) => {
    if (!q || q.length < 2) { setCustomers([]); return; }
    try {
      const r = await fetch(`/api/admin/customers?search=${encodeURIComponent(q)}`, { headers: authHeaders });
      if (r.ok) { const d = await r.json(); setCustomers(d.customers || d || []); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerSearch]);

  const [enrichedProfile, setEnrichedProfile] = useState(null);
  const [existingCustomerMatch, setExistingCustomerMatch] = useState(null);
  const [satelliteStatus, setSatelliteStatus] = useState({ type: '', msg: '' });
  const [satelliteData, setSatelliteData] = useState(null);

  const [discountPresets, setDiscountPresets] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await adminFetch('/admin/discounts');
        if (!r.ok) return;
        const rows = await r.json();
        const manual = (rows || []).filter((d) => d.is_active && !d.is_auto_apply);
        setDiscountPresets(manual);
      } catch { /* ignore */ }
    })();
  }, []);

  function applyDiscountPreset(key) {
    if (key === '__custom__' || !key) {
      setForm((f) => ({ ...f, manualDiscountPreset: key || '' }));
      return;
    }
    const d = discountPresets.find((x) => x.discount_key === key);
    if (!d) return;
    setForm((f) => ({
      ...f,
      manualDiscountPreset: key,
      manualDiscountType: d.discount_type === 'percentage' ? 'PERCENT' : 'FIXED',
      manualDiscountValue: String(d.amount || 0),
      manualDiscountLabel: `${d.icon || ''} ${d.name}`.trim(),
    }));
  }

  async function doLookup() {
    const address = form.address.trim();
    if (!address) { setLookupStatus({ type: 'err', msg: 'Enter an address' }); return; }
    setLookupStatus({ type: 'loading', msg: 'Looking up property... (RentCast + AI Satellite Analysis)' });
    setSatelliteStatus({ type: 'loading', msg: 'Running AI satellite analysis...' });
    try {
      const r = await fetch('/api/admin/estimator/property-lookup', {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ address }),
      });
      if (!r.ok) throw new Error('API ' + r.status);
      const data = await r.json();

      if (data.errors?.length > 0 && !data.enriched) {
        setLookupStatus({ type: 'err', msg: data.errors.map((e) => e.message).join(', ') });
        setSatelliteStatus({ type: '', msg: '' });
        return;
      }

      const ep = data.enriched;
      setEnrichedProfile(ep);

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

      setForm((f) => ({ ...f, ...upd, _boracareAuto: true, _preslabAuto: true }));

      try {
        const addrSearch = address.split(',')[0].trim();
        const custR = await fetch(`/api/admin/customers?search=${encodeURIComponent(addrSearch)}&limit=3`, { headers: authHeaders });
        if (custR.ok) {
          const custData = await custR.json();
          const custs = custData.customers || custData || [];
          const match = custs.find((c) => c.address && address.toLowerCase().includes(c.address.split(',')[0].trim().toLowerCase()));
          if (match) {
            setExistingCustomerMatch(match);
            const hasActivePlan = match.tier && match.tier !== 'null' && match.monthlyRate > 0;
            setForm((f) => ({
              ...f,
              isRecurringCustomer: hasActivePlan ? 'YES' : 'NO',
              customerName: `${match.firstName || ''} ${match.lastName || ''}`.trim(),
              customerPhone: match.phone || f.customerPhone || '',
              customerEmail: match.email || f.customerEmail || '',
            }));
          } else {
            setExistingCustomerMatch(null);
          }
        }
      } catch { /* ignore customer lookup errors */ }

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

  async function doSatelliteAnalysis() {
    const address = form.address.trim();
    if (!address) { setSatelliteStatus({ type: 'err', msg: 'Enter an address first' }); return; }
    setSatelliteStatus({ type: 'loading', msg: 'Analyzing satellite imagery with AI...' });
    setSatelliteData(null);
    try {
      const r = await fetch('/api/admin/lookup/satellite-ai', {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ address }),
      });
      const data = await r.json();
      if (data.error) { setSatelliteStatus({ type: 'err', msg: data.error }); return; }

      setSatelliteData(data);

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

      setForm((f) => ({ ...f, ...upd }));

      const verify = (data.fieldVerify || []).length;
      const conf = data.confidence === 'high' ? 'HIGH' : data.confidence === 'medium' ? 'MEDIUM' : 'LOW';
      setSatelliteStatus({
        type: 'ok',
        msg: `AI Analysis complete — Confidence: ${conf} (${data.agreementPct || '?'}% model agreement)${verify > 0 ? ` · ${verify} field(s) flagged for field verification` : ''}`,
      });
    } catch (e) {
      setSatelliteStatus({ type: 'err', msg: e.message });
    }
  }

  async function doGenerate(overrides = {}) {
    if (enrichedProfile) {
      try {
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

        const manualDiscountType = overrides.manualDiscountType ?? form.manualDiscountType;
        const manualDiscountValue = Number(overrides.manualDiscountValue ?? form.manualDiscountValue) || 0;
        const manualDiscount = (manualDiscountType && manualDiscountType !== 'NONE' && manualDiscountValue > 0)
          ? { type: manualDiscountType, value: manualDiscountValue, label: form.manualDiscountLabel || '' }
          : null;

        const options = {
          grassType: form.grassType || 'st_augustine',
          lawnFreq: parseInt(overrides.lawnFreq ?? form.lawnFreq) || 9,
          pestFreq: parseInt(overrides.pestFreq ?? form.pestFreq) || 4,
          manualDiscount,
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

        const profile = { ...enrichedProfile };
        if (form.homeSqFt) profile.homeSqFt = parseInt(form.homeSqFt);
        if (form.lotSqFt) profile.lotSqFt = parseInt(form.lotSqFt);
        if (form.stories) profile.stories = parseInt(form.stories);
        if (form.bedArea) profile.estimatedBedAreaSf = parseInt(form.bedArea);
        if (form.palmCount) profile.estimatedPalmCount = parseInt(form.palmCount);
        if (form.treeCount) profile.estimatedTreeCount = parseInt(form.treeCount);
        profile.footprint = Math.round(profile.homeSqFt / (profile.stories || 1));
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
        if (result.error) { alert(result.error); setLookupStatus((s) => ({ ...s, type: 'err', msg: result.error })); return; }

        if (!result.modifiers) {
          const p = result.property || profile || {};
          const mods = [];
          const add = (svc, label, impact, type) => mods.push({ service: svc, label, impact, type });
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
          else if (sd === 'MODERATE') add('pest', 'Moderate shrubs: +$5/visit', 5, 'up');
          else if (sd === 'LIGHT') add('pest', 'Light shrubs: -$5/visit', -5, 'down');
          else add('pest', 'Shrubs: not specified', 0, 'info');
          const td = p.treeDensity || p.trees;
          if (td === 'HEAVY') add('pest', 'Heavy trees: +$10/visit', 10, 'up');
          else if (td === 'MODERATE') add('pest', 'Moderate trees: +$5/visit', 5, 'up');
          else if (td === 'LIGHT') add('pest', 'Light trees: -$5/visit', -5, 'down');
          else add('pest', 'Trees: not specified', 0, 'info');
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
        setLookupStatus((s) => ({ ...s, type: 'ok' }));
      } catch (e) {
        alert('Estimate calculation failed: ' + e.message);
      }
      return;
    }

    const yesNo = (v) => v === 'YES' || v === true;
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

  async function doSend(id, method) {
    const useId = id || savedId;
    if (!useId) { alert('Save the estimate first.'); return; }
    const sendMethod = method || 'both';
    let scheduled = null;
    if (form.scheduleSend) {
      if (!form.scheduledAt) { alert('Pick a send time.'); return; }
      const when = new Date(form.scheduledAt);
      if (isNaN(when.getTime())) { alert('Invalid send time.'); return; }
      if (when <= new Date()) { alert('Send time must be in the future.'); return; }
      scheduled = form.scheduledAt;
    }
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
      } else if (d.channels) {
        const parts = [];
        if (d.channels.sms) parts.push(d.channels.sms.ok ? 'SMS sent' : `SMS failed: ${d.channels.sms.error}`);
        if (d.channels.email) parts.push(d.channels.email.ok ? 'Email sent' : `Email failed: ${d.channels.email.error}`);
        const anyFail = (d.channels.sms && !d.channels.sms.ok) || (d.channels.email && !d.channels.email.ok);
        alert((anyFail ? 'Send had issues: ' : 'Sent: ') + parts.join(' / '));
      } else {
        alert(`Estimate sent via ${label}!`);
      }
    } catch (e) { alert(e.message); }
    setSending(false);
  }

  function nextEstimate() {
    setForm((f) => ({
      ...f,
      address: '', homeSqFt: '', stories: '1', lotSqFt: '', propertyType: 'Single Family',
      hasPool: 'NO', hasPoolCage: 'NO', hasLargeDriveway: 'NO', nearWater: 'NO',
      shrubDensity: 'MODERATE', treeDensity: 'MODERATE', landscapeComplexity: 'MODERATE',
      urgency: 'ROUTINE', isAfterHours: 'NO', isRecurringCustomer: 'NO',
      bedArea: '', palmCount: '', treeCount: '',
      boracareSqft: '', preslabSqft: '',
      customerName: '', customerPhone: '', customerEmail: '',
      _boracareAuto: false, _preslabAuto: false,
    }));
    setEstimate(null);
    setSavedId(null);
    setShowSendForm(false);
    setLookupStatus({ type: '', msg: '' });
    setEnrichedProfile(null);
    setExistingCustomerMatch(null);
    setSatelliteStatus({ type: '', msg: '' });
    setSatelliteData(null);
    setCustomerSearch('');
    setCustomers([]);
  }

  async function saveAndSend(method) {
    if (!estimate) { alert('Click "Generate Estimate" first.'); return; }
    if (form.scheduleSend) {
      if (!form.scheduledAt) { alert('Pick a send time.'); return; }
      const when = new Date(form.scheduledAt);
      if (isNaN(when.getTime()) || when <= new Date()) {
        alert('Send time must be a valid future date/time.');
        return;
      }
    }
    const id = savedId || await doSave();
    if (id) await doSend(id, method);
  }

  const E = estimate;
  const R = E?.results || {};
  const formCtx = { form, set, toggle };

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  return (
    <FormCtx.Provider value={formCtx}>
      <div className="max-w-[1440px] mx-auto px-4 md:px-7 pb-7">
        <div className="grid gap-7 grid-cols-1 lg:grid-cols-[440px_1fr]">
          {/* ═══ LEFT COLUMN: FORM ═══ */}
          <div className="space-y-4">
            {/* Property Lookup */}
            <Card className="p-5">
              <PanelTitle>Property Lookup</PanelTitle>
              <FieldV2 label="Address">
                <input
                  ref={addressRef}
                  type="text"
                  value={form.address}
                  onChange={(e) => set('address', e.target.value)}
                  placeholder="Start typing an address..."
                  className={INPUT_CLS}
                />
              </FieldV2>
              <StatusLine status={lookupStatus} />
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Button onClick={doLookup} variant="primary" size="md">Property Lookup</Button>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    setForm((f) => ({
                      ...f, address: '', homeSqFt: '', lotSqFt: '', stories: '1', propertyType: 'Single Family',
                      hasPool: 'NO', hasPoolCage: 'NO', hasLargeDriveway: 'NO',
                      shrubDensity: 'MODERATE', treeDensity: 'MODERATE', landscapeComplexity: 'MODERATE',
                      nearWater: 'NO', bedArea: '', palmCount: '', treeCount: '',
                    }));
                    setLookupStatus({ type: '', msg: '' });
                    setSatelliteStatus({ type: '', msg: '' });
                    setSatelliteData(null);
                    setEstimate(null);
                  }}
                >
                  Clear All
                </Button>
              </div>
              <StatusLine status={satelliteStatus} />
              {enrichedProfile?.fieldVerifyFlags?.length > 0 && (
                <div className="mb-2.5 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs">
                  {enrichedProfile.fieldVerifyFlags.map((flag, i) => (
                    <div key={i} className="text-12 text-alert-fg">
                      ⚠ {typeof flag === 'string' ? flag.replace(/_/g, ' ') : (flag.field || flag.name || '').replace(/_/g, ' ')}
                      {flag.reason ? ` — ${flag.reason}` : ''}
                    </div>
                  ))}
                </div>
              )}
              {existingCustomerMatch && (
                <div className="mb-2.5 px-3 py-2 bg-zinc-50 border-hairline border-zinc-300 rounded-xs text-12 text-zinc-900">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-900 mr-1.5 align-middle" />
                  Existing customer: <strong>{existingCustomerMatch.firstName} {existingCustomerMatch.lastName}</strong>
                  {existingCustomerMatch.tier && existingCustomerMatch.tier !== 'null' ? ` · WaveGuard ${existingCustomerMatch.tier}` : ' · No active plan'}
                  {existingCustomerMatch.tier && existingCustomerMatch.tier !== 'null' && existingCustomerMatch.monthlyRate > 0 ? ' · 15% loyalty discount applied' : ''}
                </div>
              )}
              {satelliteData && (satelliteData.imageUrl || satelliteData.closeUrl) && (
                <div className="mb-3">
                  <div className="grid grid-cols-4 gap-1 mb-2">
                    {satelliteData.ultraCloseUrl && (
                      <div>
                        <img src={satelliteData.ultraCloseUrl} alt="Ultra close" className="w-full rounded-xs border border-zinc-900 aspect-square object-cover" />
                        <div className="text-11 text-zinc-900 text-center mt-0.5 font-medium uppercase tracking-label">Ultra</div>
                      </div>
                    )}
                    {satelliteData.superCloseUrl && (
                      <div>
                        <img src={satelliteData.superCloseUrl} alt="Super close" className="w-full rounded-xs border-hairline border-zinc-300 aspect-square object-cover" />
                        <div className="text-11 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">Detail</div>
                      </div>
                    )}
                    <div>
                      <img src={satelliteData.closeUrl || satelliteData.imageUrl} alt="Close view" className="w-full rounded-xs border-hairline border-zinc-300 aspect-square object-cover" />
                      <div className="text-11 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">Property</div>
                    </div>
                    {satelliteData.wideUrl && (
                      <div>
                        <img src={satelliteData.wideUrl} alt="Area view" className="w-full rounded-xs border-hairline border-zinc-300 aspect-square object-cover" />
                        <div className="text-11 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">Area</div>
                      </div>
                    )}
                  </div>
                  {satelliteData.aiSources && (
                    <div className="text-11 text-ink-secondary mb-1">
                      AI Analysis: {satelliteData.aiSources.join(' + ')} {satelliteData.aiSources.length > 1 ? '(dual-model)' : ''}
                    </div>
                  )}
                  {satelliteData.fieldVerify?.length > 0 && (
                    <div className="text-12 text-alert-fg font-medium px-3 py-1.5 bg-alert-bg rounded-xs">
                      Field verify: {satelliteData.fieldVerify.map((f) => typeof f === 'string' ? f.replace(/_/g, ' ') : (f.field || '')).join(', ')}
                    </div>
                  )}
                  {satelliteData.notes && (
                    <div className="text-11 text-ink-tertiary mt-1 italic">{satelliteData.notes}</div>
                  )}
                </div>
              )}
            </Card>

            {/* Property Data */}
            <Card className="p-5">
              <PanelTitle>Property Data</PanelTitle>
              <FieldV2 label="Property Type">
                <SelectV2 k="propertyType" options={[
                  { value: 'Single Family', label: 'Single Family ($0)' },
                  { value: 'Townhome', label: 'Townhome — End Unit (-$8)' },
                  { value: 'Townhome Interior', label: 'Townhome — Interior Unit (-$15)' },
                  { value: 'Duplex', label: 'Duplex (-$10)' },
                  { value: 'Condo', label: 'Condo — Ground Floor (-$20)' },
                  { value: 'Condo Upper', label: 'Condo — Upper Floor (-$25)' },
                  { value: 'Commercial', label: 'Commercial' },
                ]} />
              </FieldV2>
              <div className="grid grid-cols-2 gap-3">
                <FieldV2 label="Home Sq Ft"><InputV2 k="homeSqFt" type="number" placeholder="2000" /></FieldV2>
                <FieldV2 label="Stories"><InputV2 k="stories" type="number" min="1" max="4" /></FieldV2>
              </div>
              <FieldV2 label="Lot Sq Ft"><InputV2 k="lotSqFt" type="number" placeholder="8000" /></FieldV2>
              {form.svcTs && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Bed Area (sq ft)"><InputV2 k="bedArea" type="number" placeholder="Auto-estimate" /></FieldV2>
                    <FieldV2 label="Palm Count"><InputV2 k="palmCount" type="number" placeholder="Auto" /></FieldV2>
                  </div>
                  <FieldV2 label="Tree Count"><InputV2 k="treeCount" type="number" placeholder="Auto" /></FieldV2>
                </>
              )}
            </Card>

            {/* Property Features */}
            <Card className="p-5">
              <PanelTitle>Property Features</PanelTitle>
              <div className="grid grid-cols-3 gap-3">
                <FieldV2 label="Pool"><SelectV2 k="hasPool" options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} /></FieldV2>
                <FieldV2 label="Pool Cage"><SelectV2 k="hasPoolCage" options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} /></FieldV2>
                <FieldV2 label="Large Driveway"><SelectV2 k="hasLargeDriveway" options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} /></FieldV2>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <FieldV2 label="Shrub Density"><SelectV2 k="shrubDensity" options={[{ value: 'LIGHT', label: 'Light' }, { value: 'MODERATE', label: 'Moderate' }, { value: 'HEAVY', label: 'Heavy' }]} /></FieldV2>
                <FieldV2 label="Tree Density"><SelectV2 k="treeDensity" options={[{ value: 'LIGHT', label: 'Light' }, { value: 'MODERATE', label: 'Moderate' }, { value: 'HEAVY', label: 'Heavy' }]} /></FieldV2>
                <FieldV2 label="Complexity"><SelectV2 k="landscapeComplexity" options={[{ value: 'SIMPLE', label: 'Simple' }, { value: 'MODERATE', label: 'Moderate' }, { value: 'COMPLEX', label: 'Complex' }]} /></FieldV2>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FieldV2 label="Near Water"><SelectV2 k="nearWater" options={[{ value: 'NO', label: 'No' }, { value: 'YES', label: 'Yes' }]} /></FieldV2>
                <FieldV2 label="Urgency"><SelectV2 k="urgency" options={[{ value: 'ROUTINE', label: 'Routine' }, { value: 'SOON', label: 'Soon (same/next day)' }, { value: 'URGENT', label: 'Urgent (within 12 hrs)' }]} /></FieldV2>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FieldV2 label="After Hours"><SelectV2 k="isAfterHours" options={[{ value: 'NO', label: 'No — business hours' }, { value: 'YES', label: 'Yes — evenings/weekends/holidays' }]} /></FieldV2>
                <FieldV2 label="Recurring Customer"><SelectV2 k="isRecurringCustomer" options={[{ value: 'NO', label: 'No — new customer' }, { value: 'YES', label: 'Yes — 15% off one-time' }]} /></FieldV2>
              </div>
            </Card>

            {/* Services */}
            <Card className="p-5">
              <PanelTitle>Services to Quote</PanelTitle>

              <SubGroupLabel>Recurring Programs</SubGroupLabel>
              <CheckboxV2 k="svcLawn" label="Lawn Care" />
              {form.svcLawn && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <FieldV2 label="Grass Type / Track" className="mb-0">
                    <SelectV2 k="grassType" options={[
                      { value: 'st_augustine', label: 'St. Augustine' },
                      { value: 'bermuda', label: 'Bermuda' },
                      { value: 'zoysia', label: 'Zoysia' },
                      { value: 'bahia', label: 'Bahia' },
                    ]} />
                  </FieldV2>
                </div>
              )}
              <CheckboxV2 k="svcPest" label="Pest Control" />
              {form.svcPest && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Frequency"><SelectV2 k="pestFreq" options={[{ value: '4', label: 'Quarterly (4x/yr)' }, { value: '6', label: 'Bi-Monthly (6x/yr)' }, { value: '12', label: 'Monthly (12x/yr)' }]} /></FieldV2>
                    <FieldV2 label="Cockroach Modifier"><SelectV2 k="roachModifier" options={[{ value: 'NONE', label: 'None' }, { value: 'REGULAR', label: 'Regular (+15%)' }, { value: 'GERMAN', label: 'German ($100+15%)' }]} /></FieldV2>
                  </div>
                </div>
              )}
              <CheckboxV2 k="svcTs" label="Tree & Shrub" />
              <CheckboxV2 k="svcInjection" label="Palm Injection" />
              <CheckboxV2 k="svcMosquito" label="Mosquito Program" />
              <CheckboxV2 k="svcTermiteBait" label="Termite Bait Stations" />
              <CheckboxV2 k="svcRodentBait" label="Rodent Bait Stations" />

              {livePreview.recurringCount > 0 && (
                <div className="mt-3 mb-1.5 px-3 py-2 rounded-xs bg-zinc-50 border-hairline border-zinc-300 text-12 text-zinc-900">
                  {livePreview.recurringCount} service{livePreview.recurringCount > 1 ? 's' : ''} selected →{' '}
                  <strong>WaveGuard {livePreview.tier.name}</strong>
                  {livePreview.tier.discount > 0 ? ` (${Math.round(livePreview.tier.discount * 100)}% bundle discount)` : ' (no discount — add 1 more for Silver 10%)'}
                </div>
              )}

              <SubGroupLabel>One-Time Services</SubGroupLabel>

              <SubGroupLabel className="mt-3 text-ink-tertiary">Lawn</SubGroupLabel>
              <CheckboxV2 k="svcOnetimeLawn" label="Lawn Treatment" />
              {form.svcOnetimeLawn && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <FieldV2 label="Type" className="mb-0">
                    <SelectV2 k="otLawnType" options={[{ value: 'FERT', label: 'Fertilization (base)' }, { value: 'WEED', label: 'Weed Control (+12%)' }, { value: 'PEST', label: 'Lawn Pest (+30%)' }, { value: 'FUNGICIDE', label: 'Fungicide (+38%)' }]} />
                  </FieldV2>
                </div>
              )}
              <CheckboxV2 k="svcPlugging" label="Lawn Plugging" />
              {form.svcPlugging && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Plug Area (sq ft)"><InputV2 k="plugArea" type="number" placeholder="e.g. 1000" /></FieldV2>
                    <FieldV2 label="Spacing"><SelectV2 k="plugSpacing" options={[{ value: '12', label: '12" Economy' }, { value: '9', label: '9" Standard' }, { value: '6', label: '6" Premium' }]} /></FieldV2>
                  </div>
                </div>
              )}
              <CheckboxV2 k="svcTopdress" label="Top Dressing" />
              <CheckboxV2 k="svcDethatch" label="Dethatching" />
              <CheckboxV2 k="svcOverseed" label="Overseeding" />

              <SubGroupLabel className="mt-3 text-ink-tertiary">Termite</SubGroupLabel>
              <CheckboxV2 k="svcTrenching" label="Termite Trenching" />
              <CheckboxV2 k="svcBoracare" label="Termite Attic Remediation" />
              {form.svcBoracare && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <FieldV2 label="Attic Sq Ft (auto-estimated from home/stories)" className="mb-0">
                    <InputV2 k="boracareSqft" type="number" placeholder="Auto from RentCast" />
                  </FieldV2>
                </div>
              )}
              <CheckboxV2 k="svcPreslab" label="Pre-Slab Termite Treatment" />
              {form.svcPreslab && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Slab Sq Ft"><InputV2 k="preslabSqft" type="number" placeholder="From footprint" /></FieldV2>
                    <FieldV2 label="Warranty"><SelectV2 k="preslabWarranty" options={[{ value: 'BASIC', label: 'Basic 1-yr (included)' }, { value: 'EXTENDED', label: 'Extended 5-yr (+$200)' }]} /></FieldV2>
                  </div>
                  <FieldV2 label="Builder Volume"><SelectV2 k="preslabVolume" options={[{ value: 'NONE', label: 'No discount' }, { value: '5', label: '5+ homes (-10%)' }, { value: '10', label: '10+ homes (-15%)' }]} /></FieldV2>
                </div>
              )}
              <CheckboxV2 k="svcFoam" label="Termite Foam Treatment" />
              {form.svcFoam && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <FieldV2 label="Drill Points" className="mb-0">
                    <SelectV2 k="foamPoints" options={[{ value: '5', label: '1-5 Spot' }, { value: '10', label: '6-10 Moderate' }, { value: '15', label: '11-15 Extensive' }, { value: '20', label: '15+ Full Perimeter' }]} />
                  </FieldV2>
                </div>
              )}

              <SubGroupLabel className="mt-3 text-ink-tertiary">Pest</SubGroupLabel>
              <CheckboxV2 k="svcOnetimePest" label="Pest Treatment" />
              <CheckboxV2 k="svcOnetimeMosquito" label="Mosquito Treatment" />
              <CheckboxV2 k="svcFlea" label="Flea Treatment" />
              <CheckboxV2 k="svcRoach" label="Cockroach Treatment" />
              {form.svcRoach && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <FieldV2 label="Type" className="mb-0">
                    <SelectV2 k="roachType" options={[{ value: 'REGULAR', label: 'Regular (American/Smoky Brown)' }, { value: 'GERMAN', label: 'German (3-visit)' }]} />
                  </FieldV2>
                </div>
              )}
              <CheckboxV2 k="svcWasp" label="Wasp/Bee/Stinging Insect" />
              <CheckboxV2 k="svcBedbug" label="Bed Bug Treatment" />
              {form.svcBedbug && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Rooms"><InputV2 k="bedbugRooms" type="number" min="1" max="10" /></FieldV2>
                    <FieldV2 label="Method"><SelectV2 k="bedbugMethod" options={[{ value: 'BOTH', label: 'Quote Both' }, { value: 'CHEMICAL', label: 'Chemical Only' }, { value: 'HEAT', label: 'Heat Only' }]} /></FieldV2>
                  </div>
                </div>
              )}

              <SubGroupLabel className="mt-3 text-ink-tertiary">Rodent</SubGroupLabel>
              <CheckboxV2 k="svcRodentTrap" label="Rodent Trapping" />
              <CheckboxV2 k="svcRodentSanitation" label="Rodent Sanitation" />
              <CheckboxV2 k="svcExclusion" label="Rodent Exclusion" />
              {form.svcExclusion && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-3 gap-3">
                    <FieldV2 label="Simple Seals"><InputV2 k="exclSimple" type="number" min="0" /></FieldV2>
                    <FieldV2 label="Moderate"><InputV2 k="exclModerate" type="number" min="0" /></FieldV2>
                    <FieldV2 label="Advanced/Roof"><InputV2 k="exclAdvanced" type="number" min="0" /></FieldV2>
                  </div>
                  <FieldV2 label="Waive Inspection ($85)?"><SelectV2 k="exclWaive" options={[{ value: 'NO', label: 'No — charge $85' }, { value: 'YES', label: 'Yes — booking work' }]} /></FieldV2>
                </div>
              )}
            </Card>

            {/* Manual Discount */}
            <Card className="p-5">
              <PanelTitle>Manual Discount (optional)</PanelTitle>
              <FieldV2 label="Preset">
                <select
                  value={form.manualDiscountPreset || ''}
                  onChange={(e) => applyDiscountPreset(e.target.value)}
                  className={cn(INPUT_CLS, 'cursor-pointer appearance-none pr-8')}
                >
                  <option value="">— None —</option>
                  {discountPresets.map((d) => {
                    const amt = d.discount_type === 'percentage' ? `${Number(d.amount).toFixed(0)}%` : `$${Number(d.amount).toFixed(2)}`;
                    return <option key={d.id} value={d.discount_key}>{d.icon ? `${d.icon} ` : ''}{d.name} — {amt}</option>;
                  })}
                  <option value="__custom__">Custom…</option>
                </select>
              </FieldV2>
              <div className="grid grid-cols-2 sm:grid-cols-[140px_120px_1fr] gap-2">
                <FieldV2 label="Type">
                  <SelectV2 k="manualDiscountType" options={[
                    { value: 'NONE', label: 'None' },
                    { value: 'PERCENT', label: 'Percent %' },
                    { value: 'FIXED', label: 'Dollar $' },
                  ]} />
                </FieldV2>
                <FieldV2 label="Amount"><InputV2 k="manualDiscountValue" type="number" min="0" placeholder="0" /></FieldV2>
                <div className="col-span-2 sm:col-span-1">
                  <FieldV2 label="Label (shown on estimate)"><InputV2 k="manualDiscountLabel" placeholder="e.g. Military, Referral" /></FieldV2>
                </div>
              </div>
              <div className="text-11 text-ink-tertiary mt-2">
                Applies after WaveGuard bundle discount. Re-click Generate Estimate to recalculate.
              </div>
            </Card>

            {/* Action buttons */}
            <div className="grid grid-cols-2 gap-3">
              <Button onClick={() => doGenerate()} variant="primary" size="md" className="h-12 text-14">
                Generate Estimate
              </Button>
              <Button
                variant="secondary"
                size="md"
                className="h-12 text-14"
                onClick={() => {
                  if (!estimate) { doGenerate(); }
                  setShowSendForm(true);
                }}
              >
                Send Estimate
              </Button>
            </div>

            {/* Send form */}
            {showSendForm && (
              <Card className="p-5 border-zinc-900">
                <PanelTitle>Send Estimate</PanelTitle>
                <FieldV2 label="Customer Phone Number">
                  <input
                    type="tel"
                    value={form.customerPhone || ''}
                    onChange={async (e) => {
                      let raw = e.target.value.replace(/\D/g, '');
                      if (raw.length === 11 && raw.startsWith('1')) raw = raw.slice(1);
                      const digits = raw.slice(0, 10);
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
                    }}
                    placeholder="9415551234"
                    className={cn(INPUT_CLS, 'h-12 text-18 font-mono tracking-wider')}
                  />
                </FieldV2>
                {form.customerName && (
                  <div className="text-12 text-zinc-900 mb-3 px-3 py-2 bg-zinc-50 rounded-xs border-hairline border-zinc-300">
                    Found: <strong>{form.customerName}</strong>{form.customerEmail ? ` · ${form.customerEmail}` : ''}
                  </div>
                )}
                {!form.customerName && form.customerPhone?.length >= 7 && (
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    <FieldV2 label="Name">
                      <input type="text" value={form.customerName || ''} onChange={(e) => set('customerName', e.target.value)} placeholder="Full name" className={INPUT_CLS} />
                    </FieldV2>
                    <FieldV2 label="Email">
                      <input type="email" value={form.customerEmail || ''} onChange={(e) => set('customerEmail', e.target.value)} placeholder="email@example.com" className={INPUT_CLS} />
                    </FieldV2>
                  </div>
                )}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <label className="flex items-center gap-2 cursor-pointer text-12 text-ink-secondary select-none">
                    <input
                      type="checkbox"
                      checked={form.scheduleSend || false}
                      onChange={(e) => set('scheduleSend', e.target.checked)}
                      className="accent-zinc-900"
                    />
                    Schedule for later
                  </label>
                  {form.scheduleSend && (
                    <input
                      type="datetime-local"
                      value={form.scheduledAt || ''}
                      onChange={(e) => set('scheduledAt', e.target.value)}
                      className={cn(INPUT_CLS, 'w-auto h-8 text-12 px-2')}
                    />
                  )}
                </div>
                {form.scheduleSend && !form.scheduledAt && (
                  <div className="text-11 text-ink-secondary mb-2">
                    Quick:{' '}
                    <button
                      onClick={() => {
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        tomorrow.setHours(8, 0, 0, 0);
                        set('scheduledAt', tomorrow.toISOString().slice(0, 16));
                      }}
                      className="underline font-medium u-focus-ring"
                    >
                      Tomorrow 8:00 AM
                    </button>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      variant="secondary" size="md"
                      onClick={async () => {
                        if (!form.customerPhone) { alert('Enter a phone number.'); return; }
                        await saveAndSend('sms');
                      }}
                      disabled={sending}
                    >
                      {sending ? '…' : form.scheduleSend ? 'Schedule SMS' : 'SMS Only'}
                    </Button>
                    <Button
                      variant="secondary" size="md"
                      onClick={async () => {
                        if (!form.customerEmail) { alert('Enter an email.'); return; }
                        await saveAndSend('email');
                      }}
                      disabled={sending}
                    >
                      {sending ? '…' : form.scheduleSend ? 'Schedule Email' : 'Email Only'}
                    </Button>
                    <Button
                      variant="primary" size="md"
                      onClick={async () => {
                        if (!form.customerPhone && !form.customerEmail) { alert('Enter phone or email.'); return; }
                        await saveAndSend('both');
                      }}
                      disabled={sending}
                    >
                      {sending ? '…' : form.scheduleSend ? 'Schedule Both' : 'Both'}
                    </Button>
                  </div>
                  <Button variant="ghost" size="md" onClick={() => setShowSendForm(false)}>Cancel</Button>
                </div>
              </Card>
            )}

            {savedId && (
              <div className="text-12 text-ink-secondary">Saved — ID #{savedId}.</div>
            )}
          </div>

          {/* ═══ RIGHT COLUMN: RESULTS ═══ */}
          <div>
            {!estimate ? (
              <Card className="p-10 text-center">
                <div
                  className="text-zinc-900 mb-3"
                  style={{
                    fontFamily: "'Montserrat', sans-serif",
                    fontSize: 12,
                    fontWeight: 500,
                    letterSpacing: '0.02em',
                  }}
                >
                  {!livePreview.anySelected ? 'Select Services to Get Started' : 'Ready to Generate'}
                </div>
                <div className="text-14 text-ink-secondary mb-4">
                  {!livePreview.anySelected
                    ? 'Select at least one service to see pricing'
                    : `${livePreview.recurringCount} recurring + ${livePreview.onetimeCount} one-time selected — click Generate Estimate`}
                </div>
                {enrichedProfile && (
                  <div className="text-left px-4 py-3 bg-zinc-50 rounded-sm border-hairline border-zinc-200 mt-3 text-13 text-ink-secondary leading-relaxed">
                    <div className="text-11 font-medium text-zinc-900 uppercase tracking-label mb-1.5">Property Loaded</div>
                    <div>{form.address}</div>
                    <div>
                      {(Number(form.homeSqFt) || 0).toLocaleString()} sf home ·{' '}
                      {(Number(form.lotSqFt) || 0).toLocaleString()} sf lot · {form.stories || 1} story
                    </div>
                    {form.hasPool === 'YES' && <div>Pool: Yes{form.hasPoolCage === 'YES' ? ' (caged)' : ''}</div>}
                    <div>
                      Shrubs: {form.shrubDensity} · Trees: {form.treeDensity} · Complexity: {form.landscapeComplexity}
                    </div>
                  </div>
                )}
              </Card>
            ) : (
              <EstimateErrorBoundary key={JSON.stringify(estimate).slice(0, 100)}>
                <Card className="p-5">
                  <div className="flex justify-end gap-2 mb-2">
                    <Button variant="secondary" size="sm" onClick={nextEstimate}>Next Estimate (keep services)</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setEstimate(null); setSavedId(null); setShowSendForm(false); }}>New Estimate</Button>
                  </div>
                  <div className="max-h-[calc(100vh-120px)] overflow-y-auto pr-2">
                    {/* Summary Card */}
                    {(E.recurring.serviceCount > 0 || E.oneTime.total > 0) && (
                      <>
                        <div className="bg-zinc-50 border-hairline border-zinc-900 rounded-sm p-6 mb-6 text-center">
                          <div className="font-mono text-28 font-medium text-zinc-900 u-nums">
                            {fmt(E.recurring.grandTotal || (E.recurring.monthlyTotal + (E.recurring.rodentBaitMo || 0)))}/mo
                          </div>
                          <div className="text-12 text-ink-secondary mt-1">
                            Recurring monthly{E.recurring.savings > 0 ? ` (WaveGuard ${E.recurring.waveGuardTier} pricing)` : ''}
                            {E.manualDiscount && E.manualDiscount.amount > 0 ? ' + manual discount' : ''}
                          </div>
                          <div className="flex justify-center gap-10 mt-3 flex-wrap">
                            {E.oneTime.total > 0 && (
                              <div className="text-center">
                                <div className="font-mono text-18 font-medium text-zinc-900 u-nums">{fmtInt(E.oneTime.total)}</div>
                                <div className="text-11 text-ink-secondary uppercase tracking-label">
                                  {E.oneTime.tmInstall > 0 ? `One-Time (incl ${fmtInt(E.oneTime.tmInstall)} install)` : 'WaveGuard Membership'}
                                </div>
                              </div>
                            )}
                            <div className="text-center">
                              <div className="font-mono text-18 font-medium text-zinc-900 u-nums">{fmt(E.totals.year1)}</div>
                              <div className="text-11 text-ink-secondary uppercase tracking-label">Year 1 Total</div>
                            </div>
                            {E.recurring.savings > 0 && (
                              <div className="text-center">
                                <div className="font-mono text-18 font-medium text-zinc-900 u-nums">-{fmt(E.recurring.savings)}</div>
                                <div className="text-11 text-ink-secondary uppercase tracking-label">Bundle Savings/yr</div>
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
                            <div className="bg-zinc-50 border-hairline border-zinc-300 rounded-sm px-4 py-3 mb-5 text-13 text-ink-secondary">
                              <strong className="text-zinc-900">Recommended:</strong>{' '}
                              {parts.join(' + ')} for comprehensive coverage at {fmt(E.recurring.monthlyTotal)}/mo recurring.
                            </div>
                          );
                        })()}

                        {E.fieldVerify?.length > 0 && (
                          <div className="bg-alert-bg border-hairline border-alert-fg rounded-sm px-4 py-3 mb-5 text-13 text-alert-fg">
                            <strong>Field Verify:</strong> {E.fieldVerify.map((f) => typeof f === 'string' ? f : (f.field || f.name || JSON.stringify(f))).join(', ')} — estimated from satellite data, tech should confirm on-site.
                          </div>
                        )}
                      </>
                    )}

                    {/* Property Summary */}
                    <div className="mb-6">
                      <SectionTitle>Property Summary</SectionTitle>
                      <div className="text-13 text-ink-secondary leading-relaxed">
                        <strong className="text-zinc-900">{E.property?.type || E.property?.propertyType || 'Residential'}</strong> — {(E.property?.homeSqFt || 0).toLocaleString()} sf / {(E.property?.lotSqFt || 0).toLocaleString()} sf lot / {E.property?.stories || 1} story<br />
                        Footprint: <strong>{(E.property?.footprint || 0).toLocaleString()} sf</strong> | Pool: {E.property?.pool === 'YES' || E.property?.pool === true ? 'Yes' : 'No'}{E.property?.poolCage === 'YES' ? ' (caged)' : ''} | Driveway: {E.property?.largeDriveway === 'YES' || E.property?.largeDriveway === true ? 'Large' : 'Normal'}<br />
                        Shrubs: {E.property?.shrubDensity || E.property?.shrubs || '--'} | Trees: {E.property?.treeDensity || E.property?.trees || '--'} | Complexity: {E.property?.landscapeComplexity || E.property?.complexity || '--'} | Water: {E.property?.nearWater && E.property.nearWater !== 'NONE' ? E.property.nearWater.replace(/_/g, ' ') : 'No'}
                        {E.property?.yearBuilt && <><br />Built: {E.property.yearBuilt} | {E.property?.constructionMaterial} | {E.property?.foundationType} foundation | {E.property?.roofType} roof</>}
                        {E.property?.estimatedValue && (
                          <>
                            <br />Estimated value: <strong className="text-zinc-900">${Math.round(E.property.estimatedValue).toLocaleString()}</strong>
                            {E.property.estimatedValueLow && E.property.estimatedValueHigh ? <> (${Math.round(E.property.estimatedValueLow).toLocaleString()}–${Math.round(E.property.estimatedValueHigh).toLocaleString()})</> : null}
                          </>
                        )}
                        {E.property?.serviceZone && <Tag>Zone {E.property.serviceZone}</Tag>}
                        {E.urgency?.label && <><br /><Tag>{E.urgency.label}</Tag></>}
                        {E.recurringCustomer && <Tag>Recurring -15% one-time</Tag>}
                      </div>
                    </div>

                    {/* Pricing Modifiers */}
                    {E.modifiers?.length > 0 && (
                      <div className="mb-6">
                        <SectionTitle>Pricing Modifiers</SectionTitle>
                        <div className="flex flex-col gap-1">
                          {E.modifiers.map((m, i) => (
                            <div
                              key={i}
                              className={cn(
                                'flex items-center gap-2 px-3 py-1.5 rounded-xs border-hairline',
                                m.type === 'up' ? 'border-zinc-300 bg-white' : m.type === 'down' ? 'border-zinc-300 bg-zinc-50' : 'border-zinc-200 bg-white',
                              )}
                            >
                              <span className="text-11 text-ink-tertiary flex-shrink-0 w-3 text-center">
                                {m.type === 'up' ? '▲' : m.type === 'down' ? '▼' : '·'}
                              </span>
                              <span className="text-12 text-ink-secondary flex-1">{m.label}</span>
                              <span className="text-11 font-mono font-medium text-zinc-900 u-nums">
                                {m.impact != null ? (m.impact >= 0 ? '+$' + m.impact : '-$' + Math.abs(m.impact)) : '$0'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recurring Programs */}
                    {E.hasRecurring && (
                      <>
                        <GroupHeader>Recurring Programs</GroupHeader>

                        {R.lawn && (
                          <div className="mb-6">
                            <SectionTitle>
                              Lawn Care
                              <Tag>{R.lawnMeta?.lsf?.toLocaleString()} sf turf</Tag>
                              {R.lawnMeta?.grassName && <Tag>{R.lawnMeta.grassName}</Tag>}
                            </SectionTitle>
                            <TierGridV2>
                              {R.lawn.map((t, i) => (
                                <TierRowV2
                                  key={i}
                                  name={t.name}
                                  detail={`${fmt(t.pa)}/app x ${t.v}`}
                                  price={`${fmt(t.mo)}/mo`}
                                  recommended={t.recommended}
                                  dimmed={t.dimmed}
                                  selected={String(t.v) === String(form.lawnFreq)}
                                  onSelect={() => { set('lawnFreq', String(t.v)); doGenerate({ lawnFreq: t.v }); }}
                                />
                              ))}
                            </TierGridV2>
                          </div>
                        )}

                        {R.pestTiers && (
                          <div className="mb-6">
                            <SectionTitle>Pest Control</SectionTitle>
                            <TierGridV2>
                              {R.pestTiers.map((t, i) => (
                                <TierRowV2
                                  key={i}
                                  name={t.label}
                                  detail={`${fmt(t.pa)}/app x ${t.apps}${R.pest?.rOG > 0 ? ' (incl roach +15%)' : ''}`}
                                  price={`${fmt(t.mo)}/mo`}
                                  recommended={t.recommended}
                                  dimmed={t.dimmed}
                                  selected={String(t.apps) === String(form.pestFreq)}
                                  onSelect={() => { set('pestFreq', String(t.apps)); doGenerate({ pestFreq: t.apps }); }}
                                />
                              ))}
                            </TierGridV2>
                            {R.pest?.rOG > 0 && (
                              <div className="font-mono text-11 text-ink-secondary mt-1">
                                Roach modifier: +{fmt(R.pest.rOG)}/visit ({R.pestRoachMod === 'GERMAN' ? 'German' : 'Regular'})
                              </div>
                            )}
                          </div>
                        )}

                        {R.ts && (
                          <div className="mb-6">
                            <SectionTitle>
                              Tree &amp; Shrub
                              <Tag>{R.tsMeta?.eb} sf beds | {R.tsMeta?.et} trees</Tag>
                              {R.tsMeta?.bedAreaIsEstimated && <FieldVerifyTag>FIELD VERIFY</FieldVerifyTag>}
                            </SectionTitle>
                            <TierGridV2>
                              {R.ts.map((t, i) => (
                                <TierRowV2 key={i} name={t.name} detail={`${fmt(t.pa)}/app x ${t.v}`} price={`${fmt(t.mo)}/mo`} recommended={t.recommended} dimmed={t.dimmed} />
                              ))}
                            </TierGridV2>
                          </div>
                        )}

                        {R.injection && (
                          <div className="mb-6">
                            <SectionTitle>
                              Palm Injection <Tag>{R.injection.palms} palms</Tag>
                            </SectionTitle>
                            <TierGridV2>
                              <TierRowV2 name="Arborjet" detail={`${R.injection.palms} palms x $35 x 3/yr`} price={`${fmt(R.injection.mo)}/mo`} recommended />
                            </TierGridV2>
                          </div>
                        )}

                        {R.mq && (
                          <div className="mb-6">
                            <SectionTitle>
                              Mosquito <Tag>Pressure {R.mqMeta?.pr}x</Tag>
                            </SectionTitle>
                            <TierGridV2>
                              {R.mq.map((t, i) => (
                                <TierRowV2 key={i} name={t.n} detail={`$${t.pv}/visit x ${t.v}`} price={`${fmt(t.mo)}/mo`} recommended={t.recommended} dimmed={t.dimmed} />
                              ))}
                            </TierGridV2>
                          </div>
                        )}

                        {R.tmBait && (
                          <div className="mb-6">
                            <SectionTitle>
                              Termite Bait <Tag>{R.tmBait.sta} sta | {R.tmBait.perim} ft</Tag>
                            </SectionTitle>
                            <TierGridV2>
                              <TierRowV2 name="Advance" detail={`${fmtInt(R.tmBait.ai)} install | Basic $35 | Premier $65/mo`} price="$35-65" dimmed />
                              <TierRowV2 name="Trelona" detail={`${fmtInt(R.tmBait.ti)} install | Basic $35 | Premier $65/mo`} price="$35-65" recommended />
                            </TierGridV2>
                            <div className="font-mono text-11 text-ink-secondary mt-1">Install cost is a one-time setup fee, not a recurring charge</div>
                          </div>
                        )}

                        {R.rodBaitMo && (
                          <div className="mb-6">
                            <SectionTitle>Rodent Bait Stations</SectionTitle>
                            <TierGridV2>
                              <TierRowV2 name="Monthly" detail={`${R.rodBaitSize} property`} price={`$${R.rodBaitMo}/mo`} recommended />
                            </TierGridV2>
                            <div className="font-mono text-11 text-ink-secondary mt-1">Not included in WaveGuard bundle discount — priced separately</div>
                          </div>
                        )}
                      </>
                    )}

                    {/* One-Time Services */}
                    {E.hasOneTime && (
                      <>
                        <GroupHeader>One-Time Services</GroupHeader>
                        {E.oneTime.items.map((item, i) => {
                          if (item.name === 'Top Dressing' && R.tdTiers) {
                            return (
                              <div key={i} className="mb-6">
                                <SectionTitle>Top Dressing{E.isRecurringCustomer && <DiscBadge>-15%</DiscBadge>}</SectionTitle>
                                <TierGridV2>
                                  {R.tdTiers.map((t, j) => <TierRowV2 key={j} name={t.name} detail={t.detail} price={fmtInt(t.price)} />)}
                                </TierGridV2>
                              </div>
                            );
                          }
                          if (item.name === 'Trenching' && R.trench) {
                            return (
                              <div key={i} className="mb-6">
                                <SectionTitle>Trenching{E.isRecurringCustomer && <DiscBadge>-15%</DiscBadge>}</SectionTitle>
                                <TierGridV2>
                                  <TierRowV2 name="Treatment" detail={item.detail} price={fmtInt(item.price)} />
                                  <TierRowV2 name="Renewal" detail="Annual warranty" price="$325/yr" dimmed />
                                </TierGridV2>
                                <div className="text-12 text-ink-secondary italic mt-1">Best scheduled before rainy season (Apr-May)</div>
                              </div>
                            );
                          }
                          if (item.name === 'Bora-Care') {
                            return (
                              <div key={i} className="mb-6">
                                <SectionTitle>
                                  Bora-Care Attic{E.isRecurringCustomer && <DiscBadge>-15%</DiscBadge>}
                                  {item.atticIsEstimated && <FieldVerifyTag>FIELD VERIFY ATTIC</FieldVerifyTag>}
                                </SectionTitle>
                                <TierGridV2>
                                  <TierRowV2 name="Treatment" detail={item.detail} price={fmtInt(item.price)} />
                                </TierGridV2>
                                <div className="text-12 text-ink-secondary italic mt-1">Best time: Oct-Mar (cooler attic temps)</div>
                              </div>
                            );
                          }
                          if (item.name === 'Pre-Slab') {
                            return (
                              <div key={i} className="mb-6">
                                <SectionTitle>Pre-Slab Termidor{E.isRecurringCustomer && <DiscBadge>-15%</DiscBadge>}</SectionTitle>
                                <TierGridV2>
                                  <TierRowV2 name="Treatment" detail={item.detail} price={fmtInt(item.basePrice || item.price)} />
                                  {item.warrAdd > 0 && <TierRowV2 name="5yr Warranty" detail="Extended transferable" price="+$200" />}
                                </TierGridV2>
                                {!item.warrAdd && <div className="font-mono text-11 text-ink-secondary mt-1">Includes 1-yr builder warranty | $225/yr renewal after</div>}
                              </div>
                            );
                          }
                          if (item.name === 'Foam Drill') {
                            return (
                              <div key={i} className="mb-6">
                                <SectionTitle>Foam Drill{E.isRecurringCustomer && <DiscBadge>-15%</DiscBadge>}</SectionTitle>
                                <TierGridV2>
                                  <TierRowV2 name={item.tierName} detail={item.detail} price={fmtInt(item.price)} />
                                </TierGridV2>
                                <div className="font-mono text-11 text-ink-secondary mt-1">For localized drywood, wall voids, door/window frames</div>
                              </div>
                            );
                          }
                          if (item.name === 'Plugging') {
                            return (
                              <div key={i} className="mb-6">
                                <SectionTitle>Plugging{E.isRecurringCustomer && <DiscBadge>-15%</DiscBadge>}</SectionTitle>
                                <TierGridV2>
                                  <TierRowV2 name={item.spacing} detail={item.detail} price={fmtInt(item.price)} />
                                </TierGridV2>
                                {item.warn6 && <div className="font-mono text-11 text-ink-secondary mt-1">Sod may be more cost-effective at 6"</div>}
                              </div>
                            );
                          }
                          const nameMap = { 'OT Pest': 'One-Time Pest', 'OT Mosquito': 'One-Time Mosquito', 'German Roach': 'German Roach Initial' };
                          const displayName = item.lawnType ? `One-Time Lawn (${item.lawnType})` : (nameMap[item.name] || item.name);
                          return (
                            <div key={i} className="mb-6">
                              <SectionTitle>{displayName}{E.isRecurringCustomer && <DiscBadge>-15%</DiscBadge>}</SectionTitle>
                              <TierGridV2>
                                <TierRowV2
                                  name={item.lawnType || (item.name === 'OT Pest' ? 'Full Spray' : item.name === 'OT Mosquito' ? 'Event Spray' : item.name === 'German Roach' ? '3-Visit' : item.name === 'Trapping' ? 'Trapping' : 'Standalone')}
                                  detail={item.detail}
                                  price={fmtInt(item.price)}
                                />
                              </TierGridV2>
                            </div>
                          );
                        })}
                      </>
                    )}

                    {/* Specialty Pest */}
                    {E.specItems && E.specItems.length > 0 && (
                      <>
                        <GroupHeader>Specialty Pest</GroupHeader>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-6">
                          {E.specItems.map((s, i) => (
                            <div key={i} className="bg-white border-hairline border-zinc-200 rounded-sm p-4">
                              <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-1">{s.name}</div>
                              <div className="font-mono text-18 font-medium text-zinc-900 u-nums">{s.onProg ? '$0 — Included' : fmtInt(s.price)}</div>
                              <div className="text-12 text-ink-secondary mt-1">{s.det}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {/* WaveGuard + Totals */}
                    {(E.recurring.serviceCount > 0 || E.oneTime.total > 0 || E.recurring.rodentBaitMo > 0) && (
                      <>
                        <div className="h-px bg-zinc-200 my-4" />

                        {E.recurring.serviceCount > 0 && (
                          <div className="bg-zinc-50 border-hairline border-zinc-300 rounded-sm p-5 mb-6">
                            <div className="text-18 font-medium text-zinc-900">WaveGuard {E.recurring.waveGuardTier}</div>
                            <div className="text-13 text-ink-secondary mt-0.5">
                              {E.recurring.serviceCount} recurring service{E.recurring.serviceCount > 1 ? 's' : ''} — {Math.round(E.recurring.discount * 100)}% bundle discount
                            </div>
                            {E.recurring.savings > 0 && (
                              <div className="text-zinc-900 text-14 font-medium mt-1">
                                Bundling saves <span className="u-nums font-mono">{fmt(E.recurring.savings)}</span>/year
                              </div>
                            )}
                            <div className="grid grid-cols-[1fr_auto] gap-y-1 gap-x-4 text-13 mt-3 p-3 bg-white rounded-xs border-hairline border-zinc-200">
                              {E.recurring.services.map((s, i) => (
                                <React.Fragment key={i}>
                                  <div className="text-ink-secondary">{s.name}</div>
                                  <div className="font-mono text-zinc-900 text-right u-nums">{fmt(s.mo)}/mo</div>
                                </React.Fragment>
                              ))}
                              <div className="font-medium text-zinc-900 border-t border-hairline border-zinc-200 pt-1 mt-1">Total before discount</div>
                              <div className="font-mono font-medium border-t border-hairline border-zinc-200 pt-1 mt-1 text-right text-zinc-900 u-nums">{fmt(Math.round(E.recurring.annualBeforeDiscount / 12 * 100) / 100)}/mo</div>
                              {E.recurring.discount > 0 && (
                                <>
                                  <div className="text-ink-secondary">{E.recurring.waveGuardTier} discount (-{Math.round(E.recurring.discount * 100)}%)</div>
                                  <div className="font-mono text-zinc-900 text-right u-nums">-{fmt(Math.round(E.recurring.savings / 12 * 100) / 100)}/mo</div>
                                </>
                              )}
                              <div className="font-medium text-zinc-900">Your monthly rate</div>
                              <div className="font-mono font-medium text-zinc-900 text-right u-nums">{fmt(E.recurring.monthlyTotal)}/mo</div>
                            </div>
                          </div>
                        )}

                        {/* Grand totals */}
                        <div className="bg-white border-hairline border-zinc-900 rounded-sm p-5">
                          {E.recurring.serviceCount > 0 && (
                            <div className="flex justify-between items-center py-1.5 text-14">
                              <span className="text-ink-secondary">Recurring (after WaveGuard)</span>
                              <span className="font-mono font-medium text-zinc-900 u-nums">{fmt(E.recurring.annualAfterDiscount)}/yr ({fmt(E.recurring.monthlyTotal)}/mo)</span>
                            </div>
                          )}
                          {E.recurring.rodentBaitMo > 0 && (
                            <div className="flex justify-between items-center py-1.5 text-14">
                              <span className="text-ink-secondary">Rodent bait (separate)</span>
                              <span className="font-mono font-medium text-zinc-900 u-nums">{fmtInt(E.recurring.rodentBaitMo * 12)}/yr (${E.recurring.rodentBaitMo}/mo)</span>
                            </div>
                          )}
                          {E.manualDiscount && E.manualDiscount.amount > 0 && (
                            <div className="flex justify-between items-center py-1.5 text-14">
                              <span className="text-ink-secondary">
                                {E.manualDiscount.label || (E.manualDiscount.type === 'PERCENT' ? `Discount (${E.manualDiscount.value}%)` : `Discount`)}
                              </span>
                              <span className="font-mono font-medium text-zinc-900 u-nums">-{fmt(E.manualDiscount.amount)}/yr</span>
                            </div>
                          )}
                          {E.oneTime.tmInstall > 0 && (
                            <div className="flex justify-between items-center py-1.5 text-14">
                              <span className="text-ink-secondary">Termite bait install (Trelona)</span>
                              <span className="font-mono font-medium text-zinc-900 u-nums">{fmtInt(E.oneTime.tmInstall)}</span>
                            </div>
                          )}
                          {E.oneTime.otSubtotal > 0 && (
                            <>
                              <div className="flex justify-between items-center py-2 text-14 border-t border-hairline border-zinc-200 mt-1.5">
                                <span className="font-medium text-zinc-900">One-Time Services</span>
                                <span className="font-mono font-medium text-zinc-900 u-nums">{fmtInt(E.oneTime.otSubtotal)}</span>
                              </div>
                              {E.oneTime.items.map((item, i) => (
                                <div key={i} className="flex justify-between items-center py-0.5 pl-4 text-13 text-ink-secondary">
                                  <span>{item.name}{item.waivedWithPrepay ? <span className="text-11 text-ink-tertiary ml-1">waived with annual prepay</span> : ''}</span>
                                  <span className="font-mono text-13 u-nums">{fmtInt(item.price)}</span>
                                </div>
                              ))}
                              {E.oneTime.specItems.map((s, i) => (
                                <div key={`sp-${i}`} className="flex justify-between items-center py-0.5 pl-4 text-13 text-ink-secondary">
                                  <span>{s.name}</span>
                                  <span className="font-mono text-13 u-nums">{fmtInt(s.price)}</span>
                                </div>
                              ))}
                            </>
                          )}
                          <div className="flex justify-between items-center py-3 text-18 font-medium border-t-2 border-zinc-900 mt-2">
                            <span className="text-zinc-900">Year 1 Total</span>
                            <span className="font-mono font-medium text-zinc-900 u-nums">{fmt(E.totals.year1)}</span>
                          </div>
                          <div className="flex justify-between items-center py-1.5 text-14">
                            <span className="text-ink-secondary">Year 2+ Annual</span>
                            <span className="font-mono font-medium text-zinc-900 u-nums">{fmt(E.totals.year2)}/yr ({fmt(E.totals.year2mo)}/mo)</span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </Card>
              </EstimateErrorBoundary>
            )}
          </div>
        </div>
      </div>
    </FormCtx.Provider>
  );
}
