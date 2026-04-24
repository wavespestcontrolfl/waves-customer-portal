import { useState, useEffect, useCallback, useMemo } from 'react';

import CallRecordingsPanel from './CallRecordingsPanel';
import PushSettings from '../../components/admin/PushSettings';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };
const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

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

function formatTimestamp(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isYesterday) return 'Yesterday ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const TEMPLATES = [
  { label: 'Service reminder', body: 'Hi! This is Waves Pest Control. Just a reminder that your service is scheduled for tomorrow. Reply CONFIRM to confirm or call us to reschedule.' },
  { label: 'Running late', body: 'Hi! This is Waves Pest Control. Our technician is running a bit behind schedule. We estimate arrival in about 15-20 minutes. Sorry for the delay!' },
  { label: 'Review request', body: 'Thanks for choosing Waves Pest Control! We\'d love your feedback. Please leave us a quick review: [LINK]' },
  { label: 'Confirm scheduling', body: 'Hi {name}, your service is scheduled for {date}. Reply CONFIRM.' },
  { label: 'Service complete', body: 'All done! Your report is in your portal.' },
  { label: 'Follow-up', body: 'Following up on your request. Adam will address this at your next visit.' },
  { label: 'Quick acknowledge', body: 'We received your message and will respond within 1 hour.' },
];

const ALL_NUMBERS = [
  { group: 'GBP Locations', numbers: [
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
  { group: 'Operations', numbers: [
    { number: '+18559260203', formatted: '(855) 926-0203', label: 'AI Agent' },
    { number: '+19412412459', formatted: '(941) 241-2459', label: 'Waves Van' },
  ]},
  { group: 'Unassigned', numbers: [
    { number: '+19412535279', formatted: '(941) 253-5279', label: 'Unassigned' },
    { number: '+19412411388', formatted: '(941) 241-1388', label: 'Unassigned' },
  ]},
];

// Flat lookup: number -> label
const NUMBER_LABEL_MAP = {};
ALL_NUMBERS.forEach(g => g.numbers.forEach(n => { NUMBER_LABEL_MAP[n.number] = n.label; }));

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

const CALL_DISPOSITIONS = [
  { value: '', label: 'Tag call...' },
  { value: 'new_lead_booked', label: 'New lead — booked' },
  { value: 'new_lead_no_booking', label: 'New lead — no booking' },
  { value: 'existing_service_q', label: 'Existing — service Q' },
  { value: 'existing_complaint', label: 'Existing — complaint' },
  { value: 'spam', label: 'Spam / wrong number' },
];

// --- Stat Card ---
function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
      padding: isMobile ? '12px 10px' : '16px 20px', flex: isMobile ? '1 1 calc(50% - 6px)' : '1 1 0', minWidth: isMobile ? 0 : 140,
    }}>
      <div style={{ color: D.muted, fontSize: 11, fontFamily: 'DM Sans, sans-serif', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 26, fontWeight: 700, color: color || D.heading }}>{value}</div>
    </div>
  );
}

// --- Stat Card with health indicator ---
function StatCardWithHealth({ label, value, color, shouldHaveActivity, onClick, active }) {
  const isHealthy = value > 0;
  const showDot = shouldHaveActivity !== false;
  const dotColor = isHealthy ? D.green : D.red;
  return (
    <div onClick={onClick} style={{
      background: D.card, borderRadius: 10, padding: '12px 14px', border: `1px solid ${active ? color : D.border}`, textAlign: 'center', minWidth: 0,
      flex: isMobile ? '1 1 calc(50% - 6px)' : '1 1 100px',
      cursor: onClick ? 'pointer' : 'default', transition: 'border-color 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 4 }}>
        <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
        {showDot && (
          <span title={isHealthy ? 'Active' : 'No activity detected'} style={{
            width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0,
          }} />
        )}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
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
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, color: D.heading }}>{number}</span>
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

// --- Expandable SMS Log Item ---
function SmsLogItem({ msg: m, onReply }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = m.body && m.body.length > 80;

  return (
    <div
      style={{ padding: '10px 0', borderBottom: `1px solid ${D.border}`, cursor: 'pointer' }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{
          fontSize: 16, lineHeight: '20px', flexShrink: 0, width: 20, textAlign: 'center',
          color: m.direction === 'outbound' ? D.green : D.teal,
        }}>
          {m.direction === 'outbound' ? '↑' : '↓'}
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: D.text }}>
              {m.from} → {m.to}
            </span>
            {m.customerName && (
              <span style={{ fontSize: 11, color: D.teal, fontFamily: 'DM Sans, sans-serif' }}>({m.customerName})</span>
            )}
          </div>
          <div style={{ fontSize: 13, color: expanded ? D.text : D.muted, lineHeight: 1.5, wordBreak: 'break-word', whiteSpace: expanded ? 'pre-wrap' : 'normal' }}>
            {expanded ? m.body : (isLong ? m.body.slice(0, 80) + '...' : m.body)}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <StatusBadge status={m.status} />
            {m.messageType && <TypeBadge type={m.messageType} />}
          </div>
          <span style={{ fontSize: 10, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>{timeAgo(m.createdAt)}</span>
        </div>
      </div>

      {/* Expanded actions */}
      {expanded && (
        <div style={{ marginTop: 8, marginLeft: 30, display: 'flex', gap: 8 }}>
          {m.direction === 'inbound' && (
            <button onClick={e => { e.stopPropagation(); onReply(m.from, m.to); }} style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', background: D.teal, color: '#fff',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>Reply</button>
          )}
          {m.direction === 'outbound' && (
            <button onClick={e => { e.stopPropagation(); onReply(m.to, m.from); }} style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', background: D.teal, color: '#fff',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>Send Again</button>
          )}
          <button onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(m.body || ''); }} style={{
            padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.border}`, background: 'transparent',
            color: D.muted, fontSize: 12, cursor: 'pointer',
          }}>Copy</button>
        </div>
      )}
    </div>
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
// CONVERSATION THREAD VIEW
// =========================================================================
function ConversationView({ thread, messages, onReply, onBack }) {
  const contactPhone = thread.contactPhone;
  const contactName = thread.customerName || contactPhone;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Thread header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${D.border}` }}>
        <button onClick={onBack} style={{
          background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6, color: D.muted,
          fontSize: 13, padding: '6px 12px', cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
        }}>Back</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>{contactName}</div>
          <div style={{ fontSize: 12, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>{contactPhone}</div>
        </div>
        <button onClick={() => onReply(contactPhone, thread.ourNumber)} style={{
          padding: '8px 18px', borderRadius: 8, border: 'none', background: D.teal, color: '#fff',
          fontSize: 13, fontWeight: 600, cursor: 'pointer',
        }}>Reply</button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, maxHeight: 500, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.map(m => {
          const isOutbound = m.direction === 'outbound';
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: isOutbound ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '75%', padding: '10px 14px', borderRadius: 12,
                background: isOutbound ? D.teal : '#F1F5F9',
                border: `1px solid ${isOutbound ? D.teal : D.border}`,
                color: isOutbound ? '#fff' : undefined,
                borderBottomRightRadius: isOutbound ? 4 : 12,
                borderBottomLeftRadius: isOutbound ? 12 : 4,
              }}>
                <div style={{ fontSize: 13, color: isOutbound ? '#fff' : D.text, lineHeight: 1.5, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{m.body}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, justifyContent: isOutbound ? 'flex-end' : 'flex-start' }}>
                  <span style={{ fontSize: 10, color: isOutbound ? 'rgba(255,255,255,0.7)' : D.muted }}>{formatTimestamp(m.createdAt)}</span>
                  {m.messageType && <TypeBadge type={m.messageType} />}
                  <StatusBadge status={m.status} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =========================================================================
// CALL LOG TAB
// =========================================================================
function CallLogTab() {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [callTo, setCallTo] = useState('');
  const [callToSearch, setCallToSearch] = useState('');
  const [callToResults, setCallToResults] = useState([]);
  const [callFrom, setCallFrom] = useState('+19413187612');
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState(null);
  const [dispositions, setDispositions] = useState({}); // { callId: value }
  const [savingDisp, setSavingDisp] = useState(null);
  const [callFilter, setCallFilter] = useState('all');
  const [callLogSearch, setCallLogSearch] = useState('');

  const loadCalls = (search = '') => {
    const q = search
      ? `?search=${encodeURIComponent(search)}&limit=1000`
      : '?days=365&limit=200';
    adminFetch(`/ai/admin/calls${q}`).then(d => { setCalls(d.calls || []); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => { loadCalls(); }, []);

  useEffect(() => {
    const t = setTimeout(() => { loadCalls(callLogSearch.trim()); }, 300);
    return () => clearTimeout(t);
  }, [callLogSearch]);

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

  const handleDisposition = async (callId, value) => {
    if (value === 'spam' && !confirm('Block this number and delete the call log? This cannot be undone.')) return;
    setDispositions(prev => ({ ...prev, [callId]: value }));
    setSavingDisp(callId);
    try {
      const r = await adminFetch(`/admin/call-recordings/calls/${callId}/disposition`, {
        method: 'PUT',
        body: JSON.stringify({ disposition: value }),
      });
      if (r.deleted) {
        // Spam — remove from call list
        setCalls(prev => prev.filter(c => c.id !== callId));
      }
    } catch (e) {
      alert('Tag failed: ' + e.message);
    } finally {
      setSavingDisp(null);
    }
  };

  const handleCallBack = (phone) => {
    setCallTo(phone);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCreateLead = (phone, city, state) => {
    // Navigate to customer creation with pre-filled phone
    const params = new URLSearchParams({ phone: phone || '' });
    if (city) params.set('city', city);
    if (state) params.set('state', state);
    window.open(`/admin/customers/new?${params.toString()}`, '_blank');
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading calls...</div>;

  const answered = calls.filter(c => c.answered_by === 'human').length;
  const aiHandled = calls.filter(c => c.answered_by === 'voice_agent').length;
  const voicemail = calls.filter(c => c.answered_by === 'voicemail').length;
  const missed = calls.filter(c => !c.answered_by || c.answered_by === 'missed').length;

  // Source number analytics — calls per source number this month
  const now = new Date();
  const thisMonthCalls = calls.filter(c => {
    const cd = new Date(c.created_at);
    return cd.getMonth() === now.getMonth() && cd.getFullYear() === now.getFullYear();
  });
  const sourceNumberCounts = {};
  thisMonthCalls.forEach(c => {
    const num = c.to_phone || 'Unknown';
    const label = NUMBER_LABEL_MAP[num] || num;
    sourceNumberCounts[label] = (sourceNumberCounts[label] || 0) + 1;
  });
  const sortedSources = Object.entries(sourceNumberCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: 'Total', value: calls.length, color: D.heading, filter: 'all' },
          { label: 'Answered', value: answered, color: D.green, filter: 'answered' },
          { label: 'AI Agent', value: aiHandled, color: D.teal, filter: 'ai_agent' },
          { label: 'Voicemail', value: voicemail, color: D.amber, filter: 'voicemail' },
          { label: 'Missed', value: missed, color: D.red, filter: 'missed' },
        ].map((s, i) => (
          <div key={i} onClick={() => setCallFilter(prev => prev === s.filter ? 'all' : s.filter)} style={{ flex: isMobile ? '1 1 calc(50% - 6px)' : '1 1 100px', background: D.card, borderRadius: 10, padding: '12px 14px', border: `1px solid ${callFilter === s.filter && s.filter !== 'all' ? s.color : D.border}`, textAlign: 'center', minWidth: 0, cursor: 'pointer', transition: 'border-color 0.15s' }}>
            <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Source Number Analytics */}
      {sortedSources.length > 0 && (
        <div style={{ background: D.card, borderRadius: 12, padding: '16px 20px', border: `1px solid ${D.border}` }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 12px' }}>Calls Per Source (This Month)</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {sortedSources.slice(0, 12).map(([label, count]) => (
              <div key={label} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                background: D.bg, borderRadius: 8, border: `1px solid ${D.border}`,
              }}>
                <span style={{ fontSize: 12, color: D.text, fontFamily: 'DM Sans, sans-serif' }}>{label}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: D.teal, fontFamily: "'JetBrains Mono', monospace" }}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Make a Call panel */}
      <div style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}`, marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 14px' }}>Make a Call</h2>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>From</label>
            <select
              value={callFrom}
              onChange={e => setCallFrom(e.target.value)}
              style={{
                width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
                color: D.heading, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', boxSizing: 'border-box',
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
              type="text"
              placeholder="Search by name or enter phone number..."
              value={callToSearch || callTo}
              onChange={async (e) => {
                const val = e.target.value;
                if (/^[\d\s\(\)\-\+]+$/.test(val)) {
                  setCallTo(val);
                  setCallToSearch('');
                  setCallToResults([]);
                } else {
                  setCallToSearch(val);
                  setCallTo('');
                  if (val.length >= 2) {
                    try {
                      const r = await fetch(`${API_BASE}/admin/customers?search=${encodeURIComponent(val)}&limit=8`, {
                        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
                      });
                      if (r.ok) { const d = await r.json(); setCallToResults(d.customers || []); }
                    } catch {}
                  } else { setCallToResults([]); }
                }
              }}
              style={{
                width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
                color: D.heading, fontSize: 14, fontFamily: callToSearch ? "'DM Sans', sans-serif" : "'JetBrains Mono', monospace", outline: 'none', boxSizing: 'border-box',
              }}
            />
            {callToResults.length > 0 && (
              <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: '0 0 8px 8px', maxHeight: 180, overflowY: 'auto' }}>
                {callToResults.map(c => (
                  <div key={c.id} onClick={() => {
                    setCallTo(c.phone || '');
                    setCallToSearch(`${c.firstName} ${c.lastName} — ${c.phone || ''}`);
                    setCallToResults([]);
                  }} style={{
                    padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`,
                    fontSize: 13, color: D.heading,
                  }}>
                    <strong>{c.firstName} {c.lastName}</strong>
                    <span style={{ color: D.muted, marginLeft: 8 }}>{c.phone || 'no phone'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={handleCall}
          disabled={calling || !callTo.trim()}
          style={{
            padding: '10px 24px', background: calling ? D.muted : D.green, border: 'none', borderRadius: 8,
            color: D.heading, fontSize: 14, fontWeight: 600, cursor: calling ? 'not-allowed' : 'pointer',
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>Call History</h2>
          <input
            type="text"
            placeholder="Search calls by name or phone..."
            value={callLogSearch}
            onChange={e => setCallLogSearch(e.target.value)}
            style={{
              flex: '1 1 260px', maxWidth: 360, minWidth: 200,
              background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text,
              fontSize: 13, padding: '8px 12px', fontFamily: 'DM Sans, sans-serif', outline: 'none',
            }}
          />
        </div>

        {calls.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No calls recorded yet.</div>
        ) : (
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {calls.filter(c => {
              if (callFilter === 'all') return true;
              if (callFilter === 'answered') return c.answered_by === 'human';
              if (callFilter === 'ai_agent') return c.answered_by === 'voice_agent';
              if (callFilter === 'voicemail') return c.answered_by === 'voicemail';
              if (callFilter === 'missed') return !c.answered_by || c.answered_by === 'missed';
              return true;
            }).map(c => {
              const isMissed = !c.answered_by || c.answered_by === 'missed';
              const answeredColor = c.answered_by === 'human' ? D.green : c.answered_by === 'voice_agent' ? D.teal : c.answered_by === 'voicemail' ? D.amber : D.red;
              const answeredLabel = c.answered_by === 'human' ? 'Answered' : c.answered_by === 'voice_agent' ? 'AI Agent' : c.answered_by === 'voicemail' ? 'Voicemail' : 'Missed';
              const dur = c.duration_seconds ? `${Math.floor(c.duration_seconds / 60)}:${String(c.duration_seconds % 60).padStart(2, '0')}` : '--';
              const isUnknown = !c.first_name && !c.customer_id;
              const currentDisp = dispositions[c.id] || c.disposition || '';

              return (
                <div key={c.id} style={{
                  padding: '12px 0', borderBottom: `1px solid ${D.border}`,
                  background: isMissed ? D.red + '08' : 'transparent',
                  borderLeft: isMissed ? `3px solid ${D.red}` : '3px solid transparent',
                  paddingLeft: 10,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16, width: 20, textAlign: 'center', color: c.direction === 'inbound' ? D.teal : D.green }}>{c.direction === 'inbound' ? '↓' : '↑'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>
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

                  {/* Action row: disposition, missed call-back, create lead */}
                  <div style={{ marginTop: 8, marginLeft: 30, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {/* Disposition tag */}
                    <select
                      value={currentDisp}
                      onChange={e => handleDisposition(c.id, e.target.value)}
                      style={{
                        background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6, color: currentDisp ? D.text : D.muted,
                        fontSize: 11, padding: '4px 8px', fontFamily: 'DM Sans, sans-serif', outline: 'none',
                        opacity: savingDisp === c.id ? 0.5 : 1, cursor: 'pointer',
                      }}
                    >
                      {CALL_DISPOSITIONS.map(d => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                      ))}
                    </select>

                    {/* Missed call — Call Back button */}
                    {isMissed && c.from_phone && (
                      <button onClick={() => handleCallBack(c.from_phone)} style={{
                        padding: '4px 12px', borderRadius: 6, border: 'none', background: D.red, color: '#fff',
                        fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      }}>Call Back</button>
                    )}

                    {/* Unknown caller — Create Lead button */}
                    {isUnknown && c.from_phone && (
                      <button onClick={() => handleCreateLead(c.from_phone, c.caller_city, c.caller_state)} style={{
                        padding: '4px 12px', borderRadius: 6, border: `1px solid ${D.teal}`, background: 'transparent', color: D.teal,
                        fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      }}>Create Lead</button>
                    )}
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
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Team Overview (Last 30 Days)</div>
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
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 12 }}>{"📊"} This Week's Team Focus</div>
          <div style={{ padding: 16, background: D.bg, borderRadius: 10, marginBottom: 12, borderLeft: `3px solid ${D.teal}` }}>
            <div style={{ fontSize: 14, color: D.heading, lineHeight: 1.6, marginBottom: 8 }}>{"🎯"} {weeklyRec.recommendation}</div>
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
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Lead Quality vs CSR Performance</div>
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
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading }}>Follow-Up Tasks</div>
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
                <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>
                  {isOverdue ? '🔴 OVERDUE' : '🟡 DUE'}: {t.assigned_to} — {t.task_type?.replace(/_/g, ' ')}
                  {t.first_name && ` ${t.first_name} ${t.last_name || ''}`}
                </div>
                <span style={{ fontSize: 10, color: D.muted }}>{new Date(t.deadline).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              </div>
              <div style={{ fontSize: 12, color: D.text, marginBottom: 8, lineHeight: 1.5 }}>{t.recommended_action}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => handleTaskUpdate(t.id, 'completed')} style={{ padding: '4px 10px', borderRadius: 4, border: 'none', background: D.green, color: '#fff', fontSize: 11, cursor: 'pointer' }}>Mark Done</button>
                <button onClick={() => handleTaskUpdate(t.id, 'in_progress')} style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 11, cursor: 'pointer' }}>Reassign</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bonus Leaderboard */}
      {leaderboard && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 4 }}>{"🏆"} Bonus Leaderboard</div>
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>Period: {leaderboard.periodLabel}</div>
          {(leaderboard.categories || []).map((cat, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: D.bg, borderRadius: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 20 }}>{"🏆"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{cat.category}: {cat.winner || 'TBD'}</div>
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
// PHONE NUMBERS TAB
// =========================================================================

// Health status helper: determines dot color and label based on last inbound date
function getHealthStatus(lastInboundDate, isUnassigned) {
  if (isUnassigned) return { color: '#6b7280', label: 'Unassigned', key: 'gray' };
  if (!lastInboundDate) return { color: '#C0392B', label: 'Dormant (no inbound)', key: 'red' };
  const now = new Date();
  const last = new Date(lastInboundDate);
  const daysSince = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  if (daysSince <= 30) return { color: '#10b981', label: `Active (${daysSince}d ago)`, key: 'green' };
  if (daysSince <= 60) return { color: '#f59e0b', label: `Low activity (${daysSince}d ago)`, key: 'amber' };
  return { color: '#C0392B', label: `Dormant (${daysSince}d ago)`, key: 'red' };
}

// Channel type metadata for expanded analytics
const CHANNEL_TYPE_META = {
  manual: { icon: '💬', label: 'Manual', color: D.muted },
  auto_reminder: { icon: '🔔', label: 'Auto Reminder', color: D.amber },
  auto_enroute: { icon: '🚐', label: 'Auto En Route', color: D.green },
  auto_completion: { icon: '✅', label: 'Auto Completion', color: D.green },
  auto_review: { icon: '⭐', label: 'Auto Review', color: D.amber },
  auto_estimate: { icon: '📋', label: 'Auto Estimate', color: D.teal },
  auto_payment: { icon: '💳', label: 'Auto Payment', color: '#8b5cf6' },
  internal_alert: { icon: '🚨', label: 'Internal Alert', color: D.red },
  reminder: { icon: '🔔', label: 'Reminder', color: D.amber },
  estimate: { icon: '📋', label: 'Estimate', color: D.teal },
  review: { icon: '⭐', label: 'Review', color: D.amber },
  completion: { icon: '✅', label: 'Completion', color: D.green },
  en_route: { icon: '🚐', label: 'En Route', color: D.green },
  confirmation: { icon: '📩', label: 'Confirmation', color: D.teal },
  inbound: { icon: '📥', label: 'Inbound', color: D.teal },
};

function SmsTemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    adminFetch('/admin/sms-templates').then(d => { setTemplates(d.templates || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleSave = async (id) => {
    setSaving(true);
    try {
      await adminFetch(`/admin/sms-templates/${id}`, { method: 'PUT', body: JSON.stringify({ body: editBody }) });
      setTemplates(prev => prev.map(t => t.id === id ? { ...t, body: editBody } : t));
      setEditing(null);
    } catch { alert('Save failed'); }
    setSaving(false);
  };

  const toggleActive = async (t) => {
    await adminFetch(`/admin/sms-templates/${t.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !t.is_active }) });
    setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, is_active: !x.is_active } : x));
  };

  const categories = [...new Set(templates.map(t => t.category))];
  const filtered = filter === 'all' ? templates : templates.filter(t => t.category === filter);

  const catColors = { service: '#0A7EC2', billing: '#16A34A', estimates: '#F0A500', reviews: '#7C3AED', referrals: '#0A7EC2', retention: '#C0392B', onboarding: '#16A34A', internal: '#64748B', custom: '#94a3b8' };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading templates...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{filtered.length} SMS Templates</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => setFilter('all')} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer', background: filter === 'all' ? D.teal : D.card, color: filter === 'all' ? D.white : D.muted }}>All</button>
          {categories.map(c => (
            <button key={c} onClick={() => setFilter(c)} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer', background: filter === c ? (catColors[c] || D.teal) : D.card, color: filter === c ? D.white : D.muted, textTransform: 'capitalize' }}>{c}</button>
          ))}
        </div>
      </div>

      {filtered.map(t => (
        <div key={t.id} style={{ background: D.card, borderRadius: 10, padding: '14px 16px', border: `1px solid ${D.border}`, marginBottom: 8, borderLeft: `3px solid ${catColors[t.category] || D.muted}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{t.name}</span>
              <span style={{ fontSize: 10, marginLeft: 8, padding: '2px 6px', borderRadius: 4, background: (catColors[t.category] || D.muted) + '22', color: catColors[t.category] || D.muted, textTransform: 'capitalize' }}>{t.category}</span>
              {t.is_internal && <span style={{ fontSize: 10, marginLeft: 6, padding: '2px 6px', borderRadius: 4, background: '#64748b22', color: '#64748b' }}>Internal</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button onClick={() => toggleActive(t)} title={t.is_active ? 'Click to disable' : 'Click to enable'} style={{
                position: 'relative', width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                background: t.is_active ? D.green : '#475569', transition: 'background 0.2s', padding: 0,
              }}>
                <span style={{
                  position: 'absolute', top: 2, left: t.is_active ? 22 : 2,
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                }} />
              </button>
              {editing === t.id ? (
                <>
                  <button onClick={() => handleSave(t.id)} disabled={saving} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', background: D.green, color: '#fff' }}>{saving ? '...' : 'Save'}</button>
                  <button onClick={() => setEditing(null)} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', background: 'transparent', color: D.muted, border: `1px solid ${D.border}` }}>Cancel</button>
                </>
              ) : (
                <button onClick={() => { setEditing(t.id); setEditBody(t.body); }} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', background: D.teal + '22', color: D.teal }}>Edit</button>
              )}
            </div>
          </div>
          {editing === t.id ? (
            <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={4} style={{ width: '100%', padding: 10, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.heading, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }} />
          ) : (
            <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{t.body}</div>
          )}
          {t.variables && (
            <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {(typeof t.variables === 'string' ? JSON.parse(t.variables) : t.variables).map(v => (
                <span key={v} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: D.bg, color: D.muted, border: `1px solid ${D.border}` }}>{`{${v}}`}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PhoneNumbersTab({ channelStats, maxChannel, stats }) {
  // Build per-number stats from the stats API data
  const numberStats = {};
  (stats?.locationStats || []).forEach(l => {
    if (l.number) numberStats[l.number] = {
      sent: l.sent || 0,
      received: l.received || 0,
      inboundThisMonth: l.inboundThisMonth || l.received || 0,
      lastInboundDate: l.lastInboundDate || l.lastActivity || null,
      smsEnabled: l.smsEnabled !== undefined ? l.smsEnabled : true,
      voiceEnabled: l.voiceEnabled !== undefined ? l.voiceEnabled : true,
    };
  });

  const totalNumbers = ALL_NUMBERS.reduce((s, g) => s + g.numbers.length, 0);
  const estMonthlyCost = totalNumbers * 1.15; // ~$1.15/number/month typical Twilio

  // Find top performing number by messages
  let topLabel = '';
  let topCount = 0;
  ALL_NUMBERS.forEach(g => g.numbers.forEach(n => {
    const ns = numberStats[n.number];
    const total = (ns?.sent || 0) + (ns?.received || 0);
    if (total > topCount) { topCount = total; topLabel = n.label; }
  }));

  // Count dormant numbers (no inbound in 60+ days, excluding Unassigned)
  let dormantCount = 0;
  ALL_NUMBERS.forEach(g => {
    if (g.group === 'Unassigned') return;
    g.numbers.forEach(n => {
      const ns = numberStats[n.number];
      const health = getHealthStatus(ns?.lastInboundDate, false);
      if (health.key === 'red') dormantCount++;
    });
  });

  // Channel analytics: compute automation rate
  const totalChannelMessages = channelStats.reduce((s, c) => s + (c.sent || 0), 0);
  const manualMessages = channelStats.find(c => c.type === 'manual')?.sent || 0;
  const automatedMessages = totalChannelMessages - manualMessages;
  const automationRate = totalChannelMessages > 0 ? Math.round((automatedMessages / totalChannelMessages) * 100) : 0;

  // Expanded channel types — merge existing stats with all possible types
  const allChannelTypes = ['manual', 'auto_reminder', 'auto_enroute', 'auto_completion', 'auto_review', 'auto_estimate', 'auto_payment', 'internal_alert'];
  const channelStatsMap = {};
  channelStats.forEach(c => { channelStatsMap[c.type] = c.sent || 0; });
  // Also map legacy types
  const expandedChannels = allChannelTypes.map(type => ({
    type,
    count: channelStatsMap[type] || channelStatsMap[type.replace('auto_', '')] || 0,
  })).filter(c => c.count > 0);
  // If no expanded data, fall back to original channelStats
  const displayChannels = expandedChannels.length > 0 ? expandedChannels : channelStats.map(c => ({ type: c.type, count: c.sent || 0 }));
  const maxDisplayChannel = displayChannels.length > 0 ? Math.max(...displayChannels.map(c => c.count), 1) : 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Smart Summary Banner */}
      <div style={{
        background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
        padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 13, color: D.text, fontFamily: 'DM Sans, sans-serif' }}>
          <span style={{ fontWeight: 700, color: D.heading, fontFamily: "'JetBrains Mono', monospace" }}>{totalNumbers}</span> numbers
          <span style={{ color: D.muted, margin: '0 6px' }}>{'\u00B7'}</span>
          <span style={{ fontWeight: 700, color: D.heading, fontFamily: "'JetBrains Mono', monospace" }}>${estMonthlyCost.toFixed(2)}</span> est. monthly cost
          {topLabel && <>
            <span style={{ color: D.muted, margin: '0 6px' }}>{'\u00B7'}</span>
            Top: <span style={{ fontWeight: 600, color: D.teal }}>{topLabel}</span> ({topCount} msgs)
          </>}
          {dormantCount > 0 && <>
            <span style={{ color: D.muted, margin: '0 6px' }}>{'\u00B7'}</span>
            <span style={{ color: D.red, fontWeight: 600 }}>{dormantCount} dormant</span>
          </>}
        </span>
      </div>

      {/* Summary Stat Cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <StatCard label="Total Numbers" value={totalNumbers} color={D.white} />
        <StatCard label="GBP Locations" value={ALL_NUMBERS[0].numbers.length} color={D.green} />
        <StatCard label="Pest Domains" value={ALL_NUMBERS[1].numbers.length} color={D.teal} />
        <StatCard label="Lawn Domains" value={ALL_NUMBERS[2].numbers.length} color={D.green} />
        <StatCard label="Operations" value={ALL_NUMBERS[3].numbers.length + ALL_NUMBERS[4].numbers.length} color={D.muted} />
      </div>

      {/* Number Groups */}
      {ALL_NUMBERS.map(group => {
        const isUnassignedGroup = group.group === 'Unassigned';
        return (
        <div key={group.group} style={{ background: D.card, borderRadius: 12, padding: 20, border: `1px solid ${D.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.teal, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14, paddingBottom: 10, borderBottom: `1px solid ${D.border}` }}>
            {group.group}
            <span style={{ fontSize: 11, fontWeight: 500, color: D.muted, marginLeft: 8 }}>({group.numbers.length})</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
            {group.numbers.map((n, i) => {
              const ns = numberStats[n.number];
              const health = getHealthStatus(ns?.lastInboundDate, isUnassignedGroup);
              const daysSinceInbound = ns?.lastInboundDate
                ? Math.floor((new Date() - new Date(ns.lastInboundDate)) / (1000 * 60 * 60 * 24))
                : null;
              const showDormancyWarning = !isUnassignedGroup && (daysSinceInbound === null || daysSinceInbound >= 60);
              const smsEnabled = ns?.smsEnabled !== undefined ? ns.smsEnabled : true;
              const voiceEnabled = ns?.voiceEnabled !== undefined ? ns.voiceEnabled : true;

              return (
                <div key={i} style={{ background: D.bg, border: `1px solid ${D.border}`, borderRadius: 10, padding: '12px 14px' }}>
                  {/* Number + health dot */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span
                      title={health.label}
                      style={{ width: 8, height: 8, borderRadius: '50%', background: health.color, flexShrink: 0 }}
                    />
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600, color: D.heading }}>{n.formatted}</span>
                    {/* SMS/Voice capability indicators */}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexShrink: 0 }}>
                      <span title={smsEnabled ? 'SMS enabled' : 'SMS disabled'} style={{
                        fontSize: 9, padding: '1px 5px', borderRadius: 4,
                        background: smsEnabled ? D.green + '22' : D.red + '22',
                        color: smsEnabled ? D.green : D.red,
                        fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
                      }}>SMS {smsEnabled ? '\u2713' : '\u2717'}</span>
                      <span title={voiceEnabled ? 'Voice enabled' : 'Voice disabled'} style={{
                        fontSize: 9, padding: '1px 5px', borderRadius: 4,
                        background: voiceEnabled ? D.green + '22' : D.red + '22',
                        color: voiceEnabled ? D.green : D.red,
                        fontFamily: "'JetBrains Mono', monospace", fontWeight: 600,
                      }}>Voice {voiceEnabled ? '\u2713' : '\u2717'}</span>
                    </span>
                  </div>

                  {/* Label */}
                  <div style={{ fontSize: 12, color: D.muted, marginBottom: 8 }}>{n.label}</div>

                  {/* Activity metrics */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
                    <div>
                      <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Sent</div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600, color: D.green }}>{ns?.sent || 0}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Received</div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600, color: D.teal }}>{ns?.received || 0}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Inbound/mo</div>
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600, color: D.teal }}>{ns?.inboundThisMonth || 0}</div>
                    </div>
                  </div>

                  {/* Last inbound date */}
                  {!isUnassignedGroup && (
                    <div style={{ fontSize: 10, color: D.muted, marginBottom: 4 }}>
                      Last inbound: {ns?.lastInboundDate
                        ? <span style={{ color: health.color }}>{new Date(ns.lastInboundDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                        : <span style={{ color: D.red }}>never</span>
                      }
                    </div>
                  )}

                  {/* Dormancy warning */}
                  {showDormancyWarning && !isUnassignedGroup && (
                    <div style={{
                      marginTop: 6, padding: '6px 10px', borderRadius: 6,
                      background: D.red + '12', borderLeft: `3px solid ${D.red}`,
                      fontSize: 11, color: D.red, lineHeight: 1.4,
                    }}>
                      {'\u26A0\uFE0F'} No inbound in {daysSinceInbound != null ? `${daysSinceInbound}` : '90+'} days — review SEO ranking
                    </div>
                  )}

                  {/* Unassigned action note */}
                  {isUnassignedGroup && (
                    <div style={{
                      marginTop: 6, padding: '6px 10px', borderRadius: 6,
                      background: D.muted + '12', borderLeft: `3px solid ${D.muted}`,
                      fontSize: 11, color: D.muted, lineHeight: 1.4,
                    }}>
                      Unassigned — assign to a domain or campaign to start tracking
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        );
      })}

      {/* Channel Analytics — Expanded */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>Channel Analytics</h2>
          {totalChannelMessages > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '4px 12px', borderRadius: 8,
              background: D.teal + '18', border: `1px solid ${D.teal}33`,
            }}>
              <span style={{ fontSize: 11, color: D.muted }}>Automation rate</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: D.teal, fontFamily: "'JetBrains Mono', monospace" }}>{automationRate}%</span>
              <span style={{ fontSize: 10, color: D.muted }}>of SMS is automated</span>
            </div>
          )}
        </div>

        {displayChannels.length > 0 ? (
          <>
            {/* Pill badges summary */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
              {displayChannels.map(c => {
                const meta = CHANNEL_TYPE_META[c.type] || { icon: '💬', label: c.type, color: D.muted };
                return (
                  <span key={c.type} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', borderRadius: 20,
                    background: meta.color + '18', border: `1px solid ${meta.color}33`,
                    fontSize: 11, color: meta.color, fontFamily: 'DM Sans, sans-serif',
                  }}>
                    {meta.icon} {meta.label}
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, marginLeft: 2 }}>{c.count}</span>
                  </span>
                );
              })}
            </div>

            {/* Bar chart */}
            {displayChannels.sort((a, b) => b.count - a.count).map(c => {
              const meta = CHANNEL_TYPE_META[c.type] || { icon: '💬', label: c.type, color: D.muted };
              const pct = maxDisplayChannel > 0 ? (c.count / maxDisplayChannel) * 100 : 0;
              return (
                <div key={c.type} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{meta.icon}</span>
                  <span style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 12, color: D.text, width: 120, textTransform: 'capitalize' }}>{meta.label}</span>
                  <div style={{ flex: 1, height: 10, background: D.bg, borderRadius: 5, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: meta.color, borderRadius: 5, transition: 'width 0.4s ease' }} />
                  </div>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: D.muted, width: 36, textAlign: 'right' }}>{c.count}</span>
                </div>
              );
            })}
          </>
        ) : (
          <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No channel data yet. Analytics will appear as messages are sent and received across your numbers.</div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// MAIN COMMUNICATIONS PAGE
// =========================================================================

// Named exports for V2 reuse
export { ALL_NUMBERS, TEMPLATES, CALL_DISPOSITIONS, NUMBER_LABEL_MAP, CallLogTab, CSRCoachTab, SmsTemplatesTab };

export default function CommunicationsPage() {
  const [messages, setMessages] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [commsTab, setCommsTab] = useState('sms');
  const [smsFilter, setSmsFilter] = useState('all');

  // Import state
  const [importing, setImporting] = useState(null);
  const [importResult, setImportResult] = useState(null);

  const handleImport = async (type) => {
    setImporting(type);
    setImportResult(null);
    try {
      const result = await adminFetch(`/admin/import/${type}`, { method: 'POST' });
      setImportResult({ type, ...result });
    } catch (e) {
      setImportResult({ type, error: e.message });
    } finally {
      setImporting(null);
      loadData();
    }
  };

  // AI auto-reply state
  const [aiAutoReply, setAiAutoReply] = useState(false);
  const [togglingAi, setTogglingAi] = useState(false);

  // Compose state
  const [toNumber, setToNumber] = useState('');
  const [toSearch, setToSearch] = useState('');
  const [toResults, setToResults] = useState([]);
  const [fromNumber, setFromNumber] = useState('+19413187612');
  const [msgBody, setMsgBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [aiDrafting, setAiDrafting] = useState(false);

  // Filters
  const [dirFilter, setDirFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  // Conversation threading state
  const [smsView, setSmsView] = useState('threads'); // 'threads' | 'log' | 'conversation'
  const [activeThread, setActiveThread] = useState(null);
  // PR 4 — thread-status filter (independent of smsFilter which gates by stat card).
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'unread' | 'unanswered' | 'unknown' | 'blocked'
  // PR 4 — reply-from lock: when a thread is opened, the From number is pinned
  // to the thread's our_endpoint so replies don't cross Waves numbers. Nullable
  // so "Override" can clear it and fall back to the normal compose picker.
  const [threadLock, setThreadLock] = useState(null); // { contactPhone, ourNumber, label } | null
  // PR 4 — blocked-numbers set (normalized E.164). Used by the Blocked filter
  // chip and by the Block-this-number action.
  const [blockedNumbers, setBlockedNumbers] = useState([]);
  // Tracks when each thread was last read: { [phoneKey]: ISO timestamp of the latest
  // message at the moment the user opened the thread }. Persisted to localStorage so
  // the unread dot doesn't reappear when navigating away and back. A new inbound
  // message after that timestamp will flip the dot back on.
  const [threadReadAt, setThreadReadAt] = useState(() => {
    try {
      const raw = localStorage.getItem('waves_sms_thread_read_at');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [smsSearch, setSmsSearch] = useState('');

  const loadData = useCallback((search = '') => {
    const logUrl = search
      ? `/admin/communications/log?search=${encodeURIComponent(search)}&limit=1000`
      : '/admin/communications/log';
    Promise.all([
      adminFetch(logUrl).catch(() => ({ messages: [] })),
      adminFetch('/admin/communications/stats').catch(() => null),
    ]).then(([logData, statsData]) => {
      setMessages(logData.messages || []);
      setStats(statsData);
      setLoading(false);
    });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const t = setTimeout(() => { loadData(smsSearch.trim()); }, 300);
    return () => clearTimeout(t);
  }, [smsSearch, loadData]);

  // PR 4 — load blocked-numbers list. Used by the filter chip + block action.
  const loadBlocked = useCallback(() => {
    adminFetch('/admin/communications/blocked-numbers').then(d => {
      setBlockedNumbers((d.numbers || []).map(b => b.number));
    }).catch(() => setBlockedNumbers([]));
  }, []);
  useEffect(() => { loadBlocked(); }, [loadBlocked]);

  // Load AI auto-reply setting
  useEffect(() => {
    adminFetch('/admin/communications/ai-auto-reply-status').then(d => setAiAutoReply(d.enabled)).catch(() => {});
  }, []);

  const toggleAiAutoReply = async () => {
    setTogglingAi(true);
    try {
      const r = await adminFetch('/admin/communications/ai-auto-reply', { method: 'POST', body: JSON.stringify({ enabled: !aiAutoReply }) });
      setAiAutoReply(r.enabled);
    } catch { /* ignore */ }
    setTogglingAi(false);
  };

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

  const handleAiDraft = async () => {
    if (!toNumber.trim()) { alert('Enter a To number first'); return; }
    setAiDrafting(true);
    try {
      // Find the last inbound message from this number to use as context
      const lastMsg = messages.find(m => m.direction === 'inbound' && (m.from === toNumber.trim() || m.from?.includes(toNumber.trim().replace(/\D/g, '').slice(-10))));
      const d = await adminFetch('/admin/communications/ai-draft', {
        method: 'POST',
        body: JSON.stringify({ customerPhone: toNumber.trim(), lastMessage: lastMsg?.body || '' }),
      });
      if (d.draft) setMsgBody(d.draft.slice(0, 160));
    } catch (e) {
      alert('AI draft failed: ' + e.message);
    } finally {
      setAiDrafting(false);
    }
  };

  // Build conversation threads from messages
  const threads = useMemo(() => {
    const threadMap = {};
    // Sort messages oldest first to build threads correctly
    const sorted = [...messages].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    sorted.forEach(m => {
      // Determine the contact phone (the non-Waves number)
      const allNums = new Set();
      ALL_NUMBERS.forEach(g => g.numbers.forEach(n => allNums.add(n.number)));

      let contactPhone, ourNumber;
      if (m.direction === 'inbound') {
        contactPhone = m.from;
        ourNumber = m.to;
      } else {
        contactPhone = m.to;
        ourNumber = m.from;
      }
      // Normalize
      const key = contactPhone?.replace(/\D/g, '').slice(-10) || 'unknown';

      if (!threadMap[key]) {
        threadMap[key] = {
          contactPhone,
          ourNumber,
          customerName: m.customerName || null,
          messages: [],
          lastMessage: null,
          lastTimestamp: null,
          lastDirection: null,
          unread: false,
        };
      }
      const thread = threadMap[key];
      thread.messages.push(m);
      // Update with the latest name we find
      if (m.customerName) thread.customerName = m.customerName;
      // Keep ourNumber updated to the last one used
      if (ourNumber && allNums.has(ourNumber)) thread.ourNumber = ourNumber;
      // Update last message info
      thread.lastMessage = m.body;
      thread.lastTimestamp = m.createdAt;
      thread.lastDirection = m.direction;
    });

    // Convert to array, determine unanswered status
    const threadList = Object.values(threadMap).map(t => {
      // Sort thread messages newest first for display
      t.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      // Unanswered = last message was inbound (customer wrote, no reply)
      t.unanswered = t.lastDirection === 'inbound';
      return t;
    });

    // Sort by most recent first
    threadList.sort((a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp));
    return threadList;
  }, [messages]);

  // Normalize a phone to the blocked-numbers set format (E.164-ish last-10 match).
  const phoneLast10 = (p) => (p || '').replace(/\D/g, '').slice(-10);
  const blockedSet = useMemo(() => new Set(blockedNumbers.map(phoneLast10)), [blockedNumbers]);

  const filteredThreads = threads.filter(t => {
    // PR 4 — status filter (thread-level) stacks on top of smsFilter (message-level).
    if (statusFilter !== 'all') {
      const key = phoneLast10(t.contactPhone);
      const lastReadAt = threadReadAt[key];
      const hasUnseen = t.unanswered && (!lastReadAt || new Date(t.lastTimestamp) > new Date(lastReadAt));
      if (statusFilter === 'unread' && !hasUnseen) return false;
      if (statusFilter === 'unanswered' && !t.unanswered) return false;
      if (statusFilter === 'unknown' && t.customerName) return false;
      if (statusFilter === 'blocked' && !blockedSet.has(key)) return false;
    }
    if (smsFilter === 'all') return true;
    if (smsFilter === 'sent') return t.messages.some(m => m.direction === 'outbound');
    if (smsFilter === 'received') return t.messages.some(m => m.direction === 'inbound');
    if (smsFilter === 'auto_reply') return t.messages.some(m => m.messageType === 'auto_reply' || m.messageType === 'ai_draft');
    if (smsFilter === 'reminder') return t.messages.some(m => m.messageType === 'reminder' || m.messageType === 'confirmation' || m.messageType === 'appointment_confirmation');
    if (smsFilter === 'review_request') return t.messages.some(m => m.messageType === 'review_request');
    if (smsFilter === 'estimate') return t.messages.some(m => m.messageType === 'estimate');
    return true;
  });

  // PR 4 — counts used by the filter chip row (shown next to each chip).
  const chipCounts = useMemo(() => {
    let unread = 0, unanswered = 0, unknown = 0, blocked = 0;
    threads.forEach(t => {
      const key = phoneLast10(t.contactPhone);
      const lastReadAt = threadReadAt[key];
      if (t.unanswered && (!lastReadAt || new Date(t.lastTimestamp) > new Date(lastReadAt))) unread++;
      if (t.unanswered) unanswered++;
      if (!t.customerName) unknown++;
      if (blockedSet.has(key)) blocked++;
    });
    return { all: threads.length, unread, unanswered, unknown, blocked };
  }, [threads, threadReadAt, blockedSet]);

  // PR 4 — Block/unblock actions. Uses last-seen E.164 from the thread.
  const blockNumber = async (number, reason) => {
    try {
      await adminFetch('/admin/communications/blocked-numbers', {
        method: 'POST',
        body: JSON.stringify({ number, blockType: 'hard_block', reason: reason || 'Manual block from inbox' }),
      });
      loadBlocked();
    } catch (e) { alert('Failed to block: ' + e.message); }
  };
  const unblockNumber = async (number) => {
    try {
      await adminFetch(`/admin/communications/blocked-numbers/${encodeURIComponent(number)}`, { method: 'DELETE' });
      loadBlocked();
    } catch (e) { alert('Failed to unblock: ' + e.message); }
  };

  // Handle reply from thread — auto-set From to the number customer texted
  const handleThreadReply = (contactPhone, ourNumber) => {
    setToNumber(contactPhone);
    if (ourNumber) {
      setFromNumber(ourNumber);
      // PR 4 — engage the thread-reply lock so the From select can't drift to
      // a different Waves number mid-compose.
      setThreadLock({ contactPhone, ourNumber, label: NUMBER_LABEL_MAP[ourNumber] || ourNumber });
    }
    setSmsView('threads');
    setActiveThread(null);
    setTimeout(() => {
      const el = document.getElementById('sms-compose');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  // Derived data — use server-provided totals (includes ALL message types)
  const totalSent = stats?.totalSent || stats?.channelStats?.reduce((s, c) => s + (c.sent || 0), 0) || 0;
  const totalReceived = stats?.totalReceived || stats?.locationStats?.reduce((s, l) => s + (l.received || 0), 0) || 0;

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
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 400, color: D.heading, margin: 0 }}>SMS & Calls</h1>
        </div>
      </div>

      {/* --- Tabs --- */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 24, background: '#F4F4F5', borderRadius: 10, padding: 4, border: '1px solid #E4E4E7' }}>
        {[{ key: 'sms', label: 'SMS' }, { key: 'calls', label: 'Calls' }, { key: 'templates', label: 'Templates' }, { key: 'csr', label: 'CSR Coach' }, { key: 'notifications', label: 'Notifications' }].map(t => (
          <button key={t.key} onClick={() => { setCommsTab(t.key); if (t.key === 'sms') { setSmsView('threads'); setActiveThread(null); } }} style={{
            padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: commsTab === t.key ? '#18181B' : 'transparent',
            color: commsTab === t.key ? '#FFFFFF' : '#A1A1AA',
            fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
            fontFamily: "'DM Sans', sans-serif",
          }}>{t.label}</button>
        ))}
      </div>

      {commsTab === 'notifications' ? <PushSettings /> : commsTab === 'csr' ? <CSRCoachTab /> : commsTab === 'calls' ? <CallLogTab /> : commsTab === 'templates' ? (
        <SmsTemplatesTab />
      ) : <>

      {/* --- SMS Stats with health indicators --- */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <StatCardWithHealth label="Sent This Month" value={totalSent} color={D.green} shouldHaveActivity={false} onClick={() => setSmsFilter(f => f === 'sent' ? 'all' : 'sent')} active={smsFilter === 'sent'} />
        <StatCardWithHealth label="Received This Month" value={totalReceived} color={D.teal} shouldHaveActivity={false} onClick={() => setSmsFilter(f => f === 'received' ? 'all' : 'received')} active={smsFilter === 'received'} />
        <StatCardWithHealth label="Auto-Replies" value={channelStats.find(c => c.type === 'auto_reply')?.sent || 0} color="#0ea5e9" shouldHaveActivity={true} onClick={() => setSmsFilter(f => f === 'auto_reply' ? 'all' : 'auto_reply')} active={smsFilter === 'auto_reply'} />
        <StatCardWithHealth label="Reminders" value={channelStats.find(c => c.type === 'reminder')?.sent || channelStats.find(c => c.type === 'confirmation')?.sent || 0} color={D.amber} shouldHaveActivity={true} onClick={() => setSmsFilter(f => f === 'reminder' ? 'all' : 'reminder')} active={smsFilter === 'reminder'} />
        <StatCardWithHealth label="Review Requests" value={channelStats.find(c => c.type === 'review_request')?.sent || 0} color="#8b5cf6" shouldHaveActivity={true} onClick={() => setSmsFilter(f => f === 'review_request' ? 'all' : 'review_request')} active={smsFilter === 'review_request'} />
        <StatCardWithHealth label="Estimates" value={channelStats.find(c => c.type === 'estimate')?.sent || 0} color="#3b82f6" shouldHaveActivity={true} onClick={() => setSmsFilter(f => f === 'estimate' ? 'all' : 'estimate')} active={smsFilter === 'estimate'} />
      </div>

      {/* --- Send SMS --- */}
      <div id="sms-compose" style={{ marginBottom: 28 }}>
        <div style={{
          background: D.card, border: `1px solid ${D.border}`, borderRadius: 12,
          padding: 20,
        }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14, margin: '0 0 14px' }}>SMS</h2>

          {/* PR 4 — thread-reply lock banner */}
          {threadLock && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              background: `${D.teal}12`, border: `1px solid ${D.teal}44`, borderRadius: 8, marginBottom: 10,
            }}>
              <span style={{ fontSize: 11, color: D.teal, fontWeight: 700, letterSpacing: 0.5 }}>🔒 LOCKED</span>
              <span style={{ fontSize: 12, color: D.text, flex: 1 }}>
                Replying from <strong style={{ color: D.heading }}>{threadLock.label}</strong> to continue thread with {threadLock.contactPhone}
              </span>
              <button onClick={() => setThreadLock(null)} style={{
                background: 'none', border: `1px solid ${D.border}`, color: D.muted,
                fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              }}>Override</button>
            </div>
          )}

          <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>From{threadLock && ' (locked to thread)'}</label>
          <select
            value={fromNumber}
            onChange={e => setFromNumber(e.target.value)}
            disabled={!!threadLock}
            style={{
              width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${threadLock ? D.teal : D.border}`, borderRadius: 8,
              color: D.heading, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', marginBottom: 12, boxSizing: 'border-box',
              opacity: threadLock ? 0.75 : 1, cursor: threadLock ? 'not-allowed' : 'pointer',
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
            type="text"
            placeholder="Search by name or enter phone number..."
            value={toSearch || toNumber}
            onChange={async (e) => {
              const val = e.target.value;
              // If it looks like a phone number, set directly
              if (/^[\d\s\(\)\-\+]+$/.test(val)) {
                setToNumber(val);
                setToSearch('');
                setToResults([]);
              } else {
                setToSearch(val);
                setToNumber('');
                if (val.length >= 2) {
                  try {
                    const r = await fetch(`${API_BASE}/admin/customers?search=${encodeURIComponent(val)}&limit=8`, {
                      headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
                    });
                    if (r.ok) {
                      const d = await r.json();
                      setToResults(d.customers || []);
                    }
                  } catch {}
                } else {
                  setToResults([]);
                }
              }
            }}
            style={{
              width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
              color: D.heading, fontSize: 14, fontFamily: 'DM Sans, sans-serif', outline: 'none', marginBottom: toResults.length ? 0 : 12, boxSizing: 'border-box',
            }}
          />
          {toResults.length > 0 && (
            <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: '0 0 8px 8px', maxHeight: 180, overflowY: 'auto', marginBottom: 12 }}>
              {toResults.map(c => (
                <div key={c.id} onClick={() => {
                  setToNumber(c.phone || '');
                  setToSearch(`${c.firstName} ${c.lastName} — ${c.phone || ''}`);
                  setToResults([]);
                }} style={{
                  padding: '8px 12px', cursor: 'pointer', borderBottom: `1px solid ${D.border}`,
                  fontSize: 13, color: D.heading,
                }}>
                  <strong>{c.firstName} {c.lastName}</strong>
                  <span style={{ color: D.muted, marginLeft: 8 }}>{c.phone || 'no phone'}</span>
                </div>
              ))}
            </div>
          )}

          {/* Recent message from customer */}
          {activeThread && (() => {
            const lastInbound = activeThread.messages.find(m => m.direction === 'inbound');
            if (!lastInbound) return null;
            return (
              <div style={{ marginBottom: 12, padding: '10px 12px', background: D.bg, borderRadius: 8, border: `1px solid ${D.border}` }}>
                <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Last message from customer</div>
                <div style={{ fontSize: 13, color: D.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{lastInbound.body}</div>
                <div style={{ fontSize: 10, color: D.muted, marginTop: 4 }}>{formatTimestamp(lastInbound.createdAt)}</div>
              </div>
            );
          })()}

          <label style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>Message</label>
          <textarea
            placeholder="Type your message..."
            value={msgBody}
            onChange={e => setMsgBody(e.target.value)}
            rows={3}
            style={{
              width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
              color: D.heading, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', resize: 'vertical', marginBottom: 4, boxSizing: 'border-box',
            }}
          />
          <div style={{ textAlign: 'right', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: D.muted, marginBottom: 12 }}>
            {msgBody.length} chars
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

          <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleSend}
            disabled={sending || !toNumber.trim() || !msgBody.trim()}
            style={{
              flex: 1, padding: '10px 0', background: sending ? D.muted : D.green, border: 'none', borderRadius: 8,
              color: D.heading, fontSize: 14, fontWeight: 600, cursor: sending ? 'not-allowed' : 'pointer', fontFamily: 'DM Sans, sans-serif',
              opacity: (!toNumber.trim() || !msgBody.trim()) ? 0.5 : 1,
            }}
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
          <button
            onClick={handleAiDraft}
            disabled={aiDrafting || !toNumber.trim()}
            style={{
              padding: '10px 18px', background: 'transparent', border: `1px solid ${D.teal}`, borderRadius: 8,
              color: D.teal, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
              opacity: aiDrafting || !toNumber.trim() ? 0.5 : 1, whiteSpace: 'nowrap',
            }}
          >
            {aiDrafting ? 'Drafting...' : 'AI Draft'}
          </button>
          </div>

          {sendResult && (
            <div style={{ marginTop: 10, fontSize: 12, color: sendResult.ok ? D.green : D.red, fontFamily: 'DM Sans, sans-serif' }}>
              {sendResult.text}
            </div>
          )}
        </div>
      </div>

      {/* --- SMS View Toggle: Threads vs Log --- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 4, background: D.card, borderRadius: 8, padding: 3, border: `1px solid ${D.border}` }}>
          <button onClick={() => { setSmsView('threads'); setActiveThread(null); }} style={{
            padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
            background: smsView === 'threads' || smsView === 'conversation' ? D.teal : 'transparent',
            color: smsView === 'threads' || smsView === 'conversation' ? D.white : D.muted,
          }}>Conversations</button>
          <button onClick={() => { setSmsView('log'); setActiveThread(null); }} style={{
            padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
            background: smsView === 'log' ? D.teal : 'transparent',
            color: smsView === 'log' ? D.white : D.muted,
          }}>Log View</button>
        </div>

      </div>

      {/* --- SMS Search (searches all history) --- */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search all SMS by name, phone, or message text..."
          value={smsSearch}
          onChange={e => setSmsSearch(e.target.value)}
          style={{
            width: '100%', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8,
            color: D.text, fontSize: 14, padding: '10px 14px', fontFamily: 'DM Sans, sans-serif',
            outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* --- Conversation Thread View --- */}
      {smsView === 'conversation' && activeThread ? (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20 }}>
          <ConversationView
            thread={activeThread}
            messages={activeThread.messages.slice().reverse()}
            onReply={handleThreadReply}
            onBack={() => { setSmsView('threads'); setActiveThread(null); }}
          />
        </div>
      ) : smsView === 'threads' ? (
        /* --- Thread List --- */
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>
              Conversations
              <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 8, color: D.muted }}>({filteredThreads.length})</span>
            </h2>
          </div>

          {/* PR 4 — filter chip row */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {[
              { key: 'all', label: 'All', count: chipCounts.all, tone: D.muted },
              { key: 'unread', label: 'Unread', count: chipCounts.unread, tone: D.red },
              { key: 'unanswered', label: 'Unanswered', count: chipCounts.unanswered, tone: D.amber },
              { key: 'unknown', label: 'Unknown', count: chipCounts.unknown, tone: D.purple },
              { key: 'blocked', label: 'Blocked', count: chipCounts.blocked, tone: D.muted },
            ].map(chip => {
              const active = statusFilter === chip.key;
              return (
                <button key={chip.key} onClick={() => setStatusFilter(chip.key)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 16, cursor: 'pointer',
                  fontSize: 12, fontWeight: 600, fontFamily: 'DM Sans, sans-serif',
                  background: active ? chip.tone : 'transparent',
                  color: active ? D.white : chip.tone,
                  border: `1px solid ${active ? chip.tone : chip.tone + '44'}`,
                  transition: 'all 0.15s',
                }}>
                  {chip.label}
                  <span style={{
                    fontSize: 10, fontFamily: "'JetBrains Mono', monospace", padding: '1px 6px', borderRadius: 8,
                    background: active ? `${D.white}22` : `${chip.tone}22`,
                  }}>{chip.count}</span>
                </button>
              );
            })}
          </div>

          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {filteredThreads.length === 0 ? (
              <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>
                No conversations found.
              </div>
            ) : (
              filteredThreads.map((t, i) => {
                const preview = t.lastMessage ? (t.lastMessage.length > 60 ? t.lastMessage.slice(0, 60) + '...' : t.lastMessage) : '';
                const threadKey = t.contactPhone?.replace(/\D/g, '').slice(-10);
                const lastReadAt = threadReadAt[threadKey];
                const hasUnseenInbound = t.unanswered && (!lastReadAt || new Date(t.lastTimestamp) > new Date(lastReadAt));
                const showDot = hasUnseenInbound;
                const isUnknown = !t.customerName;
                const isBlocked = blockedSet.has(threadKey);
                return (
                  <div
                    key={i}
                    onClick={() => {
                      setActiveThread(t);
                      setSmsView('conversation');
                      setToNumber(t.contactPhone);
                      if (t.ourNumber) {
                        setFromNumber(t.ourNumber);
                        setThreadLock({ contactPhone: t.contactPhone, ourNumber: t.ourNumber, label: NUMBER_LABEL_MAP[t.ourNumber] || t.ourNumber });
                      }
                      setThreadReadAt(prev => {
                        const next = { ...prev, [threadKey]: t.lastTimestamp };
                        try { localStorage.setItem('waves_sms_thread_read_at', JSON.stringify(next)); } catch {}
                        return next;
                      });
                    }}
                    style={{
                      padding: '12px 14px', borderBottom: `1px solid ${D.border}`, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 12,
                      background: showDot ? D.red + '08' : 'transparent',
                      borderLeft: showDot ? `3px solid ${D.red}` : '3px solid transparent',
                      transition: 'background 0.15s',
                      opacity: isBlocked ? 0.55 : 1,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = D.bg}
                    onMouseLeave={e => e.currentTarget.style.background = showDot ? D.red + '08' : 'transparent'}
                  >
                    {/* Unread dot */}
                    <div style={{ width: 10, flexShrink: 0 }}>
                      {showDot && (
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: D.red, display: 'block' }} />
                      )}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: D.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.customerName || t.contactPhone}
                          </span>
                          {isUnknown && (
                            <span style={{
                              fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                              padding: '2px 6px', borderRadius: 4, background: `${D.purple}22`, color: D.purple,
                              flexShrink: 0,
                            }}>UNKNOWN</span>
                          )}
                          {isBlocked && (
                            <span style={{
                              fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                              padding: '2px 6px', borderRadius: 4, background: `${D.muted}22`, color: D.muted,
                              flexShrink: 0,
                            }}>BLOCKED</span>
                          )}
                        </div>
                        <span style={{ fontSize: 10, color: D.muted, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, marginLeft: 8 }}>
                          {timeAgo(t.lastTimestamp)}
                        </span>
                      </div>
                      {t.customerName && (
                        <div style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace", marginBottom: 2 }}>{t.contactPhone}</div>
                      )}
                      <div style={{ fontSize: 12, color: D.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ color: t.lastDirection === 'inbound' ? D.teal : D.green, marginRight: 4 }}>
                          {t.lastDirection === 'inbound' ? '↓' : '↑'}
                        </span>
                        {preview}
                      </div>
                    </div>

                    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>
                        {t.messages.length} msg{t.messages.length !== 1 ? 's' : ''}
                      </span>
                      {/* PR 4 — Block / Unblock action */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isBlocked) {
                            if (!confirm(`Unblock ${t.contactPhone}?`)) return;
                            unblockNumber(t.contactPhone);
                          } else {
                            if (!confirm(`Block ${t.contactPhone}? Future inbound calls will be rejected.`)) return;
                            blockNumber(t.contactPhone, `Blocked from SMS inbox${t.customerName ? ` (${t.customerName})` : ''}`);
                          }
                        }}
                        style={{
                          background: 'none', border: `1px solid ${D.border}`,
                          color: isBlocked ? D.teal : D.muted,
                          fontSize: 10, fontWeight: 600, padding: '4px 8px', borderRadius: 6,
                          cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
                        }}
                        title={isBlocked ? 'Unblock this number' : 'Block this number'}
                      >{isBlocked ? 'Unblock' : 'Block'}</button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        /* --- Classic SMS Log --- */
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

          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No messages found.</div>
            ) : (
              filtered.map(m => (
                <SmsLogItem key={m.id} msg={m} onReply={(phone, from) => { setToNumber(phone); setFromNumber(from); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
              ))
            )}
          </div>
        </div>
      )}

      </>}
    </div>
  );
}
