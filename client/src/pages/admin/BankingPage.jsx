import { useState, useEffect, useCallback } from 'react';
import SEOIntelligenceBar from '../../components/admin/SEOIntelligenceBar';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const API = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B', purple: '#7C3AED', text: '#334155', muted: '#64748B', white: '#FFFFFF', heading: '#0F172A', inputBorder: '#CBD5E1' };
const MONO = "'JetBrains Mono', monospace";
const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;

function adminFetch(path, options = {}) {
  return fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function adminFetchRaw(path) {
  return fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
  });
}

const fmtM = (n) => n != null ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '$0.00';
const fmtD = (d) => d ? new Date(d).toLocaleDateString() : '--';

const STATUS_COLORS = { paid: D.green, pending: D.amber, in_transit: '#0A7EC2', failed: D.red };

function Badge({ children, color }) {
  return <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 600, background: `${color || D.muted}22`, color: color || D.muted, textTransform: 'capitalize', letterSpacing: 0.5 }}>{children}</span>;
}

function TabBtn({ active, label, onClick }) {
  return (
    <button onClick={onClick} style={{ background: active ? D.card : 'transparent', border: active ? `1px solid ${D.border}` : '1px solid transparent', borderRadius: 8, padding: '8px 14px', color: active ? D.heading : D.muted, fontSize: 12, cursor: 'pointer', fontWeight: active ? 600 : 400, transition: 'all 0.15s', whiteSpace: 'nowrap', flexShrink: 0, minHeight: 44 }}>
      {label}
    </button>
  );
}

const inputStyle = { background: '#FFFFFF', border: `1px solid ${D.inputBorder}`, borderRadius: 6, padding: '8px 12px', color: D.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };
const thStyle = { fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` };
const tdStyle = { padding: '10px', borderBottom: `1px solid ${D.border}22`, fontSize: 13, color: D.text };

// ═══════════════════════════════════════════════════════════════
// PAYOUTS TAB
// ═══════════════════════════════════════════════════════════════
function PayoutsTab() {
  const [payouts, setPayouts] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [txns, setTxns] = useState({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p) => {
    setLoading(true);
    try {
      const d = await adminFetch(`/admin/banking/payouts?limit=20&page=${p}`);
      setPayouts(d.payouts || []);
      // Use the authoritative `pages` field from the backend instead of guessing
      // from page length (a short first page would otherwise disable Next).
      setHasMore(typeof d.pages === 'number' ? p < d.pages : (d.payouts || []).length === 20);
    } catch (e) { /* no-op */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(page); }, [page, load]);

  const toggleExpand = async (payoutId) => {
    if (expanded === payoutId) { setExpanded(null); return; }
    setExpanded(payoutId);
    if (!txns[payoutId]) {
      try {
        const d = await adminFetch(`/admin/banking/payouts/${payoutId}`);
        setTxns(prev => ({ ...prev, [payoutId]: d.transactions || [] }));
      } catch (e) { setTxns(prev => ({ ...prev, [payoutId]: [] })); }
    }
  };

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Date</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Amount</th>
              <th style={thStyle}>Status</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Transactions</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Fees</th>
              <th style={thStyle}>Arrival</th>
              <th style={thStyle}>Reconciled</th>
            </tr>
          </thead>
          <tbody>
            {payouts.map(p => (
              <>
                <tr key={p.id} onClick={() => toggleExpand(p.id)} style={{ cursor: 'pointer', background: expanded === p.id ? D.bg : 'transparent', transition: 'background 0.15s' }}
                  onMouseEnter={e => { if (expanded !== p.id) e.currentTarget.style.background = `${D.card}88`; }}
                  onMouseLeave={e => { if (expanded !== p.id) e.currentTarget.style.background = 'transparent'; }}>
                  <td style={tdStyle}>{fmtD(p.date || p.created)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO, fontWeight: 700 }}>{fmtM(p.amount)}</td>
                  <td style={tdStyle}><Badge color={STATUS_COLORS[p.status] || D.muted}>{p.status}</Badge></td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO }}>{p.transaction_count ?? '--'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO, color: D.muted }}>{p.fees != null ? fmtM(p.fees) : '--'}</td>
                  <td style={tdStyle}>{fmtD(p.arrival_date)}</td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    {p.reconciled ? <span style={{ color: D.green, fontSize: 16 }}>&#10003;</span> : <span style={{ color: D.muted }}>--</span>}
                  </td>
                </tr>
                {expanded === p.id && (
                  <tr key={`${p.id}-detail`}>
                    <td colSpan={7} style={{ padding: 0, background: D.bg }}>
                      <div style={{ padding: '12px 20px' }}>
                        {!txns[p.id] ? (
                          <div style={{ color: D.muted, fontSize: 12 }}>Loading transactions...</div>
                        ) : txns[p.id].length === 0 ? (
                          <div style={{ color: D.muted, fontSize: 12 }}>No transaction details available</div>
                        ) : (
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ ...thStyle, fontSize: 9 }}>Customer / Type</th>
                                <th style={{ ...thStyle, fontSize: 9 }}>Description</th>
                                <th style={{ ...thStyle, fontSize: 9, textAlign: 'right' }}>Amount</th>
                                <th style={{ ...thStyle, fontSize: 9, textAlign: 'right' }}>Fee</th>
                                <th style={{ ...thStyle, fontSize: 9, textAlign: 'right' }}>Net</th>
                              </tr>
                            </thead>
                            <tbody>
                              {txns[p.id].map((t, i) => {
                                const isFee = t.type === 'stripe_fee' || t.type === 'fee';
                                return (
                                  <tr key={i} style={{ opacity: isFee ? 0.5 : 1 }}>
                                    <td style={{ ...tdStyle, fontSize: 12, color: isFee ? D.muted : D.text }}>{t.customer_name || t.type || '--'}</td>
                                    <td style={{ ...tdStyle, fontSize: 12, color: D.muted }}>{t.description || '--'}</td>
                                    <td style={{ ...tdStyle, fontSize: 12, textAlign: 'right', fontFamily: MONO }}>{fmtM(t.amount)}</td>
                                    <td style={{ ...tdStyle, fontSize: 12, textAlign: 'right', fontFamily: MONO, color: D.muted }}>{t.fee != null ? fmtM(t.fee) : '--'}</td>
                                    <td style={{ ...tdStyle, fontSize: 12, textAlign: 'right', fontFamily: MONO, fontWeight: 600 }}>{t.net != null ? fmtM(t.net) : '--'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {loading && <div style={{ textAlign: 'center', color: D.muted, fontSize: 12, padding: 16 }}>Loading...</div>}

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
        <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ ...inputStyle, cursor: page <= 1 ? 'not-allowed' : 'pointer', opacity: page <= 1 ? 0.4 : 1 }}>Previous</button>
        <span style={{ color: D.muted, fontSize: 12, alignSelf: 'center', fontFamily: MONO }}>Page {page}</span>
        <button disabled={!hasMore} onClick={() => setPage(p => p + 1)} style={{ ...inputStyle, cursor: !hasMore ? 'not-allowed' : 'pointer', opacity: !hasMore ? 0.4 : 1 }}>Next</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CASH FLOW TAB
// ═══════════════════════════════════════════════════════════════
function CashFlowTab() {
  const [period, setPeriod] = useState('weekly');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const today = new Date();
  const threeMonthsAgo = new Date(today);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const [startDate, setStartDate] = useState(threeMonthsAgo.toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(today.toISOString().split('T')[0]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await adminFetch(`/admin/banking/cash-flow?start_date=${startDate}&end_date=${endDate}&period=${period}`);
      setData(d);
    } catch (e) { /* no-op */ }
    setLoading(false);
  }, [startDate, endDate, period]);

  useEffect(() => { load(); }, [load]);

  const chartData = data?.periods || [];
  const summary = data?.summary || {};

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {['weekly', 'monthly'].map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{ background: period === p ? D.teal : 'transparent', border: `1px solid ${period === p ? D.teal : D.border}`, borderRadius: 6, padding: '6px 14px', color: period === p ? D.white : D.muted, fontSize: 12, cursor: 'pointer', fontWeight: period === p ? 600 : 400, textTransform: 'capitalize' }}>
              {p}
            </button>
          ))}
        </div>
        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
        <span style={{ color: D.muted, fontSize: 12 }}>to</span>
        <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ ...inputStyle, width: 140 }} />
      </div>

      {loading && <div style={{ color: D.muted, fontSize: 12, padding: 16, textAlign: 'center' }}>Loading cash flow data...</div>}

      {!loading && chartData.length > 0 && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
              <XAxis dataKey="label" tick={{ fill: D.muted, fontSize: 11 }} axisLine={{ stroke: D.border }} />
              <YAxis tick={{ fill: D.muted, fontSize: 11, fontFamily: MONO }} axisLine={{ stroke: D.border }} tickFormatter={v => '$' + (v / 1000).toFixed(0) + 'k'} />
              <Tooltip content={<CashFlowTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: D.muted }} />
              <Bar dataKey="money_in" name="Money In" fill={D.green} radius={[4, 4, 0, 0]} />
              <Bar dataKey="money_out" name="Money Out" fill={D.red} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 10 }}>
          <SummaryCard label="Total In" value={fmtM(summary.total_in)} color={D.green} />
          <SummaryCard label="Total Out" value={fmtM(summary.total_out)} color={D.red} />
          <SummaryCard label="Net" value={fmtM(summary.net)} color={(summary.net || 0) >= 0 ? D.green : D.red} />
          <SummaryCard label="Stripe Fees" value={fmtM(summary.stripe_fees)} color={D.amber} />
        </div>
      )}
    </div>
  );
}

function CashFlowTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
      <div style={{ color: D.muted, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontFamily: MONO }}>{fmtM(p.value)} {p.name}</div>
      ))}
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: isMobile ? '12px 10px' : '16px 20px' }}>
      <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: color || D.heading }}>{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// RECONCILIATION TAB
// ═══════════════════════════════════════════════════════════════
function ReconciliationTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actuals, setActuals] = useState({});
  const [notes, setNotes] = useState({});
  const [reconciling, setReconciling] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await adminFetch('/admin/banking/reconciliation');
      setItems(d.payouts || []);
    } catch (e) { /* no-op */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleReconcile = async (payoutId) => {
    const actual = actuals[payoutId];
    if (actual == null || actual === '') return;
    setReconciling(payoutId);
    try {
      await adminFetch(`/admin/banking/reconciliation/${payoutId}`, {
        method: 'POST',
        body: JSON.stringify({ actual_amount: parseFloat(actual), notes: notes[payoutId] || '' }),
      });
      await load();
    } catch (e) {
      alert('Reconciliation failed: ' + e.message);
    }
    setReconciling(null);
  };

  return (
    <div>
      {loading && <div style={{ color: D.muted, fontSize: 12, padding: 16, textAlign: 'center' }}>Loading reconciliation data...</div>}

      {!loading && items.length === 0 && (
        <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No payouts to reconcile</div>
      )}

      {items.map(item => {
        const discrepancy = actuals[item.id] != null && actuals[item.id] !== '' ? (parseFloat(actuals[item.id]) - (item.expected_amount || item.amount)).toFixed(2) : null;
        return (
          <div key={item.id} style={{ background: D.card, border: `1px solid ${item.reconciled ? D.green + '44' : D.border}`, borderRadius: 10, padding: '14px 18px', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 150 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{fmtD(item.date || item.created)}</div>
                <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>Expected: <span style={{ fontFamily: MONO, color: D.text }}>{fmtM(item.expected_amount || item.amount)}</span></div>
              </div>

              {item.reconciled ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: D.green, fontSize: 16 }}>&#10003;</span>
                  <div style={{ fontSize: 11, color: D.muted }}>
                    <div>Actual: <span style={{ fontFamily: MONO, color: D.green }}>{fmtM(item.actual_amount)}</span></div>
                    <div>{fmtD(item.reconciled_at)} by {item.reconciled_by || 'admin'}</div>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Actual Amount</div>
                    <input
                      type="number" step="0.01"
                      placeholder={String(item.expected_amount || item.amount || '')}
                      value={actuals[item.id] || ''}
                      onChange={e => setActuals(prev => ({ ...prev, [item.id]: e.target.value }))}
                      style={{ ...inputStyle, width: 120, fontFamily: MONO }}
                    />
                  </div>
                  {discrepancy != null && parseFloat(discrepancy) !== 0 && (
                    <div style={{ fontSize: 11, fontFamily: MONO, color: parseFloat(discrepancy) > 0 ? D.green : D.red, alignSelf: 'flex-end', padding: '8px 0' }}>
                      {parseFloat(discrepancy) > 0 ? '+' : ''}{fmtM(parseFloat(discrepancy))}
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Notes</div>
                    <input
                      value={notes[item.id] || ''}
                      onChange={e => setNotes(prev => ({ ...prev, [item.id]: e.target.value }))}
                      placeholder="Optional notes"
                      style={{ ...inputStyle, width: 160 }}
                    />
                  </div>
                  <button
                    onClick={() => handleReconcile(item.id)}
                    disabled={reconciling === item.id || !actuals[item.id]}
                    style={{ background: D.green, border: 'none', borderRadius: 6, padding: '8px 14px', color: '#fff', fontSize: 12, fontWeight: 600, cursor: reconciling === item.id || !actuals[item.id] ? 'not-allowed' : 'pointer', opacity: reconciling === item.id || !actuals[item.id] ? 0.5 : 1, alignSelf: 'flex-end' }}
                  >
                    {reconciling === item.id ? 'Saving...' : 'Reconcile'}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS TAB
// ═══════════════════════════════════════════════════════════════
function ExportsTab() {
  const today = new Date();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const [startDate, setStartDate] = useState(startOfMonth.toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(today.toISOString().split('T')[0]);
  const [format, setFormat] = useState('csv');
  const [preview, setPreview] = useState([]);
  const [downloading, setDownloading] = useState(false);

  const applyPreset = (preset) => {
    const now = new Date();
    let s, e;
    switch (preset) {
      case 'this_month':
        s = new Date(now.getFullYear(), now.getMonth(), 1);
        e = now;
        break;
      case 'last_month':
        s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        e = new Date(now.getFullYear(), now.getMonth(), 0);
        break;
      case 'this_quarter': {
        const q = Math.floor(now.getMonth() / 3) * 3;
        s = new Date(now.getFullYear(), q, 1);
        e = now;
        break;
      }
      case 'ytd':
        s = new Date(now.getFullYear(), 0, 1);
        e = now;
        break;
      default: return;
    }
    setStartDate(s.toISOString().split('T')[0]);
    setEndDate(e.toISOString().split('T')[0]);
  };

  useEffect(() => {
    adminFetch(`/admin/banking/payouts?limit=5&page=1&start_date=${startDate}&end_date=${endDate}`)
      .then(d => setPreview(d.payouts || []))
      .catch(() => setPreview([]));
  }, [startDate, endDate]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const resp = await adminFetchRaw(`/admin/banking/export?format=${format}&start_date=${startDate}&end_date=${endDate}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `waves-banking-${startDate}-to-${endDate}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Download failed: ' + e.message);
    }
    setDownloading(false);
  };

  return (
    <div>
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 14 }}>Export Settings</div>

        {/* Date range */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>Start Date</div>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...inputStyle, width: 150 }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: D.muted, marginBottom: 2 }}>End Date</div>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ ...inputStyle, width: 150 }} />
          </div>
        </div>

        {/* Presets */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { key: 'this_month', label: 'This Month' },
            { key: 'last_month', label: 'Last Month' },
            { key: 'this_quarter', label: 'This Quarter' },
            { key: 'ytd', label: 'YTD' },
          ].map(p => (
            <button key={p.key} onClick={() => applyPreset(p.key)} style={{ background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 6, padding: '6px 12px', color: D.muted, fontSize: 11, cursor: 'pointer', transition: 'border-color 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = D.teal; e.currentTarget.style.color = D.text; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = D.border; e.currentTarget.style.color = D.muted; }}>
              {p.label}
            </button>
          ))}
        </div>

        {/* Format */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: D.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Format</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['csv', 'ofx'].map(f => (
              <button key={f} onClick={() => setFormat(f)} style={{ background: format === f ? D.teal : 'transparent', border: `1px solid ${format === f ? D.teal : D.border}`, borderRadius: 6, padding: '6px 16px', color: format === f ? D.white : D.muted, fontSize: 12, fontWeight: format === f ? 600 : 400, cursor: 'pointer', textTransform: 'uppercase' }}>
                {f}
              </button>
            ))}
          </div>
        </div>

        <button onClick={handleDownload} disabled={downloading} style={{ background: D.teal, border: 'none', borderRadius: 8, padding: '10px 24px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: downloading ? 'not-allowed' : 'pointer', opacity: downloading ? 0.6 : 1 }}>
          {downloading ? 'Generating...' : 'Generate & Download'}
        </button>
      </div>

      {/* Preview */}
      {preview.length > 0 && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 10 }}>Preview (first 5 payouts in range)</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Date</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Amount</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Arrival</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((p, i) => (
                <tr key={i}>
                  <td style={tdStyle}>{fmtD(p.date || p.created)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO, fontWeight: 600 }}>{fmtM(p.amount)}</td>
                  <td style={tdStyle}><Badge color={STATUS_COLORS[p.status] || D.muted}>{p.status}</Badge></td>
                  <td style={tdStyle}>{fmtD(p.arrival_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// INSTANT PAYOUT MODAL
// ═══════════════════════════════════════════════════════════════
function InstantPayoutModal({ available, onClose, onSuccess }) {
  const [amount, setAmount] = useState(available || 0);
  const [submitting, setSubmitting] = useState(false);

  const fee = (parseFloat(amount) || 0) * 0.01;
  const net = (parseFloat(amount) || 0) - fee;

  const handleSubmit = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    setSubmitting(true);
    try {
      await adminFetch('/admin/banking/payouts/instant', {
        method: 'POST',
        body: JSON.stringify({ amount: parseFloat(amount) }),
      });
      onSuccess();
    } catch (e) {
      alert('Instant payout failed: ' + e.message);
    }
    setSubmitting(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 16, padding: 28, width: '100%', maxWidth: 400 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, marginBottom: 4 }}>Instant Payout</div>
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 20 }}>Funds sent immediately to your bank. 1% fee applies.</div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: D.muted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>Payout Amount</div>
          <input
            type="number" step="0.01" min="0" max={available || 0}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            style={{ ...inputStyle, width: '100%', fontSize: 20, fontFamily: MONO, fontWeight: 700, padding: '12px 16px' }}
          />
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>Available: <span style={{ fontFamily: MONO, color: D.green }}>{fmtM(available)}</span></div>
        </div>

        <div style={{ background: D.bg, borderRadius: 10, padding: 14, marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: D.muted }}>Amount</span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: D.text }}>{fmtM(parseFloat(amount) || 0)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: D.muted }}>Fee (1%)</span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: D.amber }}>{fmtM(fee)}</span>
          </div>
          <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 6, display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>Net Payout</span>
            <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: D.green }}>{fmtM(net)}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, background: 'transparent', border: `1px solid ${D.border}`, borderRadius: 8, padding: '10px 16px', color: D.muted, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={submitting || !amount || parseFloat(amount) <= 0} style={{ flex: 1, background: D.green, border: 'none', borderRadius: 8, padding: '10px 16px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.6 : 1 }}>
            {submitting ? 'Processing...' : 'Confirm Payout'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════
export default function BankingPage() {
  const [tab, setTab] = useState('payouts');
  const [balance, setBalance] = useState(null);
  const [stats, setStats] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [showPayoutModal, setShowPayoutModal] = useState(false);

  const loadBalance = useCallback(async () => {
    try {
      const d = await adminFetch('/admin/banking/balance');
      setBalance(d);
      if (d.last_sync) setLastSync(d.last_sync);
    } catch (e) { /* no-op */ }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const d = await adminFetch('/admin/banking/stats');
      setStats(d);
    } catch (e) { /* no-op */ }
  }, []);

  useEffect(() => { loadBalance(); loadStats(); }, [loadBalance, loadStats]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const d = await adminFetch('/admin/banking/sync', { method: 'POST' });
      setLastSync(d.synced_at || new Date().toISOString());
      await loadBalance();
      await loadStats();
    } catch (e) {
      alert('Sync failed: ' + e.message);
    }
    setSyncing(false);
  };

  const handlePayoutSuccess = () => {
    setShowPayoutModal(false);
    loadBalance();
    loadStats();
  };

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: D.heading }}>Banking & Cash Flow</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 2 }}>Stripe payouts, reconciliation & cash flow analysis</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastSync && (
            <span style={{ fontSize: 11, color: D.muted }}>
              Last sync: {new Date(lastSync).toLocaleString()}
            </span>
          )}
          <button onClick={handleSync} disabled={syncing} style={{ background: D.teal, border: 'none', borderRadius: 8, padding: '8px 18px', color: '#fff', fontSize: 13, fontWeight: 600, cursor: syncing ? 'not-allowed' : 'pointer', opacity: syncing ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {syncing ? 'Syncing...' : 'Sync Stripe'}
          </button>
        </div>
      </div>

      {/* Intelligence Bar */}
      <SEOIntelligenceBar context="banking" />

      {/* Balance Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
        {/* Available */}
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: isMobile ? '12px 10px' : '16px 20px' }}>
          <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Available</div>
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: D.green }}>{fmtM(balance?.available)}</div>
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4, marginBottom: 8 }}>Ready to pay out</div>
          <button onClick={() => setShowPayoutModal(true)} disabled={!balance?.available || balance.available <= 0} style={{ background: `${D.green}22`, border: `1px solid ${D.green}44`, borderRadius: 6, padding: '4px 10px', color: D.green, fontSize: 10, fontWeight: 600, cursor: !balance?.available || balance.available <= 0 ? 'not-allowed' : 'pointer', opacity: !balance?.available || balance.available <= 0 ? 0.4 : 1 }}>
            Instant Payout
          </button>
        </div>

        {/* Pending */}
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: isMobile ? '12px 10px' : '16px 20px' }}>
          <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Pending</div>
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: D.amber }}>{fmtM(balance?.pending)}</div>
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>Processing</div>
        </div>

        {/* Next Payout */}
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: isMobile ? '12px 10px' : '16px 20px' }}>
          <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Next Payout</div>
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: D.teal }}>{fmtM(balance?.next_payout?.amount)}</div>
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>{balance?.next_payout?.arrival_date ? fmtD(balance.next_payout.arrival_date) : 'No payout scheduled'}</div>
        </div>

        {/* MTD Deposited */}
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: isMobile ? '12px 10px' : '16px 20px' }}>
          <div style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>MTD Deposited</div>
          <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: D.purple }}>{fmtM(stats?.mtd_deposited)}</div>
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>{stats?.payout_count ?? 0} payout{(stats?.payout_count ?? 0) !== 1 ? 's' : ''} this month</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, overflowX: 'auto', WebkitOverflowScrolling: 'touch', flexWrap: 'nowrap' }}>
        <TabBtn active={tab === 'payouts'} label="Payouts" onClick={() => setTab('payouts')} />
        <TabBtn active={tab === 'cashflow'} label="Cash Flow" onClick={() => setTab('cashflow')} />
        <TabBtn active={tab === 'reconciliation'} label="Reconciliation" onClick={() => setTab('reconciliation')} />
        <TabBtn active={tab === 'exports'} label="Exports" onClick={() => setTab('exports')} />
      </div>

      {tab === 'payouts' && <PayoutsTab />}
      {tab === 'cashflow' && <CashFlowTab />}
      {tab === 'reconciliation' && <ReconciliationTab />}
      {tab === 'exports' && <ExportsTab />}

      {/* Instant Payout Modal */}
      {showPayoutModal && (
        <InstantPayoutModal
          available={balance?.available || 0}
          onClose={() => setShowPayoutModal(false)}
          onSuccess={handlePayoutSuccess}
        />
      )}
    </div>
  );
}
