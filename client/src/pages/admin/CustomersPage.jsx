import { useState, useEffect, useRef, useMemo } from 'react';
import Customer360Profile from '../../components/admin/Customer360Profile';

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
  { key: 'estimate_viewed', label: 'Est. Viewed', color: D.amber, bg: D.amber, textColor: '#1e293b' },
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
          <div className="modal-grid-2col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
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
function PipelineCard({ customer, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const daysInStage = customer.stageEnteredAt
    ? Math.floor((Date.now() - new Date(customer.stageEnteredAt)) / 86400000)
    : null;
  const addressLine = customer.address ? customer.address.split(',')[0] : '';

  return (
    <div style={{
      background: D.bg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 14, marginBottom: 8,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>
          {customer.firstName} {customer.lastName}
        </div>
        <button onClick={(e) => { e.stopPropagation(); setConfirming(!confirming); }} style={{
          background: 'none', border: 'none', color: D.muted, fontSize: 14, cursor: 'pointer', padding: '0 4px',
        }}>×</button>
      </div>
      {confirming && (
        <div style={{ background: D.card, border: `1px solid ${D.red}44`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: D.red, marginBottom: 8 }}>Delete {customer.firstName} {customer.lastName}?</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={async () => {
              try {
                await fetch(`${API_BASE}/admin/customers/${customer.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` } });
                onDelete?.(customer.id);
              } catch (e) { alert('Delete failed: ' + e.message); }
            }} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: D.red, color: D.white, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
            <button onClick={() => setConfirming(false)} style={{ padding: '4px 12px', borderRadius: 6, border: `1px solid ${D.border}`, background: 'none', color: D.muted, fontSize: 11, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
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
function PipelineColumn({ stage, customers, onDeleteCustomer }) {
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
          customers.map(c => <PipelineCard key={c.id} customer={c} onDelete={onDeleteCustomer} />)
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
        <div className="intel-health-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
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
          <div className="intel-metrics-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
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

function CustomerTimeline({ customerId }) {
  const [timeline, setTimeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    adminFetch(`/admin/customers/${customerId}/timeline`)
      .then(d => { setTimeline(d.timeline || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [customerId]);

  if (loading) return <div style={{ color: D.muted, fontSize: 12, padding: 12 }}>Loading timeline...</div>;
  if (!timeline.length) return null;

  const ICONS = { sms: '💬', call: '📞', service: '🔧', payment: '💰', review: '⭐', scheduled_service: '📅', interaction: '📝', activity: '📋' };
  const COLORS = { sms: D.teal, call: '#60a5fa', service: D.green, payment: D.green, review: D.amber, scheduled_service: D.teal, interaction: D.muted, activity: D.muted };
  const items = showAll ? timeline : timeline.slice(0, 8);

  return (
    <div style={{ gridColumn: '1 / -1', marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 1 }}>Timeline ({timeline.length})</div>
        {timeline.length > 8 && <button onClick={() => setShowAll(!showAll)} style={{ background: 'none', border: 'none', color: D.teal, fontSize: 11, cursor: 'pointer' }}>{showAll ? 'Show less' : `Show all ${timeline.length}`}</button>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map((item, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: i < items.length - 1 ? `1px solid ${D.border}22` : 'none', fontSize: 12 }}>
            <span style={{ fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 }}>{ICONS[item.type] || '•'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ color: COLORS[item.type] || D.muted, fontWeight: 600 }}>{item.title}</span>
              {item.description && <span style={{ color: D.muted, marginLeft: 6 }}>— {item.description.substring(0, 80)}</span>}
            </div>
            <span style={{ color: D.muted, fontSize: 10, fontFamily: 'JetBrains Mono, monospace', flexShrink: 0 }}>{item.date ? timeAgo(item.date) : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CUSTOMER MAP — Interactive Google Maps with customer pins
// ═══════════════════════════════════════════════════════════════════
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
const TIER_PIN_COLORS = { Platinum: '#E5E4E2', Gold: '#FDD835', Silver: '#90CAF9', Bronze: '#CD7F32' };
const STAGE_PIN_COLORS = { active_customer: '#10b981', won: '#10b981', new_lead: '#0ea5e9', contacted: '#0ea5e9', estimate_sent: '#f59e0b', at_risk: '#ef4444', churned: '#ef4444' };

function CustomerMap({ customers, onSelect }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [filterTier, setFilterTier] = useState('all');
  const [filterStage, setFilterStage] = useState('all');
  const [stats, setStats] = useState({ total: 0, mapped: 0, unmapped: 0 });
  const [selectedPin, setSelectedPin] = useState(null);

  // Load Google Maps script
  useEffect(() => {
    try {
      if (window.google?.maps) { setMapReady(true); return; }
      if (!MAPS_KEY) return;
      const existingScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
      if (existingScript) {
        // Script exists — wait for it to load
        if (window.google?.maps) { setMapReady(true); return; }
        existingScript.addEventListener('load', () => setMapReady(true));
        existingScript.addEventListener('error', () => setMapError('Google Maps failed to load'));
        return;
      }
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=places`;
      script.async = true;
      script.defer = true;
      script.onload = () => setMapReady(true);
      script.onerror = () => setMapError('Google Maps script failed to load. Check API key.');
      document.head.appendChild(script);
    } catch (e) { setMapError(e.message); }
  }, []);

  // Filter customers
  const filtered = useMemo(() => {
    if (!customers || !Array.isArray(customers)) return [];
    return customers.filter(c => {
      if (filterTier !== 'all' && (c.tier || null) !== (filterTier === 'none' ? null : filterTier)) return false;
      if (filterStage !== 'all' && c.pipelineStage !== filterStage) return false;
      return true;
    });
  }, [customers, filterTier, filterStage]);

  // Build map + markers
  useEffect(() => {
    if (!mapReady || !mapRef.current || !window.google?.maps) return;
    try {

    // Init map centered on Bradenton/LWR area
    if (!mapInstance.current) {
      mapInstance.current = new window.google.maps.Map(mapRef.current, {
        center: { lat: 27.45, lng: -82.45 },
        zoom: 10,
        mapTypeId: 'roadmap',
        styles: [
          { elementType: 'geometry', stylers: [{ color: '#1a2332' }] },
          { elementType: 'labels.text.stroke', stylers: [{ color: '#1a2332' }] },
          { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3e8' }] },
          { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c3e50' }] },
          { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1926' }] },
          { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        ],
      });
    }

    // Clear old markers
    markersRef.current.forEach(m => m.setMap(null));
    markersRef.current = [];

    // Geocode + place markers
    const geocoder = new window.google.maps.Geocoder();
    let mapped = 0, unmapped = 0;
    const bounds = new window.google.maps.LatLngBounds();
    const infoWindow = new window.google.maps.InfoWindow();

    const mappable = filtered.filter(c => c.address || c.city);

    mappable.forEach((c, idx) => {
      const address = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      if (!address || address.replace(/,\s*/g, '').length < 5) { unmapped++; return; }

      // Use lat/lng if available, otherwise geocode
      if (c.lat && c.lng) {
        placeMarker(c, { lat: parseFloat(c.lat), lng: parseFloat(c.lng) });
        mapped++;
        bounds.extend({ lat: parseFloat(c.lat), lng: parseFloat(c.lng) });
      } else if (idx < 200) { // limit geocoding to 200 to avoid quota
        geocoder.geocode({ address: address + ', FL' }, (results, status) => {
          if (status === 'OK' && results[0]) {
            const pos = results[0].geometry.location;
            placeMarker(c, pos);
            bounds.extend(pos);
            if (mapped + unmapped >= Math.min(mappable.length, 200)) {
              mapInstance.current.fitBounds(bounds, 50);
            }
          }
        });
        mapped++;
      } else { unmapped++; }
    });

    function placeMarker(c, position) {
      const color = TIER_PIN_COLORS[c.tier] || STAGE_PIN_COLORS[c.pipelineStage] || '#0ea5e9';
      const marker = new window.google.maps.Marker({
        position, map: mapInstance.current,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 8, fillColor: color, fillOpacity: 0.9,
          strokeColor: '#fff', strokeWeight: 2,
        },
        title: `${c.firstName} ${c.lastName}`,
      });

      marker.addListener('click', () => {
        setSelectedPin(c);
        infoWindow.setContent(`
          <div style="font-family:DM Sans,sans-serif;min-width:200px;color:#1e293b">
            <div style="font-weight:700;font-size:14px;margin-bottom:4px">${c.firstName} ${c.lastName}</div>
            <div style="font-size:12px;color:#64748b">${c.address || ''} ${c.city || ''}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px">${c.phone || ''}</div>
            ${c.tier ? `<div style="font-size:11px;margin-top:4px;color:${color};font-weight:600">WaveGuard ${c.tier}</div>` : ''}
            <div style="font-size:11px;color:#94a3b8;margin-top:2px">${c.pipelineStage ? c.pipelineStage.replace(/_/g, ' ') : 'No stage'}</div>
          </div>
        `);
        infoWindow.open(mapInstance.current, marker);
      });

      markersRef.current.push(marker);
    }

    unmapped += filtered.length - mappable.length;
    setStats({ total: filtered.length, mapped, unmapped });

    if (mapped > 0) {
      setTimeout(() => {
        if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
          mapInstance.current.setCenter(bounds.getCenter());
          mapInstance.current.setZoom(14);
        } else {
          mapInstance.current.fitBounds(bounds, 50);
        }
      }, 1500);
    }
    } catch (e) { console.error('[CustomerMap] Error:', e); setMapError(e.message); }
  }, [mapReady, filtered]);

  if (!MAPS_KEY) {
    return (
      <div style={{ background: D.card, borderRadius: 12, padding: 40, textAlign: 'center', border: `1px solid ${D.border}` }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🗺️</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 4 }}>Google Maps API Key Required</div>
        <div style={{ fontSize: 13, color: D.muted }}>Set VITE_GOOGLE_MAPS_API_KEY in your environment to enable the customer map.</div>
      </div>
    );
  }

  if (mapError) {
    return (
      <div style={{ background: D.card, borderRadius: 12, padding: 40, textAlign: 'center', border: `1px solid ${D.border}` }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.red, marginBottom: 4 }}>Map Error</div>
        <div style={{ fontSize: 13, color: D.muted }}>{mapError}</div>
        <div style={{ fontSize: 11, color: D.muted, marginTop: 8 }}>Ensure Maps JavaScript API is enabled in Google Cloud Console.</div>
      </div>
    );
  }

  if (!mapReady) {
    return (
      <div style={{ background: D.card, borderRadius: 12, padding: 40, textAlign: 'center', border: `1px solid ${D.border}` }}>
        <div style={{ fontSize: 13, color: D.muted }}>Loading map...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={filterTier} onChange={e => setFilterTier(e.target.value)} style={{ padding: '6px 10px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 12 }}>
          <option value="all">All Tiers</option>
          <option value="Platinum">Platinum</option>
          <option value="Gold">Gold</option>
          <option value="Silver">Silver</option>
          <option value="Bronze">Bronze</option>
          <option value="none">No Plan</option>
        </select>
        <select value={filterStage} onChange={e => setFilterStage(e.target.value)} style={{ padding: '6px 10px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 12 }}>
          <option value="all">All Stages</option>
          <option value="active_customer">Active</option>
          <option value="new_lead">New Lead</option>
          <option value="estimate_sent">Estimate Sent</option>
          <option value="at_risk">At Risk</option>
          <option value="churned">Churned</option>
        </select>
        <div style={{ fontSize: 12, color: D.muted }}>
          {stats.mapped} mapped · {stats.unmapped} no address
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', fontSize: 11, color: D.muted }}>
          {Object.entries(TIER_PIN_COLORS).map(([tier, color]) => (
            <span key={tier} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, border: '1px solid #fff3' }} />
              {tier}
            </span>
          ))}
        </div>
      </div>

      {/* Map container */}
      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: `1px solid ${D.border}` }}>
        <div ref={mapRef} style={{ width: '100%', height: 600 }} />

        {/* Selected customer card */}
        {selectedPin && (
          <div style={{
            position: 'absolute', bottom: 16, left: 16, right: 16, maxWidth: 360,
            background: D.card, borderRadius: 12, padding: 16,
            border: `1px solid ${D.border}`, boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: D.white }}>{selectedPin.firstName} {selectedPin.lastName}</div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{selectedPin.address} {selectedPin.city}</div>
                <div style={{ fontSize: 12, color: D.muted }}>{selectedPin.phone}</div>
                {selectedPin.tier && <div style={{ fontSize: 11, color: TIER_PIN_COLORS[selectedPin.tier] || D.teal, fontWeight: 600, marginTop: 4 }}>WaveGuard {selectedPin.tier}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => onSelect(selectedPin)} style={{ padding: '6px 12px', background: D.teal, color: D.white, border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>View</button>
                <button onClick={() => setSelectedPin(null)} style={{ padding: '6px 8px', background: 'transparent', color: D.muted, border: `1px solid ${D.border}`, borderRadius: 6, fontSize: 14, cursor: 'pointer' }}>✕</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [squareSyncInfo, setSquareSyncInfo] = useState(null);
  const [filterCity, setFilterCity] = useState('all');
  const [fixingTiers, setFixingTiers] = useState(false);
  const [filterHasBalance, setFilterHasBalance] = useState(false);
  const [selected360Id, setSelected360Id] = useState(null);
  const [page, setPage] = useState(1);
  const [totalCustomers, setTotalCustomers] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);

  const expandCustomer = async (id) => {
    // Open the 360 slide-out panel instead of inline expansion
    setSelected360Id(id);
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
    // Bronze=0%, Silver=10%, Gold=15%, Platinum=20%
    if (c.tier && c.tier !== 'Bronze') return c.tier;
    if (c.monthlyRate > 200) return 'Platinum';
    if (c.monthlyRate > 100) return 'Gold';
    if (c.monthlyRate > 50) return 'Silver';
    return c.tier || 'Bronze';
  };

  const loadCustomers = (p) => {
    const pg = p || page;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (filterStage !== 'all') params.set('stage', filterStage);
    if (filterTier !== 'all') params.set('tier', filterTier);
    if (filterCity !== 'all') params.set('city', filterCity);
    params.set('page', String(pg));
    params.set('limit', '100');
    adminFetch(`/admin/customers?${params.toString()}`)
      .then(data => {
        setCustomers(Array.isArray(data) ? data : data.customers || []);
        setTotalCustomers(data.total || 0);
        setTotalPages(data.totalPages || 1);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  const loadPipeline = () => {
    adminFetch('/admin/customers/pipeline/view')
      .then(data => setPipelineData(data))
      .catch(() => {}); // silent fail for pipeline
  };

  useEffect(() => { setPage(1); loadCustomers(1); }, [filterStage, filterTier, filterCity]);
  useEffect(() => { if (view === 'pipeline') loadPipeline(); }, [view]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); loadCustomers(1); }, 300);
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

  const handleFixTiers = async () => {
    if (!confirm('Recalculate all customer tiers based on active service count?\n\n0 services = No Plan\n1 = Bronze\n2 = Silver\n3 = Gold\n4+ = Platinum')) return;
    setFixingTiers(true);
    try {
      const result = await adminFetch('/admin/customers/fix-tiers', { method: 'POST', body: '{}' });
      alert(`Tiers updated: ${result.updated || 0} customers recalculated`);
      loadCustomers();
    } catch (e) {
      alert('Fix tiers failed: ' + e.message);
    }
    setFixingTiers(false);
  };

  const handleDeleteCustomer = async (customerId, customerName) => {
    if (!confirm(`Delete ${customerName}? This cannot be undone.`)) return;
    try {
      const r = await fetch(`${API_BASE}/admin/customers/${customerId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` } });
      if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.error || `HTTP ${r.status}`); }
      loadCustomers();
    } catch (e) { alert('Delete failed: ' + e.message); }
  };

  // Service type icons helper
  const serviceIcons = (c) => {
    const icons = [];
    const types = (c.serviceTypes || c.service_types || '').toLowerCase();
    if (types.includes('pest')) icons.push({ icon: 'P', label: 'Pest', color: D.teal });
    if (types.includes('lawn')) icons.push({ icon: 'L', label: 'Lawn', color: D.green });
    if (types.includes('mosquito')) icons.push({ icon: 'M', label: 'Mosquito', color: D.amber });
    if (types.includes('termite')) icons.push({ icon: 'T', label: 'Termite', color: D.red });
    return icons;
  };

  // Auto-tier from service count
  const tierFromServices = (count) => {
    if (!count || count === 0) return null;
    if (count === 1) return 'Bronze';
    if (count === 2) return 'Silver';
    if (count === 3) return 'Gold';
    return 'Platinum';
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

  // Apply "Has Balance" filter
  const filteredSorted = filterHasBalance ? sorted.filter(c => (c.balanceOwed || 0) > 0) : sorted;

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
        @media (max-width: 640px) {
          .customers-header { flex-direction: column !important; align-items: flex-start !important; gap: 12px !important; }
          .customers-header-actions { flex-wrap: wrap !important; width: 100% !important; }
          .customers-header-actions input[type="text"] { width: 100% !important; }
          .customers-filter-bar { flex-direction: column !important; gap: 8px !important; }
          .customers-filter-bar select { width: 100% !important; }
          .customers-table-header { display: none !important; }
          .customers-row-grid { display: flex !important; flex-direction: column !important; gap: 8px !important; padding: 14px 16px !important; }
          .customers-row-grid > div { display: flex !important; }
          .customer-expanded-detail .detail-grid-3col { grid-template-columns: 1fr !important; }
          .customer-edit-grid { grid-template-columns: 1fr 1fr !important; }
          .customers-pipeline-wrap { -webkit-overflow-scrolling: touch; }
          .intel-health-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .intel-metrics-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .customers-view-toggle { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; }
          .customers-view-toggle button { white-space: nowrap !important; font-size: 12px !important; padding: 6px 10px !important; }
          .modal-grid-2col { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* ====================== HEADER ====================== */}
      <div className="customers-header" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: D.white, fontFamily: 'DM Sans, sans-serif' }}>Customers</div>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, color: D.muted }}>{totalCount}</span>
        </div>
        <div className="customers-header-actions" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* View toggle */}
          <div className="customers-view-toggle" style={{
            display: 'flex', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: 'hidden',
          }}>
            {[
              { key: 'directory', label: '\ud83d\udccb Directory' },
              { key: 'map', label: '\ud83d\uddfa Map' },
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
          {/* Square sync status + Fix tiers */}
          <div style={{
            display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center',
            padding: '8px 14px', background: `${D.card}cc`, border: `1px solid ${D.border}`, borderRadius: 10,
          }}>
            <div style={{ flex: 1 }} />
            <button onClick={handleFixTiers} disabled={fixingTiers} style={{
              padding: '5px 12px', background: 'transparent', border: `1px solid ${D.amber}66`, borderRadius: 6,
              color: D.amber, fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: fixingTiers ? 0.5 : 1,
            }}>{fixingTiers ? 'Fixing...' : 'Fix Tiers'}</button>
          </div>

          {/* Filter pills — City */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: D.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, alignSelf: 'center', marginRight: 4 }}>City:</span>
            {['all', 'Lakewood Ranch', 'Parrish', 'Sarasota', 'Venice', 'Bradenton'].map(city => (
              <button key={city} onClick={() => setFilterCity(city)} style={{
                padding: '4px 10px', borderRadius: 9999, border: `1px solid ${filterCity === city ? D.teal : D.border}`,
                background: filterCity === city ? `${D.teal}22` : 'transparent',
                color: filterCity === city ? D.teal : D.muted, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}>{city === 'all' ? 'All' : city}</button>
            ))}
          </div>

          {/* Filter pills — Tier */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: D.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, alignSelf: 'center', marginRight: 4 }}>Tier:</span>
            {[
              { value: 'all', label: 'All' },
              { value: 'Bronze', label: 'Bronze' },
              { value: 'Silver', label: 'Silver' },
              { value: 'Gold', label: 'Gold' },
              { value: 'Platinum', label: 'Platinum' },
              { value: 'none', label: 'No Plan' },
            ].map(t => (
              <button key={t.value} onClick={() => setFilterTier(t.value)} style={{
                padding: '4px 10px', borderRadius: 9999,
                border: `1px solid ${filterTier === t.value ? (TIER_COLORS[t.value] || D.teal) : D.border}`,
                background: filterTier === t.value ? `${TIER_COLORS[t.value] || D.teal}22` : 'transparent',
                color: filterTier === t.value ? (TIER_COLORS[t.value] || D.teal) : D.muted,
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}>{t.label}</button>
            ))}
          </div>

          {/* Filter pills — Status */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: D.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, alignSelf: 'center', marginRight: 4 }}>Status:</span>
            {[
              { value: 'all', label: 'All' },
              { value: 'active_customer', label: 'Active' },
              { value: 'new_lead', label: 'New Lead' },
              { value: 'at_risk', label: 'At Risk' },
            ].map(s => (
              <button key={s.value} onClick={() => setFilterStage(s.value)} style={{
                padding: '4px 10px', borderRadius: 9999,
                border: `1px solid ${filterStage === s.value ? D.teal : D.border}`,
                background: filterStage === s.value ? `${D.teal}22` : 'transparent',
                color: filterStage === s.value ? D.teal : D.muted,
                fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}>{s.label}</button>
            ))}
            <button onClick={() => setFilterHasBalance(!filterHasBalance)} style={{
              padding: '4px 10px', borderRadius: 9999,
              border: `1px solid ${filterHasBalance ? D.red : D.border}`,
              background: filterHasBalance ? `${D.red}22` : 'transparent',
              color: filterHasBalance ? D.red : D.muted,
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}>Has Balance</button>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: D.muted, alignSelf: 'center' }}>
              {filteredSorted.length} result{filteredSorted.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Table header */}
          <div className="customers-table-header" style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr 0.3fr 0.5fr 0.5fr 0.5fr 0.5fr 0.5fr 0.6fr 0.6fr 0.5fr 0.5fr',
            gap: 6, padding: '10px 16px', marginBottom: 4,
          }}>
            <SortHeader label="Name" sortKey="lastName" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>HP</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>Services</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>Tier</div>
            <SortHeader label="$/Mo" sortKey="monthlyRate" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>Balance</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>City</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>Next Svc</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>Stage</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8 }}>Rating</div>
            <div />
          </div>

          {/* Rows */}
          {filteredSorted.length === 0 ? (
            <div style={{
              padding: 48, textAlign: 'center', color: D.muted, fontFamily: 'DM Sans, sans-serif',
              background: D.card, borderRadius: 12, border: `1px solid ${D.border}`,
            }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>&#128101;</div>
              <div style={{ fontSize: 15 }}>No customers found</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Try adjusting your filters or add a new customer</div>
            </div>
          ) : (
            filteredSorted.map(c => {
              const icons = serviceIcons(c);
              const computedTier = c.serviceCount != null ? tierFromServices(c.serviceCount) : null;
              const hsColor = c.healthScore != null ? (c.healthScore >= 70 ? D.green : c.healthScore >= 40 ? D.amber : D.red) : D.border;
              return (
              <div key={c.id} style={{ marginBottom: 6 }}>
                <div
                  className="customers-row-grid"
                  onClick={() => expandCustomer(c.id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.6fr 0.3fr 0.5fr 0.5fr 0.5fr 0.5fr 0.5fr 0.6fr 0.6fr 0.5fr 0.5fr',
                    gap: 6, padding: '12px 16px', alignItems: 'center',
                    background: D.card,
                    border: `1px solid ${D.border}`,
                    borderRadius: 10,
                    cursor: 'pointer', transition: 'border-color 0.15s',
                  }}
                >
                  {/* Name + Phone */}
                  <div>
                    <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 14, fontWeight: 600, color: D.white }}>
                      {c.firstName} {c.lastName}
                    </div>
                    {c.phone ? (
                      <a href={`/admin/communications?phone=${encodeURIComponent(c.phone)}`} onClick={e => e.stopPropagation()} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: D.teal, textDecoration: 'none' }}>{c.phone}</a>
                    ) : (
                      <span style={{ fontSize: 11, color: D.muted }}>{c.email || '--'}</span>
                    )}
                  </div>
                  {/* Health Score Dot */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: hsColor, display: 'inline-block' }} title={c.healthScore != null ? `Health: ${c.healthScore}` : 'No score'} />
                  </div>
                  {/* Services icons */}
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {icons.length > 0 ? icons.map(ic => (
                      <span key={ic.label} title={ic.label} style={{
                        display: 'inline-block', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                        background: `${ic.color}22`, color: ic.color, letterSpacing: 0.3,
                      }}>{ic.icon}</span>
                    )) : <span style={{ fontSize: 11, color: D.muted }}>--</span>}
                  </div>
                  {/* Tier */}
                  <div><TierBadge tier={detectTier(c)} /></div>
                  {/* Monthly rate */}
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: c.monthlyRate ? D.green : D.muted }}>
                    {c.monthlyRate ? `$${c.monthlyRate}` : '--'}
                  </div>
                  {/* Balance Owed */}
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: (c.balanceOwed || 0) > 0 ? D.red : D.muted }}>
                    {(c.balanceOwed || 0) > 0 ? `$${parseFloat(c.balanceOwed).toFixed(0)}` : '--'}
                  </div>
                  {/* City */}
                  <div style={{ fontSize: 11, color: D.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.city || '--'}</div>
                  {/* Next service date */}
                  <div style={{ fontSize: 11, color: c.nextServiceDate ? D.teal : D.muted }}>
                    {c.nextServiceDate ? new Date(c.nextServiceDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '--'}
                  </div>
                  {/* Stage */}
                  <div><StageBadge stage={c.pipelineStage} /></div>
                  {/* Satisfaction / Rating */}
                  <div>
                    {c.lastRating != null ? (
                      <span style={{ fontSize: 12, color: c.lastRating >= 4 ? D.green : c.lastRating >= 3 ? D.amber : D.red, fontWeight: 600 }}>
                        {'*'.repeat(c.lastRating)}{c.lastRating >= 4 ? '' : ''}
                      </span>
                    ) : c.leadScore != null ? (
                      <ScoreDot score={c.leadScore} />
                    ) : (
                      <span style={{ fontSize: 11, color: D.muted }}>--</span>
                    )}
                  </div>
                  {/* Actions: Edit + Delete */}
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={e => { e.stopPropagation(); startEdit(c); }} style={{
                      padding: '4px 8px', background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6,
                      color: D.muted, fontSize: 10, cursor: 'pointer',
                    }}>Edit</button>
                    <button onClick={e => { e.stopPropagation(); handleDeleteCustomer(c.id, `${c.firstName} ${c.lastName}`); }} style={{
                      padding: '4px 6px', background: 'transparent', border: `1px solid ${D.red}44`, borderRadius: 6,
                      color: D.red, fontSize: 10, cursor: 'pointer', opacity: 0.7,
                    }}>x</button>
                  </div>
                </div>

                {/* Inline edit modal */}
                {editingId === c.id && (
                  <div style={{ background: D.card, border: `1px solid ${D.teal}`, borderRadius: 10, padding: 20, marginTop: -2 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Edit Customer</div>
                    <div className="customer-edit-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
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
                        <select value={editForm.tier || ''} onChange={e => setEditForm(p => ({ ...p, tier: e.target.value || null }))} style={{ width: '100%', padding: '8px 10px', background: '#0f172a', border: `1px solid ${D.border}`, borderRadius: 6, color: D.text, fontSize: 13, outline: 'none', cursor: 'pointer' }}>
                          <option value="">No Plan</option><option value="Bronze">Bronze (0%)</option><option value="Silver">Silver (10%)</option><option value="Gold">Gold (15%)</option><option value="Platinum">Platinum (20%)</option>
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
            );})
          )}
          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 20, padding: '12px 0' }}>
              <button onClick={() => { const p = Math.max(1, page - 1); setPage(p); loadCustomers(p); }} disabled={page <= 1} style={{
                padding: '8px 18px', borderRadius: 8, border: `1px solid ${D.border}`, background: 'transparent',
                color: page <= 1 ? D.border : D.muted, fontSize: 13, cursor: page <= 1 ? 'default' : 'pointer',
              }}>← Previous</button>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: D.muted }}>
                Page {page} of {totalPages} ({totalCustomers} total)
              </span>
              <button onClick={() => { const p = Math.min(totalPages, page + 1); setPage(p); loadCustomers(p); }} disabled={page >= totalPages} style={{
                padding: '8px 18px', borderRadius: 8, border: `1px solid ${D.border}`, background: 'transparent',
                color: page >= totalPages ? D.border : D.muted, fontSize: 13, cursor: page >= totalPages ? 'default' : 'pointer',
              }}>Next →</button>
            </div>
          )}
        </>
      )}

      {/* ====================== MAP VIEW ====================== */}
      {view === 'map' && <CustomerMap customers={customers} onSelect={(c) => { setSelectedCustomer(c); setShowProfile(true); }} />}

      {/* ====================== PIPELINE VIEW ====================== */}
      {view === 'pipeline' && (
        <div className="customers-pipeline-wrap" style={{
          display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 12, WebkitOverflowScrolling: 'touch',
        }}>
          {KANBAN_STAGES.map(key => {
            const stage = STAGE_MAP[key];
            return (
              <PipelineColumn
                key={key}
                stage={stage}
                customers={pipelineGroups[key] || []}
                onDeleteCustomer={() => { loadPipeline(); loadCustomers(); }}
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

      {/* ====================== CUSTOMER 360 PROFILE ====================== */}
      {selected360Id && (
        <Customer360Profile
          customerId={selected360Id}
          onClose={() => setSelected360Id(null)}
        />
      )}
    </div>
  );
}
