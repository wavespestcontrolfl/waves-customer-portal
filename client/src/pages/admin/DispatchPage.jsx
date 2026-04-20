import { useState, useEffect, useRef, useCallback } from 'react';
import JobFormSection from '../../components/admin/JobFormSection';
import ExpenseCapture from '../../components/admin/ExpenseCapture';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', input: '#FFFFFF',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B',
  blue: '#0A7EC2', purple: '#7C3AED', gray: '#64748B',
  text: '#334155', muted: '#64748B', white: '#FFFFFF',
  heading: '#0F172A', inputBorder: '#CBD5E1',
};

const SERVICE_TYPE_COLORS = {
  lawn: D.green, pest: D.blue, mosquito: D.purple, termite: D.amber,
};

const STATUS_CONFIG = {
  pending:    { label: 'Pending',    bg: 'transparent', color: D.amber, border: D.amber },
  confirmed:  { label: 'Confirmed',  bg: 'transparent', color: D.green, border: D.green },
  en_route:   { label: 'En Route',   bg: D.teal,        color: '#fff', border: D.teal, pulse: true },
  on_site:    { label: 'On Site',    bg: D.blue,        color: '#fff', border: D.blue },
  in_progress:{ label: 'In Progress',bg: D.blue,        color: '#fff', border: D.blue },
  completed:  { label: 'Completed',  bg: D.green,       color: '#fff', border: D.green },
  skipped:    { label: 'Skipped',    bg: D.gray,        color: '#fff', border: D.gray },
};

const QUICK_NOTES = [
  'Applied perimeter band',
  'Interior — baseboards, kitchen, baths',
  'Cobweb sweep',
  'Granular in beds',
  'Spot-treated weeds',
  'Checked bait stations',
  'Pre-emergent applied',
  'Customer not home',
];

const TIER_COLORS = {
  Platinum: { bg: '#E5E4E2', text: '#0F172A' },
  Gold:     { bg: '#FDD835', text: '#0F172A' },
  Silver:   { bg: '#90CAF9', text: '#0F172A' },
  Bronze:   { bg: '#CD7F32', text: '#fff' },
  'One-Time': { bg: '#0A7EC2', text: '#fff' },
};

/* ── Helpers ──────────────────────────────────────────── */

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

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function detectServiceCategory(serviceType) {
  const s = (serviceType || '').toLowerCase();
  if (s.includes('lawn')) return 'lawn';
  if (s.includes('mosquito')) return 'mosquito';
  if (s.includes('termite')) return 'termite';
  return 'pest';
}

function googleMapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function staticMapUrl(services) {
  if (!MAPS_KEY || !services.length) return null;
  const markers = services
    .map(s => `markers=color:red%7Clabel:${s.routeOrder}%7C${encodeURIComponent(s.address)}`)
    .join('&');
  return `https://maps.googleapis.com/maps/api/staticmap?size=600x400&maptype=roadmap&${markers}&key=${MAPS_KEY}`;
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

/* ── Status Badge ─────────────────────────────────────── */

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return (
    <span style={{
      display: 'inline-block', padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
      letterSpacing: 0.5, textTransform: 'uppercase',
      background: cfg.bg, color: cfg.color, border: `1.5px solid ${cfg.border}`,
      animation: cfg.pulse ? 'statusPulse 2s ease infinite' : 'none',
    }}>
      {cfg.label}
    </span>
  );
}

/* ── Tier Badge ───────────────────────────────────────── */

function TierBadge({ tier }) {
  if (!tier) return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: '#334155', color: '#94a3b8' }}>NO PLAN</span>;
  const c = TIER_COLORS[tier] || TIER_COLORS.Bronze;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700,
      background: c.bg, color: c.text, marginLeft: 8, verticalAlign: 'middle',
    }}>
      {tier}
    </span>
  );
}

/* ── Service Card ─────────────────────────────────────── */

function RescheduleModal({ service, onClose, onRescheduled }) {
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
    const window = { start: manualTime, end: `${endH}:${m}`, display: `${fmtTimeVal(manualTime)} - ${fmtTimeVal(`${endH}:${m}`)}` };
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

  function fmtTimeVal(t) {
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

function ServiceCard({ service, onStatusChange, onComplete, onReschedule, cardRef }) {
  const [updating, setUpdating] = useState(false);
  const cat = detectServiceCategory(service.serviceType);
  const borderColor = SERVICE_TYPE_COLORS[cat] || D.blue;
  const isLawn = cat === 'lawn';

  async function changeStatus(newStatus) {
    setUpdating(true);
    try {
      await adminFetch(`/admin/dispatch/${service.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      });
      onStatusChange(service.id, newStatus);
    } catch (e) {
      alert('Failed to update status: ' + e.message);
    }
    setUpdating(false);
  }

  const status = service.status;

  return (
    <div ref={cardRef} style={{
      background: D.card, borderRadius: 14, border: `1px solid ${D.border}`,
      borderLeft: `4px solid ${borderColor}`, padding: 20, marginBottom: 14,
      opacity: status === 'completed' || status === 'skipped' ? 0.7 : 1,
      transition: 'opacity 0.3s',
    }}>
      {/* Top row: route # + time | status badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 18, color: D.teal,
          }}>
            #{service.routeOrder}
          </span>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: D.muted,
          }}>
            {fmtTime(service.windowStart)} - {fmtTime(service.windowEnd)}
          </span>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Customer name + tier */}
      <div style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>
          {service.customerName}
        </span>
        <TierBadge tier={service.waveguardTier} />
      </div>

      {/* Address */}
      <a href={googleMapsUrl(service.address)} target="_blank" rel="noopener noreferrer" style={{
        display: 'block', fontSize: 13, color: D.muted, textDecoration: 'none', marginBottom: 4,
        cursor: 'pointer',
      }}>
        {service.address}
      </a>

      {/* Phone */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <a href={`tel:${service.customerPhone}`} style={{
          fontSize: 13, color: D.teal, textDecoration: 'none',
        }}>
          {service.customerPhone}
        </a>
        <a href={`sms:${service.customerPhone}`} style={{
          fontSize: 14, textDecoration: 'none', cursor: 'pointer',
        }}>
          💬
        </a>
      </div>

      {/* Service type */}
      <div style={{
        fontSize: 13, fontWeight: 600, color: D.text, marginBottom: 8,
        padding: '4px 10px', borderRadius: 8, background: borderColor + '18', display: 'inline-block',
      }}>
        {service.serviceType}
      </div>

      {/* Last service */}
      {service.lastServiceDate && (
        <div style={{ fontSize: 12, color: D.muted, fontStyle: 'italic', marginBottom: 8, lineHeight: 1.5 }}>
          Last: {fmtDate(service.lastServiceDate)} &mdash; {service.lastServiceType}
          {service.lastServiceNotes && (
            <> &mdash; {service.lastServiceNotes.substring(0, 120)}{service.lastServiceNotes.length > 120 ? '...' : ''}</>
          )}
        </div>
      )}

      {/* Property alerts */}
      {service.propertyAlerts && service.propertyAlerts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {service.propertyAlerts.map((alert, i) => (
            <span key={i} style={{
              fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
              background: D.amber + '22', color: D.amber, border: `1px solid ${D.amber}44`,
            }}>
              {alert}
            </span>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        {(status === 'pending' || status === 'confirmed') && (
          <button onClick={() => changeStatus('en_route')} disabled={updating} style={{
            ...btnBase, background: D.teal, color: '#fff',
          }}>
            En Route
          </button>
        )}
        {status === 'en_route' && (
          <button onClick={() => changeStatus('on_site')} disabled={updating} style={{
            ...btnBase, background: D.blue, color: '#fff',
          }}>
            On Site
          </button>
        )}
        {(status === 'on_site' || status === 'in_progress') && (
          <>
            <button onClick={() => onComplete(service)} style={{
              ...btnBase, background: D.green, color: '#fff',
            }}>
              Complete
            </button>
            <button onClick={() => changeStatus('skipped')} disabled={updating} style={{
              ...btnBase, background: D.gray, color: D.heading,
            }}>
              Skip
            </button>
          </>
        )}
        {status === 'completed' && (
          <span style={{
            ...btnBase, background: D.green + '22', color: D.green, border: `1px solid ${D.green}44`,
            cursor: 'default',
          }}>
            Completed
          </span>
        )}
        {status !== 'completed' && status !== 'skipped' && (
          <button onClick={() => onReschedule?.(service)} style={{
            ...btnBase, background: 'transparent', color: D.amber, border: `1px solid ${D.amber}44`,
          }}>
            🔄 Reschedule
          </button>
        )}
      </div>
    </div>
  );
}

const btnBase = {
  height: 48, minWidth: 120, padding: '0 20px', borderRadius: 12, border: 'none',
  fontWeight: 700, fontSize: 14, cursor: 'pointer', transition: 'all 0.2s',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
};

/* ── Completion Panel ─────────────────────────────────── */

function CompletionPanel({ service, products, onClose, onSubmit }) {
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
  const [success, setSuccess] = useState(false);
  const [elapsed, setElapsed] = useState('0:00');
  const [formResponses, setFormResponses] = useState({});
  const [formStartedAt] = useState(() => new Date().toISOString());

  const isLawn = detectServiceCategory(service.serviceType) === 'lawn';

  // find the on_site timestamp from the status log
  const onSiteEntry = (service.statusLog || []).find(e => e.status === 'on_site');
  const onSiteTime = onSiteEntry ? onSiteEntry.at : null;

  useEffect(() => {
    const iv = setInterval(() => setElapsed(elapsedSince(onSiteTime)), 1000);
    return () => clearInterval(iv);
  }, [onSiteTime]);

  function addQuickNote(text) {
    setNotes(prev => {
      if (!prev.trim()) return text;
      return prev.trimEnd() + '\n' + text;
    });
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

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const body = {
        technicianNotes: notes,
        products: selectedProducts.map(p => ({ productId: p.productId, rate: p.rate, rateUnit: p.rateUnit })),
        sendCompletionSms: sendSms,
        requestReview,
        formResponses,
        formStartedAt,
      };
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

  return (
    <>
      {/* Backdrop */}
      <div onClick={() => onClose(false)} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 999,
      }} />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: '60%', minWidth: 360, maxWidth: 640,
        background: D.bg, borderLeft: `1px solid ${D.border}`, zIndex: 1000,
        overflowY: 'auto', display: 'flex', flexDirection: 'column',
        animation: 'slideIn 0.25s ease',
      }}>
        {/* Success overlay */}
        {success && (
          <div style={{
            position: 'absolute', inset: 0, background: D.bg + 'ee', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 10, flexDirection: 'column',
          }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>&#10003;</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: D.green }}>Service Completed!</div>
          </div>
        )}

        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${D.border}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>Complete Service</div>
            <button onClick={() => onClose(false)} style={{
              background: 'none', border: 'none', color: D.muted, fontSize: 24, cursor: 'pointer', padding: 4,
            }}>&times;</button>
          </div>
          <div style={{ fontSize: 14, color: D.text, fontWeight: 600 }}>{service.customerName}</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{service.address}</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{service.serviceType}</div>
          <div style={{
            marginTop: 8, display: 'inline-block', padding: '3px 10px', borderRadius: 8,
            background: D.teal + '22', color: D.teal, fontFamily: "'JetBrains Mono', monospace",
            fontSize: 13, fontWeight: 600,
          }}>
            On site: {elapsed}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          {/* Tech Notes */}
          <label style={labelStyle}>Technician Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={5} style={{
            width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`,
            borderRadius: 10, padding: 12, fontSize: 14, resize: 'vertical',
            fontFamily: "'Nunito Sans', sans-serif", boxSizing: 'border-box',
          }} placeholder="Notes about this service..." />

          {/* Quick-note chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 20 }}>
            {QUICK_NOTES.map(qn => (
              <button key={qn} onClick={() => addQuickNote(qn)} style={{
                padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                background: D.card, color: D.text, border: `1px solid ${D.border}`,
                cursor: 'pointer', transition: 'background 0.15s',
              }}>
                {qn}
              </button>
            ))}
          </div>

          {/* Service Checklist (template-driven) */}
          <JobFormSection
            serviceType={service.serviceType}
            value={formResponses}
            onChange={setFormResponses}
          />

          {/* Products Applied */}
          <label style={labelStyle}>Products Applied</label>
          <input
            type="text" value={productSearch} onChange={e => setProductSearch(e.target.value)}
            placeholder="Search products..."
            style={inputStyle}
          />
          {productSearch && filteredProducts.length > 0 && (
            <div style={{
              background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
              maxHeight: 160, overflowY: 'auto', marginTop: 4, marginBottom: 8,
            }}>
              {filteredProducts.slice(0, 8).map(p => (
                <div key={p.id} onClick={() => addProduct(p)} style={{
                  padding: '8px 12px', fontSize: 13, color: D.text, cursor: 'pointer',
                  borderBottom: `1px solid ${D.border}`,
                }}>
                  {p.name}
                </div>
              ))}
            </div>
          )}
          {selectedProducts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, marginBottom: 20 }}>
              {selectedProducts.map(sp => (
                <div key={sp.productId} style={{
                  background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: 12,
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: D.text, flex: 1, minWidth: 120 }}>{sp.name}</span>
                  <input
                    type="number" placeholder="Rate" value={sp.rate}
                    onChange={e => updateProduct(sp.productId, 'rate', e.target.value)}
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }}
                  />
                  <select
                    value={sp.rateUnit}
                    onChange={e => updateProduct(sp.productId, 'rateUnit', e.target.value)}
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }}
                  >
                    <option value="oz">oz</option>
                    <option value="ml">ml</option>
                    <option value="g">g</option>
                    <option value="lb">lb</option>
                    <option value="gal">gal</option>
                  </select>
                  <button onClick={() => removeProduct(sp.productId)} style={{
                    background: 'none', border: 'none', color: D.red, fontSize: 18,
                    cursor: 'pointer', padding: '0 4px',
                  }}>&times;</button>
                </div>
              ))}
            </div>
          )}

          {/* Lawn Measurements */}
          {isLawn && (
            <>
              <label style={labelStyle}>Lawn Measurements</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
                <div>
                  <div style={subLabelStyle}>Soil Temp (&deg;F)</div>
                  <input type="number" value={soilTemp} onChange={e => setSoilTemp(e.target.value)}
                    placeholder="--" style={inputStyle} />
                </div>
                <div>
                  <div style={subLabelStyle}>Thatch (in)</div>
                  <input type="number" step="0.1" value={thatchMeasurement} onChange={e => setThatchMeasurement(e.target.value)}
                    placeholder="--" style={inputStyle} />
                </div>
                <div>
                  <div style={subLabelStyle}>Soil pH</div>
                  <input type="number" step="0.1" value={soilPh} onChange={e => setSoilPh(e.target.value)}
                    placeholder="--" style={inputStyle} />
                </div>
                <div>
                  <div style={subLabelStyle}>Moisture (%)</div>
                  <input type="number" value={soilMoisture} onChange={e => setSoilMoisture(e.target.value)}
                    placeholder="--" style={inputStyle} />
                </div>
              </div>
            </>
          )}

          {/* Expense / Receipt capture */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Expenses (optional)</label>
            <ExpenseCapture
              scheduledServiceId={service.id}
              customerId={service.customerId}
              technicianId={service.technicianId}
            />
          </div>

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
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: `1px solid ${D.border}`, flexShrink: 0 }}>
          <button onClick={handleSubmit} disabled={submitting} style={{
            ...btnBase, width: '100%', background: D.green, color: '#fff', fontSize: 16,
            opacity: submitting ? 0.6 : 1,
          }}>
            {submitting ? 'Completing...' : 'Complete Service'}
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

/* ── Main Dispatch Page ───────────────────────────────── */

export default function DispatchPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [activeTech, setActiveTech] = useState('All');
  const [completingService, setCompletingService] = useState(null);
  const [rescheduleService, setRescheduleService] = useState(null);
  const [weatherAlert, setWeatherAlert] = useState(null);

  const cardRefs = useRef({});

  useEffect(() => {
    Promise.all([
      adminFetch('/admin/dispatch/today'),
      adminFetch('/admin/dispatch/products/catalog'),
      adminFetch('/admin/dispatch/weather/tomorrow').catch(() => null),
    ])
      .then(([dispatchData, catalogData, weatherData]) => {
        setData(dispatchData);
        setProducts(catalogData.products || []);
        if (weatherData?.needsReschedule?.length > 0 || weatherData?.caution?.length > 0) {
          setWeatherAlert(weatherData);
        }
        setLoading(false);
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  const handleStatusChange = useCallback((serviceId, newStatus) => {
    setData(prev => {
      if (!prev) return prev;
      const updated = prev.services.map(s =>
        s.id === serviceId
          ? { ...s, status: newStatus, statusLog: [...(s.statusLog || []), { status: newStatus, at: new Date().toISOString() }] }
          : s
      );
      return { ...prev, services: updated };
    });
  }, []);

  const handleComplete = useCallback((service) => {
    setCompletingService(service);
  }, []);

  const handleCompleteSubmit = useCallback(async (serviceId, body) => {
    await adminFetch(`/admin/dispatch/${serviceId}/complete`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    handleStatusChange(serviceId, 'completed');
  }, [handleStatusChange]);

  const handlePanelClose = useCallback((wasCompleted) => {
    const completedId = completingService?.id;
    setCompletingService(null);

    // auto-scroll to next pending service
    if (wasCompleted && data) {
      const nextPending = data.services.find(s =>
        s.id !== completedId && !['completed', 'skipped'].includes(s.status)
      );
      if (nextPending && cardRefs.current[nextPending.id]) {
        setTimeout(() => {
          cardRefs.current[nextPending.id].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
      }
    }
  }, [completingService, data]);

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontSize: 15 }}>Loading dispatch...</div>;
  if (error) return <div style={{ color: D.red, padding: 60, textAlign: 'center' }}>Failed to load dispatch: {error}</div>;
  if (!data) return null;

  const services = data.services || [];
  const techs = [...new Set(services.map(s => s.technicianName).filter(Boolean))];
  const filtered = activeTech === 'All' ? services : services.filter(s => s.technicianName === activeTech);

  const totalCount = services.length;
  const completedCount = services.filter(s => s.status === 'completed').length;
  const remainingCount = totalCount - completedCount - services.filter(s => s.status === 'skipped').length;

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const mapUrl = staticMapUrl(services);

  return (
    <div>
      {/* Pulse keyframes + slide-in animation */}
      <style>{`
        @keyframes statusPulse {
          0%, 100% { box-shadow: 0 0 0 0 ${D.teal}44; }
          50% { box-shadow: 0 0 0 6px ${D.teal}00; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @media (max-width: 640px) {
          .dispatch-panel { width: 100% !important; min-width: 0 !important; }
          .dispatch-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* Header */}
      {/* Weather Alert Banner */}
      {weatherAlert && (
        <div style={{
          background: weatherAlert.needsReschedule?.length > 0 ? `${D.red}15` : `${D.amber}15`,
          border: `1px solid ${weatherAlert.needsReschedule?.length > 0 ? D.red : D.amber}44`,
          borderRadius: 12, padding: '14px 18px', marginBottom: 16,
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <span style={{ fontSize: 22 }}>{weatherAlert.needsReschedule?.length > 0 ? '🌧️' : '⛅'}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
              Tomorrow's Weather: {weatherAlert.overallConditions?.summary || 'Check forecast'}
            </div>
            {weatherAlert.needsReschedule?.length > 0 && (
              <div style={{ fontSize: 13, color: D.red, marginTop: 4 }}>
                ⚠️ {weatherAlert.needsReschedule.length} service{weatherAlert.needsReschedule.length > 1 ? 's' : ''} may need rescheduling: {weatherAlert.needsReschedule.map(s => s.customerName).join(', ')}
              </div>
            )}
            {weatherAlert.caution?.length > 0 && (
              <div style={{ fontSize: 13, color: D.amber, marginTop: 2 }}>
                ⏸️ {weatherAlert.caution.length} service{weatherAlert.caution.length > 1 ? 's' : ''} with caution: {weatherAlert.caution.map(s => s.customerName).join(', ')}
              </div>
            )}
          </div>
          <button onClick={() => setWeatherAlert(null)} style={{ background: 'none', border: 'none', color: D.muted, cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 400, color: D.heading, margin: '0 0 4px' }}>Dispatch</h1>
          <div style={{ fontSize: 13, color: D.muted }}>{today}</div>
        </div>
        <div style={{
          display: 'flex', gap: 16, alignItems: 'center', fontSize: 13, color: D.muted,
          background: D.card, padding: '8px 16px', borderRadius: 10, border: `1px solid ${D.border}`,
        }}>
          <span><strong style={{ color: D.heading }}>{totalCount}</strong> services</span>
          <span><strong style={{ color: D.green }}>{completedCount}</strong> completed</span>
          <span><strong style={{ color: D.amber }}>{remainingCount}</strong> remaining</span>
        </div>
      </div>

      {/* Tech filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <button
          onClick={() => setActiveTech('All')}
          style={{
            ...tabStyle,
            background: activeTech === 'All' ? D.teal : D.card,
            color: activeTech === 'All' ? D.white : D.muted,
            border: `1px solid ${activeTech === 'All' ? D.teal : D.border}`,
          }}
        >
          All ({totalCount})
        </button>
        {techs.map(tech => {
          const count = services.filter(s => s.technicianName === tech).length;
          const isActive = activeTech === tech;
          return (
            <button key={tech} onClick={() => setActiveTech(tech)} style={{
              ...tabStyle,
              background: isActive ? D.teal : D.card,
              color: isActive ? D.white : D.muted,
              border: `1px solid ${isActive ? D.teal : D.border}`,
            }}>
              {tech} ({count})
            </button>
          );
        })}
      </div>

      {/* Map */}
      {mapUrl && (
        <div style={{
          marginBottom: 20, borderRadius: 12, overflow: 'hidden', border: `1px solid ${D.border}`,
        }}>
          <img src={mapUrl} alt="Today's route map" style={{ width: '100%', height: 'auto', display: 'block' }} />
        </div>
      )}

      {/* Service Cards */}
      <div>
        {filtered.length === 0 && (
          <div style={{ color: D.muted, textAlign: 'center', padding: 40, fontSize: 14 }}>
            No services scheduled{activeTech !== 'All' ? ` for ${activeTech}` : ''}.
          </div>
        )}
        {filtered.map(service => (
          <ServiceCard
            key={service.id}
            service={service}
            onStatusChange={handleStatusChange}
            onComplete={handleComplete}
            onReschedule={svc => setRescheduleService(svc)}
            cardRef={el => { if (el) cardRefs.current[service.id] = el; }}
          />
        ))}
      </div>

      {/* Completion Panel */}
      {completingService && (
        <CompletionPanel
          service={completingService}
          products={products}
          onClose={handlePanelClose}
          onSubmit={handleCompleteSubmit}
        />
      )}

      {/* Reschedule Modal */}
      {rescheduleService && (
        <RescheduleModal
          service={rescheduleService}
          onClose={() => setRescheduleService(null)}
          onRescheduled={() => {
            setRescheduleService(null);
            // Refresh dispatch data
            adminFetch('/admin/dispatch/today').then(setData).catch(console.error);
          }}
        />
      )}
    </div>
  );
}

const tabStyle = {
  padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600,
  cursor: 'pointer', transition: 'all 0.15s',
};
