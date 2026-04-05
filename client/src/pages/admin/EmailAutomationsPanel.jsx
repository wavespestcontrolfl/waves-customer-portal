import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function timeAgo(d) {
  if (!d) return '';
  const mins = Math.floor((Date.now() - new Date(d)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });

const TRIGGER_LABELS = {
  stage_change: 'Stage Change',
  service_type: 'Service Booked',
  review_received: 'Review Received',
};

export default function EmailAutomationsPanel() {
  const [tab, setTab] = useState('automations');
  const [automations, setAutomations] = useState([]);
  const [log, setLog] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [beehiivConfigured, setBeehiivConfigured] = useState(false);
  const [toast, setToast] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [autoData, statsData, logData] = await Promise.all([
        adminFetch('/admin/email-automations/automations'),
        adminFetch('/admin/email-automations/stats'),
        adminFetch('/admin/email-automations/log?limit=50'),
      ]);
      setAutomations(autoData.automations || []);
      setBeehiivConfigured(autoData.beehiivConfigured);
      setStats(statsData);
      setLog(logData.log || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  const toggleAutomation = async (key, enabled) => {
    try {
      await adminFetch(`/admin/email-automations/automations/${key}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      setAutomations(prev => prev.map(a => a.key === key ? { ...a, enabled } : a));
      showToast(`${key} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading email automations...</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: D.white }}>Email Automations</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>
            Beehiiv newsletters + SMS onboarding — replaces Zapier
            {beehiivConfigured
              ? <span style={{ ...sBadge(`${D.green}22`, D.green), marginLeft: 8 }}>Beehiiv Connected</span>
              : <span style={{ ...sBadge(`${D.amber}22`, D.amber), marginLeft: 8 }}>Beehiiv Not Configured</span>
            }
          </div>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Total Runs', value: stats.total, color: D.white },
            { label: 'Last 24h', value: stats.last24h, color: D.teal },
            { label: 'Last 7d', value: stats.last7d, color: D.teal },
            { label: 'Success', value: stats.success, color: D.green },
            { label: 'Partial', value: stats.partial, color: D.amber },
            { label: 'Failed', value: stats.failed, color: D.red },
            { label: 'Unique Customers', value: stats.uniqueCustomers, color: D.purple },
          ].map(s => (
            <div key={s.label} style={{ ...sCard, flex: '1 1 120px', minWidth: 120, marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 24, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}` }}>
        {[
          { key: 'automations', label: 'Automations' },
          { key: 'log', label: 'Activity Log' },
          { key: 'beehiiv', label: 'Beehiiv' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
            transition: 'all 0.15s',
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'automations' && <AutomationsTab automations={automations} onToggle={toggleAutomation} />}
      {tab === 'log' && <LogTab log={log} onRefresh={loadData} />}
      {tab === 'beehiiv' && <BeehiivTab configured={beehiivConfigured} />}

      {/* Toast */}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ── Automations Tab ──
function AutomationsTab({ automations, onToggle }) {
  const triggerIcon = { stage_change: '🔄', service_type: '🛠', review_received: '⭐' };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {automations.map(a => (
        <div key={a.key} style={{ ...sCard, marginBottom: 0, display: 'flex', alignItems: 'flex-start', gap: 16, opacity: a.enabled ? 1 : 0.5 }}>
          <div style={{ fontSize: 28, flexShrink: 0, marginTop: 4 }}>{triggerIcon[a.trigger] || '📧'}</div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>{a.name}</div>
              <label style={{ position: 'relative', display: 'inline-block', width: 40, height: 22, cursor: 'pointer' }}>
                <input type="checkbox" checked={a.enabled} onChange={e => onToggle(a.key, e.target.checked)} style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }} />
                <span style={{ position: 'absolute', inset: 0, background: a.enabled ? D.green : D.border, borderRadius: 22, transition: '.2s' }} />
                <span style={{ position: 'absolute', left: a.enabled ? 20 : 2, top: 2, width: 18, height: 18, background: 'white', borderRadius: '50%', transition: '.2s' }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={sBadge(`${D.teal}22`, D.teal)}>{TRIGGER_LABELS[a.trigger] || a.trigger}: {a.triggerValue || 'any'}</span>
              {a.tags?.map(t => <span key={t} style={sBadge(`${D.purple}22`, D.purple)}>tag: {t}</span>)}
              {a.smsTemplate && <span style={sBadge(`${D.green}22`, D.green)}>+ SMS</span>}
              {a.beehiivAutomationId && <span style={sBadge(`${D.amber}22`, D.amber)}>Beehiiv: {a.beehiivAutomationId.slice(0, 12)}...</span>}
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: D.muted }}>
              <span>Total: <strong style={{ color: D.white }}>{a.totalRuns}</strong></span>
              <span>Success: <strong style={{ color: D.green }}>{a.successCount}</strong></span>
              <span>Last 7d: <strong style={{ color: D.teal }}>{a.last7Days}</strong></span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Activity Log Tab ──
function LogTab({ log, onRefresh }) {
  const statusColor = { success: D.green, partial: D.amber, failed: D.red };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>Recent Automation Runs</div>
        <button onClick={onRefresh} style={sBtn(D.teal, D.white)}>Refresh</button>
      </div>
      {log.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No automation runs yet</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Customer', 'Automation', 'Trigger', 'Status', 'Beehiiv', 'SMS', 'Time'].map(h => (
                <th key={h} style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {log.map(l => {
              const bh = l.beehiiv_result ? (typeof l.beehiiv_result === 'string' ? JSON.parse(l.beehiiv_result) : l.beehiiv_result) : null;
              const sms = l.sms_result ? (typeof l.sms_result === 'string' ? JSON.parse(l.sms_result) : l.sms_result) : null;
              return (
                <tr key={l.id} style={{ borderBottom: `1px solid ${D.border}22` }}>
                  <td style={{ padding: 10, fontSize: 13 }}>
                    <div style={{ fontWeight: 600, color: D.white }}>{l.first_name} {l.last_name}</div>
                    <div style={{ fontSize: 11, color: D.muted }}>{l.customer_email}</div>
                  </td>
                  <td style={{ padding: 10, fontSize: 13, color: D.teal }}>{l.automation_name || l.automation_key}</td>
                  <td style={{ padding: 10 }}>
                    <span style={sBadge(`${D.purple}22`, D.purple)}>{l.trigger_type}: {l.trigger_value}</span>
                  </td>
                  <td style={{ padding: 10 }}>
                    <span style={sBadge(`${statusColor[l.status]}22`, statusColor[l.status])}>{l.status}</span>
                  </td>
                  <td style={{ padding: 10, fontSize: 11, color: D.muted }}>
                    {bh?.subscriberId ? '✓ Enrolled' : bh?.skipped ? 'Skipped' : bh?.error ? '✗ Error' : '—'}
                  </td>
                  <td style={{ padding: 10, fontSize: 11, color: D.muted }}>
                    {sms?.sent ? `✓ ${sms.to}` : sms?.error ? '✗ Error' : '—'}
                  </td>
                  <td style={{ padding: 10, fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>{timeAgo(l.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Beehiiv Tab ──
function BeehiivTab({ configured }) {
  const [automations, setAutomations] = useState([]);
  const [subscribers, setSubscribers] = useState({ subscribers: [], total: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      adminFetch('/admin/email-automations/beehiiv/automations').catch(() => ({ automations: [] })),
      adminFetch('/admin/email-automations/beehiiv/subscribers?limit=20').catch(() => ({ subscribers: [], total: 0 })),
    ]).then(([autoData, subData]) => {
      setAutomations(autoData.automations || []);
      setSubscribers(subData);
      setLoading(false);
    });
  }, []);

  if (!configured) {
    return (
      <div style={{ ...sCard, textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📧</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 8 }}>Beehiiv Not Connected</div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 16, maxWidth: 400, margin: '0 auto' }}>
          Set the <code style={{ background: D.bg, padding: '2px 6px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace" }}>BEEHIIV_API_KEY</code> environment
          variable in Railway to connect your Beehiiv publication.
        </div>
        <div style={{ fontSize: 12, color: D.muted }}>
          Publication ID: <code style={{ fontFamily: "'JetBrains Mono', monospace", color: D.teal }}>pub_dac693f8-2507-4213-9987-e9d6a2a90374</code>
        </div>
      </div>
    );
  }

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading Beehiiv data...</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* Automations */}
      <div style={sCard}>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>Beehiiv Automations ({automations.length})</div>
        {automations.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13 }}>No automations found</div>
        ) : automations.map((a, i) => (
          <div key={i} style={{ padding: '10px 0', borderBottom: `1px solid ${D.border}33`, fontSize: 13 }}>
            <div style={{ fontWeight: 600, color: D.white }}>{a.name || a.id}</div>
            <div style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>{a.id}</div>
            {a.status && <span style={sBadge(a.status === 'active' ? `${D.green}22` : `${D.muted}22`, a.status === 'active' ? D.green : D.muted)}>{a.status}</span>}
          </div>
        ))}
      </div>

      {/* Recent Subscribers */}
      <div style={sCard}>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 4 }}>Subscribers</div>
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>Total: {subscribers.total}</div>
        {(subscribers.subscribers || []).map((s, i) => (
          <div key={i} style={{ padding: '8px 0', borderBottom: `1px solid ${D.border}33`, fontSize: 12 }}>
            <div style={{ color: D.white }}>{s.email}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <span style={sBadge(`${D.green}22`, D.green)}>{s.status || 'active'}</span>
              {(s.tags || []).map(t => <span key={t} style={sBadge(`${D.purple}22`, D.purple)}>{t}</span>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
