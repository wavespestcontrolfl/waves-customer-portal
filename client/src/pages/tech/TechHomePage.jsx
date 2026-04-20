import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TechIntelligenceBar from '../../components/tech/TechIntelligenceBar';
import GeofenceArrivalPrompt from '../../components/tech/GeofenceArrivalPrompt';
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
  { icon: '📸', label: 'Photo ID Guide', path: '/tech' },
  { icon: '💬', label: 'Messages', path: '/tech/messages' },
];

export default function TechHomePage() {
  const navigate = useNavigate();
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(true);
  const techName = localStorage.getItem('techName') || localStorage.getItem('adminName') || 'Tech';
  const firstName = techName.split(' ')[0];

  useEffect(() => {
    fetchSchedule();
  }, []);

  async function fetchSchedule() {
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
  }

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
            onClick={() => navigate(action.path)}
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
