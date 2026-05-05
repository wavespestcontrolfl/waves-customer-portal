// client/src/pages/admin/DispatchPageV2.jsx
//
// Mobile-first orchestrator for /admin/dispatch under the dispatch-v2
// feature flag. Renders the day/week board, sidebars (TechMatchPanelV2 /
// CSRPanelV2 / RevenuePanelV2 / InsightsPanelV2), and on mobile manages
// the action-sheet stack (MobileAppointmentDetailSheet,
// MobileCheckoutSheet, MobilePaymentSheet, MobileServicePickerSheet, and
// the four payment tender sheets). Reuses CompletionPanel /
// RescheduleModal / EditServiceModal / ProtocolPanel from SchedulePage so
// the V1 modal logic is shared rather than re-implemented.
//
// Endpoints:
//   GET  /admin/dispatch/services?date=…
//   PATCH /admin/services/:id              (status, notes, tech assignment)
//   POST /admin/services/:id/complete      (final products + observations)
//   POST /admin/services/:id/reschedule
//   POST /admin/services/:id/payment       (cash/check/card/manual-card)
//   POST /admin/services/:id/refund
//   GET  /admin/techs/availability
//
// Mobile-shell-v2 rule (CLAUDE.md): under 768px the page renders inside
// MobileAdminShell with a bottom tab bar and StickyActionBar.
//
// Audit focus:
// - Action-sheet stack management — opening one sheet from inside another
//   (e.g. checkout → payment → cash tender) needs careful focus / scroll
//   restoration so the user doesn't lose context on dismiss.
// - Day-grid drag-drop (TimeGridDay / TimeGridDays) — race conditions
//   between optimistic local move and the PATCH /admin/services/:id call.
// - Sidebar lazy loading — Suspense boundaries around TechMatchPanelV2 etc.
//   should fail gracefully when the API for a panel times out.
// - Mobile vs desktop divergence — confirm the same appointment renders
//   the same details / action set on both, no orphaned mobile-only state
//   that desktop users can't reach.
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
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
import MobileWeekGrid from '../../components/schedule/MobileWeekGrid';
import MobileDispatchList from '../../components/schedule/MobileDispatchList';
import MobileAppointmentDetailSheet from '../../components/schedule/MobileAppointmentDetailSheet';
import MobileCheckoutSheet from '../../components/schedule/MobileCheckoutSheet';
import MobilePaymentSheet from '../../components/schedule/MobilePaymentSheet';
import MobileServiceEditModal from '../../components/schedule/MobileServiceEditModal';
import TreatmentPlanPanel from '../../components/schedule/TreatmentPlanPanel';
import MarkPrepaidModal from '../../components/schedule/MarkPrepaidModal';
import RecurringAlertsBannerV2 from '../../components/schedule/RecurringAlertsBannerV2';
import CreateAppointmentModal from '../../components/schedule/CreateAppointmentModal';
import ScheduleCustomerSidebar from '../../components/schedule/ScheduleCustomerSidebar';
import Customer360ProfileV2 from '../../components/admin/Customer360ProfileV2';
import HorizontalScroll from '../../components/HorizontalScroll';
import useIsMobile from '../../hooks/useIsMobile';
import { Button, Badge, Card, CardBody, cn } from '../../components/ui';
import { etDateString, etStartOfWeek, formatETDate, isETToday as isETTodayStr } from '../../lib/timezone';
import { adminFetch, isRateLimitError } from '../../utils/admin-fetch';

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

function googleMapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || '')}`;
}

function detectServiceCategory(serviceType) {
  const t = (serviceType || '').toLowerCase();
  if (t.includes('lawn')) return 'lawn';
  if (t.includes('mosquito')) return 'mosquito';
  return 'pest';
}

const formatDateISO = (d) => etDateString(d);

function dateAtNoonUTC(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function addDaysISO(dateStr, days) {
  const d = dateAtNoonUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonthsISO(dateStr, months) {
  const d = dateAtNoonUTC(dateStr);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function formatDateDisplay(dateStr) {
  return formatETDate(dateAtNoonUTC(dateStr), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

const isToday = (dateStr) => isETTodayStr(dateStr);

// "08:00", "09:30" → 90. Returns undefined for missing/malformed input so the
// modal can fall back to the chosen service's default duration.
function slotDurationMinutes(start, end) {
  if (!start || !end) return undefined;
  const sm = start.match(/^(\d{1,2}):(\d{2})/);
  const em = end.match(/^(\d{1,2}):(\d{2})/);
  if (!sm || !em) return undefined;
  const minutes = (Number(em[1]) * 60 + Number(em[2])) - (Number(sm[1]) * 60 + Number(sm[2]));
  return minutes > 0 ? minutes : undefined;
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

function ServiceCardV2({ service, zoneColors, onStatusChange, onComplete, onReschedule, onDelete, onProtocol, onTreatmentPlan, onViewAudit, onEdit }) {
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
  const [sendingReview, setSendingReview] = useState(false);
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

  async function sendReview() {
    if (!service.customerId) return;
    if (!window.confirm(`Send review request SMS to ${service.customerName || 'customer'}?`)) return;
    setSendingReview(true);
    try {
      await adminFetch('/admin/review-requests/trigger', {
        method: 'POST',
        body: JSON.stringify({ customerId: service.customerId, triggeredBy: 'tech' }),
      });
    } catch (e) {
      alert('Review send failed: ' + e.message);
    }
    setSendingReview(false);
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
              const r = await adminFetch('/admin/communications/call', { method: 'POST', body: JSON.stringify({ to: service.customerPhone, fromNumber: '+19412975749' }) });
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
                className="h-11 md:h-8 text-16 md:text-12 px-2 rounded-sm bg-white border-hairline border-zinc-300 u-focus-ring w-56"
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
              className="h-11 md:h-8 text-16 md:text-12 px-2 rounded-sm bg-white border-hairline border-zinc-300 u-focus-ring w-14 u-nums"
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
            <Button size="sm" variant="secondary" onClick={sendReview} disabled={sendingReview || !service.customerId}>
              {sendingReview ? 'Sending…' : 'Review'}
            </Button>
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
        {status === 'completed' && service.customerId && (
          <Button size="sm" variant="secondary" onClick={() => onViewAudit?.(service)}>View Audit</Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => onProtocol?.(service)}>Protocol</Button>
        {isLawn && <Button size="sm" variant="secondary" onClick={() => onTreatmentPlan?.(service)}>Treatment Plan</Button>}
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

function TechSectionV2({ tech, zoneColors, zoneLabels, onStatusChange, onComplete, onReschedule, onDelete, onProtocol, onTreatmentPlan, onViewAudit, onEdit }) {
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
                onTreatmentPlan={onTreatmentPlan}
                onViewAudit={onViewAudit}
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
  { id: 'board', label: 'Schedule' },
  { id: 'protocols', label: 'Protocols' },
  { id: 'match', label: 'Tech Match', desktopOnly: true },
  { id: 'csr', label: 'CSR Booking', desktopOnly: true },
  { id: 'revenue', label: 'Job Scores', desktopOnly: true },
  { id: 'insights', label: 'Insights', desktopOnly: true },
];

function MobileScheduleSheet({ children, serviceCount, completedCount }) {
  const [snap, setSnap] = useState('half');
  const sheetRef = useRef(null);
  const dragRef = useRef(null);

  const getHeight = (s) => {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    if (s === 'peek') return 120;
    if (s === 'half') return Math.round(vh * 0.5);
    return Math.round(vh * 0.9);
  };

  useEffect(() => {
    if (!sheetRef.current) return;
    sheetRef.current.style.transition = 'height 300ms cubic-bezier(0.34, 1.56, 0.64, 1)';
    sheetRef.current.style.height = `${getHeight(snap)}px`;
  }, [snap]);

  const onTouchStart = (e) => {
    dragRef.current = {
      y: e.touches[0].clientY,
      h: sheetRef.current ? sheetRef.current.offsetHeight : getHeight(snap),
    };
  };

  const onTouchMove = (e) => {
    if (!dragRef.current || !sheetRef.current) return;
    const dy = dragRef.current.y - e.touches[0].clientY;
    const vh = window.innerHeight;
    const newH = Math.max(120, Math.min(vh * 0.9, dragRef.current.h + dy));
    sheetRef.current.style.transition = 'none';
    sheetRef.current.style.height = `${newH}px`;
  };

  const onTouchEnd = () => {
    if (!dragRef.current || !sheetRef.current) return;
    const currentH = sheetRef.current.offsetHeight;
    const vh = window.innerHeight;
    const targets = [
      ['peek', 120],
      ['half', Math.round(vh * 0.5)],
      ['full', Math.round(vh * 0.9)],
    ];
    targets.sort((a, b) => Math.abs(currentH - a[1]) - Math.abs(currentH - b[1]));
    setSnap(targets[0][0]);
    dragRef.current = null;
  };

  return (
    <div
      ref={sheetRef}
      className="fixed left-0 right-0 z-40 bg-white border-t border-hairline border-zinc-200 rounded-t-md shadow-lg flex flex-col md:hidden"
      style={{
        bottom: 'calc(56px + env(safe-area-inset-bottom))',
        height: `${getHeight(snap)}px`,
      }}
    >
      <div
        className="flex-shrink-0 select-none"
        style={{ touchAction: 'none' }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="pt-2 pb-1">
          <div className="w-9 h-[5px] bg-zinc-400 rounded-full mx-auto" />
        </div>
        <div className="px-4 pt-1 pb-3 flex items-center justify-between border-b border-hairline border-zinc-100">
          <div className="flex items-baseline gap-1.5">
            <span className="u-nums text-16 font-medium text-ink-primary">{serviceCount}</span>
            <span className="text-13 text-ink-secondary">job{serviceCount === 1 ? '' : 's'} today</span>
            {completedCount > 0 && (
              <>
                <span className="text-zinc-300 mx-1">·</span>
                <span className="u-nums text-13 text-ink-secondary">{completedCount} done</span>
              </>
            )}
          </div>
          <button
            onClick={() => setSnap(snap === 'peek' ? 'full' : 'peek')}
            className="text-11 u-label text-ink-secondary h-8 px-2 u-focus-ring"
          >
            {snap === 'peek' ? 'Expand' : 'Collapse'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
        {children}
      </div>
    </div>
  );
}

export default function DispatchPageV2({ activeTab: controlledActiveTab, setOpenCreateHandler } = {}) {
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  // Controlled mode: when AdminDispatchPage drives the active sub-tab via
  // the top-level pill, the internal tab strip + mobile pills + More sheet
  // are hidden and `setActiveTab` becomes a no-op.
  const isControlled = controlledActiveTab !== undefined;
  const [internalActiveTab, setInternalActiveTab] = useState('board');
  const activeTab = isControlled ? controlledActiveTab : internalActiveTab;
  const setActiveTab = isControlled ? () => {} : setInternalActiveTab;

  // On mobile, desktopOnly tabs (Tech Match / CSR / Job Scores / Insights) are
  // hidden from both the top row and the More sheet. If a returning user's
  // persisted activeTab is one of those, snap back to 'board' so they don't
  // land on a panel they can't navigate away from. Skip in controlled mode —
  // the parent owns the active tab.
  useEffect(() => {
    if (isControlled || !isMobile) return;
    const current = SCHEDULE_TABS.find((t) => t.id === activeTab);
    if (current?.desktopOnly) setInternalActiveTab('board');
  }, [isControlled, isMobile, activeTab]);
  // Default desktop to Week (multi-day grid); phones still open on Day,
  // which is what techs and Virginia want when triaging in the field.
  const [viewMode, setViewMode] = useState(() => {
    // In controlled mode with a non-board sub-tab (Protocols / Tech Match
    // / CSR / Job Scores / Insights), the panel only renders when
    // viewMode === 'day'. Initialize to 'day' so deep-linking to those
    // tabs (e.g. /admin/dispatch?tab=protocols) doesn't render the week
    // calendar instead of the requested panel.
    if (isControlled && controlledActiveTab !== 'board') return 'day';
    if (typeof window === 'undefined') return 'week';
    return window.matchMedia('(max-width: 767px)').matches ? 'day' : 'week';
  });

  // Same idea for *runtime* tab swaps from AdminDispatchPage's pill: if
  // the parent flips activeTab to a non-board sub-tab while we're sitting
  // on Week / 5-Day / Month, snap back to Day so the panel renders.
  useEffect(() => {
    if (!isControlled) return;
    if (controlledActiveTab !== 'board' && viewMode !== 'day') {
      setViewMode('day');
    }
  }, [isControlled, controlledActiveTab, viewMode]);
  const [date, setDate] = useState(formatDateISO(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [products, setProducts] = useState([]);
  const [completingService, setCompletingService] = useState(null);
  const [rescheduleService, setRescheduleService] = useState(null);
  const [editingService, setEditingService] = useState(null);
  const [detailService, setDetailService] = useState(null);
  const [checkoutService, setCheckoutService] = useState(null);
  const [paymentData, setPaymentData] = useState(null);
  const [editingLineService, setEditingLineService] = useState(null);
  const [prepaidService, setPrepaidService] = useState(null);
  const [protocolService, setProtocolService] = useState(null);
  const [treatmentPlanService, setTreatmentPlanService] = useState(null);
  const [auditContext, setAuditContext] = useState(null);
  const [selectedScheduleService, setSelectedScheduleService] = useState(null);
  const [showNewAppt, setShowNewAppt] = useState(false);
  const [newApptDefaults, setNewApptDefaults] = useState(null);
  const [scheduleRefreshKey, setScheduleRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  // Aggregated stats from TimeGridDays for the currently-visible range
  // (Day / 5-Day / Week). null until the grid mounts and emits the first
  // batch — at which point we use these for the centered stats row so the
  // numbers reflect the visible date range, not just `?date=…`.
  const [gridStats, setGridStats] = useState(null);
  const handleGridStatsChange = useCallback((stats) => {
    setGridStats(stats);
  }, []);

  const openCustomerSidebar = useCallback((svc) => {
    const customerId = svc?.customerId || svc?.customer_id;
    if (!customerId) return;
    setSelectedScheduleService({ ...svc, customerId });
  }, []);

  // Reset gridStats whenever the visible range changes (different date or
  // a different viewMode). Otherwise the centered stats row keeps showing
  // the prior range's totals until the new TimeGridDays fetch lands —
  // e.g. switching Week → Day still showed the 7-day count for a beat.
  // The cleared state falls back to the single-day `services` numbers
  // (already date-correct via fetchSchedule) until the grid emits fresh
  // stats.
  useEffect(() => {
    setGridStats(null);
  }, [date, viewMode]);

  // Expose "open create modal" to AdminDispatchPage so the lifted "+ Add
  // Appointment" pill in its header can trigger this page's modal.
  useEffect(() => {
    if (typeof setOpenCreateHandler !== 'function') return;
    setOpenCreateHandler(() => {
      setNewApptDefaults(null);
      setShowNewAppt(true);
    });
    return () => setOpenCreateHandler(null);
  }, [setOpenCreateHandler]);

  const fetchSchedule = useCallback(async (d) => {
    setLoading(true);
    setError(null);
    try {
      const [scheduleData, catalogData] = await Promise.all([
        adminFetch(`/admin/schedule?date=${d}`),
        adminFetch('/admin/dispatch/products/catalog'),
      ]);
      setData(scheduleData);
      setProducts(catalogData.products || []);
      setLoading(false);
      return scheduleData;
    } catch (e) {
      setError(e);
      setLoading(false);
      return null;
    }
  }, []);

  useEffect(() => { fetchSchedule(date); }, [date, fetchSchedule]);

  useEffect(() => {
    const customerId = searchParams.get('customer');
    if (!customerId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await adminFetch(`/admin/customers/${customerId}`);
        if (cancelled) return;
        const c = res.customer || {};
        const address = c.address || {};
        setNewApptDefaults({
          customer: {
            id: c.id,
            firstName: c.firstName || '',
            lastName: c.lastName || '',
            phone: c.phone || '',
            address: address.line1 || '',
            city: address.city || '',
            zip: address.zip || '',
            tier: c.tier || null,
          },
        });
        setShowNewAppt(true);
      } catch (err) {
        console.error('Failed to preload schedule customer:', err);
      } finally {
        if (!cancelled) {
          const next = new URLSearchParams(searchParams);
          next.delete('customer');
          setSearchParams(next, { replace: true });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [searchParams, setSearchParams]);

  // Mobile only exposes Day + Week. Snap back if user loaded with 5day/month.
  useEffect(() => {
    if (isMobile && (viewMode === '5day' || viewMode === 'month')) {
      setViewMode('week');
    }
  }, [isMobile, viewMode]);

  const syncDispatchAI = async () => {
    setSyncing(true); setSyncMsg('');
    try {
      const res = await fetch(`${API_BASE}/dispatch/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      const d = await res.json();
      setSyncMsg(d.message || `Synced ${d.bridge?.synced || 0} jobs from schedule`);
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

  const handleEnRoute = useCallback(async (service) => {
    try {
      await adminFetch(`/admin/schedule/${service.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'en_route' }),
      });
      handleStatusChange(service.id, 'en_route');
    } catch (e) {
      alert('En route failed: ' + e.message);
    }
  }, [handleStatusChange]);

  const handleCompleteSubmit = useCallback(async (serviceId, body) => {
    const r = await adminFetch(`/admin/dispatch/${serviceId}/complete`, { method: 'POST', body: JSON.stringify(body) });
    handleStatusChange(serviceId, 'completed');
    return r;
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

  const handleSidebarCancel = useCallback((service) => {
    setSelectedScheduleService(null);
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
    setScheduleRefreshKey((k) => k + 1);
    fetchSchedule(date);
  }, [date, fetchSchedule]);

  function shiftDate(dir) {
    if (viewMode === 'day') setDate(addDaysISO(date, dir));
    else if (viewMode === 'week') setDate(addDaysISO(date, dir * 7));
    else setDate(addMonthsISO(date, dir));
  }

  const isReferencePanel = activeTab !== 'board' && viewMode === 'day';
  if (loading && !isReferencePanel) return <div className="py-16 text-center text-13 text-ink-secondary">Loading schedule…</div>;
  if (error && !isReferencePanel) {
    if (isRateLimitError(error)) {
      return (
        <div className="py-16 text-center text-13 text-alert-fg">
          Too many requests. Wait a few seconds and{' '}
          <button onClick={() => fetchSchedule(date)} className="underline">retry</button>.
        </div>
      );
    }
    return (
      <div className="py-16 text-center text-13 text-alert-fg">
        Failed to load schedule: {error?.message || String(error)}
      </div>
    );
  }
  if (!data && !isReferencePanel) return null;

  const safeData = data || {};
  const services = safeData.services || [];
  const techSummary = safeData.techSummary || [];
  const unassigned = safeData.unassigned || [];
  const technicians = safeData.technicians || [];
  const zoneColors = safeData.zoneColors || {};
  const zoneLabels = safeData.zoneLabels || {};

  // Stats source by viewMode:
  //   - Day:           single-day `services` from /admin/schedule?date=X.
  //                    TimeGridDay (tech swimlanes) doesn't emit gridStats.
  //   - 5-Day / Week:  gridStats from TimeGridDays' /admin/schedule/week
  //                    aggregation. We never fall back to single-day data
  //                    here — that would show one day's numbers labeled
  //                    as "the week's totals". If the grid is still
  //                    loading or the fetch failed, the stats row hides
  //                    via `statsAvailable` instead.
  //   - Month:         row hidden entirely.
  const isDayView = viewMode === 'day';
  const isMultiDayView = viewMode === '5day' || viewMode === 'week';
  // Identity-check incoming gridStats against the currently-visible range
  // before trusting them. The reset-on-change useEffect runs after render,
  // so a Week→Week date hop (or Week→5-Day mode swap) would briefly render
  // the old range's totals labeled as the new range's. Comparing
  // gridStats.startDate / dayCount to what TimeGridDays *would* compute
  // for the current date+viewMode rejects the stale frame synchronously.
  const expectedDayCount = viewMode === 'week' ? 7 : viewMode === '5day' ? 5 : 1;
  // Plain const — etStartOfWeek is cheap, and a hook here would sit
  // below the loading/error early-returns above, breaking hook order.
  const expectedStart = isMultiDayView ? etStartOfWeek(date) : null;
  const useGridStats = isMultiDayView
    && !!gridStats
    && gridStats.startDate === expectedStart
    && gridStats.dayCount === expectedDayCount;
  const statsAvailable = isDayView || useGridStats;

  const totalCount = useGridStats ? gridStats.totalCount : services.length;
  const completedCount = useGridStats ? gridStats.completedCount : services.filter((s) => s.status === 'completed').length;
  const skippedCount = useGridStats ? gridStats.skippedCount : services.filter((s) => s.status === 'skipped').length;
  const remainingCount = useGridStats ? gridStats.remainingCount : (totalCount - completedCount - skippedCount);

  // Totals reflect the actual planned figures on the visible services —
  // no per-service averages or fallbacks. A service without a price /
  // duration contributes 0 so 2 priced appts at $617 read as $617, not
  // $617 plus a placeholder for every unpriced row.
  const estTotalMin = useGridStats
    ? (gridStats.totalMin || 0)
    : services.reduce((sum, s) => sum + (typeof s.estimatedDuration === 'number' ? s.estimatedDuration : 0), 0);
  const estTotalHrs = Math.floor(estTotalMin / 60);
  const estTotalMinRemainder = estTotalMin % 60;
  const estRemainingMin = useGridStats
    ? (gridStats.remainingMin || 0)
    : services.reduce((sum, s) => {
        if (s.status === 'completed' || s.status === 'skipped') return sum;
        return sum + (typeof s.estimatedDuration === 'number' ? s.estimatedDuration : 0);
      }, 0);
  // ETA is "now + remaining time" — only meaningful when looking at a
  // single day; on multi-day views it's suppressed since the implied
  // finish time spans days. Hide it when no remaining time is known so
  // we don't render "ETA now".
  const estFinishTime = isDayView && estRemainingMin > 0 ? (() => {
    const finish = new Date(Date.now() + estRemainingMin * 60000);
    return finish.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  })() : null;
  const estRevenue = useGridStats
    ? gridStats.revenue
    : services.reduce(
        (sum, s) => sum + (typeof s.estimatedPrice === 'number' ? s.estimatedPrice : 0),
        0,
      );

  const unassignedCount = unassigned.length;
  const newCustomers = services.filter((s) => !s.lastServiceDate);
  const weatherData = safeData.weather || {};
  const rainProbability = weatherData.rainProbability ?? weatherData.rain_probability ?? null;
  const windSpeed = weatherData.windSpeed ?? weatherData.wind_speed ?? null;
  const weatherTemp = weatherData.temp ?? weatherData.temperature ?? null;
  const hasRainAlert = rainProbability != null && rainProbability > 40;
  const hasFocusAlerts = (!isMobile && unassignedCount > 0) || newCustomers.length > 0 || hasRainAlert;
  const sprayHold = (rainProbability != null && rainProbability > 50) || (windSpeed != null && windSpeed > 15);

  const dateHeader = viewMode === 'day'
    ? formatDateDisplay(date)
    : viewMode === 'week'
      ? (() => {
          // TimeGridDays renders a Mon→Sun week containing the selected
          // date, so the header must label that same span — not
          // selected → selected + 6, which drifts as soon as the user
          // picks any non-Monday.
          const monday = etStartOfWeek(date);
          const sunday = addDaysISO(monday, 6);
          return `${formatETDate(dateAtNoonUTC(monday), { month: 'short', day: 'numeric' })} – ${formatETDate(dateAtNoonUTC(sunday), { month: 'short', day: 'numeric', year: 'numeric' })}`;
        })()
      : formatETDate(dateAtNoonUTC(date), { month: 'long', year: 'numeric' });

  return (
    <div className="bg-surface-page min-h-full p-4 md:p-6 font-sans text-zinc-900">
      {/* "↻ Sync AI Data" — right-aligned, only visible on non-board sub-tabs.
          The Schedule h1 + "+ Add Appointment" pill that used to share this
          row are now lifted into AdminDispatchPage so they sit above the
          centered top-level tab pill. */}
      {activeTab !== 'board' && viewMode === 'day' && (
        <div className="hidden md:flex justify-end mb-4">
          <Button variant="secondary" onClick={syncDispatchAI} disabled={syncing}>
            {syncing ? 'Syncing…' : '↻ Sync AI Data'}
          </Button>
        </div>
      )}

      {/* Mobile: Schedule + More pills. Hidden in controlled mode (top-level
          pill in AdminDispatchPage replaces them). */}
      {!isControlled && viewMode === 'day' && (
        <div className="md:hidden mb-4 flex items-center gap-2">
          <button
            onClick={() => setActiveTab('board')}
            className={cn(
              'flex-1 inline-flex items-center justify-center u-label px-3 h-11 rounded-sm border-hairline u-focus-ring transition-colors',
              activeTab === 'board' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-ink-secondary border-zinc-300'
            )}
          >
            Schedule
          </button>
          <button
            onClick={() => setShowMoreSheet(true)}
            className={cn(
              'flex-1 inline-flex items-center justify-center u-label px-3 h-11 rounded-sm border-hairline u-focus-ring transition-colors',
              activeTab !== 'board' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-ink-secondary border-zinc-300'
            )}
          >
            {activeTab === 'board' ? 'More' : SCHEDULE_TABS.find((t) => t.id === activeTab)?.label || 'More'}
          </button>
        </div>
      )}

      {/* Centered stats badges — schedule grid sub-tab on Day / 5-Day /
          Week (Month uses MonthViewV2 which has its own summary), desktop
          only. Day uses the single-day services fetch; multi-day views
          use TimeGridDays' aggregated stats. The row hides on multi-day
          while the week fetch is still loading or failed (statsAvailable
          guards), instead of falling back to single-day numbers that
          would mislabel the visible range. */}
      {statsAvailable && activeTab === 'board' && (
        <div className="hidden md:flex justify-center mb-4">
          <div className="flex gap-3 items-center text-12 text-ink-secondary bg-white px-3 py-2 rounded-sm border-hairline border-zinc-200 flex-wrap">
            <span><span className="u-nums font-medium text-zinc-900">{totalCount}</span> services</span>
            <span><span className="u-nums font-medium text-zinc-900">{completedCount}</span> done</span>
            <span><span className={cn('u-nums font-medium', remainingCount > 0 ? 'text-zinc-900' : 'text-ink-secondary')}>{remainingCount}</span> left</span>
            <span className="pl-3 border-l-hairline border-zinc-200">
              ~{estTotalHrs}h{estTotalMinRemainder > 0 ? ` ${estTotalMinRemainder}m` : ''} total
            </span>
            {estFinishTime && (
              <span>ETA <span className="u-nums font-medium text-zinc-900">{estFinishTime}</span></span>
            )}
            <span className="pl-3 border-l-hairline border-zinc-200">
              <span className="u-nums font-medium text-zinc-900">${estRevenue.toLocaleString()}</span> revenue
            </span>
          </div>
        </div>
      )}

      {/* Centered date nav — every tab. */}
      <div className="flex justify-center items-center gap-1.5 mb-4 flex-wrap">
        <button
          type="button"
          onClick={() => shiftDate(-1)}
          className="w-11 h-11 md:w-8 md:h-8 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-700 text-14 md:text-12 u-focus-ring hover:bg-zinc-50 inline-flex items-center justify-center flex-shrink-0"
          title="Previous"
        >
          ◀
        </button>
        <span className="u-nums text-14 md:text-13 font-medium text-zinc-900 text-center px-2 md:min-w-[220px]">
          {dateHeader}
        </span>
        <button
          type="button"
          onClick={() => shiftDate(1)}
          className="w-11 h-11 md:w-8 md:h-8 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-700 text-14 md:text-12 u-focus-ring hover:bg-zinc-50 inline-flex items-center justify-center flex-shrink-0"
          title="Next"
        >
          ▶
        </button>
        {!isToday(date) && (
          <Button size="sm" variant="secondary" onClick={() => setDate(formatDateISO(new Date()))}>Today</Button>
        )}
      </div>

      {/* Centered view-mode selector — schedule grid sub-tab + desktop only. */}
      {!isMobile && activeTab === 'board' && (
        <div className="flex justify-center mb-4">
          <ViewModeSelectorV2 viewMode={viewMode} onViewModeChange={(m) => { setViewMode(m); if (m === 'day') setActiveTab('board'); }} />
        </div>
      )}

      {syncMsg && <div className="text-11 text-ink-secondary mb-2">{syncMsg}</div>}

      {/* Mobile day strip — 7 rolling days centered on the selected date.
          Styled to mirror ViewModeSelectorV2 (Day / 5-Day / Week / Month):
          h-8 hairline pills, dark fill when active, single inline label
          "<num> <weekday-letter>" so all 7 fit comfortably in the row. */}
      {viewMode === 'day' && (
        <div className="md:hidden mb-4 flex justify-center -mx-4 px-4 overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
          <div className="inline-flex gap-1.5 min-w-max">
            {Array.from({ length: 7 }).map((_, i) => {
              const iso = addDaysISO(date, i - 3);
              const d = dateAtNoonUTC(iso);
              const selected = iso === date;
              const dayNum = d.getUTCDate();
              const weekdayLetter = d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'narrow' });
              return (
                <button
                  key={iso}
                  onClick={() => setDate(iso)}
                  className={cn(
                    'inline-flex items-center justify-center gap-1 h-8 px-3 text-11 uppercase font-medium tracking-label rounded-sm border-hairline u-focus-ring transition-colors flex-shrink-0',
                    selected
                      ? 'bg-zinc-900 text-white border-zinc-900'
                      : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50'
                  )}
                >
                  <span className="u-nums">{dayNum}</span>
                  <span>{weekdayLetter}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Mobile-only ViewMode selector — Day + Week only on phones. */}
      <div className="md:hidden mb-3 grid grid-cols-2 gap-1.5">
        {[
          { id: 'day', label: 'Day' },
          { id: 'week', label: 'Week' },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => { setViewMode(m.id); if (m.id === 'day') setActiveTab('board'); }}
            className={cn(
              'inline-flex items-center justify-center u-label px-2 h-11 rounded-sm border-hairline u-focus-ring transition-colors',
              viewMode === m.id ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-ink-secondary border-zinc-300'
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {showNewAppt && (
        <CreateAppointmentModal
          defaultDate={newApptDefaults?.date || date}
          defaultWindowStart={newApptDefaults?.windowStart}
          defaultDurationMinutes={newApptDefaults?.durationMinutes}
          defaultTechId={newApptDefaults?.techId}
          defaultCustomer={newApptDefaults?.customer || null}
          onClose={() => { setShowNewAppt(false); setNewApptDefaults(null); }}
          onCreated={(appt) => {
            setShowNewAppt(false);
            setNewApptDefaults(null);
            fetchSchedule(appt.scheduledDate || date);
            // TimeGridDays (week / 5-day) owns its own week-fetch — bump the
            // key so it refetches and the just-created appointment shows up.
            setScheduleRefreshKey((k) => k + 1);
          }}
        />
      )}

      {/* Week / 5-Day = multi-day time grid (drag to reschedule). Month = summary grid. */}
      {viewMode === 'week' && isMobile && (
        <MobileDispatchList
          mode="week"
          date={date}
          onEdit={(svc) => setDetailService(svc)}
          onEnRoute={handleEnRoute}
          onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
        />
      )}
      {viewMode === 'week' && !isMobile && (
        <TimeGridDays
          date={date}
          dayCount={7}
          selectedDate={date}
          hideUnassignedRail={false}
          refreshKey={scheduleRefreshKey}
          onEdit={(svc) => setEditingService(svc)}
          onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
          onViewCustomer={openCustomerSidebar}
          onChange={() => fetchSchedule(date)}
          onStatsChange={handleGridStatsChange}
          onCreateSlot={({ date: slotDate, windowStart, windowEnd }) => {
            setNewApptDefaults({ date: slotDate, windowStart, durationMinutes: slotDurationMinutes(windowStart, windowEnd) });
            setShowNewAppt(true);
          }}
        />
      )}
      {viewMode === '5day' && (
        <TimeGridDays
          date={date}
          dayCount={5}
          selectedDate={date}
          hideUnassignedRail={isMobile}
          refreshKey={scheduleRefreshKey}
          onEdit={(svc) => setEditingService(svc)}
          onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
          onViewCustomer={openCustomerSidebar}
          onChange={() => fetchSchedule(date)}
          onStatsChange={handleGridStatsChange}
          onCreateSlot={({ date: slotDate, windowStart, windowEnd }) => {
            setNewApptDefaults({ date: slotDate, windowStart, durationMinutes: slotDurationMinutes(windowStart, windowEnd) });
            setShowNewAppt(true);
          }}
        />
      )}
      {viewMode === 'month' && (
        <MonthViewV2
          date={date}
          onDateClick={(d) => { setDate(d); setViewMode('day'); }}
          onViewCustomer={openCustomerSidebar}
        />
      )}

      {/* Tabs bar — day view only, and only when this page owns its own
          activeTab state. In controlled mode AdminDispatchPage's top-level
          pill is the single source of truth so we don't render a duplicate
          strip here. */}
      {!isControlled && viewMode === 'day' && (
        <>
          {/* Desktop: tab strip — same separate-pill style as ViewModeSelectorV2
              (Day / 5-Day / Week / Month) so the two rows of selectors read
              consistently. */}
          <div className="hidden md:block mb-5">
            <HorizontalScroll gap={6} edgeBleed={4} style={{ paddingBottom: 0 }}>
              {SCHEDULE_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={cn(
                    'h-8 px-3 text-11 uppercase font-medium tracking-label rounded-sm border-hairline whitespace-nowrap flex-shrink-0 u-focus-ring transition-colors',
                    activeTab === t.id
                      ? 'bg-zinc-900 text-white border-zinc-900'
                      : 'bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50'
                  )}
                >
                  {t.label}
                </button>
              ))}
            </HorizontalScroll>
          </div>
        </>
      )}

      {/* Mobile "More" bottom sheet */}
      {showMoreSheet && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-zinc-900/30" onClick={() => setShowMoreSheet(false)} />
          <div
            className="absolute inset-x-0 bottom-0 bg-white rounded-t-md border-t border-hairline border-zinc-200"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="px-4 pt-3 pb-2 flex items-center justify-between border-b border-hairline border-zinc-200">
              <span className="u-label text-ink-secondary">Switch tool</span>
              <button
                onClick={() => setShowMoreSheet(false)}
                className="inline-flex items-center justify-center h-11 w-11 -mr-3 text-ink-secondary u-focus-ring"
              >
                ✕
              </button>
            </div>
            <div className="py-2">
              {SCHEDULE_TABS.filter((t) => !t.desktopOnly).map((t) => (
                <button
                  key={t.id}
                  onClick={() => { setActiveTab(t.id); setShowMoreSheet(false); }}
                  className={cn(
                    'w-full flex items-center justify-between px-4 h-12 text-14 text-left u-focus-ring transition-colors',
                    activeTab === t.id ? 'bg-zinc-50 text-zinc-900 font-medium' : 'bg-white text-ink-primary hover:bg-zinc-50'
                  )}
                >
                  <span>{t.label}</span>
                  {activeTab === t.id && <span className="text-11 u-label text-ink-tertiary">Active</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {viewMode === 'day' && <RecurringAlertsBannerV2 />}

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
                {!isMobile && unassignedCount > 0 && (
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

          {/* Weather bar — full-bleed, single row */}
          {(() => {
            const rp = rainProbability ?? 0;
            const weatherIcon = rp > 40 ? '🌧️' : rp > 15 ? '⛅' : '☀️';
            return (
              <div className="-mx-4 md:-mx-6 mb-3 md:mb-4 bg-white border-y border-hairline border-zinc-200 px-4 md:px-6 py-2 flex items-center justify-center gap-2 text-12 text-zinc-700 overflow-x-auto whitespace-nowrap">
                <span className="text-16" aria-hidden="true">{weatherIcon}</span>
                <span className="u-nums font-medium text-zinc-900">{weatherTemp ?? 82}°F</span>
                {windSpeed != null && (
                  <>
                    <span className="text-zinc-300" aria-hidden="true">·</span>
                    <span className="u-nums">{windSpeed} mph</span>
                  </>
                )}
                {rainProbability != null && (
                  <>
                    <span className="text-zinc-300" aria-hidden="true">·</span>
                    <span className="u-nums">{rainProbability}% rain</span>
                  </>
                )}
                <span className="text-zinc-300" aria-hidden="true">·</span>
                <span className={cn('font-medium uppercase tracking-label', sprayHold ? 'text-alert-fg' : 'text-zinc-900')}>
                  SPRAY: {sprayHold ? 'HOLD' : 'GO'}
                </span>
              </div>
            );
          })()}

          {/* Day view keeps the per-technician swimlane layout (TimeGridDay)
              so dispatchers can drag jobs between tech lanes and create a
              slot pre-bound to a specific tech — the core same-day
              reassignment workflow. The 5-Day / Week / Month views use the
              date-column TimeGridDays since tech-by-tech granularity isn't
              meaningful across multiple days. Visual styling on TimeGridDay
              already mirrors TimeGridDays. */}
          <div className="hidden md:block">
            <TimeGridDay
              date={date}
              services={services}
              technicians={technicians}
              onEdit={(svc) => setEditingService(svc)}
              onProtocol={(svc) => setProtocolService(svc)}
              onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
              onViewCustomer={openCustomerSidebar}
              onViewAudit={(svc) => setAuditContext({ customerId: svc.customerId || svc.customer_id, scheduledServiceId: svc.id })}
              onChange={() => fetchSchedule(date)}
              onDateChange={setDate}
              onCreateSlot={({ date: slotDate, windowStart, techId }) => {
                setNewApptDefaults({ date: slotDate, windowStart, techId });
                setShowNewAppt(true);
              }}
            />
          </div>

          {/* Mobile: inline scrollable day list (replaces the multi-day calendar) */}
          <div className="md:hidden">
            <MobileDispatchList
              mode="day"
              date={date}
              services={services}
              onEdit={(svc) => setDetailService(svc)}
              onEnRoute={handleEnRoute}
              onProtocol={(svc) => setProtocolService(svc)}
              onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
              onViewAudit={(svc) => setAuditContext({ customerId: svc.customerId || svc.customer_id, scheduledServiceId: svc.id })}
            />
          </div>
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
      {detailService && (
        <MobileAppointmentDetailSheet
          service={detailService}
          onClose={() => setDetailService(null)}
          onEdit={(svc) => { setDetailService(null); setEditingService(svc); }}
          onTreatmentPlan={(svc) => setTreatmentPlanService(svc)}
          onReviewCheckout={(svc) => setCheckoutService(svc)}
          onCompleteService={(svc) => { setDetailService(null); setCompletingService(svc); }}
          onBookNext={(svc) => {
            setDetailService(null);
            setNewApptDefaults({
              customer: {
                id: svc.customerId,
                firstName: (svc.customerName || '').split(' ')[0] || '',
                lastName: (svc.customerName || '').split(' ').slice(1).join(' '),
                phone: svc.customerPhone || '',
                address: svc.address || '',
                city: svc.city || '',
                tier: svc.waveguardTier || null,
              },
            });
            setShowNewAppt(true);
          }}
          onCancelled={() => fetchSchedule(date)}
          onNoShow={() => fetchSchedule(date)}
        />
      )}
      {checkoutService && (
        <MobileCheckoutSheet
          service={checkoutService}
          onClose={() => setCheckoutService(null)}
          onChargeSuccess={({ service: svc, invoiceId, invoiceToken, amount }) => {
            setPaymentData({ service: svc, invoiceId, invoiceToken, amount });
          }}
          onEditServiceLine={(svc) => setEditingLineService(svc)}
        />
      )}
      {editingLineService && (
        <MobileServiceEditModal
          service={editingLineService}
          technicians={technicians}
          onClose={() => setEditingLineService(null)}
          onSaved={async () => {
            const svcId = editingLineService.id;
            setEditingLineService(null);
            const fresh = await fetchSchedule(date);
            // Re-seat the checkout sheet on the updated service record so
            // the new totals render immediately without the tech having
            // to close + reopen the sheet.
            const updated = fresh?.services?.find((s) => s.id === svcId);
            if (updated) setCheckoutService(updated);
          }}
        />
      )}
      {paymentData && (
        <MobilePaymentSheet
          service={paymentData.service}
          invoiceId={paymentData.invoiceId}
          invoiceToken={paymentData.invoiceToken}
          amount={paymentData.amount}
          onClose={() => setPaymentData(null)}
          onInvoiceSent={() => {
            // Invoice SMS+email was just sent — the bill is now in the
            // customer's hands. Mirror the cash/check tender flow and
            // punch straight to the completion sheet so the tech can
            // wrap the visit without a second step.
            const svc = { ...paymentData.service, completionInvoiceAlreadySent: true };
            setPaymentData(null);
            setCheckoutService(null);
            setDetailService(null);
            setCompletingService(svc);
            fetchSchedule(date);
          }}
          onChargeSuccess={() => {
            setPaymentData(null);
            setCheckoutService(null);
            setDetailService(null);
            fetchSchedule(date);
          }}
          onPrepaidRecorded={async ({ invoice } = {}) => {
            // Cash / Check tender marked the pre-minted invoice paid server-side;
            // punch straight to completion with fresh enough payment state for
            // the completion SMS to use the paid branch.
            const svc = {
              ...paymentData.service,
              checkoutInvoiceId: invoice?.id || paymentData.invoiceId,
              checkoutInvoiceStatus: invoice?.status || 'paid',
            };
            setPaymentData(null);
            setCheckoutService(null);
            setDetailService(null);
            const fresh = await fetchSchedule(date);
            const updated = fresh?.services?.find((s) => s.id === svc.id);
            setCompletingService(updated ? { ...updated, ...svc } : svc);
          }}
        />
      )}
      {prepaidService && (
        <MarkPrepaidModal
          service={prepaidService}
          onClose={() => setPrepaidService(null)}
          onSaved={() => {
            const svc = prepaidService;
            setPrepaidService(null);
            setCompletingService(svc);
            fetchSchedule(date);
          }}
        />
      )}
      {treatmentPlanService && (
        <TreatmentPlanPanel
          service={treatmentPlanService}
          onClose={() => setTreatmentPlanService(null)}
        />
      )}
      {auditContext?.customerId && (
        <Customer360ProfileV2
          customerId={auditContext.customerId}
          initialTab="services"
          initialScheduledServiceId={auditContext.scheduledServiceId}
          onClose={() => setAuditContext(null)}
        />
      )}
      {selectedScheduleService && (
        <ScheduleCustomerSidebar
          service={selectedScheduleService}
          onClose={() => setSelectedScheduleService(null)}
          onEdit={(svc) => {
            setSelectedScheduleService(null);
            setEditingService(svc);
          }}
          onSavedNote={(svc, notes) => {
            setSelectedScheduleService((prev) => (
              prev && prev.id === svc.id ? { ...prev, notes } : prev
            ));
            fetchSchedule(date);
          }}
          onCancel={handleSidebarCancel}
          onBookNext={(svc) => {
            setSelectedScheduleService(null);
            setNewApptDefaults({
              customer: {
                id: svc.customerId,
                firstName: (svc.customerName || '').split(' ')[0] || '',
                lastName: (svc.customerName || '').split(' ').slice(1).join(' '),
                phone: svc.customerPhone || '',
                address: svc.address || '',
                city: svc.city || '',
                tier: svc.waveguardTier || svc.tier || null,
              },
            });
            setShowNewAppt(true);
          }}
        />
      )}
    </div>
  );
}
