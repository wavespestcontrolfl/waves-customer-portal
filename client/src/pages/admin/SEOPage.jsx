import { useState, useEffect, lazy, Suspense } from 'react';
const BlogPage = lazy(() => import('./BlogPage'));
const SEODashboardPage = lazy(() => import('./SEODashboardPage'));

const API_BASE = import.meta.env.VITE_API_URL || '/api';
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

const thStyle = { padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: D.muted, borderBottom: `1px solid ${D.border}`, textTransform: 'uppercase', letterSpacing: '0.5px' };
const thR = { ...thStyle, textAlign: 'right' };
const tdStyle = { padding: '10px 14px', fontSize: 13, color: D.text, borderBottom: `1px solid ${D.border}`, fontFamily: MONO };
const tdR = { ...tdStyle, textAlign: 'right' };

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

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: '🔍' },
  { key: 'advisor', label: 'SEO Advisor', icon: '🧠' },
  { key: 'rankings', label: 'Rankings', icon: '📊' },
  { key: 'backlinks', label: 'Backlinks & Citations', icon: '🔗' },
  { key: 'content-qa', label: 'Content QA', icon: '✅' },
  { key: 'ai-overview', label: 'AI Overview', icon: '🤖' },
  { key: 'funnel', label: 'Funnel', icon: '📈' },
  { key: 'analytics', label: 'Analytics', icon: '📉' },
  { key: 'site-audit', label: 'Site Health', icon: '🩺' },
  { key: 'blog', label: 'Blog Content', icon: '📝' },
];

const NETWORK_DOMAINS = [
  { domain: 'wavespestcontrol.com', label: 'Waves Pest Control (Hub)', type: 'hub' },
  { domain: 'waveslawncare.com', label: 'Waves Lawn Care (Hub)', type: 'hub' },
  { domain: 'bradentonflpestcontrol.com', label: 'Bradenton Pest', type: 'spoke' },
  { domain: 'palmettoflpestcontrol.com', label: 'Palmetto Pest', type: 'spoke' },
  { domain: 'parrishpestcontrol.com', label: 'Parrish Pest', type: 'spoke' },
  { domain: 'sarasotaflpestcontrol.com', label: 'Sarasota Pest', type: 'spoke' },
  { domain: 'veniceflpestcontrol.com', label: 'Venice Pest', type: 'spoke' },
  { domain: 'bradentonflexterminator.com', label: 'Bradenton Ext', type: 'spoke' },
  { domain: 'palmettoexterminator.com', label: 'Palmetto Ext', type: 'spoke' },
  { domain: 'parrishexterminator.com', label: 'Parrish Ext', type: 'spoke' },
  { domain: 'sarasotaflexterminator.com', label: 'Sarasota Ext', type: 'spoke' },
  { domain: 'bradentonfllawncare.com', label: 'Bradenton Lawn', type: 'spoke' },
  { domain: 'parrishfllawncare.com', label: 'Parrish Lawn', type: 'spoke' },
  { domain: 'sarasotafllawncare.com', label: 'Sarasota Lawn', type: 'spoke' },
  { domain: 'venicelawncare.com', label: 'Venice Lawn', type: 'spoke' },
];

// ── GSC Dashboard ──
function DashboardTab({ domain }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(28);
  const [queryFilter, setQueryFilter] = useState('all');
  useEffect(() => { setLoading(true); adminFetch(`/admin/seo/dashboard?period=${period}${domain ? `&domain=${domain}` : ''}`).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, [period, domain]);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading SEO data...</div>;
  const cur = data?.current || {};
  const chg = data?.change || {};
  const posColor = (v) => v >= 0 ? D.green : D.red;

  const filteredQueries = (data?.topQueries || []).filter(q => {
    if (queryFilter === 'nonbrand') return !q.is_branded;
    if (queryFilter === 'branded') return q.is_branded;
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', gap: 4, background: D.bg, borderRadius: 8, padding: 3, alignSelf: 'flex-start' }}>
        {[7, 28, 90].map(p => (
          <button key={p} onClick={() => setPeriod(p)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: period === p ? D.teal : 'transparent', color: period === p ? D.white : D.muted }}>{p === 7 ? '7 Days' : p === 28 ? '28 Days' : '90 Days'}</button>
        ))}
      </div>
      <div className="seo-kpi-grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <KpiCard label="Total Clicks" value={cur.clicks?.toLocaleString() || '0'} sub={chg.clicks ? { text: `${chg.clicks >= 0 ? '+' : ''}${chg.clicks}% vs prev`, color: posColor(chg.clicks) } : null} />
        <KpiCard label="Impressions" value={cur.impressions?.toLocaleString() || '0'} />
        <KpiCard label="Avg CTR" value={((cur.ctr || 0) * 100).toFixed(2) + '%'} />
        <KpiCard label="Non-Brand Clicks" value={cur.nonbrandClicks?.toLocaleString() || '0'} color={D.purple} />
      </div>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>Top Queries</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[['all', 'All'], ['nonbrand', 'Non-Brand'], ['branded', 'Branded']].map(([k, l]) => (
              <button key={k} onClick={() => setQueryFilter(k)} style={{ padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11, background: queryFilter === k ? D.teal : D.bg, color: queryFilter === k ? D.white : D.muted }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={thStyle}>Query</th><th style={thR}>Clicks</th><th style={thR}>Impr</th><th style={thR}>CTR</th><th style={thR}>Position</th></tr></thead>
            <tbody>
              {filteredQueries.slice(0, 25).map((q, i) => {
                const pos = parseFloat(q.avg_position).toFixed(1);
                return (
                  <tr key={i}>
                    <td style={{ ...tdStyle, fontFamily: 'inherit' }}>{q.query} {q.is_branded && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: D.teal + '22', color: D.teal, marginLeft: 4 }}>BRAND</span>}</td>
                    <td style={tdR}>{parseInt(q.clicks)}</td>
                    <td style={tdR}>{parseInt(q.impressions).toLocaleString()}</td>
                    <td style={tdR}>{parseInt(q.impressions) > 0 ? (parseInt(q.clicks) / parseInt(q.impressions) * 100).toFixed(1) + '%' : '0%'}</td>
                    <td style={{ ...tdR, color: pos <= 3 ? D.green : pos <= 10 ? D.teal : pos <= 20 ? D.amber : D.red }}>{pos}</td>
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

// ── Stub tabs that fetch from existing endpoints ──
function AdvisorTab() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/advisor').then(d => { setReport(d.report); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading SEO advisor...</div>;
  const [generating, setGenerating] = useState(false);
  const generate = async () => {
    setGenerating(true);
    try {
      await adminFetch('/admin/seo/sync', { method: 'POST', body: JSON.stringify({ daysBack: 28 }) }).catch(() => {});
      const r = await adminFetch('/admin/seo/advisor/generate', { method: 'POST', body: JSON.stringify({}) });
      if (r.report) setReport(r.report);
    } catch { /* failed */ }
    setGenerating(false);
  };
  if (!report) return (
    <Card style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ color: D.muted, marginBottom: 16 }}>No SEO reports yet.</div>
      <button onClick={generate} disabled={generating} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', background: D.teal, color: D.white, fontSize: 13, fontWeight: 600, opacity: generating ? 0.7 : 1 }}>
        {generating ? 'Syncing & generating...' : 'Sync GSC & Generate Report'}
      </button>
    </Card>
  );
  const data = report.report_data || {};
  const gradeColor = (g) => !g ? D.muted : g.startsWith('A') ? D.green : g.startsWith('B') ? D.teal : g.startsWith('C') ? D.amber : D.red;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ width: 72, height: 72, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 800, fontFamily: MONO, background: gradeColor(data.grade) + '22', color: gradeColor(data.grade), border: `2px solid ${gradeColor(data.grade)}44` }}>{data.grade || '?'}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>SEO Grade</div>
            <div style={{ fontSize: 14, color: D.text, lineHeight: 1.5 }}>{data.overall_assessment}</div>
          </div>
        </div>
      </Card>
      {(data.recommendations || []).length > 0 && (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Recommendations</div>
          {data.recommendations.map((rec, i) => (
            <div key={i} style={{ padding: '12px 14px', background: D.bg, borderRadius: 8, marginBottom: 6, borderLeft: `3px solid ${rec.priority === 'high' ? D.red : rec.priority === 'medium' ? D.amber : D.muted}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{rec.action}</div>
              {rec.reasoning && <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>{rec.reasoning}</div>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function SimpleTableTab({ endpoint, title, columns, emptyMsg }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch(endpoint).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>{emptyMsg || 'No data yet.'}</div></Card>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {data.summary && (
        <div className="seo-kpi-grid-5" style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(Object.keys(data.summary).length, 5)}, 1fr)`, gap: 12 }}>
          {Object.entries(data.summary).map(([k, v]) => <KpiCard key={k} label={k.replace(/([A-Z])/g, ' $1').trim()} value={typeof v === 'number' ? v.toLocaleString() : v} />)}
        </div>
      )}
      <Card><div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 4 }}>{title}</div><div style={{ fontSize: 13, color: D.muted }}>Data loaded from {endpoint}</div></Card>
    </div>
  );
}

function RankingsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/rankings?days=7').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading rankings...</div>;
  if (!data?.rankings?.length) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No ranking data yet. Configure DataForSEO and enable GATE_SEO_INTELLIGENCE.</div></Card>;
  const s = data.summary || {};
  const posColor = (p) => !p ? D.muted : p <= 3 ? D.green : p <= 10 ? D.teal : p <= 20 ? D.amber : D.red;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="seo-kpi-grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <KpiCard label="Improving" value={s.improving || 0} color={D.green} />
        <KpiCard label="Declining" value={s.declining || 0} color={D.red} />
        <KpiCard label="Stable" value={s.stable || 0} />
        <KpiCard label="Map Pack" value={s.inMapPack || 0} color={D.teal} />
      </div>
      <Card>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={thStyle}>Keyword</th><th style={thStyle}>City</th><th style={thR}>Position</th><th style={thR}>Change</th><th style={thStyle}>AIO</th></tr></thead>
            <tbody>
              {data.rankings.map((r, i) => (
                <tr key={i}>
                  <td style={{ ...tdStyle, fontFamily: 'inherit', fontWeight: 500 }}>{r.keyword}</td>
                  <td style={{ ...tdStyle, fontFamily: 'inherit', color: D.muted }}>{r.primary_city || '—'}</td>
                  <td style={{ ...tdR, color: posColor(r.currentPosition) }}>{r.currentPosition || '—'}</td>
                  <td style={{ ...tdR, color: r.delta > 0 ? D.green : r.delta < 0 ? D.red : D.muted }}>{r.delta > 0 ? `+${r.delta}` : r.delta || '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>{r.aiOverviewCited ? '✅' : '—'}</td>
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
  const [scanning, setScanning] = useState(false);
  const [subTab, setSubTab] = useState('overview');

  useEffect(() => { adminFetch('/admin/seo/backlinks').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);

  const handleScan = async () => { setScanning(true); await adminPost('/admin/seo/backlinks/scan', {}); const d = await adminFetch('/admin/seo/backlinks'); setData(d); setScanning(false); };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading backlinks...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No backlink data yet. Click "Scan" to pull from DataForSEO.</div></Card>;

  const sevColor = { critical: D.red, warning: D.amber, watch: D.muted, clean: D.green };
  const statusColor = { active: D.green, inconsistent: D.red, missing: D.amber, claimed: D.teal, unchecked: D.muted };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div className="seo-sub-tabs" style={{ display: 'flex', gap: 4, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {[{ key: 'overview', label: 'Overview' }, { key: 'citations', label: 'Citations' }, { key: 'gaps', label: 'Competitor Gaps' }, { key: 'llm', label: 'LLM Mentions' }, { key: 'agent', label: 'Agent' }].map(t => (
            <button key={t.key} onClick={() => setSubTab(t.key)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, background: subTab === t.key ? D.teal : D.bg, color: subTab === t.key ? D.white : D.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>{t.label}</button>
          ))}
        </div>
        <button onClick={handleScan} disabled={scanning} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${D.teal}`, background: 'transparent', color: D.teal, fontSize: 12, cursor: 'pointer', opacity: scanning ? 0.5 : 1 }}>{scanning ? 'Scanning...' : 'Scan Backlinks'}</button>
      </div>

      {/* Stats */}
      <div className="seo-kpi-grid-5" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        <KpiCard label="Total Links" value={data.total || 0} />
        <KpiCard label="Critical" value={data.critical || 0} color={D.red} />
        <KpiCard label="Warning" value={data.warning || 0} color={D.amber} />
        <KpiCard label="Clean" value={data.clean || 0} color={D.green} />
        <KpiCard label="Citations" value={data.citationStats?.total || 0} sub={{ text: `${data.citationStats?.active || 0} active` }} />
      </div>

      {/* Overview sub-tab */}
      {subTab === 'overview' && (
        <>
          {data.anchorDistribution && (
            <Card>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Anchor Text Distribution</div>
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
                  <div style={{ fontSize: 12, color: D.white }}>{l.source_domain}</div>
                  <div style={{ fontSize: 11, color: D.muted }}>Anchor: "{l.anchor_text}" · Toxicity: {l.toxicity_score}/100</div>
                </div>
              ))}
            </Card>
          )}
          {/* Trend */}
          {(data.snapshots || []).length > 1 && (
            <Card>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Backlink Trend</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 60 }}>
                {(data.snapshots || []).reverse().map((s, i) => (
                  <div key={i} style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: D.muted, fontFamily: MONO }}>{s.total_backlinks}</div>
                    <div style={{ height: `${Math.max(4, (s.total_backlinks || 0) / 2)}px`, background: D.teal, borderRadius: 2, marginTop: 2 }} />
                    <div style={{ fontSize: 9, color: D.muted, marginTop: 2 }}>{new Date(s.snapshot_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {/* Citations sub-tab */}
      {subTab === 'citations' && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Directory Citations ({data.citationStats?.total || 0})</div>
          {(data.citations || []).map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${D.border}` }}>
              <div style={{ width: 8, height: 8, borderRadius: 4, background: statusColor[c.status] || D.muted, flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 13, color: D.white }}>{c.directory_name}</div>
              {c.listing_url && <a href={c.listing_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: D.teal, textDecoration: 'none' }}>View</a>}
              <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: (statusColor[c.status] || D.muted) + '22', color: statusColor[c.status] || D.muted, textTransform: 'uppercase', fontWeight: 700 }}>{c.status}</span>
            </div>
          ))}
        </Card>
      )}

      {/* Competitor Gaps sub-tab */}
      {subTab === 'gaps' && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.amber, marginBottom: 12 }}>Competitor Gap Opportunities ({(data.competitorGaps || []).length})</div>
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>Domains linking to competitors but not to Waves</div>
          {(data.competitorGaps || []).length === 0 ? (
            <div style={{ fontSize: 13, color: D.muted, padding: 20, textAlign: 'center' }}>Run a competitor gap scan to find opportunities</div>
          ) : (data.competitorGaps || []).map((g, i) => (
            <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 12, color: D.white, fontWeight: 500 }}>{g.source_domain}</div>
                <span style={{ fontSize: 10, color: D.muted }}>DR: {g.source_domain_rating || '?'}</span>
              </div>
              <div style={{ fontSize: 11, color: D.muted }}>Links to: {g.competitor_domain} · Anchor: "{(g.anchor_text || '').substring(0, 40)}"</div>
            </div>
          ))}
        </Card>
      )}

      {/* LLM Mentions sub-tab */}
      {subTab === 'llm' && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>LLM Mentions ({data.llmStats?.wavesMentioned || 0}/{data.llmStats?.total || 0} mentioning Waves)</div>
            <button onClick={() => adminPost('/admin/seo/backlinks/llm-mentions', {})} style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${D.teal}`, background: 'transparent', color: D.teal, fontSize: 11, cursor: 'pointer' }}>Check Now</button>
          </div>
          {(data.llmMentions || []).length === 0 ? (
            <div style={{ fontSize: 13, color: D.muted, padding: 20, textAlign: 'center' }}>Click "Check Now" to scan LLM responses for Waves mentions</div>
          ) : (data.llmMentions || []).map((m, i) => (
            <div key={i} style={{ padding: '8px 12px', background: D.bg, borderRadius: 6, marginBottom: 4, borderLeft: `3px solid ${m.waves_mentioned ? D.green : D.muted}` }}>
              <div style={{ fontSize: 12, color: D.white }}>"{m.query}"</div>
              <div style={{ fontSize: 11, color: m.waves_mentioned ? D.green : D.muted }}>{m.waves_mentioned ? '✅ Waves mentioned' : '— Not mentioned'} · {m.llm_platform} · {m.check_date}</div>
            </div>
          ))}
        </Card>
      )}

      {subTab === 'agent' && <BacklinkAgentPanel />}
    </div>
  );
}

// =========================================================================
// BACKLINK AGENT PANEL
// =========================================================================
function BacklinkAgentPanel() {
  const [stats, setStats] = useState(null);
  const [queue, setQueue] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [urlInput, setUrlInput] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [processing, setProcessing] = useState(false);
  const [addResult, setAddResult] = useState(null);

  const loadData = () => {
    Promise.all([
      adminFetch('/admin/backlink-agent/stats').catch(() => null),
      adminFetch('/admin/backlink-agent/queue?limit=50').catch(() => ({ items: [] })),
      adminFetch('/admin/backlink-agent/profiles').catch(() => ({ profiles: [] })),
      adminFetch('/admin/backlink-agent/targets').catch(() => ({ targets: [] })),
    ]).then(([s, q, p, t]) => {
      setStats(s);
      setQueue(q.items || []);
      setProfiles(p.profiles || []);
      setTargets(t.targets || []);
      setLoading(false);
    });
  };

  useEffect(() => { loadData(); }, []);

  const handleAddUrls = async () => {
    const urls = urlInput.split('\n').map(u => u.trim()).filter(Boolean).map(u => u.startsWith('http') ? u : `https://${u}`);
    if (urls.length === 0) return;
    const result = await adminPost('/admin/backlink-agent/queue', { urls });
    setAddResult(result);
    setUrlInput('');
    loadData();
  };

  const handleProcess = async () => {
    setProcessing(true);
    await adminPost('/admin/backlink-agent/process', { limit: 3 });
    setTimeout(() => { setProcessing(false); loadData(); }, 3000);
  };

  const handleRetry = async (id) => {
    await adminPost(`/admin/backlink-agent/queue/${id}/retry`, {});
    loadData();
  };

  const handleSkip = async (id) => {
    await adminPost(`/admin/backlink-agent/queue/${id}/skip`, {});
    loadData();
  };

  const handleAddTarget = async () => {
    if (!newTarget.trim()) return;
    await adminPost('/admin/backlink-agent/targets', { username: newTarget.trim() });
    setNewTarget('');
    loadData();
  };

  const handleDeleteTarget = async (id) => {
    await adminFetch(`/admin/backlink-agent/targets/${id}`, { method: 'DELETE' });
    loadData();
  };

  const handlePoll = async () => {
    await adminPost('/admin/backlink-agent/poll', {});
    loadData();
  };

  const handleVerifyEmails = async () => {
    await adminPost('/admin/backlink-agent/verify-emails', {});
    loadData();
  };

  const statusColor = { pending: D.muted, processing: D.teal, signup_complete: D.amber, verified: D.green, failed: D.red, skipped: '#475569' };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading backlink agent...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stats */}
      <div className="seo-kpi-grid-5" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        <KpiCard label="Total Queued" value={stats?.total || 0} />
        <KpiCard label="Pending" value={stats?.pending || 0} color={D.muted} />
        <KpiCard label="Completed" value={stats?.completed || 0} color={D.amber} />
        <KpiCard label="Verified" value={stats?.verified || 0} color={D.green} />
        <KpiCard label="Success Rate" value={`${stats?.successRate || 0}%`} color={stats?.successRate >= 50 ? D.green : D.amber} />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleProcess} disabled={processing || (stats?.pending || 0) === 0} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: D.teal, color: D.white, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: processing || !(stats?.pending) ? 0.5 : 1 }}>
          {processing ? 'Processing...' : `Process Queue (${stats?.pending || 0})`}
        </button>
        <button onClick={loadData} style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 13, cursor: 'pointer' }}>Refresh</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Manual URL Input */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Add URLs</div>
            <textarea
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              placeholder="Paste URLs here, one per line..."
              rows={4}
              style={{ width: '100%', padding: 10, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, fontFamily: 'DM Sans, sans-serif', resize: 'vertical', outline: 'none', boxSizing: 'border-box', marginBottom: 8 }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: D.muted }}>{urlInput.split('\n').filter(u => u.trim()).length} URLs detected</span>
              <button onClick={handleAddUrls} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: D.teal, color: D.white, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Add to Queue</button>
            </div>
            {addResult && (
              <div style={{ marginTop: 8, fontSize: 12, color: D.green }}>
                Added {addResult.added}, skipped {addResult.skipped}{addResult.duplicates?.length > 0 ? ` (dupes: ${addResult.duplicates.join(', ')})` : ''}
              </div>
            )}
          </Card>

          {/* Queue Table */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Queue ({queue.length})</div>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {queue.length === 0 ? (
                <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: 'center' }}>No URLs in queue. Add some above or poll X feeds.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, fontSize: 11, textTransform: 'uppercase' }}>Domain</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, fontSize: 11, textTransform: 'uppercase' }}>Source</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', color: D.muted, fontSize: 11, textTransform: 'uppercase' }}>Status</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', color: D.muted, fontSize: 11, textTransform: 'uppercase' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map(item => (
                      <tr key={item.id} style={{ borderBottom: `1px solid ${D.border}33` }}>
                        <td style={{ padding: '8px 10px', color: D.text }}><a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: D.teal, textDecoration: 'none' }}>{item.domain}</a></td>
                        <td style={{ padding: '8px 10px', color: D.muted }}>{item.source}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 6, background: (statusColor[item.status] || D.muted) + '22', color: statusColor[item.status] || D.muted }}>{item.status}</span>
                          {item.error_message && <div style={{ fontSize: 10, color: D.red, marginTop: 2 }}>{item.error_message.substring(0, 60)}</div>}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {(item.status === 'failed' || item.status === 'skipped') && <button onClick={() => handleRetry(item.id)} style={{ padding: '3px 8px', borderRadius: 4, border: `1px solid ${D.teal}`, background: 'transparent', color: D.teal, fontSize: 10, cursor: 'pointer', marginRight: 4 }}>Retry</button>}
                          {(item.status === 'pending' || item.status === 'failed') && <button onClick={() => handleSkip(item.id)} style={{ padding: '3px 8px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'transparent', color: D.muted, fontSize: 10, cursor: 'pointer' }}>Skip</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          {/* Profiles */}
          {profiles.length > 0 && (
            <Card>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Completed Profiles ({profiles.length})</div>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {profiles.map(p => (
                  <div key={p.id} style={{ padding: '8px 0', borderBottom: `1px solid ${D.border}33`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 13, color: D.text }}>{p.domain || p.site_url}</div>
                      {p.profile_url && <a href={p.profile_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: D.teal, textDecoration: 'none' }}>View Profile</a>}
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: p.queue_status === 'verified' ? D.green + '22' : D.amber + '22', color: p.queue_status === 'verified' ? D.green : D.amber }}>
                      {p.queue_status === 'verified' ? 'VERIFIED' : 'PENDING VERIFY'}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

    </div>
    </div>
  );
}

function ContentQATab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/qa').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading QA scores...</div>;
  if (!data || data.total === 0) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No QA scores yet.</div></Card>;
  const gc = { A: D.green, B: D.teal, C: D.amber, D: D.orange, F: D.red };
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      {Object.entries(data.gradeDistribution || {}).map(([g, c]) => <KpiCard key={g} label={`Grade ${g}`} value={c} color={gc[g]} />)}
    </div>
  );
}

function AIOverviewTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/ai-overview').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No AI Overview data yet.</div></Card>;
  return (
    <div className="seo-kpi-grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
      <KpiCard label="Tracked" value={data.total || 0} />
      <KpiCard label="With AIO" value={data.withAIO || 0} color={D.purple} />
      <KpiCard label="Waves Cited" value={data.wavesCited || 0} color={D.green} />
      <KpiCard label="GEO Score" value={`${data.geoScore || 0}%`} color={data.geoScore >= 30 ? D.green : D.amber} />
    </div>
  );
}

function FunnelTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/funnel?days=30').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No funnel data yet.</div></Card>;
  const o = data.organic || {};
  return (
    <div className="seo-kpi-grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
      <KpiCard label="Impressions" value={(o.impressions || 0).toLocaleString()} />
      <KpiCard label="Clicks" value={(o.clicks || 0).toLocaleString()} sub={{ text: `${o.ctr || 0}% CTR` }} />
      <KpiCard label="Booked" value={data.estimates?.booked || 0} color={D.green} />
      <KpiCard label="Revenue" value={fmt(data.revenue || 0)} color={D.green} />
    </div>
  );
}

function CitationsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/seo/citations').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading...</div>;
  if (!data) return <Card style={{ padding: 40, textAlign: 'center' }}><div style={{ color: D.muted }}>No citations.</div></Card>;
  const bs = data.byStatus || {};
  const sc = { active: D.green, inconsistent: D.red, missing: D.amber, claimed: D.teal, unchecked: D.muted };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="seo-kpi-grid-5" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
        <KpiCard label="Active" value={bs.active || 0} color={D.green} />
        <KpiCard label="Inconsistent" value={bs.inconsistent || 0} color={D.red} />
        <KpiCard label="Missing" value={bs.missing || 0} color={D.amber} />
        <KpiCard label="Claimed" value={bs.claimed || 0} color={D.teal} />
        <KpiCard label="Unchecked" value={bs.unchecked || 0} />
      </div>
      <Card>
        {(data.citations || []).map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${D.border}` }}>
            <div style={{ width: 8, height: 8, borderRadius: 4, background: sc[c.status] || D.muted }} />
            <div style={{ flex: 1, fontSize: 13, color: D.white }}>{c.directory_name}</div>
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: (sc[c.status] || D.muted) + '22', color: sc[c.status] || D.muted, textTransform: 'uppercase', fontWeight: 700 }}>{c.status}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ── GA4 Analytics Tab ──
function AnalyticsTab() {
  const [overview, setOverview] = useState(null);
  const [traffic, setTraffic] = useState(null);
  const [pages, setPages] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      adminFetch(`/admin/analytics/overview?days=${days}`),
      adminFetch(`/admin/analytics/traffic?days=${days}`),
      adminFetch(`/admin/analytics/pages?days=${days}`),
    ]).then(([o, t, p]) => {
      setOverview(o); setTraffic(t); setPages(p); setLoading(false);
    }).catch(() => setLoading(false));
  }, [days]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading analytics...</div>;

  if (overview?.configured === false) return (
    <Card style={{ textAlign: 'center', padding: 60 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>📉</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: D.white, marginBottom: 8 }}>Google Analytics Not Connected</div>
      <div style={{ fontSize: 13, color: D.muted }}>Set GOOGLE_SERVICE_ACCOUNT_JSON and GA4_PROPERTY_ID in Railway, then grant the service account Viewer access in GA4.</div>
    </Card>
  );

  const data = overview?.data || {};
  const sources = traffic?.data || [];
  const topPages = pages?.data || [];
  const fmt = (v) => v != null ? Number(v).toLocaleString() : '—';
  const pct = (v) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '—';
  const dur = (v) => { if (!v) return '—'; const s = Math.round(Number(v)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Period selector */}
      <div className="seo-analytics-period" style={{ display: 'flex', gap: 8 }}>
        {[7, 14, 28, 30, 90].map(d => (
          <button key={d} onClick={() => setDays(d)} style={{
            padding: '6px 14px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: days === d ? D.teal : D.card, color: days === d ? D.white : D.muted,
          }}>{d}d</button>
        ))}
      </div>

      {/* KPI Row */}
      <div className="seo-kpi-grid-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {[
          { label: 'Sessions', value: fmt(data.sessions) },
          { label: 'Users', value: fmt(data.users) },
          { label: 'New Users', value: fmt(data.newUsers) },
        ].map(k => <KpiCard key={k.label} label={k.label} value={k.value} />)}
      </div>
      <div className="seo-kpi-grid-3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {[
          { label: 'Bounce Rate', value: pct(data.bounceRate), color: data.bounceRate > 0.6 ? D.red : data.bounceRate > 0.4 ? D.amber : D.green },
          { label: 'Avg Session', value: dur(data.avgSessionDuration) },
          { label: 'Pages / Session', value: data.pageviewsPerSession ? Number(data.pageviewsPerSession).toFixed(1) : '—' },
        ].map(k => <KpiCard key={k.label} label={k.label} value={k.value} color={k.color} />)}
      </div>

      {/* Traffic Sources */}
      {sources.length > 0 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 12 }}>Traffic Sources</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sources.map((s, i) => {
              const totalSessions = sources.reduce((sum, x) => sum + (parseInt(x.sessions) || 0), 0);
              const pctOfTotal = totalSessions ? ((parseInt(s.sessions) || 0) / totalSessions * 100).toFixed(1) : 0;
              const srcColor = { organic: D.green, paid: D.amber, direct: D.teal, referral: D.purple, social: '#ec4899' }[s.source?.toLowerCase()] || D.muted;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: D.bg, borderRadius: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: srcColor, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: D.white, fontWeight: 500 }}>{s.source || 'unknown'}{s.medium ? ` / ${s.medium}` : ''}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: D.white, fontFamily: MONO }}>{fmt(s.sessions)}</div>
                  <div style={{ fontSize: 11, color: D.muted, fontFamily: MONO, width: 50, textAlign: 'right' }}>{pctOfTotal}%</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Top Pages */}
      {topPages.length > 0 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 12 }}>Top Landing Pages</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="seo-top-pages-header" style={{ display: 'flex', padding: '0 12px 8px', fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              <div style={{ flex: 1 }}>Page</div>
              <div style={{ width: 70, textAlign: 'right' }}>Sessions</div>
              <div style={{ width: 70, textAlign: 'right' }}>Bounce</div>
              <div style={{ width: 70, textAlign: 'right' }}>Avg Time</div>
            </div>
            {topPages.slice(0, 20).map((p, i) => (
              <div key={i} className="seo-top-pages-row" style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', background: i % 2 === 0 ? D.bg : 'transparent', borderRadius: 6 }}>
                <div style={{ flex: 1, fontSize: 12, color: D.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', wordBreak: 'break-all' }}>{p.page || p.pagePath}</div>
                <div style={{ width: 70, textAlign: 'right', fontSize: 12, fontWeight: 600, color: D.white, fontFamily: MONO, flexShrink: 0 }}>{fmt(p.sessions)}</div>
                <div style={{ width: 70, textAlign: 'right', fontSize: 12, color: p.bounceRate > 0.6 ? D.red : D.muted, fontFamily: MONO, flexShrink: 0 }}>{pct(p.bounceRate)}</div>
                <div style={{ width: 70, textAlign: 'right', fontSize: 12, color: D.muted, fontFamily: MONO, flexShrink: 0 }}>{dur(p.avgSessionDuration)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function SiteAuditTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState('all'); // all, critical, warning, healthy
  const [expandedPage, setExpandedPage] = useState(null);

  useEffect(() => { adminFetch('/admin/seo/audit').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, []);

  const runAudit = async () => {
    setRunning(true);
    try {
      await adminPost('/admin/seo/audit/run', {});
      const d = await adminFetch('/admin/seo/audit');
      setData(d);
    } catch {}
    setRunning(false);
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading site audit...</div>;
  if (!data?.hasData) return (
    <Card style={{ textAlign: 'center', padding: 60 }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>{'🩺'}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: D.white, marginBottom: 8 }}>No Audit Data Yet</div>
      <button onClick={runAudit} disabled={running} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: D.teal, color: D.white, fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: running ? 0.5 : 1 }}>{running ? 'Auditing...' : 'Run Site Audit'}</button>
    </Card>
  );

  const run = data.latestRun || {};
  const pages = data.pages || [];
  const issues = data.issues || [];
  const history = data.history || [];
  const scoreColor = (s) => s >= 80 ? D.green : s >= 50 ? D.amber : D.red;
  const severityColor = { critical: D.red, warning: D.amber, info: D.muted, healthy: D.green };

  const getPageStatus = (p) => {
    if (p.issue_count_critical > 0) return 'critical';
    if (p.issue_count_warning > 0) return 'warning';
    return 'healthy';
  };

  const filteredPages = pages.filter(p => {
    if (filter === 'all') return true;
    return getPageStatus(p) === filter;
  });

  const shortUrl = (url) => {
    try { return new URL(url).pathname || '/'; } catch { return url; }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI Row */}
      <div className="seo-audit-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <Card style={{ padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: D.muted }}>Site Health Score</div>
          <div style={{ fontSize: 36, fontWeight: 800, color: scoreColor(parseFloat(run.avg_health_score || 0)), fontFamily: MONO }}>{Math.round(run.avg_health_score || 0)}</div>
          <div style={{ fontSize: 10, color: D.muted }}>{run.pages_crawled || 0} pages crawled</div>
        </Card>
        {[{ label: 'Healthy', key: 'healthy', count: run.pages_healthy || 0, color: D.green },
          { label: 'Warning', key: 'warning', count: run.pages_warning || 0, color: D.amber },
          { label: 'Critical', key: 'critical', count: run.pages_critical || 0, color: D.red }].map(s => (
          <Card key={s.key} onClick={() => setFilter(filter === s.key ? 'all' : s.key)}
            style={{ padding: 16, textAlign: 'center', cursor: 'pointer', border: filter === s.key ? `2px solid ${s.color}` : `1px solid ${D.border}` }}>
            <div style={{ fontSize: 11, color: D.muted }}>{s.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color, fontFamily: MONO }}>{s.count}</div>
          </Card>
        ))}
      </div>

      {/* Re-run + last run info */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 12, color: D.muted }}>
          Last audit: {run.run_date ? new Date(run.run_date).toLocaleString() : 'N/A'}
        </div>
        <button onClick={runAudit} disabled={running} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: D.teal, color: D.white, fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: running ? 0.5 : 1 }}>{running ? 'Running...' : 'Re-run Audit'}</button>
      </div>

      {/* Top Issues Summary */}
      {issues.length > 0 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 12 }}>Top Issues</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {issues.slice(0, 15).map((iss, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: D.bg, borderRadius: 8, border: `1px solid ${D.border}` }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: severityColor[iss.severity] || D.muted,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: D.white, fontWeight: 500 }}>{iss.issue_type?.replace(/_/g, ' ')}</div>
                  {iss.details && <div style={{ fontSize: 11, color: D.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{iss.details}</div>}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: severityColor[iss.severity] || D.muted, fontFamily: MONO, flexShrink: 0 }}>
                  {iss.affected_count} page{iss.affected_count !== 1 ? 's' : ''}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Page-by-Page Breakdown */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.white }}>
            Pages {filter !== 'all' ? `(${filter})` : ''} — {filteredPages.length}
          </div>
          {filter !== 'all' && <button onClick={() => setFilter('all')} style={{ fontSize: 11, color: D.teal, background: 'none', border: 'none', cursor: 'pointer' }}>Show all</button>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filteredPages.slice(0, 50).map((p, i) => {
            const status = getPageStatus(p);
            const pageIssues = (() => { try { return JSON.parse(p.issues || '[]'); } catch { return []; } })();
            const isExpanded = expandedPage === i;
            return (
              <div key={i}>
                <div onClick={() => setExpandedPage(isExpanded ? null : i)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: D.bg, borderRadius: 8, border: `1px solid ${D.border}`, cursor: 'pointer' }}>
                  {/* Score circle */}
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    border: `3px solid ${scoreColor(p.technical_health_score || 0)}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 800, color: scoreColor(p.technical_health_score || 0), fontFamily: MONO,
                  }}>{Math.round(p.technical_health_score || 0)}</div>
                  {/* URL + meta */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: D.white, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortUrl(p.url)}</div>
                    <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                      {p.status_code && <span style={{ marginRight: 8 }}>{p.status_code}</span>}
                      {p.response_time_ms != null && <span style={{ marginRight: 8 }}>{p.response_time_ms}ms</span>}
                      {p.word_count != null && <span>{p.word_count} words</span>}
                    </div>
                  </div>
                  {/* Issue counts */}
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {p.issue_count_critical > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: D.red, background: D.red + '18', padding: '2px 6px', borderRadius: 6 }}>{p.issue_count_critical} critical</span>}
                    {p.issue_count_warning > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: D.amber, background: D.amber + '18', padding: '2px 6px', borderRadius: 6 }}>{p.issue_count_warning} warning</span>}
                    {status === 'healthy' && <span style={{ fontSize: 10, fontWeight: 700, color: D.green, background: D.green + '18', padding: '2px 6px', borderRadius: 6 }}>OK</span>}
                  </div>
                  <span style={{ fontSize: 12, color: D.muted, flexShrink: 0 }}>{isExpanded ? '▲' : '▼'}</span>
                </div>
                {/* Expanded details */}
                {isExpanded && (
                  <div style={{ padding: '12px 16px', background: D.bg, borderRadius: '0 0 8px 8px', borderTop: 'none', border: `1px solid ${D.border}`, borderTopColor: 'transparent', marginTop: -2 }}>
                    {/* Meta info */}
                    <div className="seo-audit-expanded-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                      {p.meta_title && (
                        <div><div style={{ fontSize: 10, color: D.muted }}>Title ({p.meta_title_length} chars)</div><div style={{ fontSize: 12, color: D.text, marginTop: 2 }}>{p.meta_title}</div></div>
                      )}
                      {p.meta_description && (
                        <div><div style={{ fontSize: 10, color: D.muted }}>Description ({p.meta_description_length} chars)</div><div style={{ fontSize: 12, color: D.text, marginTop: 2 }}>{p.meta_description?.substring(0, 160)}</div></div>
                      )}
                      {p.h1_text && (
                        <div><div style={{ fontSize: 10, color: D.muted }}>H1 (count: {p.h1_count})</div><div style={{ fontSize: 12, color: D.text, marginTop: 2 }}>{p.h1_text}</div></div>
                      )}
                      <div>
                        <div style={{ fontSize: 10, color: D.muted }}>Structure</div>
                        <div style={{ fontSize: 12, color: D.text, marginTop: 2 }}>
                          H2s: {p.h2_count || 0} | Links: {p.internal_links_count || 0} int / {p.external_links_count || 0} ext | Images: {p.total_images || 0} ({p.images_missing_alt || 0} no alt)
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: D.muted }}>Schema</div>
                        <div style={{ fontSize: 12, color: D.text, marginTop: 2 }}>
                          {(() => { try { const s = JSON.parse(p.schema_types_found || '[]'); return s.length ? s.join(', ') : 'None found'; } catch { return 'None'; } })()}
                          {p.has_faq_schema && <span style={{ color: D.green, marginLeft: 6 }}>FAQ</span>}
                          {p.has_local_business_schema && <span style={{ color: D.green, marginLeft: 6 }}>LocalBusiness</span>}
                        </div>
                      </div>
                      {p.canonical_url && (
                        <div><div style={{ fontSize: 10, color: D.muted }}>Canonical</div><div style={{ fontSize: 12, color: p.canonical_mismatch ? D.red : D.green, marginTop: 2 }}>{p.canonical_self_referencing ? 'Self-referencing' : p.canonical_url}</div></div>
                      )}
                    </div>
                    {/* Issue list */}
                    {pageIssues.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: D.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Issues</div>
                        {pageIssues.map((iss, j) => (
                          <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderBottom: j < pageIssues.length - 1 ? `1px solid ${D.border}` : 'none' }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: severityColor[iss.severity] || D.muted, marginTop: 5, flexShrink: 0 }} />
                            <div>
                              <div style={{ fontSize: 12, color: D.text }}>{iss.message || iss.type?.replace(/_/g, ' ')}</div>
                              {iss.details && <div style={{ fontSize: 11, color: D.muted, marginTop: 1 }}>{iss.details}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {pageIssues.length === 0 && <div style={{ fontSize: 12, color: D.green }}>No issues found — page is healthy</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* Audit History */}
      {history.length > 1 && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.white, marginBottom: 12 }}>Audit History</div>
          <div className="seo-audit-history-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(history.length, 6)}, 1fr)`, gap: 8 }}>
            {history.slice(0, 6).map((h, i) => (
              <div key={i} style={{ textAlign: 'center', padding: 12, background: D.bg, borderRadius: 8, border: i === 0 ? `2px solid ${D.teal}` : `1px solid ${D.border}` }}>
                <div style={{ fontSize: 10, color: D.muted }}>{new Date(h.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: scoreColor(h.score), fontFamily: MONO }}>{Math.round(h.score)}</div>
                <div style={{ fontSize: 10, color: D.muted }}>{h.pages} pages</div>
                {h.critical > 0 && <div style={{ fontSize: 10, color: D.red }}>{h.critical} critical</div>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Main Page ──
export default function SEOPage() {
  const [tab, setTab] = useState('dashboard');
  const [activeDomain, setActiveDomain] = useState('wavespestcontrol.com');

  return (
    <div>
      <style>{`
        @media (max-width: 640px) {
          .seo-tab-bar { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; flex-wrap: nowrap !important; scrollbar-width: none; }
          .seo-tab-bar::-webkit-scrollbar { display: none; }
          .seo-tab-bar button { padding: 8px 12px !important; font-size: 12px !important; flex-shrink: 0 !important; }
          .seo-kpi-grid-4 { grid-template-columns: repeat(2, 1fr) !important; }
          .seo-kpi-grid-5 { grid-template-columns: repeat(2, 1fr) !important; }
          .seo-kpi-grid-3 { grid-template-columns: 1fr !important; }
          .seo-sub-tabs { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; flex-wrap: nowrap !important; }
          .seo-sub-tabs button { flex-shrink: 0 !important; }
          .seo-top-pages-header { display: none !important; }
          .seo-top-pages-row { flex-wrap: wrap !important; gap: 4px !important; }
          .seo-top-pages-row > div:first-child { width: 100% !important; flex: none !important; }
          .seo-audit-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .seo-audit-expanded-grid { grid-template-columns: 1fr !important; }
          .seo-audit-history-grid { grid-template-columns: repeat(3, 1fr) !important; }
          .seo-funnel-stats { grid-template-columns: 1fr 1fr 1fr !important; }
          .seo-analytics-period { flex-wrap: wrap !important; }
          .seo-domain-picker { width: 100% !important; }
        }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: D.white }}>SEO</div>
        <div className="seo-domain-picker" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: D.muted }}>Domain:</span>
          <select
            value={activeDomain}
            onChange={e => setActiveDomain(e.target.value)}
            style={{
              padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              background: D.card, color: D.text, border: `1px solid ${D.border}`,
              outline: 'none', cursor: 'pointer', minWidth: 220,
            }}
          >
            {NETWORK_DOMAINS.map(d => (
              <option key={d.domain} value={d.domain}>
                {d.type === 'hub' ? '⭐ ' : '  '}{d.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="seo-tab-bar" style={{ display: 'flex', gap: 4, marginBottom: 24, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent',
            color: tab === t.key ? D.white : D.muted,
            transition: 'all 0.15s', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
          }}><span>{t.icon}</span> {t.label}</button>
        ))}
      </div>

      {tab === 'dashboard' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading dashboard...</div>}><SEODashboardPage domain={activeDomain} /></Suspense>}
      {tab === 'advisor' && <AdvisorTab />}
      {tab === 'rankings' && <RankingsTab />}
      {tab === 'backlinks' && <BacklinksTab />}
      {tab === 'content-qa' && <ContentQATab />}
      {tab === 'ai-overview' && <AIOverviewTab />}
      {tab === 'funnel' && <FunnelTab />}
      {tab === 'analytics' && <AnalyticsTab />}
      {tab === 'site-audit' && <SiteAuditTab />}
      {tab === 'blog' && <Suspense fallback={<div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading blog...</div>}><BlogPage domain={activeDomain} /></Suspense>}
    </div>
  );
}
