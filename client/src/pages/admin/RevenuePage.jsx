import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
  }).then(r => r.json());
}

function fmt(n) { return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

const PERIODS = [
  { key: 'month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'quarter', label: 'This Quarter' },
  { key: 'ytd', label: 'YTD' },
];

function marginColor(pct) {
  if (pct >= 55) return D.green;
  if (pct >= 40) return D.amber;
  return D.red;
}

function rpmhColor(val) {
  if (val >= 120) return D.green;
  if (val >= 100) return D.amber;
  return D.red;
}

function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20,
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ fontSize: 13, color: D.muted, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || D.white, fontFamily: MONO }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: sub.color || D.muted, fontFamily: MONO }}>{sub.text}</div>}
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
      <div style={{ color: D.muted, marginBottom: 4 }}>{label}</div>
      <div style={{ color: D.teal, fontFamily: MONO }}>{fmt(payload[0].value)} revenue</div>
      {payload[1] && <div style={{ color: D.muted, fontFamily: MONO }}>{fmt(payload[1].value)} cost</div>}
    </div>
  );
}

function AdAttributionSection({ period }) {
  const [attr, setAttr] = useState(null);
  useEffect(() => {
    adminFetch(`/admin/ads/revenue-attribution?period=${period}`).then(d => setAttr(d)).catch(() => {});
  }, [period]);

  if (!attr || !attr.sources?.length) return null;

  const sourceIcons = { 'Google Ads': '📣', 'Google LSA': '🏷️', 'Organic': '🌿', 'Referral': '🤝', 'Domain Sites': '🌐', 'Waves Website': '🌊', 'Google Business': '📍', 'Facebook': '📘', 'Nextdoor': '🏘️' };

  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, marginBottom: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Ad Attribution</div>
        {attr.blendedROAS && <div style={{ fontSize: 13, color: D.muted }}>Blended ROAS: <span style={{ color: D.teal, fontFamily: MONO, fontWeight: 700 }}>{attr.blendedROAS}x</span></div>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>Source</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Revenue</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Ad Spend</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>ROAS</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Customers</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>CAC</th>
            </tr>
          </thead>
          <tbody>
            {attr.sources.map((s, i) => (
              <tr key={i}>
                <td style={tdStyle}><span style={{ marginRight: 6 }}>{sourceIcons[s.source] || '📦'}</span>{s.source}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO }}>{fmt(s.revenue)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO }}>{s.adSpend > 0 ? fmt(s.adSpend) : '—'}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO, color: s.roas ? (s.roas >= 4 ? D.green : s.roas >= 2 ? D.amber : D.red) : D.muted }}>{s.roas ? s.roas + 'x' : 'N/A'}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO }}>{s.customers}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontFamily: MONO }}>{s.cac > 0 ? fmt(s.cac) : '$0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: D.muted }}>
        <span>Total attributed revenue: <span style={{ color: D.teal, fontFamily: MONO }}>{fmt(attr.totalRevenue)}</span></span>
        <span>Total ad spend: <span style={{ color: D.amber, fontFamily: MONO }}>{fmt(attr.totalAdSpend)}</span></span>
      </div>
    </div>
  );
}

export default function RevenuePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('month');

  useEffect(() => {
    setLoading(true);
    adminFetch(`/admin/revenue/overview?period=${period}`)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [period]);

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center', fontSize: 15 }}>Loading revenue data...</div>;
  if (!data) return <div style={{ color: D.red, padding: 60, textAlign: 'center' }}>Failed to load revenue data</div>;

  const t = data.topline;
  const vs = data.vsLastPeriod || {};
  const avgRevenuePerJob = t.totalServices > 0 ? Math.round(t.totalRevenue / t.totalServices) : 0;

  const kpis = [
    { label: 'Gross Revenue', value: fmt(t.totalRevenue), sub: vs.revenueChange != null ? { text: `${vs.revenueChange >= 0 ? '+' : ''}${vs.revenueChange.toFixed(1)}% vs last period`, color: vs.revenueChange >= 0 ? D.green : D.red } : null },
    { label: 'Gross Margin %', value: `${t.grossMarginPct}%`, color: marginColor(t.grossMarginPct) },
    { label: 'Revenue / Man-Hour', value: fmt(t.revenuePerManHour), color: rpmhColor(t.revenuePerManHour) },
    { label: 'MRR', value: fmt(t.mrr), color: D.teal },
    { label: 'ARR', value: fmt(t.arr), color: D.teal },
    { label: 'Avg Revenue / Job', value: fmt(avgRevenuePerJob) },
  ];

  const chartData = (data.revenueChart?.daily || []).map(d => ({
    ...d,
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }));

  const thStyle = { padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: D.muted, borderBottom: `1px solid ${D.border}`, textTransform: 'uppercase', letterSpacing: '0.5px' };
  const tdStyle = { padding: '10px 14px', fontSize: 14, color: D.text, borderBottom: `1px solid ${D.border}`, fontFamily: MONO };
  const tdTextStyle = { ...tdStyle, fontFamily: 'inherit' };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: D.white }}>Revenue</div>
          {data.period?.label && <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>{data.period.label}</div>}
        </div>
        <div style={{ display: 'flex', gap: 6, background: D.card, borderRadius: 8, padding: 4, border: `1px solid ${D.border}` }}>
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)} style={{
              padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
              background: period === p.key ? D.teal : 'transparent',
              color: period === p.key ? D.white : D.muted,
              transition: 'all 0.15s',
            }}>{p.label}</button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 28 }}>
        {kpis.map((k, i) => <KpiCard key={i} {...k} />)}
      </div>

      {/* Revenue Chart */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, marginBottom: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Daily Revenue</div>
          <div style={{ display: 'flex', gap: 20, fontSize: 13 }}>
            <span style={{ color: D.muted }}>MRR: <span style={{ color: D.teal, fontFamily: MONO }}>{fmt(t.mrr)}</span></span>
            <span style={{ color: D.muted }}>Services: <span style={{ color: D.white, fontFamily: MONO }}>{t.totalServices}</span></span>
          </div>
        </div>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={D.border} />
              <XAxis dataKey="date" tick={{ fill: D.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: D.border }} />
              <YAxis tick={{ fill: D.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: D.border }} tickFormatter={v => `$${v}`} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(14,165,233,0.08)' }} />
              <Bar dataKey="revenue" fill={D.teal} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ color: D.muted, textAlign: 'center', padding: 40, fontSize: 14 }}>No chart data for this period</div>
        )}
      </div>

      {/* Ad Attribution */}
      <AdAttributionSection period={period} />

      {/* Service Line Table */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, marginBottom: 28 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Service Line Breakdown</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Service Line</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Cost</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Margin %</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>RPMH</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Services</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>$/Job</th>
              </tr>
            </thead>
            <tbody>
              {(data.byServiceLine || []).map((s, i) => (
                <tr key={i}>
                  <td style={tdTextStyle}>{s.serviceLine}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(s.revenue)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(s.cost)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: marginColor(s.margin) }}>
                    {s.margin}%
                    {s.margin < 55 && <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: D.amber, marginLeft: 6, verticalAlign: 'middle' }} title="Below 55% target" />}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(s.rpmh)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{s.services}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(s.avgJobRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: D.muted }}>
          <span style={{ display: 'inline-block', width: 20, borderTop: `2px dashed ${D.amber}`, verticalAlign: 'middle', marginRight: 6 }} />
          55% margin target
        </div>
      </div>

      {/* Tier Analysis Table */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, marginBottom: 28 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Tier Analysis</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Tier</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Customers</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Avg $/Customer</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Services</th>
              </tr>
            </thead>
            <tbody>
              {(data.byTier || []).map((t, i) => (
                <tr key={i}>
                  <td style={tdTextStyle}>{t.tier}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{t.customers}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(t.revenue)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{t.customers > 0 ? fmt(Math.round(t.revenue / t.customers)) : '$0'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{t.services}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Technician Performance Table */}
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, marginBottom: 28 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Technician Performance</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Tech</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Services</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Hours</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>RPMH</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Margin %</th>
              </tr>
            </thead>
            <tbody>
              {(data.byTechnician || []).map((t, i) => (
                <tr key={i}>
                  <td style={tdTextStyle}>{t.tech}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{t.services}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{t.hours}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(t.revenue)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: rpmhColor(t.rpmh) }}>{fmt(t.rpmh)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', color: marginColor(t.margin) }}>{t.margin}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Alerts */}
      {data.alerts && data.alerts.length > 0 && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Alerts</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.alerts.map((a, i) => {
              const sevColor = a.severity === 'critical' ? D.red : a.severity === 'warning' ? D.amber : D.muted;
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
                  background: D.bg, borderRadius: 8, border: `1px solid ${sevColor}33`,
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor, flexShrink: 0 }} />
                  <div style={{ fontSize: 13, color: D.text }}>{a.message}</div>
                  <div style={{ marginLeft: 'auto', fontSize: 11, color: D.muted, textTransform: 'uppercase', flexShrink: 0 }}>{a.severity}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
