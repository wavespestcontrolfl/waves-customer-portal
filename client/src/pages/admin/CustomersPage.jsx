import { useState, useEffect } from 'react';

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
  const months = Math.floor(days / 30);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}

// --- Pipeline stage config ---
const STAGES = [
  { key: 'new_lead', label: 'New Lead', color: D.teal, bg: `${D.teal}22` },
  { key: 'contacted', label: 'Contacted', color: D.teal, bg: D.teal, textColor: D.white },
  { key: 'estimate_sent', label: 'Est. Sent', color: D.amber, bg: `${D.amber}22` },
  { key: 'estimate_viewed', label: 'Est. Viewed', color: D.amber, bg: D.amber, textColor: '#000' },
  { key: 'follow_up', label: 'Follow Up', color: '#a855f7', bg: `${'#a855f7'}22` },
  { key: 'won', label: 'Won', color: D.green, bg: `${D.green}22` },
  { key: 'active_customer', label: 'Active', color: D.green, bg: D.green, textColor: D.white },
  { key: 'at_risk', label: 'At Risk', color: D.red, bg: `${D.red}22`, pulse: true },
  { key: 'churned', label: 'Churned', color: D.red, bg: `${D.red}33` },
  { key: 'lost', label: 'Lost', color: D.muted, bg: `${D.muted}22` },
];

const STAGE_MAP = {};
STAGES.forEach(s => { STAGE_MAP[s.key] = s; });

const TIER_COLORS = { Gold: D.amber, Silver: '#94a3b8', Bronze: '#cd7f32', Platinum: '#a855f7' };

const LEAD_SOURCES = ['referral', 'google', 'facebook', 'nextdoor', 'website', 'door_knock', 'yelp', 'other'];

// --- Reusable components ---
function StageBadge({ stage }) {
  const s = STAGE_MAP[stage] || { label: stage, color: D.muted, bg: `${D.muted}22` };
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.textColor || s.color, letterSpacing: 0.3, whiteSpace: 'nowrap',
      animation: s.pulse ? 'pulse-badge 2s ease infinite' : undefined,
    }}>
      {s.label}
    </span>
  );
}

function TierBadge({ tier }) {
  if (!tier) return null;
  const color = TIER_COLORS[tier] || D.muted;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 9999, fontSize: 10, fontWeight: 700,
      border: `1px solid ${color}`, color, letterSpacing: 0.5, textTransform: 'uppercase',
    }}>
      {tier}
    </span>
  );
}

function ScoreDot({ score }) {
  if (score == null) return null;
  const color = score > 70 ? D.green : score >= 40 ? D.amber : D.red;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color, fontWeight: 600 }}>{score}</span>
    </span>
  );
}

function TagChip({ tag, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 9999,
      fontSize: 10, fontWeight: 600, background: `${D.teal}22`, color: D.teal, letterSpacing: 0.3,
    }}>
      {tag}
      {onRemove && (
        <span onClick={e => { e.stopPropagation(); onRemove(); }} style={{ cursor: 'pointer', marginLeft: 2, fontSize: 12 }}>x</span>
      )}
    </span>
  );
}

function Select({ value, onChange, options, style: extraStyle }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{
      padding: '8px 12px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8,
      color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', cursor: 'pointer',
      ...extraStyle,
    }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// --- Quick Add Modal ---
function QuickAddModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', phone: '', email: '', address: '',
    leadSource: 'referral', pipelineStage: 'new_lead', tags: '', notes: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) return;
    setSubmitting(true);
    try {
      const body = {
        ...form,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      };
      await adminFetch('/admin/customers', { method: 'POST', body: JSON.stringify(body) });
      onCreated();
      onClose();
    } catch (err) {
      alert('Failed to create customer: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '10px 12px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8,
    color: D.text, fontSize: 14, fontFamily: 'DM Sans, sans-serif', outline: 'none', boxSizing: 'border-box',
  };

  const labelStyle = { display: 'block', fontSize: 12, color: D.muted, marginBottom: 4, fontFamily: 'DM Sans, sans-serif' };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: D.card, border: `1px solid ${D.border}`, borderRadius: 14, padding: 28,
        width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: D.white, fontFamily: 'DM Sans, sans-serif', marginBottom: 20 }}>
          Add Customer
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>First Name *</label>
              <input value={form.firstName} onChange={e => set('firstName', e.target.value)} style={inputStyle} required />
            </div>
            <div>
              <label style={labelStyle}>Last Name *</label>
              <input value={form.lastName} onChange={e => set('lastName', e.target.value)} style={inputStyle} required />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Phone</label>
              <input value={form.phone} onChange={e => set('phone', e.target.value)} style={inputStyle} placeholder="+1..." />
            </div>
            <div>
              <label style={labelStyle}>Email</label>
              <input value={form.email} onChange={e => set('email', e.target.value)} style={inputStyle} type="email" />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Address</label>
            <input value={form.address} onChange={e => set('address', e.target.value)} style={inputStyle} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Lead Source</label>
              <select value={form.leadSource} onChange={e => set('leadSource', e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                {LEAD_SOURCES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Pipeline Stage</label>
              <select value={form.pipelineStage} onChange={e => set('pipelineStage', e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Tags (comma-separated)</label>
            <input value={form.tags} onChange={e => set('tags', e.target.value)} style={inputStyle} placeholder="VIP, referral_machine" />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Notes</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={{
              padding: '10px 20px', background: 'transparent', border: `1px solid ${D.border}`, color: D.muted,
              borderRadius: 8, fontSize: 14, fontFamily: 'DM Sans, sans-serif', cursor: 'pointer',
            }}>Cancel</button>
            <button type="submit" disabled={submitting} style={{
              padding: '10px 24px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
              fontSize: 14, fontFamily: 'DM Sans, sans-serif', fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.6 : 1,
            }}>{submitting ? 'Creating...' : 'Create Customer'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Pipeline kanban card ---
function PipelineCard({ customer }) {
  const daysInStage = customer.stageEnteredAt
    ? Math.floor((Date.now() - new Date(customer.stageEnteredAt)) / 86400000)
    : null;
  const addressLine = customer.address ? customer.address.split(',')[0] : '';

  return (
    <div style={{
      background: D.bg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 14, marginBottom: 8,
      cursor: 'pointer',
    }} onClick={() => console.log('Navigate to /admin/customers/' + customer.id)}>
      <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>
        {customer.firstName} {customer.lastName}
      </div>
      {addressLine && (
        <div style={{ fontSize: 12, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginBottom: 8 }}>{addressLine}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <ScoreDot score={customer.leadScore} />
        <TierBadge tier={customer.tier} />
        {customer.monthlyRate > 0 && (
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.green }}>
            ${customer.monthlyRate}/mo
          </span>
        )}
      </div>
      {daysInStage != null && (
        <div style={{ fontSize: 11, color: D.muted, fontFamily: 'DM Sans, sans-serif', marginTop: 6 }}>
          {daysInStage === 0 ? 'Today' : `${daysInStage}d in stage`}
        </div>
      )}
    </div>
  );
}

// --- Pipeline column ---
function PipelineColumn({ stage, customers }) {
  const monthlyTotal = customers.reduce((sum, c) => sum + (c.monthlyRate || 0), 0);
  return (
    <div style={{
      flex: '0 0 260px', minWidth: 260, background: D.card, border: `1px solid ${D.border}`,
      borderRadius: 12, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 220px)',
    }}>
      <div style={{
        padding: '14px 16px', borderBottom: `1px solid ${D.border}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.white, fontFamily: 'DM Sans, sans-serif' }}>{stage.label}</div>
          <div style={{ fontSize: 11, color: D.muted, fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>
            {customers.length} {customers.length === 1 ? 'customer' : 'customers'}
          </div>
        </div>
        {monthlyTotal > 0 && (
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.green, fontWeight: 600 }}>
            ${monthlyTotal.toLocaleString()}/mo
          </span>
        )}
      </div>
      <div style={{ padding: 10, overflowY: 'auto', flex: 1 }}>
        {customers.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 12, fontFamily: 'DM Sans, sans-serif', textAlign: 'center', padding: 20 }}>
            No customers
          </div>
        ) : (
          customers.map(c => <PipelineCard key={c.id} customer={c} />)
        )}
      </div>
    </div>
  );
}

// --- Sortable header cell ---
function SortHeader({ label, sortKey, currentSort, currentDir, onSort, style: extraStyle }) {
  const active = currentSort === sortKey;
  return (
    <div
      onClick={() => onSort(sortKey)}
      style={{
        cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4,
        fontSize: 11, fontWeight: 600, color: active ? D.teal : D.muted, textTransform: 'uppercase',
        letterSpacing: 0.8, fontFamily: 'DM Sans, sans-serif', ...extraStyle,
      }}
    >
      {label}
      {active && <span style={{ fontSize: 10 }}>{currentDir === 'asc' ? ' ^' : ' v'}</span>}
    </div>
  );
}

// =============================================================================
// CUSTOMER INTELLIGENCE TAB
// =============================================================================
function CustomerIntelligenceTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    adminFetch('/admin/customers/intelligence').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleScan = async () => {
    setScanning(true);
    await adminFetch('/admin/customers/intelligence/scan', { method: 'POST', body: '{}' });
    const d = await adminFetch('/admin/customers/intelligence');
    setData(d);
    setScanning(false);
  };

  const handleApprove = async (outreachId) => {
    await adminFetch(`/admin/customers/intelligence/retention/${outreachId}/approve`, { method: 'PUT', body: JSON.stringify({ approvedBy: 'admin' }) });
    const d = await adminFetch('/admin/customers/intelligence');
    setData(d);
  };

  const handleUpsellStatus = async (upsellId, status) => {
    await adminFetch(`/admin/customers/intelligence/upsells/${upsellId}`, { method: 'PUT', body: JSON.stringify({ status }) });
    const d = await adminFetch('/admin/customers/intelligence');
    setData(d);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading customer intelligence...</div>;
  if (!data) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Unable to load intelligence data</div>;

  const dist = data.distribution || {};
  const total = data.totalCustomers || 0;
  const MONO = "'JetBrains Mono', monospace";
  const riskColor = { healthy: D.green, watch: D.amber, at_risk: '#f97316', critical: D.red };
  const riskEmoji = { healthy: '🟢', watch: '🟡', at_risk: '🟠', critical: '🔴' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, color: D.muted }}>{total} active customers scanned</div>
        <button onClick={handleScan} disabled={scanning} style={{
          padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.teal}`, background: 'transparent',
          color: D.teal, fontSize: 12, cursor: 'pointer', opacity: scanning ? 0.5 : 1,
        }}>{scanning ? 'Scanning...' : 'Run Scan Now'}</button>
      </div>

      {/* Health Distribution */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Customer Health Overview</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          {['healthy', 'watch', 'at_risk', 'critical'].map(level => (
            <div key={level} style={{ padding: 14, background: D.bg, borderRadius: 10, textAlign: 'center', borderTop: `3px solid ${riskColor[level]}` }}>
              <div style={{ fontSize: 11, color: D.muted, textTransform: 'capitalize', marginBottom: 4 }}>{riskEmoji[level]} {level.replace('_', ' ')}</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: riskColor[level], fontFamily: MONO }}>{dist[level] || 0}</div>
              <div style={{ fontSize: 11, color: D.muted }}>{total > 0 ? Math.round((dist[level] || 0) / total * 100) : 0}%</div>
            </div>
          ))}
        </div>
        {data.mrrAtRisk > 0 && (
          <div style={{ padding: '10px 14px', background: D.bg, borderRadius: 8, borderLeft: `3px solid ${D.red}`, fontSize: 13 }}>
            <span style={{ color: D.red, fontWeight: 600 }}>MRR at risk: ${data.mrrAtRisk?.toLocaleString()}/mo</span>
            <span style={{ color: D.muted, marginLeft: 8 }}>(${(data.mrrAtRisk * 12).toLocaleString()}/yr)</span>
          </div>
        )}
      </div>

      {/* Critical + At Risk Customers */}
      {(data.atRiskCustomers || []).length > 0 && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.red, marginBottom: 16 }}>Action Required ({data.atRiskCustomers.length} customers)</div>
          {data.atRiskCustomers.slice(0, 10).map(c => {
            const factors = c.risk_factors || [];
            return (
              <div key={c.id} style={{ padding: '14px 16px', background: D.bg, borderRadius: 10, marginBottom: 10, borderLeft: `3px solid ${riskColor[c.churn_risk_level]}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{c.first_name} {c.last_name}</span>
                    <span style={{ fontSize: 12, color: D.muted, marginLeft: 8 }}>{c.waveguard_tier} ${parseFloat(c.monthly_rate || 0).toFixed(0)}/mo</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11, color: riskColor[c.churn_risk_level], fontWeight: 700 }}>{c.health_score}/100</span>
                    <span>{riskEmoji[c.churn_risk_level]}</span>
                  </div>
                </div>

                {factors.length > 0 && (
                  <div style={{ fontSize: 12, color: D.muted, marginBottom: 6 }}>
                    Signals: {factors.map(f => f.value).join(' • ')}
                  </div>
                )}

                {c.engagement_trend && c.engagement_trend !== 'stable' && (
                  <div style={{ fontSize: 11, color: c.engagement_trend === 'declining' || c.engagement_trend === 'disengaging' ? D.red : D.green, marginBottom: 6 }}>
                    Trend: {c.engagement_trend === 'declining' ? '📉' : c.engagement_trend === 'disengaging' ? '📉📉' : '📈'} {c.engagement_trend}
                  </div>
                )}

                {c.next_best_action && (
                  <div style={{ fontSize: 13, color: D.teal, fontWeight: 500, marginBottom: 8, padding: '6px 10px', background: D.card, borderRadius: 6 }}>
                    🤖 {c.next_best_action}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pending Outreach */}
      {(data.pendingOutreach || []).length > 0 && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.amber, marginBottom: 16 }}>Pending Retention Outreach ({data.pendingOutreach.length})</div>
          {data.pendingOutreach.map(o => (
            <div key={o.id} style={{ padding: '12px 14px', background: D.bg, borderRadius: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: D.white, marginBottom: 4 }}>
                {o.first_name} {o.last_name} — {o.outreach_type?.toUpperCase()} ({o.outreach_strategy?.replace(/_/g, ' ')})
              </div>
              <div style={{ fontSize: 12, color: D.text, lineHeight: 1.6, marginBottom: 8, padding: '8px 10px', background: D.card, borderRadius: 6, fontStyle: 'italic' }}>
                "{o.message_content}"
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => handleApprove(o.id)} style={{ padding: '5px 12px', borderRadius: 5, border: 'none', background: D.green, color: D.white, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                  {o.outreach_type === 'sms' ? '✅ Approve & Send' : '✅ Approve & Call'}
                </button>
                <button style={{ padding: '5px 12px', borderRadius: 5, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 11, cursor: 'pointer' }}>✏️ Edit</button>
                <button style={{ padding: '5px 12px', borderRadius: 5, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 11, cursor: 'pointer' }}>⏭ Skip</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upsell Opportunities */}
      {(data.upsells || []).length > 0 && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: D.green }}>💰 Upsell Opportunities ({data.upsells.length})</div>
            <div style={{ fontSize: 13, color: D.muted }}>Potential: <span style={{ color: D.green, fontFamily: MONO }}>${data.upsellTotalMonthly}/mo</span></div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ padding: '8px 12px', fontSize: 11, color: D.muted, textAlign: 'left', borderBottom: `1px solid ${D.border}` }}>Customer</th>
                  <th style={{ padding: '8px 12px', fontSize: 11, color: D.muted, textAlign: 'left', borderBottom: `1px solid ${D.border}` }}>Current</th>
                  <th style={{ padding: '8px 12px', fontSize: 11, color: D.muted, textAlign: 'left', borderBottom: `1px solid ${D.border}` }}>Recommend</th>
                  <th style={{ padding: '8px 12px', fontSize: 11, color: D.muted, textAlign: 'right', borderBottom: `1px solid ${D.border}` }}>+$/mo</th>
                  <th style={{ padding: '8px 12px', fontSize: 11, color: D.muted, textAlign: 'right', borderBottom: `1px solid ${D.border}` }}>Conf</th>
                  <th style={{ padding: '8px 12px', fontSize: 11, color: D.muted, textAlign: 'center', borderBottom: `1px solid ${D.border}` }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {data.upsells.slice(0, 15).map(u => (
                  <tr key={u.id}>
                    <td style={{ padding: '8px 12px', fontSize: 13, color: D.white, borderBottom: `1px solid ${D.border}` }}>{u.first_name} {u.last_name}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: D.muted, borderBottom: `1px solid ${D.border}` }}>{u.waveguard_tier}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: D.teal, borderBottom: `1px solid ${D.border}` }}>{(u.recommended_service || '').replace(/_/g, ' ')}</td>
                    <td style={{ padding: '8px 12px', fontSize: 13, color: D.green, textAlign: 'right', fontFamily: MONO, borderBottom: `1px solid ${D.border}` }}>+${parseFloat(u.estimated_monthly_value || 0).toFixed(0)}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: D.muted, textAlign: 'right', fontFamily: MONO, borderBottom: `1px solid ${D.border}` }}>{Math.round(parseFloat(u.confidence || 0) * 100)}%</td>
                    <td style={{ padding: '8px 12px', textAlign: 'center', borderBottom: `1px solid ${D.border}` }}>
                      <button onClick={() => handleUpsellStatus(u.id, 'pitched')} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: D.teal, color: D.white, fontSize: 10, cursor: 'pointer' }}>Pitch</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Retention Metrics */}
      {data.metrics && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>📊 Retention Metrics (Last 30 Days)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <div style={{ padding: 12, background: D.bg, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: D.muted }}>Outreach Sent</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.teal, fontFamily: MONO }}>{data.metrics.outreachSent}</div>
            </div>
            <div style={{ padding: 12, background: D.bg, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: D.muted }}>Customers Saved</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.green, fontFamily: MONO }}>{data.metrics.customersSaved}</div>
              <div style={{ fontSize: 11, color: D.muted }}>{data.metrics.saveRate}% save rate</div>
            </div>
            <div style={{ padding: 12, background: D.bg, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: D.muted }}>Revenue Saved</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.green, fontFamily: MONO }}>${data.metrics.revenueSaved}/mo</div>
            </div>
            <div style={{ padding: 12, background: D.bg, borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: D.muted }}>Upsells Accepted</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: D.teal, fontFamily: MONO }}>{data.metrics.upsellsAccepted}</div>
              <div style={{ fontSize: 11, color: D.green }}>+${data.metrics.upsellRevenue}/mo</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
const KANBAN_STAGES = ['new_lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'follow_up', 'won', 'active_customer', 'at_risk'];

export default function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [pipelineData, setPipelineData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('directory'); // 'directory' | 'pipeline'
  const [search, setSearch] = useState('');
  const [filterStage, setFilterStage] = useState('all');
  const [filterTier, setFilterTier] = useState('all');
  const [sortBy, setSortBy] = useState('lastName');
  const [sortDir, setSortDir] = useState('asc');
  const [showAddModal, setShowAddModal] = useState(false);
  const [syncingSquare, setSyncingSquare] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedData, setExpandedData] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);

  const expandCustomer = async (id) => {
    if (expandedId === id) { setExpandedId(null); setExpandedData(null); return; }
    setExpandedId(id);
    setExpandedData(null);
    try {
      const data = await adminFetch(`/admin/customers/${id}`);
      setExpandedData(data);
    } catch { setExpandedData({ error: true }); }
  };

  const startEdit = (c) => {
    setEditingId(c.id);
    setEditForm({
      firstName: c.firstName, lastName: c.lastName, email: c.email || '',
      phone: c.phone || '', city: c.city || '', tier: c.tier || 'Bronze',
      monthlyRate: c.monthlyRate || '', pipelineStage: c.pipelineStage || 'new_lead',
    });
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      await adminFetch(`/admin/customers/${editingId}`, {
        method: 'PUT', body: JSON.stringify(editForm),
      });
      setEditingId(null);
      loadCustomers();
    } catch (e) { alert('Save failed: ' + e.message); }
    setSavingEdit(false);
  };

  const detectTier = (c) => {
    // Detect tier from monthly rate vs what it would be without discount
    // Silver=10%, Gold=15%, Platinum=20%
    if (c.tier && c.tier !== 'Bronze') return c.tier;
    if (c.monthlyRate > 200) return 'Platinum';
    if (c.monthlyRate > 100) return 'Gold';
    if (c.monthlyRate > 50) return 'Silver';
    return c.tier || 'Bronze';
  };

  const loadCustomers = () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (filterStage !== 'all') params.set('stage', filterStage);
    if (filterTier !== 'all') params.set('tier', filterTier);
    const qs = params.toString();
    adminFetch(`/admin/customers${qs ? '?' + qs : ''}`)
      .then(data => {
        setCustomers(Array.isArray(data) ? data : data.customers || []);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  const loadPipeline = () => {
    adminFetch('/admin/customers/pipeline/view')
      .then(data => setPipelineData(data))
      .catch(() => {}); // silent fail for pipeline
  };

  useEffect(() => { loadCustomers(); }, [filterStage, filterTier]);
  useEffect(() => { if (view === 'pipeline') loadPipeline(); }, [view]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => loadCustomers(), 300);
    return () => clearTimeout(t);
  }, [search]);

  const handleSort = (key) => {
    if (sortBy === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  };

  // Client-side sort
  const sorted = [...customers].sort((a, b) => {
    let aVal, bVal;
    switch (sortBy) {
      case 'name': aVal = `${a.lastName} ${a.firstName}`.toLowerCase(); bVal = `${b.lastName} ${b.firstName}`.toLowerCase(); break;
      case 'lastName': aVal = (a.lastName || '').toLowerCase(); bVal = (b.lastName || '').toLowerCase(); break;
      case 'leadScore': aVal = a.leadScore || 0; bVal = b.leadScore || 0; break;
      case 'monthlyRate': aVal = a.monthlyRate || 0; bVal = b.monthlyRate || 0; break;
      case 'lastContactDate': aVal = a.lastContactDate || ''; bVal = b.lastContactDate || ''; break;
      case 'lifetimeRevenue': aVal = a.lifetimeRevenue || 0; bVal = b.lifetimeRevenue || 0; break;
      default: aVal = (a[sortBy] || '').toString().toLowerCase(); bVal = (b[sortBy] || '').toString().toLowerCase();
    }
    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const totalCount = customers.length;

  // Group customers by stage for pipeline view
  const pipelineGroups = {};
  KANBAN_STAGES.forEach(key => { pipelineGroups[key] = []; });
  if (view === 'pipeline') {
    (pipelineData?.customers || customers).forEach(c => {
      const key = c.pipelineStage || 'new_lead';
      if (pipelineGroups[key]) pipelineGroups[key].push(c);
    });
  }

  // --- Loading & Error ---
  if (loading && customers.length === 0) {
    return (
      <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontFamily: 'DM Sans, sans-serif', fontSize: 15 }}>
        Loading customers...
      </div>
    );
  }

  if (error && customers.length === 0) {
    return (
      <div style={{ color: D.red, padding: 60, textAlign: 'center', fontFamily: 'DM Sans, sans-serif' }}>
        <div style={{ fontSize: 16, marginBottom: 12 }}>Failed to load customers</div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>{error}</div>
        <button onClick={loadCustomers} style={{
          padding: '8px 20px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
          fontSize: 14, fontFamily: 'DM Sans, sans-serif', cursor: 'pointer',
        }}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <style>{`
        @keyframes pulse-badge { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>

      {/* ====================== HEADER ====================== */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: D.white, fontFamily: 'DM Sans, sans-serif' }}>Customers</div>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, color: D.muted }}>{totalCount}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* View toggle */}
          <div style={{
            display: 'flex', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: 'hidden',
          }}>
            {[
              { key: 'directory', label: '\ud83d\udccb Directory' },
              { key: 'pipeline', label: '\ud83d\udd00 Pipeline' },
              { key: 'intelligence', label: '\ud83e\udd16 AI Advisor' },
            ].map(v => (
              <button key={v.key} onClick={() => setView(v.key)} style={{
                padding: '8px 14px', background: view === v.key ? D.teal : 'transparent',
                color: view === v.key ? D.white : D.muted, border: 'none', fontSize: 13,
                fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: 'pointer',
              }}>{v.label}</button>
            ))}
          </div>
          {/* Search */}
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search customers..."
            style={{
              padding: '8px 14px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8,
              color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', outline: 'none', width: 200,
            }}
          />
          {/* Sync Square */}
          <button onClick={async () => {
            setSyncingSquare(true);
            try {
              const r = await fetch(`${API_BASE}/admin/customers/sync-square`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
              });
              const result = await r.json();
              if (!r.ok) {
                alert(`Sync failed: ${result.error}`);
              } else {
                alert(`Square sync: ${result.totalFetched} fetched, ${result.created} new, ${result.updated} updated, ${result.skipped} unchanged${result.errors?.length ? '\n' + result.errors.length + ' errors' : ''}`);
                loadCustomers();
              }
            } catch (e) { alert('Sync failed: ' + e.message); }
            setSyncingSquare(false);
          }} disabled={syncingSquare} style={{
            padding: '8px 18px', background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 8,
            fontSize: 13, fontFamily: 'DM Sans, sans-serif', color: D.muted, cursor: 'pointer',
            opacity: syncingSquare ? 0.5 : 1, whiteSpace: 'nowrap',
          }}>{syncingSquare ? 'Syncing...' : 'Sync from Square'}</button>
          {/* Add button */}
          <button onClick={() => setShowAddModal(true)} style={{
            padding: '8px 18px', background: D.teal, color: D.white, border: 'none', borderRadius: 8,
            fontSize: 14, fontFamily: 'DM Sans, sans-serif', fontWeight: 600, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}>+ Add Customer</button>
        </div>
      </div>

      {/* ====================== DIRECTORY VIEW ====================== */}
      {view === 'directory' && (
        <>
          {/* Filter bar */}
          <div style={{
            display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center',
            padding: '10px 14px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 10,
          }}>
            <Select
              value={filterStage}
              onChange={setFilterStage}
              options={[{ value: 'all', label: 'All Stages' }, ...STAGES.map(s => ({ value: s.key, label: s.label }))]}
            />
            <Select
              value={filterTier}
              onChange={setFilterTier}
              options={[
                { value: 'all', label: 'All Tiers' },
                { value: 'Platinum', label: 'Platinum' },
                { value: 'Gold', label: 'Gold' },
                { value: 'Silver', label: 'Silver' },
                { value: 'Bronze', label: 'Bronze' },
              ]}
            />
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.muted }}>
              {sorted.length} result{sorted.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '2.5fr 1.2fr 1fr 0.8fr 0.7fr 0.7fr 0.8fr 0.5fr',
            gap: 8, padding: '10px 16px', marginBottom: 4,
          }}>
            <SortHeader label="Name / Email" sortKey="lastName" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
            <SortHeader label="Phone" sortKey="phone" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>City</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>Stage</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>Tier</div>
            <SortHeader label="$/Mo" sortKey="monthlyRate" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
            <SortHeader label="Last Contact" sortKey="lastContactDate" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
            <div />
          </div>

          {/* Rows */}
          {sorted.length === 0 ? (
            <div style={{
              padding: 48, textAlign: 'center', color: D.muted, fontFamily: 'DM Sans, sans-serif',
              background: D.card, borderRadius: 12, border: `1px solid ${D.border}`,
            }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>👥</div>
              <div style={{ fontSize: 15 }}>No customers found</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Try adjusting your filters or add a new customer</div>
            </div>
          ) : (
            sorted.map(c => (
              <div key={c.id} style={{ marginBottom: 6 }}>
                <div
                  onClick={() => expandCustomer(c.id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2.5fr 1.2fr 1fr 0.8fr 0.7fr 0.7fr 0.8fr 0.5fr',
                    gap: 8, padding: '12px 16px', alignItems: 'center',
                    background: expandedId === c.id ? `${D.teal}08` : D.card,
                    border: `1px solid ${expandedId === c.id ? D.teal : D.border}`,
                    borderRadius: expandedId === c.id ? '10px 10px 0 0' : 10,
                    cursor: 'pointer', transition: 'border-color 0.15s',
                  }}
                >
                  {/* Name + Email */}
                  <div>
                    <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 14, fontWeight: 600, color: D.white }}>
                      {c.firstName} {c.lastName}
                    </div>
                    <div style={{ fontSize: 11, color: D.muted, marginTop: 1 }}>{c.email || 'No email'}</div>
                  </div>
                  {/* Phone — clickable */}
                  <div>
                    {c.phone ? (
                      <a
                        href={`/admin/communications?phone=${encodeURIComponent(c.phone)}`}
                        onClick={e => e.stopPropagation()}
                        style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.teal, textDecoration: 'none' }}
                      >
                        {c.phone}
                      </a>
                    ) : (
                      <span style={{ fontSize: 12, color: D.muted }}>--</span>
                    )}
                  </div>
                  {/* City */}
                  <div style={{ fontSize: 12, color: D.muted }}>{c.city || '--'}</div>
                  {/* Stage */}
                  <div><StageBadge stage={c.pipelineStage} /></div>
                  {/* Tier */}
                  <div><TierBadge tier={detectTier(c)} /></div>
                  {/* Monthly rate */}
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: c.monthlyRate ? D.green : D.muted }}>
                    {c.monthlyRate ? `$${c.monthlyRate}` : '--'}
                  </div>
                  {/* Last contact */}
                  <div style={{ fontSize: 12, color: D.muted }}>{timeAgo(c.lastContactDate)}</div>
                  {/* Edit */}
                  <div>
                    <button onClick={e => { e.stopPropagation(); startEdit(c); }} style={{
                      padding: '4px 10px', background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6,
                      color: D.muted, fontSize: 11, cursor: 'pointer',
                    }}>Edit</button>
                  </div>
                </div>

                {/* Expanded detail panel */}
                {expandedId === c.id && (
                  <div style={{
                    background: D.card, border: `1px solid ${D.teal}`, borderTop: 'none',
                    borderRadius: '0 0 10px 10px', padding: 20,
                  }}>
                    {!expandedData ? <div style={{ color: D.muted, textAlign: 'center', padding: 20 }}>Loading...</div> :
                    expandedData.error ? <div style={{ color: D.red, textAlign: 'center' }}>Failed to load details</div> : (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                        {/* Column 1: Contact Info */}
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Contact</div>
                          {[
                            ['Name', `${expandedData.customer.firstName} ${expandedData.customer.lastName}`],
                            ['Email', expandedData.customer.email],
                            ['Phone', expandedData.customer.phone],
                            ['Address', `${expandedData.customer.address?.line1 || ''}, ${expandedData.customer.address?.city || ''}, ${expandedData.customer.address?.state || ''} ${expandedData.customer.address?.zip || ''}`],
                            ['Company', expandedData.customer.companyName],
                            ['Member Since', expandedData.customer.memberSince],
                            ['Lead Source', expandedData.customer.leadSource],
                          ].map(([l, v]) => v && (
                            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
                              <span style={{ color: D.muted }}>{l}</span>
                              <span style={{ color: D.white, textAlign: 'right', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
                            </div>
                          ))}
                          <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
                            {expandedData.customer.phone && (
                              <>
                                <a href={`/admin/communications?phone=${encodeURIComponent(expandedData.customer.phone)}&action=sms`} style={{ padding: '6px 12px', background: D.teal, color: D.white, borderRadius: 6, fontSize: 11, fontWeight: 600, textDecoration: 'none' }}>💬 Text</a>
                                <a href={`/admin/communications?phone=${encodeURIComponent(expandedData.customer.phone)}&action=call`} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${D.border}`, color: D.muted, borderRadius: 6, fontSize: 11, textDecoration: 'none' }}>📞 Call</a>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Column 2: Services + Payments */}
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Service History ({(expandedData.services || []).length})</div>
                          {(expandedData.services || []).slice(0, 5).map((s, i) => (
                            <div key={i} style={{ padding: '4px 0', fontSize: 12, borderBottom: `1px solid ${D.border}22` }}>
                              <span style={{ color: D.white }}>{s.service_type}</span>
                              <span style={{ color: D.muted, marginLeft: 8 }}>{s.service_date ? new Date(s.service_date).toLocaleDateString() : ''}</span>
                            </div>
                          ))}
                          {(expandedData.services || []).length === 0 && <div style={{ fontSize: 12, color: D.muted }}>No services</div>}

                          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 16 }}>Payments ({(expandedData.payments || []).length})</div>
                          {(expandedData.payments || []).slice(0, 5).map((p, i) => (
                            <div key={i} style={{ padding: '4px 0', fontSize: 12, borderBottom: `1px solid ${D.border}22` }}>
                              <span style={{ color: D.green, fontFamily: 'JetBrains Mono, monospace' }}>${parseFloat(p.amount || 0).toFixed(2)}</span>
                              <span style={{ color: D.muted, marginLeft: 8 }}>{p.payment_date ? new Date(p.payment_date).toLocaleDateString() : ''}</span>
                              <span style={{ color: D.muted, marginLeft: 8 }}>{p.description}</span>
                            </div>
                          ))}
                          {(expandedData.payments || []).length === 0 && <div style={{ fontSize: 12, color: D.muted }}>No payments</div>}
                        </div>

                        {/* Column 3: Recent SMS + Interactions */}
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Recent SMS ({(expandedData.smsLog || []).length})</div>
                          {(expandedData.smsLog || []).slice(0, 5).map((s, i) => (
                            <div key={i} style={{ padding: '4px 0', fontSize: 11, borderBottom: `1px solid ${D.border}22` }}>
                              <span style={{ color: s.direction === 'inbound' ? D.teal : D.green }}>{s.direction === 'inbound' ? '← ' : '→ '}</span>
                              <span style={{ color: D.muted }}>{(s.message_body || '').substring(0, 60)}</span>
                              <div style={{ fontSize: 10, color: D.muted }}>{timeAgo(s.created_at)}</div>
                            </div>
                          ))}
                          {(expandedData.smsLog || []).length === 0 && <div style={{ fontSize: 12, color: D.muted }}>No SMS</div>}

                          <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 16 }}>Tags</div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {(expandedData.tags || []).map(t => <TagChip key={t} tag={t} />)}
                            {(expandedData.tags || []).length === 0 && <span style={{ fontSize: 12, color: D.muted }}>No tags</span>}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Inline edit modal */}
                {editingId === c.id && (
                  <div style={{ background: D.card, border: `1px solid ${D.teal}`, borderRadius: 10, padding: 20, marginTop: -2 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Edit Customer</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
                      {[
                        { key: 'firstName', label: 'First Name' },
                        { key: 'lastName', label: 'Last Name' },
                        { key: 'email', label: 'Email', type: 'email' },
                        { key: 'phone', label: 'Phone', type: 'tel' },
                        { key: 'city', label: 'City' },
                        { key: 'monthlyRate', label: '$/Mo', type: 'number' },
                      ].map(f => (
                        <div key={f.key}>
                          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>{f.label}</label>
                          <input value={editForm[f.key] || ''} onChange={e => setEditForm(p => ({ ...p, [f.key]: e.target.value }))} type={f.type || 'text'} style={{ width: '100%', padding: '8px 10px', background: '#0f172a', border: `1px solid ${D.border}`, borderRadius: 6, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                        </div>
                      ))}
                      <div>
                        <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Tier</label>
                        <select value={editForm.tier || 'Bronze'} onChange={e => setEditForm(p => ({ ...p, tier: e.target.value }))} style={{ width: '100%', padding: '8px 10px', background: '#0f172a', border: `1px solid ${D.border}`, borderRadius: 6, color: D.text, fontSize: 13, outline: 'none', cursor: 'pointer' }}>
                          <option value="Bronze">Bronze</option><option value="Silver">Silver (10%)</option><option value="Gold">Gold (15%)</option><option value="Platinum">Platinum (20%)</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Stage</label>
                        <select value={editForm.pipelineStage || ''} onChange={e => setEditForm(p => ({ ...p, pipelineStage: e.target.value }))} style={{ width: '100%', padding: '8px 10px', background: '#0f172a', border: `1px solid ${D.border}`, borderRadius: 6, color: D.text, fontSize: 13, outline: 'none', cursor: 'pointer' }}>
                          {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={saveEdit} disabled={savingEdit} style={{ padding: '8px 18px', background: D.teal, color: D.white, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: savingEdit ? 0.5 : 1 }}>{savingEdit ? 'Saving...' : 'Save'}</button>
                      <button onClick={() => setEditingId(null)} style={{ padding: '8px 18px', background: 'transparent', border: `1px solid ${D.border}`, color: D.muted, borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}

      {/* ====================== PIPELINE VIEW ====================== */}
      {view === 'pipeline' && (
        <div style={{
          display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 12,
        }}>
          {KANBAN_STAGES.map(key => {
            const stage = STAGE_MAP[key];
            return (
              <PipelineColumn
                key={key}
                stage={stage}
                customers={pipelineGroups[key] || []}
              />
            );
          })}
        </div>
      )}

      {/* ====================== INTELLIGENCE TAB ====================== */}
      {view === 'intelligence' && <CustomerIntelligenceTab />}

      {/* ====================== QUICK ADD MODAL ====================== */}
      {showAddModal && (
        <QuickAddModal
          onClose={() => setShowAddModal(false)}
          onCreated={() => { loadCustomers(); if (view === 'pipeline') loadPipeline(); }}
        />
      )}
    </div>
  );
}
