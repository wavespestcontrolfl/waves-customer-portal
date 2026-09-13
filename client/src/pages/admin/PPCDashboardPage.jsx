import { useState, useEffect, useMemo } from "react";
import {
  Badge,
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
function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
  }).then((r) => r.json());
}

// V2 token pass: non-semantic accents (blue/purple/orange/cyan/gold) fold to
// zinc-900; semantic green/red/yellow preserved as V2-legal variants.
// Glows collapsed to zinc-100 pastels.
const REVENUE_CHART_COLORS = [
  "#18181B", "#3F3F46", "#71717A", "#A1A1AA", "#D4D4D8",
];

// --- HELPERS ---
const fmt = (n, d = 0) =>
  n == null
    ? "--"
    : n.toLocaleString(undefined, {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
const fmtMoney = (n) =>
  n == null
    ? "--"
    : `$${n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
const fmtPct = (n) => (n == null ? "--" : `${Number(n).toFixed(1)}%`);
function MiniSparkline({ data, width = 80, height = 24 }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data
    .map(
      (v, i) =>
        `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 4) - 2}`,
    )
    .join(" ");
  const up = data[data.length - 1] >= data[0];
  const c = up ? "#18181B" : "#991B1B";
  return (
    <svg width={width} height={height} className="block">
      {" "}
      <polyline
        points={pts}
        fill="none"
        stroke={c}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />{" "}
      <circle
        cx={parseFloat(pts.split(" ").pop().split(",")[0])}
        cy={parseFloat(pts.split(" ").pop().split(",")[1])}
        r="2.5"
        fill={c}
      />{" "}
    </svg>
  );
}
function KPI({ value, label, sub, color = "#18181B", metric }) {
  return (
    <UiCard className="[padding:20px_16px] text-center relative overflow-hidden">
      {" "}
      <div
        style={{
          background: color,
        }}
        className="absolute [top:0px] [left:50%] [transform:translateX(-50%)] [width:60px] [height:3px] rounded-xs"
      />{" "}
      <div
        data-metric={metric}
        style={{
          color,
        }}
        className="text-[28px] font-medium [line-height:1.1]"
      >
        {value}
      </div>{" "}
      <div className="text-ui-body font-medium [margin-top:6px] text-ink-secondary">
        {label}
      </div>
      {sub && (
        <div className="text-ui-body [margin-top:2px] text-ink-secondary">
          {sub}
        </div>
      )}
    </UiCard>
  );
}
function SectionTitle({ children, right }) {
  return (
    <div className="flex justify-between items-center [margin-bottom:16px]">
      {" "}
      <h3 className="text-ui-body font-medium [margin:0px] text-zinc-800">
        {children}
      </h3>
      {right}
    </div>
  );
}
function Pill({ label, active, onClick }) {
  return (
    <Button onClick={onClick} variant={active ? "primary" : "secondary"}>
      {label}
    </Button>
  );
}
function StatusBadge({ status }) {
  const map = {
    active: {
      className: "!bg-green-100 !text-green-700",
      label: "Active",
    },
    paused: {
      className: "!bg-amber-100 !text-amber-700",
      label: "Paused",
    },
    winner: {
      className: "!bg-green-100 !text-green-700",
      label: "Winner",
    },
    testing: {
      className: "!bg-zinc-100 !text-zinc-900",
      label: "Testing",
    },
    losing: {
      className: "!bg-red-100 !text-red-800",
      label: "Losing",
    },
    keep: {
      className: "!bg-green-100 !text-green-700",
      label: "Keep",
    },
    watch: {
      className: "!bg-amber-100 !text-amber-700",
      label: "Watch",
    },
    negative: {
      className: "!bg-red-100 !text-red-800",
      label: "Negative",
    },
  };
  const s = map[status] || {
    className: "!bg-zinc-100 !text-zinc-700",
    label: status,
  };
  return <Badge className={s.className}>{s.label}</Badge>;
}
function QualityDots({ score }) {
  if (score == null)
    return <span className="text-ui-body text-ink-secondary">--</span>;
  const color = score >= 8 ? "#15803D" : score >= 6 ? "#A16207" : "#991B1B";
  return (
    <div className="flex items-center [gap:4px]">
      {" "}
      <span
        style={{
          color,
        }}
        className="text-ui-body font-medium"
      >
        {score}
      </span>{" "}
      <span className="text-ui-body text-ink-secondary">/10</span>{" "}
    </div>
  );
}
function FunnelBar({
  label, value, maxValue, color, prefix = "", metric, alert = false,
}) {
  const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  return (
    <div
      data-qa="metric-bar"
      className="flex items-center [gap:12px] [margin-bottom:8px]"
    >
      {" "}
      <div className="[width:80px] text-ui-body font-medium text-right shrink-0 text-ink-secondary">
        {label}
      </div>{" "}
      <div data-qa="metric-bar-track" className="[flex:1] min-w-0 [height:26px] bg-zinc-100 rounded-sm overflow-hidden relative">
        {" "}
        <div
          data-qa="metric-bar-fill"
          style={{
            width: `${pct}%`,
            background: color,
            minWidth: value > 0 ? 4 : 0,
          }}
          className="[height:100%] rounded-sm transition-all"
        />{" "}
      </div>{" "}
      <span
        data-qa="metric-bar-value"
        data-metric={metric}
        className={`w-[88px] shrink-0 break-words text-right text-ui-body font-medium ${alert ? "text-alert-fg" : "text-zinc-800"}`}
      >
        {prefix}
        {fmt(value)}
      </span>{" "}
    </div>
  );
}
function DonutChart({
  segments,
  size = 140,
  thickness = 18,
  centerLabel,
  centerValue,
  metric,
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  // Preserve the complete currency amount when it would outgrow the ring.
  const largeCenterValue = String(centerValue ?? "").length > 10;
  let cumAngle = -90;
  const paths = segments.map((seg, i) => {
    const angle = total > 0 ? (seg.value / total) * 360 : 0;
    const startRad = (cumAngle * Math.PI) / 180;
    const endRad = ((cumAngle + angle) * Math.PI) / 180;
    cumAngle += angle;
    const r = size / 2 - thickness / 2;
    const cx = size / 2,
      cy = size / 2;
    const x1 = cx + r * Math.cos(startRad),
      y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad),
      y2 = cy + r * Math.sin(endRad);
    const large = angle > 180 ? 1 : 0;
    return (
      <path
        key={i}
        d={`M${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2}`}
        fill="none"
        stroke={seg.color}
        strokeWidth={thickness}
        strokeLinecap="round"
      />
    );
  });
  return (
    <div
      style={{
        width: size,
        height: size,
      }}
      className="relative"
    >
      {" "}
      <svg width={size} height={size}>
        {paths}
      </svg>{" "}
      <div className="absolute [top:50%] [left:50%] [transform:translate(-50%,-50%)] text-center">
        {" "}
        <div
          data-qa="donut-center-value"
          data-metric={metric}
          style={{ maxWidth: size - 2 * thickness - 12 }}
          className={`${largeCenterValue ? "text-14" : "text-22"} break-words font-medium text-zinc-800`}
        >
          {centerValue}
        </div>{" "}
        <div className="text-ui-body font-medium text-ink-secondary">
          {centerLabel}
        </div>{" "}
      </div>{" "}
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
      adminFetch("/admin/ads/campaigns").catch(() => ({
        campaigns: [],
      })),
      adminFetch("/admin/ads/funnel?period=30d").catch(() => null),
      adminFetch("/admin/ads/revenue-attribution?period=month").catch(
        () => null,
      ),
    ]).then(([campRes, funnel, revenue]) => {
      setCampaigns(campRes.campaigns || []);
      setFunnelData(funnel);
      setRevenueData(revenue);
      setLoading(false);
    });
  }, []);
  const services = useMemo(() => {
    const set = new Set(
      campaigns.map((c) => c.service_category).filter(Boolean),
    );
    return ["All", ...Array.from(set).sort()];
  }, [campaigns]);
  const cities = useMemo(() => {
    const set = new Set(campaigns.map((c) => c.target_area).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [campaigns]);
  const platforms = useMemo(() => {
    const set = new Set(campaigns.map((c) => c.campaign_type).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [campaigns]);
  const filtered = useMemo(
    () =>
      campaigns.filter((c) => {
        if (serviceFilter !== "All" && c.service_category !== serviceFilter)
          return false;
        if (cityFilter !== "All" && c.target_area !== cityFilter) return false;
        if (platformFilter !== "All" && c.campaign_type !== platformFilter)
          return false;
        return true;
      }),
    [campaigns, serviceFilter, cityFilter, platformFilter],
  );
  const totals = useMemo(() => {
    const active = filtered.filter((c) => c.status === "active");
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
  const overallROAS =
    totals.spent > 0 ? (totals.revenue / totals.spent).toFixed(1) : "--";
  const overallCPL =
    totals.leads > 0 ? (totals.spent / totals.leads).toFixed(2) : "--";
  const overallCTR =
    totals.impressions > 0
      ? ((totals.clicks / totals.impressions) * 100).toFixed(1)
      : "--";

  // Service breakdown from 30-day data
  const serviceBreakdown = useMemo(() => {
    const map = {};
    campaigns
      .filter((c) => c.status === "active")
      .forEach((c) => {
        const svc = c.service_category || "Other";
        if (!map[svc])
          map[svc] = {
            service: svc,
            spent: 0,
            revenue: 0,
            leads: 0,
          };
        map[svc].spent += c.last30d?.spend || 0;
        map[svc].revenue += c.last30d?.conversionValue || 0;
        map[svc].leads += c.last30d?.conversions || 0;
      });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [campaigns]);
  const serviceColors = {
    "Pest Control": "#18181B",
    "Lawn Care": "#3F3F46",
    Mosquito: "#71717A",
    Termite: "#52525B",
  };
  const activeCampaigns = campaigns.filter((c) => c.status === "active").length;
  if (loading) {
    return (
      <div className="[padding:60px] text-center text-ui-body text-ink-secondary">
        Loading PPC Command Center...
      </div>
    );
  }
  if (campaigns.length === 0) {
    return (
      <UiCard className="[padding:60px] text-center">
        {" "}
        <div className="text-ui-body [margin-bottom:16px]"></div>{" "}
        <div className="text-18 font-medium [margin-bottom:8px] text-zinc-900">
          No Campaigns Yet
        </div>{" "}
        <div className="text-ui-body text-ink-secondary">
          Connect your Google Ads account and add campaigns to start tracking
          PPC performance.
        </div>{" "}
      </UiCard>
    );
  }
  return (
    // AdsPage and AdminLayoutV2 provide no UiSurface, so without this the
    // migrated Button, Badge, TH and TD primitives resolve the legacy context
    // default — 11px badges and headings and legacy control sizing. Wrapped at
    // this page, the migrated unit, rather than higher.
    <UiSurface className="text-zinc-800">
      {" "}
      {/* Header */}
      <div className="[margin-bottom:24px]">
        {" "}
        <div className="ppc-header-badge flex max-sm:flex-wrap max-sm:gap-2 items-center [gap:12px] [margin-bottom:4px]">
          {" "}
          <h2 className="text-[18px] font-medium [margin:0px]">
            Waves PPC command center
          </h2>{" "}
          <Badge className="[padding:4px_12px] rounded-md text-ui-body font-medium bg-green-100 text-green-700">
            {activeCampaigns} Active Campaigns
          </Badge>{" "}
        </div>{" "}
        <div className="text-ui-body text-ink-secondary">
          Google Ads + Local Service Ads -- Live data from campaign tracker
        </div>{" "}
      </div>
      {/* Tab Switcher */}
      <div className="ppc-tab-bar flex max-sm:w-full [&_button]:shrink-0 [gap:4px] [margin-bottom:24px] bg-zinc-100 rounded-md [padding:4px] [width:fit-content] overflow-x-auto">
        {[
          {
            id: "overview",
            label: "Overview",
          },
          {
            id: "campaigns",
            label: "Campaigns",
          },
          {
            id: "funnel",
            label: "Funnel & Attribution",
          },
        ].map((t) => (
          <Button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="shrink-0 whitespace-nowrap"
            variant={tab === t.id ? "primary" : "secondary"}
          >
            {t.label}
          </Button>
        ))}
      </div>
      {/* ======= OVERVIEW ======= */}
      {tab === "overview" && (
        <div>
          {/* KPI Row */}
          <div className="ppc-kpi-grid-6 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(6,1fr)] [gap:12px] [margin-bottom:20px]">
            {" "}
            <KPI
              value={fmtMoney(totals.spent)}
              label="7-Day Spend"
              sub={`of ${fmtMoney(totals.budget)} budget`}
              color={"#18181B"}
            />{" "}
            <KPI
              value={fmtMoney(totals.revenue)}
              label="7-Day Revenue"
              sub="attributed revenue"
              color={"#18181B"}
              metric="revenue"
            />{" "}
            <KPI
              value={`${overallROAS}x`}
              label="ROAS"
              sub="return on ad spend"
              color={parseFloat(overallROAS) >= 2 ? "#18181B" : "#991B1B"}
              metric="roas"
            />{" "}
            <KPI
              value={fmt(totals.leads)}
              label="Conversions"
              sub={`${fmt(totals.clicks)} clicks`}
              color={"#18181B"}
            />{" "}
            <KPI
              value={`$${overallCPL}`}
              label="Cost Per Lead"
              sub="all campaigns"
              color={"#18181B"}
            />{" "}
            <KPI
              value={`${overallCTR}%`}
              label="Avg CTR"
              sub="search campaigns"
              color={"#18181B"}
            />{" "}
          </div>
          {/* Service Breakdown + Budget Donut */}
          <div className="ppc-two-col grid max-sm:!grid-cols-1 [grid-template-columns:1fr_300px] [gap:16px] [margin-bottom:20px]">
            {" "}
            <UiCard className="p-5">
              {" "}
              <SectionTitle>Revenue by Service Line (30d)</SectionTitle>
              {serviceBreakdown.length > 0 ? (
                serviceBreakdown.map((s) => (
                  <FunnelBar
                    key={s.service}
                    label={s.service}
                    value={s.revenue}
                    maxValue={
                      Math.max(...serviceBreakdown.map((x) => x.revenue)) * 1.1
                    }
                    color={serviceColors[s.service] || "#71717A"}
                    prefix="$"
                    metric="revenue"
                  />
                ))
              ) : (
                <div className="text-ui-body [padding:20px] text-center text-ink-secondary">
                  No revenue data yet
                </div>
              )}
              {serviceBreakdown.length > 0 && (
                <div className="[padding-top:12px] [margin-top:8px] border-t border-hairline border-zinc-200">
                  {" "}
                  <SectionTitle>Spend by Service Line</SectionTitle>
                  {serviceBreakdown.map((s) => (
                    <FunnelBar
                      key={s.service}
                      label={s.service}
                      value={s.spent}
                      maxValue={
                        Math.max(...serviceBreakdown.map((x) => x.spent)) * 1.1
                      }
                      color={serviceColors[s.service] || "#71717A"}
                      prefix="$"
                    />
                  ))}
                </div>
              )}
            </UiCard>{" "}
            <UiCard className="p-5 flex flex-col items-center justify-center">
              {" "}
              <SectionTitle>Budget Utilization (7d)</SectionTitle>{" "}
              <DonutChart
                segments={[
                  {
                    value: totals.spent,
                    color: "#18181B",
                  },
                  {
                    value: Math.max(0, totals.budget - totals.spent),
                    color: "#E4E4E7",
                  },
                ]}
                centerValue={
                  totals.budget > 0
                    ? `${((totals.spent / totals.budget) * 100).toFixed(0)}%`
                    : "--"
                }
                centerLabel="Utilized"
              />{" "}
              <div className="[margin-top:16px] text-center">
                {" "}
                <div className="text-ui-body text-ink-secondary">
                  {fmtMoney(totals.spent)} of {fmtMoney(totals.budget)}
                </div>{" "}
                <div className="text-ui-body [margin-top:4px] text-ink-secondary">
                  {fmtMoney(Math.max(0, totals.budget - totals.spent))}{" "}
                  remaining
                </div>{" "}
              </div>{" "}
            </UiCard>{" "}
          </div>
          {/* Platform Split */}
          <div className="ppc-platform-grid grid max-sm:!grid-cols-1 [grid-template-columns:1fr_1fr] [gap:16px] [margin-bottom:20px]">
            {["google_search", "google_lsa"].map((type) => {
              const label =
                type === "google_lsa"
                  ? "Local Service Ads"
                  : "Google Search Ads";
              // Sync keeps Google's channel: SEARCH, or enum 2 stored as text.
              // Retain existing manual types without treating Display/PMax as Search.
              const typeCamps = campaigns.filter(
                (c) =>
                  c.status === "active" &&
                  (c.campaign_type === type ||
                    (type === "google_search" &&
                      c.platform === "google_ads" &&
                      ["SEARCH", "2"].includes(c.campaign_type))),
              );
              const sp = typeCamps.reduce(
                (s, c) => s + (c.last30d?.spend || 0),
                0,
              );
              const rv = typeCamps.reduce(
                (s, c) => s + (c.last30d?.conversionValue || 0),
                0,
              );
              const ld = typeCamps.reduce(
                (s, c) => s + (c.last30d?.conversions || 0),
                0,
              );
              return (
                <UiCard key={type} data-qa={`platform-${type}`} className="p-5">
                  {" "}
                  <SectionTitle>{label}</SectionTitle>{" "}
                  <div className="ppc-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,1fr)] [gap:12px]">
                    {" "}
                    <div>
                      <div className="text-22 font-medium text-zinc-900">
                        {fmtMoney(sp)}
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        SPEND
                      </div>
                    </div>{" "}
                    <div>
                      <div
                        data-metric="revenue"
                        className="text-22 font-medium text-zinc-900"
                      >
                        {fmtMoney(rv)}
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        REVENUE
                      </div>
                    </div>{" "}
                    <div>
                      <div className="text-22 font-medium text-zinc-900">
                        {ld}
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        CONVERSIONS
                      </div>
                    </div>{" "}
                    <div>
                      <div data-metric="roas" className="text-22 font-medium text-zinc-900">
                        {sp > 0 ? (rv / sp).toFixed(1) + "x" : "--"}
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        ROAS
                      </div>
                    </div>{" "}
                  </div>{" "}
                </UiCard>
              );
            })}
          </div>{" "}
        </div>
      )}
      {/* ======= CAMPAIGNS ======= */}
      {tab === "campaigns" && (
        <div>
          {/* Filters */}
          <UiCard className="p-5 [margin-bottom:20px]">
            {" "}
            <div className="ppc-filter-wrap flex max-sm:flex-col max-sm:gap-2 max-sm:[&>div]:flex-wrap [gap:24px] flex-wrap">
              {" "}
              <div className="flex [gap:6px] items-center">
                {" "}
                <span className="text-ui-body font-medium text-ink-secondary">
                  Service:
                </span>
                {services.map((s) => (
                  <Pill
                    key={s}
                    label={s}
                    active={serviceFilter === s}
                    onClick={() => setServiceFilter(s)}
                  />
                ))}
              </div>{" "}
              <div className="flex [gap:6px] items-center">
                {" "}
                <span className="text-ui-body font-medium text-ink-secondary">
                  City:
                </span>
                {cities.map((c) => (
                  <Pill
                    key={c}
                    label={c}
                    active={cityFilter === c}
                    onClick={() => setCityFilter(c)}
                  />
                ))}
              </div>
              {platforms.length > 2 && (
                <div className="flex [gap:6px] items-center">
                  {" "}
                  <span className="text-ui-body font-medium text-ink-secondary">
                    Platform:
                  </span>
                  {platforms.map((p) => (
                    <Pill
                      key={p}
                      label={p}
                      active={platformFilter === p}
                      onClick={() => setPlatformFilter(p)}
                    />
                  ))}
                </div>
              )}
            </div>{" "}
          </UiCard>
          {/* Campaign Table */}
          <UiCard className="p-5">
            {" "}
            <SectionTitle
              right={
                <span className="text-ui-body text-ink-secondary">
                  {filtered.length} campaigns
                </span>
              }
            >
              Campaign Performance
            </SectionTitle>{" "}
            <div className="overflow-x-auto">
              {" "}
              <Table className="[width:100%] [border-collapse:collapse] text-ui-body">
                <THead>
                  <TR className="border-b border-hairline border-zinc-200">
                    {[
                      "Campaign",
                      "Status",
                      "Budget/Day",
                      "7d Spend",
                      "7d Revenue",
                      "ROAS",
                      "CPA",
                      "Conv",
                      "Clicks",
                      "CTR",
                    ].map((h, i) => (
                      <TH
                        key={i}
                        style={{
                          textAlign: i >= 2 ? "right" : "left",
                        }}
                        className="[padding:10px_8px] text-ui-body font-medium whitespace-nowrap text-ink-secondary"
                      >
                        {h}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {filtered.map((c, i) => {
                    const p = c.last7d || {};
                    const roas = p.spend > 0 ? p.conversionValue / p.spend : 0;
                    const cpa =
                      p.conversions > 0 ? p.spend / p.conversions : null;
                    const ctr =
                      p.impressions > 0
                        ? (p.clicks / p.impressions) * 100
                        : null;
                    return (
                      <TR
                        key={c.id}
                        style={{
                          background: i % 2 === 0 ? "transparent" : "#F0F7FC",
                        }}
                        className="border-b border-hairline border-zinc-200"
                      >
                        <TD className="[padding:10px_8px] font-medium whitespace-nowrap [max-width:220px] overflow-hidden text-ellipsis text-zinc-800">
                          {" "}
                          <div>{c.campaign_name}</div>{" "}
                          <div className="text-ui-body text-ink-secondary">
                            {c.target_area}{" "}
                            {c.campaign_type && `- ${c.campaign_type}`}
                          </div>{" "}
                        </TD>
                        <TD className="[padding:10px_8px]">
                          <StatusBadge status={c.status} />
                        </TD>
                        <TD className="[padding:10px_8px] text-right text-ink-secondary">
                          {fmtMoney(c.daily_budget_current)}
                        </TD>
                        <TD className="[padding:10px_8px] text-right font-medium text-zinc-800">
                          {fmtMoney(p.spend)}
                        </TD>
                        <TD
                          data-metric="revenue"
                          className="[padding:10px_8px] text-right font-medium text-zinc-800"
                        >
                          {fmtMoney(p.conversionValue)}
                        </TD>
                        <TD
                          style={{
                            color:
                              roas >= 2
                                ? "#18181B"
                                : roas >= 1
                                  ? "#A16207"
                                  : "#991B1B",
                          }}
                          data-metric="roas"
                          className="[padding:10px_8px] text-right font-medium"
                        >
                          {roas > 0 ? roas.toFixed(1) + "x" : "--"}
                        </TD>
                        <TD className="[padding:10px_8px] text-right text-ink-secondary">
                          {cpa != null ? fmtMoney(cpa) : "--"}
                        </TD>
                        <TD className="[padding:10px_8px] text-right font-medium text-zinc-900">
                          {p.conversions || 0}
                        </TD>
                        <TD className="[padding:10px_8px] text-right text-ink-secondary">
                          {p.clicks != null ? fmt(p.clicks) : "--"}
                        </TD>
                        <TD className="[padding:10px_8px] text-right text-ink-secondary">
                          {ctr != null ? fmtPct(ctr) : "--"}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>{" "}
            </div>{" "}
          </UiCard>{" "}
        </div>
      )}
      {/* ======= FUNNEL & ATTRIBUTION ======= */}
      {tab === "funnel" && (
        <div>
          {" "}
          <div className="ppc-funnel-grid grid max-sm:!grid-cols-1 [grid-template-columns:1fr_1fr] [gap:16px] [margin-bottom:20px]">
            {/* Funnel */}
            <UiCard className="p-5">
              {" "}
              <SectionTitle>Acquisition Funnel -- Last 30 Days</SectionTitle>
              {funnelData ? (
                <>
                  {Object.entries(funnelData.funnel || {})
                    .filter(([, v]) => v > 0)
                    .map(([stage, count]) => (
                      <FunnelBar
                        key={stage}
                        label={stage.replace(/_/g, " ")}
                        value={count}
                        maxValue={funnelData.totalLeads || 1}
                        color={stage === "lost" ? "#C8312F" : "#71717A"}
                        alert={stage === "lost"}
                      />
                    ))}
                  <div className="ppc-funnel-stats max-sm:!grid-cols-3 [padding-top:12px] [margin-top:12px] grid [grid-template-columns:repeat(3,1fr)] [gap:12px] text-center border-t border-hairline border-zinc-200">
                    {" "}
                    <div>
                      <div className="text-18 font-medium text-zinc-900">
                        {fmt(funnelData.totalLeads)}
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        TOTAL LEADS
                      </div>
                    </div>{" "}
                    <div>
                      <div
                        data-metric="revenue"
                        className="text-18 font-medium text-zinc-900"
                      >
                        {fmtMoney(funnelData.totalRevenue)}
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        REVENUE
                      </div>
                    </div>{" "}
                    <div>
                      <div
                        style={{
                          color: funnelData.roas >= 2 ? "#18181B" : "#A16207",
                        }}
                        data-metric="roas"
                        className="text-18 font-medium"
                      >
                        {funnelData.roas}x
                      </div>
                      <div className="text-ui-body text-ink-secondary">
                        ROAS
                      </div>
                    </div>{" "}
                  </div>{" "}
                </>
              ) : (
                <div className="text-ui-body [padding:20px] text-center text-ink-secondary">
                  No funnel data yet
                </div>
              )}
            </UiCard>
            {/* Revenue Attribution */}
            <UiCard className="p-5">
              {" "}
              <SectionTitle>Revenue Attribution by Source</SectionTitle>
              {revenueData?.sources?.length > 0 ? (
                <>
                  {" "}
                  <DonutChart
                    size={160}
                    segments={(revenueData.sources || []).map((s, i) => ({
                      value: s.revenue,
                      color:
                        REVENUE_CHART_COLORS[
                          i % REVENUE_CHART_COLORS.length
                        ],
                    }))}
                    centerValue={fmtMoney(revenueData.totalRevenue)}
                    centerLabel="Total"
                    metric="revenue"
                  />{" "}
                  <div className="[margin-top:16px] grid [gap:6px]">
                    {(revenueData.sources || []).map((s, i) => (
                      <div
                        key={s.source}
                        className="flex items-center justify-between"
                      >
                        {" "}
                        <div className="flex items-center [gap:8px]">
                          {" "}
                          <span
                            style={{
                              background:
                                REVENUE_CHART_COLORS[
                                  i % REVENUE_CHART_COLORS.length
                                ],
                            }}
                            className="[width:10px] [height:10px] rounded-xs"
                          />{" "}
                          <span className="text-ui-body text-ink-secondary">
                            {s.source}
                          </span>{" "}
                        </div>{" "}
                        <div className="flex [gap:16px]">
                          {" "}
                          <span
                            data-metric="revenue"
                            className="text-ui-body font-medium text-zinc-800"
                          >
                            {fmtMoney(s.revenue)}
                          </span>
                          {s.roas && (
                            <span
                              data-metric="roas"
                              className="text-ui-body text-ink-secondary"
                            >
                              {s.roas}x ROAS
                            </span>
                          )}
                        </div>{" "}
                      </div>
                    ))}
                  </div>{" "}
                </>
              ) : (
                <div className="text-ui-body [padding:20px] text-center text-ink-secondary">
                  No attribution data yet
                </div>
              )}
            </UiCard>{" "}
          </div>
          {/* City-Level Attribution */}
          {campaigns.length > 0 && (
            <UiCard className="p-5">
              {" "}
              <SectionTitle>City-Level PPC Performance (30d)</SectionTitle>{" "}
              <div className="overflow-x-auto">
                {" "}
                <Table className="[width:100%] [border-collapse:collapse] text-ui-body">
                  <THead>
                    <TR className="border-b border-hairline border-zinc-200">
                      {[
                        "City",
                        "Campaigns",
                        "Spend",
                        "Conversions",
                        "Revenue",
                        "ROAS",
                        "CPA",
                      ].map((h, i) => (
                        <TH
                          key={i}
                          style={{
                            textAlign: i >= 2 ? "right" : "left",
                          }}
                          className="[padding:10px_8px] text-ui-body font-medium text-ink-secondary"
                        >
                          {h}
                        </TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {(() => {
                      const cityMap = {};
                      campaigns
                        .filter((c) => c.status === "active")
                        .forEach((c) => {
                          const city = c.target_area || "Other";
                          if (!cityMap[city])
                            cityMap[city] = {
                              city,
                              count: 0,
                              spend: 0,
                              revenue: 0,
                              conv: 0,
                            };
                          cityMap[city].count++;
                          cityMap[city].spend += c.last30d?.spend || 0;
                          cityMap[city].revenue +=
                            c.last30d?.conversionValue || 0;
                          cityMap[city].conv += c.last30d?.conversions || 0;
                        });
                      return Object.values(cityMap)
                        .sort((a, b) => b.revenue - a.revenue)
                        .map((row, i) => {
                          const roas =
                            row.spend > 0 ? row.revenue / row.spend : 0;
                          const cpa =
                            row.conv > 0 ? row.spend / row.conv : null;
                          return (
                            <TR
                              key={row.city}
                              className="border-b border-hairline border-zinc-200"
                            >
                              <TD className="[padding:10px_8px] font-medium">
                                {row.city}
                              </TD>
                              <TD className="[padding:10px_8px] text-ink-secondary">
                                {row.count}
                              </TD>
                              <TD className="[padding:10px_8px] text-right">
                                {fmtMoney(row.spend)}
                              </TD>
                              <TD className="[padding:10px_8px] text-right font-medium text-zinc-900">
                                {row.conv}
                              </TD>
                              <TD
                                data-metric="revenue"
                                className="[padding:10px_8px] text-right font-medium text-zinc-900"
                              >
                                {fmtMoney(row.revenue)}
                              </TD>
                              <TD
                                style={{
                                  color:
                                    roas >= 2
                                      ? "#18181B"
                                      : roas >= 1
                                        ? "#A16207"
                                        : "#991B1B",
                                }}
                                data-metric="roas"
                                className="[padding:10px_8px] text-right font-medium"
                              >
                                {roas > 0 ? roas.toFixed(1) + "x" : "--"}
                              </TD>
                              <TD className="[padding:10px_8px] text-right text-ink-secondary">
                                {cpa != null ? fmtMoney(cpa) : "--"}
                              </TD>
                            </TR>
                          );
                        });
                    })()}
                  </TBody>
                </Table>{" "}
              </div>{" "}
            </UiCard>
          )}
        </div>
      )}
    </UiSurface>
  );
}
