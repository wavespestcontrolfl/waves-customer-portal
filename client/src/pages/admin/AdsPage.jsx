import { useState, useEffect, lazy, Suspense } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { etDateString } from '../../lib/timezone';
const PPCDashboardPage = lazy(() => import('./PPCDashboardPage'));

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: `teal` folded to zinc-900, `purple`/`orange` fold too.
// Semantic green/amber/red preserved for status/alert accents.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', orange: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', purple: '#18181B', heading: '#09090B', inputBorder: '#D4D4D8' };
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
  { key: 'ppc-dashboard', label: 'PPC Dashboard' },
  { key: 'overview', label: 'Overview' },
  { key: 'service-lines', label: 'Service Lines' },
  { key: 'advisor', label: 'AI Advisor' },
  { key: 'capacity', label: 'Capacity' },
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
      <div style={{ fontSize: 24, fontWeight: 700, color: color || D.heading, fontFamily: MONO }}>{value}</div>
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
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Campaign Performance</div>
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
      <div style={{ fontSize: 18, fontWeight: 600, color: D.heading, marginBottom: 8 }}>No Campaigns Yet</div>
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
            <span style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{bucketLabels[b.bucket] || b.bucket.toUpperCase()}</span>
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
        <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Per-Service Breakdown</div>
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
    setReport({ report_data: r.report, date: etDateString(), grade: r.report?.grade });
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
          <div style={{ fontSize: 18, fontWeight: 600, color: D.heading, marginBottom: 8 }}>No Reports Yet</div>
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
                <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 4 }}>Overall Grade</div>
                <div style={{ fontSize: 14, color: D.text, lineHeight: 1.5 }}>{data.overall_assessment}</div>
              </div>
            </div>
          </Card>

          {/* Recommendations */}
          {(data.recommendations || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Recommendations</div>
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
                            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 4 }}>
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
                                  color: applied[globalIdx] ? D.green : D.heading,
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
                  <div style={{ fontSize: 13, color: D.heading }}><strong>{s.campaign}</strong>: {fmt(s.current_budget)}/d → {fmt(s.suggested_budget)}/d</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{s.headroom_reason}</div>
                </div>
              ))}
            </Card>
          )}

          {/* Insights */}
          {(data.insights || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>{'💡'} Insights</div>
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
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Previous Reports</div>
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
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{areaLabels[area] || area}</div>
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
        <div style={{ fontSize: 18, fontWeight: 600, color: D.heading, marginBottom: 8 }}>No Search Console Data Yet</div>
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
        <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Branded vs Non-Branded</div>
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
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Device Breakdown</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {data.devices.map((d, i) => {
              const icons = { mobile: '📱', desktop: '🖥️', tablet: '📟' };
              const totalClicks = data.devices.reduce((s, x) => s + parseInt(x.clicks), 0);
              const pctOfTotal = totalClicks > 0 ? Math.round((parseInt(d.clicks) / totalClicks) * 100) : 0;
              return (
                <div key={i} style={{ flex: 1, minWidth: 140, padding: 14, background: D.bg, borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 24, marginBottom: 4 }}>{icons[d.device] || '🌐'}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, textTransform: 'capitalize' }}>{d.device}</div>
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
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>Top Queries</div>
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
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Top Pages</div>
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
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Core Web Vitals</div>
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
    setReport({ report_data: r.report, date: etDateString(), grade: r.report?.grade });
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
          <div style={{ fontSize: 18, fontWeight: 600, color: D.heading, marginBottom: 8 }}>No SEO Reports Yet</div>
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
                <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 4 }}>SEO Grade</div>
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
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 16 }}>SEO Recommendations</div>
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
                        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 4 }}>
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
                  <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>"{opp.query}" — Position {opp.position}</div>
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
                  <div style={{ fontSize: 13, color: D.heading }}>"{a.query}" — <span style={{ color: D.red }}>{a.drop_pct}%</span> decline</div>
                  {a.action && <div style={{ fontSize: 12, color: D.muted }}>{a.action}</div>}
                </div>
              ))}
            </Card>
          )}

          {/* GBP Insights */}
          {(data.gbp_insights || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>{'📍'} GBP Insights</div>
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
                  <div style={{ fontSize: 13, color: D.heading }}>{t.issue}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{t.fix}</div>
                </div>
              ))}
            </Card>
          )}

          {/* Mobile Insights */}
          {(data.mobile_insights || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>{'📱'} Mobile Insights</div>
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
              <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Previous SEO Reports</div>
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
// =========================================================================
// SEO COMMAND CENTER TABS
// =========================================================================

function RankingsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
  useEffect(() => { setLoading(true); adminFetch(`/admin/seo/rankings?days=${days}`).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, [days]);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading rankings...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No ranking data yet. Configure DataForSEO credentials and enable GATE_SEO_INTELLIGENCE.</div></Card>;

  const s = data.summary || {};
  const posColor = (p) => !p ? D.muted : p <= 3 ? D.green : p <= 10 ? D.teal : p <= 20 ? D.amber : D.red;
  const deltaColor = (d) => d > 0 ? D.green : d < 0 ? D.red : D.muted;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 12 }}>
          <KpiCard label="Improving" value={s.improving || 0} color={D.green} />
          <KpiCard label="Declining" value={s.declining || 0} color={D.red} />
          <KpiCard label="Stable" value={s.stable || 0} />
          <KpiCard label="In Map Pack" value={s.inMapPack || 0} color={D.teal} />
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: days === d ? D.teal : D.bg, color: days === d ? D.white : D.muted }}>{d}d</button>
          ))}
        </div>
      </div>
      <Card>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={thStyle}>Keyword</th><th style={thStyle}>City</th>
              <th style={thR}>Position</th><th style={thR}>Map Pack</th><th style={thR}>Change</th>
              <th style={thStyle}>AIO</th><th style={thStyle}>Features</th>
            </tr></thead>
            <tbody>
              {(data.rankings || []).map((r, i) => (
                <tr key={i}>
                  <td style={{ ...tdStyle, fontFamily: 'inherit', fontWeight: 500 }}>{r.keyword}</td>
                  <td style={{ ...tdStyle, fontFamily: 'inherit', fontSize: 12, color: D.muted }}>{r.primary_city || '—'}</td>
                  <td style={{ ...tdR, color: posColor(r.currentPosition) }}>{r.currentPosition || '—'}</td>
                  <td style={{ ...tdR, color: r.mapPackPosition ? D.green : D.muted }}>{r.mapPackPosition || '—'}</td>
                  <td style={{ ...tdR, color: deltaColor(r.delta) }}>{r.delta > 0 ? `+${r.delta}` : r.delta || '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>{r.aiOverviewCited ? '✅' : '—'}</td>
                  <td style={{ ...tdStyle, fontSize: 11, color: D.muted }}>{r.serpFeatures ? Object.entries(typeof r.serpFeatures === 'string' ? JSON.parse(r.serpFeatures) : r.serpFeatures).filter(([,v]) => v).map(([k]) => k).join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function BacklinksTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/backlinks').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading backlinks...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No backlink data yet.</div></Card>;

  const sevColor = { critical: D.red, warning: D.amber, watch: D.muted, clean: D.green };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <KpiCard label="Total Links" value={data.total || 0} />
        <KpiCard label="Critical" value={data.critical || 0} color={D.red} />
        <KpiCard label="Warning" value={data.warning || 0} color={D.amber} />
        <KpiCard label="Clean" value={data.clean || 0} color={D.green} />
      </div>
      {data.anchorDistribution && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Anchor Text Distribution</div>
          {Object.entries(data.anchorDistribution).map(([type, count]) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <div style={{ width: 100, fontSize: 12, color: D.text, textAlign: 'right', textTransform: 'capitalize' }}>{type.replace('_', ' ')}</div>
              <div style={{ flex: 1, height: 14, background: D.bg, borderRadius: 3 }}>
                <div style={{ height: '100%', borderRadius: 3, background: type === 'branded' ? D.green : type === 'keyword_rich' ? D.amber : D.teal, width: `${Math.min(100, (count / Math.max(data.total, 1)) * 100)}%` }} />
              </div>
              <div style={{ width: 30, fontSize: 12, color: D.muted, fontFamily: MONO }}>{count}</div>
            </div>
          ))}
        </Card>
      )}
      {(data.recentToxic || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.red, marginBottom: 12 }}>Toxic Links</div>
          {data.recentToxic.map((l, i) => (
            <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4, borderLeft: `3px solid ${sevColor[l.severity]}` }}>
              <div style={{ fontSize: 12, color: D.heading }}>{l.source_domain}</div>
              <div style={{ fontSize: 11, color: D.muted }}>Anchor: "{l.anchor_text}" · Toxicity: {l.toxicity_score}/100</div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function ContentQATab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/qa').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading QA scores...</div>;
  if (!data || data.total === 0) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No QA scores yet. Run a batch score from the API.</div></Card>;

  const gradeColor = { A: D.green, B: D.teal, C: D.amber, D: D.orange, F: D.red };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        {Object.entries(data.gradeDistribution || {}).map(([grade, count]) => (
          <KpiCard key={grade} label={`Grade ${grade}`} value={count} color={gradeColor[grade]} />
        ))}
      </div>
      {(data.fixFirst || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.amber, marginBottom: 12 }}>Fix These First</div>
          {data.fixFirst.map((s, i) => (
            <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: D.text }}>{s.url || `Post ${s.blog_post_id}`}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: gradeColor[s.grade], fontFamily: MONO }}>{s.grade} ({s.total_score}/50)</span>
            </div>
          ))}
        </Card>
      )}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>All Scores</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={thStyle}>URL</th><th style={thR}>Grade</th><th style={thR}>Tech</th><th style={thR}>OnPage</th><th style={thR}>E-E-A-T</th><th style={thR}>Local</th><th style={thR}>Brand</th><th style={thR}>Total</th></tr></thead>
            <tbody>
              {(data.scores || []).slice(0, 30).map((s, i) => (
                <tr key={i}>
                  <td style={{ ...tdStyle, fontFamily: 'inherit', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.url || `Post ${s.blog_post_id}`}</td>
                  <td style={{ ...tdR, color: gradeColor[s.grade], fontWeight: 700 }}>{s.grade}</td>
                  <td style={tdR}>{s.technical_score}/12</td>
                  <td style={tdR}>{s.onpage_score}/10</td>
                  <td style={tdR}>{s.eeat_score}/8</td>
                  <td style={tdR}>{s.local_score}/10</td>
                  <td style={tdR}>{s.brand_score}/10</td>
                  <td style={{ ...tdR, fontWeight: 700 }}>{s.total_score}/50</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AIOverviewTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/ai-overview').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading AI Overview data...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No AI Overview data yet.</div></Card>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <KpiCard label="Keywords Tracked" value={data.total || 0} />
        <KpiCard label="With AI Overview" value={data.withAIO || 0} color={D.purple} />
        <KpiCard label="Waves Cited" value={data.wavesCited || 0} color={D.green} />
        <KpiCard label="GEO Score" value={`${data.geoScore || 0}%`} color={data.geoScore >= 30 ? D.green : D.amber} />
      </div>
      {(data.quickWins || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.amber, marginBottom: 12 }}>Quick Wins — AIO exists but Waves not cited</div>
          {data.quickWins.map((r, i) => (
            <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4 }}>
              <div style={{ fontSize: 13, color: D.heading }}>"{r.keyword}" <span style={{ color: D.muted, fontSize: 11 }}>({r.city})</span></div>
              <div style={{ fontSize: 11, color: D.muted }}>Currently cited: {r.sources.map(s => s.domain).join(', ') || 'unknown'}</div>
            </div>
          ))}
        </Card>
      )}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>All Keywords</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={thStyle}>Keyword</th><th style={thStyle}>City</th><th style={thR}>AIO?</th><th style={thR}>Cited?</th><th style={thStyle}>Sources</th></tr></thead>
            <tbody>
              {(data.results || []).map((r, i) => (
                <tr key={i}>
                  <td style={{ ...tdStyle, fontFamily: 'inherit' }}>{r.keyword}</td>
                  <td style={{ ...tdStyle, fontFamily: 'inherit', color: D.muted }}>{r.city}</td>
                  <td style={{ ...tdR }}>{r.aioPresent ? '✅' : '—'}</td>
                  <td style={{ ...tdR, color: r.wavesCited ? D.green : D.muted }}>{r.wavesCited ? '✅' : '—'}</td>
                  <td style={{ ...tdStyle, fontSize: 11, color: D.muted }}>{r.sources.map(s => s.domain).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SEOFunnelTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  useEffect(() => { setLoading(true); adminFetch(`/admin/seo/funnel?days=${days}`).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, [days]);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading funnel data...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No funnel data yet.</div></Card>;

  const o = data.organic || {};
  const e = data.estimates || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
        {[7, 30, 90].map(d => (
          <button key={d} onClick={() => setDays(d)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: days === d ? D.teal : D.bg, color: days === d ? D.white : D.muted }}>{d}d</button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        <KpiCard label="Impressions" value={(o.impressions || 0).toLocaleString()} />
        <KpiCard label="Clicks" value={(o.clicks || 0).toLocaleString()} sub={{ text: `${o.ctr || 0}% CTR` }} />
        <KpiCard label="Estimates" value={e.total || 0} />
        <KpiCard label="Booked" value={e.booked || 0} color={D.green} sub={{ text: `${e.conversionRate || 0}% rate` }} />
        <KpiCard label="Revenue" value={fmt(data.revenue || 0)} color={D.green} />
      </div>
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Top Landing Pages</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={thStyle}>Page</th><th style={thR}>Impr</th><th style={thR}>Clicks</th><th style={thR}>CTR</th><th style={thStyle}>Keyword</th></tr></thead>
            <tbody>
              {(data.funnelByPage || []).slice(0, 20).map((f, i) => (
                <tr key={i}>
                  <td style={{ ...tdStyle, fontFamily: 'inherit', maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(f.landingPage || '').replace(/https?:\/\/[^/]+/, '')}</td>
                  <td style={tdR}>{f.impressions.toLocaleString()}</td>
                  <td style={tdR}>{f.clicks}</td>
                  <td style={tdR}>{f.ctr}%</td>
                  <td style={{ ...tdStyle, fontFamily: 'inherit', fontSize: 11, color: D.muted }}>{f.keyword || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function CitationsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/citations').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading citations...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No citation data.</div></Card>;

  const statusColor = { active: D.green, inconsistent: D.red, missing: D.amber, claimed: D.teal, unchecked: D.muted };
  const bs = data.byStatus || {};
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        <KpiCard label="Active" value={bs.active || 0} color={D.green} />
        <KpiCard label="Inconsistent" value={bs.inconsistent || 0} color={D.red} />
        <KpiCard label="Missing" value={bs.missing || 0} color={D.amber} />
        <KpiCard label="Claimed" value={bs.claimed || 0} color={D.teal} />
        <KpiCard label="Unchecked" value={bs.unchecked || 0} />
      </div>
      {data.canonicalNAP && (
        <Card style={{ padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 6 }}>Canonical NAP</div>
          <div style={{ fontSize: 12, color: D.text }}>{data.canonicalNAP.name} · {data.canonicalNAP.phone} · {data.canonicalNAP.website}</div>
        </Card>
      )}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Directory Listings</div>
        {(data.citations || []).map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${D.border}` }}>
            <div style={{ width: 8, height: 8, borderRadius: 4, background: statusColor[c.status] || D.muted, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: D.heading }}>{c.directory_name}</div>
              {c.listing_url && <div style={{ fontSize: 11, color: D.muted }}>{c.listing_url}</div>}
            </div>
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: (statusColor[c.status] || D.muted) + '22', color: statusColor[c.status] || D.muted, textTransform: 'uppercase', fontWeight: 700 }}>{c.status}</span>
            <span style={{ fontSize: 10, color: D.muted }}>{c.priority}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function SiteAuditTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => { adminFetch('/admin/seo/audit').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);

  const runAudit = async () => {
    setRunning(true);
    await adminPost('/admin/seo/audit/run', {});
    const d = await adminFetch('/admin/seo/audit');
    setData(d);
    setRunning(false);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading site audit...</div>;
  if (!data?.hasData) return (
    <Card style={{ textAlign: 'center', padding: 60 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>{'🩺'}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: D.heading, marginBottom: 8 }}>No Audit Data Yet</div>
      <div style={{ fontSize: 14, color: D.muted, marginBottom: 20 }}>Run a site-wide technical audit to check all pages.</div>
      <button onClick={runAudit} disabled={running} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: D.teal, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: running ? 0.5 : 1 }}>{running ? 'Auditing...' : 'Run Site Audit'}</button>
    </Card>
  );

  const run = data.latestRun || {};
  const scoreColor = (s) => s >= 80 ? D.green : s >= 50 ? D.amber : D.red;
  const sevColor = { critical: D.red, warning: D.amber, info: D.muted };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, color: D.muted }}>Last audit: {run.run_date ? new Date(run.run_date).toLocaleDateString() : '—'} ({run.duration_seconds}s)</div>
        </div>
        <button onClick={runAudit} disabled={running} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.teal}`, background: 'transparent', color: D.teal, fontSize: 12, cursor: 'pointer', opacity: running ? 0.5 : 1 }}>{running ? 'Running...' : 'Re-run Audit'}</button>
      </div>

      {/* Score + summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Card style={{ padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Site Health</div>
          <div style={{ fontSize: 32, fontWeight: 800, color: scoreColor(parseFloat(run.avg_health_score || 0)), fontFamily: MONO }}>{Math.round(run.avg_health_score || 0)}</div>
          {run.score_delta != null && <div style={{ fontSize: 11, color: parseFloat(run.score_delta) >= 0 ? D.green : D.red }}>{parseFloat(run.score_delta) >= 0 ? '+' : ''}{parseFloat(run.score_delta).toFixed(1)} vs last</div>}
        </Card>
        <KpiCard label="Healthy (80+)" value={run.pages_healthy || 0} color={D.green} />
        <KpiCard label="Warning (50-79)" value={run.pages_warning || 0} color={D.amber} />
        <KpiCard label="Critical (<50)" value={run.pages_critical || 0} color={D.red} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <KpiCard label="Broken Links" value={run.pages_with_broken_links || 0} color={run.pages_with_broken_links > 0 ? D.red : D.green} />
        <KpiCard label="Missing Schema" value={run.pages_missing_schema || 0} color={run.pages_missing_schema > 0 ? D.amber : D.green} />
        <KpiCard label="Thin Content" value={run.pages_thin_content || 0} color={run.pages_thin_content > 0 ? D.amber : D.green} />
        <KpiCard label="Failing CWV" value={run.pages_failing_cwv || 0} color={run.pages_failing_cwv > 0 ? D.red : D.green} />
      </div>

      {/* Issues by category */}
      {(data.issues || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Issues ({data.issues.length})</div>
          {data.issues.map((issue, i) => (
            <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4, borderLeft: `3px solid ${sevColor[issue.severity] || D.muted}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 12, color: D.heading }}><span style={{ color: D.muted, textTransform: 'uppercase', fontSize: 10, marginRight: 8 }}>[{issue.issue_category}]</span>{issue.issue_type?.replace(/_/g, ' ')}</div>
                <span style={{ fontSize: 11, color: D.muted }}>{issue.affected_count} page{issue.affected_count !== 1 ? 's' : ''}</span>
              </div>
              {issue.recommendation && <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>{issue.recommendation}</div>}
            </div>
          ))}
        </Card>
      )}

      {/* Page scores table */}
      {(data.pages || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>All Pages ({data.pages.length})</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={thStyle}>URL</th><th style={thR}>Score</th><th style={thR}>Critical</th><th style={thR}>Warning</th><th style={thStyle}>Schema</th><th style={thStyle}>NAP</th>
              </tr></thead>
              <tbody>
                {data.pages.slice(0, 30).map((p, i) => (
                  <tr key={i}>
                    <td style={{ ...tdStyle, fontFamily: 'inherit', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(p.url || '').replace(/https?:\/\/[^/]+/, '')}</td>
                    <td style={{ ...tdR, color: scoreColor(p.technical_health_score), fontWeight: 700 }}>{p.technical_health_score}</td>
                    <td style={{ ...tdR, color: p.issue_count_critical > 0 ? D.red : D.muted }}>{p.issue_count_critical}</td>
                    <td style={{ ...tdR, color: p.issue_count_warning > 0 ? D.amber : D.muted }}>{p.issue_count_warning}</td>
                    <td style={{ ...tdStyle, fontSize: 11 }}>{p.has_local_business_schema ? '✅' : '—'} {p.has_faq_schema ? 'FAQ' : ''}</td>
                    <td style={{ ...tdStyle }}>{p.nap_present ? '✅' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Score trend */}
      {(data.history || []).length > 1 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Health Score Trend</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 80 }}>
            {data.history.reverse().map((h, i) => {
              const pct = (h.score || 0);
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ fontSize: 10, color: D.muted, fontFamily: MONO }}>{Math.round(pct)}</div>
                  <div style={{ width: '100%', height: `${pct * 0.7}px`, background: scoreColor(pct), borderRadius: 3 }} />
                  <div style={{ fontSize: 9, color: D.muted }}>{new Date(h.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

export default function AdsPage() {
  const [tab, setTab] = useState('ppc-dashboard');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>PPC</h1>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 24, background: '#F4F4F5', borderRadius: 10, padding: 4, border: '1px solid #E4E4E7' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: tab === t.key ? '#18181B' : 'transparent',
            color: tab === t.key ? '#FFFFFF' : '#A1A1AA',
            fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
            fontFamily: "'DM Sans', sans-serif",
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'ppc-dashboard' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading PPC dashboard...</div>}><PPCDashboardPage /></Suspense>}
      {tab === 'overview' && <OverviewTab />}
      {tab === 'service-lines' && <ServiceLinesTab />}
      {tab === 'advisor' && <AdvisorTab />}
      {tab === 'capacity' && <CapacityTab />}
    </div>
  );
}
