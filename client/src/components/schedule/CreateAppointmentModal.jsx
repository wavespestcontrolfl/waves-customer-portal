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
//   POST /admin/customers/quick-add       (when creating a new customer
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
import { createPortal } from 'react-dom';
import AddressAutocomplete from '../AddressAutocomplete';
import EstimateProvenanceCard from './EstimateProvenanceCard';

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
  }).then(async r => {
    if (!r.ok) {
      let message = `HTTP ${r.status}`;
      try {
        const body = await r.json();
        if (body?.error) message = body.error;
      } catch { /* keep status fallback */ }
      throw new Error(message);
    }
    return r.json();
  });
}

const TIER_COLORS = { Platinum: '#E5E4E2', Gold: '#FDD835', Silver: '#90CAF9', Bronze: '#CD7F32', 'One-Time': '#0A7EC2' };

const CATEGORY_LABELS = { recurring: 'Recurring Services', one_time: 'One-Time Treatments', assessment: 'Assessments', pest_control: 'Pest Control', lawn_care: 'Lawn Care', mosquito: 'Mosquito', termite: 'Termite', rodent: 'Rodent', tree_shrub: 'Tree & Shrub', inspection: 'Inspections', specialty: 'Specialty', other: 'Other' };


// Per-line cadence options. Each service line picks its own cadence so a
// customer can get e.g. bimonthly pest + monthly lawn from a single new-
// appointment form. The initial save is one appointment; future generated
// visits include whichever add-on service lines are due on that date.
const CADENCE_OPTIONS = [
  { value: 'one_time', label: 'One-time' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'bimonthly', label: 'Every 2 months' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'triannual', label: 'Every 4 months' },
  { value: 'semiannual', label: 'Semiannual' },
  { value: 'annual', label: 'Annual' },
  { value: 'monthly_nth_weekday', label: 'Monthly (Nth weekday)' },
  { value: 'custom', label: 'Custom (every N days)' },
];

const NTH_OPTIONS = [
  { value: 1, label: '1st' }, { value: 2, label: '2nd' },
  { value: 3, label: '3rd' }, { value: 4, label: '4th' },
  { value: 5, label: '5th / last' },
];
const WEEKDAY_OPTIONS = [
  { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURLY_TIME_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const value = `${String(h).padStart(2, '0')}:00`;
  const hour12 = h % 12 || 12;
  return { value, label: `${hour12}:00 ${h >= 12 ? 'PM' : 'AM'}` };
});

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
const ROBOTO_STACK = "'Roboto', Arial, sans-serif";

function discountAvailableForCustomer(discount, customer) {
  const requiredTier = discount?.requires_waveguard_tier || '';
  if (!requiredTier) return !discount?.is_waveguard_tier_discount;
  const customerTier = customer?.tier || customer?.waveguard_tier || '';
  if (discount?.is_waveguard_tier_discount) return customerTier === requiredTier;
  const requiredIdx = WAVEGUARD_TIER_ORDER.indexOf(requiredTier);
  const customerIdx = WAVEGUARD_TIER_ORDER.indexOf(customerTier);
  return requiredIdx < 0 || customerIdx >= requiredIdx;
}

function normalizeHourTime(value, fallback = '09:00') {
  const match = String(value || '').trim().match(/^(\d{1,2})(?::(\d{2}))?/);
  if (!match) return fallback;
  const hour = Number.parseInt(match[1], 10);
  if (!Number.isFinite(hour)) return fallback;
  return `${String(Math.min(23, Math.max(0, hour))).padStart(2, '0')}:00`;
}

function isHourTime(value) {
  return /^\d{2}:00(?::00)?$/.test(String(value || '').trim());
}

function inferServiceCadence(service) {
  const name = String(typeof service === 'string' ? service : service?.name || '').toLowerCase();
  const frequency = String(typeof service === 'object' ? service?.frequency || '' : '').toLowerCase();
  const billingType = String(typeof service === 'object' ? service?.billing_type || '' : '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const visitsPerYear = Number(typeof service === 'object' ? service?.visits_per_year : null);
  if (billingType && billingType !== 'recurring') return { cadence: 'one_time', intervalDays: 30 };
  if (/\bevery[_\s-]*6[_\s-]*weeks?\b/.test(frequency)) return { cadence: 'custom', intervalDays: 42 };
  if (['bimonthly', 'bi_monthly', 'every_2_months'].includes(frequency)) return { cadence: 'bimonthly', intervalDays: 30 };
  if (['quarterly', 'every_3_months'].includes(frequency)) return { cadence: 'quarterly', intervalDays: 30 };
  if (['triannual', 'every_4_months'].includes(frequency)) return { cadence: 'triannual', intervalDays: 30 };
  if (['semiannual', 'semi_annual', 'biannual', 'every_6_months'].includes(frequency)) return { cadence: 'semiannual', intervalDays: 30 };
  if (['annual', 'yearly', 'every_12_months'].includes(frequency)) return { cadence: 'annual', intervalDays: 30 };
  if (frequency === 'monthly') return { cadence: 'monthly', intervalDays: 30 };
  if (billingType === 'recurring') {
    if (visitsPerYear === 12) return { cadence: 'monthly', intervalDays: 30 };
    if (visitsPerYear === 6) return { cadence: 'bimonthly', intervalDays: 30 };
    if (visitsPerYear === 4) return { cadence: 'quarterly', intervalDays: 30 };
    if (visitsPerYear === 3) return { cadence: 'triannual', intervalDays: 30 };
    if (visitsPerYear === 2) return { cadence: 'semiannual', intervalDays: 30 };
    if (visitsPerYear === 1) return { cadence: 'annual', intervalDays: 30 };
  }
  if (/\bevery\s*6\s*weeks?\b/.test(name)) return { cadence: 'custom', intervalDays: 42 };
  if (/\bbi[-\s]?monthly\b|\bevery\s*2\s*months?\b/.test(name)) return { cadence: 'bimonthly', intervalDays: 30 };
  if (/\bquarterly\b|\bevery\s*3\s*months?\b/.test(name)) return { cadence: 'quarterly', intervalDays: 30 };
  if (/\btri[-\s]?annual\b|\bevery\s*4\s*months?\b/.test(name)) return { cadence: 'triannual', intervalDays: 30 };
  if (/\bsemi[-\s]?annual\b|\bevery\s*6\s*months?\b/.test(name)) return { cadence: 'semiannual', intervalDays: 30 };
  if (/\bannual\b|\byearly\b|\bevery\s*12\s*months?\b/.test(name)) return { cadence: 'annual', intervalDays: 30 };
  if (/\bmonthly\b/.test(name)) return { cadence: 'monthly', intervalDays: 30 };
  return { cadence: 'one_time', intervalDays: 30 };
}

function nthWeekdayOfMonth(year, month, nth, weekday) {
  const first = new Date(year, month, 1, 12, 0, 0);
  const firstW = first.getDay();
  const offset = (weekday - firstW + 7) % 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  let day = 1 + offset + (Math.max(1, nth) - 1) * 7;
  if (day > lastDay) day -= 7;
  return new Date(year, month, day, 12, 0, 0);
}

function addCalendarMonthsByWeekday(base, months) {
  const d = new Date(base);
  const nth = Math.ceil(d.getDate() / 7);
  return nthWeekdayOfMonth(d.getFullYear(), d.getMonth() + months, nth, d.getDay());
}

// Client mirror of the server's recurring-date math. Returns a Date.
function nextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const { intervalDays, nth, weekday } = opts;
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : '';
  const base = new Date(safe + 'T12:00:00');
  if (isNaN(base.getTime())) return new Date();
  const nthNum = (nth != null && nth !== '' && !isNaN(parseInt(nth))) ? parseInt(nth) : null;
  const wdayNum = (weekday != null && weekday !== '' && !isNaN(parseInt(weekday))) ? parseInt(weekday) : null;
  if (pattern === 'monthly_nth_weekday' && nthNum != null && wdayNum != null) {
    const d = nthWeekdayOfMonth(base.getFullYear(), base.getMonth() + i, nthNum, wdayNum);
    return isNaN(d.getTime()) ? base : d;
  }
  const monthIntervals = { monthly: 1, bimonthly: 2, quarterly: 3, triannual: 4, semiannual: 6, biannual: 6, annual: 12, yearly: 12 };
  if (monthIntervals[pattern]) {
    return addCalendarMonthsByWeekday(base, monthIntervals[pattern] * i);
  }
  const intervals = { daily: 1, weekly: 7, biweekly: 14 };
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

export function findScheduleEstimateById(estimates = [], estimateId) {
  return estimates.find((estimate) => String(estimate?.id) === String(estimateId)) || null;
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '';
}

export function formatScheduleEstimateAmount(estimate) {
  const onetime = Number(estimate?.onetimeTotal);
  if (Number.isFinite(onetime) && onetime > 0) return `${formatMoney(onetime)} one-time`;
  const monthly = Number(estimate?.monthlyTotal);
  if (Number.isFinite(monthly) && monthly > 0) return `${formatMoney(monthly)}/mo`;
  const annual = Number(estimate?.annualTotal);
  if (Number.isFinite(annual) && annual > 0) return `${formatMoney(annual)}/yr`;
  return '';
}

export const ESTIMATE_SOURCE_LABEL = 'Estimate source';
export const MANUAL_SERVICE_ENTRY_LABEL = 'No estimate - choose services manually';

export function pickAutoScheduleEstimate({
  customerId,
  estimates = [],
  isLoading = false,
  error = '',
  linkedEstimate = null,
  serviceCount = 0,
  appliedKey = null,
} = {}) {
  if (!customerId || isLoading || error || linkedEstimate || serviceCount > 0) return null;
  // Only auto-apply a formally ACCEPTED quote. Open quotes (sent/viewed) are
  // surfaced in the picker but must be picked deliberately — auto-applying one
  // would let an unrelated booking silently mark it accepted on submit.
  const candidates = estimates.filter((estimate) => estimate.status === 'accepted' && !estimate.linkedAppointment);
  if (candidates.length !== 1) return null;
  const estimate = candidates[0];
  const key = `${customerId}:${estimate.id}`;
  if (appliedKey === key) return null;
  return { estimate, key };
}

export default function CreateAppointmentModal({ defaultDate, defaultWindowStart, defaultDurationMinutes, defaultTechId, defaultCustomer = null, defaultEstimateId = null, onClose, onCreated, onChange }) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const searchRef = useRef(null);

  // Customer state
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  // Only treat a default customer as "selected" when it actually resolves to a
  // customer record. The Estimates page passes a placeholder with id = null for
  // a LEAD's quote (no customer yet); that must leave the customer unselected so
  // the operator creates one (prefilled from the quote — see the estimate-load
  // effect) rather than booking against a null id.
  const [selectedCustomer, setSelectedCustomer] = useState(defaultCustomer?.id ? defaultCustomer : null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAdd, setQuickAdd] = useState({ firstName: '', lastName: '', phone: '', email: '', address: '', city: '', state: 'FL', zip: '', profileLabel: '' });

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
  const [scheduleEstimates, setScheduleEstimates] = useState([]);
  const [scheduleEstimatesLoading, setScheduleEstimatesLoading] = useState(false);
  const [scheduleEstimateError, setScheduleEstimateError] = useState('');
  const [linkedEstimate, setLinkedEstimate] = useState(null);
  const autoAppliedScheduleEstimateRef = useRef(null);
  const selectedService = services[0] || null;

  // Lock body scroll while the modal is open. The modal is portaled to
  // document.body (so it isn't trapped inside the admin shell's
  // -webkit-overflow-scrolling: touch scroll container — iOS Safari would
  // otherwise pin position: fixed descendants to that container and hide
  // the modal header (×, Save) and footer (Schedule appointment) behind
  // the app's top/bottom tab bars).
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

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
          billing_type: s.billing_type,
          frequency: s.frequency,
          visits_per_year: s.visits_per_year,
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

  useEffect(() => {
    const customerId = selectedCustomer?.id;
    // When booking a SPECIFIC estimate (defaultEstimateId), the estimate — not
    // the customer — is the anchor. The lead-estimate flow creates the customer
    // mid-modal (quick-add), which re-runs this effect; clearing the link there
    // would drop the quote from the booking. So only reset the link when we're
    // NOT pinned to a default estimate.
    if (!defaultEstimateId) {
      setLinkedEstimate(null);
      autoAppliedScheduleEstimateRef.current = null;
    }
    setScheduleEstimates([]);
    setScheduleEstimateError('');
    let cancelled = false;
    setScheduleEstimatesLoading(true);
    (async () => {
      let list = [];
      if (customerId) {
        const r = await adminFetch(`/admin/customers/${customerId}/schedule-estimates`);
        list = Array.isArray(r.estimates) ? r.estimates : [];
      }
      // Ensure the estimate we were opened to book is present even when the
      // selected customer doesn't own it yet — a lead's quote (customer_id NULL)
      // scheduled before the lead is converted. schedule-source needs no
      // customer and also hands back the quote's contact so we can stage the
      // customer the operator still has to create.
      if (defaultEstimateId && !list.some((e) => String(e.id) === String(defaultEstimateId))) {
        try {
          const r = await adminFetch(`/admin/estimates/${defaultEstimateId}/schedule-source`);
          if (r?.estimate) {
            list = [r.estimate, ...list];
            const c = r.contact || {};
            // Only stage a new customer to create when the quote is genuinely
            // unowned (r.customerId === null — a lead/standalone estimate). If it
            // already belongs to a customer, never prefill quick-add: that would
            // create a duplicate. (Current callers always pass an owned quote's
            // customer as defaultCustomer, so this is a guard, not a path.)
            if (!cancelled && !customerId && !r.customerId && (c.firstName || c.phone || c.email)) {
              setQuickAdd((prev) => ({
                ...prev,
                firstName: prev.firstName || c.firstName || '',
                lastName: prev.lastName || c.lastName || '',
                phone: prev.phone || c.phone || '',
                email: prev.email || c.email || '',
                address: prev.address || c.address || '',
              }));
              setShowQuickAdd(true);
            }
          }
        } catch { /* schedule-source is best-effort — fall back to manual entry */ }
      }
      return list;
    })()
      .then((list) => { if (!cancelled) setScheduleEstimates(list); })
      .catch((e) => {
        if (cancelled) return;
        setScheduleEstimateError(e.message || 'Could not load estimates');
        setScheduleEstimates([]);
      })
      .finally(() => {
        if (!cancelled) setScheduleEstimatesLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer?.id, defaultEstimateId]);

  // Find-a-Time state
  const [findingTimes, setFindingTimes] = useState(false);
  const [timeSlots, setTimeSlots] = useState(null); // null = hidden, [] = searched but none, [...] = results
  const [slotError, setSlotError] = useState('');
  const [findTimeHorizonDays, setFindTimeHorizonDays] = useState(7);

  // Date/Time/Tech state — default to today + next clean hour in local time
  const _now = new Date();
  const _ymd = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  const _rounded = new Date(_now);
  if (_rounded.getMinutes() > 0 || _rounded.getSeconds() > 0 || _rounded.getMilliseconds() > 0) {
    _rounded.setHours(_rounded.getHours() + 1);
  }
  _rounded.setMinutes(0, 0, 0);
  const _hhmm = `${String(_rounded.getHours()).padStart(2, '0')}:${String(_rounded.getMinutes()).padStart(2, '0')}`;
  const _defaultDate = _rounded.toDateString() !== _now.toDateString()
    ? `${_rounded.getFullYear()}-${String(_rounded.getMonth() + 1).padStart(2, '0')}-${String(_rounded.getDate()).padStart(2, '0')}`
    : _ymd;
  const [apptDate, setApptDate] = useState(defaultDate || _defaultDate);
  const [windowStart, setWindowStart] = useState(normalizeHourTime(defaultWindowStart || _hhmm, _hhmm));
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
  const [collectPrepay, setCollectPrepay] = useState(false);
  const [prepayMethod, setPrepayMethod] = useState('cash');
  const [prepayNote, setPrepayNote] = useState('');
  const [discountPresets, setDiscountPresets] = useState([]);
  const [lineDiscountQueries, setLineDiscountQueries] = useState({});
  const [lineDiscountOpenIdx, setLineDiscountOpenIdx] = useState(null);

  const lineDiscountPresets = useMemo(() => {
    return discountPresets.filter((d) => (
      d.is_active
      && d.show_in_invoices
    ));
  }, [discountPresets]);

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
    setLineDiscountOpenIdx((current) => (current === idx ? null : current));
  };
  const addServiceFromCatalog = (svc) => {
    const defaultPrice = svc.priceMin || svc.base_price || '';
    const inferred = inferServiceCadence(svc);
    setServices((arr) => [
      ...arr,
      {
        ...svc,
        lineId: `svc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        price: defaultPrice ? String(defaultPrice) : '',
        cadence: inferred.cadence,
        intervalDays: inferred.intervalDays,
        nth: 3,        // default "3rd"
        weekday: 3,    // default "Wednesday"
        boosterMonths: [],
      },
    ]);
    setServiceSearch('');
    setServiceResults([]);
    setAddingService(false);
  };
  const formatScheduleEstimateLabel = (estimate) => {
    if (!estimate) return '';
    const isAccepted = estimate.status === 'accepted';
    const stamp = isAccepted ? estimate.acceptedAt : (estimate.createdAt || estimate.acceptedAt);
    const date = stamp
      ? new Date(stamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
    // Spell out acceptance so the operator can tell a phone-accepted-but-not-
    // yet-marked quote from one the customer formally accepted.
    const statusLabel = isAccepted
      ? `Accepted${date ? ` ${date}` : ''}`
      : `Sent${date ? ` ${date}` : ''} - not yet accepted`;
    const servicesLabel = estimate.serviceInterest || (estimate.lines || []).map((l) => l.estimateLabel || l.name).filter(Boolean).slice(0, 2).join(' + ') || 'Estimate';
    const amount = formatScheduleEstimateAmount(estimate);
    return [servicesLabel, amount, statusLabel].filter(Boolean).join(' - ');
  };
  const applyScheduleEstimate = (estimateId) => {
    if (!estimateId) {
      setLinkedEstimate(null);
      return;
    }
    const estimate = findScheduleEstimateById(scheduleEstimates, estimateId);
    if (!estimate) return;
    const nextLines = (estimate.lines || []).map((line) => {
      const inferred = inferServiceCadence({
        name: line.name,
        frequency: line.frequency,
        billing_type: line.billingType,
        visits_per_year: line.visitsPerYear,
      });
      return {
        id: line.serviceId || null,
        serviceKey: line.serviceKey || null,
        name: line.name || line.estimateLabel || 'Estimate service',
        category: line.category || undefined,
        billing_type: line.billingType || undefined,
        frequency: line.frequency || undefined,
        visits_per_year: line.visitsPerYear || undefined,
        duration: line.duration || 30,
        default_duration_minutes: line.duration || 30,
        priceMin: line.price,
        priceMax: line.price,
        base_price: line.price,
        lineId: `estimate_${estimate.id}_${line.serviceId || line.name}_${Math.random().toString(36).slice(2, 8)}`,
        price: line.price != null ? String(line.price) : '',
        cadence: line.cadence || inferred.cadence,
        intervalDays: inferred.intervalDays,
        nth: 3,
        weekday: 3,
        boosterMonths: [],
        sourceEstimateId: estimate.id,
      };
    });
    if (nextLines.length > 0) {
      setServices(nextLines);
      setAddingService(false);
      setServiceSearch('');
      setServiceResults([]);
    }
    setLinkedEstimate(estimate);
  };
  useEffect(() => {
    const customerId = selectedCustomer?.id;
    const auto = pickAutoScheduleEstimate({
      customerId,
      estimates: scheduleEstimates,
      isLoading: scheduleEstimatesLoading,
      error: scheduleEstimateError,
      linkedEstimate,
      serviceCount: services.length,
      appliedKey: autoAppliedScheduleEstimateRef.current,
    });
    if (!auto) return;
    autoAppliedScheduleEstimateRef.current = auto.key;
    applyScheduleEstimate(auto.estimate.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleEstimates, scheduleEstimatesLoading, scheduleEstimateError, linkedEstimate, selectedCustomer?.id, services.length]);

  const defaultEstimateAppliedRef = useRef(false);
  useEffect(() => {
    if (!defaultEstimateId || defaultEstimateAppliedRef.current) return;
    if (scheduleEstimatesLoading || !scheduleEstimates.length) return;
    const match = scheduleEstimates.find(e => String(e.id) === String(defaultEstimateId));
    if (!match) return;
    defaultEstimateAppliedRef.current = true;
    applyScheduleEstimate(match.id);
  }, [defaultEstimateId, scheduleEstimates, scheduleEstimatesLoading]);

  // Custom discounts ship as a percentage/fixed_amount preset with amount 0 (or
  // the variable_* types) — the operator supplies the value when applying it.
  const isCustomAmountDiscount = (d) =>
    d?.discount_type === 'variable_amount' ||
    (d?.discount_type === 'fixed_amount' &&
      (d?.discount_key === 'custom_dollar' || !(Number(d?.amount) > 0)));
  const isCustomPercentageDiscount = (d) =>
    d?.discount_type === 'variable_percentage' ||
    (d?.discount_type === 'percentage' &&
      (d?.discount_key === 'custom_percent' || !(Number(d?.amount) > 0)));
  const formatDiscountLabel = (d) => {
    if (!d) return '';
    if (d.discount_type === 'free_service') return 'Free';
    if (d.discount_type === 'percentage' || d.discount_type === 'variable_percentage') {
      if (isCustomPercentageDiscount(d)) return 'custom %';
      return `${Number(d.amount || 0).toFixed(Number(d.amount || 0) % 1 ? 2 : 0)}%`;
    }
    if (isCustomAmountDiscount(d)) return 'custom $';
    return `$${Number(d.amount || 0).toFixed(2)}`;
  };
  const lineBaseAmount = (svc) => {
    const n = parseFloat(svc?.price);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const previewLineDiscount = (discount, baseAmount) => {
    const amt = Number(discount?.amount) || 0;
    let dollars = 0;
    if (discount?.discount_type === 'percentage' || discount?.discount_type === 'variable_percentage') {
      dollars = baseAmount * (amt / 100);
      if (discount.max_discount_dollars) dollars = Math.min(dollars, Number(discount.max_discount_dollars));
    } else if (discount?.discount_type === 'fixed_amount' || discount?.discount_type === 'variable_amount') {
      dollars = amt;
    } else if (discount?.discount_type === 'free_service') {
      dollars = baseAmount;
    }
    return Math.min(baseAmount, Math.max(0, Math.round(dollars * 100) / 100));
  };
  const lineDiscountAmount = (svc) => previewLineDiscount(svc?.lineDiscount, lineBaseAmount(svc));
  const lineNetAmount = (svc) => Math.max(0, Math.round((lineBaseAmount(svc) - lineDiscountAmount(svc)) * 100) / 100);
  const matchingLineDiscounts = (idx) => {
    const svc = services[idx];
    const key = svc?.lineId || idx;
    const q = (lineDiscountQueries[key] || '').trim().toLowerCase();
    if (!q) return lineDiscountPresets.slice(0, 10);
    return lineDiscountPresets
      .filter((d) => `${d.name || ''} ${d.description || ''} ${formatDiscountLabel(d)}`.toLowerCase().includes(q))
      .slice(0, 10);
  };
  const applyLineDiscount = (idx, discount) => {
    const base = lineBaseAmount(services[idx]);
    if (base <= 0) {
      setToast('Enter a price before applying a line discount');
      setTimeout(() => setToast(''), 2400);
      return;
    }
    // Custom discounts carry no preset amount — prompt the operator for one
    // and store it as the line discount's amount so the preview/totals/payload
    // all flow through previewLineDiscount unchanged.
    let amount = discount.amount;
    if (isCustomAmountDiscount(discount)) {
      const raw = window.prompt(`Discount amount for ${discount.name} ($)`, '');
      if (raw === null) return;
      const customAmount = Math.round((Number(raw) || 0) * 100) / 100;
      if (!(customAmount > 0)) {
        setToast('Enter a discount amount greater than $0');
        setTimeout(() => setToast(''), 2400);
        return;
      }
      amount = customAmount;
    } else if (isCustomPercentageDiscount(discount)) {
      const raw = window.prompt(`Discount percentage for ${discount.name} (%)`, '');
      if (raw === null) return;
      const customPct = Number(raw);
      if (!Number.isFinite(customPct) || customPct <= 0 || customPct > 100) {
        setToast('Enter a discount percentage between 0 and 100');
        setTimeout(() => setToast(''), 2400);
        return;
      }
      amount = customPct;
    }
    if (previewLineDiscount({ ...discount, amount }, base) <= 0) {
      setToast('Discount has no amount for this service line');
      setTimeout(() => setToast(''), 2400);
      return;
    }
    setServices((arr) => arr.map((s, i) => (i === idx ? {
      ...s,
      lineDiscount: {
        id: discount.id,
        name: discount.name,
        discount_type: discount.discount_type,
        amount,
        max_discount_dollars: discount.max_discount_dollars,
      },
    } : s)));
    const key = services[idx]?.lineId || idx;
    setLineDiscountQueries((prev) => ({ ...prev, [key]: '' }));
    setLineDiscountOpenIdx(null);
  };
  const clearLineDiscount = (idx) => {
    setServices((arr) => arr.map((s, i) => (i === idx ? { ...s, lineDiscount: null } : s)));
  };
  const subtotal = useMemo(() => {
    return services.reduce((sum, s) => {
      return sum + lineBaseAmount(s);
    }, 0);
  }, [services]);
  const lineDiscountTotal = useMemo(() => {
    return services.reduce((sum, s) => sum + lineDiscountAmount(s), 0);
  }, [services]);
  const netSubtotal = useMemo(() => {
    return services.reduce((sum, s) => sum + lineNetAmount(s), 0);
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

  // Customer search. Tracks loading so the dropdown can show "Searching…"
  // and "No matches" states — without them, a slow network or zero-hit
  // query looks identical to a broken search (no UI ever appears) and
  // operators report it as "the search vanished".
  const doSearch = async (val) => {
    setCustomerSearch(val);
    if (val.length >= 2) {
      setCustomerLoading(true);
      try {
        const r = await adminFetch(`/admin/customers?search=${encodeURIComponent(val)}&limit=8`);
        setCustomerResults(r.customers || []);
      } catch { setCustomerResults([]); }
      finally { setCustomerLoading(false); }
    } else { setCustomerResults([]); setCustomerLoading(false); }
  };

  const selectCustomer = (c) => {
    setSelectedCustomer(c);
    const label = c.profileLabel && c.profileLabel !== 'Primary' ? ` - ${c.profileLabel}` : '';
    setCustomerSearch(`${c.firstName} ${c.lastName}${label}`);
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
        setQuickAdd({ firstName: '', lastName: '', phone: '', email: '', address: '', city: '', state: 'FL', zip: '', profileLabel: '' });
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
  const handleFindTimes = async ({ horizonDays = 7 } = {}) => {
    if (!selectedCustomer || !selectedService) return;
    setFindTimeHorizonDays(horizonDays);
    setFindingTimes(true);
    setSlotError('');
    setTimeSlots(null);
    try {
      const dur = totalDuration || 60;
      const today = new Date();
      const from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const searchFrom = apptDate && apptDate > from ? apptDate : from;
      const endD = new Date(searchFrom + 'T12:00:00'); endD.setDate(endD.getDate() + horizonDays);
      const to = `${endD.getFullYear()}-${String(endD.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`;
      const r = await adminFetch('/admin/schedule/find-time', {
        method: 'POST',
        body: JSON.stringify({
          customerId: selectedCustomer.id,
          serviceType: selectedService.name,
          serviceId: selectedService.id || undefined,
          durationMinutes: dur,
          dateFrom: searchFrom,
          dateTo: to,
          technicianId: techMode === 'choose' && techId ? techId : undefined,
          topN: horizonDays > 7 ? 100 : 25,
        }),
      });
      setTimeSlots((r.slots || [])
        .filter((slot) => isHourTime(slot.start_time))
        .slice(0, 8)
        .map((slot, index) => ({ ...slot, rank: index + 1 })));
    } catch (e) {
      setSlotError(e.message || 'Failed to find times');
      setTimeSlots(null);
    }
    setFindingTimes(false);
  };

  const applySlot = (slot) => {
    setApptDate(slot.date);
    setWindowStart(normalizeHourTime(slot.start_time, windowStart));
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
  const cadenceRankDays = (svc) => {
    const cadence = svc?.cadence || 'one_time';
    if (cadence === 'one_time') return Number.POSITIVE_INFINITY;
    if (cadence === 'custom') return Math.max(1, parseInt(svc.intervalDays) || 30);
    if (cadence === 'weekly') return 7;
    if (cadence === 'biweekly') return 14;
    const months = {
      monthly: 30,
      monthly_nth_weekday: 30,
      bimonthly: 60,
      quarterly: 90,
      triannual: 120,
      semiannual: 180,
      biannual: 180,
      annual: 365,
      yearly: 365,
    };
    return months[cadence] || 91;
  };
  const serviceCadenceConfig = (s) => {
    const cadence = s?.cadence || 'one_time';
    const wd = Number.isFinite(parseInt(s?.weekday)) ? parseInt(s.weekday) : 3;
    return {
      recurringPattern: cadence,
      recurringIntervalDays: cadence === 'custom' ? parseInt(s.intervalDays) || 30 : null,
      recurringNth: cadence === 'monthly_nth_weekday' ? parseInt(s.nth) || 3 : null,
      recurringWeekday: cadence === 'monthly_nth_weekday' ? wd : null,
    };
  };
  const groupServicesForAppointmentSubmit = (rows) => {
    const sorted = [...rows].sort((a, b) => {
      const rank = cadenceRankDays(a) - cadenceRankDays(b);
      if (rank !== 0) return rank;
      return rows.indexOf(a) - rows.indexOf(b);
    });
    const primary = sorted[0] || rows[0];
    if (!primary) return [];
    const cfg = serviceCadenceConfig(primary);
    return [{
      cadence: primary.cadence || 'one_time',
      intervalDays: cfg.recurringIntervalDays,
      nth: cfg.recurringNth,
      weekday: cfg.recurringWeekday,
      lines: [primary, ...sorted.filter((s) => s !== primary)],
    }];
  };

  // Tracks cadence-group keys already POSTed during this modal session.
  // If the loop fails partway (e.g. quarterly succeeded, monthly errored),
  // a retry click skips the keys that landed so we don't double-book the
  // customer. Reset on successful close.
  const createdGroupKeysRef = useRef(new Set());
  // Recurring preview — for each cadence group, produce up to 4 future
  // dates Virginia will land on. Honors skip-weekends shift so what's
  // shown matches what gets saved. Renders below the Visits input.
  const recurringPreview = useMemo(() => {
    if (!apptDate) return [];
    const groups = groupServicesForAppointmentSubmit(services);
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
    const groups = groupServicesForAppointmentSubmit(services);
    const results = [];
    let firstError = null;
    for (const group of groups) {
      const key = groupKey(group);
      // Skip groups already created in a prior attempt of this submit
      // session — a retry after partial failure shouldn't duplicate them.
      if (createdGroupKeysRef.current.has(key)) continue;
      try {
        const [primary, ...extras] = group.lines;
        const groupSubtotal = group.lines.reduce((sum, s) => sum + lineNetAmount(s), 0);
        const groupHasPrice = group.lines.some((s) => {
          const n = parseFloat(s.price);
          return Number.isFinite(n) && n >= 0 && s.price !== '' && s.price != null;
        });
        const groupDuration = group.lines.reduce((sum, s) => sum + (s.duration || s.default_duration_minutes || 30), 0);
        const addons = extras.map((s) => {
          const basePrice = lineBaseAmount(s);
          const p = lineNetAmount(s);
          return {
            serviceId: s.id || null,
            serviceName: s.name,
            name: s.name,
            basePrice: basePrice > 0 ? basePrice : null,
            price: p > 0 ? p : null,
            discountId: s.lineDiscount?.id || null,
            discountName: s.lineDiscount?.name || null,
            discountType: s.lineDiscount?.discount_type || null,
            discountAmount: s.lineDiscount?.amount != null ? Number(s.lineDiscount.amount) : null,
            discountDollars: lineDiscountAmount(s) || null,
            ...serviceCadenceConfig(s),
            skipWeekends: s.cadence && s.cadence !== 'one_time' ? !!skipWeekends : undefined,
            weekendShift: s.cadence && s.cadence !== 'one_time' && skipWeekends ? weekendShift : undefined,
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
          primaryLinePrice: groupHasPrice ? lineBaseAmount(primary) : null,
          primaryLineDiscount: primary.lineDiscount ? {
            discountId: primary.lineDiscount.id || null,
            discountName: primary.lineDiscount.name || null,
            discountType: primary.lineDiscount.discount_type || null,
            discountAmount: primary.lineDiscount.amount != null ? Number(primary.lineDiscount.amount) : null,
            discountDollars: lineDiscountAmount(primary) || null,
          } : undefined,
          serviceAddons: addons,
          windowStart,
          windowEnd: computeWindowEnd(windowStart, groupDuration),
          assignmentMode: techMode,
          technicianId: techMode === 'choose' ? techId : undefined,
          // Parent's estimated_price reflects the whole group so completion-
          // triggered auto-invoicing (server/routes/admin-dispatch.js) charges
          // the full visit. Per-line prices stay on each addon row for
          // breakdown / analytics.
          estimatedPrice: groupHasPrice ? groupSubtotal : null,
          // Send the summed group duration so the server's
          // estimated_duration_minutes matches the actual time window
          // (windowStart..windowEnd) instead of just the primary line's
          // catalog default — capacity / dispatch math depends on this.
          estimatedDuration: groupDuration > 0 ? groupDuration : undefined,
          // Always pass the linked estimate id. The server links accepted
          // estimates directly; for a sent/viewed quote the customer accepted
          // by phone it records the acceptance first (canonical Mark-Won flow)
          // and then links, or — for estimate shapes that can't be auto-
          // accepted — books without the link and returns a warning.
          sourceEstimateId: linkedEstimate?.id || undefined,
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
          createInvoice: true,
          sendConfirmation: sendSms,
          prepaid: collectPrepay && isRecurring ? {
            totalAmount: groupSubtotal * (hasFiniteRecurringCount ? parsedRecurringCount : 4),
            method: prepayMethod,
            note: prepayNote || undefined,
          } : undefined,
        };
        const r = await adminFetch('/admin/schedule', { method: 'POST', body: JSON.stringify(body) });
        createdGroupKeysRef.current.add(key);
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
    const estimateAccepted = results.some((r) => r?.estimateAccepted);
    const apptWarnings = results.flatMap((r) => (Array.isArray(r?.warnings) ? r.warnings : []));
    const baseMessage = apptCount === 1
      ? 'Appointment created — invoice will send with service report'
      : `${apptCount} appointment series created — invoices will send with each service report`;
    setToast(estimateAccepted ? `Estimate marked accepted. ${baseMessage}` : baseMessage);
    // A guarded estimate (one-time/recurring choice, invoice-mode, expired,
    // pending manager approval) books fine but couldn't be auto-accepted — tell
    // the operator so they can record the win from the Estimates page.
    if (apptWarnings.length) alert(apptWarnings.join('\n\n'));
    setTimeout(() => {
      createdGroupKeysRef.current = new Set();
      onCreated?.({ id: results[0]?.id, scheduledDate: apptDate });
      onChange?.({ id: results[0]?.id, scheduledDate: apptDate });
    }, 1200);
  };

  const overlayStyle = {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: isMobile ? D.bg : 'rgba(0,0,0,0.3)',
    display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
    overflow: isMobile ? 'hidden' : 'auto', padding: isMobile ? 0 : 20,
    height: isMobile ? '100dvh' : undefined,
    fontFamily: ROBOTO_STACK,
  };

  const modalStyle = {
    background: D.bg, width: isMobile ? '100%' : 640, maxWidth: '100%',
    height: isMobile ? '100dvh' : undefined,
    maxHeight: isMobile ? '100dvh' : '90vh',
    overflow: isMobile ? 'hidden' : 'auto',
    borderRadius: isMobile ? 0 : 16, padding: isMobile ? 0 : 24,
    border: isMobile ? 'none' : `1px solid ${D.border}`,
    fontFamily: ROBOTO_STACK,
    display: isMobile ? 'flex' : undefined,
    flexDirection: isMobile ? 'column' : undefined,
  };

  const mobileContentStyle = isMobile
    ? {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        paddingTop: 0,
        paddingRight: 'calc(16px + env(safe-area-inset-right, 0px))',
        paddingBottom: 16,
        paddingLeft: 'calc(16px + env(safe-area-inset-left, 0px))',
      }
    : { padding: 0 };

  const mobileActionBarStyle = {
    flex: '0 0 auto',
    zIndex: 20,
    paddingTop: 10,
    paddingRight: 'calc(16px + env(safe-area-inset-right, 0px))',
    paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
    paddingLeft: 'calc(16px + env(safe-area-inset-left, 0px))',
    background: 'rgba(250,250,250,0.96)',
    borderTop: `1px solid ${D.border}`,
    boxShadow: '0 -8px 20px rgba(0,0,0,0.06)',
    fontFamily: ROBOTO_STACK,
  };
  const mobileTopInset = 'max(8px, env(safe-area-inset-top, 0px))';

  const canSubmit = !!selectedCustomer && !!selectedService && !saving;
  const hasRecurringServices = services.some((s) => s.cadence && s.cadence !== 'one_time');
  const firstCustomRecurringIndex = services.findIndex((s) => s.cadence === 'custom');
  const weekendRuleValue = skipWeekends ? weekendShift : 'allow';
  const updateWeekendRule = (value) => {
    if (value === 'allow') {
      setSkipWeekends(false);
      return;
    }
    setSkipWeekends(true);
    setWeekendShift(value === 'back' ? 'back' : 'forward');
  };
  const serviceLineColumns = isMobile
    ? 'minmax(0, 1fr) 112px'
    : 'minmax(0, 1fr) 112px 132px 36px';
  const serviceLineGrid = (isDiscount = false) => ({
    display: 'grid',
    gridTemplateColumns: serviceLineColumns,
    gap: 8,
    alignItems: 'start',
    padding: isDiscount ? '8px 0 8px 18px' : '12px 0',
    borderTop: `1px solid ${D.border}`,
    background: isDiscount ? '#F0FDF4' : 'transparent',
    borderRadius: isDiscount ? 8 : 0,
  });
  const serviceFieldLabel = (label, align = 'left') => (
    <div style={{
      fontSize: 11,
      color: D.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 5,
      textAlign: align,
      fontWeight: 500,
    }}>
      {label}
    </div>
  );
  const weekendRuleControl = () => (
    <div>
      {serviceFieldLabel('Weekend rule')}
      <select
        value={weekendRuleValue}
        onChange={(e) => updateWeekendRule(e.target.value)}
        style={inputStyle}
      >
        <option value="allow">Allow weekends</option>
        <option value="forward">Move Sat/Sun to Monday</option>
        <option value="back">Move Sat/Sun to Friday</option>
      </select>
    </div>
  );

  return createPortal(
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
            flex: '0 0 auto',
            position: 'relative', zIndex: 10, background: D.bg,
            height: `calc(60px + ${mobileTopInset})`,
            paddingTop: mobileTopInset,
            paddingRight: 'calc(16px + env(safe-area-inset-right, 0px))',
            paddingLeft: 'calc(16px + env(safe-area-inset-left, 0px))',
            boxSizing: 'border-box',
            borderBottom: `1px solid ${D.border}`,
          }}>
            <div style={{ position: 'relative', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <h1 style={{ fontFamily: ROBOTO_STACK, fontSize: 17, fontWeight: 700, color: '#18181B', margin: 0, maxWidth: 'calc(100% - 148px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
            <h1 style={{ fontFamily: ROBOTO_STACK, fontSize: 28, fontWeight: 400, color: '#18181B', margin: 0 }}>New Appointment</h1>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 22, cursor: 'pointer', minWidth: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
          </div>
        )}
        <div style={mobileContentStyle}>

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
                      <div key={c.id} onClick={() => selectCustomer(c)} className="waves-sq-row" style={{ padding: '12px 14px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 14, color: '#18181B', minHeight: 58, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700 }}>
                            {c.firstName} {c.lastName}
                            {c.profileLabel && c.profileLabel !== 'Primary' && <span style={{ color: D.muted, fontWeight: 500 }}> · {c.profileLabel}</span>}
                          </div>
                          <div style={{ color: D.muted, fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {c.address || c.phone || ''}
                          </div>
                        </div>
                        {c.tier && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: `${TIER_COLORS[c.tier] || D.teal}22`, color: TIER_COLORS[c.tier] || D.teal, flex: '0 0 auto' }}>{c.tier}</span>}
                      </div>
                    ))}
                    {!customerLoading && customerResults.length === 0 && (
                      <div style={{ padding: '14px', textAlign: 'center', color: D.muted, fontSize: 13 }}>
                        No customers match &ldquo;{customerSearch}&rdquo;
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
                        state: parts.state || q.state,
                        zip: parts.zip || q.zip,
                      }))}
                      style={inputStyle}
                      placeholder=""
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 8, marginBottom: 8 }}>
                    <div><label style={labelStyle}>City</label><input value={quickAdd.city} onChange={e => setQuickAdd(q => ({ ...q, city: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>State</label><input value={quickAdd.state} onChange={e => setQuickAdd(q => ({ ...q, state: e.target.value.toUpperCase().slice(0, 2) }))} style={inputStyle} /></div>
                  </div>
                  <div style={{ marginBottom: 8 }}><label style={labelStyle}>ZIP</label><input value={quickAdd.zip} onChange={e => setQuickAdd(q => ({ ...q, zip: e.target.value }))} style={inputStyle} /></div>
                  <div style={{ marginBottom: 8 }}><label style={labelStyle}>Property Label</label><input value={quickAdd.profileLabel || ''} onChange={e => setQuickAdd(q => ({ ...q, profileLabel: e.target.value }))} style={inputStyle} placeholder="Rental - Cape Coral" /></div>
                  <button onClick={handleQuickAdd} style={{ padding: '10px 16px', background: D.text, color: D.white, border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer', minHeight: 44, width: '100%' }}>Add customer</button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#FFFFFF', borderRadius: 10, padding: 12, border: `1px solid #E4E4E7` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#18181B', fontSize: 14 }}>
                  {selectedCustomer.firstName} {selectedCustomer.lastName}
                  {selectedCustomer.profileLabel && selectedCustomer.profileLabel !== 'Primary' && <span style={{ color: D.muted, fontWeight: 500 }}> · {selectedCustomer.profileLabel}</span>}
                </div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{selectedCustomer.address || `${selectedCustomer.city || ''}`}</div>
                {selectedCustomer.phone && <div style={{ fontSize: 12, color: D.muted }}>{selectedCustomer.phone}</div>}
              </div>
              {selectedCustomer.tier && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: `${TIER_COLORS[selectedCustomer.tier] || D.teal}22`, color: TIER_COLORS[selectedCustomer.tier] || D.teal, fontWeight: 600 }}>{selectedCustomer.tier}</span>}
              <button onClick={() => { setSelectedCustomer(null); setCustomerSearch(''); }} style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 16, minWidth: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>
          )}
        </div>

        {/* Section 2: Services — invoice-style line items. Service rows
            remain appointment-aware (cadence, boosters, duration), while
            discounts render as their own negative line under the service. */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#18181B' }}>
              Services {services.length > 1 ? <span style={{ fontWeight: 400, color: D.muted, fontSize: 12 }}>({services.length})</span> : null}
            </div>
            {services.length > 0 && subtotal > 0 && (
              <div style={{ fontSize: 13, fontWeight: 600, color: '#18181B', textAlign: 'right' }}>
                <div>Total: ${netSubtotal.toFixed(2)}</div>
                {lineDiscountTotal > 0 && (
                  <div style={{ fontSize: 11, fontWeight: 500, color: D.muted }}>
                    Discounts: -${lineDiscountTotal.toFixed(2)}
                  </div>
                )}
              </div>
            )}
          </div>

          {(selectedCustomer || scheduleEstimatesLoading || scheduleEstimates.length > 0) && (
            <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${D.border}` }}>
              <label style={labelStyle}>{ESTIMATE_SOURCE_LABEL}</label>
              {scheduleEstimatesLoading ? (
                <div style={{ fontSize: 13, color: D.muted, minHeight: 36, display: 'flex', alignItems: 'center' }}>Loading estimates...</div>
              ) : scheduleEstimateError ? (
                <div style={{ fontSize: 12, color: D.red }}>{scheduleEstimateError}</div>
              ) : scheduleEstimates.length > 0 ? (
                <>
                  <select
                    value={linkedEstimate?.id != null ? String(linkedEstimate.id) : ''}
                    onChange={(e) => applyScheduleEstimate(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">{MANUAL_SERVICE_ENTRY_LABEL}</option>
                    {scheduleEstimates.map((estimate) => (
                      <option key={estimate.id} value={String(estimate.id)}>
                        {formatScheduleEstimateLabel(estimate)}
                        {estimate.linkedAppointment ? ' (already linked)' : ''}
                      </option>
                    ))}
                  </select>
                  {linkedEstimate && (
                    <>
                      {/* Acceptance status — spells out whether the customer
                          formally accepted (status flipped in the system) or
                          this is still an open quote we're booking from a phone
                          "yes". An accepted quote links to the appointment;
                          a not-yet-accepted one only fills the prices. */}
                      {(() => {
                        const accepted = linkedEstimate.status === 'accepted';
                        return (
                          <div style={{
                            marginTop: 10,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 12,
                            fontWeight: 600,
                            color: D.text,
                          }}>
                            <span style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              borderRadius: 999,
                              border: `1px solid ${D.border}`,
                              background: D.bg,
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                              fontSize: 10,
                            }}>
                              {accepted ? 'Accepted' : 'Not yet accepted'}
                            </span>
                            <span style={{ fontWeight: 400, color: D.muted }}>
                              {accepted
                                ? 'Customer accepted this estimate.'
                                : 'Saving this appointment will mark the estimate accepted and record the win.'}
                            </span>
                          </div>
                        );
                      })()}
                      {/* Quoted vs current charge, deposit posture, and the
                          balance to collect at the visit once any paid deposit
                          is credited — same card the appointment detail sheet
                          shows at checkout. groupServicesForAppointmentSubmit
                          books ALL lines as one appointment (primary + addons)
                          whose estimated price is the full netSubtotal even when
                          cadences differ, so netSubtotal is always this visit's
                          charge. */}
                      <EstimateProvenanceCard
                        quotedTotal={linkedEstimate.quotedTotal}
                        currentPrice={netSubtotal}
                        deposit={linkedEstimate.deposit}
                        style={{ marginTop: 10 }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', marginTop: 8, fontSize: 12, color: D.muted }}>
                        <span style={{ minWidth: 0 }}>
                          {linkedEstimate.status === 'accepted'
                            ? `Linked to estimate #${String(linkedEstimate.id).slice(0, 8)}. Service lines and prices can still be edited before saving.`
                            : `From estimate #${String(linkedEstimate.id).slice(0, 8)} — saving marks it accepted and links it. Prices filled from the quote; edit before saving as needed.`}
                        </span>
                        <button
                          type="button"
                          onClick={() => setLinkedEstimate(null)}
                          style={{ border: 'none', background: 'transparent', color: D.text, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', padding: '4px 0' }}
                        >
                          {linkedEstimate.status === 'accepted' ? 'Unlink' : 'Clear'}
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 13, color: D.muted, minHeight: 36, display: 'flex', alignItems: 'center' }}>
                  No estimates found. Choose services manually below.
                </div>
              )}
            </div>
          )}

          {services.length > 0 && !isMobile && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: serviceLineColumns,
              gap: 8,
              padding: '0 0 8px',
              borderBottom: `1px solid ${D.border}`,
              color: D.muted,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
            }}>
              <div>Item</div>
              <div>Rate</div>
              <div>Repeats</div>
              <div />
            </div>
          )}

          {services.map((svc, idx) => (
            <div key={`line-${idx}-${svc.lineId || svc.id || svc.name}`}>
              <div style={serviceLineGrid(false)}>
                <div style={{ minWidth: 0 }}>
                  {isMobile && serviceFieldLabel(idx === 0 ? 'Primary service' : 'Additional service')}
                  <div style={{
                    ...inputStyle,
                    minHeight: 44,
                    display: 'flex',
                    alignItems: 'center',
                    background: '#FFFFFF',
                    overflow: 'hidden',
                  }}>
                    <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{svc.name}</span>
                  </div>
                  {!isMobile && idx === 0 && services.length > 1 && (
                    <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>Primary</div>
                  )}
                </div>

                <div style={{ position: 'relative' }}>
                  {isMobile && serviceFieldLabel('Rate')}
                  <span style={{ position: 'absolute', left: 10, top: isMobile ? 43 : 22, transform: 'translateY(-50%)', color: D.muted, fontSize: isMobile ? 16 : 13 }}>$</span>
                  <input
                    type="number"
                    value={svc.price ?? ''}
                    onChange={(e) => updateServicePrice(idx, e.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    style={{ ...inputStyle, paddingLeft: 24 }}
                  />
                </div>

                <div style={{ gridColumn: isMobile ? '1 / -1' : undefined }}>
                  {isMobile && serviceFieldLabel('Repeats')}
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

                <button
                  onClick={() => removeServiceAt(idx)}
                  aria-label="Remove line item"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: D.red,
                    cursor: 'pointer',
                    fontSize: 18,
                    padding: isMobile ? '8px 12px' : '6px 4px',
                    minHeight: 44,
                    minWidth: 44,
                    gridColumn: isMobile ? '2' : undefined,
                    gridRow: isMobile ? '3' : undefined,
                  }}
                >x</button>

                {svc.cadence === 'custom' && (
                  <div
                    style={{
                      gridColumn: '1 / -1',
                      display: 'grid',
                      gridTemplateColumns: isMobile || idx !== firstCustomRecurringIndex ? '1fr' : '140px minmax(220px, 1fr)',
                      gap: 8,
                    }}
                  >
                    <div>
                      {serviceFieldLabel('Days')}
                      <input
                        type="number"
                        min={1}
                        max={365}
                        value={svc.intervalDays ?? 30}
                        onChange={(e) => updateServiceInterval(idx, e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                    {idx === firstCustomRecurringIndex && weekendRuleControl()}
                  </div>
                )}

                {svc.cadence === 'monthly_nth_weekday' && (
                  <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '140px 180px', gap: 8 }}>
                    <div>
                      {serviceFieldLabel('Nth')}
                      <select
                        value={svc.nth ?? 3}
                        onChange={(e) => updateServiceNth(idx, parseInt(e.target.value))}
                        style={inputStyle}
                      >
                        {NTH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div>
                      {serviceFieldLabel('Weekday')}
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
                  <div style={{ gridColumn: '1 / -1' }}>
                    {serviceFieldLabel('Booster months (optional)')}
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

                {!svc.lineDiscount && (
                  <div style={{ gridColumn: '1 / -1', position: 'relative', padding: '0 0 2px' }}>
                    {serviceFieldLabel('Discount')}
                    <input
                      value={lineDiscountQueries[svc.lineId || idx] || ''}
                      onChange={(e) => {
                        setLineDiscountQueries((prev) => ({ ...prev, [svc.lineId || idx]: e.target.value }));
                        if (lineDiscountPresets.length > 0) setLineDiscountOpenIdx(idx);
                      }}
                      onFocus={() => { if (lineDiscountPresets.length > 0) setLineDiscountOpenIdx(idx); }}
                      onBlur={() => setTimeout(() => setLineDiscountOpenIdx((current) => (current === idx ? null : current)), 150)}
                      placeholder={lineDiscountPresets.length === 0 ? 'No invoice discounts are available' : `Search discounts${svc.name ? ` for ${svc.name}` : ''}...`}
                      disabled={lineDiscountPresets.length === 0}
                      style={{ ...inputStyle, fontSize: isMobile ? 15 : 12, minHeight: isMobile ? 42 : 36, padding: isMobile ? '10px 12px' : '8px 10px', opacity: lineDiscountPresets.length === 0 ? 0.65 : 1 }}
                    />
                    {lineDiscountOpenIdx === idx && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, zIndex: 18, maxHeight: 220, overflow: 'auto', marginTop: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
                        {matchingLineDiscounts(idx).length === 0 ? (
                          <div style={{ padding: '10px 12px', color: D.muted, fontSize: 12 }}>No discounts match.</div>
                        ) : matchingLineDiscounts(idx).map((d) => (
                          <div
                            key={d.id}
                            onMouseDown={(e) => { e.preventDefault(); applyLineDiscount(idx, d); }}
                            style={{ padding: '10px 12px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}
                          >
                            <span style={{ color: D.text, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                            <span style={{ color: D.text, fontFamily: ROBOTO_STACK, fontSize: 12, whiteSpace: 'nowrap' }}>{formatDiscountLabel(d)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {svc.lineDiscount && (
                <div style={serviceLineGrid(true)}>
                  <div style={{ minWidth: 0, gridColumn: isMobile ? '1 / -1' : undefined }}>
                    {isMobile && serviceFieldLabel('Discount')}
                    <div style={{ fontSize: 13, fontWeight: 600, color: D.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {svc.lineDiscount.name} ({svc.name})
                    </div>
                    <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                      {formatDiscountLabel(svc.lineDiscount)}
                    </div>
                  </div>
                  <div style={{ fontFamily: ROBOTO_STACK, fontSize: 13, fontWeight: 600, color: D.text, textAlign: isMobile ? 'left' : 'right', whiteSpace: 'nowrap' }}>
                    -${lineDiscountAmount(svc).toFixed(2)}
                  </div>
                  <div />
                  <button
                    type="button"
                    onClick={() => clearLineDiscount(idx)}
                    aria-label="Remove discount"
                    style={{ background: 'none', border: 'none', color: D.red, cursor: 'pointer', fontSize: 18, padding: isMobile ? '8px 12px' : '6px 4px', minHeight: 44, minWidth: 44 }}
                  >x</button>
                </div>
              )}
            </div>
          ))}

          {/* Search box — shown initially (no services yet) or when adding another */}
          {(services.length === 0 || addingService) && (
            <div style={{ borderTop: services.length > 0 ? `1px solid ${D.border}` : 'none', paddingTop: services.length > 0 ? 12 : 0 }}>
              <input
                type="text"
                value={serviceSearch}
                onChange={(e) => setServiceSearch(e.target.value)}
                placeholder={services.length === 0 ? 'Search services' : 'Search to add service'}
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
                      <span style={{ flex: 1, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{svc.name}</span>
                      {(svc.base_price != null || svc.priceMin != null) && (
                        <span style={{ color: D.text, fontFamily: ROBOTO_STACK, fontSize: 12, whiteSpace: 'nowrap' }}>
                          ${Number(svc.base_price ?? svc.priceMin).toFixed(2)}
                        </span>
                      )}
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
                padding: isMobile ? '12px 14px' : '8px 12px',
                background: 'transparent',
                border: 'none',
                color: D.text,
                fontSize: isMobile ? 14 : 12,
                fontWeight: 600,
                cursor: 'pointer',
                minHeight: 44,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
              }}
            >+ Add service</button>
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

        {/* Prepaid collection toggle */}
        {hasRecurringServices && (() => {
          const parsedCount = Number.parseInt(recurringCount, 10);
          const finiteCount = Number.isInteger(parsedCount) && parsedCount >= 2 ? parsedCount : 0;
          if (!finiteCount) return null;
          const perVisit = services.reduce((sum, s) => sum + Number(s.price || 0), 0);
          const total = perVisit * finiteCount;
          return (
            <div style={{ ...sectionStyle, background: collectPrepay ? '#F0FDF4' : undefined, border: collectPrepay ? '1px solid #BBF7D0' : undefined, borderRadius: 8, padding: collectPrepay ? 14 : undefined }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={collectPrepay} onChange={(e) => setCollectPrepay(e.target.checked)} />
                <span style={{ fontSize: 14, fontWeight: 500, color: '#18181B' }}>Collect prepayment</span>
              </label>
              {collectPrepay && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 13, color: '#52525B', marginBottom: 8 }}>
                    {finiteCount} visits &times; ${perVisit.toFixed(2)} = <strong>${total.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    {['cash', 'check', 'card', 'other'].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setPrepayMethod(m)}
                        style={{
                          padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                          border: prepayMethod === m ? '1.5px solid #166534' : '1px solid #D4D4D8',
                          background: prepayMethod === m ? '#DCFCE7' : '#fff',
                          color: prepayMethod === m ? '#166534' : '#52525B',
                          cursor: 'pointer',
                        }}
                      >
                        {m.charAt(0).toUpperCase() + m.slice(1)}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    placeholder="Note (optional)"
                    value={prepayNote}
                    onChange={(e) => setPrepayNote(e.target.value)}
                    style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #D4D4D8', fontSize: 13 }}
                  />
                </div>
              )}
            </div>
          );
        })()}

        {/* Section 3: Date */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#18181B' }}>Date</div>
            {selectedCustomer && selectedService && (
              <button
                onClick={() => handleFindTimes({ horizonDays: 7 })}
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
          {selectedCustomer && selectedService && (
            <button
              onClick={() => handleFindTimes({ horizonDays: 90 })}
              disabled={findingTimes}
              style={{
                width: '100%', marginBottom: 10, padding: '8px 12px',
                background: '#FFFFFF', color: D.teal, border: `1px solid ${D.teal}55`, borderRadius: 8,
                fontSize: 12, fontWeight: 600, cursor: findingTimes ? 'default' : 'pointer',
              }}
              title="Search up to 90 days from the selected date"
            >
              Find more dates
            </button>
          )}

          {slotError && (
            <div style={{ background: `${D.red}15`, border: `1px solid ${D.red}55`, borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 12, color: D.red }}>
              {slotError}
            </div>
          )}

          {timeSlots !== null && (
            <div style={{ marginBottom: 12, background: '#FFFFFF', border: `1px solid ${D.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {timeSlots.length > 0 ? `Top ${timeSlots.length} Slots (ranked by detour)` : `No feasible slots in next ${findTimeHorizonDays} days`}
                </div>
                <button onClick={() => setTimeSlots(null)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 16, cursor: 'pointer', padding: 4 }}>✕</button>
              </div>
              {timeSlots.length > 0 && (
                <>
                {!timeSlots.some(slot => Number.isFinite(slot.detour_minutes) && slot.detour_minutes <= 15) && (
                  <div style={{ background: '#EFF6FF', border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 12, color: D.muted }}>
                    No route near this customer that day yet — here's what's close.
                  </div>
                )}
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
                </>
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
              <select value={windowStart} onChange={e => setWindowStart(normalizeHourTime(e.target.value, windowStart))} className="waves-sq-date" style={inputStyle}>
                {HOURLY_TIME_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          {hasRecurringServices && firstCustomRecurringIndex < 0 && (
            <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 10, marginTop: 4 }}>
              {weekendRuleControl()}
            </div>
          )}
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
        {isMobile && (
          <div style={mobileActionBarStyle}>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              style={{
                width: '100%',
                minHeight: 52,
                border: 'none',
                borderRadius: 8,
                background: canSubmit ? D.text : '#E4E4E7',
                color: canSubmit ? D.white : '#A1A1AA',
                fontSize: 15,
                fontWeight: 600,
                cursor: canSubmit ? 'pointer' : 'default',
                fontFamily: ROBOTO_STACK,
              }}
            >
              {saving ? 'Scheduling...' : 'Schedule appointment'}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
