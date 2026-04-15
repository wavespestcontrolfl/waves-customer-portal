import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', text: '#334155', muted: '#64748B', white: '#FFFFFF', input: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };

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
  return `${Math.floor(hrs / 24)}d ago`;
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600 });
const sInput = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

export default function EmailAutomationsPanel() {
  const [tab, setTab] = useState('send');
  const [automations, setAutomations] = useState([]);
  const [log, setLog] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [beehiivConfigured, setBeehiivConfigured] = useState(false);
  const [toast, setToast] = useState('');

  const loadData = useCallback(async () => {
    const [autoData, statsData, logData] = await Promise.all([
      adminFetch('/admin/email-automations/automations').catch(() => ({ automations: [] })),
      adminFetch('/admin/email-automations/stats').catch(() => null),
      adminFetch('/admin/email-automations/log?limit=50').catch(() => ({ log: [] })),
    ]);
    setAutomations(autoData.automations || []);
    setBeehiivConfigured(autoData.beehiivConfigured);
    setStats(statsData);
    setLog(logData.log || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading email automations...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: D.heading }}>Email Automations</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>
            Beehiiv + SMS — manual triggers
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
            { label: 'Total Sent', value: stats.total, color: D.heading },
            { label: 'Last 24h', value: stats.last24h, color: D.teal },
            { label: 'Last 7d', value: stats.last7d, color: D.teal },
            { label: 'Success', value: stats.success, color: D.green },
            { label: 'Customers Reached', value: stats.uniqueCustomers, color: D.purple },
          ].map(s => (
            <div key={s.label} style={{ ...sCard, flex: '1 1 120px', minWidth: 120, marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}` }}>
        {[{ key: 'send', label: 'Send to Customer' }, { key: 'automations', label: 'Automations' }, { key: 'log', label: 'Activity Log' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'send' && <SendTab automations={automations} showToast={showToast} onSent={loadData} />}
      {tab === 'automations' && <AutomationsTab automations={automations} showToast={showToast} onUpdate={loadData} />}
      {tab === 'log' && <LogTab log={log} onRefresh={loadData} />}

      <div style={{ position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none' }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ── Send Tab: search customer → pick automation → send ──
function SendTab({ automations, showToast, onSent }) {
  const [search, setSearch] = useState('');
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [selectedAuto, setSelectedAuto] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);

  const doSearch = async (q) => {
    setSearch(q);
    if (q.length < 2) { setCustomers([]); return; }
    setSearching(true);
    try {
      const d = await adminFetch(`/admin/customers?search=${encodeURIComponent(q)}&limit=10`);
      setCustomers(d.customers || []);
    } catch { setCustomers([]); }
    setSearching(false);
  };

  const handleSend = async () => {
    if (!selectedCustomer || !selectedAuto) { showToast('Select a customer and automation'); return; }
    setSending(true);
    setResult(null);
    try {
      const r = await adminFetch('/admin/email-automations/trigger', {
        method: 'POST',
        body: JSON.stringify({ automationKey: selectedAuto, customerId: selectedCustomer.id }),
      });
      setResult(r);
      if (r.success) showToast(`Sent "${automations.find(a => a.key === selectedAuto)?.name}" to ${selectedCustomer.firstName}`);
      else showToast(r.error || 'Failed');
      onSent();
    } catch (e) { showToast(`Failed: ${e.message}`); setResult({ error: e.message }); }
    setSending(false);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      {/* Left: Customer search + selection */}
      <div>
        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>1. Select Customer</div>
          <input
            value={search} onChange={e => doSearch(e.target.value)}
            placeholder="Search by name, phone, or email..."
            style={sInput}
          />
          {searching && <div style={{ color: D.muted, fontSize: 12, marginTop: 8 }}>Searching...</div>}
          <div style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
            {customers.map(c => (
              <div key={c.id} onClick={() => { setSelectedCustomer(c); setCustomers([]); setSearch(`${c.firstName} ${c.lastName}`); }}
                style={{
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
                  background: selectedCustomer?.id === c.id ? `${D.teal}15` : D.input,
                  border: `1px solid ${selectedCustomer?.id === c.id ? D.teal : 'transparent'}`,
                }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{c.firstName} {c.lastName}</div>
                <div style={{ fontSize: 11, color: D.muted }}>
                  {c.phone && <span>{c.phone} </span>}
                  {c.email && <span>· {c.email} </span>}
                  {c.pipelineStage && <span style={sBadge(`${D.teal}22`, D.teal)}>{c.pipelineStage}</span>}
                </div>
              </div>
            ))}
          </div>

          {selectedCustomer && (
            <div style={{ marginTop: 12, padding: 12, background: `${D.teal}08`, borderRadius: 8, border: `1px solid ${D.teal}33` }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.teal }}>Selected: {selectedCustomer.firstName} {selectedCustomer.lastName}</div>
              <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                {selectedCustomer.email || 'No email'} · {selectedCustomer.phone || 'No phone'}
              </div>
              {!selectedCustomer.email && <div style={{ fontSize: 12, color: D.amber, marginTop: 4 }}>⚠ No email — Beehiiv will be skipped</div>}
            </div>
          )}
        </div>
      </div>

      {/* Right: Pick automation + send */}
      <div>
        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>2. Pick Automation & Send</div>

          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            {automations.filter(a => a.enabled).map(a => (
              <div key={a.key} onClick={() => setSelectedAuto(a.key)} style={{
                padding: '12px 14px', borderRadius: 8, cursor: 'pointer',
                background: selectedAuto === a.key ? `${D.teal}15` : D.input,
                border: `1px solid ${selectedAuto === a.key ? D.teal : D.border}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: selectedAuto === a.key ? D.teal : D.white }}>{a.name}</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {a.smsTemplate && <span style={sBadge(`${D.green}22`, D.green)}>+ SMS</span>}
                    {a.tags?.map(t => <span key={t} style={sBadge(`${D.purple}22`, D.purple)}>{t}</span>)}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{a.description}</div>
              </div>
            ))}
          </div>

          <button onClick={handleSend} disabled={sending || !selectedCustomer || !selectedAuto} style={{
            ...sBtn(D.green, D.white), width: '100%', padding: '14px 20px', fontSize: 15,
            opacity: sending || !selectedCustomer || !selectedAuto ? 0.5 : 1,
          }}>
            {sending ? 'Sending...' : `Send ${automations.find(a => a.key === selectedAuto)?.name || 'Automation'}`}
          </button>

          {result && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: result.success ? `${D.green}11` : `${D.red}11`, border: `1px solid ${result.success ? D.green : D.red}33` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: result.success ? D.green : D.red }}>
                {result.success ? '✓ Sent successfully' : `✗ ${result.error || 'Failed'}`}
              </div>
              {result.beehiiv && !result.beehiiv.error && (
                <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>Beehiiv: subscribed + tagged [{result.beehiiv.tags?.join(', ')}]</div>
              )}
              {result.beehiiv?.skipped && <div style={{ fontSize: 12, color: D.amber, marginTop: 4 }}>Beehiiv: {result.beehiiv.skipped}</div>}
              {result.sms?.sent && <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>SMS: sent to {result.sms.to}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Automations Tab ──
function AutomationsTab({ automations, showToast, onUpdate }) {
  const toggleAuto = async (key, enabled) => {
    try {
      await adminFetch(`/admin/email-automations/automations/${key}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      showToast(`${key} ${enabled ? 'enabled' : 'disabled'}`);
      onUpdate();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {automations.map(a => (
        <div key={a.key} style={{ ...sCard, marginBottom: 0, display: 'flex', alignItems: 'flex-start', gap: 16, opacity: a.enabled ? 1 : 0.5 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{a.name}</div>
              <label style={{ position: 'relative', display: 'inline-block', width: 40, height: 22, cursor: 'pointer' }}>
                <input type="checkbox" checked={a.enabled} onChange={e => toggleAuto(a.key, e.target.checked)} style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }} />
                <span style={{ position: 'absolute', inset: 0, background: a.enabled ? D.green : D.border, borderRadius: 22, transition: '.2s' }} />
                <span style={{ position: 'absolute', left: a.enabled ? 20 : 2, top: 2, width: 18, height: 18, background: 'white', borderRadius: '50%', transition: '.2s' }} />
              </label>
            </div>
            <div style={{ fontSize: 13, color: D.muted, marginBottom: 8 }}>{a.description}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={sBadge(`${D.teal}22`, D.teal)}>Manual trigger</span>
              {a.tags?.map(t => <span key={t} style={sBadge(`${D.purple}22`, D.purple)}>tag: {t}</span>)}
              {a.smsTemplate && <span style={sBadge(`${D.green}22`, D.green)}>+ SMS</span>}
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: D.muted }}>
              <span>Total: <strong style={{ color: D.heading }}>{a.totalRuns}</strong></span>
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
        <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>Recent Sends</div>
        <button onClick={onRefresh} style={sBtn(D.teal, D.white)}>Refresh</button>
      </div>
      {log.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No automations sent yet</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            {['Customer', 'Automation', 'Status', 'Beehiiv', 'SMS', 'Time'].map(h => (
              <th key={h} style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {log.map(l => {
              const bh = l.beehiiv_result ? (typeof l.beehiiv_result === 'string' ? JSON.parse(l.beehiiv_result) : l.beehiiv_result) : null;
              const sms = l.sms_result ? (typeof l.sms_result === 'string' ? JSON.parse(l.sms_result) : l.sms_result) : null;
              return (
                <tr key={l.id}>
                  <td style={{ padding: 10, fontSize: 13 }}>
                    <div style={{ fontWeight: 600, color: D.heading }}>{l.first_name} {l.last_name}</div>
                    <div style={{ fontSize: 11, color: D.muted }}>{l.customer_email}</div>
                  </td>
                  <td style={{ padding: 10, fontSize: 13, color: D.teal }}>{l.automation_name || l.automation_key}</td>
                  <td style={{ padding: 10 }}><span style={sBadge(`${statusColor[l.status]}22`, statusColor[l.status])}>{l.status}</span></td>
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
