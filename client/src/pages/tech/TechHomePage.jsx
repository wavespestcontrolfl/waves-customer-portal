// client/src/pages/tech/TechHomePage.jsx
//
// Tech portal home page (/tech). Mobile-first; the dashboard a tech
// sees when they open the app on their phone in the field. Renders
// the day's route, quick actions (start service, complete service,
// mark en-route, geofence prompt acknowledge), and the
// TechIntelligenceBar (read-only Claude-powered Q&A scoped to
// tech-tools).
//
// Endpoints:
//   GET   /api/tech/services?date=…           (today's route)
//   PATCH /api/tech/services/:id/start        (begin service)
//   PATCH /api/tech/services/:id/complete     (finish service)
//   PATCH /api/tech/services/:id/skip         (skip with reason)
//   POST  /api/tech/services/:id/en-route     (begin drive)
//   GET   /api/tech/notifications             (geofence prompts;
//                                              polled every 10s by
//                                              GeofenceArrivalPrompt)
//   POST  /api/tech/notifications/:id/ack
//   POST  /api/tech/projects                  (CreateProjectModal save)
//
// Lifecycle a tech moves an appointment through:
//   pending -> en_route -> on_site -> completed
//                                \--> skipped (with reason)
//
// Mobile rule (CLAUDE.md): tech portal stays Montserrat headings +
// dark palette ('#0f1923' bg, '#1e293b' card). DO NOT apply admin
// monochrome or customer-facing warm-tone rules to this surface.
//
// Audit focus:
// - State transitions: confirm a tech can't accidentally skip an
//   appointment they're already on-site for, and can't complete one
//   that hasn't been started.
// - GeofenceArrivalPrompt polling: 10s interval. What happens on
//   network loss / backgrounded tab? Does it stack toasts?
// - CreateProjectModal save: photo uploads + draft save. Verify the
//   photos make it to the server before "save as draft" returns
//   success — silent photo failure here loses field data.
// - Route refresh: when a service status changes, does the rest of
//   the day's route re-fetch / re-render correctly? Stale rows are
//   common here.
import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useNavigate } from 'react-router-dom';
import TechIntelligenceBar from '../../components/tech/TechIntelligenceBar';
import GeofenceArrivalPrompt from '../../components/tech/GeofenceArrivalPrompt';
import CreateProjectModal from '../../components/tech/CreateProjectModal';
import TechServicePhotosModal from '../../components/tech/TechServicePhotosModal';
import { etDateString } from '../../lib/timezone';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

const API = import.meta.env.VITE_API_URL || '';

// Same socketOrigin shape as TrackPage / useDispatchBoard. Empty
// string or relative path → undefined → io() defaults to same-origin
// (works in production where SPA + API share a host, plus Vite dev
// with the /socket.io ws proxy). Full URL → return its origin so the
// socket handshake hits the same backend the HTTP fetches do.
function socketOrigin() {
  if (!API || API.startsWith('/')) return undefined;
  try {
    return new URL(API).origin;
  } catch {
    return undefined;
  }
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// Mirrors server-side PRE_EN_ROUTE in tech-track.js. Tapping outside
// these states is guaranteed to 409, so disable the button rather
// than letting it look tappable. Re-tap on en_route is also locked
// (server treats it idempotently, but no point looking enabled).
const EN_ROUTE_ELIGIBLE = new Set(['pending', 'confirmed', 'rescheduled']);

// /tech/messages and /tech/quick-invoice are both dead — neither has
// an underlying feature. Dropped from QUICK_ACTIONS until those
// surfaces actually exist (matches the /tech/messages drop in #355).
const QUICK_ACTIONS = [
  { icon: '📅', label: "Today's Route", path: '/tech' },
  { icon: '📋', label: 'Field Estimator', path: '/tech/estimate' },
  { icon: '📖', label: 'Protocols & SOPs', path: '/tech/protocols' },
  { icon: '🗂️', label: 'Project Report', action: 'create-project' },
];

export default function TechHomePage() {
  const navigate = useNavigate();
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [photoTarget, setPhotoTarget] = useState(null); // { id, customerName }
  const [enRouteState, setEnRouteState] = useState({ pendingId: null, message: '', isError: false });
  const techName = localStorage.getItem('techName') || localStorage.getItem('adminName') || 'Tech';
  const firstName = techName.split(' ')[0];
  // Login persists `waves_admin_user` as JSON ({ id, name, email, role }).
  // Use it to scope `schedule` to this tech's own jobs — /api/admin/schedule
  // returns the whole route board (not tech-filtered), so without this
  // guard nextStop could land on another tech's job and the En Route
  // POST would 403 server-side (tech-track.js ownership guard).
  let currentTechId = null;
  try {
    const u = JSON.parse(localStorage.getItem('waves_admin_user') || 'null');
    currentTechId = u?.id || null;
  } catch { /* ignore */ }

  const fetchSchedule = useCallback(async () => {
    try {
      const token = localStorage.getItem('adminToken');
      const today = etDateString();
      const res = await fetch(`${API}/api/admin/schedule?date=${today}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSchedule(Array.isArray(data) ? data : data.schedule || []);
      }
    } catch (err) {
      console.error('Failed to fetch schedule:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  // Mark En Route — POST /api/tech/services/:id/en-route. The server
  // owns the source-status gate (pending/confirmed/rescheduled, plus
  // an idempotent en_route re-tap) and broadcasts dispatch:job_update
  // post-commit, which our socket listener catches to refetch the
  // schedule. We don't need to mutate `schedule` here.
  //
  // Errors we surface inline rather than a global toast:
  //   - 403 (not assigned)            — defensive; routing prevents this
  //   - 404 (service vanished)        — race window during cancellation
  //   - 409 (terminal status / drift) — the server message is already
  //                                     user-friendly ("Cannot mark
  //                                     en-route from status 'completed'")
  // Success message auto-clears after 3s; the schedule refresh from
  // the broadcast typically replaces "Pending" with "En route" in the
  // status pill before the timeout fires.
  const handleEnRoute = useCallback(async (serviceId) => {
    if (!serviceId || enRouteState.pendingId) return;
    setEnRouteState({ pendingId: serviceId, message: '', isError: false });
    try {
      const token = localStorage.getItem('adminToken');
      const res = await fetch(`${API}/api/tech/services/${serviceId}/en-route`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const msg = data.alreadyEnRoute ? 'Already en route' : 'Marked en route';
      setEnRouteState({ pendingId: null, message: msg, isError: false });
      // Belt + suspenders refresh: the dispatch:job_update broadcast
      // is the primary path, but if the socket is mid-reconnect the
      // event can be missed, leaving the card stale. A retry then
      // hits the idempotent alreadyEnRoute branch on the server,
      // which does NOT re-broadcast (no status transition occurred),
      // so the stale card would persist until a manual reload. An
      // explicit fetch closes that drift window.
      fetchSchedule();
      setTimeout(() => setEnRouteState((s) => s.message === msg ? { pendingId: null, message: '', isError: false } : s), 3000);
    } catch (err) {
      setEnRouteState({ pendingId: null, message: err.message || 'Failed to mark en route', isError: true });
    }
  }, [enRouteState.pendingId, fetchSchedule]);

  // Live updates via Socket.io. Tech JWTs auth into the same
  // dispatch:admins room as admins (server/sockets/index.js), so the
  // dispatch:job_update broadcast fired post-commit by every status
  // write (PRs #328 / #329 / #330 / #335) reaches us here. On any
  // event we refetch the schedule — refresh shape is simpler than
  // merging a narrow broadcast payload into our full row shape, and
  // a same-tab "Mark En Route" tap doesn't double-render because
  // we already setSchedule from its response.
  //
  // Filtering by tech_id on the client is possible (broadcast carries
  // it), but reassignment FROM this tech to another would carry the
  // NEW tech's id and we'd miss the un-assignment. Refetch
  // unconditionally — cheap, correct.
  //
  // Cleanup: socket.off + socket.disconnect on unmount, matching the
  // pattern in useDispatchAlerts / useDispatchBoard / TrackPage.
  // Either alone leaks on every navigation away from the tech home.
  useEffect(() => {
    const token = localStorage.getItem('adminToken');
    if (!token) return undefined;
    const origin = socketOrigin();
    const opts = { auth: { token }, transports: ['websocket', 'polling'], reconnection: true };
    const socket = origin ? io(origin, opts) : io(opts);

    function handleJobUpdate() {
      fetchSchedule();
    }
    socket.on('dispatch:job_update', handleJobUpdate);

    return () => {
      socket.off('dispatch:job_update', handleJobUpdate);
      socket.disconnect();
    };
  }, [fetchSchedule]);

  // Scope to this tech's own jobs. /api/admin/schedule returns the
  // entire dispatch board, so nextStop, counts, and the Today's
  // Services list all need filtering before they're consumed.
  const myServices = currentTechId
    ? schedule.filter((s) => s.technician_id === currentTechId)
    : schedule;
  const completed = myServices.filter((s) => s.status === 'completed').length;
  const total = myServices.length;
  // "Next Stop" = first non-terminal service in the day's route.
  // Skipping past completed/skipped/cancelled means a tech with an
  // earlier skipped job sees the actual upcoming pending one, not
  // the dead row. on_site / en_route still show — they ARE the
  // current focus, the En Route CTA is disabled there because the
  // server's PRE_EN_ROUTE gate rejects those.
  const TERMINAL_STATUSES = new Set(['completed', 'skipped', 'cancelled']);
  const nextStop = myServices.find((s) => !TERMINAL_STATUSES.has(s.status));

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      <GeofenceArrivalPrompt />
      {/* Greeting */}
      <h1 style={{
        fontSize: 22, fontWeight: 700, margin: '0 0 4px',
        fontFamily: "'Montserrat', sans-serif",
        color: DARK.text,
      }}>
        {getGreeting()}, {firstName}
      </h1>
      <p style={{ fontSize: 13, color: DARK.muted, margin: '0 0 20px' }}>
        {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
      </p>

      {/* Today's Stats */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 20,
      }}>
        <StatCard label="Services" value={total} />
        <StatCard label="Completed" value={completed} color="#22c55e" />
      </div>

      {/* Field Assistant */}
      <TechIntelligenceBar />

      {/* Quick Actions */}
      <h2 style={{
        fontSize: 14, fontWeight: 700, color: DARK.muted, margin: '0 0 10px',
        fontFamily: "'Montserrat', sans-serif", textTransform: 'uppercase', letterSpacing: 1,
      }}>Quick Actions</h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 10,
        marginBottom: 20,
      }}>
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() => {
              if (action.action === 'create-project') setShowCreateProject(true);
              else if (action.path) navigate(action.path);
            }}
            style={{
              background: DARK.card,
              border: `1px solid ${DARK.border}`,
              borderRadius: 12,
              padding: '16px 8px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              cursor: 'pointer',
              transition: 'border-color 0.2s',
            }}
          >
            <span style={{ fontSize: 26 }}>{action.icon}</span>
            <span style={{
              fontSize: 11, fontWeight: 600, color: DARK.text, textAlign: 'center',
              fontFamily: "'Nunito Sans', sans-serif",
            }}>{action.label}</span>
          </button>
        ))}
      </div>

      {/* Next Stop */}
      <h2 style={{
        fontSize: 14, fontWeight: 700, color: DARK.muted, margin: '0 0 10px',
        fontFamily: "'Montserrat', sans-serif", textTransform: 'uppercase', letterSpacing: 1,
      }}>Next Stop</h2>

      {loading ? (
        <div style={{
          background: DARK.card, borderRadius: 12, padding: 24,
          border: `1px solid ${DARK.border}`, textAlign: 'center', color: DARK.muted,
        }}>Loading schedule...</div>
      ) : nextStop ? (
        <div style={{
          background: DARK.card,
          borderRadius: 12,
          border: `1px solid ${DARK.border}`,
          padding: 16,
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
            <div>
              <p style={{ fontSize: 16, fontWeight: 700, color: DARK.text, margin: 0 }}>
                {nextStop.customer_name || nextStop.customerName || 'Customer'}
              </p>
              <p style={{ fontSize: 12, color: DARK.muted, margin: '4px 0 0' }}>
                {nextStop.address || nextStop.service_type || 'Service'}
              </p>
            </div>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
              background: '#0ea5e920', color: DARK.teal,
            }}>
              {nextStop.time || nextStop.scheduled_time || 'Pending'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionBtn label="Navigate" icon="🗺️" onClick={() => {
              const addr = nextStop.address;
              if (addr) window.open(`https://maps.google.com/?q=${encodeURIComponent(addr)}`, '_blank');
            }} />
            <ActionBtn label="Protocol" icon="📖" onClick={() => navigate('/tech/protocols')} />
            <ActionBtn
              label={enRouteState.pendingId === nextStop.id ? 'Sending…' : 'En Route'}
              icon="🚗"
              primary
              disabled={enRouteState.pendingId === nextStop.id || !EN_ROUTE_ELIGIBLE.has(nextStop.status || 'pending')}
              onClick={() => handleEnRoute(nextStop.id)}
            />
          </div>
          {enRouteState.message && (
            <div style={{
              marginTop: 10, fontSize: 12, padding: '6px 10px', borderRadius: 6,
              background: enRouteState.isError ? '#ef444422' : '#22c55e22',
              border: `1px solid ${enRouteState.isError ? '#ef4444' : '#22c55e'}`,
              color: enRouteState.isError ? '#ef4444' : '#22c55e',
            }}>
              {enRouteState.message}
            </div>
          )}
        </div>
      ) : (
        <div style={{
          background: DARK.card, borderRadius: 12, padding: 24,
          border: `1px solid ${DARK.border}`, textAlign: 'center',
        }}>
          <p style={{ fontSize: 14, color: DARK.muted, margin: 0 }}>
            {total === 0 ? 'No services scheduled today' : 'All services completed! 🎉'}
          </p>
        </div>
      )}

      {/* Today's Services — full list with Photos affordance per row.
          Photos button hits POST /api/tech/services/:id/photos which
          requires the service to be completed (server returns 409
          otherwise; the modal surfaces that inline). Visible for all
          statuses so techs can review/manage photos on any of their
          day's stops, not just the next one. */}
      {!loading && myServices.length > 0 && (
        <>
          <h2 style={{
            fontSize: 14, fontWeight: 700, color: DARK.muted, margin: '20px 0 10px',
            fontFamily: "'Montserrat', sans-serif", textTransform: 'uppercase', letterSpacing: 1,
          }}>Today's Services</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {myServices.map((s) => (
              <ServiceRow
                key={s.id}
                service={s}
                onPhotos={() => setPhotoTarget({
                  id: s.id,
                  customerName: s.customer_name || s.customerName || 'Customer',
                })}
              />
            ))}
          </div>
        </>
      )}

      <TimecardSignoffCard techName={techName} />

      {showCreateProject && (
        <CreateProjectModal
          onClose={() => setShowCreateProject(false)}
          onCreated={() => setShowCreateProject(false)}
        />
      )}

      {photoTarget && (
        <TechServicePhotosModal
          serviceId={photoTarget.id}
          customerName={photoTarget.customerName}
          onClose={() => setPhotoTarget(null)}
        />
      )}
    </div>
  );
}

// Sign-off card — surfaces last week's weekly summary and a "Sign
// timecard" button when the tech hasn't yet acknowledged the hours.
// Quietly hides itself when there's no last-week data, when the week
// is already approved by admin (sign-off is moot), or when the tech
// has already signed. Lets the employee attest their own hours
// before manager approval, which is the audit value here.
function TimecardSignoffCard({ techName }) {
  const [weekly, setWeekly] = useState(null);
  const [weekStart, setWeekStart] = useState(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [signature, setSignature] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null); // {message, isError}

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Server is the source of truth for "what week should this tech
      // sign right now?" — Railway runs UTC, browser may not be in ET,
      // so computing the boundary client-side drifts near midnight.
      // The endpoint anchors on ET via shared helpers.
      const token = localStorage.getItem('adminToken');
      const res = await fetch(`${API}/api/tech/timetracking/pending-signoff`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setWeekly(null);
        setPending(false);
      } else {
        const data = await res.json();
        setWeekly(data.weekly || null);
        setWeekStart(data.weekStart || null);
        setPending(data.pending === true);
        // Functional setter so we don't depend on `signature` here —
        // including it in the useCallback deps would cause this to
        // re-run every time the input changes, refetching on each
        // keystroke. Pre-fill from techName only if the field is still
        // empty.
        if (data.weekly) setSignature((s) => s || techName || '');
      }
    } catch {
      setWeekly(null);
    } finally {
      // Always clear loading — a non-OK fetch used to early-return
      // before this line, leaving loading stuck true and the card
      // permanently null until a full page reload.
      setLoading(false);
    }
  }, [techName]);

  useEffect(() => { load(); }, [load]);

  if (loading) return null;
  if (!weekly) return null;
  // Server is authoritative on whether sign-off is pending. If the
  // endpoint says pending=false and the tech has already signed,
  // render a quiet confirmation; if pending=false and not signed
  // (the week is approved or otherwise not eligible), render nothing.
  if (!pending) {
    if (weekly.tech_signed_at) {
      return (
        <div style={{
          background: DARK.card, border: `1px solid #22c55e44`, borderRadius: 12,
          padding: 12, margin: '20px 0',
          fontSize: 12, color: '#22c55e',
        }}>
          ✓ Last week signed{weekly.tech_signature ? ` as "${weekly.tech_signature}"` : ''} — awaiting admin approval.
        </div>
      );
    }
    return null;
  }

  const hours = (parseFloat(weekly.total_shift_minutes || 0) / 60).toFixed(1);
  const otHrs = (parseFloat(weekly.overtime_minutes || 0) / 60).toFixed(1);

  const handleSign = async () => {
    if (!signature.trim()) {
      setFeedback({ message: 'Type your name to sign', isError: true });
      return;
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const token = localStorage.getItem('adminToken');
      const r = await fetch(`${API}/api/tech/timetracking/sign-week`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekStart, signature: signature.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setFeedback({ message: 'Timecard signed', isError: false });
      load();
    } catch (e) {
      setFeedback({ message: e.message || 'Sign failed', isError: true });
    }
    setSubmitting(false);
  };

  return (
    <div style={{
      background: DARK.card, borderRadius: 12, border: `1px solid #f59e0b66`,
      padding: 16, margin: '20px 0',
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b', marginBottom: 4, fontFamily: "'Montserrat', sans-serif", textTransform: 'uppercase', letterSpacing: 1 }}>
        Sign Last Week's Timecard
      </div>
      <div style={{ fontSize: 12, color: DARK.muted, marginBottom: 10 }}>
        Week of {weekly.week_start ? String(weekly.week_start).split('T')[0] : weekStart} — review and attest these hours.
      </div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 13, color: DARK.text }}>
        <div><strong style={{ color: DARK.text }}>{hours}h</strong> <span style={{ color: DARK.muted }}>total</span></div>
        <div><strong style={{ color: parseFloat(otHrs) > 0 ? '#f59e0b' : DARK.text }}>{otHrs}h</strong> <span style={{ color: DARK.muted }}>OT</span></div>
        <div><strong>{weekly.job_count || 0}</strong> <span style={{ color: DARK.muted }}>jobs</span></div>
      </div>
      <div style={{ fontSize: 11, color: DARK.muted, marginBottom: 4 }}>Type your name to sign:</div>
      <input
        value={signature}
        onChange={(e) => setSignature(e.target.value)}
        placeholder="Your name"
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '8px 10px', fontSize: 14,
          background: '#0f1923', color: DARK.text,
          border: `1px solid ${DARK.border}`, borderRadius: 6,
          marginBottom: 10,
        }}
      />
      <button
        onClick={handleSign}
        disabled={submitting || !signature.trim()}
        style={{
          width: '100%', padding: '10px', fontSize: 14, fontWeight: 700,
          background: '#22c55e', color: '#fff', border: 'none', borderRadius: 8,
          cursor: submitting || !signature.trim() ? 'wait' : 'pointer',
          opacity: submitting || !signature.trim() ? 0.6 : 1,
          fontFamily: "'Montserrat', sans-serif",
        }}
      >
        {submitting ? 'Signing…' : 'Sign Timecard'}
      </button>
      {feedback && (
        <div style={{
          marginTop: 10, fontSize: 12, padding: '6px 10px', borderRadius: 6,
          background: feedback.isError ? '#ef444422' : '#22c55e22',
          border: `1px solid ${feedback.isError ? '#ef4444' : '#22c55e'}`,
          color: feedback.isError ? '#ef4444' : '#22c55e',
        }}>{feedback.message}</div>
      )}
    </div>
  );
}

function ServiceRow({ service, onPhotos }) {
  const status = service.status || 'pending';
  const statusColor = {
    completed: '#22c55e',
    on_site: DARK.teal,
    en_route: '#f59e0b',
    skipped: '#94a3b8',
  }[status] || DARK.muted;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      background: DARK.card, border: `1px solid ${DARK.border}`,
      borderRadius: 10, padding: '10px 12px',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          margin: 0, fontSize: 14, fontWeight: 600, color: DARK.text,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {service.customer_name || service.customerName || 'Customer'}
        </p>
        <p style={{ margin: '2px 0 0', fontSize: 11, color: statusColor, textTransform: 'capitalize' }}>
          {status.replace(/_/g, ' ')}
          {service.scheduled_time && <span style={{ color: DARK.muted }}> · {service.scheduled_time}</span>}
        </p>
      </div>
      <button onClick={onPhotos} style={{
        padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
        border: `1px solid ${DARK.border}`, background: 'transparent',
        color: DARK.teal, cursor: 'pointer',
      }}>
        📷 Photos
      </button>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      flex: 1,
      background: DARK.card,
      borderRadius: 12,
      padding: '14px 16px',
      border: `1px solid ${DARK.border}`,
    }}>
      <p style={{ fontSize: 24, fontWeight: 800, color: color || DARK.teal, margin: 0,
        fontFamily: "'Montserrat', sans-serif" }}>{value}</p>
      <p style={{ fontSize: 12, color: DARK.muted, margin: '2px 0 0' }}>{label}</p>
    </div>
  );
}

function ActionBtn({ label, icon, primary, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      flex: 1,
      padding: '8px 4px',
      borderRadius: 8,
      border: primary ? 'none' : `1px solid ${DARK.border}`,
      background: primary ? DARK.teal : 'transparent',
      color: primary ? '#fff' : DARK.text,
      fontSize: 12,
      fontWeight: 600,
      cursor: disabled ? 'wait' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    }}>
      <span style={{ fontSize: 14 }}>{icon}</span> {label}
    </button>
  );
}
