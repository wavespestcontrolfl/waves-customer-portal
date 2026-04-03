import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', orange: '#f97316', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', purple: '#a78bfa' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
  }).then(r => r.json());
}
function adminPost(path, body) {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

function fmt(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtDec(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(n) { return (Number(n) || 0).toFixed(1) + '%'; }

const TABS = [
  { key: 'overview', label: 'Overview', icon: '📈' },
  { key: 'service-lines', label: 'Service Lines', icon: '🎯' },
  { key: 'advisor', label: 'AI Advisor', icon: '🤖' },
  { key: 'capacity', label: 'Capacity', icon: '📊' },
  { key: 'seo', label: 'SEO Dashboard', icon: '🔍' },
  { key: 'seo-advisor', label: 'SEO Advisor', icon: '🧠' },
];

const thStyle = { padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: D.muted, borderBottom: `1px solid ${D.border}`, textTransform: 'uppercase', letterSpacing: '0.5px' };
const thR = { ...thStyle, textAlign: 'right' };
const tdStyle = { padding: '10px 14px', fontSize: 13, color: D.text, borderBottom: `1px solid ${D.border}`, fontFamily: MONO };
const tdR = { ...tdStyle, textAlign: 'right' };
const tdText = { ...tdStyle, fontFamily: 'inherit' };

function Card({ children, style }) {
  return <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, ...style }}>{children}</div>;
}

function KpiCard({ label, value, sub, color }) {
  return (
    <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 12, color: D.muted, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || D.white, fontFamily: MONO }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: sub.color || D.muted, fontFamily: MONO }}>{sub.text}</div>}
    </Card>
  );
}

function Badge({ mode }) {
  const colors = { base: D.green, spent: D.amber, stop: D.red };
  const labels = { base: 'BASE', spent: 'SPENT', stop: 'STOP' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
      background: (colors[mode] || D.muted) + '22', color: colors[mode] || D.muted,
      fontFamily: MONO, letterSpacing: '0.5px',
    }}>{labels[mode] || mode?.toUpperCase()}</span>
  );
}

function roasColor(roas) {
  if (roas >= 4) return D.green;
  if (roas >= 2) return D.amber;
  return D.red;
}

// =========================================================================
// OVERVIEW TAB
// =========================================================================
function OverviewTab() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/ads/campaigns').then(d => { setCampaigns(d.campaigns || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading campaigns...</div>;
  if (campaigns.length === 0) return <EmptyState />;

  const total7 = campaigns.reduce((s, c) => ({ spend: s.spend + (c.last7d?.spend || 0), value: s.value + (c.last7d?.conversionValue || 0), conv: s.conv + (c.last7d?.conversions || 0), clicks: s.clicks + (c.last7d?.clicks || 0) }), { spend: 0, value: 0, conv: 0, clicks: 0 });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <KpiCard label="7-Day Ad Spend" value={fmt(total7.spend)} />
        <KpiCard label="7-Day Revenue" value={fmt(total7.value)} color={D.green} />
        <KpiCard label="Blended ROAS" value={total7.spend > 0 ? (total7.value / total7.spend).toFixed(1) + 'x' : '—'} color={total7.spend > 0 ? roasColor(total7.value / total7.spend) : D.muted} />
        <KpiCard label="Conversions" value={total7.conv.toFixed(0)} sub={{ text: `${total7.clicks} clicks`, color: D.muted }} />
      </div>

      <Card>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Campaign Performance</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Campaign</th>
                <th style={thR}>Mode</th>
                <th style={thR}>Budget</th>
                <th style={thR}>7d Spend</th>
                <th style={thR}>7d Revenue</th>
                <th style={thR}>ROAS</th>
                <th style={thR}>CPA</th>
                <th style={thR}>Conv</th>
                <th style={thR}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => {
                const p = c.last7d || {};
                const trendIcon = c.last7d?.roas > (c.last30d?.roas || 0) * 1.05 ? '📈' : c.last7d?.roas < (c.last30d?.roas || 0) * 0.8 ? '📉' : '➡️';
                return (
                  <tr key={c.id}>
                    <td style={tdText}>
                      <div>{c.campaign_name}</div>
                      <div style={{ fontSize: 11, color: D.muted }}>{c.target_area} • {c.campaign_type}</div>
                    </td>
                    <td style={tdR}><Badge mode={c.budget_mode} /></td>
                    <td style={tdR}>{fmtDec(c.daily_budget_current)}/d</td>
                    <td style={tdR}>{fmtDec(p.spend)}</td>
                    <td style={tdR}>{fmtDec(p.conversionValue)}</td>
                    <td style={{ ...tdR, color: roasColor(p.roas) }}>{p.roas ? p.roas + 'x' : '—'}</td>
                    <td style={tdR}>{p.cpa ? fmtDec(p.cpa) : '—'}</td>
                    <td style={tdR}>{p.conversions || 0}</td>
                    <td style={{ ...tdR, fontSize: 16 }}>{trendIcon}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function EmptyState() {
  return (
    <Card style={{ textAlign: 'center', padding: 60 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>📣</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: D.white, marginBottom: 8 }}>No Campaigns Yet</div>
      <div style={{ fontSize: 14, color: D.muted, maxWidth: 400, margin: '0 auto' }}>
        Connect your Google Ads account to start tracking campaign performance, service-line attribution, and get daily AI-powered recommendations.
      </div>
    </Card>
  );
}

// =========================================================================
// SERVICE LINES TAB
// =========================================================================
function ServiceLinesTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('30d');

  useEffect(() => {
    setLoading(true);
    adminFetch(`/admin/ads/service-lines?period=${period}`).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, [period]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading service-line data...</div>;
  if (!data || data.totalLeads === 0) return <Card style={{ textAlign: 'center', padding: 40 }}><div style={{ color: D.muted }}>No attribution data yet. Leads will appear here as they come in through your ad campaigns.</div></Card>;

  const bucketIcons = { recurring: '🔄', one_time_entry: '⚡', high_ticket_specialty: '💎', lawn_seasonal: '🌿' };
  const bucketLabels = { recurring: 'RECURRING PROGRAMS', one_time_entry: 'ONE-TIME ENTRY', high_ticket_specialty: 'HIGH-TICKET SPECIALTY', lawn_seasonal: 'LAWN SEASONAL' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, color: D.muted }}>Service Line Performance</div>
        <div style={{ display: 'flex', gap: 4, background: D.bg, borderRadius: 8, padding: 3 }}>
          {['7d', '30d', '90d'].map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
              background: period === p ? D.teal : 'transparent', color: period === p ? D.white : D.muted,
            }}>{p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : '90 Days'}</button>
          ))}
        </div>
      </div>

      {(data.byBucket || []).map(b => (
        <Card key={b.bucket}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <span style={{ fontSize: 18 }}>{bucketIcons[b.bucket] || '📦'}</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: D.white }}>{bucketLabels[b.bucket] || b.bucket.toUpperCase()}</span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Metric</th>
                  <th style={thR}>Value</th>
                  <th style={thStyle}>Metric</th>
                  <th style={thR}>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={tdText}>Leads</td><td style={tdR}>{b.leads}</td>
                  <td style={tdText}>Booked</td><td style={tdR}>{b.booked}</td>
                </tr>
                <tr>
                  <td style={tdText}>Lead → Book %</td><td style={{ ...tdR, color: b.leadToBookRate >= 60 ? D.green : D.amber }}>{pct(b.leadToBookRate)}</td>
                  <td style={tdText}>Book → Complete %</td><td style={{ ...tdR, color: b.bookToCompleteRate >= 80 ? D.green : D.amber }}>{pct(b.bookToCompleteRate)}</td>
                </tr>
                <tr>
                  <td style={tdText}>Ad Spend</td><td style={tdR}>{fmt(b.adSpend)}</td>
                  <td style={tdText}>Cost/Lead</td><td style={tdR}>{fmtDec(b.costPerLead)}</td>
                </tr>
                <tr>
                  <td style={tdText}>Cost/Booked Job</td><td style={tdR}>{fmtDec(b.costPerBookedJob)}</td>
                  <td style={tdText}>Completed Revenue</td><td style={{ ...tdR, color: D.green }}>{fmt(b.completedRevenue)}</td>
                </tr>
                <tr>
                  <td style={tdText}>ROAS</td><td style={{ ...tdR, color: roasColor(b.roas), fontWeight: 700 }}>{b.roas}x</td>
                  <td style={tdText}>Avg Ticket</td><td style={tdR}>{fmt(b.avgTicket)}</td>
                </tr>
                <tr>
                  <td style={tdText}>Gross Margin</td><td style={tdR}>{pct(b.grossMargin)}</td>
                  <td style={tdText}>{b.ltvToCAC != null ? 'LTV:CAC' : 'Proj LTV 12mo'}</td>
                  <td style={{ ...tdR, color: (b.ltvToCAC || 0) >= 10 ? D.green : D.amber }}>
                    {b.ltvToCAC != null ? b.ltvToCAC + 'x' : fmt(b.projectedLTV12mo)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {b.verdict && (
            <div style={{ marginTop: 12, padding: '10px 14px', background: D.bg, borderRadius: 8, fontSize: 13, color: D.text, borderLeft: `3px solid ${b.roas >= 3 ? D.green : b.roas >= 1.5 ? D.amber : D.red}` }}>
              {b.verdict}
            </div>
          )}

          {b.services?.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: D.muted }}>
              Services: {b.services.join(', ')}
            </div>
          )}
        </Card>
      ))}

      {/* Per-service table */}
      <Card>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>Per-Service Breakdown</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Service</th>
                <th style={thR}>Leads</th>
                <th style={thR}>Booked</th>
                <th style={thR}>Close %</th>
                <th style={thR}>Spend</th>
                <th style={thR}>CPA</th>
                <th style={thR}>Ticket</th>
                <th style={thR}>ROAS</th>
                <th style={thR}>LTV ROAS</th>
                <th style={thR}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {(data.bySpecificService || []).map((s, i) => (
                <tr key={i}>
                  <td style={tdText}>{s.service}</td>
                  <td style={tdR}>{s.leads}</td>
                  <td style={tdR}>{s.booked}</td>
                  <td style={{ ...tdR, color: s.closeRate >= 60 ? D.green : D.amber }}>{pct(s.closeRate)}</td>
                  <td style={tdR}>{fmt(s.adSpend)}</td>
                  <td style={tdR}>{s.cpa ? fmtDec(s.cpa) : '—'}</td>
                  <td style={tdR}>{s.avgTicket ? fmt(s.avgTicket) : '—'}</td>
                  <td style={{ ...tdR, color: roasColor(s.roas) }}>{s.roas ? s.roas + 'x' : '—'}</td>
                  <td style={{ ...tdR, color: s.ltvROAS ? D.purple : D.muted }}>{s.ltvROAS ? s.ltvROAS + 'x' : '—'}</td>
                  <td style={tdR}>{s.margin != null ? s.margin + '%' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: D.muted, display: 'flex', gap: 16 }}>
          <span>ROAS = immediate return</span>
          <span style={{ color: D.purple }}>LTV ROAS = 12-month projected return (recurring services)</span>
        </div>
      </Card>
    </div>
  );
}

// =========================================================================
// AI ADVISOR TAB
// =========================================================================
function AdvisorTab() {
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [applied, setApplied] = useState({});

  useEffect(() => {
    Promise.all([
      adminFetch('/admin/ads/advisor'),
      adminFetch('/admin/ads/advisor/history'),
    ]).then(([r, h]) => {
      setReport(r.report);
      setHistory(h.reports || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    const r = await adminPost('/admin/ads/advisor/generate', {});
    setReport({ report_data: r.report, date: new Date().toISOString().split('T')[0], grade: r.report?.grade });
    setGenerating(false);
  };

  const handleApply = async (rec, idx) => {
    const result = await adminPost('/admin/ads/advisor/apply', {
      action: rec.apply_action,
      campaignName: rec.campaign,
      reason: rec.action,
    });
    setApplied(prev => ({ ...prev, [idx]: new Date().toLocaleTimeString() }));
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading advisor report...</div>;

  const data = report?.report_data || {};

  const gradeColor = (g) => {
    if (!g) return D.muted;
    if (g.startsWith('A')) return D.green;
    if (g.startsWith('B')) return D.teal;
    if (g.startsWith('C')) return D.amber;
    return D.red;
  };

  const priorityColor = { high: D.red, medium: D.amber, low: D.muted };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, color: D.muted }}>
          AI Campaign Advisor {report?.date ? `— ${new Date(report.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}
        </div>
        <button onClick={handleGenerate} disabled={generating} style={{
          padding: '8px 16px', borderRadius: 8, border: `1px solid ${D.teal}`, background: 'transparent',
          color: D.teal, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: generating ? 0.5 : 1,
        }}>{generating ? 'Generating...' : 'Generate Report'}</button>
      </div>

      {!report ? (
        <Card style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🤖</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: D.white, marginBottom: 8 }}>No Reports Yet</div>
          <div style={{ fontSize: 14, color: D.muted }}>Click "Generate Report" to run the AI advisor, or wait for the daily 8 AM auto-run.</div>
        </Card>
      ) : (
        <>
          {/* Grade + Assessment */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{
                width: 72, height: 72, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 32, fontWeight: 800, fontFamily: MONO,
                background: gradeColor(data.grade) + '22', color: gradeColor(data.grade),
                border: `2px solid ${gradeColor(data.grade)}44`,
              }}>{data.grade || '?'}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>Overall Grade</div>
                <div style={{ fontSize: 14, color: D.text, lineHeight: 1.5 }}>{data.overall_assessment}</div>
              </div>
            </div>
          </Card>

          {/* Recommendations */}
          {(data.recommendations || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>Recommendations</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {['high', 'medium', 'low'].map(priority => {
                  const recs = (data.recommendations || []).filter(r => r.priority === priority);
                  if (recs.length === 0) return null;
                  return (
                    <div key={priority}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: priorityColor[priority], textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.5px' }}>
                        {priority === 'high' ? '🔴' : priority === 'medium' ? '🟡' : '💡'} {priority} Priority
                      </div>
                      {recs.map((rec, idx) => {
                        const globalIdx = `${priority}-${idx}`;
                        return (
                          <div key={idx} style={{
                            padding: '14px 16px', background: D.bg, borderRadius: 8, marginBottom: 8,
                            borderLeft: `3px solid ${priorityColor[priority]}`,
                          }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>
                              {rec.campaign && <span style={{ color: D.teal }}>{rec.campaign}: </span>}
                              {rec.action}
                            </div>
                            {rec.reasoning && <div style={{ fontSize: 12, color: D.muted, marginBottom: 6 }}>{rec.reasoning}</div>}
                            {rec.estimated_impact && <div style={{ fontSize: 12, color: D.green, marginBottom: 8 }}>Est. impact: {rec.estimated_impact}</div>}
                            {rec.apply_action && (
                              <button
                                onClick={() => handleApply(rec, globalIdx)}
                                disabled={!!applied[globalIdx]}
                                style={{
                                  padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                  background: applied[globalIdx] ? D.green + '22' : D.teal,
                                  color: applied[globalIdx] ? D.green : D.white,
                                }}
                              >{applied[globalIdx] ? `Applied at ${applied[globalIdx]}` : `Apply: ${rec.apply_action.replace(/_/g, ' ')}`}</button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Waste Alerts */}
          {(data.waste_alerts || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.red, marginBottom: 12 }}>Waste Alerts</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={thStyle}>Search Term</th><th style={thR}>Spend</th><th style={thR}>Conv</th><th style={thR}>Action</th></tr></thead>
                  <tbody>
                    {data.waste_alerts.map((w, i) => (
                      <tr key={i}>
                        <td style={tdText}>{w.search_term}</td>
                        <td style={{ ...tdR, color: D.red }}>{fmtDec(w.spend)}</td>
                        <td style={tdR}>{w.conversions}</td>
                        <td style={tdR}><span style={{ color: D.amber, fontSize: 12 }}>{w.action}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Scaling Opportunities */}
          {(data.scaling_opportunities || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.green, marginBottom: 12 }}>Scaling Opportunities</div>
              {data.scaling_opportunities.map((s, i) => (
                <div key={i} style={{ padding: '10px 14px', background: D.bg, borderRadius: 8, marginBottom: 6 }}>
                  <div style={{ fontSize: 13, color: D.white }}><strong>{s.campaign}</strong>: {fmt(s.current_budget)}/d → {fmt(s.suggested_budget)}/d</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{s.headroom_reason}</div>
                </div>
              ))}
            </Card>
          )}

          {/* Insights */}
          {(data.insights || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>{'💡'} Insights</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.insights.map((ins, i) => (
                  <div key={i} style={{ fontSize: 13, color: D.text, padding: '8px 12px', background: D.bg, borderRadius: 6, lineHeight: 1.5 }}>
                    {'•'} {ins}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Capacity Warnings */}
          {(data.capacity_warnings || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.amber, marginBottom: 12 }}>Capacity Warnings</div>
              {data.capacity_warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 13, color: D.text, padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4 }}>
                  <strong>{w.area}</strong> at {w.utilization}% — {w.recommendation}
                </div>
              ))}
            </Card>
          )}

          {/* History */}
          {history.length > 1 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Previous Reports</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {history.slice(1, 8).map((h, i) => (
                  <div key={i} style={{
                    padding: '8px 14px', background: D.bg, borderRadius: 8, fontSize: 12, color: D.muted,
                    border: `1px solid ${D.border}`,
                  }}>
                    <span style={{ color: D.text }}>{new Date(h.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <span style={{ color: gradeColor(h.grade), fontWeight: 700, marginLeft: 8 }}>{h.grade}</span>
                    <span style={{ marginLeft: 8 }}>{h.recommendation_count} recs</span>
                    {h.applied_count > 0 && <span style={{ color: D.green, marginLeft: 4 }}>({h.applied_count} applied)</span>}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// =========================================================================
// CAPACITY HEATMAP TAB
// =========================================================================
function CapacityTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/ads/capacity-heatmap').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading capacity data...</div>;
  if (!data) return <Card style={{ textAlign: 'center', padding: 40 }}><div style={{ color: D.muted }}>Unable to load capacity data</div></Card>;

  const zoneColors = { green: D.green, yellow: D.amber, orange: D.orange, red: D.red };
  const modeEmoji = { base: '🟢', spent: '🟡', stop: '🔴' };
  const areaLabels = { all: 'ALL AREAS', 'Lakewood Ranch': 'LWR', Parrish: 'Parrish', Sarasota: 'Sarasota', Venice: 'Venice' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ fontSize: 14, color: D.muted }}>Capacity & Ad Budget Status — Week View</div>

      {Object.entries(data.heatmap || {}).map(([area, info]) => (
        <Card key={area}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>{areaLabels[area] || area}</div>
              <div style={{ fontSize: 12, color: D.muted }}>{info.techs} tech{info.techs !== 1 ? 's' : ''}</div>
            </div>
            <div style={{ fontSize: 14, fontFamily: MONO, color: D.text }}>
              {info.weeklyUtilization}% weekly
              <span style={{ color: D.muted, fontSize: 12, marginLeft: 8 }}>{info.weeklyBooked}/{info.weeklySlots}</span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
            {(info.days || []).map((day, i) => {
              const color = zoneColors[day.colorZone] || D.muted;
              return (
                <div key={i} style={{
                  background: color + '15', border: `1px solid ${color}44`, borderRadius: 10,
                  padding: '12px 8px', textAlign: 'center', minWidth: 0,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: D.muted, marginBottom: 4 }}>{day.dayName}</div>
                  <div style={{ fontSize: 10, color: D.muted, marginBottom: 8 }}>{day.dayLabel}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: MONO, marginBottom: 4 }}>{day.utilizationPct}%</div>
                  <div style={{ fontSize: 11, color: D.muted, fontFamily: MONO, marginBottom: 6 }}>{day.booked}/{day.slots}</div>
                  <div style={{ fontSize: 10 }}>
                    {modeEmoji[day.budgetMode] || '⚪'}{' '}
                    <span style={{ fontWeight: 600, fontSize: 9, letterSpacing: '0.5px', color: D.muted }}>{day.budgetMode?.toUpperCase()}</span>
                    {day.isSunday && <span style={{ color: D.teal, fontSize: 9 }}>*</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ))}

      {/* Legend */}
      <Card style={{ padding: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, fontSize: 12, color: D.muted }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: D.green, marginRight: 6 }} />0–70% Green (full ads)</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: D.amber, marginRight: 6 }} />71–85% Yellow (may cap)</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: D.orange, marginRight: 6 }} />86–95% Orange (capped)</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: D.red, marginRight: 6 }} />96–100% Red (soft-stop)</span>
        </div>
        <div style={{ fontSize: 11, color: D.muted, marginTop: 10 }}>
          <span style={{ color: D.teal }}>*</span> Sunday runs at full power based on Monday's capacity (no time-of-day check)
        </div>
      </Card>
    </div>
  );
}

// =========================================================================
// SEO DASHBOARD TAB
// =========================================================================
function SEODashboardTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(28);
  const [queryFilter, setQueryFilter] = useState('all'); // all, nonbrand, branded
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    setLoading(true);
    adminFetch(`/admin/seo/dashboard?period=${period}`).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, [period]);

  const handleSync = async () => {
    setSyncing(true);
    await adminPost('/admin/seo/sync', { daysBack: 7 });
    setSyncing(false);
    // Reload
    const d = await adminFetch(`/admin/seo/dashboard?period=${period}`);
    setData(d);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading SEO data...</div>;

  const hasData = data?.current?.clicks > 0 || data?.topQueries?.length > 0;

  if (!hasData) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card style={{ textAlign: 'center', padding: 60 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
        <div style={{ fontSize: 18, fontWeight: 600, color: D.white, marginBottom: 8 }}>No Search Console Data Yet</div>
        <div style={{ fontSize: 14, color: D.muted, maxWidth: 500, margin: '0 auto 20px' }}>
          Connect your Google Search Console account to start tracking organic search performance, query rankings, and page visibility.
        </div>
        <button onClick={handleSync} disabled={syncing} style={{
          padding: '10px 20px', borderRadius: 8, border: `1px solid ${D.teal}`, background: 'transparent',
          color: D.teal, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: syncing ? 0.5 : 1,
        }}>{syncing ? 'Syncing...' : 'Sync GSC Data'}</button>
      </Card>
    </div>
  );

  const cur = data.current || {};
  const chg = data.change || {};
  const posColor = (v) => v >= 0 ? D.green : D.red;

  const filteredQueries = (data.topQueries || []).filter(q => {
    if (queryFilter === 'nonbrand') return !q.is_branded;
    if (queryFilter === 'branded') return q.is_branded;
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 4, background: D.bg, borderRadius: 8, padding: 3 }}>
          {[7, 28, 90].map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
              background: period === p ? D.teal : 'transparent', color: period === p ? D.white : D.muted,
            }}>{p === 7 ? '7 Days' : p === 28 ? '28 Days' : '90 Days'}</button>
          ))}
        </div>
        <button onClick={handleSync} disabled={syncing} style={{
          padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.border}`, background: 'transparent',
          color: D.muted, fontSize: 12, cursor: 'pointer', opacity: syncing ? 0.5 : 1,
        }}>{syncing ? 'Syncing...' : 'Sync GSC'}</button>
      </div>

      {/* Core 4 KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <KpiCard label="Total Clicks" value={cur.clicks?.toLocaleString() || '0'} sub={chg.clicks ? { text: `${chg.clicks >= 0 ? '+' : ''}${chg.clicks}% vs prev`, color: posColor(chg.clicks) } : null} />
        <KpiCard label="Total Impressions" value={cur.impressions?.toLocaleString() || '0'} sub={chg.impressions ? { text: `${chg.impressions >= 0 ? '+' : ''}${chg.impressions}% vs prev`, color: posColor(chg.impressions) } : null} />
        <KpiCard label="Avg CTR" value={(cur.ctr * 100).toFixed(2) + '%'} color={cur.ctr > 0.03 ? D.green : D.amber} />
        <KpiCard label="Non-Brand Clicks" value={cur.nonbrandClicks?.toLocaleString() || '0'} sub={chg.nonbrandClicks ? { text: `${chg.nonbrandClicks >= 0 ? '+' : ''}${chg.nonbrandClicks}% vs prev`, color: posColor(chg.nonbrandClicks) } : null} color={D.purple} />
      </div>

      {/* Branded vs Non-Branded Split */}
      <Card>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>Branded vs Non-Branded</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ padding: 16, background: D.bg, borderRadius: 8, borderLeft: `3px solid ${D.teal}` }}>
            <div style={{ fontSize: 12, color: D.muted, marginBottom: 4 }}>Branded (people searching "Waves")</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: D.teal, fontFamily: MONO }}>{cur.brandedClicks?.toLocaleString() || 0} clicks</div>
            <div style={{ fontSize: 12, color: D.muted, fontFamily: MONO }}>{cur.brandedImpressions?.toLocaleString() || 0} impressions</div>
          </div>
          <div style={{ padding: 16, background: D.bg, borderRadius: 8, borderLeft: `3px solid ${D.purple}` }}>
            <div style={{ fontSize: 12, color: D.muted, marginBottom: 4 }}>Non-Branded (real SEO capture)</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: D.purple, fontFamily: MONO }}>{cur.nonbrandClicks?.toLocaleString() || 0} clicks</div>
            <div style={{ fontSize: 12, color: D.muted, fontFamily: MONO }}>{cur.nonbrandImpressions?.toLocaleString() || 0} impressions</div>
          </div>
        </div>
      </Card>

      {/* Device Breakdown */}
      {(data.devices || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Device Breakdown</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {data.devices.map((d, i) => {
              const icons = { mobile: '📱', desktop: '🖥️', tablet: '📟' };
              const totalClicks = data.devices.reduce((s, x) => s + parseInt(x.clicks), 0);
              const pctOfTotal = totalClicks > 0 ? Math.round((parseInt(d.clicks) / totalClicks) * 100) : 0;
              return (
                <div key={i} style={{ flex: 1, minWidth: 140, padding: 14, background: D.bg, borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 24, marginBottom: 4 }}>{icons[d.device] || '🌐'}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: D.white, textTransform: 'capitalize' }}>{d.device}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: D.teal, fontFamily: MONO }}>{parseInt(d.clicks).toLocaleString()}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>{pctOfTotal}% of clicks</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Top Queries */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>Top Queries</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[['all', 'All'], ['nonbrand', 'Non-Brand'], ['branded', 'Branded']].map(([k, l]) => (
              <button key={k} onClick={() => setQueryFilter(k)} style={{
                padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 500,
                background: queryFilter === k ? D.teal : D.bg, color: queryFilter === k ? D.white : D.muted,
              }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Query</th>
                <th style={thR}>Clicks</th>
                <th style={thR}>Impr</th>
                <th style={thR}>CTR</th>
                <th style={thR}>Position</th>
                <th style={thStyle}>Service</th>
                <th style={thStyle}>City</th>
              </tr>
            </thead>
            <tbody>
              {filteredQueries.slice(0, 25).map((q, i) => {
                const ctr = parseInt(q.impressions) > 0 ? (parseInt(q.clicks) / parseInt(q.impressions) * 100).toFixed(1) : '0';
                const pos = parseFloat(q.avg_position).toFixed(1);
                const posClr = pos <= 3 ? D.green : pos <= 10 ? D.amber : D.red;
                return (
                  <tr key={i}>
                    <td style={tdText}>
                      <span>{q.query}</span>
                      {q.is_branded && <span style={{ marginLeft: 6, fontSize: 9, padding: '1px 5px', borderRadius: 3, background: D.teal + '22', color: D.teal }}>BRAND</span>}
                    </td>
                    <td style={tdR}>{parseInt(q.clicks)}</td>
                    <td style={tdR}>{parseInt(q.impressions).toLocaleString()}</td>
                    <td style={tdR}>{ctr}%</td>
                    <td style={{ ...tdR, color: posClr }}>{pos}</td>
                    <td style={{ ...tdText, fontSize: 11, color: D.muted }}>{q.service_category || '—'}</td>
                    <td style={{ ...tdText, fontSize: 11, color: D.muted }}>{q.city_target || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Page 2 Opportunities */}
      {(data.opportunities || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.amber, marginBottom: 4 }}>Page 2 Opportunities (Positions 4–15)</div>
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>These queries have high impressions but rank on page 2 — push them to page 1 for significant traffic gains.</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={thStyle}>Query</th><th style={thR}>Impr</th><th style={thR}>Position</th><th style={thR}>Potential Clicks</th><th style={thStyle}>Service</th><th style={thStyle}>City</th></tr></thead>
              <tbody>
                {data.opportunities.slice(0, 15).map((q, i) => (
                  <tr key={i}>
                    <td style={tdText}>{q.query}</td>
                    <td style={tdR}>{parseInt(q.impressions).toLocaleString()}</td>
                    <td style={{ ...tdR, color: D.amber }}>{parseFloat(q.avg_position).toFixed(1)}</td>
                    <td style={{ ...tdR, color: D.green }}>{Math.round(parseInt(q.impressions) * 0.08)}</td>
                    <td style={{ ...tdText, fontSize: 11, color: D.muted }}>{q.service_category || '—'}</td>
                    <td style={{ ...tdText, fontSize: 11, color: D.muted }}>{q.city_target || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Declining Queries */}
      {(data.declining || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.red, marginBottom: 12 }}>Declining Queries</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={thStyle}>Query</th><th style={thR}>Current</th><th style={thR}>Previous</th><th style={thR}>Change</th></tr></thead>
              <tbody>
                {data.declining.map((q, i) => (
                  <tr key={i}>
                    <td style={tdText}>{q.query}</td>
                    <td style={tdR}>{q.currentClicks}</td>
                    <td style={tdR}>{q.previousClicks}</td>
                    <td style={{ ...tdR, color: D.red }}>{q.changePct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Top Pages */}
      {(data.topPages || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>Top Pages</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={thStyle}>Page</th><th style={thR}>Clicks</th><th style={thR}>Impr</th><th style={thR}>CTR</th><th style={thR}>Position</th><th style={thStyle}>Type</th></tr></thead>
              <tbody>
                {data.topPages.slice(0, 15).map((p, i) => {
                  const ctr = parseInt(p.impressions) > 0 ? (parseInt(p.clicks) / parseInt(p.impressions) * 100).toFixed(1) : '0';
                  const shortUrl = p.page_url.replace(/https?:\/\/(www\.)?/, '').replace(/\/$/, '');
                  return (
                    <tr key={i}>
                      <td style={{ ...tdText, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.page_url}>{shortUrl}</td>
                      <td style={tdR}>{parseInt(p.clicks)}</td>
                      <td style={tdR}>{parseInt(p.impressions).toLocaleString()}</td>
                      <td style={tdR}>{ctr}%</td>
                      <td style={{ ...tdR, color: parseFloat(p.avg_position) <= 10 ? D.green : D.amber }}>{parseFloat(p.avg_position).toFixed(1)}</td>
                      <td style={{ ...tdText, fontSize: 11, color: D.muted }}>{p.page_type || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* CWV */}
      {(data.cwv || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Core Web Vitals</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Page</th><th style={thStyle}>Device</th>
                  <th style={thR}>LCP (ms)</th><th style={thR}>INP (ms)</th><th style={thR}>CLS</th><th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.cwv.map((c, i) => {
                  const statusColor = { good: D.green, needs_improvement: D.amber, poor: D.red };
                  return (
                    <tr key={i}>
                      <td style={{ ...tdText, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.page_url || 'Sitewide'}</td>
                      <td style={tdText}>{c.device}</td>
                      <td style={{ ...tdR, color: parseFloat(c.lcp_p75) <= 2500 ? D.green : D.red }}>{c.lcp_p75}</td>
                      <td style={{ ...tdR, color: parseFloat(c.inp_p75) <= 200 ? D.green : D.red }}>{c.inp_p75}</td>
                      <td style={{ ...tdR, color: parseFloat(c.cls_p75) <= 0.1 ? D.green : D.red }}>{c.cls_p75}</td>
                      <td style={{ ...tdText, color: statusColor[c.overall_status] || D.muted, fontWeight: 600, fontSize: 12 }}>{(c.overall_status || '').replace(/_/g, ' ')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Indexing Issues */}
      {(data.indexIssues || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.red, marginBottom: 12 }}>Indexing Issues ({data.indexIssues.length})</div>
          {data.indexIssues.slice(0, 10).map((iss, i) => (
            <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4, fontSize: 13, color: D.text, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{iss.page_url}</span>
              <span style={{ color: D.red, fontSize: 12 }}>{iss.issue_type?.replace(/_/g, ' ')}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// =========================================================================
// SEO ADVISOR TAB
// =========================================================================
function SEOAdvisorTab() {
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    Promise.all([
      adminFetch('/admin/seo/advisor'),
      adminFetch('/admin/seo/advisor/history'),
    ]).then(([r, h]) => {
      setReport(r.report);
      setHistory(h.reports || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    const r = await adminPost('/admin/seo/advisor/generate', {});
    setReport({ report_data: r.report, date: new Date().toISOString().split('T')[0], grade: r.report?.grade });
    setGenerating(false);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading SEO advisor...</div>;

  const data = report?.report_data || {};
  const gradeColor = (g) => {
    if (!g) return D.muted;
    if (g.startsWith('A')) return D.green;
    if (g.startsWith('B')) return D.teal;
    if (g.startsWith('C')) return D.amber;
    return D.red;
  };

  const priorityColor = { high: D.red, medium: D.amber, low: D.muted };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, color: D.muted }}>
          Weekly SEO Advisor {report?.date ? `— ${new Date(report.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}
        </div>
        <button onClick={handleGenerate} disabled={generating} style={{
          padding: '8px 16px', borderRadius: 8, border: `1px solid ${D.teal}`, background: 'transparent',
          color: D.teal, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: generating ? 0.5 : 1,
        }}>{generating ? 'Generating...' : 'Generate SEO Report'}</button>
      </div>

      {!report ? (
        <Card style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🧠</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: D.white, marginBottom: 8 }}>No SEO Reports Yet</div>
          <div style={{ fontSize: 14, color: D.muted }}>Click "Generate SEO Report" or wait for the weekly Monday 7 AM auto-run.</div>
        </Card>
      ) : (
        <>
          {/* Grade + Assessment */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{
                width: 72, height: 72, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 32, fontWeight: 800, fontFamily: MONO,
                background: gradeColor(data.grade) + '22', color: gradeColor(data.grade),
                border: `2px solid ${gradeColor(data.grade)}44`,
              }}>{data.grade || '?'}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>SEO Grade</div>
                <div style={{ fontSize: 14, color: D.text, lineHeight: 1.5 }}>{data.overall_assessment}</div>
              </div>
            </div>
          </Card>

          {/* Key Metrics */}
          {data.key_metrics && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
              <KpiCard label="Total Clicks" value={data.key_metrics.totalClicks?.toLocaleString() || '0'} sub={data.key_metrics.clicksChange ? { text: data.key_metrics.clicksChange + ' vs prev', color: D.muted } : null} />
              <KpiCard label="Non-Brand Clicks" value={data.key_metrics.nonbrandClicks?.toLocaleString() || '0'} color={D.purple} />
              <KpiCard label="Impressions" value={data.key_metrics.impressionsChange || '—'} />
              <KpiCard label="Avg Position" value={data.key_metrics.avgPosition || '—'} />
            </div>
          )}

          {/* Wins */}
          {(data.wins || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.green, marginBottom: 12 }}>{'🏆'} Wins</div>
              {data.wins.map((w, i) => (
                <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4, fontSize: 13, color: D.text, borderLeft: `3px solid ${D.green}` }}>
                  {w}
                </div>
              ))}
            </Card>
          )}

          {/* Recommendations */}
          {(data.recommendations || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>SEO Recommendations</div>
              {['high', 'medium', 'low'].map(priority => {
                const recs = (data.recommendations || []).filter(r => r.priority === priority);
                if (recs.length === 0) return null;
                return (
                  <div key={priority} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: priorityColor[priority], textTransform: 'uppercase', marginBottom: 8, letterSpacing: '0.5px' }}>
                      {priority === 'high' ? '🔴' : priority === 'medium' ? '🟡' : '💡'} {priority} Priority
                    </div>
                    {recs.map((rec, idx) => (
                      <div key={idx} style={{
                        padding: '14px 16px', background: D.bg, borderRadius: 8, marginBottom: 8,
                        borderLeft: `3px solid ${priorityColor[priority]}`,
                      }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>
                          {rec.category && <span style={{ color: D.muted, fontSize: 11, textTransform: 'uppercase', marginRight: 8 }}>[{rec.category}]</span>}
                          {rec.action}
                        </div>
                        {rec.page_or_query && <div style={{ fontSize: 12, color: D.teal, marginBottom: 4 }}>Target: {rec.page_or_query}</div>}
                        {rec.reasoning && <div style={{ fontSize: 12, color: D.muted, marginBottom: 4 }}>{rec.reasoning}</div>}
                        {rec.estimated_impact && <div style={{ fontSize: 12, color: D.green }}>Est. impact: {rec.estimated_impact}</div>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </Card>
          )}

          {/* Page 2 Opportunities */}
          {(data.page2_opportunities || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.amber, marginBottom: 12 }}>Page 2 Opportunities</div>
              {data.page2_opportunities.map((opp, i) => (
                <div key={i} style={{ padding: '10px 14px', background: D.bg, borderRadius: 8, marginBottom: 6, borderLeft: `3px solid ${D.amber}` }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>"{opp.query}" — Position {opp.position}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{opp.impressions} impressions • {opp.action}</div>
                </div>
              ))}
            </Card>
          )}

          {/* Declining Alerts */}
          {(data.declining_alerts || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.red, marginBottom: 12 }}>Declining Query Alerts</div>
              {data.declining_alerts.map((a, i) => (
                <div key={i} style={{ padding: '10px 14px', background: D.bg, borderRadius: 8, marginBottom: 6, borderLeft: `3px solid ${D.red}` }}>
                  <div style={{ fontSize: 13, color: D.white }}>"{a.query}" — <span style={{ color: D.red }}>{a.drop_pct}%</span> decline</div>
                  {a.action && <div style={{ fontSize: 12, color: D.muted }}>{a.action}</div>}
                </div>
              ))}
            </Card>
          )}

          {/* GBP Insights */}
          {(data.gbp_insights || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>{'📍'} GBP Insights</div>
              {data.gbp_insights.map((g, i) => (
                <div key={i} style={{ padding: '10px 14px', background: D.bg, borderRadius: 8, marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: D.teal }}>{g.location}</div>
                  <div style={{ fontSize: 12, color: D.text }}>{g.metric} — {g.recommendation}</div>
                </div>
              ))}
            </Card>
          )}

          {/* Technical Issues */}
          {(data.technical_issues || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.red, marginBottom: 12 }}>{'⚙️'} Technical Issues</div>
              {data.technical_issues.map((t, i) => (
                <div key={i} style={{ padding: '10px 14px', background: D.bg, borderRadius: 8, marginBottom: 6, borderLeft: `3px solid ${t.severity === 'high' ? D.red : D.amber}` }}>
                  <div style={{ fontSize: 13, color: D.white }}>{t.issue}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{t.fix}</div>
                </div>
              ))}
            </Card>
          )}

          {/* Mobile Insights */}
          {(data.mobile_insights || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>{'📱'} Mobile Insights</div>
              {data.mobile_insights.map((m, i) => (
                <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4, fontSize: 13, color: D.text }}>
                  <strong>{m.finding}</strong> — {m.action}
                </div>
              ))}
            </Card>
          )}

          {/* Previous Reports */}
          {history.length > 1 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Previous SEO Reports</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {history.slice(1, 8).map((h, i) => (
                  <div key={i} style={{ padding: '8px 14px', background: D.bg, borderRadius: 8, fontSize: 12, color: D.muted, border: `1px solid ${D.border}` }}>
                    <span style={{ color: D.text }}>{new Date(h.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <span style={{ color: gradeColor(h.grade), fontWeight: 700, marginLeft: 8 }}>{h.grade}</span>
                    <span style={{ marginLeft: 8 }}>{h.recommendation_count} recs</span>
                    <span style={{ marginLeft: 4 }}>{h.opportunity_count} opps</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// =========================================================================
// MAIN PAGE
// =========================================================================
export default function AdsPage() {
  const [tab, setTab] = useState('overview');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: D.white }}>Ads & Marketing</div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent',
            color: tab === t.key ? D.white : D.muted,
            transition: 'all 0.15s', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'service-lines' && <ServiceLinesTab />}
      {tab === 'advisor' && <AdvisorTab />}
      {tab === 'capacity' && <CapacityTab />}
      {tab === 'seo' && <SEODashboardTab />}
      {tab === 'seo-advisor' && <SEOAdvisorTab />}
    </div>
  );
}
