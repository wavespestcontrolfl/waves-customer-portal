// client/src/pages/admin/CustomersPage.jsx
//
// Shared-utility module for the V2 admin Customers surface. The V1 page
// component was deleted in the V1→V2 migration; this file is retained
// only for named exports consumed by CustomersPageV2:
//   - CustomerMap                 (lat/lng pins of the directory)
//   - CustomerIntelligenceTab     (AI Advisor)
//   - STAGES / STAGE_MAP / KANBAN_STAGES / LEAD_SOURCES / TIER_COLORS
//   - PipelineColumn              (legacy named export)
//
// Endpoints these helpers are wired against (kept in sync with V2):
//   GET    /admin/customers
//   POST   /admin/customers
//   PUT    /admin/customers/:id
//   DELETE /admin/customers/:id
//   GET    /admin/customers/pipeline/view
//
// Audit focus:
// - Reusable exports: any change here affects V2. The named exports
//   above are the public API; touching them needs care.
// - CustomerMap: confirm graceful behavior when a customer has no
//   lat/lng (RentCast-skipped, brand-new builds). Don't render
//   off-map pins.
// - STAGE_MAP / KANBAN_STAGES export shape: any consumer (V2,
//   LeadsTabs, IB tools) reads from these. Adding/renaming a stage
//   is a coordinated change.
import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import CallBridgeLink from '../../components/admin/CallBridgeLink';
import HorizontalScroll from '../../components/HorizontalScroll';
import useIsMobile from '../../hooks/useIsMobile';
import { CustomerHealthSection } from './CustomerHealthTabs';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', text: '#334155', muted: '#64748B', white: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };

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
  { key: 'estimate_viewed', label: 'Est. Viewed', color: D.amber, bg: D.amber, textColor: '#FFFFFF' },
  { key: 'follow_up', label: 'Follow Up', color: '#7C3AED', bg: `${'#7C3AED'}22` },
  { key: 'won', label: 'Won', color: D.green, bg: `${D.green}22` },
  { key: 'active_customer', label: 'Active', color: D.green, bg: D.green, textColor: D.white },
  { key: 'at_risk', label: 'At Risk', color: D.red, bg: `${D.red}22`, pulse: true },
  { key: 'churned', label: 'Churned', color: D.red, bg: `${D.red}33` },
  { key: 'lost', label: 'Lost', color: D.muted, bg: `${D.muted}22` },
];

const STAGE_MAP = {};
STAGES.forEach(s => { STAGE_MAP[s.key] = s; });

const TIER_COLORS = { Platinum: '#7C3AED', Gold: D.amber, Silver: '#64748B', Bronze: '#cd7f32', 'One-Time': '#0A7EC2' };

const LEAD_SOURCES = ['referral', 'google', 'facebook', 'nextdoor', 'website', 'door_knock', 'yelp', 'other'];

// V2 re-uses these constants + sub-panels via named exports (see end of file).

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
  if (!tier) return <span style={{ padding: '2px 8px', borderRadius: 9999, fontSize: 10, fontWeight: 700, border: `1px solid ${D.muted}`, color: D.muted, letterSpacing: 0.5, textTransform: 'uppercase' }}>No Plan</span>;
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
function QuickAddModal({ onClose, onCreated, onOpenExisting }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', phone: '', email: '', address: '',
    leadSource: 'referral', pipelineStage: 'new_lead', tags: '', notes: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [existingMatch, setExistingMatch] = useState(null);

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.firstName.trim() || !form.lastName.trim()) return;
    setExistingMatch(null);
    setSubmitting(true);
    try {
      const body = {
        ...form,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      };
      const r = await fetch(`${API_BASE}/admin/customers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        if (data.existingCustomerId) {
          setExistingMatch({ id: data.existingCustomerId, name: data.existingCustomerName || 'existing customer' });
          return;
        }
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
        <div style={{ fontSize: 20, fontWeight: 700, color: D.heading, fontFamily: 'DM Sans, sans-serif', marginBottom: 20 }}>
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
          {existingMatch && (
            <div style={{
              marginBottom: 16, padding: '12px 14px', borderRadius: 8,
              background: '#FEF7E0', border: `1px solid ${D.amber}`, color: D.heading,
              fontSize: 14, fontFamily: 'DM Sans, sans-serif',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
            }}>
              <span>Phone already on file for <strong>{existingMatch.name}</strong>.</span>
              <button type="button" onClick={() => { onOpenExisting?.(existingMatch.id); onClose(); }} style={{
                padding: '6px 14px', background: D.teal, color: '#fff', border: 'none', borderRadius: 6,
                fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'DM Sans, sans-serif',
              }}>Open profile</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={{
              padding: '10px 20px', background: 'transparent', border: `1px solid ${D.border}`, color: D.muted,
              borderRadius: 8, fontSize: 14, fontFamily: 'DM Sans, sans-serif', cursor: 'pointer',
            }}>Cancel</button>
            <button type="submit" disabled={submitting} style={{
              padding: '10px 24px', background: D.teal, color: '#fff', border: 'none', borderRadius: 8,
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
        <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 4 }}>
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
            }} style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: D.red, color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
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
          <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, fontFamily: 'DM Sans, sans-serif' }}>{stage.label}</div>
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
    try {
      await adminFetch('/admin/customers/intelligence/scan', { method: 'POST', body: '{}' });
      const d = await adminFetch('/admin/customers/intelligence');
      setData(d);
    } catch (e) { console.error('Scan failed:', e); }
    setScanning(false);
  };

  const handleApprove = async (outreachId) => {
    try {
      await adminFetch(`/admin/customers/intelligence/retention/${outreachId}/approve`, { method: 'PUT', body: JSON.stringify({ approvedBy: 'admin' }) });
      const d = await adminFetch('/admin/customers/intelligence');
      setData(d);
    } catch (e) { console.error('Approve failed:', e); }
  };

  const handleSkip = async (outreachId) => {
    try {
      await adminFetch(`/admin/customers/intelligence/retention/${outreachId}/skip`, { method: 'PUT', body: JSON.stringify({}) });
      const d = await adminFetch('/admin/customers/intelligence');
      setData(d);
    } catch (e) { console.error('Skip failed:', e); }
  };

  const handleUpsellStatus = async (upsellId, status) => {
    try {
      await adminFetch(`/admin/customers/intelligence/upsells/${upsellId}`, { method: 'PUT', body: JSON.stringify({ status }) });
      const d = await adminFetch('/admin/customers/intelligence');
      setData(d);
    } catch (e) { console.error('Upsell update failed:', e); }
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
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Customer Health Overview</div>
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
                    <span style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{c.first_name} {c.last_name}</span>
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
              <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 4 }}>
                {o.first_name} {o.last_name} — {o.outreach_type?.toUpperCase()} ({o.outreach_strategy?.replace(/_/g, ' ')})
              </div>
              <div style={{ fontSize: 12, color: D.text, lineHeight: 1.6, marginBottom: 8, padding: '8px 10px', background: D.card, borderRadius: 6, fontStyle: 'italic' }}>
                "{o.message_content}"
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => handleApprove(o.id)} style={{ padding: '5px 12px', borderRadius: 5, border: 'none', background: D.green, color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                  {o.outreach_type === 'sms' ? '✅ Approve & Send' : '✅ Approve & Call'}
                </button>
                <button style={{ padding: '5px 12px', borderRadius: 5, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 11, cursor: 'pointer' }}>✏️ Edit</button>
                <button onClick={() => handleSkip(o.id)} style={{ padding: '5px 12px', borderRadius: 5, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 11, cursor: 'pointer' }}>⏭ Skip</button>
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
                    <td style={{ padding: '8px 12px', fontSize: 13, color: D.heading, borderBottom: `1px solid ${D.border}` }}>{u.first_name} {u.last_name}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: D.muted, borderBottom: `1px solid ${D.border}` }}>{u.waveguard_tier}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: D.teal, borderBottom: `1px solid ${D.border}` }}>{(u.recommended_service || '').replace(/_/g, ' ')}</td>
                    <td style={{ padding: '8px 12px', fontSize: 13, color: D.green, textAlign: 'right', fontFamily: MONO, borderBottom: `1px solid ${D.border}` }}>+${parseFloat(u.estimated_monthly_value || 0).toFixed(0)}</td>
                    <td style={{ padding: '8px 12px', fontSize: 12, color: D.muted, textAlign: 'right', fontFamily: MONO, borderBottom: `1px solid ${D.border}` }}>{Math.round(parseFloat(u.confidence || 0) * 100)}%</td>
                    <td style={{ padding: '8px 12px', textAlign: 'center', borderBottom: `1px solid ${D.border}` }}>
                      <button onClick={() => handleUpsellStatus(u.id, 'pitched')} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', background: D.teal, color: '#fff', fontSize: 10, cursor: 'pointer' }}>Pitch</button>
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
          <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>📊 Retention Metrics (Last 30 Days)</div>
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
          <div key={item.id || `${item.type}-${item.date}-${i}`} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: i < items.length - 1 ? `1px solid ${D.border}22` : 'none', fontSize: 12 }}>
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
const TIER_PIN_COLORS = { Platinum: '#E5E4E2', Gold: '#FDD835', Silver: '#90CAF9', Bronze: '#CD7F32', 'One-Time': '#0A7EC2' };
const STAGE_PIN_COLORS = { active_customer: '#16A34A', won: '#16A34A', new_lead: '#0A7EC2', contacted: '#0A7EC2', estimate_sent: '#F0A500', at_risk: '#C0392B', churned: '#C0392B' };

function CustomerMap({ customers: _ignored, onSelect }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [filterTier, setFilterTier] = useState('all');
  const [filterStage, setFilterStage] = useState('all');
  const [stats, setStats] = useState({ total: 0, mapped: 0, unmapped: 0 });
  const [selectedPin, setSelectedPin] = useState(null);
  const [customers, setCustomers] = useState([]);

  // Load ALL customers for the map (not paginated)
  useEffect(() => {
    adminFetch('/admin/customers?limit=5000')
      .then(data => setCustomers(Array.isArray(data) ? data : data.customers || []))
      .catch(() => {});
  }, []);

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
      const color = TIER_PIN_COLORS[c.tier] || STAGE_PIN_COLORS[c.pipelineStage] || '#0A7EC2';
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
        infoWindow.close();
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
        <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 4 }}>Google Maps API Key Required</div>
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
        <select value={filterTier} onChange={e => setFilterTier(e.target.value)} style={{ padding: '6px 10px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 12 }}>
          <option value="all">All Tiers</option>
          <option value="Platinum">Platinum</option>
          <option value="Gold">Gold</option>
          <option value="Silver">Silver</option>
          <option value="Bronze">Bronze</option>
          <option value="One-Time">One-Time</option>
          <option value="none">No Plan</option>
        </select>
        <select value={filterStage} onChange={e => setFilterStage(e.target.value)} style={{ padding: '6px 10px', background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 12 }}>
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
                <div style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>{selectedPin.firstName} {selectedPin.lastName}</div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{selectedPin.address} {selectedPin.city}</div>
                <div style={{ fontSize: 12, color: D.muted }}>{selectedPin.phone}</div>
                {selectedPin.tier && <div style={{ fontSize: 11, color: TIER_PIN_COLORS[selectedPin.tier] || D.teal, fontWeight: 600, marginTop: 4 }}>WaveGuard {selectedPin.tier}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => onSelect(selectedPin)} style={{ padding: '6px 12px', background: D.teal, color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>View</button>
                <button onClick={() => setSelectedPin(null)} style={{ padding: '6px 8px', background: 'transparent', color: D.muted, border: `1px solid ${D.border}`, borderRadius: 6, fontSize: 14, cursor: 'pointer' }}>✕</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// Named exports consumed by CustomersPageV2 (the V1 page itself was
// retired in the V1→V2 migration). These sub-panels and constants are
// the public API of this shared-utility module — touching them needs
// care.
export {
  STAGES,
  STAGE_MAP,
  KANBAN_STAGES,
  TIER_COLORS,
  LEAD_SOURCES,
  CustomerMap,
  PipelineColumn,
  CustomerIntelligenceTab,
};
