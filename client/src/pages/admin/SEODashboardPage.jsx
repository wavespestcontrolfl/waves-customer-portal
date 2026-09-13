import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ActionFeedback,
  Button,
  Card as UiCard,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  UiSurface,
} from "../../components/ui";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
function adminFetch(path, options = {}) {
  const body =
    options.body && typeof options.body !== "string"
      ? JSON.stringify(options.body)
      : options.body;
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body,
  }).then(async (r) => {
    if (!r.ok) {
      let message = `${r.status} ${r.statusText}`;
      try {
        const data = await r.clone().json();
        message = data?.error || message;
      } catch {
        /* keep default message */
      }
      throw new Error(message);
    }
    if (r.status === 204) return null;
    return r.json();
  });
}
function isAdminUser() {
  try {
    return (
      JSON.parse(localStorage.getItem("waves_admin_user") || "{}")?.role ===
      "admin"
    );
  } catch {
    return false;
  }
}

// --- COMPONENTS ---

function MetricCard({ value, label, sublabel, color = "#18181B" }) {
  return (
    <UiCard
      className="relative overflow-hidden rounded-md border-hairline border-zinc-200 bg-white px-4 py-[18px] text-center"
    >
      {" "}
      <div
        style={{
          background: color,
        }}
        className="absolute [top:0px] [left:50%] [transform:translateX(-50%)] [width:80px] [height:3px] rounded-xs"
      />{" "}
      <div
        style={{ color }}
        className="text-24 font-medium leading-tight"
      >
        {value}
      </div>{" "}
      <div className="text-ui-body font-medium text-ink-secondary [margin-top:6px]">
        {label}
      </div>
      {sublabel && (
        <div className="text-ui-body text-ink-secondary [margin-top:2px]">
          {sublabel}
        </div>
      )}
    </UiCard>
  );
}
function HBar({ label, value, maxValue, color, suffix = "%" }) {
  const pct = Math.min((value / maxValue) * 100, 100);
  return (
    <div className="mb-2.5 flex w-full items-center gap-3">
      {" "}
      <div className="[width:100px] text-ui-body text-ink-secondary font-medium shrink-0 text-right">
        {label}
      </div>{" "}
      <div className="[flex:1] [height:22px] bg-zinc-100 rounded-sm overflow-hidden relative">
        {" "}
        <div
          style={{
            width: `${pct}%`,
            background: color,
          }}
          className="[height:100%] rounded-sm transition-all"
        />{" "}
      </div>{" "}
      <div className="[width:52px] text-ui-body font-medium text-zinc-900 text-right shrink-0">
        {value}
        {suffix}
      </div>{" "}
    </div>
  );
}
function CompBar({ name, count, maxCount }) {
  const pct = (count / maxCount) * 100;
  return (
    <div className="flex items-center [gap:12px] [margin-bottom:8px]">
      {" "}
      <div className="[width:90px] text-ui-body text-ink-secondary font-medium text-right shrink-0 overflow-hidden text-ellipsis whitespace-nowrap">
        {name}
      </div>{" "}
      <div className="[flex:1] [height:18px] bg-zinc-100 rounded-sm overflow-hidden">
        {" "}
        <div
          style={{
            width: `${pct}%`,
          }}
          className="[height:100%] bg-alert-bg rounded-sm [min-width:8px]"
        />{" "}
      </div>{" "}
      <div className="[width:28px] text-ui-body font-medium text-zinc-900 text-right shrink-0">
        {count}
      </div>{" "}
    </div>
  );
}
function Sparkline({ data, width = 90, height = 28 }) {
  if (!data || data.length < 2)
    return <span className="text-ink-secondary text-ui-body">--</span>;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");
  const trending = data[data.length - 1] < data[0]; // lower position = better for rankings
  const lineColor = trending
    ? "#15803D"
    : data[data.length - 1] > data[0]
      ? "#991B1B"
      : "#A1A1AA";
  return (
    <svg width={width} height={height} className="block">
      {" "}
      <polyline
        points={points}
        fill="none"
        stroke={lineColor}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />{" "}
      <circle
        cx={parseFloat(points.split(" ").pop().split(",")[0])}
        cy={parseFloat(points.split(" ").pop().split(",")[1])}
        r="3"
        fill={lineColor}
      />{" "}
    </svg>
  );
}
function StatusDot({ status }) {
  const colors = {
    cited: "#15803D",
    competitor: "#991B1B",
    no_aio: "#A1A1AA",
  };
  const labels = {
    cited: "Waves Cited",
    competitor: "Competitor Cited",
    no_aio: "No AI Overview",
  };
  return (
    <span
      style={{
        color: colors[status],
      }}
      className="inline-flex items-center [gap:6px] text-ui-body font-medium"
    >
      {" "}
      <span
        style={{
          background: colors[status],
        }}
        className="[width:8px] [height:8px] rounded-xs inline-block"
      />
      {labels[status]}
    </span>
  );
}
function DeltaArrow({ current, previous }) {
  if (current == null || previous == null)
    return <span className="text-ink-secondary text-ui-body">--</span>;
  const diff = previous - current; // positive = improved (lower position is better)
  if (diff === 0)
    return (
      <span className="text-ink-secondary text-ui-body font-medium">--</span>
    );
  const color = diff > 0 ? "#15803D" : "#991B1B";
  return (
    <span
      style={{
        color,
      }}
      className="text-ui-body font-medium"
    >
      {diff > 0 ? "+" : "-"}
      {Math.abs(diff)}
    </span>
  );
}
function PositionBadge({ pos }) {
  if (pos == null)
    return <span className="text-ink-secondary text-ui-body">--</span>;
  let bg = "#F4F4F5";
  let color = "#52525B";
  if (pos <= 3) {
    bg = "#DCFCE7";
    color = "#15803D";
  } else if (pos <= 10) {
    bg = "#F4F4F5";
    color = "#18181B";
  } else if (pos <= 20) {
    bg = "#FEF3C7";
    color = "#A16207";
  } else {
    bg = "#FEE2E2";
    color = "#991B1B";
  }
  return (
    <span
      style={{
        background: bg,
        color,
      }}
      className="inline-flex items-center justify-center [min-width:32px] [padding:2px_8px] rounded-sm text-ui-body font-medium"
    >
      #{pos}
    </span>
  );
}
function SectionTitle({ children, right }) {
  return (
    <div className="flex justify-between items-center [margin-bottom:16px]">
      {" "}
      <h3 className="text-ui-body font-medium text-zinc-900 [margin:0px]">
        {children}
      </h3>
      {right}
    </div>
  );
}
function FilterPill({ label, active, onClick }) {
  return (
    <Button onClick={onClick} variant={active ? "primary" : "secondary"}>
      {label}
    </Button>
  );
}

// --- MAIN DASHBOARD ---
export default function WavesSEODashboard() {
  const [activeTab, setActiveTab] = useState("ai");
  const [cityFilter, setCityFilter] = useState("All");
  const [catFilter, setCatFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const loadSequence = useRef(0);

  // Real data from API
  const [aiData, setAiData] = useState(null);
  const [rankData, setRankData] = useState(null);
  const [backlinkData, setBacklinkData] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const canRunSeoActions = isAdminUser();
  const loadDashboard = useCallback(() => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError("");
    Promise.all([
      adminFetch("/admin/seo/ai-overview"),
      adminFetch("/admin/seo/rankings?days=7"),
      adminFetch("/admin/seo/backlinks"),
    ])
      .then(([ai, rank, bl]) => {
        if (sequence !== loadSequence.current) return;
        setAiData(ai);
        setRankData(rank);
        setBacklinkData(bl);
      })
      .catch((error) => {
        if (sequence !== loadSequence.current) return;
        setLoadError(error?.message || "Failed to load SEO dashboard data");
      })
      .finally(() => {
        if (sequence === loadSequence.current) setLoading(false);
      });
  }, []);
  useEffect(() => {
    loadDashboard();
    return () => {
      loadSequence.current += 1;
    };
  }, [loadDashboard]);
  const cities = [
    "All",
    "Bradenton",
    "Sarasota",
    "Lakewood Ranch",
    "Venice",
    "Parrish",
    "North Port",
  ];
  const categories = [
    "All",
    "Pest Control",
    "Lawn Care",
    "Mosquito",
    "Termite",
    "Tree & Shrub",
  ];

  // Transform rankings API data into the shape we need
  const keywords = useMemo(() => {
    if (!rankData?.rankings) return [];
    return rankData.rankings.map((r) => ({
      keyword: r.keyword,
      organic: r.currentPosition,
      prev:
        r.currentPosition != null && r.delta != null
          ? r.currentPosition - r.delta
          : null,
      mapPack: r.mapPackPosition || null,
      mapPrev: null,
      // API doesn't track map pack history separately
      trend: (r.history || []).map((h) => h.position).filter((p) => p != null),
      category: r.service_category || "Pest Control",
      city: r.primary_city || "All",
    }));
  }, [rankData]);
  const filteredKeywords = useMemo(() => {
    return keywords.filter((k) => {
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
    const keywordTracking = (aiData.results || []).map((r) => ({
      keyword: r.keyword,
      aio: r.aioPresent,
      wavesCited: r.wavesCited,
      citedBy: r.wavesCited ? "--" : r.sources?.[0]?.domain || "--",
      provider: r.aioPresent ? "Google AIO" : "--",
      status: r.wavesCited ? "cited" : r.aioPresent ? "competitor" : "no_aio",
    }));

    // Build competitor mentions from citation counts
    const competitorMentions = Object.entries(aiData.citationCounts || {})
      .filter(([domain]) => !domain.includes("waves"))
      .map(([name, count]) => ({
        name,
        count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // Quick wins from API
    const quickWins = (aiData.quickWins || []).map((qw) => ({
      keyword: qw.keyword,
      action: `AIO present for "${qw.keyword}" but Waves not cited. Optimize content to earn citation.`,
      effort: "Medium",
    }));

    // LLM provider visibility from backlink data
    const llmStats = backlinkData?.llmStats || {};
    const sourceCoverage =
      total > 0 ? ((wavesCited / total) * 100).toFixed(1) : 0;
    return {
      sourceCoverage,
      recommendRate: aiData.geoScore || 0,
      sourceRate:
        total > 0 ? ((wavesCited / Math.max(withAIO, 1)) * 100).toFixed(1) : 0,
      citations: wavesCited,
      gaps: (aiData.quickWins || []).length,
      llmSample: `${llmStats.measured || 0} measured of ${llmStats.total || 0} recent LLM observations`,
      providerVisibility: [
        {
          name: "Google AIO presence",
          pct: total > 0 ? ((withAIO / total) * 100).toFixed(1) : 0,
          color: "#15803D",
        },
        {
          name: "LLM linked citations",
          pct: llmStats.citationRate ?? null,
          color: "#18181B",
        },
        {
          name: "LLM brand mentions",
          pct: llmStats.mentionRate ?? null,
          color: "#15803D",
        },
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
    const positions = keywords.map((k) => k.organic).filter((p) => p != null);
    const avg =
      positions.length > 0
        ? (positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1)
        : "--";
    return {
      avgPosition: avg,
      top3Count: positions.filter((p) => p <= 3).length,
      top10Count: positions.filter((p) => p <= 10).length,
      mapPackCount: s.inMapPack || 0,
      improvingCount: s.improving || 0,
      decliningCount: s.declining || 0,
      stableCount: s.stable || 0,
      total: keywords.length,
    };
  }, [rankData, keywords]);
  if (loading) {
    return (
      <UiSurface
        density="comfortable"
        className="text-ink-secondary [padding:60px] text-center text-ui-body"
      >
        Loading SEO Command Center...
      </UiSurface>
    );
  }
  if (loadError) {
    return (
      <ActionFeedback
        error
        onRetry={loadDashboard}
        className="justify-center [padding:40px] text-center"
      >
        SEO dashboard unavailable: {loadError}
      </ActionFeedback>
    );
  }
  const runSync = async () => {
    if (!canRunSeoActions) return;
    setSyncing(true);
    setSyncMsg("Syncing GSC data...");
    try {
      await adminFetch("/admin/seo/sync", {
        method: "POST",
        body: { daysBack: 28 },
      });
      setSyncMsg("GSC synced. Running rank tracking...");
      await adminFetch("/admin/seo/rankings/track", {
        method: "POST",
        body: {},
      }).catch(() => {});
      setSyncMsg("Generating SEO report...");
      await adminFetch("/admin/seo/advisor/generate", {
        method: "POST",
        body: {},
      }).catch(() => {});
      setSyncMsg("Done! Refreshing...");
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      setSyncMsg("Sync failed: " + e.message);
    }
    setSyncing(false);
  };
  const noData = !aiData && !rankData;
  if (noData) {
    return (
      <UiCard className="[padding:60px] text-center">
        {" "}
        <div className="text-[48px] [margin-bottom:16px]"></div>{" "}
        <div className="text-[18px] font-medium text-zinc-900 [margin-bottom:8px]">
          No SEO Data Yet
        </div>{" "}
        <div className="text-ui-body text-ink-secondary [margin-bottom:20px]">
          Sync Google Search Console data and run the SEO analyzer to populate
          this dashboard.
        </div>{" "}
        {canRunSeoActions && (
          <Button onClick={runSync} disabled={syncing}>
            {syncing ? syncMsg : "Sync & Generate SEO Report"}
          </Button>
        )}
        {syncMsg && !syncing && (
          <div className="text-ui-body text-ink-secondary [margin-top:10px]">
            {syncMsg}
          </div>
        )}
        <div className="text-ui-body text-ink-secondary [margin-top:16px]">
          Requires: GOOGLE_SERVICE_ACCOUNT_JSON + GSC_SITE_URL env vars on
          Railway
        </div>{" "}
      </UiCard>
    );
  }
  const maxCompMentions = Math.max(
    1,
    ...(aiOverview?.competitorMentions || []).map((c) => c.count),
  );
  const maxProviderPct = Math.max(
    1,
    ...(aiOverview?.providerVisibility || []).map((p) => Number(p.pct)),
  );
  return (
    <UiSurface density="comfortable" className="text-zinc-900">
      {" "}
      {/* Tab Switcher */}
      <div className="mx-auto mb-6 flex w-full justify-center gap-1 rounded-md border-hairline border-zinc-200 bg-zinc-100 p-1 sm:w-fit">
        {[
          {
            id: "ai",
            label: "AI Visibility",
          },
          {
            id: "organic",
            label: "Organic Rankings",
          },
        ].map((tab) => (
          <Button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            variant={activeTab === tab.id ? "primary" : "secondary"}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      {/* ============= AI VISIBILITY TAB ============= */}
      {activeTab === "ai" && aiOverview && (
        <div>
          {/* KPI Row */}
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {" "}
            <MetricCard
              value={`${aiOverview.sourceCoverage}%`}
              label="Source Coverage"
              sublabel="across tracked keywords"
              color={"#18181B"}
            />{" "}
            <MetricCard
              value={`${aiOverview.recommendRate}%`}
              label="Legacy GEO Score"
              sublabel="SERP source signal"
              color={"#15803D"}
            />{" "}
            <MetricCard
              value={`${aiOverview.sourceRate}%`}
              label="AIO Source Rate"
              sublabel="of AIO results"
              color={"#18181B"}
            />{" "}
            <MetricCard
              value={aiOverview.citations}
              label="Source Appearances"
              sublabel="legacy SERP source flags"
              color={"#18181B"}
            />{" "}
            <MetricCard
              value={aiOverview.gaps}
              label="Gaps"
              sublabel="missing opportunities"
              color={"#991B1B"}
            />{" "}
          </div>
          {/* Provider Visibility + Competitor Mentions */}
          <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {" "}
            <UiCard className="p-5">
              {" "}
              <SectionTitle>Provider Visibility</SectionTitle>
              {aiOverview.providerVisibility.map((p) =>
                p.pct === null ? (
                  <div
                    key={p.name}
                    className="text-ui-body text-ink-secondary [margin-bottom:12px]"
                  >
                    {p.name}: not measured
                  </div>
                ) : (
                  <HBar
                    key={p.name}
                    label={p.name}
                    value={parseFloat(p.pct)}
                    maxValue={maxProviderPct * 1.1}
                    color={p.color}
                  />
                ),
              )}
              <p className="text-ui-body text-ink-secondary">
                {aiOverview.llmSample}. Engine and question breakdowns are in
                SEO → Authority → LLM Mentions.
              </p>
              {aiOverview.providerVisibility.length === 0 && (
                <div className="text-ui-body text-ink-secondary [padding:20px] text-center">
                  No provider data yet
                </div>
              )}
            </UiCard>{" "}
            <UiCard className="p-5">
              {" "}
              <SectionTitle>Competitor Mentions in AI</SectionTitle>
              {aiOverview.competitorMentions.length > 0 ? (
                aiOverview.competitorMentions.map((c) => (
                  <CompBar
                    key={c.name}
                    name={c.name}
                    count={c.count}
                    maxCount={maxCompMentions}
                  />
                ))
              ) : (
                <div className="text-ui-body text-ink-secondary [padding:20px] text-center">
                  No competitor mention data yet
                </div>
              )}
            </UiCard>{" "}
          </div>
          {/* Keyword Tracking Table */}
          {aiOverview.keywordTracking.length > 0 && (
            <UiCard className="p-5 [margin-bottom:20px]">
              <SectionTitle>Keyword AI Tracking</SectionTitle>
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse] text-ui-body">
                  <THead>
                    <TR className="border-b border-hairline border-zinc-200">
                      {[
                        "Keyword",
                        "AI Overview",
                        "Status",
                        "Cited Instead",
                        "Provider",
                      ].map((h) => (
                        <TH
                          key={h}
                          className="[padding:10px_12px] text-left text-ui-body font-medium text-ink-secondary"
                        >
                          {h}
                        </TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {aiOverview.keywordTracking.map((kw, i) => (
                      <TR
                        key={i}
                        className="border-b border-hairline border-zinc-200"
                      >
                        <TD className="[padding:10px_12px] font-medium text-zinc-900">
                          {kw.keyword}
                        </TD>
                        <TD className="[padding:10px_12px]">
                          {kw.aio ? (
                            <span className="text-zinc-900 font-medium">
                              Yes
                            </span>
                          ) : (
                            <span className="text-ink-secondary">No</span>
                          )}
                        </TD>
                        <TD className="[padding:10px_12px]">
                          <StatusDot status={kw.status} />
                        </TD>
                        <TD
                          className={`px-3 py-2.5 ${
                            kw.citedBy === "--"
                              ? "font-normal text-ink-tertiary"
                              : "font-medium text-alert-fg"
                          }`}
                        >
                          {kw.citedBy}
                        </TD>
                        <TD className="[padding:10px_12px] text-ink-secondary">
                          {kw.provider}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </UiCard>
          )}

          {/* Quick Wins */}
          {aiOverview.quickWins.length > 0 && (
            <UiCard className="p-5">
              {" "}
              <SectionTitle
                right={
                  <span className="text-ui-body text-zinc-700 font-medium">
                    {aiOverview.quickWins.length} opportunities
                  </span>
                }
              >
                Quick Wins -- Get Cited
              </SectionTitle>{" "}
              <div className="grid [gap:10px]">
                {aiOverview.quickWins.map((qw, i) => (
                  <div
                    key={i}
                    className="flex items-center [gap:16px] [padding:12px_16px] bg-zinc-100 rounded-md border-hairline border-zinc-200"
                  >
                    {" "}
                    <div className="[flex:1]">
                      {" "}
                      <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:3px]">
                        {qw.keyword}
                      </div>{" "}
                      <div className="text-ui-body text-ink-secondary">
                        {qw.action}
                      </div>{" "}
                    </div>{" "}
                    <span
                      style={{
                        background:
                          qw.effort === "Low"
                            ? "#DCFCE7"
                            : qw.effort === "Medium"
                              ? "#FEF3C7"
                              : "#FEE2E2",
                        color:
                          qw.effort === "Low"
                            ? "#15803D"
                            : qw.effort === "Medium"
                              ? "#A16207"
                              : "#991B1B",
                      }}
                      className="[padding:3px_10px] rounded-md text-ui-body font-medium"
                    >
                      {qw.effort}
                    </span>{" "}
                  </div>
                ))}
              </div>{" "}
            </UiCard>
          )}

          {!aiOverview.keywordTracking.length &&
            !aiOverview.quickWins.length && (
              <UiCard className="[padding:40px] text-center">
                {" "}
                <div className="text-ui-body text-ink-secondary">
                  No AI Overview tracking data yet. Enable GATE_SEO_INTELLIGENCE
                  and run an AI Overview scan.
                </div>{" "}
              </UiCard>
            )}
        </div>
      )}
      {activeTab === "ai" && !aiOverview && (
        <UiCard className="[padding:40px] text-center">
          {" "}
          <div className="text-ui-body text-ink-secondary">
            No AI visibility data yet. Enable GATE_SEO_INTELLIGENCE to start
            tracking.
          </div>{" "}
        </UiCard>
      )}
      {/* ============= ORGANIC RANKINGS TAB ============= */}
      {activeTab === "organic" && rankSummary && (
        <div>
          {/* KPI Row */}
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {" "}
            <MetricCard
              value={rankSummary.avgPosition}
              label="Avg Position"
              color={"#18181B"}
            />{" "}
            <MetricCard
              value={rankSummary.top3Count}
              label="Top 3"
              sublabel="keywords in top 3"
              color={"#18181B"}
            />{" "}
            <MetricCard
              value={rankSummary.top10Count}
              label="Top 10"
              sublabel="page 1 rankings"
              color={"#15803D"}
            />{" "}
            <MetricCard
              value={rankSummary.mapPackCount}
              label="Map Pack"
              sublabel="in local 3-pack"
              color={"#18181B"}
            />{" "}
            <MetricCard
              value={`${rankSummary.improvingCount}/${rankSummary.total}`}
              label="Improving"
              sublabel={`${rankSummary.decliningCount} declining`}
              color={"#18181B"}
            />{" "}
          </div>
          {/* Movement Summary + Filters */}
          <UiCard className="p-5 [margin-bottom:20px]">
            {" "}
            <div className="flex flex-wrap items-center gap-4 sm:gap-8">
              {" "}
              <div className="flex items-center [gap:8px]">
                {" "}
                <span className="[width:12px] [height:12px] rounded-xs bg-zinc-900 inline-block" />{" "}
                <span className="text-ui-body font-medium text-zinc-900">
                  {rankSummary.improvingCount}
                </span>{" "}
                <span className="text-ui-body text-ink-secondary">
                  Improving
                </span>{" "}
              </div>{" "}
              <div className="flex items-center [gap:8px]">
                {" "}
                <span className="[width:12px] [height:12px] rounded-xs bg-alert-bg inline-block" />{" "}
                <span className="text-ui-body font-medium text-alert-fg">
                  {rankSummary.decliningCount}
                </span>{" "}
                <span className="text-ui-body text-ink-secondary">
                  Declining
                </span>{" "}
              </div>{" "}
              <div className="flex items-center [gap:8px]">
                {" "}
                <span className="[width:12px] [height:12px] rounded-xs bg-zinc-900 inline-block" />{" "}
                <span className="text-ui-body font-medium text-ink-secondary">
                  {rankSummary.stableCount}
                </span>{" "}
                <span className="text-ui-body text-ink-secondary">
                  Stable
                </span>{" "}
              </div>
              <div className="hidden flex-1 sm:block" />
              <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
                {cities.map((c) => (
                  <FilterPill
                    key={c}
                    label={c}
                    active={cityFilter === c}
                    onClick={() => setCityFilter(c)}
                  />
                ))}
              </div>{" "}
            </div>{" "}
            <div className="flex [gap:6px] [margin-top:10px] flex-wrap">
              {categories.map((c) => (
                <FilterPill
                  key={c}
                  label={c}
                  active={catFilter === c}
                  onClick={() => setCatFilter(c)}
                />
              ))}
            </div>{" "}
          </UiCard>
          {/* Rankings Table */}
          <UiCard className="p-5">
            {" "}
            <SectionTitle
              right={
                <span className="text-ui-body text-ink-secondary">
                  {filteredKeywords.length} keywords
                </span>
              }
            >
              Keyword Rankings
            </SectionTitle>
            <div className="overflow-x-auto">
              <Table className="[width:100%] [border-collapse:collapse] text-ui-body">
                <THead>
                  <TR className="border-b border-hairline border-zinc-200">
                    {[
                      "Keyword",
                      "Organic",
                      "Map Pack",
                      "Category",
                      "City",
                      "Trend",
                    ].map((h, i) => (
                      <TH
                        key={i}
                        className={`whitespace-nowrap px-3 py-2.5 text-ui-body font-medium text-ink-secondary ${
                          i >= 1 && i <= 2 ? "text-center" : "text-left"
                        }`}
                      >
                        {h}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {filteredKeywords.map((kw, i) => (
                    <TR
                      key={i}
                      className="border-b border-hairline border-zinc-200 odd:bg-zinc-50"
                    >
                      <TD className="[padding:10px_12px] font-medium text-zinc-900 whitespace-nowrap">
                        {kw.keyword}
                      </TD>
                      <TD className="[padding:10px_12px] text-center">
                        <PositionBadge pos={kw.organic} />
                        {kw.prev != null &&
                          kw.organic != null &&
                          kw.prev !== kw.organic && (
                            <span className="[margin-left:6px]">
                              <DeltaArrow
                                current={kw.organic}
                                previous={kw.prev}
                              />
                            </span>
                          )}
                      </TD>
                      <TD className="[padding:10px_12px] text-center">
                        <PositionBadge pos={kw.mapPack} />
                      </TD>
                      <TD className="[padding:10px_12px]">
                        <span className="[padding:2px_8px] rounded-sm text-ui-body font-medium bg-zinc-100 text-ink-secondary">
                          {kw.category}
                        </span>
                      </TD>
                      <TD className="[padding:10px_12px] text-ink-secondary text-ui-body">
                        {kw.city}
                      </TD>
                      <TD className="[padding:10px_12px]">
                        <Sparkline data={kw.trend} />
                      </TD>
                    </TR>
                  ))}
                  {filteredKeywords.length === 0 && (
                    <TR>
                      <TD
                        colSpan={6}
                        className="[padding:30px] text-center text-ink-secondary"
                      >
                        No keywords match filters
                      </TD>
                    </TR>
                  )}
                </TBody>
              </Table>
            </div>
          </UiCard>
          {/* Top Movers */}
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {" "}
            <UiCard className="p-5">
              {" "}
              <SectionTitle>Biggest Gains (7 days)</SectionTitle>
              {[...filteredKeywords]
                .filter((k) => k.prev != null && k.organic != null)
                .sort((a, b) => b.prev - b.organic - (a.prev - a.organic))
                .slice(0, 5)
                .map((kw, i) => {
                  const gain = kw.prev - kw.organic;
                  if (gain <= 0) return null;
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between [padding:8px_0] border-b border-hairline border-zinc-200"
                    >
                      {" "}
                      <span className="text-ui-body font-medium text-zinc-900">
                        {kw.keyword}
                      </span>{" "}
                      <span className="text-ui-body font-medium text-zinc-900">
                        #{kw.prev} &rarr; #{kw.organic} +{gain}
                      </span>{" "}
                    </div>
                  );
                })}
            </UiCard>{" "}
            <UiCard className="p-5">
              {" "}
              <SectionTitle>Biggest Drops (7 days)</SectionTitle>
              {[...filteredKeywords]
                .filter((k) => k.prev != null && k.organic != null)
                .sort((a, b) => a.prev - a.organic - (b.prev - b.organic))
                .slice(0, 5)
                .map((kw, i) => {
                  const drop = kw.prev - kw.organic;
                  if (drop >= 0) return null;
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between [padding:8px_0] border-b border-hairline border-zinc-200"
                    >
                      {" "}
                      <span className="text-ui-body font-medium text-zinc-900">
                        {kw.keyword}
                      </span>{" "}
                      <span className="text-ui-body font-medium text-alert-fg">
                        #{kw.prev} &rarr; #{kw.organic} {drop}
                      </span>{" "}
                    </div>
                  );
                })}
            </UiCard>{" "}
          </div>{" "}
        </div>
      )}
      {activeTab === "organic" && !rankSummary && (
        <UiCard className="[padding:40px] text-center">
          {" "}
          <div className="text-ui-body text-ink-secondary">
            No ranking data yet. Enable GATE_SEO_INTELLIGENCE and configure
            DataForSEO to start tracking.
          </div>{" "}
        </UiCard>
      )}
    </UiSurface>
  );
}
