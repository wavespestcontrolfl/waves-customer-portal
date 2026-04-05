import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

const TEMPLATES = [
  { label: 'Service reminder', body: 'Hi! This is Waves Pest Control. Just a reminder that your service is scheduled for tomorrow. Reply CONFIRM to confirm or call us to reschedule.' },
  { label: 'Running late', body: 'Hi! This is Waves Pest Control. Our technician is running a bit behind schedule. We estimate arrival in about 15-20 minutes. Sorry for the delay!' },
  { label: 'Review request', body: 'Thanks for choosing Waves Pest Control! We\'d love your feedback. Please leave us a quick review: [LINK]' },
];

const ALL_NUMBERS = [
  { group: 'Location Lines', numbers: [
    { number: '+19412975749', formatted: '(941) 297-5749', label: 'wavespestcontrol.com (main)' },
    { number: '+19413187612', formatted: '(941) 318-7612', label: 'Waves Pest Control Lakewood Ranch' },
    { number: '+19412972606', formatted: '(941) 297-2606', label: 'Waves Pest Control Sarasota' },
    { number: '+19412973337', formatted: '(941) 297-3337', label: 'Waves Pest Control Venice' },
    { number: '+19412972817', formatted: '(941) 297-2817', label: 'Waves Pest Control Parrish' },
  ]},
  { group: 'Pest Control Domains', numbers: [
    { number: '+19412838194', formatted: '(941) 283-8194', label: 'bradentonflexterminator.com' },
    { number: '+19413265011', formatted: '(941) 326-5011', label: 'bradentonflpestcontrol.com' },
    { number: '+19412972671', formatted: '(941) 297-2671', label: 'sarasotaflpestcontrol.com' },
    { number: '+19412135203', formatted: '(941) 213-5203', label: 'palmettoexterminator.com' },
    { number: '+19412943355', formatted: '(941) 294-3355', label: 'palmettoflpestcontrol.com' },
    { number: '+19419098995', formatted: '(941) 909-8995', label: 'parrishexterminator.com' },
    { number: '+19413187765', formatted: '(941) 318-7765', label: 'sarasotaflexterminator.com' },
    { number: '+19412998937', formatted: '(941) 299-8937', label: 'veniceexterminator.com' },
    { number: '+19412589109', formatted: '(941) 258-9109', label: 'portcharlotteflpestcontrol.com' },
    { number: '+19412402066', formatted: '(941) 240-2066', label: 'wavespestcontrol.com/north-port' },
  ]},
  { group: 'Lawn Care Domains', numbers: [
    { number: '+19413041850', formatted: '(941) 304-1850', label: 'bradentonfllawncare.com' },
    { number: '+19412691692', formatted: '(941) 269-1692', label: 'sarasotafllawncare.com' },
    { number: '+19412077456', formatted: '(941) 207-7456', label: 'parrishfllawncare.com' },
    { number: '+19414131227', formatted: '(941) 413-1227', label: 'venicelawncare.com' },
    { number: '+19412413824', formatted: '(941) 241-3824', label: 'waveslawncare.com' },
  ]},
  { group: 'Other', numbers: [
    { number: '+18559260203', formatted: '(855) 926-0203', label: 'AI Agent' },
    { number: '+19412412459', formatted: '(941) 241-2459', label: 'Waves Van' },
  ]},
  { group: 'Unassigned', numbers: [
    { number: '+19412535279', formatted: '(941) 253-5279', label: 'Unassigned' },
    { number: '+19412411388', formatted: '(941) 241-1388', label: 'Unassigned' },
  ]},
];

const TYPE_META = {
  reminder: { icon: '🔔', color: D.amber },
  estimate: { icon: '📋', color: D.teal },
  review: { icon: '⭐', color: D.amber },
  completion: { icon: '✅', color: D.green },
  manual: { icon: '💬', color: D.muted },
  en_route: { icon: '🚐', color: D.green },
  confirmation: { icon: '📩', color: D.teal },
  inbound: { icon: '📥', color: D.teal },
};

// --- Stat Card ---
function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
      padding: '16px 20px', flex: '1 1 0', minWidth: 140,
    }}>
      <div style={{ color: D.muted, fontSize: 11, fontFamily: 'DM Sans, sans-serif', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 26, fontWeight: 700, color: color || D.white }}>{value}</div>
    </div>
  );
}

// --- Phone Number Card ---
function PhoneCard({ number, label, sent, received, isTracking }) {
  return (
    <div style={{
      background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
      padding: 16, flex: '1 1 200px', minWidth: 200,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: D.green, display: 'inline-block', flexShrink: 0 }} />
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, color: D.white }}>{number}</span>
      </div>
      <div style={{ color: D.muted, fontSize: 12, fontFamily: 'DM Sans, sans-serif', marginBottom: 10 }}>
        {isTracking ? '🚐 Van Wrap Tracking' : label}
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <div>
          <div style={{ color: D.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Sent</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 16, fontWeight: 600, color: D.green }}>{sent ?? 0}</div>
        </div>
        <div>
          <div style={{ color: D.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Received</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 16, fontWeight: 600, color: D.teal }}>{received ?? 0}</div>
        </div>
      </div>
    </div>
  );
}

// --- Status Badge ---
function StatusBadge({ status }) {
  const colors = {
    delivered: D.green,
    sent: D.teal,
    failed: D.red,
    queued: D.amber,
    received: D.teal,
  };
  const c = colors[status] || D.muted;
  return (
    <span style={{
      fontSize: 10, fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase',
      padding: '2px 8px', borderRadius: 6, background: `${c}22`, color: c, letterSpacing: 0.5,
    }}>{status}</span>
  );
}

// --- Type Badge ---
function TypeBadge({ type }) {
  const meta = TYPE_META[type] || { icon: '💬', color: D.muted };
  return (
    <span style={{
      fontSize: 10, fontFamily: 'DM Sans, sans-serif',
      padding: '2px 8px', borderRadius: 6, background: `${meta.color}18`, color: meta.color,
    }}>{meta.icon} {type}</span>
  );
}

// --- Channel Bar ---
function ChannelBar({ type, count, max }) {
  const meta = TYPE_META[type] || { icon: '💬', color: D.muted };
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <span style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{meta.icon}</span>
      <span style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 12, color: D.text, width: 90, textTransform: 'capitalize' }}>{type}</span>
      <div style={{ flex: 1, height: 10, background: D.bg, borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: meta.color, borderRadius: 5, transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.muted, width: 36, textAlign: 'right' }}>{count}</span>
    </div>
  );
}

// =========================================================================
// =========================================================================
// CALL LOG TAB
// =========================================================================
function CallLogTab() {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [callTo, setCallTo] = useState('');
  const [callFrom, setCallFrom] = useState('+19413187612');
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);

  const loadCalls = () => {
    adminFetch('/ai/admin/calls?days=30').then(d => { setCalls(d.calls || []); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => { loadCalls(); }, []);

  const handleCall = async () => {
    if (!callTo.trim()) return;
    setCalling(true);
    setCallResult(null);
    try {
      await adminFetch('/admin/communications/call', {
        method: 'POST',
        body: JSON.stringify({ to: callTo.trim(), fromNumber: callFrom }),
      });
      setCallResult({ ok: true, text: 'Call initiated! Your phone will ring shortly.' });
      setCallTo('');
      setTimeout(loadCalls, 3000);
    } catch (e) {
      setCallResult({ ok: false, text: `Failed: ${e.message}` });
    } finally {
      setCalling(false);
    }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading calls...</div>;

  const answered = calls.filter(c => c.answered_by === 'human').length;
  const aiHandled = calls.filter(c => c.answered_by === 'voice_agent').length;
  const voicemail = calls.filter(c => c.answered_by === 'voicemail').length;
  const missed = calls.filter(c => !c.answered_by || c.answered_by === 'missed').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: 'Total', value: calls.length, color: D.white },
          { label: 'Answered', value: answered, color: D.green },
          { label: 'AI Agent', value: aiHandled, color: D.teal },
          { label: 'Voicemail', value: voicemail, color: D.amber },
          { label: 'Missed', value: missed, color: D.red },
        ].map((s, i) => (
          <div key={i} style={{ flex: '1 1 100px', background: D.card, borderRadius: 10, padding: '12px 14px', border: `1px solid ${D.border}`, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Make a Call panel */}
      <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}`, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 14px' }}>Make a Call</h2>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>From</label>
            <select
              value={callFrom}
              onChange={e => setCallFrom(e.target.value)}
              style={{
                width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
                color: D.white, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', boxSizing: 'border-box',
                WebkitAppearance: 'none', appearance: 'none',
                backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")",
                backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: 32,
              }}
            >
              {ALL_NUMBERS.map(group => (
                <optgroup key={group.group} label={group.group}>
                  {group.numbers.map(n => (
                    <option key={n.number} value={n.number}>{n.formatted} — {n.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>To</label>
            <input
              type="tel"
              placeholder="+1 (xxx) xxx-xxxx"
              value={callTo}
              onChange={e => setCallTo(e.target.value)}
              style={{
                width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
                color: D.white, fontSize: 14, fontFamily: "'JetBrains Mono', monospace", outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        <button
          onClick={handleCall}
          disabled={calling || !callTo.trim()}
          style={{
            padding: '10px 24px', background: calling ? D.muted : D.green, border: 'none', borderRadius: 8,
            color: D.white, fontSize: 14, fontWeight: 600, cursor: calling ? 'not-allowed' : 'pointer',
            fontFamily: 'DM Sans, sans-serif', opacity: !callTo.trim() ? 0.5 : 1,
          }}
        >
          {calling ? 'Calling...' : 'Call'}
        </button>

        {callResult && (
          <div style={{ marginTop: 10, fontSize: 12, color: callResult.ok ? D.green : D.red }}>{callResult.text}</div>
        )}
      </div>

      {/* Call list */}
      <div style={{ background: D.card, borderRadius: 12, padding: '16px 20px', border: `1px solid ${D.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>Call History</h2>
        </div>

        {calls.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No calls recorded yet.</div>
        ) : (
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {calls.map(c => {
              const answeredColor = c.answered_by === 'human' ? D.green : c.answered_by === 'voice_agent' ? D.teal : c.answered_by === 'voicemail' ? D.amber : D.red;
              const answeredLabel = c.answered_by === 'human' ? 'Answered' : c.answered_by === 'voice_agent' ? 'AI Agent' : c.answered_by === 'voicemail' ? 'Voicemail' : 'Missed';
              const dur = c.duration_seconds ? `${Math.floor(c.duration_seconds / 60)}:${String(c.duration_seconds % 60).padStart(2, '0')}` : '--';

              return (
                <div key={c.id} style={{ padding: '12px 0', borderBottom: `1px solid ${D.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16, width: 20, textAlign: 'center', color: c.direction === 'inbound' ? D.teal : D.green }}>{c.direction === 'inbound' ? '↓' : '↑'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>
                        {c.first_name ? `${c.first_name} ${c.last_name || ''}` : c.from_phone || 'Unknown'}
                        <span style={{ fontSize: 11, color: D.muted, fontWeight: 400, marginLeft: 8 }}>{c.direction === 'inbound' ? 'Inbound' : 'Outbound'}</span>
                      </div>
                      <div style={{ fontSize: 11, color: D.muted }}>
                        {c.from_phone} {c.to_phone ? ` > ${c.to_phone}` : ''} · {dur} · {c.caller_city ? `${c.caller_city}, ${c.caller_state}` : ''}
                      </div>
                      {c.voice_agent_outcome && <div style={{ fontSize: 11, color: D.teal, marginTop: 2 }}>Outcome: {c.voice_agent_outcome?.replace(/_/g, ' ')}</div>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: answeredColor + '22', color: answeredColor }}>{answeredLabel}</span>
                      <span style={{ fontSize: 10, color: D.muted }}>{timeAgo(c.created_at)}</span>
                    </div>
                  </div>
                  {/* Recording player */}
                  {c.recording_url && (
                    <div style={{ marginTop: 8, marginLeft: 30, padding: '8px 12px', background: D.bg, borderRadius: 8, border: `1px solid ${D.border}` }}>
                      <div style={{ fontSize: 11, color: D.muted, marginBottom: 4, fontWeight: 600 }}>Recording {c.recording_duration_seconds ? `(${Math.floor(c.recording_duration_seconds / 60)}:${String(c.recording_duration_seconds % 60).padStart(2, '0')})` : ''}</div>
                      <audio controls preload="none" style={{ width: '100%', height: 32 }}>
                        <source src={c.recording_url} type="audio/mpeg" />
                      </audio>
                    </div>
                  )}
                  {/* Transcription */}
                  {c.transcription && (
                    <div style={{ marginTop: 6, marginLeft: 30, padding: '8px 12px', background: D.bg, borderRadius: 8, border: `1px solid ${D.border}` }}>
                      <div style={{ fontSize: 11, color: D.muted, marginBottom: 2, fontWeight: 600 }}>Transcription</div>
                      <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5, fontStyle: 'italic' }}>"{c.transcription}"</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// CSR COACH TAB
// =========================================================================
function CSRCoachTab() {
  const [overview, setOverview] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [weeklyRec, setWeeklyRec] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [leadQuality, setLeadQuality] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminFetch('/admin/csr/overview?days=30').catch(() => null),
      adminFetch('/admin/csr/follow-up-tasks').catch(() => null),
      adminFetch('/admin/csr/weekly-recommendation').catch(() => null),
      adminFetch('/admin/csr/leaderboard').catch(() => null),
      adminFetch('/admin/csr/lead-quality?days=30').catch(() => null),
    ]).then(([ov, tk, wr, lb, lq]) => {
      setOverview(ov);
      setTasks(tk);
      setWeeklyRec(wr);
      setLeaderboard(lb);
      setLeadQuality(lq);
      setLoading(false);
    });
  }, []);

  const handleTaskUpdate = async (taskId, status) => {
    await adminFetch(`/admin/csr/follow-up-tasks/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    const tk = await adminFetch('/admin/csr/follow-up-tasks');
    setTasks(tk);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading CSR Coach...</div>;

  const csrs = overview?.csrStats || [];
  const thSt = { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: D.muted, borderBottom: `1px solid ${D.border}`, textTransform: 'uppercase', letterSpacing: '0.5px' };
  const thR = { ...thSt, textAlign: 'right' };
  const tdSt = { padding: '10px 14px', fontSize: 13, color: D.text, borderBottom: `1px solid ${D.border}`, fontFamily: "'JetBrains Mono', monospace" };
  const tdR = { ...tdSt, textAlign: 'right' };
  const tdT = { ...tdSt, fontFamily: 'inherit' };

  const rateColor = (r) => r >= 60 ? D.green : r >= 40 ? D.amber : D.red;
  const scoreColor = (s) => s >= 12 ? D.green : s >= 9 ? D.amber : D.red;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Team Overview */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Team Overview (Last 30 Days)</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thSt}>CSR</th>
                <th style={thR}>Calls</th>
                <th style={thR}>1st-Call Book %</th>
                <th style={thR}>Avg Score</th>
                <th style={thR}>Follow-Up %</th>
              </tr>
            </thead>
            <tbody>
              {csrs.map(c => (
                <tr key={c.name}>
                  <td style={tdT}>{c.name}</td>
                  <td style={tdR}>{c.calls}</td>
                  <td style={{ ...tdR, color: rateColor(c.firstCallBookingRate) }}>{c.firstCallBookingRate}% {c.firstCallBookingRate >= 60 ? '✅' : c.firstCallBookingRate >= 40 ? '⚠️' : '🔴'}</td>
                  <td style={{ ...tdR, color: scoreColor(c.avgScore) }}>{c.avgScore}/15</td>
                  <td style={{ ...tdR, color: rateColor(c.followUpRate) }}>{c.followUpRate}% {c.followUpRate >= 80 ? '✅' : c.followUpRate >= 60 ? '⚠️' : '🔴'}</td>
                </tr>
              ))}
              {overview?.teamTotals && (
                <tr style={{ borderTop: `2px solid ${D.border}` }}>
                  <td style={{ ...tdT, fontWeight: 700 }}>Team</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{overview.teamTotals.calls}</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{overview.teamTotals.bookingRate}%</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{overview.teamTotals.avgScore}/15</td>
                  <td style={tdR}>—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Weekly Team Focus */}
      {weeklyRec && weeklyRec.recommendation && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 12 }}>{"📊"} This Week's Team Focus</div>
          <div style={{ padding: 16, background: D.bg, borderRadius: 10, marginBottom: 12, borderLeft: `3px solid ${D.teal}` }}>
            <div style={{ fontSize: 14, color: D.white, lineHeight: 1.6, marginBottom: 8 }}>{"🎯"} {weeklyRec.recommendation}</div>
            {weeklyRec.dataPoint && <div style={{ fontSize: 12, color: D.muted, marginBottom: 4 }}>{weeklyRec.dataPoint}</div>}
            {weeklyRec.estimatedImpact && <div style={{ fontSize: 12, color: D.green }}>{weeklyRec.estimatedImpact}</div>}
          </div>
          <button onClick={() => navigator.clipboard?.writeText(weeklyRec.recommendation)} style={{
            padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.border}`, background: 'transparent',
            color: D.muted, fontSize: 12, cursor: 'pointer',
          }}>{"📋"} Copy to Group Chat</button>
        </div>
      )}

      {/* Lead Quality vs CSR Performance */}
      {leadQuality && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 12 }}>Lead Quality vs CSR Performance</div>
          <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>Lost calls breakdown (last 30 days):</div>
          {(leadQuality.lossReasons || []).map((r, i) => {
            const reasonLabels = { bad_lead: 'Bad leads (CSR couldn\'t save)', csr_missed_script: 'CSR missed script', pricing: 'Price objection unhandled', no_availability: 'No availability', customer_shopping: 'Customer shopping', after_hours: 'After hours', no_answer: 'No answer' };
            const isCsr = r.reason === 'csr_missed_script' || r.reason === 'pricing';
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ flex: 1, height: 18, background: D.bg, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${r.pct}%`, background: isCsr ? D.red : D.muted, borderRadius: 4, minWidth: r.pct > 0 ? 4 : 0 }} />
                </div>
                <span style={{ fontSize: 12, color: isCsr ? D.red : D.text, width: 250, textAlign: 'right' }}>{reasonLabels[r.reason] || r.reason}</span>
                <span style={{ fontSize: 12, fontFamily: "'JetBrains Mono', monospace", color: D.muted, width: 40, textAlign: 'right' }}>{r.pct}%</span>
              </div>
            );
          })}
          {overview?.fixableLossCount > 0 && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: D.bg, borderRadius: 8, borderLeft: `3px solid ${D.red}` }}>
              <span style={{ fontSize: 13, color: D.red, fontWeight: 600 }}>{"⚠️"} {overview.fixableLossCount} fixable CSR errors = ~${overview.fixableRevenue?.toLocaleString()}/mo in lost bookings</span>
            </div>
          )}
        </div>
      )}

      {/* Follow-Up Tasks */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Follow-Up Tasks</div>
          <div style={{ fontSize: 12, color: D.muted }}>
            Pending: {tasks?.pending || 0} | Overdue: <span style={{ color: tasks?.overdue > 0 ? D.red : D.muted }}>{tasks?.overdue || 0}</span>
          </div>
        </div>
        {(tasks?.tasks || []).length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: D.muted, fontSize: 13 }}>No pending follow-up tasks</div>
        ) : (tasks?.tasks || []).slice(0, 10).map(t => {
          const isOverdue = t.status === 'pending' && new Date(t.deadline) < new Date();
          return (
            <div key={t.id} style={{ padding: '12px 14px', background: D.bg, borderRadius: 8, marginBottom: 8, borderLeft: `3px solid ${isOverdue ? D.red : D.amber}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>
                  {isOverdue ? '🔴 OVERDUE' : '🟡 DUE'}: {t.assigned_to} — {t.task_type?.replace(/_/g, ' ')}
                  {t.first_name && ` ${t.first_name} ${t.last_name || ''}`}
                </div>
                <span style={{ fontSize: 10, color: D.muted }}>{new Date(t.deadline).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              </div>
              <div style={{ fontSize: 12, color: D.text, marginBottom: 8, lineHeight: 1.5 }}>{t.recommended_action}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => handleTaskUpdate(t.id, 'completed')} style={{ padding: '4px 10px', borderRadius: 4, border: 'none', background: D.green, color: D.white, fontSize: 11, cursor: 'pointer' }}>Mark Done</button>
                <button onClick={() => handleTaskUpdate(t.id, 'in_progress')} style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 11, cursor: 'pointer' }}>Reassign</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bonus Leaderboard */}
      {leaderboard && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 4 }}>{"🏆"} Bonus Leaderboard</div>
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>Period: {leaderboard.periodLabel}</div>
          {(leaderboard.categories || []).map((cat, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: D.bg, borderRadius: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 20 }}>{"🏆"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{cat.category}: {cat.winner || 'TBD'}</div>
                <div style={{ fontSize: 12, color: D.teal }}>{cat.value}</div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: D.green, fontFamily: "'JetBrains Mono', monospace" }}>${cat.bonus}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// MAIN COMMUNICATIONS PAGE
// =========================================================================

export default function CommunicationsPage() {
  const [messages, setMessages] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [commsTab, setCommsTab] = useState('sms');

  // Compose state
  const [toNumber, setToNumber] = useState('');
  const [fromNumber, setFromNumber] = useState('+19413187612');
  const [msgBody, setMsgBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);

  // Filters
  const [dirFilter, setDirFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  const loadData = useCallback(() => {
    Promise.all([
      adminFetch('/admin/communications/log').catch(() => ({ messages: [] })),
      adminFetch('/admin/communications/stats').catch(() => null),
    ]).then(([logData, statsData]) => {
      setMessages(logData.messages || []);
      setStats(statsData);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSend = async () => {
    if (!toNumber.trim() || !msgBody.trim()) return;
    setSending(true);
    setSendResult(null);
    try {
      await adminFetch('/admin/communications/sms', {
        method: 'POST',
        body: JSON.stringify({ to: toNumber.trim(), body: msgBody.trim(), messageType: 'manual', fromNumber }),
      });
      setSendResult({ ok: true, text: 'Message sent!' });
      setToNumber('');
      setMsgBody('');
      loadData();
    } catch (e) {
      setSendResult({ ok: false, text: `Failed: ${e.message}` });
    } finally {
      setSending(false);
    }
  };

  // Derived data
  const totalSent = stats?.channelStats?.reduce((s, c) => s + (c.sent || 0), 0) || 0;
  const totalReceived = stats?.locationStats?.reduce((s, l) => s + (l.received || 0), 0) || 0;

  const locationNumbers = stats?.locationStats || [];
  const trackingObj = stats?.phoneNumbers?.tracking || {};
  const trackingNumbers = Object.values(trackingObj);

  const channelStats = stats?.channelStats || [];
  const maxChannel = channelStats.length > 0 ? Math.max(...channelStats.map(c => c.sent || 0), 1) : 1;

  // Unique message types for filter dropdown
  const messageTypes = [...new Set(messages.map(m => m.messageType).filter(Boolean))];

  const filtered = messages.filter(m => {
    if (dirFilter === 'inbound' && m.direction !== 'inbound') return false;
    if (dirFilter === 'outbound' && m.direction !== 'outbound') return false;
    if (typeFilter !== 'all' && m.messageType !== typeFilter) return false;
    return true;
  });

  if (loading) {
    return (
      <div style={{ padding: 40, color: D.muted, fontFamily: 'DM Sans, sans-serif' }}>
        Loading communications...
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 28px', fontFamily: 'DM Sans, sans-serif', color: D.text, maxWidth: 1200 }}>
      {/* --- Header --- */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
        <h1 style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 24, fontWeight: 700, color: D.white, margin: 0 }}>Communications</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <StatCard label="Sent this month" value={totalSent} color={D.green} />
          <StatCard label="Received this month" value={totalReceived} color={D.teal} />
        </div>
      </div>

      {/* --- Tabs --- */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}` }}>
        {[{ key: 'sms', label: 'SMS' }, { key: 'calls', label: 'Call' }, { key: 'csr', label: 'CSR Coach' }].map(t => (
          <button key={t.key} onClick={() => setCommsTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: commsTab === t.key ? D.teal : 'transparent',
            color: commsTab === t.key ? D.white : D.muted,
            transition: 'all 0.15s',
          }}>{t.label}</button>
        ))}
      </div>

      {commsTab === 'csr' ? <CSRCoachTab /> : commsTab === 'calls' ? <CallLogTab /> : <>

      {/* --- Phone Numbers Overview --- */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Phone Numbers</h2>
        {ALL_NUMBERS.map(group => (
          <div key={group.group} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: D.teal, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{group.group}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {group.numbers.map((n, i) => (
                <div key={i} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '10px 14px', minWidth: 200, flex: '0 1 auto' }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: D.white, marginBottom: 2 }}>{n.formatted}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>{n.label}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* --- Two-column: Send SMS + Channel Analytics --- */}
      <div style={{ display: 'flex', gap: 20, marginBottom: 28, flexWrap: 'wrap' }}>
        {/* Send SMS Panel */}
        <div style={{
          background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
          padding: 20, flex: '1 1 340px', minWidth: 300,
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14, margin: '0 0 14px' }}>SMS</h2>

          <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>From</label>
          <select
            value={fromNumber}
            onChange={e => setFromNumber(e.target.value)}
            style={{
              width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
              color: D.white, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', marginBottom: 12, boxSizing: 'border-box',
              WebkitAppearance: 'none', appearance: 'none',
              backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")",
              backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: 32,
            }}
          >
            {ALL_NUMBERS.map(group => (
              <optgroup key={group.group} label={group.group}>
                {group.numbers.map(n => (
                  <option key={n.number} value={n.number}>{n.formatted} — {n.label}</option>
                ))}
              </optgroup>
            ))}
          </select>

          <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>To</label>
          <input
            type="tel"
            placeholder="+1 (xxx) xxx-xxxx"
            value={toNumber}
            onChange={e => setToNumber(e.target.value)}
            style={{
              width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
              color: D.white, fontSize: 14, fontFamily: 'JetBrains Mono, monospace', outline: 'none', marginBottom: 12, boxSizing: 'border-box',
            }}
          />

          <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>Message</label>
          <textarea
            placeholder="Type your message..."
            value={msgBody}
            onChange={e => { if (e.target.value.length <= 160) setMsgBody(e.target.value); }}
            rows={3}
            style={{
              width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
              color: D.white, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', resize: 'vertical', marginBottom: 4, boxSizing: 'border-box',
            }}
          />
          <div style={{ textAlign: 'right', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: msgBody.length > 140 ? D.amber : D.muted, marginBottom: 12 }}>
            {msgBody.length}/160
          </div>

          {/* Quick Templates */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {TEMPLATES.map(t => (
              <button
                key={t.label}
                onClick={() => setMsgBody(t.body.slice(0, 160))}
                style={{
                  background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6,
                  color: D.teal, fontSize: 11, padding: '5px 10px', cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            onClick={handleSend}
            disabled={sending || !toNumber.trim() || !msgBody.trim()}
            style={{
              width: '100%', padding: '10px 0', background: sending ? D.muted : D.green, border: 'none', borderRadius: 8,
              color: D.white, fontSize: 14, fontWeight: 600, cursor: sending ? 'not-allowed' : 'pointer', fontFamily: 'DM Sans, sans-serif',
              opacity: (!toNumber.trim() || !msgBody.trim()) ? 0.5 : 1,
            }}
          >
            {sending ? 'Sending...' : 'Send'}
          </button>

          {sendResult && (
            <div style={{ marginTop: 10, fontSize: 12, color: sendResult.ok ? D.green : D.red, fontFamily: 'DM Sans, sans-serif' }}>
              {sendResult.text}
            </div>
          )}
        </div>

        {/* Channel Analytics */}
        <div style={{
          background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
          padding: 20, flex: '1 1 300px', minWidth: 280,
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14, margin: '0 0 14px' }}>Channel Analytics</h2>
          {channelStats.length > 0 ? (
            channelStats.map(c => (
              <ChannelBar key={c.type} type={c.type} count={c.sent} max={maxChannel} />
            ))
          ) : (
            <div style={{ color: D.muted, fontSize: 13 }}>No channel data yet.</div>
          )}
        </div>
      </div>

      {/* --- SMS Log --- */}
      <div style={{
        background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>SMS Log</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            {/* Direction filter */}
            <select
              value={dirFilter}
              onChange={e => setDirFilter(e.target.value)}
              style={{
                background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6, color: D.text,
                fontSize: 12, padding: '5px 8px', fontFamily: 'DM Sans, sans-serif', outline: 'none',
              }}
            >
              <option value="all">All directions</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
            {/* Type filter */}
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              style={{
                background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6, color: D.text,
                fontSize: 12, padding: '5px 8px', fontFamily: 'DM Sans, sans-serif', outline: 'none',
              }}
            >
              <option value="all">All types</option>
              {messageTypes.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ maxHeight: 480, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No messages found.</div>
          ) : (
            filtered.map(m => (
              <div
                key={m.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0',
                  borderBottom: `1px solid ${D.border}`,
                }}
              >
                {/* Direction arrow */}
                <span style={{
                  fontSize: 16, lineHeight: '20px', flexShrink: 0, width: 20, textAlign: 'center',
                  color: m.direction === 'outbound' ? D.green : D.teal,
                }}>
                  {m.direction === 'outbound' ? '↑' : '↓'}
                </span>

                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Top line: from/to + customer name */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.text }}>
                      {m.from} → {m.to}
                    </span>
                    {m.customerName && (
                      <span style={{ fontSize: 11, color: D.teal, fontFamily: 'DM Sans, sans-serif' }}>({m.customerName})</span>
                    )}
                  </div>
                  {/* Body */}
                  <div style={{ fontSize: 13, color: D.muted, lineHeight: 1.4, wordBreak: 'break-word' }}>
                    {m.body && m.body.length > 80 ? m.body.slice(0, 80) + '...' : m.body}
                  </div>
                </div>

                {/* Right side: badges + time */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <StatusBadge status={m.status} />
                    {m.messageType && <TypeBadge type={m.messageType} />}
                  </div>
                  <span style={{ fontSize: 10, color: D.muted, fontFamily: 'JetBrains Mono, monospace' }}>{timeAgo(m.createdAt)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      </>}
    </div>
  );
}
