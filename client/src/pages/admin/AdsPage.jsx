import { useState, useEffect, useRef, lazy, Suspense } from "react";
import {
  BarChart3,
  CalendarRange,
  Layers,
  Megaphone,
  PhoneCall,
  Sparkles,
} from "lucide-react";

import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { etDateString } from "../../lib/timezone";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
const PPCDashboardPage = lazy(() => import("./PPCDashboardPage"));

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: `teal` folded to zinc-900, `purple`/`orange` fold too.
// Semantic green/amber/red preserved for status/alert accents.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  orange: "#18181B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  purple: "#18181B",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
const MONO = "'JetBrains Mono', monospace";

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
  { key: "ppc-dashboard", label: "PPC Dashboard", Icon: Megaphone },
  { key: "overview", label: "Overview", Icon: BarChart3 },
  { key: "call-bridge", label: "Call Bridge", Icon: PhoneCall },
  { key: "service-lines", label: "Service Lines", Icon: Layers },
  { key: "advisor", label: "AI Advisor", Icon: Sparkles },
  { key: "capacity", label: "Capacity", Icon: CalendarRange },
];

const thStyle = {
  padding: "10px 14px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 500,
  color: D.muted,
  borderBottom: `1px solid ${D.border}`,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};
const thR = { ...thStyle, textAlign: "right" };
const tdStyle = {
  padding: "10px 14px",
  fontSize: 13,
  color: D.text,
  borderBottom: `1px solid ${D.border}`,
  fontFamily: MONO,
};
const tdR = { ...tdStyle, textAlign: "right" };
const tdText = { ...tdStyle, fontFamily: "inherit" };

function Card({ children, style }) {
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: 24,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function KpiCard({ label, value, sub, color }) {
  return (
    <Card
      style={{ padding: 20, display: "flex", flexDirection: "column", gap: 4 }}
    >
      {" "}
      <div style={{ fontSize: 12, color: D.muted, fontWeight: 500 }}>
        {label}
      </div>{" "}
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: color || D.heading,
          fontFamily: MONO,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 11,
            color: sub.color || D.muted,
            fontFamily: MONO,
          }}
        >
          {sub.text}
        </div>
      )}
    </Card>
  );
}

function Badge({ mode }) {
  const colors = { base: D.green, spent: D.amber, stop: D.red };
  const labels = { base: "BASE", spent: "SPENT", stop: "STOP" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        background: (colors[mode] || D.muted) + "22",
        color: colors[mode] || D.muted,
        fontFamily: MONO,
        letterSpacing: "0.5px",
      }}
    >
      {labels[mode] || mode?.toUpperCase()}
    </span>
  );
}

function roasColor(roas) {
  if (roas >= 4) return D.green;
  if (roas >= 2) return D.amber;
  return D.red;
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
  if (status === "ready" || status === "already_bridged") return D.green;
  if (status === "ambiguous") return D.amber;
  return D.muted;
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
  if (match?.status === "already_bridged" && match.callLog?.googleAdsLeadMatched === false) {
    return "Needs Lead";
  }
  return bridgeStatusLabel(match?.status);
}

function bridgeDisplayTone(match) {
  if (match?.status === "already_bridged" && match.callLog?.googleAdsLeadMatched === false) {
    return D.amber;
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
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
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
    { spend: 0, value: 0, conv: 0, clicks: 0 },
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 14,
        }}
      >
        {" "}
        <KpiCard label="7-Day Ad Spend" value={fmt(total7.spend)} />{" "}
        <KpiCard
          label="7-Day Revenue"
          value={fmt(total7.value)}
          color={D.green}
        />{" "}
        <KpiCard
          label="Blended ROAS"
          value={
            total7.spend > 0
              ? (total7.value / total7.spend).toFixed(1) + "x"
              : "—"
          }
          color={
            total7.spend > 0 ? roasColor(total7.value / total7.spend) : D.muted
          }
        />{" "}
        <KpiCard
          label="Conversions"
          value={total7.conv.toFixed(0)}
          sub={{ text: `${total7.clicks} clicks`, color: D.muted }}
        />{" "}
      </div>{" "}
      <Card>
        {" "}
        <div
          style={{
            fontSize: 16,
            fontWeight: 500,
            color: D.heading,
            marginBottom: 16,
          }}
        >
          Campaign Performance
        </div>{" "}
        <div style={{ overflowX: "auto" }}>
          {" "}
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            {" "}
            <thead>
              {" "}
              <tr>
                {" "}
                <th style={thStyle}>Campaign</th> <th style={thR}>Mode</th>{" "}
                <th style={thR}>Budget</th> <th style={thR}>7d Spend</th>{" "}
                <th style={thR}>7d Revenue</th> <th style={thR}>ROAS</th>{" "}
                <th style={thR}>CPA</th> <th style={thR}>Conv</th>{" "}
                <th style={thR}>Trend</th>{" "}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {campaigns.map((c) => {
                const p = c.last7d || {};
                const trendIcon =
                  c.last7d?.roas > (c.last30d?.roas || 0) * 1.05
                    ? ""
                    : c.last7d?.roas < (c.last30d?.roas || 0) * 0.8
                      ? ""
                      : "";
                return (
                  <tr key={c.id}>
                    {" "}
                    <td style={tdText}>
                      {" "}
                      <div>{c.campaign_name}</div>{" "}
                      <div style={{ fontSize: 11, color: D.muted }}>
                        {c.target_area} • {c.campaign_type}
                      </div>{" "}
                    </td>{" "}
                    <td style={tdR}>
                      <Badge mode={c.budget_mode} />
                    </td>{" "}
                    <td style={tdR}>{fmtDec(c.daily_budget_current)}/d</td>{" "}
                    <td style={tdR}>{fmtDec(p.spend)}</td>{" "}
                    <td style={tdR}>{fmtDec(p.conversionValue)}</td>{" "}
                    <td style={{ ...tdR, color: roasColor(p.roas) }}>
                      {p.roas ? p.roas + "x" : "—"}
                    </td>{" "}
                    <td style={tdR}>{p.cpa ? fmtDec(p.cpa) : "—"}</td>{" "}
                    <td style={tdR}>{p.conversions || 0}</td>{" "}
                    <td style={{ ...tdR, fontSize: 16 }}>{trendIcon}</td>{" "}
                  </tr>
                );
              })}
            </tbody>{" "}
          </table>{" "}
        </div>{" "}
      </Card>{" "}
    </div>
  );
}

function EmptyState() {
  return (
    <Card style={{ textAlign: "center", padding: 60 }}>
      {" "}
      <div
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: D.heading,
          marginBottom: 8,
        }}
      >
        No Campaigns Yet
      </div>{" "}
      <div
        style={{
          fontSize: 14,
          color: D.muted,
          maxWidth: 400,
          margin: "0 auto",
        }}
      >
        Connect your Google Ads account to start tracking campaign performance,
        service-line attribution, and get daily AI-powered recommendations.
      </div>{" "}
    </Card>
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
        setMessage({ tone: D.red, text: e.message || "Bridge preview failed" });
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
        tone: result.appliedCount > 0 ? D.green : D.amber,
        text: `${fmtInt(result.appliedCount || 0)} bridge update${Number(result.appliedCount || 0) === 1 ? "" : "s"} applied`,
      });
    } catch (e) {
      setMessage({ tone: D.red, text: e.message || "Bridge apply failed" });
    } finally {
      setApplying(false);
    }
  };

  if (loading) {
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading call bridge...
      </div>
    );
  }

  const summary = data?.summary || {};
  const matches = data?.matches || [];
  const readyCount = Number(summary.ready || 0);
  const leadRetryCount = matches.filter((match) => (
    match.status === "already_bridged"
    && !!match.callLog
    && match.callLog.googleAdsLeadMatched === false
  )).length;
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
    : (readyCount > 0 && leadRetryCount > 0)
      ? "Apply ready + retry leads"
      : leadRetryCount > 0
        ? "Retry lead attribution"
        : readyCount > 0
          ? "Apply ready matches"
          : "Record clean rescan";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 14, color: D.muted }}>
            Google Ads call reporting bridge
          </div>
          <div style={{ fontSize: 12, color: D.text, marginTop: 4 }}>
            Main call asset: <span style={{ fontFamily: MONO }}>{targetNumber}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div
            style={{
              display: "flex",
              gap: 4,
              background: D.bg,
              borderRadius: 8,
              padding: 3,
            }}
          >
            {["7d", "30d", "90d"].map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                  background: period === p ? D.heading : "transparent",
                  color: period === p ? D.white : D.muted,
                }}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: `1px solid ${D.border}`,
              background: D.card,
              color: D.heading,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Preview
          </button>
          <button
            onClick={applyBridge}
            disabled={!canApply}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              border: `1px solid ${canApply ? D.green : D.border}`,
              background: canApply ? D.green : D.bg,
              color: canApply ? D.white : D.muted,
              fontSize: 12,
              fontWeight: 700,
              cursor: canApply ? "pointer" : "not-allowed",
            }}
          >
            {applyLabel}
          </button>
        </div>
      </div>

      {!configured && (
        <Card style={{ padding: 16, borderColor: D.amber }}>
          <div style={{ color: D.amber, fontSize: 13, fontWeight: 700 }}>
            Google Ads API is not configured in this environment.
          </div>
        </Card>
      )}

      {message && (
        <Card style={{ padding: 16 }}>
          <div style={{ color: message.tone, fontSize: 13, fontWeight: 700 }}>
            {message.text}
          </div>
        </Card>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
        gap: 14,
      }}>
        <KpiCard label="Google Calls" value={fmtInt(summary.googleCalls)} />
        <KpiCard label="Ready Matches" value={fmtInt(summary.ready)} color={D.green} />
        <KpiCard
          label="Already Bridged"
          value={fmtInt(summary.alreadyBridged)}
          sub={leadRetryCount > 0 ? { text: `${fmtInt(leadRetryCount)} lead retries`, color: D.amber } : null}
        />
        <KpiCard label="Main-Line CRM Calls" value={fmtInt(summary.crmMainLineCalls)} />
      </div>

      <Card>
        <div
          style={{
            fontSize: 15,
            fontWeight: 500,
            color: D.heading,
            marginBottom: 16,
          }}
        >
          Bridge Queue
        </div>
        {matches.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13 }}>
            No Google Ads call rows returned for this period.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>Google Call</th>
                  <th style={thStyle}>Campaign</th>
                  <th style={thStyle}>CRM Call</th>
                  <th style={thR}>Confidence</th>
                  <th style={thR}>Status</th>
                </tr>
              </thead>
              <tbody>
                {matches.slice(0, 50).map((match, i) => (
                  <tr key={match.googleCall?.resourceName || i}>
                    <td style={tdText}>
                      <div>{match.googleCall?.startLabel || "Unknown"}</div>
                      <div style={{ color: D.muted, fontSize: 11 }}>
                        {secondsLabel(match.googleCall?.durationSeconds)} · area {match.googleCall?.callerAreaCode || "—"}
                      </div>
                    </td>
                    <td style={tdText}>
                      <div>{match.googleCall?.campaignName || "—"}</div>
                      <div style={{ color: D.muted, fontSize: 11 }}>
                        {match.googleCall?.adGroupName || "—"}
                      </div>
                    </td>
                    <td style={tdText}>
                      {match.callLog ? (
                        <>
                          <div>{match.callLog.fromPhone || "Unknown caller"}</div>
                          <div style={{ color: D.muted, fontSize: 11 }}>
                            {match.callLog.customerName || match.callLog.leadSourceName || match.callLog.status || "CRM call"}
                          </div>
                        </>
                      ) : (
                        <span style={{ color: D.muted }}>No CRM match</span>
                      )}
                    </td>
                    <td style={{ ...tdR, color: bridgeDisplayTone(match), fontWeight: 700 }}>
                      {fmtInt(match.confidence)}%
                    </td>
                    <td style={{ ...tdR, color: bridgeDisplayTone(match), fontWeight: 700 }}>
                      {bridgeDisplayStatus(match)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div
          style={{
            fontSize: 15,
            fontWeight: 500,
            color: D.heading,
            marginBottom: 16,
          }}
        >
          Recent {targetNumber} Calls
        </div>
        {(data?.recentMainLineCalls || []).length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13 }}>
            No recent main-line calls in this period.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>Caller</th>
                  <th style={thStyle}>Customer</th>
                  <th style={thR}>Duration</th>
                  <th style={thR}>Source</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recentMainLineCalls || []).slice(0, 20).map((call) => (
                  <tr key={call.id}>
                    <td style={tdText}>{call.fromPhone || "Unknown"}</td>
                    <td style={tdText}>{call.customerName || "—"}</td>
                    <td style={tdR}>{secondsLabel(call.durationSeconds)}</td>
                    <td style={{ ...tdR, color: call.source === "google_ads" ? D.green : D.muted }}>
                      {call.source || "unattributed"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
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
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading service-line data...
      </div>
    );
  if (!data || data.totalLeads === 0)
    return (
      <Card style={{ textAlign: "center", padding: 40 }}>
        <div style={{ color: D.muted }}>
          No attribution data yet. Leads will appear here as they come in
          through your ad campaigns.
        </div>
      </Card>
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
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        {" "}
        <div style={{ fontSize: 14, color: D.muted }}>
          Service Line Performance
        </div>{" "}
        <div
          style={{
            display: "flex",
            gap: 4,
            background: D.bg,
            borderRadius: 8,
            padding: 3,
          }}
        >
          {["7d", "30d", "90d"].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 500,
                background: period === p ? D.teal : "transparent",
                color: period === p ? D.white : D.muted,
              }}
            >
              {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "90 Days"}
            </button>
          ))}
        </div>{" "}
      </div>
      {(data.byBucket || []).map((b) => (
        <Card key={b.bucket}>
          {" "}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 16,
            }}
          >
            {" "}
            <span style={{ fontSize: 18 }}>
              {bucketIcons[b.bucket] || ""}
            </span>{" "}
            <span style={{ fontSize: 15, fontWeight: 500, color: D.heading }}>
              {bucketLabels[b.bucket] || b.bucket.toUpperCase()}
            </span>{" "}
          </div>{" "}
          <div style={{ overflowX: "auto" }}>
            {" "}
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              {" "}
              <thead>
                {" "}
                <tr>
                  {" "}
                  <th style={thStyle}>Metric</th> <th style={thR}>Value</th>{" "}
                  <th style={thStyle}>Metric</th>{" "}
                  <th style={thR}>Value</th>{" "}
                </tr>{" "}
              </thead>{" "}
              <tbody>
                {" "}
                <tr>
                  {" "}
                  <td style={tdText}>Leads</td>
                  <td style={tdR}>{b.leads}</td> <td style={tdText}>Booked</td>
                  <td style={tdR}>{b.booked}</td>{" "}
                </tr>{" "}
                <tr>
                  {" "}
                  <td style={tdText}>Lead → Book %</td>
                  <td
                    style={{
                      ...tdR,
                      color: b.leadToBookRate >= 60 ? D.green : D.amber,
                    }}
                  >
                    {pct(b.leadToBookRate)}
                  </td>{" "}
                  <td style={tdText}>Book → Complete %</td>
                  <td
                    style={{
                      ...tdR,
                      color: b.bookToCompleteRate >= 80 ? D.green : D.amber,
                    }}
                  >
                    {pct(b.bookToCompleteRate)}
                  </td>{" "}
                </tr>{" "}
                <tr>
                  {" "}
                  <td style={tdText}>Ad Spend</td>
                  <td style={tdR}>{fmt(b.adSpend)}</td>{" "}
                  <td style={tdText}>Cost/Lead</td>
                  <td style={tdR}>{fmtDec(b.costPerLead)}</td>{" "}
                </tr>{" "}
                <tr>
                  {" "}
                  <td style={tdText}>Cost/Booked Job</td>
                  <td style={tdR}>{fmtDec(b.costPerBookedJob)}</td>{" "}
                  <td style={tdText}>Completed Revenue</td>
                  <td style={{ ...tdR, color: D.green }}>
                    {fmt(b.completedRevenue)}
                  </td>{" "}
                </tr>{" "}
                <tr>
                  {" "}
                  <td style={tdText}>ROAS</td>
                  <td
                    style={{
                      ...tdR,
                      color: roasColor(b.roas),
                      fontWeight: 700,
                    }}
                  >
                    {b.roas}x
                  </td>{" "}
                  <td style={tdText}>Avg Ticket</td>
                  <td style={tdR}>{fmt(b.avgTicket)}</td>{" "}
                </tr>{" "}
                <tr>
                  {" "}
                  <td style={tdText}>Gross Margin</td>
                  <td style={tdR}>{pct(b.grossMargin)}</td>{" "}
                  <td style={tdText}>
                    {b.ltvToCAC != null ? "LTV:CAC" : "Proj LTV 12mo"}
                  </td>{" "}
                  <td
                    style={{
                      ...tdR,
                      color: (b.ltvToCAC || 0) >= 10 ? D.green : D.amber,
                    }}
                  >
                    {b.ltvToCAC != null
                      ? b.ltvToCAC + "x"
                      : fmt(b.projectedLTV12mo)}
                  </td>{" "}
                </tr>{" "}
              </tbody>{" "}
            </table>{" "}
          </div>
          {b.verdict && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 14px",
                background: D.bg,
                borderRadius: 8,
                fontSize: 13,
                color: D.text,
                borderLeft: `3px solid ${b.roas >= 3 ? D.green : b.roas >= 1.5 ? D.amber : D.red}`,
              }}
            >
              {b.verdict}
            </div>
          )}
          {b.services?.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: D.muted }}>
              Services: {b.services.join(", ")}
            </div>
          )}
        </Card>
      ))}
      {/* Per-service table */}
      <Card>
        {" "}
        <div
          style={{
            fontSize: 15,
            fontWeight: 500,
            color: D.heading,
            marginBottom: 16,
          }}
        >
          Per-Service Breakdown
        </div>{" "}
        <div style={{ overflowX: "auto" }}>
          {" "}
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            {" "}
            <thead>
              {" "}
              <tr>
                {" "}
                <th style={thStyle}>Service</th> <th style={thR}>Leads</th>{" "}
                <th style={thR}>Booked</th> <th style={thR}>Close %</th>{" "}
                <th style={thR}>Spend</th> <th style={thR}>CPA</th>{" "}
                <th style={thR}>Ticket</th> <th style={thR}>ROAS</th>{" "}
                <th style={thR}>LTV ROAS</th> <th style={thR}>Margin</th>{" "}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {(data.bySpecificService || []).map((s, i) => (
                <tr key={i}>
                  {" "}
                  <td style={tdText}>{s.service}</td>{" "}
                  <td style={tdR}>{s.leads}</td> <td style={tdR}>{s.booked}</td>{" "}
                  <td
                    style={{
                      ...tdR,
                      color: s.closeRate >= 60 ? D.green : D.amber,
                    }}
                  >
                    {pct(s.closeRate)}
                  </td>{" "}
                  <td style={tdR}>{fmt(s.adSpend)}</td>{" "}
                  <td style={tdR}>{s.cpa ? fmtDec(s.cpa) : "—"}</td>{" "}
                  <td style={tdR}>{s.avgTicket ? fmt(s.avgTicket) : "—"}</td>{" "}
                  <td style={{ ...tdR, color: roasColor(s.roas) }}>
                    {s.roas ? s.roas + "x" : "—"}
                  </td>{" "}
                  <td style={{ ...tdR, color: s.ltvROAS ? D.purple : D.muted }}>
                    {s.ltvROAS ? s.ltvROAS + "x" : "—"}
                  </td>{" "}
                  <td style={tdR}>
                    {s.margin != null ? s.margin + "%" : "—"}
                  </td>{" "}
                </tr>
              ))}
            </tbody>{" "}
          </table>{" "}
        </div>{" "}
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            color: D.muted,
            display: "flex",
            gap: 16,
          }}
        >
          {" "}
          <span>ROAS = immediate return</span>{" "}
          <span style={{ color: D.purple }}>
            LTV ROAS = 12-month projected return (recurring services)
          </span>{" "}
        </div>{" "}
      </Card>{" "}
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
    setAppliedIfCurrent((prev) => ({ ...prev, [idx]: { status: "pending" } }));
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
        [idx]: { status: "applied", at: new Date().toLocaleTimeString() },
      }));
    } catch {
      setAppliedIfCurrent((prev) => ({
        ...prev,
        [idx]: { status: "error", message: "Network error — not applied." },
      }));
    }
  };

  // Only these advisor actions map to an automated change (setBudget/setMode);
  // everything else (add_negative, SEO/GBP/bid/keyword actions) is advisory and
  // must be done by hand — so it never gets an Apply button that could imply it
  // was executed. An auto action without a concrete value (stale pre-apply_value
  // reports, a fallback rec with no known budget) is equally un-executable —
  // its Apply click could only ever 422 — so it renders as manual too.
  const AUTO_APPLY_ACTIONS = ["increase_budget", "decrease_budget", "change_mode"];
  const canAutoApply = (rec) => {
    if (!AUTO_APPLY_ACTIONS.includes(rec.apply_action)) return false;
    if (rec.apply_action === "change_mode")
      return ["base", "spent", "stop"].includes(rec.apply_value);
    const n = Number(rec.apply_value);
    return Number.isFinite(n) && n > 0;
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading advisor report...
      </div>
    );

  const data = report?.report_data || {};

  const gradeColor = (g) => {
    if (!g) return D.muted;
    if (g.startsWith("A")) return D.green;
    if (g.startsWith("B")) return D.teal;
    if (g.startsWith("C")) return D.amber;
    return D.red;
  };

  const priorityColor = { high: D.red, medium: D.amber, low: D.muted };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        {" "}
        <div style={{ fontSize: 14, color: D.muted }}>
          AI Campaign Advisor{" "}
          {report?.date
            ? `— ${new Date(report.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
            : ""}
        </div>{" "}
        <button
          onClick={handleGenerate}
          disabled={generating}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: `1px solid ${D.teal}`,
            background: "transparent",
            color: D.teal,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            opacity: generating ? 0.5 : 1,
          }}
        >
          {generating ? "Generating..." : "Generate Report"}
        </button>{" "}
      </div>
      {!report ? (
        <Card style={{ textAlign: "center", padding: 60 }}>
          {" "}
          <div style={{ fontSize: 48, marginBottom: 16 }}>AI</div>{" "}
          <div
            style={{
              fontSize: 18,
              fontWeight: 500,
              color: D.heading,
              marginBottom: 8,
            }}
          >
            No Reports Yet
          </div>{" "}
          <div style={{ fontSize: 14, color: D.muted }}>
            Click "Generate Report" to run the AI advisor, or wait for the daily
            8 AM auto-run.
          </div>{" "}
        </Card>
      ) : (
        <>
          {/* Grade + Assessment */}
          <Card>
            {" "}
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              {" "}
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 32,
                  fontWeight: 700,
                  fontFamily: MONO,
                  background: gradeColor(data.grade) + "22",
                  color: gradeColor(data.grade),
                  border: `2px solid ${gradeColor(data.grade)}44`,
                }}
              >
                {data.grade || "?"}
              </div>{" "}
              <div style={{ flex: 1 }}>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: D.heading,
                    marginBottom: 4,
                  }}
                >
                  Overall Grade
                </div>{" "}
                <div style={{ fontSize: 14, color: D.text, lineHeight: 1.5 }}>
                  {data.overall_assessment}
                </div>{" "}
              </div>{" "}
            </div>{" "}
          </Card>
          {/* Recommendations */}
          {(data.recommendations || []).length > 0 && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: D.heading,
                  marginBottom: 16,
                }}
              >
                Recommendations
              </div>{" "}
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
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
                          fontSize: 12,
                          fontWeight: 700,
                          color: priorityColor[priority],
                          textTransform: "uppercase",
                          marginBottom: 8,
                          letterSpacing: "0.5px",
                        }}
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
                              padding: "14px 16px",
                              background: D.bg,
                              borderRadius: 8,
                              marginBottom: 8,
                              borderLeft: `3px solid ${priorityColor[priority]}`,
                            }}
                          >
                            {" "}
                            <div
                              style={{
                                fontSize: 14,
                                fontWeight: 500,
                                color: D.heading,
                                marginBottom: 4,
                              }}
                            >
                              {rec.campaign && (
                                <span style={{ color: D.teal }}>
                                  {rec.campaign}:{" "}
                                </span>
                              )}
                              {rec.action}
                            </div>
                            {rec.reasoning && (
                              <div
                                style={{
                                  fontSize: 12,
                                  color: D.muted,
                                  marginBottom: 6,
                                }}
                              >
                                {rec.reasoning}
                              </div>
                            )}
                            {rec.estimated_impact && (
                              <div
                                style={{
                                  fontSize: 12,
                                  color: D.green,
                                  marginBottom: 8,
                                }}
                              >
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
                                      <button
                                        onClick={() => handleApply(rec, globalIdx)}
                                        disabled={done || pending || generating}
                                        style={{
                                          padding: "6px 14px",
                                          borderRadius: 6,
                                          border: "none",
                                          fontSize: 12,
                                          fontWeight: 500,
                                          cursor:
                                            done || pending || generating ? "default" : "pointer",
                                          background: done ? D.green + "22" : D.teal,
                                          color: done ? D.green : D.heading,
                                          opacity: pending || generating ? 0.6 : 1,
                                        }}
                                      >
                                        {done
                                          ? `Applied at ${st.at}`
                                          : pending
                                            ? "Applying…"
                                            : rec.apply_action === "change_mode"
                                              ? `Apply: set mode to ${rec.apply_value}`
                                              : `Apply: ${rec.apply_action.replace(/_/g, " ")} to $${Number(rec.apply_value)}/day`}
                                      </button>
                                      {st?.status === "error" && (
                                        <div
                                          style={{
                                            fontSize: 11,
                                            color: D.red,
                                            marginTop: 6,
                                          }}
                                        >
                                          {st.message}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()
                              ) : (
                                <div style={{ fontSize: 11, color: D.muted }}>
                                  Manual action: {(rec.apply_action || rec.manual_action).replace(/_/g, " ")}
                                </div>
                              ))}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>{" "}
            </Card>
          )}

          {/* Waste Alerts */}
          {(data.waste_alerts || []).length > 0 && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: D.red,
                  marginBottom: 12,
                }}
              >
                Waste Alerts
              </div>{" "}
              <div style={{ overflowX: "auto" }}>
                {" "}
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  {" "}
                  <thead>
                    <tr>
                      <th style={thStyle}>Search Term</th>
                      <th style={thR}>Spend</th>
                      <th style={thR}>Conv</th>
                      <th style={thR}>Action</th>
                    </tr>
                  </thead>{" "}
                  <tbody>
                    {data.waste_alerts.map((w, i) => (
                      <tr key={i}>
                        {" "}
                        <td style={tdText}>{w.search_term}</td>{" "}
                        <td style={{ ...tdR, color: D.red }}>
                          {fmtDec(w.spend)}
                        </td>{" "}
                        <td style={tdR}>{w.conversions}</td>{" "}
                        <td style={tdR}>
                          <span style={{ color: D.amber, fontSize: 12 }}>
                            {w.action}
                          </span>
                        </td>{" "}
                      </tr>
                    ))}
                  </tbody>{" "}
                </table>{" "}
              </div>{" "}
            </Card>
          )}

          {/* Scaling Opportunities */}
          {(data.scaling_opportunities || []).length > 0 && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: D.green,
                  marginBottom: 12,
                }}
              >
                Scaling Opportunities
              </div>
              {data.scaling_opportunities.map((s, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px 14px",
                    background: D.bg,
                    borderRadius: 8,
                    marginBottom: 6,
                  }}
                >
                  {" "}
                  <div style={{ fontSize: 13, color: D.heading }}>
                    <strong>{s.campaign}</strong>: {fmt(s.current_budget)}/d →{" "}
                    {fmt(s.suggested_budget)}/d
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted }}>
                    {s.headroom_reason}
                  </div>{" "}
                </div>
              ))}
            </Card>
          )}

          {/* Insights */}
          {(data.insights || []).length > 0 && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: D.heading,
                  marginBottom: 12,
                }}
              >
                Insights
              </div>{" "}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {data.insights.map((ins, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 13,
                      color: D.text,
                      padding: "8px 12px",
                      background: D.bg,
                      borderRadius: 6,
                      lineHeight: 1.5,
                    }}
                  >
                    {"•"} {ins}
                  </div>
                ))}
              </div>{" "}
            </Card>
          )}

          {/* Capacity Warnings */}
          {(data.capacity_warnings || []).length > 0 && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: D.amber,
                  marginBottom: 12,
                }}
              >
                Capacity Warnings
              </div>
              {data.capacity_warnings.map((w, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 13,
                    color: D.text,
                    padding: "8px 12px",
                    background: D.bg,
                    borderRadius: 6,
                    marginBottom: 4,
                  }}
                >
                  {" "}
                  <strong>{w.area}</strong>at {w.utilization}% —{" "}
                  {w.recommendation}
                </div>
              ))}
            </Card>
          )}

          {/* History */}
          {history.length > 1 && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: D.heading,
                  marginBottom: 12,
                }}
              >
                Previous Reports
              </div>{" "}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {history.slice(1, 8).map((h, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "8px 14px",
                      background: D.bg,
                      borderRadius: 8,
                      fontSize: 12,
                      color: D.muted,
                      border: `1px solid ${D.border}`,
                    }}
                  >
                    {" "}
                    <span style={{ color: D.text }}>
                      {new Date(h.date + "T12:00:00").toLocaleDateString(
                        "en-US",
                        { month: "short", day: "numeric" },
                      )}
                    </span>{" "}
                    <span
                      style={{
                        color: gradeColor(h.grade),
                        fontWeight: 700,
                        marginLeft: 8,
                      }}
                    >
                      {h.grade}
                    </span>{" "}
                    <span style={{ marginLeft: 8 }}>
                      {h.recommendation_count} recs
                    </span>
                    {h.applied_count > 0 && (
                      <span style={{ color: D.green, marginLeft: 4 }}>
                        ({h.applied_count} applied)
                      </span>
                    )}
                  </div>
                ))}
              </div>{" "}
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
    adminFetch("/admin/ads/capacity-heatmap")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading capacity data...
      </div>
    );
  if (!data)
    return (
      <Card style={{ textAlign: "center", padding: 40 }}>
        <div style={{ color: D.muted }}>Unable to load capacity data</div>
      </Card>
    );

  const zoneColors = {
    green: D.green,
    yellow: D.amber,
    orange: D.orange,
    red: D.red,
  };
  const modeEmoji = { base: "", spent: "", stop: "" };
  const areaLabels = {
    all: "ALL AREAS",
    "Lakewood Ranch": "LWR",
    Parrish: "Parrish",
    Sarasota: "Sarasota",
    Venice: "Venice",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {" "}
      <div style={{ fontSize: 14, color: D.muted }}>
        Capacity & Ad Budget Status — Week View
      </div>
      {Object.entries(data.heatmap || {}).map(([area, info]) => (
        <Card key={area}>
          {" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
            }}
          >
            {" "}
            <div>
              {" "}
              <div style={{ fontSize: 15, fontWeight: 500, color: D.heading }}>
                {areaLabels[area] || area}
              </div>{" "}
              <div style={{ fontSize: 12, color: D.muted }}>
                {info.techs} tech{info.techs !== 1 ? "s" : ""}
              </div>{" "}
            </div>{" "}
            <div style={{ fontSize: 14, fontFamily: MONO, color: D.text }}>
              {info.weeklyUtilization}% weekly
              <span style={{ color: D.muted, fontSize: 12, marginLeft: 8 }}>
                {info.weeklyBooked}/{info.weeklySlots}
              </span>{" "}
            </div>{" "}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 8,
            }}
          >
            {(info.days || []).map((day, i) => {
              const color = zoneColors[day.colorZone] || D.muted;
              return (
                <div
                  key={i}
                  style={{
                    background: color + "15",
                    border: `1px solid ${color}44`,
                    borderRadius: 10,
                    padding: "12px 8px",
                    textAlign: "center",
                    minWidth: 0,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: D.muted,
                      marginBottom: 4,
                    }}
                  >
                    {day.dayName}
                  </div>{" "}
                  <div
                    style={{ fontSize: 10, color: D.muted, marginBottom: 8 }}
                  >
                    {day.dayLabel}
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color,
                      fontFamily: MONO,
                      marginBottom: 4,
                    }}
                  >
                    {day.utilizationPct}%
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 11,
                      color: D.muted,
                      fontFamily: MONO,
                      marginBottom: 6,
                    }}
                  >
                    {day.booked}/{day.slots}
                  </div>{" "}
                  <div style={{ fontSize: 10 }}>
                    {modeEmoji[day.budgetMode] || ""}{" "}
                    <span
                      style={{
                        fontWeight: 500,
                        fontSize: 9,
                        letterSpacing: "0.5px",
                        color: D.muted,
                      }}
                    >
                      {day.budgetMode?.toUpperCase()}
                    </span>
                    {day.isSunday && (
                      <span style={{ color: D.teal, fontSize: 9 }}>*</span>
                    )}
                  </div>{" "}
                </div>
              );
            })}
          </div>{" "}
        </Card>
      ))}
      {/* Legend */}
      <Card style={{ padding: 16 }}>
        {" "}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 20,
            fontSize: 12,
            color: D.muted,
          }}
        >
          {" "}
          <span>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: 2,
                background: D.green,
                marginRight: 6,
              }}
            />
            0–70% Green (full ads)
          </span>{" "}
          <span>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: 2,
                background: D.amber,
                marginRight: 6,
              }}
            />
            71–85% Yellow (may cap)
          </span>{" "}
          <span>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: 2,
                background: D.orange,
                marginRight: 6,
              }}
            />
            86–95% Orange (capped)
          </span>{" "}
          <span>
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: 2,
                background: D.red,
                marginRight: 6,
              }}
            />
            96–100% Red (soft-stop)
          </span>{" "}
        </div>{" "}
        <div style={{ fontSize: 11, color: D.muted, marginTop: 10 }}>
          {" "}
          <span style={{ color: D.teal }}>*</span>Sunday runs at full power
          based on Monday's capacity (no time-of-day check)
        </div>{" "}
      </Card>{" "}
    </div>
  );
}

export default function AdsPage() {
  const [tab, setTab] = useState("ppc-dashboard");

  // Usage beacon for the tab that actually RENDERS. PPC tabs are pure
  // state — they never reach the router, so without this the page's tab
  // column is impossible, same as Communications (Codex #2961 r17).
  useRenderedTabBeacon("/admin/ppc", tab);

  return (
    <div>
      {" "}
      <AdminCommandHeader
        title="PPC"
        icon={Megaphone}
        sections={TABS}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="PPC section"
        navGridClassName="grid-cols-2 md:grid-cols-6"
      />
      {tab === "ppc-dashboard" && (
        <Suspense
          fallback={
            <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
              Loading PPC dashboard...
            </div>
          }
        >
          <PPCDashboardPage />
        </Suspense>
      )}
      {tab === "overview" && <OverviewTab />}
      {tab === "call-bridge" && <CallBridgeTab />}
      {tab === "service-lines" && <ServiceLinesTab />}
      {tab === "advisor" && <AdvisorTab />}
      {tab === "capacity" && <CapacityTab />}
    </div>
  );
}
