import { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155', input: '#0f172a',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444',
  blue: '#3b82f6', purple: '#a855f7', gray: '#64748b',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
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

const TIER_COLORS = { Bronze: '#CD7F32', Silver: '#90CAF9', Gold: '#FDD835', Platinum: '#E5E4E2' };

const FALLBACK_SERVICES = [
  { category: 'specialty', items: [
    { name: 'WaveGuard Membership', duration: 30, priceMin: 0, priceMax: 0 },
    { name: 'WaveGuard Initial Setup', duration: 60, priceMin: 99, priceMax: 99 },
    { name: 'Fire Ant Treatment', duration: 30, priceMin: 55, priceMax: 150 },
    { name: 'Flea & Tick Yard Treatment', duration: 40, priceMin: 150, priceMax: 350 },
    { name: 'Bee / Wasp Nest Removal', duration: 30, priceMin: 150, priceMax: 250 },
    { name: 'Tick Control Service', duration: 30, priceMin: 100, priceMax: 200 },
    { name: 'Mud Dauber Nest Removal', duration: 20, priceMin: 75, priceMax: 150 },
    { name: 'Wildlife Trapping Service', duration: 30, priceMin: 150, priceMax: 400 },
  ]},
  { category: 'pest_control', items: [
    { name: 'General Pest Control (Quarterly)', duration: 45, priceMin: 55, priceMax: 95 },
    { name: 'General Pest Control (Monthly)', duration: 30, priceMin: 40, priceMax: 75 },
    { name: 'Initial Pest Cleanout', duration: 90, priceMin: 125, priceMax: 300 },
    { name: 'General Pest Control (Semiannual)', duration: 45, priceMin: 65, priceMax: 110 },
    { name: 'General Pest Control (Bi-Monthly)', duration: 40, priceMin: 50, priceMax: 85 },
  ]},
  { category: 'lawn_care', items: [
    { name: 'Lawn Fertilization & Weed Control', duration: 45, priceMin: 45, priceMax: 120 },
    { name: 'Lawn Fungicide Treatment', duration: 40, priceMin: 55, priceMax: 150 },
    { name: 'Lawn Insect Control', duration: 45, priceMin: 50, priceMax: 130 },
    { name: 'Core Aeration', duration: 60, priceMin: 100, priceMax: 350 },
  ]},
  { category: 'mosquito', items: [
    { name: 'Mosquito Control (Monthly)', duration: 30, priceMin: 39, priceMax: 85 },
    { name: 'Mosquito Event Spray', duration: 30, priceMin: 125, priceMax: 125 },
  ]},
  { category: 'termite', items: [
    { name: 'Termite Liquid Treatment', duration: 240, priceMin: 800, priceMax: 3500 },
    { name: 'Termite Bait Station System', duration: 180, priceMin: 1000, priceMax: 4000 },
    { name: 'Termite Warranty Renewal', duration: 60, priceMin: 175, priceMax: 400 },
    { name: 'Termite Bond (10-Year Term)', duration: 60, priceMin: 500, priceMax: 1500 },
    { name: 'Termite Bond (5-Year Term)', duration: 60, priceMin: 350, priceMax: 900 },
    { name: 'Termite Bond (1-Year Term)', duration: 60, priceMin: 175, priceMax: 400 },
    { name: 'Termite Monitoring Service', duration: 30, priceMin: 35, priceMax: 65 },
    { name: 'Termite Active Annual Bait Station Service', duration: 60, priceMin: 250, priceMax: 500 },
    { name: 'Termite Active Bait Station Service (Quarterly)', duration: 45, priceMin: 65, priceMax: 150 },
    { name: 'Termite Trenching Service', duration: 120, priceMin: 600, priceMax: 2500 },
    { name: 'Termite Installation Setup', duration: 180, priceMin: 500, priceMax: 2000 },
    { name: 'Termite Pretreatment Service', duration: 120, priceMin: 300, priceMax: 1200 },
    { name: 'Termite Bait Station Cartridge Replacement', duration: 30, priceMin: 25, priceMax: 50 },
    { name: 'Slab Pre-Treat Termite Service', duration: 120, priceMin: 300, priceMax: 1000 },
    { name: 'Termite Spot Treatment Service', duration: 45, priceMin: 150, priceMax: 500 },
  ]},
  { category: 'rodent', items: [
    { name: 'Rodent Exclusion & Trapping', duration: 120, priceMin: 250, priceMax: 1200 },
    { name: 'Rodent Monitoring (Monthly)', duration: 20, priceMin: 45, priceMax: 109 },
    { name: 'Rodent Trapping Service', duration: 30, priceMin: 150, priceMax: 400 },
    { name: 'Rodent Exclusion Service', duration: 90, priceMin: 200, priceMax: 800 },
    { name: 'Rodent Trapping & Sanitation Service', duration: 60, priceMin: 250, priceMax: 600 },
    { name: 'Rodent Trapping, Exclusion & Sanitation Service', duration: 120, priceMin: 400, priceMax: 1200 },
    { name: 'Rodent Pest Control', duration: 30, priceMin: 75, priceMax: 200 },
  ]},
  { category: 'tree_shrub', items: [
    { name: 'Tree & Shrub Care Program', duration: 45, priceMin: 45, priceMax: 150 },
    { name: 'Palm Tree Nutritional Treatment', duration: 30, priceMin: 15, priceMax: 45 },
    { name: 'Tree & Shrub Care (Every 6 Weeks)', duration: 45, priceMin: 55, priceMax: 130 },
  ]},
  { category: 'inspection', items: [
    { name: 'WDO Inspection (Termite Letter)', duration: 60, priceMin: 0, priceMax: 125 },
    { name: 'Lawn Health Inspection', duration: 45, priceMin: 0, priceMax: 75 },
    { name: 'New Customer Property Inspection', duration: 60, priceMin: 0, priceMax: 0 },
  ]},
  { category: 'other', items: [
    { name: 'Waves Pest Control Appointment', duration: 60, priceMin: 0, priceMax: 0 },
  ]},
];

const CATEGORY_LABELS = { recurring: 'Recurring Services', one_time: 'One-Time Treatments', assessment: 'Assessments', pest_control: 'Pest Control', lawn_care: 'Lawn Care', mosquito: 'Mosquito', termite: 'Termite', rodent: 'Rodent', tree_shrub: 'Tree & Shrub', inspection: 'Inspections', specialty: 'Specialty', other: 'Other' };
const CATEGORY_EMOJI = { recurring: '🔄', one_time: '🎯', assessment: '📋', pest_control: '🐛', lawn_care: '🌿', mosquito: '🦟', termite: '🪵', rodent: '🐀', tree_shrub: '🌳', inspection: '🔍', specialty: '⚡', other: '📦' };

const TIME_SLOTS = Array.from({ length: 21 }, (_, i) => {
  const totalMin = 7 * 60 + i * 30;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const val = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const label = `${h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  return { value: val, label };
});

const FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' }, { value: 'biweekly', label: 'Every 2 Weeks' },
  { value: 'monthly', label: 'Monthly' }, { value: 'bimonthly', label: 'Every 2 Months' },
  { value: 'quarterly', label: 'Quarterly' }, { value: 'triannual', label: 'Every 4 Months' },
];

const inputStyle = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.white, fontSize: 14, outline: 'none', boxSizing: 'border-box', minHeight: 44 };
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

  // Date/Time/Tech state
  const [apptDate, setApptDate] = useState(defaultDate || new Date().toISOString().split('T')[0]);
  const [windowStart, setWindowStart] = useState('09:00');
  const [recommendedSlots, setRecommendedSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [techMode, setTechMode] = useState('auto');
  const [techId, setTechId] = useState('');
  const [techs, setTechs] = useState([]);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFreq, setRecurringFreq] = useState('quarterly');
  const [recurringCount, setRecurringCount] = useState(4);

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

  // Fetch recommended slots when customer + service + date are set
  useEffect(() => {
    if (!selectedCustomer || !selectedService || !apptDate) return;
    let cancelled = false;
    setLoadingSlots(true);
    (async () => {
      try {
        const params = new URLSearchParams({
          customerId: selectedCustomer.id,
          serviceType: selectedService.name,
          date: apptDate,
        });
        const r = await adminFetch(`/admin/schedule/recommend-slots?${params}`);
        if (!cancelled && r.slots) setRecommendedSlots(r.slots);
      } catch { /* non-critical */ }
      if (!cancelled) setLoadingSlots(false);
    })();
    return () => { cancelled = true; };
  }, [selectedCustomer?.id, selectedService?.name, apptDate]);

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
        recurringCount: isRecurring ? recurringCount : undefined,
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
    const intervals = { weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60, quarterly: 91, triannual: 122 };
    const gap = intervals[recurringFreq] || 91;
    const dates = [];
    for (let i = 0; i < Math.min(recurringCount, 6); i++) {
      const d = new Date(apptDate + 'T12:00:00');
      d.setDate(d.getDate() + gap * i);
      dates.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    return dates;
  };

  const overlayStyle = {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: isMobile ? D.bg : 'rgba(0,0,0,0.6)',
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
          <div style={{ fontSize: 18, fontWeight: 700, color: D.white }}>New Appointment</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 22, cursor: 'pointer', minWidth: 48, minHeight: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>

        {/* Toast */}
        {toast && <div style={{ background: `${D.green}22`, border: `1px solid ${D.green}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12, color: D.green, fontSize: 14, fontWeight: 600 }}>{toast}</div>}

        {/* Section 1: Customer */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: D.white, marginBottom: 10 }}>Customer</div>
          {!selectedCustomer ? (
            <div style={{ position: 'relative' }}>
              <input ref={searchRef} type="text" value={customerSearch} onChange={(e) => doSearch(e.target.value)} placeholder="Search by name or phone..." style={inputStyle} />
              {customerResults.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: D.card, border: `1px solid ${D.border}`, borderRadius: '0 0 10px 10px', maxHeight: 240, overflowY: 'auto', zIndex: 20 }}>
                  {customerResults.map(c => (
                    <div key={c.id} onClick={() => selectCustomer(c)} style={{ padding: '12px 14px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 14, color: D.white, minHeight: 48, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong>{c.firstName} {c.lastName}</strong>
                      <span style={{ color: D.muted, fontSize: 12 }}>{c.phone || ''}</span>
                      {c.tier && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: `${TIER_COLORS[c.tier] || D.teal}22`, color: TIER_COLORS[c.tier] || D.teal }}>{c.tier}</span>}
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => setShowQuickAdd(!showQuickAdd)} style={{ background: 'none', border: 'none', color: D.teal, fontSize: 12, cursor: 'pointer', marginTop: 6, padding: '4px 0', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>+ New Customer</button>
              {showQuickAdd && (
                <div style={{ marginTop: 8, padding: 12, background: D.input, borderRadius: 10, border: `1px solid ${D.border}` }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: D.input, borderRadius: 10, padding: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: D.white, fontSize: 14 }}>{selectedCustomer.firstName} {selectedCustomer.lastName}</div>
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
          <div style={{ fontSize: 13, fontWeight: 700, color: D.white, marginBottom: 10 }}>Service</div>
          {!selectedService ? (
            <div>
              {serviceGroups.map((group, gi) => (
                <div key={gi} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: D.muted, fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {CATEGORY_EMOJI[group.category] || '📦'} {CATEGORY_LABELS[group.category] || group.category}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {group.items.map((svc, si) => (
                      <button key={si} onClick={() => setSelectedService(svc)} style={{ padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>
                        {svc.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: D.input, borderRadius: 10, padding: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: D.white, fontSize: 14 }}>{selectedService.name}</div>
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
          <div style={{ fontSize: 13, fontWeight: 700, color: D.white, marginBottom: 10 }}>Date, Time & Tech</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={labelStyle}>Date</label>
              <input type="date" value={apptDate} onChange={e => setApptDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Start Time</label>
              <select value={windowStart} onChange={e => setWindowStart(e.target.value)} style={inputStyle}>
                {TIME_SLOTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>

          {/* Recommended Slots */}
          {selectedCustomer && selectedService && (
            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>Recommended Slots</label>
              {loadingSlots ? (
                <div style={{ fontSize: 12, color: D.muted, padding: 8 }}>Finding best slots...</div>
              ) : recommendedSlots.length > 0 ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {recommendedSlots.map((slot, i) => (
                    <button key={i} onClick={() => setWindowStart(slot.start)} style={{
                      flex: 1, minWidth: isMobile ? '100%' : 140, padding: '10px 12px',
                      background: windowStart === slot.start ? `${D.teal}22` : D.input,
                      border: `1px solid ${windowStart === slot.start ? D.teal : D.border}`,
                      borderRadius: 10, cursor: 'pointer', minHeight: 48, textAlign: 'left',
                    }}>
                      <div style={{ fontWeight: 600, color: D.white, fontSize: 14 }}>{fmtTime(slot.start)}</div>
                      <div style={{ fontSize: 11, color: D.muted }}>{slot.label || `${slot.conflicts || 0} conflicts`}</div>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: D.muted, padding: 4 }}>No slot data for this date</div>
              )}
            </div>
          )}

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
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={labelStyle}>Frequency</label>
                  <select value={recurringFreq} onChange={e => setRecurringFreq(e.target.value)} style={inputStyle}>
                    {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Count</label>
                  <input type="number" min={2} max={24} value={recurringCount} onChange={e => setRecurringCount(parseInt(e.target.value) || 4)} style={inputStyle} />
                </div>
              </div>
              {recurringPreview() && (
                <div style={{ fontSize: 11, color: D.muted, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {recurringPreview().map((d, i) => (
                    <span key={i} style={{ padding: '2px 6px', background: `${D.teal}15`, borderRadius: 4 }}>{d}</span>
                  ))}
                  {recurringCount > 6 && <span style={{ padding: '2px 6px' }}>+{recurringCount - 6} more</span>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Section 4: Notes & Confirm */}
        <div style={sectionStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: D.white, marginBottom: 10 }}>Notes & Confirm</div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Customer Notes</label>
            <textarea value={customerNotes} onChange={e => setCustomerNotes(e.target.value)} rows={2} placeholder="Notes visible to customer..." style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ ...labelStyle, color: D.amber }}>Internal Notes (Admin only)</label>
            <textarea value={internalNotes} onChange={e => setInternalNotes(e.target.value)} rows={2} placeholder="Internal notes..." style={{ ...inputStyle, resize: 'vertical', minHeight: 60, borderColor: `${D.amber}33` }} />
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
