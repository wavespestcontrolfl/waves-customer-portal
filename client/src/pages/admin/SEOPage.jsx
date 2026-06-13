import { useState, useEffect, lazy, Suspense } from "react";
import {
  Activity,
  BarChart3,
  LayoutDashboard,
  Link,
  Search,
  Sparkles,
  TrendingUp,
  UploadCloud,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
const SEODashboardPage = lazy(() => import("./SEODashboardPage"));

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: `teal` folded to zinc-900, `purple` folded to zinc-900.
// Semantic green/amber/red preserved for status/change accents.
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
function adminPost(path, body) {
  return adminFetch(path, { method: "POST", body });
}

function isAdminUser() {
  try {
    return JSON.parse(localStorage.getItem("waves_admin_user") || "{}")?.role === "admin";
  } catch {
    return false;
  }
}

function fmt(n) {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtMoney(n) {
  return (
    "$" +
    Number(n || 0).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
  );
}

const thStyle = {
  padding: "10px 14px",
  textAlign: "left",
  fontSize: 12,
  fontWeight: 600,
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

const WORKSPACES = [
  {
    key: "command",
    label: "Command",
    Icon: LayoutDashboard,
    sections: [
      { key: "dashboard", label: "Dashboard" },
      { key: "advisor", label: "SEO Advisor" },
    ],
  },
  {
    key: "strategy",
    label: "Strategy",
    Icon: Sparkles,
    sections: [
      { key: "actions", label: "Actions" },
      { key: "content-qa", label: "Content QA" },
    ],
  },
  {
    key: "performance",
    label: "Rankings",
    Icon: TrendingUp,
    sections: [
      { key: "rankings", label: "Rankings" },
      { key: "rankings-monitor", label: "Monitor" },
      { key: "funnel", label: "Funnel" },
    ],
  },
  {
    key: "authority",
    label: "Authority",
    Icon: Link,
    sections: [
      { key: "backlinks", label: "Backlinks & Citations" },
      { key: "ai-overview", label: "AI Overview" },
    ],
  },
  {
    key: "technical",
    label: "Technical",
    Icon: Activity,
    sections: [
      { key: "url-intel", label: "URL Intel" },
      { key: "indexation", label: "Indexation" },
      { key: "site-audit", label: "Site Health" },
    ],
  },
  {
    key: "measurement",
    label: "Measurement",
    Icon: BarChart3,
    sections: [
      { key: "analytics", label: "Analytics" },
      { key: "by-site", label: "By Site" },
    ],
  },
];

const WORKSPACE_BY_KEY = Object.fromEntries(WORKSPACES.map((w) => [w.key, w]));

function defaultViewForWorkspace(key) {
  return WORKSPACE_BY_KEY[key]?.sections?.[0]?.key || "dashboard";
}

const PRIMARY_DOMAIN = "wavespestcontrol.com";

// ── GSC Dashboard ──
function DashboardTab({ domain }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(28);
  const [queryFilter, setQueryFilter] = useState("all");
  useEffect(() => {
    setLoading(true);
    adminFetch(
      `/admin/seo/dashboard?period=${period}${domain ? `&domain=${domain}` : ""}`,
    )
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period, domain]);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading SEO data...
      </div>
    );
  const cur = data?.current || {};
  const chg = data?.change || {};
  const posColor = (v) => (v >= 0 ? D.green : D.red);

  const filteredQueries = (data?.topQueries || []).filter((q) => {
    if (queryFilter === "nonbrand") return !q.is_branded;
    if (queryFilter === "branded") return q.is_branded;
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {" "}
      <div
        style={{
          display: "flex",
          gap: 4,
          background: D.bg,
          borderRadius: 8,
          padding: 3,
          alignSelf: "flex-start",
        }}
      >
        {[7, 28, 90].map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              background: period === p ? D.teal : "transparent",
              color: period === p ? D.white : D.muted,
            }}
          >
            {p === 7 ? "7 Days" : p === 28 ? "28 Days" : "90 Days"}
          </button>
        ))}
      </div>{" "}
      <div
        className="seo-kpi-grid-4"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 14,
        }}
      >
        {" "}
        <KpiCard
          label="Total Clicks"
          value={cur.clicks?.toLocaleString() || "0"}
          sub={
            chg.clicks
              ? {
                  text: `${chg.clicks >= 0 ? "+" : ""}${chg.clicks}% vs prev`,
                  color: posColor(chg.clicks),
                }
              : null
          }
        />{" "}
        <KpiCard
          label="Impressions"
          value={cur.impressions?.toLocaleString() || "0"}
        />{" "}
        <KpiCard
          label="Avg CTR"
          value={((cur.ctr || 0) * 100).toFixed(2) + "%"}
        />{" "}
        <KpiCard
          label="Non-Brand Clicks"
          value={cur.nonbrandClicks?.toLocaleString() || "0"}
          color={D.purple}
        />{" "}
      </div>{" "}
      <Card>
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
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
            Top Queries
          </div>{" "}
          <div style={{ display: "flex", gap: 4 }}>
            {[
              ["all", "All"],
              ["nonbrand", "Non-Brand"],
              ["branded", "Branded"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setQueryFilter(k)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 11,
                  background: queryFilter === k ? D.teal : D.bg,
                  color: queryFilter === k ? D.white : D.muted,
                }}
              >
                {l}
              </button>
            ))}
          </div>{" "}
        </div>{" "}
        <div style={{ overflowX: "auto" }}>
          {" "}
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            {" "}
            <thead>
              <tr>
                <th style={thStyle}>Query</th>
                <th style={thR}>Clicks</th>
                <th style={thR}>Impr</th>
                <th style={thR}>CTR</th>
                <th style={thR}>Position</th>
              </tr>
            </thead>{" "}
            <tbody>
              {filteredQueries.slice(0, 25).map((q, i) => {
                const pos = parseFloat(q.avg_position).toFixed(1);
                return (
                  <tr key={i}>
                    {" "}
                    <td style={{ ...tdStyle, fontFamily: "inherit" }}>
                      {q.query}{" "}
                      {q.is_branded && (
                        <span
                          style={{
                            fontSize: 9,
                            padding: "1px 5px",
                            borderRadius: 3,
                            background: D.teal + "22",
                            color: D.teal,
                            marginLeft: 4,
                          }}
                        >
                          BRAND
                        </span>
                      )}
                    </td>{" "}
                    <td style={tdR}>{parseInt(q.clicks)}</td>{" "}
                    <td style={tdR}>
                      {parseInt(q.impressions).toLocaleString()}
                    </td>{" "}
                    <td style={tdR}>
                      {parseInt(q.impressions) > 0
                        ? (
                            (parseInt(q.clicks) / parseInt(q.impressions)) *
                            100
                          ).toFixed(1) + "%"
                        : "0%"}
                    </td>{" "}
                    <td
                      style={{
                        ...tdR,
                        color:
                          pos <= 3
                            ? D.green
                            : pos <= 10
                              ? D.teal
                              : pos <= 20
                                ? D.amber
                                : D.red,
                      }}
                    >
                      {pos}
                    </td>{" "}
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

// ── Stub tabs that fetch from existing endpoints ──
function SyncHealthCard() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/seo/sync-health")
      .then((d) => {
        setHealth(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading) return null;
  if (!health?.gsc || !health?.gbp) return null;
  const { gsc, gbp } = health;
  const gbpLocations = Array.isArray(gbp.locations) ? gbp.locations : [];
  const gscOk = gsc.configured && gsc.daily?.count > 0;
  const gbpOk = gbp.anyConfigured && gbpLocations.some((l) => l.rowCount > 0);
  const anyIssue = !gscOk || !gbpOk;
  if (!anyIssue) return null; // Only surface when there's something to fix

  const StatusDot = ({ ok, warn }) => (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: ok ? D.green : warn ? D.amber : D.red,
        marginRight: 8,
      }}
    />
  );

  const section = (label, children) => (
    <div style={{ marginBottom: 10 }}>
      {" "}
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: D.heading,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>{" "}
      <div style={{ fontSize: 13, color: D.text, lineHeight: 1.6 }}>
        {children}
      </div>{" "}
    </div>
  );

  return (
    <Card style={{ borderLeft: `3px solid ${D.amber}` }}>
      {" "}
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: D.heading,
          marginBottom: 8,
        }}
      >
        SEO sync health
      </div>{" "}
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>
        The Advisor runs on data from <code>gsc_performance_daily</code>{" "}
        +{" "}
        <code>gbp_performance_daily</code>. Below is what's actually present in
        the DB right now.
      </div>
      {section(
        "Google Search Console",
        <>
          {" "}
          <div>
            <StatusDot ok={gsc.configured} />{" "}
            <strong>{gsc.configured ? "Configured" : "Not configured"}</strong>
            {!gsc.configured && (
              <span style={{ color: D.muted }}>
                — set <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> on Railway
              </span>
            )}
          </div>{" "}
          <div>
            <StatusDot
              ok={gsc.daily?.count > 0}
              warn={gsc.daily?.count === 0}
            />{" "}
            <strong>{gsc.daily?.count || 0} daily rows</strong>
            {gsc.daily?.lastDate && (
              <span style={{ color: D.muted }}>
                · last sync {String(gsc.daily.lastDate).slice(0, 10)}
                {gsc.staleDays != null && gsc.staleDays > 2
                  ? ` (${gsc.staleDays}d old)`
                  : ""}
              </span>
            )}
          </div>{" "}
          <div style={{ color: D.muted }}>
            {gsc.queries?.count || 0} query rows in{" "}
            <code>gsc_queries</code>{" "}
          </div>{" "}
        </>,
      )}
      {section(
        "Google Business Profile (per location)",
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
        >
          {gbpLocations.map((l) => (
            <div key={l.id}>
              {" "}
              <StatusDot
                ok={l.configured && l.rowCount > 0}
                warn={l.configured && l.rowCount === 0}
              />{" "}
              <strong>{l.name}</strong>{" "}
              <div style={{ fontSize: 11, color: D.muted, marginLeft: 16 }}>
                {!l.configured ? (
                  <>
                    env <code>{l.envVar}</code> missing
                  </>
                ) : l.rowCount === 0 ? (
                  <>token set, 0 rows</>
                ) : (
                  <>
                    {l.rowCount} rows · last {String(l.lastDate).slice(0, 10)}
                  </>
                )}
              </div>{" "}
            </div>
          ))}
          {gbpLocations.length === 0 && (
            <div style={{ color: D.muted }}>No location sync rows reported.</div>
          )}
        </div>,
      )}
      <div
        style={{
          fontSize: 11,
          color: D.muted,
          marginTop: 10,
          paddingTop: 8,
          borderTop: `1px solid ${D.border}`,
        }}
      >
        Sync runs daily at 6am ET (see <code>scheduler.js</code>). If rows stay
        at 0 after 24h, grep Railway logs for <code>[GSC]</code> and{" "}
        <code>[GBP]</code> to see init errors.
      </div>{" "}
    </Card>
  );
}

function AdvisorTab() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const canRunSeoActions = isAdminUser();
  useEffect(() => {
    adminFetch("/admin/seo/advisor")
      .then((d) => {
        setReport(d.report);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading SEO advisor...
      </div>
    );
  const generate = async () => {
    if (!canRunSeoActions) return;
    setGenerating(true);
    try {
      await adminPost("/admin/seo/sync", { daysBack: 28 }).catch(() => {});
      const r = await adminPost("/admin/seo/advisor/generate", {});
      if (r.report) setReport(r.report);
    } catch {
      /* failed */
    }
    setGenerating(false);
  };
  if (!report)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {" "}
        <SyncHealthCard />{" "}
        <Card style={{ padding: 40, textAlign: "center" }}>
          {" "}
          <div style={{ color: D.muted, marginBottom: 16 }}>
            No SEO reports yet.
          </div>{" "}
          {canRunSeoActions && (
            <button
              onClick={generate}
              disabled={generating}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: "none",
                cursor: "pointer",
                background: D.teal,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                opacity: generating ? 0.7 : 1,
              }}
            >
              {generating
                ? "Syncing & generating..."
                : "Sync GSC & Generate Report"}
            </button>
          )}{" "}
        </Card>{" "}
      </div>
    );
  const data = report.report_data || {};
  const gradeColor = (g) =>
    !g
      ? D.muted
      : g.startsWith("A")
        ? D.green
        : g.startsWith("B")
          ? D.teal
          : g.startsWith("C")
            ? D.amber
            : D.red;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {" "}
      <SyncHealthCard />{" "}
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
              fontWeight: 800,
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
                fontWeight: 600,
                color: D.heading,
                marginBottom: 4,
              }}
            >
              SEO Grade
            </div>{" "}
            <div style={{ fontSize: 14, color: D.text, lineHeight: 1.5 }}>
              {data.overall_assessment}
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </Card>
      {(data.recommendations || []).length > 0 && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Recommendations
          </div>
          {data.recommendations.map((rec, i) => (
            <div
              key={i}
              style={{
                padding: "12px 14px",
                background: D.bg,
                borderRadius: 8,
                marginBottom: 6,
                borderLeft: `3px solid ${rec.priority === "high" ? D.red : rec.priority === "medium" ? D.amber : D.muted}`,
              }}
            >
              {" "}
              <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>
                {rec.action}
              </div>
              {rec.reasoning && (
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                  {rec.reasoning}
                </div>
              )}
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
  useEffect(() => {
    adminFetch(endpoint)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading...
      </div>
    );
  if (!data)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>{emptyMsg || "No data yet."}</div>
      </Card>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {data.summary && (
        <div
          className="seo-kpi-grid-5"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${Math.min(Object.keys(data.summary).length, 5)}, 1fr)`,
            gap: 12,
          }}
        >
          {Object.entries(data.summary).map(([k, v]) => (
            <KpiCard
              key={k}
              label={k.replace(/([A-Z])/g, " $1").trim()}
              value={typeof v === "number" ? v.toLocaleString() : v}
            />
          ))}
        </div>
      )}
      <Card>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 4,
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 13, color: D.muted }}>
          Data loaded from {endpoint}
        </div>
      </Card>{" "}
    </div>
  );
}

function RankingsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/seo/rankings?days=7")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading rankings...
      </div>
    );
  if (!data?.rankings?.length)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>
          No ranking data yet. Configure DataForSEO and enable
          GATE_SEO_INTELLIGENCE.
        </div>
      </Card>
    );
  const s = data.summary || {};
  const posColor = (p) =>
    !p
      ? D.muted
      : p <= 3
        ? D.green
        : p <= 10
          ? D.teal
          : p <= 20
            ? D.amber
            : D.red;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {" "}
      <div
        className="seo-kpi-grid-4"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
        }}
      >
        {" "}
        <KpiCard
          label="Improving"
          value={s.improving || 0}
          color={D.green}
        />{" "}
        <KpiCard label="Declining" value={s.declining || 0} color={D.red} />{" "}
        <KpiCard label="Stable" value={s.stable || 0} />{" "}
        <KpiCard
          label="Map Pack"
          value={s.inMapPack || 0}
          color={D.teal}
        />{" "}
      </div>{" "}
      <Card>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Keyword</th>
                <th style={thStyle}>City</th>
                <th style={thR}>Position</th>
                <th style={thR}>Change</th>
                <th style={thStyle}>AIO</th>
              </tr>
            </thead>
            <tbody>
              {data.rankings.map((r, i) => (
                <tr key={i}>
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: "inherit",
                      fontWeight: 500,
                    }}
                  >
                    {r.keyword}
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: "inherit",
                      color: D.muted,
                    }}
                  >
                    {r.primary_city || "—"}
                  </td>
                  <td style={{ ...tdR, color: posColor(r.currentPosition) }}>
                    {r.currentPosition || "—"}
                  </td>
                  <td
                    style={{
                      ...tdR,
                      color:
                        r.delta > 0 ? D.green : r.delta < 0 ? D.red : D.muted,
                    }}
                  >
                    {r.delta > 0 ? `+${r.delta}` : r.delta || "—"}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    {r.aiOverviewCited ? "Yes" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>{" "}
    </div>
  );
}

// ── Rankings Monitor — per-page position before/now + change chips ──

const CHIP_COLORS = {
  META: D.amber,
  CONTENT: D.teal,
  LINKS: D.green,
  SCHEMA: D.muted,
};
const CHIP_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function chipDateLabel(date) {
  const [, m, d] = String(date || "").split("-");
  if (!m || !d) return date || "";
  return `${parseInt(d, 10)} ${CHIP_MONTHS[parseInt(m, 10) - 1] || ""}`;
}

function pagePath(url) {
  return String(url || "").replace(/^https?:\/\/[^/]+/i, "") || "/";
}

function pageHost(url) {
  const m = String(url || "").match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function AnnotationChip({ ann }) {
  const color = CHIP_COLORS[ann.type] || D.muted;
  const verdict =
    ann.status === "accepted" ? " ✓" : ann.status === "rejected" ? " ✗" : "";
  const title = `${ann.type.toLowerCase()} change on ${ann.date}${ann.count > 1 ? ` (×${ann.count})` : ""} — source: ${(ann.sources || []).join(", ")}${ann.status ? ` · experiment ${ann.status}` : ""}`;
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 4,
        border: `1px solid ${color}`,
        color,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.5px",
        fontFamily: MONO,
        whiteSpace: "nowrap",
      }}
    >
      {ann.type} · {chipDateLabel(ann.date)}
      {ann.count > 1 ? ` ×${ann.count}` : ""}
      {verdict}
    </span>
  );
}

function beforeAfter(before, now, suffix = "") {
  if (before == null) return <span>{now}{suffix}</span>;
  return (
    <span>
      <span style={{ color: D.muted }}>{before}{suffix} → </span>
      {now}{suffix}
    </span>
  );
}

function MonitorTable({ title, rows, accent }) {
  if (!rows.length) return null;
  return (
    <Card style={{ padding: 0 }}>
      <div
        style={{
          padding: "14px 16px",
          fontSize: 13,
          fontWeight: 600,
          color: accent || D.heading,
          borderBottom: `1px solid ${D.border}`,
        }}
      >
        {title} ({rows.length})
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>Page</th>
              <th style={thR}>Pos Before</th>
              <th style={thR}>Pos Now</th>
              <th style={thR}>Change</th>
              <th style={thR}>Clicks</th>
              <th style={thR}>Imp</th>
              <th style={thR}>CTR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => {
              const host = pageHost(p.page_url);
              const isHub = !host || host === "wavespestcontrol.com";
              return (
                <tr key={`${p.domain || ""}-${p.page_url}-${i}`}>
                  <td style={{ ...tdStyle, fontFamily: "inherit", maxWidth: 420 }}>
                    <div
                      style={{
                        color: D.heading,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={p.page_url}
                    >
                      {!isHub && (
                        <span style={{ color: D.muted, fontSize: 11 }}>{host}</span>
                      )}
                      {pagePath(p.page_url)}
                    </div>
                    {p.annotations?.length > 0 && (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                        {p.annotations.map((a, j) => (
                          <AnnotationChip key={j} ann={a} />
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={tdR}>{p.pos_before ?? "—"}</td>
                  <td style={{ ...tdR, color: D.heading }}>{p.pos_now ?? "—"}</td>
                  <td
                    style={{
                      ...tdR,
                      fontWeight: 600,
                      color:
                        p.movement === "lost"
                          ? D.red
                          : p.change == null
                            ? D.muted
                            : p.change < 0
                              ? D.green
                              : p.change > 0
                                ? D.red
                                : D.muted,
                    }}
                  >
                    {p.movement === "lost"
                      ? "GONE"
                      : p.change == null
                        ? "NEW"
                        : p.change > 0
                          ? `+${p.change}`
                          : p.change}
                  </td>
                  <td style={tdR}>{beforeAfter(p.clicks_before, p.clicks_now)}</td>
                  <td style={tdR}>
                    {beforeAfter(
                      p.impressions_before == null ? null : p.impressions_before.toLocaleString(),
                      p.impressions_now.toLocaleString()
                    )}
                  </td>
                  <td style={tdR}>{beforeAfter(p.ctr_before, p.ctr_now, "%")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RankingsMonitorTab() {
  const [period, setPeriod] = useState(90);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    adminFetch(`/admin/seo/rankings-monitor?period=${period}`)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [period]);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading rankings monitor...
      </div>
    );
  if (error)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.red }}>{error}</div>
      </Card>
    );
  // pages holds only visible movers — an all-flat window arrives with
  // pages empty but pages_tracked > 0, and that's healthy data (the
  // no-movement card below covers it), not missing GSC data.
  if (!data?.pages?.length && !data?.summary?.pages_tracked)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>
          No page data in this window yet. GSC syncs daily at 6am ET; data
          publishes with a ~3 day lag.
        </div>
      </Card>
    );

  const s = data.summary || {};
  const wins = data.pages.filter((p) => p.movement === "win");
  // Pages that vanished from GSC entirely are the hardest losses — they
  // share the Losses table, marked GONE.
  const losses = data.pages.filter(
    (p) => p.movement === "loss" || p.movement === "lost"
  );
  const fresh = data.pages.filter((p) => p.movement === "new");
  const deltaSub = (delta, invert = false) => {
    if (delta == null || delta === 0) return null;
    const good = invert ? delta < 0 : delta > 0;
    return {
      text: `${delta > 0 ? "+" : ""}${typeof delta === "number" ? delta.toLocaleString() : delta}`,
      color: good ? D.green : D.red,
    };
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div
          style={{
            display: "flex",
            gap: 4,
            background: D.bg,
            borderRadius: 8,
            padding: 3,
          }}
        >
          {[7, 28, 90].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                background: period === p ? D.teal : "transparent",
                color: period === p ? D.white : D.muted,
              }}
            >
              {p === 7 ? "7 Days" : p === 28 ? "28 Days" : "3 Months"}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: D.muted, fontFamily: MONO }}>
          {data.window?.current?.from} → {data.window?.current?.to} vs{" "}
          {data.window?.prior?.from} → {data.window?.prior?.to}
        </div>
      </div>
      <div style={{ fontSize: 12, color: D.muted }}>
        Google Search Console publishes data with a ~3 day lag — the most
        recent days shown will be 2–3 days behind today. Chips mark shipped
        page changes: META = title/description rewrite, CONTENT =
        refresh/new page, LINKS = inbound internal links, SCHEMA = structured
        data.
      </div>
      <div
        className="seo-kpi-grid-4"
        style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}
      >
        <KpiCard
          label="Clicks"
          value={(s.clicks || 0).toLocaleString()}
          sub={deltaSub(s.clicks_delta)}
        />
        <KpiCard
          label="Impressions"
          value={(s.impressions || 0).toLocaleString()}
          sub={deltaSub(s.impressions_delta)}
        />
        <KpiCard
          label="Avg Position"
          value={s.avg_position ?? "—"}
          sub={deltaSub(s.avg_position_delta, true)}
        />
        <KpiCard
          label="Pages Tracked"
          value={(s.pages_tracked || 0).toLocaleString()}
          sub={deltaSub(s.pages_tracked_delta)}
        />
      </div>
      <MonitorTable title="Position Wins" rows={wins} accent={D.green} />
      <MonitorTable title="Position Losses" rows={losses} accent={D.red} />
      <MonitorTable title="New Pages" rows={fresh} />
      {wins.length + losses.length + fresh.length === 0 && (
        <Card style={{ padding: 40, textAlign: "center" }}>
          <div style={{ color: D.muted }}>
            No position movement past ±0.5 in this window.
          </div>
        </Card>
      )}
    </div>
  );
}

function BacklinksTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [subTab, setSubTab] = useState("overview");
  const [llmDash, setLlmDash] = useState(null);
  const [llmScanning, setLlmScanning] = useState(false);
  const canRunSeoActions = isAdminUser();

  useEffect(() => {
    adminFetch("/admin/seo/backlinks")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Lazy-load the answer-engine share-of-voice dashboard the first time the
  // LLM Mentions sub-tab is opened.
  useEffect(() => {
    if (subTab !== "llm" || llmDash) return;
    adminFetch("/admin/seo/llm-mentions")
      .then(setLlmDash)
      .catch(() => {});
  }, [subTab, llmDash]);

  const handleLlmScan = async () => {
    if (!canRunSeoActions) return;
    setLlmScanning(true);
    try {
      await adminPost("/admin/seo/llm-mentions/scan", {});
      const [dash, backlinks] = await Promise.all([
        adminFetch("/admin/seo/llm-mentions").catch(() => null),
        adminFetch("/admin/seo/backlinks").catch(() => null),
      ]);
      if (dash) setLlmDash(dash);
      if (backlinks) setData(backlinks);
    } finally {
      setLlmScanning(false);
    }
  };

  const handleScan = async () => {
    if (!canRunSeoActions) return;
    setScanning(true);
    try {
      await adminPost("/admin/seo/backlinks/scan", {});
      const d = await adminFetch("/admin/seo/backlinks");
      setData(d);
    } finally {
      setScanning(false);
    }
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading backlinks...
      </div>
    );
  if (!data)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>
          No backlink data yet.
        </div>
      </Card>
    );

  const sevColor = {
    critical: D.red,
    warning: D.amber,
    watch: D.muted,
    clean: D.green,
  };
  const statusColor = {
    active: D.green,
    inconsistent: D.red,
    missing: D.amber,
    claimed: D.teal,
    unchecked: D.muted,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Sub-tabs */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {" "}
        <div
          className="seo-sub-tabs"
          style={{
            display: "flex",
            gap: 4,
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {[
            { key: "overview", label: "Overview" },
            { key: "citations", label: "Citations" },
            { key: "gaps", label: "Competitor Gaps" },
            { key: "llm", label: "LLM Mentions" },
            { key: "prospects", label: "Link Building" },
            { key: "agent", label: "Agent" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setSubTab(t.key)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                background: subTab === t.key ? D.teal : D.bg,
                color: subTab === t.key ? D.white : D.muted,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>{" "}
        {canRunSeoActions && (
          <button
            onClick={handleScan}
            disabled={scanning}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: `1px solid ${D.teal}`,
              background: "transparent",
              color: D.teal,
              fontSize: 12,
              cursor: "pointer",
              opacity: scanning ? 0.5 : 1,
            }}
          >
            {scanning ? "Scanning..." : "Scan Backlinks"}
          </button>
        )}{" "}
      </div>
      {/* Stats */}
      <div
        className="seo-kpi-grid-5"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 10,
        }}
      >
        {" "}
        <KpiCard label="Total Links" value={data.total || 0} />{" "}
        <KpiCard label="Critical" value={data.critical || 0} color={D.red} />{" "}
        <KpiCard label="Warning" value={data.warning || 0} color={D.amber} />{" "}
        <KpiCard label="Clean" value={data.clean || 0} color={D.green} />{" "}
        <KpiCard
          label="Citations"
          value={data.citationStats?.total || 0}
          sub={{ text: `${data.citationStats?.active || 0} active` }}
        />{" "}
      </div>
      {/* Velocity KPIs */}
      {data.velocity && (
        <div className="seo-kpi-grid-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 10 }}>
          <KpiCard label="New 7d" value={`+${data.velocity.new_7d}`} color={D.green} />
          <KpiCard label="Lost 7d" value={data.velocity.lost_7d > 0 ? `-${data.velocity.lost_7d}` : "0"} color={data.velocity.lost_7d > 0 ? D.red : D.muted} />
          <KpiCard label="Net 7d" value={data.velocity.net_7d >= 0 ? `+${data.velocity.net_7d}` : `${data.velocity.net_7d}`} color={data.velocity.net_7d > 0 ? D.green : data.velocity.net_7d < 0 ? D.red : D.muted} />
          <KpiCard label="Trend" value={data.velocity.trend === "growing" ? "Growing" : data.velocity.trend === "shrinking" ? "Shrinking" : "Flat"} color={data.velocity.net_7d > 0 ? D.green : data.velocity.net_7d < 0 ? D.red : D.muted} />
        </div>
      )}
      {/* Overview sub-tab */}
      {subTab === "overview" && (
        <>
          {data.anchorDistribution && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 12,
                }}
              >
                Anchor Text Distribution
              </div>
              {Object.entries(data.anchorDistribution).map(([type, count]) => (
                <div
                  key={type}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 6,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      width: 100,
                      fontSize: 12,
                      color: D.text,
                      textAlign: "right",
                      textTransform: "capitalize",
                    }}
                  >
                    {type.replace("_", " ")}
                  </div>{" "}
                  <div
                    style={{
                      flex: 1,
                      height: 14,
                      background: D.bg,
                      borderRadius: 3,
                    }}
                  >
                    {" "}
                    <div
                      style={{
                        height: "100%",
                        borderRadius: 3,
                        background:
                          type === "branded"
                            ? D.green
                            : type === "keyword_rich"
                              ? D.amber
                              : D.teal,
                        width: `${Math.min(100, (count / Math.max(data.total, 1)) * 100)}%`,
                      }}
                    />{" "}
                  </div>{" "}
                  <div
                    style={{
                      width: 30,
                      fontSize: 12,
                      color: D.muted,
                      fontFamily: MONO,
                    }}
                  >
                    {count}
                  </div>{" "}
                </div>
              ))}
            </Card>
          )}
          {(data.recentToxic || []).length > 0 && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: D.red,
                  marginBottom: 12,
                }}
              >
                Toxic Links
              </div>
              {data.recentToxic.map((l, i) => (
                <div
                  key={i}
                  style={{
                    padding: "8px 12px",
                    background: D.bg,
                    borderRadius: 6,
                    marginBottom: 4,
                    borderLeft: `3px solid ${sevColor[l.severity]}`,
                  }}
                >
                  {" "}
                  <div style={{ fontSize: 12, color: D.heading }}>
                    {l.source_domain}
                  </div>{" "}
                  <div style={{ fontSize: 11, color: D.muted }}>
                    Anchor: "{l.anchor_text}" · Toxicity: {l.toxicity_score}/100
                  </div>{" "}
                </div>
              ))}
            </Card>
          )}
          {/* Trend */}
          {(data.snapshots || []).length > 1 && (
            <Card>
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 12,
                }}
              >
                Backlink Trend
              </div>{" "}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-end",
                  height: 60,
                }}
              >
                {(data.snapshots || []).reverse().map((s, i) => (
                  <div key={i} style={{ flex: 1, textAlign: "center" }}>
                    {" "}
                    <div
                      style={{ fontSize: 10, color: D.muted, fontFamily: MONO }}
                    >
                      {s.total_backlinks}
                    </div>{" "}
                    <div
                      style={{
                        height: `${Math.max(4, (s.total_backlinks || 0) / 2)}px`,
                        background: D.teal,
                        borderRadius: 2,
                        marginTop: 2,
                      }}
                    />{" "}
                    <div style={{ fontSize: 9, color: D.muted, marginTop: 2 }}>
                      {new Date(s.snapshot_date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </div>{" "}
                  </div>
                ))}
              </div>{" "}
            </Card>
          )}

          {/* Recently Lost Links */}
          {(data.recentlyLost || []).length > 0 && (
            <Card>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Recently Lost Links</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={thStyle}>Source Domain</th>
                    <th style={thR}>DR</th>
                    <th style={thStyle}>Anchor</th>
                    <th style={thStyle}>Target</th>
                    <th style={thStyle}>Lost</th>
                  </tr></thead>
                  <tbody>
                    {data.recentlyLost.map((l, i) => (
                      <tr key={l.id || `${l.source_domain || "lost"}-${l.target_url || i}`}>
                        <td style={tdStyle}>{l.source_domain}</td>
                        <td style={tdR}>{l.domain_rating || "—"}</td>
                        <td style={{ ...tdStyle, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.anchor_text || "—"}</td>
                        <td style={{ ...tdStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.target_url || "—"}</td>
                        <td style={tdStyle}>{l.updated_at ? new Date(l.updated_at).toLocaleDateString() : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {/* Citations sub-tab */}
      {subTab === "citations" && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Directory Citations ({data.citationStats?.total || 0})
          </div>
          {(data.citations || []).map((c, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 0",
                borderBottom: `1px solid ${D.border}`,
              }}
            >
              {" "}
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  background: statusColor[c.status] || D.muted,
                  flexShrink: 0,
                }}
              />{" "}
              <div style={{ flex: 1, fontSize: 13, color: D.heading }}>
                {c.directory_name}
              </div>
              {c.listing_url && (
                <a
                  href={c.listing_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11,
                    color: D.teal,
                    textDecoration: "none",
                  }}
                >
                  View
                </a>
              )}
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: (statusColor[c.status] || D.muted) + "22",
                  color: statusColor[c.status] || D.muted,
                  textTransform: "uppercase",
                  fontWeight: 700,
                }}
              >
                {c.status}
              </span>{" "}
            </div>
          ))}
        </Card>
      )}

      {/* Competitor Gaps sub-tab */}
      {subTab === "gaps" && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.amber,
              marginBottom: 12,
            }}
          >
            Competitor Gap Opportunities ({(data.competitorGaps || []).length})
            {data.newGapsSince7d > 0 && (
              <span style={{ marginLeft: 8, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 500, background: `${D.green}18`, color: D.green }}>
                {data.newGapsSince7d} new this week{data.newHighValueGapsSince7d > 0 ? ` (${data.newHighValueGapsSince7d} high-value)` : ""}
              </span>
            )}
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>
            Domains linking to competitors but not to Waves
          </div>
          {(data.competitorGaps || []).length === 0 ? (
            <div
              style={{
                fontSize: 13,
                color: D.muted,
                padding: 20,
                textAlign: "center",
              }}
            >
              Run a competitor gap scan to find opportunities
            </div>
          ) : (
            (data.competitorGaps || []).map((g, i) => (
              <div
                key={i}
                style={{
                  padding: "8px 12px",
                  background: D.bg,
                  borderRadius: 6,
                  marginBottom: 4,
                }}
              >
                {" "}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  {" "}
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, color: D.heading, fontWeight: 500 }}>{g.source_domain}</span>
                    {g.created_at && new Date(g.created_at) >= new Date(Date.now() - 7 * 86400000) && (
                      <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600, background: `${D.green}18`, color: D.green }}>New</span>
                    )}
                  </div>{" "}
                  <span style={{ fontSize: 10, color: D.muted }}>
                    DR: {g.source_domain_rating || "?"}
                  </span>{" "}
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted }}>
                  Links to: {g.competitor_domain} · Anchor: "
                  {(g.anchor_text || "").substring(0, 40)}"
                </div>{" "}
              </div>
            ))
          )}
        </Card>
      )}

      {/* LLM Mentions sub-tab — answer-engine visibility (AEO) */}
      {subTab === "llm" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Header + scan */}
          <Card>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div
                  style={{ fontSize: 14, fontWeight: 600, color: D.heading }}
                >
                  Answer-Engine Visibility (AEO)
                </div>
                <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                  {llmDash
                    ? `${llmDash.summary?.overallShareOfVoice ?? 0}% share of voice · ${llmDash.summary?.queriesTracked ?? 0} queries · ${(llmDash.summary?.platforms || []).length} engines`
                    : "Loading…"}
                </div>
              </div>
              {canRunSeoActions && (
                <button
                  onClick={handleLlmScan}
                  disabled={llmScanning}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: `1px solid ${D.teal}`,
                    background: "transparent",
                    color: D.teal,
                    fontSize: 11,
                    cursor: llmScanning ? "default" : "pointer",
                    opacity: llmScanning ? 0.6 : 1,
                  }}
                >
                  {llmScanning ? "Scanning…" : "Run Scan"}
                </button>
              )}
            </div>
          </Card>

          {/* Share of voice by engine */}
          {llmDash?.byPlatform?.length > 0 && (
            <Card>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 10,
                }}
              >
                Share of Voice by Engine
              </div>
              {llmDash.byPlatform.map((p) => (
                <div
                  key={p.platform}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <div
                    style={{
                      width: 130,
                      fontSize: 11,
                      color: D.text,
                      textTransform: "capitalize",
                    }}
                  >
                    {p.platform.replace(/_/g, " ")}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      height: 14,
                      background: D.bg,
                      borderRadius: 3,
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        borderRadius: 3,
                        background:
                          p.shareOfVoice >= 50
                            ? D.green
                            : p.shareOfVoice > 0
                              ? D.amber
                              : D.muted,
                        width: `${p.shareOfVoice}%`,
                      }}
                    />
                  </div>
                  <div
                    style={{
                      width: 70,
                      fontSize: 11,
                      color: D.muted,
                      textAlign: "right",
                      fontFamily: MONO,
                    }}
                  >
                    {p.shareOfVoice}% ({p.mentioned}/{p.total})
                  </div>
                </div>
              ))}
            </Card>
          )}

          {/* Share-of-voice trend */}
          {llmDash?.trend?.length > 1 && (
            <Card>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 10,
                }}
              >
                Share-of-Voice Trend ({llmDash.trend.length}d)
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 2,
                  height: 48,
                }}
              >
                {llmDash.trend.map((t) => (
                  <div
                    key={t.date}
                    title={`${t.date}: ${t.shareOfVoice}% (${t.mentioned}/${t.total})`}
                    style={{
                      flex: 1,
                      minWidth: 3,
                      height: `${Math.max(2, t.shareOfVoice)}%`,
                      background: D.green,
                      borderRadius: 2,
                    }}
                  />
                ))}
              </div>
            </Card>
          )}

          {/* Cited Waves pages + competitors */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Card style={{ flex: 1, minWidth: 240 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 10,
                }}
              >
                Cited Waves Pages
              </div>
              {(llmDash?.citedPages || []).length === 0 ? (
                <div style={{ fontSize: 12, color: D.muted }}>
                  No owned-domain citations yet.
                </div>
              ) : (
                llmDash.citedPages.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      fontSize: 11,
                      padding: "3px 0",
                      color: D.text,
                    }}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.url}
                    </span>
                    <span style={{ color: D.green, fontFamily: MONO }}>
                      {c.count}
                    </span>
                  </div>
                ))
              )}
            </Card>
            <Card style={{ flex: 1, minWidth: 240 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 10,
                }}
              >
                Competitors Cited
              </div>
              {(llmDash?.competitors || []).length === 0 ? (
                <div style={{ fontSize: 12, color: D.muted }}>
                  None detected.
                </div>
              ) : (
                llmDash.competitors.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      fontSize: 11,
                      padding: "3px 0",
                      color: D.text,
                      textTransform: "capitalize",
                    }}
                  >
                    <span>{c.name}</span>
                    <span style={{ color: D.amber, fontFamily: MONO }}>
                      {c.count}
                    </span>
                  </div>
                ))
              )}
            </Card>
          </div>

          {/* Latest by query × engine */}
          <Card>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: D.heading,
                marginBottom: 10,
              }}
            >
              Latest by Query × Engine
            </div>
            {(llmDash?.grid || data.llmMentions || []).length === 0 ? (
              <div
                style={{
                  fontSize: 13,
                  color: D.muted,
                  padding: 20,
                  textAlign: "center",
                }}
              >
                {canRunSeoActions
                  ? 'Click "Run Scan" to probe answer engines for Waves mentions'
                  : "No LLM mentions found."}
              </div>
            ) : (
              (llmDash?.grid || data.llmMentions || []).map((m, i) => (
                <div
                  key={i}
                  style={{
                    padding: "8px 12px",
                    background: D.bg,
                    borderRadius: 6,
                    marginBottom: 4,
                    borderLeft: `3px solid ${m.waves_mentioned ? D.green : D.muted}`,
                  }}
                >
                  <div style={{ fontSize: 12, color: D.heading }}>
                    "{m.query}"
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: m.waves_mentioned ? D.green : D.muted,
                    }}
                  >
                    {m.waves_mentioned
                      ? `✓ Mentioned${m.rank_position ? ` (rank ${m.rank_position})` : ""}`
                      : "— Not mentioned"}{" "}
                    · {m.llm_platform} · {m.check_date}
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      )}

      {subTab === "prospects" && <LinkBuildingBoard canRun={canRunSeoActions} />}
      {subTab === "agent" && <BacklinkAgentPanel />}
    </div>
  );
}

// =========================================================================
// LINK BUILDING BOARD — outbound prospect pipeline (Backlink Manager M1)
// =========================================================================
const PROSPECT_VIEWS = [
  { key: "all", label: "All", statuses: null },
  { key: "outreach", label: "Needs outreach", statuses: ["prospect", "contacted", "negotiating"] },
  { key: "placed", label: "In progress", statuses: ["placed"] },
  { key: "notindexed", label: "Live · not indexed", statuses: ["live"] },
  { key: "indexed", label: "Indexed", statuses: ["indexed"] },
  { key: "lost", label: "Lost", statuses: ["lost"] },
];

const PROSPECT_STATUS_COLOR = {
  prospect: D.muted,
  contacted: D.amber,
  negotiating: D.amber,
  placed: D.teal,
  live: D.green,
  indexed: D.green,
  lost: D.red,
  rejected: D.red,
};

function LinkBuildingBoard({ canRun }) {
  const [items, setItems] = useState(null);
  const [stats, setStats] = useState(null);
  const [view, setView] = useState("all");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ target_url: "", live_url: "", target_page: "", anchor_planned: "", link_type: "editorial", priority: "medium" });

  const load = () => {
    const cur = PROSPECT_VIEWS.find((v) => v.key === view);
    const qs = cur?.statuses?.length === 1 ? `?status=${cur.statuses[0]}` : "";
    const request = cur?.statuses?.length > 1
      ? Promise.all(cur.statuses.map((status) => adminFetch(`/admin/backlink-agent/prospects?status=${status}`)))
        .then((results) => {
          const seen = new Set();
          return results.flatMap((d) => d.items || []).filter((row) => {
            if (!row?.id || seen.has(row.id)) return false;
            seen.add(row.id);
            return true;
          });
        })
      : adminFetch(`/admin/backlink-agent/prospects${qs}`).then((d) => d.items || []);
    request
      .then((rows) => setItems(rows))
      .catch(() => setItems([]));
    adminFetch("/admin/backlink-agent/prospects/stats").then(setStats).catch(() => {});
  };

  useEffect(load, [view]);

  const runVerify = async () => {
    if (!canRun) return;
    setBusy(true);
    try { await adminPost("/admin/backlink-agent/prospects/verify", {}); } finally { setBusy(false); }
  };

  const recheck = async (id) => {
    setBusy(true);
    try { await adminPost(`/admin/backlink-agent/prospects/${id}/recheck`, {}); load(); } finally { setBusy(false); }
  };

  const addProspect = async () => {
    if (!form.target_page || (!form.target_url && !form.live_url)) return;
    setBusy(true);
    try {
      await adminPost("/admin/backlink-agent/prospects", form);
      setForm({ target_url: "", live_url: "", target_page: "", anchor_planned: "", link_type: "editorial", priority: "medium" });
      setAdding(false);
      load();
    } finally { setBusy(false); }
  };

  if (items === null) return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading link prospects...</div>;

  const inputStyle = { padding: "6px 10px", borderRadius: 6, border: `1px solid ${D.inputBorder}`, fontSize: 13, background: D.white, color: D.text };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* KPIs */}
      {stats && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            ["Prospects", stats.total],
            ["Placed", stats.byStatus?.placed || 0],
            ["Live", stats.byStatus?.live || 0],
            ["Indexed", stats.byStatus?.indexed || 0],
            ["Lost", stats.byStatus?.lost || 0],
            ["Indexing rate", `${stats.indexingRate || 0}%`],
          ].map(([label, val]) => (
            <div key={label} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: "10px 14px", minWidth: 96 }}>
              <div style={{ fontSize: 18, fontWeight: 600, color: D.heading }}>{val}</div>
              <div style={{ fontSize: 11, color: D.muted }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* View filters + actions */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {PROSPECT_VIEWS.map((v) => (
            <button key={v.key} onClick={() => setView(v.key)}
              style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12,
                background: view === v.key ? D.teal : D.bg, color: view === v.key ? D.white : D.muted, whiteSpace: "nowrap" }}>
              {v.label}
            </button>
          ))}
        </div>
        {canRun && (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setAdding((a) => !a)} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${D.teal}`, background: D.teal, color: D.white, fontSize: 12, cursor: "pointer" }}>
              + Add prospect
            </button>
            <button onClick={runVerify} disabled={busy} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${D.teal}`, background: "transparent", color: D.teal, fontSize: 12, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
              {busy ? "Verifying..." : "Verify now"}
            </button>
          </div>
        )}
      </div>

      {/* Add form */}
      {adding && canRun && (
        <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <input style={{ ...inputStyle, flex: "1 1 220px" }} placeholder="Prospect site/page URL (planned)" value={form.target_url} onChange={(e) => setForm({ ...form, target_url: e.target.value })} />
          <input style={{ ...inputStyle, flex: "1 1 220px" }} placeholder="Live URL — if link is already placed" value={form.live_url} onChange={(e) => setForm({ ...form, live_url: e.target.value })} />
          <input style={{ ...inputStyle, flex: "1 1 220px" }} placeholder="Our target page (money page URL)" value={form.target_page} onChange={(e) => setForm({ ...form, target_page: e.target.value })} />
          <input style={{ ...inputStyle, flex: "1 1 160px" }} placeholder="Planned anchor" value={form.anchor_planned} onChange={(e) => setForm({ ...form, anchor_planned: e.target.value })} />
          <select style={inputStyle} value={form.link_type} onChange={(e) => setForm({ ...form, link_type: e.target.value })}>
            {["editorial", "resource", "guest_post", "haro", "directory", "citation", "social"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select style={inputStyle} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {["high", "medium", "low"].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button onClick={addProspect} disabled={busy} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: D.green, color: D.white, fontSize: 12, cursor: "pointer" }}>Save</button>
        </div>
      )}

      {/* Table */}
      {items.length === 0 ? (
        <Card style={{ padding: 30, textAlign: "center" }}><div style={{ color: D.muted }}>No prospects in this view.</div></Card>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: "left", color: D.muted, borderBottom: `1px solid ${D.border}` }}>
                {["Target", "Our page", "Anchor", "Type", "Follow", "Indexed", "Status", "DR", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", fontWeight: 500, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} style={{ borderBottom: `1px solid ${D.border}`, color: D.text }}>
                  <td style={{ padding: "8px 10px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.live_url ? <a href={p.live_url} target="_blank" rel="noreferrer" style={{ color: D.teal }}>{p.target_domain}</a> : p.target_domain}
                  </td>
                  <td style={{ padding: "8px 10px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", color: D.muted }}>{(p.target_page || "").replace(/^https?:\/\/[^/]+/, "")}</td>
                  <td style={{ padding: "8px 10px" }}>{p.anchor_text || <span style={{ color: D.muted }}>{p.anchor_planned || "—"}</span>}</td>
                  <td style={{ padding: "8px 10px", color: D.muted }}>{p.link_type || "—"}</td>
                  <td style={{ padding: "8px 10px" }}>{p.is_dofollow == null ? "—" : p.is_dofollow ? <span style={{ color: D.green }}>dofollow</span> : <span style={{ color: D.amber }}>nofollow</span>}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <span style={{ color: p.indexing_status === "indexed" ? D.green : p.indexing_status === "not_checked" ? D.muted : D.amber }}>
                      {p.indexing_status === "not_checked" ? "—" : p.indexing_status}
                    </span>
                  </td>
                  <td style={{ padding: "8px 10px" }}><span style={{ color: PROSPECT_STATUS_COLOR[p.status] || D.muted, fontWeight: 500 }}>{p.status}</span></td>
                  <td style={{ padding: "8px 10px", color: D.muted }}>{p.domain_rating ?? "—"}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {p.live_url && <button onClick={() => recheck(p.id)} disabled={busy} style={{ padding: "3px 8px", borderRadius: 5, border: `1px solid ${D.border}`, background: "transparent", color: D.teal, fontSize: 11, cursor: "pointer" }}>Recheck</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  const [urlInput, setUrlInput] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [processing, setProcessing] = useState(false);
  const [addResult, setAddResult] = useState(null);

  const loadData = () => {
    Promise.all([
      adminFetch("/admin/backlink-agent/stats").catch(() => null),
      adminFetch("/admin/backlink-agent/queue?limit=50").catch(() => ({
        items: [],
      })),
      adminFetch("/admin/backlink-agent/profiles").catch(() => ({
        profiles: [],
      })),
      adminFetch("/admin/backlink-agent/targets").catch(() => ({
        targets: [],
      })),
    ]).then(([s, q, p, t]) => {
      setStats(s);
      setQueue(q.items || []);
      setProfiles(p.profiles || []);
      setTargets(t.targets || []);
      setLoading(false);
    });
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAddUrls = async () => {
    const urls = urlInput
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => (u.startsWith("http") ? u : `https://${u}`));
    if (urls.length === 0) return;
    const result = await adminPost("/admin/backlink-agent/queue", { urls });
    setAddResult(result);
    setUrlInput("");
    loadData();
  };

  const handleProcess = async () => {
    setProcessing(true);
    try {
      await adminPost("/admin/backlink-agent/process", { limit: 3 });
      setTimeout(() => {
        setProcessing(false);
        loadData();
      }, 3000);
    } catch {
      setProcessing(false);
    }
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
    await adminPost("/admin/backlink-agent/targets", {
      username: newTarget.trim(),
    });
    setNewTarget("");
    loadData();
  };

  const handleDeleteTarget = async (id) => {
    await adminFetch(`/admin/backlink-agent/targets/${id}`, {
      method: "DELETE",
    });
    loadData();
  };

  const handlePoll = async () => {
    await adminPost("/admin/backlink-agent/poll", {});
    loadData();
  };

  const handleVerifyEmails = async () => {
    await adminPost("/admin/backlink-agent/verify-emails", {});
    loadData();
  };

  const statusColor = {
    pending: D.muted,
    processing: D.teal,
    signup_complete: D.amber,
    verified: D.green,
    failed: D.red,
    skipped: "#475569",
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading backlink agent...
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Stats */}
      <div
        className="seo-kpi-grid-5"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 10,
        }}
      >
        {" "}
        <KpiCard label="Total Queued" value={stats?.total || 0} />{" "}
        <KpiCard label="Pending" value={stats?.pending || 0} color={D.muted} />{" "}
        <KpiCard
          label="Completed"
          value={stats?.completed || 0}
          color={D.amber}
        />{" "}
        <KpiCard
          label="Verified"
          value={stats?.verified || 0}
          color={D.green}
        />{" "}
        <KpiCard
          label="Success Rate"
          value={`${stats?.successRate || 0}%`}
          color={stats?.successRate >= 50 ? D.green : D.amber}
        />{" "}
      </div>
      {/* Controls */}
      <div style={{ display: "flex", gap: 8 }}>
        {" "}
        <button
          onClick={handleProcess}
          disabled={processing || (stats?.pending || 0) === 0}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: D.teal,
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            opacity: processing || !stats?.pending ? 0.5 : 1,
          }}
        >
          {processing
            ? "Processing..."
            : `Process Queue (${stats?.pending || 0})`}
        </button>{" "}
        <button
          onClick={handlePoll}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: `1px solid ${D.border}`,
            background: "#fff",
            color: D.text,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Poll X Targets
        </button>{" "}
        <button
          onClick={handleVerifyEmails}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: `1px solid ${D.border}`,
            background: "#fff",
            color: D.text,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Verify Emails
        </button>{" "}
        <button
          onClick={loadData}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: `1px solid ${D.border}`,
            background: "transparent",
            color: D.muted,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Refresh
        </button>{" "}
      </div>{" "}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* X Targets */}
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            X Targets
          </div>{" "}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {" "}
            <input
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              placeholder="@username"
              style={{
                flex: 1,
                padding: 10,
                background: D.bg,
                border: `1px solid ${D.border}`,
                borderRadius: 8,
                color: D.text,
                fontSize: 13,
                outline: "none",
              }}
            />{" "}
            <button
              onClick={handleAddTarget}
              style={{
                padding: "8px 18px",
                borderRadius: 8,
                border: "none",
                background: D.teal,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Add Target
            </button>{" "}
          </div>
          {targets.length === 0 ? (
            <div style={{ color: D.muted, fontSize: 13 }}>
              No X targets configured.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 8,
              }}
            >
              {targets.map((target) => (
                <div
                  key={target.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    background: D.bg,
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                  }}
                >
                  {" "}
                  <div style={{ minWidth: 0 }}>
                    {" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: D.heading,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      @{target.x_username}
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 11,
                        color: target.is_active ? D.green : D.muted,
                      }}
                    >
                      {target.is_active ? "active" : "inactive"}
                      {target.last_polled_at
                        ? ` · ${String(target.last_polled_at).slice(0, 10)}`
                        : ""}
                    </div>{" "}
                  </div>{" "}
                  <button
                    onClick={() => handleDeleteTarget(target.id)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: D.red,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    Remove
                  </button>{" "}
                </div>
              ))}
            </div>
          )}
        </Card>
        {/* Manual URL Input */}
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Add URLs
          </div>{" "}
          <textarea
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Paste URLs here, one per line..."
            rows={4}
            style={{
              width: "100%",
              padding: 10,
              background: D.bg,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              color: D.text,
              fontSize: 13,
              fontFamily: "Roboto, Arial, sans-serif",
              resize: "vertical",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: 8,
            }}
          />{" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            {" "}
            <span style={{ fontSize: 12, color: D.muted }}>
              {urlInput.split("\n").filter((u) => u.trim()).length} URLs
              detected
            </span>{" "}
            <button
              onClick={handleAddUrls}
              style={{
                padding: "8px 18px",
                borderRadius: 8,
                border: "none",
                background: D.teal,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Add to Queue
            </button>{" "}
          </div>
          {addResult && (
            <div style={{ marginTop: 8, fontSize: 12, color: D.green }}>
              Added {addResult.added}, skipped {addResult.skipped}
              {addResult.duplicates?.length > 0
                ? ` (dupes: ${addResult.duplicates.join(", ")})`
                : ""}
            </div>
          )}
        </Card>
        {/* Queue Table */}
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Queue ({queue.length})
          </div>{" "}
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            {queue.length === 0 ? (
              <div
                style={{
                  color: D.muted,
                  fontSize: 13,
                  padding: 20,
                  textAlign: "center",
                }}
              >
                No URLs in queue. Add some above or poll X feeds.
              </div>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}
              >
                {" "}
                <thead>
                  {" "}
                  <tr style={{ borderBottom: `1px solid ${D.border}` }}>
                    {" "}
                    <th
                      style={{
                        padding: "8px 10px",
                        textAlign: "left",
                        color: D.muted,
                        fontSize: 11,
                        textTransform: "uppercase",
                      }}
                    >
                      Domain
                    </th>{" "}
                    <th
                      style={{
                        padding: "8px 10px",
                        textAlign: "left",
                        color: D.muted,
                        fontSize: 11,
                        textTransform: "uppercase",
                      }}
                    >
                      Source
                    </th>{" "}
                    <th
                      style={{
                        padding: "8px 10px",
                        textAlign: "left",
                        color: D.muted,
                        fontSize: 11,
                        textTransform: "uppercase",
                      }}
                    >
                      Status
                    </th>{" "}
                    <th
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        color: D.muted,
                        fontSize: 11,
                        textTransform: "uppercase",
                      }}
                    >
                      Actions
                    </th>{" "}
                  </tr>{" "}
                </thead>{" "}
                <tbody>
                  {queue.map((item) => (
                    <tr
                      key={item.id}
                      style={{ borderBottom: `1px solid ${D.border}33` }}
                    >
                      {" "}
                      <td style={{ padding: "8px 10px", color: D.text }}>
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: D.teal, textDecoration: "none" }}
                        >
                          {item.domain}
                        </a>
                      </td>{" "}
                      <td style={{ padding: "8px 10px", color: D.muted }}>
                        {item.source}
                      </td>{" "}
                      <td style={{ padding: "8px 10px" }}>
                        {" "}
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            padding: "2px 8px",
                            borderRadius: 6,
                            background:
                              (statusColor[item.status] || D.muted) + "22",
                            color: statusColor[item.status] || D.muted,
                          }}
                        >
                          {item.status}
                        </span>
                        {item.error_message && (
                          <div
                            style={{ fontSize: 10, color: D.red, marginTop: 2 }}
                          >
                            {item.error_message.substring(0, 60)}
                          </div>
                        )}
                      </td>{" "}
                      <td style={{ padding: "8px 10px", textAlign: "right" }}>
                        {(item.status === "failed" ||
                          item.status === "skipped") && (
                          <button
                            onClick={() => handleRetry(item.id)}
                            style={{
                              padding: "3px 8px",
                              borderRadius: 4,
                              border: `1px solid ${D.teal}`,
                              background: "transparent",
                              color: D.teal,
                              fontSize: 10,
                              cursor: "pointer",
                              marginRight: 4,
                            }}
                          >
                            Retry
                          </button>
                        )}
                        {(item.status === "pending" ||
                          item.status === "failed") && (
                          <button
                            onClick={() => handleSkip(item.id)}
                            style={{
                              padding: "3px 8px",
                              borderRadius: 4,
                              border: `1px solid ${D.border}`,
                              background: "transparent",
                              color: D.muted,
                              fontSize: 10,
                              cursor: "pointer",
                            }}
                          >
                            Skip
                          </button>
                        )}
                      </td>{" "}
                    </tr>
                  ))}
                </tbody>{" "}
              </table>
            )}
          </div>{" "}
        </Card>
        {/* Profiles */}
        {profiles.length > 0 && (
          <Card>
            {" "}
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: D.heading,
                marginBottom: 12,
              }}
            >
              Completed Profiles ({profiles.length})
            </div>{" "}
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {profiles.map((p) => (
                <div
                  key={p.id}
                  style={{
                    padding: "8px 0",
                    borderBottom: `1px solid ${D.border}33`,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  {" "}
                  <div>
                    {" "}
                    <div style={{ fontSize: 13, color: D.text }}>
                      {p.domain || p.site_url}
                    </div>
                    {p.profile_url && (
                      <a
                        href={p.profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: 11,
                          color: D.teal,
                          textDecoration: "none",
                        }}
                      >
                        View Profile
                      </a>
                    )}
                  </div>{" "}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: 6,
                      background:
                        p.queue_status === "verified"
                          ? D.green + "22"
                          : D.amber + "22",
                      color: p.queue_status === "verified" ? D.green : D.amber,
                    }}
                  >
                    {p.queue_status === "verified"
                      ? "VERIFIED"
                      : "PENDING VERIFY"}
                  </span>{" "}
                </div>
              ))}
            </div>{" "}
          </Card>
        )}
      </div>{" "}
    </div>
  );
}

function ContentQATab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/seo/qa")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading QA scores...
      </div>
    );
  if (!data || data.total === 0)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>
          No QA scores yet. Run Content QA to populate scored URLs, fix-first
          items, and publish readiness.
        </div>
      </Card>
    );
  const scores = data.scores || [];
  const fixFirst = data.fixFirst || [];
  const gc = { A: D.green, B: D.teal, C: D.amber, D: D.orange, F: D.red };
  const avgScore = scores.length
    ? Math.round(
        scores.reduce((sum, row) => sum + Number(row.total_score || 0), 0) /
          scores.length,
      )
    : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        className="seo-kpi-grid-4"
        style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}
      >
        <KpiCard label="Scored URLs" value={fmt(data.total)} />
        <KpiCard
          label="Avg Latest 50"
          value={avgScore}
          color={avgScore >= 38 ? D.green : avgScore >= 30 ? D.amber : D.red}
        />
        <KpiCard
          label="Publish Ready"
          value={(data.gradeDistribution?.A || 0) + (data.gradeDistribution?.B || 0)}
          color={D.green}
        />
        <KpiCard
          label="Top Fixes"
          value={fixFirst.length}
          color={fixFirst.length ? D.red : D.green}
        />
      </div>

      <div
        className="seo-kpi-grid-5"
        style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}
      >
        {Object.entries(data.gradeDistribution || {}).map(([g, c]) => (
          <KpiCard key={g} label={`Grade ${g}`} value={c} color={gc[g]} />
        ))}
      </div>

      {fixFirst.length > 0 && (
        <Card>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Top Fixes
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>URL</th>
                  <th style={thR}>Score</th>
                  <th style={thStyle}>Grade</th>
                  <th style={thStyle}>Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {fixFirst.map((row) => (
                  <tr key={row.id || row.blog_post_id || row.url}>
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: "inherit",
                        maxWidth: 420,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={row.url}
                    >
                      {row.url || `Blog post ${row.blog_post_id}`}
                    </td>
                    <td style={{ ...tdR, color: gc[row.grade] || D.text }}>
                      {row.total_score}/50
                    </td>
                    <td style={tdStyle}>{row.grade || "—"}</td>
                    <td style={{ ...tdStyle, fontFamily: "inherit" }}>
                      {row.recommendation || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {scores.length > 0 && (
        <Card>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Latest Scores
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={thStyle}>URL</th>
                  <th style={thR}>Total</th>
                  <th style={thR}>Technical</th>
                  <th style={thR}>On Page</th>
                  <th style={thR}>Local</th>
                  <th style={thStyle}>Grade</th>
                </tr>
              </thead>
              <tbody>
                {scores.slice(0, 20).map((row) => (
                  <tr key={`score-${row.id || row.blog_post_id || row.url}`}>
                    <td
                      style={{
                        ...tdStyle,
                        fontFamily: "inherit",
                        maxWidth: 420,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={row.url}
                    >
                      {row.url || `Blog post ${row.blog_post_id}`}
                    </td>
                    <td style={tdR}>{row.total_score}/50</td>
                    <td style={tdR}>{row.technical_score ?? "—"}</td>
                    <td style={tdR}>{row.onpage_score ?? "—"}</td>
                    <td style={tdR}>{row.local_score ?? "—"}</td>
                    <td style={{ ...tdStyle, color: gc[row.grade] || D.text }}>
                      {row.grade || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function AIOverviewTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/seo/ai-overview")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading...
      </div>
    );
  if (!data)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>No AI Overview data yet.</div>
      </Card>
    );
  return (
    <div
      className="seo-kpi-grid-4"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 12,
      }}
    >
      {" "}
      <KpiCard label="Tracked" value={data.total || 0} />{" "}
      <KpiCard label="With AIO" value={data.withAIO || 0} color={D.purple} />{" "}
      <KpiCard
        label="Waves Cited"
        value={data.wavesCited || 0}
        color={D.green}
      />{" "}
      <KpiCard
        label="GEO Score"
        value={`${data.geoScore || 0}%`}
        color={data.geoScore >= 30 ? D.green : D.amber}
      />{" "}
    </div>
  );
}

function FunnelTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/seo/funnel?days=30")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading...
      </div>
    );
  if (!data)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>No funnel data yet.</div>
      </Card>
    );
  const o = data.organic || {};
  return (
    <div
      className="seo-kpi-grid-4"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 12,
      }}
    >
      {" "}
      <KpiCard
        label="Impressions"
        value={(o.impressions || 0).toLocaleString()}
      />{" "}
      <KpiCard
        label="Clicks"
        value={(o.clicks || 0).toLocaleString()}
        sub={{ text: `${o.ctr || 0}% CTR` }}
      />{" "}
      <KpiCard
        label="Sitewide Booked"
        value={data.estimates?.booked || 0}
        color={D.green}
      />{" "}
      <KpiCard
        label="Sitewide Revenue"
        value={fmtMoney(data.revenue || 0)}
        color={D.green}
        sub={{ text: "correlated, not attributed" }}
      />{" "}
    </div>
  );
}

// ── By Site — inbound calls + leads per fleet domain ──
function BySiteTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  useEffect(() => {
    setLoading(true);
    adminFetch(`/admin/seo/site-rollup?days=${days}`)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [days]);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading site rollup...
      </div>
    );
  if (!data)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>No rollup data yet.</div>
      </Card>
    );
  const t = data.totals || {};
  const sites = data.sites || [];
  const nonSite = data.nonSiteLines || [];
  const other = data.otherSources || [];
  const un = data.unattributed || {};
  const num = (v) => Number(v || 0).toLocaleString();
  const cell = (v) => (v ? num(v) : "—");
  const hubChip = (
    <span
      style={{
        fontSize: 9,
        padding: "1px 5px",
        borderRadius: 3,
        background: D.teal + "22",
        color: D.teal,
        marginLeft: 6,
      }}
    >
      HUB
    </span>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="seo-analytics-period" style={{ display: "flex", gap: 8 }}>
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "none",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              background: days === d ? D.teal : D.card,
              color: days === d ? D.white : D.muted,
            }}
          >
            {d}d
          </button>
        ))}
      </div>
      <div
        className="seo-kpi-grid-4"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
        }}
      >
        <KpiCard
          label="Inbound Calls"
          value={num(t.calls)}
          sub={{
            text: `${num(t.missedCalls)} missed`,
            color: t.missedCalls > 0 ? D.amber : undefined,
          }}
        />
        <KpiCard
          label="Leads"
          value={num(t.leads)}
          sub={{ text: `${num(t.won)} won`, color: D.green }}
        />
        <KpiCard
          label="Site Calls"
          value={num(t.siteCalls)}
          sub={{ text: "attributed to a fleet domain" }}
        />
        <KpiCard
          label="Site Leads"
          value={num(t.siteLeads)}
          sub={{ text: "attributed to a fleet domain" }}
        />
      </div>
      <Card>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 12,
          }}
        >
          Calls + Leads by Site
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Site</th>
                <th style={thStyle}>Lane</th>
                <th style={thR}>Calls</th>
                <th style={thR}>Missed</th>
                <th style={thR}>Form Leads</th>
                <th style={thR}>Call Leads</th>
                <th style={thR}>Leads</th>
                <th style={thR}>Won</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.domain}>
                  <td style={{ ...tdStyle, fontFamily: "inherit" }}>
                    {s.domain}
                    {s.kind === "hub" && hubChip}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: "inherit", color: D.muted }}>
                    {s.lane}
                  </td>
                  <td style={tdR}>{cell(s.calls)}</td>
                  <td style={{ ...tdR, color: s.missedCalls ? D.amber : D.text }}>
                    {cell(s.missedCalls)}
                  </td>
                  <td style={tdR}>{cell(s.formLeads)}</td>
                  <td style={tdR}>{cell(s.callLeads)}</td>
                  <td style={tdR}>{cell(s.leads)}</td>
                  <td style={{ ...tdR, color: s.won ? D.green : D.text }}>
                    {cell(s.won)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: D.muted, marginTop: 10 }}>
          Calls attribute by tracking number; leads by lead source. Call Leads
          are calls that became pipeline entries, so they overlap with Calls.
        </div>
      </Card>
      {(nonSite.length > 0 || other.length > 0 || un.leads > 0) && (
        <div
          className="seo-kpi-grid-3"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            alignItems: "start",
          }}
        >
          {nonSite.length > 0 && (
            <Card>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 12,
                }}
              >
                Non-Site Lines
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Line</th>
                      <th style={thR}>Calls</th>
                      <th style={thR}>Missed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nonSite.map((l) => (
                      <tr key={l.label}>
                        <td style={{ ...tdStyle, fontFamily: "inherit" }}>
                          {l.label}
                        </td>
                        <td style={tdR}>{cell(l.calls)}</td>
                        <td style={{ ...tdR, color: l.missedCalls ? D.amber : D.text }}>
                          {cell(l.missedCalls)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          {(other.length > 0 || un.leads > 0) && (
            <Card>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 12,
                }}
              >
                Non-Site Lead Sources
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Source</th>
                      <th style={thR}>Leads</th>
                      <th style={thR}>Won</th>
                    </tr>
                  </thead>
                  <tbody>
                    {other.map((s) => (
                      <tr key={s.name}>
                        <td style={{ ...tdStyle, fontFamily: "inherit" }}>
                          {s.name}
                        </td>
                        <td style={tdR}>{cell(s.leads)}</td>
                        <td style={{ ...tdR, color: s.won ? D.green : D.text }}>
                          {cell(s.won)}
                        </td>
                      </tr>
                    ))}
                    {un.leads > 0 && (
                      <tr>
                        <td
                          style={{
                            ...tdStyle,
                            fontFamily: "inherit",
                            color: D.muted,
                          }}
                        >
                          No source attributed
                        </td>
                        <td style={tdR}>{cell(un.leads)}</td>
                        <td style={{ ...tdR, color: un.won ? D.green : D.text }}>
                          {cell(un.won)}
                        </td>
                      </tr>
                    )}
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

function CitationsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch("/admin/seo/citations")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading...
      </div>
    );
  if (!data)
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ color: D.muted }}>No citations.</div>
      </Card>
    );
  const bs = data.byStatus || {};
  const sc = {
    active: D.green,
    inconsistent: D.red,
    missing: D.amber,
    claimed: D.teal,
    unchecked: D.muted,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {" "}
      <div
        className="seo-kpi-grid-5"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 12,
        }}
      >
        {" "}
        <KpiCard label="Active" value={bs.active || 0} color={D.green} />{" "}
        <KpiCard
          label="Inconsistent"
          value={bs.inconsistent || 0}
          color={D.red}
        />{" "}
        <KpiCard label="Missing" value={bs.missing || 0} color={D.amber} />{" "}
        <KpiCard label="Claimed" value={bs.claimed || 0} color={D.teal} />{" "}
        <KpiCard label="Unchecked" value={bs.unchecked || 0} />{" "}
      </div>{" "}
      <Card>
        {(data.citations || []).map((c, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 0",
              borderBottom: `1px solid ${D.border}`,
            }}
          >
            {" "}
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: sc[c.status] || D.muted,
              }}
            />{" "}
            <div style={{ flex: 1, fontSize: 13, color: D.heading }}>
              {c.directory_name}
            </div>{" "}
            <span
              style={{
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 4,
                background: (sc[c.status] || D.muted) + "22",
                color: sc[c.status] || D.muted,
                textTransform: "uppercase",
                fontWeight: 700,
              }}
            >
              {c.status}
            </span>{" "}
          </div>
        ))}
      </Card>{" "}
    </div>
  );
}

// ── GA4 Analytics Tab ──
function AnalyticsTab() {
  const [overview, setOverview] = useState(null);
  const [traffic, setTraffic] = useState(null);
  const [pages, setPages] = useState(null);
  const [localPerformance, setLocalPerformance] = useState(null);
  const [dataManager, setDataManager] = useState(null);
  const [dataManagerBusy, setDataManagerBusy] = useState(null);
  const [dataManagerResult, setDataManagerResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      adminFetch(`/admin/analytics/overview?period=${days}`).catch((e) => ({ error: e.message })),
      adminFetch(`/admin/analytics/sources?period=${days}`).catch((e) => ({ data: [], error: e.message })),
      adminFetch(`/admin/analytics/landing-pages?period=${days}`).catch((e) => ({ data: [], error: e.message })),
      adminFetch(`/admin/analytics/local-performance?period=${days}`).catch((e) => ({ error: e.message })),
      adminFetch(`/admin/analytics/data-manager/readiness?period=${days}`).catch((e) => ({ error: e.message })),
    ])
      .then(([o, t, p, l, dm]) => {
        setOverview(o);
        setTraffic(t);
        setPages(p);
        setLocalPerformance(l);
        setDataManager(dm);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [days]);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading analytics...
      </div>
    );

  const totals = overview?.totals || overview?.data || {};
  const data = {
    sessions: totals.sessions,
    users: totals.users,
    newUsers: totals.newUsers,
    bounceRate: totals.bounceRate,
    avgSessionDuration: totals.avgSessionDuration,
    pageviewsPerSession:
      totals.pageviewsPerSession ||
      (totals.sessions ? totals.pageviews / totals.sessions : null),
  };
  const sources = traffic?.data || [];
  const topPages = pages?.data || [];
  const local = localPerformance || {};
  const blended = local.blended || {};
  const localGbp = blended.gbp || {};
  const localGa4 = blended.ga4Website || {};
  const localCrm = blended.crm || {};
  const readiness = blended.dataManagerReadiness || {};
  const dm = dataManager || {};
  const dmConversions = dm.conversions || {};
  const dmQualified = dmConversions.qualified_lead || {};
  const dmCompleted = dmConversions.completed_job_revenue || {};
  const profiles = Array.isArray(local.profiles) ? local.profiles : [];
  const setupLinks = Array.isArray(local.setup?.utmWebsiteLinks) ? local.setup.utmWebsiteLinks : [];
  const localWarnings = Array.isArray(local.warnings) ? local.warnings : [];
  const dataManagerWarnings = Array.isArray(dm.warnings) ? dm.warnings : [];
  const analyticsNotices = [
    ...(overview?.configured === false
      ? [{
        title: "Google Analytics access",
        message: "Set GOOGLE_SERVICE_ACCOUNT_JSON and GA4_PROPERTY_ID, then grant the service account Viewer access in GA4.",
      }]
      : []),
    ...(overview?.configured !== false && overview?.error
      ? [{ title: "Google Analytics access", message: overview.error }]
      : []),
    ...localWarnings.map((warning) => ({
      title: "Local performance data",
      message: `${warning?.source || "source"}: ${warning?.message || "Unavailable"}`,
    })),
    ...(dm.error ? [{ title: "Google Ads Data Manager", message: dm.error }] : []),
    ...dataManagerWarnings.map((warning) => ({
      title: "Google Ads Data Manager",
      message: `${warning?.source || "source"}: ${warning?.message || "Unavailable"}`,
    })),
  ];
  const fmt = (v) => (v != null ? Number(v).toLocaleString() : "—");
  const money = (v) => (v != null ? fmtMoney(v) : "—");
  const pct = (v) => (v != null ? `${(Number(v) * 100).toFixed(1)}%` : "—");
  const dur = (v) => {
    if (!v) return "—";
    const s = Math.round(Number(v));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const validateDataManager = (conversionType) => {
    setDataManagerBusy(conversionType);
    setDataManagerResult(null);
    adminPost("/admin/analytics/data-manager/upload", {
      conversionType,
      period: days,
      limit: 100,
      validateOnly: true,
    })
      .then((result) => setDataManagerResult(result))
      .catch((e) => setDataManagerResult({ synced: false, conversionType, error: e.message }))
      .finally(() => setDataManagerBusy(null));
  };
  const dmStatus = (config) => {
    if (config?.configured) return dm.liveUploadsAllowed ? "Live-ready" : "Validate-only";
    if (config?.missing?.length) return "Needs config";
    return "Checking";
  };
  const dmTone = (config) => (config?.configured ? D.green : D.amber);
  const dmMetric = (config, key) => fmt(config?.candidates?.[key] || 0);
  const dmResultText = dataManagerResult
    ? `${dataManagerResult.conversionType === "qualified_lead" ? "Qualified Lead" : "Completed Revenue"}: ${
      dataManagerResult.synced
        ? `${fmt(dataManagerResult.sent || 0)} event${Number(dataManagerResult.sent || 0) === 1 ? "" : "s"} validated`
        : dataManagerResult.error || "Validation failed"
    }`
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Period selector */}
      <div className="seo-analytics-period" style={{ display: "flex", gap: 8 }}>
        {[7, 14, 28, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "none",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              background: days === d ? D.teal : D.card,
              color: days === d ? D.white : D.muted,
            }}
          >
            {d}d
          </button>
        ))}
      </div>
      {analyticsNotices.length > 0 && (
        <Card style={{ padding: 16, borderColor: D.amber }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
            Analytics data notices
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {analyticsNotices.map((notice, idx) => (
              <div key={`${notice.title}-${idx}`} style={{ fontSize: 12, color: D.muted, lineHeight: 1.5 }}>
                <strong style={{ color: D.heading }}>{notice.title}:</strong> {notice.message}
              </div>
            ))}
          </div>
        </Card>
      )}
      {profiles.length > 0 && (
        <>
          <div
            className="seo-kpi-grid-3"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 12,
            }}
          >
            <KpiCard
              label="GBP Interactions"
              value={fmt(localGbp.interactions)}
              sub={{ text: `${fmt(localGbp.calls)} calls · ${fmt(localGbp.directionRequests)} directions` }}
            />
            <KpiCard
              label="GBP Website Clicks"
              value={fmt(localGbp.websiteClicks)}
              sub={{ text: "4-profile blended total" }}
            />
            <KpiCard
              label="GBP UTM Sessions"
              value={fmt(localGa4.sessions)}
              sub={{ text: `${fmt(localGa4.conversions)} GA4 key events` }}
            />
            <KpiCard
              label="GBP CRM Revenue"
              value={money(localCrm.acceptedEstimateRevenue)}
              sub={{ text: `${fmt(localCrm.leads)} leads · ${fmt(localCrm.bookedJobs)} booked` }}
            />
          </div>
          <Card>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                alignItems: "flex-start",
                marginBottom: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
                  Local Performance By Profile
                </div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                  Native GBP totals stay blended in GA4; profile rows use Waves GBP sync, UTMs, and CRM attribution.
                </div>
              </div>
              <div style={{ fontSize: 12, color: D.muted, fontFamily: MONO }}>
                {fmt(readiness.eligible)}/{fmt(readiness.leads)} upload-ready leads
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Profile</th>
                    <th style={thR}>GBP Clicks</th>
                    <th style={thR}>GA4 Sessions</th>
                    <th style={thR}>Leads</th>
                    <th style={thR}>Booked</th>
                    <th style={thR}>Revenue</th>
                    <th style={thR}>Upload Ready</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((profile) => (
                    <tr key={profile.id}>
                      <td style={{ ...tdStyle, fontFamily: "inherit" }}>
                        <div style={{ fontWeight: 700, color: D.heading }}>{profile.name}</div>
                        <a
                          href={profile.trackingUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: "block",
                            marginTop: 4,
                            fontSize: 11,
                            color: D.muted,
                            textDecoration: "none",
                            maxWidth: 320,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {profile.trackingUrl}
                        </a>
                      </td>
                      <td style={tdR}>{fmt(profile.gbp?.websiteClicks)}</td>
                      <td style={tdR}>{fmt(profile.ga4?.sessions)}</td>
                      <td style={tdR}>{fmt(profile.crm?.leads)}</td>
                      <td style={tdR}>{fmt(profile.crm?.bookedJobs)}</td>
                      <td style={tdR}>{money(profile.crm?.acceptedEstimateRevenue)}</td>
                      <td style={tdR}>{fmt(profile.crm?.dataManagerEligible)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card style={{ padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
              GA4 And Google Ads Setup
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
                marginTop: 12,
              }}
            >
              <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>
                <strong>GA4 GBP link</strong>
                <br />
                <span style={{ color: D.muted }}>
                  Link all 4 profiles in GA4 Admin. Native GBP metrics are aggregate-only.
                </span>
              </div>
              <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>
                <strong>GBP website URLs</strong>
                <br />
                <span style={{ color: D.muted }}>
                  {setupLinks.length} tagged links configured for per-profile website attribution.
                </span>
              </div>
              <div style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>
                <strong>Ads feedback loop</strong>
                <br />
                <span style={{ color: D.muted }}>
                  {dmStatus(dmCompleted)} · {dmMetric(dmCompleted, "eligible")} completed-revenue events ready
                </span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                  <button
                    type="button"
                    onClick={() => validateDataManager("qualified_lead")}
                    disabled={!!dataManagerBusy || !dmQualified?.configured}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 10px",
                      borderRadius: 8,
                      border: `1px solid ${D.border}`,
                      background: dmQualified?.configured ? D.card : D.bg,
                      color: dmQualified?.configured ? D.heading : D.muted,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: dmQualified?.configured && !dataManagerBusy ? "pointer" : "not-allowed",
                    }}
                  >
                    <UploadCloud size={14} />
                    {dataManagerBusy === "qualified_lead" ? "Validating" : "Validate leads"}
                  </button>
                  <button
                    type="button"
                    onClick={() => validateDataManager("completed_job_revenue")}
                    disabled={!!dataManagerBusy || !dmCompleted?.configured}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 10px",
                      borderRadius: 8,
                      border: `1px solid ${D.border}`,
                      background: dmCompleted?.configured ? D.card : D.bg,
                      color: dmCompleted?.configured ? D.heading : D.muted,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: dmCompleted?.configured && !dataManagerBusy ? "pointer" : "not-allowed",
                    }}
                  >
                    <UploadCloud size={14} />
                    {dataManagerBusy === "completed_job_revenue" ? "Validating" : "Validate revenue"}
                  </button>
                </div>
              </div>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 12,
                marginTop: 14,
                paddingTop: 12,
                borderTop: `1px solid ${D.border}`,
              }}
            >
              {[
                ["Qualified Lead", dmQualified],
                ["Completed Revenue", dmCompleted],
              ].map(([label, config]) => (
                <div key={label} style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <strong>{label}</strong>
                    <span style={{
                      color: dmTone(config),
                      fontSize: 11,
                      fontWeight: 800,
                      textTransform: "uppercase",
                    }}>
                      {dmStatus(config)}
                    </span>
                  </div>
                  <div style={{ color: D.muted, marginTop: 4 }}>
                    {dmMetric(config, "eligible")} ready · {dmMetric(config, "alreadySent")} sent · {dmMetric(config, "missingMatchKeys")} missing match keys
                  </div>
                  {config?.missing?.length > 0 && (
                    <div style={{ color: D.amber, marginTop: 4 }}>
                      Missing {config.missing.join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {dmResultText && (
              <div style={{
                marginTop: 12,
                fontSize: 12,
                color: dataManagerResult?.synced ? D.green : D.red,
                fontWeight: 700,
              }}>
                {dmResultText}
              </div>
            )}
          </Card>
        </>
      )}
      {/* KPI Row */}
      <div
        className="seo-kpi-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        {[
          { label: "Sessions", value: fmt(data.sessions) },
          { label: "Users", value: fmt(data.users) },
          { label: "New Users", value: fmt(data.newUsers) },
        ].map((k) => (
          <KpiCard key={k.label} label={k.label} value={k.value} />
        ))}
      </div>{" "}
      <div
        className="seo-kpi-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        {[
          {
            label: "Bounce Rate",
            value: pct(data.bounceRate),
            color:
              data.bounceRate > 0.6
                ? D.red
                : data.bounceRate > 0.4
                  ? D.amber
                  : D.green,
          },
          { label: "Avg Session", value: dur(data.avgSessionDuration) },
          {
            label: "Pages / Session",
            value: data.pageviewsPerSession
              ? Number(data.pageviewsPerSession).toFixed(1)
              : "—",
          },
        ].map((k) => (
          <KpiCard
            key={k.label}
            label={k.label}
            value={k.value}
            color={k.color}
          />
        ))}
      </div>
      {/* Traffic Sources */}
      {sources.length > 0 && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Traffic Sources
          </div>{" "}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {sources.map((s, i) => {
              const totalSessions = sources.reduce(
                (sum, x) => sum + (parseInt(x.sessions) || 0),
                0,
              );
              const pctOfTotal = totalSessions
                ? (((parseInt(s.sessions) || 0) / totalSessions) * 100).toFixed(
                    1,
                  )
                : 0;
              const srcColor =
                {
                  organic: D.green,
                  paid: D.amber,
                  direct: D.teal,
                  referral: D.purple,
                  social: "#ec4899",
                }[s.source?.toLowerCase()] || D.muted;
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    background: D.bg,
                    borderRadius: 8,
                  }}
                >
                  {" "}
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: srcColor,
                      flexShrink: 0,
                    }}
                  />{" "}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: D.heading,
                        fontWeight: 500,
                      }}
                    >
                      {s.source || "unknown"}
                      {s.medium ? ` / ${s.medium}` : ""}
                    </div>{" "}
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: D.heading,
                      fontFamily: MONO,
                    }}
                  >
                    {fmt(s.sessions)}
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 11,
                      color: D.muted,
                      fontFamily: MONO,
                      width: 50,
                      textAlign: "right",
                    }}
                  >
                    {pctOfTotal}%
                  </div>{" "}
                </div>
              );
            })}
          </div>{" "}
        </Card>
      )}
      {/* Top Pages */}
      {topPages.length > 0 && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Top Landing Pages
          </div>{" "}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {" "}
            <div
              className="seo-top-pages-header"
              style={{
                display: "flex",
                padding: "0 12px 8px",
                fontSize: 10,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {" "}
              <div style={{ flex: 1 }}>Page</div>{" "}
              <div style={{ width: 70, textAlign: "right" }}>Sessions</div>{" "}
              <div style={{ width: 70, textAlign: "right" }}>Bounce</div>{" "}
              <div style={{ width: 70, textAlign: "right" }}>Avg Time</div>{" "}
            </div>
            {topPages.slice(0, 20).map((p, i) => (
              <div
                key={i}
                className="seo-top-pages-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 12px",
                  background: i % 2 === 0 ? D.bg : "transparent",
                  borderRadius: 6,
                }}
              >
                {" "}
                <div
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: D.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    wordBreak: "break-all",
                  }}
                >
                  {p.landingPage || p.page || p.pagePath}
                </div>{" "}
                <div
                  style={{
                    width: 70,
                    textAlign: "right",
                    fontSize: 12,
                    fontWeight: 600,
                    color: D.heading,
                    fontFamily: MONO,
                    flexShrink: 0,
                  }}
                >
                  {fmt(p.sessions || p.pageviews)}
                </div>{" "}
                <div
                  style={{
                    width: 70,
                    textAlign: "right",
                    fontSize: 12,
                    color: p.bounceRate > 0.6 ? D.red : D.muted,
                    fontFamily: MONO,
                    flexShrink: 0,
                  }}
                >
                  {pct(p.bounceRate)}
                </div>{" "}
                <div
                  style={{
                    width: 70,
                    textAlign: "right",
                    fontSize: 12,
                    color: D.muted,
                    fontFamily: MONO,
                    flexShrink: 0,
                  }}
                >
                  {dur(p.avgSessionDuration)}
                </div>{" "}
              </div>
            ))}
          </div>{" "}
        </Card>
      )}
    </div>
  );
}

function SiteAuditTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState("all"); // all, critical, warning, healthy
  const [expandedPage, setExpandedPage] = useState(null);
  const canRunSeoActions = isAdminUser();

  useEffect(() => {
    adminFetch("/admin/seo/audit")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const runAudit = async () => {
    if (!canRunSeoActions) return;
    setRunning(true);
    try {
      await adminPost("/admin/seo/audit/run", {});
      const d = await adminFetch("/admin/seo/audit");
      setData(d);
    } catch {
      // Keep current dashboard data visible; adminFetch has already rejected.
    } finally {
      setRunning(false);
    }
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading site audit...
      </div>
    );
  if (!data?.hasData)
    return (
      <Card style={{ textAlign: "center", padding: 60 }}>
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 8,
          }}
        >
          No Audit Data Yet
        </div>{" "}
        {canRunSeoActions && (
          <button
            onClick={runAudit}
            disabled={running}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: D.teal,
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              opacity: running ? 0.5 : 1,
            }}
          >
            {running ? "Auditing..." : "Run Site Audit"}
          </button>
        )}{" "}
      </Card>
    );

  const run = data.latestRun || {};
  const pages = data.pages || [];
  const issues = data.issues || [];
  const history = data.history || [];
  const scoreColor = (s) => (s >= 80 ? D.green : s >= 50 ? D.amber : D.red);
  const severityColor = {
    critical: D.red,
    warning: D.amber,
    info: D.muted,
    healthy: D.green,
  };

  const getPageStatus = (p) => {
    if (p.issue_count_critical > 0) return "critical";
    if (p.issue_count_warning > 0) return "warning";
    return "healthy";
  };

  const parseAuditIssues = (value) => {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const filteredPages = pages.filter((p) => {
    if (filter === "all") return true;
    return getPageStatus(p) === filter;
  });

  const shortUrl = (url) => {
    try {
      return new URL(url).pathname || "/";
    } catch {
      return url;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* KPI Row */}
      <div
        className="seo-audit-kpi-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
        }}
      >
        {" "}
        <Card style={{ padding: 16, textAlign: "center" }}>
          {" "}
          <div style={{ fontSize: 11, color: D.muted }}>
            Site Health Score
          </div>{" "}
          <div
            style={{
              fontSize: 36,
              fontWeight: 800,
              color: scoreColor(parseFloat(run.avg_health_score || 0)),
              fontFamily: MONO,
            }}
          >
            {Math.round(run.avg_health_score || 0)}
          </div>{" "}
          <div style={{ fontSize: 10, color: D.muted }}>
            {run.pages_crawled || 0} pages crawled
          </div>{" "}
        </Card>
        {[
          {
            label: "Healthy",
            key: "healthy",
            count: run.pages_healthy || 0,
            color: D.green,
          },
          {
            label: "Warning",
            key: "warning",
            count: run.pages_warning || 0,
            color: D.amber,
          },
          {
            label: "Critical",
            key: "critical",
            count: run.pages_critical || 0,
            color: D.red,
          },
        ].map((s) => (
          <Card
            key={s.key}
            onClick={() => setFilter(filter === s.key ? "all" : s.key)}
            style={{
              padding: 16,
              textAlign: "center",
              cursor: "pointer",
              border:
                filter === s.key
                  ? `2px solid ${s.color}`
                  : `1px solid ${D.border}`,
            }}
          >
            {" "}
            <div style={{ fontSize: 11, color: D.muted }}>{s.label}</div>{" "}
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: s.color,
                fontFamily: MONO,
              }}
            >
              {s.count}
            </div>{" "}
          </Card>
        ))}
      </div>
      {/* Re-run + last run info */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        {" "}
        <div style={{ fontSize: 12, color: D.muted }}>
          Last audit:{" "}
          {run.run_date ? new Date(run.run_date).toLocaleString() : "N/A"}
        </div>{" "}
        {canRunSeoActions && (
          <button
            onClick={runAudit}
            disabled={running}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: D.teal,
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              opacity: running ? 0.5 : 1,
            }}
          >
            {running ? "Running..." : "Re-run Audit"}
          </button>
        )}{" "}
      </div>
      {/* Top Issues Summary */}
      {issues.length > 0 && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Top Issues
          </div>{" "}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {issues.slice(0, 15).map((iss, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  background: D.bg,
                  borderRadius: 8,
                  border: `1px solid ${D.border}`,
                }}
              >
                {" "}
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: severityColor[iss.severity] || D.muted,
                  }}
                />{" "}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {" "}
                  <div
                    style={{ fontSize: 13, color: D.heading, fontWeight: 500 }}
                  >
                    {iss.issue_type?.replace(/_/g, " ")}
                  </div>
                  {iss.details && (
                    <div
                      style={{
                        fontSize: 11,
                        color: D.muted,
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {iss.details}
                    </div>
                  )}
                </div>{" "}
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: severityColor[iss.severity] || D.muted,
                    fontFamily: MONO,
                    flexShrink: 0,
                  }}
                >
                  {iss.affected_count} page{iss.affected_count !== 1 ? "s" : ""}
                </div>{" "}
              </div>
            ))}
          </div>{" "}
        </Card>
      )}

      {/* Page-by-Page Breakdown */}
      <Card>
        {" "}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          {" "}
          <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
            Pages {filter !== "all" ? `(${filter})` : ""} —{" "}
            {filteredPages.length}
          </div>
          {filter !== "all" && (
            <button
              onClick={() => setFilter("all")}
              style={{
                fontSize: 11,
                color: D.teal,
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              Show all
            </button>
          )}
        </div>{" "}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {filteredPages.slice(0, 50).map((p, i) => {
            const status = getPageStatus(p);
            const pageIssues = parseAuditIssues(p.issues);
            const isExpanded = expandedPage === i;
            return (
              <div key={i}>
                {" "}
                <div
                  onClick={() => setExpandedPage(isExpanded ? null : i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    background: D.bg,
                    borderRadius: 8,
                    border: `1px solid ${D.border}`,
                    cursor: "pointer",
                  }}
                >
                  {/* Score circle */}
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      flexShrink: 0,
                      border: `3px solid ${scoreColor(p.technical_health_score || 0)}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 800,
                      color: scoreColor(p.technical_health_score || 0),
                      fontFamily: MONO,
                    }}
                  >
                    {Math.round(p.technical_health_score || 0)}
                  </div>
                  {/* URL + meta */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: D.heading,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {shortUrl(p.url)}
                    </div>{" "}
                    <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                      {p.status_code && (
                        <span style={{ marginRight: 8 }}>{p.status_code}</span>
                      )}
                      {p.response_time_ms != null && (
                        <span style={{ marginRight: 8 }}>
                          {p.response_time_ms}ms
                        </span>
                      )}
                      {p.word_count != null && (
                        <span>{p.word_count} words</span>
                      )}
                    </div>{" "}
                  </div>
                  {/* Issue counts */}
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {p.issue_count_critical > 0 && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: D.red,
                          background: D.red + "18",
                          padding: "2px 6px",
                          borderRadius: 6,
                        }}
                      >
                        {p.issue_count_critical} critical
                      </span>
                    )}
                    {p.issue_count_warning > 0 && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: D.amber,
                          background: D.amber + "18",
                          padding: "2px 6px",
                          borderRadius: 6,
                        }}
                      >
                        {p.issue_count_warning} warning
                      </span>
                    )}
                    {status === "healthy" && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: D.green,
                          background: D.green + "18",
                          padding: "2px 6px",
                          borderRadius: 6,
                        }}
                      >
                        OK
                      </span>
                    )}
                  </div>{" "}
                  <span style={{ fontSize: 12, color: D.muted, flexShrink: 0 }}>
                    {isExpanded ? "▲" : "▼"}
                  </span>{" "}
                </div>
                {/* Expanded details */}
                {isExpanded && (
                  <div
                    style={{
                      padding: "12px 16px",
                      background: D.bg,
                      borderRadius: "0 0 8px 8px",
                      borderTop: "none",
                      border: `1px solid ${D.border}`,
                      borderTopColor: "transparent",
                      marginTop: -2,
                    }}
                  >
                    {/* Meta info */}
                    <div
                      className="seo-audit-expanded-grid"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                        marginBottom: 12,
                      }}
                    >
                      {p.meta_title && (
                        <div>
                          <div style={{ fontSize: 10, color: D.muted }}>
                            Title ({p.meta_title_length} chars)
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: D.text,
                              marginTop: 2,
                            }}
                          >
                            {p.meta_title}
                          </div>
                        </div>
                      )}
                      {p.meta_description && (
                        <div>
                          <div style={{ fontSize: 10, color: D.muted }}>
                            Description ({p.meta_description_length} chars)
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: D.text,
                              marginTop: 2,
                            }}
                          >
                            {p.meta_description?.substring(0, 160)}
                          </div>
                        </div>
                      )}
                      {p.h1_text && (
                        <div>
                          <div style={{ fontSize: 10, color: D.muted }}>
                            H1 (count: {p.h1_count})
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: D.text,
                              marginTop: 2,
                            }}
                          >
                            {p.h1_text}
                          </div>
                        </div>
                      )}
                      <div>
                        {" "}
                        <div style={{ fontSize: 10, color: D.muted }}>
                          Structure
                        </div>{" "}
                        <div
                          style={{ fontSize: 12, color: D.text, marginTop: 2 }}
                        >
                          H2s: {p.h2_count || 0} | Links:{" "}
                          {p.internal_links_count || 0} int /{" "}
                          {p.external_links_count || 0} ext | Images:{" "}
                          {p.total_images || 0} ({p.images_missing_alt || 0} no
                          alt)
                        </div>{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        <div style={{ fontSize: 10, color: D.muted }}>
                          Schema
                        </div>{" "}
                        <div
                          style={{ fontSize: 12, color: D.text, marginTop: 2 }}
                        >
                          {(() => {
                            try {
                              const s = JSON.parse(
                                p.schema_types_found || "[]",
                              );
                              return s.length ? s.join(", ") : "None found";
                            } catch {
                              return "None";
                            }
                          })()}
                          {p.has_faq_schema && (
                            <span style={{ color: D.green, marginLeft: 6 }}>
                              FAQ
                            </span>
                          )}
                          {p.has_local_business_schema && (
                            <span style={{ color: D.green, marginLeft: 6 }}>
                              LocalBusiness
                            </span>
                          )}
                        </div>{" "}
                      </div>
                      {p.canonical_url && (
                        <div>
                          <div style={{ fontSize: 10, color: D.muted }}>
                            Canonical
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: p.canonical_mismatch ? D.red : D.green,
                              marginTop: 2,
                            }}
                          >
                            {p.canonical_self_referencing
                              ? "Self-referencing"
                              : p.canonical_url}
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Issue list */}
                    {pageIssues.length > 0 && (
                      <div>
                        {" "}
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: D.muted,
                            marginBottom: 6,
                            textTransform: "uppercase",
                            letterSpacing: 0.5,
                          }}
                        >
                          Issues
                        </div>
                        {pageIssues.map((iss, j) => (
                          <div
                            key={j}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 8,
                              padding: "6px 0",
                              borderBottom:
                                j < pageIssues.length - 1
                                  ? `1px solid ${D.border}`
                                  : "none",
                            }}
                          >
                            {" "}
                            <span
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                background:
                                  severityColor[iss.severity] || D.muted,
                                marginTop: 5,
                                flexShrink: 0,
                              }}
                            />{" "}
                            <div>
                              {" "}
                              <div style={{ fontSize: 12, color: D.text }}>
                                {iss.message || iss.type?.replace(/_/g, " ")}
                              </div>
                              {iss.details && (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: D.muted,
                                    marginTop: 1,
                                  }}
                                >
                                  {iss.details}
                                </div>
                              )}
                            </div>{" "}
                          </div>
                        ))}
                      </div>
                    )}
                    {pageIssues.length === 0 && (
                      <div style={{ fontSize: 12, color: D.green }}>
                        No issues found — page is healthy
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>{" "}
      </Card>
      {/* Audit History */}
      {history.length > 1 && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Audit History
          </div>{" "}
          <div
            className="seo-audit-history-grid"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${Math.min(history.length, 6)}, 1fr)`,
              gap: 8,
            }}
          >
            {history.slice(0, 6).map((h, i) => (
              <div
                key={i}
                style={{
                  textAlign: "center",
                  padding: 12,
                  background: D.bg,
                  borderRadius: 8,
                  border:
                    i === 0 ? `2px solid ${D.teal}` : `1px solid ${D.border}`,
                }}
              >
                {" "}
                <div style={{ fontSize: 10, color: D.muted }}>
                  {new Date(h.date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </div>{" "}
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: scoreColor(h.score),
                    fontFamily: MONO,
                  }}
                >
                  {Math.round(h.score)}
                </div>{" "}
                <div style={{ fontSize: 10, color: D.muted }}>
                  {h.pages} pages
                </div>
                {h.critical > 0 && (
                  <div style={{ fontSize: 10, color: D.red }}>
                    {h.critical} critical
                  </div>
                )}
              </div>
            ))}
          </div>{" "}
        </Card>
      )}
    </div>
  );
}

// ── URL Intelligence Tab ──
function UrlIntelTab({ domain }) {
  const [data, setData] = useState(null);
  const [scanData, setScanData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState("overview");
  const [diagnosisFilter, setDiagnosisFilter] = useState("");
  const [scanPage, setScanPage] = useState(0);
  const canRefresh = isAdminUser();

  useEffect(() => {
    adminFetch(`/admin/seo/url-intelligence/dashboard?domain=${domain}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [domain]);

  useEffect(() => {
    if (subTab === "diagnosis" || subTab === "priority") {
      const diag = subTab === "priority" ? "" : diagnosisFilter;
      const qs = `diagnosis=${diag}&domain=${domain}&limit=25&offset=${scanPage * 25}`;
      adminFetch(`/admin/seo/url-intelligence/scan?${qs}`)
        .then(setScanData)
        .catch(() => setScanData(null));
    }
  }, [subTab, diagnosisFilter, scanPage, domain]);

  function handleRefresh() {
    adminPost("/admin/seo/url-intelligence/refresh", { domain })
      .then(() => {
        adminFetch(`/admin/seo/url-intelligence/dashboard?domain=${domain}`).then(setData);
      })
      .catch(() => {});
  }

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading URL Intelligence...</div>;
  if (!data) return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>No data — run a refresh to populate.</div>;

  const subTabs = [
    { key: "overview", label: "Overview" },
    { key: "diagnosis", label: "By Diagnosis" },
    { key: "priority", label: "Priority Queue" },
    { key: "duplicates", label: "Duplicates" },
    { key: "intent", label: "Intent Routing" },
  ];

  const diagnosisLabels = {
    indexation_problem: "Indexation",
    canonical_problem: "Canonical",
    duplicate_content: "Duplicate",
    technical_performance: "Technical",
    cannibalization: "Cannibalization",
    ranking_decay: "Decay",
    ctr_problem: "CTR",
    thin_local_proof: "Thin Local",
    structured_data: "Schema",
    internal_linking: "Internal Links",
    freshness: "Freshness",
    low_value: "Low Value",
    healthy: "Healthy",
    unknown: "Unknown",
  };

  const statusColors = {
    healthy: D.green,
    needs_technical_fix: D.red,
    needs_canonical_fix: D.amber,
    needs_content_refresh: D.amber,
    needs_indexation_fix: D.red,
    low_priority: D.muted,
    review_required: D.amber,
    unknown: D.muted,
  };

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} className="seo-sub-tabs">
        {subTabs.map((st) => (
          <button
            key={st.key}
            onClick={() => { setSubTab(st.key); setScanPage(0); }}
            style={{
              padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer",
              background: subTab === st.key ? D.heading : "transparent",
              color: subTab === st.key ? D.white : D.muted,
              border: `1px solid ${subTab === st.key ? D.heading : D.border}`,
            }}
          >{st.label}</button>
        ))}
        {canRefresh && (
          <button
            onClick={handleRefresh}
            style={{
              marginLeft: "auto", padding: "6px 14px", borderRadius: 8, fontSize: 12,
              background: D.heading, color: D.white, border: "none", cursor: "pointer",
            }}
          >Refresh Domain</button>
        )}
      </div>

      {subTab === "overview" && (
        <>
          <div className="seo-kpi-grid-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
            <KpiCard label="Total URLs" value={fmt(data.total_urls)} />
            <KpiCard
              label="Healthy"
              value={`${data.by_status.find((s) => s.status === "healthy")?.count || 0}`}
              color={D.green}
            />
            <KpiCard
              label="Needs Fix"
              value={`${data.total_urls - (data.by_status.find((s) => s.status === "healthy")?.count || 0) - (data.by_status.find((s) => s.status === "unknown")?.count || 0)}`}
              color={D.red}
            />
            <KpiCard label="Indexation Gap" value={`${data.indexation_gap?.gap_pct || 0}%`} color={data.indexation_gap?.gap_pct > 20 ? D.red : D.green} />
          </div>

          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Diagnosis Breakdown</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
              {data.by_diagnosis.filter((d) => d.count > 0).map((d) => (
                <div
                  key={d.diagnosis}
                  onClick={() => { setSubTab("diagnosis"); setDiagnosisFilter(d.diagnosis); setScanPage(0); }}
                  style={{
                    padding: 12, borderRadius: 8, border: `1px solid ${D.border}`, cursor: "pointer",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: 12, color: D.text }}>{diagnosisLabels[d.diagnosis] || d.diagnosis}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, fontFamily: MONO, color: D.heading }}>{d.count}</span>
                </div>
              ))}
            </div>
          </Card>

          {data.top_issues?.length > 0 && (
            <Card>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Top Priority Issues</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={thStyle}>URL</th>
                    <th style={thStyle}>Diagnosis</th>
                    <th style={thR}>Priority</th>
                    <th style={thStyle}>Action</th>
                  </tr></thead>
                  <tbody>
                    {data.top_issues.map((row) => (
                      <tr key={row.id}>
                        <td style={{ ...tdStyle, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.url}
                        </td>
                        <td style={tdStyle}>
                          <span style={{
                            padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 500,
                            background: statusColors[row.primary_status] ? `${statusColors[row.primary_status]}18` : `${D.muted}18`,
                            color: statusColors[row.primary_status] || D.muted,
                          }}>{diagnosisLabels[row.primary_diagnosis] || row.primary_diagnosis}</span>
                        </td>
                        <td style={tdR}>{row.priority_score}</td>
                        <td style={{ ...tdStyle, fontSize: 12, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.recommended_action}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {data.canonical_conflicts > 0 && (
            <Card style={{ borderLeft: `3px solid ${D.amber}` }}>
              <div style={{ fontSize: 13, color: D.amber, fontWeight: 600 }}>
                {data.canonical_conflicts} canonical conflict{data.canonical_conflicts > 1 ? "s" : ""} detected
              </div>
              <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                Switch to the Indexation tab → Canonical Conflicts to review.
              </div>
            </Card>
          )}
        </>
      )}

      {(subTab === "diagnosis" || subTab === "priority") && (
        <Card>
          {subTab === "diagnosis" && (
            <div style={{ marginBottom: 16, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: D.muted }}>Filter:</span>
              <select
                value={diagnosisFilter}
                onChange={(e) => { setDiagnosisFilter(e.target.value); setScanPage(0); }}
                style={{
                  padding: "6px 10px", borderRadius: 6, fontSize: 13, border: `1px solid ${D.border}`,
                  background: D.card, color: D.text,
                }}
              >
                <option value="">All</option>
                {Object.entries(diagnosisLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          )}

          {subTab === "priority" && (
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>
              Priority Queue — highest impact first
            </div>
          )}

          {scanData?.urls?.length > 0 ? (
            <>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={thStyle}>URL</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Diagnosis</th>
                    <th style={thR}>Priority</th>
                    <th style={thR}>Clicks 28d</th>
                    <th style={thR}>Position</th>
                    {subTab === "priority" && <th style={thStyle}>Recommended Action</th>}
                  </tr></thead>
                  <tbody>
                    {scanData.urls.map((row) => (
                      <tr key={row.id}>
                        <td style={{ ...tdStyle, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.url}
                        </td>
                        <td style={tdStyle}>
                          <span style={{
                            padding: "2px 8px", borderRadius: 4, fontSize: 11,
                            background: statusColors[row.primary_status] ? `${statusColors[row.primary_status]}18` : `${D.muted}18`,
                            color: statusColors[row.primary_status] || D.muted,
                          }}>{row.primary_status}</span>
                        </td>
                        <td style={tdStyle}>{diagnosisLabels[row.primary_diagnosis] || row.primary_diagnosis}</td>
                        <td style={tdR}>{row.priority_score}</td>
                        <td style={tdR}>{fmt(row.gsc_clicks_28d)}</td>
                        <td style={tdR}>{row.gsc_avg_position_28d ? parseFloat(row.gsc_avg_position_28d).toFixed(1) : "—"}</td>
                        {subTab === "priority" && (
                          <td style={{ ...tdStyle, fontSize: 12, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.recommended_action}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
                <button
                  disabled={scanPage === 0}
                  onClick={() => setScanPage((p) => Math.max(0, p - 1))}
                  style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, border: `1px solid ${D.border}`, background: D.card, color: D.text, cursor: scanPage === 0 ? "default" : "pointer", opacity: scanPage === 0 ? 0.4 : 1 }}
                >Prev</button>
                <span style={{ fontSize: 12, color: D.muted }}>
                  {scanPage * 25 + 1}–{Math.min((scanPage + 1) * 25, scanData.total)} of {scanData.total}
                </span>
                <button
                  disabled={(scanPage + 1) * 25 >= scanData.total}
                  onClick={() => setScanPage((p) => p + 1)}
                  style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, border: `1px solid ${D.border}`, background: D.card, color: D.text, cursor: (scanPage + 1) * 25 >= scanData.total ? "default" : "pointer", opacity: (scanPage + 1) * 25 >= scanData.total ? 0.4 : 1 }}
                >Next</button>
              </div>
            </>
          ) : (
            <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>
              {scanData ? "No URLs match the current filter." : "Loading..."}
            </div>
          )}
        </Card>
      )}

      {subTab === "duplicates" && (
        <DuplicatesSubTab domain={domain} />
      )}

      {subTab === "intent" && (
        <IntentSubTab domain={domain} />
      )}
    </div>
  );
}

function DuplicatesSubTab({ domain }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch(`/admin/seo/url-intelligence/duplicate-clusters?domain=${domain}`)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [domain]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading...</div>;
  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>
        Duplicate Content Clusters — body similarity &gt; 80%
      </div>
      {data && data.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={thStyle}>URL</th>
              <th style={thStyle}>Domain</th>
              <th style={thR}>Similarity</th>
              <th style={thStyle}>City</th>
              <th style={thStyle}>Service</th>
              <th style={thStyle}>Page Type</th>
            </tr></thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id}>
                  <td style={{ ...tdStyle, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.url}</td>
                  <td style={tdStyle}>{row.domain}</td>
                  <td style={tdR}>{row.body_similarity_max != null ? `${row.body_similarity_max}%` : "—"}</td>
                  <td style={tdStyle}>{row.city || "—"}</td>
                  <td style={tdStyle}>{row.service || "—"}</td>
                  <td style={tdStyle}>{row.page_type || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>
          No duplicate clusters detected. Run duplicate detection to populate.
        </div>
      )}
    </Card>
  );
}

function IntentSubTab({ domain }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [severityFilter, setSeverityFilter] = useState("");
  useEffect(() => {
    const qs = severityFilter ? `&severity=${severityFilter}` : "";
    adminFetch(`/admin/seo/url-intelligence/intent-routes?domain=${domain}${qs}&limit=50`)
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [domain, severityFilter]);

  const severityColors = { severe: D.red, moderate: D.amber, mild: D.muted, none: D.green };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading...</div>;
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>Intent Routing — Query → Page Alignment</div>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, fontSize: 13, border: `1px solid ${D.border}`, background: D.card, color: D.text }}
        >
          <option value="">All</option>
          <option value="severe">Severe</option>
          <option value="moderate">Moderate</option>
          <option value="mild">Mild</option>
        </select>
      </div>
      {data && data.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={thStyle}>Query Cluster</th>
              <th style={thStyle}>Intent</th>
              <th style={thStyle}>Expected</th>
              <th style={thStyle}>Actual Winner</th>
              <th style={thStyle}>Misroute</th>
              <th style={thStyle}>Severity</th>
              <th style={thR}>Impressions</th>
            </tr></thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id}>
                  <td style={{ ...tdStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.query_cluster}</td>
                  <td style={tdStyle}>{row.intent_type}</td>
                  <td style={tdStyle}>{row.expected_page_type}</td>
                  <td style={{ ...tdStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.actual_winner_url}</td>
                  <td style={tdStyle}>{row.misroute_type}</td>
                  <td style={tdStyle}>
                    {row.misroute_severity && row.misroute_severity !== "none" && (
                      <span style={{
                        padding: "2px 8px", borderRadius: 4, fontSize: 11,
                        background: `${severityColors[row.misroute_severity] || D.muted}18`,
                        color: severityColors[row.misroute_severity] || D.muted,
                      }}>{row.misroute_severity}</span>
                    )}
                  </td>
                  <td style={tdR}>{fmt(row.impressions_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>
          No intent routes found. Run intent map builder to populate.
        </div>
      )}
    </Card>
  );
}

// ── Actions Tab ──
function ActionsTab({ domain }) {
  const [subTab, setSubTab] = useState("queue");
  const [summary, setSummary] = useState(null);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const canAdmin = isAdminUser();

  const loadData = () => {
    setLoading(true);
    Promise.all([
      adminFetch(`/admin/seo/actions/summary?domain=${domain}`),
      subTab === "drafts"
        ? adminFetch(`/admin/seo/actions?domain=${domain}&type=rewrite_title_meta&limit=50`)
        : subTab === "progress"
        ? adminFetch(`/admin/seo/actions?domain=${domain}&execution_status=in_progress&limit=50`)
          .then((d) => d.length > 0 ? d : adminFetch(`/admin/seo/actions?domain=${domain}&execution_status=done&limit=25`))
        : subTab === "experiments"
        ? adminFetch(`/admin/seo/url-intelligence/experiments?limit=50`)
        : adminFetch(`/admin/seo/actions?domain=${domain}&approval_status=pending&limit=50`),
    ])
      .then(([s, a]) => { setSummary(s); setActions(Array.isArray(a) ? a : []); })
      .catch(() => { setSummary(null); setActions([]); })
      .finally(() => setLoading(false));
  };

  useEffect(loadData, [domain, subTab]);

  function handleAction(id, verb) {
    adminPost(`/admin/seo/actions/${id}/${verb}`, {})
      .then(loadData)
      .catch(() => {});
  }

  const subTabs = [
    { key: "queue", label: "Queue" },
    { key: "drafts", label: "AI Drafts" },
    { key: "progress", label: "In Progress" },
    { key: "experiments", label: "Experiments" },
  ];

  const tierColors = { auto: D.green, editor: D.muted, seo: D.amber, owner: D.red };

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} className="seo-sub-tabs">
        {subTabs.map((st) => (
          <button
            key={st.key}
            onClick={() => setSubTab(st.key)}
            style={{
              padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer",
              background: subTab === st.key ? D.heading : "transparent",
              color: subTab === st.key ? D.white : D.muted,
              border: `1px solid ${subTab === st.key ? D.heading : D.border}`,
            }}
          >{st.label}</button>
        ))}
        {canAdmin && subTab === "queue" && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={() => adminPost("/admin/seo/actions/generate", { domain }).then(loadData)} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, background: D.heading, color: D.white, border: "none", cursor: "pointer" }}>Generate Actions</button>
            <button onClick={() => adminPost("/admin/seo/actions/auto-approve", { domain }).then(loadData)} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 12, background: "transparent", color: D.text, border: `1px solid ${D.border}`, cursor: "pointer" }}>Auto-Approve</button>
          </div>
        )}
        {canAdmin && subTab === "drafts" && (
          <button onClick={() => adminPost("/admin/seo/actions/generate-drafts", {}).then(loadData)} style={{ marginLeft: "auto", padding: "6px 14px", borderRadius: 8, fontSize: 12, background: D.heading, color: D.white, border: "none", cursor: "pointer" }}>Generate Drafts</button>
        )}
      </div>

      {summary && (
        <div className="seo-kpi-grid-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          <KpiCard label="Pending Auto" value={fmt(summary.pending_by_tier?.auto || 0)} color={D.green} />
          <KpiCard label="Pending Editor" value={fmt(summary.pending_by_tier?.editor || 0)} />
          <KpiCard label="Pending SEO" value={fmt(summary.pending_by_tier?.seo || 0)} color={D.amber} />
          <KpiCard label="Done" value={fmt(summary.done)} color={D.green} />
        </div>
      )}

      {loading ? <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading...</div> : (
        <Card>
          {subTab === "queue" && (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Pending Actions — by priority</div>
              {actions.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={thStyle}>URL</th>
                      <th style={thStyle}>Issue</th>
                      <th style={thStyle}>Action</th>
                      <th style={thR}>Priority</th>
                      <th style={thStyle}>Tier</th>
                      {canAdmin && <th style={thStyle}>Actions</th>}
                    </tr></thead>
                    <tbody>
                      {actions.map((a) => (
                        <tr key={a.id}>
                          <td style={{ ...tdStyle, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.url}</td>
                          <td style={tdStyle}>{a.issue_type}</td>
                          <td style={tdStyle}>{a.action_type.replace(/_/g, " ")}</td>
                          <td style={tdR}>{a.priority_score}</td>
                          <td style={tdStyle}>
                            <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, background: `${tierColors[a.approval_tier] || D.muted}18`, color: tierColors[a.approval_tier] || D.muted }}>{a.approval_tier}</span>
                          </td>
                          {canAdmin && (
                            <td style={tdStyle}>
                              <div style={{ display: "flex", gap: 4 }}>
                                <button onClick={() => handleAction(a.id, "approve")} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, background: `${D.green}18`, color: D.green, border: "none", cursor: "pointer" }}>Approve</button>
                                <button onClick={() => handleAction(a.id, "reject")} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, background: `${D.red}18`, color: D.red, border: "none", cursor: "pointer" }}>Reject</button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>No pending actions. Run the pipeline to generate.</div>
              )}
            </>
          )}

          {subTab === "drafts" && (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>AI Title/Meta Drafts</div>
              {actions.filter((a) => a.ai_draft).length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {actions.filter((a) => a.ai_draft).map((a) => {
                    let draft = {};
                    try { draft = typeof a.ai_draft === "string" ? JSON.parse(a.ai_draft) : (a.ai_draft || {}); } catch {}
                    let detail = {};
                    try { detail = typeof a.detail === "string" ? JSON.parse(a.detail) : (a.detail || {}); } catch {}
                    return (
                      <div key={a.id} style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 16 }}>
                        <div style={{ fontSize: 13, color: D.muted, marginBottom: 8 }}>{a.url}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                          <div>
                            <div style={{ fontSize: 11, color: D.muted, fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>Current</div>
                            <div style={{ fontSize: 13, color: D.text }}>{detail.current_title || "—"}</div>
                            <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{detail.current_meta || "—"}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: D.green, fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>Proposed</div>
                            <div style={{ fontSize: 13, color: D.text, fontWeight: 500 }}>{draft.title || "—"}</div>
                            <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{draft.meta_description || "—"}</div>
                          </div>
                        </div>
                        {draft.reasoning && <div style={{ fontSize: 12, color: D.muted, marginTop: 8, fontStyle: "italic" }}>{draft.reasoning}</div>}
                        {canAdmin && (
                          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                            <button onClick={() => handleAction(a.id, "approve")} style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, background: D.green, color: D.white, border: "none", cursor: "pointer" }}>Approve</button>
                            <button onClick={() => handleAction(a.id, "reject")} style={{ padding: "4px 12px", borderRadius: 6, fontSize: 12, background: "transparent", color: D.red, border: `1px solid ${D.red}`, cursor: "pointer" }}>Reject</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>No AI drafts yet. Click "Generate Drafts" to create title/meta suggestions.</div>
              )}
            </>
          )}

          {subTab === "progress" && (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Execution Status</div>
              {actions.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={thStyle}>URL</th>
                      <th style={thStyle}>Action</th>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Executor</th>
                      <th style={thStyle}>Completed</th>
                      <th style={thStyle}>Notes</th>
                    </tr></thead>
                    <tbody>
                      {actions.map((a) => (
                        <tr key={a.id}>
                          <td style={{ ...tdStyle, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.url}</td>
                          <td style={tdStyle}>{a.action_type.replace(/_/g, " ")}</td>
                          <td style={tdStyle}>
                            <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, background: a.execution_status === "done" ? `${D.green}18` : `${D.amber}18`, color: a.execution_status === "done" ? D.green : D.amber }}>{a.execution_status}</span>
                          </td>
                          <td style={tdStyle}>{a.executor || "—"}</td>
                          <td style={tdStyle}>{a.completed_at ? new Date(a.completed_at).toLocaleDateString() : "—"}</td>
                          <td style={{ ...tdStyle, fontSize: 12, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.execution_notes || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>No actions in progress.</div>
              )}
            </>
          )}

          {subTab === "experiments" && (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>SEO Experiments</div>
              {actions.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={thStyle}>URL</th>
                      <th style={thStyle}>Action</th>
                      <th style={thStyle}>Published</th>
                      <th style={thR}>Pre Clicks</th>
                      <th style={thR}>Post Clicks</th>
                      <th style={thR}>Pre Pos</th>
                      <th style={thR}>Post Pos</th>
                      <th style={thStyle}>Status</th>
                    </tr></thead>
                    <tbody>
                      {actions.map((e) => (
                        <tr key={e.id}>
                          <td style={{ ...tdStyle, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.url}</td>
                          <td style={tdStyle}>{e.action_type.replace(/_/g, " ")}</td>
                          <td style={tdStyle}>{e.publish_date || "—"}</td>
                          <td style={tdR}>{fmt(e.pre_28d_clicks)}</td>
                          <td style={tdR}>{e.post_28d_clicks != null ? fmt(e.post_28d_clicks) : "—"}</td>
                          <td style={tdR}>{e.pre_28d_position ? parseFloat(e.pre_28d_position).toFixed(1) : "—"}</td>
                          <td style={tdR}>{e.post_28d_position ? parseFloat(e.post_28d_position).toFixed(1) : "—"}</td>
                          <td style={tdStyle}>
                            <span style={{
                              padding: "2px 8px", borderRadius: 4, fontSize: 11,
                              background: e.status === "accepted" ? `${D.green}18` : e.status === "rejected" ? `${D.red}18` : `${D.amber}18`,
                              color: e.status === "accepted" ? D.green : e.status === "rejected" ? D.red : D.amber,
                            }}>{e.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>No experiments yet. Complete actions to create experiments.</div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Indexation Tab ──
function IndexationTab({ domain }) {
  const [subTab, setSubTab] = useState("gap");
  const [gapData, setGapData] = useState(null);
  const [conflictsData, setConflictsData] = useState(null);
  const [crawledNotIndexed, setCrawledNotIndexed] = useState(null);
  const [inspectUrl, setInspectUrl] = useState("");
  const [inspectData, setInspectData] = useState(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (subTab === "gap") {
      setLoading(true);
      adminFetch(`/admin/seo/url-intelligence/indexation-gap?domain=${domain}`)
        .then(setGapData)
        .catch(() => setGapData(null))
        .finally(() => setLoading(false));
    } else if (subTab === "conflicts") {
      setLoading(true);
      adminFetch(`/admin/seo/url-intelligence/canonical-conflicts?domain=${domain}`)
        .then(setConflictsData)
        .catch(() => setConflictsData(null))
        .finally(() => setLoading(false));
    } else if (subTab === "crawled") {
      setLoading(true);
      adminFetch(`/admin/seo/url-intelligence/scan?diagnosis=indexation_problem&domain=${domain}&limit=50`)
        .then(setCrawledNotIndexed)
        .catch(() => setCrawledNotIndexed(null))
        .finally(() => setLoading(false));
    }
  }, [subTab, domain]);

  function handleInspect() {
    if (!inspectUrl.trim()) return;
    setInspectLoading(true);
    setInspectData(null);
    adminFetch(`/admin/seo/url-intelligence/inspect?url=${encodeURIComponent(inspectUrl.trim())}`)
      .then(setInspectData)
      .catch(() => setInspectData({ _error: true }))
      .finally(() => setInspectLoading(false));
  }

  const subTabs = [
    { key: "gap", label: "Indexation Gap" },
    { key: "conflicts", label: "Canonical Conflicts" },
    { key: "crawled", label: "Not Indexed" },
    { key: "sitemap", label: "Sitemap Issues" },
    { key: "inspector", label: "URL Inspector" },
  ];

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} className="seo-sub-tabs">
        {subTabs.map((st) => (
          <button
            key={st.key}
            onClick={() => setSubTab(st.key)}
            style={{
              padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer",
              background: subTab === st.key ? D.heading : "transparent",
              color: subTab === st.key ? D.white : D.muted,
              border: `1px solid ${subTab === st.key ? D.heading : D.border}`,
            }}
          >{st.label}</button>
        ))}
      </div>

      {subTab === "gap" && (
        loading ? <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading...</div> : (
          gapData && (
            <Card>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 20 }}>
                Indexation Gap — {gapData.domain}
              </div>
              <div className="seo-kpi-grid-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
                <KpiCard label="Submitted" value={fmt(gapData.submitted)} />
                <KpiCard label="Indexed" value={fmt(gapData.indexed)} color={D.green} />
                <KpiCard label="Gap" value={fmt(gapData.gap)} color={gapData.gap > 0 ? D.red : D.green} />
                <KpiCard label="Gap %" value={`${gapData.gap_pct}%`} color={gapData.gap_pct > 20 ? D.red : gapData.gap_pct > 10 ? D.amber : D.green} />
              </div>

              {gapData.gap_pct > 20 && (
                <div style={{ padding: 12, borderRadius: 8, background: `${D.red}0A`, border: `1px solid ${D.red}30`, marginBottom: 16 }}>
                  <span style={{ fontSize: 12, color: D.red, fontWeight: 500 }}>
                    Indexation gap above 20% — indicates quality, duplication, or crawl-budget issues.
                  </span>
                </div>
              )}

              {gapData.by_coverage_state?.length > 0 && (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 12 }}>By Coverage State</div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr>
                      <th style={thStyle}>Coverage State</th>
                      <th style={thR}>Count</th>
                    </tr></thead>
                    <tbody>
                      {gapData.by_coverage_state.map((row) => (
                        <tr key={row.coverage_state}>
                          <td style={tdStyle}>{row.coverage_state}</td>
                          <td style={tdR}>{row.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </Card>
          )
        )
      )}

      {subTab === "conflicts" && (
        loading ? <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading...</div> : (
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>
              Canonical Conflicts — Hub / Spoke
            </div>
            {conflictsData?.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={thStyle}>Spoke URL</th>
                    <th style={thStyle}>Hub URL</th>
                    <th style={thR}>Body Sim %</th>
                    <th style={thStyle}>Google Canonical</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Fix</th>
                  </tr></thead>
                  <tbody>
                    {conflictsData.map((row) => (
                      <tr key={row.id}>
                        <td style={{ ...tdStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.spoke_url}</td>
                        <td style={{ ...tdStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.hub_url}</td>
                        <td style={tdR}>{row.body_similarity_pct != null ? `${row.body_similarity_pct}%` : "—"}</td>
                        <td style={{ ...tdStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.google_selected_canonical || "—"}</td>
                        <td style={tdStyle}>
                          <span style={{
                            padding: "2px 8px", borderRadius: 4, fontSize: 11,
                            background: row.status === "open" ? `${D.amber}18` : `${D.green}18`,
                            color: row.status === "open" ? D.amber : D.green,
                          }}>{row.status}</span>
                        </td>
                        <td style={{ ...tdStyle, fontSize: 12, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.recommended_fix}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>
                No canonical conflicts detected. Run a refresh + conflict detection to populate.
              </div>
            )}
          </Card>
        )
      )}

      {subTab === "crawled" && (
        loading ? <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading...</div> : (
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>
              Not Indexed — Priority URLs
            </div>
            {crawledNotIndexed?.urls?.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    <th style={thStyle}>URL</th>
                    <th style={thStyle}>Coverage State</th>
                    <th style={thR}>Priority</th>
                    <th style={thStyle}>In Sitemap</th>
                    <th style={thStyle}>Action</th>
                  </tr></thead>
                  <tbody>
                    {crawledNotIndexed.urls.map((row) => (
                      <tr key={row.id}>
                        <td style={{ ...tdStyle, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.url}</td>
                        <td style={tdStyle}>{row.coverage_state || "—"}</td>
                        <td style={tdR}>{row.priority_score}</td>
                        <td style={tdStyle}>{row.in_sitemap ? "Yes" : "No"}</td>
                        <td style={{ ...tdStyle, fontSize: 12, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.recommended_action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>
                No indexation problems found — or data not yet populated.
              </div>
            )}
          </Card>
        )
      )}

      {subTab === "sitemap" && (
        <SitemapIssuesSubTab domain={domain} />
      )}

      {subTab === "inspector" && (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>URL Inspector</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <input
              type="text"
              value={inspectUrl}
              onChange={(e) => setInspectUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleInspect()}
              placeholder="Enter URL to inspect..."
              style={{
                flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 13,
                border: `1px solid ${D.inputBorder}`, background: D.card, color: D.text,
              }}
            />
            <button
              onClick={handleInspect}
              disabled={inspectLoading}
              style={{
                padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                background: D.heading, color: D.white, border: "none", cursor: "pointer",
                opacity: inspectLoading ? 0.6 : 1,
              }}
            >{inspectLoading ? "Inspecting..." : "Inspect"}</button>
          </div>

          {inspectData && !inspectData._error && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Status banner */}
              <div style={{
                padding: 16, borderRadius: 8,
                background: inspectData.primary_status === "healthy" ? `${D.green}0A` : `${D.amber}0A`,
                border: `1px solid ${inspectData.primary_status === "healthy" ? `${D.green}30` : `${D.amber}30`}`,
              }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{inspectData.url}</div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                  Status: <strong>{inspectData.primary_status}</strong> · Diagnosis: <strong>{inspectData.primary_diagnosis}</strong> · Priority: <strong>{inspectData.priority_score}</strong>
                </div>
              </div>

              {/* Detail sections */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }} className="seo-audit-expanded-grid">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, textTransform: "uppercase", letterSpacing: "0.5px" }}>Identity</div>
                  {[
                    ["Domain", inspectData.domain],
                    ["Type", inspectData.hub_or_spoke],
                    ["Page Type", inspectData.page_type],
                    ["City", inspectData.city || "—"],
                    ["Service", inspectData.service || "—"],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: D.muted }}>{k}</span>
                      <span style={{ color: D.text, fontFamily: MONO }}>{v}</span>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, textTransform: "uppercase", letterSpacing: "0.5px" }}>Indexation</div>
                  {[
                    ["Coverage", inspectData.coverage_state || "—"],
                    ["Indexing State", inspectData.indexing_state || "—"],
                    ["In Sitemap", inspectData.in_sitemap ? "Yes" : "No"],
                    ["Canonical Match", inspectData.canonical_match === true ? "Yes" : inspectData.canonical_match === false ? "No" : "—"],
                    ["Status Code", inspectData.status_code || "—"],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: D.muted }}>{k}</span>
                      <span style={{ color: D.text, fontFamily: MONO }}>{v}</span>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, textTransform: "uppercase", letterSpacing: "0.5px" }}>Performance (28d)</div>
                  {[
                    ["Clicks", fmt(inspectData.gsc_clicks_28d)],
                    ["Impressions", fmt(inspectData.gsc_impressions_28d)],
                    ["CTR", inspectData.gsc_ctr_28d != null ? `${(parseFloat(inspectData.gsc_ctr_28d) * 100).toFixed(1)}%` : "—"],
                    ["Avg Position", inspectData.gsc_avg_position_28d ? parseFloat(inspectData.gsc_avg_position_28d).toFixed(1) : "—"],
                    ["Backlinks", fmt(inspectData.backlinks_count)],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: D.muted }}>{k}</span>
                      <span style={{ color: D.text, fontFamily: MONO }}>{v}</span>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, textTransform: "uppercase", letterSpacing: "0.5px" }}>Scores</div>
                  {[
                    ["Technical QA", inspectData.technical_qa_score ?? "—"],
                    ["Content QA", inspectData.content_qa_score ?? "—"],
                    ["Local QA", inspectData.local_qa_score ?? "—"],
                    ["Word Count", inspectData.word_count ? fmt(inspectData.word_count) : "—"],
                    ["Approval", inspectData.approval_level || "—"],
                  ].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: D.muted }}>{k}</span>
                      <span style={{ color: D.text, fontFamily: MONO }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recommended action */}
              {inspectData.recommended_action && (
                <div style={{ padding: 16, borderRadius: 8, background: `${D.heading}08`, border: `1px solid ${D.border}` }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 6 }}>RECOMMENDED ACTION</div>
                  <div style={{ fontSize: 13, color: D.text }}>{inspectData.recommended_action}</div>
                  {inspectData.alternative_action && (
                    <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>Alt: {inspectData.alternative_action}</div>
                  )}
                </div>
              )}

              {/* Canonical detail */}
              {(inspectData.user_declared_canonical || inspectData.google_selected_canonical) && (
                <div style={{ padding: 16, borderRadius: 8, border: `1px solid ${D.border}` }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 8 }}>CANONICAL</div>
                  <div style={{ fontSize: 12, color: D.muted }}>
                    User declared: <span style={{ color: D.text, fontFamily: MONO }}>{inspectData.user_declared_canonical || "—"}</span>
                  </div>
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                    Google selected: <span style={{ color: D.text, fontFamily: MONO }}>{inspectData.google_selected_canonical || "—"}</span>
                  </div>
                </div>
              )}

              {/* Title / Meta */}
              <div style={{ padding: 16, borderRadius: 8, border: `1px solid ${D.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: D.heading, marginBottom: 8 }}>CONTENT</div>
                <div style={{ fontSize: 12, color: D.muted }}>Title: <span style={{ color: D.text }}>{inspectData.title || "—"}</span></div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>H1: <span style={{ color: D.text }}>{inspectData.h1 || "—"}</span></div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>Meta: <span style={{ color: D.text }}>{inspectData.meta_description || "—"}</span></div>
              </div>
            </div>
          )}

          {inspectData?._error && (
            <div style={{ color: D.red, fontSize: 13, padding: 20, textAlign: "center" }}>
              URL not found in intelligence layer. Run a domain refresh first.
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function SitemapIssuesSubTab({ domain }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    adminFetch(`/admin/seo/url-intelligence/sitemap-issues?domain=${domain}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [domain]);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading...</div>;
  if (!data) return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>No sitemap issues data. Run validation first.</div>;

  const severityColor = { critical: D.red, warning: D.amber };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="seo-kpi-grid-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <KpiCard label="Total Issues" value={fmt(data.total_issues)} color={data.total_issues > 0 ? D.red : D.green} />
        <KpiCard label="Critical" value={fmt(data.by_severity?.find((s) => s.severity === "critical")?.count || 0)} color={D.red} />
        <KpiCard label="Warning" value={fmt(data.by_severity?.find((s) => s.severity === "warning")?.count || 0)} color={D.amber} />
        <KpiCard label="Issue Types" value={fmt(data.by_type?.length || 0)} />
      </div>

      {data.issues?.length > 0 ? (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Sitemap Issues — {data.domain}</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={thStyle}>URL</th>
                <th style={thStyle}>Issue</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Detail</th>
              </tr></thead>
              <tbody>
                {data.issues.map((row) => (
                  <tr key={row.id}>
                    <td style={{ ...tdStyle, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.page_url}</td>
                    <td style={tdStyle}>{row.issue_type.replace(/_/g, " ")}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: "2px 8px", borderRadius: 4, fontSize: 11,
                        background: `${severityColor[row.severity] || D.muted}18`,
                        color: severityColor[row.severity] || D.muted,
                      }}>{row.severity}</span>
                    </td>
                    <td style={{ ...tdStyle, fontSize: 12, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ color: D.muted, fontSize: 13, padding: 20, textAlign: "center" }}>
            No sitemap issues found.
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Main Page ──
function SEOWorkspaceNav({ sections, activeKey, onChange }) {
  if (!sections?.length || sections.length === 1) return null;
  return (
    <div
      className="seo-workspace-nav"
      style={{
        display: "flex",
        gap: 6,
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
        margin: "-4px 0 18px",
        padding: "0 2px 2px",
      }}
    >
      {sections.map((section) => {
        const active = activeKey === section.key;
        return (
          <button
            key={section.key}
            type="button"
            onClick={() => onChange(section.key)}
            style={{
              padding: "7px 13px",
              borderRadius: 7,
              border: `1px solid ${active ? D.heading : D.border}`,
              background: active ? D.heading : D.card,
              color: active ? D.white : D.text,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {section.label}
          </button>
        );
      })}
    </div>
  );
}

export default function SEOPage() {
  const [workspace, setWorkspace] = useState("command");
  const [activeViews, setActiveViews] = useState(() =>
    Object.fromEntries(
      WORKSPACES.map((item) => [item.key, defaultViewForWorkspace(item.key)]),
    ),
  );
  const activeWorkspace = WORKSPACE_BY_KEY[workspace] || WORKSPACES[0];
  const activeView =
    activeViews[workspace] || defaultViewForWorkspace(workspace);

  function handleWorkspaceChange(key) {
    setWorkspace(key);
    setActiveViews((prev) =>
      prev[key] ? prev : { ...prev, [key]: defaultViewForWorkspace(key) },
    );
  }

  function handleViewChange(key) {
    setActiveViews((prev) => ({ ...prev, [workspace]: key }));
  }

  return (
    <div>
      {" "}
      <style>{`
        @media (max-width: 640px) {
          .seo-tab-bar { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; justify-content: flex-start !important; scrollbar-width: none; }
          .seo-tab-bar::-webkit-scrollbar { display: none; }
          .seo-tab-bar-inner { flex-wrap: nowrap !important; }
          .seo-tab-bar button { padding: 8px 12px !important; font-size: 12px !important; flex-shrink: 0 !important; }
          .seo-kpi-grid-4 { grid-template-columns: repeat(2, 1fr) !important; }
          .seo-kpi-grid-5 { grid-template-columns: repeat(2, 1fr) !important; }
          .seo-kpi-grid-3 { grid-template-columns: 1fr !important; }
          .seo-sub-tabs { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; flex-wrap: nowrap !important; }
          .seo-sub-tabs button { flex-shrink: 0 !important; }
          .seo-workspace-nav { scrollbar-width: none; }
          .seo-workspace-nav::-webkit-scrollbar { display: none; }
          .seo-top-pages-header { display: none !important; }
          .seo-top-pages-row { flex-wrap: wrap !important; gap: 4px !important; }
          .seo-top-pages-row >div:first-child { width: 100% !important; flex: none !important; }
          .seo-audit-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .seo-audit-expanded-grid { grid-template-columns: 1fr !important; }
          .seo-audit-history-grid { grid-template-columns: repeat(3, 1fr) !important; }
          .seo-funnel-stats { grid-template-columns: 1fr 1fr 1fr !important; }
          .seo-analytics-period { flex-wrap: wrap !important; }
        }
      `}</style>{" "}
      <AdminCommandHeader
        title="SEO"
        icon={Search}
        sections={WORKSPACES}
        activeKey={workspace}
        onSectionChange={handleWorkspaceChange}
        ariaLabel="SEO section"
        navGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-6"
      />
      <SEOWorkspaceNav
        sections={activeWorkspace.sections}
        activeKey={activeView}
        onChange={handleViewChange}
      />
      {activeView === "dashboard" && (
        <Suspense
          fallback={
            <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
              Loading dashboard...
            </div>
          }
        >
          <SEODashboardPage domain={PRIMARY_DOMAIN} />
        </Suspense>
      )}
      {activeView === "advisor" && <AdvisorTab />}
      {activeView === "rankings" && <RankingsTab />}
      {activeView === "rankings-monitor" && <RankingsMonitorTab />}
      {activeView === "backlinks" && <BacklinksTab />}
      {activeView === "content-qa" && <ContentQATab />}
      {activeView === "ai-overview" && <AIOverviewTab />}
      {activeView === "funnel" && <FunnelTab />}
      {activeView === "analytics" && <AnalyticsTab />}
      {activeView === "by-site" && <BySiteTab />}
      {activeView === "url-intel" && <UrlIntelTab domain={PRIMARY_DOMAIN} />}
      {activeView === "actions" && <ActionsTab domain={PRIMARY_DOMAIN} />}
      {activeView === "indexation" && <IndexationTab domain={PRIMARY_DOMAIN} />}
      {activeView === "site-audit" && <SiteAuditTab />}
    </div>
  );
}
