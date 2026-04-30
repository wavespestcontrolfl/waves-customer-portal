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
const AREAS_SERVICED_OPTIONS = [
  'Front Yard', 'Back Yard', 'Side Yards', 'Interior', 'Garage',
  'Lanai/Pool Cage', 'Perimeter', 'Fence Line', 'Beds',
];
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
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
  { value: 'monthly_nth_weekday', label: 'Every month on the Nth weekday' },
  { value: 'custom', label: 'Custom (every N days)' },
];
const EDIT_NTH_OPTIONS = [
  { value: 1, label: '1st' }, { value: 2, label: '2nd' },
  { value: 3, label: '3rd' }, { value: 4, label: '4th' },
];
const EDIT_WEEKDAY_OPTIONS = [
  { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];

function editNextRecurringDate(baseDateStr, pattern, i, opts = {}) {
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

  const handleSave = async () => {
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
          createInvoice,
        }),
      });
      onSaved?.();
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
    setSaving(false);
  };

  const labelStyle = { fontSize: 12, color: '#000', marginBottom: 4, display: 'block' };
  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 8, background: D.input,
    color: '#000', border: `1px solid ${D.inputBorder}`, fontSize: 14, outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div
        onClick={e => e.stopPropagation()}
        className="font-bold"
        style={{
          background: D.card, borderRadius: 14, border: `1px solid ${D.border}`,
          width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto', padding: 24,
          color: '#000', fontFamily: 'Roboto, system-ui, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 12, marginBottom: 4 }}>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              flexShrink: 0, width: 32, height: 32, borderRadius: 8,
              border: `1px solid ${D.border}`, background: D.card, color: D.muted,
              fontSize: 18, lineHeight: 1, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ fontSize: 13, color: '#000', marginBottom: 18 }}>
          {service.customerName} — {service.address || ''}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Date</label>
            <input type="date" value={form.scheduledDate} onChange={e => update('scheduledDate', e.target.value)} className="font-bold" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Duration (min)</label>
            <input type="number" value={form.estimatedDuration} onChange={e => update('estimatedDuration', e.target.value)} className="font-bold" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Window Start</label>
            <input type="time" value={form.windowStart} onChange={e => update('windowStart', e.target.value)} className="font-bold" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Window End</label>
            <input type="time" value={form.windowEnd} onChange={e => update('windowEnd', e.target.value)} className="font-bold" style={inputStyle} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Service Type</label>
          {!editingServiceType ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#F8FAFC', borderRadius: 8, padding: '10px 12px', border: `1px solid ${D.inputBorder}` }}>
              <div style={{ flex: 1, fontSize: 14, color: '#000' }}>
                {form.serviceType || <span style={{ color: '#000' }}>— Select service —</span>}
              </div>
              <button type="button" onClick={() => setEditingServiceType(true)} className="font-bold" style={{
                padding: '6px 12px', borderRadius: 6, background: `${D.teal}15`, color: '#000',
                border: `1px solid ${D.teal}55`, fontSize: 12, cursor: 'pointer',
              }}>Change</button>
            </div>
          ) : (
            <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${D.inputBorder}`, borderRadius: 8, padding: 6, background: '#F8FAFC' }}>
              {serviceGroups.map((group) => {
                const isOpen = expandedCategory === group.category;
                return (
                  <div key={group.category} style={{ marginBottom: 4 }}>
                    <button type="button" onClick={() => setExpandedCategory(isOpen ? null : group.category)} className="font-bold" style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6,
                      background: isOpen ? `${D.teal}15` : D.card, border: `1px solid ${D.border}`,
                      color: '#000', fontSize: 13, cursor: 'pointer',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <span>{EDIT_CATEGORY_EMOJI[group.category] || '📦'} {EDIT_CATEGORY_LABELS[group.category] || group.category} <span style={{ color: '#000', marginLeft: 4 }}>({group.items.length})</span></span>
                      <span style={{ color: D.muted, fontSize: 11 }}>{isOpen ? '▾' : '▸'}</span>
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
                            padding: '8px 10px', background: D.card, border: `1px solid ${D.border}`,
                            borderRadius: 6, color: '#000', fontSize: 13, cursor: 'pointer', textAlign: 'left',
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

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Technician</label>
          <select value={form.technicianId} onChange={e => update('technicianId', e.target.value)} className="font-bold" style={inputStyle}>
            <option value="">— Unassigned —</option>
            {(technicians || []).map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Price ($)</label>
          <input type="number" min={0} step={0.01} value={form.price} onChange={e => update('price', e.target.value)} placeholder="0.00" className="font-bold" style={inputStyle} />
          {discountType && discountAmount !== '' && form.price !== '' && !isNaN(parseFloat(form.price)) && (
            <div style={{ fontSize: 11, color: '#000', marginTop: 4 }}>
              After discount: <span style={{ color: D.green }}>${Math.max(0, discountType === 'percentage' ? parseFloat(form.price) * (1 - Number(discountAmount) / 100) : parseFloat(form.price) - Number(discountAmount)).toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* Recurring toggle (same pattern as New Appointment) */}
        <div style={{ marginBottom: 12, padding: 12, background: '#F8FAFC', border: `1px solid ${D.border}`, borderRadius: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: isRecurring ? 10 : 0 }}>
            <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} style={{ width: 16, height: 16, accentColor: D.teal }} />
            <span style={{ fontSize: 13, color: '#000' }}>Make Recurring</span>
            <span style={{ fontSize: 11, color: '#000' }}>— creates future appointments from this date</span>
          </label>
          {isRecurring && (
            <div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button type="button" onClick={() => setRecurringOngoing(true)} className="font-bold" style={{
                  flex: 1, padding: '8px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  background: recurringOngoing ? D.teal : 'transparent',
                  color: recurringOngoing ? '#fff' : '#000',
                  border: `1px solid ${recurringOngoing ? D.teal : D.border}`,
                }}>Ongoing (auto-extend)</button>
                <button type="button" onClick={() => setRecurringOngoing(false)} className="font-bold" style={{
                  flex: 1, padding: '8px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  background: !recurringOngoing ? D.teal : 'transparent',
                  color: !recurringOngoing ? '#fff' : '#000',
                  border: `1px solid ${!recurringOngoing ? D.teal : D.border}`,
                }}>Fixed count</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: recurringOngoing ? '1fr' : '2fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={labelStyle}>Frequency</label>
                  <select value={recurringFreq} onChange={e => setRecurringFreq(e.target.value)} className="font-bold" style={inputStyle}>
                    {EDIT_FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={labelStyle}>Nth</label>
                    <select value={recurringNth} onChange={e => setRecurringNth(parseInt(e.target.value))} className="font-bold" style={inputStyle}>
                      {EDIT_NTH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Weekday</label>
                    <select value={recurringWeekday} onChange={e => setRecurringWeekday(parseInt(e.target.value))} className="font-bold" style={inputStyle}>
                      {EDIT_WEEKDAY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {recurringFreq === 'custom' && (
                <div style={{ marginBottom: 8 }}>
                  <label style={labelStyle}>Every N days</label>
                  <input type="number" min={1} max={365} value={recurringIntervalDays} onChange={e => setRecurringIntervalDays(parseInt(e.target.value) || 30)} className="font-bold" style={inputStyle} />
                </div>
              )}
              <div style={{ marginBottom: 8 }}>
                <label style={labelStyle}>Manual Discount (optional)</label>
                <select value={discountPresetId} onChange={e => applyDiscountPreset(e.target.value)} className="font-bold" style={inputStyle}>
                  <option value="">None</option>
                  {discountPresets.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name} — {d.discount_type === 'percentage' ? `${Number(d.amount).toFixed(d.amount % 1 ? 2 : 0)}%` : `$${Number(d.amount).toFixed(2)}`}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {discountPresetId === 'custom' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={labelStyle}>Type</label>
                    <select value={discountType} onChange={e => setDiscountType(e.target.value)} className="font-bold" style={inputStyle}>
                      <option value="">—</option>
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
                </div>
              )}
              {recurringPreview() && (
                <div style={{ fontSize: 11, color: '#000', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {recurringPreview().map((d, i) => (
                    <span key={i} style={{ padding: '2px 6px', background: `${D.teal}15`, borderRadius: 4, color: '#000' }}>{d}</span>
                  ))}
                  {recurringOngoing
                    ? <span style={{ padding: '2px 6px', color: '#000' }}>… then auto-extends</span>
                    : (recurringCount > 6 && <span style={{ padding: '2px 6px', color: '#000' }}>+{recurringCount - 6} more</span>)}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>Notes</label>
          <textarea value={form.notes} onChange={e => update('notes', e.target.value)} rows={3} className="font-bold" style={{ ...inputStyle, resize: 'vertical' }} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 16, padding: '10px 12px', background: '#F8FAFC', border: `1px solid ${D.border}`, borderRadius: 8 }}>
          <input type="checkbox" checked={createInvoice} onChange={e => setCreateInvoice(e.target.checked)} style={{ width: 16, height: 16, accentColor: D.green }} />
          <span style={{ fontSize: 13, color: '#000' }}>Create invoice on completion</span>
          <span style={{ fontSize: 11, color: '#000' }}>— invoice + pay link sent in the service-complete SMS</span>
        </label>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} className="font-bold" style={{
            padding: '10px 18px', borderRadius: 8, background: 'transparent',
            color: '#000', border: `1px solid ${D.border}`, fontSize: 13, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} className="font-bold" style={{
            padding: '10px 20px', borderRadius: 8, background: '#000', color: '#fff',
            border: 'none', fontSize: 13, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1,
          }}>{saving ? 'Saving…' : 'Save Changes'}</button>
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
      await adminFetch(`/admin/dispatch/${service.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({ newDate: opt.date, newWindow: opt.suggestedWindow, reasonCode: reason, reasonText: notes, notifyCustomer: true }),
      });
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
      await adminFetch(`/admin/dispatch/${service.id}/reschedule`, {
        method: 'POST',
        body: JSON.stringify({ newDate: manualDate, newWindow: window, reasonCode: reason, reasonText: notes, notifyCustomer: true }),
      });
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
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [success, setSuccess] = useState(false);
  const [elapsed, setElapsed] = useState('0:00');
  const [quickComplete, setQuickComplete] = useState(false);
  const [servicePhotos, setServicePhotos] = useState([]);
  const [areasServiced, setAreasServiced] = useState([]);
  const [customerInteraction, setCustomerInteraction] = useState('');
  const [customerConcern, setCustomerConcern] = useState('');
  const [nextVisit, setNextVisit] = useState(null);
  const [nextVisitNote, setNextVisitNote] = useState('');
  const [showNextVisitNote, setShowNextVisitNote] = useState(false);
  const photoInputRef = useRef(null);

  const isLawn = detectServiceCategory(service.serviceType) === 'lawn';
  const onSiteEntry = (service.statusLog || []).find(e => e.status === 'on_site');
  const onSiteTime = onSiteEntry ? onSiteEntry.at : service.checkInTime;

  const svcTypeLower = (service.serviceType || '').toLowerCase();
  const isCallback = svcTypeLower.includes('re-service') || svcTypeLower.includes('callback') || service.isCallback;

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

  function addChipNote(prefix, text) {
    const line = `[${prefix}] ${text}`;
    setNotes(prev => prev.trim() ? prev.trimEnd() + '\n' + line : line);
  }
  function addProduct(product) {
    if (selectedProducts.find(p => p.productId === product.id)) return;
    setSelectedProducts(prev => [...prev, { productId: product.id, name: product.name, rate: '', rateUnit: product.defaultUnit || 'oz' }]);
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
    setSubmitting(true);
    try {
      const body = {
        technicianNotes: notes,
        products: selectedProducts.map(p => ({ productId: p.productId, rate: p.rate, rateUnit: p.rateUnit })),
        sendCompletionSms: sendSms,
        requestReview,
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
      await onSubmit(service.id, body);
      setSuccess(true);
      setTimeout(() => onClose(true), 1200);
    } catch (e) {
      alert('Failed to complete service: ' + e.message);
    }
    setSubmitting(false);
  }

  const filteredProducts = (products || []).filter(p =>
    p.name.toLowerCase().includes(productSearch.toLowerCase())
  );

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
                {sendSms ? 'SMS + report sent' : 'Report saved'} for {service.customerName}
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

            {/* Technician notes */}
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
              <Field label="Areas serviced">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {AREAS_SERVICED_OPTIONS.map(area => {
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
                <input type="checkbox" checked={sendSms}
                       onChange={e => setSendSms(e.target.checked)}
                       style={{ width: 18, height: 18, accentColor: M.ink }} />
                <span style={{ fontFamily: font, fontSize: 15, color: M.ink }}>
                  Send completion SMS to customer
                </span>
              </label>
              <label style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                background: M.card, border: `0.5px solid ${M.hairline}`, borderRadius: 12,
                cursor: 'pointer',
              }}>
                <input type="checkbox" checked={requestReview}
                       onChange={e => setRequestReview(e.target.checked)}
                       style={{ width: 18, height: 18, accentColor: M.ink }} />
                <span style={{ fontFamily: font, fontSize: 15, color: M.ink }}>
                  Send review request (2hr delay)
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
              disabled={submitting}
              style={{ ...primaryPill, opacity: submitting ? 0.5 : 1 }}
            >
              {submitting ? 'Completing…' : 'Complete service'}
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
              <label style={labelStyle}>Areas Serviced</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {AREAS_SERVICED_OPTIONS.map(area => {
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
            <input type="checkbox" checked={sendSms} onChange={e => setSendSms(e.target.checked)} />
            <span>Send completion SMS to customer</span>
          </label>
          <label style={checkboxRow}>
            <input type="checkbox" checked={requestReview} onChange={e => setRequestReview(e.target.checked)} />
            <span>Send review request (2hr delay)</span>
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
          <button onClick={() => handleSubmit()} disabled={submitting} style={{
            ...btnBase, width: '100%', background: D.green, color: '#fff', fontSize: 14, height: 52,
            opacity: submitting ? 0.6 : 1, flexDirection: 'column', lineHeight: 1.3,
          }}>
            {submitting ? 'Completing...' : (
              <>
                <span style={{ fontSize: 15, fontWeight: 700 }}>Complete Service</span>
                <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.85 }}>
                  {sendSms ? `SMS + Report sent to ${service.customerName}` : `Report saved for ${service.customerName}`}
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
  'pillar sc': 'dual fungicide for take-all root rot in shade turf (FRAC 11+3)',
  'pillar': 'dual fungicide for take-all root rot in shade turf (FRAC 11+3)',
  'moisture manager': 'wetting agent that helps water penetrate compacted soil',
  'dispatch': 'wetting agent that helps water penetrate compacted soil',
  'green flo 6-0-0': 'calcium supplement for summer cation balance',
  'green flo phyte plus': 'phosphite + potassium for disease suppression and root health',
};

/* Safety rules per track */
const TRACK_SAFETY_RULES = {
  'A_St_Aug_Sun': [
    'Celsius WG: MAX 3 apps/year/property',
    'SpeedZone: do NOT apply >90\u00b0F',
    'N blackout Jun 1 \u2013 Sep 30',
  ],
  'B_St_Aug_Shade': [
    'Celsius WG: MAX 3 apps/year/property',
    'NEVER SpeedZone on shade St. Aug',
    'NO PGR (Primo Maxx) on shade turf',
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
