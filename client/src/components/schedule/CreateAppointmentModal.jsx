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
import { etDateString } from '../../lib/timezone';

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


const FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'bimonthly', label: 'Every 2 months' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'triannual', label: 'Every 4 months' },
  { value: 'monthly_nth_weekday', label: 'Every month on the Nth weekday' },
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

function nextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const { nth, weekday, intervalDays } = opts;
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : etDateString();
  const base = new Date(safe + 'T12:00:00');
  if (isNaN(base.getTime())) return new Date();
  const nthNum = (nth != null && nth !== '' && !isNaN(parseInt(nth))) ? parseInt(nth) : null;
  const wdayNum = (weekday != null && weekday !== '' && !isNaN(parseInt(weekday))) ? parseInt(weekday) : null;
  const intNum = (intervalDays != null && intervalDays !== '' && !isNaN(parseInt(intervalDays))) ? parseInt(intervalDays) : null;
  if (pattern === 'monthly_nth_weekday' && nthNum != null && wdayNum != null) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1, 12, 0, 0);
    const firstW = d.getDay();
    const offset = (wdayNum - firstW + 7) % 7;
    d.setDate(1 + offset + (nthNum - 1) * 7);
    return isNaN(d.getTime()) ? base : d;
  }
  const intervals = { daily: 1, weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60, quarterly: 91, triannual: 122 };
  let gap;
  if (pattern === 'custom' && intNum) gap = Math.max(1, intNum);
  else gap = intervals[pattern] || 91;
  const d = new Date(base);
  d.setDate(d.getDate() + gap * i);
  return isNaN(d.getTime()) ? base : d;
}

const inputStyle = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 6, color: D.text, fontSize: 16, fontFamily: 'inherit', fontWeight: 400, outline: 'none', boxSizing: 'border-box', minHeight: 44, colorScheme: 'light' };
const labelStyle = { fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500, display: 'block', marginBottom: 4 };
const sectionStyle = { background: D.card, borderRadius: 8, padding: 16, border: `1px solid ${D.border}`, marginBottom: 12 };

export default function CreateAppointmentModal({ defaultDate, defaultWindowStart, defaultDurationMinutes, defaultTechId, defaultCustomer = null, onClose, onCreated }) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const searchRef = useRef(null);

  // Customer state
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
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
  const [addingService, setAddingService] = useState(false);
  const selectedService = services[0] || null;

  // Debounced Service Library search (same endpoint + filters as /admin/services catalog).
  useEffect(() => {
    const q = serviceSearch.trim();
    if (!q) { setServiceResults([]); setServiceLoading(false); return; }
    setServiceLoading(true);
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
      } catch {
        setServiceResults([]);
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
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFreq, setRecurringFreq] = useState('quarterly');
  const [recurringCount, setRecurringCount] = useState(4);
  const [recurringOngoing, setRecurringOngoing] = useState(true);
  const [recurringNth, setRecurringNth] = useState(3);
  const [recurringWeekday, setRecurringWeekday] = useState(3);
  const [recurringIntervalDays, setRecurringIntervalDays] = useState(30);
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

  // Per-line price helpers. Each entry in `services` carries its own `price`
  // string (so an operator can override goodwill / loyalty pricing on one
  // line without touching the others). The summed total drives the discount
  // base and the totals strip.
  const updateServicePrice = (idx, val) => {
    setServices((arr) => arr.map((s, i) => (i === idx ? { ...s, price: val } : s)));
  };
  const removeServiceAt = (idx) => {
    setServices((arr) => arr.filter((_, i) => i !== idx));
  };
  const addServiceFromCatalog = (svc) => {
    const defaultPrice = svc.priceMin || svc.base_price || '';
    setServices((arr) => [...arr, { ...svc, price: defaultPrice ? String(defaultPrice) : '' }]);
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

  // Customer search
  const doSearch = async (val) => {
    setCustomerSearch(val);
    if (val.length >= 2) {
      try {
        const r = await adminFetch(`/admin/customers?search=${encodeURIComponent(val)}&limit=8`);
        setCustomerResults(r.customers || []);
      } catch { setCustomerResults([]); }
    } else { setCustomerResults([]); }
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

  // Submit
  const handleSubmit = async () => {
    if (!selectedCustomer || !selectedService) return;
    if (isRecurring && services.length > 1) return; // see canSubmit comment
    setSaving(true);
    try {
      // services[0] is the primary line — its name + id drive the parent
      // scheduled_services row. services[1..] are persisted as
      // scheduled_service_addons (handler already supports this shape).
      //
      // Pricing: the parent's estimated_price must reflect the WHOLE visit,
      // not just the primary line. Auto-invoicing on completion
      // (server/routes/admin-dispatch.js) reads only scheduled_services.
      // estimated_price; if we sent only the primary, multi-service
      // appointments would invoice short. Per-line prices are still
      // preserved on each addon row for analytics / breakdown.
      const [primary, ...extras] = services;
      const visitTotal = subtotal > 0 ? subtotal : null;
      const addons = extras.map((s) => {
        const p = parseFloat(s.price);
        return {
          serviceId: s.id || null,
          serviceName: s.name,
          name: s.name,
          price: isNaN(p) ? null : p,
        };
      });
      const body = {
        customerId: selectedCustomer.id,
        scheduledDate: apptDate,
        serviceType: primary.name,
        serviceId: primary.id || null,
        serviceAddons: addons,
        windowStart,
        windowEnd: getEndTime(),
        assignmentMode: techMode,
        technicianId: techMode === 'choose' ? techId : undefined,
        estimatedPrice: visitTotal,
        urgency: 'routine',
        notes: customerNotes || undefined,
        internalNotes: internalNotes || undefined,
        sendConfirmationSms: sendSms,
        isRecurring,
        recurringPattern: isRecurring ? recurringFreq : undefined,
        recurringCount: isRecurring ? (recurringOngoing ? 4 : recurringCount) : undefined,
        recurringOngoing: isRecurring ? recurringOngoing : undefined,
        recurringNth: isRecurring && recurringFreq === 'monthly_nth_weekday' ? recurringNth : undefined,
        recurringWeekday: isRecurring && recurringFreq === 'monthly_nth_weekday' ? recurringWeekday : undefined,
        recurringIntervalDays: isRecurring && recurringFreq === 'custom' ? recurringIntervalDays : undefined,
        discountType: discountType || undefined,
        discountAmount: discountType && discountAmount !== '' ? Number(discountAmount) : undefined,
        createInvoice: true,
        sendConfirmation: sendSms,
      };
      const r = await adminFetch('/admin/schedule', { method: 'POST', body: JSON.stringify(body) });
      setToast(`Appointment created${r.recurringCreated > 1 ? ` (${r.recurringCreated} total)` : ''} — invoice will send with service report`);
      setTimeout(() => { onCreated?.({ id: r.id, scheduledDate: apptDate }); }, 1200);
    } catch (e) { alert('Failed: ' + e.message); }
    setSaving(false);
  };

  // Recurring preview
  const recurringPreview = () => {
    if (!isRecurring) return null;
    const opts = { nth: recurringNth, weekday: recurringWeekday, intervalDays: recurringIntervalDays };
    const limit = Math.min(recurringOngoing ? 4 : recurringCount, 6);
    const dates = [];
    for (let i = 0; i < limit; i++) {
      const d = nextRecurringDate(apptDate, recurringFreq, i, opts);
      dates.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    return dates;
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

  // Recurring + multi-service is intentionally blocked: the schedule API
  // clones recurring children but doesn't carry addon rows forward, so
  // visits 2..N would silently lose every line beyond the primary. Until
  // the server learns to clone addons, force the operator to either drop
  // recurring or drop the extra services.
  const recurringMultiServiceBlocked = isRecurring && services.length > 1;
  const canSubmit = !!selectedCustomer && !!selectedService && !saving && !recurringMultiServiceBlocked;

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
            <div style={{ position: 'relative' }}>
              <input ref={searchRef} type="text" value={customerSearch} onChange={(e) => doSearch(e.target.value)} placeholder="Search by name or phone..." style={inputStyle} />
              {customerResults.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: '0 0 10px 10px', maxHeight: 240, overflowY: 'auto', zIndex: 20 }}>
                  {customerResults.map(c => (
                    <div key={c.id} onClick={() => selectCustomer(c)} className="waves-sq-row" style={{ padding: '12px 14px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 14, color: '#18181B', minHeight: 48, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong>{c.firstName} {c.lastName}</strong>
                      <span style={{ color: D.muted, fontSize: 12 }}>{c.phone || ''}</span>
                      {c.tier && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: `${TIER_COLORS[c.tier] || D.teal}22`, color: TIER_COLORS[c.tier] || D.teal }}>{c.tier}</span>}
                    </div>
                  ))}
                </div>
              )}
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
                  {!serviceLoading && serviceResults.length === 0 && (
                    <div style={{ padding: '14px', textAlign: 'center', color: D.muted, fontSize: 13 }}>
                      No services match &ldquo;{serviceSearch}&rdquo;
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
        </div>

        {/* Section 3a: Recurring — its own section below Date */}
        <div style={sectionStyle}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 44, marginBottom: isRecurring ? 8 : 0 }}>
            <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} style={{ width: 18, height: 18, accentColor: D.teal }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: '#18181B' }}>Recurring</span>
          </label>
          {isRecurring && recurringMultiServiceBlocked && (
            <div style={{ background: `${D.red}10`, border: `1px solid ${D.red}55`, borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12, color: D.red, lineHeight: 1.5 }}>
              Recurring with multiple services isn&rsquo;t supported yet — only the primary service would repeat on visits 2+. Either remove the extra services or turn off Recurring to save.
            </div>
          )}
          {isRecurring && (
            <div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button type="button" onClick={() => setRecurringOngoing(true)} style={{
                  flex: 1, padding: '8px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: recurringOngoing ? D.teal : 'transparent',
                  color: recurringOngoing ? '#fff' : D.muted,
                  border: `1px solid ${recurringOngoing ? D.teal : D.border}`,
                }}>Ongoing (auto-extend)</button>
                <button type="button" onClick={() => setRecurringOngoing(false)} style={{
                  flex: 1, padding: '8px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: !recurringOngoing ? D.teal : 'transparent',
                  color: !recurringOngoing ? '#fff' : D.muted,
                  border: `1px solid ${!recurringOngoing ? D.teal : D.border}`,
                }}>Fixed count</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: recurringOngoing ? '1fr' : '2fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={labelStyle}>Frequency</label>
                  <select value={recurringFreq} onChange={e => setRecurringFreq(e.target.value)} style={inputStyle}>
                    {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
                {!recurringOngoing && (
                  <div>
                    <label style={labelStyle}>Count</label>
                    <input type="number" min={2} max={24} value={recurringCount} onChange={e => setRecurringCount(parseInt(e.target.value) || 4)} style={inputStyle} />
                  </div>
                )}
              </div>
              {recurringFreq === 'monthly_nth_weekday' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={labelStyle}>Nth</label>
                    <select value={recurringNth} onChange={e => setRecurringNth(parseInt(e.target.value))} style={inputStyle}>
                      {NTH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Weekday</label>
                    <select value={recurringWeekday} onChange={e => setRecurringWeekday(parseInt(e.target.value))} style={inputStyle}>
                      {WEEKDAY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {recurringFreq === 'custom' && (
                <div style={{ marginBottom: 8 }}>
                  <label style={labelStyle}>Every N days</label>
                  <input type="number" min={1} max={365} value={recurringIntervalDays} onChange={e => setRecurringIntervalDays(parseInt(e.target.value) || 30)} style={inputStyle} />
                </div>
              )}
              {recurringPreview() && (
                <div style={{ fontSize: 11, color: D.muted, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {recurringPreview().map((d, i) => (
                    <span key={i} style={{ padding: '2px 6px', background: `${D.teal}15`, borderRadius: 4 }}>{d}</span>
                  ))}
                  {recurringOngoing
                    ? <span style={{ padding: '2px 6px' }}>… then auto-extends</span>
                    : (recurringCount > 6 && <span style={{ padding: '2px 6px' }}>+{recurringCount - 6} more</span>)}
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
