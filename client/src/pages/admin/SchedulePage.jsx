import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';

const RoutePanel = lazy(() => import('../../components/dispatch/RoutePanel'));
const TechMatchPanel = lazy(() => import('../../components/dispatch/TechMatchPanel'));
const CSRPanel = lazy(() => import('../../components/dispatch/CSRPanel'));
const RevenuePanel = lazy(() => import('../../components/dispatch/RevenuePanel'));
const InsightsPanel = lazy(() => import('../../components/dispatch/InsightsPanel'));

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155', input: '#0f172a',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444',
  blue: '#3b82f6', purple: '#a855f7', gray: '#64748b',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff',
};

const STATUS_CONFIG = {
  pending:   { label: 'Pending',   bg: 'transparent', color: D.amber, border: D.amber },
  confirmed: { label: 'Confirmed', bg: 'transparent', color: D.green, border: D.green },
  en_route:  { label: 'En Route',  bg: D.teal,        color: D.white, border: D.teal, pulse: true },
  on_site:   { label: 'On Site',   bg: D.blue,        color: D.white, border: D.blue },
  completed: { label: 'Completed', bg: D.green,       color: D.white, border: D.green },
  skipped:   { label: 'Skipped',   bg: D.gray,        color: D.white, border: D.gray, strike: true },
};

const TIER_COLORS = {
  Bronze:   { bg: '#CD7F32', text: '#fff' },
  Silver:   { bg: '#90CAF9', text: '#0f1923' },
  Gold:     { bg: '#FDD835', text: '#0f1923' },
  Platinum: { bg: '#E5E4E2', text: '#0f1923' },
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

const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

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
  if (!tier) return null;
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

function ServiceCard({ service, zoneColors, onStatusChange, onComplete, onReschedule, onProtocol, onLawnPhotos }) {
  const [updating, setUpdating] = useState(false);
  const [lawnUploading, setLawnUploading] = useState(false);
  const [lawnDone, setLawnDone] = useState(false);
  const lawnFileRef = useRef(null);
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
        <span style={{ fontSize: 16, fontWeight: 700, color: D.white }}>
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
        <a href={`tel:${service.customerPhone}`} style={{ fontSize: 13, color: D.teal, textDecoration: 'none' }}>
          {service.customerPhone}
        </a>
        <a href={`sms:${service.customerPhone}`} style={{ fontSize: 14, textDecoration: 'none', cursor: 'pointer' }}>
          💬
        </a>
      </div>

      {/* Service type + duration */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{
          fontSize: 13, fontWeight: 600, color: D.text,
          padding: '4px 10px', borderRadius: 8, background: zoneColor + '18', display: 'inline-block',
        }}>
          {service.serviceType}
        </span>
        {service.estimatedDuration && (
          <span style={{ fontSize: 12, color: D.muted }}>
            ~{service.estimatedDuration} min
          </span>
        )}
      </div>

      {/* Property alerts */}
      <PropertyAlerts alerts={service.propertyAlerts} />

      {/* Last service notes (truncated) */}
      {service.lastServiceDate && (
        <div style={{ fontSize: 12, color: D.muted, fontStyle: 'italic', marginBottom: 8, lineHeight: 1.5 }}>
          Last: {new Date(service.lastServiceDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          {service.lastServiceNotes && (
            <> — {service.lastServiceNotes.substring(0, 100)}{service.lastServiceNotes.length > 100 ? '...' : ''}</>
          )}
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
                ...btnBase, background: D.teal, color: D.white,
              }}>
                En Route
              </button>
            )}
            {status === 'en_route' && (
              <button onClick={() => changeStatus('on_site')} disabled={updating} style={{
                ...btnBase, background: D.blue, color: D.white,
              }}>
                On Site
              </button>
            )}
            <button onClick={() => onComplete(service)} style={{
              ...btnBase, background: D.green, color: D.white,
            }}>
              Complete
            </button>
            <button onClick={() => changeStatus('skipped')} disabled={updating} style={{
              ...btnBase, background: 'transparent', color: D.gray, border: `1px solid ${D.border}`,
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
  height: 44, minWidth: 110, padding: '0 18px', borderRadius: 12, border: 'none',
  fontWeight: 700, fontSize: 13, cursor: 'pointer', transition: 'all 0.2s',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
};

/* ── Tech Section (collapsible) ───────────────────────── */

function TechSection({ tech, zoneColors, zoneLabels, onStatusChange, onComplete, onReschedule, onProtocol }) {
  const [collapsed, setCollapsed] = useState(false);

  const completedCount = tech.completedServices || tech.services.filter(s => s.status === 'completed').length;
  const totalHrs = Math.round(((tech.estimatedServiceMinutes || 0) + (tech.estimatedDriveMinutes || 0)) / 60 * 10) / 10;

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
          fontWeight: 800, fontSize: 15, color: D.white, flexShrink: 0,
        }}>
          {tech.initials || tech.technicianName?.split(' ').map(w => w[0]).join('').toUpperCase() || '?'}
        </div>

        {/* Name + stats */}
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>
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
          {tech.services.map(svc => (
            <ServiceCard
              key={svc.id}
              service={svc}
              zoneColors={zoneColors}
              onStatusChange={onStatusChange}
              onComplete={onComplete}
              onReschedule={onReschedule}
              onProtocol={onProtocol}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Reschedule Modal ─────────────────────────────────── */

// =========================================================================
// PROTOCOL PANEL — shows all 5 protocol layers for a service
// =========================================================================
function ProtocolPanel({ service, onClose }) {
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
          <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>📋 Service Protocol</div>
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
                <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 12 }}>Service Overview</div>
                <div style={{ background: D.bg, borderRadius: 10, padding: 14, border: `1px solid ${D.border}`, marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: D.white, fontWeight: 600 }}>{service.serviceType}</div>
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
                {service.lastServiceNotes && (
                  <div style={{ background: D.bg, borderRadius: 10, padding: 12, border: `1px solid ${D.border}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Last Visit Notes</div>
                    <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>{service.lastServiceNotes}</div>
                  </div>
                )}
              </div>
            )}

            {/* SEASONAL PEST PRESSURE */}
            {activeSection === 'seasonal' && (
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 4 }}>This Month in SWFL</div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>What to look for and how to respond</div>
                {seasonal.length === 0 ? (
                  <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No seasonal data for this service line</div>
                ) : seasonal.map((p, i) => (
                  <div key={i} style={{ background: D.bg, borderRadius: 10, padding: 14, border: `1px solid ${D.border}`, marginBottom: 8, borderLeft: `3px solid ${pressureColors[p.pressure_level] || D.gray}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{p.pest_name}</span>
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
                <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 4 }}>Identification References</div>
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
                <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 4 }}>Customer Communication Scripts</div>
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>What to say on the property</div>
                {scripts.length === 0 ? (
                  <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No scripts for this service line</div>
                ) : scripts.map((s, i) => (
                  <div key={i} style={{ background: D.bg, borderRadius: 10, padding: 14, border: `1px solid ${D.border}`, marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: D.white, marginBottom: 6 }}>{s.title}</div>
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
                <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 4 }}>Equipment Checklist</div>
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

function RescheduleModal({ service, onClose, onRescheduled }) {
  const [options, setOptions] = useState([]);
  const [reason, setReason] = useState('customer_request');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

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

  const REASONS = [
    { value: 'weather_rain', label: 'Weather — Rain' },
    { value: 'weather_wind', label: 'Weather — Wind' },
    { value: 'customer_request', label: 'Customer Request' },
    { value: 'customer_noshow', label: 'Customer No-Show' },
    { value: 'gate_locked', label: 'Gate Locked' },
    { value: 'tech_callout', label: 'Tech Unavailable' },
    { value: 'route_overload', label: 'Route Overload' },
  ];

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: D.card, borderRadius: 16, padding: 24, maxWidth: 480, width: '100%', border: `1px solid ${D.border}`, maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: D.white, marginBottom: 4 }}>Reschedule Service</div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>{service.customerName} — {service.serviceType}</div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, marginBottom: 6 }}>Reason</div>
          <select value={reason} onChange={e => setReason(e.target.value)} style={{
            width: '100%', padding: '10px 14px', borderRadius: 10, border: `1px solid ${D.border}`,
            background: D.input, color: D.white, fontSize: 14, outline: 'none',
          }}>
            {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, marginBottom: 6 }}>Notes (optional)</div>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Additional context..."
            style={{ width: '100%', padding: '10px 14px', borderRadius: 10, border: `1px solid ${D.border}`, background: D.input, color: D.white, fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: D.teal, marginBottom: 10 }}>Available Dates</div>
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
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{opt.displayDate}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{opt.suggestedWindow?.display} · {opt.currentLoad} other services · {opt.sameAreaServices} same area</div>
                </div>
                <button onClick={() => handleReschedule(opt)} disabled={sending} style={{
                  padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: D.teal, color: D.white, fontSize: 12, fontWeight: 600,
                  opacity: sending ? 0.6 : 1,
                }}>Reschedule</button>
              </div>
            ))}
          </div>
        )}

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
  const [generating, setGenerating] = useState(false);
  const [success, setSuccess] = useState(false);
  const [elapsed, setElapsed] = useState('0:00');

  const isLawn = detectServiceCategory(service.serviceType) === 'lawn';
  const onSiteEntry = (service.statusLog || []).find(e => e.status === 'on_site');
  const onSiteTime = onSiteEntry ? onSiteEntry.at : service.checkInTime;

  useEffect(() => {
    const iv = setInterval(() => setElapsed(elapsedSince(onSiteTime)), 1000);
    return () => clearInterval(iv);
  }, [onSiteTime]);

  function addQuickNote(text) {
    setNotes(prev => prev.trim() ? prev.trimEnd() + '\n' + text : text);
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
          </div>
        )}

        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: `1px solid ${D.border}`, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: D.white }}>Complete Service</div>
            <button onClick={() => onClose(false)} style={{ background: 'none', border: 'none', color: D.muted, fontSize: 24, cursor: 'pointer', padding: 4 }}>&times;</button>
          </div>
          <div style={{ fontSize: 14, color: D.text, fontWeight: 600 }}>{service.customerName}</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{service.address}</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{service.serviceType}</div>
          {onSiteTime && (
            <div style={{
              marginTop: 8, display: 'inline-block', padding: '3px 10px', borderRadius: 8,
              background: D.teal + '22', color: D.teal, fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13, fontWeight: 600,
            }}>
              On site: {elapsed}
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          <label style={labelStyle}>Technician Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={5} style={{
            width: '100%', background: D.input, color: D.text, border: `1px solid ${D.border}`,
            borderRadius: 10, padding: 12, fontSize: 14, resize: 'vertical',
            fontFamily: "'Nunito Sans', sans-serif", boxSizing: 'border-box',
          }} placeholder="Notes about this service..." />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 10 }}>
            {QUICK_NOTES.map(qn => (
              <button key={qn} onClick={() => addQuickNote(qn)} style={{
                padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                background: D.card, color: D.text, border: `1px solid ${D.border}`, cursor: 'pointer',
              }}>
                {qn}
              </button>
            ))}
          </div>
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
            color: D.white, fontSize: 13, fontWeight: 700, cursor: generating ? 'wait' : 'pointer',
            marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            {generating ? 'Generating Report...' : 'Generate AI Service Report'}
          </button>

          <label style={labelStyle}>Products Applied</label>
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
          {selectedProducts.length > 0 && (
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

          {isLawn && (
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
            ...btnBase, width: '100%', background: D.green, color: D.white, fontSize: 16, height: 48,
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

/* ── Protocol Reference Tab ────────────────────────────── */

function ProtocolReferenceTab() {
  const [programs, setPrograms] = useState(null);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [trackData, setTrackData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/protocols/programs').then(d => { setPrograms(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const loadTrack = async (key) => {
    setSelectedTrack(key);
    setTrackData(null);
    const param = key === 'tree_shrub' ? 'program=tree_shrub' : `track=${key}`;
    const d = await adminFetch(`/admin/protocols/programs?${param}`);
    setTrackData(d.track || d.program);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading protocols...</div>;

  const thSt = { padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: D.muted, textAlign: 'left', borderBottom: `1px solid ${D.border}` };
  const tdSt = { padding: '8px 10px', fontSize: 12, color: D.text, borderBottom: `1px solid ${D.border}22`, verticalAlign: 'top', lineHeight: 1.5 };

  const tierBadge = (active, label) => (
    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: active ? D.green + '22' : D.border + '44', color: active ? D.green : D.muted, fontWeight: 700, marginRight: 3 }}>{label}</span>
  );

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
            {'🌿'} {t.name?.substring(0, 35) || t.key}
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
          {'🌳'} Tree & Shrub v3
          <div style={{ fontSize: 10, color: selectedTrack === 'tree_shrub' ? D.white + 'cc' : D.muted, marginTop: 2 }}>12 visits/year</div>
        </button>
      </div>

      {/* Track detail */}
      {trackData && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ padding: '16px 20px', borderBottom: `1px solid ${D.border}`, background: D.bg }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.white }}>{trackData.name}</div>
          </div>

          {/* Notes/warnings */}
          {trackData.notes?.length > 0 && (
            <div style={{ padding: '12px 20px', borderBottom: `1px solid ${D.border}`, background: '#1a1a0a' }}>
              {trackData.notes.map((n, i) => (
                <div key={i} style={{ fontSize: 12, color: n.startsWith('⚠') ? D.amber : D.green, marginBottom: 4, lineHeight: 1.5 }}>{n}</div>
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
                {trackData.visits?.map((v, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : D.bg + '44' }}>
                    <td style={{ ...tdSt, fontWeight: 700, color: D.teal, textAlign: 'center' }}>{v.visit}</td>
                    <td style={{ ...tdSt, fontWeight: 600, color: D.white, whiteSpace: 'nowrap' }}>{v.month}</td>
                    <td style={{ ...tdSt, whiteSpace: 'pre-wrap' }}>{v.primary}</td>
                    <td style={{ ...tdSt, whiteSpace: 'pre-wrap', color: D.muted }}>{v.secondary || '—'}</td>
                    <td style={{ ...tdSt, fontFamily: "'JetBrains Mono', monospace", color: D.amber, whiteSpace: 'nowrap' }}>{v.material_cost ? `$${v.material_cost}` : '—'}</td>
                    <td style={{ ...tdSt, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>{v.labor_cost ? `$${v.labor_cost}` : '—'}</td>
                    <td style={tdSt}>
                      {v.tiers ? (
                        <>{tierBadge(v.tiers.bronze, 'B')}{tierBadge(v.tiers.silver, 'S')}{tierBadge(v.tiers.enhanced, 'E')}{tierBadge(v.tiers.premium, 'P')}</>
                      ) : (
                        <>{tierBadge(v.tier_4x, '4x')}{tierBadge(v.tier_6x, '6x')}</>
                      )}
                    </td>
                    <td style={{ ...tdSt, fontSize: 11, color: D.muted, whiteSpace: 'pre-wrap' }}>{v.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!selectedTrack && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>{'📋'}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 4 }}>Select a program above</div>
          <div style={{ fontSize: 13, color: D.muted }}>View the full visit-by-visit protocol with products, rates, costs, and tier requirements.</div>
        </div>
      )}
    </div>
  );
}

/* ── Main Schedule Page ───────────────────────────────── */

export default function SchedulePage() {
  const [activeTab, setActiveTab] = useState('board');
  const [date, setDate] = useState(formatDateISO(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [completingService, setCompletingService] = useState(null);
  const [rescheduleService, setRescheduleService] = useState(null);
  const [protocolService, setProtocolService] = useState(null);
  const [optimizing, setOptimizing] = useState(false);
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

  const handlePanelClose = useCallback((wasCompleted) => {
    setCompletingService(null);
  }, []);

  const handleOptimize = async () => {
    setOptimizing(true);
    try {
      await adminFetch('/admin/schedule/optimize', {
        method: 'POST',
        body: JSON.stringify({ date }),
      });
      fetchSchedule(date);
    } catch (e) {
      alert('Optimize failed: ' + e.message);
    }
    setOptimizing(false);
  };

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
        const sq = result.square || {};
        const gc = result.google || {};
        const lines = [];
        lines.push(`Square: ${sq.found || 0} found, ${sq.created || 0} new, ${sq.updated || 0} updated`);
        if (sq.error) lines.push(`  ⚠ ${sq.error}`);
        lines.push(`Google Calendar: ${gc.found || 0} found, ${gc.created || 0} new`);
        if (gc.error) lines.push(`  ⚠ ${gc.error}`);
        alert(lines.join('\n'));
        if (sq.created > 0 || gc.created > 0) fetchSchedule(date);
      }
    } catch (e) {
      alert('Calendar sync failed: ' + e.message);
    }
    setSyncingCal(false);
  };

  function shiftDate(days) {
    const d = new Date(date + 'T00:00:00');
    d.setDate(d.getDate() + days);
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
  const remainingCount = totalCount - completedCount - services.filter(s => s.status === 'skipped').length;

  const SCHEDULE_TABS = [
    { id: 'board', label: 'Board' },
    { id: 'protocols', label: 'Protocols' },
    { id: 'routes', label: 'AI Routes' },
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
          <div style={{ fontSize: 26, fontWeight: 700, color: D.white, marginBottom: 4 }}>Schedule & Dispatch</div>
          {/* Date nav */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <button onClick={() => shiftDate(-1)} style={navBtnStyle} title="Previous day">&#9664;</button>
            <span style={{ fontSize: 14, fontWeight: 600, color: D.text, minWidth: 180, textAlign: 'center' }}>
              {formatDateDisplay(date)}
            </span>
            <button onClick={() => shiftDate(1)} style={navBtnStyle} title="Next day">&#9654;</button>
            {!isToday(date) && (
              <button onClick={() => setDate(formatDateISO(new Date()))} style={{
                ...navBtnStyle, fontSize: 12, padding: '4px 12px', width: 'auto',
              }}>Today</button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {activeTab === 'board' && (
            <>
              <div style={{
                display: 'flex', gap: 16, alignItems: 'center', fontSize: 13, color: D.muted,
                background: D.card, padding: '8px 16px', borderRadius: 10, border: `1px solid ${D.border}`,
              }}>
                <span><strong style={{ color: D.white }}>{totalCount}</strong> services</span>
                <span><strong style={{ color: D.green }}>{completedCount}</strong> completed</span>
                <span><strong style={{ color: D.amber }}>{remainingCount}</strong> remaining</span>
              </div>
              <button onClick={handleSyncCalendar} disabled={syncingCal} style={{
                ...btnBase, background: 'transparent', border: `1px solid ${D.border}`, color: D.muted, fontSize: 13, height: 38,
                opacity: syncingCal ? 0.6 : 1,
              }}>
                {syncingCal ? 'Syncing...' : 'Sync Calendar'}
              </button>
              <button onClick={handleOptimize} disabled={optimizing} style={{
                ...btnBase, background: D.teal, color: D.white, fontSize: 13, height: 38,
                opacity: optimizing ? 0.6 : 1,
              }}>
                {optimizing ? 'Optimizing...' : 'Optimize Routes'}
              </button>
            </>
          )}
          {activeTab !== 'board' && (
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

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
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
      </div>

      {/* ── Protocol Reference ── */}
      {activeTab === 'protocols' && <ProtocolReferenceTab />}

      {/* ── AI Dispatch Panels ── */}
      {activeTab === 'routes' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><RoutePanel date={date} /></Suspense>}
      {activeTab === 'match' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><TechMatchPanel /></Suspense>}
      {activeTab === 'csr' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><CSRPanel /></Suspense>}
      {activeTab === 'revenue' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><RevenuePanel date={date} /></Suspense>}
      {activeTab === 'insights' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>}><InsightsPanel /></Suspense>}

      {/* ── Board Tab Content ── */}
      {activeTab === 'board' && <>

      {/* Weather bar placeholder */}
      <div style={{
        background: D.card, borderRadius: 10, padding: '10px 18px', marginBottom: 20,
        border: `1px solid ${D.border}`, fontSize: 13, color: D.text,
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <span>82F Clear</span>
        <span style={{ color: D.green, fontWeight: 700 }}>SPRAY: GO</span>
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
          onProtocol={svc => setProtocolService(svc)}
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
                  onProtocol={svc2 => setProtocolService(svc2)}
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
