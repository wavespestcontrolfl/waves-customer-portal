import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';

const TechMatchPanel = lazy(() => import('../../components/dispatch/TechMatchPanel'));
const CSRPanel = lazy(() => import('../../components/dispatch/CSRPanel'));
const RevenuePanel = lazy(() => import('../../components/dispatch/RevenuePanel'));
const InsightsPanel = lazy(() => import('../../components/dispatch/InsightsPanel'));
import { ViewModeSelector, WeekView, MonthView } from '../../components/schedule/CalendarViews';
import CreateAppointmentModal from '../../components/schedule/CreateAppointmentModal';
import ScheduleIntelligenceBar from '../../components/admin/ScheduleIntelligenceBar';
import HorizontalScroll from '../../components/HorizontalScroll';
import useIsMobile from '../../hooks/useIsMobile';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', input: '#FFFFFF',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B',
  blue: '#0A7EC2', purple: '#7C3AED', gray: '#64748B',
  text: '#334155', muted: '#64748B', white: '#FFFFFF',
  heading: '#0F172A', inputBorder: '#CBD5E1',
};

const STATUS_CONFIG = {
  pending:   { label: 'Pending',   bg: 'transparent', color: D.amber, border: D.amber },
  confirmed: { label: 'Confirmed', bg: 'transparent', color: D.green, border: D.green },
  en_route:  { label: 'En Route',  bg: D.teal,        color: '#fff', border: D.teal, pulse: true },
  on_site:   { label: 'On Site',   bg: D.blue,        color: '#fff', border: D.blue },
  completed: { label: 'Completed', bg: D.green,       color: '#fff', border: D.green },
  skipped:   { label: 'Skipped',   bg: D.gray,        color: '#fff', border: D.gray, strike: true },
};

const TIER_COLORS = {
  Platinum: { bg: '#E5E4E2', text: '#0F172A' },
  Gold:     { bg: '#FDD835', text: '#0F172A' },
  Silver:   { bg: '#90CAF9', text: '#0F172A' },
  Bronze:   { bg: '#CD7F32', text: '#fff' },
  'One-Time': { bg: '#0A7EC2', text: '#fff' },
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
    .replace(/https?:\/\/app\.squareup\.com\S*/g, '')
    .replace(/https?:\/\/squareup\.com\S*/g, '')
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

function sanitizeServiceTypeClient(serviceType) {
  if (!serviceType) return 'General Service';
  if (/^[A-Z0-9]{5,}$/.test(serviceType)) return 'General Service';
  // Strip common legacy suffixes: " - 1 hour", " - $117", " - 45 min"
  return serviceType
    .replace(/\s*[-\u2013]\s*\d+\s*(hour|hr|min|minute)s?\b/gi, '')
    .replace(/\s*[-\u2013]\s*\$[\d,.]+/g, '')
    .replace(/\s*[-\u2013]\s*$/g, '')
    .trim() || 'General Service';
}

function formatLastServiceDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return null;
  }
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

function formatDateISO(d) {
  return d.toISOString().split('T')[0];
}

function formatDateDisplay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function isToday(dateStr) {
  return dateStr === formatDateISO(new Date());
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
      textDecoration: cfg.strike ? 'line-through' : 'none',
    }}>
      {cfg.label}
    </span>
  );
}

/* ── Tier Badge ───────────────────────────────────────── */

function TierBadge({ tier }) {
  if (!tier) return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: '#334155', color: '#94a3b8', marginLeft: 8, verticalAlign: 'middle' }}>NO PLAN</span>;
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

/* ── Lead Score ───────────────────────────────────────── */

function LeadScoreBadge({ score }) {
  if (score == null) return null;
  const color = score >= 80 ? D.green : score >= 50 ? D.amber : D.muted;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 6, fontSize: 10, fontWeight: 700,
      background: color + '22', color, marginLeft: 6, verticalAlign: 'middle',
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      LS {score}
    </span>
  );
}

/* ── Property Alert Badge ─────────────────────────────── */

function PropertyAlerts({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
      {alerts.map((alert, i) => {
        const isRed = alert.type === 'chemical_sensitivity';
        const c = isRed ? D.red : D.amber;
        return (
          <span key={i} style={{
            fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
            background: c + '22', color: c, border: `1px solid ${c}44`,
          }}>
            {alert.text || alert}
          </span>
        );
      })}
    </div>
  );
}

/* ── Service Card ─────────────────────────────────────── */

function ServiceCard({ service, zoneColors, onStatusChange, onComplete, onReschedule, onDelete, onProtocol, onLawnPhotos, onEdit }) {
  const [updating, setUpdating] = useState(false);
  const [lawnUploading, setLawnUploading] = useState(false);
  const [lawnDone, setLawnDone] = useState(false);
  const [showSkipReasons, setShowSkipReasons] = useState(false);
  const [editQuery, setEditQuery] = useState('');
  const [serviceResults, setServiceResults] = useState([]);
  const [showServiceResults, setShowServiceResults] = useState(false);
  const lawnFileRef = useRef(null);

  useEffect(() => {
    if (!service._editing) { setShowServiceResults(false); setServiceResults([]); return; }
    if (editQuery.length < 2) { setServiceResults([]); return; }
    const t = setTimeout(() => {
      adminFetch(`/admin/services?search=${encodeURIComponent(editQuery)}&is_active=true&limit=10`)
        .then(d => setServiceResults(d.services || []))
        .catch(() => setServiceResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [editQuery, service._editing]);

  const pickServiceFromLibrary = (svc) => {
    service._editType = svc.name;
    if (svc.default_duration_minutes) service._editDuration = String(svc.default_duration_minutes);
    setEditQuery(svc.name);
    setShowServiceResults(false);
    setServiceResults([]);
    setUpdating(u => !u);
  };
  const zoneColor = zoneColors?.[service.zone] || service.zoneColor || D.blue;
  const status = service.status;
  const isLawn = detectServiceCategory(service.serviceType) === 'lawn';

  async function handleLawnPhotos(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setLawnUploading(true);
    try {
      const photoData = await Promise.all(files.map(f => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ data: reader.result.split(',')[1], mimeType: f.type || 'image/jpeg' });
        reader.onerror = reject;
        reader.readAsDataURL(f);
      })));
      await adminFetch('/admin/lawn-assessment/assess', {
        method: 'POST',
        body: JSON.stringify({ customerId: service.customerId, photos: photoData }),
      });
      setLawnDone(true);
      onLawnPhotos?.(service);
    } catch (err) {
      alert('Lawn assessment failed: ' + err.message);
    }
    setLawnUploading(false);
    if (lawnFileRef.current) lawnFileRef.current.value = '';
  }

  async function changeStatus(newStatus) {
    setUpdating(true);
    try {
      await adminFetch(`/admin/schedule/${service.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus }),
      });
      onStatusChange(service.id, newStatus);
    } catch (e) {
      alert('Failed to update status: ' + e.message);
    }
    setUpdating(false);
  }

  return (
    <div style={{
      background: D.card, borderRadius: 14, border: `1px solid ${D.border}`,
      borderLeft: `4px solid ${zoneColor}`, padding: 18, marginBottom: 12,
      opacity: status === 'completed' || status === 'skipped' ? 0.65 : 1,
      transition: 'opacity 0.3s',
    }}>
      {/* Top row: route # + time | status badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 18, color: D.teal,
          }}>
            #{service.routeOrder}
          </span>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: D.muted,
          }}>
            {service.windowDisplay || ''}
          </span>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Customer name + tier + lead score */}
      <div style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>
          {service.customerName}
        </span>
        <TierBadge tier={service.waveguardTier} />
        <LeadScoreBadge score={service.leadScore} />
      </div>

      {/* Address + phone */}
      <a href={googleMapsUrl(service.address)} target="_blank" rel="noopener noreferrer" style={{
        display: 'block', fontSize: 13, color: D.muted, textDecoration: 'none', marginBottom: 4,
      }}>
        {service.address}
      </a>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: D.text, fontFamily: "'JetBrains Mono', monospace" }}>
          {service.customerPhone}
        </span>
        <button
          type="button"
          title="Call via Waves number"
          onClick={async () => {
            if (!service.customerPhone) return;
            if (!window.confirm(`Call ${service.customerName || 'customer'} at ${service.customerPhone}?\n\nWaves will call your phone first — press 1 to connect.`)) return;
            try {
              const r = await adminFetch('/admin/communications/call', {
                method: 'POST',
                body: JSON.stringify({ to: service.customerPhone }),
              });
              if (!r?.success) alert('Call failed: ' + (r?.error || 'unknown error'));
            } catch (e) { alert('Call failed: ' + e.message); }
          }}
          style={{ fontSize: 14, background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}
        >
          📞
        </button>
        <a
          href={`/admin/communications?phone=${encodeURIComponent(service.customerPhone || '')}`}
          title="Open internal messenger"
          style={{ fontSize: 14, textDecoration: 'none', cursor: 'pointer' }}
        >
          💬
        </a>
      </div>

      {/* Service type + duration — editable, with category color and icon */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        {service._editing ? (
          <>
            <div style={{ position: 'relative' }}>
              <input
                value={service._editType !== undefined ? service._editType : (service.serviceType || '')}
                onChange={e => {
                  service._editType = e.target.value;
                  setEditQuery(e.target.value);
                  setShowServiceResults(true);
                  setUpdating(u => !u);
                }}
                onFocus={() => {
                  if (!editQuery) setEditQuery(service._editType ?? service.serviceType ?? '');
                  setShowServiceResults(true);
                }}
                onBlur={() => setTimeout(() => setShowServiceResults(false), 150)}
                placeholder="Search service library..."
                style={{ fontSize: 13, fontWeight: 600, color: D.text, padding: '4px 10px', borderRadius: 8, background: D.input, border: `1px solid ${D.border}`, width: 200, outline: 'none' }}
              />
              {showServiceResults && serviceResults.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, minWidth: 280, background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, zIndex: 30, maxHeight: 240, overflow: 'auto', marginTop: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.12)' }}>
                  {serviceResults.map(svc => (
                    <div
                      key={svc.id}
                      onMouseDown={e => { e.preventDefault(); pickServiceFromLibrary(svc); }}
                      style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`, fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ color: D.text, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{svc.name}</div>
                        {svc.short_name && svc.short_name !== svc.name && (
                          <div style={{ color: D.muted, fontSize: 10, marginTop: 2 }}>{svc.short_name}</div>
                        )}
                      </div>
                      {svc.default_duration_minutes && (
                        <span style={{ color: D.muted, fontSize: 10, whiteSpace: 'nowrap' }}>
                          {svc.default_duration_minutes}m
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <input type="number" value={service._editDuration || service.estimatedDuration || 30} onChange={e => {
              service._editDuration = e.target.value;
              setUpdating(u => !u);
            }} style={{ fontSize: 12, color: D.text, padding: '4px 8px', borderRadius: 8, background: D.input, border: `1px solid ${D.border}`, width: 50, outline: 'none' }} />
            <span style={{ fontSize: 11, color: D.muted }}>min</span>
            <button onClick={async () => {
              try {
                await adminFetch(`/admin/schedule/${service.id}/update-details`, {
                  method: 'PUT',
                  body: JSON.stringify({ serviceType: service._editType || service.serviceType, estimatedDuration: parseInt(service._editDuration || service.estimatedDuration || 30) }),
                });
                service.serviceType = service._editType || service.serviceType;
                service.estimatedDuration = parseInt(service._editDuration || service.estimatedDuration || 30);
                service._editing = false;
                setUpdating(u => !u);
              } catch (e) { alert('Save failed: ' + e.message); }
            }} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, border: 'none', background: D.green, color: '#fff', cursor: 'pointer' }}>Save</button>
            <button onClick={() => { service._editing = false; setUpdating(u => !u); }} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, border: 'none', background: 'transparent', color: D.muted, cursor: 'pointer' }}>Cancel</button>
          </>
        ) : (
          <>
            <span style={{
              fontSize: 13, fontWeight: 600, color: D.text,
              padding: '4px 10px', borderRadius: 8,
              background: (service.serviceCategoryColor || zoneColor) + '18',
              display: 'inline-block',
              cursor: 'pointer',
            }} onClick={() => { service._editing = true; setUpdating(u => !u); }}>
              {service.serviceIcon || ''} {sanitizeServiceTypeClient(service.serviceType)}
            </span>
            {service.estimatedDuration && (
              <span style={{ fontSize: 12, color: D.muted, cursor: 'pointer' }} onClick={() => { service._editing = true; setUpdating(u => !u); }}>
                ~{service.estimatedDuration} min
              </span>
            )}
          </>
        )}
      </div>

      {/* Property alerts */}
      <PropertyAlerts alerts={service.propertyAlerts} />

      {/* Communication status icons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <span title={service.reminderSent ? 'Reminder sent' : 'Reminder pending'} style={{
          fontSize: 11, color: service.reminderSent ? D.green : D.gray,
          display: 'flex', alignItems: 'center', gap: 3,
        }}>
          {service.reminderSent ? '\u2713' : '\u25CB'} Reminder
        </span>
        <span title={service.customerConfirmed ? 'Customer confirmed' : 'Not confirmed'} style={{
          fontSize: 11, color: service.customerConfirmed ? D.green : D.gray,
          display: 'flex', alignItems: 'center', gap: 3,
        }}>
          {service.customerConfirmed ? '\u2713' : '\u25CB'} Confirmed
        </span>
        <span title={service.enRouteSent ? 'En route sent' : 'En route not sent'} style={{
          fontSize: 11, color: service.enRouteSent ? D.green : D.gray,
          display: 'flex', alignItems: 'center', gap: 3,
        }}>
          {service.enRouteSent ? '\u2713' : '\u25CB'} En Route
        </span>
      </div>

      {/* Last service info — with safe date handling */}
      {service.lastServiceDate && (
        <div style={{ fontSize: 12, color: D.muted, fontStyle: 'italic', marginBottom: 8, lineHeight: 1.5 }}>
          Last: {(() => {
            try {
              const d = new Date(service.lastServiceDate + 'T12:00:00');
              return isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            } catch { return 'Unknown date'; }
          })()}
          {service.lastServiceType && <> {'\u2014'} {service.lastServiceType}</>}
          {service.lastServiceNotes && (() => {
            const cleaned = stripLegacyBoilerplate(service.lastServiceNotes);
            if (!cleaned) return null;
            return <> {'\u2014'} {cleaned.substring(0, 100)}{cleaned.length > 100 ? '...' : ''}</>;
          })()}
        </div>
      )}
      {!service.lastServiceDate && !service.isNewCustomer && (
        <div style={{ fontSize: 12, color: D.muted, fontStyle: 'italic', marginBottom: 8 }}>
          No previous service on record
        </div>
      )}

      {/* Materials needed */}
      {service.materialsNeeded && service.materialsNeeded.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {service.materialsNeeded.map((m, i) => (
            <span key={i} style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 6,
              background: D.teal + '18', color: D.teal, fontWeight: 600,
            }}>
              {m}
            </span>
          ))}
        </div>
      )}

      {/* Action buttons — flexible flow, en route is optional */}
      <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        {status !== 'completed' && status !== 'skipped' && (
          <>
            {status !== 'en_route' && status !== 'on_site' && (
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
            <button onClick={() => onComplete(service)} style={{
              ...btnBase, background: D.green, color: '#fff',
            }}>
              Complete
            </button>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <button onClick={() => setShowSkipReasons(!showSkipReasons)} disabled={updating} style={{
                ...btnBase, background: 'transparent', color: D.gray, border: `1px solid ${D.border}`,
              }}>
                Skip
              </button>
              {showSkipReasons && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50,
                  background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
                  padding: 4, minWidth: 200, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                }}>
                  {SKIP_REASONS.map(r => (
                    <button key={r.value} onClick={async () => {
                      setUpdating(true);
                      setShowSkipReasons(false);
                      try {
                        await adminFetch(`/admin/schedule/${service.id}/status`, {
                          method: 'PUT',
                          body: JSON.stringify({ status: 'skipped', notes: `Skip reason: ${r.label}` }),
                        });
                        onStatusChange(service.id, 'skipped');
                      } catch (e) { alert('Failed: ' + e.message); }
                      setUpdating(false);
                    }} style={{
                      display: 'block', width: '100%', padding: '8px 12px', border: 'none',
                      background: 'transparent', color: D.text, fontSize: 12, textAlign: 'left',
                      cursor: 'pointer', borderRadius: 6,
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = D.border + '44'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
        {/* Protocol button — always visible */}
        <button onClick={() => onProtocol?.(service)} style={{
          ...btnBase, background: 'transparent', color: D.teal, border: `1px solid ${D.teal}44`,
        }}>
          📋 Protocol
        </button>
        {/* Lawn photo upload — only for lawn services */}
        {isLawn && !lawnDone && (
          <>
            <input ref={lawnFileRef} type="file" accept="image/*" multiple capture="environment"
              onChange={handleLawnPhotos} style={{ display: 'none' }} />
            <button onClick={() => lawnFileRef.current?.click()} disabled={lawnUploading} style={{
              ...btnBase, background: 'transparent', color: D.green, border: `1px solid ${D.green}44`,
            }}>
              {lawnUploading ? '⏳ Analyzing...' : '📷 Lawn Photos'}
            </button>
          </>
        )}
        {isLawn && lawnDone && (
          <span style={{
            ...btnBase, background: D.green + '22', color: D.green, border: `1px solid ${D.green}44`,
            cursor: 'default',
          }}>
            ✅ Lawn Assessed
          </span>
        )}
        <button
          onClick={() => onEdit?.(service)}
          style={{
            ...btnBase, background: 'transparent', color: D.teal, border: `1px solid ${D.teal}44`,
          }}
        >
          ✏️ Edit
        </button>
        {status !== 'completed' && status !== 'skipped' && (
          <>
            <button onClick={() => onReschedule?.(service)} style={{
              ...btnBase, background: 'transparent', color: D.amber, border: `1px solid ${D.amber}44`,
            }}>
              🔄 Reschedule
            </button>
            <button onClick={() => onDelete?.(service)} style={{
              ...btnBase, background: 'transparent', color: D.red, border: `1px solid ${D.red}44`,
            }}>
              🗑 Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const btnBase = {
  height: 44, minWidth: 110, padding: '0 18px', borderRadius: 12, border: 'none',
  fontWeight: 700, fontSize: 13, cursor: 'pointer', transition: 'all 0.2s',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
};

/* ── Tech Section (collapsible) ───────────────────────── */

function groupMultiServiceStops(services) {
  const groups = {};
  const singles = [];
  services.forEach(svc => {
    const key = `${svc.customerId || svc.customer_id || ''}_${svc.scheduledDate || ''}_${svc.windowStart || ''}`;
    if (!svc.customerId && !svc.customer_id) {
      singles.push(svc);
      return;
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(svc);
  });
  const result = [];
  Object.values(groups).forEach(group => {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      // Create a consolidated entry: use first service as base, attach extra types
      const primary = { ...group[0] };
      primary._multiServices = group;
      primary._extraServiceTypes = group.slice(1).map(s => sanitizeServiceTypeClient(s.serviceType));
      result.push(primary);
    }
  });
  return [...result, ...singles];
}

function TechSection({ tech, zoneColors, zoneLabels, onStatusChange, onComplete, onReschedule, onDelete, onProtocol, onEdit }) {
  const [collapsed, setCollapsed] = useState(false);

  const completedCount = tech.completedServices || tech.services.filter(s => s.status === 'completed').length;
  const totalHrs = Math.round(((tech.estimatedServiceMinutes || 0) + (tech.estimatedDriveMinutes || 0)) / 60 * 10) / 10;
  const consolidatedServices = groupMultiServiceStops(tech.services);

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Tech header */}
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          background: D.card, borderRadius: 12, border: `1px solid ${D.border}`,
          padding: '14px 18px', cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        }}
      >
        {/* Initials badge */}
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: D.teal,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: 15, color: D.heading, flexShrink: 0,
        }}>
          {tech.initials || tech.technicianName?.split(' ').map(w => w[0]).join('').toUpperCase() || '?'}
        </div>

        {/* Name + stats */}
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>
            {tech.technicianName}
            <span style={{ fontSize: 13, fontWeight: 400, color: D.muted, marginLeft: 10 }}>
              {completedCount}/{tech.totalServices || tech.services.length} done · ~{totalHrs}h
            </span>
          </div>

          {/* Zone breakdown dots */}
          {tech.zones && (
            <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
              {Object.entries(tech.zones).map(([zone, count]) => (
                <span key={zone} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: D.muted }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: zoneColors?.[zone] || D.blue, display: 'inline-block',
                  }} />
                  {zoneLabels?.[zone] || zone} ({count})
                </span>
              ))}
            </div>
          )}

          {/* Load list */}
          {tech.loadList && tech.loadList.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {tech.loadList.map((item, i) => (
                <span key={i} style={{
                  fontSize: 10, padding: '2px 7px', borderRadius: 6,
                  background: D.teal + '18', color: D.teal, fontWeight: 600,
                }}>
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Collapse chevron */}
        <span style={{ fontSize: 18, color: D.muted, transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
          ▾
        </span>
      </div>

      {/* Service cards */}
      {!collapsed && (
        <div style={{ paddingLeft: 20, paddingTop: 12 }}>
          {consolidatedServices.map(svc => (
            <div key={svc.id}>
              {svc._extraServiceTypes && svc._extraServiceTypes.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap', paddingLeft: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Multi-service stop:
                  </span>
                  {[sanitizeServiceTypeClient(svc.serviceType), ...svc._extraServiceTypes].map((t, i) => (
                    <span key={i} style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                      background: D.teal + '18', color: D.teal, border: `1px solid ${D.teal}33`,
                    }}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <ServiceCard
                service={svc}
                zoneColors={zoneColors}
                onStatusChange={onStatusChange}
                onComplete={onComplete}
                onReschedule={onReschedule}
                onDelete={onDelete}
                onProtocol={onProtocol}
                onEdit={onEdit}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : new Date().toISOString().split('T')[0];
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

  const labelStyle = { fontSize: 12, fontWeight: 600, color: D.muted, marginBottom: 4, display: 'block' };
  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 8, background: D.input,
    color: D.text, border: `1px solid ${D.inputBorder}`, fontSize: 14, outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: D.card, borderRadius: 14, border: `1px solid ${D.border}`,
        width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto', padding: 24,
      }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, marginBottom: 4 }}>Edit Service</div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 18 }}>
          {service.customerName} — {service.address || ''}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Date</label>
            <input type="date" value={form.scheduledDate} onChange={e => update('scheduledDate', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Duration (min)</label>
            <input type="number" value={form.estimatedDuration} onChange={e => update('estimatedDuration', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Window Start</label>
            <input type="time" value={form.windowStart} onChange={e => update('windowStart', e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Window End</label>
            <input type="time" value={form.windowEnd} onChange={e => update('windowEnd', e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Service Type</label>
          {!editingServiceType ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#F8FAFC', borderRadius: 8, padding: '10px 12px', border: `1px solid ${D.inputBorder}` }}>
              <div style={{ flex: 1, fontSize: 14, color: D.heading, fontWeight: 600 }}>
                {form.serviceType || <span style={{ color: D.muted, fontWeight: 400 }}>— Select service —</span>}
              </div>
              <button type="button" onClick={() => setEditingServiceType(true)} style={{
                padding: '6px 12px', borderRadius: 6, background: `${D.teal}15`, color: D.teal,
                border: `1px solid ${D.teal}55`, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}>Change</button>
            </div>
          ) : (
            <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${D.inputBorder}`, borderRadius: 8, padding: 6, background: '#F8FAFC' }}>
              {serviceGroups.map((group) => {
                const isOpen = expandedCategory === group.category;
                return (
                  <div key={group.category} style={{ marginBottom: 4 }}>
                    <button type="button" onClick={() => setExpandedCategory(isOpen ? null : group.category)} style={{
                      width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6,
                      background: isOpen ? `${D.teal}15` : D.card, border: `1px solid ${D.border}`,
                      color: D.heading, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <span>{EDIT_CATEGORY_EMOJI[group.category] || '📦'} {EDIT_CATEGORY_LABELS[group.category] || group.category} <span style={{ color: D.muted, fontWeight: 400, marginLeft: 4 }}>({group.items.length})</span></span>
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
                          }} style={{
                            padding: '8px 10px', background: D.card, border: `1px solid ${D.border}`,
                            borderRadius: 6, color: D.text, fontSize: 13, cursor: 'pointer', textAlign: 'left',
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

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Technician</label>
            <select value={form.technicianId} onChange={e => update('technicianId', e.target.value)} style={inputStyle}>
              <option value="">— Unassigned —</option>
              {(technicians || []).map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Route #</label>
            <input type="number" value={form.routeOrder} onChange={e => update('routeOrder', e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Price ($)</label>
          <input type="number" min={0} step={0.01} value={form.price} onChange={e => update('price', e.target.value)} placeholder="0.00" style={inputStyle} />
          {discountType && discountAmount !== '' && form.price !== '' && !isNaN(parseFloat(form.price)) && (
            <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>
              After discount: <span style={{ color: D.green, fontWeight: 700 }}>${Math.max(0, discountType === 'percentage' ? parseFloat(form.price) * (1 - Number(discountAmount) / 100) : parseFloat(form.price) - Number(discountAmount)).toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* Recurring toggle (same pattern as New Appointment) */}
        <div style={{ marginBottom: 12, padding: 12, background: '#F8FAFC', border: `1px solid ${D.border}`, borderRadius: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: isRecurring ? 10 : 0 }}>
            <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} style={{ width: 16, height: 16, accentColor: D.teal }} />
            <span style={{ fontSize: 13, color: D.heading, fontWeight: 600 }}>Make Recurring</span>
            <span style={{ fontSize: 11, color: D.muted }}>— creates future appointments from this date</span>
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
                    {EDIT_FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
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
                      {EDIT_NTH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Weekday</label>
                    <select value={recurringWeekday} onChange={e => setRecurringWeekday(parseInt(e.target.value))} style={inputStyle}>
                      {EDIT_WEEKDAY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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
              <div style={{ marginBottom: 8 }}>
                <label style={labelStyle}>Manual Discount (optional)</label>
                <select value={discountPresetId} onChange={e => applyDiscountPreset(e.target.value)} style={inputStyle}>
                  <option value="">None</option>
                  {discountPresets.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.icon ? `${d.icon} ` : ''}{d.name} — {d.discount_type === 'percentage' ? `${Number(d.amount).toFixed(d.amount % 1 ? 2 : 0)}%` : `$${Number(d.amount).toFixed(2)}`}
                    </option>
                  ))}
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {discountPresetId === 'custom' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div>
                    <label style={labelStyle}>Type</label>
                    <select value={discountType} onChange={e => setDiscountType(e.target.value)} style={inputStyle}>
                      <option value="">—</option>
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
              )}
              {recurringPreview() && (
                <div style={{ fontSize: 11, color: D.muted, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {recurringPreview().map((d, i) => (
                    <span key={i} style={{ padding: '2px 6px', background: `${D.teal}15`, borderRadius: 4, color: D.teal, fontWeight: 600 }}>{d}</span>
                  ))}
                  {recurringOngoing
                    ? <span style={{ padding: '2px 6px', color: D.muted }}>… then auto-extends</span>
                    : (recurringCount > 6 && <span style={{ padding: '2px 6px', color: D.muted }}>+{recurringCount - 6} more</span>)}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={labelStyle}>Notes</label>
          <textarea value={form.notes} onChange={e => update('notes', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 16, padding: '10px 12px', background: '#F8FAFC', border: `1px solid ${D.border}`, borderRadius: 8 }}>
          <input type="checkbox" checked={createInvoice} onChange={e => setCreateInvoice(e.target.checked)} style={{ width: 16, height: 16, accentColor: D.green }} />
          <span style={{ fontSize: 13, color: D.heading, fontWeight: 600 }}>Create invoice on completion</span>
          <span style={{ fontSize: 11, color: D.muted }}>— invoice + pay link sent in the service-complete SMS</span>
        </label>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{
            padding: '10px 18px', borderRadius: 8, background: 'transparent',
            color: D.muted, border: `1px solid ${D.border}`, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{
            padding: '10px 20px', borderRadius: 8, background: D.teal, color: '#fff',
            border: 'none', fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1,
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
        <div style={{ padding: '16px 24px', borderTop: `1px solid ${D.border}`, flexShrink: 0 }}>
          <button onClick={handleSubmit} disabled={submitting} style={{
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

/* Parse product lines and attach descriptions */
function parseProductLines(text) {
  if (!text) return [];
  return text.split('\n').filter(l => l.trim()).map(line => {
    const clean = line.replace(/^\u2605\s*/, '').replace(/^IF\s+.*?:\s*/, '').trim();
    const nameMatch = clean.match(/^([A-Za-z][A-Za-z0-9\s\-+/.]+?)(?:\s+(?:split|liquid|broadleaf|preventive|fert|foliar|biostimulant|drought|wetting|late|curative|PGR)|\s*\(|\s*\$|$)/i);
    const productName = nameMatch ? nameMatch[1].trim().toLowerCase() : '';
    // Try matching product descriptions
    let desc = null;
    for (const [key, val] of Object.entries(PRODUCT_DESCRIPTIONS)) {
      if (productName.includes(key) || clean.toLowerCase().includes(key)) {
        desc = val;
        break;
      }
    }
    return { raw: line, description: desc };
  });
}

/* Tier dot component */
function TierDot({ active, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginRight: 6 }}>
      <span style={{
        display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
        background: active ? D.green : 'transparent',
        border: `2px solid ${active ? D.green : D.gray}`,
      }} />
      <span style={{ fontSize: 10, fontWeight: 600, color: active ? D.green : D.muted }}>{label}</span>
    </span>
  );
}

/* Tier dots row with legend */
function TierDots({ tiers, tier4x, tier6x }) {
  if (tiers) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <TierDot active={tiers.bronze} label="B" />
        <TierDot active={tiers.silver} label="S" />
        <TierDot active={tiers.enhanced} label="E" />
        <TierDot active={tiers.premium} label="P" />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <TierDot active={tier4x} label="4x" />
      <TierDot active={tier6x} label="6x" />
    </div>
  );
}

/* Current Visit Card — the hero card shown by default */
function CurrentVisitCard({ visit, trackName }) {
  if (!visit) return null;
  const primaryProducts = parseProductLines(visit.primary);
  const secondaryProducts = parseProductLines(visit.secondary);
  const totalCost = (parseFloat(visit.material_cost) || 0) + (parseFloat(visit.labor_cost) || 0);

  // Extract weather gates and warnings from notes
  const warnings = [];
  if (visit.notes) {
    const parts = visit.notes.split(/\.\s+|\n/).filter(Boolean);
    parts.forEach(p => {
      const lower = p.toLowerCase();
      if (lower.includes('weather') || lower.includes('>90') || lower.includes('<85') || lower.includes('celsius') && lower.includes('app') || lower.includes('threshold') || lower.includes('blackout')) {
        warnings.push(p.trim().replace(/^\u2605\s*/, ''));
      }
    });
  }

  return (
    <div style={{
      background: D.card, border: `2px solid ${D.teal}`, borderRadius: 14,
      overflow: 'hidden', marginBottom: 8,
    }}>
      {/* Visit header */}
      <div style={{
        padding: '14px 16px', background: D.teal + '18',
        borderBottom: `1px solid ${D.teal}44`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: D.teal, letterSpacing: 0.5 }}>
            VISIT {visit.visit} — {visit.month?.toUpperCase()}
          </div>
          <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>{trackName}</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <TierDots tiers={visit.tiers} tier4x={visit.tier_4x} tier6x={visit.tier_6x} />
        </div>
      </div>

      <div style={{ padding: '14px 16px' }}>
        {/* Primary Products */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Primary Products</div>
          {primaryProducts.map((p, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 13, color: D.text, lineHeight: 1.4 }}>{p.raw}</div>
              {p.description && (
                <div style={{ fontSize: 11, color: D.muted, marginLeft: 12, fontStyle: 'italic', lineHeight: 1.3 }}>{p.description}</div>
              )}
            </div>
          ))}
        </div>

        {/* Secondary / Conditional */}
        {secondaryProducts.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Secondary / Conditional</div>
            {secondaryProducts.map((p, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 13, color: D.muted, lineHeight: 1.4 }}>{p.raw}</div>
                {p.description && (
                  <div style={{ fontSize: 11, color: D.gray, marginLeft: 12, fontStyle: 'italic', lineHeight: 1.3 }}>{p.description}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {warnings.map((w, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4,
                padding: '6px 10px', background: D.amber + '14', borderRadius: 6,
                border: `1px solid ${D.amber}33`,
              }}>
                <span style={{ color: D.amber, fontSize: 13, flexShrink: 0 }}>{'\u26a0\ufe0f'}</span>
                <span style={{ fontSize: 12, color: D.amber, lineHeight: 1.4 }}>{w}</span>
              </div>
            ))}
          </div>
        )}

        {/* Cost summary */}
        <div style={{
          display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
          padding: '10px 12px', background: D.bg, borderRadius: 8,
          border: `1px solid ${D.border}`,
        }}>
          <div style={{ fontSize: 12, color: D.muted }}>
            Materials: <span style={{ color: D.amber, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>${visit.material_cost || '0'}</span>
          </div>
          <div style={{ fontSize: 12, color: D.muted }}>
            Labor: <span style={{ color: D.text, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>${visit.labor_cost || '0'}</span>
          </div>
          <div style={{ fontSize: 13, color: D.green, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", marginLeft: 'auto' }}>
            Total: ${totalCost.toFixed(2)}
          </div>
        </div>

        {/* Notes/SOP */}
        {visit.notes && stripLegacyBoilerplate(visit.notes) && (
          <div style={{ marginTop: 10, fontSize: 12, color: D.muted, lineHeight: 1.5, padding: '8px 10px', background: D.bg + '88', borderRadius: 6 }}>
            {stripLegacyBoilerplate(visit.notes)}
          </div>
        )}
      </div>
    </div>
  );
}

export function ProtocolReferenceTab() {
  const [programs, setPrograms] = useState(null);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [trackData, setTrackData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showFullCalendar, setShowFullCalendar] = useState(false);

  useEffect(() => {
    adminFetch('/admin/protocols/programs').then(d => { setPrograms(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const loadTrack = async (key) => {
    setSelectedTrack(key);
    setTrackData(null);
    setShowFullCalendar(false);
    const param = key === 'tree_shrub' ? 'program=tree_shrub' : `track=${key}`;
    const d = await adminFetch(`/admin/protocols/programs?${param}`);
    setTrackData(d.track || d.program);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading protocols...</div>;

  const currentMonthIndex = new Date().getMonth(); // 0-based
  const currentMonthAbbr = MONTH_NAMES[currentMonthIndex];

  // Find the current visit based on month
  const currentVisit = trackData?.visits?.find(v => v.month === currentMonthAbbr);

  const thSt = { padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: D.muted, textAlign: 'left', borderBottom: `1px solid ${D.border}` };
  const tdSt = { padding: '8px 10px', fontSize: 12, color: D.text, borderBottom: `1px solid ${D.border}22`, verticalAlign: 'top', lineHeight: 1.5 };

  const safetyRules = selectedTrack && selectedTrack !== 'tree_shrub' ? (TRACK_SAFETY_RULES[selectedTrack] || []) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 14, color: D.muted }}>WaveGuard service protocols — visit-by-visit products, rates, costs, and SOPs for techs.</div>

      {/* Track selector */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', overflowX: isMobile ? 'auto' : undefined, WebkitOverflowScrolling: 'touch' }}>
        {programs?.lawn?.tracks?.map(t => (
          <button key={t.key} onClick={() => loadTrack(t.key)} style={{
            padding: '10px 16px', borderRadius: 10, cursor: 'pointer', border: 'none', flexShrink: 0,
            background: selectedTrack === t.key ? D.teal : D.card,
            color: selectedTrack === t.key ? D.white : D.text,
            fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
            borderLeft: `3px solid ${selectedTrack === t.key ? D.teal : D.green}`,
          }}>
            {'\ud83c\udf3f'} {t.name?.substring(0, 35) || t.key}
            <div style={{ fontSize: 10, color: selectedTrack === t.key ? D.white + 'cc' : D.muted, marginTop: 2 }}>{t.visits} visits/year</div>
          </button>
        ))}
        <button onClick={() => loadTrack('tree_shrub')} style={{
          padding: '10px 16px', borderRadius: 10, cursor: 'pointer', border: 'none',
          background: selectedTrack === 'tree_shrub' ? D.teal : D.card,
          color: selectedTrack === 'tree_shrub' ? D.white : D.text,
          fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
          borderLeft: `3px solid ${selectedTrack === 'tree_shrub' ? D.teal : D.amber}`,
        }}>
          {'\ud83c\udf33'} Tree & Shrub v3
          <div style={{ fontSize: 10, color: selectedTrack === 'tree_shrub' ? D.white + 'cc' : D.muted, marginTop: 2 }}>12 visits/year</div>
        </button>
      </div>

      {/* Track detail */}
      {trackData && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Header */}
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', background: D.bg }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>{trackData.name}</div>
            </div>
          </div>

          {/* Safety Rules Bar — always visible, compact amber strip */}
          {safetyRules.length > 0 && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px',
              background: D.amber + '14', border: `1px solid ${D.amber}44`,
              borderRadius: 10, alignItems: 'center',
            }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: D.amber, marginRight: 4, flexShrink: 0 }}>{'\u26a0'} SAFETY:</span>
              {safetyRules.map((rule, i) => (
                <span key={i} style={{
                  fontSize: 11, color: D.amber, padding: '3px 8px',
                  background: D.amber + '18', borderRadius: 6,
                  border: `1px solid ${D.amber}33`, whiteSpace: 'nowrap',
                  fontWeight: 600,
                }}>
                  {rule}
                </span>
              ))}
            </div>
          )}

          {/* Current Visit Card — default hero view */}
          {currentVisit && (
            <CurrentVisitCard visit={currentVisit} trackName={trackData.name} />
          )}

          {!currentVisit && trackData.visits?.length > 0 && (
            <div style={{
              background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
              padding: '16px 20px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 14, color: D.muted }}>No visit mapped to {currentMonthAbbr} for this track.</div>
            </div>
          )}

          {/* Tier legend */}
          <div style={{
            display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
            padding: '8px 14px', background: D.card, borderRadius: 8,
            border: `1px solid ${D.border}`,
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Tier Legend:</span>
            <span style={{ fontSize: 11, color: D.text }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: D.green, marginRight: 3, verticalAlign: 'middle' }} />
              = included
            </span>
            <span style={{ fontSize: 11, color: D.muted }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', border: `2px solid ${D.gray}`, marginRight: 3, verticalAlign: 'middle', boxSizing: 'border-box' }} />
              = not included
            </span>
            <span style={{ fontSize: 10, color: D.muted }}>B=Bronze S=Silver E=Enhanced P=Premium</span>
          </div>

          {/* View Full Calendar toggle */}
          <button onClick={() => setShowFullCalendar(prev => !prev)} style={{
            width: '100%', padding: '12px 16px', background: D.card,
            border: `1px solid ${D.border}`, borderRadius: 10, cursor: 'pointer',
            color: D.teal, fontSize: 13, fontWeight: 700,
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6,
            transition: 'all 0.15s',
          }}>
            {showFullCalendar ? 'Hide full calendar' : 'View full calendar'} <span style={{ fontSize: 16, transition: 'transform 0.2s', transform: showFullCalendar ? 'rotate(180deg)' : 'none' }}>{'\u25bc'}</span>
          </button>

          {/* Full 12-month table — hidden by default */}
          {showFullCalendar && (
            <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: 'hidden' }}>
              {/* Notes/warnings */}
              {trackData.notes?.length > 0 && (
                <div style={{ padding: '12px 20px', borderBottom: `1px solid ${D.border}`, background: '#1a1a0a' }}>
                  {trackData.notes.map((n, i) => (
                    <div key={i} style={{ fontSize: 12, color: n.startsWith('\u26a0') ? D.amber : D.green, marginBottom: 4, lineHeight: 1.5 }}>{n}</div>
                  ))}
                </div>
              )}

              {/* Visits table */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thSt}>#</th>
                      <th style={thSt}>Month</th>
                      <th style={{ ...thSt, minWidth: 250 }}>Primary Applications</th>
                      <th style={{ ...thSt, minWidth: 200 }}>Secondary / Conditional</th>
                      <th style={thSt}>Mat$</th>
                      <th style={thSt}>Lab$</th>
                      <th style={thSt}>Tiers</th>
                      <th style={{ ...thSt, minWidth: 200 }}>Notes / SOP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trackData.visits?.map((v, i) => {
                      const isCurrentMonth = v.month === currentMonthAbbr;
                      return (
                        <tr key={i} style={{
                          background: isCurrentMonth ? D.teal + '14' : (i % 2 === 0 ? 'transparent' : D.bg + '44'),
                          borderLeft: isCurrentMonth ? `3px solid ${D.teal}` : '3px solid transparent',
                        }}>
                          <td style={{ ...tdSt, fontWeight: 700, color: isCurrentMonth ? D.teal : D.teal + '99', textAlign: 'center' }}>{v.visit}</td>
                          <td style={{ ...tdSt, fontWeight: 600, color: isCurrentMonth ? D.heading : D.muted, whiteSpace: 'nowrap' }}>
                            {v.month}
                            {isCurrentMonth && <span style={{ fontSize: 9, color: D.teal, marginLeft: 4, fontWeight: 800 }}>NOW</span>}
                          </td>
                          <td style={{ ...tdSt, whiteSpace: 'pre-wrap' }}>
                            {parseProductLines(v.primary).map((p, pi) => (
                              <div key={pi} style={{ marginBottom: 3 }}>
                                <div style={{ color: D.text }}>{p.raw}</div>
                                {p.description && <div style={{ fontSize: 10, color: D.muted, fontStyle: 'italic', marginLeft: 8 }}>{p.description}</div>}
                              </div>
                            ))}
                          </td>
                          <td style={{ ...tdSt, whiteSpace: 'pre-wrap', color: D.muted }}>
                            {parseProductLines(v.secondary).map((p, pi) => (
                              <div key={pi} style={{ marginBottom: 3 }}>
                                <div>{p.raw}</div>
                                {p.description && <div style={{ fontSize: 10, color: D.gray, fontStyle: 'italic', marginLeft: 8 }}>{p.description}</div>}
                              </div>
                            ))}
                            {(!v.secondary) && '\u2014'}
                          </td>
                          <td style={{ ...tdSt, fontFamily: "'JetBrains Mono', monospace", color: D.amber, whiteSpace: 'nowrap' }}>{v.material_cost ? `$${v.material_cost}` : '\u2014'}</td>
                          <td style={{ ...tdSt, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>{v.labor_cost ? `$${v.labor_cost}` : '\u2014'}</td>
                          <td style={tdSt}>
                            <TierDots tiers={v.tiers} tier4x={v.tier_4x} tier6x={v.tier_6x} />
                          </td>
                          <td style={{ ...tdSt, fontSize: 11, color: D.muted, whiteSpace: 'pre-wrap' }}>{stripLegacyBoilerplate(v.notes) || '\u2014'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {!selectedTrack && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>{'\ud83d\udccb'}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 4 }}>Select a program above</div>
          <div style={{ fontSize: 13, color: D.muted }}>View the full visit-by-visit protocol with products, rates, costs, and tier requirements.</div>
        </div>
      )}
    </div>
  );
}

/* ── Recurring Plan Alerts Banner ──────────────────────── */

export function RecurringAlertsBanner() {
  const [alerts, setAlerts] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/admin/schedule/recurring-alerts');
      setAlerts(r.alerts || []);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (row, action) => {
    setBusyId(row.id);
    try {
      await adminFetch(`/admin/schedule/recurring-alerts/${row.id}/action`, {
        method: 'POST', body: JSON.stringify({ action, count: 4 }),
      });
      await load();
    } catch (e) { window.alert('Failed: ' + e.message); }
    setBusyId(null);
  };

  if (!alerts.length) return null;

  return (
    <div style={{ background: `${D.amber}15`, border: `1px solid ${D.amber}55`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>⚠️</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: D.heading }}>
            {alerts.length} recurring plan{alerts.length === 1 ? '' : 's'} ending soon
          </span>
        </div>
        <span style={{ fontSize: 11, color: D.muted }}>{expanded ? '▾ hide' : '▸ review'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {alerts.map(a => (
            <div key={a.id} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: '1 1 220px', minWidth: 200 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{a.customerName || 'Customer'}</div>
                <div style={{ fontSize: 11, color: D.muted }}>
                  {a.serviceType} · {a.pattern} · last visit {a.lastVisitDate || '—'} · {a.remainingVisits ?? 0} pending
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button disabled={busyId === a.id} onClick={() => act(a, 'extend')} style={{
                  padding: '6px 10px', borderRadius: 6, border: `1px solid ${D.teal}`, background: `${D.teal}15`,
                  color: D.teal, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>+4 visits</button>
                <button disabled={busyId === a.id} onClick={() => act(a, 'convert_ongoing')} style={{
                  padding: '6px 10px', borderRadius: 6, border: `1px solid ${D.green}`, background: `${D.green}15`,
                  color: D.green, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>Convert to ongoing</button>
                <button disabled={busyId === a.id} onClick={() => act(a, 'let_lapse')} style={{
                  padding: '6px 10px', borderRadius: 6, border: `1px solid ${D.border}`, background: 'transparent',
                  color: D.muted, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>Let lapse</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main Schedule Page ───────────────────────────────── */

/**
 * @deprecated V1 SchedulePage. DispatchGate now always renders DispatchPageV2;
 * this default export is no longer reached as a route. The named exports above
 * (CompletionPanel, RescheduleModal, EditServiceModal, ProtocolPanel,
 * MONTH_NAMES, PRODUCT_DESCRIPTIONS, TRACK_SAFETY_RULES,
 * stripLegacyBoilerplate) are still consumed by V2 and ProtocolReferenceTabV2.
 */
export default function SchedulePage() {
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState('board');
  const [viewMode, setViewMode] = useState('day');
  const [date, setDate] = useState(formatDateISO(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [completingService, setCompletingService] = useState(null);
  const [rescheduleService, setRescheduleService] = useState(null);
  const [editingService, setEditingService] = useState(null);
  const [protocolService, setProtocolService] = useState(null);
  const [showNewAppt, setShowNewAppt] = useState(false);
  const [newAppt, setNewAppt] = useState({ customerId: '', customerSearch: '', customerResults: [], serviceType: 'Pest Control', windowStart: '09:00', windowEnd: '11:00', notes: '' });
  const [savingAppt, setSavingAppt] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const syncDispatchAI = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await fetch(`${API_BASE}/dispatch/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      const d = await res.json();
      setSyncMsg(`Synced ${d.bridge?.synced || 0} jobs from schedule`);
      setTimeout(() => setSyncMsg(''), 5000);
    } catch {
      setSyncMsg('Sync failed');
    }
    setSyncing(false);
  };

  const fetchSchedule = useCallback((d) => {
    setLoading(true);
    setError(null);
    Promise.all([
      adminFetch(`/admin/schedule?date=${d}`),
      adminFetch('/admin/dispatch/products/catalog'),
    ])
      .then(([scheduleData, catalogData]) => {
        setData(scheduleData);
        setProducts(catalogData.products || []);
        setLoading(false);
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchSchedule(date);
  }, [date, fetchSchedule]);

  const handleStatusChange = useCallback((serviceId, newStatus) => {
    setData(prev => {
      if (!prev) return prev;
      const updatedServices = prev.services.map(s =>
        s.id === serviceId
          ? { ...s, status: newStatus, statusLog: [...(s.statusLog || []), { status: newStatus, at: new Date().toISOString() }] }
          : s
      );
      const updatedTechSummary = prev.techSummary.map(tech => ({
        ...tech,
        services: tech.services.map(s =>
          s.id === serviceId
            ? { ...s, status: newStatus, statusLog: [...(s.statusLog || []), { status: newStatus, at: new Date().toISOString() }] }
            : s
        ),
        completedServices: tech.services.filter(s =>
          s.id === serviceId ? newStatus === 'completed' : s.status === 'completed'
        ).length,
      }));
      return { ...prev, services: updatedServices, techSummary: updatedTechSummary };
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

  const handleDelete = useCallback(async (service) => {
    const name = service.customerName || service.customer_name || 'this customer';
    if (!window.confirm(`Delete service for ${name}?\n\nThis will cancel the scheduled service.`)) return;
    try {
      await adminFetch(`/admin/schedule/${service.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      // Remove from local state
      setData(prev => {
        if (!prev) return prev;
        const updatedServices = prev.services.filter(s => s.id !== service.id);
        const updatedTechSummary = prev.techSummary.map(tech => ({
          ...tech,
          services: tech.services.filter(s => s.id !== service.id),
          totalServices: tech.services.filter(s => s.id !== service.id).length,
        }));
        return { ...prev, services: updatedServices, techSummary: updatedTechSummary };
      });
    } catch (err) {
      alert('Failed to delete service: ' + err.message);
    }
  }, []);

  const handlePanelClose = useCallback((wasCompleted) => {
    setCompletingService(null);
  }, []);

  const [syncingCal, setSyncingCal] = useState(false);
  const handleSyncCalendar = async () => {
    setSyncingCal(true);
    try {
      const r = await fetch(`${API_BASE}/admin/schedule/sync-calendar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 14 }),
      });
      const result = await r.json();
      if (!r.ok) {
        alert(`Sync error: ${result.error || r.status}`);
      } else {
        const gc = result.google || {};
        const lines = [`Google Calendar: ${gc.found || 0} found, ${gc.created || 0} new`];
        if (gc.error) lines.push(`  ⚠ ${gc.error}`);
        alert(lines.join('\n'));
        if (gc.created > 0) fetchSchedule(date);
      }
    } catch (e) {
      alert('Calendar sync failed: ' + e.message);
    }
    setSyncingCal(false);
  };

  function shiftDate(dir) {
    const d = new Date(date + 'T12:00:00');
    if (viewMode === 'day') d.setDate(d.getDate() + dir);
    else if (viewMode === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setDate(formatDateISO(d));
  }

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontSize: 15 }}>Loading schedule...</div>;
  if (error) return <div style={{ color: D.red, padding: 60, textAlign: 'center' }}>Failed to load schedule: {error}</div>;
  if (!data) return null;

  const services = data.services || [];
  const techSummary = data.techSummary || [];
  const unassigned = data.unassigned || [];
  const technicians = data.technicians || [];
  const zoneColors = data.zoneColors || {};
  const zoneLabels = data.zoneLabels || {};

  const totalCount = services.length;
  const completedCount = services.filter(s => s.status === 'completed').length;
  const skippedCount = services.filter(s => s.status === 'skipped').length;
  const remainingCount = totalCount - completedCount - skippedCount;

  // Header stats: estimated time + revenue
  const AVG_SERVICE_MIN = 35;
  const estTotalMin = totalCount * AVG_SERVICE_MIN;
  const estTotalHrs = Math.floor(estTotalMin / 60);
  const estTotalMinRemainder = estTotalMin % 60;
  const estRemainingMin = remainingCount * AVG_SERVICE_MIN;
  const estFinishTime = (() => {
    const now = new Date();
    const finish = new Date(now.getTime() + estRemainingMin * 60000);
    return finish.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  })();
  const estRevenue = (() => {
    const total = services.reduce((sum, s) => sum + (s.price || 125), 0);
    return total;
  })();

  // Today's Focus alerts
  const unassignedCount = unassigned.length;
  const newCustomers = services.filter(s => !s.lastServiceDate);
  const weatherData = data.weather || {};
  const rainProbability = weatherData.rainProbability ?? weatherData.rain_probability ?? null;
  const windSpeed = weatherData.windSpeed ?? weatherData.wind_speed ?? null;
  const weatherTemp = weatherData.temp ?? weatherData.temperature ?? null;
  const hasRainAlert = rainProbability != null && rainProbability > 40;
  const hasFocusAlerts = unassignedCount > 0 || newCustomers.length > 0 || hasRainAlert;

  const SCHEDULE_TABS = [
    { id: 'board', label: 'Board' },
    { id: 'protocols', label: 'Protocols' },
    { id: 'match', label: 'Tech Match' },
    { id: 'csr', label: 'CSR Booking' },
    { id: 'revenue', label: 'Job Scores' },
    { id: 'insights', label: 'Insights' },
  ];

  return (
    <div>
      <style>{`
        @keyframes statusPulse {
          0%, 100% { box-shadow: 0 0 0 0 ${D.teal}44; }
          50% { box-shadow: 0 0 0 6px ${D.teal}00; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 400, color: D.heading, margin: '0 0 4px' }}>Schedule & Dispatch</h1>
          {/* Date nav */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <button onClick={() => shiftDate(-1)} style={navBtnStyle} title="Previous">&#9664;</button>
              <span style={{ fontSize: 14, fontWeight: 600, color: D.text, minWidth: isMobile ? 0 : 220, textAlign: 'center', flex: isMobile ? 1 : undefined }}>
                {viewMode === 'day' ? formatDateDisplay(date)
                  : viewMode === 'week' ? (() => {
                      const d = new Date(date + 'T12:00:00');
                      const end = new Date(d); end.setDate(end.getDate() + 6);
                      return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
                    })()
                  : new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                }
              </span>
              <button onClick={() => shiftDate(1)} style={navBtnStyle} title="Next">&#9654;</button>
              {!isToday(date) && (
                <button onClick={() => setDate(formatDateISO(new Date()))} style={{
                  ...navBtnStyle, fontSize: 12, padding: '4px 12px', width: 'auto',
                }}>Today</button>
              )}
            </div>
            <ViewModeSelector viewMode={viewMode} onViewModeChange={(m) => { setViewMode(m); if (m === 'day') setActiveTab('board'); }} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {viewMode === 'day' && activeTab === 'board' && (
            <>
              <div style={{
                display: 'flex', gap: 12, alignItems: 'center', fontSize: 13, color: D.muted,
                background: D.card, padding: '8px 16px', borderRadius: 10, border: `1px solid ${D.border}`,
                flexWrap: 'wrap',
              }}>
                <span><strong style={{ color: D.heading }}>{totalCount}</strong> services</span>
                <span><strong style={{ color: D.green }}>{completedCount}</strong> done</span>
                <span><strong style={{ color: D.amber }}>{remainingCount}</strong> left</span>
                <span style={{ borderLeft: `1px solid ${D.border}`, paddingLeft: 12 }}>
                  ~{estTotalHrs}h{estTotalMinRemainder > 0 ? `${estTotalMinRemainder}m` : ''} total
                </span>
                <span>ETA <strong style={{ color: D.teal }}>{estFinishTime}</strong></span>
                <span style={{ borderLeft: `1px solid ${D.border}`, paddingLeft: 12 }}>
                  <strong style={{ color: D.green }}>${estRevenue.toLocaleString()}</strong> revenue
                </span>
              </div>
              <button onClick={() => setShowNewAppt(!showNewAppt)} style={{
                ...btnBase, background: D.green, color: '#fff', fontSize: 13, height: 38,
              }}>+ New Appointment</button>
            </>
          )}
          {viewMode === 'day' && activeTab !== 'board' && (
            <button onClick={syncDispatchAI} disabled={syncing} style={{
              padding: '6px 14px', borderRadius: 8, border: `1px solid ${D.border}`,
              background: 'transparent', color: D.muted, fontSize: 13, cursor: 'pointer',
              opacity: syncing ? 0.5 : 1,
            }}>
              {syncing ? 'Syncing...' : '↻ Sync AI Data'}
            </button>
          )}
        </div>
      </div>

      {syncMsg && <div style={{ fontSize: 12, color: D.muted, marginBottom: 8 }}>{syncMsg}</div>}

      {/* New Appointment Modal */}
      {showNewAppt && <CreateAppointmentModal defaultDate={date} onClose={() => setShowNewAppt(false)} onCreated={(appt) => { setShowNewAppt(false); fetchSchedule(appt.scheduledDate || date); }} />}

      {/* Week / Month calendar views */}
      {viewMode === 'week' && <WeekView startDate={date} onDateClick={(d) => { setDate(d); setViewMode('day'); }} />}
      {viewMode === 'month' && <MonthView date={date} onDateClick={(d) => { setDate(d); setViewMode('day'); }} />}

      {/* Tabs — day view only */}
      {viewMode === 'day' && <div style={{ marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}` }}>
        <HorizontalScroll gap={4} edgeBleed={4} style={{ paddingBottom: 0 }}>
          {SCHEDULE_TABS.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0, minHeight: 44,
              background: activeTab === t.id ? D.teal : 'transparent',
              color: activeTab === t.id ? D.white : D.muted,
              transition: 'all 0.15s',
            }}>
              {t.label}
            </button>
          ))}
        </HorizontalScroll>
      </div>}

      {/* Recurring plan alerts */}
      {viewMode === 'day' && <RecurringAlertsBanner />}

      {/* Intelligence Bar — schedule context */}
      {viewMode === 'day' && (
        <ScheduleIntelligenceBar
          date={date}
          scheduleData={data}
          onRefresh={() => fetchSchedule(date)}
        />
      )}

      {/* ── Protocol Reference ── */}
      {viewMode === 'day' && activeTab === 'protocols' && <ProtocolReferenceTab />}

      {/* ── AI Dispatch Panels ── */}
      {viewMode === 'day' && activeTab === 'match' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><TechMatchPanel /></Suspense>}
      {viewMode === 'day' && activeTab === 'csr' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><CSRPanel /></Suspense>}
      {viewMode === 'day' && activeTab === 'revenue' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><RevenuePanel date={date} /></Suspense>}
      {viewMode === 'day' && activeTab === 'insights' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><InsightsPanel /></Suspense>}

      {/* ── Board Tab Content ── */}
      {viewMode === 'day' && activeTab === 'board' && <>

      {/* Today's Focus summary */}
      {hasFocusAlerts && (
        <div style={{
          background: D.amber + '12', borderRadius: 10, padding: '12px 18px', marginBottom: 12,
          border: `1px solid ${D.amber}33`, display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: D.amber, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Today's Focus
          </div>
          {unassignedCount > 0 && (
            <div style={{ fontSize: 13, color: D.red, fontWeight: 600 }}>
              {unassignedCount} service{unassignedCount > 1 ? 's' : ''} unassigned — assign techs
            </div>
          )}
          {newCustomers.length > 0 && (
            <div style={{ fontSize: 13, color: D.teal, fontWeight: 600 }}>
              {newCustomers.length} new customer{newCustomers.length > 1 ? 's' : ''} today (first visit)
            </div>
          )}
          {hasRainAlert && (
            <div style={{ fontSize: 13, color: D.amber, fontWeight: 600 }}>
              Rain expected ({rainProbability}% chance) — monitor spray conditions
            </div>
          )}
        </div>
      )}

      {/* Weather bar */}
      <div style={{
        background: D.card, borderRadius: 10, padding: '10px 18px', marginBottom: 20,
        border: `1px solid ${D.border}`, fontSize: 13, color: D.text,
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      }}>
        <span>{weatherTemp ?? 82}{'\u00B0'}F</span>
        {windSpeed != null && <span>{windSpeed}mph</span>}
        {rainProbability != null && <span>{rainProbability}% rain</span>}
        <span style={{
          color: (rainProbability != null && rainProbability > 50) || (windSpeed != null && windSpeed > 15) ? D.red : D.green,
          fontWeight: 700,
        }}>
          SPRAY: {(rainProbability != null && rainProbability > 50) || (windSpeed != null && windSpeed > 15) ? 'HOLD' : 'GO'}
        </span>
      </div>

      {/* Tech sections */}
      {techSummary.map(tech => (
        <TechSection
          key={tech.technicianId}
          tech={tech}
          zoneColors={zoneColors}
          zoneLabels={zoneLabels}
          onStatusChange={handleStatusChange}
          onComplete={handleComplete}
          onReschedule={svc => setRescheduleService(svc)}
          onDelete={handleDelete}
          onProtocol={svc => setProtocolService(svc)}
          onEdit={svc => setEditingService(svc)}
        />
      ))}

      {/* Unassigned section */}
      {unassigned.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            background: D.red + '18', borderRadius: 12, border: `1px solid ${D.red}44`,
            padding: '14px 18px', marginBottom: 12,
            fontSize: 16, fontWeight: 700, color: D.red,
          }}>
            Unassigned ({unassigned.length})
          </div>
          <div style={{ paddingLeft: 20 }}>
            {unassigned.map(svc => (
              <div key={svc.id}>
                <div style={{ marginBottom: 8 }}>
                  <select onChange={async (e) => {
                    if (!e.target.value) return;
                    try {
                      await adminFetch(`/admin/schedule/${svc.id}/assign`, {
                        method: 'PUT',
                        body: JSON.stringify({ technicianId: e.target.value }),
                      });
                      fetchSchedule(date);
                    } catch (err) { alert('Assign failed: ' + err.message); }
                  }} defaultValue="" style={{
                    width: '100%', padding: '10px 14px', borderRadius: 10,
                    background: D.input, color: D.text, border: `1px solid ${D.amber}`,
                    fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  }}>
                    <option value="">Assign to technician...</option>
                    {technicians.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <ServiceCard
                  service={svc}
                  zoneColors={zoneColors}
                  onStatusChange={handleStatusChange}
                  onComplete={handleComplete}
                  onReschedule={svc2 => setRescheduleService(svc2)}
                  onDelete={handleDelete}
                  onProtocol={svc2 => setProtocolService(svc2)}
                  onEdit={svc2 => setEditingService(svc2)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {techSummary.length === 0 && unassigned.length === 0 && (
        <div style={{ color: D.muted, textAlign: 'center', padding: 60, fontSize: 15 }}>
          No services scheduled for {formatDateDisplay(date)}.
        </div>
      )}

      </>}

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
            fetchSchedule(date);
          }}
        />
      )}

      {/* Edit Service Modal */}
      {editingService && (
        <EditServiceModal
          service={editingService}
          technicians={technicians}
          onClose={() => setEditingService(null)}
          onSaved={() => {
            setEditingService(null);
            fetchSchedule(date);
          }}
        />
      )}

      {/* Protocol Panel */}
      {protocolService && (
        <ProtocolPanel
          service={protocolService}
          onClose={() => setProtocolService(null)}
        />
      )}
    </div>
  );
}

const navBtnStyle = {
  width: 32, height: 32, borderRadius: 8, border: `1px solid ${D.border}`,
  background: D.card, color: D.text, fontSize: 14, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};
