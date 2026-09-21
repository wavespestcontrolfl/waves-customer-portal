import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  BarChart3,
  CalendarRange,
  Layers,
  Megaphone,
  PhoneCall,
  Sparkles,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  Badge as UiBadge,
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
import { etDateString } from "../../lib/timezone";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
const PPCDashboardPage = lazy(() => import("./PPCDashboardPage"));
const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: `teal` folded to zinc-900, `purple`/`orange` fold too.
// Semantic green/amber/red preserved for status/alert accents.

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
  }).then((r) => r.json());
}
function adminPost(path, body) {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}
function fmt(n) {
  return (
    "$" +
    Number(n || 0).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
  );
}
function fmtDec(n) {
  return (
    "$" +
    Number(n || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function pct(n) {
  return (Number(n) || 0).toFixed(1) + "%";
}
const TABS = [
  {
    key: "ppc-dashboard",
    label: "PPC Dashboard",
    Icon: Megaphone,
  },
  {
    key: "overview",
    label: "Overview",
    Icon: BarChart3,
  },
  {
    key: "call-bridge",
    label: "Call Bridge",
    Icon: PhoneCall,
  },
  {
    key: "service-lines",
    label: "Service Lines",
    Icon: Layers,
  },
  {
    key: "advisor",
    label: "AI Advisor",
    Icon: Sparkles,
  },
  {
    key: "capacity",
    label: "Capacity",
    Icon: CalendarRange,
  },
];
const UI_TABS = TABS.map((item) => ({
  ...item,
  className: "!h-11 !min-h-11 !text-14 !normal-case !tracking-normal",
}));
function KpiCard({ label, value, sub, color }) {
  return (
    <UiCard className="[padding:20px] flex flex-col [gap:4px]">
      {" "}
      <div className="text-ui-body text-ink-secondary font-medium">
        {label}
      </div>{" "}
      <div
        style={{
          color: color || "#09090B",
        }}
        className="text-[24px] font-medium"
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            color: sub.color || "#71717A",
          }}
          className="text-ui-body"
        >
          {sub.text}
        </div>
      )}
    </UiCard>
  );
}
function Badge({ mode }) {
  const modeClasses = {
    base: "!bg-green-100 !text-green-700",
    spent: "!bg-amber-100 !text-amber-700",
    stop: "!bg-red-100 !text-red-800",
  };
  const labels = {
    base: "Base",
    spent: "Spent",
    stop: "Stop",
  };
  return (
    <UiBadge tone="neutral" className={modeClasses[mode]}>
      {labels[mode] || mode}
    </UiBadge>
  );
}
function roasColor(roas) {
  if (roas >= 4) return "#15803D";
  if (roas >= 2) return "#A16207";
  return "#991B1B";
}
function fmtInt(n) {
  return Number(n || 0).toLocaleString();
}
function secondsLabel(value) {
  const seconds = Number(value || 0);
  if (!seconds) return "—";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
function bridgeStatusTone(status) {
  if (status === "ready" || status === "already_bridged") return "#15803D";
  if (status === "ambiguous") return "#A16207";
  return "#71717A";
}
function bridgeStatusLabel(status) {
  const labels = {
    ready: "Ready",
    already_bridged: "Bridged",
    ambiguous: "Review",
    unmatched: "Unmatched",
  };
  return labels[status] || "Unknown";
}
function bridgeDisplayStatus(match) {
  if (
    match?.status === "already_bridged" &&
    match.callLog?.googleAdsLeadMatched === false
  ) {
    return "Needs Lead";
  }
  return bridgeStatusLabel(match?.status);
}
function bridgeDisplayTone(match) {
  if (
    match?.status === "already_bridged" &&
    match.callLog?.googleAdsLeadMatched === false
  ) {
    return "#A16207";
  }
  return bridgeStatusTone(match?.status);
}

// =========================================================================
// OVERVIEW TAB
// =========================================================================
function OverviewTab() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/ads/campaigns")
      .then((d) => {
        setCampaigns(d.campaigns || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading campaigns...
      </div>
    );
  if (campaigns.length === 0) return <EmptyState />;
  const total7 = campaigns.reduce(
    (s, c) => ({
      spend: s.spend + (c.last7d?.spend || 0),
      value: s.value + (c.last7d?.conversionValue || 0),
      conv: s.conv + (c.last7d?.conversions || 0),
      clicks: s.clicks + (c.last7d?.clicks || 0),
    }),
    {
      spend: 0,
      value: 0,
      conv: 0,
      clicks: 0,
    },
  );
  return (
    <div className="flex flex-col [gap:20px]">
      {" "}
      <div className="ads-kpi-grid grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:14px]">
        {" "}
        <KpiCard label="7-Day Ad Spend" value={fmt(total7.spend)} />{" "}
        <KpiCard
          label="7-Day Revenue"
          value={fmt(total7.value)}
          color={"#15803D"}
        />{" "}
        <KpiCard
          label="Blended ROAS"
          value={
            total7.spend > 0
              ? (total7.value / total7.spend).toFixed(1) + "x"
              : "—"
          }
          color={
            total7.spend > 0
              ? roasColor(total7.value / total7.spend)
              : "#71717A"
          }
        />{" "}
        <KpiCard
          label="Conversions"
          value={total7.conv.toFixed(0)}
          sub={{
            text: `${total7.clicks} clicks`,
            color: "#71717A",
          }}
        />{" "}
      </div>{" "}
      <UiCard className="p-6">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
          Campaign Performance
        </div>{" "}
        <div className="overflow-x-auto">
          {" "}
          <Table className="[width:100%] [border-collapse:collapse]">
            <THead>
              <TR>
                <TH>Campaign</TH>
                <TH className="text-right u-nums">Mode</TH>
                <TH className="text-right u-nums">Budget</TH>
                <TH className="text-right u-nums">7d Spend</TH>
                <TH className="text-right u-nums">7d Revenue</TH>
                <TH className="text-right u-nums">ROAS</TH>
                <TH className="text-right u-nums">CPA</TH>
                <TH className="text-right u-nums">Conv</TH>
                <TH className="text-right u-nums">Trend</TH>
              </TR>
            </THead>
            <TBody>
              {campaigns.map((c) => {
                const p = c.last7d || {};
                const trendIcon =
                  c.last7d?.roas > (c.last30d?.roas || 0) * 1.05
                    ? ""
                    : c.last7d?.roas < (c.last30d?.roas || 0) * 0.8
                      ? ""
                      : "";
                return (
                  <TR key={c.id}>
                    <TD>
                      {" "}
                      <div>{c.campaign_name}</div>{" "}
                      <div className="text-ui-body text-ink-secondary">
                        {c.target_area} • {c.campaign_type}
                      </div>{" "}
                    </TD>
                    <TD className="text-right u-nums">
                      <Badge mode={c.budget_mode} />
                    </TD>
                    <TD className="text-right u-nums">
                      {fmtDec(c.daily_budget_current)}/d
                    </TD>
                    <TD className="text-right u-nums">{fmtDec(p.spend)}</TD>
                    <TD className="text-right u-nums">
                      {fmtDec(p.conversionValue)}
                    </TD>
                    <TD
                      style={{
                        color: roasColor(p.roas),
                      }}
                      className="text-right u-nums"
                    >
                      {p.roas ? p.roas + "x" : "—"}
                    </TD>
                    <TD className="text-right u-nums">
                      {p.cpa ? fmtDec(p.cpa) : "—"}
                    </TD>
                    <TD className="text-right u-nums">{p.conversions || 0}</TD>
                    <TD className="text-right u-nums text-ui-body">
                      {trendIcon}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>{" "}
        </div>{" "}
      </UiCard>{" "}
    </div>
  );
}
function EmptyState() {
  return (
    <UiCard className="text-center [padding:60px]">
      {" "}
      <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:8px]">
        No Campaigns Yet
      </div>{" "}
      <div className="text-ui-body text-ink-secondary [max-width:400px] [margin:0_auto]">
        Connect your Google Ads account to start tracking campaign performance,
        service-line attribution, and get daily AI-powered recommendations.
      </div>{" "}
    </UiCard>
  );
}

// =========================================================================
// CALL BRIDGE TAB
// =========================================================================
function CallBridgeTab() {
  const [data, setData] = useState(null);
  const [period, setPeriod] = useState("30d");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState(null);
  const load = () => {
    setLoading(true);
    setMessage(null);
    adminFetch(`/admin/ads/call-bridge?period=${period}`)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setMessage({
          tone: "#991B1B",
          text: e.message || "Bridge preview failed",
        });
        setLoading(false);
      });
  };
  useEffect(() => {
    load();
  }, [period]);
  const applyBridge = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const result = await adminPost("/admin/ads/call-bridge/apply", {
        period,
        limit: 200,
      });
      setData(result);
      setMessage({
        tone: result.appliedCount > 0 ? "#15803D" : "#A16207",
        text: `${fmtInt(result.appliedCount || 0)} bridge update${Number(result.appliedCount || 0) === 1 ? "" : "s"} applied`,
      });
    } catch (e) {
      setMessage({
        tone: "#991B1B",
        text: e.message || "Bridge apply failed",
      });
    } finally {
      setApplying(false);
    }
  };
  if (loading) {
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading call bridge...
      </div>
    );
  }
  const summary = data?.summary || {};
  const matches = data?.matches || [];
  const readyCount = Number(summary.ready || 0);
  const leadRetryCount = matches.filter(
    (match) =>
      match.status === "already_bridged" &&
      !!match.callLog &&
      match.callLog.googleAdsLeadMatched === false,
  ).length;
  const configured = data?.configured !== false;
  const scanFailed = data?.scanFailed === true;
  const targetNumber = data?.targetNumber?.formatted || "(941) 318-7612";
  // A healthy scan with NOTHING to apply is still submittable (codex P1,
  // ambiguity-record r4 GH round): applying a clean preview records and
  // RESOLVES persisted ambiguity records — the only way a 31–90-day scan
  // can clear an old record the daily cron's window never reaches. The
  // server treats an empty apply as a no-op plus that bookkeeping.
  const canApply = configured && !scanFailed && !applying;
  const applyLabel = applying
    ? "Applying..."
    : readyCount > 0 && leadRetryCount > 0
      ? "Apply ready + retry leads"
      : leadRetryCount > 0
        ? "Retry lead attribution"
        : readyCount > 0
          ? "Apply ready matches"
          : "Record clean rescan";
  return (
    <div className="flex flex-col [gap:20px]">
      <div className="flex justify-between items-center [gap:12px] flex-wrap">
        <div>
          <div className="text-ui-body text-ink-secondary">
            Google Ads call reporting bridge
          </div>
          <div className="text-ui-body text-zinc-900 [margin-top:4px]">
            Main call asset: <span>{targetNumber}</span>
          </div>
        </div>
        <div className="flex [gap:8px] items-center flex-wrap">
          <div className="flex [gap:4px] bg-zinc-100 rounded-md [padding:3px]">
            {["7d", "30d", "90d"].map((p) => (
              <Button
                key={p}
                onClick={() => setPeriod(p)}
                variant={period === p ? "primary" : "secondary"}
              >
                {p}
              </Button>
            ))}
          </div>
          <Button onClick={load} variant="secondary">
            Preview
          </Button>
          <Button
            onClick={applyBridge}
            disabled={!canApply}
            variant={canApply ? "primary" : "secondary"}
          >
            {applyLabel}
          </Button>
        </div>
      </div>

      {!configured && (
        <UiCard className="[padding:16px] text-zinc-700">
          <div className="text-zinc-700 text-ui-body font-medium">
            Google Ads API is not configured in this environment.
          </div>
        </UiCard>
      )}

      {message && (
        <UiCard className="[padding:16px]">
          <div
            style={{
              color: message.tone,
            }}
            className="text-ui-body font-medium"
          >
            {message.text}
          </div>
        </UiCard>
      )}

      <div className="grid [grid-template-columns:repeat(auto-fit,_minmax(170px,_1fr))] [gap:14px]">
        <KpiCard label="Google Calls" value={fmtInt(summary.googleCalls)} />
        <KpiCard
          label="Ready Matches"
          value={fmtInt(summary.ready)}
          color={"#15803D"}
        />
        <KpiCard
          label="Already Bridged"
          value={fmtInt(summary.alreadyBridged)}
          sub={
            leadRetryCount > 0
              ? {
                  text: `${fmtInt(leadRetryCount)} lead retries`,
                  color: "#A16207",
                }
              : null
          }
        />
        <KpiCard
          label="Main-Line CRM Calls"
          value={fmtInt(summary.crmMainLineCalls)}
        />
      </div>

      <UiCard className="p-6">
        <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
          Bridge Queue
        </div>
        {matches.length === 0 ? (
          <div className="text-ink-secondary text-ui-body">
            No Google Ads call rows returned for this period.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="[width:100%] [border-collapse:collapse]">
              <THead>
                <TR>
                  <TH>Google Call</TH>
                  <TH>Campaign</TH>
                  <TH>CRM Call</TH>
                  <TH className="text-right u-nums">Confidence</TH>
                  <TH className="text-right u-nums">Status</TH>
                </TR>
              </THead>
              <TBody>
                {matches.slice(0, 50).map((match, i) => (
                  <TR key={match.googleCall?.resourceName || i}>
                    <TD>
                      <div>{match.googleCall?.startLabel || "Unknown"}</div>
                      <div className="text-ink-secondary text-ui-body">
                        {secondsLabel(match.googleCall?.durationSeconds)} · area{" "}
                        {match.googleCall?.callerAreaCode || "—"}
                      </div>
                    </TD>
                    <TD>
                      <div>{match.googleCall?.campaignName || "—"}</div>
                      <div className="text-ink-secondary text-ui-body">
                        {match.googleCall?.adGroupName || "—"}
                      </div>
                    </TD>
                    <TD>
                      {match.callLog ? (
                        <>
                          <div>
                            {match.callLog.fromPhone || "Unknown caller"}
                          </div>
                          <div className="text-ink-secondary text-ui-body">
                            {match.callLog.customerName ||
                              match.callLog.leadSourceName ||
                              match.callLog.status ||
                              "CRM call"}
                          </div>
                        </>
                      ) : (
                        <span className="text-ink-secondary">No CRM match</span>
                      )}
                    </TD>
                    <TD
                      style={{
                        color: bridgeDisplayTone(match),
                      }}
                      className="text-right u-nums font-medium"
                    >
                      {fmtInt(match.confidence)}%
                    </TD>
                    <TD
                      style={{
                        color: bridgeDisplayTone(match),
                      }}
                      className="text-right u-nums font-medium"
                    >
                      {bridgeDisplayStatus(match)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </UiCard>

      <UiCard className="p-6">
        <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
          Recent {targetNumber} Calls
        </div>
        {(data?.recentMainLineCalls || []).length === 0 ? (
          <div className="text-ink-secondary text-ui-body">
            No recent main-line calls in this period.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="[width:100%] [border-collapse:collapse]">
              <THead>
                <TR>
                  <TH>Caller</TH>
                  <TH>Customer</TH>
                  <TH className="text-right u-nums">Duration</TH>
                  <TH className="text-right u-nums">Source</TH>
                </TR>
              </THead>
              <TBody>
                {(data?.recentMainLineCalls || []).slice(0, 20).map((call) => (
                  <TR key={call.id}>
                    <TD>{call.fromPhone || "Unknown"}</TD>
                    <TD>{call.customerName || "—"}</TD>
                    <TD className="text-right u-nums">
                      {secondsLabel(call.durationSeconds)}
                    </TD>
                    <TD
                      style={{
                        color:
                          call.source === "google_ads" ? "#15803D" : "#71717A",
                      }}
                      className="text-right u-nums"
                    >
                      {call.source || "unattributed"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </UiCard>
    </div>
  );
}

// =========================================================================
// SERVICE LINES TAB
// =========================================================================
function ServiceLinesTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("30d");
  useEffect(() => {
    setLoading(true);
    adminFetch(`/admin/ads/service-lines?period=${period}`)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period]);
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading service-line data...
      </div>
    );
  if (!data || data.totalLeads === 0)
    return (
      <UiCard className="text-center [padding:40px]">
        <div className="text-ink-secondary">
          No attribution data yet. Leads will appear here as they come in
          through your ad campaigns.
        </div>
      </UiCard>
    );
  const bucketIcons = {
    recurring: "",
    one_time_entry: "",
    high_ticket_specialty: "",
    lawn_seasonal: "",
  };
  const bucketLabels = {
    recurring: "RECURRING PROGRAMS",
    one_time_entry: "ONE-TIME ENTRY",
    high_ticket_specialty: "HIGH-TICKET SPECIALTY",
    lawn_seasonal: "LAWN SEASONAL",
  };
  return (
    <div className="flex flex-col [gap:20px]">
      {" "}
      <div className="flex justify-between items-center">
        {" "}
        <div className="text-ui-body text-ink-secondary">
          Service Line Performance
        </div>{" "}
        <div className="flex [gap:4px] bg-zinc-100 rounded-md [padding:3px]">
          {["7d", "30d", "90d"].map((p) => (
            <Button
              key={p}
              onClick={() => setPeriod(p)}
              variant={period === p ? "primary" : "secondary"}
            >
              {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "90 Days"}
            </Button>
          ))}
        </div>{" "}
      </div>
      {(data.byBucket || []).map((b) => (
        <UiCard key={b.bucket} className="p-6">
          {" "}
          <div className="flex items-center [gap:8px] [margin-bottom:16px]">
            {" "}
            <span className="text-ui-body">
              {bucketIcons[b.bucket] || ""}
            </span>{" "}
            <span className="text-ui-body font-medium text-zinc-900">
              {bucketLabels[b.bucket] || b.bucket.toUpperCase()}
            </span>{" "}
          </div>{" "}
          <div className="overflow-x-auto">
            {" "}
            <Table className="[width:100%] [border-collapse:collapse]">
              <THead>
                <TR>
                  <TH>Metric</TH>
                  <TH className="text-right u-nums">Value</TH>
                  <TH>Metric</TH>
                  <TH className="text-right u-nums">Value</TH>
                </TR>
              </THead>
              <TBody>
                <TR>
                  <TD>Leads</TD>
                  <TD className="text-right u-nums">{b.leads}</TD>
                  <TD>Booked</TD>
                  <TD className="text-right u-nums">{b.booked}</TD>
                </TR>
                <TR>
                  <TD>Lead → Book %</TD>
                  <TD
                    style={{
                      color: b.leadToBookRate >= 60 ? "#15803D" : "#A16207",
                    }}
                    className="text-right u-nums"
                  >
                    {pct(b.leadToBookRate)}
                  </TD>
                  <TD>Book → Complete %</TD>
                  <TD
                    style={{
                      color: b.bookToCompleteRate >= 80 ? "#15803D" : "#A16207",
                    }}
                    className="text-right u-nums"
                  >
                    {pct(b.bookToCompleteRate)}
                  </TD>
                </TR>
                <TR>
                  <TD>Ad Spend</TD>
                  <TD className="text-right u-nums">{fmt(b.adSpend)}</TD>
                  <TD>Cost/Lead</TD>
                  <TD className="text-right u-nums">{fmtDec(b.costPerLead)}</TD>
                </TR>
                <TR>
                  <TD>Cost/Booked Job</TD>
                  <TD className="text-right u-nums">
                    {fmtDec(b.costPerBookedJob)}
                  </TD>
                  <TD>Completed Revenue</TD>
                  <TD className="text-right u-nums text-zinc-900">
                    {fmt(b.completedRevenue)}
                  </TD>
                </TR>
                <TR>
                  <TD>ROAS</TD>
                  <TD
                    style={{
                      color: roasColor(b.roas),
                    }}
                    className="text-right u-nums font-medium"
                  >
                    {b.roas}x
                  </TD>
                  <TD>Avg Ticket</TD>
                  <TD className="text-right u-nums">{fmt(b.avgTicket)}</TD>
                </TR>
                <TR>
                  <TD>Gross Margin</TD>
                  <TD className="text-right u-nums">{pct(b.grossMargin)}</TD>
                  <TD>{b.ltvToCAC != null ? "LTV:CAC" : "Proj LTV 12mo"}</TD>
                  <TD
                    style={{
                      color: (b.ltvToCAC || 0) >= 10 ? "#15803D" : "#A16207",
                    }}
                    className="text-right u-nums"
                  >
                    {b.ltvToCAC != null
                      ? b.ltvToCAC + "x"
                      : fmt(b.projectedLTV12mo)}
                  </TD>
                </TR>
              </TBody>
            </Table>{" "}
          </div>
          {b.verdict && (
            <div
              style={{
                borderLeft: `3px solid ${b.roas >= 3 ? "#15803D" : b.roas >= 1.5 ? "#A16207" : "#991B1B"}`,
              }}
              className="[margin-top:12px] [padding:10px_14px] bg-zinc-100 rounded-md text-ui-body text-zinc-900"
            >
              {b.verdict}
            </div>
          )}
          {b.services?.length > 0 && (
            <div className="[margin-top:10px] text-ui-body text-ink-secondary">
              Services: {b.services.join(", ")}
            </div>
          )}
        </UiCard>
      ))}
      {/* Per-service table */}
      <UiCard className="p-6">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
          Per-Service Breakdown
        </div>{" "}
        <div className="overflow-x-auto">
          {" "}
          <Table className="[width:100%] [border-collapse:collapse]">
            <THead>
              <TR>
                <TH>Service</TH>
                <TH className="text-right u-nums">Leads</TH>
                <TH className="text-right u-nums">Booked</TH>
                <TH className="text-right u-nums">Close %</TH>
                <TH className="text-right u-nums">Spend</TH>
                <TH className="text-right u-nums">CPA</TH>
                <TH className="text-right u-nums">Ticket</TH>
                <TH className="text-right u-nums">ROAS</TH>
                <TH className="text-right u-nums">LTV ROAS</TH>
                <TH className="text-right u-nums">Margin</TH>
              </TR>
            </THead>
            <TBody>
              {(data.bySpecificService || []).map((s, i) => (
                <TR key={i}>
                  <TD>{s.service}</TD>
                  <TD className="text-right u-nums">{s.leads}</TD>
                  <TD className="text-right u-nums">{s.booked}</TD>
                  <TD
                    style={{
                      color: s.closeRate >= 60 ? "#15803D" : "#A16207",
                    }}
                    className="text-right u-nums"
                  >
                    {pct(s.closeRate)}
                  </TD>
                  <TD className="text-right u-nums">{fmt(s.adSpend)}</TD>
                  <TD className="text-right u-nums">
                    {s.cpa ? fmtDec(s.cpa) : "—"}
                  </TD>
                  <TD className="text-right u-nums">
                    {s.avgTicket ? fmt(s.avgTicket) : "—"}
                  </TD>
                  <TD
                    style={{
                      color: roasColor(s.roas),
                    }}
                    className="text-right u-nums"
                  >
                    {s.roas ? s.roas + "x" : "—"}
                  </TD>
                  <TD
                    style={{
                      color: s.ltvROAS ? "#18181B" : "#71717A",
                    }}
                    className="text-right u-nums"
                  >
                    {s.ltvROAS ? s.ltvROAS + "x" : "—"}
                  </TD>
                  <TD className="text-right u-nums">
                    {s.margin != null ? s.margin + "%" : "—"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>{" "}
        </div>{" "}
        <div className="[margin-top:12px] text-ui-body text-ink-secondary flex [gap:16px]">
          {" "}
          <span>ROAS = immediate return</span>{" "}
          <span className="text-zinc-900">
            LTV ROAS = 12-month projected return (recurring services)
          </span>{" "}
        </div>{" "}
      </UiCard>{" "}
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
      adminFetch("/admin/ads/advisor"),
      adminFetch("/admin/ads/advisor/history"),
    ])
      .then(([r, h]) => {
        setReport(r.report);
        setHistory(h.reports || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Apply state belongs to ONE report: regenerating replaces the rec list, so
  // stale positional state (or a late response from the old report's apply)
  // must never mark the new report's recommendations as applied. The counter
  // invalidates in-flight applies; the reset clears rendered state.
  const reportGenRef = useRef(0);
  const handleGenerate = async () => {
    setGenerating(true);
    // Invalidate the OLD report's apply state when generation STARTS, not
    // when it finishes — the AI request is slow, and an apply clicked during
    // it would capture a token that's still current, executing a live budget
    // change whose feedback the incoming report then silently discards.
    // (Apply buttons are also disabled while generating.)
    reportGenRef.current += 1;
    setApplied({});
    try {
      const r = await adminPost("/admin/ads/advisor/generate", {});
      setReport({
        report_data: r.report,
        date: etDateString(),
        grade: r.report?.grade,
      });
    } finally {
      // A failed generation must not leave every Apply button disabled until
      // a page reload — generating gates them while true.
      setGenerating(false);
    }
  };
  const handleApply = async (rec, idx) => {
    if (generating) return; // stale report — a new one is being generated
    // The button label shows the parsed value, and this confirm repeats it —
    // the server applies rec.apply_value, not whatever number the rec's prose
    // mentions, so the admin must see the actual amount before it goes live.
    const summary =
      rec.apply_action === "change_mode"
        ? `Set "${rec.campaign}" budget mode to "${rec.apply_value}"?`
        : `Set "${rec.campaign}" daily budget to $${Number(rec.apply_value)}/day?`;
    if (!window.confirm(summary)) return;
    const gen = reportGenRef.current;
    const setAppliedIfCurrent = (updater) => {
      if (reportGenRef.current === gen) setApplied(updater);
    };
    setAppliedIfCurrent((prev) => ({
      ...prev,
      [idx]: {
        status: "pending",
      },
    }));
    try {
      const res = await fetch(`${API_BASE}/admin/ads/advisor/apply`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: rec.apply_action,
          campaignId: rec.campaign_id,
          campaignName: rec.campaign,
          value: rec.apply_value,
          reason: rec.action,
        }),
      });
      const body = await res.json().catch(() => ({}));
      // Only show "Applied" when the server actually applied the change — a
      // 4xx/5xx, or an honest applied:false (couldn't resolve the campaign, no
      // concrete value, or a manual-only action), surfaces as an error instead.
      if (!res.ok || body.applied !== true) {
        setAppliedIfCurrent((prev) => ({
          ...prev,
          [idx]: {
            status: "error",
            message:
              body.error ||
              body.note ||
              "Couldn't apply automatically — adjust it manually.",
          },
        }));
        return;
      }
      setAppliedIfCurrent((prev) => ({
        ...prev,
        [idx]: {
          status: "applied",
          at: new Date().toLocaleTimeString(),
        },
      }));
    } catch {
      setAppliedIfCurrent((prev) => ({
        ...prev,
        [idx]: {
          status: "error",
          message: "Network error — not applied.",
        },
      }));
    }
  };

  // Only these advisor actions map to an automated change (setBudget/setMode);
  // everything else (add_negative, SEO/GBP/bid/keyword actions) is advisory and
  // must be done by hand — so it never gets an Apply button that could imply it
  // was executed. An auto action without a concrete value (stale pre-apply_value
  // reports, a fallback rec with no known budget) is equally un-executable —
  // its Apply click could only ever 422 — so it renders as manual too.
  const AUTO_APPLY_ACTIONS = [
    "increase_budget",
    "decrease_budget",
    "change_mode",
  ];
  const canAutoApply = (rec) => {
    if (!AUTO_APPLY_ACTIONS.includes(rec.apply_action)) return false;
    if (rec.apply_action === "change_mode")
      return ["base", "spent", "stop"].includes(rec.apply_value);
    const n = Number(rec.apply_value);
    return Number.isFinite(n) && n > 0;
  };
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading advisor report...
      </div>
    );
  const data = report?.report_data || {};
  const gradeColor = (g) => {
    if (!g) return "#71717A";
    if (g.startsWith("A")) return "#15803D";
    if (g.startsWith("B")) return "#18181B";
    if (g.startsWith("C")) return "#A16207";
    return "#991B1B";
  };
  const priorityColor = {
    high: "#991B1B",
    medium: "#A16207",
    low: "#71717A",
  };
  return (
    <div className="flex flex-col [gap:20px]">
      {/* Header */}
      <div className="flex justify-between items-center">
        {" "}
        <div className="text-ui-body text-ink-secondary">
          AI Campaign Advisor{" "}
          {report?.date
            ? `— ${new Date(report.date + "T12:00:00").toLocaleDateString(
                "en-US",
                {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                },
              )}`
            : ""}
        </div>{" "}
        <Button
          onClick={handleGenerate}
          disabled={generating}
          variant="secondary"
        >
          {generating ? "Generating..." : "Generate Report"}
        </Button>{" "}
      </div>
      {!report ? (
        <UiCard className="text-center [padding:60px]">
          {" "}
          <div className="text-ui-body [margin-bottom:16px]">AI</div>{" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:8px]">
            No Reports Yet
          </div>{" "}
          <div className="text-ui-body text-ink-secondary">
            Click "Generate Report" to run the AI advisor, or wait for the daily
            8 AM auto-run.
          </div>{" "}
        </UiCard>
      ) : (
        <>
          {/* Grade + Assessment */}
          <UiCard className="p-6">
            {" "}
            <div className="flex items-center [gap:20px]">
              {" "}
              <div
                style={{
                  background: gradeColor(data.grade) + "22",
                  color: gradeColor(data.grade),
                  border: `2px solid ${gradeColor(data.grade)}44`,
                }}
                className="[width:72px] [height:72px] rounded-md flex items-center justify-center text-ui-body font-medium"
              >
                {data.grade || "?"}
              </div>{" "}
              <div className="[flex:1]">
                {" "}
                <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
                  Overall Grade
                </div>{" "}
                <div className="text-ui-body text-zinc-900 [line-height:1.5]">
                  {data.overall_assessment}
                </div>{" "}
              </div>{" "}
            </div>{" "}
          </UiCard>
          {/* Recommendations */}
          {(data.recommendations || []).length > 0 && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
                Recommendations
              </div>{" "}
              <div className="flex flex-col [gap:12px]">
                {["high", "medium", "low"].map((priority) => {
                  const recs = (data.recommendations || []).filter(
                    (r) => r.priority === priority,
                  );
                  if (recs.length === 0) return null;
                  return (
                    <div key={priority}>
                      {" "}
                      <div
                        style={{
                          color: priorityColor[priority],
                        }}
                        className="text-ui-body font-medium [margin-bottom:8px]"
                      >
                        {priority === "high"
                          ? ""
                          : priority === "medium"
                            ? ""
                            : ""}{" "}
                        {priority} Priority
                      </div>
                      {recs.map((rec, idx) => {
                        // Identity-carrying key: positional state from a prior
                        // report must not attach to an unrelated rec that
                        // happens to land in the same slot.
                        const globalIdx = `${priority}-${idx}-${rec.campaign || ""}-${rec.apply_action || ""}`;
                        return (
                          <div
                            key={idx}
                            style={{
                              borderLeft: `3px solid ${priorityColor[priority]}`,
                            }}
                            className="[padding:14px_16px] bg-zinc-100 rounded-md [margin-bottom:8px]"
                          >
                            {" "}
                            <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
                              {rec.campaign && (
                                <span className="text-zinc-900">
                                  {rec.campaign}:{" "}
                                </span>
                              )}
                              {rec.action}
                            </div>
                            {rec.reasoning && (
                              <div className="text-ui-body text-ink-secondary [margin-bottom:6px]">
                                {rec.reasoning}
                              </div>
                            )}
                            {rec.estimated_impact && (
                              <div className="text-ui-body text-zinc-900 [margin-bottom:8px]">
                                Est. impact: {rec.estimated_impact}
                              </div>
                            )}
                            {(rec.apply_action || rec.manual_action) &&
                              (rec.apply_action && canAutoApply(rec) ? (
                                (() => {
                                  const st = applied[globalIdx];
                                  const done = st?.status === "applied";
                                  const pending = st?.status === "pending";
                                  return (
                                    <div>
                                      <Button
                                        onClick={() =>
                                          handleApply(rec, globalIdx)
                                        }
                                        disabled={done || pending || generating}
                                        variant={done ? "primary" : "secondary"}
                                      >
                                        {done
                                          ? `Applied at ${st.at}`
                                          : pending
                                            ? "Applying…"
                                            : rec.apply_action === "change_mode"
                                              ? `Apply: set mode to ${rec.apply_value}`
                                              : `Apply: ${rec.apply_action.replace(/_/g, " ")} to $${Number(rec.apply_value)}/day`}
                                      </Button>
                                      {st?.status === "error" && (
                                        <div className="text-ui-body text-alert-fg [margin-top:6px]">
                                          {st.message}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()
                              ) : (
                                <div className="text-ui-body text-ink-secondary">
                                  Manual action:{" "}
                                  {(
                                    rec.apply_action || rec.manual_action
                                  ).replace(/_/g, " ")}
                                </div>
                              ))}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>{" "}
            </UiCard>
          )}

          {/* Waste Alerts */}
          {(data.waste_alerts || []).length > 0 && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-alert-fg [margin-bottom:12px]">
                Waste Alerts
              </div>{" "}
              <div className="overflow-x-auto">
                {" "}
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>Search Term</TH>
                      <TH className="text-right u-nums">Spend</TH>
                      <TH className="text-right u-nums">Conv</TH>
                      <TH className="text-right u-nums">Action</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.waste_alerts.map((w, i) => (
                      <TR key={i}>
                        <TD>{w.search_term}</TD>
                        <TD className="text-right u-nums text-alert-fg">
                          {fmtDec(w.spend)}
                        </TD>
                        <TD className="text-right u-nums">{w.conversions}</TD>
                        <TD className="text-right u-nums">
                          <span className="text-zinc-700 text-ui-body">
                            {w.action}
                          </span>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>{" "}
              </div>{" "}
            </UiCard>
          )}

          {/* Scaling Opportunities */}
          {(data.scaling_opportunities || []).length > 0 && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                Scaling Opportunities
              </div>
              {data.scaling_opportunities.map((s, i) => (
                <div
                  key={i}
                  className="[padding:10px_14px] bg-zinc-100 rounded-md [margin-bottom:6px]"
                >
                  {" "}
                  <div className="text-ui-body text-zinc-900">
                    <strong>{s.campaign}</strong>: {fmt(s.current_budget)}/d →{" "}
                    {fmt(s.suggested_budget)}/d
                  </div>{" "}
                  <div className="text-ui-body text-ink-secondary">
                    {s.headroom_reason}
                  </div>{" "}
                </div>
              ))}
            </UiCard>
          )}

          {/* Insights */}
          {(data.insights || []).length > 0 && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                Insights
              </div>{" "}
              <div className="flex flex-col [gap:8px]">
                {data.insights.map((ins, i) => (
                  <div
                    key={i}
                    className="text-ui-body text-zinc-900 [padding:8px_12px] bg-zinc-100 rounded-sm [line-height:1.5]"
                  >
                    {"•"} {ins}
                  </div>
                ))}
              </div>{" "}
            </UiCard>
          )}

          {/* Capacity Warnings */}
          {(data.capacity_warnings || []).length > 0 && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-zinc-700 [margin-bottom:12px]">
                Capacity Warnings
              </div>
              {data.capacity_warnings.map((w, i) => (
                <div
                  key={i}
                  className="text-ui-body text-zinc-900 [padding:8px_12px] bg-zinc-100 rounded-sm [margin-bottom:4px]"
                >
                  {" "}
                  <strong>{w.area}</strong>at {w.utilization}% —{" "}
                  {w.recommendation}
                </div>
              ))}
            </UiCard>
          )}

          {/* History */}
          {history.length > 1 && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                Previous Reports
              </div>{" "}
              <div className="flex flex-wrap [gap:8px]">
                {history.slice(1, 8).map((h, i) => (
                  <div
                    key={i}
                    className="[padding:8px_14px] bg-zinc-100 rounded-md text-ui-body text-ink-secondary border-hairline border-zinc-200"
                  >
                    {" "}
                    <span className="text-zinc-900">
                      {new Date(h.date + "T12:00:00").toLocaleDateString(
                        "en-US",
                        {
                          month: "short",
                          day: "numeric",
                        },
                      )}
                    </span>{" "}
                    <span
                      style={{
                        color: gradeColor(h.grade),
                      }}
                      className="font-medium [margin-left:8px]"
                    >
                      {h.grade}
                    </span>{" "}
                    <span className="[margin-left:8px]">
                      {h.recommendation_count} recs
                    </span>
                    {h.applied_count > 0 && (
                      <span className="text-zinc-900 [margin-left:4px]">
                        ({h.applied_count} applied)
                      </span>
                    )}
                  </div>
                ))}
              </div>{" "}
            </UiCard>
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
    adminFetch("/admin/ads/capacity-heatmap")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading capacity data...
      </div>
    );
  if (!data)
    return (
      <UiCard className="text-center [padding:40px]">
        <div className="text-ink-secondary">Unable to load capacity data</div>
      </UiCard>
    );
  const zoneColors = {
    green: "#15803D",
    yellow: "#A16207",
    orange: "#92400E",
    red: "#991B1B",
  };
  const modeEmoji = {
    base: "",
    spent: "",
    stop: "",
  };
  const areaLabels = {
    all: "ALL AREAS",
    "Lakewood Ranch": "LWR",
    Parrish: "Parrish",
    Sarasota: "Sarasota",
    Venice: "Venice",
  };
  return (
    <div className="flex flex-col [gap:20px]">
      {" "}
      <div className="text-ui-body text-ink-secondary">
        Capacity & Ad Budget Status — Week View
      </div>
      {Object.entries(data.heatmap || {}).map(([area, info]) => (
        <UiCard key={area} className="p-6">
          {" "}
          <div className="flex justify-between items-center [margin-bottom:16px]">
            {" "}
            <div>
              {" "}
              <div className="text-ui-body font-medium text-zinc-900">
                {areaLabels[area] || area}
              </div>{" "}
              <div className="text-ui-body text-ink-secondary">
                {info.techs} tech{info.techs !== 1 ? "s" : ""}
              </div>{" "}
            </div>{" "}
            <div className="text-ui-body text-zinc-900">
              {info.weeklyUtilization}% weekly
              <span className="text-ink-secondary text-ui-body [margin-left:8px]">
                {info.weeklyBooked}/{info.weeklySlots}
              </span>{" "}
            </div>{" "}
          </div>{" "}
          {/* Seven fixed columns: each keeps room for "Sep 9" / "SPENT" at
              the caption floor, and the row scrolls sideways on phones
              instead of letting day labels collide (Codex round 4). */}
          <div className="overflow-x-auto">
            <div className="grid [grid-template-columns:repeat(7,_minmax(84px,_1fr))] [gap:8px]">
              {(info.days || []).map((day, i) => {
                const color = zoneColors[day.colorZone] || "#71717A";
                return (
                  <div
                    key={i}
                    style={{
                      background: color + "15",
                      border: `1px solid ${color}44`,
                    }}
                    className="rounded-md [padding:12px_6px] box-border text-center [min-width:0px]"
                  >
                    {" "}
                    <div className="text-ui-body font-medium text-ink-secondary [margin-bottom:4px]">
                      {day.dayName}
                    </div>{" "}
                    <div className="text-ui-body text-ink-secondary [margin-bottom:8px]">
                      {day.dayLabel}
                    </div>{" "}
                    <div
                      style={{
                        color,
                      }}
                      className="text-ui-body font-medium [margin-bottom:4px]"
                    >
                      {day.utilizationPct}%
                    </div>{" "}
                    <div className="text-ui-body text-ink-secondary [margin-bottom:6px]">
                      {day.booked}/{day.slots}
                    </div>{" "}
                    <div className="text-ui-body">
                      {modeEmoji[day.budgetMode] || ""}{" "}
                      <span className="font-medium text-ui-body text-ink-secondary">
                        {day.budgetMode?.toUpperCase()}
                      </span>
                      {day.isSunday && (
                        <span className="text-zinc-900 text-ui-body">*</span>
                      )}
                    </div>{" "}
                  </div>
                );
              })}
            </div>{" "}
          </div>
        </UiCard>
      ))}
      {/* Legend */}
      <UiCard className="[padding:16px]">
        {" "}
        <div className="flex flex-wrap [gap:20px] text-ui-body text-ink-secondary">
          {" "}
          <span>
            <span className="inline-block [width:10px] [height:10px] rounded-xs bg-green-700 [margin-right:6px]" />
            0–70% Green (full ads)
          </span>{" "}
          <span>
            <span className="inline-block [width:10px] [height:10px] rounded-xs bg-amber-200 [margin-right:6px]" />
            71–85% Yellow (may cap)
          </span>{" "}
          <span>
            <span className="inline-block [width:10px] [height:10px] rounded-xs bg-amber-800 [margin-right:6px]" />
            86–95% Orange (capped)
          </span>{" "}
          <span>
            <span className="inline-block [width:10px] [height:10px] rounded-xs bg-alert-fg [margin-right:6px]" />
            96–100% Red (soft-stop)
          </span>{" "}
        </div>{" "}
        <div className="text-ui-body text-ink-secondary [margin-top:10px]">
          {" "}
          <span className="text-zinc-900">*</span>Sunday runs at full power
          based on Monday's capacity (no time-of-day check)
        </div>{" "}
      </UiCard>{" "}
    </div>
  );
}
export default function AdsPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedTab = searchParams.get("tab");
  const tab = TABS.some((item) => item.key === requestedTab)
    ? requestedTab
    : "ppc-dashboard";
  const setTab = (nextTab) => {
    if (nextTab === tab) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", nextTab);
    navigate({
      pathname: location.pathname,
      search: `?${next.toString()}`,
      hash: location.hash,
    });
  };

  // Report the validated leaf that actually renders, including fallbacks
  // reached through same-route history navigation.
  useRenderedTabBeacon("/admin/ppc", tab, [searchParams]);
  return (
    <UiSurface
      density="comfortable"
      className="ads-page mx-auto w-full max-w-[1400px]"
    >
      <AdminCommandHeader
        title="PPC"
        icon={Megaphone}
        sections={UI_TABS}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="PPC section"
        navGridClassName="grid-cols-2 md:grid-cols-6"
      />
      {tab === "ppc-dashboard" && (
        // Marked so the foundation QA can exclude it: the dashboard is migrated
        // by its own PR and still renders explicit 11px text and sub-44px
        // controls, which UiSurface does not override.
        <div data-qa="ppc-dashboard">
          <Suspense
            fallback={
              <div className="text-ink-secondary [padding:40px] text-center">
                Loading PPC dashboard...
              </div>
            }
          >
            <PPCDashboardPage />
          </Suspense>
        </div>
      )}
      {tab === "overview" && <OverviewTab />}
      {tab === "call-bridge" && <CallBridgeTab />}
      {tab === "service-lines" && <ServiceLinesTab />}
      {tab === "advisor" && <AdvisorTab />}
      {tab === "capacity" && <CapacityTab />}
    </UiSurface>
  );
}
