import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import {
  CompletionPanel,
  RescheduleModal,
  EditServiceModal,
  ProtocolPanel,
} from './SchedulePage';
import ProtocolReferenceTabV2 from './ProtocolReferenceTabV2';
import { ViewModeSelectorV2, MonthViewV2 } from '../../components/schedule/CalendarViewsV2';
import TimeGridDay from '../../components/schedule/TimeGridDay';
import TimeGridDays from '../../components/schedule/TimeGridDays';
import RecurringAlertsBannerV2 from '../../components/schedule/RecurringAlertsBannerV2';
import CreateAppointmentModal from '../../components/schedule/CreateAppointmentModal';
import ScheduleIntelligenceBarV2 from '../../components/admin/ScheduleIntelligenceBarV2';
import HorizontalScroll from '../../components/HorizontalScroll';
import useIsMobile from '../../hooks/useIsMobile';
import { Button, Badge, Card, CardBody, cn } from '../../components/ui';

const TechMatchPanel = lazy(() => import('../../components/dispatch/TechMatchPanelV2'));
const CSRPanel = lazy(() => import('../../components/dispatch/CSRPanelV2'));
const RevenuePanel = lazy(() => import('../../components/dispatch/RevenuePanelV2'));
const InsightsPanel = lazy(() => import('../../components/dispatch/InsightsPanelV2'));

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const SKIP_REASONS = [
  { value: 'not_home', label: 'Customer not home' },
  { value: 'inaccessible', label: 'Property inaccessible' },
  { value: 'weather', label: 'Weather' },
  { value: 'customer_requested', label: 'Customer requested' },
  { value: 'tech_behind', label: 'Tech running behind' },
];

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); }
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(text || `${r.status} ${r.statusText}`);
    }
    return r.json();
  });
}

function googleMapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || '')}`;
}

function detectServiceCategory(serviceType) {
  const t = (serviceType || '').toLowerCase();
  if (t.includes('lawn')) return 'lawn';
  if (t.includes('mosquito')) return 'mosquito';
  return 'pest';
}

function formatDateISO(d) {
  return d.toISOString().slice(0, 10);
}

function formatDateDisplay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function isToday(dateStr) {
  return dateStr === formatDateISO(new Date());
}

function sanitizeServiceTypeClient(serviceType) {
  if (!serviceType) return 'General Service';
  if (/^[A-Z0-9]{5,}$/.test(serviceType)) return 'General Service';
  return serviceType
    .replace(/\s*[-\u2013]\s*\d+\s*(hour|hr|min|minute)s?\b/gi, '')
    .replace(/\s*[-\u2013]\s*\$[\d,.]+/g, '')
    .replace(/\s*[-\u2013]\s*$/g, '')
    .trim() || 'General Service';
}

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

function groupMultiServiceStops(services) {
  const groups = {};
  const singles = [];
  services.forEach((svc) => {
    const key = `${svc.customerId || svc.customer_id || ''}_${svc.scheduledDate || ''}_${svc.windowStart || ''}`;
    if (!svc.customerId && !svc.customer_id) { singles.push(svc); return; }
    if (!groups[key]) groups[key] = [];
    groups[key].push(svc);
  });
  const result = [];
  Object.values(groups).forEach((group) => {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      const primary = { ...group[0] };
      primary._multiServices = group;
      primary._extraServiceTypes = group.slice(1).map((s) => sanitizeServiceTypeClient(s.serviceType));
      result.push(primary);
    }
  });
  return [...result, ...singles];
}

// Status → Badge tone. completed/skipped = strong/alert; in-flight = neutral; pending = neutral.
function statusTone(status) {
  if (status === 'completed') return 'strong';
  if (status === 'skipped') return 'alert';
  return 'neutral';
}
function statusLabel(status) {
  return (
    { pending: 'Pending', confirmed: 'Confirmed', en_route: 'En Route', on_site: 'On Site', completed: 'Completed', skipped: 'Skipped' }[status] || status
  );
}

function TierBadge({ tier }) {
  if (!tier) return null;
  return <Badge className="ml-2" tone="neutral">{tier}</Badge>;
}

function LeadScoreBadge({ score }) {
  if (score == null) return null;
  const tone = score >= 80 ? 'strong' : score >= 50 ? 'neutral' : 'alert';
  return <Badge className="ml-1" tone={tone}>Lead {score}</Badge>;
}

function PropertyAlertsV2({ alerts }) {
  if (!alerts || alerts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-2">
      {alerts.map((a, i) => (
        <Badge key={i} tone="alert">{a.icon || '!'} {a.text || a.message || a.label || String(a)}</Badge>
      ))}
    </div>
  );
}

function ServiceCardV2({ service, zoneColors, onStatusChange, onComplete, onReschedule, onDelete, onProtocol, onEdit }) {
  const [updating, setUpdating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editType, setEditType] = useState(service.serviceType || '');
  const [editDuration, setEditDuration] = useState(service.estimatedDuration || 30);
  const [editQuery, setEditQuery] = useState('');
  const [serviceResults, setServiceResults] = useState([]);
  const [showServiceResults, setShowServiceResults] = useState(false);
  const [showSkipReasons, setShowSkipReasons] = useState(false);
  const [lawnUploading, setLawnUploading] = useState(false);
  const [lawnDone, setLawnDone] = useState(false);
  const lawnFileRef = useRef(null);

  useEffect(() => {
    if (!editing || editQuery.length < 2) { setServiceResults([]); return; }
    const t = setTimeout(() => {
      adminFetch(`/admin/services?search=${encodeURIComponent(editQuery)}&is_active=true&limit=10`)
        .then((d) => setServiceResults(d.services || []))
        .catch(() => setServiceResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [editQuery, editing]);

  const zoneColor = zoneColors?.[service.zone] || service.zoneColor || '#18181B';
  const status = service.status;
  const isLawn = detectServiceCategory(service.serviceType) === 'lawn';
  const dimmed = status === 'completed' || status === 'skipped';

  async function changeStatus(newStatus, notes) {
    setUpdating(true);
    try {
      await adminFetch(`/admin/schedule/${service.id}/status`, {
        method: 'PUT',
        body: JSON.stringify(notes ? { status: newStatus, notes } : { status: newStatus }),
      });
      onStatusChange(service.id, newStatus);
    } catch (e) {
      alert('Failed to update status: ' + e.message);
    }
    setUpdating(false);
  }

  async function saveEdit() {
    try {
      await adminFetch(`/admin/schedule/${service.id}/update-details`, {
        method: 'PUT',
        body: JSON.stringify({ serviceType: editType, estimatedDuration: parseInt(editDuration) || 30 }),
      });
      service.serviceType = editType;
      service.estimatedDuration = parseInt(editDuration) || 30;
      setEditing(false);
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  }

  async function handleLawnPhotos(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setLawnUploading(true);
    try {
      const photoData = await Promise.all(files.map((f) => new Promise((resolve, reject) => {
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
    } catch (err) {
      alert('Lawn assessment failed: ' + err.message);
    }
    setLawnUploading(false);
    if (lawnFileRef.current) lawnFileRef.current.value = '';
  }

  return (
    <div
      className={cn(
        'bg-white rounded-md border-hairline border-zinc-200 p-4 mb-3 transition-opacity',
        dimmed && 'opacity-60'
      )}
      style={{ borderLeft: `3px solid ${zoneColor}` }}
    >
      {/* Top row: route # + time | status */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="u-nums text-14 font-medium text-zinc-900">#{service.routeOrder}</span>
          <span className="u-nums text-12 text-ink-secondary">{service.windowDisplay || ''}</span>
        </div>
        <Badge dot tone={statusTone(status)}>{statusLabel(status)}</Badge>
      </div>

      {/* Customer name + badges */}
      <div className="mb-1">
        <span className="text-14 font-medium text-zinc-900">{service.customerName}</span>
        <TierBadge tier={service.waveguardTier} />
        <LeadScoreBadge score={service.leadScore} />
      </div>

      {/* Address + phone */}
      <a
        href={googleMapsUrl(service.address)}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-12 text-ink-secondary no-underline hover:text-zinc-900 mb-1"
      >
        {service.address}
      </a>
      <div className="flex items-center gap-2 mb-2">
        <span className="u-nums text-12 text-zinc-700">{service.customerPhone}</span>
        <button
          type="button"
          title="Call via Waves number"
          onClick={async () => {
            if (!service.customerPhone) return;
            if (!window.confirm(`Call ${service.customerName || 'customer'} at ${service.customerPhone}?\n\nWaves will call your phone first — press 1 to connect.`)) return;
            try {
              const r = await adminFetch('/admin/communications/call', { method: 'POST', body: JSON.stringify({ to: service.customerPhone }) });
              if (!r?.success) alert('Call failed: ' + (r?.error || 'unknown error'));
            } catch (e) { alert('Call failed: ' + e.message); }
          }}
          className="text-12 u-focus-ring text-zinc-600 hover:text-zinc-900"
        >
          Call
        </button>
        <a
          href={`/admin/communications?phone=${encodeURIComponent(service.customerPhone || '')}`}
          className="text-12 u-focus-ring text-zinc-600 hover:text-zinc-900 no-underline"
        >
          Message
        </a>
      </div>

      {/* Service type + duration */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {editing ? (
          <>
            <div className="relative">
              <input
                value={editType}
                onChange={(e) => { setEditType(e.target.value); setEditQuery(e.target.value); setShowServiceResults(true); }}
                onFocus={() => setShowServiceResults(true)}
                onBlur={() => setTimeout(() => setShowServiceResults(false), 150)}
                placeholder="Search service library..."
                className="h-8 text-12 px-2 rounded-sm bg-white border-hairline border-zinc-300 u-focus-ring w-56"
              />
              {showServiceResults && serviceResults.length > 0 && (
                <div className="absolute top-full left-0 mt-1 min-w-[280px] bg-white border-hairline border-zinc-200 rounded-sm z-30 max-h-60 overflow-auto shadow-md">
                  {serviceResults.map((svc) => (
                    <div
                      key={svc.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setEditType(svc.name);
                        if (svc.default_duration_minutes) setEditDuration(String(svc.default_duration_minutes));
                        setShowServiceResults(false);
                      }}
                      className="px-3 py-2 text-12 border-b-hairline border-zinc-100 hover:bg-zinc-50 cursor-pointer flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-zinc-900 truncate">{svc.name}</div>
                        {svc.short_name && svc.short_name !== svc.name && (
                          <div className="text-11 text-ink-secondary mt-0.5">{svc.short_name}</div>
                        )}
                      </div>
                      {svc.default_duration_minutes && (
                        <span className="u-nums text-11 text-ink-secondary whitespace-nowrap">{svc.default_duration_minutes}m</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <input
              type="number"
              value={editDuration}
              onChange={(e) => setEditDuration(e.target.value)}
              className="h-8 text-12 px-2 rounded-sm bg-white border-hairline border-zinc-300 u-focus-ring w-14 u-nums"
            />
            <span className="text-11 text-ink-secondary">min</span>
            <Button size="sm" onClick={saveEdit}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center h-6 px-2 bg-zinc-100 text-12 font-medium text-zinc-900 rounded-xs u-focus-ring hover:bg-zinc-200"
            >
              {sanitizeServiceTypeClient(service.serviceType)}
            </button>
            {service.estimatedDuration && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-11 text-ink-secondary u-focus-ring hover:text-zinc-900"
              >
                ~{service.estimatedDuration} min
              </button>
            )}
          </>
        )}
      </div>

      <PropertyAlertsV2 alerts={service.propertyAlerts} />

      {/* Comms status row */}
      <div className="flex gap-3 mb-2">
        <span className={cn('flex items-center gap-1 text-11', service.reminderSent ? 'text-zinc-900' : 'text-ink-tertiary')}>
          <span className={cn('u-dot', service.reminderSent ? 'u-dot--filled' : 'u-dot--hollow')} />
          Reminder
        </span>
        <span className={cn('flex items-center gap-1 text-11', service.customerConfirmed ? 'text-zinc-900' : 'text-ink-tertiary')}>
          <span className={cn('u-dot', service.customerConfirmed ? 'u-dot--filled' : 'u-dot--hollow')} />
          Confirmed
        </span>
        <span className={cn('flex items-center gap-1 text-11', service.enRouteSent ? 'text-zinc-900' : 'text-ink-tertiary')}>
          <span className={cn('u-dot', service.enRouteSent ? 'u-dot--filled' : 'u-dot--hollow')} />
          En Route
        </span>
      </div>

      {/* Last service */}
      {service.lastServiceDate && (
        <div className="text-11 italic text-ink-secondary mb-2 leading-snug">
          Last: {(() => {
            try {
              const d = new Date(service.lastServiceDate + 'T12:00:00');
              return isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            } catch { return 'Unknown date'; }
          })()}
          {service.lastServiceType && <> — {service.lastServiceType}</>}
          {service.lastServiceNotes && (() => {
            const cleaned = stripLegacyBoilerplate(service.lastServiceNotes);
            if (!cleaned) return null;
            return <> — {cleaned.substring(0, 100)}{cleaned.length > 100 ? '...' : ''}</>;
          })()}
        </div>
      )}
      {!service.lastServiceDate && !service.isNewCustomer && (
        <div className="text-11 italic text-ink-secondary mb-2">No previous service on record</div>
      )}

      {/* Materials */}
      {service.materialsNeeded && service.materialsNeeded.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {service.materialsNeeded.map((m, i) => (
            <Badge key={i} tone="neutral">{m}</Badge>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mt-3">
        {status !== 'completed' && status !== 'skipped' && (
          <>
            {status !== 'en_route' && status !== 'on_site' && (
              <Button size="sm" onClick={() => changeStatus('en_route')} disabled={updating}>En Route</Button>
            )}
            {status === 'en_route' && (
              <Button size="sm" onClick={() => changeStatus('on_site')} disabled={updating}>On Site</Button>
            )}
            <Button size="sm" onClick={() => onComplete(service)}>Complete</Button>
            <div className="relative inline-block">
              <Button size="sm" variant="secondary" onClick={() => setShowSkipReasons((s) => !s)} disabled={updating}>Skip</Button>
              {showSkipReasons && (
                <div className="absolute top-full left-0 mt-1 z-50 bg-white border-hairline border-zinc-200 rounded-sm p-1 min-w-[200px] shadow-md">
                  {SKIP_REASONS.map((r) => (
                    <button
                      key={r.value}
                      onClick={async () => { setShowSkipReasons(false); await changeStatus('skipped', `Skip reason: ${r.label}`); }}
                      className="block w-full text-left px-3 py-2 text-12 text-zinc-900 hover:bg-zinc-50 rounded-xs u-focus-ring"
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {status === 'completed' && <Badge tone="strong">Completed</Badge>}
        <Button size="sm" variant="secondary" onClick={() => onProtocol?.(service)}>Protocol</Button>
        {isLawn && !lawnDone && (
          <>
            <input ref={lawnFileRef} type="file" accept="image/*" multiple capture="environment" onChange={handleLawnPhotos} className="hidden" />
            <Button size="sm" variant="secondary" onClick={() => lawnFileRef.current?.click()} disabled={lawnUploading}>
              {lawnUploading ? 'Analyzing…' : 'Lawn Photos'}
            </Button>
          </>
        )}
        {isLawn && lawnDone && <Badge tone="strong">Lawn Assessed</Badge>}
        <Button size="sm" variant="secondary" onClick={() => onEdit?.(service)}>Edit</Button>
        {status !== 'completed' && status !== 'skipped' && (
          <>
            <Button size="sm" variant="secondary" onClick={() => onReschedule?.(service)}>Reschedule</Button>
            <Button size="sm" variant="danger" onClick={() => onDelete?.(service)}>Delete</Button>
          </>
        )}
      </div>
    </div>
  );
}

function TechSectionV2({ tech, zoneColors, zoneLabels, onStatusChange, onComplete, onReschedule, onDelete, onProtocol, onEdit }) {
  const [collapsed, setCollapsed] = useState(false);
  const completedCount = tech.completedServices || tech.services.filter((s) => s.status === 'completed').length;
  const totalHrs = Math.round(((tech.estimatedServiceMinutes || 0) + (tech.estimatedDriveMinutes || 0)) / 60 * 10) / 10;
  const consolidated = groupMultiServiceStops(tech.services);
  const initials = tech.initials || tech.technicianName?.split(' ').map((w) => w[0]).join('').toUpperCase() || '?';

  return (
    <div className="mb-5">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full bg-white border-hairline border-zinc-200 rounded-md px-4 py-3 cursor-pointer select-none flex items-center gap-3 flex-wrap u-focus-ring hover:bg-zinc-50 text-left"
      >
        <div className="w-10 h-10 rounded-sm bg-zinc-900 text-white flex items-center justify-center font-medium text-13 flex-shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-[140px]">
          <div className="text-14 font-medium text-zinc-900">
            {tech.technicianName}
            <span className="u-nums text-12 font-normal text-ink-secondary ml-3">
              {completedCount}/{tech.totalServices || tech.services.length} done · ~{totalHrs}h
            </span>
          </div>
          {tech.zones && Object.keys(tech.zones).length > 0 && (
            <div className="flex gap-3 mt-1 flex-wrap">
              {Object.entries(tech.zones).map(([zone, count]) => (
                <span key={zone} className="flex items-center gap-1.5 text-11 text-ink-secondary">
                  <span className="w-2 h-2 rounded-full" style={{ background: zoneColors?.[zone] || '#71717A' }} />
                  {zoneLabels?.[zone] || zone} ({count})
                </span>
              ))}
            </div>
          )}
          {tech.loadList && tech.loadList.length > 0 && (
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {tech.loadList.map((item, i) => (
                <Badge key={i} tone="neutral">{item}</Badge>
              ))}
            </div>
          )}
        </div>
        <span
          className="text-14 text-ink-secondary transition-transform"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
        >
          ▾
        </span>
      </button>

      {!collapsed && (
        <div className="pl-5 pt-3">
          {consolidated.map((svc) => (
            <div key={svc.id}>
              {svc._extraServiceTypes && svc._extraServiceTypes.length > 0 && (
                <div className="flex gap-1 mb-1 flex-wrap pl-1">
                  <span className="u-label text-ink-secondary">Multi-service stop:</span>
                  {[sanitizeServiceTypeClient(svc.serviceType), ...svc._extraServiceTypes].map((t, i) => (
                    <Badge key={i} tone="neutral">{t}</Badge>
                  ))}
                </div>
              )}
              <ServiceCardV2
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

const SCHEDULE_TABS = [
  { id: 'board', label: 'Board' },
  { id: 'protocols', label: 'Protocols' },
  { id: 'match', label: 'Tech Match' },
  { id: 'csr', label: 'CSR Booking' },
  { id: 'revenue', label: 'Job Scores' },
  { id: 'insights', label: 'Insights' },
];

export default function DispatchPageV2() {
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
  const [newApptDefaults, setNewApptDefaults] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

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
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => { fetchSchedule(date); }, [date, fetchSchedule]);

  const syncDispatchAI = async () => {
    setSyncing(true); setSyncMsg('');
    try {
      const res = await fetch(`${API_BASE}/dispatch/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      const d = await res.json();
      setSyncMsg(`Synced ${d.bridge?.synced || 0} jobs from schedule`);
      setTimeout(() => setSyncMsg(''), 5000);
    } catch { setSyncMsg('Sync failed'); }
    setSyncing(false);
  };

  const handleStatusChange = useCallback((serviceId, newStatus) => {
    setData((prev) => {
      if (!prev) return prev;
      const nowIso = new Date().toISOString();
      const updatedServices = prev.services.map((s) =>
        s.id === serviceId ? { ...s, status: newStatus, statusLog: [...(s.statusLog || []), { status: newStatus, at: nowIso }] } : s
      );
      const updatedTechSummary = prev.techSummary.map((tech) => ({
        ...tech,
        services: tech.services.map((s) =>
          s.id === serviceId ? { ...s, status: newStatus, statusLog: [...(s.statusLog || []), { status: newStatus, at: nowIso }] } : s
        ),
        completedServices: tech.services.filter((s) =>
          s.id === serviceId ? newStatus === 'completed' : s.status === 'completed'
        ).length,
      }));
      return { ...prev, services: updatedServices, techSummary: updatedTechSummary };
    });
  }, []);

  const handleComplete = useCallback((service) => { setCompletingService(service); }, []);

  const handleCompleteSubmit = useCallback(async (serviceId, body) => {
    await adminFetch(`/admin/dispatch/${serviceId}/complete`, { method: 'POST', body: JSON.stringify(body) });
    handleStatusChange(serviceId, 'completed');
  }, [handleStatusChange]);

  const handleDelete = useCallback(async (service) => {
    const name = service.customerName || service.customer_name || 'this customer';
    if (!window.confirm(`Delete service for ${name}?\n\nThis will cancel the scheduled service.`)) return;
    try {
      await adminFetch(`/admin/schedule/${service.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          services: prev.services.filter((s) => s.id !== service.id),
          techSummary: prev.techSummary.map((tech) => ({
            ...tech,
            services: tech.services.filter((s) => s.id !== service.id),
            totalServices: tech.services.filter((s) => s.id !== service.id).length,
          })),
        };
      });
    } catch (err) { alert('Failed to delete service: ' + err.message); }
  }, []);

  function shiftDate(dir) {
    const d = new Date(date + 'T12:00:00');
    if (viewMode === 'day') d.setDate(d.getDate() + dir);
    else if (viewMode === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setDate(formatDateISO(d));
  }

  if (loading) return <div className="py-16 text-center text-13 text-ink-secondary">Loading schedule…</div>;
  if (error) return <div className="py-16 text-center text-13 text-alert-fg">Failed to load schedule: {error}</div>;
  if (!data) return null;

  const services = data.services || [];
  const techSummary = data.techSummary || [];
  const unassigned = data.unassigned || [];
  const technicians = data.technicians || [];
  const zoneColors = data.zoneColors || {};
  const zoneLabels = data.zoneLabels || {};

  const totalCount = services.length;
  const completedCount = services.filter((s) => s.status === 'completed').length;
  const skippedCount = services.filter((s) => s.status === 'skipped').length;
  const remainingCount = totalCount - completedCount - skippedCount;

  const AVG_SERVICE_MIN = 35;
  const estTotalMin = totalCount * AVG_SERVICE_MIN;
  const estTotalHrs = Math.floor(estTotalMin / 60);
  const estTotalMinRemainder = estTotalMin % 60;
  const estRemainingMin = remainingCount * AVG_SERVICE_MIN;
  const estFinishTime = (() => {
    const finish = new Date(Date.now() + estRemainingMin * 60000);
    return finish.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  })();
  const estRevenue = services.reduce((sum, s) => sum + (s.price || 125), 0);

  const unassignedCount = unassigned.length;
  const newCustomers = services.filter((s) => !s.lastServiceDate);
  const weatherData = data.weather || {};
  const rainProbability = weatherData.rainProbability ?? weatherData.rain_probability ?? null;
  const windSpeed = weatherData.windSpeed ?? weatherData.wind_speed ?? null;
  const weatherTemp = weatherData.temp ?? weatherData.temperature ?? null;
  const hasRainAlert = rainProbability != null && rainProbability > 40;
  const hasFocusAlerts = unassignedCount > 0 || newCustomers.length > 0 || hasRainAlert;
  const sprayHold = (rainProbability != null && rainProbability > 50) || (windSpeed != null && windSpeed > 15);

  const dateHeader = viewMode === 'day'
    ? formatDateDisplay(date)
    : viewMode === 'week'
      ? (() => {
          const d = new Date(date + 'T12:00:00');
          const end = new Date(d); end.setDate(end.getDate() + 6);
          return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        })()
      : new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="bg-surface-page min-h-full p-4 md:p-6 font-sans text-zinc-900">
      {/* Header */}
      <div className="flex justify-between items-start mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-28 font-medium tracking-h1 text-zinc-900">Schedule &amp; Dispatch</h1>
          <div className="flex items-center gap-2 mt-2 justify-between flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => shiftDate(-1)}
                className="w-8 h-8 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-700 text-12 u-focus-ring hover:bg-zinc-50 inline-flex items-center justify-center"
                title="Previous"
              >
                ◀
              </button>
              <span
                className="u-nums text-13 font-medium text-zinc-900 text-center"
                style={{ minWidth: isMobile ? 0 : 220, flex: isMobile ? 1 : undefined }}
              >
                {dateHeader}
              </span>
              <button
                type="button"
                onClick={() => shiftDate(1)}
                className="w-8 h-8 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-700 text-12 u-focus-ring hover:bg-zinc-50 inline-flex items-center justify-center"
                title="Next"
              >
                ▶
              </button>
              {!isToday(date) && (
                <Button size="sm" variant="secondary" onClick={() => setDate(formatDateISO(new Date()))}>Today</Button>
              )}
            </div>
            <ViewModeSelectorV2 viewMode={viewMode} onViewModeChange={(m) => { setViewMode(m); if (m === 'day') setActiveTab('board'); }} />
          </div>
        </div>

        <div className="flex gap-2 items-center flex-wrap">
          {viewMode === 'day' && activeTab === 'board' && (
            <>
              <div className="flex gap-3 items-center text-12 text-ink-secondary bg-white px-3 py-2 rounded-sm border-hairline border-zinc-200 flex-wrap">
                <span><span className="u-nums font-medium text-zinc-900">{totalCount}</span> services</span>
                <span><span className="u-nums font-medium text-zinc-900">{completedCount}</span> done</span>
                <span><span className={cn('u-nums font-medium', remainingCount > 0 ? 'text-zinc-900' : 'text-ink-secondary')}>{remainingCount}</span> left</span>
                <span className="pl-3 border-l-hairline border-zinc-200">
                  ~{estTotalHrs}h{estTotalMinRemainder > 0 ? `${estTotalMinRemainder}m` : ''} total
                </span>
                <span>ETA <span className="u-nums font-medium text-zinc-900">{estFinishTime}</span></span>
                <span className="pl-3 border-l-hairline border-zinc-200">
                  <span className="u-nums font-medium text-zinc-900">${estRevenue.toLocaleString()}</span> revenue
                </span>
              </div>
              <Button onClick={() => setShowNewAppt(true)}>+ New Appointment</Button>
            </>
          )}
          {viewMode === 'day' && activeTab !== 'board' && (
            <Button variant="secondary" onClick={syncDispatchAI} disabled={syncing}>
              {syncing ? 'Syncing…' : '↻ Sync AI Data'}
            </Button>
          )}
        </div>
      </div>
      {syncMsg && <div className="text-11 text-ink-secondary mb-2">{syncMsg}</div>}

      {showNewAppt && (
        <CreateAppointmentModal
          defaultDate={newApptDefaults?.date || date}
          defaultWindowStart={newApptDefaults?.windowStart}
          defaultTechId={newApptDefaults?.techId}
          onClose={() => { setShowNewAppt(false); setNewApptDefaults(null); }}
          onCreated={(appt) => {
            setShowNewAppt(false);
            setNewApptDefaults(null);
            fetchSchedule(appt.scheduledDate || date);
          }}
        />
      )}

      {/* Week / 5-Day = Square-style time grid (drag to reschedule). Month = summary grid. */}
      {viewMode === 'week' && (
        <TimeGridDays
          date={date}
          dayCount={7}
          selectedDate={date}
          onEdit={(svc) => setEditingService(svc)}
          onChange={() => fetchSchedule(date)}
        />
      )}
      {viewMode === '5day' && (
        <TimeGridDays
          date={date}
          dayCount={5}
          selectedDate={date}
          onEdit={(svc) => setEditingService(svc)}
          onChange={() => fetchSchedule(date)}
        />
      )}
      {viewMode === 'month' && <MonthViewV2 date={date} onDateClick={(d) => { setDate(d); setViewMode('day'); }} />}

      {/* Tabs bar — day view only */}
      {viewMode === 'day' && (
        <div className="mb-5 bg-white rounded-md p-1 border-hairline border-zinc-200">
          <HorizontalScroll gap={4} edgeBleed={4} style={{ paddingBottom: 0 }}>
            {SCHEDULE_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  'px-4 h-9 rounded-sm text-12 font-medium uppercase tracking-label whitespace-nowrap flex-shrink-0 u-focus-ring transition-colors',
                  activeTab === t.id ? 'bg-zinc-900 text-white' : 'bg-transparent text-ink-secondary hover:bg-zinc-50'
                )}
              >
                {t.label}
              </button>
            ))}
          </HorizontalScroll>
        </div>
      )}

      {viewMode === 'day' && <RecurringAlertsBannerV2 />}

      {viewMode === 'day' && (
        <ScheduleIntelligenceBarV2 date={date} scheduleData={data} onRefresh={() => fetchSchedule(date)} />
      )}

      {/* Non-board tabs — V2 monochrome panels (Match/CSR/Revenue/Insights/Protocols). */}
      {viewMode === 'day' && activeTab === 'protocols' && <ProtocolReferenceTabV2 />}
      {viewMode === 'day' && activeTab === 'match' && (
        <Suspense fallback={<div className="py-10 text-center text-13 text-ink-secondary">Loading…</div>}><TechMatchPanel /></Suspense>
      )}
      {viewMode === 'day' && activeTab === 'csr' && (
        <Suspense fallback={<div className="py-10 text-center text-13 text-ink-secondary">Loading…</div>}><CSRPanel /></Suspense>
      )}
      {viewMode === 'day' && activeTab === 'revenue' && (
        <Suspense fallback={<div className="py-10 text-center text-13 text-ink-secondary">Loading…</div>}><RevenuePanel date={date} /></Suspense>
      )}
      {viewMode === 'day' && activeTab === 'insights' && (
        <Suspense fallback={<div className="py-10 text-center text-13 text-ink-secondary">Loading…</div>}><InsightsPanel /></Suspense>
      )}

      {/* Board tab content */}
      {viewMode === 'day' && activeTab === 'board' && (
        <>
          {hasFocusAlerts && (
            <Card className="mb-3">
              <CardBody className="py-3">
                <div className="u-label text-ink-secondary mb-1">Today's Focus</div>
                {unassignedCount > 0 && (
                  <div className="text-13 font-medium text-alert-fg">
                    {unassignedCount} service{unassignedCount > 1 ? 's' : ''} unassigned — assign techs
                  </div>
                )}
                {newCustomers.length > 0 && (
                  <div className="text-13 font-medium text-zinc-900">
                    {newCustomers.length} new customer{newCustomers.length > 1 ? 's' : ''} today (first visit)
                  </div>
                )}
                {hasRainAlert && (
                  <div className="text-13 font-medium text-zinc-900">
                    Rain expected ({rainProbability}% chance) — monitor spray conditions
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          {/* Weather bar */}
          <div className="bg-white border-hairline border-zinc-200 rounded-sm px-4 py-2.5 mb-5 flex items-center gap-4 flex-wrap text-12 text-zinc-700">
            <span className="u-nums">{weatherTemp ?? 82}°F</span>
            {windSpeed != null && <span className="u-nums">{windSpeed} mph</span>}
            {rainProbability != null && <span className="u-nums">{rainProbability}% rain</span>}
            <span className={cn('font-medium uppercase tracking-label', sprayHold ? 'text-alert-fg' : 'text-zinc-900')}>
              SPRAY: {sprayHold ? 'HOLD' : 'GO'}
            </span>
          </div>

          {/* Calendar-style time grid */}
          <TimeGridDay
            date={date}
            services={services}
            technicians={technicians}
            onEdit={(svc) => setEditingService(svc)}
            onChange={() => fetchSchedule(date)}
            onDateChange={setDate}
            onCreateSlot={({ date: slotDate, windowStart, techId }) => {
              setNewApptDefaults({ date: slotDate, windowStart, techId });
              setShowNewAppt(true);
            }}
          />
        </>
      )}

      {/* Modals — V1 components, unchanged */}
      {completingService && (
        <CompletionPanel
          service={completingService}
          products={products}
          onClose={() => setCompletingService(null)}
          onSubmit={handleCompleteSubmit}
        />
      )}
      {rescheduleService && (
        <RescheduleModal
          service={rescheduleService}
          onClose={() => setRescheduleService(null)}
          onRescheduled={() => { setRescheduleService(null); fetchSchedule(date); }}
        />
      )}
      {editingService && (
        <EditServiceModal
          service={editingService}
          technicians={technicians}
          onClose={() => setEditingService(null)}
          onSaved={() => { setEditingService(null); fetchSchedule(date); }}
        />
      )}
      {protocolService && (
        <ProtocolPanel
          service={protocolService}
          onClose={() => setProtocolService(null)}
        />
      )}
    </div>
  );
}
