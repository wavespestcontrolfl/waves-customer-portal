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

const QUICK_ACTIONS = [
  { icon: '📅', label: "Today's Route", path: '/tech' },
  { icon: '📋', label: 'Field Estimator', path: '/tech/estimate' },
  { icon: '🧾', label: 'Quick Invoice', path: '/tech' },
  { icon: '📖', label: 'Protocols & SOPs', path: '/tech/protocols' },
  { icon: '🗂️', label: 'Project Report', action: 'create-project' },
  { icon: '💬', label: 'Messages', path: '/tech/messages' },
];

export default function TechHomePage() {
  const navigate = useNavigate();
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [photoTarget, setPhotoTarget] = useState(null); // { id, customerName }
  const techName = localStorage.getItem('techName') || localStorage.getItem('adminName') || 'Tech';
  const firstName = techName.split(' ')[0];

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

  const completed = schedule.filter((s) => s.status === 'completed').length;
  const total = schedule.length;
  const nextStop = schedule.find((s) => s.status !== 'completed');

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
            <ActionBtn label="En Route" icon="🚗" primary onClick={() => {}} />
          </div>
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
      {!loading && schedule.length > 0 && (
        <>
          <h2 style={{
            fontSize: 14, fontWeight: 700, color: DARK.muted, margin: '20px 0 10px',
            fontFamily: "'Montserrat', sans-serif", textTransform: 'uppercase', letterSpacing: 1,
          }}>Today's Services</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {schedule.map((s) => (
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

function ActionBtn({ label, icon, primary, onClick }) {
  return (
    <button onClick={onClick} style={{
      flex: 1,
      padding: '8px 4px',
      borderRadius: 8,
      border: primary ? 'none' : `1px solid ${DARK.border}`,
      background: primary ? DARK.teal : 'transparent',
      color: primary ? '#fff' : DARK.text,
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    }}>
      <span style={{ fontSize: 14 }}>{icon}</span> {label}
    </button>
  );
}
