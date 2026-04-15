import { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', input: '#FFFFFF',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B',
  blue: '#3b82f6', purple: '#7C3AED', gray: '#64748b',
  text: '#334155', muted: '#64748B', white: '#fff',
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

// All services default 1hr / $0 unless noted. WaveGuard Membership = 0hr.
const S = (name, dur = 60, pMin = 0, pMax = 0) => ({ name, duration: dur, priceMin: pMin, priceMax: pMax });
const FALLBACK_SERVICES = [
  { category: 'pest_control', items: [
    S('Pest Control Service'),
    S('Mite Control Service'),
    S('Mold Remediation Service'),
    S('Mosquito Control Service'),
    S('Mud Dauber Nest Removal Service'),
    S('Tick Control Service'),
    S('Yellow Jacket Control Service'),
    S('Wasp Control Service'),
    S('Wildlife Trapping Service'),
    S('Semiannual Pest Control Service'),
    S('Quarterly Pest Control Service'),
    S('Bi-Monthly Pest Control Service'),
    S('Monthly Pest Control Service'),
  ]},
  { category: 'rodent', items: [
    S('Rodent Control Service'),
    S('Rodent Trapping Service'),
    S('Rodent Exclusion Service'),
    S('Rodent Trapping & Exclusion Service'),
    S('Rodent Trapping & Sanitation Service'),
    S('Rodent Trapping, Exclusion & Sanitation Service'),
    S('Rodent Pest Control'),
    S('Rodent Bait Station Service'),
  ]},
  { category: 'termite', items: [
    S('Termite Bond (Billed Quarterly | 10-Year Term)', 60, 45, 45),
    S('Termite Bond (Billed Quarterly | 5-Year Term)', 60, 54, 54),
    S('Termite Bond (Billed Quarterly | 1-Year Term)', 60, 60, 60),
    S('Termite Monitoring Service', 60, 99, 99),
    S('Termite Active Annual Bait Station Service', 60, 199, 199),
    S('Termite Active Bait Station Service'),
    S('Termite Installation Setup'),
    S('Termite Spot Treatment Service'),
    S('Termite Pretreatment Service'),
    S('Termite Trenching Service'),
    S('Termite Bait Station Cartridge Replacement', 60, 20, 20),
    S('Slab Pre-Treat Termite'),
  ]},
  { category: 'lawn_care', items: [
    S('Lawn Care Service'),
    S('Lawn Fertilization Service'),
    S('Lawn Fungicide Treatment Service'),
    S('Lawn Insect Control Service'),
    S('Lawn Aeration Service'),
  ]},
  { category: 'tree_shrub', items: [
    S('Every 6 Weeks Tree & Shrub Care Service'),
    S('Bi-Monthly Tree & Shrub Care Service'),
  ]},
  { category: 'specialty', items: [
    S('WaveGuard Membership', 0),
    S('WaveGuard Initial Setup'),
    S('Waves Pest Control Appointment'),
  ]},
];

const CATEGORY_LABELS = { recurring: 'Recurring Services', one_time: 'One-Time Treatments', assessment: 'Assessments', pest_control: 'Pest Control', lawn_care: 'Lawn Care', mosquito: 'Mosquito', termite: 'Termite', rodent: 'Rodent', tree_shrub: 'Tree & Shrub', inspection: 'Inspections', specialty: 'Specialty', other: 'Other' };
const CATEGORY_EMOJI = { recurring: '🔄', one_time: '🎯', assessment: '📋', pest_control: '🐛', lawn_care: '🌿', mosquito: '🦟', termite: '🪵', rodent: '🐀', tree_shrub: '🌳', inspection: '🔍', specialty: '⚡', other: '📦' };


const FREQUENCIES = [
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
  const base = new Date(baseDateStr + 'T12:00:00');
  if (pattern === 'monthly_nth_weekday' && nth != null && weekday != null) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1, 12, 0, 0);
    const firstW = d.getDay();
    const offset = (Number(weekday) - firstW + 7) % 7;
    d.setDate(1 + offset + (Number(nth) - 1) * 7);
    return d;
  }
  const intervals = { daily: 1, weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60, quarterly: 91, triannual: 122 };
  let gap;
  if (pattern === 'custom' && intervalDays) gap = Math.max(1, Number(intervalDays));
  else gap = intervals[pattern] || 91;
  const d = new Date(base);
  d.setDate(d.getDate() + gap * i);
  return d;
}

const inputStyle = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid #CBD5E1`, borderRadius: 8, color: '#0F172A', fontSize: 14, outline: 'none', boxSizing: 'border-box', minHeight: 44 };
const labelStyle = { fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 };
const sectionStyle = { background: D.card, borderRadius: 12, padding: 16, border: `1px solid ${D.border}`, marginBottom: 12 };

export default function CreateAppointmentModal({ defaultDate, onClose, onCreated }) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  const searchRef = useRef(null);

  // Customer state
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAdd, setQuickAdd] = useState({ firstName: '', lastName: '', phone: '', address: '', city: '', zip: '' });

  // Service state
  const [serviceGroups, setServiceGroups] = useState(FALLBACK_SERVICES);
  const [selectedService, setSelectedService] = useState(null);
  const [isCallback, setIsCallback] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState(null);

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
  const [windowStart, setWindowStart] = useState(_hhmm);
  const [techMode, setTechMode] = useState('auto');
  const [techId, setTechId] = useState('');
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

  // Notes & Confirm state
  const [customerNotes, setCustomerNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [price, setPrice] = useState('');
  const [sendSms, setSendSms] = useState(true);
  const [notifyTech, setNotifyTech] = useState(true);
  const [createInvoice, setCreateInvoice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  // Fetch services dropdown on mount
  useEffect(() => {
    (async () => {
      try {
        const r = await adminFetch('/admin/schedule/services-dropdown');
        if (r.groups?.length) setServiceGroups(r.groups);
      } catch { /* fallback already set */ }
    })();
    (async () => {
      try {
        const r = await adminFetch('/admin/technicians');
        if (r.technicians) setTechs(r.technicians);
        else if (Array.isArray(r)) setTechs(r);
      } catch { /* techs not critical */ }
    })();
  }, []);

  // Set price when service changes
  useEffect(() => {
    if (!selectedService) return;
    if (isCallback && selectedCustomer?.tier) { setPrice('0'); return; }
    const p = selectedService.priceMin || selectedService.base_price || '';
    setPrice(p ? String(p) : '');
  }, [selectedService, isCallback, selectedCustomer?.tier]);

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
        setQuickAdd({ firstName: '', lastName: '', phone: '', address: '', city: '', zip: '' });
      }
    } catch (e) { alert('Failed to add customer: ' + e.message); }
  };

  // Compute end time
  const getEndTime = () => {
    const dur = selectedService?.duration || selectedService?.default_duration_minutes || 60;
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
      const dur = selectedService.duration || selectedService.default_duration_minutes || 60;
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
    setSaving(true);
    try {
      const body = {
        customerId: selectedCustomer.id,
        scheduledDate: apptDate,
        serviceType: selectedService.name,
        serviceId: selectedService.id || null,
        windowStart,
        windowEnd: getEndTime(),
        assignmentMode: techMode,
        technicianId: techMode === 'choose' ? techId : techMode === 'unassigned' ? null : undefined,
        estimatedPrice: price ? parseFloat(price) : null,
        urgency: 'routine',
        notes: customerNotes || undefined,
        internalNotes: internalNotes || undefined,
        isCallback,
        sendConfirmationSms: sendSms,
        sendTechNotification: notifyTech,
        isRecurring,
        recurringPattern: isRecurring ? recurringFreq : undefined,
        recurringCount: isRecurring ? (recurringOngoing ? 4 : recurringCount) : undefined,
        recurringOngoing: isRecurring ? recurringOngoing : undefined,
        recurringNth: isRecurring && recurringFreq === 'monthly_nth_weekday' ? recurringNth : undefined,
        recurringWeekday: isRecurring && recurringFreq === 'monthly_nth_weekday' ? recurringWeekday : undefined,
        recurringIntervalDays: isRecurring && recurringFreq === 'custom' ? recurringIntervalDays : undefined,
        discountType: isRecurring && discountType ? discountType : undefined,
        discountAmount: isRecurring && discountType && discountAmount !== '' ? Number(discountAmount) : undefined,
        sendConfirmation: sendSms,
      };
      const r = await adminFetch('/admin/schedule', { method: 'POST', body: JSON.stringify(body) });
      setToast(`Appointment created${r.recurringCreated > 1 ? ` (${r.recurringCreated} total)` : ''}`);
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
    borderRadius: isMobile ? 0 : 16, padding: isMobile ? 16 : 24,
    border: isMobile ? 'none' : `1px solid ${D.border}`,
  };

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modalStyle}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A' }}>New Appointment</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 22, cursor: 'pointer', minWidth: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        {/* Toast */}
        {toast && <div style={{ background: `${D.green}22`, border: `1px solid ${D.green}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12, color: D.green, fontSize: 14, fontWeight: 600 }}>{toast}</div>}

        {/* Section 1: Customer */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}>Customer</div>
          {!selectedCustomer ? (
            <div style={{ position: 'relative' }}>
              <input ref={searchRef} type="text" value={customerSearch} onChange={(e) => doSearch(e.target.value)} placeholder="Search by name or phone..." style={inputStyle} />
              {customerResults.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: '0 0 10px 10px', maxHeight: 240, overflowY: 'auto', zIndex: 20 }}>
                  {customerResults.map(c => (
                    <div key={c.id} onClick={() => selectCustomer(c)} style={{ padding: '12px 14px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 14, color: '#0F172A', minHeight: 48, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong>{c.firstName} {c.lastName}</strong>
                      <span style={{ color: D.muted, fontSize: 12 }}>{c.phone || ''}</span>
                      {c.tier && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: `${TIER_COLORS[c.tier] || D.teal}22`, color: TIER_COLORS[c.tier] || D.teal }}>{c.tier}</span>}
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => setShowQuickAdd(!showQuickAdd)} style={{ background: 'none', border: 'none', color: D.teal, fontSize: 12, cursor: 'pointer', marginTop: 6, padding: '4px 0', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>+ New Customer</button>
              {showQuickAdd && (
                <div style={{ marginTop: 8, padding: 12, background: '#F8FAFC', borderRadius: 10, border: `1px solid #CBD5E1` }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div><label style={labelStyle}>First Name</label><input value={quickAdd.firstName} onChange={e => setQuickAdd(q => ({ ...q, firstName: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>Last Name</label><input value={quickAdd.lastName} onChange={e => setQuickAdd(q => ({ ...q, lastName: e.target.value }))} style={inputStyle} /></div>
                  </div>
                  <div style={{ marginBottom: 8 }}><label style={labelStyle}>Phone</label><input value={quickAdd.phone} onChange={e => setQuickAdd(q => ({ ...q, phone: e.target.value }))} style={inputStyle} placeholder="(941) 555-1234" /></div>
                  <div style={{ marginBottom: 8 }}><label style={labelStyle}>Address</label><input value={quickAdd.address} onChange={e => setQuickAdd(q => ({ ...q, address: e.target.value }))} style={inputStyle} /></div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div><label style={labelStyle}>City</label><input value={quickAdd.city} onChange={e => setQuickAdd(q => ({ ...q, city: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>ZIP</label><input value={quickAdd.zip} onChange={e => setQuickAdd(q => ({ ...q, zip: e.target.value }))} style={inputStyle} /></div>
                  </div>
                  <button onClick={handleQuickAdd} style={{ padding: '10px 16px', background: D.teal, color: D.white, border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', minHeight: 44, width: '100%' }}>Add Customer</button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#F8FAFC', borderRadius: 10, padding: 12, border: `1px solid #CBD5E1` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#0F172A', fontSize: 14 }}>{selectedCustomer.firstName} {selectedCustomer.lastName}</div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{selectedCustomer.address || `${selectedCustomer.city || ''}`}</div>
                {selectedCustomer.phone && <div style={{ fontSize: 12, color: D.muted }}>{selectedCustomer.phone}</div>}
              </div>
              {selectedCustomer.tier && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: `${TIER_COLORS[selectedCustomer.tier] || D.teal}22`, color: TIER_COLORS[selectedCustomer.tier] || D.teal, fontWeight: 600 }}>{selectedCustomer.tier}</span>}
              <button onClick={() => { setSelectedCustomer(null); setCustomerSearch(''); }} style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 16, minWidth: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>
          )}
        </div>

        {/* Section 2: Service */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}>Service</div>
          {!selectedService ? (
            <div>
              {[...serviceGroups]
                .sort((a, b) => (CATEGORY_LABELS[a.category] || a.category)
                  .localeCompare(CATEGORY_LABELS[b.category] || b.category))
                .map((group, gi) => {
                const isOpen = expandedCategory === group.category;
                return (
                  <div key={gi} style={{ marginBottom: 6, border: `1px solid ${D.border}`, borderRadius: 8, overflow: 'hidden' }}>
                    <button
                      onClick={() => setExpandedCategory(isOpen ? null : group.category)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: isOpen ? `${D.teal}11` : D.input, border: 'none', color: '#0F172A', fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44 }}
                    >
                      <span>{CATEGORY_EMOJI[group.category] || '📦'} {CATEGORY_LABELS[group.category] || group.category} <span style={{ color: D.muted, fontWeight: 400, marginLeft: 6 }}>({group.items.length})</span></span>
                      <span style={{ color: D.muted, fontSize: 12 }}>{isOpen ? '▾' : '▸'}</span>
                    </button>
                    {isOpen && (
                      <div style={{ display: 'flex', flexDirection: 'column', padding: 8, gap: 4, background: D.bg }}>
                        {group.items.map((svc, si) => (
                          <button key={si} onClick={() => setSelectedService(svc)} style={{ padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 6, color: D.text, fontSize: 13, cursor: 'pointer', minHeight: 40, textAlign: 'left' }}>
                            {svc.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#F8FAFC', borderRadius: 10, padding: 12, border: `1px solid #CBD5E1` }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: '#0F172A', fontSize: 14 }}>{selectedService.name}</div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                  {selectedService.duration || selectedService.default_duration_minutes || 60} min
                  {(selectedService.priceMin || selectedService.base_price) ? ` — $${selectedService.priceMin || selectedService.base_price}${selectedService.priceMax && selectedService.priceMax !== selectedService.priceMin ? `–$${selectedService.priceMax}` : ''}` : ''}
                </div>
              </div>
              <button onClick={() => setSelectedService(null)} style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 16, minWidth: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>
          )}
          {selectedService && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer', minHeight: 44 }}>
              <input type="checkbox" checked={isCallback} onChange={e => setIsCallback(e.target.checked)} style={{ width: 18, height: 18, accentColor: D.teal }} />
              <span style={{ fontSize: 13, color: D.text }}>WaveGuard Callback (free for members)</span>
            </label>
          )}
        </div>

        {/* Section 3: Date, Time & Tech */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Date, Time & Tech</div>
            {selectedCustomer && selectedService && (
              <button
                onClick={handleFindTimes}
                disabled={findingTimes}
                style={{
                  padding: '6px 12px', background: findingTimes ? '#CBD5E1' : `${D.teal}15`,
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
            <div style={{ marginBottom: 12, background: '#F8FAFC', border: `1px solid ${D.border}`, borderRadius: 10, padding: 10 }}>
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
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>
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
              <input type="date" value={apptDate} onChange={e => setApptDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Start Time</label>
              <input type="time" value={windowStart} onChange={e => setWindowStart(e.target.value)} step={900} style={inputStyle} />
            </div>
          </div>

          {/* Tech Assignment */}
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Tech Assignment</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {[{ v: 'auto', l: 'Auto' }, { v: 'choose', l: 'Choose' }, { v: 'unassigned', l: 'Unassigned' }].map(o => (
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

          {/* Recurring */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 44, marginBottom: isRecurring ? 8 : 0 }}>
            <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} style={{ width: 18, height: 18, accentColor: D.teal }} />
            <span style={{ fontSize: 13, color: D.text }}>Recurring</span>
          </label>
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={labelStyle}>Discount</label>
                  <select value={discountType} onChange={e => setDiscountType(e.target.value)} style={inputStyle}>
                    <option value="">None</option>
                    <option value="percentage">Percentage (%)</option>
                    <option value="fixed_amount">Amount ($)</option>
                  </select>
                </div>
                {discountType && (
                  <div>
                    <label style={labelStyle}>{discountType === 'percentage' ? 'Amount (%)' : 'Amount ($)'}</label>
                    <input type="number" min={0} step={discountType === 'percentage' ? 1 : 0.01} value={discountAmount} onChange={e => setDiscountAmount(e.target.value)} style={inputStyle} />
                  </div>
                )}
              </div>
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

        {/* Section 4: Notes & Confirm */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}>Notes & Confirm</div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Customer Notes</label>
            <textarea value={customerNotes} onChange={e => setCustomerNotes(e.target.value)} rows={2} placeholder="Notes visible to customer..." style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ ...labelStyle, color: D.amber }}>Internal Notes (Admin only)</label>
            <textarea value={internalNotes} onChange={e => setInternalNotes(e.target.value)} rows={2} placeholder="Internal notes..." style={{ ...inputStyle, resize: 'vertical', minHeight: 60, borderColor: `${D.amber}55` }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Price</label>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: D.muted, fontSize: 14 }}>$</span>
              <input type="number" value={price} onChange={e => setPrice(e.target.value)} style={{ ...inputStyle, paddingLeft: 28 }} placeholder="0.00" />
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
            {[
              { label: 'Send confirmation SMS', val: sendSms, set: setSendSms },
              { label: 'Notify technician', val: notifyTech, set: setNotifyTech },
              { label: 'Create invoice', val: createInvoice, set: setCreateInvoice },
            ].map((t, i) => (
              <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minHeight: 44 }}>
                <input type="checkbox" checked={t.val} onChange={e => t.set(e.target.checked)} style={{ width: 18, height: 18, accentColor: D.green }} />
                <span style={{ fontSize: 13, color: D.text }}>{t.label}</span>
              </label>
            ))}
          </div>
          <button disabled={!selectedCustomer || !selectedService || saving} onClick={handleSubmit} style={{
            width: '100%', padding: '14px 20px', background: D.green, color: D.white,
            border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer',
            minHeight: 52, opacity: (!selectedCustomer || !selectedService || saving) ? 0.5 : 1,
            transition: 'opacity 0.15s',
          }}>
            {saving ? 'Scheduling...' : 'Schedule Appointment'}
          </button>
        </div>
      </div>
    </div>
  );
}
