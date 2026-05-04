// client/src/pages/admin/SchedulePage.jsx
//
// Shared-utility module for the V2 dispatch surface. The V1 page
// component was retired in the dispatch V1→V2 migration; this file is
// retained only for the inline modal/panel components consumed by
// DispatchPageV2 + ProtocolReferenceTabV2:
//   - CompletionPanel       — mark service complete + record products /
//                             observations / labor minutes
//   - RescheduleModal       — move an appointment to a new slot
//   - EditServiceModal      — edit notes / billable items / tech
//                             assignment / status
//   - ProtocolPanel         — surface the appropriate service protocol
//                             (lawn / pest / tree-shrub / mosquito) for
//                             the tech on-site
//   - MONTH_NAMES, PRODUCT_DESCRIPTIONS, TRACK_SAFETY_RULES,
//     stripLegacyBoilerplate (consumed by ProtocolReferenceTabV2)
//
// Endpoints these helpers are wired against:
//   GET   /admin/schedule/services?date=…
//   PATCH /admin/services/:id
//   POST  /admin/services/:id/complete
//   POST  /admin/services/:id/reschedule
//   GET   /admin/techs/availability
//
// Audit focus:
// - The four exported sub-components are state-heavy — confirm they
//   don't carry hidden assumptions about a V1 page parent's state
//   shape that break under V2's parent.
// - CompletionPanel's products + observations submit creates the
//   service_record + invoice line items — verify it's idempotent
//   (operator double-clicks "Complete" should not double-bill).
// - RescheduleModal's slot-conflict handling — what happens if the
//   chosen slot is taken between modal open and submit?
import { useState, useEffect, useRef } from 'react';

import { etDateString } from '../../lib/timezone';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', input: '#FFFFFF',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B',
  blue: '#0A7EC2', purple: '#7C3AED', gray: '#64748B',
  text: '#334155', muted: '#64748B', white: '#FFFFFF',
  heading: '#0F172A', inputBorder: '#CBD5E1',
};

const CHIP_ACTIONS = [
  'Applied perimeter band', 'Interior — baseboards/kitchen/baths', 'Cobweb sweep',
  'Granular in beds', 'Spot-treated weeds', 'Checked bait stations',
  'Pre-emergent applied', 'Barrier treatment', 'Larvicide applied', 'De-webbed eaves',
];
const CHIP_OBSERVATIONS = [
  'Pest activity noted', 'Standing water found', 'Irrigation issue',
  'Rodent signs', 'Lawn stress/dry patches', 'Fungus visible',
  'Weeds spreading', 'Property access issue', 'Customer concern discussed',
];
const CHIP_RECOMMENDATIONS = [
  'Callback recommended', 'Irrigation adjustment needed', 'Follow-up in 2 weeks',
  'Schedule interior next visit', 'Bait station replacement', 'Customer wants estimate',
];
const VISIT_OUTCOME_OPTIONS = [
  { value: 'completed', label: 'Completed' },
  { value: 'inspection_only', label: 'Inspection only' },
  { value: 'customer_declined', label: 'Customer declined' },
  { value: 'follow_up_needed', label: 'Follow-up needed' },
  { value: 'customer_concern', label: 'Customer concern' },
  { value: 'incomplete', label: 'Incomplete' },
];
const OFFICE_APPROVAL_REASONS = [
  { value: 'office_approved_blackout_exception', label: 'Office approved exception' },
  { value: 'soil_test_supported_phosphorus', label: 'Soil test supports phosphorus' },
  { value: 'non_fertilizer_application_only', label: 'No N/P fertilizer applied' },
];
const N_LIMIT_APPROVAL_REASONS = [
  { value: 'admin_approved_n_budget_exception', label: 'Admin approved exception' },
  { value: 'ledger_adjustment_pending', label: 'Ledger adjustment pending' },
  { value: 'site_specific_agronomic_need', label: 'Site-specific agronomic need' },
];
const MANAGER_APPROVAL_REASONS = [
  { value: 'manager_approved_protocol_exception', label: 'Manager approved protocol exception' },
  { value: 'field_conditions_documented', label: 'Field conditions documented' },
  { value: 'label_review_completed', label: 'Label / rotation reviewed' },
];
const MANAGER_APPROVAL_CODES = new Set([
  'off_protocol_product',
  'high_rate_application',
  'fungicide_frac_rotation_approval',
  'repeat_moa_group',
  'repeat_frac_group',
  'repeat_irac_group',
  'repeat_hrac_group',
  'pgr_on_stressed_turf',
  'st_augustine_dethatching',
]);
function normalizeRateUnit(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const aliases = {
    floz: 'fl_oz',
    fl_oz: 'fl_oz',
    fluid_ounce: 'fl_oz',
    fluid_ounces: 'fl_oz',
    lbs: 'lb',
    pounds: 'lb',
    ounces: 'oz',
  };
  return aliases[normalized] || normalized;
}
function rateUnitsMatch(a, b) {
  const left = normalizeRateUnit(a);
  const right = normalizeRateUnit(b);
  return !!left && !!right && left === right;
}
const TANK_CLEANOUT_METHODS = [
  'Triple rinse',
  'Clean water flush',
  'Tank cleaner flush',
  'Dedicated tank, no residue risk',
];
const AREAS_BY_SERVICE = {
  pest: ['Perimeter', 'Garage', 'Kitchen', 'Bathrooms', 'Entry points', 'Yard', 'Fence line', 'Trash area'],
  lawn: ['Front yard', 'Back yard', 'Side yard', 'Landscape beds', 'Shrubs', 'Palms', 'Problem area', 'Irrigation zone'],
  universal: ['Customer spoke with tech', 'No issues found', 'Follow-up recommended'],
};
const CUSTOMER_INTERACTION_OPTIONS = [
  { value: 'spoke', label: 'Customer home — spoke with them' },
  { value: 'not_home_full', label: 'Customer not home — full access' },
  { value: 'not_home_partial', label: 'Customer not home — partial access' },
  { value: 'concern', label: 'Customer had specific concern' },
];

const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

const SKIP_REASONS = [
  { value: 'not_home', label: 'Customer not home' },
  { value: 'inaccessible', label: 'Property inaccessible' },
  { value: 'weather', label: 'Weather' },
  { value: 'customer_requested', label: 'Customer requested' },
  { value: 'tech_behind', label: 'Tech running behind' },
];

/* ── Helpers ──────────────────────────────────────────── */

// Strips legacy boilerplate from historical imported appointment notes.
function stripLegacyBoilerplate(notes) {
  if (!notes) return '';
  return notes
    .replace(/\*{3}\s*Please make changes.*?(?:\*{3}|$)/gis, '')
    .replace(/Please make changes to this appointment in the [\s\S]*?next sync\./gi, '')
    .replace(/New customer\s*[-\u2013\u2014]\s*first visit/gi, '')
    .replace(/New customer\s*[-\u2013\u2014]\s*first time/gi, '')
    .replace(/First[-\s]time customer/gi, '')
    .replace(/Booked online/gi, '')
    .replace(/Any changes made here will be overwritten.*$/gim, '')
    .replace(/\|\s*$/g, '').replace(/^\s*\|/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then(r => {
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  });
}

function googleMapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function detectServiceCategory(serviceType) {
  const s = (serviceType || '').toLowerCase();
  if (s.includes('lawn')) return 'lawn';
  if (s.includes('mosquito')) return 'mosquito';
  if (s.includes('termite')) return 'termite';
  return 'pest';
}

function createCompletionIdempotencyKey(serviceId) {
  const randomPart = window.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `complete_${serviceId}_${randomPart}`;
}

function completionDraftKey(serviceId) {
  return `waves_completion_draft_${serviceId}`;
}

function elapsedSince(isoTime) {
  if (!isoTime) return '0:00';
  const diff = Math.max(0, Math.floor((Date.now() - new Date(isoTime).getTime()) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}


const btnBase = {
  height: 44, minWidth: 110, padding: '0 18px', borderRadius: 12, border: 'none',
  fontWeight: 700, fontSize: 13, cursor: 'pointer', transition: 'all 0.2s',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
};


/* ── Edit Service Modal ───────────────────────────────── */

const EDIT_CATEGORY_LABELS = { recurring: 'Recurring Services', one_time: 'One-Time Treatments', assessment: 'Assessments', pest_control: 'Pest Control', lawn_care: 'Lawn Care', mosquito: 'Mosquito', termite: 'Termite', rodent: 'Rodent', tree_shrub: 'Tree & Shrub', inspection: 'Inspections', specialty: 'Specialty', other: 'Other' };
const EDIT_CATEGORY_EMOJI = { recurring: '🔄', one_time: '🎯', assessment: '📋', pest_control: '🐛', lawn_care: '🌿', mosquito: '🦟', termite: '🪵', rodent: '🐀', tree_shrub: '🌳', inspection: '🔍', specialty: '⚡', other: '📦' };
const EDIT_FREQUENCIES = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'bimonthly', label: 'Every 2 months' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'triannual', label: 'Every 4 months' },
  { value: 'semiannual', label: 'Semiannual' },
  { value: 'annual', label: 'Annual' },
  { value: 'monthly_nth_weekday', label: 'Every month on the Nth weekday' },
  { value: 'custom', label: 'Custom (every N days)' },
];
const EDIT_NTH_OPTIONS = [
  { value: 1, label: '1st' }, { value: 2, label: '2nd' },
  { value: 3, label: '3rd' }, { value: 4, label: '4th' },
  { value: 5, label: '5th / last' },
];
const EDIT_WEEKDAY_OPTIONS = [
  { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

function editNthWeekdayOfMonth(year, month, nth, weekday) {
  const d = new Date(year, month, 1, 12, 0, 0);
  const firstW = d.getDay();
  const offset = (weekday - firstW + 7) % 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  let day = 1 + offset + (Math.max(1, nth) - 1) * 7;
  if (day > lastDay) day -= 7;
  return new Date(year, month, day, 12, 0, 0);
}

function editNextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const { nth, weekday, intervalDays } = opts;
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : etDateString();
  const base = new Date(safe + 'T12:00:00');
  if (isNaN(base.getTime())) return new Date();
  const nthNum = (nth != null && nth !== '' && !isNaN(parseInt(nth))) ? parseInt(nth) : null;
  const wdayNum = (weekday != null && weekday !== '' && !isNaN(parseInt(weekday))) ? parseInt(weekday) : null;
  const intNum = (intervalDays != null && intervalDays !== '' && !isNaN(parseInt(intervalDays))) ? parseInt(intervalDays) : null;
  if (pattern === 'monthly_nth_weekday' && nthNum != null && wdayNum != null) {
    const d = editNthWeekdayOfMonth(base.getFullYear(), base.getMonth() + i, nthNum, wdayNum);
    return isNaN(d.getTime()) ? base : d;
  }
  const monthIntervals = {
    monthly: 1, bimonthly: 2, quarterly: 3, triannual: 4,
    semiannual: 6, biannual: 6, annual: 12, yearly: 12,
  };
  if (monthIntervals[pattern]) {
    const d = new Date(base);
    const nth = Math.ceil(d.getDate() / 7);
    const target = editNthWeekdayOfMonth(d.getFullYear(), d.getMonth() + monthIntervals[pattern] * i, nth, d.getDay());
    return isNaN(target.getTime()) ? base : target;
  }
  const intervals = { daily: 1, weekly: 7, biweekly: 14 };
  let gap;
  if (pattern === 'custom' && intNum) gap = Math.max(1, intNum);
  else gap = intervals[pattern] || 91;
  const d = new Date(base);
  d.setDate(d.getDate() + gap * i);
  return isNaN(d.getTime()) ? base : d;
}
const EDIT_FALLBACK_SERVICES = [
  { category: 'pest_control', items: [
    { name: 'Pest Control Service' }, { name: 'Mosquito Control Service' },
    { name: 'Tick Control Service' }, { name: 'Wasp Control Service' },
    { name: 'Quarterly Pest Control Service' }, { name: 'Bi-Monthly Pest Control Service' },
    { name: 'Monthly Pest Control Service' },
  ]},
  { category: 'rodent', items: [
    { name: 'Rodent Control Service' }, { name: 'Rodent Trapping Service' },
    { name: 'Rodent Exclusion Service' }, { name: 'Rodent Bait Station Service' },
  ]},
  { category: 'termite', items: [
    { name: 'Termite Monitoring Service' }, { name: 'Termite Active Bait Station Service' },
    { name: 'Termite Spot Treatment Service' }, { name: 'Termite Trenching Service' },
  ]},
  { category: 'lawn_care', items: [
    { name: 'Lawn Care Service' }, { name: 'Lawn Fertilization Service' },
    { name: 'Lawn Fungicide Treatment Service' }, { name: 'Lawn Insect Control Service' },
  ]},
  { category: 'tree_shrub', items: [
    { name: 'Every 6 Weeks Tree & Shrub Care Service' }, { name: 'Bi-Monthly Tree & Shrub Care Service' },
  ]},
  { category: 'specialty', items: [
    { name: 'WaveGuard Membership' }, { name: 'Waves Pest Control Appointment' },
  ]},
];

export function EditServiceModal({ service, technicians, onClose, onSaved }) {
  const [form, setForm] = useState({
    scheduledDate: service.scheduledDate ? String(service.scheduledDate).split('T')[0] : '',
    windowStart: service.windowStart || '',
    windowEnd: service.windowEnd || '',
    serviceType: service.serviceType || '',
    estimatedDuration: service.estimatedDuration || 60,
    technicianId: service.technicianId || '',
    routeOrder: service.routeOrder || '',
    notes: service.notes || '',
    price: service.estimatedPrice != null ? String(service.estimatedPrice) : (service.estimated_price != null ? String(service.estimated_price) : ''),
  });
  const [saving, setSaving] = useState(false);
  const [serviceGroups, setServiceGroups] = useState(EDIT_FALLBACK_SERVICES);
  const [expandedCategory, setExpandedCategory] = useState(null);
  const [editingServiceType, setEditingServiceType] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFreq, setRecurringFreq] = useState(service.recurringPattern || 'quarterly');
  const [recurringCount, setRecurringCount] = useState(4);
  const [recurringOngoing, setRecurringOngoing] = useState(true);
  const [recurringNth, setRecurringNth] = useState(3);
  const [recurringWeekday, setRecurringWeekday] = useState(3);
  const [recurringIntervalDays, setRecurringIntervalDays] = useState(30);
  const [discountType, setDiscountType] = useState('');
  const [discountAmount, setDiscountAmount] = useState('');
  const [discountPresets, setDiscountPresets] = useState([]);
  const [discountPresetId, setDiscountPresetId] = useState('');
  const [createInvoice, setCreateInvoice] = useState(!!(service.createInvoiceOnComplete ?? service.create_invoice_on_complete));
  const [customerData, setCustomerData] = useState(null);
  const [customerLoading, setCustomerLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await adminFetch('/admin/schedule/services-dropdown');
        if (r.groups?.length) setServiceGroups(r.groups);
      } catch { /* keep fallback */ }
    })();
    (async () => {
      try {
        const r = await adminFetch('/admin/discounts');
        const list = Array.isArray(r) ? r : [];
        const filtered = list.filter(d => d.is_active && !d.is_auto_apply
          && (d.discount_type === 'percentage' || d.discount_type === 'fixed_amount'));
        setDiscountPresets(filtered);
      } catch { /* discounts optional */ }
    })();
  }, []);

  useEffect(() => {
    const customerId = service.customerId || service.customer_id;
    if (!customerId) return;
    let cancelled = false;
    setCustomerLoading(true);
    adminFetch(`/admin/customers/${customerId}`)
      .then((json) => { if (!cancelled) setCustomerData(json); })
      .catch(() => { if (!cancelled) setCustomerData(null); })
      .finally(() => { if (!cancelled) setCustomerLoading(false); });
    return () => { cancelled = true; };
  }, [service.customerId, service.customer_id]);

  const applyDiscountPreset = (id) => {
    setDiscountPresetId(id);
    if (!id) { setDiscountType(''); setDiscountAmount(''); return; }
    if (id === 'custom') return;
    const d = discountPresets.find(x => String(x.id) === String(id));
    if (!d) return;
    setDiscountType(d.discount_type);
    setDiscountAmount(String(d.amount ?? ''));
  };

  const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const recurringPreview = () => {
    if (!isRecurring || !form.scheduledDate) return null;
    const opts = { nth: recurringNth, weekday: recurringWeekday, intervalDays: recurringIntervalDays };
    const limit = Math.min(recurringOngoing ? 4 : recurringCount, 6);
    const dates = [];
    for (let i = 0; i < limit; i++) {
      const d = editNextRecurringDate(form.scheduledDate, recurringFreq, i, opts);
      dates.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    return dates;
  };

  const handleSave = async ({ takePayment = false } = {}) => {
    setSaving(true);
    try {
      await adminFetch(`/admin/schedule/${service.id}/update-details`, {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          isRecurring,
          recurringPattern: isRecurring ? recurringFreq : undefined,
          recurringCount: isRecurring ? (recurringOngoing ? 4 : recurringCount) : undefined,
          recurringOngoing: isRecurring ? recurringOngoing : undefined,
          recurringNth: isRecurring && recurringFreq === 'monthly_nth_weekday' ? recurringNth : undefined,
          recurringWeekday: isRecurring && recurringFreq === 'monthly_nth_weekday' ? recurringWeekday : undefined,
          recurringIntervalDays: isRecurring && recurringFreq === 'custom' ? recurringIntervalDays : undefined,
          discountType: discountType || undefined,
          discountAmount: discountType && discountAmount !== '' ? Number(discountAmount) : undefined,
          estimatedPrice: form.price !== '' && !isNaN(parseFloat(form.price)) ? parseFloat(form.price) : undefined,
          createInvoice: takePayment || createInvoice,
        }),
      });
      onSaved?.();
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
    setSaving(false);
  };

  const customer = customerData?.customer || {};
  const customerName = service.customerName
    || `${customer.firstName || ''} ${customer.lastName || ''}`.trim()
    || 'Customer';
  const customerPhone = service.customerPhone || customer.phone || '';
  const customerEmail = customer.email || '';
  const servicePrice = form.price !== '' && !isNaN(parseFloat(form.price)) ? parseFloat(form.price) : 0;
  const manualDiscount = discountType && discountAmount !== ''
    ? (discountType === 'percentage' ? servicePrice * (Number(discountAmount) / 100) : Number(discountAmount))
    : 0;
  const appointmentTotal = Math.max(0, servicePrice - manualDiscount);
  const appointmentHistory = Array.isArray(customerData?.scheduled)
    ? [...customerData.scheduled]
      .sort((a, b) => String(b.scheduled_date).localeCompare(String(a.scheduled_date)))
      .slice(0, 6)
    : [];
  const cards = Array.isArray(customerData?.cards) ? customerData.cards : [];

  const formatHistoryDate = (value, time) => {
    if (!value) return '';
    const [year, month, day] = String(value).split('T')[0].split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day, 12));
    const dateText = d.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timeMatch = String(time || '').match(/^(\d{1,2}):(\d{2})/);
    const timeText = timeMatch
      ? `${parseInt(timeMatch[1], 10) % 12 || 12}:${timeMatch[2]} ${parseInt(timeMatch[1], 10) >= 12 ? 'PM' : 'AM'}`
      : '';
    return [dateText, timeText].filter(Boolean).join(', ');
  };

  const labelStyle = {
    fontSize: 12,
    color: '#374151',
    marginBottom: 6,
    display: 'block',
    fontWeight: 700,
  };
  const inputStyle = {
    width: '100%',
    padding: '11px 12px',
    borderRadius: 4,
    background: D.input,
    color: '#111827',
    border: `1px solid ${D.inputBorder}`,
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
  };
  const sectionStyle = {
    background: '#fff',
    border: `1px solid ${D.border}`,
    borderRadius: 6,
    padding: 18,
    marginBottom: 16,
  };
  const sectionTitleStyle = {
    fontSize: 18,
    fontWeight: 700,
    color: '#111827',
    margin: '0 0 14px',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#F6F7F8', zIndex: 1000,
      display: 'flex', flexDirection: 'column', color: '#111827',
      fontFamily: 'Inter, Roboto, system-ui, sans-serif',
    }}>
      <div
        onClick={e => e.stopPropagation()}
        className="font-bold"
        style={{
          height: '100%', overflow: 'auto',
        }}
      >
        <div style={{
          position: 'sticky', top: 0, zIndex: 3, background: '#fff',
          borderBottom: `1px solid ${D.border}`, padding: '14px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
        }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#111827' }}>Edit appointment</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px',
                borderRadius: 999, background: '#ECFDF3', color: '#027A48', fontSize: 12, fontWeight: 800,
              }}>{service.status || 'Accepted'}</span>
              <span style={{ color: D.muted, fontSize: 13 }}>{customerName}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button onClick={() => handleSave({ takePayment: true })} disabled={saving} className="font-bold" style={{
              padding: '11px 16px', borderRadius: 4, background: '#111827', color: '#fff',
              border: 'none', fontSize: 13, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1,
            }}>{saving ? 'Saving...' : 'Save and take payment'}</button>
            <button onClick={() => handleSave()} disabled={saving} className="font-bold" style={{
              padding: '11px 16px', borderRadius: 4, background: '#fff', color: '#111827',
              border: `1px solid ${D.inputBorder}`, fontSize: 13, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1,
            }}>{saving ? 'Saving...' : 'Save'}</button>
            <button onClick={onClose} disabled={saving} className="font-bold" style={{
              width: 38, height: 38, borderRadius: 4, background: '#fff',
              color: D.muted, border: `1px solid ${D.inputBorder}`, fontSize: 22,
              lineHeight: 1, cursor: 'pointer',
            }} aria-label="Close">×</button>
          </div>
        </div>

        <div style={{
          width: '100%', maxWidth: 1180, margin: '0 auto', padding: '22px 20px 36px',
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 20,
        }}>
          <aside style={{ ...sectionStyle, alignSelf: 'start', position: 'sticky', top: 88 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: D.muted, marginBottom: 12 }}>Customer</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#111827', marginBottom: 10 }}>{customerName}</div>
            <div style={{ display: 'grid', gap: 4, marginBottom: 14, fontSize: 14, color: '#374151' }}>
              {customerPhone && <a href={`tel:${customerPhone}`} style={{ color: '#111827', textDecoration: 'none' }}>{customerPhone}</a>}
              {customerEmail && <a href={`mailto:${customerEmail}`} style={{ color: '#111827', textDecoration: 'none', wordBreak: 'break-word' }}>{customerEmail}</a>}
              {!customerPhone && !customerEmail && <span style={{ color: D.muted }}>No contact details</span>}
            </div>
            <button type="button" style={{
              width: '100%', padding: '10px 12px', borderRadius: 4,
              border: `1px solid ${D.inputBorder}`, background: '#fff',
              color: '#111827', fontSize: 13, fontWeight: 800, cursor: 'pointer',
              marginBottom: 18,
            }}>Customer details</button>

            <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>Customer notes</div>
                <button type="button" style={{ border: 0, background: 'transparent', color: D.teal, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>Add note</button>
              </div>
              <div style={{ fontSize: 13, color: D.muted }}>
                {customer.notes || customer.customerNotes || 'No customer notes'}
              </div>
            </div>

            <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>Cards on file</div>
                <button type="button" style={{ border: 0, background: 'transparent', color: D.teal, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>Add card</button>
              </div>
              {cards.length ? cards.slice(0, 2).map((card, i) => (
                <div key={card.id || i} style={{ fontSize: 13, color: '#374151', marginBottom: 6 }}>
                  Card ending in {card.last4 || card.card_last4 || '----'}
                </div>
              )) : <div style={{ fontSize: 13, color: D.muted }}>No cards on file</div>}
            </div>

            <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>Appointment history</div>
              {customerLoading && <div style={{ fontSize: 13, color: D.muted }}>Loading history...</div>}
              {!customerLoading && appointmentHistory.length === 0 && (
                <div style={{ fontSize: 13, color: D.muted }}>No appointment history</div>
              )}
              <div style={{ display: 'grid', gap: 12 }}>
                {appointmentHistory.map((item) => (
                  <div key={item.id} style={{ borderLeft: `2px solid ${item.id === service.id ? D.teal : D.border}`, paddingLeft: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#111827' }}>{item.service_type || item.serviceType || 'Service'}</div>
                    <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{formatHistoryDate(item.scheduled_date, item.window_start)}</div>
                    {item.status && <div style={{ fontSize: 12, color: '#027A48', marginTop: 2 }}>{item.status}</div>}
                  </div>
                ))}
              </div>
            </div>
          </aside>

          <main>
            <section style={sectionStyle}>
              <h2 style={sectionTitleStyle}>Location</h2>
              <label style={labelStyle}>Appointment location</label>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, height: 36,
                padding: '0 12px', borderRadius: 999, background: '#EEF6FF',
                color: D.teal, fontSize: 13, fontWeight: 800, marginBottom: 14,
              }}>Customer location</div>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Street address</label>
                  <input value={service.address || customer.address?.line1 || ''} readOnly className="font-bold" style={{ ...inputStyle, background: '#F9FAFB' }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>City</label>
                    <input value={service.city || customer.address?.city || ''} readOnly className="font-bold" style={{ ...inputStyle, background: '#F9FAFB' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>State</label>
                    <input value={customer.address?.state || 'Florida'} readOnly className="font-bold" style={{ ...inputStyle, background: '#F9FAFB' }} />
                  </div>
                </div>
              </div>
            </section>

            <section style={sectionStyle}>
              <h2 style={sectionTitleStyle}>Services and items</h2>
              <div style={{ border: `1px solid ${D.border}`, borderRadius: 6, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, alignItems: 'center', padding: 14, background: '#F9FAFB' }}>
                  <div>
                    <label style={labelStyle}>Service</label>
                    {!editingServiceType ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ flex: 1, fontSize: 14, color: '#111827' }}>
                          {form.serviceType || 'Select service'}
                        </div>
                        <button type="button" onClick={() => setEditingServiceType(true)} className="font-bold" style={{
                          padding: '8px 10px', borderRadius: 4, background: '#fff', color: '#111827',
                          border: `1px solid ${D.inputBorder}`, fontSize: 12, cursor: 'pointer',
                        }}>Change</button>
                      </div>
                    ) : (
                      <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${D.inputBorder}`, borderRadius: 4, padding: 6, background: '#fff' }}>
                        {serviceGroups.map((group) => {
                          const isOpen = expandedCategory === group.category;
                          return (
                            <div key={group.category} style={{ marginBottom: 4 }}>
                              <button type="button" onClick={() => setExpandedCategory(isOpen ? null : group.category)} className="font-bold" style={{
                                width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 4,
                                background: isOpen ? '#EEF6FF' : '#fff', border: `1px solid ${D.border}`,
                                color: '#111827', fontSize: 13, cursor: 'pointer',
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              }}>
                                <span>{EDIT_CATEGORY_LABELS[group.category] || group.category} <span style={{ color: D.muted }}>({group.items.length})</span></span>
                                <span style={{ color: D.muted, fontSize: 11 }}>{isOpen ? 'v' : '>'}</span>
                              </button>
                              {isOpen && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: 6 }}>
                                  {group.items.map((svc, si) => (
                                    <button key={si} type="button" onClick={() => {
                                      update('serviceType', svc.name);
                                      if (svc.duration || svc.default_duration_minutes) {
                                        update('estimatedDuration', svc.duration || svc.default_duration_minutes);
                                      }
                                      setEditingServiceType(false);
                                      setExpandedCategory(null);
                                    }} className="font-bold" style={{
                                      padding: '8px 10px', background: '#fff', border: `1px solid ${D.border}`,
                                      borderRadius: 4, color: '#111827', fontSize: 13, cursor: 'pointer', textAlign: 'left',
                                    }}>{svc.name}</button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div>
                    <label style={labelStyle}>Staff</label>
                    <select value={form.technicianId} onChange={e => update('technicianId', e.target.value)} className="font-bold" style={inputStyle}>
                      <option value="">Unassigned</option>
                      {(technicians || []).map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Duration</label>
                    <input type="number" value={form.estimatedDuration} onChange={e => update('estimatedDuration', e.target.value)} className="font-bold" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Price</label>
                    <input type="number" min={0} step={0.01} value={form.price} onChange={e => update('price', e.target.value)} placeholder="0.00" className="font-bold" style={inputStyle} />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                <button type="button" style={{ padding: '9px 12px', borderRadius: 4, border: `1px solid ${D.inputBorder}`, background: '#fff', fontSize: 13, fontWeight: 800 }}>Add services</button>
                <button type="button" style={{ padding: '9px 12px', borderRadius: 4, border: `1px solid ${D.inputBorder}`, background: '#fff', fontSize: 13, fontWeight: 800 }}>Add item</button>
                <button type="button" onClick={() => setDiscountPresetId(discountPresetId || 'custom')} style={{ padding: '9px 12px', borderRadius: 4, border: `1px solid ${D.inputBorder}`, background: '#fff', fontSize: 13, fontWeight: 800 }}>Add discount</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle}>Discount</label>
                  <select value={discountPresetId} onChange={e => applyDiscountPreset(e.target.value)} className="font-bold" style={inputStyle}>
                    <option value="">None</option>
                    {discountPresets.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name} - {d.discount_type === 'percentage' ? `${Number(d.amount).toFixed(d.amount % 1 ? 2 : 0)}%` : `$${Number(d.amount).toFixed(2)}`}
                      </option>
                    ))}
                    <option value="custom">Custom</option>
                  </select>
                </div>
                {discountPresetId === 'custom' && (
                  <>
                    <div>
                      <label style={labelStyle}>Discount type</label>
                      <select value={discountType} onChange={e => setDiscountType(e.target.value)} className="font-bold" style={inputStyle}>
                        <option value="">Select</option>
                        <option value="percentage">Percentage (%)</option>
                        <option value="fixed_amount">Amount ($)</option>
                      </select>
                    </div>
                    {discountType && (
                      <div>
                        <label style={labelStyle}>{discountType === 'percentage' ? 'Amount (%)' : 'Amount ($)'}</label>
                        <input type="number" min={0} step={discountType === 'percentage' ? 1 : 0.01} value={discountAmount} onChange={e => setDiscountAmount(e.target.value)} className="font-bold" style={inputStyle} />
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 12, display: 'grid', gap: 6, justifyContent: 'end' }}>
                <div style={{ minWidth: 220, display: 'flex', justifyContent: 'space-between', gap: 40, fontSize: 14 }}>
                  <span>Subtotal</span><strong>${servicePrice.toFixed(2)}</strong>
                </div>
                {manualDiscount > 0 && (
                  <div style={{ minWidth: 220, display: 'flex', justifyContent: 'space-between', gap: 40, fontSize: 14, color: '#B42318' }}>
                    <span>Custom Discount</span><strong>(${manualDiscount.toFixed(2)})</strong>
                  </div>
                )}
                <div style={{ minWidth: 220, display: 'flex', justifyContent: 'space-between', gap: 40, fontSize: 16, borderTop: `1px solid ${D.border}`, paddingTop: 8 }}>
                  <span>Total</span><strong>${appointmentTotal.toFixed(2)}</strong>
                </div>
              </div>
            </section>

            <section style={sectionStyle}>
              <h2 style={sectionTitleStyle}>Date and time</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle}>Date</label>
                  <input type="date" value={form.scheduledDate} onChange={e => update('scheduledDate', e.target.value)} className="font-bold" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Time</label>
                  <input type="time" value={form.windowStart} onChange={e => update('windowStart', e.target.value)} className="font-bold" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>End time</label>
                  <input type="time" value={form.windowEnd} onChange={e => update('windowEnd', e.target.value)} className="font-bold" style={inputStyle} />
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: isRecurring ? 14 : 0 }}>
                <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} style={{ width: 17, height: 17, accentColor: D.teal }} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800 }}>Repeat</div>
                  <div style={{ fontSize: 12, color: D.muted }}>Create future appointments from this date</div>
                </div>
              </div>
              {isRecurring && (
                <div style={{ border: `1px solid ${D.border}`, borderRadius: 6, padding: 14, background: '#F9FAFB' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 }}>
                    <div>
                      <label style={labelStyle}>Repeats</label>
                      <select value={recurringFreq} onChange={e => setRecurringFreq(e.target.value)} className="font-bold" style={inputStyle}>
                        {EDIT_FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>End repeating</label>
                      <select value={recurringOngoing ? 'never' : 'count'} onChange={e => setRecurringOngoing(e.target.value === 'never')} className="font-bold" style={inputStyle}>
                        <option value="never">Never</option>
                        <option value="count">After count</option>
                      </select>
                    </div>
                    {!recurringOngoing && (
                      <div>
                        <label style={labelStyle}>Count</label>
                        <input type="number" min={2} max={24} value={recurringCount} onChange={e => setRecurringCount(parseInt(e.target.value) || 4)} className="font-bold" style={inputStyle} />
                      </div>
                    )}
                  </div>
                  {recurringFreq === 'monthly_nth_weekday' && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 }}>
                      <div>
                        <label style={labelStyle}>Repeat every</label>
                        <select value={recurringNth} onChange={e => setRecurringNth(parseInt(e.target.value))} className="font-bold" style={inputStyle}>
                          {EDIT_NTH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={labelStyle}>Day of month</label>
                        <select value={recurringWeekday} onChange={e => setRecurringWeekday(parseInt(e.target.value))} className="font-bold" style={inputStyle}>
                          {EDIT_WEEKDAY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    </div>
                  )}
                  {recurringFreq === 'custom' && (
                    <div style={{ marginBottom: 10 }}>
                      <label style={labelStyle}>Frequency</label>
                      <input type="number" min={1} max={365} value={recurringIntervalDays} onChange={e => setRecurringIntervalDays(parseInt(e.target.value) || 30)} className="font-bold" style={inputStyle} />
                    </div>
                  )}
                  {recurringPreview() && (
                    <div style={{ fontSize: 12, color: D.muted, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {recurringPreview().map((d, i) => (
                        <span key={i} style={{ padding: '3px 7px', background: '#EEF6FF', borderRadius: 999, color: D.teal, fontWeight: 800 }}>{d}</span>
                      ))}
                      {recurringOngoing
                        ? <span style={{ padding: '3px 7px' }}>then auto-extends</span>
                        : (recurringCount > 6 && <span style={{ padding: '3px 7px' }}>+{recurringCount - 6} more</span>)}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section style={sectionStyle}>
              <h2 style={sectionTitleStyle}>Notes</h2>
              <label style={labelStyle}>Appointment notes</label>
              <textarea value={form.notes} onChange={e => update('notes', e.target.value)} rows={5} className="font-bold" style={{ ...inputStyle, resize: 'vertical' }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginTop: 14, padding: '11px 12px', background: '#F9FAFB', border: `1px solid ${D.border}`, borderRadius: 4 }}>
                <input type="checkbox" checked={createInvoice} onChange={e => setCreateInvoice(e.target.checked)} style={{ width: 16, height: 16, accentColor: D.green }} />
                <span style={{ fontSize: 13, color: '#111827', fontWeight: 800 }}>Create invoice on completion</span>
              </label>
              {service.createdAt && (
                <div style={{ fontSize: 12, color: D.muted, marginTop: 14 }}>
                  Booked on {new Date(service.createdAt).toLocaleString()}
                </div>
              )}
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}

/* ── Reschedule Modal ─────────────────────────────────── */

// =========================================================================
// PROTOCOL PANEL — shows all 5 protocol layers for a service
// =========================================================================
export function ProtocolPanel({ service, onClose }) {
  const [photos, setPhotos] = useState([]);
  const [seasonal, setSeasonal] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [productLabels, setProductLabels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState('overview');

  useEffect(() => {
    const svcType = (service.serviceType || '').toLowerCase();
    const line = svcType.includes('lawn') ? 'lawn' : svcType.includes('tree') || svcType.includes('shrub') ? 'tree_shrub' : svcType.includes('mosquito') ? 'mosquito' : 'pest';
    const month = new Date().getMonth() + 1;

    Promise.all([
      adminFetch(`/admin/protocols/photos/relevant?serviceType=${encodeURIComponent(service.serviceType)}&month=${month}`),
      adminFetch(`/admin/protocols/seasonal-index?month=${month}&service_line=${line}`),
      adminFetch(`/admin/protocols/scripts?service_line=${line}`),
      adminFetch(`/admin/protocols/equipment?service_line=${line}`),
    ]).then(([p, s, sc, eq]) => {
      setPhotos(p.photos || []);
      setSeasonal(s.pests || []);
      setScripts(sc.scripts || []);
      setEquipment(eq.checklists || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [service]);

  const SECTIONS = [
    { id: 'overview', label: '📊 Overview', count: null },
    { id: 'seasonal', label: '🌡️ Pest Pressure', count: seasonal.length },
    { id: 'photos', label: '📸 ID Guide', count: photos.length },
    { id: 'scripts', label: '💬 Scripts', count: scripts.length },
    { id: 'equipment', label: '🔧 Equipment', count: equipment.length },
  ];

  const pressureColors = { peak: D.red, high: D.amber, moderate: D.teal, low: D.green, dormant: D.gray };

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, width: isMobile ? '100%' : '60%', maxWidth: isMobile ? '100%' : 600, minWidth: isMobile ? 0 : 380,
      height: '100vh', background: D.card, borderLeft: isMobile ? 'none' : `1px solid ${D.border}`,
      zIndex: 1000, display: 'flex', flexDirection: 'column',
      boxShadow: '-8px 0 32px rgba(0,0,0,0.3)',
    }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${D.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>📋 Service Protocol</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{service.serviceType} — {service.customerName}</div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 20, cursor: 'pointer' }}>✕</button>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: `1px solid ${D.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)} style={{
            padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
            fontSize: 11, fontWeight: 600, flexShrink: 0, minHeight: 44,
            background: activeSection === s.id ? D.teal : 'transparent',
            color: activeSection === s.id ? D.bg : D.muted,
          }}>{s.label}{s.count !== null ? ` (${s.count})` : ''}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: D.muted }}>Loading protocol...</div>
        ) : (
          <>
            {/* OVERVIEW */}
            {activeSection === 'overview' && (
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Service Overview</div>
                <div style={{ background: D.bg, borderRadius: 10, padding: 14, border: `1px solid ${D.border}`, marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: D.heading, fontWeight: 600 }}>{service.serviceType}</div>
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{service.customerName} — {service.address}</div>
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>Est. duration: {service.estimatedDuration || 30} min</div>
                  {service.lawnType && <div style={{ fontSize: 12, color: D.teal, marginTop: 2 }}>{service.lawnType} — {service.lotSqft?.toLocaleString() || '?'} sf lot</div>}
                </div>

                {/* Quick stats */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <div style={{ flex: 1, background: D.bg, borderRadius: 8, padding: 10, border: `1px solid ${D.border}`, textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: D.amber }}>{seasonal.length}</div>
                    <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Active Pests</div>
                  </div>
                  <div style={{ flex: 1, background: D.bg, borderRadius: 8, padding: 10, border: `1px solid ${D.border}`, textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: D.teal }}>{photos.length}</div>
                    <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>ID Refs</div>
                  </div>
                  <div style={{ flex: 1, background: D.bg, borderRadius: 8, padding: 10, border: `1px solid ${D.border}`, textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: D.green }}>{scripts.length}</div>
                    <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Scripts</div>
                  </div>
                </div>

                {/* Property alerts */}
                {service.propertyAlerts?.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: D.amber, marginBottom: 6 }}>⚠️ Property Alerts</div>
                    {service.propertyAlerts.map((a, i) => (
                      <div key={i} style={{ fontSize: 12, color: a.type === 'chemical' ? D.red : D.amber, marginBottom: 3, paddingLeft: 8, borderLeft: `2px solid ${a.type === 'chemical' ? D.red : D.amber}` }}>
                        {a.text}
                      </div>
                    ))}
                  </div>
                )}

                {/* Last service notes */}
                {service.lastServiceNotes && stripLegacyBoilerplate(service.lastServiceNotes) && (
                  <div style={{ background: D.bg, borderRadius: 10, padding: 12, border: `1px solid ${D.border}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Last Visit Notes</div>
                    <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>{stripLegacyBoilerplate(service.lastServiceNotes)}</div>
                  </div>
                )}
              </div>
            )}

            {/* SEASONAL PEST PRESSURE */}
            {activeSection === 'seasonal' && (
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 4 }}>This Month in SWFL</div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>What to look for and how to respond</div>
                {seasonal.length === 0 ? (
                  <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No seasonal data for this service line</div>
                ) : seasonal.map((p, i) => (
                  <div key={i} style={{ background: D.bg, borderRadius: 10, padding: 14, border: `1px solid ${D.border}`, marginBottom: 8, borderLeft: `3px solid ${pressureColors[p.pressure_level] || D.gray}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{p.pest_name}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 8, background: `${pressureColors[p.pressure_level]}22`, color: pressureColors[p.pressure_level] }}>{p.pressure_level}</span>
                    </div>
                    <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.5 }}>{p.description}</div>
                    {p.treatment_if_found && (
                      <div style={{ fontSize: 11, color: D.teal, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${D.border}` }}>
                        <strong>If found:</strong> {p.treatment_if_found}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* PHOTO ID GUIDE */}
            {activeSection === 'photos' && (
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 4 }}>Identification References</div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>Visual ID guides for this service type</div>
                {photos.length === 0 ? (
                  <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No photo references for this service</div>
                ) : photos.map((p, i) => (
                  <div key={i} style={{ background: D.bg, borderRadius: 10, padding: 14, border: `1px solid ${D.border}`, marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: D.teal, marginBottom: 6 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: D.text, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{p.description}</div>
                    {p.photoUrl && <img src={p.photoUrl} alt={p.name} style={{ width: '100%', borderRadius: 8, marginTop: 8 }} />}
                  </div>
                ))}
              </div>
            )}

            {/* COMMUNICATION SCRIPTS */}
            {activeSection === 'scripts' && (
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 4 }}>Customer Communication Scripts</div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>What to say on the property</div>
                {scripts.length === 0 ? (
                  <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No scripts for this service line</div>
                ) : scripts.map((s, i) => (
                  <div key={i} style={{ background: D.bg, borderRadius: 10, padding: 14, border: `1px solid ${D.border}`, marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: D.heading, marginBottom: 6 }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: D.text, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{s.script}</div>
                    {s.tone_notes && (
                      <div style={{ fontSize: 11, color: D.amber, marginTop: 8, fontStyle: 'italic' }}>💡 {s.tone_notes}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* EQUIPMENT CHECKLIST */}
            {activeSection === 'equipment' && (
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 4 }}>Equipment Checklist</div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>What to grab before this service</div>
                {equipment.length === 0 ? (
                  <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No checklist for this service type</div>
                ) : equipment.map((checklist, ci) => (
                  <div key={ci}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: D.teal, marginBottom: 8 }}>{checklist.service_type || checklist.serviceType}</div>
                    {(checklist.checklist_items || checklist.checklistItems || []).map((cat, cati) => (
                      <div key={cati} style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: D.amber, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{cat.category}</div>
                        {(cat.items || []).map((item, ii) => (
                          <div key={ii} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
                            <span style={{ fontSize: 14, color: item.required ? D.green : D.muted, flexShrink: 0 }}>{item.required ? '☐' : '○'}</span>
                            <div>
                              <div style={{ fontSize: 12, color: D.text }}>{item.item}</div>
                              {item.note && <div style={{ fontSize: 10, color: D.muted, marginTop: 1 }}>{item.note}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function RescheduleModal({ service, onClose, onRescheduled }) {
  const [options, setOptions] = useState([]);
  const [reason, setReason] = useState('customer_request');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualDate, setManualDate] = useState('');
  const [manualTime, setManualTime] = useState('08:00');

  useEffect(() => {
    adminFetch(`/admin/dispatch/${service.id}/reschedule-options`)
      .then(d => { setOptions(d.options || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [service.id]);

  const handleReschedule = async (opt) => {
    setSending(true);
    try {
      const result = await adminFetch(`/admin/dispatch/${service.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({ newDate: opt.date, newWindow: opt.suggestedWindow, reasonCode: reason, reasonText: notes, notifyCustomer: true }),
      });
      if (result?.notificationSent === false) {
        alert(`Appointment moved, but SMS notification failed: ${result.notificationError || 'customer was not notified'}`);
      }
      onRescheduled?.();
      onClose();
    } catch (e) { console.error(e); }
    setSending(false);
  };

  const handleManualReschedule = async () => {
    if (!manualDate) return;
    setSending(true);
    const [h, m] = manualTime.split(':');
    const endH = String(Math.min(23, parseInt(h) + 2)).padStart(2, '0');
    const window = { start: manualTime, end: `${endH}:${m}`, display: `${formatTimeDisplay(manualTime)} - ${formatTimeDisplay(`${endH}:${m}`)}` };
    try {
      const result = await adminFetch(`/admin/dispatch/${service.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({ newDate: manualDate, newWindow: window, reasonCode: reason, reasonText: notes, notifyCustomer: true }),
      });
      if (result?.notificationSent === false) {
        alert(`Appointment moved, but SMS notification failed: ${result.notificationError || 'customer was not notified'}`);
      }
      onRescheduled?.();
      onClose();
    } catch (e) { console.error(e); }
    setSending(false);
  };

  function formatTimeDisplay(t) {
    const [h, min] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(min).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }

  const REASONS = [
    { value: 'weather_rain', label: 'Weather — Rain' },
    { value: 'weather_wind', label: 'Weather — Wind' },
    { value: 'customer_request', label: 'Customer Request' },
    { value: 'customer_noshow', label: 'Customer No-Show' },
    { value: 'gate_locked', label: 'Gate Locked' },
    { value: 'tech_callout', label: 'Tech Unavailable' },
    { value: 'route_overload', label: 'Route Overload' },
  ];

  const inputSt = { width: '100%', padding: '10px 14px', borderRadius: 10, border: `1px solid ${D.border}`, background: D.input, color: D.heading, fontSize: 14, outline: 'none', boxSizing: 'border-box' };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: D.card, borderRadius: 16, padding: 24, maxWidth: 480, width: '100%', border: `1px solid ${D.border}`, maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, marginBottom: 4 }}>Reschedule Service</div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>{service.customerName} — {service.serviceType}</div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, marginBottom: 6 }}>Reason</div>
          <select value={reason} onChange={e => setReason(e.target.value)} style={inputSt}>
            {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, marginBottom: 6 }}>Notes (optional)</div>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Additional context..." style={inputSt} />
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: D.teal, marginBottom: 10 }}>Suggested Dates (on route)</div>
        {loading ? (
          <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>Finding best dates...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {options.map((opt, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 14px', borderRadius: 10, background: D.bg, border: `1px solid ${D.border}`,
                cursor: 'pointer', transition: 'border-color 0.15s',
              }}
                onMouseEnter={e => e.currentTarget.style.borderColor = D.teal}
                onMouseLeave={e => e.currentTarget.style.borderColor = D.border}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{opt.displayDate}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{opt.suggestedWindow?.display} · {opt.currentLoad} jobs · {opt.sameAreaServices} same area</div>
                </div>
                <button onClick={() => handleReschedule(opt)} disabled={sending} style={{
                  padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: D.teal, color: '#fff', fontSize: 12, fontWeight: 600,
                  opacity: sending ? 0.6 : 1,
                }}>Select</button>
              </div>
            ))}
          </div>
        )}

        {/* Manual date/time picker */}
        <div style={{ marginTop: 16, borderTop: `1px solid ${D.border}`, paddingTop: 14 }}>
          <button onClick={() => setShowManual(!showManual)} style={{
            background: 'transparent', border: 'none', color: D.teal, fontSize: 13, fontWeight: 600,
            cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {showManual ? '\u25BC' : '\u25B6'} Pick Custom Date & Time
          </button>
          {showManual && (
            <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Date</div>
                <input type="date" value={manualDate} onChange={e => setManualDate(e.target.value)} style={inputSt} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Start Time</div>
                <input type="time" value={manualTime} onChange={e => setManualTime(e.target.value)} style={inputSt} />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button onClick={handleManualReschedule} disabled={sending || !manualDate} style={{
                  padding: '10px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: manualDate ? D.teal : D.border, color: D.heading, fontSize: 13, fontWeight: 600,
                  opacity: sending ? 0.6 : 1, whiteSpace: 'nowrap',
                }}>Reschedule</button>
              </div>
            </div>
          )}
        </div>

        <button onClick={onClose} style={{
          width: '100%', marginTop: 14, padding: '10px 14px', borderRadius: 10,
          background: 'transparent', border: `1px solid ${D.border}`, color: D.muted,
          fontSize: 13, cursor: 'pointer',
        }}>Cancel</button>
      </div>
    </div>
  );
}

/* ── Completion Panel (slide-over) ────────────────────── */

// Module-scoped helpers for the mobile Complete sheet. Keeping these
// outside CompletionPanel is load-bearing: if they're defined inside the
// render, every keystroke creates new component identities and React
// unmounts/remounts the textarea, dropping focus after each word.
const CP_M = {
  card: '#FFFFFF', hairline: '#E5E5E5',
  ink: '#111111', ink4: '#A3A3A3', actionFg: '#FFFFFF',
};
const CP_FONT = "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif";
const CP_EYEBROW = {
  display: 'block', fontFamily: CP_FONT, fontSize: 11, fontWeight: 600,
  color: CP_M.ink4, textTransform: 'uppercase', letterSpacing: '0.3px',
  marginBottom: 8,
};

function CPField({ label, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <label style={CP_EYEBROW}>{label}</label>
      {children}
    </div>
  );
}

function CPChip({ selected, onClick, children, dot }) {
  return (
    <button type="button" onClick={onClick} style={{
      height: 36, padding: '0 14px', borderRadius: 999,
      background: selected ? CP_M.ink : CP_M.card,
      color: selected ? CP_M.actionFg : CP_M.ink,
      border: `1px solid ${selected ? CP_M.ink : CP_M.hairline}`,
      fontFamily: CP_FONT, fontSize: 13, fontWeight: 500,
      cursor: 'pointer', display: 'inline-flex',
      alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
    }}>
      {dot && <span style={{
        width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0,
      }}/>}
      {children}
    </button>
  );
}

function CPChipGroup({ label, dot, chips, onPick }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }}/>
        <span style={CP_EYEBROW}>{label}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {chips.map(c => (
          <CPChip key={c} onClick={() => onPick(c)}>{c}</CPChip>
        ))}
      </div>
    </div>
  );
}

export function CompletionPanel({ service, products, onClose, onSubmit }) {
  const [notes, setNotes] = useState('');
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [productSearch, setProductSearch] = useState('');
  const [soilTemp, setSoilTemp] = useState('');
  const [thatchMeasurement, setThatchMeasurement] = useState('');
  const [soilPh, setSoilPh] = useState('');
  const [soilMoisture, setSoilMoisture] = useState('');
  const [sendSms, setSendSms] = useState(true);
  const [requestReview, setRequestReview] = useState(true);
  const [visitOutcome, setVisitOutcome] = useState('completed');
  const [customerRecap, setCustomerRecap] = useState('');
  const [recapSource, setRecapSource] = useState('template');
  const [recapStaleAfterEdit, setRecapStaleAfterEdit] = useState(false);
  const [recapDraftStatus, setRecapDraftStatus] = useState('idle');
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapError, setRecapError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [success, setSuccess] = useState(false);
  const [completionResult, setCompletionResult] = useState(null);
  const [elapsed, setElapsed] = useState('0:00');
  const [quickComplete, setQuickComplete] = useState(false);
  const [servicePhotos, setServicePhotos] = useState([]);
  const [areasServiced, setAreasServiced] = useState([]);
  const [customerInteraction, setCustomerInteraction] = useState('');
  const [customerConcern, setCustomerConcern] = useState('');
  const [nextVisit, setNextVisit] = useState(null);
  const [nextVisitNote, setNextVisitNote] = useState('');
  const [showNextVisitNote, setShowNextVisitNote] = useState(false);
  const [equipmentSystemId, setEquipmentSystemId] = useState('');
  const [calibrationId, setCalibrationId] = useState('');
  const [equipmentCalibrations, setEquipmentCalibrations] = useState([]);
  const [equipmentCalibrationError, setEquipmentCalibrationError] = useState('');
  const [treatmentPlanBlocks, setTreatmentPlanBlocks] = useState([]);
  const [treatmentPlanAnnualN, setTreatmentPlanAnnualN] = useState(null);
  const [treatmentPlanError, setTreatmentPlanError] = useState('');
  const [officeApprovalReasonCode, setOfficeApprovalReasonCode] = useState('');
  const [officeApprovalNote, setOfficeApprovalNote] = useState('');
  const [nLimitApprovalReasonCode, setNLimitApprovalReasonCode] = useState('');
  const [nLimitApprovalNote, setNLimitApprovalNote] = useState('');
  const [managerApprovalReasonCode, setManagerApprovalReasonCode] = useState('');
  const [managerApprovalNote, setManagerApprovalNote] = useState('');
  const [treatmentPlanProductIds, setTreatmentPlanProductIds] = useState([]);
  const [treatmentPlanPlannedProductIds, setTreatmentPlanPlannedProductIds] = useState([]);
  const [tankLastProduct, setTankLastProduct] = useState('');
  const [tankLastProductCategory, setTankLastProductCategory] = useState('');
  const [tankCleanoutCompleted, setTankCleanoutCompleted] = useState('');
  const [tankCleanoutMethod, setTankCleanoutMethod] = useState('');
  const [tankCleanoutNote, setTankCleanoutNote] = useState('');
  const [savedDraft, setSavedDraft] = useState(null);
  const [showDraftPrompt, setShowDraftPrompt] = useState(false);
  const photoInputRef = useRef(null);
  const recapRequestRef = useRef(0);
  const recapAbortRef = useRef(null);
  const completionIdempotencyKeyRef = useRef(null);
  const draftReadyRef = useRef(false);

  const isLawn = detectServiceCategory(service.serviceType) === 'lawn';
  const calibrationRequired = isLawn && !!service.waveguardTier;
  const currentAdminUser = (() => {
    try { return JSON.parse(localStorage.getItem('waves_admin_user') || 'null'); } catch { return null; }
  })();
  const canApproveOfficeExceptions = currentAdminUser?.role === 'admin';
  const serviceCategory = detectServiceCategory(service.serviceType);
  const areaOptions = [
    ...(AREAS_BY_SERVICE[serviceCategory] || AREAS_BY_SERVICE.pest),
    ...AREAS_BY_SERVICE.universal,
  ];
  const onSiteEntry = (service.statusLog || []).find(e => e.status === 'on_site');
  const onSiteTime = onSiteEntry ? onSiteEntry.at : service.checkInTime;

  const svcTypeLower = (service.serviceType || '').toLowerCase();
  const isCallback = svcTypeLower.includes('re-service') || svcTypeLower.includes('callback') || service.isCallback;
  const invoiceAmount = service.estimatedPrice != null && Number(service.estimatedPrice) > 0
    ? Number(service.estimatedPrice)
    : Number(service.monthlyRate || 0);
  const prepaidCovered = service.prepaidAmount != null
    && Number(service.prepaidAmount) > 0
    && Number(service.prepaidAmount) >= invoiceAmount;
  const willInvoice = !prepaidCovered && (!!service.createInvoiceOnComplete || !!service.waveguardTier) && invoiceAmount > 0;
  const isIncompleteVisit = visitOutcome === 'incomplete';
  const reviewSuppressionReason = isIncompleteVisit
    ? 'incomplete'
    : visitOutcome === 'customer_declined'
      ? 'customer_declined'
      : (visitOutcome === 'customer_concern' || customerInteraction === 'concern')
        ? 'customer_concern'
        : willInvoice
          ? 'invoice_created'
          : null;
  const willReview = !!requestReview && !willInvoice && !reviewSuppressionReason;
  const smsPreview = [
    customerRecap.trim(),
    !isIncompleteVisit && willInvoice ? '[pay link inserted]' : '',
    willReview ? '[review link inserted]' : '',
  ].filter(Boolean).join('\n\n');
  const canAutoDraftRecap = !isIncompleteVisit
    && notes.trim().length >= 15
    && (selectedProducts.length > 0 || areasServiced.length > 0 || visitOutcome !== 'completed' || customerInteraction);
  const recapStatusText = recapLoading
    ? 'Drafting customer recap...'
    : recapError
      ? "Couldn't draft. Edit manually or send without SMS."
      : recapStaleAfterEdit
        ? 'Notes changed since this draft'
        : recapDraftStatus === 'manual'
          ? 'Edited by tech'
          : recapSource && recapSource !== 'template'
            ? `Draft: ${recapSource}`
            : '';
  const blackoutBlocks = treatmentPlanBlocks.filter(block =>
    block?.code === 'nitrogen_blackout' || block?.code === 'phosphorus_blackout'
  );
  const blackoutApprovalRequired = calibrationRequired && !isIncompleteVisit && blackoutBlocks.length > 0;
  const blackoutCompletionBlocked = blackoutApprovalRequired && (!canApproveOfficeExceptions || !officeApprovalReasonCode);
  const blackoutHelpText = treatmentPlanError
    || blackoutBlocks.map(block => block.message).filter(Boolean).join(' ')
    || 'Nitrogen or phosphorus fertilizer is restricted for this municipality window.';
  const annualNBlocks = treatmentPlanBlocks.filter(block => block?.code === 'annual_n_budget_exceeded');
  const nLimitApprovalRequired = calibrationRequired && !isIncompleteVisit && annualNBlocks.length > 0;
  const nLimitCompletionBlocked = nLimitApprovalRequired && (!canApproveOfficeExceptions || !nLimitApprovalReasonCode);
  const nLimitHelpText = treatmentPlanError
    || annualNBlocks.map(block => block.message).filter(Boolean).join(' ')
    || 'This visit would exceed the annual nitrogen budget.';
  const nLimitSummaryText = treatmentPlanAnnualN
    ? `Used ${treatmentPlanAnnualN.used ?? 0}, visit ${treatmentPlanAnnualN.visit ?? 0}, projected ${treatmentPlanAnnualN.projected ?? 0} / ${treatmentPlanAnnualN.limit ?? 0} ${treatmentPlanAnnualN.unit || 'lb N / 1,000 sqft / year'}.`
    : '';
  const offProtocolSelectedProducts = treatmentPlanProductIds.length
    ? selectedProducts.filter(p => !treatmentPlanProductIds.includes(String(p.productId)))
    : [];
  const selectedProductIds = new Set(selectedProducts.map(product => String(product.productId)));
  const conditionalProtocolSelectedProducts = treatmentPlanProductIds.length
    ? selectedProducts.filter(p => {
        const id = String(p.productId);
        return treatmentPlanProductIds.includes(id) && !treatmentPlanPlannedProductIds.includes(id);
      })
    : [];
  const highRateSelectedProducts = selectedProducts.filter(product => {
    const enteredRate = Number(product.rate);
    const maxRate = Number(product.maxLabelRatePer1000);
    return Number.isFinite(enteredRate)
      && Number.isFinite(maxRate)
      && maxRate > 0
      && enteredRate > maxRate
      && rateUnitsMatch(product.rateUnit, product.catalogRateUnit);
  });
  const labelUnitReviewProducts = selectedProducts.filter(product => {
    const enteredRate = Number(product.rate);
    const maxRate = Number(product.maxLabelRatePer1000);
    return Number.isFinite(enteredRate)
      && Number.isFinite(maxRate)
      && enteredRate > 0
      && maxRate > 0
      && !rateUnitsMatch(product.rateUnit, product.catalogRateUnit);
  });
  const managerPlanBlocks = treatmentPlanBlocks.filter(block => {
    if (!MANAGER_APPROVAL_CODES.has(block?.code)) return false;
    if (!block?.productId) return block?.code === 'st_augustine_dethatching';
    return selectedProductIds.has(String(block.productId));
  });
  const managerApprovalBlocks = [
    ...managerPlanBlocks,
    ...offProtocolSelectedProducts.map(product => ({
      code: 'off_protocol_product',
      message: `${product.name || 'Selected product'} is not part of the current WaveGuard protocol card.`,
    })),
    ...conditionalProtocolSelectedProducts.map(product => ({
      code: 'conditional_protocol_product_review',
      message: `${product.name || 'Selected product'} is conditional on the WaveGuard protocol card and was not in the generated mix; manager review is required before applying it.`,
    })),
    ...highRateSelectedProducts.map(product => ({
      code: 'high_rate_application',
      message: `${product.name || 'Selected product'} rate ${product.rate} ${product.rateUnit || ''}/1k exceeds label max ${product.maxLabelRatePer1000} ${product.catalogRateUnit || ''}/1k.`,
    })),
    ...labelUnitReviewProducts.map(product => ({
      code: 'label_rate_unit_review',
      message: `${product.name || 'Selected product'} rate unit ${product.rateUnit || 'unknown'} does not match label unit ${product.catalogRateUnit || 'unknown'}; manager review is required before applying it.`,
    })),
  ];
  const managerApprovalRequired = calibrationRequired && !isIncompleteVisit && managerApprovalBlocks.length > 0;
  const managerApprovalCompletionBlocked = managerApprovalRequired && (!canApproveOfficeExceptions || !managerApprovalReasonCode);
  const managerApprovalHelpText = managerApprovalBlocks.map(block => block.message).filter(Boolean).join(' ');
  const tankCleanoutRequired = calibrationRequired && !isIncompleteVisit && !!equipmentSystemId;
  const tankCleanoutCompletionBlocked = tankCleanoutRequired
    && (!tankLastProduct.trim() || tankCleanoutCompleted !== 'yes' || !tankCleanoutMethod.trim());
  const tankCleanoutHelpText = 'Record the prior tank product and confirm cleanout before completing this WaveGuard lawn visit.';
  const completionCtaLabel = submitting
    ? 'Completing...'
    : calibrationRequired && !isIncompleteVisit && !equipmentSystemId
      ? 'Select Equipment Calibration'
    : tankCleanoutCompletionBlocked
      ? 'Tank Cleanout Required'
    : blackoutCompletionBlocked
      ? canApproveOfficeExceptions ? 'Office Approval Required' : 'Admin Approval Required'
    : nLimitCompletionBlocked
      ? canApproveOfficeExceptions ? 'N Approval Required' : 'Admin Approval Required'
    : managerApprovalCompletionBlocked
      ? canApproveOfficeExceptions ? 'Manager Approval Required' : 'Admin Approval Required'
    : isIncompleteVisit
      ? 'Mark Visit Incomplete'
      : !sendSms
        ? 'Complete Service'
        : willInvoice
          ? 'Complete & Send Invoice'
          : 'Complete & Send Recap';

  useEffect(() => {
    const iv = setInterval(() => setElapsed(elapsedSince(onSiteTime)), 1000);
    return () => clearInterval(iv);
  }, [onSiteTime]);

  useEffect(() => {
    if (service.customerId) {
      adminFetch(`/admin/schedule/next-visit?customerId=${service.customerId}`)
        .then(d => { if (d.nextVisit) setNextVisit(d.nextVisit); })
        .catch(() => {});
    }
  }, [service.customerId]);

  useEffect(() => {
    if (!calibrationRequired) return;
    let cancelled = false;
    setEquipmentCalibrationError('');
    adminFetch('/admin/equipment-systems/calibrations')
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data.calibrations) ? data.calibrations : [];
        setEquipmentCalibrations(rows);
        if (!equipmentSystemId && rows.length === 1) {
          setEquipmentSystemId(rows[0].equipment_system_id || '');
          setCalibrationId(rows[0].id || '');
        }
      })
      .catch((err) => {
        if (!cancelled) setEquipmentCalibrationError(err.message || 'Could not load equipment calibrations');
      });
    return () => { cancelled = true; };
  }, [calibrationRequired]);

  useEffect(() => {
    if (!calibrationRequired) return;
    let cancelled = false;
    setTreatmentPlanError('');
    const params = new URLSearchParams();
    if (equipmentSystemId) params.set('equipmentSystemId', equipmentSystemId);
    if (calibrationId) params.set('calibrationId', calibrationId);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    adminFetch(`/admin/treatment-plans/${service.id}${suffix}`)
      .then((data) => {
        if (cancelled) return;
        const blocks = data?.plan?.propertyGate?.blocks || data?.plan?.protocol?.blocked || [];
        setTreatmentPlanBlocks(Array.isArray(blocks) ? blocks : []);
        setTreatmentPlanAnnualN(data?.plan?.propertyGate?.annualN || null);
        const baseItems = data?.plan?.protocol?.base || [];
        const conditionalItems = data?.plan?.protocol?.conditional || [];
        const mixItems = data?.plan?.mixCalculator?.items || [];
        const productIdsFor = (items) => items.map(item => item?.product?.id || item?.productId).filter(Boolean).map(String);
        setTreatmentPlanProductIds([...new Set(productIdsFor([...baseItems, ...conditionalItems, ...mixItems]))]);
        setTreatmentPlanPlannedProductIds([...new Set(productIdsFor([...baseItems, ...mixItems]))]);
      })
      .catch((err) => {
        if (!cancelled) setTreatmentPlanError(err.message || 'Could not load WaveGuard plan');
      });
    return () => { cancelled = true; };
  }, [calibrationRequired, service.id, equipmentSystemId, calibrationId]);

  useEffect(() => {
    draftReadyRef.current = false;
    setSavedDraft(null);
    setShowDraftPrompt(false);
    try {
      const raw = localStorage.getItem(completionDraftKey(service.id));
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft && draft.serviceId === service.id) {
          setSavedDraft(draft);
          setShowDraftPrompt(true);
        }
      }
    } catch {
      localStorage.removeItem(completionDraftKey(service.id));
    } finally {
      draftReadyRef.current = true;
    }
  }, [service.id]);

  useEffect(() => {
    if (!draftReadyRef.current || showDraftPrompt || success) return;
    const hasDraftContent = notes.trim()
      || customerRecap.trim()
      || selectedProducts.length
      || areasServiced.length
      || customerInteraction
      || customerConcern.trim()
      || nextVisitNote.trim()
      || tankLastProduct.trim()
      || tankCleanoutCompleted
      || tankCleanoutMethod.trim()
      || tankCleanoutNote.trim()
      || visitOutcome !== 'completed';
    if (!hasDraftContent) return;

    const timer = setTimeout(() => {
      const draft = {
        serviceId: service.id,
        savedAt: new Date().toISOString(),
        notes,
        selectedProducts,
        soilTemp,
        thatchMeasurement,
        soilPh,
        soilMoisture,
        sendSms,
        requestReview,
        visitOutcome,
        customerRecap,
        recapSource,
        areasServiced,
        customerInteraction,
        customerConcern,
        nextVisitNote,
        showNextVisitNote,
        equipmentSystemId,
        calibrationId,
        officeApprovalReasonCode,
        officeApprovalNote,
        nLimitApprovalReasonCode,
        nLimitApprovalNote,
        managerApprovalReasonCode,
        managerApprovalNote,
        tankLastProduct,
        tankLastProductCategory,
        tankCleanoutCompleted,
        tankCleanoutMethod,
        tankCleanoutNote,
      };
      localStorage.setItem(completionDraftKey(service.id), JSON.stringify(draft));
    }, 700);
    return () => clearTimeout(timer);
  }, [
    service.id, showDraftPrompt, success, notes, selectedProducts, soilTemp, thatchMeasurement,
    soilPh, soilMoisture, sendSms, requestReview, visitOutcome, customerRecap, recapSource,
    areasServiced, customerInteraction, customerConcern, nextVisitNote, showNextVisitNote,
    equipmentSystemId, calibrationId,
    officeApprovalReasonCode, officeApprovalNote,
    nLimitApprovalReasonCode, nLimitApprovalNote,
    managerApprovalReasonCode, managerApprovalNote,
    tankLastProduct, tankLastProductCategory, tankCleanoutCompleted, tankCleanoutMethod, tankCleanoutNote,
  ]);

  function restoreDraft() {
    if (!savedDraft) return;
    setNotes(savedDraft.notes || '');
    setSelectedProducts(Array.isArray(savedDraft.selectedProducts) ? savedDraft.selectedProducts : []);
    setSoilTemp(savedDraft.soilTemp || '');
    setThatchMeasurement(savedDraft.thatchMeasurement || '');
    setSoilPh(savedDraft.soilPh || '');
    setSoilMoisture(savedDraft.soilMoisture || '');
    setSendSms(savedDraft.sendSms !== false);
    setRequestReview(savedDraft.requestReview !== false);
    setVisitOutcome(savedDraft.visitOutcome || 'completed');
    setCustomerRecap(savedDraft.customerRecap || '');
    setRecapSource(savedDraft.recapSource || 'draft');
    setRecapDraftStatus(savedDraft.recapSource === 'manual' ? 'manual' : 'ready');
    setRecapStaleAfterEdit(false);
    setAreasServiced(Array.isArray(savedDraft.areasServiced) ? savedDraft.areasServiced : []);
    setCustomerInteraction(savedDraft.customerInteraction || '');
    setCustomerConcern(savedDraft.customerConcern || '');
    setNextVisitNote(savedDraft.nextVisitNote || '');
    setShowNextVisitNote(!!savedDraft.showNextVisitNote);
    setEquipmentSystemId(savedDraft.equipmentSystemId || '');
    setCalibrationId(savedDraft.calibrationId || '');
    setOfficeApprovalReasonCode(savedDraft.officeApprovalReasonCode || '');
    setOfficeApprovalNote(savedDraft.officeApprovalNote || '');
    setNLimitApprovalReasonCode(savedDraft.nLimitApprovalReasonCode || '');
    setNLimitApprovalNote(savedDraft.nLimitApprovalNote || '');
    setManagerApprovalReasonCode(savedDraft.managerApprovalReasonCode || '');
    setManagerApprovalNote(savedDraft.managerApprovalNote || '');
    setTankLastProduct(savedDraft.tankLastProduct || '');
    setTankLastProductCategory(savedDraft.tankLastProductCategory || '');
    setTankCleanoutCompleted(savedDraft.tankCleanoutCompleted || '');
    setTankCleanoutMethod(savedDraft.tankCleanoutMethod || '');
    setTankCleanoutNote(savedDraft.tankCleanoutNote || '');
    setShowDraftPrompt(false);
  }

  function discardDraft() {
    localStorage.removeItem(completionDraftKey(service.id));
    setSavedDraft(null);
    setShowDraftPrompt(false);
  }

  useEffect(() => {
    if (!canAutoDraftRecap) return;
    if (recapSource === 'manual') {
      if (customerRecap.trim()) setRecapStaleAfterEdit(true);
      return;
    }
    const requestId = ++recapRequestRef.current;
    if (recapAbortRef.current) recapAbortRef.current.abort();
    const controller = new AbortController();
    recapAbortRef.current = controller;
    setRecapError('');
    const timer = setTimeout(async () => {
      try {
        setRecapLoading(true);
        setRecapDraftStatus('drafting');
        const result = await adminFetch('/admin/dispatch/recap-preview', {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            notes,
            visitOutcome,
            serviceType: service.serviceType,
            areasTreated: areasServiced,
            willInvoice,
            willReview,
          }),
        });
        if (requestId !== recapRequestRef.current) return;
        if (result.recap) {
          setCustomerRecap(result.recap);
          setRecapSource(result.source || '');
          setRecapDraftStatus('ready');
          setRecapStaleAfterEdit(false);
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (requestId !== recapRequestRef.current) return;
        setRecapError(err.message || 'Could not draft recap');
        setRecapDraftStatus('failed');
      } finally {
        if (requestId === recapRequestRef.current) setRecapLoading(false);
      }
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [canAutoDraftRecap, notes, selectedProducts.length, visitOutcome, areasServiced, service.serviceType, customerInteraction, willInvoice, willReview]);

  function handleCustomerRecapChange(value) {
    recapRequestRef.current += 1;
    if (recapAbortRef.current) recapAbortRef.current.abort();
    setRecapLoading(false);
    setCustomerRecap(value);
    setRecapSource('manual');
    setRecapDraftStatus('manual');
    setRecapStaleAfterEdit(false);
  }

  async function regenerateCustomerRecap() {
    const requestId = ++recapRequestRef.current;
    if (recapAbortRef.current) recapAbortRef.current.abort();
    const controller = new AbortController();
    recapAbortRef.current = controller;
    setRecapLoading(true);
    setRecapDraftStatus('drafting');
    setRecapError('');
    try {
      const result = await adminFetch('/admin/dispatch/recap-preview', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          notes,
          visitOutcome,
          serviceType: service.serviceType,
          areasTreated: areasServiced,
          willInvoice,
          willReview,
          force: true,
        }),
      });
      if (requestId !== recapRequestRef.current) return;
      if (result.recap) {
        setCustomerRecap(result.recap);
        setRecapSource(result.source || 'ai');
        setRecapDraftStatus('ready');
        setRecapStaleAfterEdit(false);
      }
    } catch (err) {
      if (requestId !== recapRequestRef.current) return;
      if (err?.name !== 'AbortError') {
        setRecapError(err.message || 'Could not draft recap');
        setRecapDraftStatus('failed');
      }
    } finally {
      if (requestId === recapRequestRef.current) setRecapLoading(false);
    }
  }

  function addChipNote(prefix, text) {
    const line = `[${prefix}] ${text}`;
    setNotes(prev => prev.trim() ? prev.trimEnd() + '\n' + line : line);
  }
  function addProduct(product) {
    if (selectedProducts.find(p => p.productId === product.id)) return;
    const defaultUnit = product.defaultUnit || product.default_unit || product.rateUnit || product.rate_unit || 'oz';
    setSelectedProducts(prev => [...prev, {
      productId: product.id,
      name: product.name,
      rate: '',
      rateUnit: defaultUnit,
      catalogRateUnit: product.rateUnit || product.rate_unit || defaultUnit,
      maxLabelRatePer1000: product.maxLabelRatePer1000 ?? product.max_label_rate_per_1000 ?? null,
      totalAmount: '',
      amountUnit: defaultUnit,
    }]);
    setProductSearch('');
  }
  function removeProduct(productId) {
    setSelectedProducts(prev => prev.filter(p => p.productId !== productId));
  }
  function updateProduct(productId, field, value) {
    setSelectedProducts(prev => prev.map(p => p.productId === productId ? { ...p, [field]: value } : p));
  }
  function toggleArea(area) {
    setAreasServiced(prev => prev.includes(area) ? prev.filter(a => a !== area) : [...prev, area]);
  }
  function handleEquipmentSelect(value) {
    setEquipmentSystemId(value);
    const selected = equipmentCalibrations.find(c => c.equipment_system_id === value);
    setCalibrationId(selected?.id || '');
  }
  function handlePhotoSelect(e) {
    const files = Array.from(e.target.files || []);
    if (servicePhotos.length + files.length > 5) {
      alert('Maximum 5 photos allowed.');
      return;
    }
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        setServicePhotos(prev => {
          if (prev.length >= 5) return prev;
          return [...prev, { data: reader.result, name: file.name }];
        });
      };
      reader.readAsDataURL(file);
    });
    if (photoInputRef.current) photoInputRef.current.value = '';
  }
  function removePhoto(index) {
    setServicePhotos(prev => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (calibrationCompletionBlocked) {
      alert(calibrationHelpText || 'Select calibrated equipment before completing this WaveGuard lawn visit.');
      return;
    }
    if (tankCleanoutCompletionBlocked) {
      alert(tankCleanoutHelpText);
      return;
    }
    if (blackoutCompletionBlocked) {
      alert(canApproveOfficeExceptions
        ? 'Office approval is required before completing this WaveGuard lawn visit during an N/P blackout.'
        : 'Admin approval is required before completing this WaveGuard lawn visit during an N/P blackout.');
      return;
    }
    if (nLimitCompletionBlocked) {
      alert('Admin approval is required before completing this WaveGuard lawn visit over the annual N budget.');
      return;
    }
    if (managerApprovalCompletionBlocked) {
      alert(canApproveOfficeExceptions
        ? 'Manager approval is required before completing this WaveGuard protocol exception.'
        : 'An admin must approve this WaveGuard protocol exception before completion.');
      return;
    }
    setSubmitting(true);
    try {
      if (!completionIdempotencyKeyRef.current) {
        completionIdempotencyKeyRef.current = createCompletionIdempotencyKey(service.id);
      }
      const body = {
        idempotencyKey: completionIdempotencyKeyRef.current,
        technicianNotes: notes,
        customerRecap,
        visitOutcome,
        reviewSuppression: reviewSuppressionReason,
        equipmentSystemId: equipmentSystemId || null,
        calibrationId: calibrationId || null,
        officeApproval: blackoutApprovalRequired && canApproveOfficeExceptions
          ? {
              reasonCode: officeApprovalReasonCode,
              note: officeApprovalNote,
            }
          : null,
        nLimitApproval: nLimitApprovalRequired && canApproveOfficeExceptions
          ? {
              reasonCode: nLimitApprovalReasonCode,
              note: nLimitApprovalNote,
            }
          : null,
        managerApproval: managerApprovalRequired && canApproveOfficeExceptions
          ? {
              reasonCode: managerApprovalReasonCode,
              note: managerApprovalNote,
            }
          : null,
        tankCleanout: tankCleanoutRequired
          ? {
              lastProductInTank: tankLastProduct,
              lastProductCategory: tankLastProductCategory,
              cleanoutCompleted: tankCleanoutCompleted === 'yes',
              cleanoutMethod: tankCleanoutMethod,
              note: tankCleanoutNote,
            }
          : null,
        products: selectedProducts.map(p => ({
          productId: p.productId,
          rate: p.rate,
          rateUnit: p.rateUnit,
          totalAmount: p.totalAmount,
          amountUnit: p.amountUnit,
        })),
        sendCompletionSms: isIncompleteVisit ? false : sendSms,
        requestReview: willReview,
        areasTreated: areasServiced,
        timeOnSite: elapsed,
        areasServiced,
        customerInteraction,
      };
      if (customerInteraction === 'concern' && customerConcern) {
        body.customerConcernText = customerConcern;
      }
      // Photos captured but not sent in JSON body — server doesn't process them yet
      // TODO: upload photos to S3 separately when backend photo support is added
      if (nextVisitNote) {
        body.nextVisitAdjustmentNote = nextVisitNote;
      }
      if (isLawn) {
        if (soilTemp) body.soilTemp = parseFloat(soilTemp);
        if (thatchMeasurement) body.thatchMeasurement = parseFloat(thatchMeasurement);
        if (soilPh) body.soilPh = parseFloat(soilPh);
        if (soilMoisture) body.soilMoisture = parseFloat(soilMoisture);
      }
      if (service?.completionInvoiceAlreadySent) {
        body.invoiceAlreadySent = true;
      }
      const result = await onSubmit(service.id, body);
      localStorage.removeItem(completionDraftKey(service.id));
      setCompletionResult(result || null);
      setSuccess(true);
      const smsNeedsAttention = ['blocked', 'failed'].includes(result?.completionSmsStatus);
      setTimeout(() => onClose(true), smsNeedsAttention ? 3200 : 1200);
    } catch (e) {
      if (e?.status >= 400 && e.status < 500 && e.status !== 409) {
        completionIdempotencyKeyRef.current = null;
      }
      alert('Failed to complete service: ' + e.message);
    }
    setSubmitting(false);
  }

  const filteredProducts = (products || []).filter(p =>
    p.name.toLowerCase().includes(productSearch.toLowerCase())
  );
  const selectedCalibration = equipmentCalibrations.find(c => c.equipment_system_id === equipmentSystemId) || null;
  const selectedCalibrationExpired = !!selectedCalibration?.expires_at
    && new Date(selectedCalibration.expires_at).getTime() < Date.now();
  const calibrationCompletionBlocked = calibrationRequired
    && !isIncompleteVisit
    && (!equipmentSystemId || selectedCalibrationExpired);
  const calibrationHelpText = equipmentCalibrationError
    || (selectedCalibrationExpired
      ? 'Selected calibration is expired. Record a new calibration before completing this visit.'
      : calibrationRequired
        ? 'WaveGuard lawn visits require current calibrated spray equipment before completion.'
        : '');
  const chipGroupStyle = { marginBottom: 8 };
  const chipLabelStyle = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4, display: 'block' };

  // ────────────────────────────────────────────────────────────────────
  // Mobile admin render — follows reference_waves_admin_ui_system.md
  // Light mode only. DM Sans (body) + JetBrains Mono (numerics). No D.palette.
  // ────────────────────────────────────────────────────────────────────
  if (isMobile) {
    const M = {
      page: '#FAFAFA', card: '#FFFFFF', pressed: '#F5F5F5', muted: '#F5F5F5',
      hairline: '#E5E5E5', subtle: '#EEEEEE',
      ink: '#111111', ink2: '#333333', ink3: '#737373', ink4: '#A3A3A3',
      success: '#16A34A', warn: '#EA580C', err: '#C2410C', info: '#2563EB',
      actionBg: '#111111', actionBgActive: '#000000', actionFg: '#FFFFFF',
      destructive: '#C2410C',
    };
    const font = "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif";
    const mono = "'JetBrains Mono', ui-monospace, Menlo, monospace";

    const eyebrowStyle = {
      display: 'block', fontFamily: font, fontSize: 11, fontWeight: 600,
      color: M.ink4, textTransform: 'uppercase', letterSpacing: '0.3px',
      marginBottom: 8,
    };
    const mInput = {
      width: '100%', boxSizing: 'border-box', height: 48, padding: '0 16px',
      background: M.card, color: M.ink, border: `1px solid ${M.hairline}`,
      borderRadius: 12, fontFamily: font, fontSize: 16, fontWeight: 400,
      lineHeight: 1.5, outline: 'none', WebkitAppearance: 'none',
    };
    const mTextarea = {
      ...mInput, height: 'auto', padding: 14, resize: 'vertical',
    };
    const primaryPill = {
      width: '100%', height: 48, border: 'none', borderRadius: 999,
      background: M.actionBg, color: M.actionFg,
      fontFamily: font, fontSize: 14, fontWeight: 600,
      textTransform: 'uppercase', letterSpacing: '0.3px',
      cursor: 'pointer', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center', gap: 8,
    };
    const secondaryPill = {
      ...primaryPill, background: 'transparent', color: M.ink,
      border: `1px solid ${M.ink}`,
    };
    const tertiaryPill = {
      ...primaryPill, background: 'transparent', color: M.ink,
      height: 44,
    };

    // Field / Chip / ChipGroup are hoisted above CompletionPanel (CPField,
    // CPChip, CPChipGroup) so they survive re-renders without unmounting
    // the inputs inside them.
    const Field = CPField;
    const Chip = CPChip;
    const ChipGroup = CPChipGroup;

    return (
      <>
        <div
          role="presentation"
          onClick={() => onClose(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999 }}
        />
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: M.page, color: M.ink, fontFamily: font,
          overflowY: 'auto', WebkitOverflowScrolling: 'touch',
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'calc(160px + env(safe-area-inset-bottom))',
          animation: 'slideIn 0.25s ease',
        }}>
          {success && (
            <div style={{
              position: 'absolute', inset: 0, background: 'rgba(250,250,250,0.96)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 10, flexDirection: 'column', padding: 24,
            }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%', background: M.success,
                color: '#fff', display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 32, marginBottom: 16,
              }}>✓</div>
              <div style={{ fontFamily: font, fontSize: 20, fontWeight: 600, color: M.ink }}>
                Service completed
              </div>
              <div style={{ fontFamily: font, fontSize: 13, color: M.ink3, marginTop: 6, textAlign: 'center' }}>
                {completionResult?.completionSmsStatus === 'sent'
                  ? 'SMS + report sent'
                  : completionResult?.completionSmsStatus === 'blocked'
                    ? `Report saved. SMS blocked${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ''}`
                    : completionResult?.completionSmsStatus === 'failed'
                      ? `Report saved. SMS failed${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ''}`
                      : sendSms
                        ? 'Report saved'
                        : 'Report saved'} for {service.customerName}
              </div>
            </div>
          )}

          {/* Sticky top bar — Square pattern: ← · centered title · ⋯ */}
          <div style={{
            position: 'sticky', top: 0, zIndex: 2, background: M.page,
            padding: '12px 12px', display: 'flex', alignItems: 'center', gap: 8,
            height: 64, boxSizing: 'border-box',
          }}>
            <button
              type="button"
              onClick={() => onClose(false)}
              aria-label="Back"
              style={{
                width: 36, height: 36, minWidth: 36, borderRadius: '50%',
                background: M.muted, border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, fontSize: 20, lineHeight: 1, color: M.ink,
              }}
            >←</button>
            <div style={{ flex: 1, minWidth: 0, textAlign: 'center', padding: '0 8px', lineHeight: 1.2 }}>
              <div style={{ fontFamily: font, fontSize: 17, fontWeight: 600, color: M.ink,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Complete service
              </div>
              <div style={{ fontFamily: font, fontSize: 13, fontWeight: 400, color: M.ink3,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                {service.customerName}
              </div>
            </div>
            <div style={{ width: 36, height: 36 }} aria-hidden />
          </div>

          <div style={{ padding: 20, maxWidth: 560, margin: '0 auto' }}>
            {showDraftPrompt && (
              <div style={{
                background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 14,
                padding: 14, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ fontFamily: font, fontSize: 14, fontWeight: 600, color: M.ink }}>
                  Restore saved draft?
                </div>
                <div style={{ fontFamily: font, fontSize: 12, color: M.ink3 }}>
                  Saved {savedDraft?.savedAt ? new Date(savedDraft.savedAt).toLocaleString() : 'recently'}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={restoreDraft} style={{ ...primaryPill, height: 40, fontSize: 12 }}>
                    Restore
                  </button>
                  <button type="button" onClick={discardDraft} style={{ ...secondaryPill, height: 40, fontSize: 12 }}>
                    Discard
                  </button>
                </div>
              </div>
            )}

            {/* Service meta */}
            <div style={{ fontFamily: font, fontSize: 13, color: M.ink3, marginBottom: 20, lineHeight: 1.4 }}>
              {service.serviceType}
              {service.address ? <><br/>{service.address}</> : null}
            </div>

            {/* Time on-site */}
            {onSiteTime && (
              <div style={{
                background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 16,
                padding: 16, marginBottom: 20,
              }}>
                <div style={eyebrowStyle}>Time on-site</div>
                <div style={{
                  fontFamily: mono, fontSize: 28, fontWeight: 700, color: M.ink,
                  fontVariantNumeric: 'tabular-nums', lineHeight: 1.15,
                }}>{elapsed}</div>
              </div>
            )}

            {/* Quick complete */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
              <button type="button" onClick={() => setQuickComplete(!quickComplete)} style={{
                height: 36, padding: '0 16px', borderRadius: 999,
                background: quickComplete ? M.ink : 'transparent',
                color: quickComplete ? M.actionFg : M.ink,
                border: quickComplete ? 'none' : `1px solid ${M.ink}`,
                fontFamily: font, fontSize: 12, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.3px', cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}>
                Quick complete {quickComplete ? 'on' : 'off'}
              </button>
            </div>

            {/* Callback banner */}
            {isCallback && (
              <div style={{
                background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                padding: '12px 16px', marginBottom: 20,
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: M.success,
                  marginTop: 7, flexShrink: 0,
                }}/>
                <div style={{ fontFamily: font, fontSize: 13, color: M.ink, lineHeight: 1.4 }}>
                  Callback visit — will be noted as included with WaveGuard membership on the customer's report.
                </div>
              </div>
            )}

            {calibrationRequired && (
              <Field label="Equipment calibration">
                <select
                  value={equipmentSystemId}
                  onChange={e => handleEquipmentSelect(e.target.value)}
                  disabled={isIncompleteVisit}
                  style={mInput}
                >
                  <option value="">Select calibrated equipment</option>
                  {equipmentCalibrations.map(c => (
                    <option key={c.id} value={c.equipment_system_id}>
                      {c.system_name || 'Equipment'} · {c.carrier_gal_per_1000 || '—'} gal/1K
                    </option>
                  ))}
                </select>
                <div style={{
                  marginTop: 8, fontFamily: font, fontSize: 12,
                  color: selectedCalibrationExpired || equipmentCalibrationError ? M.err : M.ink3,
                  lineHeight: 1.35,
                }}>
                  {isIncompleteVisit ? 'Calibration is not required when marking a visit incomplete.' : calibrationHelpText}
                </div>
              </Field>
            )}

            {tankCleanoutRequired && (
              <Field label="Tank cleanout">
                <div style={{
                  marginBottom: 10, fontFamily: font, fontSize: 12,
                  color: tankCleanoutCompletionBlocked ? M.err : M.ink3, lineHeight: 1.35,
                }}>
                  {tankCleanoutHelpText}
                </div>
                <input
                  value={tankLastProduct}
                  onChange={e => setTankLastProduct(e.target.value)}
                  placeholder="Last product in tank"
                  style={mInput}
                />
                <select
                  value={tankLastProductCategory}
                  onChange={e => setTankLastProductCategory(e.target.value)}
                  style={{ ...mInput, marginTop: 8 }}
                >
                  <option value="">Prior product type</option>
                  <option value="herbicide">Herbicide / weed control</option>
                  <option value="insecticide">Insecticide</option>
                  <option value="fungicide">Fungicide</option>
                  <option value="fertilizer">Fertilizer / nutrient</option>
                  <option value="water_only">Water only</option>
                  <option value="unknown">Unknown</option>
                </select>
                <select
                  value={tankCleanoutCompleted}
                  onChange={e => setTankCleanoutCompleted(e.target.value)}
                  style={{ ...mInput, marginTop: 8 }}
                >
                  <option value="">Cleanout completed?</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
                <select
                  value={tankCleanoutMethod}
                  onChange={e => setTankCleanoutMethod(e.target.value)}
                  style={{ ...mInput, marginTop: 8 }}
                >
                  <option value="">Cleanout method</option>
                  {TANK_CLEANOUT_METHODS.map(method => (
                    <option key={method} value={method}>{method}</option>
                  ))}
                </select>
                <textarea
                  value={tankCleanoutNote}
                  onChange={e => setTankCleanoutNote(e.target.value)}
                  rows={2}
                  placeholder="Cleanout note"
                  style={{ ...mTextarea, minHeight: 72, marginTop: 8 }}
                />
              </Field>
            )}

            {blackoutApprovalRequired && (
              <Field label="Office approval">
                <div style={{
                  marginBottom: 10, fontFamily: font, fontSize: 12,
                  color: M.err, lineHeight: 1.35,
                }}>
                  {blackoutHelpText} {!canApproveOfficeExceptions ? 'An admin must approve this exception before completion.' : ''}
                </div>
                {canApproveOfficeExceptions && (
                  <>
                    <select
                      value={officeApprovalReasonCode}
                      onChange={e => setOfficeApprovalReasonCode(e.target.value)}
                      style={mInput}
                    >
                      <option value="">Select approval reason</option>
                      {OFFICE_APPROVAL_REASONS.map(reason => (
                        <option key={reason.value} value={reason.value}>{reason.label}</option>
                      ))}
                    </select>
                    <textarea
                      value={officeApprovalNote}
                      onChange={e => setOfficeApprovalNote(e.target.value)}
                      rows={2}
                      placeholder="Approval note"
                      style={{ ...mTextarea, minHeight: 72, marginTop: 8 }}
                    />
                  </>
                )}
              </Field>
            )}

            {nLimitApprovalRequired && (
              <Field label="Annual N budget">
                <div style={{
                  marginBottom: 10, fontFamily: font, fontSize: 12,
                  color: M.err, lineHeight: 1.35,
                }}>
                  {nLimitHelpText} {nLimitSummaryText} {!canApproveOfficeExceptions ? 'An admin must approve this exception before completion.' : ''}
                </div>
                {canApproveOfficeExceptions && (
                  <>
                    <select
                      value={nLimitApprovalReasonCode}
                      onChange={e => setNLimitApprovalReasonCode(e.target.value)}
                      style={mInput}
                    >
                      <option value="">Select approval reason</option>
                      {N_LIMIT_APPROVAL_REASONS.map(reason => (
                        <option key={reason.value} value={reason.value}>{reason.label}</option>
                      ))}
                    </select>
                    <textarea
                      value={nLimitApprovalNote}
                      onChange={e => setNLimitApprovalNote(e.target.value)}
                      rows={2}
                      placeholder="Approval note"
                      style={{ ...mTextarea, minHeight: 72, marginTop: 8 }}
                    />
                  </>
                )}
              </Field>
            )}

            {managerApprovalRequired && (
              <Field label="Manager approval">
                <div style={{
                  marginBottom: 10, fontFamily: font, fontSize: 12,
                  color: M.err, lineHeight: 1.35,
                }}>
                  {managerApprovalHelpText} {!canApproveOfficeExceptions ? 'An admin must approve this exception before completion.' : ''}
                </div>
                {canApproveOfficeExceptions && (
                  <>
                    <select
                      value={managerApprovalReasonCode}
                      onChange={e => setManagerApprovalReasonCode(e.target.value)}
                      style={mInput}
                    >
                      <option value="">Select approval reason</option>
                      {MANAGER_APPROVAL_REASONS.map(reason => (
                        <option key={reason.value} value={reason.value}>{reason.label}</option>
                      ))}
                    </select>
                    <textarea
                      value={managerApprovalNote}
                      onChange={e => setManagerApprovalNote(e.target.value)}
                      rows={2}
                      placeholder="Approval note"
                      style={{ ...mTextarea, minHeight: 72, marginTop: 8 }}
                    />
                  </>
                )}
              </Field>
            )}

            {/* Technician notes */}
            <Field label="Visit outcome">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {VISIT_OUTCOME_OPTIONS.map(opt => (
                  <Chip
                    key={opt.value}
                    selected={visitOutcome === opt.value}
                    onClick={() => setVisitOutcome(opt.value)}
                  >
                    {visitOutcome === opt.value ? '✓ ' : ''}{opt.label}
                  </Chip>
                ))}
              </div>
            </Field>

            <Field label="Technician notes">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={quickComplete ? 3 : 5}
                placeholder="What did you do on this visit?"
                style={{ ...mTextarea, minHeight: quickComplete ? 90 : 140 }}
              />
            </Field>

            {/* Chip groups */}
            <div style={{ marginBottom: 8 }}>
              <ChipGroup label="Actions" dot={M.info}
                         chips={CHIP_ACTIONS} onPick={c => addChipNote('Action', c)} />
              <ChipGroup label="Observations" dot={M.warn}
                         chips={CHIP_OBSERVATIONS} onPick={c => addChipNote('Found', c)} />
              <ChipGroup label="Recommendations" dot={M.success}
                         chips={CHIP_RECOMMENDATIONS} onPick={c => addChipNote('Next', c)} />
            </div>

            {/* AI report */}
            {!quickComplete && (
              <button
                type="button"
                onClick={async () => {
                  if (!notes.trim()) { alert('Add service notes first.'); return; }
                  setGenerating(true);
                  try {
                    const productNames = selectedProducts.map(p => p.name + (p.rate ? ` (${p.rate} ${p.rateUnit})` : '')).join(', ');
                    const r = await adminFetch('/admin/schedule/generate-report', {
                      method: 'POST',
                      body: JSON.stringify({
                        customerName: service.customerName,
                        serviceType: service.serviceType,
                        technicianName: service.technicianName || 'Waves Tech',
                        serviceDate: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                        arrivalTime: service.checkInTime ? new Date(service.checkInTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '',
                        serviceNotes: notes,
                        productsApplied: productNames,
                      }),
                    });
                    if (r.report) setNotes(r.report);
                  } catch (e) { alert('AI report failed: ' + e.message); }
                  setGenerating(false);
                }}
                disabled={generating}
                style={{ ...secondaryPill, marginTop: 4, marginBottom: 20, opacity: generating ? 0.5 : 1 }}
              >
                {generating ? 'Generating…' : 'Generate AI report'}
              </button>
            )}

            {/* Service photos */}
            {!quickComplete && (
              <Field label={`Service photos (${servicePhotos.length}/5)`}>
                <input ref={photoInputRef} type="file" accept="image/*" capture="environment" multiple
                       onChange={handlePhotoSelect} style={{ display: 'none' }} />
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={servicePhotos.length >= 5}
                  style={{ ...secondaryPill, opacity: servicePhotos.length >= 5 ? 0.5 : 1 }}
                >
                  Add photos
                </button>
                {servicePhotos.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    {servicePhotos.map((photo, i) => (
                      <div key={i} style={{ position: 'relative', width: 80, height: 80 }}>
                        <img src={photo.data} alt={photo.name} style={{
                          width: 80, height: 80, objectFit: 'cover', borderRadius: 8,
                          border: `0.5px solid ${M.hairline}`,
                        }} />
                        <button
                          type="button"
                          onClick={() => removePhoto(i)}
                          aria-label="Remove photo"
                          style={{
                            position: 'absolute', top: -6, right: -6, width: 22, height: 22,
                            borderRadius: '50%', background: M.ink, color: M.actionFg,
                            border: 'none', fontSize: 14, lineHeight: 1, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}
                        >×</button>
                      </div>
                    ))}
                  </div>
                )}
              </Field>
            )}

            {/* Products applied */}
            <Field label="Products applied">
              {quickComplete ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(products || []).slice(0, 8).map(p => {
                    const selected = !!selectedProducts.find(sp => sp.productId === p.id);
                    return (
                      <Chip key={p.id} selected={selected}
                            onClick={() => selected ? removeProduct(p.id) : addProduct(p)}>
                        {selected ? '✓ ' : ''}{p.name}
                      </Chip>
                    );
                  })}
                </div>
              ) : (
                <>
                  <input
                    type="text" value={productSearch}
                    onChange={e => setProductSearch(e.target.value)}
                    placeholder="Search products…"
                    style={mInput}
                  />
                  {productSearch && filteredProducts.length > 0 && (
                    <div style={{
                      background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                      maxHeight: 180, overflowY: 'auto', marginTop: 8,
                    }}>
                      {filteredProducts.slice(0, 8).map((p, idx, arr) => (
                        <div
                          key={p.id}
                          onClick={() => addProduct(p)}
                          style={{
                            padding: '12px 16px', fontFamily: font, fontSize: 15,
                            color: M.ink, cursor: 'pointer',
                            borderBottom: idx === arr.length - 1 ? 'none' : `0.5px solid ${M.hairline}`,
                          }}
                        >{p.name}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {selectedProducts.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                  {selectedProducts.map(sp => (
                    <div key={sp.productId} style={{
                      background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                      padding: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    }}>
                      <span style={{
                        fontFamily: font, fontSize: 15, fontWeight: 600, color: M.ink,
                        flex: 1, minWidth: 120,
                      }}>{sp.name}</span>
                      <input
                        type="number" placeholder="Rate" value={sp.rate}
                        onChange={e => updateProduct(sp.productId, 'rate', e.target.value)}
                        style={{ ...mInput, width: 84, height: 40, padding: '0 12px' }}
                      />
                      <select
                        value={sp.rateUnit}
                        onChange={e => updateProduct(sp.productId, 'rateUnit', e.target.value)}
                        style={{ ...mInput, width: 78, height: 40, padding: '0 12px' }}
                      >
                        <option value="oz">oz</option>
                        <option value="fl_oz">fl oz</option>
                        <option value="ml">ml</option>
                        <option value="g">g</option>
                        <option value="lb">lb</option>
                        <option value="gal">gal</option>
                      </select>
                      <input
                        type="number" placeholder="Total" value={sp.totalAmount || ''}
                        onChange={e => updateProduct(sp.productId, 'totalAmount', e.target.value)}
                        style={{ ...mInput, width: 84, height: 40, padding: '0 12px' }}
                      />
                      <select
                        value={sp.amountUnit || sp.rateUnit}
                        onChange={e => updateProduct(sp.productId, 'amountUnit', e.target.value)}
                        style={{ ...mInput, width: 78, height: 40, padding: '0 12px' }}
                      >
                        <option value="oz">oz</option>
                        <option value="fl_oz">fl oz</option>
                        <option value="ml">ml</option>
                        <option value="g">g</option>
                        <option value="lb">lb</option>
                        <option value="gal">gal</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => removeProduct(sp.productId)}
                        aria-label="Remove product"
                        style={{
                          width: 36, height: 36, borderRadius: '50%', background: M.muted,
                          border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1,
                          color: M.ink, padding: 0,
                        }}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
            </Field>

            {/* Areas serviced */}
            {!quickComplete && (
              <Field label="Areas treated">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {areaOptions.map(area => {
                    const selected = areasServiced.includes(area);
                    return (
                      <Chip key={area} selected={selected} onClick={() => toggleArea(area)}>
                        {selected ? '✓ ' : ''}{area}
                      </Chip>
                    );
                  })}
                </div>
              </Field>
            )}

            {/* Customer recap + final SMS preview */}
            {isIncompleteVisit ? (
              <Field label="Customer recap">
                <div style={{
                  background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                  padding: 14, fontFamily: font, fontSize: 13, color: M.ink3, lineHeight: 1.45,
                }}>
                  This visit will be closed without a customer recap, charge, or review request. The office will see the reason and follow up.
                </div>
              </Field>
            ) : (
              <Field label="Customer recap">
                <textarea
                  value={customerRecap}
                  onChange={e => handleCustomerRecapChange(e.target.value)}
                  rows={4}
                  placeholder="Customer-facing summary..."
                  style={{ ...mTextarea, minHeight: 112 }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <span style={{ fontFamily: font, fontSize: 12, color: recapError ? M.err : (recapStaleAfterEdit ? M.warn : M.ink4) }}>
                    {recapStatusText}
                  </span>
                  <button
                    type="button"
                    onClick={regenerateCustomerRecap}
                    disabled={recapLoading}
                    style={{ ...tertiaryPill, width: 'auto', height: 36, padding: '0 14px', border: `1px solid ${M.hairline}`, fontSize: 12, opacity: recapLoading ? 0.5 : 1 }}
                  >
                    Regenerate
                  </button>
                </div>
              </Field>
            )}

            {sendSms && !isIncompleteVisit && (
              <Field label="Customer SMS preview">
                <div style={{
                  background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                  padding: 14, fontFamily: font, fontSize: 14, color: M.ink,
                  lineHeight: 1.45, whiteSpace: 'pre-wrap',
                }}>
                  {smsPreview || 'Add notes to preview the customer message.'}
                </div>
              </Field>
            )}

            {/* Customer interaction */}
            {!quickComplete && (
              <Field label="Customer interaction">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {CUSTOMER_INTERACTION_OPTIONS.map(opt => {
                    const selected = customerInteraction === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setCustomerInteraction(opt.value)}
                        style={{
                          textAlign: 'left', padding: '12px 16px', borderRadius: 12,
                          background: selected ? M.ink : M.card,
                          color: selected ? M.actionFg : M.ink,
                          border: `1px solid ${selected ? M.ink : M.hairline}`,
                          fontFamily: font, fontSize: 15, fontWeight: 500,
                          cursor: 'pointer',
                        }}
                      >
                        {selected ? '✓ ' : ''}{opt.label}
                      </button>
                    );
                  })}
                </div>
                {customerInteraction === 'concern' && (
                  <input
                    type="text"
                    value={customerConcern}
                    onChange={e => setCustomerConcern(e.target.value)}
                    placeholder="Describe the customer's concern…"
                    style={{ ...mInput, marginTop: 8 }}
                  />
                )}
              </Field>
            )}

            {/* Lawn measurements */}
            {isLawn && !quickComplete && (
              <Field label="Lawn measurements">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ ...eyebrowStyle, marginBottom: 6 }}>Soil temp (°F)</label>
                    <input type="number" value={soilTemp}
                           onChange={e => setSoilTemp(e.target.value)}
                           placeholder="—" style={mInput} />
                  </div>
                  <div>
                    <label style={{ ...eyebrowStyle, marginBottom: 6 }}>Thatch (in)</label>
                    <input type="number" step="0.1" value={thatchMeasurement}
                           onChange={e => setThatchMeasurement(e.target.value)}
                           placeholder="—" style={mInput} />
                  </div>
                  <div>
                    <label style={{ ...eyebrowStyle, marginBottom: 6 }}>Soil pH</label>
                    <input type="number" step="0.1" value={soilPh}
                           onChange={e => setSoilPh(e.target.value)}
                           placeholder="—" style={mInput} />
                  </div>
                  <div>
                    <label style={{ ...eyebrowStyle, marginBottom: 6 }}>Moisture (%)</label>
                    <input type="number" value={soilMoisture}
                           onChange={e => setSoilMoisture(e.target.value)}
                           placeholder="—" style={mInput} />
                  </div>
                </div>
              </Field>
            )}

            {/* Options */}
            <Field label="Options">
              <label style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                marginBottom: 8, cursor: 'pointer',
              }}>
                <input type="checkbox" checked={sendSms && !isIncompleteVisit}
                       disabled={isIncompleteVisit}
                       onChange={e => setSendSms(e.target.checked)}
                       style={{ width: 18, height: 18, accentColor: M.ink }} />
                <span style={{ fontFamily: font, fontSize: 15, color: M.ink }}>
                  {isIncompleteVisit ? 'Completion SMS suppressed' : 'Send completion SMS to customer'}
                </span>
              </label>
              <label style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                cursor: 'pointer',
              }}>
                <input type="checkbox" checked={requestReview && !reviewSuppressionReason}
                       disabled={!!reviewSuppressionReason}
                       onChange={e => setRequestReview(e.target.checked)}
                       style={{ width: 18, height: 18, accentColor: M.ink }} />
                <span style={{ fontFamily: font, fontSize: 15, color: M.ink }}>
                  {reviewSuppressionReason ? 'Review request suppressed' : 'Send review request (2hr delay)'}
                </span>
              </label>
            </Field>

            {/* Next visit */}
            {nextVisit && (
              <div style={{
                background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                padding: 16, marginBottom: 24,
              }}>
                <div style={eyebrowStyle}>Next scheduled visit</div>
                <div style={{ fontFamily: font, fontSize: 15, fontWeight: 600, color: M.ink }}>
                  {nextVisit.date ? new Date(nextVisit.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'N/A'}
                </div>
                <div style={{ fontFamily: font, fontSize: 13, color: M.ink3, marginTop: 2 }}>
                  {nextVisit.serviceType || 'Standard service'}
                </div>
                {!showNextVisitNote ? (
                  <button
                    type="button"
                    onClick={() => setShowNextVisitNote(true)}
                    style={{
                      ...tertiaryPill, height: 36, padding: '0 14px',
                      marginTop: 10, width: 'auto',
                      border: `1px solid ${M.hairline}`, fontSize: 12,
                    }}
                  >
                    Needs adjustment?
                  </button>
                ) : (
                  <input
                    type="text" value={nextVisitNote}
                    onChange={e => setNextVisitNote(e.target.value)}
                    placeholder="Note about next visit adjustment…"
                    style={{ ...mInput, marginTop: 10 }}
                  />
                )}
              </div>
            )}
          </div>

          {/* Sticky footer */}
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 3,
            background: M.card, borderTop: `0.5px solid ${M.hairline}`,
            padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={submitting || calibrationCompletionBlocked || tankCleanoutCompletionBlocked || blackoutCompletionBlocked || nLimitCompletionBlocked || managerApprovalCompletionBlocked}
              style={{ ...primaryPill, opacity: submitting || calibrationCompletionBlocked || tankCleanoutCompletionBlocked || blackoutCompletionBlocked || nLimitCompletionBlocked || managerApprovalCompletionBlocked ? 0.5 : 1 }}
            >
              {completionCtaLabel.replace('...', '…')}
            </button>
          </div>
        </div>
      </>
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Desktop render (legacy D dark palette) — unchanged
  // ────────────────────────────────────────────────────────────────────
  return (
    <>
      <div onClick={() => onClose(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 999 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: isMobile ? '100%' : '60%', minWidth: isMobile ? 0 : 360, maxWidth: isMobile ? '100%' : 640,
        background: D.bg, borderLeft: isMobile ? 'none' : `1px solid ${D.border}`, zIndex: 1000,
        overflowY: 'auto', display: 'flex', flexDirection: 'column',
        animation: 'slideIn 0.25s ease',
      }}>
        {success && (
          <div style={{
            position: 'absolute', inset: 0, background: D.bg + 'ee', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 10, flexDirection: 'column',
          }}>
            <div style={{ fontSize: 64, marginBottom: 16, color: D.green }}>&#10003;</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: D.green }}>Service Completed!</div>
            <div style={{ fontSize: 14, color: D.muted, marginTop: 8 }}>
              {sendSms ? 'SMS + Report sent' : 'Report saved'} for {service.customerName}
            </div>
          </div>
        )}

        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${D.border}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>Complete Service</div>
            <button onClick={() => onClose(false)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 24, cursor: 'pointer', padding: 4 }}>&times;</button>
          </div>
          <div style={{ fontSize: 14, color: D.text, fontWeight: 600 }}>{service.customerName}</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{service.address}</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{service.serviceType}</div>

          {/* Service duration — prominent display */}
          {onSiteTime && (
            <div style={{
              marginTop: 10, padding: '10px 16px', borderRadius: 10,
              background: D.teal + '18', border: `1px solid ${D.teal}44`,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 20, color: D.teal }}>&#9201;</span>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: D.teal, textTransform: 'uppercase', letterSpacing: 0.5 }}>Time on-site</div>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 22, fontWeight: 800, color: D.teal, letterSpacing: 1,
                }}>{elapsed}</div>
              </div>
            </div>
          )}

          {/* Quick Complete toggle */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setQuickComplete(!quickComplete)} style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: quickComplete ? D.amber : 'transparent',
              color: quickComplete ? D.bg : D.amber,
              border: `1px solid ${D.amber}`,
              transition: 'all 0.15s',
            }}>
              {quickComplete ? 'Quick Complete ON' : 'Quick Complete'}
            </button>
            <span style={{ fontSize: 11, color: D.muted }}>
              {quickComplete ? 'Showing minimal fields' : 'Bulk end-of-day mode'}
            </span>
          </div>
        </div>

        {/* Callback banner */}
        {isCallback && (
          <div style={{
            padding: '10px 24px', background: D.green + '18', borderBottom: `1px solid ${D.green}44`,
            fontSize: 13, color: D.green, fontWeight: 600, lineHeight: 1.5,
          }}>
            Callback visit — will be noted as included with WaveGuard membership on the customer's report.
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          {showDraftPrompt && (
            <div style={{
              background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
              padding: 14, marginBottom: 16,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>Restore saved draft?</div>
              <div style={{ fontSize: 12, color: D.muted, marginTop: 3 }}>
                Saved {savedDraft?.savedAt ? new Date(savedDraft.savedAt).toLocaleString() : 'recently'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={restoreDraft} style={{ ...btnBase, width: 'auto', height: 36, padding: '0 14px', background: D.teal, color: '#fff' }}>
                  Restore
                </button>
                <button onClick={discardDraft} style={{ ...btnBase, width: 'auto', height: 36, padding: '0 14px', background: 'transparent', color: D.muted, border: `1px solid ${D.border}` }}>
                  Discard
                </button>
              </div>
            </div>
          )}

          {calibrationRequired && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Equipment Calibration</label>
              <select
                value={equipmentSystemId}
                onChange={e => handleEquipmentSelect(e.target.value)}
                disabled={isIncompleteVisit}
                style={inputStyle}
              >
                <option value="">Select calibrated equipment</option>
                {equipmentCalibrations.map(c => (
                  <option key={c.id} value={c.equipment_system_id}>
                    {c.system_name || 'Equipment'} · {c.carrier_gal_per_1000 || '—'} gal/1K
                  </option>
                ))}
              </select>
              <div style={{
                fontSize: 12,
                color: selectedCalibrationExpired || equipmentCalibrationError ? D.red : D.muted,
                lineHeight: 1.4,
              }}>
                {isIncompleteVisit ? 'Calibration is not required when marking a visit incomplete.' : calibrationHelpText}
              </div>
            </div>
          )}

          {tankCleanoutRequired && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Tank Cleanout</label>
              <div style={{ fontSize: 12, color: tankCleanoutCompletionBlocked ? D.red : D.muted, lineHeight: 1.4, marginBottom: 8 }}>
                {tankCleanoutHelpText}
              </div>
              <input
                value={tankLastProduct}
                onChange={e => setTankLastProduct(e.target.value)}
                placeholder="Last product in tank"
                style={inputStyle}
              />
              <select
                value={tankLastProductCategory}
                onChange={e => setTankLastProductCategory(e.target.value)}
                style={{ ...inputStyle, marginTop: 8 }}
              >
                <option value="">Prior product type</option>
                <option value="herbicide">Herbicide / weed control</option>
                <option value="insecticide">Insecticide</option>
                <option value="fungicide">Fungicide</option>
                <option value="fertilizer">Fertilizer / nutrient</option>
                <option value="water_only">Water only</option>
                <option value="unknown">Unknown</option>
              </select>
              <select
                value={tankCleanoutCompleted}
                onChange={e => setTankCleanoutCompleted(e.target.value)}
                style={{ ...inputStyle, marginTop: 8 }}
              >
                <option value="">Cleanout completed?</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
              <select
                value={tankCleanoutMethod}
                onChange={e => setTankCleanoutMethod(e.target.value)}
                style={{ ...inputStyle, marginTop: 8 }}
              >
                <option value="">Cleanout method</option>
                {TANK_CLEANOUT_METHODS.map(method => (
                  <option key={method} value={method}>{method}</option>
                ))}
              </select>
              <textarea
                value={tankCleanoutNote}
                onChange={e => setTankCleanoutNote(e.target.value)}
                rows={2}
                placeholder="Cleanout note"
                style={{
                  width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`,
                  borderRadius: 10, padding: 12, fontSize: 14, resize: 'vertical',
                  fontFamily: "'Nunito Sans', sans-serif", boxSizing: 'border-box', marginTop: 8,
                }}
              />
            </div>
          )}

          {blackoutApprovalRequired && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Office Approval</label>
              <div style={{ fontSize: 12, color: D.red, lineHeight: 1.4, marginBottom: 8 }}>
                {blackoutHelpText} {!canApproveOfficeExceptions ? 'An admin must approve this exception before completion.' : ''}
              </div>
              {canApproveOfficeExceptions && (
                <>
                  <select
                    value={officeApprovalReasonCode}
                    onChange={e => setOfficeApprovalReasonCode(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">Select approval reason</option>
                    {OFFICE_APPROVAL_REASONS.map(reason => (
                      <option key={reason.value} value={reason.value}>{reason.label}</option>
                    ))}
                  </select>
                  <textarea
                    value={officeApprovalNote}
                    onChange={e => setOfficeApprovalNote(e.target.value)}
                    rows={2}
                    placeholder="Approval note"
                    style={{
                      width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`,
                      borderRadius: 10, padding: 12, fontSize: 14, resize: 'vertical',
                      fontFamily: "'Nunito Sans', sans-serif", boxSizing: 'border-box', marginTop: 8,
                    }}
                  />
                </>
              )}
            </div>
          )}

          {nLimitApprovalRequired && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Annual N Budget</label>
              <div style={{ fontSize: 12, color: D.red, lineHeight: 1.4, marginBottom: 8 }}>
                {nLimitHelpText} {nLimitSummaryText} {!canApproveOfficeExceptions ? 'An admin must approve this exception before completion.' : ''}
              </div>
              {canApproveOfficeExceptions && (
                <>
                  <select
                    value={nLimitApprovalReasonCode}
                    onChange={e => setNLimitApprovalReasonCode(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">Select approval reason</option>
                    {N_LIMIT_APPROVAL_REASONS.map(reason => (
                      <option key={reason.value} value={reason.value}>{reason.label}</option>
                    ))}
                  </select>
                  <textarea
                    value={nLimitApprovalNote}
                    onChange={e => setNLimitApprovalNote(e.target.value)}
                    rows={2}
                    placeholder="Approval note"
                    style={{
                      width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`,
                      borderRadius: 10, padding: 12, fontSize: 14, resize: 'vertical',
                      fontFamily: "'Nunito Sans', sans-serif", boxSizing: 'border-box', marginTop: 8,
                    }}
                  />
                </>
              )}
            </div>
          )}

          {managerApprovalRequired && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Manager Approval</label>
              <div style={{ fontSize: 12, color: D.red, lineHeight: 1.4, marginBottom: 8 }}>
                {managerApprovalHelpText} {!canApproveOfficeExceptions ? 'An admin must approve this exception before completion.' : ''}
              </div>
              {canApproveOfficeExceptions && (
                <>
                  <select
                    value={managerApprovalReasonCode}
                    onChange={e => setManagerApprovalReasonCode(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">Select approval reason</option>
                    {MANAGER_APPROVAL_REASONS.map(reason => (
                      <option key={reason.value} value={reason.value}>{reason.label}</option>
                    ))}
                  </select>
                  <textarea
                    value={managerApprovalNote}
                    onChange={e => setManagerApprovalNote(e.target.value)}
                    rows={2}
                    placeholder="Approval note"
                    style={{
                      width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`,
                      borderRadius: 10, padding: 12, fontSize: 14, resize: 'vertical',
                      fontFamily: "'Nunito Sans', sans-serif", boxSizing: 'border-box', marginTop: 8,
                    }}
                  />
                </>
              )}
            </div>
          )}

          {/* Visit Outcome */}
          <label style={labelStyle}>Visit Outcome</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
            {VISIT_OUTCOME_OPTIONS.map(opt => (
              <button key={opt.value} onClick={() => setVisitOutcome(opt.value)} style={{
                padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                background: visitOutcome === opt.value ? D.teal + '22' : D.card,
                color: visitOutcome === opt.value ? D.teal : D.text,
                border: `1px solid ${visitOutcome === opt.value ? D.teal : D.border}`,
              }}>
                {visitOutcome === opt.value ? '\u2713 ' : ''}{opt.label}
              </button>
            ))}
          </div>

          {/* Technician Notes */}
          <label style={labelStyle}>Technician Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={quickComplete ? 3 : 5} style={{
            width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`,
            borderRadius: 10, padding: 12, fontSize: 14, resize: 'vertical',
            fontFamily: "'Nunito Sans', sans-serif", boxSizing: 'border-box',
          }} placeholder="Notes about this service..." />

          {/* Three-row chip system */}
          <div style={{ marginTop: 10, marginBottom: 16 }}>
            {/* Action chips (blue) */}
            <div style={chipGroupStyle}>
              <span style={{ ...chipLabelStyle, color: D.blue }}>Actions</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {CHIP_ACTIONS.map(chip => (
                  <button key={chip} onClick={() => addChipNote('Action', chip)} style={{
                    padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    background: D.blue + '18', color: D.blue, border: `1px solid ${D.blue}44`,
                  }}>{chip}</button>
                ))}
              </div>
            </div>
            {/* Observation chips (amber) */}
            <div style={chipGroupStyle}>
              <span style={{ ...chipLabelStyle, color: D.amber }}>Observations</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {CHIP_OBSERVATIONS.map(chip => (
                  <button key={chip} onClick={() => addChipNote('Found', chip)} style={{
                    padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    background: D.amber + '18', color: D.amber, border: `1px solid ${D.amber}44`,
                  }}>{chip}</button>
                ))}
              </div>
            </div>
            {/* Recommendation chips (green) */}
            <div style={chipGroupStyle}>
              <span style={{ ...chipLabelStyle, color: D.green }}>Recommendations</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {CHIP_RECOMMENDATIONS.map(chip => (
                  <button key={chip} onClick={() => addChipNote('Next', chip)} style={{
                    padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    background: D.green + '18', color: D.green, border: `1px solid ${D.green}44`,
                  }}>{chip}</button>
                ))}
              </div>
            </div>
          </div>

          {/* AI Report Generator — hidden in quick complete */}
          {!quickComplete && (
            <button onClick={async () => {
              if (!notes.trim()) { alert('Add service notes first.'); return; }
              setGenerating(true);
              try {
                const productNames = selectedProducts.map(p => p.name + (p.rate ? ` (${p.rate} ${p.rateUnit})` : '')).join(', ');
                const r = await adminFetch('/admin/schedule/generate-report', {
                  method: 'POST',
                  body: JSON.stringify({
                    customerName: service.customerName,
                    serviceType: service.serviceType,
                    technicianName: service.technicianName || 'Waves Tech',
                    serviceDate: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
                    arrivalTime: service.checkInTime ? new Date(service.checkInTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '',
                    serviceNotes: notes,
                    productsApplied: productNames,
                  }),
                });
                if (r.report) setNotes(r.report);
              } catch (e) { alert('AI report failed: ' + e.message); }
              setGenerating(false);
            }} disabled={generating} style={{
              width: '100%', padding: '10px 16px', borderRadius: 10, border: 'none',
              background: generating ? D.card : 'linear-gradient(135deg, #8b5cf6, #6366f1)',
              color: D.heading, fontSize: 13, fontWeight: 700, cursor: generating ? 'wait' : 'pointer',
              marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>
              {generating ? 'Generating Report...' : 'Generate AI Service Report'}
            </button>
          )}

          {/* Photo Upload — hidden in quick complete */}
          {!quickComplete && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Service Photos</label>
              <input ref={photoInputRef} type="file" accept="image/*" capture="environment" multiple
                onChange={handlePhotoSelect} style={{ display: 'none' }} />
              <button onClick={() => photoInputRef.current?.click()} disabled={servicePhotos.length >= 5} style={{
                ...btnBase, background: 'transparent', color: D.teal, border: `1px solid ${D.teal}44`,
                height: 40, fontSize: 13, opacity: servicePhotos.length >= 5 ? 0.5 : 1,
              }}>
                <span style={{ fontSize: 16 }}>&#128247;</span> Add Photos ({servicePhotos.length}/5)
              </button>
              {servicePhotos.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {servicePhotos.map((photo, i) => (
                    <div key={i} style={{ position: 'relative', width: 80, height: 80 }}>
                      <img src={photo.data} alt={photo.name} style={{
                        width: 80, height: 80, objectFit: 'cover', borderRadius: 8,
                        border: `1px solid ${D.border}`,
                      }} />
                      <button onClick={() => removePhoto(i)} style={{
                        position: 'absolute', top: -6, right: -6, width: 20, height: 20,
                        borderRadius: '50%', background: D.red, color: '#fff', border: 'none',
                        fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        lineHeight: 1, fontWeight: 700,
                      }}>&times;</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Products Applied */}
          <label style={labelStyle}>Products Applied</label>
          {quickComplete ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {(products || []).slice(0, 5).map(p => {
                const isSelected = selectedProducts.find(sp => sp.productId === p.id);
                return (
                  <button key={p.id} onClick={() => isSelected ? removeProduct(p.id) : addProduct(p)} style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: isSelected ? D.teal + '22' : D.card,
                    color: isSelected ? D.teal : D.text,
                    border: `1px solid ${isSelected ? D.teal : D.border}`,
                  }}>
                    {isSelected ? '\u2713 ' : ''}{p.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <input type="text" value={productSearch} onChange={e => setProductSearch(e.target.value)}
                placeholder="Search products..." style={inputStyle} />
              {productSearch && filteredProducts.length > 0 && (
                <div style={{
                  background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
                  maxHeight: 160, overflowY: 'auto', marginTop: 4, marginBottom: 8,
                }}>
                  {filteredProducts.slice(0, 8).map(p => (
                    <div key={p.id} onClick={() => addProduct(p)} style={{
                      padding: '8px 12px', fontSize: 13, color: D.text, cursor: 'pointer',
                      borderBottom: `1px solid ${D.border}`,
                    }}>{p.name}</div>
                  ))}
                </div>
              )}
            </>
          )}
          {selectedProducts.length > 0 && !quickComplete && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, marginBottom: 20 }}>
              {selectedProducts.map(sp => (
                <div key={sp.productId} style={{
                  background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: 12,
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: D.text, flex: 1, minWidth: 120 }}>{sp.name}</span>
                  <input type="number" placeholder="Rate" value={sp.rate}
                    onChange={e => updateProduct(sp.productId, 'rate', e.target.value)}
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }} />
                  <select value={sp.rateUnit} onChange={e => updateProduct(sp.productId, 'rateUnit', e.target.value)}
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }}>
                    <option value="oz">oz</option>
                    <option value="fl_oz">fl oz</option>
                    <option value="ml">ml</option>
                    <option value="g">g</option>
                    <option value="lb">lb</option>
                    <option value="gal">gal</option>
                  </select>
                  <input type="number" placeholder="Total" value={sp.totalAmount || ''}
                    onChange={e => updateProduct(sp.productId, 'totalAmount', e.target.value)}
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }} />
                  <select value={sp.amountUnit || sp.rateUnit} onChange={e => updateProduct(sp.productId, 'amountUnit', e.target.value)}
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }}>
                    <option value="oz">oz</option>
                    <option value="fl_oz">fl oz</option>
                    <option value="ml">ml</option>
                    <option value="g">g</option>
                    <option value="lb">lb</option>
                    <option value="gal">gal</option>
                  </select>
                  <button onClick={() => removeProduct(sp.productId)} style={{
                    background: 'none', border: 'none', color: D.red, fontSize: 18, cursor: 'pointer', padding: '0 4px',
                  }}>&times;</button>
                </div>
              ))}
            </div>
          )}

          {/* Areas Serviced */}
          {!quickComplete && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Areas Treated</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {areaOptions.map(area => {
                  const selected = areasServiced.includes(area);
                  return (
                    <button key={area} onClick={() => toggleArea(area)} style={{
                      padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      background: selected ? D.teal + '22' : D.card,
                      color: selected ? D.teal : D.muted,
                      border: `1px solid ${selected ? D.teal : D.border}`,
                      transition: 'all 0.15s',
                    }}>
                      {selected ? '\u2713 ' : ''}{area}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Customer Recap */}
          <label style={labelStyle}>Customer Recap</label>
          {isIncompleteVisit ? (
            <div style={{
              background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
              padding: 12, color: D.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 16,
            }}>
              This visit will be closed without a customer recap, charge, or review request. The office will see the reason and follow up.
            </div>
          ) : (
            <>
              <textarea value={customerRecap} onChange={e => handleCustomerRecapChange(e.target.value)} rows={4} style={{
                width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`,
                borderRadius: 10, padding: 12, fontSize: 14, resize: 'vertical',
                fontFamily: "'Nunito Sans', sans-serif", boxSizing: 'border-box', marginBottom: 8,
              }} placeholder="Customer-facing summary..." />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <span style={{ fontSize: 12, color: recapError ? D.red : (recapStaleAfterEdit ? D.amber : D.muted) }}>
                  {recapStatusText}
                </span>
                <button onClick={regenerateCustomerRecap} disabled={recapLoading} style={{
                  ...btnBase, width: 'auto', height: 36, padding: '0 14px',
                  background: 'transparent', color: D.teal, border: `1px solid ${D.teal}44`,
                  opacity: recapLoading ? 0.5 : 1,
                }}>Regenerate</button>
              </div>
            </>
          )}

          {sendSms && !isIncompleteVisit && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Customer SMS Preview</label>
              <div style={{
                background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
                padding: 12, color: D.text, fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
              }}>
                {smsPreview || 'Add notes to preview the customer message.'}
              </div>
            </div>
          )}

          {/* Customer Interaction */}
          {!quickComplete && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Customer Interaction</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {CUSTOMER_INTERACTION_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setCustomerInteraction(opt.value)} style={{
                    padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500, cursor: 'pointer',
                    textAlign: 'left',
                    background: customerInteraction === opt.value ? D.teal + '18' : D.card,
                    color: customerInteraction === opt.value ? D.teal : D.text,
                    border: `1px solid ${customerInteraction === opt.value ? D.teal : D.border}`,
                    transition: 'all 0.15s',
                  }}>
                    {customerInteraction === opt.value ? '\u2713 ' : ''}{opt.label}
                  </button>
                ))}
              </div>
              {customerInteraction === 'concern' && (
                <input type="text" value={customerConcern} onChange={e => setCustomerConcern(e.target.value)}
                  placeholder="Describe the customer's concern..."
                  style={{ ...inputStyle, marginTop: 8 }} />
              )}
            </div>
          )}

          {/* Lawn Measurements — hidden in quick complete */}
          {isLawn && !quickComplete && (
            <>
              <label style={labelStyle}>Lawn Measurements</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
                <div>
                  <div style={subLabelStyle}>Soil Temp (F)</div>
                  <input type="number" value={soilTemp} onChange={e => setSoilTemp(e.target.value)} placeholder="--" style={inputStyle} />
                </div>
                <div>
                  <div style={subLabelStyle}>Thatch (in)</div>
                  <input type="number" step="0.1" value={thatchMeasurement} onChange={e => setThatchMeasurement(e.target.value)} placeholder="--" style={inputStyle} />
                </div>
                <div>
                  <div style={subLabelStyle}>Soil pH</div>
                  <input type="number" step="0.1" value={soilPh} onChange={e => setSoilPh(e.target.value)} placeholder="--" style={inputStyle} />
                </div>
                <div>
                  <div style={subLabelStyle}>Moisture (%)</div>
                  <input type="number" value={soilMoisture} onChange={e => setSoilMoisture(e.target.value)} placeholder="--" style={inputStyle} />
                </div>
              </div>
            </>
          )}

          {/* Options */}
          <label style={labelStyle}>Options</label>
          <label style={checkboxRow}>
            <input type="checkbox" checked={sendSms && !isIncompleteVisit} disabled={isIncompleteVisit} onChange={e => setSendSms(e.target.checked)} />
            <span>{isIncompleteVisit ? 'Completion SMS suppressed' : 'Send completion SMS to customer'}</span>
          </label>
          <label style={checkboxRow}>
            <input type="checkbox" checked={requestReview && !reviewSuppressionReason} disabled={!!reviewSuppressionReason} onChange={e => setRequestReview(e.target.checked)} />
            <span>{reviewSuppressionReason ? 'Review request suppressed' : 'Send review request (2hr delay)'}</span>
          </label>

          {/* Next Visit Prompt */}
          {nextVisit && (
            <div style={{
              marginTop: 16, padding: '12px 16px', borderRadius: 10,
              background: D.card, border: `1px solid ${D.border}`,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Next Scheduled Visit
              </div>
              <div style={{ fontSize: 14, color: D.heading, fontWeight: 600 }}>
                {nextVisit.date ? new Date(nextVisit.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'N/A'}
                <span style={{ fontSize: 12, color: D.muted, fontWeight: 400, marginLeft: 8 }}>
                  ({nextVisit.serviceType || 'Standard service'})
                </span>
              </div>
              {!showNextVisitNote ? (
                <button onClick={() => setShowNextVisitNote(true)} style={{
                  background: 'none', border: 'none', color: D.amber, fontSize: 12, cursor: 'pointer',
                  padding: 0, marginTop: 6, textDecoration: 'underline',
                }}>
                  Needs adjustment?
                </button>
              ) : (
                <input type="text" value={nextVisitNote} onChange={e => setNextVisitNote(e.target.value)}
                  placeholder="Note about next visit adjustment..."
                  style={{ ...inputStyle, marginTop: 8, marginBottom: 0 }} />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: `1px solid ${D.border}`, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={() => handleSubmit()} disabled={submitting || calibrationCompletionBlocked || tankCleanoutCompletionBlocked || blackoutCompletionBlocked || nLimitCompletionBlocked || managerApprovalCompletionBlocked} style={{
            ...btnBase, width: '100%', background: D.green, color: '#fff', fontSize: 14, height: 52,
            opacity: submitting || calibrationCompletionBlocked || tankCleanoutCompletionBlocked || blackoutCompletionBlocked || nLimitCompletionBlocked || managerApprovalCompletionBlocked ? 0.6 : 1, flexDirection: 'column', lineHeight: 1.3,
          }}>
            {submitting ? completionCtaLabel : (
              <>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{completionCtaLabel}</span>
                <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.85 }}>
                  {isIncompleteVisit ? 'Office follow-up alert will be created' : sendSms ? `SMS + Report sent to ${service.customerName}` : `Report saved for ${service.customerName}`}
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
}

const labelStyle = { display: 'block', fontSize: 12, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 };
const subLabelStyle = { fontSize: 11, color: D.muted, marginBottom: 4 };
const inputStyle = { width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, boxSizing: 'border-box', marginBottom: 8 };
const checkboxRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: D.text, cursor: 'pointer', marginBottom: 8 };

/* ── Protocol Reference Tab ────────────────────────────── */

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* Product descriptions — plain-language for techs and Virginia */
const PRODUCT_DESCRIPTIONS = {
  'acelepryn xtra': 'prevents chinch bugs, webworms, and grubs for 2-3 months',
  'acelepryn': 'prevents chinch bugs, webworms, and grubs for 2-3 months',
  'speedzone southern': 'kills broadleaf weeds without harming St. Augustine',
  'speedzone': 'kills broadleaf weeds without harming St. Augustine',
  'celsius wg': 'selective weed killer for warm-season grass (max 3x/year)',
  'celsius': 'selective weed killer for warm-season grass (max 3x/year)',
  'k-flow 0-0-25': 'potassium that strengthens roots against drought and disease',
  'k-flow': 'potassium that strengthens roots against drought and disease',
  'prodiamine 65 wdg': 'pre-emergent that stops crabgrass and weeds before they sprout',
  'prodiamine': 'pre-emergent that stops crabgrass and weeds before they sprout',
  'lesco 24-0-11': 'slow-release nitrogen fertilizer for steady green-up',
  'lesco 24-2-11': 'slow-release fertilizer with phosphorus for root development',
  'lesco 0-0-18': 'potassium + magnesium for winter root strength',
  'lesco elite 0-0-28': 'premium potassium for winter hardiness and root health',
  'chelated iron plus': 'foliar iron for deep green color without excess growth',
  'chelated iron': 'foliar iron for deep green color without excess growth',
  'high mn combo': 'manganese and micronutrients for stress recovery',
  'carbonpro-l': 'biostimulant that feeds soil biology and improves nutrient uptake',
  'headway g': 'dual-action fungicide for large patch and take-all root rot (FRAC 11+3)',
  'headway': 'dual-action fungicide for large patch and take-all root rot (FRAC 11+3)',
  'medallion sc': 'fungicide for large patch — different mode of action (FRAC 7)',
  'medallion': 'fungicide for large patch — different mode of action (FRAC 7)',
  'torque sc': 'fungicide for fall disease prevention (FRAC 12)',
  'torque': 'fungicide for fall disease prevention (FRAC 12)',
  'sedgehammer plus': 'kills nutsedge without damaging turf',
  'sedgehammer': 'kills nutsedge without damaging turf',
  'dismiss': 'fast-acting sedge control — visible results in days',
  'primo maxx': 'plant growth regulator for denser, thicker turf (Premium only)',
  'talstar p': 'broad-spectrum insecticide for chinch bug rescue treatment',
  'talstar': 'broad-spectrum insecticide for chinch bug rescue treatment',
  'arena 50 wdg': 'backup insecticide if Talstar fails — different mode of action (Group 4A)',
  'arena': 'backup insecticide if Talstar fails — different mode of action (Group 4A)',
  'hydretain': 'moisture manager that reduces watering needs by 50%',
  'atrazine 4l': 'winter broadleaf and grassy weed control (apply under 85F only)',
  'atrazine': 'winter broadleaf and grassy weed control (apply under 85F only)',
  'three-way': 'broadleaf weed killer — backup when Atrazine is weather-blocked',
  'blindside wdg': 'broadleaf + sedge control — safe fallback after Celsius cap (Groups 14+2)',
  'blindside': 'broadleaf + sedge control — safe fallback after Celsius cap (Groups 14+2)',
  'pillar sc': 'dual fungicide for take-all root rot / low-light stress sites (FRAC 11+3)',
  'pillar': 'dual fungicide for take-all root rot / low-light stress sites (FRAC 11+3)',
  'moisture manager': 'wetting agent that helps water penetrate compacted soil',
  'dispatch': 'wetting agent that helps water penetrate compacted soil',
  'green flo 6-0-0': 'calcium supplement for summer cation balance',
  'green flo phyte plus': 'phosphite + potassium for disease suppression and root health',
};

/* Safety rules per track */
const TRACK_SAFETY_RULES = {
  'st_augustine': [
    'Celsius WG: MAX 3 apps/year/property',
    'SpeedZone: verify cultivar and do NOT apply >90\u00b0F',
    'Hold PGR/hot herbicide on stressed turf',
    'N blackout Jun 1 \u2013 Sep 30',
  ],
  'A_St_Aug_Sun': [
    'Celsius WG: MAX 3 apps/year/property',
    'SpeedZone: verify cultivar and do NOT apply >90\u00b0F',
    'Hold PGR/hot herbicide on stressed turf',
    'N blackout Jun 1 \u2013 Sep 30',
  ],
  'B_St_Aug_Shade': [
    'Celsius WG: MAX 3 apps/year/property',
    'SpeedZone: verify cultivar and do NOT apply >90\u00b0F',
    'Hold PGR/hot herbicide on stressed turf',
    'N blackout Jun 1 \u2013 Sep 30',
  ],
  'C1_Bermuda': [
    'Celsius WG: MAX 3 apps/year/property',
    'No Atrazine on Bermuda \u2014 EVER',
    'N blackout Jun 1 \u2013 Sep 30',
  ],
  'C2_Zoysia': [
    'Celsius WG: MAX 3 apps/year/property',
    'No Atrazine on Zoysia \u2014 EVER',
    'N blackout Jun 1 \u2013 Sep 30',
  ],
  'D_Bahia': [
    'Celsius WG: MAX 3 apps/year/property',
    'SpeedZone: do NOT apply >90\u00b0F',
    'N blackout Jun 1 \u2013 Sep 30',
  ],
};

/* Named exports for V2 reuse (ProtocolReferenceTabV2) */
export { MONTH_NAMES, PRODUCT_DESCRIPTIONS, TRACK_SAFETY_RULES, stripLegacyBoilerplate };


// V1 page + render chain retired.
//
// /admin/schedule → redirects to /admin/dispatch?tab=schedule
// /admin/dispatch → AdminDispatchPage (Board tab + DispatchPageV2)
//
// This file is retained only as a shared module for V2 consumers:
//   - CompletionPanel / RescheduleModal / EditServiceModal /
//     ProtocolPanel → DispatchPageV2
//   - MONTH_NAMES / PRODUCT_DESCRIPTIONS / TRACK_SAFETY_RULES /
//     stripLegacyBoilerplate → ProtocolReferenceTabV2
//
// Removed in the dead-code cleanup pass:
//   - StatusBadge / TierBadge / LeadScoreBadge / PropertyAlerts /
//     ServiceCard / groupMultiServiceStops / TechSection (the V1
//     render chain — never instantiated since the V1 page was deleted)
//   - sanitizeServiceTypeClient / formatLastServiceDate /
//     formatDateDisplay / isToday (only used by the dead chain)
//   - STATUS_CONFIG / TIER_COLORS (only used by the dead badges)
//   - parseProductLines / TierDot / TierDots / CurrentVisitCard /
//     ProtocolReferenceTab (V2 sibling ProtocolReferenceTabV2 is the
//     only consumer; its imports come from the export block above)
//   - RecurringAlertsBanner (V2 sibling RecurringAlertsBannerV2 in
//     components/schedule/ replaces it)
