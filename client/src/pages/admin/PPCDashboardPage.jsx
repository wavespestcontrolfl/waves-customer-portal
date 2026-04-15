import { useState, useEffect, useMemo } from "react";

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
  }).then(r => r.json());
}

const C = {
  bg: "#F1F5F9",
  card: "#FFFFFF",
  border: "#E2E8F0",
  blue: "#0A7EC2",
  blueGlow: "rgba(10,126,194,0.10)",
  green: "#16A34A",
  greenGlow: "rgba(22,163,74,0.10)",
  red: "#C0392B",
  redGlow: "rgba(192,57,43,0.08)",
  yellow: "#F0A500",
  yellowGlow: "rgba(240,165,0,0.10)",
  purple: "#7C3AED",
  purpleGlow: "rgba(124,58,237,0.08)",
  orange: "#F97316",
  orangeGlow: "rgba(249,115,22,0.08)",
  cyan: "#06B6D4",
  cyanGlow: "rgba(6,182,212,0.08)",
  gold: "#FBBF24",
  text: "#334155",
  text2: "#64748B",
  text3: "#64748B",
  text4: "#475569",
  heading: "#0F172A",
  inputBorder: "#CBD5E1",
};

// --- HELPERS ---
const fmt = (n, d = 0) => n == null ? "--" : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtMoney = (n) => n == null ? "--" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n) => n == null ? "--" : `${Number(n).toFixed(1)}%`;

function MiniSparkline({ data, width = 80, height = 24 }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 4) - 2}`).join(" ");
  const up = data[data.length - 1] >= data[0];
  const c = up ? C.green : C.red;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={parseFloat(pts.split(" ").pop().split(",")[0])} cy={parseFloat(pts.split(" ").pop().split(",")[1])} r="2.5" fill={c} />
    </svg>
  );
}

function KPI({ value, label, sub, color = C.blue }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px", textAlign: "center", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", width: 60, height: 3, background: color, borderRadius: "0 0 4px 4px" }} />
      <div style={{ fontSize: 28, fontWeight: 800, color, letterSpacing: "-0.02em", lineHeight: 1.1, fontFamily: "'DM Sans',sans-serif" }}>{value}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 6 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Card({ children, style = {} }) {
  return <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, ...style }}>{children}</div>;
}

function SectionTitle({ children, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, textTransform: "uppercase", letterSpacing: "0.06em", margin: 0, fontFamily: "'DM Sans',sans-serif" }}>{children}</h3>
      {right}
    </div>
  );
}

function Pill({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 14px", borderRadius: 20, border: "1px solid", cursor: "pointer",
      borderColor: active ? C.blue : C.border, background: active ? C.blueGlow : "transparent",
      color: active ? C.blue : C.text3, fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", transition: "all 0.15s",
    }}>{label}</button>
  );
}

function StatusBadge({ status }) {
  const map = {
    active: { bg: C.greenGlow, color: C.green, label: "Active" },
    paused: { bg: C.yellowGlow, color: C.yellow, label: "Paused" },
    winner: { bg: C.greenGlow, color: C.green, label: "Winner" },
    testing: { bg: C.blueGlow, color: C.blue, label: "Testing" },
    losing: { bg: C.redGlow, color: C.red, label: "Losing" },
    keep: { bg: C.greenGlow, color: C.green, label: "Keep" },
    watch: { bg: C.yellowGlow, color: C.yellow, label: "Watch" },
    negative: { bg: C.redGlow, color: C.red, label: "Negative" },
  };
  const s = map[status] || { bg: "#F1F5F9", color: C.text3, label: status };
  return <span style={{ padding: "3px 10px", borderRadius: 10, fontSize: 11, fontWeight: 700, background: s.bg, color: s.color, whiteSpace: "nowrap" }}>{s.label}</span>;
}

function QualityDots({ score }) {
  if (score == null) return <span style={{ color: C.text3, fontSize: 12 }}>--</span>;
  const color = score >= 8 ? C.green : score >= 6 ? C.yellow : C.red;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 14, fontWeight: 800, color, fontFamily: "'DM Sans',sans-serif" }}>{score}</span>
      <span style={{ fontSize: 11, color: C.text3 }}>/10</span>
    </div>
  );
}

function FunnelBar({ label, value, maxValue, color, prefix = "" }) {
  const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
      <div style={{ width: 80, fontSize: 12, color: C.text2, fontWeight: 500, textAlign: "right", flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 26, background: "#F1F5F9", borderRadius: 6, overflow: "hidden", position: "relative" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 6, transition: "width 0.6s ease", minWidth: value > 0 ? 4 : 0, boxShadow: `0 0 12px ${color}33` }} />
        <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 12, fontWeight: 700, color: C.text }}>{prefix}{fmt(value)}</span>
      </div>
    </div>
  );
}

function DonutChart({ segments, size = 140, thickness = 18, centerLabel, centerValue }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  let cumAngle = -90;
  const paths = segments.map((seg, i) => {
    const angle = total > 0 ? (seg.value / total) * 360 : 0;
    const startRad = (cumAngle * Math.PI) / 180;
    const endRad = ((cumAngle + angle) * Math.PI) / 180;
    cumAngle += angle;
    const r = size / 2 - thickness / 2;
    const cx = size / 2, cy = size / 2;
    const x1 = cx + r * Math.cos(startRad), y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad), y2 = cy + r * Math.sin(endRad);
    const large = angle > 180 ? 1 : 0;
    return <path key={i} d={`M${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2}`} fill="none" stroke={seg.color} strokeWidth={thickness} strokeLinecap="round" />;
  });
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size}>{paths}</svg>
      <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", textAlign: "center" }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, fontFamily: "'DM Sans',sans-serif" }}>{centerValue}</div>
        <div style={{ fontSize: 10, fontWeight: 600, color: C.text3, textTransform: "uppercase", letterSpacing: "0.05em" }}>{centerLabel}</div>
      </div>
    </div>
  );
}

// --- MAIN DASHBOARD ---
export default function WavesPPCDashboard() {
  const [tab, setTab] = useState("overview");
  const [serviceFilter, setServiceFilter] = useState("All");
  const [cityFilter, setCityFilter] = useState("All");
  const [platformFilter, setPlatformFilter] = useState("All");
  const [loading, setLoading] = useState(true);

  // Real API data
  const [campaigns, setCampaigns] = useState([]);
  const [funnelData, setFunnelData] = useState(null);
  const [revenueData, setRevenueData] = useState(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      adminFetch('/admin/ads/campaigns').catch(() => ({ campaigns: [] })),
      adminFetch('/admin/ads/funnel?period=30d').catch(() => null),
      adminFetch('/admin/ads/revenue-attribution?period=month').catch(() => null),
    ]).then(([campRes, funnel, revenue]) => {
      setCampaigns(campRes.campaigns || []);
      setFunnelData(funnel);
      setRevenueData(revenue);
      setLoading(false);
    });
  }, []);

  const services = useMemo(() => {
    const set = new Set(campaigns.map(c => c.service_category).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [campaigns]);

  const cities = useMemo(() => {
    const set = new Set(campaigns.map(c => c.target_area).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [campaigns]);

  const platforms = useMemo(() => {
    const set = new Set(campaigns.map(c => c.campaign_type).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [campaigns]);

  const filtered = useMemo(() => campaigns.filter(c => {
    if (serviceFilter !== "All" && c.service_category !== serviceFilter) return false;
    if (cityFilter !== "All" && c.target_area !== cityFilter) return false;
    if (platformFilter !== "All" && c.campaign_type !== platformFilter) return false;
    return true;
  }), [campaigns, serviceFilter, cityFilter, platformFilter]);

  const totals = useMemo(() => {
    const active = filtered.filter(c => c.status === "active");
    return {
      spent: active.reduce((s, c) => s + (c.last7d?.spend || 0), 0),
      budget: active.reduce((s, c) => s + (c.daily_budget_current || 0) * 7, 0),
      revenue: active.reduce((s, c) => s + (c.last7d?.conversionValue || 0), 0),
      conversions: active.reduce((s, c) => s + (c.last7d?.conversions || 0), 0),
      leads: active.reduce((s, c) => s + (c.last7d?.conversions || 0), 0),
      clicks: active.reduce((s, c) => s + (c.last7d?.clicks || 0), 0),
      impressions: active.reduce((s, c) => s + (c.last7d?.impressions || 0), 0),
    };
  }, [filtered]);

  const overallROAS = totals.spent > 0 ? (totals.revenue / totals.spent).toFixed(1) : "--";
  const overallCPL = totals.leads > 0 ? (totals.spent / totals.leads).toFixed(2) : "--";
  const overallCTR = totals.impressions > 0 ? ((totals.clicks / totals.impressions) * 100).toFixed(1) : "--";

  // Service breakdown from 30-day data
  const serviceBreakdown = useMemo(() => {
    const map = {};
    campaigns.filter(c => c.status === "active").forEach(c => {
      const svc = c.service_category || 'Other';
      if (!map[svc]) map[svc] = { service: svc, spent: 0, revenue: 0, leads: 0 };
      map[svc].spent += c.last30d?.spend || 0;
      map[svc].revenue += c.last30d?.conversionValue || 0;
      map[svc].leads += c.last30d?.conversions || 0;
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [campaigns]);

  const serviceColors = { "Pest Control": C.blue, "Lawn Care": C.green, "Mosquito": C.purple, "Termite": C.orange };
  const activeCampaigns = campaigns.filter(c => c.status === "active").length;

  if (loading) {
    return <div style={{ color: C.text3, padding: 60, textAlign: "center", fontSize: 14 }}>Loading PPC Command Center...</div>;
  }

  if (campaigns.length === 0) {
    return (
      <Card style={{ padding: 60, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>{'📣'}</div>
        <div style={{ fontSize: 18, fontWeight: 600, color: C.heading, marginBottom: 8 }}>No Campaigns Yet</div>
        <div style={{ fontSize: 13, color: C.text3 }}>Connect your Google Ads account and add campaigns to start tracking PPC performance.</div>
      </Card>
    );
  }

  return (
    <div style={{ color: C.text, fontFamily: "'DM Sans',-apple-system,sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
      <style>{`
        @media (max-width: 640px) {
          .ppc-tab-bar { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; width: 100% !important; }
          .ppc-tab-bar button { flex-shrink: 0 !important; padding: 8px 14px !important; font-size: 12px !important; }
          .ppc-kpi-grid-6 { grid-template-columns: repeat(2, 1fr) !important; }
          .ppc-kpi-grid-4 { grid-template-columns: repeat(2, 1fr) !important; }
          .ppc-two-col { grid-template-columns: 1fr !important; }
          .ppc-platform-grid { grid-template-columns: 1fr !important; }
          .ppc-funnel-grid { grid-template-columns: 1fr !important; }
          .ppc-funnel-stats { grid-template-columns: repeat(3, 1fr) !important; }
          .ppc-header-badge { display: flex !important; flex-wrap: wrap !important; gap: 8px !important; }
          .ppc-filter-wrap { flex-direction: column !important; gap: 8px !important; }
          .ppc-filter-wrap > div { flex-wrap: wrap !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div className="ppc-header-badge" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>
            <span style={{ color: C.blue }}>Waves</span> PPC Command Center
          </span>
          <span style={{ padding: "4px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: C.greenGlow, color: C.green }}>
            {activeCampaigns} Active Campaigns
          </span>
        </div>
        <div style={{ fontSize: 13, color: C.text3 }}>Google Ads + Local Service Ads -- Live data from campaign tracker</div>
      </div>

      {/* Tab Switcher */}
      <div className="ppc-tab-bar" style={{ display: "flex", gap: 4, marginBottom: 24, background: "#F1F5F9", borderRadius: 10, padding: 4, width: "fit-content", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        {[
          { id: "overview", label: "Overview" },
          { id: "campaigns", label: "Campaigns" },
          { id: "funnel", label: "Funnel & Attribution" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: "10px 22px", borderRadius: 8, border: "none",
            background: tab === t.id ? C.blue : "transparent",
            color: tab === t.id ? "#fff" : C.text3,
            fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "all 0.15s", fontFamily: "'DM Sans',sans-serif",
            flexShrink: 0, whiteSpace: "nowrap",
          }}>{t.label}</button>
        ))}
      </div>

      {/* ======= OVERVIEW ======= */}
      {tab === "overview" && (
        <div>
          {/* KPI Row */}
          <div className="ppc-kpi-grid-6" style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 12, marginBottom: 20 }}>
            <KPI value={fmtMoney(totals.spent)} label="7-Day Spend" sub={`of ${fmtMoney(totals.budget)} budget`} color={C.blue} />
            <KPI value={fmtMoney(totals.revenue)} label="7-Day Revenue" sub="attributed revenue" color={C.green} />
            <KPI value={`${overallROAS}x`} label="ROAS" sub="return on ad spend" color={parseFloat(overallROAS) >= 2 ? C.green : C.red} />
            <KPI value={fmt(totals.leads)} label="Conversions" sub={`${fmt(totals.clicks)} clicks`} color={C.purple} />
            <KPI value={`$${overallCPL}`} label="Cost Per Lead" sub="all campaigns" color={C.cyan} />
            <KPI value={`${overallCTR}%`} label="Avg CTR" sub="search campaigns" color={C.orange} />
          </div>

          {/* Service Breakdown + Budget Donut */}
          <div className="ppc-two-col" style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16, marginBottom: 20 }}>
            <Card>
              <SectionTitle>Revenue by Service Line (30d)</SectionTitle>
              {serviceBreakdown.length > 0 ? serviceBreakdown.map(s => (
                <FunnelBar key={s.service} label={s.service} value={s.revenue} maxValue={Math.max(...serviceBreakdown.map(x => x.revenue)) * 1.1} color={serviceColors[s.service] || C.blue} prefix="$" />
              )) : <div style={{ color: C.text3, fontSize: 13, padding: 20, textAlign: 'center' }}>No revenue data yet</div>}
              {serviceBreakdown.length > 0 && (
                <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 8 }}>
                  <SectionTitle>Spend by Service Line</SectionTitle>
                  {serviceBreakdown.map(s => (
                    <FunnelBar key={s.service} label={s.service} value={s.spent} maxValue={Math.max(...serviceBreakdown.map(x => x.spent)) * 1.1} color={serviceColors[s.service] || C.blue} prefix="$" />
                  ))}
                </div>
              )}
            </Card>
            <Card style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <SectionTitle>Budget Utilization (7d)</SectionTitle>
              <DonutChart
                segments={[
                  { value: totals.spent, color: C.blue },
                  { value: Math.max(0, totals.budget - totals.spent), color: C.border },
                ]}
                centerValue={totals.budget > 0 ? `${((totals.spent / totals.budget) * 100).toFixed(0)}%` : "--"}
                centerLabel="Utilized"
              />
              <div style={{ marginTop: 16, textAlign: "center" }}>
                <div style={{ fontSize: 13, color: C.text2 }}>{fmtMoney(totals.spent)} of {fmtMoney(totals.budget)}</div>
                <div style={{ fontSize: 12, color: C.text3, marginTop: 4 }}>{fmtMoney(Math.max(0, totals.budget - totals.spent))} remaining</div>
              </div>
            </Card>
          </div>

          {/* Platform Split */}
          <div className="ppc-platform-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
            {["google_search", "google_lsa"].map(type => {
              const label = type === "google_lsa" ? "Local Service Ads" : "Google Search Ads";
              const typeCamps = campaigns.filter(c => c.campaign_type === type && c.status === "active");
              const sp = typeCamps.reduce((s, c) => s + (c.last30d?.spend || 0), 0);
              const rv = typeCamps.reduce((s, c) => s + (c.last30d?.conversionValue || 0), 0);
              const ld = typeCamps.reduce((s, c) => s + (c.last30d?.conversions || 0), 0);
              return (
                <Card key={type}>
                  <SectionTitle>{label}</SectionTitle>
                  <div className="ppc-kpi-grid-4" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
                    <div><div style={{ fontSize: 20, fontWeight: 800, color: C.blue }}>{fmtMoney(sp)}</div><div style={{ fontSize: 11, color: C.text3 }}>SPEND</div></div>
                    <div><div style={{ fontSize: 20, fontWeight: 800, color: C.green }}>{fmtMoney(rv)}</div><div style={{ fontSize: 11, color: C.text3 }}>REVENUE</div></div>
                    <div><div style={{ fontSize: 20, fontWeight: 800, color: C.purple }}>{ld}</div><div style={{ fontSize: 11, color: C.text3 }}>CONVERSIONS</div></div>
                    <div><div style={{ fontSize: 20, fontWeight: 800, color: C.cyan }}>{sp > 0 ? (rv / sp).toFixed(1) + 'x' : '--'}</div><div style={{ fontSize: 11, color: C.text3 }}>ROAS</div></div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* ======= CAMPAIGNS ======= */}
      {tab === "campaigns" && (
        <div>
          {/* Filters */}
          <Card style={{ marginBottom: 20 }}>
            <div className="ppc-filter-wrap" style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: C.text3, fontWeight: 600 }}>Service:</span>
                {services.map(s => <Pill key={s} label={s} active={serviceFilter === s} onClick={() => setServiceFilter(s)} />)}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: C.text3, fontWeight: 600 }}>City:</span>
                {cities.map(c => <Pill key={c} label={c} active={cityFilter === c} onClick={() => setCityFilter(c)} />)}
              </div>
              {platforms.length > 2 && (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: C.text3, fontWeight: 600 }}>Platform:</span>
                  {platforms.map(p => <Pill key={p} label={p} active={platformFilter === p} onClick={() => setPlatformFilter(p)} />)}
                </div>
              )}
            </div>
          </Card>

          {/* Campaign Table */}
          <Card>
            <SectionTitle right={<span style={{ fontSize: 12, color: C.text3 }}>{filtered.length} campaigns</span>}>Campaign Performance</SectionTitle>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {["Campaign", "Status", "Budget/Day", "7d Spend", "7d Revenue", "ROAS", "CPA", "Conv", "Clicks", "CTR"].map((h, i) => (
                      <th key={i} style={{ padding: "10px 8px", textAlign: i >= 2 ? "right" : "left", fontSize: 10, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c, i) => {
                    const p = c.last7d || {};
                    const roas = p.spend > 0 ? (p.conversionValue / p.spend) : 0;
                    const cpa = p.conversions > 0 ? (p.spend / p.conversions) : null;
                    const ctr = p.impressions > 0 ? ((p.clicks / p.impressions) * 100) : null;
                    return (
                      <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}22`, background: i % 2 === 0 ? "transparent" : "#F0F7FC" }}>
                        <td style={{ padding: "10px 8px", fontWeight: 600, color: C.text, whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                          <div>{c.campaign_name}</div>
                          <div style={{ fontSize: 11, color: C.text3 }}>{c.target_area} {c.campaign_type && `- ${c.campaign_type}`}</div>
                        </td>
                        <td style={{ padding: "10px 8px" }}><StatusBadge status={c.status} /></td>
                        <td style={{ padding: "10px 8px", textAlign: "right", color: C.text2 }}>{fmtMoney(c.daily_budget_current)}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right", fontWeight: 600, color: C.text }}>{fmtMoney(p.spend)}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right", fontWeight: 600, color: C.green }}>{fmtMoney(p.conversionValue)}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right", fontWeight: 700, color: roas >= 2 ? C.green : roas >= 1 ? C.yellow : C.red }}>{roas > 0 ? roas.toFixed(1) + 'x' : '--'}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right", color: C.text2 }}>{cpa != null ? fmtMoney(cpa) : '--'}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right", fontWeight: 700, color: C.purple }}>{p.conversions || 0}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right", color: C.text2 }}>{p.clicks != null ? fmt(p.clicks) : '--'}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right", color: C.text2 }}>{ctr != null ? fmtPct(ctr) : '--'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ======= FUNNEL & ATTRIBUTION ======= */}
      {tab === "funnel" && (
        <div>
          <div className="ppc-funnel-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
            {/* Funnel */}
            <Card>
              <SectionTitle>Acquisition Funnel -- Last 30 Days</SectionTitle>
              {funnelData ? (
                <>
                  {Object.entries(funnelData.funnel || {}).filter(([, v]) => v > 0).map(([stage, count]) => (
                    <FunnelBar key={stage} label={stage.replace(/_/g, ' ')} value={count} maxValue={funnelData.totalLeads || 1}
                      color={stage === 'completed' ? C.green : stage === 'booked' ? C.cyan : stage === 'lost' ? C.red : C.blue} />
                  ))}
                  <div className="ppc-funnel-stats" style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 12, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, textAlign: "center" }}>
                    <div><div style={{ fontSize: 18, fontWeight: 800, color: C.blue }}>{fmt(funnelData.totalLeads)}</div><div style={{ fontSize: 10, color: C.text3 }}>TOTAL LEADS</div></div>
                    <div><div style={{ fontSize: 18, fontWeight: 800, color: C.green }}>{fmtMoney(funnelData.totalRevenue)}</div><div style={{ fontSize: 10, color: C.text3 }}>REVENUE</div></div>
                    <div><div style={{ fontSize: 18, fontWeight: 800, color: funnelData.roas >= 2 ? C.green : C.yellow }}>{funnelData.roas}x</div><div style={{ fontSize: 10, color: C.text3 }}>ROAS</div></div>
                  </div>
                </>
              ) : <div style={{ color: C.text3, fontSize: 13, padding: 20, textAlign: 'center' }}>No funnel data yet</div>}
            </Card>

            {/* Revenue Attribution */}
            <Card>
              <SectionTitle>Revenue Attribution by Source</SectionTitle>
              {revenueData?.sources?.length > 0 ? (
                <>
                  <DonutChart
                    size={160}
                    segments={(revenueData.sources || []).map((s, i) => ({
                      value: s.revenue,
                      color: [C.blue, C.green, C.purple, C.orange, C.cyan][i % 5],
                    }))}
                    centerValue={fmtMoney(revenueData.totalRevenue)}
                    centerLabel="Total"
                  />
                  <div style={{ marginTop: 16, display: "grid", gap: 6 }}>
                    {(revenueData.sources || []).map((s, i) => (
                      <div key={s.source} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 10, height: 10, borderRadius: 3, background: [C.blue, C.green, C.purple, C.orange, C.cyan][i % 5] }} />
                          <span style={{ fontSize: 13, color: C.text2 }}>{s.source}</span>
                        </div>
                        <div style={{ display: "flex", gap: 16 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{fmtMoney(s.revenue)}</span>
                          {s.roas && <span style={{ fontSize: 12, color: C.text3 }}>{s.roas}x ROAS</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : <div style={{ color: C.text3, fontSize: 13, padding: 20, textAlign: 'center' }}>No attribution data yet</div>}
            </Card>
          </div>

          {/* City-Level Attribution */}
          {campaigns.length > 0 && (
            <Card>
              <SectionTitle>City-Level PPC Performance (30d)</SectionTitle>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      {["City", "Campaigns", "Spend", "Conversions", "Revenue", "ROAS", "CPA"].map((h, i) => (
                        <th key={i} style={{ padding: "10px 8px", textAlign: i >= 2 ? "right" : "left", fontSize: 10, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const cityMap = {};
                      campaigns.filter(c => c.status === "active").forEach(c => {
                        const city = c.target_area || 'Other';
                        if (!cityMap[city]) cityMap[city] = { city, count: 0, spend: 0, revenue: 0, conv: 0 };
                        cityMap[city].count++;
                        cityMap[city].spend += c.last30d?.spend || 0;
                        cityMap[city].revenue += c.last30d?.conversionValue || 0;
                        cityMap[city].conv += c.last30d?.conversions || 0;
                      });
                      return Object.values(cityMap).sort((a, b) => b.revenue - a.revenue).map((row, i) => {
                        const roas = row.spend > 0 ? (row.revenue / row.spend) : 0;
                        const cpa = row.conv > 0 ? (row.spend / row.conv) : null;
                        return (
                          <tr key={row.city} style={{ borderBottom: `1px solid ${C.border}22` }}>
                            <td style={{ padding: "10px 8px", fontWeight: 600 }}>{row.city}</td>
                            <td style={{ padding: "10px 8px", color: C.text2 }}>{row.count}</td>
                            <td style={{ padding: "10px 8px", textAlign: "right" }}>{fmtMoney(row.spend)}</td>
                            <td style={{ padding: "10px 8px", textAlign: "right", fontWeight: 700, color: C.purple }}>{row.conv}</td>
                            <td style={{ padding: "10px 8px", textAlign: "right", fontWeight: 700, color: C.green }}>{fmtMoney(row.revenue)}</td>
                            <td style={{ padding: "10px 8px", textAlign: "right", fontWeight: 700, color: roas >= 2 ? C.green : roas >= 1 ? C.yellow : C.red }}>{roas > 0 ? roas.toFixed(1) + 'x' : '--'}</td>
                            <td style={{ padding: "10px 8px", textAlign: "right", color: C.text2 }}>{cpa != null ? fmtMoney(cpa) : '--'}</td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
