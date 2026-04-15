import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

// ---------------------------------------------------------------------------
// Color / style helpers
// ---------------------------------------------------------------------------
const COLORS = {
  bg: '#F1F5F9',
  card: '#FFFFFF',
  cardHover: '#F0F7FC',
  border: '#E2E8F0',
  text: '#334155',
  textMuted: '#64748B',
  teal: '#0A7EC2',
  green: '#16A34A',
  amber: '#F0A500',
  red: '#C0392B',
  purple: '#7C3AED',
  white: '#FFFFFF',
  heading: '#0F172A',
  inputBorder: '#CBD5E1',
};

const GRADE_COLORS = { A: COLORS.green, B: COLORS.teal, C: COLORS.amber, D: '#f97316', F: COLORS.red };
const RISK_COLORS = { low: COLORS.green, moderate: COLORS.amber, high: '#f97316', critical: COLORS.red };
const RISK_LABELS = { low: 'Low', moderate: 'Moderate', high: 'High', critical: 'Critical' };
const TREND_ARROWS = { improving: '\u2191', declining: '\u2193', stable: '\u2192' };
const TREND_COLORS = { improving: COLORS.green, declining: COLORS.red, stable: COLORS.textMuted };

const mono = { fontFamily: "'JetBrains Mono', monospace" };

function Badge({ label, color, style }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
      backgroundColor: color + '22', color, border: `1px solid ${color}44`, ...style,
    }}>{label}</span>
  );
}

function Card({ children, style, onClick }) {
  return (
    <div onClick={onClick} style={{
      backgroundColor: COLORS.card, borderRadius: 12, border: `1px solid ${COLORS.border}`,
      padding: 20, ...style, cursor: onClick ? 'pointer' : undefined,
    }}>{children}</div>
  );
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 0 }}>
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)} style={{
          padding: '10px 20px', background: 'none', border: 'none', color: active === t.key ? COLORS.teal : COLORS.textMuted,
          fontSize: 14, fontWeight: 600, cursor: 'pointer', borderBottom: active === t.key ? `2px solid ${COLORS.teal}` : '2px solid transparent',
          marginBottom: -1, transition: 'all 0.2s',
        }}>{t.label}</button>
      ))}
    </div>
  );
}

function ScoreBar({ value, max = 100, color, width = 60, height = 6 }) {
  return (
    <div style={{ width, height, backgroundColor: COLORS.border, borderRadius: height, overflow: 'hidden', display: 'inline-block', verticalAlign: 'middle' }}>
      <div style={{ width: `${(value / max) * 100}%`, height: '100%', backgroundColor: color || COLORS.teal, borderRadius: height, transition: 'width 0.3s' }} />
    </div>
  );
}

function GradeCircle({ grade, size = 32 }) {
  const color = GRADE_COLORS[grade] || COLORS.textMuted;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: '50%', border: `2px solid ${color}`,
      color, fontWeight: 700, fontSize: size * 0.45, ...mono,
    }}>{grade}</span>
  );
}

// ---------------------------------------------------------------------------
// Radar Chart (inline SVG, 6 axes)
// ---------------------------------------------------------------------------
function RadarChart({ scores, size = 200 }) {
  const labels = ['Payment', 'Service', 'Engage', 'Satisfy', 'Loyalty', 'Growth'];
  const keys = ['payment_score', 'service_score', 'engagement_score', 'satisfaction_score', 'loyalty_score', 'growth_score'];
  const cx = size / 2, cy = size / 2, r = size * 0.38;
  const n = 6;

  function point(i, val) {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const dist = (val / 100) * r;
    return [cx + dist * Math.cos(angle), cy + dist * Math.sin(angle)];
  }

  const rings = [25, 50, 75, 100];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* Grid rings */}
      {rings.map(v => {
        const pts = Array.from({ length: n }, (_, i) => point(i, v));
        return <polygon key={v} points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke={COLORS.border} strokeWidth={1} />;
      })}
      {/* Axis lines */}
      {Array.from({ length: n }, (_, i) => {
        const [x, y] = point(i, 100);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={COLORS.border} strokeWidth={1} />;
      })}
      {/* Data polygon */}
      {(() => {
        const pts = keys.map((k, i) => point(i, scores[k] || 0));
        return <polygon points={pts.map(p => p.join(',')).join(' ')} fill={COLORS.teal + '33'} stroke={COLORS.teal} strokeWidth={2} />;
      })()}
      {/* Data points */}
      {keys.map((k, i) => {
        const [x, y] = point(i, scores[k] || 0);
        return <circle key={k} cx={x} cy={y} r={3} fill={COLORS.teal} />;
      })}
      {/* Labels */}
      {labels.map((label, i) => {
        const [x, y] = point(i, 118);
        return <text key={label} x={x} y={y} fill={COLORS.textMuted} fontSize={10} textAnchor="middle" dominantBaseline="middle">{label}</text>;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Tab
// ---------------------------------------------------------------------------
function DashboardTab({ data }) {
  if (!data) return <div style={{ color: COLORS.textMuted }}>Loading dashboard...</div>;

  const metricCards = [
    { label: 'Fleet Health Avg', value: data.fleetHealthAvg, suffix: '/100', color: data.fleetHealthAvg >= 65 ? COLORS.green : data.fleetHealthAvg >= 50 ? COLORS.amber : COLORS.red },
    { label: 'At-Risk Customers', value: data.atRiskCount, color: COLORS.red },
    { label: 'Healthy Customers', value: data.healthyCount, color: COLORS.green },
    { label: 'Active Sequences', value: data.activeSequences, color: COLORS.purple },
    { label: '30-Day Churn Forecast', value: data.predictedChurns, color: COLORS.amber },
  ];

  const gradeMap = {};
  (data.gradeDistribution || []).forEach(g => { gradeMap[g.grade] = g.count; });
  const totalGrades = Object.values(gradeMap).reduce((s, v) => s + v, 0) || 1;

  const riskMap = {};
  (data.riskBreakdown || []).forEach(r => { riskMap[r.risk] = r.count; });

  return (
    <div>
      {/* Metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
        {metricCards.map(m => (
          <Card key={m.label}>
            <div style={{ color: COLORS.textMuted, fontSize: 12, marginBottom: 8, fontWeight: 500 }}>{m.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: m.color, ...mono }}>
              {m.value}{m.suffix || ''}
            </div>
          </Card>
        ))}
      </div>

      {/* Grade distribution bar */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.heading, marginBottom: 12 }}>Grade Distribution</div>
        <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', height: 28 }}>
          {['A', 'B', 'C', 'D', 'F'].map(g => {
            const count = gradeMap[g] || 0;
            const pct = (count / totalGrades) * 100;
            if (pct === 0) return null;
            return (
              <div key={g} style={{
                width: `${pct}%`, backgroundColor: GRADE_COLORS[g], display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: 11, fontWeight: 700, minWidth: count > 0 ? 30 : 0, transition: 'width 0.3s',
              }}>{g} ({count})</div>
            );
          })}
        </div>
      </Card>

      {/* Churn risk breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        {['low', 'moderate', 'high', 'critical'].map(risk => (
          <Card key={risk} style={{ borderLeft: `3px solid ${RISK_COLORS[risk]}` }}>
            <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 4 }}>{RISK_LABELS[risk]} Risk</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: RISK_COLORS[risk], ...mono }}>{riskMap[risk] || 0}</div>
          </Card>
        ))}
      </div>

      {/* At-risk customers table */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.heading, marginBottom: 12 }}>Top At-Risk Customers</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                {['Customer', 'Tier', 'Score', 'Grade', 'Risk', 'Top Signal', 'Days to Churn'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: COLORS.textMuted, fontWeight: 500, fontSize: 11, textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data.atRiskCustomers || []).map(c => {
                const signals = c.churn_signals || [];
                const topSignal = signals[0]?.message || '--';
                return (
                  <tr key={c.id} style={{ borderBottom: `1px solid ${COLORS.border}22` }}>
                    <td style={{ padding: '8px 12px', color: COLORS.text }}>{c.first_name} {c.last_name}</td>
                    <td style={{ padding: '8px 12px' }}>{c.waveguard_tier ? <Badge label={c.waveguard_tier} color={COLORS.teal} /> : '--'}</td>
                    <td style={{ padding: '8px 12px', ...mono, color: COLORS.text }}>{c.overall_score}</td>
                    <td style={{ padding: '8px 12px' }}><GradeCircle grade={c.score_grade} size={26} /></td>
                    <td style={{ padding: '8px 12px' }}><Badge label={RISK_LABELS[c.churn_risk]} color={RISK_COLORS[c.churn_risk]} /></td>
                    <td style={{ padding: '8px 12px', color: COLORS.textMuted, fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{topSignal}</td>
                    <td style={{ padding: '8px 12px', ...mono, color: COLORS.amber }}>{c.days_until_predicted_churn ?? '--'}</td>
                  </tr>
                );
              })}
              {(data.atRiskCustomers || []).length === 0 && (
                <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: COLORS.textMuted }}>No at-risk customers</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Recent alerts */}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.heading, marginBottom: 12 }}>Recent Alerts</div>
        {(data.recentAlerts || []).length === 0 && <div style={{ color: COLORS.textMuted, fontSize: 13 }}>No recent alerts</div>}
        {(data.recentAlerts || []).map(a => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: `1px solid ${COLORS.border}22` }}>
            <div style={{ width: 4, height: 32, borderRadius: 2, backgroundColor: RISK_COLORS[a.severity] || COLORS.textMuted, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: COLORS.text, fontWeight: 500 }}>{a.title}</div>
              <div style={{ fontSize: 11, color: COLORS.textMuted }}>{a.first_name} {a.last_name} -- {new Date(a.created_at).toLocaleDateString()}</div>
            </div>
            <Badge label={a.status} color={a.status === 'new' ? COLORS.amber : a.status === 'resolved' ? COLORS.green : COLORS.textMuted} />
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer Detail (inline expand)
// ---------------------------------------------------------------------------
function CustomerDetail({ customerId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adminFetch(`/admin/health/scores/${customerId}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [customerId]);

  if (loading) return <div style={{ padding: 20, color: COLORS.textMuted }}>Loading...</div>;
  if (!data || !data.score) return <div style={{ padding: 20, color: COLORS.red }}>Failed to load details</div>;

  const s = data.score;
  const subScores = [
    { key: 'payment_score', label: 'Payment', detail: s.payment_details, color: COLORS.green },
    { key: 'service_score', label: 'Service', detail: s.service_details, color: COLORS.teal },
    { key: 'engagement_score', label: 'Engagement', detail: s.engagement_details, color: COLORS.purple },
    { key: 'satisfaction_score', label: 'Satisfaction', detail: s.satisfaction_details, color: COLORS.amber },
    { key: 'loyalty_score', label: 'Loyalty', detail: s.loyalty_details, color: '#0A7EC2' },
    { key: 'growth_score', label: 'Growth', detail: s.growth_details, color: '#16A34A' },
  ];

  const signals = s.churn_signals || [];

  function detailString(detail) {
    if (!detail) return '--';
    const parts = [];
    if (detail.onTimeRate !== undefined && detail.onTimeRate !== null) parts.push(`On-time: ${Math.round(detail.onTimeRate * 100)}%`);
    if (detail.daysSinceLastService !== undefined && detail.daysSinceLastService !== null) parts.push(`Last: ${detail.daysSinceLastService}d ago`);
    if (detail.adherenceRate !== undefined && detail.adherenceRate !== null) parts.push(`Adherence: ${Math.round(detail.adherenceRate * 100)}%`);
    if (detail.smsInbound !== undefined) parts.push(`SMS in: ${detail.smsInbound}`);
    if (detail.avgRating !== undefined && detail.avgRating !== null) parts.push(`Rating: ${detail.avgRating}/5`);
    if (detail.tenureMonths !== undefined) parts.push(`${detail.tenureMonths}mo tenure`);
    if (detail.tier) parts.push(`Tier: ${detail.tier}`);
    if (detail.distinctServices !== undefined) parts.push(`${detail.distinctServices} service types`);
    if (detail.monthlyRate !== undefined && detail.monthlyRate !== null) parts.push(`$${detail.monthlyRate}/mo`);
    return parts.join(' | ') || '--';
  }

  return (
    <div style={{ padding: 20, backgroundColor: COLORS.bg, borderTop: `1px solid ${COLORS.border}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.heading }}>{s.first_name} {s.last_name}</div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: COLORS.textMuted, cursor: 'pointer', fontSize: 18 }}>x</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'start' }}>
        {/* Score circle + radar */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 80, height: 80, borderRadius: '50%', border: `3px solid ${GRADE_COLORS[s.score_grade]}`,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: GRADE_COLORS[s.score_grade], ...mono }}>{s.overall_score}</span>
            <span style={{ fontSize: 12, color: GRADE_COLORS[s.score_grade], fontWeight: 600 }}>{s.score_grade}</span>
          </div>
          <RadarChart scores={s} size={180} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <Badge label={`${RISK_LABELS[s.churn_risk]} Risk`} color={RISK_COLORS[s.churn_risk]} />
            <Badge label={`${TREND_ARROWS[s.score_trend] || ''} ${s.score_trend}`} color={TREND_COLORS[s.score_trend]} />
          </div>
        </div>

        {/* Sub-scores + signals */}
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
            {subScores.map(sub => (
              <div key={sub.key} style={{
                backgroundColor: COLORS.card, borderRadius: 8, padding: 12, border: `1px solid ${COLORS.border}`,
                borderLeft: `3px solid ${sub.color}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: COLORS.textMuted, fontWeight: 500 }}>{sub.label}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: sub.color, ...mono }}>{s[sub.key]}</span>
                </div>
                <ScoreBar value={s[sub.key]} color={sub.color} width="100%" height={4} />
                <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 6 }}>{detailString(sub.detail)}</div>
              </div>
            ))}
          </div>

          {/* Churn signals */}
          {signals.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.heading, marginBottom: 8 }}>Churn Signals</div>
              {signals.map((sig, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: RISK_COLORS[sig.severity] || COLORS.textMuted, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: COLORS.text }}>{sig.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Quick actions */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => adminFetch(`/admin/health/rescore/${customerId}`, { method: 'POST' }).then(() => window.location.reload())} style={{
              padding: '6px 14px', borderRadius: 6, border: `1px solid ${COLORS.teal}`, backgroundColor: 'transparent',
              color: COLORS.teal, fontSize: 12, cursor: 'pointer', fontWeight: 500,
            }}>Rescore</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scores Tab
// ---------------------------------------------------------------------------
function ScoresTab() {
  const [scores, setScores] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ grade: '', churn_risk: '', trend: '', search: '' });
  const [sort, setSort] = useState({ sort: 'overall_score', order: 'asc' });
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(false);
  const limit = 25;

  const fetchScores = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.grade) params.set('grade', filters.grade);
    if (filters.churn_risk) params.set('churn_risk', filters.churn_risk);
    if (filters.trend) params.set('trend', filters.trend);
    if (filters.search) params.set('search', filters.search);
    params.set('sort', sort.sort);
    params.set('order', sort.order);
    params.set('limit', limit);
    params.set('offset', page * limit);

    adminFetch(`/admin/health/scores?${params}`)
      .then(r => { setScores(r.scores || []); setTotal(r.total || 0); })
      .catch(() => { setScores([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [filters, sort, page]);

  useEffect(() => { fetchScores(); }, [fetchScores]);

  const selectStyle = {
    padding: '6px 10px', borderRadius: 6, border: `1px solid ${COLORS.border}`, backgroundColor: COLORS.card,
    color: COLORS.text, fontSize: 12, outline: 'none',
  };

  function handleSort(col) {
    setSort(prev => ({ sort: col, order: prev.sort === col && prev.order === 'asc' ? 'desc' : 'asc' }));
  }

  function SubScoreDot({ value }) {
    const color = value >= 65 ? COLORS.green : value >= 50 ? COLORS.amber : value >= 35 ? '#f97316' : COLORS.red;
    return <span title={value} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: color, margin: '0 2px' }} />;
  }

  return (
    <div>
      {/* Search + filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Search customers..."
          value={filters.search}
          onChange={e => { setFilters(f => ({ ...f, search: e.target.value })); setPage(0); }}
          style={{ ...selectStyle, width: 200 }}
        />
        <select value={filters.grade} onChange={e => { setFilters(f => ({ ...f, grade: e.target.value })); setPage(0); }} style={selectStyle}>
          <option value="">All Grades</option>
          {['A', 'B', 'C', 'D', 'F'].map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={filters.churn_risk} onChange={e => { setFilters(f => ({ ...f, churn_risk: e.target.value })); setPage(0); }} style={selectStyle}>
          <option value="">All Risk</option>
          {['low', 'moderate', 'high', 'critical'].map(r => <option key={r} value={r}>{RISK_LABELS[r]}</option>)}
        </select>
        <select value={filters.trend} onChange={e => { setFilters(f => ({ ...f, trend: e.target.value })); setPage(0); }} style={selectStyle}>
          <option value="">All Trends</option>
          {['improving', 'stable', 'declining'].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <span style={{ color: COLORS.textMuted, fontSize: 12, marginLeft: 'auto' }}>{total} customers</span>
      </div>

      {/* Table */}
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                {[
                  { key: 'first_name', label: 'Customer' },
                  { key: null, label: 'Tier' },
                  { key: 'overall_score', label: 'Score' },
                  { key: 'score_grade', label: 'Grade' },
                  { key: null, label: 'Sub-Scores' },
                  { key: 'churn_risk', label: 'Risk' },
                  { key: null, label: 'Trend' },
                ].map(h => (
                  <th key={h.label} onClick={h.key ? () => handleSort(h.key) : undefined} style={{
                    padding: '10px 12px', textAlign: 'left', color: COLORS.textMuted, fontWeight: 500, fontSize: 11,
                    textTransform: 'uppercase', cursor: h.key ? 'pointer' : 'default', userSelect: 'none',
                  }}>
                    {h.label}
                    {h.key && sort.sort === h.key && <span style={{ marginLeft: 4 }}>{sort.order === 'asc' ? '\u25B2' : '\u25BC'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} style={{ padding: 30, textAlign: 'center', color: COLORS.textMuted }}>Loading...</td></tr>
              )}
              {!loading && scores.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 30, textAlign: 'center', color: COLORS.textMuted }}>No scores found. Run a batch rescore to generate data.</td></tr>
              )}
              {!loading && scores.map(c => (
                <React.Fragment key={c.customer_id}>
                  <tr
                    onClick={() => setExpandedId(expandedId === c.customer_id ? null : c.customer_id)}
                    style={{ borderBottom: `1px solid ${COLORS.border}22`, cursor: 'pointer', transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = COLORS.cardHover}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <td style={{ padding: '10px 12px', color: COLORS.heading, fontWeight: 500 }}>{c.first_name} {c.last_name}</td>
                    <td style={{ padding: '10px 12px' }}>{c.waveguard_tier ? <Badge label={c.waveguard_tier} color={COLORS.teal} /> : <span style={{ color: COLORS.textMuted }}>--</span>}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ ...mono, color: COLORS.text, marginRight: 8 }}>{c.overall_score}</span>
                      <ScoreBar value={c.overall_score} color={GRADE_COLORS[c.score_grade]} width={50} />
                    </td>
                    <td style={{ padding: '10px 12px' }}><GradeCircle grade={c.score_grade} size={24} /></td>
                    <td style={{ padding: '10px 12px' }}>
                      <SubScoreDot value={c.payment_score} />
                      <SubScoreDot value={c.service_score} />
                      <SubScoreDot value={c.engagement_score} />
                      <SubScoreDot value={c.satisfaction_score} />
                      <SubScoreDot value={c.loyalty_score} />
                      <SubScoreDot value={c.growth_score} />
                    </td>
                    <td style={{ padding: '10px 12px' }}><Badge label={RISK_LABELS[c.churn_risk]} color={RISK_COLORS[c.churn_risk]} /></td>
                    <td style={{ padding: '10px 12px', ...mono, fontSize: 16, color: TREND_COLORS[c.score_trend] }}>
                      {TREND_ARROWS[c.score_trend] || '--'}
                      {c.score_change_30d != null && <span style={{ fontSize: 11, marginLeft: 4 }}>{c.score_change_30d > 0 ? '+' : ''}{c.score_change_30d}</span>}
                    </td>
                  </tr>
                  {expandedId === c.customer_id && (
                    <tr>
                      <td colSpan={7} style={{ padding: 0 }}>
                        <CustomerDetail customerId={c.customer_id} onClose={() => setExpandedId(null)} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Pagination */}
      {total > limit && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)} style={{
            padding: '6px 14px', borderRadius: 6, border: `1px solid ${COLORS.border}`, backgroundColor: COLORS.card,
            color: page === 0 ? COLORS.textMuted : COLORS.text, cursor: page === 0 ? 'default' : 'pointer', fontSize: 12,
          }}>Prev</button>
          <span style={{ padding: '6px 14px', color: COLORS.textMuted, fontSize: 12, ...mono }}>
            {page * limit + 1}-{Math.min((page + 1) * limit, total)} of {total}
          </span>
          <button disabled={(page + 1) * limit >= total} onClick={() => setPage(p => p + 1)} style={{
            padding: '6px 14px', borderRadius: 6, border: `1px solid ${COLORS.border}`, backgroundColor: COLORS.card,
            color: (page + 1) * limit >= total ? COLORS.textMuted : COLORS.text, cursor: (page + 1) * limit >= total ? 'default' : 'pointer', fontSize: 12,
          }}>Next</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alerts Tab
// ---------------------------------------------------------------------------
function AlertsTab() {
  const [alerts, setAlerts] = useState([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('new');
  const [severityFilter, setSeverityFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);

  const fetchAlerts = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (severityFilter) params.set('severity', severityFilter);
    params.set('limit', 50);

    adminFetch(`/admin/health/alerts?${params}`)
      .then(r => { setAlerts(r.alerts || []); setTotal(r.total || 0); })
      .catch(() => { setAlerts([]); })
      .finally(() => setLoading(false));
  }, [statusFilter, severityFilter]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  async function handleAction(alertId, actionIndex) {
    setActionLoading(`${alertId}-${actionIndex}`);
    try {
      await adminFetch(`/admin/health/alerts/${alertId}/action`, { method: 'POST', body: { actionIndex } });
      fetchAlerts();
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  async function handleStatusChange(alertId, newStatus) {
    try {
      await adminFetch(`/admin/health/alerts/${alertId}`, { method: 'PUT', body: { status: newStatus } });
      fetchAlerts();
    } catch { /* ignore */ }
  }

  const selectStyle = {
    padding: '6px 10px', borderRadius: 6, border: `1px solid ${COLORS.border}`, backgroundColor: COLORS.card,
    color: COLORS.text, fontSize: 12, outline: 'none',
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All Status</option>
          <option value="new">New</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <select value={severityFilter} onChange={e => setSeverityFilter(e.target.value)} style={selectStyle}>
          <option value="">All Severity</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="moderate">Moderate</option>
        </select>
        <span style={{ color: COLORS.textMuted, fontSize: 12, marginLeft: 'auto' }}>{total} alerts</span>
      </div>

      {loading && <div style={{ color: COLORS.textMuted, padding: 20 }}>Loading alerts...</div>}

      {!loading && alerts.length === 0 && (
        <Card><div style={{ color: COLORS.textMuted, textAlign: 'center', padding: 20 }}>No alerts found</div></Card>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {alerts.map(a => {
          const actions = a.recommended_actions || (typeof a.recommended_actions === 'string' ? JSON.parse(a.recommended_actions) : []) || [];
          return (
            <Card key={a.id} style={{ display: 'flex', gap: 0, padding: 0, overflow: 'hidden' }}>
              <div style={{ width: 4, backgroundColor: RISK_COLORS[a.severity] || COLORS.textMuted, flexShrink: 0 }} />
              <div style={{ padding: 16, flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.heading, marginBottom: 4 }}>{a.title}</div>
                    <div style={{ fontSize: 12, color: COLORS.textMuted }}>
                      {a.first_name} {a.last_name} -- {new Date(a.created_at).toLocaleDateString()} {new Date(a.created_at).toLocaleTimeString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Badge label={a.severity} color={RISK_COLORS[a.severity]} />
                    <select
                      value={a.status}
                      onChange={e => handleStatusChange(a.id, e.target.value)}
                      style={{ ...selectStyle, fontSize: 11 }}
                    >
                      <option value="new">New</option>
                      <option value="acknowledged">Acknowledged</option>
                      <option value="resolved">Resolved</option>
                      <option value="dismissed">Dismissed</option>
                    </select>
                  </div>
                </div>
                {a.description && <div style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 12, lineHeight: 1.5 }}>{a.description}</div>}
                {actions.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {actions.map((act, idx) => {
                      const isExecuted = act.executed === true;
                      const isLoading = actionLoading === `${a.id}-${idx}`;

                      // Color map by action type
                      const actionColors = {
                        sms: COLORS.teal,
                        send_sms: COLORS.teal,
                        discount: COLORS.green,
                        save_offer: COLORS.green,
                        free_service: COLORS.purple,
                        complimentary: COLORS.purple,
                        call: COLORS.amber,
                        schedule_call: COLORS.amber,
                      };
                      const btnColor = isExecuted ? COLORS.textMuted : (actionColors[act.type] || COLORS.teal);

                      // Label map by action type
                      const actionLabels = {
                        sms: 'Send Check-In',
                        send_sms: 'Send Check-In',
                        discount: `Apply $${act.amount || 25} Credit`,
                        save_offer: `Apply $${act.amount || 25} Credit`,
                        free_service: 'Schedule Free Service',
                        complimentary: 'Schedule Free Service',
                        call: 'Schedule Call',
                        schedule_call: 'Schedule Call',
                      };
                      const label = isExecuted
                        ? '\u2713 Done'
                        : isLoading
                          ? 'Processing...'
                          : (actionLabels[act.type] || act.label || act.type);

                      return (
                        <button
                          key={idx}
                          disabled={isExecuted || isLoading}
                          onClick={() => handleAction(a.id, idx)}
                          style={{
                            padding: '5px 12px', borderRadius: 6,
                            border: `1px solid ${btnColor}44`,
                            backgroundColor: isExecuted ? (COLORS.textMuted + '11') : (btnColor + '11'),
                            color: btnColor, fontSize: 11,
                            cursor: isExecuted || isLoading ? 'default' : 'pointer',
                            fontWeight: 500,
                            opacity: isLoading ? 0.5 : isExecuted ? 0.6 : 1,
                          }}
                        >{label}</button>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sequences Tab
// ---------------------------------------------------------------------------
function SequencesTab() {
  const [sequences, setSequences] = useState([]);
  const [statusFilter, setStatusFilter] = useState('active');
  const [loading, setLoading] = useState(false);

  const fetchSequences = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    adminFetch(`/admin/health/sequences?${params}`)
      .then(r => setSequences(r.sequences || []))
      .catch(() => setSequences([]))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => { fetchSequences(); }, [fetchSequences]);

  async function handleAction(seqId, action, outcome) {
    try {
      await adminFetch(`/admin/health/sequences/${seqId}`, { method: 'PUT', body: { action, outcome, notes: '' } });
      fetchSequences();
    } catch { /* ignore */ }
  }

  const selectStyle = {
    padding: '6px 10px', borderRadius: 6, border: `1px solid ${COLORS.border}`, backgroundColor: COLORS.card,
    color: COLORS.text, fontSize: 12, outline: 'none',
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </select>
      </div>

      {loading && <div style={{ color: COLORS.textMuted, padding: 20 }}>Loading sequences...</div>}

      {!loading && sequences.length === 0 && (
        <Card><div style={{ color: COLORS.textMuted, textAlign: 'center', padding: 20 }}>No sequences found</div></Card>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {sequences.map(seq => {
          const steps = seq.steps || [];
          return (
            <Card key={seq.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.heading }}>{seq.first_name} {seq.last_name}</span>
                  <span style={{ marginLeft: 8 }}><Badge label={seq.sequence_type.replace('_', ' ')} color={COLORS.purple} /></span>
                  {seq.waveguard_tier && <span style={{ marginLeft: 8 }}><Badge label={seq.waveguard_tier} color={COLORS.teal} /></span>}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Badge label={seq.status} color={seq.status === 'active' ? COLORS.green : seq.status === 'completed' ? COLORS.teal : COLORS.textMuted} />
                  {seq.status === 'active' && (
                    <>
                      <button onClick={() => handleAction(seq.id, 'complete', 'customer_saved')} style={{
                        padding: '4px 10px', borderRadius: 6, border: `1px solid ${COLORS.green}`, backgroundColor: 'transparent',
                        color: COLORS.green, fontSize: 11, cursor: 'pointer',
                      }}>Mark Saved</button>
                      <button onClick={() => handleAction(seq.id, 'cancel')} style={{
                        padding: '4px 10px', borderRadius: 6, border: `1px solid ${COLORS.red}`, backgroundColor: 'transparent',
                        color: COLORS.red, fontSize: 11, cursor: 'pointer',
                      }}>Cancel</button>
                    </>
                  )}
                </div>
              </div>

              {/* Step progress */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                {steps.map((step, i) => {
                  const isCompleted = step.status === 'completed';
                  const isPending = step.status === 'pending';
                  const color = isCompleted ? COLORS.green : isPending ? COLORS.amber : COLORS.border;
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{
                          width: 20, height: 20, borderRadius: '50%', border: `2px solid ${color}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          backgroundColor: isCompleted ? color : 'transparent',
                          fontSize: 10, color: isCompleted ? '#fff' : color, fontWeight: 700, flexShrink: 0,
                        }}>{isCompleted ? '\u2713' : i + 1}</div>
                        {i < steps.length - 1 && <div style={{ flex: 1, height: 2, backgroundColor: isCompleted ? COLORS.green : COLORS.border }} />}
                      </div>
                      <div style={{ fontSize: 11, color: COLORS.textMuted, paddingLeft: 26 }}>
                        <div style={{ fontWeight: 500, color: isCompleted ? COLORS.text : COLORS.textMuted }}>{step.type === 'sms' ? 'SMS' : 'Call'}</div>
                        <div>{step.description?.substring(0, 50) || ''}</div>
                        {step.executedAt && <div style={{ fontSize: 10, color: COLORS.textMuted }}>{new Date(step.executedAt).toLocaleDateString()}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 10 }}>
                Started: {new Date(seq.started_at).toLocaleDateString()}
                {seq.outcome && <span style={{ marginLeft: 12 }}>Outcome: <Badge label={seq.outcome} color={seq.outcome === 'customer_saved' ? COLORS.green : COLORS.textMuted} /></span>}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function CustomerHealthPage() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [rescoring, setRescoring] = useState(false);

  useEffect(() => {
    if (activeTab === 'dashboard') {
      adminFetch('/admin/health/dashboard')
        .then(setDashboard)
        .catch(() => setDashboard(null));
    }
  }, [activeTab]);

  async function handleRescoreAll() {
    setRescoring(true);
    try {
      await adminFetch('/admin/health/rescore-all', { method: 'POST' });
      // Refresh dashboard after a short delay
      setTimeout(() => {
        adminFetch('/admin/health/dashboard').then(setDashboard).catch(() => {});
        setRescoring(false);
      }, 3000);
    } catch {
      setRescoring(false);
    }
  }

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'scores', label: 'Health Scores' },
    { key: 'alerts', label: 'Alerts' },
    { key: 'sequences', label: 'Save Sequences' },
  ];

  return (
    <div style={{ backgroundColor: COLORS.bg, minHeight: '100vh', padding: 24, color: COLORS.text }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: COLORS.heading }}>Customer Health & Churn Prediction</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: COLORS.textMuted }}>Monitor customer health scores, detect churn risk, and automate retention</p>
        </div>
        <button
          onClick={handleRescoreAll}
          disabled={rescoring}
          style={{
            padding: '8px 18px', borderRadius: 8, border: 'none', backgroundColor: COLORS.teal,
            color: '#fff', fontSize: 13, fontWeight: 600, cursor: rescoring ? 'default' : 'pointer',
            opacity: rescoring ? 0.6 : 1,
          }}
        >{rescoring ? 'Rescoring...' : 'Rescore All'}</button>
      </div>

      <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {activeTab === 'dashboard' && <DashboardTab data={dashboard} />}
      {activeTab === 'scores' && <ScoresTab />}
      {activeTab === 'alerts' && <AlertsTab />}
      {activeTab === 'sequences' && <SequencesTab />}
    </div>
  );
}
