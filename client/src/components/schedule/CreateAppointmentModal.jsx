// client/src/components/schedule/CreateAppointmentModal.jsx
//
// Modal opened from the SchedulePage / DispatchPageV2 "+ New" CTA.
// Walks the operator through customer lookup, service selection,
// date/time slot, optional recurring cadence, and tech assignment.
// Submits to POST /admin/services to create a scheduled_service row.
//
// Endpoints:
//   GET  /admin/customers?search=         (autocomplete existing customer)
//   GET  /admin/services                  (service-library lookup)
//   GET  /admin/techs/availability        (slot availability for a date)
//   POST /admin/services                  (create the appointment)
//   POST /admin/customers                 (when creating a new customer
//                                          inline before booking)
//
// Audit focus:
// - Existing-customer-vs-new branching: confirm the new-customer
//   inline-create path doesn't double-submit when the operator picks
//   a search result mid-typing.
// - Address autocomplete (Google Places) — verify graceful degradation
//   when the script fails to load.
// - Recurring-appointment generation: when a cadence (quarterly /
//   bimonthly / monthly) is set, the server fans out future stops.
//   Worth checking that the modal's UI promise (preview of N visits)
//   matches what the server actually creates, especially around DST
//   boundaries and timezone (use etDateString — never new Date(string)).
// - Tech assignment dropdown: confirm "any available tech" vs an
//   explicit assignment doesn't get silently swapped if the
//   availability API responds slowly.
import { useState, useEffect, useMemo, useRef } from 'react';
import AddressAutocomplete from '../AddressAutocomplete';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// Square monochrome palette — zinc-only, no teal/green/blue accents. Red reserved for genuine alerts.
const D = {
  bg: '#FAFAFA', card: '#FFFFFF', border: '#E4E4E7', input: '#FFFFFF',
  teal: '#18181B', green: '#18181B', amber: '#71717A', red: '#DC2626',
  blue: '#18181B', purple: '#18181B', gray: '#71717A',
  text: '#18181B', muted: '#71717A', white: '#fff',
};

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const TIER_COLORS = { Platinum: '#E5E4E2', Gold: '#FDD835', Silver: '#90CAF9', Bronze: '#CD7F32', 'One-Time': '#0A7EC2' };

const CATEGORY_LABELS = { recurring: 'Recurring Services', one_time: 'One-Time Treatments', assessment: 'Assessments', pest_control: 'Pest Control', lawn_care: 'Lawn Care', mosquito: 'Mosquito', termite: 'Termite', rodent: 'Rodent', tree_shrub: 'Tree & Shrub', inspection: 'Inspections', specialty: 'Specialty', other: 'Other' };


// Per-line cadence options. Each service line picks its own cadence so a
// customer can get e.g. quarterly pest + monthly lawn from a single new-
// appointment form. Same-cadence lines ride one parent appointment as
// add-ons; different-cadence lines fan out into separate parent series at
// submit time.
const CADENCE_OPTIONS = [
  { value: 'one_time', label: 'One-time' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'bimonthly', label: 'Every 2 months' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'triannual', label: 'Every 4 months' },
  { value: 'monthly_nth_weekday', label: 'Monthly (Nth weekday)' },
  { value: 'custom', label: 'Custom (every N days)' },
];

const NTH_OPTIONS = [
  { value: 1, label: '1st' }, { value: 2, label: '2nd' },
  { value: 3, label: '3rd' }, { value: 4, label: '4th' },
];
const WEEKDAY_OPTIONS = [
  { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Booster months — extra visits on top of a recurring base. Common pattern:
// quarterly pest + boosters in Jun/Aug. Months are 1-indexed.
const MONTH_CHIPS = [
  { value: 1, label: 'J' }, { value: 2, label: 'F' }, { value: 3, label: 'M' },
  { value: 4, label: 'A' }, { value: 5, label: 'M' }, { value: 6, label: 'J' },
  { value: 7, label: 'J' }, { value: 8, label: 'A' }, { value: 9, label: 'S' },
  { value: 10, label: 'O' }, { value: 11, label: 'N' }, { value: 12, label: 'D' },
];

const inputStyle = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 6, color: D.text, fontSize: 16, fontFamily: 'inherit', fontWeight: 400, outline: 'none', boxSizing: 'border-box', minHeight: 44, colorScheme: 'light' };
const labelStyle = { fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500, display: 'block', marginBottom: 4 };
const sectionStyle = { background: D.card, borderRadius: 8, padding: 16, border: `1px solid ${D.border}`, marginBottom: 12 };

// Client mirror of the server's recurring-date math. Returns a Date.
function nextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const { intervalDays, nth, weekday } = opts;
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : '';
  const base = new Date(safe + 'T12:00:00');
  if (isNaN(base.getTime())) return new Date();
  const nthNum = (nth != null && nth !== '' && !isNaN(parseInt(nth))) ? parseInt(nth) : null;
  const wdayNum = (weekday != null && weekday !== '' && !isNaN(parseInt(weekday))) ? parseInt(weekday) : null;
  if (pattern === 'monthly_nth_weekday' && nthNum != null && wdayNum != null) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1, 12, 0, 0);
    const firstW = d.getDay();
    const offset = (wdayNum - firstW + 7) % 7;
    d.setDate(1 + offset + (nthNum - 1) * 7);
    return isNaN(d.getTime()) ? base : d;
  }
  const intervals = { monthly: 30, bimonthly: 60, quarterly: 91, triannual: 122 };
  let gap;
  if (pattern === 'custom' && intervalDays) gap = Math.max(1, parseInt(intervalDays) || 30);
  else gap = intervals[pattern] || 91;
  const d = new Date(base);
  d.setDate(d.getDate() + gap * i);
  return isNaN(d.getTime()) ? base : d;
}

// Client mirror of server-side shiftPastWeekend so the preview reflects
// actual saved dates when skip-weekends is on.
function shiftPastWeekendClient(d, skip, direction) {
  if (!skip || !d || isNaN(d.getTime())) return d;
  const day = d.getDay();
  if (day !== 0 && day !== 6) return d;
  const out = new Date(d);
  if (direction === 'back') out.setDate(out.getDate() - (day === 6 ? 1 : 2));
  else out.setDate(out.getDate() + (day === 6 ? 2 : 1));
  return out;
}

export default function CreateAppointmentModal({ defaultDate, defaultWindowStart, defaultDurationMinutes, defaultTechId, defaultCustomer = null, onClose, onCreated }) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const searchRef = useRef(null);

  // Customer state
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerError, setCustomerError] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState(defaultCustomer);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAdd, setQuickAdd] = useState({ firstName: '', lastName: '', phone: '', email: '', address: '', city: '', zip: '' });

  // Service state — mirrors ServiceLibraryPage's approach: ask the Service
  // Library endpoint directly, render what it returns. No local fallback
  // list, no client-side denylist. If the operator can see it in Service
  // Library, they can book it here.
  //
  // Multi-service: services[0] is the primary (drives service_id /
  // serviceType on the parent appointment); services[1..] are persisted as
  // scheduled_service_addons rows. Each row carries its own price so
  // Virginia can quote a quarterly pest + rodent station combo without
  // hand-math.
  const [services, setServices] = useState([]);
  const [serviceSearch, setServiceSearch] = useState('');
  const [serviceResults, setServiceResults] = useState([]);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceError, setServiceError] = useState('');
  const [addingService, setAddingService] = useState(false);
  const selectedService = services[0] || null;

  // Debounced Service Library search (same endpoint + filters as /admin/services catalog).
  useEffect(() => {
    const q = serviceSearch.trim();
    if (!q) { setServiceResults([]); setServiceLoading(false); setServiceError(''); return; }
    setServiceLoading(true);
    setServiceError('');
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        params.set('search', q);
        params.set('is_active', 'true');
        params.set('limit', '50');
        const r = await adminFetch(`/admin/services?${params}`);
        setServiceResults((r.services || []).map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          duration: s.default_duration_minutes,
          priceMin: s.price_range_min ?? s.base_price,
          priceMax: s.price_range_max ?? s.base_price,
          base_price: s.base_price,
          default_duration_minutes: s.default_duration_minutes,
        })));
      } catch (err) {
        // Surface real failures (401 expired token, 500, network) so a
        // service-library-data problem isn't indistinguishable from a
        // search-pipeline problem in operators' bug reports.
        setServiceResults([]);
        setServiceError(err?.message || 'Search failed');
      } finally {
        setServiceLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [serviceSearch]);

  // Find-a-Time state
  const [findingTimes, setFindingTimes] = useState(false);
  const [timeSlots, setTimeSlots] = useState(null); // null = hidden, [] = searched but none, [...] = results
  const [slotError, setSlotError] = useState('');

  // Date/Time/Tech state — default to today + next 15-min boundary in local time
  const _now = new Date();
  const _ymd = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  const _rounded = new Date(_now);
  _rounded.setSeconds(0, 0);
  const _addMin = 15 - (_rounded.getMinutes() % 15 || 15);
  _rounded.setMinutes(_rounded.getMinutes() + _addMin);
  const _hhmm = `${String(_rounded.getHours()).padStart(2, '0')}:${String(_rounded.getMinutes()).padStart(2, '0')}`;
  const _defaultDate = _rounded.toDateString() !== _now.toDateString()
    ? `${_rounded.getFullYear()}-${String(_rounded.getMonth() + 1).padStart(2, '0')}-${String(_rounded.getDate()).padStart(2, '0')}`
    : _ymd;
  const [apptDate, setApptDate] = useState(defaultDate || _defaultDate);
  const [windowStart, setWindowStart] = useState(defaultWindowStart || _hhmm);
  const [techMode, setTechMode] = useState(defaultTechId ? 'choose' : 'auto');
  const [techId, setTechId] = useState(defaultTechId || '');
  const [techs, setTechs] = useState([]);
  const [skipWeekends, setSkipWeekends] = useState(false);
  const [weekendShift, setWeekendShift] = useState('forward'); // 'forward' (Mon) | 'back' (Fri)
  // Fixed-count recurring: '' (default) means ongoing/auto-extend; any
  // integer >= 2 caps the series at that many visits. Applies to every
  // recurring cadence group on this appointment, matching the prior
  // single-form-level count semantics.
  const [recurringCount, setRecurringCount] = useState('');
  const [discountType, setDiscountType] = useState('');
  const [discountAmount, setDiscountAmount] = useState('');
  const [discountPresets, setDiscountPresets] = useState([]);
  const [discountPresetId, setDiscountPresetId] = useState('');
  const [discountSearch, setDiscountSearch] = useState('');

  const filteredDiscounts = useMemo(() => {
    const q = discountSearch.trim().toLowerCase();
    if (!q) return discountPresets;
    return discountPresets.filter((d) => (d.name || '').toLowerCase().includes(q));
  }, [discountPresets, discountSearch]);

  const selectedDiscountLabel = useMemo(() => {
    if (!discountPresetId) return '';
    if (discountPresetId === 'custom') return 'Custom amount';
    const d = discountPresets.find((x) => String(x.id) === String(discountPresetId));
    if (!d) return '';
    const amt = d.discount_type === 'percentage'
      ? `${Number(d.amount).toFixed(d.amount % 1 ? 2 : 0)}%`
      : `$${Number(d.amount).toFixed(2)}`;
    return `${d.name} — ${amt}`;
  }, [discountPresetId, discountPresets]);

  // Notes & Confirm state
  const [customerNotes, setCustomerNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [sendSms, setSendSms] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  // Per-line helpers. Each entry in `services` carries its own `price`
  // string (so an operator can override goodwill / loyalty pricing on one
  // line without touching the others) and its own `cadence` + `intervalDays`
  // so quarterly pest + monthly lawn can live on the same form. The
  // summed total drives the discount base and the totals strip.
  const updateServicePrice = (idx, val) => {
    setServices((arr) => arr.map((s, i) => (i === idx ? { ...s, price: val } : s)));
  };
  const updateServiceCadence = (idx, val) => {
    setServices((arr) => arr.map((s, i) => (i === idx ? { ...s, cadence: val } : s)));
  };
  const updateServiceInterval = (idx, val) => {
    setServices((arr) => arr.map((s, i) => (i === idx ? { ...s, intervalDays: val } : s)));
  };
  const updateServiceNth = (idx, val) => {
    setServices((arr) => arr.map((s, i) => (i === idx ? { ...s, nth: val } : s)));
  };
  const updateServiceWeekday = (idx, val) => {
    setServices((arr) => arr.map((s, i) => (i === idx ? { ...s, weekday: val } : s)));
  };
  const toggleBoosterMonth = (idx, month) => {
    setServices((arr) => arr.map((s, i) => {
      if (i !== idx) return s;
      const current = Array.isArray(s.boosterMonths) ? s.boosterMonths : [];
      const next = current.includes(month) ? current.filter((m) => m !== month) : [...current, month].sort((a, b) => a - b);
      return { ...s, boosterMonths: next };
    }));
  };
  const removeServiceAt = (idx) => {
    setServices((arr) => arr.filter((_, i) => i !== idx));
  };
  const addServiceFromCatalog = (svc) => {
    const defaultPrice = svc.priceMin || svc.base_price || '';
    setServices((arr) => [
      ...arr,
      {
        ...svc,
        price: defaultPrice ? String(defaultPrice) : '',
        cadence: 'one_time',
        intervalDays: 30,
        nth: 3,        // default "3rd"
        weekday: 3,    // default "Wednesday"
        boosterMonths: [],
      },
    ]);
    setServiceSearch('');
    setServiceResults([]);
    setAddingService(false);
  };
  const subtotal = useMemo(() => {
    return services.reduce((sum, s) => {
      const n = parseFloat(s.price);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
  }, [services]);
  const totalDuration = useMemo(() => {
    if (services.length === 0) return defaultDurationMinutes || 60;
    return services.reduce((sum, s) => sum + (s.duration || s.default_duration_minutes || 30), 0);
  }, [services, defaultDurationMinutes]);

  // Fetch technicians + discounts on mount. Services are fetched on-demand
  // via the search effect above (Service Library query).
  useEffect(() => {
    (async () => {
      try {
        const r = await adminFetch('/admin/technicians');
        if (r.technicians) setTechs(r.technicians);
        else if (Array.isArray(r)) setTechs(r);
      } catch { /* techs not critical */ }
    })();
    (async () => {
      try {
        const r = await adminFetch('/admin/discounts');
        const list = Array.isArray(r) ? r : [];
        const filtered = list
          .filter(d => d.is_active)
          .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999));
        setDiscountPresets(filtered);
      } catch { /* discounts optional */ }
    })();
  }, []);

  const applyDiscountPreset = (id) => {
    setDiscountPresetId(id);
    if (!id) { setDiscountType(''); setDiscountAmount(''); return; }
    if (id === 'custom') return;
    const d = discountPresets.find(x => String(x.id) === String(id));
    if (!d) return;
    setDiscountType(d.discount_type);
    setDiscountAmount(String(d.amount ?? ''));
  };

  // Customer search. Tracks loading so the dropdown can show "Searching…"
  // and "No matches" states — without them, a slow network or zero-hit
  // query looks identical to a broken search (no UI ever appears) and
  // operators report it as "the search vanished".
  const doSearch = async (val) => {
    setCustomerSearch(val);
    if (val.length >= 2) {
      setCustomerLoading(true);
      setCustomerError('');
      try {
        const r = await adminFetch(`/admin/customers?search=${encodeURIComponent(val)}&limit=8`);
        setCustomerResults(r.customers || []);
      } catch (err) {
        // Surface real failures (401 expired token, 500, network) so a
        // misspelled-name lookup is distinguishable from a broken pipeline.
        setCustomerResults([]);
        setCustomerError(err?.message || 'Search failed');
      }
      finally { setCustomerLoading(false); }
    } else { setCustomerResults([]); setCustomerLoading(false); setCustomerError(''); }
  };

  const selectCustomer = (c) => {
    setSelectedCustomer(c);
    setCustomerSearch(`${c.firstName} ${c.lastName}`);
    setCustomerResults([]);
  };

  // Quick add customer
  const handleQuickAdd = async () => {
    if (!quickAdd.firstName || !quickAdd.lastName || !quickAdd.phone) return;
    try {
      const r = await adminFetch('/admin/customers/quick-add', {
        method: 'POST',
        body: JSON.stringify(quickAdd),
      });
      if (r.customer) {
        selectCustomer(r.customer);
        setShowQuickAdd(false);
        setQuickAdd({ firstName: '', lastName: '', phone: '', email: '', address: '', city: '', zip: '' });
      }
    } catch (e) { alert('Failed to add customer: ' + e.message); }
  };

  // Compute end time. Sum line-item durations across all services on the
  // appointment; if none are picked yet, honor the duration the operator
  // dragged out on the grid (defaultDurationMinutes), else fall back to 60.
  const getEndTime = () => {
    const dur = totalDuration || 60;
    const [h, m] = windowStart.split(':').map(Number);
    const endMin = h * 60 + m + dur;
    return `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
  };

  // Find best times — calls /api/admin/schedule/find-time
  const handleFindTimes = async () => {
    if (!selectedCustomer || !selectedService) return;
    setFindingTimes(true);
    setSlotError('');
    setTimeSlots(null);
    try {
      const dur = totalDuration || 60;
      const today = new Date();
      const from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const endD = new Date(today); endD.setDate(endD.getDate() + 7);
      const to = `${endD.getFullYear()}-${String(endD.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`;
      const r = await adminFetch('/admin/schedule/find-time', {
        method: 'POST',
        body: JSON.stringify({
          customerId: selectedCustomer.id,
          durationMinutes: dur,
          dateFrom: from,
          dateTo: to,
          topN: 8,
        }),
      });
      setTimeSlots(r.slots || []);
    } catch (e) {
      setSlotError(e.message || 'Failed to find times');
      setTimeSlots([]);
    }
    setFindingTimes(false);
  };

  const applySlot = (slot) => {
    setApptDate(slot.date);
    setWindowStart(slot.start_time);
    setTechMode('choose');
    setTechId(slot.technician.id);
    setTimeSlots(null);
  };

  const fmtSlotDay = (d) => {
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const fmtTime = (t) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  // Group services into appointment payloads. Lines that share a cadence
  // (and interval, when custom) ride a single parent appointment as
  // add-ons; lines on different cadences fan out into their own parent
  // series so quarterly pest + monthly lawn can co-exist on this form.
  // One-time lines all share one one-time parent.
  // Group key + label include the cadence-specific config so different
  // configurations (e.g. "3rd Wed" vs "1st Mon") become separate parent
  // appointments instead of collapsing into one group.
  const groupKey = (group) => {
    if (group.cadence === 'custom') return `custom:${group.intervalDays}`;
    if (group.cadence === 'monthly_nth_weekday') return `nth:${group.nth}:${group.weekday}`;
    return group.cadence;
  };
  const groupLabel = (group) => {
    if (group.cadence === 'custom') return `Every ${group.intervalDays} days`;
    if (group.cadence === 'monthly_nth_weekday') {
      const nthOpt = NTH_OPTIONS.find((o) => o.value === parseInt(group.nth));
      const wOpt = WEEKDAY_OPTIONS.find((o) => o.value === parseInt(group.weekday));
      return `${nthOpt?.label || group.nth} ${wOpt?.label || ''}`.trim();
    }
    const found = CADENCE_OPTIONS.find((o) => o.value === group.cadence);
    return found ? found.label : group.cadence;
  };
  const groupServicesByCadence = (rows) => {
    const groups = new Map();
    for (const s of rows) {
      const cadence = s.cadence || 'one_time';
      const wd = Number.isFinite(parseInt(s.weekday)) ? parseInt(s.weekday) : 3;
      let key;
      if (cadence === 'custom') key = `custom:${parseInt(s.intervalDays) || 30}`;
      else if (cadence === 'monthly_nth_weekday') key = `nth:${parseInt(s.nth) || 3}:${wd}`;
      else key = cadence;
      if (!groups.has(key)) {
        groups.set(key, {
          cadence,
          intervalDays: cadence === 'custom' ? parseInt(s.intervalDays) || 30 : null,
          nth: cadence === 'monthly_nth_weekday' ? parseInt(s.nth) || 3 : null,
          weekday: cadence === 'monthly_nth_weekday' ? wd : null,
          lines: [],
        });
      }
      groups.get(key).lines.push(s);
    }
    return Array.from(groups.values());
  };

  // Tracks cadence-group keys already POSTed during this modal session.
  // If the loop fails partway (e.g. quarterly succeeded, monthly errored),
  // a retry click skips the keys that landed so we don't double-book the
  // customer. Reset on successful close.
  const createdGroupKeysRef = useRef(new Set());
  // For one-time discounts (fixed_amount / free_service) we send the
  // discount on the FIRST POSTed group only. Persist across retries so a
  // transient failure between groups can't re-send the discount on the
  // next attempt's first not-yet-created group. Reset on successful close.
  const discountConsumedRef = useRef(false);

  // Recurring preview — for each cadence group, produce up to 4 future
  // dates Virginia will land on. Honors skip-weekends shift so what's
  // shown matches what gets saved. Renders below the Visits input.
  const recurringPreview = useMemo(() => {
    if (!apptDate) return [];
    const groups = groupServicesByCadence(services);
    const recurring = groups.filter((g) => g.cadence !== 'one_time');
    if (recurring.length === 0) return [];
    const parsedCount = Number.parseInt(recurringCount, 10);
    const isFixed = Number.isInteger(parsedCount) && parsedCount >= 2;
    // Server treats recurringCount as TOTAL visits (initial + children) and
    // spawns plannedCount - 1 children in BOTH modes (ongoing pre-seeds a
    // 4-visit rolling window = parent + 3 children; fixed-count count=N =
    // parent + N-1 children). The preview shows future-only chips, so the
    // chip count must match plannedCount - 1 for both modes.
    const plannedCount = isFixed ? parsedCount : 4;
    const limit = Math.min(Math.max(plannedCount - 1, 0), 4);
    const dir = weekendShift === 'back' ? 'back' : 'forward';
    return recurring.map((group) => {
      // Dedupe + iterate until we've collected `limit` unique dates so
      // the chips reflect the server's spawn behavior (which now skips
      // duplicate weekend-shifted dates and keeps going until N children
      // are inserted).
      const dates = [];
      const seen = new Set();
      seen.add(String(apptDate || '').split('T')[0]);
      const maxAttempts = limit * 4 + 30;
      // Server spawn loops start at i=1. For monthly_nth_weekday, i=0
      // returns the Nth weekday of the CURRENT month (which can be in the
      // past relative to apptDate), so the preview must start from 1 too
      // — otherwise a 3rd-Wed series anchored on April 20 would show
      // April 15 as the first chip while the calendar's first child is
      // actually May.
      let attempt = 1;
      while (dates.length < limit && attempt < maxAttempts) {
        const opts = { intervalDays: group.intervalDays, nth: group.nth, weekday: group.weekday };
        const raw = nextRecurringDate(apptDate, group.cadence, attempt, opts);
        attempt++;
        const shifted = shiftPastWeekendClient(raw, !!skipWeekends, dir);
        const key = shifted.toISOString().split('T')[0];
        if (seen.has(key)) continue;
        seen.add(key);
        dates.push(shifted);
      }
      return { group, dates };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, apptDate, recurringCount, skipWeekends, weekendShift]);

  // Compute window_end given a start time and a duration in minutes.
  const computeWindowEnd = (start, durationMin) => {
    const [h, m] = start.split(':').map(Number);
    const endMin = h * 60 + m + Math.max(durationMin || 0, 30);
    return `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
  };

  // Submit
  const handleSubmit = async () => {
    if (!selectedCustomer || services.length === 0) return;
    setSaving(true);
    const groups = groupServicesByCadence(services);
    const results = [];
    let firstError = null;
    // Discount semantics across cadence groups:
    //   - percentage: rides every group (each visit gets the same % off).
    //   - fixed_amount / free_service: must apply ONCE across the booking,
    //     otherwise mixed-cadence ($50 off applied to monthly AND quarterly)
    //     would multiply the discount.
    const discountAppliesToAll = discountType === 'percentage';
    for (const group of groups) {
      const key = groupKey(group);
      // Skip groups already created in a prior attempt of this submit
      // session — a retry after partial failure shouldn't duplicate them.
      if (createdGroupKeysRef.current.has(key)) continue;
      try {
        const [primary, ...extras] = group.lines;
        const groupSubtotal = group.lines.reduce((sum, s) => {
          const n = parseFloat(s.price);
          return sum + (isNaN(n) ? 0 : n);
        }, 0);
        const groupDuration = group.lines.reduce((sum, s) => sum + (s.duration || s.default_duration_minutes || 30), 0);
        const addons = extras.map((s) => {
          const p = parseFloat(s.price);
          return {
            serviceId: s.id || null,
            serviceName: s.name,
            name: s.name,
            price: isNaN(p) ? null : p,
          };
        });
        const isRecurring = group.cadence !== 'one_time';
        const parsedRecurringCount = Number.parseInt(recurringCount, 10);
        const hasFiniteRecurringCount = Number.isInteger(parsedRecurringCount) && parsedRecurringCount >= 2;
        const body = {
          customerId: selectedCustomer.id,
          scheduledDate: apptDate,
          serviceType: primary.name,
          serviceId: primary.id || null,
          serviceAddons: addons,
          windowStart,
          windowEnd: computeWindowEnd(windowStart, groupDuration),
          assignmentMode: techMode,
          technicianId: techMode === 'choose' ? techId : undefined,
          // Parent's estimated_price reflects the whole group so completion-
          // triggered auto-invoicing (server/routes/admin-dispatch.js) charges
          // the full visit. Per-line prices stay on each addon row for
          // breakdown / analytics.
          estimatedPrice: groupSubtotal > 0 ? groupSubtotal : null,
          // Send the summed group duration so the server's
          // estimated_duration_minutes matches the actual time window
          // (windowStart..windowEnd) instead of just the primary line's
          // catalog default — capacity / dispatch math depends on this.
          estimatedDuration: groupDuration > 0 ? groupDuration : undefined,
          urgency: 'routine',
          notes: customerNotes || undefined,
          internalNotes: internalNotes || undefined,
          sendConfirmationSms: sendSms,
          isRecurring,
          recurringPattern: isRecurring ? group.cadence : undefined,
          // Send undefined for ongoing so the server's plannedCount fallback
          // (recurringCount || 4) owns the default. Only send a finite count
          // when the operator explicitly typed >= 2 in the Visits input.
          recurringCount: isRecurring && hasFiniteRecurringCount ? parsedRecurringCount : undefined,
          recurringOngoing: isRecurring ? !hasFiniteRecurringCount : undefined,
          recurringIntervalDays: isRecurring && group.cadence === 'custom' ? group.intervalDays : undefined,
          recurringNth: isRecurring && group.cadence === 'monthly_nth_weekday' ? group.nth : undefined,
          recurringWeekday: isRecurring && group.cadence === 'monthly_nth_weekday' ? group.weekday : undefined,
          skipWeekends: isRecurring ? !!skipWeekends : undefined,
          weekendShift: isRecurring && skipWeekends ? weekendShift : undefined,
          boosterMonths: isRecurring
            ? (() => {
                // Union of every line's booster month picks in this cadence
                // group. Operators most often configure boosters on the
                // primary, but if they tag chips on add-on lines too, those
                // months should also produce booster visits.
                const set = new Set();
                for (const s of group.lines) {
                  if (Array.isArray(s.boosterMonths)) {
                    for (const m of s.boosterMonths) set.add(parseInt(m));
                  }
                }
                const arr = Array.from(set).filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
                return arr.length > 0 ? arr : undefined;
              })()
            : undefined,
          discountType: (discountType && (discountAppliesToAll || !discountConsumedRef.current)) ? discountType : undefined,
          discountAmount: (discountType && discountAmount !== '' && (discountAppliesToAll || !discountConsumedRef.current))
            ? Number(discountAmount)
            : undefined,
          createInvoice: true,
          sendConfirmation: sendSms,
        };
        const r = await adminFetch('/admin/schedule', { method: 'POST', body: JSON.stringify(body) });
        createdGroupKeysRef.current.add(key);
        if (discountType && !discountAppliesToAll) discountConsumedRef.current = true;
        results.push(r);
      } catch (e) {
        firstError = { label: groupLabel(group), message: e.message };
        break;
      }
    }
    setSaving(false);
    if (firstError) {
      const created = createdGroupKeysRef.current.size;
      const total = groups.length;
      const lead = created > 0
        ? `${created} of ${total} appointment series created. ${firstError.label} failed: ${firstError.message}.`
        : `Failed: ${firstError.message}`;
      const tail = created > 0 ? ' Click Save to retry the rest.' : '';
      alert(lead + tail);
      return;
    }
    const apptCount = results.length || createdGroupKeysRef.current.size;
    const message = apptCount === 1
      ? 'Appointment created — invoice will send with service report'
      : `${apptCount} appointment series created — invoices will send with each service report`;
    setToast(message);
    setTimeout(() => {
      createdGroupKeysRef.current = new Set();
      discountConsumedRef.current = false;
      onCreated?.({ id: results[0]?.id, scheduledDate: apptDate });
    }, 1200);
  };

  const overlayStyle = {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: isMobile ? D.bg : 'rgba(0,0,0,0.3)',
    display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
    overflow: 'auto', padding: isMobile ? 0 : 20,
  };

  const modalStyle = {
    background: D.bg, width: isMobile ? '100%' : 560, maxWidth: '100%',
    maxHeight: isMobile ? '100%' : '90vh', overflow: 'auto',
    borderRadius: isMobile ? 0 : 16, padding: isMobile ? 0 : 24,
    border: isMobile ? 'none' : `1px solid ${D.border}`,
  };

  const canSubmit = !!selectedCustomer && !!selectedService && !saving;

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modalStyle}>
        <style>{`
          .waves-sq-date::-webkit-calendar-picker-indicator { opacity: 0.5; cursor: pointer; filter: grayscale(1); transition: opacity 0.15s; }
          .waves-sq-date::-webkit-calendar-picker-indicator:hover { opacity: 1; }
          .waves-sq-date::-webkit-datetime-edit { color: #18181B; font-family: inherit; font-weight: 400; }
          .waves-sq-date::-webkit-datetime-edit-fields-wrapper { padding: 0; }
          .waves-sq-row { transition: background-color 0.12s ease; }
          .waves-sq-row:hover { background: #F4F4F5; }
          .waves-sq-row:active { background: #E4E4E7; }
          .waves-sq-row:last-child { border-bottom: none !important; }
        `}</style>
        {/* Header — IMG_3713 pattern on mobile: circular × left, centered title, Save pill right */}
        {isMobile ? (
          <div style={{
            position: 'sticky', top: 0, zIndex: 10, background: D.bg,
            height: 60, padding: '0 16px',
          }}>
            <div style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <h1 style={{ fontSize: 17, fontWeight: 700, color: '#18181B', margin: 0 }}>
                New Appointment
              </h1>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                  width: 36, height: 36, borderRadius: 18, border: 'none',
                  background: '#FFFFFF', color: '#18181B', fontSize: 18, lineHeight: 1,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >×</button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                style={{
                  position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
                  padding: '9px 20px', borderRadius: 999, border: 'none',
                  background: canSubmit ? '#18181B' : '#E4E4E7',
                  color: canSubmit ? '#fff' : '#A1A1AA',
                  fontSize: 14, fontWeight: 600,
                  cursor: canSubmit ? 'pointer' : 'default',
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h1 style={{ fontSize: 28, fontWeight: 400, color: '#18181B', margin: 0 }}>New Appointment</h1>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 22, cursor: 'pointer', minWidth: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
          </div>
        )}
        <div style={{ padding: isMobile ? '0 16px 24px' : 0 }}>

        {/* Toast */}
        {toast && <div style={{ background: '#FFFFFF', border: `1px solid ${D.border}`, borderRadius: 6, padding: '10px 14px', marginBottom: 12, color: D.text, fontSize: 13, fontWeight: 500 }}>{toast}</div>}

        {/* Section 1: Customer */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#18181B', marginBottom: 10 }}>Customer</div>
          {!selectedCustomer ? (
            <div>
              {/* Inner relative wrapper so the dropdown anchors to the
                  input — not to the whole block (the "+ New customer"
                  button used to push the dropdown below itself). */}
              <div style={{ position: 'relative' }}>
                <input
                  ref={searchRef}
                  type="text"
                  value={customerSearch}
                  onChange={(e) => doSearch(e.target.value)}
                  placeholder="Search by name or phone..."
                  style={inputStyle}
                  // iOS Safari treats a bare <input type="text"> as a generic field
                  // and offers password / card / address autofill via the QuickType
                  // bar. That bar overlaps the results dropdown and auto-corrects
                  // typed text, so operators report "the search vanished". These
                  // attributes opt out of every iOS autofill / autocorrect path.
                  name="appt-customer-search"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  inputMode="search"
                  enterKeyHint="search"
                />
                {customerSearch.trim().length >= 2 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: '0 0 10px 10px', maxHeight: 240, overflowY: 'auto', WebkitOverflowScrolling: 'touch', zIndex: 20 }}>
                    {customerResults.map(c => (
                      <div key={c.id} onClick={() => selectCustomer(c)} className="waves-sq-row" style={{ padding: '12px 14px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 14, color: '#18181B', minHeight: 48, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong>{c.firstName} {c.lastName}</strong>
                        <span style={{ color: D.muted, fontSize: 12 }}>{c.phone || ''}</span>
                        {c.tier && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: `${TIER_COLORS[c.tier] || D.teal}22`, color: TIER_COLORS[c.tier] || D.teal }}>{c.tier}</span>}
                      </div>
                    ))}
                    {!customerLoading && !customerError && customerResults.length === 0 && (
                      <div style={{ padding: '14px', textAlign: 'center', color: D.muted, fontSize: 13 }}>
                        No customers match &ldquo;{customerSearch}&rdquo;
                      </div>
                    )}
                    {!customerLoading && customerError && (
                      <div style={{ padding: '14px', textAlign: 'center', color: D.red, fontSize: 13 }}>
                        Search failed: {customerError}
                        <div style={{ fontSize: 11, marginTop: 4, color: D.muted }}>
                          Token may have expired — log out + back in, then retry.
                        </div>
                      </div>
                    )}
                    {customerLoading && customerResults.length === 0 && (
                      <div style={{ padding: '14px', textAlign: 'center', color: D.muted, fontSize: 13 }}>
                        Searching…
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button onClick={() => setShowQuickAdd(!showQuickAdd)} style={{ background: 'none', border: 'none', color: D.text, fontSize: 13, fontWeight: 500, cursor: 'pointer', marginTop: 6, padding: '4px 0', minHeight: 44, display: 'inline-flex', alignItems: 'center', textDecoration: 'underline', textUnderlineOffset: 3 }}>+ New customer</button>
              {showQuickAdd && (
                <div style={{ marginTop: 8, padding: 12, background: '#FFFFFF', borderRadius: 10, border: `1px solid #E4E4E7` }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div><label style={labelStyle}>First Name</label><input value={quickAdd.firstName} onChange={e => setQuickAdd(q => ({ ...q, firstName: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>Last Name</label><input value={quickAdd.lastName} onChange={e => setQuickAdd(q => ({ ...q, lastName: e.target.value }))} style={inputStyle} /></div>
                  </div>
                  <div style={{ marginBottom: 8 }}><label style={labelStyle}>Phone</label><input value={quickAdd.phone} onChange={e => setQuickAdd(q => ({ ...q, phone: e.target.value }))} style={inputStyle} /></div>
                  <div style={{ marginBottom: 8 }}><label style={labelStyle}>Email</label><input type="email" value={quickAdd.email} onChange={e => setQuickAdd(q => ({ ...q, email: e.target.value }))} style={inputStyle} /></div>
                  <div style={{ marginBottom: 8 }}>
                    <label style={labelStyle}>Address</label>
                    <AddressAutocomplete
                      value={quickAdd.address}
                      onChange={(val) => setQuickAdd(q => ({ ...q, address: val }))}
                      onSelect={(parts) => setQuickAdd(q => ({
                        ...q,
                        address: parts.line1 || parts.formatted || '',
                        city: parts.city || q.city,
                        zip: parts.zip || q.zip,
                      }))}
                      style={inputStyle}
                      placeholder=""
                    />
                  </div>
                  <button onClick={handleQuickAdd} style={{ padding: '10px 16px', background: D.text, color: D.white, border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', minHeight: 44, width: '100%' }}>Add customer</button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#FFFFFF', borderRadius: 10, padding: 12, border: `1px solid #E4E4E7` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#18181B', fontSize: 14 }}>{selectedCustomer.firstName} {selectedCustomer.lastName}</div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{selectedCustomer.address || `${selectedCustomer.city || ''}`}</div>
                {selectedCustomer.phone && <div style={{ fontSize: 12, color: D.muted }}>{selectedCustomer.phone}</div>}
              </div>
              {selectedCustomer.tier && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: `${TIER_COLORS[selectedCustomer.tier] || D.teal}22`, color: TIER_COLORS[selectedCustomer.tier] || D.teal, fontWeight: 600 }}>{selectedCustomer.tier}</span>}
              <button onClick={() => { setSelectedCustomer(null); setCustomerSearch(''); }} style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 16, minWidth: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>
          )}
        </div>

        {/* Section 2: Services — stack of line items. The first row is the
            primary service (drives serviceType + service_id on the parent
            appointment); rows beyond that persist as scheduled_service_addons
            so a single visit can carry e.g. quarterly pest + rodent stations. */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#18181B' }}>
              Services {services.length > 1 ? <span style={{ fontWeight: 400, color: D.muted, fontSize: 12 }}>({services.length})</span> : null}
            </div>
            {services.length > 0 && subtotal > 0 && (
              <div style={{ fontSize: 13, fontWeight: 600, color: '#18181B' }}>
                Total: ${subtotal.toFixed(2)}
              </div>
            )}
          </div>

          {/* Existing service line items */}
          {services.map((svc, idx) => (
            <div key={`line-${idx}-${svc.id || svc.name}`} style={{ background: '#FFFFFF', borderRadius: 10, padding: 12, border: `1px solid #E4E4E7`, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: '#18181B', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{svc.name}</div>
                  {idx === 0 && services.length > 1 && (
                    <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 }}>Primary</div>
                  )}
                </div>
                <button
                  onClick={() => removeServiceAt(idx)}
                  aria-label="Remove service"
                  style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 16, minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >✕</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: svc.cadence === 'custom' ? '1fr 1fr 100px' : '1fr 1fr', gap: 8 }}>
                <div>
                  <label style={labelStyle}>Price</label>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: D.muted, fontSize: 14 }}>$</span>
                    <input
                      type="number"
                      value={svc.price ?? ''}
                      onChange={(e) => updateServicePrice(idx, e.target.value)}
                      style={{ ...inputStyle, paddingLeft: 28 }}
                    />
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Repeats</label>
                  <select
                    value={svc.cadence || 'one_time'}
                    onChange={(e) => updateServiceCadence(idx, e.target.value)}
                    style={inputStyle}
                  >
                    {CADENCE_OPTIONS.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>
                {svc.cadence === 'custom' && (
                  <div>
                    <label style={labelStyle}>Days</label>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={svc.intervalDays ?? 30}
                      onChange={(e) => updateServiceInterval(idx, e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                )}
              </div>
              {svc.cadence === 'monthly_nth_weekday' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                  <div>
                    <label style={labelStyle}>Nth</label>
                    <select
                      value={svc.nth ?? 3}
                      onChange={(e) => updateServiceNth(idx, parseInt(e.target.value))}
                      style={inputStyle}
                    >
                      {NTH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Weekday</label>
                    <select
                      value={svc.weekday ?? 3}
                      onChange={(e) => updateServiceWeekday(idx, parseInt(e.target.value))}
                      style={inputStyle}
                    >
                      {WEEKDAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {svc.cadence && svc.cadence !== 'one_time' && (
                <div style={{ marginTop: 10 }}>
                  <label style={labelStyle}>Booster months (optional)</label>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {MONTH_CHIPS.map((m) => {
                      const on = (svc.boosterMonths || []).includes(m.value);
                      return (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => toggleBoosterMonth(idx, m.value)}
                          aria-label={`Booster month ${m.value}`}
                          style={{
                            width: 32, height: 32, borderRadius: 6, fontSize: 12,
                            fontWeight: 600, cursor: 'pointer',
                            background: on ? D.teal : 'transparent',
                            color: on ? '#fff' : D.muted,
                            border: `1px solid ${on ? D.teal : D.border}`,
                            padding: 0,
                          }}
                        >{m.label}</button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Search box — shown initially (no services yet) or when adding another */}
          {(services.length === 0 || addingService) && (
            <div>
              <input
                type="text"
                value={serviceSearch}
                onChange={(e) => setServiceSearch(e.target.value)}
                placeholder={services.length === 0 ? 'Search by service name...' : 'Search to add another service...'}
                style={inputStyle}
                autoFocus={addingService}
                // See customer-search input for the iOS autofill rationale.
                name="appt-service-search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="search"
                enterKeyHint="search"
              />
              {serviceSearch.trim().length > 0 && (
                <div style={{ marginTop: 8, background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, maxHeight: 280, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  {serviceResults.map((svc, i) => (
                    <div
                      key={`${svc.id || svc.name}-${i}`}
                      onClick={() => addServiceFromCatalog(svc)}
                      className="waves-sq-row"
                      style={{ padding: '12px 14px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 14, color: '#18181B', minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                    >
                      <span style={{ flex: 1, fontWeight: 500 }}>{svc.name}</span>
                    </div>
                  ))}
                  {!serviceLoading && !serviceError && serviceResults.length === 0 && (
                    <div style={{ padding: '14px', textAlign: 'center', color: D.muted, fontSize: 13 }}>
                      No active services match &ldquo;{serviceSearch}&rdquo;
                      <div style={{ fontSize: 11, marginTop: 4 }}>
                        Check Service Library — only active, unarchived services appear here.
                      </div>
                    </div>
                  )}
                  {!serviceLoading && serviceError && (
                    <div style={{ padding: '14px', textAlign: 'center', color: D.red, fontSize: 13 }}>
                      Search failed: {serviceError}
                      <div style={{ fontSize: 11, marginTop: 4, color: D.muted }}>
                        Token may have expired — log out + back in, then retry.
                      </div>
                    </div>
                  )}
                  {serviceLoading && serviceResults.length === 0 && (
                    <div style={{ padding: '14px', textAlign: 'center', color: D.muted, fontSize: 13 }}>
                      Searching…
                    </div>
                  )}
                </div>
              )}
              {addingService && (
                <button
                  onClick={() => { setAddingService(false); setServiceSearch(''); setServiceResults([]); }}
                  style={{ background: 'none', border: 'none', color: D.muted, fontSize: 12, fontWeight: 500, cursor: 'pointer', marginTop: 6, padding: '4px 0', minHeight: 36, display: 'inline-flex', alignItems: 'center' }}
                >Cancel</button>
              )}
            </div>
          )}

          {/* Add another service — visible once at least one service is on the appt */}
          {services.length > 0 && !addingService && (
            <button
              type="button"
              onClick={() => setAddingService(true)}
              style={{
                width: '100%', padding: '10px 12px', background: 'transparent',
                border: `1px dashed ${D.border}`, borderRadius: 8, color: D.text,
                fontSize: 13, fontWeight: 500, cursor: 'pointer', minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >+ Add another service</button>
          )}

          {/* Visit count — applies to every recurring cadence group on
              this appointment. Empty = ongoing (auto-extends). A finite
              number caps the series at that many visits. */}
          {services.some((s) => s.cadence && s.cadence !== 'one_time') && (
            <div style={{ borderTop: `1px solid ${D.border}`, marginTop: 12, paddingTop: 12 }}>
              <label style={labelStyle}>Visits (leave blank for ongoing)</label>
              <input
                type="number"
                min={2}
                max={24}
                value={recurringCount}
                onChange={(e) => setRecurringCount(e.target.value)}
                placeholder="Ongoing"
                style={inputStyle}
              />
              {recurringPreview.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {recurringPreview.map(({ group, dates }) => (
                    <div key={groupKey(group)} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                      <span style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500, minWidth: 96 }}>
                        {groupLabel(group)}
                      </span>
                      {dates.map((d, i) => (
                        <span
                          key={`${groupKey(group)}-${i}`}
                          style={{
                            fontSize: 11, color: D.text, padding: '2px 8px',
                            background: '#F4F4F5', border: `1px solid ${D.border}`,
                            borderRadius: 4, whiteSpace: 'nowrap',
                          }}
                        >
                          {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                      ))}
                      {!Number.isInteger(Number.parseInt(recurringCount, 10)) && (
                        <span style={{ fontSize: 11, color: D.muted }}>… then auto-extends</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Section 3: Date */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#18181B' }}>Date</div>
            {selectedCustomer && selectedService && (
              <button
                onClick={handleFindTimes}
                disabled={findingTimes}
                style={{
                  padding: '6px 12px', background: findingTimes ? '#E4E4E7' : `${D.teal}15`,
                  color: D.teal, border: `1px solid ${D.teal}55`, borderRadius: 8,
                  fontSize: 12, fontWeight: 600, cursor: findingTimes ? 'default' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
                title="Rank the best slots by drive-time detour"
              >
                ✨ {findingTimes ? 'Finding...' : 'Find best times'}
              </button>
            )}
          </div>

          {slotError && (
            <div style={{ background: `${D.red}15`, border: `1px solid ${D.red}55`, borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12, color: D.red }}>
              {slotError}
            </div>
          )}

          {timeSlots !== null && (
            <div style={{ marginBottom: 12, background: '#FFFFFF', border: `1px solid ${D.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {timeSlots.length > 0 ? `Top ${timeSlots.length} Slots (ranked by detour)` : 'No feasible slots in next 7 days'}
                </div>
                <button onClick={() => setTimeSlots(null)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 16, cursor: 'pointer', padding: 4 }}>✕</button>
              </div>
              {timeSlots.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                  {timeSlots.map((slot) => (
                    <button
                      key={`${slot.date}-${slot.technician.id}-${slot.start_time}`}
                      onClick={() => applySlot(slot)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                        background: D.card, border: `1px solid ${D.border}`, borderRadius: 8,
                        cursor: 'pointer', textAlign: 'left', minHeight: 52,
                      }}
                    >
                      <div style={{
                        fontSize: 11, fontWeight: 700, color: D.teal, background: `${D.teal}15`,
                        borderRadius: 6, padding: '4px 8px', minWidth: 28, textAlign: 'center',
                      }}>#{slot.rank}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#18181B' }}>
                          {fmtSlotDay(slot.date)} · {fmtTime(slot.start_time)} · {slot.technician.name}
                        </div>
                        <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                          +{slot.detour_minutes} min detour · between {slot.insertion.after} and {slot.insertion.before}
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: D.teal, fontWeight: 600 }}>Use →</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={labelStyle}>Date</label>
              <input type="date" value={apptDate} onChange={e => setApptDate(e.target.value)} className="waves-sq-date" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Time</label>
              <input type="time" value={windowStart} onChange={e => setWindowStart(e.target.value)} step={900} className="waves-sq-date" style={inputStyle} />
            </div>
          </div>

          {/* Skip weekends — only meaningful when at least one service is
              recurring. Applies to recurring spawns + the auto-extend
              cron via skip_weekends/weekend_shift on scheduled_services. */}
          {services.some((s) => s.cadence && s.cadence !== 'one_time') && (
            <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 10, marginTop: 4 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 36, marginBottom: skipWeekends ? 8 : 0 }}>
                <input
                  type="checkbox"
                  checked={skipWeekends}
                  onChange={(e) => setSkipWeekends(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: D.teal }}
                />
                <span style={{ fontSize: 13, fontWeight: 500, color: '#18181B' }}>Skip weekends on recurring visits</span>
              </label>
              {skipWeekends && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => setWeekendShift('forward')}
                    style={{
                      flex: 1, padding: '8px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      background: weekendShift === 'forward' ? D.teal : 'transparent',
                      color: weekendShift === 'forward' ? '#fff' : D.muted,
                      border: `1px solid ${weekendShift === 'forward' ? D.teal : D.border}`,
                    }}
                  >Move to Monday</button>
                  <button
                    type="button"
                    onClick={() => setWeekendShift('back')}
                    style={{
                      flex: 1, padding: '8px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      background: weekendShift === 'back' ? D.teal : 'transparent',
                      color: weekendShift === 'back' ? '#fff' : D.muted,
                      border: `1px solid ${weekendShift === 'back' ? D.teal : D.border}`,
                    }}
                  >Pull to Friday</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Section 3.5: Discount — applies to both one-time and recurring.
            Lives in its own section so the discount picker is always
            visible, regardless of the Recurring toggle above. */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#18181B', marginBottom: 10 }}>Discount</div>
          <label style={labelStyle}>Discount (optional)</label>
          <select
            value={discountPresetId}
            onChange={(e) => applyDiscountPreset(e.target.value)}
            style={inputStyle}
          >
            <option value="">No discount</option>
            {discountPresets.map((d) => {
              const amt = d.discount_type === 'free_service'
                ? 'Free'
                : d.discount_type === 'percentage'
                  ? `${Number(d.amount).toFixed(d.amount % 1 ? 2 : 0)}%`
                  : `$${Number(d.amount).toFixed(2)}`;
              return (
                <option key={d.id} value={d.id}>
                  {d.name} — {amt}
                </option>
              );
            })}
          </select>
        </div>

        {/* Section 3b: Technician — its own section below Recurring */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#18181B', marginBottom: 10 }}>Technician</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[{ v: 'auto', l: 'Auto' }, { v: 'choose', l: 'Choose' }].map(o => (
              <button key={o.v} onClick={() => setTechMode(o.v)} style={{
                flex: 1, padding: '10px 8px', borderRadius: 8, border: `1px solid ${techMode === o.v ? D.teal : D.border}`,
                background: techMode === o.v ? `${D.teal}22` : D.input, color: techMode === o.v ? D.teal : D.text,
                fontSize: 13, cursor: 'pointer', minHeight: 44,
              }}>{o.l}</button>
            ))}
          </div>
          {techMode === 'choose' && (
            <select value={techId} onChange={e => setTechId(e.target.value)} style={{ ...inputStyle, marginTop: 8 }}>
              <option value="">Select technician...</option>
              {techs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
        </div>

        {/* Section 4: Notes & Confirm */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#18181B', marginBottom: 10 }}>Notes</div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Customer Notes</label>
            <textarea value={customerNotes} onChange={e => setCustomerNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ ...labelStyle, color: D.amber }}>Internal Notes (Admin only)</label>
            <textarea value={internalNotes} onChange={e => setInternalNotes(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 44 }}>
              <input type="checkbox" checked={sendSms} onChange={e => setSendSms(e.target.checked)} style={{ width: 18, height: 18, accentColor: D.green }} />
              <span style={{ fontSize: 13, color: D.text }}>Send confirmation SMS</span>
            </label>
          </div>
          {!isMobile && (
            <button disabled={!selectedCustomer || !selectedService || saving} onClick={handleSubmit} style={{
              width: '100%', padding: '14px 20px', background: D.text, color: D.white,
              border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: 'pointer',
              minHeight: 52, opacity: (!selectedCustomer || !selectedService || saving) ? 0.5 : 1,
              transition: 'opacity 0.15s',
            }}>
              {saving ? 'Scheduling…' : 'Schedule appointment'}
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
