import React, { useState, useEffect, useCallback } from 'react';

const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500',
  red: '#C0392B', purple: '#7C3AED',
  text: '#334155', muted: '#64748B', white: '#fff',
  input: '#FFFFFF',
};

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const af = (p, o = {}) =>
  fetch(`${API_BASE}${p}`, {
    ...o,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...o.headers,
    },
  }).then(r => r.json());

// ── Category tabs ──
const TABS = [
  { key: 'global', label: 'Global Constants', icon: '⚙️' },
  { key: 'zone', label: 'Zones', icon: '📍' },
  { key: 'lawn', label: 'Lawn Care', icon: '🌿' },
  { key: 'pest', label: 'Pest Control', icon: '🪲' },
  { key: 'tree_shrub', label: 'Tree & Shrub', icon: '🌳' },
  { key: 'palm', label: 'Palm Injection', icon: '🌴' },
  { key: 'mosquito', label: 'Mosquito', icon: '🦟' },
  { key: 'termite', label: 'Termite', icon: '🐛' },
  { key: 'rodent', label: 'Rodent', icon: '🐀' },
  { key: 'one_time', label: 'One-Time', icon: '⚡' },
  { key: 'waveguard', label: 'WaveGuard', icon: '🛡️' },
  { key: 'products', label: 'Products', icon: '📦' },
  { key: 'proposals', label: 'Proposals', icon: '📋' },
  { key: 'changelog', label: 'Changelog', icon: '📜' },
];

// Category pill color map for changelog entries
const CATEGORY_COLORS = {
  bug:            '#C0392B', // red
  leak:           '#F0A500', // amber
  rule:           '#0A7EC2', // blue
  cost:           '#16A34A', // green
  architecture:   '#7C3AED', // purple
  documentation:  '#64748B', // gray
  infrastructure: '#0EA5E9', // teal
};

// ── Changelog Tab ──
function ChangelogTab() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    setLoading(true);
    const qs = filter === 'all' ? '' : `?category=${encodeURIComponent(filter)}`;
    af(`/admin/pricing-config/changelog${qs}`)
      .then(d => { setEntries(d.entries || []); setLoading(false); })
      .catch(() => { setEntries([]); setLoading(false); });
  }, [filter]);

  const formatDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const catPill = (category) => {
    const color = CATEGORY_COLORS[category] || D.muted;
    return (
      <span style={{
        fontSize: 10, padding: '2px 8px', borderRadius: 12, fontWeight: 700,
        background: `${color}18`, color, border: `1px solid ${color}55`,
        textTransform: 'uppercase', letterSpacing: 0.3,
      }}>{category}</span>
    );
  };

  const filterOptions = ['all', 'bug', 'leak', 'rule', 'cost', 'architecture', 'documentation', 'infrastructure'];

  return (
    <div style={{ background: D.card, borderRadius: 12, border: `1px solid ${D.border}`, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>Pricing Changelog</div>
        <label style={{ fontSize: 12, color: D.muted }}>
          Filter
          <select value={filter} onChange={e => setFilter(e.target.value)} style={{
            marginLeft: 8, padding: '6px 10px', background: D.input, border: `1px solid ${D.border}`,
            borderRadius: 6, color: '#0F172A', fontSize: 12, outline: 'none',
          }}>
            {filterOptions.map(c => <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>)}
          </select>
        </label>
      </div>

      {loading ? (
        <div style={{ color: D.muted, padding: 40, textAlign: 'center', fontSize: 13 }}>Loading changelog...</div>
      ) : entries.length === 0 ? (
        <div style={{ color: D.muted, padding: 40, textAlign: 'center', fontSize: 13 }}>
          No changelog entries{filter !== 'all' ? ` for category "${filter}"` : ''} yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700, width: 150 }}>Changed At</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700, width: 120 }}>Version</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700, width: 130 }}>Category</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Summary</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700, width: 160 }}>Changed By</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => {
                const isOpen = expandedId === e.id;
                return (
                  <React.Fragment key={e.id}>
                    <tr
                      onClick={() => setExpandedId(isOpen ? null : e.id)}
                      style={{ borderBottom: `1px solid ${D.border}22`, cursor: 'pointer', background: isOpen ? `${D.teal}08` : 'transparent' }}
                    >
                      <td style={{ padding: '10px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: D.text }}>{formatDate(e.changed_at)}</td>
                      <td style={{ padding: '10px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: D.text }}>
                        {e.version_from}{e.version_from !== e.version_to ? ` → ${e.version_to}` : ''}
                      </td>
                      <td style={{ padding: '10px' }}>{catPill(e.category)}</td>
                      <td style={{ padding: '10px', color: '#0F172A', fontSize: 13 }}>{e.summary}</td>
                      <td style={{ padding: '10px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: D.muted }}>{e.changed_by}</td>
                    </tr>
                    {isOpen && (
                      <tr style={{ background: `${D.teal}06` }}>
                        <td colSpan={5} style={{ padding: '14px 16px', borderBottom: `1px solid ${D.border}22` }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Rationale</div>
                          <div style={{ fontSize: 13, color: '#0F172A', lineHeight: 1.5, marginBottom: 14 }}>{e.rationale}</div>

                          {Array.isArray(e.affected_services) && e.affected_services.length > 0 && (
                            <>
                              <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Affected Services</div>
                              <div style={{ fontSize: 12, color: D.text, marginBottom: 14, fontFamily: "'JetBrains Mono', monospace" }}>
                                {e.affected_services.join(', ')}
                              </div>
                            </>
                          )}

                          {(e.before_value != null || e.after_value != null) && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Before</div>
                                <pre style={{ fontSize: 11, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6, padding: 10, margin: 0, overflow: 'auto', fontFamily: "'JetBrains Mono', monospace", color: D.text }}>
                                  {e.before_value != null ? JSON.stringify(e.before_value, null, 2) : '—'}
                                </pre>
                              </div>
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>After</div>
                                <pre style={{ fontSize: 11, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 6, padding: 10, margin: 0, overflow: 'auto', fontFamily: "'JetBrains Mono', monospace", color: D.text }}>
                                  {e.after_value != null ? JSON.stringify(e.after_value, null, 2) : '—'}
                                </pre>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Proposals Tab ──
function ProposalsTab() {
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [selected, setSelected] = useState(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

  const loadProposals = useCallback(() => {
    setLoading(true);
    af(`/admin/pricing-proposals?status=${encodeURIComponent(statusFilter)}&limit=50`)
      .then(d => { setProposals(d.proposals || []); setLoading(false); })
      .catch(() => { setProposals([]); setLoading(false); });
  }, [statusFilter]);

  useEffect(() => { loadProposals(); }, [loadProposals]);

  const formatDate = (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const formatValue = (v) => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  const pctBadge = (pct) => {
    if (pct == null) return null;
    const n = Number(pct);
    const color = Math.abs(n) >= 10 ? D.amber : D.muted;
    return (
      <span style={{
        fontSize: 10, padding: '2px 8px', borderRadius: 12, fontWeight: 700,
        background: `${color}18`, color, border: `1px solid ${color}55`,
        fontFamily: "'JetBrains Mono', monospace",
      }}>{n > 0 ? '+' : ''}{n.toFixed(1)}%</span>
    );
  };

  const statusPill = (status) => {
    const color = status === 'pending' ? D.amber : status === 'approved' ? D.green : status === 'rejected' ? D.red : D.muted;
    return (
      <span style={{
        fontSize: 10, padding: '2px 8px', borderRadius: 12, fontWeight: 700,
        background: `${color}18`, color, border: `1px solid ${color}55`,
        textTransform: 'uppercase', letterSpacing: 0.3,
      }}>{status}</span>
    );
  };

  const submitAction = async (action) => {
    if (!selected) return;
    setSubmitting(true);
    try {
      const res = await af(`/admin/pricing-proposals/${selected.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ review_notes: reviewNotes || null }),
      });
      if (res && res.success) {
        setToast({ kind: 'success', msg: action === 'approve' ? `Proposal ${selected.id} approved. Changelog id=${res.changelog_id}. Engine caches busted.` : `Proposal ${selected.id} rejected.` });
        setSelected(null);
        setReviewNotes('');
        loadProposals();
      } else {
        setToast({ kind: 'error', msg: res?.error || 'Action failed' });
      }
    } catch (err) {
      setToast({ kind: 'error', msg: err.message || 'Action failed' });
    }
    setSubmitting(false);
    setTimeout(() => setToast(null), 5000);
  };

  const statusOptions = ['pending', 'approved', 'rejected', 'all'];

  return (
    <div style={{ background: D.card, borderRadius: 12, border: `1px solid ${D.border}`, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>Pricing Proposals</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {statusOptions.map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                border: `1px solid ${statusFilter === s ? D.teal : D.border}`,
                background: statusFilter === s ? D.teal : 'transparent',
                color: statusFilter === s ? D.white : D.muted,
                cursor: 'pointer', textTransform: 'capitalize',
              }}
            >{s}</button>
          ))}
        </div>
      </div>

      {toast && (
        <div style={{
          padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 12, fontWeight: 600,
          background: toast.kind === 'success' ? `${D.green}18` : `${D.red}18`,
          color: toast.kind === 'success' ? D.green : D.red,
          border: `1px solid ${toast.kind === 'success' ? D.green : D.red}55`,
        }}>{toast.msg}</div>
      )}

      {loading ? (
        <div style={{ color: D.muted, padding: 40, textAlign: 'center', fontSize: 13 }}>Loading proposals...</div>
      ) : proposals.length === 0 ? (
        <div style={{ color: D.muted, padding: 40, textAlign: 'center', fontSize: 13 }}>
          No {statusFilter === 'all' ? '' : statusFilter} proposals.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Config Key</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Change</th>
                <th style={{ padding: '8px 10px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>% Δ</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Source</th>
                <th style={{ padding: '8px 10px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Status</th>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Created</th>
                <th style={{ padding: '8px 10px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map(p => (
                <tr key={p.id} style={{ borderBottom: `1px solid ${D.border}22`, cursor: 'pointer' }}
                    onClick={() => { setSelected(p); setReviewNotes(p.review_notes || ''); }}>
                  <td style={{ padding: '8px 10px', color: '#0F172A', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>{p.config_key}</td>
                  <td style={{ padding: '8px 10px', color: D.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                    <span style={{ color: D.muted }}>{formatValue(p.current_value)}</span>
                    <span style={{ margin: '0 6px', color: D.muted }}>→</span>
                    <span style={{ color: '#0F172A', fontWeight: 600 }}>{formatValue(p.proposed_value)}</span>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{pctBadge(p.pct_change)}</td>
                  <td style={{ padding: '8px 10px', color: D.muted, fontSize: 11 }}>{p.trigger_source || '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>{statusPill(p.status)}</td>
                  <td style={{ padding: '8px 10px', color: D.muted, fontSize: 11 }}>{formatDate(p.created_at)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                    {p.status === 'pending' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelected(p); setReviewNotes(p.review_notes || ''); }}
                        style={{
                          padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
                          fontSize: 11, fontWeight: 600, background: D.teal, color: D.white,
                        }}
                      >Review</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div onClick={() => !submitting && setSelected(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 50,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: D.card, borderRadius: 12, border: `1px solid ${D.border}`,
            padding: 24, maxWidth: 640, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>
                Proposal #{selected.id}
              </div>
              {statusPill(selected.status)}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 12px', fontSize: 12, marginBottom: 16 }}>
              <div style={{ color: D.muted, fontWeight: 600 }}>Config Key</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: '#0F172A' }}>{selected.config_key}</div>

              <div style={{ color: D.muted, fontWeight: 600 }}>Current</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: D.text }}>{formatValue(selected.current_value)}</div>

              <div style={{ color: D.muted, fontWeight: 600 }}>Proposed</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", color: '#0F172A', fontWeight: 600 }}>{formatValue(selected.proposed_value)}</div>

              <div style={{ color: D.muted, fontWeight: 600 }}>% Change</div>
              <div>{pctBadge(selected.pct_change) || <span style={{ color: D.muted }}>—</span>}</div>

              <div style={{ color: D.muted, fontWeight: 600 }}>Source</div>
              <div style={{ color: D.text }}>{selected.trigger_source || '—'}</div>

              <div style={{ color: D.muted, fontWeight: 600 }}>Created</div>
              <div style={{ color: D.text }}>{formatDate(selected.created_at)}</div>

              {selected.reviewed_at && (
                <>
                  <div style={{ color: D.muted, fontWeight: 600 }}>Reviewed</div>
                  <div style={{ color: D.text }}>{formatDate(selected.reviewed_at)} by tech {selected.reviewed_by}</div>
                </>
              )}
            </div>

            {selected.evidence && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: D.muted, fontWeight: 600, marginBottom: 4 }}>Evidence</div>
                <pre style={{ background: D.bg, padding: 10, borderRadius: 6, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: D.text, overflowX: 'auto', margin: 0, maxHeight: 160 }}>
                  {JSON.stringify(typeof selected.evidence === 'string' ? JSON.parse(selected.evidence) : selected.evidence, null, 2)}
                </pre>
              </div>
            )}

            {selected.price_impact && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: D.muted, fontWeight: 600, marginBottom: 4 }}>Price Impact</div>
                <pre style={{ background: D.bg, padding: 10, borderRadius: 6, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: D.text, overflowX: 'auto', margin: 0, maxHeight: 160 }}>
                  {JSON.stringify(typeof selected.price_impact === 'string' ? JSON.parse(selected.price_impact) : selected.price_impact, null, 2)}
                </pre>
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: D.muted, fontWeight: 600, marginBottom: 4 }}>Review Notes</div>
              <textarea
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                disabled={selected.status !== 'pending' || submitting}
                placeholder="Optional notes captured with approval/rejection (included in changelog rationale on approve)"
                style={{
                  width: '100%', minHeight: 80, padding: 10, borderRadius: 6,
                  border: `1px solid ${D.border}`, background: D.input, color: '#0F172A',
                  fontSize: 12, fontFamily: "'DM Sans', sans-serif", resize: 'vertical', outline: 'none',
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => !submitting && setSelected(null)}
                disabled={submitting}
                style={{
                  padding: '8px 16px', borderRadius: 6, border: `1px solid ${D.border}`,
                  background: D.white, color: D.text, fontSize: 12, fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                }}
              >Close</button>
              {selected.status === 'pending' && (
                <>
                  <button
                    onClick={() => { if (window.confirm(`Reject proposal #${selected.id}? This cannot be undone.`)) submitAction('reject'); }}
                    disabled={submitting}
                    style={{
                      padding: '8px 16px', borderRadius: 6, border: 'none',
                      background: D.red, color: D.white, fontSize: 12, fontWeight: 700,
                      cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.6 : 1,
                    }}
                  >Reject</button>
                  <button
                    onClick={() => { if (window.confirm(`Approve proposal #${selected.id}?\n\nThis will:\n• UPDATE pricing_config (${selected.config_key})\n• INSERT pricing_changelog entry\n• Bust engine caches (takes effect immediately)`)) submitAction('approve'); }}
                    disabled={submitting}
                    style={{
                      padding: '8px 16px', borderRadius: 6, border: 'none',
                      background: D.green, color: D.white, fontSize: 12, fontWeight: 700,
                      cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.6 : 1,
                    }}
                  >{submitting ? 'Working...' : 'Approve'}</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Reusable inline-edit cell ──
function EditCell({ value, onSave, type = 'number', width = 70 }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { onSave(type === 'number' ? Number(val) : val); setEditing(false); }}
        onKeyDown={e => { if (e.key === 'Enter') { onSave(type === 'number' ? Number(val) : val); setEditing(false); } if (e.key === 'Escape') setEditing(false); }}
        style={{ width, padding: '4px 6px', background: D.input, border: `1px solid ${D.teal}`, borderRadius: 4, color: '#0F172A', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right', outline: 'none' }}
      />
    );
  }
  return (
    <span
      onClick={() => { setVal(value); setEditing(true); }}
      style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 4, fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: '#0F172A', display: 'inline-block', minWidth: width, textAlign: 'right' }}
      title="Click to edit"
    >
      {typeof value === 'number' ? (value < 1 && value > 0 ? `${(value * 100).toFixed(1)}%` : value.toLocaleString(undefined, { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 4 })) : value}
    </span>
  );
}

// ── Config card for key-value JSON data ──
function ConfigCard({ config, onUpdate }) {
  const data = config.data;
  const isSimple = typeof data === 'object' && !Array.isArray(data) && data !== null;
  const [expanded, setExpanded] = useState(false);
  const [rawEdit, setRawEdit] = useState(false);
  const [rawText, setRawText] = useState('');
  const [saving, setSaving] = useState(false);

  const handleFieldUpdate = async (key, newVal) => {
    const updated = { ...data, [key]: newVal };
    setSaving(true);
    await af(`/admin/pricing-config/${config.config_key}`, { method: 'PUT', body: JSON.stringify({ data: updated }) });
    onUpdate(config.config_key, updated);
    setSaving(false);
  };

  const handleRawSave = async () => {
    try {
      const parsed = JSON.parse(rawText);
      setSaving(true);
      await af(`/admin/pricing-config/${config.config_key}`, { method: 'PUT', body: JSON.stringify({ data: parsed }) });
      onUpdate(config.config_key, parsed);
      setRawEdit(false);
      setSaving(false);
    } catch (e) { alert('Invalid JSON: ' + e.message); }
  };

  // Render nested objects (like WaveGuard tiers)
  const renderValue = (key, val) => {
    if (Array.isArray(val)) {
      return (
        <div key={key} style={{ marginBottom: 8, paddingLeft: 12, borderLeft: `2px solid ${D.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.teal, marginBottom: 4, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</div>
          {renderArray(val, key)}
        </div>
      );
    }
    if (typeof val === 'object' && val !== null) {
      return (
        <div key={key} style={{ marginBottom: 8, paddingLeft: 12, borderLeft: `2px solid ${D.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.teal, marginBottom: 4, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</div>
          {Object.entries(val).map(([k, v]) =>
            (typeof v === 'object' && v !== null) ? renderValue(k, v) : (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
                <span style={{ fontSize: 12, color: D.muted, textTransform: 'capitalize' }}>{k.replace(/_/g, ' ')}</span>
                <EditCell value={v} onSave={newV => { const nested = { ...val, [k]: newV }; handleFieldUpdate(key, nested); }} type={typeof v === 'number' ? 'number' : 'text'} />
              </div>
            )
          )}
        </div>
      );
    }
    return (
      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${D.border}22` }}>
        <span style={{ fontSize: 12, color: D.muted, textTransform: 'capitalize' }}>{key.replace(/_/g, ' ')}</span>
        <EditCell value={val} onSave={newV => handleFieldUpdate(key, newV)} type={typeof val === 'number' ? 'number' : 'text'} />
      </div>
    );
  };

  // Handle array data (breakpoints, brackets)
  const renderArray = (arr, parentKey = null) => {
    if (arr.length === 0) return <div style={{ color: D.muted, fontSize: 12 }}>Empty</div>;
    const first = arr[0];
    if (typeof first === 'object' && !Array.isArray(first)) {
      const cols = Object.keys(first);
      const updateCell = (rowIdx, col, newVal) => {
        const next = arr.map((r, i) => i === rowIdx ? { ...r, [col]: newVal } : r);
        if (parentKey) handleFieldUpdate(parentKey, next);
      };
      const deleteRow = (rowIdx) => {
        const next = arr.filter((_, i) => i !== rowIdx);
        if (parentKey) handleFieldUpdate(parentKey, next);
      };
      const addRow = () => {
        const blank = Object.fromEntries(cols.map(c => [c, typeof first[c] === 'number' ? 0 : '']));
        const next = [...arr, blank];
        if (parentKey) handleFieldUpdate(parentKey, next);
      };
      return (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {cols.map(c => <th key={c} style={{ padding: '4px 8px', textAlign: 'left', color: D.muted, borderBottom: `1px solid ${D.border}`, fontSize: 11, textTransform: 'capitalize' }}>{c.replace(/_/g, ' ')}</th>)}
                {parentKey && <th style={{ borderBottom: `1px solid ${D.border}`, width: 30 }} />}
              </tr>
            </thead>
            <tbody>
              {arr.map((row, i) => (
                <tr key={i}>
                  {cols.map(c => (
                    <td key={c} style={{ padding: '3px 8px', color: '#0F172A', fontFamily: "'JetBrains Mono', monospace" }}>
                      {parentKey ? (
                        <EditCell value={row[c]} onSave={v => updateCell(i, c, v)} type={typeof row[c] === 'number' ? 'number' : 'text'} width={70} />
                      ) : (
                        typeof row[c] === 'number' ? row[c].toLocaleString() : String(row[c])
                      )}
                    </td>
                  ))}
                  {parentKey && (
                    <td style={{ padding: '3px 4px', textAlign: 'right' }}>
                      <button onClick={() => deleteRow(i)} title="Delete row" style={{ background: 'transparent', border: 'none', color: D.red, cursor: 'pointer', fontSize: 14, padding: '0 4px' }}>×</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {parentKey && (
            <button onClick={addRow} style={{ marginTop: 6, fontSize: 11, padding: '3px 10px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'transparent', color: D.teal, cursor: 'pointer' }}>+ Add row</button>
          )}
        </div>
      );
    }
    // Array of arrays (bracket data)
    return <pre style={{ fontSize: 11, color: D.muted, margin: 0, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'pre-wrap' }}>{JSON.stringify(arr, null, 2)}</pre>;
  };

  return (
    <div style={{ background: D.card, borderRadius: 10, border: `1px solid ${D.border}`, marginBottom: 8, overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', cursor: 'pointer' }}
      >
        <div>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{config.name}</span>
          {saving && <span style={{ marginLeft: 8, fontSize: 10, color: D.green }}>Saving...</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {expanded && (
            <button
              onClick={e => { e.stopPropagation(); setRawEdit(!rawEdit); if (!rawEdit) setRawText(JSON.stringify(data, null, 2)); }}
              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, cursor: 'pointer' }}
            >{rawEdit ? 'Structured' : 'Raw JSON'}</button>
          )}
          <span style={{ fontSize: 12, color: D.muted }}>{expanded ? '▼' : '▶'}</span>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: '0 16px 14px' }}>
          {rawEdit ? (
            <div>
              <textarea
                value={rawText}
                onChange={e => setRawText(e.target.value)}
                rows={Math.min(20, rawText.split('\n').length + 1)}
                style={{ width: '100%', padding: 10, background: '#FFFFFF', border: `1px solid ${D.border}`, borderRadius: 8, color: '#0F172A', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button onClick={handleRawSave} disabled={saving} style={{ fontSize: 11, padding: '4px 12px', borderRadius: 4, border: 'none', cursor: 'pointer', background: D.green, color: D.white }}>{saving ? '...' : 'Save'}</button>
                <button onClick={() => setRawEdit(false)} style={{ fontSize: 11, padding: '4px 12px', borderRadius: 4, border: 'none', cursor: 'pointer', background: 'transparent', color: D.muted, border: `1px solid ${D.border}` }}>Cancel</button>
              </div>
            </div>
          ) : isSimple ? (
            <div>{Object.entries(data).map(([k, v]) => renderValue(k, v))}</div>
          ) : Array.isArray(data) ? (
            renderArray(data)
          ) : (
            <pre style={{ fontSize: 11, color: D.muted, margin: 0, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'pre-wrap' }}>{JSON.stringify(data, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Lawn Brackets Tab ──
function LawnBracketsTab() {
  const [tracks, setTracks] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeTrack, setActiveTrack] = useState('st_augustine');
  const [saving, setSaving] = useState(false);
  const tiers = ['basic', 'standard', 'enhanced', 'premium'];
  const trackLabels = { st_augustine: 'St. Augustine', bermuda: 'Bermuda', zoysia: 'Zoysia', bahia: 'Bahia' };

  useEffect(() => {
    af('/admin/pricing-config/lawn-brackets').then(d => { setTracks(d.tracks || {}); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleCellUpdate = async (sqft, tier, newPrice) => {
    const trackData = tracks[activeTrack] || [];
    const updated = trackData.map(r =>
      r.sqft_bracket === sqft && r.tier === tier ? { ...r, monthly_price: newPrice } : r
    );
    setTracks(prev => ({ ...prev, [activeTrack]: updated }));
    setSaving(true);
    await af(`/admin/pricing-config/lawn-brackets/${activeTrack}`, {
      method: 'PUT',
      body: JSON.stringify({ brackets: [{ sqft_bracket: sqft, tier, monthly_price: newPrice }] }),
    });
    setSaving(false);
  };

  if (loading) return <div style={{ color: D.muted, padding: 20 }}>Loading brackets...</div>;

  const trackKeys = Object.keys(tracks);
  if (trackKeys.length === 0) return <div style={{ color: D.muted, padding: 20 }}>No bracket data found. Run the pricing_config migration first.</div>;

  const trackData = tracks[activeTrack] || [];
  // Group by sqft_bracket
  const sqftBrackets = [...new Set(trackData.map(r => r.sqft_bracket))].sort((a, b) => a - b);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {trackKeys.map(tk => (
          <button
            key={tk}
            onClick={() => setActiveTrack(tk)}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: activeTrack === tk ? D.green : D.card,
              color: activeTrack === tk ? D.white : D.muted,
              border: `1px solid ${activeTrack === tk ? D.green : D.border}`,
            }}
          >{trackLabels[tk] || tk}</button>
        ))}
        {saving && <span style={{ fontSize: 11, color: D.green, padding: '6px 0' }}>Saving...</span>}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700 }}>Lawn SqFt</th>
              {tiers.map(t => (
                <th key={t} style={{ padding: '8px 12px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11, fontWeight: 700, textTransform: 'capitalize' }}>
                  {t} ({t === 'basic' ? '4x' : t === 'standard' ? '6x' : t === 'enhanced' ? '9x' : '12x'})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sqftBrackets.map(sqft => (
              <tr key={sqft} style={{ borderBottom: `1px solid ${D.border}22` }}>
                <td style={{ padding: '6px 12px', color: D.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                  {sqft === 0 ? '0' : sqft.toLocaleString()}
                </td>
                {tiers.map(tier => {
                  const row = trackData.find(r => r.sqft_bracket === sqft && r.tier === tier);
                  const price = row ? Number(row.monthly_price) : 0;
                  return (
                    <td key={tier} style={{ padding: '4px 12px', textAlign: 'right' }}>
                      <span style={{ color: D.muted, fontSize: 12 }}>$</span>
                      <EditCell value={price} onSave={v => handleCellUpdate(sqft, tier, v)} width={50} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Discount Rules Tab ──
function DiscountRulesTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    af('/admin/pricing-config/discount-rules').then(d => { setRules(d.rules || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleUpdate = async (serviceKey, field, value) => {
    setRules(prev => prev.map(r => r.service_key === serviceKey ? { ...r, [field]: value } : r));
    await af(`/admin/pricing-config/discount-rules/${serviceKey}`, {
      method: 'PUT',
      body: JSON.stringify({ [field]: value }),
    });
  };

  if (loading) return <div style={{ color: D.muted, padding: 20 }}>Loading...</div>;
  if (rules.length === 0) return <div style={{ color: D.muted, padding: 20 }}>No discount rules found. Run the pricing_config migration.</div>;

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 12 }}>Service Discount Rules</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ padding: '8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Service</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Tier Qualifier</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Max Discount</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Exclude %</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Flat Credit</th>
              <th style={{ padding: '8px', textAlign: 'center', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Min Tier</th>
              <th style={{ padding: '8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.service_key} style={{ borderBottom: `1px solid ${D.border}22` }}>
                <td style={{ padding: '8px', color: D.text, fontWeight: 600, textTransform: 'capitalize', fontSize: 12 }}>
                  {r.service_key.replace(/_/g, ' ')}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={r.tier_qualifier}
                    onChange={e => handleUpdate(r.service_key, 'tier_qualifier', e.target.checked)}
                    style={{ accentColor: D.teal, width: 16, height: 16, cursor: 'pointer' }}
                  />
                </td>
                <td style={{ padding: '8px', textAlign: 'center', fontFamily: "'JetBrains Mono', monospace" }}>
                  {r.max_discount_pct !== null && r.max_discount_pct !== undefined ? (
                    <EditCell value={Number(r.max_discount_pct)} onSave={v => handleUpdate(r.service_key, 'max_discount_pct', v)} width={50} />
                  ) : (
                    <span style={{ color: D.muted, fontSize: 11 }}>—</span>
                  )}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={r.exclude_from_pct_discount}
                    onChange={e => handleUpdate(r.service_key, 'exclude_from_pct_discount', e.target.checked)}
                    style={{ accentColor: D.red, width: 16, height: 16, cursor: 'pointer' }}
                  />
                </td>
                <td style={{ padding: '8px', textAlign: 'center', fontFamily: "'JetBrains Mono', monospace" }}>
                  {r.flat_credit ? (
                    <EditCell value={Number(r.flat_credit)} onSave={v => handleUpdate(r.service_key, 'flat_credit', v)} width={50} />
                  ) : (
                    <span style={{ color: D.muted, fontSize: 11 }}>—</span>
                  )}
                </td>
                <td style={{ padding: '8px', textAlign: 'center', color: D.muted, fontSize: 11, textTransform: 'capitalize' }}>
                  {r.flat_credit_min_tier || '—'}
                </td>
                <td style={{ padding: '8px', color: D.muted, fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.notes || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Products Tab ──
function ProductsTab() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    af('/admin/inventory?limit=200').then(d => { setProducts(d.products || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 20 }}>Loading products...</div>;

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 4 }}>Product Cost Reference</div>
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>
        {products.length} products loaded. Full catalog available under Inventory tab.
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 500, overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead style={{ position: 'sticky', top: 0, background: D.card }}>
            <tr>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Product</th>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Category</th>
              <th style={{ padding: '6px 8px', textAlign: 'left', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Active Ingredient</th>
              <th style={{ padding: '6px 8px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Best Price</th>
              <th style={{ padding: '6px 8px', textAlign: 'right', color: D.muted, borderBottom: `2px solid ${D.border}`, fontSize: 11 }}>Unit Price</th>
            </tr>
          </thead>
          <tbody>
            {products.filter(p => p.best_price > 0).sort((a, b) => (a.category || '').localeCompare(b.category || '')).map(p => (
              <tr key={p.id} style={{ borderBottom: `1px solid ${D.border}22` }}>
                <td style={{ padding: '5px 8px', color: D.text, fontSize: 12 }}>{p.product_name || p.name}</td>
                <td style={{ padding: '5px 8px', color: D.muted, fontSize: 11 }}>{p.category}</td>
                <td style={{ padding: '5px 8px', color: D.muted, fontSize: 11, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.active_ingredient || '—'}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: D.green }}>${Number(p.best_price || 0).toFixed(2)}</td>
                <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: D.muted }}>{p.unit_price ? `$${Number(p.unit_price).toFixed(4)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Audit Log ──
function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    af('/admin/pricing-config/audit-log?limit=30').then(d => { setLogs(d.logs || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (logs.length === 0) return null;

  return (
    <div style={{ marginTop: 24, background: D.card, borderRadius: 10, border: `1px solid ${D.border}`, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', marginBottom: 12 }}>Recent Changes</div>
      {logs.map((l, i) => (
        <div key={i} style={{ fontSize: 11, color: D.muted, padding: '4px 0', borderBottom: `1px solid ${D.border}22` }}>
          <span style={{ color: D.teal }}>{l.config_key}</span>
          <span style={{ margin: '0 6px' }}>changed by</span>
          <span style={{ color: D.text }}>{l.changed_by || 'admin'}</span>
          <span style={{ margin: '0 6px' }}>—</span>
          <span>{new Date(l.changed_at).toLocaleString()}</span>
          {l.reason && <span style={{ marginLeft: 8, color: D.amber }}>({l.reason})</span>}
        </div>
      ))}
    </div>
  );
}

// ── Main Panel ──
export default function PricingLogicPanel() {
  const [activeTab, setActiveTab] = useState('global');
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    af('/admin/pricing-config').then(d => { setConfigs(d.configs || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleConfigUpdate = useCallback((key, newData) => {
    setConfigs(prev => prev.map(c => c.config_key === key ? { ...c, data: newData } : c));
  }, []);

  const filteredConfigs = configs.filter(c => c.category === activeTab);

  return (
    <div>
      {/* Tab strip */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 20, padding: '4px 0', borderBottom: `1px solid ${D.border}` }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '6px 12px', borderRadius: '6px 6px 0 0', fontSize: 11, fontWeight: 600,
              border: 'none', cursor: 'pointer',
              background: activeTab === t.key ? D.teal : 'transparent',
              color: activeTab === t.key ? D.white : D.muted,
              borderBottom: activeTab === t.key ? `2px solid ${D.teal}` : '2px solid transparent',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading pricing configuration...</div>
      ) : (
        <>
          {/* Lawn tab has special bracket grid */}
          {activeTab === 'lawn' && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 12 }}>Monthly Price Brackets</div>
              <LawnBracketsTab />
            </div>
          )}

          {/* WaveGuard tab has discount rules */}
          {activeTab === 'waveguard' && (
            <div style={{ marginBottom: 20 }}>
              <DiscountRulesTab />
              <div style={{ height: 20 }} />
            </div>
          )}

          {/* Products tab */}
          {activeTab === 'products' && <ProductsTab />}

          {/* Changelog tab */}
          {activeTab === 'proposals' && <ProposalsTab />}

          {activeTab === 'changelog' && <ChangelogTab />}

          {/* Config cards for this category */}
          {activeTab !== 'products' && activeTab !== 'changelog' && activeTab !== 'proposals' && filteredConfigs.length > 0 && (
            <div>
              {activeTab !== 'lawn' && activeTab !== 'waveguard' && (
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 12 }}>
                  {TABS.find(t => t.key === activeTab)?.label || activeTab} Configuration
                </div>
              )}
              {activeTab === 'waveguard' && <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 12, marginTop: 12 }}>Tier Configuration</div>}
              {activeTab === 'lawn' && <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 12, marginTop: 12 }}>Lawn Pricing Config</div>}
              {filteredConfigs.map(c => (
                <ConfigCard key={c.config_key} config={c} onUpdate={handleConfigUpdate} />
              ))}
            </div>
          )}

          {activeTab !== 'products' && activeTab !== 'changelog' && activeTab !== 'proposals' && filteredConfigs.length === 0 && activeTab !== 'lawn' && activeTab !== 'waveguard' && (
            <div style={{ color: D.muted, padding: 20, textAlign: 'center', fontSize: 13 }}>
              No configuration data for this category yet. Run the pricing_config migration to seed data.
            </div>
          )}

          {/* Audit log on relevant tabs */}
          {['global', 'waveguard'].includes(activeTab) && <AuditLog />}
        </>
      )}
    </div>
  );
}
