import { useState, useEffect, useMemo } from "react";

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
  }).then(r => r.json());
}

const WAVES_COLORS = {
  bg: "#0B1120",
  cardBg: "#111827",
  cardBorder: "#1E293B",
  accent: "#3B82F6",
  accentGlow: "rgba(59, 130, 246, 0.15)",
  green: "#10B981",
  greenGlow: "rgba(16, 185, 129, 0.2)",
  red: "#EF4444",
  redGlow: "rgba(239, 68, 68, 0.15)",
  yellow: "#F59E0B",
  yellowGlow: "rgba(245, 158, 11, 0.15)",
  purple: "#8B5CF6",
  orange: "#F97316",
  cyan: "#06B6D4",
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  textMuted: "#64748B",
  gold: "#FBBF24",
};

// --- COMPONENTS ---

function MetricCard({ value, label, sublabel, color = WAVES_COLORS.accent, large }) {
  return (
    <div style={{
      background: WAVES_COLORS.cardBg,
      border: `1px solid ${WAVES_COLORS.cardBorder}`,
      borderRadius: 12,
      padding: large ? "24px 20px" : "18px 16px",
      textAlign: "center",
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
        width: 80, height: 3, background: color, borderRadius: "0 0 4px 4px",
      }} />
      <div style={{
        fontSize: large ? 32 : 26, fontWeight: 800, color,
        letterSpacing: "-0.02em", lineHeight: 1.1,
        fontFamily: "'DM Sans', sans-serif",
      }}>{value}</div>
      <div style={{
        fontSize: 11, fontWeight: 600, color: WAVES_COLORS.textSecondary,
        textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 6,
      }}>{label}</div>
      {sublabel && <div style={{
        fontSize: 11, color: WAVES_COLORS.textMuted, marginTop: 2,
      }}>{sublabel}</div>}
    </div>
  );
}

function HBar({ label, value, maxValue, color, suffix = "%", width = "100%" }) {
  const pct = Math.min((value / maxValue) * 100, 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, width }}>
      <div style={{ width: 100, fontSize: 13, color: WAVES_COLORS.textSecondary, fontWeight: 500, flexShrink: 0, textAlign: "right" }}>{label}</div>
      <div style={{ flex: 1, height: 22, background: "rgba(255,255,255,0.04)", borderRadius: 6, overflow: "hidden", position: "relative" }}>
        <div style={{
          width: `${pct}%`, height: "100%", background: color,
          borderRadius: 6, transition: "width 0.8s cubic-bezier(.4,0,.2,1)",
          boxShadow: `0 0 12px ${color}44`,
        }} />
      </div>
      <div style={{ width: 52, fontSize: 13, fontWeight: 700, color: WAVES_COLORS.textPrimary, textAlign: "right", flexShrink: 0 }}>
        {value}{suffix}
      </div>
    </div>
  );
}

function CompBar({ name, count, maxCount }) {
  const pct = (count / maxCount) * 100;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
      <div style={{ width: 110, fontSize: 13, color: WAVES_COLORS.textSecondary, fontWeight: 500, textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
      <div style={{ flex: 1, height: 18, background: "rgba(255,255,255,0.04)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: WAVES_COLORS.red, borderRadius: 4, minWidth: 8 }} />
      </div>
      <div style={{ width: 28, fontSize: 13, fontWeight: 700, color: WAVES_COLORS.textPrimary, textAlign: "right", flexShrink: 0 }}>{count}</div>
    </div>
  );
}

function Sparkline({ data, width = 90, height = 28 }) {
  if (!data || data.length < 2) return <span style={{ color: WAVES_COLORS.textMuted, fontSize: 11 }}>--</span>;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  const trending = data[data.length - 1] < data[0]; // lower position = better for rankings
  const lineColor = trending ? WAVES_COLORS.green : data[data.length - 1] > data[0] ? WAVES_COLORS.red : WAVES_COLORS.textMuted;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={lineColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={parseFloat(points.split(" ").pop().split(",")[0])} cy={parseFloat(points.split(" ").pop().split(",")[1])} r="3" fill={lineColor} />
    </svg>
  );
}

function StatusDot({ status }) {
  const colors = { cited: WAVES_COLORS.green, competitor: WAVES_COLORS.red, no_aio: WAVES_COLORS.textMuted };
  const labels = { cited: "Waves Cited", competitor: "Competitor Cited", no_aio: "No AI Overview" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: colors[status], fontWeight: 600 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: colors[status], display: "inline-block", boxShadow: `0 0 6px ${colors[status]}66` }} />
      {labels[status]}
    </span>
  );
}

function DeltaArrow({ current, previous }) {
  if (current == null || previous == null) return <span style={{ color: WAVES_COLORS.textMuted, fontSize: 12 }}>--</span>;
  const diff = previous - current; // positive = improved (lower position is better)
  if (diff === 0) return <span style={{ color: WAVES_COLORS.textMuted, fontSize: 13, fontWeight: 600 }}>--</span>;
  const color = diff > 0 ? WAVES_COLORS.green : WAVES_COLORS.red;
  return <span style={{ color, fontSize: 13, fontWeight: 700 }}>{diff > 0 ? "+" : ""}{diff > 0 ? "+" : "-"}{Math.abs(diff)}</span>;
}

function PositionBadge({ pos }) {
  if (pos == null) return <span style={{ color: WAVES_COLORS.textMuted, fontSize: 13 }}>--</span>;
  let bg = "rgba(255,255,255,0.06)";
  let color = WAVES_COLORS.textSecondary;
  if (pos <= 3) { bg = WAVES_COLORS.greenGlow; color = WAVES_COLORS.green; }
  else if (pos <= 10) { bg = WAVES_COLORS.accentGlow; color = WAVES_COLORS.accent; }
  else if (pos <= 20) { bg = WAVES_COLORS.yellowGlow; color = WAVES_COLORS.yellow; }
  else { bg = WAVES_COLORS.redGlow; color = WAVES_COLORS.red; }
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 32, padding: "2px 8px", borderRadius: 6,
      background: bg, color, fontSize: 14, fontWeight: 800,
      fontFamily: "'DM Sans', sans-serif",
    }}>#{pos}</span>
  );
}

function SectionTitle({ children, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
      <h3 style={{
        fontSize: 14, fontWeight: 700, color: WAVES_COLORS.textPrimary,
        textTransform: "uppercase", letterSpacing: "0.06em", margin: 0,
        fontFamily: "'DM Sans', sans-serif",
      }}>{children}</h3>
      {right}
    </div>
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: WAVES_COLORS.cardBg,
      border: `1px solid ${WAVES_COLORS.cardBorder}`,
      borderRadius: 12, padding: 20,
      ...style,
    }}>{children}</div>
  );
}

function FilterPill({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 14px", borderRadius: 20, border: "1px solid",
      borderColor: active ? WAVES_COLORS.accent : WAVES_COLORS.cardBorder,
      background: active ? WAVES_COLORS.accentGlow : "transparent",
      color: active ? WAVES_COLORS.accent : WAVES_COLORS.textMuted,
      fontSize: 12, fontWeight: 600, cursor: "pointer",
      transition: "all 0.2s",
      fontFamily: "'DM Sans', sans-serif",
    }}>{label}</button>
  );
}

// --- MAIN DASHBOARD ---
export default function WavesSEODashboard() {
  const [activeTab, setActiveTab] = useState("ai");
  const [cityFilter, setCityFilter] = useState("All");
  const [catFilter, setCatFilter] = useState("All");
  const [loading, setLoading] = useState(true);

  // Real data from API
  const [aiData, setAiData] = useState(null);
  const [rankData, setRankData] = useState(null);
  const [backlinkData, setBacklinkData] = useState(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      adminFetch('/admin/seo/ai-overview').catch(() => null),
      adminFetch('/admin/seo/rankings?days=7').catch(() => null),
      adminFetch('/admin/seo/backlinks').catch(() => null),
    ]).then(([ai, rank, bl]) => {
      setAiData(ai);
      setRankData(rank);
      setBacklinkData(bl);
      setLoading(false);
    });
  }, []);

  const cities = ["All", "Bradenton", "Sarasota", "Lakewood Ranch", "Venice", "Parrish", "North Port"];
  const categories = ["All", "Pest Control", "Lawn Care", "Mosquito", "Termite", "Tree & Shrub"];

  // Transform rankings API data into the shape we need
  const keywords = useMemo(() => {
    if (!rankData?.rankings) return [];
    return rankData.rankings.map(r => ({
      keyword: r.keyword,
      organic: r.currentPosition,
      prev: r.currentPosition != null && r.delta != null ? r.currentPosition - r.delta : null,
      mapPack: r.mapPackPosition || null,
      mapPrev: null, // API doesn't track map pack history separately
      trend: (r.history || []).map(h => h.position).filter(p => p != null),
      category: r.service_category || 'Pest Control',
      city: r.primary_city || 'All',
    }));
  }, [rankData]);

  const filteredKeywords = useMemo(() => {
    return keywords.filter(k => {
      if (cityFilter !== "All" && k.city !== cityFilter) return false;
      if (catFilter !== "All" && k.category !== catFilter) return false;
      return true;
    });
  }, [keywords, cityFilter, catFilter]);

  // Transform AI Overview data
  const aiOverview = useMemo(() => {
    if (!aiData) return null;
    const total = aiData.total || 0;
    const withAIO = aiData.withAIO || 0;
    const wavesCited = aiData.wavesCited || 0;

    // Build keyword tracking from results
    const keywordTracking = (aiData.results || []).map(r => ({
      keyword: r.keyword,
      aio: r.aioPresent,
      wavesCited: r.wavesCited,
      citedBy: r.wavesCited ? '--' : (r.sources?.[0]?.domain || '--'),
      provider: r.aioPresent ? 'Google AIO' : '--',
      status: r.wavesCited ? 'cited' : r.aioPresent ? 'competitor' : 'no_aio',
    }));

    // Build competitor mentions from citation counts
    const competitorMentions = Object.entries(aiData.citationCounts || {})
      .filter(([domain]) => !domain.includes('waves'))
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // Quick wins from API
    const quickWins = (aiData.quickWins || []).map(qw => ({
      keyword: qw.keyword,
      action: `AIO present for "${qw.keyword}" but Waves not cited. Optimize content to earn citation.`,
      effort: 'Medium',
    }));

    // LLM provider visibility from backlink data
    const llmMentions = backlinkData?.llmMentions || [];
    const llmStats = backlinkData?.llmStats || {};
    const mentionRate = total > 0 ? ((wavesCited / total) * 100).toFixed(1) : 0;

    return {
      mentionRate,
      recommendRate: aiData.geoScore || 0,
      firstPosition: total > 0 ? ((wavesCited / Math.max(withAIO, 1)) * 100).toFixed(1) : 0,
      citations: wavesCited,
      gaps: (aiData.quickWins || []).length,
      providerVisibility: [
        { name: "Google AIO", pct: total > 0 ? ((withAIO / total) * 100).toFixed(1) : 0, color: WAVES_COLORS.green },
        { name: "LLM Mentions", pct: llmStats.total > 0 ? ((llmStats.wavesMentioned / llmStats.total) * 100).toFixed(1) : 0, color: WAVES_COLORS.accent },
      ],
      competitorMentions,
      keywordTracking,
      quickWins,
    };
  }, [aiData, backlinkData]);

  // Rankings summary
  const rankSummary = useMemo(() => {
    if (!rankData?.summary) return null;
    const s = rankData.summary;
    const positions = keywords.map(k => k.organic).filter(p => p != null);
    const avg = positions.length > 0 ? (positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1) : '--';
    return {
      avgPosition: avg,
      top3Count: positions.filter(p => p <= 3).length,
      top10Count: positions.filter(p => p <= 10).length,
      mapPackCount: s.inMapPack || 0,
      improvingCount: s.improving || 0,
      decliningCount: s.declining || 0,
      stableCount: s.stable || 0,
      total: keywords.length,
    };
  }, [rankData, keywords]);

  if (loading) {
    return (
      <div style={{ color: WAVES_COLORS.textMuted, padding: 60, textAlign: 'center', fontSize: 14 }}>
        Loading SEO Command Center...
      </div>
    );
  }

  const noData = !aiData && !rankData;
  if (noData) {
    return (
      <Card style={{ padding: 60, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>{'🔍'}</div>
        <div style={{ fontSize: 18, fontWeight: 600, color: WAVES_COLORS.textPrimary, marginBottom: 8 }}>No SEO Data Yet</div>
        <div style={{ fontSize: 13, color: WAVES_COLORS.textMuted }}>Enable GATE_SEO_INTELLIGENCE and configure DataForSEO to start tracking rankings and AI visibility.</div>
      </Card>
    );
  }

  const maxCompMentions = Math.max(1, ...(aiOverview?.competitorMentions || []).map(c => c.count));
  const maxProviderPct = Math.max(1, ...(aiOverview?.providerVisibility || []).map(p => parseFloat(p.pct)));

  return (
    <div style={{ color: WAVES_COLORS.textPrimary, fontFamily: "'DM Sans', -apple-system, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>
            <span style={{ color: WAVES_COLORS.accent }}>Waves</span> SEO Command Center
          </span>
        </div>
        <div style={{ fontSize: 13, color: WAVES_COLORS.textMuted }}>
          wavespestcontrol.com — Live data from DataForSEO + Google Search Console
        </div>
      </div>

      {/* Tab Switcher */}
      <div style={{ display: "flex", gap: 4, marginBottom: 24, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 4, width: "fit-content" }}>
        {[
          { id: "ai", label: "AI Visibility" },
          { id: "organic", label: "Organic Rankings" },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            padding: "10px 24px", borderRadius: 8, border: "none",
            background: activeTab === tab.id ? WAVES_COLORS.accent : "transparent",
            color: activeTab === tab.id ? "#fff" : WAVES_COLORS.textMuted,
            fontSize: 14, fontWeight: 700, cursor: "pointer",
            transition: "all 0.2s",
            fontFamily: "'DM Sans', sans-serif",
          }}>{tab.label}</button>
        ))}
      </div>

      {/* ============= AI VISIBILITY TAB ============= */}
      {activeTab === "ai" && aiOverview && (
        <div>
          {/* KPI Row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
            <MetricCard value={`${aiOverview.mentionRate}%`} label="Mention Rate" sublabel="across tracked keywords" color={WAVES_COLORS.accent} />
            <MetricCard value={`${aiOverview.recommendRate}%`} label="GEO Score" sublabel="generative engine optimization" color={WAVES_COLORS.green} />
            <MetricCard value={`${aiOverview.firstPosition}%`} label="Citation Rate" sublabel="of AIO results" color={WAVES_COLORS.purple} />
            <MetricCard value={aiOverview.citations} label="Citations" sublabel="total AI citations" color={WAVES_COLORS.cyan} />
            <MetricCard value={aiOverview.gaps} label="Gaps" sublabel="missing opportunities" color={WAVES_COLORS.red} />
          </div>

          {/* Provider Visibility + Competitor Mentions */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
            <Card>
              <SectionTitle>Provider Visibility</SectionTitle>
              {aiOverview.providerVisibility.map(p => (
                <HBar key={p.name} label={p.name} value={parseFloat(p.pct)} maxValue={maxProviderPct * 1.1} color={p.color} />
              ))}
              {aiOverview.providerVisibility.length === 0 && (
                <div style={{ fontSize: 13, color: WAVES_COLORS.textMuted, padding: 20, textAlign: 'center' }}>No provider data yet</div>
              )}
            </Card>
            <Card>
              <SectionTitle>Competitor Mentions in AI</SectionTitle>
              {aiOverview.competitorMentions.length > 0 ? aiOverview.competitorMentions.map(c => (
                <CompBar key={c.name} name={c.name} count={c.count} maxCount={maxCompMentions} />
              )) : (
                <div style={{ fontSize: 13, color: WAVES_COLORS.textMuted, padding: 20, textAlign: 'center' }}>No competitor mention data yet</div>
              )}
            </Card>
          </div>

          {/* Keyword Tracking Table */}
          {aiOverview.keywordTracking.length > 0 && (
            <Card style={{ marginBottom: 20 }}>
              <SectionTitle>Keyword AI Tracking</SectionTitle>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${WAVES_COLORS.cardBorder}` }}>
                      {["Keyword", "AI Overview", "Status", "Cited Instead", "Provider"].map(h => (
                        <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: WAVES_COLORS.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {aiOverview.keywordTracking.map((kw, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${WAVES_COLORS.cardBorder}22` }}>
                        <td style={{ padding: "10px 12px", fontWeight: 600, color: WAVES_COLORS.textPrimary }}>{kw.keyword}</td>
                        <td style={{ padding: "10px 12px" }}>
                          {kw.aio ? <span style={{ color: WAVES_COLORS.green, fontWeight: 700 }}>Yes</span> : <span style={{ color: WAVES_COLORS.textMuted }}>No</span>}
                        </td>
                        <td style={{ padding: "10px 12px" }}><StatusDot status={kw.status} /></td>
                        <td style={{ padding: "10px 12px", color: kw.citedBy === "--" ? WAVES_COLORS.textMuted : WAVES_COLORS.red, fontWeight: kw.citedBy === "--" ? 400 : 600 }}>{kw.citedBy}</td>
                        <td style={{ padding: "10px 12px", color: WAVES_COLORS.textMuted }}>{kw.provider}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Quick Wins */}
          {aiOverview.quickWins.length > 0 && (
            <Card>
              <SectionTitle right={<span style={{ fontSize: 12, color: WAVES_COLORS.yellow, fontWeight: 600 }}>{aiOverview.quickWins.length} opportunities</span>}>
                Quick Wins -- Get Cited
              </SectionTitle>
              <div style={{ display: "grid", gap: 10 }}>
                {aiOverview.quickWins.map((qw, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 16, padding: "12px 16px",
                    background: "rgba(255,255,255,0.02)", borderRadius: 8,
                    border: `1px solid ${WAVES_COLORS.cardBorder}`,
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: WAVES_COLORS.textPrimary, marginBottom: 3 }}>{qw.keyword}</div>
                      <div style={{ fontSize: 12, color: WAVES_COLORS.textSecondary }}>{qw.action}</div>
                    </div>
                    <span style={{
                      padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 700,
                      background: qw.effort === "Low" ? WAVES_COLORS.greenGlow : qw.effort === "Medium" ? WAVES_COLORS.yellowGlow : WAVES_COLORS.redGlow,
                      color: qw.effort === "Low" ? WAVES_COLORS.green : qw.effort === "Medium" ? WAVES_COLORS.yellow : WAVES_COLORS.red,
                    }}>{qw.effort}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {!aiOverview.keywordTracking.length && !aiOverview.quickWins.length && (
            <Card style={{ padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: WAVES_COLORS.textMuted }}>No AI Overview tracking data yet. Enable GATE_SEO_INTELLIGENCE and run an AI Overview scan.</div>
            </Card>
          )}
        </div>
      )}

      {activeTab === "ai" && !aiOverview && (
        <Card style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: WAVES_COLORS.textMuted }}>No AI visibility data yet. Enable GATE_SEO_INTELLIGENCE to start tracking.</div>
        </Card>
      )}

      {/* ============= ORGANIC RANKINGS TAB ============= */}
      {activeTab === "organic" && rankSummary && (
        <div>
          {/* KPI Row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
            <MetricCard value={rankSummary.avgPosition} label="Avg Position" color={WAVES_COLORS.accent} />
            <MetricCard value={rankSummary.top3Count} label="Top 3" sublabel="keywords in top 3" color={WAVES_COLORS.gold} />
            <MetricCard value={rankSummary.top10Count} label="Top 10" sublabel="page 1 rankings" color={WAVES_COLORS.green} />
            <MetricCard value={rankSummary.mapPackCount} label="Map Pack" sublabel="in local 3-pack" color={WAVES_COLORS.purple} />
            <MetricCard value={`${rankSummary.improvingCount}/${rankSummary.total}`} label="Improving" sublabel={`${rankSummary.decliningCount} declining`} color={WAVES_COLORS.cyan} />
          </div>

          {/* Movement Summary + Filters */}
          <Card style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", gap: 32, alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: WAVES_COLORS.green, display: "inline-block" }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: WAVES_COLORS.green }}>{rankSummary.improvingCount}</span>
                <span style={{ fontSize: 13, color: WAVES_COLORS.textSecondary }}>Improving</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: WAVES_COLORS.red, display: "inline-block" }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: WAVES_COLORS.red }}>{rankSummary.decliningCount}</span>
                <span style={{ fontSize: 13, color: WAVES_COLORS.textSecondary }}>Declining</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: WAVES_COLORS.textMuted, display: "inline-block" }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: WAVES_COLORS.textMuted }}>{rankSummary.stableCount}</span>
                <span style={{ fontSize: 13, color: WAVES_COLORS.textSecondary }}>Stable</span>
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {cities.map(c => <FilterPill key={c} label={c} active={cityFilter === c} onClick={() => setCityFilter(c)} />)}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              {categories.map(c => <FilterPill key={c} label={c} active={catFilter === c} onClick={() => setCatFilter(c)} />)}
            </div>
          </Card>

          {/* Rankings Table */}
          <Card>
            <SectionTitle right={<span style={{ fontSize: 12, color: WAVES_COLORS.textMuted }}>{filteredKeywords.length} keywords</span>}>
              Keyword Rankings
            </SectionTitle>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${WAVES_COLORS.cardBorder}` }}>
                    {["Keyword", "Organic", "Map Pack", "Category", "City", "Trend"].map((h, i) => (
                      <th key={i} style={{
                        padding: "10px 12px", textAlign: i >= 1 && i <= 2 ? "center" : "left",
                        fontSize: 11, fontWeight: 700, color: WAVES_COLORS.textMuted,
                        textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredKeywords.map((kw, i) => (
                    <tr key={i} style={{
                      borderBottom: `1px solid ${WAVES_COLORS.cardBorder}22`,
                      background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                    }}>
                      <td style={{ padding: "10px 12px", fontWeight: 600, color: WAVES_COLORS.textPrimary, whiteSpace: "nowrap" }}>{kw.keyword}</td>
                      <td style={{ padding: "10px 12px", textAlign: "center" }}>
                        <PositionBadge pos={kw.organic} />
                        {kw.prev != null && kw.organic != null && kw.prev !== kw.organic && (
                          <span style={{ marginLeft: 6 }}><DeltaArrow current={kw.organic} previous={kw.prev} /></span>
                        )}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "center" }}><PositionBadge pos={kw.mapPack} /></td>
                      <td style={{ padding: "10px 12px" }}>
                        <span style={{
                          padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                          background: "rgba(255,255,255,0.05)", color: WAVES_COLORS.textSecondary,
                        }}>{kw.category}</span>
                      </td>
                      <td style={{ padding: "10px 12px", color: WAVES_COLORS.textMuted, fontSize: 12 }}>{kw.city}</td>
                      <td style={{ padding: "10px 12px" }}><Sparkline data={kw.trend} /></td>
                    </tr>
                  ))}
                  {filteredKeywords.length === 0 && (
                    <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: WAVES_COLORS.textMuted }}>No keywords match filters</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Top Movers */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
            <Card>
              <SectionTitle>Biggest Gains (7 days)</SectionTitle>
              {[...filteredKeywords]
                .filter(k => k.prev != null && k.organic != null)
                .sort((a, b) => (b.prev - b.organic) - (a.prev - a.organic))
                .slice(0, 5)
                .map((kw, i) => {
                  const gain = kw.prev - kw.organic;
                  if (gain <= 0) return null;
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "8px 0", borderBottom: `1px solid ${WAVES_COLORS.cardBorder}22`,
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: WAVES_COLORS.textPrimary }}>{kw.keyword}</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: WAVES_COLORS.green }}>
                        #{kw.prev} &rarr; #{kw.organic} +{gain}
                      </span>
                    </div>
                  );
                })}
            </Card>
            <Card>
              <SectionTitle>Biggest Drops (7 days)</SectionTitle>
              {[...filteredKeywords]
                .filter(k => k.prev != null && k.organic != null)
                .sort((a, b) => (a.prev - a.organic) - (b.prev - b.organic))
                .slice(0, 5)
                .map((kw, i) => {
                  const drop = kw.prev - kw.organic;
                  if (drop >= 0) return null;
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "8px 0", borderBottom: `1px solid ${WAVES_COLORS.cardBorder}22`,
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: WAVES_COLORS.textPrimary }}>{kw.keyword}</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: WAVES_COLORS.red }}>
                        #{kw.prev} &rarr; #{kw.organic} {drop}
                      </span>
                    </div>
                  );
                })}
            </Card>
          </div>
        </div>
      )}

      {activeTab === "organic" && !rankSummary && (
        <Card style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: WAVES_COLORS.textMuted }}>No ranking data yet. Enable GATE_SEO_INTELLIGENCE and configure DataForSEO to start tracking.</div>
        </Card>
      )}
    </div>
  );
}
