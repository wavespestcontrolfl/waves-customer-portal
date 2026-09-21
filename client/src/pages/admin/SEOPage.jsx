import { Fragment, useState, useEffect, useRef, lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { formatETDate, formatETDateTime } from "../../lib/timezone";
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
import {
  ActionFeedback,
  Button,
  Card as UiCard,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  UiSurface,
} from "../../components/ui";
const SEODashboardPage = lazy(() => import("./SEODashboardPage"));
// Pillar 3 V2 — real Google-map heat map overlay. Lazy so the Maps SDK only
// loads when a user opens the Geo-Grid tab's Map view (not on every SEO page).
const GeoGridMap = lazy(() => import("../../components/admin/GeoGridMap"));
const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: `teal` folded to zinc-900, `purple` folded to zinc-900.
// Semantic green/amber/red preserved for status/change accents.
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
      let code = null;
      let review = null;
      try {
        const data = await r.clone().json();
        message = data?.error || message;
        code = data?.code || null; // a structured refusal (the outreach send) keeps its code for the message map
        review = data?.review || null; // …and the recipient review it was computed with (the owner acknowledges THAT hash)
      } catch {
        /* keep default message */
      }
      const err = new Error(message);
      if (code) err.code = code;
      if (review) err.review = review;
      throw err;
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
    return (
      JSON.parse(localStorage.getItem("waves_admin_user") || "{}")?.role ===
      "admin"
    );
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
const WORKSPACES = [
  {
    key: "command",
    label: "Command",
    Icon: LayoutDashboard,
    sections: [
      {
        key: "dashboard",
        label: "Dashboard",
      },
      {
        key: "advisor",
        label: "SEO Advisor",
      },
    ],
  },
  {
    key: "strategy",
    label: "Strategy",
    Icon: Sparkles,
    sections: [
      {
        key: "actions",
        label: "Actions",
      },
      {
        key: "content-qa",
        label: "Content QA",
      },
      {
        key: "refresh-audit",
        label: "Refresh Audit",
      },
    ],
  },
  {
    key: "performance",
    label: "Rankings",
    Icon: TrendingUp,
    sections: [
      {
        key: "rankings",
        label: "Rankings",
      },
      {
        key: "rankings-monitor",
        label: "Monitor",
      },
      {
        key: "funnel",
        label: "Funnel",
      },
      {
        key: "geo-grid",
        label: "Geo-Grid",
      },
    ],
  },
  {
    key: "authority",
    label: "Authority",
    Icon: Link,
    sections: [
      {
        key: "backlinks",
        label: "Backlinks & Citations",
      },
      {
        key: "ai-overview",
        label: "AI Overview",
      },
    ],
  },
  {
    key: "technical",
    label: "Technical",
    Icon: Activity,
    sections: [
      {
        key: "url-intel",
        label: "URL Intel",
      },
      {
        key: "indexation",
        label: "Indexation",
      },
      {
        key: "site-audit",
        label: "Site Health",
      },
    ],
  },
  {
    key: "measurement",
    label: "Measurement",
    Icon: BarChart3,
    sections: [
      {
        key: "analytics",
        label: "Analytics",
      },
      {
        key: "by-site",
        label: "By Site",
      },
    ],
  },
];
const SEO_WORKSPACES = WORKSPACES.map((workspace) => ({
  ...workspace,
  className: "!h-11 !min-h-11 !text-14 !normal-case !tracking-normal",
  sections: workspace.sections.map((section) => ({
    ...section,
    className: "!h-11 !min-h-11 !text-14 !normal-case !tracking-normal",
  })),
}));
const WORKSPACE_BY_KEY = Object.fromEntries(
  SEO_WORKSPACES.map((workspace) => [workspace.key, workspace]),
);
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading SEO data...
      </div>
    );
  const cur = data?.current || {};
  const chg = data?.change || {};
  const posColor = (v) => (v >= 0 ? "#15803D" : "#991B1B");
  const filteredQueries = (data?.topQueries || []).filter((q) => {
    if (queryFilter === "nonbrand") return !q.is_branded;
    if (queryFilter === "branded") return q.is_branded;
    return true;
  });
  return (
    <div className="flex flex-col [gap:20px]">
      {" "}
      <div className="flex [gap:4px] bg-zinc-100 rounded-md [padding:3px] self-start">
        {[7, 28, 90].map((p) => (
          <Button
            key={p}
            onClick={() => setPeriod(p)}
            variant={period === p ? "primary" : "secondary"}
          >
            {p === 7 ? "7 Days" : p === 28 ? "28 Days" : "90 Days"}
          </Button>
        ))}
      </div>{" "}
      <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:14px]">
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
          color={"#18181B"}
        />{" "}
      </div>{" "}
      <UiCard className="p-6">
        {" "}
        <div className="flex justify-between items-center [margin-bottom:16px]">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900">
            Top Queries
          </div>{" "}
          <div className="flex [gap:4px]">
            {[
              ["all", "All"],
              ["nonbrand", "Non-Brand"],
              ["branded", "Branded"],
            ].map(([k, l]) => (
              <Button
                key={k}
                onClick={() => setQueryFilter(k)}
                variant={queryFilter === k ? "primary" : "secondary"}
              >
                {l}
              </Button>
            ))}
          </div>{" "}
        </div>{" "}
        <div className="overflow-x-auto">
          {" "}
          <Table className="[width:100%] [border-collapse:collapse]">
            <THead>
              <TR>
                <TH>Query</TH>
                <TH className="text-right u-nums">Clicks</TH>
                <TH className="text-right u-nums">Impr</TH>
                <TH className="text-right u-nums">CTR</TH>
                <TH className="text-right u-nums">Position</TH>
              </TR>
            </THead>
            <TBody>
              {filteredQueries.slice(0, 25).map((q, i) => {
                const pos = parseFloat(q.avg_position).toFixed(1);
                return (
                  <TR key={i}>
                    <TD>
                      {q.query}{" "}
                      {q.is_branded && (
                        <span
                          style={{
                            background: "#18181B" + "22",
                          }}
                          className="text-ui-body [padding:1px_5px] rounded-xs text-zinc-900 [margin-left:4px]"
                        >
                          BRAND
                        </span>
                      )}
                    </TD>
                    <TD className="text-right u-nums">{parseInt(q.clicks)}</TD>
                    <TD className="text-right u-nums">
                      {parseInt(q.impressions).toLocaleString()}
                    </TD>
                    <TD className="text-right u-nums">
                      {parseInt(q.impressions) > 0
                        ? (
                            (parseInt(q.clicks) / parseInt(q.impressions)) *
                            100
                          ).toFixed(1) + "%"
                        : "0%"}
                    </TD>
                    <TD
                      style={{
                        color:
                          pos <= 3
                            ? "#15803D"
                            : pos <= 10
                              ? "#18181B"
                              : pos <= 20
                                ? "#A16207"
                                : "#991B1B",
                      }}
                      className="text-right u-nums"
                    >
                      {pos}
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
        background: ok ? "#15803D" : warn ? "#A16207" : "#991B1B",
      }}
      className="inline-block [width:8px] [height:8px] rounded-xs [margin-right:8px]"
    />
  );
  const section = (label, children) => (
    <div className="[margin-bottom:10px]">
      {" "}
      <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
        {label}
      </div>{" "}
      <div className="text-ui-body text-zinc-900 [line-height:1.6]">
        {children}
      </div>{" "}
    </div>
  );
  return (
    <UiCard className="p-6 border-l border-hairline border-zinc-200">
      {" "}
      <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:8px]">
        SEO sync health
      </div>{" "}
      <div className="text-ui-body text-ink-secondary [margin-bottom:12px]">
        The Advisor runs on data from <code>gsc_performance_daily</code> +{" "}
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
              <span className="text-ink-secondary">
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
              <span className="text-ink-secondary">
                · last sync {String(gsc.daily.lastDate).slice(0, 10)}
                {gsc.staleDays != null && gsc.staleDays > 2
                  ? ` (${gsc.staleDays}d old)`
                  : ""}
              </span>
            )}
          </div>{" "}
          <div className="text-ink-secondary">
            {gsc.queries?.count || 0} query rows in{" "}
            <code>gsc_queries</code>{" "}
          </div>{" "}
        </>,
      )}
      {section(
        "Google Business Profile (per location)",
        <div className="grid [grid-template-columns:1fr_1fr] [gap:6px]">
          {gbpLocations.map((l) => (
            <div key={l.id}>
              {" "}
              <StatusDot
                ok={l.configured && l.rowCount > 0}
                warn={l.configured && l.rowCount === 0}
              />{" "}
              <strong>{l.name}</strong>{" "}
              <div className="text-ui-body text-ink-secondary [margin-left:16px]">
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
            <div className="text-ink-secondary">
              No location sync rows reported.
            </div>
          )}
        </div>,
      )}
      <div className="text-ui-body text-ink-secondary [margin-top:10px] [padding-top:8px] border-t border-hairline border-zinc-200">
        Sync runs daily at 6am ET (see <code>scheduler.js</code>). If rows stay
        at 0 after 24h, grep Railway logs for <code>[GSC]</code> and{" "}
        <code>[GBP]</code> to see init errors.
      </div>{" "}
    </UiCard>
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
      <div className="text-ink-secondary [padding:40px] text-center">
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
      <div className="flex flex-col [gap:20px]">
        {" "}
        <SyncHealthCard />{" "}
        <UiCard className="[padding:40px] text-center">
          {" "}
          <div className="text-ink-secondary [margin-bottom:16px]">
            No SEO reports yet.
          </div>{" "}
          {canRunSeoActions && (
            <Button onClick={generate} disabled={generating}>
              {generating
                ? "Syncing & generating..."
                : "Sync GSC & Generate Report"}
            </Button>
          )}{" "}
        </UiCard>{" "}
      </div>
    );
  const data = report.report_data || {};
  const gradeColor = (g) =>
    !g
      ? "#71717A"
      : g.startsWith("A")
        ? "#15803D"
        : g.startsWith("B")
          ? "#18181B"
          : g.startsWith("C")
            ? "#A16207"
            : "#991B1B";
  return (
    <div className="flex flex-col [gap:20px]">
      {" "}
      <SyncHealthCard />{" "}
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
            className="[width:72px] [height:72px] rounded-md flex items-center justify-center text-[32px] font-medium"
          >
            {data.grade || "?"}
          </div>{" "}
          <div className="[flex:1]">
            {" "}
            <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
              SEO Grade
            </div>{" "}
            <div className="text-ui-body text-zinc-900 [line-height:1.5]">
              {data.overall_assessment}
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </UiCard>
      {(data.recommendations || []).length > 0 && (
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Recommendations
          </div>
          {data.recommendations.map((rec, i) => (
            <div
              key={i}
              style={{
                borderLeft: `3px solid ${rec.priority === "high" ? "#991B1B" : rec.priority === "medium" ? "#A16207" : "#71717A"}`,
              }}
              className="[padding:12px_14px] bg-zinc-100 rounded-md [margin-bottom:6px]"
            >
              {" "}
              <div className="text-ui-body font-medium text-zinc-900">
                {rec.action}
              </div>
              {rec.reasoning && (
                <div className="text-ui-body text-ink-secondary [margin-top:2px]">
                  {rec.reasoning}
                </div>
              )}
            </div>
          ))}
        </UiCard>
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading...
      </div>
    );
  if (!data)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">{emptyMsg || "No data yet."}</div>
      </UiCard>
    );
  return (
    <div className="flex flex-col [gap:16px]">
      {data.summary && (
        <div
          className="seo-kpi-grid-5 grid max-sm:!grid-cols-2 [gap:12px]"
          style={{
            gridTemplateColumns: `repeat(${Math.min(Object.keys(data.summary).length, 5)}, 1fr)`,
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
      <UiCard className="p-6">
        <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
          {title}
        </div>
        <div className="text-ui-body text-ink-secondary">
          Data loaded from {endpoint}
        </div>
      </UiCard>{" "}
    </div>
  );
}
function GeoStat({ label, value }) {
  return (
    <div>
      <div className="text-ui-body text-ink-secondary">{label}</div>
      <div className="text-[22px] font-medium text-zinc-900">{value}</div>
    </div>
  );
}
function GeoLegend({ color, text }) {
  return (
    <span className="inline-flex items-center [gap:5px]">
      <span
        style={{
          background: color,
        }}
        className="[width:12px] [height:12px] rounded-xs inline-block"
      />
      {text}
    </span>
  );
}
function geoRankColor(rank) {
  if (rank == null)
    return {
      bg: "#E4E4E7",
      fg: "#71717A",
      label: "—",
    };
  if (rank <= 3)
    return {
      bg: "#15803D",
      fg: "#fff",
      label: String(rank),
    };
  if (rank <= 10)
    return {
      bg: "#A16207",
      fg: "#fff",
      label: String(rank),
    };
  if (rank <= 20)
    return {
      bg: "#991B1B",
      fg: "#fff",
      label: String(rank),
    };
  return {
    bg: "#52525B",
    fg: "#fff",
    label: "20+",
  };
}

// Pillar 3 — geo-grid map-pack tracker. Pick an office + keyword, see a heat map
// of where the office ranks in the local pack block-by-block across the market.
function GeoGridTab() {
  const [cfg, setCfg] = useState(null);
  const [office, setOffice] = useState("");
  const [keyword, setKeyword] = useState("");
  const [heat, setHeat] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState("grid"); // "grid" | "map"
  const [scanGridSize, setScanGridSize] = useState(5); // N for the NEXT scan
  const [editingKw, setEditingKw] = useState(false);
  const [kwDraft, setKwDraft] = useState("");
  const [kwSaving, setKwSaving] = useState(false);
  const [kwErr, setKwErr] = useState("");
  useEffect(() => {
    adminFetch("/admin/seo/geo-grid")
      .then((d) => {
        setCfg(d);
        if (d?.offices?.length) setOffice(d.offices[0].id);
        if (d?.keywords?.length) setKeyword(d.keywords[0]);
        if (d?.gridSize) setScanGridSize(d.gridSize);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);
  const loadHeat = () => {
    if (!office || !keyword) return;
    adminFetch(
      `/admin/seo/geo-grid/heatmap?office=${encodeURIComponent(office)}&keyword=${encodeURIComponent(keyword)}`,
    )
      .then(setHeat)
      .catch(() => setHeat(null));
  };
  // Current selection mirror — so an in-flight scan poll doesn't write results
  // for a selection the user has since changed away from.
  const selRef = useRef({
    office,
    keyword,
  });
  useEffect(() => {
    selRef.current = {
      office,
      keyword,
    };
    setHeat(null);
    loadHeat();
  }, [office, keyword]);
  const runScan = async () => {
    const scanned = {
      office,
      keyword,
    };
    setRunning(true);
    try {
      const r = await adminFetch("/admin/seo/geo-grid/run", {
        method: "POST",
        body: { officeId: office, keyword, gridSize: scanGridSize },
      });
      if (r?.started === false) {
        setRunning(false);
        return;
      }
      let n = 0;
      const t = setInterval(async () => {
        n += 1;
        const s = await adminFetch("/admin/seo/geo-grid").catch(() => null);
        if (!s?.scanning || n > 18) {
          clearInterval(t);
          setRunning(false);
          // Only reload if the user hasn't switched office/keyword since starting.
          if (
            selRef.current.office === scanned.office &&
            selRef.current.keyword === scanned.keyword
          )
            loadHeat();
        }
      }, 20000);
    } catch {
      setRunning(false);
    }
  };

  // CSV of the current office+keyword heat map. Plain fetch (not adminFetch,
  // which JSON-parses) → blob → download, carrying the admin bearer token.
  const downloadCsv = async () => {
    try {
      const res = await fetch(
        `${API_BASE}/admin/seo/geo-grid/export?office=${encodeURIComponent(office)}&keyword=${encodeURIComponent(keyword)}`,
        { headers: { Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}` } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `geo-grid-${office}-${keyword.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* surfaced via the disabled-state; a failed export is non-critical */
    }
  };
  const openKwEditor = () => {
    setKwDraft((cfg?.keywords || []).join(", "));
    setKwErr("");
    setEditingKw(true);
  };
  const saveKeywords = async () => {
    const list = kwDraft
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (!list.length) {
      setKwErr("Enter at least one keyword.");
      return;
    }
    setKwSaving(true);
    setKwErr("");
    try {
      const r = await adminFetch("/admin/seo/geo-grid/keywords", {
        method: "POST",
        body: { keywords: list },
      });
      const saved = r?.keywords || list;
      setCfg((c) => ({
        ...c,
        keywords: saved,
      }));
      if (!saved.includes(keyword)) setKeyword(saved[0]);
      setEditingKw(false);
    } catch (e) {
      setKwErr(e.message || "Save failed.");
    } finally {
      setKwSaving(false);
    }
  };
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading geo-grid…
      </div>
    );
  if (!cfg)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">Geo-grid unavailable.</div>
      </UiCard>
    );
  const size = heat?.gridSize || cfg.gridSize;
  const byCell = {};
  (heat?.pins || []).forEach((p) => {
    byCell[`${p.pin_row}-${p.pin_col}`] = p;
  });
  const stats = heat?.stats;
  const officeCenter = cfg.offices.find((o) => o.id === office);
  return (
    <div>
      <div className="flex [gap:12px] items-center flex-wrap [margin-bottom:16px]">
        <Select className="!w-auto" value={office} onChange={(e) => setOffice(e.target.value)}>
          {cfg.offices.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
        <Select className="!w-auto" value={keyword} onChange={(e) => setKeyword(e.target.value)}>
          {cfg.keywords.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Button
          onClick={openKwEditor}
          title="Edit the tracked keywords"
          variant="secondary"
        >
          Edit keywords
        </Button>
        <Select
          className="!w-auto"
          value={scanGridSize}
          onChange={(e) => setScanGridSize(Number(e.target.value))}
          title="Grid size for the next scan (N×N pins per office)"
        >
          {(cfg.gridSizeOptions || [cfg.gridSize]).map((n) => (
            <option key={n} value={n}>
              {n}×{n}
            </option>
          ))}
        </Select>
        <Button onClick={runScan} disabled={running || cfg.gated}>
          {running ? "Scanning…" : "Run scan"}
        </Button>
        <Button
          onClick={downloadCsv}
          disabled={!heat?.pins?.length}
          title="Export this heat map to CSV"
          variant="secondary"
        >
          Export CSV
        </Button>
        {cfg.gated && (
          <span className="text-zinc-700 text-ui-body">
            Gated off — set GATE_GEO_GRID=true to run.
          </span>
        )}
        <div className="[margin-left:auto] inline-flex rounded-sm overflow-hidden border-hairline border-zinc-200">
          {["grid", "map"].map((v) => (
            <Button
              key={v}
              onClick={() => setView(v)}
              variant={view === v ? "primary" : "secondary"}
            >
              {v}
            </Button>
          ))}
        </div>
      </div>

      {editingKw && (
        <UiCard className="[padding:14px] [margin-bottom:16px]">
          <div className="text-ui-body text-ink-secondary [margin-bottom:8px]">
            Tracked keywords (comma-separated, up to 6). Fewer keywords = lower
            DataForSEO spend per scan.
          </div>
          <div className="flex [gap:10px] items-center flex-wrap">
            <Input
              value={kwDraft}
              onChange={(e) => setKwDraft(e.target.value)}
              placeholder="pest control, exterminator, termite control"
              className="[flex:1] [min-width:280px]"
            />
            <Button onClick={saveKeywords} disabled={kwSaving}>
              {kwSaving ? "Saving…" : "Save"}
            </Button>
            <Button onClick={() => setEditingKw(false)} variant="secondary">
              Cancel
            </Button>
          </div>
          {kwErr && (
            <div className="text-alert-fg text-ui-body [margin-top:8px]">
              {kwErr}
            </div>
          )}
        </UiCard>
      )}

      {stats && (
        <div className="flex [gap:28px] [margin-bottom:16px] flex-wrap">
          <GeoStat label="In top 3" value={`${stats.top3Pct}%`} />
          <GeoStat label="Avg rank" value={stats.avgRank ?? "—"} />
          <GeoStat label="Share of voice" value={`${stats.solv}%`} />
          <GeoStat
            label="Found / pins"
            value={`${stats.found}/${stats.total}`}
          />
          <GeoStat label="Last scan" value={heat.scanDate} />
        </div>
      )}

      <UiCard className="p-6">
        {!heat?.pins?.length ? (
          <div className="text-ink-secondary [padding:30px] text-center">
            No scan yet for this office + keyword.{" "}
            {cfg.gated
              ? "Enable GATE_GEO_GRID (and seoIntelligence), then "
              : ""}
            click “Run scan”.
          </div>
        ) : view === "map" ? (
          <Suspense
            fallback={
              <div className="text-ink-secondary [padding:30px] text-center">
                Loading map…
              </div>
            }
          >
            <GeoGridMap
              pins={heat.pins}
              center={
                officeCenter && officeCenter.latitude != null
                  ? {
                      lat: Number(officeCenter.latitude),
                      lng: Number(officeCenter.longitude),
                    }
                  : null
              }
            />
          </Suspense>
        ) : (
          <div
            style={{
              gridTemplateColumns: `repeat(${size}, 1fr)`,
            }}
            className="grid [gap:4px] [max-width:360px] [margin:0_auto]"
          >
            {Array.from({
              length: size * size,
            }).map((_, i) => {
              const row = Math.floor(i / size);
              const col = i % size;
              const p = byCell[`${row}-${col}`];
              const c = geoRankColor(p ? p.map_pack_rank : null);
              return (
                <div
                  key={i}
                  data-geo-grid-cell
                  title={
                    p ? `(${p.latitude}, ${p.longitude}) — rank ${c.label}` : ""
                  }
                  style={{
                    background: c.bg,
                    color: c.fg,
                  }}
                  className="aspect-square rounded-sm flex items-center justify-center text-ui-body font-medium"
                >
                  {c.label}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex [gap:14px] justify-center [margin-top:14px] text-ui-body text-ink-secondary flex-wrap">
          <GeoLegend color={"#15803D"} text="1–3" />
          <GeoLegend color={"#A16207"} text="4–10" />
          <GeoLegend color={"#991B1B"} text="11–20" />
          <GeoLegend color="#52525B" text="20+" />
          <GeoLegend color="#E4E4E7" text="not in pack" />
        </div>
      </UiCard>
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading rankings...
      </div>
    );
  if (!data?.rankings?.length)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">
          No ranking data yet. Configure DataForSEO and enable
          GATE_SEO_INTELLIGENCE.
        </div>
      </UiCard>
    );
  const s = data.summary || {};
  const posColor = (p) =>
    !p
      ? "#71717A"
      : p <= 3
        ? "#15803D"
        : p <= 10
          ? "#18181B"
          : p <= 20
            ? "#A16207"
            : "#991B1B";
  return (
    <div className="flex flex-col [gap:16px]">
      {" "}
      <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:12px]">
        {" "}
        <KpiCard
          label="Improving"
          value={s.improving || 0}
          color={"#15803D"}
        />{" "}
        <KpiCard label="Declining" value={s.declining || 0} color={"#991B1B"} />{" "}
        <KpiCard label="Stable" value={s.stable || 0} />{" "}
        <KpiCard
          label="Map Pack"
          value={s.inMapPack || 0}
          color={"#18181B"}
        />{" "}
      </div>{" "}
      <UiCard className="p-6">
        <div className="overflow-x-auto">
          <Table className="[width:100%] [border-collapse:collapse]">
            <THead>
              <TR>
                <TH>Keyword</TH>
                <TH>City</TH>
                <TH className="text-right u-nums">Position</TH>
                <TH className="text-right u-nums">Change</TH>
                <TH>AIO</TH>
              </TR>
            </THead>
            <TBody>
              {data.rankings.map((r, i) => (
                <TR key={i}>
                  <TD className="font-medium">{r.keyword}</TD>
                  <TD className="text-ink-secondary">
                    {r.primary_city || "—"}
                  </TD>
                  <TD
                    style={{
                      color: posColor(r.currentPosition),
                    }}
                    className="text-right u-nums"
                  >
                    {r.currentPosition || "—"}
                  </TD>
                  <TD
                    style={{
                      color:
                        r.delta > 0
                          ? "#15803D"
                          : r.delta < 0
                            ? "#991B1B"
                            : "#71717A",
                    }}
                    className="text-right u-nums"
                  >
                    {r.delta > 0 ? `+${r.delta}` : r.delta || "—"}
                  </TD>
                  <TD className="text-center">
                    {r.aiOverviewCited ? "Yes" : "—"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </UiCard>{" "}
    </div>
  );
}

// ── Rankings Monitor — per-page position before/now + change chips ──

const CHIP_COLORS = {
  META: "#A16207",
  CONTENT: "#18181B",
  LINKS: "#15803D",
  SCHEMA: "#71717A",
};
const CHIP_MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
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
  const color = CHIP_COLORS[ann.type] || "#71717A";
  const verdict =
    ann.status === "accepted" ? " ✓" : ann.status === "rejected" ? " ✗" : "";
  const title = `${ann.type.toLowerCase()} change on ${ann.date}${ann.count > 1 ? ` (×${ann.count})` : ""} — source: ${(ann.sources || []).join(", ")}${ann.status ? ` · experiment ${ann.status}` : ""}`;
  return (
    <span
      title={title}
      style={{
        border: `1px solid ${color}`,
        color,
      }}
      className="inline-block [padding:1px_7px] rounded-sm text-ui-body font-medium whitespace-nowrap"
    >
      {ann.type} · {chipDateLabel(ann.date)}
      {ann.count > 1 ? ` ×${ann.count}` : ""}
      {verdict}
    </span>
  );
}
function beforeAfter(before, now, suffix = "") {
  if (before == null)
    return (
      <span>
        {now}
        {suffix}
      </span>
    );
  return (
    <span>
      <span className="text-ink-secondary">
        {before}
        {suffix} →{" "}
      </span>
      {now}
      {suffix}
    </span>
  );
}
function MonitorTable({ title, rows, accent }) {
  if (!rows.length) return null;
  return (
    <UiCard className="[padding:0px]">
      <div
        style={{
          color: accent || "#09090B",
        }}
        className="[padding:14px_16px] text-ui-body font-medium border-b border-hairline border-zinc-200"
      >
        {title} ({rows.length})
      </div>
      <div className="overflow-x-auto">
        <Table className="[width:100%] [border-collapse:collapse]">
          <THead>
            <TR>
              <TH>Page</TH>
              <TH className="text-right u-nums">Pos Before</TH>
              <TH className="text-right u-nums">Pos Now</TH>
              <TH className="text-right u-nums">Change</TH>
              <TH className="text-right u-nums">Clicks</TH>
              <TH className="text-right u-nums">Imp</TH>
              <TH className="text-right u-nums">CTR</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((p, i) => {
              const host = pageHost(p.page_url);
              const isHub = !host || host === "wavespestcontrol.com";
              return (
                <TR key={`${p.domain || ""}-${p.page_url}-${i}`}>
                  <TD className="[max-width:420px]">
                    <div
                      title={p.page_url}
                      className="text-zinc-900 overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      {!isHub && (
                        <span className="text-ink-secondary text-ui-body">
                          {host}
                        </span>
                      )}
                      {pagePath(p.page_url)}
                    </div>
                    {p.annotations?.length > 0 && (
                      <div className="flex [gap:4px] flex-wrap [margin-top:4px]">
                        {p.annotations.map((a, j) => (
                          <AnnotationChip key={j} ann={a} />
                        ))}
                      </div>
                    )}
                  </TD>
                  <TD className="text-right u-nums">{p.pos_before ?? "—"}</TD>
                  <TD className="text-right u-nums text-zinc-900">
                    {p.pos_now ?? "—"}
                  </TD>
                  <TD
                    style={{
                      color:
                        p.movement === "lost"
                          ? "#991B1B"
                          : p.change == null
                            ? "#71717A"
                            : p.change < 0
                              ? "#15803D"
                              : p.change > 0
                                ? "#991B1B"
                                : "#71717A",
                    }}
                    className="text-right u-nums font-medium"
                  >
                    {p.movement === "lost"
                      ? "GONE"
                      : p.change == null
                        ? "NEW"
                        : p.change > 0
                          ? `+${p.change}`
                          : p.change}
                  </TD>
                  <TD className="text-right u-nums">
                    {beforeAfter(p.clicks_before, p.clicks_now)}
                  </TD>
                  <TD className="text-right u-nums">
                    {beforeAfter(
                      p.impressions_before == null
                        ? null
                        : p.impressions_before.toLocaleString(),
                      p.impressions_now.toLocaleString(),
                    )}
                  </TD>
                  <TD className="text-right u-nums">
                    {beforeAfter(p.ctr_before, p.ctr_now, "%")}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </UiCard>
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading rankings monitor...
      </div>
    );
  if (error)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-alert-fg">{error}</div>
      </UiCard>
    );
  // pages holds only visible movers — an all-flat window arrives with
  // pages empty but pages_tracked > 0, and that's healthy data (the
  // no-movement card below covers it), not missing GSC data.
  if (!data?.pages?.length && !data?.summary?.pages_tracked)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">
          No page data in this window yet. GSC syncs daily at 6am ET; data
          publishes with a ~3 day lag.
        </div>
      </UiCard>
    );
  const s = data.summary || {};
  const wins = data.pages.filter((p) => p.movement === "win");
  // Pages that vanished from GSC entirely are the hardest losses — they
  // share the Losses table, marked GONE.
  const losses = data.pages.filter(
    (p) => p.movement === "loss" || p.movement === "lost",
  );
  const fresh = data.pages.filter((p) => p.movement === "new");
  const deltaSub = (delta, invert = false) => {
    if (delta == null || delta === 0) return null;
    const good = invert ? delta < 0 : delta > 0;
    return {
      text: `${delta > 0 ? "+" : ""}${typeof delta === "number" ? delta.toLocaleString() : delta}`,
      color: good ? "#15803D" : "#991B1B",
    };
  };
  return (
    <div className="flex flex-col [gap:16px]">
      <div className="flex items-center [gap:12px] flex-wrap">
        <div className="flex [gap:4px] bg-zinc-100 rounded-md [padding:3px]">
          {[7, 28, 90].map((p) => (
            <Button
              key={p}
              onClick={() => setPeriod(p)}
              variant={period === p ? "primary" : "secondary"}
            >
              {p === 7 ? "7 Days" : p === 28 ? "28 Days" : "3 Months"}
            </Button>
          ))}
        </div>
        <div className="text-ui-body text-ink-secondary">
          {data.window?.current?.from} → {data.window?.current?.to} vs{" "}
          {data.window?.prior?.from} → {data.window?.prior?.to}
        </div>
      </div>
      <div className="text-ui-body text-ink-secondary">
        Google Search Console publishes data with a ~3 day lag — the most recent
        days shown will be 2–3 days behind today. Chips mark shipped page
        changes: META = title/description rewrite, CONTENT = refresh/new page,
        LINKS = inbound internal links, SCHEMA = structured data.
      </div>
      <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:12px]">
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
      <MonitorTable title="Position wins" rows={wins} accent={"#15803D"} />
      <MonitorTable title="Position losses" rows={losses} accent={"#991B1B"} />
      <MonitorTable title="New pages" rows={fresh} />
      {wins.length + losses.length + fresh.length === 0 && (
        <UiCard className="[padding:40px] text-center">
          <div className="text-ink-secondary">
            No position movement past ±0.5 in this window.
          </div>
        </UiCard>
      )}
    </div>
  );
}

// lost_reason is stamped by the weekly scan only after a crawl of the source page
// confirmed the link is gone; rows without one predate verified loss tracking.
const LOST_REASON_LABEL = {
  page_gone: "page gone (404/410)",
  link_removed: "link removed",
  unreachable: "site unreachable",
};
function BacklinksTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [subTab, setSubTab] = useState("overview");
  const [llmDash, setLlmDash] = useState(null);
  const [llmError, setLlmError] = useState(false);
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

  // Lazy-load citation evidence the first time the
  // LLM Mentions sub-tab is opened.
  useEffect(() => {
    if (subTab !== "llm" || llmDash || llmError) return;
    adminFetch("/admin/seo/llm-mentions")
      .then(setLlmDash)
      .catch(() => setLlmError(true));
  }, [subTab, llmDash, llmError]);
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading backlinks...
      </div>
    );
  if (!data)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">No backlink data yet.</div>
      </UiCard>
    );
  const sevColor = {
    critical: "#991B1B",
    warning: "#A16207",
    watch: "#71717A",
    clean: "#15803D",
  };
  const statusColor = {
    active: "#15803D",
    inconsistent: "#991B1B",
    missing: "#A16207",
    claimed: "#18181B",
    unchecked: "#71717A",
  };
  return (
    <div className="flex flex-col [gap:16px]">
      {/* Sub-tabs */}
      <div className="flex justify-between items-center flex-wrap [gap:8px]">
        {" "}
        <div className="seo-sub-tabs flex max-sm:flex-nowrap max-sm:overflow-x-auto [gap:4px] overflow-x-auto">
          {[
            {
              key: "overview",
              label: "Overview",
            },
            {
              key: "citations",
              label: "Citations",
            },
            {
              key: "gaps",
              label: "Competitor Gaps",
            },
            {
              key: "llm",
              label: "LLM Mentions",
            },
            {
              key: "prospects",
              label: "Link Building",
            },
            {
              key: "agent",
              label: "Agent",
            },
          ].map((t) => (
            <Button
              key={t.key}
              onClick={() => setSubTab(t.key)}
              className="whitespace-nowrap shrink-0"
              variant={subTab === t.key ? "primary" : "secondary"}
            >
              {t.label}
            </Button>
          ))}
        </div>{" "}
        {canRunSeoActions && (
          <Button onClick={handleScan} disabled={scanning} variant="secondary">
            {scanning ? "Scanning..." : "Scan Backlinks"}
          </Button>
        )}{" "}
      </div>
      {/* Stats */}
      <div className="seo-kpi-grid-5 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(5,_1fr)] [gap:10px]">
        {" "}
        <KpiCard label="Total Links" value={data.total || 0} />{" "}
        <KpiCard
          label="Critical"
          value={data.critical || 0}
          color={"#991B1B"}
        />{" "}
        <KpiCard label="Warning" value={data.warning || 0} color={"#A16207"} />{" "}
        <KpiCard label="Clean" value={data.clean || 0} color={"#15803D"} />{" "}
        <KpiCard
          label="Citations"
          value={data.citationStats?.total || 0}
          sub={{
            text: `${data.citationStats?.active || 0} active`,
          }}
        />{" "}
      </div>
      {/* Velocity KPIs */}
      {data.velocity && (
        <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:10px] [margin-top:10px]">
          <KpiCard
            label="New 7d"
            value={`+${data.velocity.new_7d}`}
            color={"#15803D"}
          />
          <KpiCard
            label="Lost 7d"
            value={
              data.velocity.lost_7d > 0 ? `-${data.velocity.lost_7d}` : "0"
            }
            color={data.velocity.lost_7d > 0 ? "#991B1B" : "#71717A"}
          />
          <KpiCard
            label="Net 7d"
            value={
              data.velocity.net_7d >= 0
                ? `+${data.velocity.net_7d}`
                : `${data.velocity.net_7d}`
            }
            color={
              data.velocity.net_7d > 0
                ? "#15803D"
                : data.velocity.net_7d < 0
                  ? "#991B1B"
                  : "#71717A"
            }
          />
          <KpiCard
            label="Trend"
            value={
              data.velocity.trend === "growing"
                ? "Growing"
                : data.velocity.trend === "shrinking"
                  ? "Shrinking"
                  : "Flat"
            }
            color={
              data.velocity.net_7d > 0
                ? "#15803D"
                : data.velocity.net_7d < 0
                  ? "#991B1B"
                  : "#71717A"
            }
          />
        </div>
      )}
      {/* Overview sub-tab */}
      {subTab === "overview" && (
        <>
          {data.anchorDistribution && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                Anchor Text Distribution
              </div>
              {Object.entries(data.anchorDistribution).map(([type, count]) => (
                <div
                  key={type}
                  className="flex items-center [gap:10px] [margin-bottom:6px]"
                >
                  {" "}
                  <div className="[width:100px] text-ui-body text-zinc-900 text-right">
                    {type.replace("_", " ")}
                  </div>{" "}
                  <div className="[flex:1] [height:14px] bg-zinc-100 rounded-xs">
                    {" "}
                    <div
                      style={{
                        background:
                          type === "branded"
                            ? "#15803D"
                            : type === "keyword_rich"
                              ? "#A16207"
                              : "#18181B",
                        width: `${Math.min(100, (count / Math.max(data.total, 1)) * 100)}%`,
                      }}
                      className="[height:100%] rounded-xs"
                    />{" "}
                  </div>{" "}
                  <div className="[width:30px] text-ui-body text-ink-secondary">
                    {count}
                  </div>{" "}
                </div>
              ))}
            </UiCard>
          )}
          {(data.recentToxic || []).length > 0 && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-alert-fg [margin-bottom:12px]">
                Toxic Links
              </div>
              {data.recentToxic.map((l, i) => (
                <div
                  key={i}
                  style={{
                    borderLeft: `3px solid ${sevColor[l.severity]}`,
                  }}
                  className="[padding:8px_12px] bg-zinc-100 rounded-sm [margin-bottom:4px]"
                >
                  {" "}
                  <div className="text-ui-body text-zinc-900">
                    {l.source_domain}
                  </div>{" "}
                  <div className="text-ui-body text-ink-secondary">
                    Anchor: "{l.anchor_text}" · Toxicity: {l.toxicity_score}/100
                  </div>{" "}
                </div>
              ))}
            </UiCard>
          )}
          {/* Trend */}
          {(data.snapshots || []).length > 1 && (
            <UiCard className="p-6">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                Backlink Trend
              </div>{" "}
              <div className="flex [gap:8px] items-end [height:60px]">
                {(data.snapshots || []).reverse().map((s, i) => (
                  <div key={i} className="[flex:1] text-center">
                    {" "}
                    <div className="text-ui-body text-ink-secondary">
                      {s.total_backlinks}
                    </div>{" "}
                    <div
                      style={{
                        height: `${Math.max(4, (s.total_backlinks || 0) / 2)}px`,
                      }}
                      className="bg-zinc-900 rounded-xs [margin-top:2px]"
                    />{" "}
                    <div className="text-ui-body text-ink-secondary [margin-top:2px]">
                      {new Date(s.snapshot_date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </div>{" "}
                  </div>
                ))}
              </div>{" "}
            </UiCard>
          )}

          {/* Recently Lost Links */}
          {(data.recentlyLost || []).length > 0 && (
            <UiCard className="p-6">
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                Recently Lost Links
              </div>
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>Source Domain</TH>
                      <TH className="text-right u-nums">DR</TH>
                      <TH>Anchor</TH>
                      <TH>Target</TH>
                      <TH>Reason</TH>
                      <TH>Lost</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.recentlyLost.map((l, i) => (
                      <TR
                        key={
                          l.id ||
                          `${l.source_domain || "lost"}-${l.target_url || i}`
                        }
                      >
                        <TD className="u-nums">{l.source_domain}</TD>
                        <TD className="text-right u-nums">
                          {l.domain_rating || "—"}
                        </TD>
                        <TD className="[max-width:160px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {l.anchor_text || "—"}
                        </TD>
                        <TD className="[max-width:200px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {l.target_url || "—"}
                        </TD>
                        <TD className="u-nums">
                          {LOST_REASON_LABEL[l.lost_reason] ||
                            (l.lost_reason
                              ? l.lost_reason
                              : "unverified (legacy)")}
                        </TD>
                        <TD className="u-nums">
                          {l.lost_at || l.updated_at
                            ? formatETDate(l.lost_at || l.updated_at)
                            : "—"}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </UiCard>
          )}
        </>
      )}

      {/* Citations sub-tab */}
      {subTab === "citations" && (
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Directory Citations ({data.citationStats?.total || 0})
          </div>
          {(data.citations || []).map((c, i) => (
            <div
              key={i}
              className="flex items-center [gap:10px] [padding:8px_0] border-b border-hairline border-zinc-200"
            >
              {" "}
              <div
                style={{
                  background: statusColor[c.status] || "#71717A",
                }}
                className="[width:8px] [height:8px] rounded-sm shrink-0"
              />{" "}
              <div className="[flex:1] text-ui-body text-zinc-900">
                {c.directory_name}
              </div>
              {c.listing_url && (
                <a
                  href={c.listing_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ui-body text-zinc-900 [text-decoration:none]"
                >
                  View
                </a>
              )}
              <span
                style={{
                  background: (statusColor[c.status] || "#71717A") + "22",
                  color: statusColor[c.status] || "#71717A",
                }}
                className="text-ui-body [padding:2px_8px] rounded-sm font-medium"
              >
                {c.status}
              </span>{" "}
            </div>
          ))}
        </UiCard>
      )}

      {/* Competitor Gaps sub-tab */}
      {subTab === "gaps" && (
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-700 [margin-bottom:12px]">
            Competitor Gap Opportunities ({(data.competitorGaps || []).length})
            {data.newGapsSince7d > 0 && (
              <span className="[margin-left:8px] [padding:2px_8px] rounded-sm text-ui-body font-medium text-zinc-900 [background:#15803D18]">
                {data.newGapsSince7d} new this week
                {data.newHighValueGapsSince7d > 0
                  ? ` (${data.newHighValueGapsSince7d} high-value)`
                  : ""}
              </span>
            )}
          </div>{" "}
          <div className="text-ui-body text-ink-secondary [margin-bottom:12px]">
            Domains linking to competitors but not to Waves
          </div>
          {(data.competitorGaps || []).length === 0 ? (
            <div className="text-ui-body text-ink-secondary [padding:20px] text-center">
              Run a competitor gap scan to find opportunities
            </div>
          ) : (
            (data.competitorGaps || []).map((g, i) => (
              <div
                key={i}
                className="[padding:8px_12px] bg-zinc-100 rounded-sm [margin-bottom:4px]"
              >
                {" "}
                <div className="flex justify-between items-center">
                  {" "}
                  <div className="flex items-center [gap:6px]">
                    <span className="text-ui-body text-zinc-900 font-medium">
                      {g.source_domain}
                    </span>
                    {g.created_at &&
                      new Date(g.created_at) >=
                        new Date(Date.now() - 7 * 86400000) && (
                        <span className="[padding:1px_6px] rounded-xs text-ui-body font-medium text-zinc-900 [background:#15803D18]">
                          New
                        </span>
                      )}
                  </div>{" "}
                  <span className="text-ui-body text-ink-secondary">
                    DR: {g.source_domain_rating || "?"}
                  </span>{" "}
                </div>{" "}
                <div className="text-ui-body text-ink-secondary">
                  Links to: {g.competitor_domain} · Anchor: "
                  {(g.anchor_text || "").substring(0, 40)}"
                </div>{" "}
              </div>
            ))
          )}
        </UiCard>
      )}

      {/* Citation evidence and brand mentions are separate measurements. */}
      {subTab === "llm" && (
        <div className="flex flex-col [gap:12px] [min-width:0px]">
          <UiCard className="p-6">
            <div className="flex justify-between [gap:16px] flex-wrap">
              <div>
                <h3 className="text-[18px] font-medium text-zinc-900 [margin:0_0_8px]">
                  AI citations and mentions
                </h3>
                <p className="text-ui-body text-ink-secondary [margin:0px]">
                  {llmDash
                    ? `${llmDash.summary.queriesTracked} active queries observed across ${llmDash.summary.platforms.length} engines`
                    : llmError
                      ? "Observations could not be loaded."
                      : "Loading observations…"}
                </p>
              </div>
              {canRunSeoActions && (
                <Button
                  onClick={handleLlmScan}
                  disabled={llmScanning}
                  variant="secondary"
                >
                  {llmScanning ? "Scanning…" : "Run Scan"}
                </Button>
              )}
            </div>
            <p className="text-ui-body text-ink-secondary [line-height:1.6] [margin-bottom:0px]">
              Citation rate counts answers with a Waves source link attached.
              Mention rate counts answers that name Waves. Search-result links
              do not count as citations. Unanswered probes and unresolved links
              are excluded from rates. These API observations are directional;
              validate a sample in each consumer app.
            </p>
            {llmError && (
              <Button
                onClick={() => setLlmError(false)}
                className="[margin-top:12px]"
                variant="secondary"
              >
                Retry loading observations
              </Button>
            )}
          </UiCard>
          {llmDash?.benchmark && (
            <UiCard className="p-6">
              <h3 className="text-ui-body text-zinc-900 font-medium [margin-top:0px]">
                Fixed 40-question benchmark
              </h3>
              <div className="flex flex-wrap [gap:24px]">
                <div>
                  <div className="text-ui-body text-ink-secondary">
                    Linked citation rate
                  </div>
                  <div className="text-[24px] text-zinc-900">
                    {aeoRate(llmDash.benchmark.citationRate)}
                  </div>
                </div>
                <div>
                  <div className="text-ui-body text-ink-secondary">
                    Brand mention rate
                  </div>
                  <div className="text-[24px] text-zinc-900">
                    {aeoRate(llmDash.benchmark.mentionRate)}
                  </div>
                </div>
                <div>
                  <div className="text-ui-body text-ink-secondary">
                    Questions observed
                  </div>
                  <div className="text-[24px] text-zinc-900">
                    {llmDash.benchmark.observedQuestions} /{" "}
                    {llmDash.benchmark.questions}
                  </div>
                </div>
              </div>
              <p className="text-ui-body text-ink-secondary [line-height:1.6] [margin-bottom:0px]">
                {llmDash.benchmark.activeQuestions} questions active ·{" "}
                {llmDash.benchmark.measured} measured answers. Excluded:{" "}
                {llmDash.benchmark.legacy} legacy, {llmDash.benchmark.noAnswer}{" "}
                no answer, {llmDash.benchmark.unresolved} unresolved. Historical
                observations used a different citation method. Compare the same
                questions and model in repeat runs. This view uses the latest
                observations within 30 days; sampling dates may differ by
                engine.
              </p>
            </UiCard>
          )}
          <AeoRateTable
            label="Benchmark by engine and model"
            rows={llmDash?.benchmark?.byPlatform || []}
          />
          <div className="grid [grid-template-columns:repeat(auto-fit,_minmax(min(100%,_320px),_1fr))] [gap:12px] [min-width:0px]">
            <AeoRateTable
              label="Benchmark by question type"
              rows={llmDash?.benchmark?.byIntent || []}
            />
            <AeoRateTable
              label="Benchmark by city"
              rows={llmDash?.benchmark?.byCity || []}
            />
          </div>
          <details className="text-ui-body text-zinc-900">
            <summary className="cursor-pointer [padding:10px_0]">
              All managed queries and benchmark history
            </summary>
            <AeoRateTable
              label="All managed queries by engine"
              rows={llmDash?.byPlatform || []}
            />
            <AeoRateTable
              label="Daily benchmark observations by engine and model"
              rows={llmDash?.trend || []}
            />
          </details>
          {llmDash?.entity && (
            <UiCard className="p-6">
              <h3 className="text-ui-body text-zinc-900 font-medium [margin-top:0px]">
                Entity accuracy: what engines say about Waves
              </h3>
              <div className="flex flex-wrap [gap:24px]">
                <div>
                  <div className="text-ui-body text-ink-secondary">
                    Facts stated correctly
                  </div>
                  <div className="text-[24px] text-zinc-900">
                    {aeoRate(llmDash.entity.factAccuracy)}
                  </div>
                </div>
                <div>
                  <div className="text-ui-body text-ink-secondary">
                    Answers with a wrong claim
                  </div>
                  <div className="text-[24px] text-zinc-900">
                    {aeoRate(llmDash.entity.wrongClaimRate)}
                  </div>
                </div>
                <div>
                  <div className="text-ui-body text-ink-secondary">
                    Questions observed
                  </div>
                  <div className="text-[24px] text-zinc-900">
                    {llmDash.entity.observedQuestions} /{" "}
                    {llmDash.entity.questions}
                  </div>
                </div>
              </div>
              <p className="text-ui-body text-ink-secondary [line-height:1.6] [margin-bottom:0px]">
                {llmDash.entity.activeQuestions} questions active ·{" "}
                {llmDash.entity.observed} answers scored against the
                owner-approved cohort {llmDash.entity.version}. Facts are the
                founder, founding year, license, footprint, services and contact
                details; wrong claims are the rulings an answer must not
                contradict (a franchise, fumigation, damage-repair coverage
                inferred from the termite bond).
                {llmDash.entity.missingMostOften?.length > 0 && (
                  <>
                    {" "}
                    Missing most often:{" "}
                    {llmDash.entity.missingMostOften
                      .map((f) => `${f.label} (${f.count})`)
                      .join(", ")}
                    .
                  </>
                )}
                {llmDash.entity.wrongMostOften?.length > 0 && (
                  <>
                    {" "}
                    Wrong most often:{" "}
                    {llmDash.entity.wrongMostOften
                      .map((f) => `${f.label} (${f.count})`)
                      .join(", ")}
                    .
                  </>
                )}
              </p>
            </UiCard>
          )}
          <EntityFactsTable
            label="Entity accuracy by engine and model"
            rows={llmDash?.entity?.byPlatform || []}
          />
          <EntityFactsTable
            label="Entity accuracy by question"
            rows={llmDash?.entity?.byQuestion || []}
            first="Question"
          />
          <div className="flex [gap:12px] flex-wrap">
            <UiCard className="p-6 [flex:1] [min-width:240px]">
              <h3 className="text-ui-body font-medium text-zinc-900 [margin-top:0px]">
                Linked Waves pages
              </h3>
              {(llmDash?.citedPages || []).length === 0 && (
                <p className="text-ui-body text-ink-secondary">
                  No verified linked citations yet.
                </p>
              )}
              {(llmDash?.citedPages || []).map((c) => (
                <div
                  key={c.url}
                  className="flex [gap:12px] justify-between [padding:6px_0] text-ui-body"
                >
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-900 break-words [min-width:0px]"
                  >
                    {c.url}
                  </a>
                  <span className="text-ink-secondary">{c.count}</span>
                </div>
              ))}
            </UiCard>
            <UiCard className="p-6 [flex:1] [min-width:240px]">
              <h3 className="text-ui-body font-medium text-zinc-900 [margin-top:0px]">
                Competitors mentioned
              </h3>
              {(llmDash?.competitors || []).length === 0 && (
                <p className="text-ui-body text-ink-secondary">
                  None detected in measured answers.
                </p>
              )}
              {(llmDash?.competitors || []).map((c) => (
                <div
                  key={c.name}
                  className="flex [gap:12px] justify-between [padding:6px_0] text-ui-body text-zinc-900"
                >
                  <span>{c.name}</span>
                  <span>{c.count}</span>
                </div>
              ))}
            </UiCard>
          </div>
          <UiCard className="p-6">
            <h3 className="text-ui-body font-medium text-zinc-900 [margin-top:0px]">
              Latest answer evidence
            </h3>
            {!llmDash?.grid?.length && (
              <p className="text-ui-body text-ink-secondary">
                No observations for active queries yet.
              </p>
            )}
            {(llmDash?.grid || []).map((m) => (
              <details
                key={`${m.query}::${m.llm_platform}::${m.model_version}`}
                className="[padding:12px_0] text-ui-body text-zinc-900 border-b border-hairline border-zinc-200"
              >
                <summary className="cursor-pointer [line-height:1.6]">
                  {m.benchmark_id && `${m.benchmark_id} · `}
                  {m.query}
                  <span className="block text-ink-secondary">
                    {aeoStatus(m)} · {m.llm_platform} · {m.model_version} ·{" "}
                    {String(m.check_date).slice(0, 10)}
                  </span>
                </summary>
                <p className="whitespace-pre-wrap break-words [line-height:1.6]">
                  {m.response_raw || "No answer text returned."}
                </p>
                {m.waves_cited_urls.map((url) => (
                  <p key={url}>
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-900 break-words"
                    >
                      {url}
                    </a>
                  </p>
                ))}
                {m.target_cited && (
                  <p className="text-ink-secondary">
                    The guide mapped to this benchmark question was linked.
                  </p>
                )}
              </details>
            ))}
          </UiCard>
        </div>
      )}

      {subTab === "prospects" && (
        <LinkBuildingBoard canRun={canRunSeoActions} />
      )}
      {subTab === "agent" && <BacklinkAgentPanel />}
    </div>
  );
}
function aeoRate(value) {
  return typeof value === "number" ? `${value}%` : "Not measured";
}
function aeoStatus(row) {
  if (row.measurement_version !== 2) return "Historical observation";
  if (!row.answer_available) return "No answer";
  if (!row.citations_complete) return "Unresolved source link";
  if (row.waves_cited_urls.length) return "Linked citation";
  return row.waves_mentioned ? "Mention only" : "No Waves mention or citation";
}
function EntityFactsTable({ label, rows, first = "Group" }) {
  const scored = rows.filter((row) => row.observed > 0);
  return (
    <UiCard className="p-6 [flex:1] [min-width:0px]">
      <h3 className="text-ui-body font-medium text-zinc-900 [margin-top:0px]">
        {label}
      </h3>
      {scored.length === 0 ? (
        <p className="text-ui-body text-ink-secondary">
          No scored answers yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table
            aria-label={label}
            className="[width:100%] [min-width:520px] [border-collapse:collapse] text-ui-body text-zinc-900"
          >
            <THead>
              <TR>
                {[
                  first,
                  "Facts right",
                  "Wrong claims",
                  "Answers",
                  "Missing most often",
                ].map((title) => (
                  <TH
                    key={title}
                    className="text-left font-medium [padding:8px] border-b border-hairline border-zinc-200"
                  >
                    {title}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {scored.map((row) => (
                <TR key={row.key}>
                  <TD className="[padding:8px] break-words">{row.key}</TD>
                  <TD className="[padding:8px] whitespace-nowrap">
                    {aeoRate(row.factAccuracy)}
                  </TD>
                  <TD className="[padding:8px] whitespace-nowrap">
                    {row.wrongClaims} of {row.observed}
                  </TD>
                  <TD className="[padding:8px]">{row.observed}</TD>
                  <TD className="[padding:8px] text-ink-secondary">
                    {(row.missingMostOften || [])
                      .map((f) => f.label)
                      .join(", ") || "None"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </UiCard>
  );
}
function AeoRateTable({ label, rows }) {
  return (
    <UiCard className="p-6 [flex:1] [min-width:0px]">
      <h3 className="text-ui-body font-medium text-zinc-900 [margin-top:0px]">
        {label}
      </h3>
      {rows.length === 0 ? (
        <p className="text-ui-body text-ink-secondary">No observations yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table
            aria-label={label}
            className="[width:100%] [min-width:440px] [border-collapse:collapse] text-ui-body text-zinc-900"
          >
            <THead>
              <TR>
                {["Group", "Linked", "Mentioned", "Answers", "Excluded"].map(
                  (title) => (
                    <TH
                      key={title}
                      className="text-left font-medium [padding:8px] border-b border-hairline border-zinc-200"
                    >
                      {title}
                    </TH>
                  ),
                )}
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.key}>
                  <TD className="[padding:8px] break-words">{row.key}</TD>
                  <TD className="[padding:8px] whitespace-nowrap">
                    {aeoRate(row.citationRate)}
                  </TD>
                  <TD className="[padding:8px] whitespace-nowrap">
                    {aeoRate(row.mentionRate)}
                  </TD>
                  <TD className="[padding:8px]">{row.measured}</TD>
                  <TD className="[padding:8px]">{row.total - row.measured}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </UiCard>
  );
}

// =========================================================================
// LINK BUILDING BOARD — outbound prospect pipeline (Backlink Manager M1)
// =========================================================================
const PROSPECT_VIEWS = [
  {
    key: "all",
    label: "All",
    statuses: null,
  },
  {
    key: "approvals",
    label: "Needs approval",
    statuses: null,
  },
  // outreach drafts → send (M3b)
  {
    key: "outreach",
    label: "Needs outreach",
    statuses: ["prospect", "contacted", "negotiating"],
  },
  {
    key: "placed",
    label: "In progress",
    statuses: ["placed"],
  },
  {
    key: "notindexed",
    label: "Live · not indexed",
    statuses: ["live"],
  },
  {
    key: "indexed",
    label: "Indexed",
    statuses: ["indexed"],
  },
  {
    key: "lost",
    label: "Lost",
    statuses: ["lost"],
  },
  {
    key: "parked",
    label: "Parked",
    statuses: ["awaiting_owner", "watching"],
  }, // v2: owner decision / unactionable today
];

// Outreach (M3b): link types whose prospects can be drafted + sent as one-to-one email.
const OUTREACH_TYPES_UI = ["editorial", "resource", "guest_post", "haro"];
const PROSPECT_STATUS_COLOR = {
  prospect: "#71717A",
  contacted: "#A16207",
  negotiating: "#A16207",
  placed: "#18181B",
  live: "#15803D",
  indexed: "#15803D",
  lost: "#991B1B",
  rejected: "#991B1B",
  awaiting_owner: "#A16207",
  watching: "#71717A",
};
function LinkBuildingBoard({ canRun }) {
  const [items, setItems] = useState(null);
  const [stats, setStats] = useState(null);
  const [view, setView] = useState("all");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [drafting, setDrafting] = useState(null); // prospect being drafted for outreach (M3b)
  const [form, setForm] = useState({
    target_url: "",
    live_url: "",
    target_page: "",
    anchor_planned: "",
    link_type: "editorial",
    priority: "medium",
  });
  const load = () => {
    adminFetch("/admin/backlink-agent/prospects/stats")
      .then(setStats)
      .catch(() => {});
    // The approvals view is self-fetching (OutreachApprovals) — skip the board query.
    if (view === "approvals") {
      setItems([]);
      return;
    }
    const cur = PROSPECT_VIEWS.find((v) => v.key === view);
    const qs = cur?.statuses?.length === 1 ? `?status=${cur.statuses[0]}` : "";
    const request =
      cur?.statuses?.length > 1
        ? Promise.all(
            cur.statuses.map((status) =>
              adminFetch(`/admin/backlink-agent/prospects?status=${status}`),
            ),
          ).then((results) => {
            const seen = new Set();
            return results
              .flatMap((d) => d.items || [])
              .filter((row) => {
                if (!row?.id || seen.has(row.id)) return false;
                seen.add(row.id);
                return true;
              });
          })
        : adminFetch(`/admin/backlink-agent/prospects${qs}`).then(
            (d) => d.items || [],
          );
    request.then((rows) => setItems(rows)).catch(() => setItems([]));
  };
  useEffect(load, [view]);
  const runVerify = async () => {
    if (!canRun) return;
    setBusy(true);
    try {
      await adminPost("/admin/backlink-agent/prospects/verify", {});
    } finally {
      setBusy(false);
    }
  };
  const recheck = async (id) => {
    setBusy(true);
    try {
      await adminPost(`/admin/backlink-agent/prospects/${id}/recheck`, {});
      load();
    } finally {
      setBusy(false);
    }
  };
  const addProspect = async () => {
    if (!form.target_page || (!form.target_url && !form.live_url)) return;
    setBusy(true);
    try {
      await adminPost("/admin/backlink-agent/prospects", form);
      setForm({
        target_url: "",
        live_url: "",
        target_page: "",
        anchor_planned: "",
        link_type: "editorial",
        priority: "medium",
      });
      setAdding(false);
      load();
    } finally {
      setBusy(false);
    }
  };
  if (items === null)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading link prospects...
      </div>
    );
  return (
    <div className="flex flex-col [gap:14px]">
      {/* KPIs */}
      {stats && (
        <div className="flex [gap:10px] flex-wrap">
          {[
            ["Prospects", stats.total],
            ["Placed", stats.byStatus?.placed || 0],
            ["Live", stats.byStatus?.live || 0],
            ["Indexed", stats.byStatus?.indexed || 0],
            ["Lost", stats.byStatus?.lost || 0],
            ["Indexing rate", `${stats.indexingRate || 0}%`],
          ].map(([label, val]) => (
            <UiCard
              key={label}
              className="bg-white rounded-md [padding:10px_14px] [min-width:96px] border-hairline border-zinc-200"
            >
              <div className="text-[18px] font-medium text-zinc-900">{val}</div>
              <div className="text-ui-body text-ink-secondary">{label}</div>
            </UiCard>
          ))}
        </div>
      )}

      {/* View filters + actions */}
      <div className="flex justify-between items-center flex-wrap [gap:8px]">
        <div className="flex [gap:4px] flex-wrap">
          {PROSPECT_VIEWS.map((v) => (
            <Button
              key={v.key}
              onClick={() => setView(v.key)}
              className="whitespace-nowrap"
              variant={view === v.key ? "primary" : "secondary"}
            >
              {v.label}
            </Button>
          ))}
        </div>
        {canRun && (
          <div className="flex [gap:8px]">
            <Button onClick={() => setAdding((a) => !a)}>+ Add prospect</Button>
            <Button onClick={runVerify} disabled={busy} variant="secondary">
              {busy ? "Verifying..." : "Verify now"}
            </Button>
          </div>
        )}
      </div>

      {/* Outreach approvals (M3b) — its own self-fetching panel */}
      {view === "approvals" && (
        <OutreachApprovals canRun={canRun} onChange={load} />
      )}

      {/* Add form */}
      {view !== "approvals" && adding && canRun && (
        <UiCard className="bg-white rounded-md [padding:14px] flex flex-wrap [gap:8px] items-center border-hairline border-zinc-200">
          <Input
            placeholder="Prospect site/page URL (planned)"
            value={form.target_url}
            onChange={(e) =>
              setForm({
                ...form,
                target_url: e.target.value,
              })
            }
            className="[flex:1_1_220px]"
          />
          <Input
            placeholder="Live URL — if link is already placed"
            value={form.live_url}
            onChange={(e) =>
              setForm({
                ...form,
                live_url: e.target.value,
              })
            }
            className="[flex:1_1_220px]"
          />
          <Input
            placeholder="Our target page (money page URL)"
            value={form.target_page}
            onChange={(e) =>
              setForm({
                ...form,
                target_page: e.target.value,
              })
            }
            className="[flex:1_1_220px]"
          />
          <Input
            placeholder="Planned anchor"
            value={form.anchor_planned}
            onChange={(e) =>
              setForm({
                ...form,
                anchor_planned: e.target.value,
              })
            }
            className="[flex:1_1_160px]"
          />
          <Select
            className="!w-auto"
            value={form.link_type}
            onChange={(e) =>
              setForm({
                ...form,
                link_type: e.target.value,
              })
            }
          >
            {[
              "editorial",
              "resource",
              "guest_post",
              "haro",
              "directory",
              "citation",
              "social",
            ].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select
            className="!w-auto"
            value={form.priority}
            onChange={(e) =>
              setForm({
                ...form,
                priority: e.target.value,
              })
            }
          >
            {["high", "medium", "low"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <Button onClick={addProspect} disabled={busy}>
            Save
          </Button>
        </UiCard>
      )}

      {/* Table */}
      {view !== "approvals" &&
        (items.length === 0 ? (
          <UiCard className="[padding:30px] text-center">
            <div className="text-ink-secondary">No prospects in this view.</div>
          </UiCard>
        ) : (
          <div className="overflow-x-auto">
            <Table className="[width:100%] [border-collapse:collapse] text-ui-body">
              <THead>
                <TR className="text-left text-ink-secondary border-b border-hairline border-zinc-200">
                  {[
                    "Target",
                    "Our page",
                    "Anchor",
                    "Type",
                    "Follow",
                    "Indexed",
                    "Status",
                    "DR",
                    "",
                  ].map((h) => (
                    <TH
                      key={h}
                      className="[padding:8px_10px] font-medium whitespace-nowrap"
                    >
                      {h}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {items.map((p) => (
                  <TR
                    key={p.id}
                    className="text-zinc-900 border-b border-hairline border-zinc-200"
                  >
                    <TD className="[padding:8px_10px] [max-width:200px] overflow-hidden text-ellipsis">
                      {p.live_url ? (
                        <a
                          href={p.live_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-zinc-900"
                        >
                          {p.target_domain}
                        </a>
                      ) : (
                        p.target_domain
                      )}
                    </TD>
                    <TD className="[padding:8px_10px] [max-width:180px] overflow-hidden text-ellipsis text-ink-secondary">
                      {(p.target_page || "").replace(/^https?:\/\/[^/]+/, "")}
                    </TD>
                    <TD className="[padding:8px_10px]">
                      {p.anchor_text || (
                        <span className="text-ink-secondary">
                          {p.anchor_planned || "—"}
                        </span>
                      )}
                    </TD>
                    <TD className="[padding:8px_10px] text-ink-secondary">
                      {p.link_type || "—"}
                    </TD>
                    <TD className="[padding:8px_10px]">
                      {p.is_dofollow == null ? (
                        "—"
                      ) : p.is_dofollow ? (
                        <span className="text-zinc-900">dofollow</span>
                      ) : (
                        <span className="text-zinc-700">nofollow</span>
                      )}
                    </TD>
                    <TD className="[padding:8px_10px]">
                      <span
                        style={{
                          color:
                            p.indexing_status === "indexed"
                              ? "#15803D"
                              : p.indexing_status === "not_checked"
                                ? "#71717A"
                                : "#A16207",
                        }}
                      >
                        {p.indexing_status === "not_checked"
                          ? "—"
                          : p.indexing_status}
                      </span>
                    </TD>
                    <TD className="[padding:8px_10px]">
                      <span
                        style={{
                          color: PROSPECT_STATUS_COLOR[p.status] || "#71717A",
                        }}
                        className="font-medium"
                      >
                        {p.status}
                      </span>
                    </TD>
                    <TD className="[padding:8px_10px] text-ink-secondary">
                      {p.domain_rating ?? "—"}
                    </TD>
                    <TD className="[padding:8px_10px] whitespace-nowrap">
                      {p.status === "prospect" &&
                        OUTREACH_TYPES_UI.includes(p.link_type) && (
                          <Button
                            onClick={() => setDrafting(p)}
                            className="[margin-right:6px]"
                            variant="secondary"
                          >
                            {p.outreach_status === "drafted"
                              ? "Edit draft"
                              : "Draft"}
                          </Button>
                        )}
                      {p.live_url && (
                        <Button
                          onClick={() => recheck(p.id)}
                          disabled={busy}
                          variant="secondary"
                        >
                          Recheck
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ))}

      {drafting && (
        <OutreachDraftModal
          prospect={drafting}
          onClose={() => setDrafting(null)}
          onSaved={() => {
            setDrafting(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// =========================================================================
// OUTREACH APPROVALS — review drafts, approve + send, reconcile (Backlink M3b)
// =========================================================================
// Friendly text for the structured result codes the outreach routes return.
// a refusal that means the recipient match the card showed is no longer the one the server would send against
const REVIEW_RESET_CODES = new Set([
  "recipient_review_required",
  "customer_recipient",
  "recipient_changed",
  "draft_changed",
]);
const OUTREACH_CODE_MSG = {
  gate_off: "Outreach lane is OFF — set GATE_LINK_OUTREACH to enable sending.",
  gmail_not_connected: "Gmail isn't connected — authorize it first.",
  rate_limited: "Daily send cap reached — try again later.",
  already_sent: "Already sent or in flight.",
  not_actionable: "Prospect is no longer open.",
  no_draft: "No draft to send.",
  invalid_recipient: "Recipient email is invalid.",
  incomplete_draft: "Draft is missing a subject or body.",
  send_failed: "Send failed (ambiguous) — reconcile it below.",
  finalize_failed: "Email sent but recording failed — reconcile manually.",
  needs_reconcile: "This send is awaiting reconciliation.",
  not_reconcilable: "Nothing to reconcile.",
  send_in_flight: "A send is currently in flight.",
  not_found: "Prospect not found.",
  bad_outcome: "Invalid reconcile outcome.",
  not_authorized:
    "Not authorized to send yet — the nightly authority bridge decides it, or the inputs changed since.",
  customer_recipient:
    "The recipient is a customer contact — outreach never goes to a customer. Re-draft to another address.",
  recipient_review_required:
    "The recipient shares a domain with a customer or lead contact — review the match and acknowledge it before sending.",
  recipient_lookup_failed:
    "The customer-recipient check failed — not sent. Try again.",
  inbox_in_flight:
    "Another placement already has a conversation with this recipient — one conversation per inbox.",
  recipient_changed:
    "The draft was re-addressed while you looked at it — reload and send again.",
  draft_changed:
    "The draft changed while you looked at it — reload and read the current text before sending.",
  draft_hash_required: "This card is stale — reload and send again.",
  path_moved:
    "The acquisition path changed since the draft — reload and draft again.",
  path_unlinked:
    "Not linked to an acquisition path yet — the registry catch-up links it within the hour.",
};

// §6.4 / §13 — what the owner sees before a send: the draft review (why it is
// the owner's to send, not the policy's) and the recipient match to acknowledge.
function RecipientReview({ review, acked, onAck, disabled }) {
  if (!review) return null;
  if (review.kind === "clear")
    return (
      <div className="text-ui-body text-ink-secondary">
        Recipient: not a customer or lead contact.
      </div>
    );
  if (review.kind === "customer")
    return (
      <div className="text-ui-body text-zinc-700">
        Recipient is a customer contact (
        {review.matched.map((m) => m.source).join(", ")}) — outreach never goes
        to a customer.
      </div>
    );
  if (review.kind === "ambiguous") {
    return (
      <label className="flex cursor-pointer items-start gap-1.5 text-ui-body text-zinc-700 has-[:disabled]:cursor-default">
        <Checkbox
          checked={Boolean(acked)}
          disabled={disabled}
          onChange={(e) => onAck(e.target.checked)}
          className="mt-0.5"
        />
        <span>{`Shares a domain with ${review.matched.length} customer / lead contact${review.matched.length === 1 ? "" : "s"} (${[...new Set(review.matched.map((m) => m.source))].join(", ")}). I reviewed the match — this is a business inbox, not a customer.`}</span>
      </label>
    );
  }
  return (
    <div className="text-ui-body text-zinc-700">
      Recipient check unavailable ({review.error || "lookup failed"}) — the send
      re-runs it and fails closed.
    </div>
  );
}
function DraftReviewLine({ review }) {
  if (!review || review.clean) return null;
  const parts = [
    ...(review.flags || []),
    ...(review.lint || []).map((l) => `lint: ${l.rule}`),
  ];
  return (
    <div className="text-ui-body text-ink-secondary">{`Owner review: ${parts.join(", ") || review.reason}`}</div>
  );
}

// §3.6b — a send on an attested path attests to the publisher's agreement: the
// owner reads it HERE before Approve & send, as the Owner queue card shows it.
function LegalAttestationLine({ p }) {
  if (!p.legal_attestation) return null;
  return (
    <div className="text-ui-body text-zinc-700">
      Legal attestation{p.authority_level ? ` (${p.authority_level})` : ""} —
      sending attests to the publisher's agreement:{" "}
      {p.legal_terms_url ? (
        <a
          href={p.legal_terms_url}
          target="_blank"
          rel="noreferrer"
          className="text-zinc-900"
        >
          read the agreement
        </a>
      ) : (
        "no agreement url in the evidence — re-investigate before sending"
      )}
    </div>
  );
}

// Raw POST that returns the parsed body even on non-2xx, so we can read the
// structured {code}. (adminFetch throws on non-2xx and loses the code.)
async function outreachPost(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try {
    data = await r.json();
  } catch {
    /* ignore */
  }
  return {
    ok: r.ok,
    status: r.status,
    data,
  };
}
function OutreachApprovals({ canRun, onChange }) {
  const [data, setData] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(null);
  const [acks, setAcks] = useState({}); // prospect id → the owner acknowledged the recipient match

  const load = () => {
    adminFetch("/admin/backlink-agent/prospects/outreach/pending")
      .then(setData)
      .catch(() =>
        setData({
          items: [],
          needsReconcile: [],
          gateOn: false,
          rateLimit: {},
        }),
      );
  };
  useEffect(load, []);
  const refresh = () => {
    load();
    if (onChange) onChange();
  };
  const send = async (p) => {
    const id = p.id;
    setBusyId(id);
    setMsg(null);
    // the acknowledged match travels with the click (§13): the server sends only when the lookup still yields it
    // the acknowledgement is bound to the hash it was given for: a reloaded card with a new match starts unacknowledged
    const ackKey = `${id}:${p.recipient_review?.lookup_hash || ""}`;
    // the click sends the text this card displayed (§3.6b): the server refuses a draft edited since
    const body = {
      draft_hash: p.draft_hash || "",
      ...(acks[ackKey] && p.recipient_review?.lookup_hash
        ? {
            reviewed_lookup_hash: p.recipient_review.lookup_hash,
          }
        : {}),
    };
    const { ok, data: r } = await outreachPost(`/admin/backlink-agent/prospects/${id}/outreach/send`, body);
    setMsg({
      ok,
      text: ok
        ? "Outreach sent."
        : OUTREACH_CODE_MSG[r.code] || r.error || "Send failed.",
    });
    if (!ok && r.code === "recipient_review_required")
      setAcks((prev) => ({
        ...prev,
        [ackKey]: false,
      })); // the reload below shows the current match
    setBusyId(null);
    refresh();
  };
  const reconcile = async (p, outcome) => {
    const id = p.id;
    setBusyId(id);
    setMsg(null);
    const { ok, data: r } = await outreachPost(`/admin/backlink-agent/prospects/${id}/outreach/reconcile`, { outcome, ...(p.follow_up ? { follow_up: true } : {}) });
    setMsg({
      ok,
      text: ok
        ? outcome === "sent"
          ? "Marked as sent."
          : outcome === "skip"
            ? "Follow-up skipped."
            : r.retired
              ? "Not sent — the placement moved on; the follow-up is retired."
              : "Returned to drafts."
        : OUTREACH_CODE_MSG[r.code] || r.error || "Reconcile failed.",
    });
    setBusyId(null);
    refresh();
  };
  if (!data)
    return (
      <div className="text-ink-secondary [padding:30px] text-center">
        Loading approvals…
      </div>
    );
  const drafts = data.items || [];
  const reconciles = data.needsReconcile || [];
  const cap = data.rateLimit?.cap;
  const sentToday = data.rateLimit?.sentToday;
  return (
    <div className="flex flex-col [gap:14px]">
      <div className="flex [gap:12px] flex-wrap items-center">
        <span
          style={{
            background: data.gateOn
              ? "rgba(16,185,129,0.15)"
              : "rgba(245,158,11,0.15)",
            color: data.gateOn ? "#15803D" : "#A16207",
          }}
          className="text-ui-body [padding:4px_10px] rounded-sm"
        >
          {data.gateOn
            ? "Outreach lane: ON"
            : "Outreach lane: OFF — sends disabled (GATE_LINK_OUTREACH)"}
        </span>
        {cap != null && (
          <span className="text-ui-body text-ink-secondary">
            Sent today (ET): {sentToday}/{cap}
          </span>
        )}
      </div>

      {msg && (
        <div
          style={{
            border: `1px solid ${msg.ok ? "#15803D" : "#A16207"}`,
            color: msg.ok ? "#15803D" : "#A16207",
          }}
          className="text-ui-body [padding:8px_12px] rounded-sm bg-white"
        >
          {msg.text}
        </div>
      )}

      <div>
        <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:8px]">
          Drafts awaiting approval ({drafts.length})
        </div>
        {drafts.length === 0 ? (
          <UiCard className="[padding:24px] text-center">
            <div className="text-ink-secondary text-ui-body">
              No drafts to approve. Use “Draft” on an editorial / resource /
              guest-post / HARO prospect to queue one here.
            </div>
          </UiCard>
        ) : (
          drafts.map((p) => (
            <UiCard
              key={p.id}
              className="bg-white rounded-md [padding:14px] [margin-bottom:10px] border-hairline border-zinc-200"
            >
              <div className="flex justify-between [gap:12px] flex-wrap">
                <div className="[min-width:0px] [flex:1_1_320px]">
                  <div className="text-ui-body text-zinc-900 font-medium">
                    {p.target_domain}{" "}
                    <span className="text-ink-secondary font-normal">
                      · {p.link_type}
                    </span>
                  </div>
                  <div className="text-ui-body text-ink-secondary">
                    To: {p.outreach_to_email}
                  </div>
                  <div className="text-ui-body text-zinc-900 [margin-top:4px]">
                    <b>{p.outreach_subject}</b>
                  </div>
                  <div className="text-ui-body text-ink-secondary [margin-top:4px] whitespace-pre-wrap [max-height:84px] overflow-hidden">
                    {p.outreach_body}
                  </div>
                  <div className="flex flex-col [gap:4px] [margin-top:6px]">
                    <DraftReviewLine review={p.draft_review} />
                    <LegalAttestationLine p={p} />
                    <RecipientReview
                      review={p.recipient_review}
                      acked={
                        acks[`${p.id}:${p.recipient_review?.lookup_hash || ""}`]
                      }
                      disabled={busyId === p.id}
                      onAck={(v) =>
                        setAcks({
                          ...acks,
                          [`${p.id}:${p.recipient_review?.lookup_hash || ""}`]:
                            v,
                        })
                      }
                    />
                  </div>
                </div>
                <div className="flex flex-col [gap:6px] shrink-0">
                  <Button
                    onClick={() => send(p)}
                    disabled={
                      !canRun ||
                      busyId === p.id ||
                      p.recipient_review?.kind === "customer" ||
                      (p.recipient_review?.kind === "ambiguous" &&
                        !acks[
                          `${p.id}:${p.recipient_review?.lookup_hash || ""}`
                        ])
                    }
                  >
                    {busyId === p.id ? "Sending…" : "Approve & send"}
                  </Button>
                  <Button
                    onClick={() => setEditing(p)}
                    disabled={busyId === p.id}
                  >
                    Edit
                  </Button>
                </div>
              </div>
            </UiCard>
          ))
        )}
      </div>

      {reconciles.length > 0 && (
        <div>
          <div className="text-ui-body font-medium text-zinc-700 [margin-bottom:6px]">
            Needs reconciliation ({reconciles.length})
          </div>
          <div className="text-ui-body text-ink-secondary [margin-bottom:8px]">
            These sends errored ambiguously and may have reached Gmail. Check
            the Sent folder, then confirm.
          </div>
          {reconciles.map((p) => (
            <UiCard
              key={p.id}
              className="bg-white rounded-md [padding:14px] [margin-bottom:10px] border-hairline border-zinc-200"
            >
              <div className="flex justify-between [gap:12px] flex-wrap">
                <div className="[min-width:0px]">
                  <div className="text-ui-body text-zinc-900 font-medium">
                    {p.target_domain}
                    {p.follow_up ? " · follow-up" : ""}
                  </div>
                  <div className="text-ui-body text-ink-secondary">
                    To: {p.outreach_to_email} · <b>{p.outreach_subject}</b>
                  </div>
                  {p.unverifiable && (
                    <div className="text-ui-body text-ink-secondary [margin-top:4px]">{`The automatic attempt could not verify this follow-up (${String(p.follow_up_skipped_reason || "").replace(/_/g, " ")}). Send it from the Owner queue once the cause clears, or skip it.`}</div>
                  )}
                </div>
                <div className="flex [gap:6px] shrink-0">
                  {!p.unverifiable && (
                    <Button
                      onClick={() => reconcile(p, "sent")}
                      disabled={!canRun || busyId === p.id}
                    >
                      It sent
                    </Button>
                  )}
                  {!p.unverifiable && (
                    <Button
                      onClick={() => reconcile(p, "requeue")}
                      disabled={!canRun || busyId === p.id}
                    >
                      Re-queue
                    </Button>
                  )}
                  {p.follow_up && (
                    <Button
                      onClick={() => reconcile(p, "skip")}
                      disabled={!canRun || busyId === p.id}
                    >
                      Skip follow-up
                    </Button>
                  )}
                </div>
              </div>
            </UiCard>
          ))}
        </div>
      )}

      {editing && (
        <OutreachDraftModal
          prospect={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// Compose / edit a one-to-one outreach draft (M3b). Saving never sends — an admin
// approves + sends from the approvals view.
function OutreachDraftModal({ prospect, onClose, onSaved }) {
  const [to, setTo] = useState(prospect.outreach_to_email || "");
  const [subject, setSubject] = useState(prospect.outreach_subject || "");
  const [body, setBody] = useState(prospect.outreach_body || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    const { ok, data } = await outreachPost(`/admin/backlink-agent/prospects/${prospect.id}/outreach/draft`, { to, subject, body });
    setBusy(false);
    if (ok) onSaved();
    else
      setErr(
        OUTREACH_CODE_MSG[data.code] || data.error || "Could not save draft.",
      );
  };
  return (
    <Dialog open onClose={onClose} size="lg">
      <DialogHeader>
        <DialogTitle>Outreach draft — {prospect.target_domain}</DialogTitle>
        <p className="[margin:4px_0_0] text-ui-body text-ink-secondary">
          One-to-one only. Saving does not send; an admin approves + sends from
          the primary inbox.
        </p>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <label className="block text-ui-body text-ink-secondary">
          Recipient email
          <Input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="editor@example.com"
            className="[margin-top:4px]"
          />
        </label>
        <label className="block text-ui-body text-ink-secondary">
          Subject
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="[margin-top:4px]"
          />
        </label>
        <label className="block text-ui-body text-ink-secondary">
          Body
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="[margin-top:4px] resize-y"
          />
        </label>
        {err && <ActionFeedback error>{err}</ActionFeedback>}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={save}
          loading={busy}
          disabled={!to || !subject || !body}
        >
          {busy ? "Saving…" : "Save draft"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// =========================================================================
// BACKLINK AGENT PANEL
// =========================================================================
// Registry view (plan v2 §11 items 2 + step 3): what intake wrote, what the
// investigator concluded, and the owner's Watch / Reject / Reopen actions.
// "Acquire anyway" is step 4 (it needs a stamped authority, not a state flip).
const REGISTRY_STATES = [
  "new",
  "investigating",
  "qualified",
  "ready_to_acquire",
  "acquiring",
  "acquired",
  "watching",
  "not_reproducible",
  "rejected",
];
const LANE_OWNED_STATES = ["ready_to_acquire", "acquiring", "acquired"];

// refreshKey / onMutated: the registry card and the owner queue below it read the same domains — a mutation in
// either (Acquire anyway parks cards; Reject / Watch hide them) bumps the shared key and both reload.
function BacklinkRegistryCard({ refreshKey = 0, onMutated } = {}) {
  const [rows, setRows] = useState([]);
  const [stateFilter, setStateFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const expandedRef = useRef(null);
  // current controls, readable from async continuations whose closure is
  // stale (an action started before the operator changed filter/page)
  const controlsRef = useRef({
    stateFilter,
    search,
    page,
  });
  controlsRef.current = {
    stateFilter,
    search,
    page,
  };
  const [busyId, setBusyId] = useState(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [error, setError] = useState(null);
  const loadGen = useRef(0);
  const load = async (state = stateFilter, q = search, p = page) => {
    // request generation: a superseded load (filter/page changed while it was
    // in flight) must never write its rows under the newer controls
    const gen = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: 50,
        page: p,
      });
      if (state) params.set("agent_state", state);
      if (q.trim()) params.set("q", q.trim());
      const r = await adminFetch(`/admin/backlink-agent/registry?${params}`);
      if (gen !== loadGen.current) return;
      setRows(r?.items || []);
      setPage(p);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setError(e?.message || "Registry load failed");
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  };
  // detail carries the row id it answers — a slow response for a row the
  // operator has since left never renders under the newly expanded one,
  // and (via the ref check) never OVERWRITES the loaded detail of the row
  // they moved to — that would strand the expanded row on "Loading…"
  // …and only the LATEST request for that row may write: an expand still in flight when a mutation refetches the
  // same id must not land last and overwrite the refreshed waiver / paths (same generation guard as the list)
  const detailGen = useRef(0);
  const loadDetail = async (id) => {
    const gen = ++detailGen.current;
    try {
      const r = await adminFetch(`/admin/backlink-agent/registry/${id}`);
      if (expandedRef.current !== id || gen !== detailGen.current) return;
      setDetail({
        forId: id,
        ...r,
      });
    } catch (e) {
      if (expandedRef.current !== id || gen !== detailGen.current) return;
      setDetail({
        forId: id,
        error: e?.message || "Detail load failed",
      });
    }
  };
  useEffect(() => {
    const c = controlsRef.current;
    load(c.stateFilter, c.search, c.page);
    // the expanded row's detail (waiver, paths, placements) moves with the same mutations — refetch it in place
    if (expandedRef.current) loadDetail(expandedRef.current);
  }, [refreshKey]);
  const toggleExpand = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      expandedRef.current = null;
      return;
    }
    setExpandedId(id);
    expandedRef.current = id;
    setDetail(null);
    await loadDetail(id);
  };
  const doAction = async (id, action) => {
    setBusyId(id);
    setError(null);
    try {
      await adminFetch(`/admin/backlink-agent/registry/${id}`, {
        method: "PATCH",
        body: { action },
      });
      // refresh with the CURRENT controls — this closure's stateFilter/
      // search/page are from the render the action started on
      if (onMutated) onMutated();
      else
        await load(
          controlsRef.current.stateFilter,
          controlsRef.current.search,
          controlsRef.current.page,
        );
    } catch (e) {
      setError(e?.message || `${action} failed`);
    } finally {
      setBusyId(null);
    }
  };

  // "Acquire anyway" (plan v2 §6.3 1b, step 4 PR 2b): waives the quality floors
  // the domain fails — an audited waiver, never an approval — and runs the
  // bridge for this domain so its owner cards appear in the queue below.
  const acquireAnyway = async (id) => {
    setBusyId(id);
    setError(null);
    setRunResult(null);
    try {
      const r = await adminPost(`/admin/backlink-agent/registry/${id}/acquire-anyway`, {});
      setRunResult({
        acquireAnyway: true,
        text: `${r.domain}: waived ${(r.floors || []).map((f) => `${f.floor} ${f.value} vs ${f.threshold}`).join(", ")} — ${r.bridge?.gated ? "recorded; GATE_LINK_AUTHORITY is off, so the bridge decides it when the gate is on" : r.bridge?.skipped ? "recorded; the nightly bridge decides it" : r.summary_unavailable ? "recorded; the Owner queue below shows what now awaits your decision" : `${r.awaiting} step${r.awaiting === 1 ? "" : "s"} now await your decision in the Owner queue`}`,
      });
      if (onMutated) onMutated();
      else
        await load(
          controlsRef.current.stateFilter,
          controlsRef.current.search,
          controlsRef.current.page,
        );
    } catch (e) {
      setError(e?.message || "Acquire anyway failed");
    } finally {
      setBusyId(null);
    }
  };
  const runInvestigator = async (dryRun) => {
    setRunBusy(true);
    setRunResult(null);
    try {
      const r = await adminPost("/admin/backlink-agent/registry/jobs/investigate", { dryRun });
      setRunResult(r);
      if (!dryRun) {
        const c = controlsRef.current;
        load(c.stateFilter, c.search, c.page);
      } // same stale-closure rule as doAction
    } catch (e) {
      setRunResult({
        error: e?.message || "Investigator run failed",
      });
    } finally {
      setRunBusy(false);
    }
  };
  const bestPathLabel = (d) => {
    if (!d.best_path) return "—";
    const p = d.best_path;
    const cost =
      p.payment_required && p.estimated_cost_cents != null
        ? ` · $${(p.estimated_cost_cents / 100).toFixed(2)}`
        : p.payment_required
          ? ` · paid (${p.currency})`
          : "";
    return `${p.acquisition_type}${cost} · ${p.expected_rel}`;
  };
  return (
    <UiCard className="p-6">
      <div className="flex justify-between items-center [gap:8px] flex-wrap [margin-bottom:4px]">
        <div className="text-ui-body font-medium text-zinc-900">Registry</div>
        <div className="flex [gap:8px]">
          <Button onClick={() => runInvestigator(true)} disabled={runBusy}>
            Preview investigator
          </Button>
          <Button onClick={() => runInvestigator(false)} disabled={runBusy}>
            {runBusy ? "Working…" : "Run investigator"}
          </Button>
        </div>
      </div>
      <div className="text-ui-body text-ink-secondary [margin-bottom:10px]">
        One row per candidate domain: how a link can be acquired, what it costs,
        and where it stands. Investigation fetches pages and spends up to two
        model calls per domain (one, plus a repair retry when the first answer
        fails validation); it never contacts or pays anyone.
      </div>
      {runResult && (
        <div
          style={{
            color: runResult.error
              ? "#991B1B"
              : runResult.acquireAnyway
                ? "#27272A"
                : runResult.gated
                  ? "#A16207"
                  : "#15803D",
          }}
          className="[margin-bottom:8px] text-ui-body"
        >
          {runResult.error
            ? runResult.error
            : runResult.acquireAnyway
              ? runResult.text
              : runResult.gated
                ? `Held by GATE_LINK_INVESTIGATOR (${runResult.selected} selected, nothing fetched)`
                : runResult.dryRun
                  ? `Preview: ${runResult.selected} selected, up to ${runResult.wouldFetch ?? 0} fetches and ${runResult.wouldCall ?? 0} model calls`
                  : runResult.skipped === "lease_held"
                    ? "Another investigator run already holds the lease — nothing new was started."
                    : runResult.skipped === "probe_failed"
                      ? "Could not check the investigator lease (database busy) — nothing was started; try again."
                      : runResult.started
                        ? "Investigator started in the background — runs are serialized; refresh the table to see results."
                        : `Investigated ${runResult.investigated}/${runResult.selected}: ${runResult.qualified} qualified, ${runResult.watching} watching, ${runResult.notReproducible} not reproducible, ${runResult.pathsWritten} paths written${runResult.failed?.length ? `, ${runResult.failed.length} failed` : ""}${runResult.skipped ? " (skipped: run already in progress)" : ""}`}
        </div>
      )}
      <div className="flex [gap:8px] [margin-bottom:10px] flex-wrap">
        <Select
          className="!w-auto"
          value={stateFilter}
          onChange={(e) => {
            setStateFilter(e.target.value);
            load(e.target.value, search, 1);
          }}
        >
          <option value="">All states</option>
          {REGISTRY_STATES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load(stateFilter, search, 1)}
          placeholder="Search domain…"
          className="[flex:1] [min-width:160px]"
        />
        <Button onClick={() => load(stateFilter, search, 1)} disabled={loading}>
          {loading ? "Loading…" : "Search"}
        </Button>
      </div>
      {error && (
        <div className="[margin-bottom:8px] text-ui-body text-alert-fg">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
        <Table className="[width:100%] [border-collapse:collapse]">
          <THead>
            <TR>
              <TH>Domain</TH>
              <TH className="text-right u-nums">DR</TH>
              <TH className="text-right u-nums">Traffic</TH>
              <TH className="text-right u-nums">Spam</TH>
              <TH className="text-right u-nums">Comp.</TH>
              <TH>Best path</TH>
              <TH className="text-right u-nums">Score</TH>
              <TH>State</TH>
              <TH>Source</TH>
              <TH>Actions</TH>
            </TR>
          </THead>
          <TBody>
            {rows.length === 0 && (
              <TR>
                <TD colSpan={10} className="text-ink-secondary">
                  {loading ? "Loading…" : "No registry rows match."}
                </TD>
              </TR>
            )}
            {rows.map((d) => (
              <Fragment key={d.id}>
                <TR
                  onClick={() => toggleExpand(d.id)}
                  className="cursor-pointer"
                >
                  <TD className="u-nums">{d.domain}</TD>
                  <TD className="text-right u-nums">
                    {d.domain_rating ?? "—"}
                  </TD>
                  <TD className="text-right u-nums">
                    {d.organic_traffic != null
                      ? Number(d.organic_traffic).toLocaleString()
                      : "—"}
                  </TD>
                  <TD className="text-right u-nums">{d.spam_score ?? "—"}</TD>
                  <TD className="text-right u-nums">
                    {d.competitors_linked ?? 0}
                  </TD>
                  <TD>{bestPathLabel(d)}</TD>
                  <TD className="text-right u-nums">{d.score ?? "—"}</TD>
                  <TD>
                    {d.agent_state.replace(/_/g, " ")}
                    {d.discovery_priority === "owner_seed" ? " ★" : ""}
                  </TD>
                  <TD>{d.source}</TD>
                  <TD className="whitespace-nowrap">
                    {!LANE_OWNED_STATES.includes(d.agent_state) && (
                      <span
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex [gap:6px]"
                      >
                        {d.agent_state !== "watching" && (
                          <Button
                            onClick={() => doAction(d.id, "watch")}
                            disabled={busyId === d.id}
                          >
                            Watch
                          </Button>
                        )}
                        {d.agent_state !== "rejected" && (
                          <Button
                            onClick={() => doAction(d.id, "reject")}
                            disabled={busyId === d.id}
                            className="text-alert-fg"
                            variant="secondary"
                          >
                            Reject
                          </Button>
                        )}
                        {[
                          "watching",
                          "rejected",
                          "qualified",
                          "not_reproducible",
                        ].includes(d.agent_state) && (
                          <Button
                            onClick={() => doAction(d.id, "reopen")}
                            disabled={busyId === d.id}
                          >
                            Reopen
                          </Button>
                        )}
                        {d.agent_state === "rejected" &&
                          d.waivable === true && (
                            <Button
                              onClick={() => acquireAnyway(d.id)}
                              disabled={busyId === d.id}
                              title="Waive the quality floors this domain fails (audited) and route it to the Owner queue"
                            >
                              Acquire anyway
                            </Button>
                          )}
                      </span>
                    )}
                  </TD>
                </TR>
                {expandedId === d.id && (
                  <TR>
                    <TD colSpan={10} className="bg-zinc-100">
                      {detail?.forId !== d.id && (
                        <span className="text-ink-secondary">Loading…</span>
                      )}
                      {detail?.forId === d.id && detail.error && (
                        <span className="text-alert-fg">{detail.error}</span>
                      )}
                      {detail?.forId === d.id && !detail.error && (
                        <div className="flex flex-col [gap:8px]">
                          {d.score_reasons && (
                            <div className="text-ui-body text-ink-secondary">
                              {d.score_reasons}
                            </div>
                          )}
                          {detail.waiver && (
                            <div className="text-ui-body text-zinc-700">
                              {`Floors waived by ${detail.waiver.approved_by} on ${formatETDate(detail.waiver.approved_at)}: ${(detail.waiver.overridden_floors || []).map((f) => `${f.floor} ${f.value} vs ${f.threshold}`).join(", ")}${detail.waiver.note ? ` — ${detail.waiver.note}` : ""}`}
                            </div>
                          )}
                          <div>
                            <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
                              Paths
                            </div>
                            {(detail.paths || []).length === 0 && (
                              <div className="text-ui-body text-ink-secondary">
                                None yet — not investigated.
                              </div>
                            )}
                            {(detail.paths || []).map((p) => {
                              let ev = null;
                              try {
                                ev =
                                  typeof p.investigation === "string"
                                    ? JSON.parse(p.investigation)
                                    : p.investigation;
                              } catch {
                                /* unparseable evidence stays hidden */
                              }
                              return (
                                <div
                                  key={p.id}
                                  className="text-ui-body text-zinc-900 [padding:4px_0] border-b border-hairline border-zinc-200"
                                >
                                  <span>{p.acquisition_type}</span>
                                  {p.submission_url
                                    ? ` · ${p.submission_url}`
                                    : ""}
                                  {` · conf ${p.confidence ?? "—"}`}
                                  {p.payment_required
                                    ? ` · ${p.estimated_cost_cents != null ? `$${(p.estimated_cost_cents / 100).toFixed(2)}` : `price ${p.currency || "unknown"}`}${
                                        // a distinct renewal charge renders separately — "$95.00/annual"
                                        // would present the initial fee as the recurring amount
                                        p.renewal_cost_cents != null
                                          ? ` · renews $${(p.renewal_cost_cents / 100).toFixed(2)}${p.renewal_period && p.renewal_period !== "none" ? `/${p.renewal_period}` : ""}`
                                          : p.renewal_period === "none"
                                            ? " · one-time"
                                            : p.renewal_period
                                              ? ` · renews ${p.renewal_period}, amount unverified`
                                              : ""
                                      }`
                                    : " · free"}
                                  {p.superseded_by ? " · superseded" : ""}
                                  {p.baseline ? " · baseline import" : ""}
                                  {ev?.reasons && (
                                    <div className="text-ink-secondary [margin-top:2px]">
                                      {ev.reasons}
                                    </div>
                                  )}
                                  {(ev?.disproven_reason ||
                                    ev?.submission_verification ||
                                    ev?.terms_verification) && (
                                    <div className="text-ink-secondary [margin-top:2px]">
                                      {[
                                        ev.disproven_reason,
                                        ev.submission_verification &&
                                          `submission: ${ev.submission_verification}`,
                                        ev.terms_verification &&
                                          `terms: ${ev.terms_verification}`,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {(detail.attempts || []).length > 0 && (
                            <div>
                              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
                                Attempts
                              </div>
                              {detail.attempts.map((a) => (
                                <div
                                  key={a.id}
                                  className="text-ui-body text-zinc-900 [padding:2px_0]"
                                >
                                  {formatETDate(a.created_at)} · {a.provider} ·{" "}
                                  {a.action} → {a.outcome}
                                  {a.cost_cents
                                    ? ` · $${(a.cost_cents / 100).toFixed(2)}`
                                    : ""}
                                  {a.sandbox ? " · sandbox" : ""}
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="text-ui-body text-ink-secondary">
                            Seen by:{" "}
                            {(detail.touches || [])
                              .map((t) => t.source)
                              .filter((v, i, a) => a.indexOf(v) === i)
                              .join(", ") || "—"}
                            {(detail.placements || []).length > 0 &&
                              ` · ${detail.placements.length} placement${detail.placements.length === 1 ? "" : "s"} on the board`}
                          </div>
                        </div>
                      )}
                    </TD>
                  </TR>
                )}
              </Fragment>
            ))}
          </TBody>
        </Table>
      </div>
      <div className="flex justify-end items-center [gap:8px] [margin-top:10px]">
        <Button
          onClick={() => load(stateFilter, search, page - 1)}
          disabled={loading || page <= 1}
        >
          Prev
        </Button>
        <span className="text-ui-body text-ink-secondary">Page {page}</span>
        <Button
          onClick={() => load(stateFilter, search, page + 1)}
          disabled={loading || rows.length < 50}
        >
          Next
        </Button>
      </div>
    </UiCard>
  );
}

// §3.8 / §6.2 / §11 item 4 — the ONLY place authority/spend thresholds change
// (step 4a). Every save is audited server-side; env may only tighten.
// =========================================================================
// Owner queue (plan v2 §11 item 3 / §3.6b / §6.3 1b — step 4 PR 2b): the
// placements the nightly authority bridge parked awaiting the owner. Approve
// is per dimension row and freezes exactly what is on the card; Reject and
// Watch are domain decisions (the same writer as the Registry buttons). A
// communication row's approval IS its send (step 4 PR 3a, §6.3 2c): the Send
// button here and the board's Approve & send are the same authenticated click
// — the sender writes the approval bound to the draft hash and the recipient
// review the owner acknowledged, then sends.
const DIMENSION_LABELS = {
  execution: "Execution",
  payment: "Payment",
  communication: "Message",
};
const ACTION_LABELS = {
  acquire: "create the account / submit the listing",
  accept_terms: "accept the agreement",
  purchase: "pay the listing fee",
  renewal: "pay the renewal",
  outreach_send: "send the pitch",
  outreach_followup: "send the follow-up",
};
const money = (cents) => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);
// "95", "95.5", "95.50" → 9500 / 9550 / 9550; "10.075", "-1", "abc", "" → null
function dollarsToCents(raw) {
  const m = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(String(raw));
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}
const compact = (n) =>
  n == null
    ? "—"
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
      : String(n);
function OwnerQueuePanel({ refreshKey = 0, onMutated } = {}) {
  const [data, setData] = useState(null);
  const [drafting, setDrafting] = useState(null);
  const [placementUrls, setPlacementUrls] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [amounts, setAmounts] = useState({});
  const [notes, setNotes] = useState({});
  const [acks, setAcks] = useState({}); // row id → the owner acknowledged the recipient match (§13)
  const [result, setResult] = useState(null);
  const loadGen = useRef(0);
  const load = async () => {
    const gen = ++loadGen.current;
    setError(null);
    try {
      const r = await adminFetch("/admin/backlink-agent/owner-queue");
      if (gen !== loadGen.current) return;
      setData(r);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setError(e?.message || "Owner queue load failed");
    }
  };
  useEffect(() => {
    load();
  }, [refreshKey]);
  // after a mutation: the parent refreshes every panel when it owns the key, else this panel reloads itself
  const refresh = () => (onMutated ? onMutated() : load());

  // Preserve edits (including clearing) for this held attempt; untouched verified rows use their exact stored URL.
  const displayedSubmissionUrl = (card) =>
    placementUrls[card.submission_ambiguity.id] ??
    (["live", "indexed"].includes(card.placement.status)
      ? (card.placement.live_url ?? "")
      : "");
  const recordSubmissionVerdict = async (card, verdict) => {
    if (
      !window.confirm(
        verdict === "placed"
          ? "Confirm this submission reached the publisher at the URL entered below."
          : "Confirm you reviewed the evidence and no submission reached the publisher. This releases the automatic retry hold.",
      )
    )
      return;
    setBusy(card.domain.id);
    setError(null);
    try {
      await adminFetch(`/admin/backlink-agent/prospects/${card.placement.id}`, {
        method: "PATCH",
        body: JSON.stringify({ submission_verdict: verdict, submission_attempt_id: card.submission_ambiguity.id, ...(verdict === "placed" ? { live_url: displayedSubmissionUrl(card) } : {}) }),
      });
      refresh();
    } catch (e) {
      setError(e?.message || "Submission verdict failed");
    } finally {
      setBusy(null);
    }
  };

  // what the inline bridge run did with the click — or why the nightly run will
  const bridgeNote = (b) => {
    if (!b) return "";
    if (b.gated)
      return "recorded; GATE_LINK_AUTHORITY is off, so it takes effect when the gate is on";
    if (b.skipped)
      return `recorded; the nightly bridge applies it (${b.skipped === "lease_held" ? "a bridge run is in progress" : b.skipped})`;
    return `released ${b.released}, parked ${b.parked}, domain updates ${b.aggregateChanges}`;
  };

  // what the payment field SHOWS: the owner's edit (even a cleared one), else the quote
  // (the server picks the quote THIS row authorizes — a renewal row shows the renewal price, never the initial fee;
  // no applicable quote ⇒ blank ⇒ the click is refused until the owner types the amount)
  const displayedAmount = (card, row) =>
    amounts[row.id] !== undefined
      ? amounts[row.id]
      : row.quote_cents != null
        ? (row.quote_cents / 100).toFixed(2)
        : "";
  const approve = async (card, row) => {
    setBusy(row.id);
    setError(null);
    setResult(null);
    const body = {};
    if (row.dimension === "payment") {
      // a money authorization ALWAYS carries the amount the owner can see in the field — the server never
      // defaults it for a click from this card. The decimal TOKEN becomes integer cents (never through a
      // binary float — 10.075 * 100 rounds to 1007); a blank field or >2 decimals is refused, not defaulted.
      const cents = dollarsToCents(displayedAmount(card, row));
      if (cents === null) {
        setError(
          "Enter the amount in dollars with at most two decimals, greater than zero.",
        );
        setBusy(null);
        return;
      }
      body.approved_amount_cents = cents;
    }
    if (notes[card.domain.id]) body.note = notes[card.domain.id];
    try {
      const r = await adminFetch(`/admin/backlink-agent/owner-queue/rows/${row.id}/approve`, { method: "POST", body });
      setResult({
        tone: "#15803D",
        text: `Approved ${DIMENSION_LABELS[row.dimension] || row.dimension} on ${card.domain.domain}${r.attached?.length > 1 ? ` (${r.attached.length} locations share the fee)` : ""} — ${bridgeNote(r.bridge)}`,
      });
      await refresh();
    } catch (e) {
      setError(e?.message || "Approve failed");
    } finally {
      setBusy(null);
    }
  };

  // the owner's TERMINAL review of a follow-up that is theirs to send (§6.4): skipped, the conversation settles and
  // its inbox and domain are released on the closure sweep — the queue never sends an owner-routed follow-up
  const skipFollowUp = async (card, row) => {
    setBusy(row.id);
    setError(null);
    setResult(null);
    try {
      await adminFetch(`/admin/backlink-agent/prospects/${card.placement.id}/outreach/reconcile`, { method: "POST", body: { outcome: "skip", follow_up: true } });
      setResult({
        tone: "#71717A",
        text: `Skipped the follow-up on ${card.domain.domain} — the conversation settles without it`,
      });
      await refresh();
    } catch (e) {
      setError(OUTREACH_CODE_MSG[e?.code] || e?.message || "Skip failed");
    } finally {
      setBusy(null);
    }
  };

  // the send click IS the approval of a communication row (§6.3 2c)
  const send = async (card, row) => {
    setBusy(row.id);
    setError(null);
    setResult(null);
    const lookupHash = row.draft?.recipient_review?.lookup_hash || "";
    const ackKey = `${row.id}:${lookupHash}`; // the acknowledgement is bound to the hash it was given for
    // the click sends the text this card displayed (§3.6b): the server refuses a draft edited since
    const body = {
      draft_hash: row.draft?.hash || "",
      ...(acks[ackKey] && lookupHash
        ? {
            reviewed_lookup_hash: lookupHash,
          }
        : {}),
    };
    try {
      const r = await adminFetch(`/admin/backlink-agent/owner-queue/rows/${row.id}/send`, { method: "POST", body });
      setResult({
        tone: "#15803D",
        text: `Sent the ${row.action === "outreach_followup" ? "follow-up" : "pitch"} to ${row.draft?.to || "the recipient"} on ${card.domain.domain}${r.authority ? ` (${r.authority.level})` : ""}`,
      });
      await refresh();
    } catch (e) {
      setError(OUTREACH_CODE_MSG[e?.code] || e?.message || "Send failed");
      // the match changed under the card (or the lookup now yields one): drop the stale acknowledgement and reload so
      // the owner reviews the CURRENT match — the server sends only against the hash it just computed
      if (REVIEW_RESET_CODES.has(e?.code)) {
        setAcks((prev) => ({
          ...prev,
          [ackKey]: false,
        }));
        await load();
      }
    } finally {
      setBusy(null);
    }
  };
  const decide = async (card, action) => {
    setBusy(card.domain.id);
    setError(null);
    setResult(null);
    try {
      const r = await adminFetch(`/admin/backlink-agent/owner-queue/domains/${card.domain.id}/${action}`, { method: "POST", body: { note: notes[card.domain.id] || null } });
      setResult({
        tone: "#27272A",
        text: `${card.domain.domain} → ${String(r.agent_state).replace(/_/g, " ")}${r.watch_recheck_at ? `, rechecked ${formatETDate(r.watch_recheck_at)}` : ""}`,
      });
      await refresh();
    } catch (e) {
      setError(e?.message || `${action} failed`);
    } finally {
      setBusy(null);
    }
  };
  const matchBacklink = async (card) => {
    setBusy(card.domain.id);
    setError(null);
    try {
      await adminFetch(`/admin/backlink-agent/prospects/${card.placement.id}/reconcile-backlink`, { method: "POST", body: { backlink_id: card.backlink_match.id } });
      setResult({
        tone: "#27272A",
        text: "Link matched to this placement. Verification will confirm whether it is live.",
      });
      await refresh();
    } catch (e) {
      setError(e?.message || "Could not match backlink");
    } finally {
      setBusy(null);
    }
  };
  const cards = data?.cards || [];
  return (
    <UiCard className="p-6 [margin-bottom:20px]">
      <div className="flex items-center justify-between flex-wrap [gap:8px] [margin-bottom:6px]">
        <div className="text-ui-body font-medium text-zinc-900">
          Owner queue
          {data
            ? ` · ${cards.length} card${cards.length === 1 ? "" : "s"}`
            : ""}
        </div>
        <div className="flex [gap:8px] items-center">
          <div className="text-ui-body text-ink-secondary">
            {data
              ? data.gateOn
                ? "GATE_LINK_AUTHORITY on"
                : "GATE_LINK_AUTHORITY off — nothing parks until it is on"
              : "…"}
          </div>
          <Button onClick={load} disabled={busy !== null}>
            Refresh
          </Button>
        </div>
      </div>
      <div className="text-ui-body text-ink-secondary [margin-bottom:12px]">
        Placements the nightly bridge parked for your decision. Approve freezes
        exactly the terms shown here; a changed price, agreement or policy
        invalidates it and the card comes back. Reject and Watch apply to the
        whole domain. Send the pitch mails the draft shown on the card from
        contact@ — that click is its approval. Nothing else here signs or pays —
        the runner does that later, against the approval.
      </div>
      {error && (
        <div className="[margin-bottom:8px] text-ui-body text-alert-fg">
          {error}
        </div>
      )}
      {result && (
        <div
          style={{
            color: result.tone,
          }}
          className="[margin-bottom:8px] text-ui-body"
        >
          {result.text}
        </div>
      )}
      {!data && !error && (
        <div className="text-ui-body text-ink-secondary">Loading…</div>
      )}
      {data && cards.length === 0 && (
        <div className="text-ui-body text-ink-secondary">
          Nothing awaits your decision.
        </div>
      )}
      {cards.map((c) => {
        const domainBusy = busy === c.domain.id;
        const assignmentHold = c.placement.claimed_at
          ? "Assignment waits for the active placement work to finish."
          : ["sending", "send_error"].includes(c.placement.follow_up_status)
            ? "Resolve the pending follow-up send before assigning this backlink."
            : null;
        const p = c.path;
        return (
          <div
            key={c.placement.id}
            className="rounded-md [padding:14px] [margin-bottom:12px] border-hairline border-zinc-200"
          >
            {c.submission_ambiguity && (
              <div className="text-ui-body [margin-bottom:14px]">
                <p>
                  The submission may have reached the publisher. Review the
                  evidence before recording a verdict. Automatic retry remains
                  held.
                </p>
                {c.submission_ambiguity.evidence_url ? (
                  <a
                    href={c.submission_ambiguity.evidence_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View submission screenshot
                  </a>
                ) : (
                  <p>
                    Screenshot unavailable. Verify the submission directly with
                    the publisher before recording a verdict.
                  </p>
                )}
                <label className="block [margin-top:12px]">
                  Confirmed publisher URL
                  <Input
                    type="url"
                    value={displayedSubmissionUrl(c)}
                    onChange={(event) =>
                      setPlacementUrls({
                        ...placementUrls,
                        [c.submission_ambiguity.id]: event.target.value,
                      })
                    }
                    placeholder="https://publisher.example/listing"
                    className="[width:100%] box-border [margin-top:4px]"
                  />
                </label>
                <div className="flex flex-wrap [gap:8px] [margin-top:10px]">
                  <Button
                    disabled={
                      busy !== null ||
                      Boolean(c.placement.claimed_at) ||
                      !displayedSubmissionUrl(c)
                    }
                    onClick={() => recordSubmissionVerdict(c, "placed")}
                  >
                    Confirm submitted
                  </Button>
                  <Button
                    disabled={busy !== null || Boolean(c.placement.claimed_at)}
                    onClick={() => recordSubmissionVerdict(c, "not_submitted")}
                  >
                    Confirm not submitted
                  </Button>
                </div>
              </div>
            )}
            {c.outreach_draft_exhausted && (
              <div className="text-ui-body [margin-bottom:14px]">
                <p>
                  Automatic drafting stopped without a pitch. Create or revise
                  its outreach draft to continue.
                </p>
                <Button
                  disabled={busy !== null || Boolean(c.placement.claimed_at)}
                  onClick={() =>
                    setDrafting({
                      ...c.placement,
                      target_domain: c.domain.domain,
                    })
                  }
                >
                  Create outreach draft
                </Button>
              </div>
            )}
            {c.backlink_match && (
              <div className="text-ui-body [margin-bottom:12px]">
                <p>
                  A backlink was found, but more than one placement could match
                  it. Review the source page before assigning it to this
                  placement.
                </p>
                <a
                  href={c.backlink_match.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-zinc-900"
                >
                  Review source page
                </a>
                <Button
                  disabled={domainBusy || Boolean(assignmentHold)}
                  onClick={() => matchBacklink(c)}
                  className="[margin-left:12px]"
                >
                  Assign to this placement
                </Button>
                {assignmentHold && <p>{assignmentHold}</p>}
              </div>
            )}

            <div className="flex justify-between flex-wrap [gap:8px] items-baseline">
              <div className="text-ui-body font-medium text-zinc-900">
                {c.domain.domain}
                {c.placement.location_key &&
                c.placement.location_key !== "-" ? (
                  <span className="text-ink-secondary font-normal">{` · ${c.placement.location_key}`}</span>
                ) : (
                  ""
                )}
                {c.placement.status === "ready_for_payment" && (
                  <span className="text-zinc-700 font-normal">
                    {" · at the publisher's checkout"}
                  </span>
                )}
                {["placed", "live", "indexed"].includes(c.placement.status) &&
                  (() => {
                    // the label is the PENDING action, never the status alone: a placed placement can still owe its initial fee — or
                    // only its follow-up send (§6.4), which owes no fee at all
                    const pending = c.rows.find(
                      (r) => r.dimension === "payment" && !r.satisfied_at,
                    ); // approved-but-unsettled is still the obligation
                    const what = pending
                      ? pending.action === "renewal"
                        ? "renewal"
                        : "initial fee"
                      : c.rows.some(
                            (r) =>
                              r.action === "outreach_followup" &&
                              !r.satisfied_at,
                          )
                        ? "follow-up"
                        : null;
                    return (
                      <span className="text-zinc-700 font-normal">{` · ${c.placement.status}${what ? ` — ${what}` : ""}`}</span>
                    );
                  })()}
              </div>
              <div className="text-ui-body text-ink-secondary">
                {`DR ${c.domain.domain_rating ?? "—"} · traffic ${compact(c.domain.organic_traffic)} · spam ${c.domain.spam_score ?? "—"} · score ${c.domain.score ?? "—"} · ${c.domain.competitors_linked ?? 0} competitor${c.domain.competitors_linked === 1 ? "" : "s"} linked · D30 ${c.d30_confidence == null ? "n/a" : c.d30_confidence}`}
              </div>
            </div>
            {p && (
              <div className="text-ui-body text-zinc-900 [margin-top:6px]">
                <span>{p.acquisition_type}</span>
                {` · ${p.expected_rel || "rel unknown"}`}
                {p.payment_required
                  ? ` · ${p.estimated_cost_cents != null ? money(p.estimated_cost_cents) : `price ${p.currency}`}${p.renewal_cost_cents != null ? ` · renews ${money(p.renewal_cost_cents)}${p.renewal_period && p.renewal_period !== "none" ? `/${p.renewal_period}` : ""}` : p.renewal_period === "none" ? " · one-time" : ""}${p.fee_scope === "account_wide" ? " · one fee for every location" : ""}`
                  : " · free"}
                {p.submission_url && (
                  <>
                    {" · "}
                    <a
                      href={p.submission_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-900"
                    >
                      submission page
                    </a>
                  </>
                )}
                {p.payment_required && (
                  <span>
                    {p.merchant_binding
                      ? ` · pays ${p.merchant_binding.merchant_account_id || "?"} via ${p.merchant_binding.processor_host || "?"} at ${p.merchant_binding.checkout_origin || "?"}${p.merchant_binding.issuer_merchant_descriptor ? ` (${p.merchant_binding.issuer_merchant_descriptor})` : ""}`
                      : " · no resolvable merchant — manual settlement only"}
                  </span>
                )}
                {p.legal_attestation && (
                  <>
                    {" · "}
                    {p.legal_terms_url ? (
                      <a
                        href={p.legal_terms_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-900"
                      >
                        agreement
                      </a>
                    ) : (
                      "agreement (no url)"
                    )}
                  </>
                )}
                {!p.on_best_path && (
                  <span className="text-zinc-700">
                    {" "}
                    · not on the current best path — the nightly bridge rotates
                    it
                  </span>
                )}
              </div>
            )}
            {c.domain.score_reasons && (
              <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                {c.domain.score_reasons}
              </div>
            )}
            {c.waiver && (
              <div className="text-ui-body text-zinc-700 [margin-top:4px]">
                {`Floors waived by ${c.waiver.approved_by} on ${formatETDate(c.waiver.approved_at)}: ${(c.waiver.overridden_floors || []).map((f) => `${f.floor} ${f.value} vs ${f.threshold}`).join(", ")}`}
              </div>
            )}
            <div className="overflow-x-auto [margin-top:10px]">
              <Table className="[width:100%] [border-collapse:collapse]">
                <THead>
                  <TR>
                    <TH>Step</TH>
                    <TH>Level</TH>
                    <TH>Why</TH>
                    <TH>Decision</TH>
                  </TR>
                </THead>
                <TBody>
                  {c.rows.map((r) => {
                    const rowBusy = busy === r.id;
                    // the service's verdict, not the raw approval: a consumed approval on a still-unsatisfied row is spent — the card asks again
                    const approvedBy =
                      r.approved && r.approval ? r.approval : null;
                    return (
                      <TR key={r.id}>
                        <TD>
                          {DIMENSION_LABELS[r.dimension] || r.dimension}
                          <div className="text-ink-secondary">
                            {ACTION_LABELS[r.action] || r.action}
                          </div>
                        </TD>
                        <TD className="u-nums">{r.level}</TD>
                        <TD className="text-ink-secondary">
                          {r.reason || "—"}
                        </TD>
                        <TD>
                          {approvedBy ? (
                            <span
                              style={{
                                color: r.approval_stale ? "#A16207" : "#15803D",
                              }}
                            >
                              {`Approved by ${approvedBy.approved_by} ${formatETDateTime(approvedBy.approved_at)}`}
                              {approvedBy.max_payable_cents != null
                                ? ` · up to ${money(approvedBy.max_payable_cents)}`
                                : ""}
                              {r.approval_stale ? ` · ${r.approval_stale}` : ""}
                            </span>
                          ) : r.approvable &&
                            r.dimension === "communication" ? (
                            <div className="flex flex-col [gap:6px] [min-width:260px]">
                              <div className="text-ui-body text-zinc-900">
                                <span className="text-ink-secondary">To </span>
                                {r.draft?.to || "—"}
                                <div>
                                  <b>{r.draft?.subject || "—"}</b>
                                </div>
                                <div className="text-ink-secondary whitespace-pre-wrap [max-height:84px] overflow-hidden">
                                  {r.draft?.body || ""}
                                </div>
                              </div>
                              <DraftReviewLine review={r.draft?.review} />
                              <RecipientReview
                                review={r.draft?.recipient_review}
                                acked={
                                  acks[
                                    `${r.id}:${r.draft?.recipient_review?.lookup_hash || ""}`
                                  ]
                                }
                                disabled={rowBusy}
                                onAck={(v) =>
                                  setAcks({
                                    ...acks,
                                    [`${r.id}:${r.draft?.recipient_review?.lookup_hash || ""}`]:
                                      v,
                                  })
                                }
                              />
                              <span>
                                <Button
                                  onClick={() => send(c, r)}
                                  disabled={
                                    rowBusy ||
                                    domainBusy ||
                                    (r.draft?.recipient_review?.kind ===
                                      "ambiguous" &&
                                      !acks[
                                        `${r.id}:${r.draft?.recipient_review?.lookup_hash || ""}`
                                      ])
                                  }
                                >
                                  {rowBusy
                                    ? "Sending…"
                                    : r.action === "outreach_followup"
                                      ? "Send the follow-up"
                                      : "Send the pitch"}
                                </Button>
                                {r.action === "outreach_followup" && (
                                  <Button
                                    onClick={() => skipFollowUp(c, r)}
                                    disabled={rowBusy || domainBusy}
                                    className="[margin-left:6px]"
                                  >
                                    Skip the follow-up
                                  </Button>
                                )}
                              </span>
                            </div>
                          ) : r.approvable ? (
                            <span className="inline-flex [gap:6px] items-center flex-wrap">
                              {r.dimension === "payment" && (
                                <label className="inline-flex [gap:4px] items-center text-ink-secondary">
                                  $
                                  <Input
                                    type="number"
                                    min="0.01"
                                    step="0.01"
                                    value={displayedAmount(c, r)}
                                    disabled={rowBusy}
                                    onChange={(e) =>
                                      setAmounts({
                                        ...amounts,
                                        [r.id]: e.target.value,
                                      })
                                    }
                                    className="[width:96px]"
                                  />
                                  {c.price_tolerance_cents > 0
                                    ? `+${money(c.price_tolerance_cents)} tolerance`
                                    : "exact"}
                                  {r.shared_fee
                                    ? ` · covers ${r.shared_fee.placements} locations`
                                    : ""}
                                </label>
                              )}
                              <Button
                                onClick={() => approve(c, r)}
                                disabled={rowBusy || domainBusy}
                              >
                                {rowBusy ? "Approving…" : "Approve"}
                              </Button>
                            </span>
                          ) : (
                            <span className="text-ink-secondary">
                              {r.why_not}
                            </span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            <div className="flex [gap:8px] items-center [margin-top:10px] flex-wrap">
              <Input
                type="text"
                placeholder="Note (optional, kept with the decision)"
                value={notes[c.domain.id] || ""}
                disabled={domainBusy}
                onChange={(e) =>
                  setNotes({
                    ...notes,
                    [c.domain.id]: e.target.value,
                  })
                }
                className="[flex:1_1_240px]"
              />
              {c.decidable ? (
                <>
                  <Button
                    onClick={() => decide(c, "watch")}
                    disabled={domainBusy}
                  >
                    Watch domain
                  </Button>
                  <Button
                    onClick={() => decide(c, "reject")}
                    disabled={domainBusy}
                  >
                    Reject domain
                  </Button>
                </>
              ) : (
                <span className="text-ui-body text-ink-secondary">
                  {c.submission_ambiguity
                    ? "Recording a submission verdict does not reopen acquisition for this domain."
                    : `Domain is ${String(c.domain.agent_state).replace(/_/g, " ")} — a sibling placement is approved or in flight; reject or watch it from the Link Building board`}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {drafting && (
        <OutreachDraftModal
          prospect={drafting}
          onClose={() => setDrafting(null)}
          onSaved={() => {
            setDrafting(null);
            refresh();
          }}
        />
      )}
    </UiCard>
  );
}
const POLICY_GROUPS = [
  {
    title: "Floors (any action, auto or owner-routed)",
    fields: ["min_score", "min_path_confidence", "max_spam_score"],
  },
  {
    title: "Automatic acquisition",
    fields: [
      "auto_free_acquisition",
      "auto_account_creation",
      "auto_submission_daily_cap",
      "membership_requires_owner",
      "legal_attestation_requires_owner",
    ],
  },
  {
    title: "Automatic outreach",
    fields: ["auto_outreach_min_score", "auto_outreach_daily_cap"],
  },
  {
    title: "Automatic spend",
    fields: [
      "monthly_paid_budget_cents",
      "max_auto_purchase_cents",
      "auto_paid_min_score",
      "auto_paid_min_d30_confidence",
    ],
  },
  {
    title: "Owner-approved spend",
    fields: [
      "owner_monthly_budget_cents",
      "owner_price_tolerance_cents",
      "presentment_window_days",
    ],
  },
  {
    title: "Provider",
    fields: ["preferred_provider"],
  },
];
const POLICY_LABELS = {
  min_score: "Minimum score",
  min_path_confidence: "Minimum path confidence (0–1)",
  max_spam_score: "Maximum spam score",
  auto_free_acquisition: "Auto free acquisition",
  auto_account_creation: "Auto account creation",
  auto_submission_daily_cap: "Auto submissions / day (0 = none)",
  membership_requires_owner: "Memberships need the owner",
  legal_attestation_requires_owner: "Signed terms need the owner",
  auto_outreach_min_score: "Auto outreach min score (blank = never)",
  auto_outreach_daily_cap: "Auto outreach / day (0 = none)",
  monthly_paid_budget_cents: "Auto monthly budget (¢)",
  max_auto_purchase_cents: "Max auto purchase (¢)",
  auto_paid_min_score: "Auto paid min score (blank = never)",
  auto_paid_min_d30_confidence: "Auto paid min D30 confidence (blank = never)",
  owner_monthly_budget_cents: "Owner monthly budget (¢, blank = no cap)",
  owner_price_tolerance_cents: "Owner price tolerance (¢)",
  presentment_window_days: "Presentment window (days, raise only)",
  preferred_provider: "Preferred provider",
};
function LinkPolicyPanel() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const loadGen = useRef(0);
  const load = async () => {
    const gen = ++loadGen.current;
    setError(null);
    try {
      const r = await adminFetch("/admin/backlink-agent/policy");
      if (gen !== loadGen.current) return;
      setData(r);
      setDraft({});
    } catch (e) {
      if (gen !== loadGen.current) return;
      setError(e?.message || "Policy load failed");
    }
  };
  useEffect(() => {
    load();
  }, []);
  const stored = data?.stored || {};
  const fields = data?.fields || {};
  const dirty = Object.keys(draft).filter(
    (k) =>
      draft[k] !== undefined &&
      String(draft[k] ?? "") !== String(stored[k] ?? ""),
  );
  const overrideFor = (name) =>
    (data?.overrides || []).find((o) => o.field === name);
  const save = async () => {
    if (!dirty.length) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    const patch = {};
    dirty.forEach((k) => {
      patch[k] = draft[k];
    });
    try {
      const r = await adminFetch("/admin/backlink-agent/policy", { method: "PATCH", body: patch });
      setSaved(
        r?.changed?.length
          ? `${r.changed.length} field${r.changed.length === 1 ? "" : "s"} changed`
          : "No changes",
      );
      await load();
    } catch (e) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };
  const renderField = (name) => {
    const spec = fields[name];
    if (!spec) return null;
    const value = draft[name] !== undefined ? draft[name] : stored[name];
    const override = overrideFor(name);
    const label = (
      <div className="text-ui-body text-ink-secondary [margin-bottom:4px]">
        {POLICY_LABELS[name] || name}
        {override && (
          <span className="text-zinc-700">{` · env ${override.env} tightens to ${override.applied}`}</span>
        )}
      </div>
    );
    if (spec.type === "boolean") {
      return (
        <label key={name} className="block text-ui-body text-zinc-900">
          {label}
          <Checkbox
            checked={value === true}
            disabled={saving}
            onChange={(e) =>
              setDraft({
                ...draft,
                [name]: e.target.checked,
              })
            }
          />
        </label>
      );
    }
    if (spec.type === "enum") {
      return (
        <div key={name}>
          {label}
          <Select
            value={value ?? ""}
            disabled={saving}
            onChange={(e) =>
              setDraft({
                ...draft,
                [name]: e.target.value,
              })
            }
          >
            {spec.values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </div>
      );
    }
    return (
      <div key={name}>
        {label}
        <Input
          type="number"
          step={spec.type === "int" ? 1 : 0.01}
          min={spec.min}
          max={spec.max}
          value={value === null || value === undefined ? "" : value}
          placeholder={spec.nullable ? "blank = off" : ""}
          disabled={saving}
          onChange={(e) =>
            setDraft({
              ...draft,
              [name]: e.target.value === "" ? null : e.target.value,
            })
          }
        />
      </div>
    );
  };
  return (
    <UiCard className="p-6 [margin-bottom:20px]">
      <div className="flex items-center justify-between flex-wrap [gap:8px] [margin-bottom:6px]">
        <div className="text-ui-body font-medium text-zinc-900">
          Acquisition authority policy
        </div>
        <div className="text-ui-body text-ink-secondary">
          {data
            ? data.gateOn
              ? "GATE_LINK_AUTHORITY on"
              : "GATE_LINK_AUTHORITY off — every row routes to you"
            : "…"}
        </div>
      </div>
      <div className="text-ui-body text-ink-secondary [margin-bottom:14px]">
        The only place thresholds change. Shipped defaults grant nothing
        automatically; every save is logged. Environment limits can only tighten
        a value.
      </div>
      {error && (
        <div className="[margin-bottom:8px] text-ui-body text-alert-fg">
          {error}
        </div>
      )}
      {!data && !error && (
        <div className="text-ui-body text-ink-secondary">Loading…</div>
      )}
      {data && (
        <>
          <div className="grid [grid-template-columns:repeat(auto-fill,_minmax(240px,_1fr))] [gap:16px]">
            {POLICY_GROUPS.map((g) => (
              <div key={g.title} className="flex flex-col [gap:10px]">
                <div className="text-ui-body font-medium text-zinc-900">
                  {g.title}
                </div>
                {g.fields.map(renderField)}
              </div>
            ))}
          </div>
          <div className="flex [gap:8px] items-center [margin-top:16px] flex-wrap">
            <Button onClick={save} disabled={saving || !dirty.length}>
              {saving
                ? "Saving…"
                : dirty.length
                  ? `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}`
                  : "No changes"}
            </Button>
            {dirty.length > 0 && (
              <Button
                onClick={() => {
                  setDraft({});
                  setError(null);
                }}
                disabled={saving}
              >
                Discard
              </Button>
            )}
            {saved && (
              <span className="text-ui-body text-zinc-900">{saved}</span>
            )}
            {data.updated_at && (
              <span className="text-ui-body text-ink-secondary">
                Last change {formatETDate(data.updated_at)}
                {data.updated_by ? ` by ${data.updated_by}` : ""}
              </span>
            )}
          </div>
          {data.audit?.length > 0 && (
            <div className="[margin-top:14px]">
              <div className="text-ui-body text-ink-secondary [margin-bottom:6px]">
                Recent changes
              </div>
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>When</TH>
                      <TH>Who</TH>
                      <TH>Field</TH>
                      <TH>From</TH>
                      <TH>To</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.audit.map((a) => (
                      <TR key={a.id}>
                        <TD className="u-nums">
                          {formatETDateTime(a.changed_at)}
                        </TD>
                        <TD>{a.changed_by || "—"}</TD>
                        <TD className="u-nums">{a.field}</TD>
                        <TD className="u-nums">{a.old_value ?? "null"}</TD>
                        <TD className="u-nums">{a.new_value ?? "null"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </div>
          )}
        </>
      )}
    </UiCard>
  );
}
function BacklinkAgentPanel() {
  const [stats, setStats] = useState(null);
  // one refresh key for the Registry card and the Owner queue: a mutation in either reloads both
  const [linkRefresh, setLinkRefresh] = useState(0);
  const bumpLinkRefresh = () => setLinkRefresh((n) => n + 1);
  const [queue, setQueue] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [urlInput, setUrlInput] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [processing, setProcessing] = useState(false);
  const [addResult, setAddResult] = useState(null);
  // Registry intake (plan v2 §4, step 2): paste/CSV → seo_link_domains + intake items
  const [intakeText, setIntakeText] = useState("");
  const [intakeSeed, setIntakeSeed] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeResult, setIntakeResult] = useState(null);
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
  const runIntake = async (dryRun) => {
    if (!intakeText.trim()) return;
    setIntakeBusy(true);
    try {
      const r = await adminPost("/admin/backlink-agent/opportunities/bulk", {
        text: intakeText,
        source: intakeSeed ? "owner_seed" : "list_import",
        dryRun,
      });
      setIntakeResult(r);
      if (!dryRun && !r?.error) setIntakeText("");
    } catch (e) {
      setIntakeResult({
        error: e?.message || "Intake failed",
      });
    } finally {
      setIntakeBusy(false);
    }
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
    pending: "#71717A",
    processing: "#18181B",
    signup_complete: "#A16207",
    verified: "#15803D",
    failed: "#991B1B",
    skipped: "#475569",
  };
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading backlink agent...
      </div>
    );
  return (
    <div className="flex flex-col [gap:16px]">
      {/* Stats */}
      <div className="seo-kpi-grid-5 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(5,_1fr)] [gap:10px]">
        {" "}
        <KpiCard label="Total Queued" value={stats?.total || 0} />{" "}
        <KpiCard
          label="Pending"
          value={stats?.pending || 0}
          color={"#71717A"}
        />{" "}
        <KpiCard
          label="Completed"
          value={stats?.completed || 0}
          color={"#A16207"}
        />{" "}
        <KpiCard
          label="Verified"
          value={stats?.verified || 0}
          color={"#15803D"}
        />{" "}
        <KpiCard
          label="Success Rate"
          value={`${stats?.successRate || 0}%`}
          color={stats?.successRate >= 50 ? "#15803D" : "#A16207"}
        />{" "}
      </div>
      {/* Controls */}
      <div className="flex [gap:8px]">
        {" "}
        <Button
          onClick={handleProcess}
          disabled={processing || (stats?.pending || 0) === 0}
        >
          {processing
            ? "Processing..."
            : `Process Queue (${stats?.pending || 0})`}
        </Button>{" "}
        <Button onClick={handlePoll} variant="secondary">
          Poll X Targets
        </Button>{" "}
        <Button onClick={handleVerifyEmails} variant="secondary">
          Verify Emails
        </Button>{" "}
        <Button onClick={loadData} variant="secondary">
          Refresh
        </Button>{" "}
      </div>{" "}
      <div className="flex flex-col [gap:16px]">
        {/* X Targets */}
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            X Targets
          </div>{" "}
          <div className="flex [gap:8px] [margin-bottom:12px]">
            {" "}
            <Input
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              placeholder="@username"
              className="[flex:1]"
            />{" "}
            <Button onClick={handleAddTarget}>Add Target</Button>{" "}
          </div>
          {targets.length === 0 ? (
            <div className="text-ink-secondary text-ui-body">
              No X targets configured.
            </div>
          ) : (
            <div className="grid [grid-template-columns:repeat(auto-fit,_minmax(180px,_1fr))] [gap:8px]">
              {targets.map((target) => (
                <div
                  key={target.id}
                  className="flex justify-between items-center [gap:8px] [padding:8px_10px] bg-zinc-100 rounded-md border-hairline border-zinc-200"
                >
                  {" "}
                  <div className="[min-width:0px]">
                    {" "}
                    <div className="text-ui-body text-zinc-900 font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                      @{target.x_username}
                    </div>{" "}
                    <div
                      style={{
                        color: target.is_active ? "#15803D" : "#71717A",
                      }}
                      className="text-ui-body"
                    >
                      {target.is_active ? "active" : "inactive"}
                      {target.last_polled_at
                        ? ` · ${String(target.last_polled_at).slice(0, 10)}`
                        : ""}
                    </div>{" "}
                  </div>{" "}
                  <Button
                    onClick={() => handleDeleteTarget(target.id)}
                    className="text-alert-fg"
                    variant="secondary"
                  >
                    Remove
                  </Button>{" "}
                </div>
              ))}
            </div>
          )}
        </UiCard>
        {/* Registry intake — paste box + CSV (plan v2 step 2) */}
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:4px]">
            Add opportunities to the registry
          </div>{" "}
          <div className="text-ui-body text-ink-secondary [margin-bottom:10px]">
            Domains, URLs, free text, or a CSV with a Website column. Shortener
            links and X posts are kept and resolved on the hourly sweep. Nothing
            is contacted or paid.
          </div>{" "}
          <Textarea
            value={intakeText}
            onChange={(e) => setIntakeText(e.target.value)}
            placeholder={
              "academia.edu\nhttps://producthunt.com/…\nWebsite,Primary Action\n…"
            }
            rows={5}
            className="[width:100%] resize-y box-border [margin-bottom:8px]"
          />{" "}
          <div className="flex justify-between items-center [gap:8px] flex-wrap">
            {" "}
            <label className="text-ui-body text-ink-secondary flex items-center [gap:6px] [min-height:44px]">
              <Checkbox
                checked={intakeSeed}
                onChange={(e) => setIntakeSeed(e.target.checked)}
              />
              Owner seed (investigate first)
            </label>{" "}
            <div className="flex [gap:8px]">
              {" "}
              <Button
                onClick={() => runIntake(true)}
                disabled={intakeBusy || !intakeText.trim()}
                variant="secondary"
              >
                Preview
              </Button>{" "}
              <Button
                onClick={() => runIntake(false)}
                disabled={intakeBusy || !intakeText.trim()}
              >
                {intakeBusy ? "Working…" : "Add to registry"}
              </Button>{" "}
            </div>
          </div>
          {intakeResult && (
            <div
              style={{
                color: intakeResult.error ? "#991B1B" : "#15803D",
              }}
              className="[margin-top:8px] text-ui-body"
            >
              {intakeResult.error
                ? intakeResult.error
                : `${intakeResult.dryRun ? "Preview: " : ""}${intakeResult.inserted} new, ${intakeResult.existing} already known` +
                  `${intakeResult.items?.pending ? `, ${intakeResult.items.pending} waiting to resolve` : ""}` +
                  `${intakeResult.dropped?.length ? `, ${intakeResult.dropped.length} dropped` : ""}`}
            </div>
          )}
        </UiCard>
        {/* Registry view + investigator (plan v2 step 3) */}
        <BacklinkRegistryCard
          refreshKey={linkRefresh}
          onMutated={bumpLinkRefresh}
        />
        {/* Owner queue — the cards the authority bridge parked (plan v2 step 4 PR 2b) */}
        <OwnerQueuePanel refreshKey={linkRefresh} onMutated={bumpLinkRefresh} />
        {/* Acquisition authority policy (plan v2 step 4a) */}
        <LinkPolicyPanel />
        {/* Manual URL Input */}
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Add URLs
          </div>{" "}
          <Textarea
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Paste URLs here, one per line..."
            rows={4}
            className="[width:100%] resize-y box-border [margin-bottom:8px]"
          />{" "}
          <div className="flex justify-between items-center">
            {" "}
            <span className="text-ui-body text-ink-secondary">
              {urlInput.split("\n").filter((u) => u.trim()).length} URLs
              detected
            </span>{" "}
            <Button onClick={handleAddUrls}>Add to Queue</Button>{" "}
          </div>
          {addResult && (
            <div className="[margin-top:8px] text-ui-body text-zinc-900">
              Added {addResult.added}, skipped {addResult.skipped}
              {addResult.duplicates?.length > 0
                ? ` (dupes: ${addResult.duplicates.join(", ")})`
                : ""}
            </div>
          )}
        </UiCard>
        {/* Queue Table */}
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Queue ({queue.length})
          </div>{" "}
          {/* overflowX spelled explicitly (overflow-y alone computes x to auto
              but never serializes "overflow-x: auto", so the index.css
              scroll-shadow affordance selector would miss this wrapper). */}
          <div className="[max-height:400px] overflow-y-auto overflow-x-auto">
            {queue.length === 0 ? (
              <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
                No URLs in queue. Add some above or poll X feeds.
              </div>
            ) : (
              <Table className="[width:100%] [border-collapse:collapse] text-ui-body">
                <THead>
                  <TR className="border-b border-hairline border-zinc-200">
                    <TH className="[padding:8px_10px] text-left text-ink-secondary text-ui-body">
                      Domain
                    </TH>
                    <TH className="[padding:8px_10px] text-left text-ink-secondary text-ui-body">
                      Source
                    </TH>
                    <TH className="[padding:8px_10px] text-left text-ink-secondary text-ui-body">
                      Status
                    </TH>
                    <TH className="[padding:8px_10px] text-right text-ink-secondary text-ui-body">
                      Actions
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {queue.map((item) => (
                    <TR
                      key={item.id}
                      className="border-b border-hairline border-zinc-200"
                    >
                      <TD className="[padding:8px_10px] text-zinc-900">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-zinc-900 [text-decoration:none]"
                        >
                          {item.domain}
                        </a>
                      </TD>
                      <TD className="[padding:8px_10px] text-ink-secondary">
                        {item.source}
                      </TD>
                      <TD className="[padding:8px_10px]">
                        {" "}
                        <span
                          style={{
                            background:
                              (statusColor[item.status] || "#71717A") + "22",
                            color: statusColor[item.status] || "#71717A",
                          }}
                          className="text-ui-body font-medium [padding:2px_8px] rounded-sm"
                        >
                          {item.status}
                        </span>
                        {item.error_message && (
                          <div className="text-ui-body text-alert-fg [margin-top:2px]">
                            {item.error_message.substring(0, 60)}
                          </div>
                        )}
                      </TD>
                      <TD className="[padding:8px_10px] text-right">
                        {(item.status === "failed" ||
                          item.status === "skipped") && (
                          <Button
                            onClick={() => handleRetry(item.id)}
                            className="[margin-right:4px]"
                            variant="secondary"
                          >
                            Retry
                          </Button>
                        )}
                        {(item.status === "pending" ||
                          item.status === "failed") && (
                          <Button
                            onClick={() => handleSkip(item.id)}
                            variant="secondary"
                          >
                            Skip
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>{" "}
        </UiCard>
        {/* Profiles */}
        {profiles.length > 0 && (
          <UiCard className="p-6">
            {" "}
            <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
              Completed Profiles ({profiles.length})
            </div>{" "}
            <div className="[max-height:300px] overflow-y-auto">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="[padding:8px_0] flex justify-between items-center border-b border-hairline border-zinc-200"
                >
                  {" "}
                  <div>
                    {" "}
                    <div className="text-ui-body text-zinc-900">
                      {p.domain || p.site_url}
                    </div>
                    {p.profile_url && (
                      <a
                        href={p.profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ui-body text-zinc-900 [text-decoration:none]"
                      >
                        View Profile
                      </a>
                    )}
                  </div>{" "}
                  <span
                    style={{
                      background:
                        p.queue_status === "verified"
                          ? "#15803D" + "22"
                          : "#A16207" + "22",
                      color:
                        p.queue_status === "verified" ? "#15803D" : "#A16207",
                    }}
                    className="text-ui-body font-medium [padding:2px_8px] rounded-sm"
                  >
                    {p.queue_status === "verified"
                      ? "VERIFIED"
                      : "PENDING VERIFY"}
                  </span>{" "}
                </div>
              ))}
            </div>{" "}
          </UiCard>
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading QA scores...
      </div>
    );
  if (!data || data.total === 0)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">
          No QA scores yet. Run Content QA to populate scored URLs, fix-first
          items, and publish readiness.
        </div>
      </UiCard>
    );
  const scores = data.scores || [];
  const fixFirst = data.fixFirst || [];
  const gc = {
    A: "#15803D",
    B: "#18181B",
    C: "#A16207",
    D: "#18181B",
    F: "#991B1B",
  };
  const avgScore = scores.length
    ? Math.round(
        scores.reduce((sum, row) => sum + Number(row.total_score || 0), 0) /
          scores.length,
      )
    : 0;
  return (
    <div className="flex flex-col [gap:16px]">
      <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:12px]">
        <KpiCard label="Scored URLs" value={fmt(data.total)} />
        <KpiCard
          label="Avg Latest 50"
          value={avgScore}
          color={
            avgScore >= 38 ? "#15803D" : avgScore >= 30 ? "#A16207" : "#991B1B"
          }
        />
        <KpiCard
          label="Publish Ready"
          value={
            (data.gradeDistribution?.A || 0) + (data.gradeDistribution?.B || 0)
          }
          color={"#15803D"}
        />
        <KpiCard
          label="Top Fixes"
          value={fixFirst.length}
          color={fixFirst.length ? "#991B1B" : "#15803D"}
        />
      </div>

      <div className="seo-kpi-grid-5 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(5,_1fr)] [gap:12px]">
        {Object.entries(data.gradeDistribution || {}).map(([g, c]) => (
          <KpiCard key={g} label={`Grade ${g}`} value={c} color={gc[g]} />
        ))}
      </div>

      {fixFirst.length > 0 && (
        <UiCard className="p-6">
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Top Fixes
          </div>
          <div className="overflow-x-auto">
            <Table className="[width:100%] [border-collapse:collapse]">
              <THead>
                <TR>
                  <TH>URL</TH>
                  <TH className="text-right u-nums">Score</TH>
                  <TH>Grade</TH>
                  <TH>Recommendation</TH>
                </TR>
              </THead>
              <TBody>
                {fixFirst.map((row) => (
                  <TR key={row.id || row.blog_post_id || row.url}>
                    <TD
                      title={row.url}
                      className="[max-width:420px] overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      {row.url || `Blog post ${row.blog_post_id}`}
                    </TD>
                    <TD
                      style={{
                        color: gc[row.grade] || "#27272A",
                      }}
                      className="text-right u-nums"
                    >
                      {row.total_score}/50
                    </TD>
                    <TD className="u-nums">{row.grade || "—"}</TD>
                    <TD>{row.recommendation || "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </UiCard>
      )}

      {scores.length > 0 && (
        <UiCard className="p-6">
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Latest Scores
          </div>
          <div className="overflow-x-auto">
            <Table className="[width:100%] [border-collapse:collapse]">
              <THead>
                <TR>
                  <TH>URL</TH>
                  <TH className="text-right u-nums">Total</TH>
                  <TH className="text-right u-nums">Technical</TH>
                  <TH className="text-right u-nums">On Page</TH>
                  <TH className="text-right u-nums">Local</TH>
                  <TH>Grade</TH>
                </TR>
              </THead>
              <TBody>
                {scores.slice(0, 20).map((row) => (
                  <TR key={`score-${row.id || row.blog_post_id || row.url}`}>
                    <TD
                      title={row.url}
                      className="[max-width:420px] overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      {row.url || `Blog post ${row.blog_post_id}`}
                    </TD>
                    <TD className="text-right u-nums">{row.total_score}/50</TD>
                    <TD className="text-right u-nums">
                      {row.technical_score ?? "—"}
                    </TD>
                    <TD className="text-right u-nums">
                      {row.onpage_score ?? "—"}
                    </TD>
                    <TD className="text-right u-nums">
                      {row.local_score ?? "—"}
                    </TD>
                    <TD
                      style={{
                        color: gc[row.grade] || "#27272A",
                      }}
                    >
                      {row.grade || "—"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </UiCard>
      )}
    </div>
  );
}

// Pillar 4 — Refresh Audit. Ranks published pages by refresh priority (age + QA
// gap + decay) and queues a chosen page into the existing autonomous refresh
// engine (opportunity_queue). Reuses content-qa + content-decay signals.
function priorityColor(p) {
  if (p >= 60) return "#991B1B";
  if (p >= 40) return "#A16207";
  if (p >= 20) return "#18181B";
  return "#71717A";
}
function RefreshAuditTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [batching, setBatching] = useState(false);
  const [enq, setEnq] = useState({}); // blogPostId -> 'queuing'|'queued'|'error'|'no_gsc'
  const [enqErr, setEnqErr] = useState({}); // blogPostId -> error message (button title)
  // Queue refresh + Run QA batch POST to requireAdmin routes — non-admins (tech/
  // CSR) can VIEW the ranking but would only get a 403, so hide the actions.
  const isAdmin = isAdminUser();
  const load = () => {
    setLoading(true);
    adminFetch("/admin/seo/refresh-audit?limit=200")
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };
  useEffect(load, []);
  const runQaBatch = async () => {
    setBatching(true);
    try {
      // publishedOnly: the audit only ranks published pages — don't spend the
      // batch on unscored drafts that never appear here.
      await adminFetch("/admin/seo/qa/batch", { method: "POST", body: { limit: 100, publishedOnly: true } });
      load(); // re-rank with fresh QA scores
    } catch {
      /* non-critical */
    } finally {
      setBatching(false);
    }
  };
  const queueRefresh = async (c) => {
    setEnq((s) => ({
      ...s,
      [c.blogPostId]: "queuing",
    }));
    try {
      const r = await adminFetch("/admin/seo/refresh-audit/enqueue", {
        method: "POST",
        body: { blogPostId: c.blogPostId },
      });
      if (r && r.queued === false) {
        // Page already has a claimed/done/in-review opportunity — the upsert
        // preserved it, so this wasn't (re)queued. Show the real state.
        const label =
          {
            pending: "Already queued",
            claimed: "Running",
            done: "Already done",
            pending_review: "In review",
          }[r.status] || `Already ${r.status}`;
        setEnq((s) => ({
          ...s,
          [c.blogPostId]: "already",
        }));
        setEnqErr((s) => ({
          ...s,
          [c.blogPostId]: label,
        }));
      } else {
        setEnq((s) => ({
          ...s,
          [c.blogPostId]: "queued",
        }));
      }
    } catch (e) {
      // Distinguish permanent blocks (no GSC signal, unmappable service, not
      // published) from a transient failure (which offers Retry).
      const msg = e?.message || "Enqueue failed";
      const noGsc = /search console|gsc/i.test(msg);
      const blocked =
        /could not (map|determine)|not published|no resolvable url/i.test(msg);
      setEnq((s) => ({
        ...s,
        [c.blogPostId]: noGsc ? "no_gsc" : blocked ? "blocked" : "error",
      }));
      setEnqErr((s) => ({
        ...s,
        [c.blogPostId]: msg,
      }));
    }
  };
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading refresh audit…
      </div>
    );
  if (!data || !data.summary)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">Refresh audit unavailable.</div>
      </UiCard>
    );
  const s = data.summary;
  const candidates = data.candidates || [];
  const gradeColor = {
    A: "#15803D",
    B: "#18181B",
    C: "#A16207",
    D: "#18181B",
    F: "#991B1B",
  };
  return (
    <div className="flex flex-col [gap:16px]">
      <div className="flex justify-between items-center flex-wrap [gap:10px]">
        <div className="text-ui-body text-ink-secondary">
          Ranks published pages by refresh priority — age since update, QA
          helpfulness gap, and traffic decay. “Queue refresh” hands a page to
          the autonomous engine (safe: shadow mode unless activated).
        </div>
        {isAdmin && (
          <Button
            onClick={runQaBatch}
            disabled={batching}
            title="Score up to 100 unscored pages with the Content QA gate, then re-rank"
            className="whitespace-nowrap"
            variant="secondary"
          >
            {batching ? "Scoring…" : "Run QA batch"}
          </Button>
        )}
      </div>

      <div className="seo-kpi-grid-5 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(5,_1fr)] [gap:12px]">
        <KpiCard label="Published" value={fmt(s.totalPublished)} />
        <KpiCard
          label="High priority"
          value={fmt(s.highPriority)}
          color={s.highPriority ? "#991B1B" : "#15803D"}
        />
        <KpiCard
          label="Stale 180d+"
          value={fmt(s.stale)}
          color={s.stale ? "#A16207" : "#15803D"}
        />
        <KpiCard
          label="Traffic decay"
          value={fmt(s.withDecay)}
          color={s.withDecay ? "#991B1B" : "#15803D"}
        />
        <KpiCard
          label="Not QA-scored"
          value={fmt(s.unscored)}
          color={s.unscored ? "#A16207" : "#15803D"}
        />
      </div>

      <UiCard className="p-6">
        <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
          Refresh candidates
        </div>
        {candidates.length === 0 ? (
          <div className="text-ink-secondary [padding:20px] text-center">
            No published pages found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="[width:100%] [border-collapse:collapse]">
              <THead>
                <TR>
                  <TH className="text-right u-nums">Priority</TH>
                  <TH>Page</TH>
                  <TH className="text-right u-nums">Age</TH>
                  <TH>QA</TH>
                  <TH className="text-right u-nums">Decay</TH>
                  <TH>Why</TH>
                  {isAdmin && <TH>Action</TH>}
                </TR>
              </THead>
              <TBody>
                {candidates.map((c) => {
                  const st = enq[c.blogPostId];
                  return (
                    <TR key={c.blogPostId}>
                      <TD
                        style={{
                          color: priorityColor(c.priority),
                        }}
                        className="text-right u-nums font-medium"
                      >
                        {c.priority}
                      </TD>
                      <TD
                        title={c.url || c.title}
                        className="[max-width:360px] overflow-hidden text-ellipsis whitespace-nowrap"
                      >
                        {c.title || c.url || c.slug}
                      </TD>
                      <TD className="text-right u-nums">
                        {c.ageDays != null ? `${c.ageDays}d` : "—"}
                      </TD>
                      <TD
                        style={{
                          color: gradeColor[c.qaGrade] || "#71717A",
                        }}
                      >
                        {c.qaGrade ? `${c.qaGrade} (${c.qaScore})` : "—"}
                      </TD>
                      <TD
                        style={{
                          color: c.decayPct != null ? "#991B1B" : "#71717A",
                        }}
                        className="text-right u-nums"
                      >
                        {c.decayPct != null ? `${c.decayPct}%` : "—"}
                      </TD>
                      <TD className="text-ui-body text-ink-secondary [max-width:240px]">
                        {(c.reasons || []).join(" · ") || "—"}
                      </TD>
                      {isAdmin && (
                        <TD className="u-nums">
                          <Button
                            onClick={() => queueRefresh(c)}
                            disabled={[
                              "queuing",
                              "queued",
                              "no_gsc",
                              "blocked",
                              "already",
                            ].includes(st)}
                            title={enqErr[c.blogPostId] || ""}
                            className="whitespace-nowrap"
                            variant={st === "queued" ? "primary" : "secondary"}
                          >
                            {st === "queued"
                              ? "Queued ✓"
                              : st === "queuing"
                                ? "Queuing…"
                                : st === "already"
                                  ? enqErr[c.blogPostId] || "Already queued"
                                  : st === "no_gsc"
                                    ? "No GSC data"
                                    : st === "blocked"
                                      ? "Can't queue"
                                      : st === "error"
                                        ? "Retry"
                                        : "Queue refresh"}
                          </Button>
                        </TD>
                      )}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </UiCard>
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading...
      </div>
    );
  if (!data)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">No AI Overview data yet.</div>
      </UiCard>
    );
  return (
    <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:12px]">
      {" "}
      <KpiCard label="Tracked" value={data.total || 0} />{" "}
      <KpiCard label="With AIO" value={data.withAIO || 0} color={"#18181B"} />{" "}
      <KpiCard
        label="Waves Cited"
        value={data.wavesCited || 0}
        color={"#15803D"}
      />{" "}
      <KpiCard
        label="GEO Score"
        value={`${data.geoScore || 0}%`}
        color={data.geoScore >= 30 ? "#15803D" : "#A16207"}
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading...
      </div>
    );
  if (!data)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">No funnel data yet.</div>
      </UiCard>
    );
  const o = data.organic || {};
  return (
    <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:12px]">
      {" "}
      <KpiCard
        label="Impressions"
        value={(o.impressions || 0).toLocaleString()}
      />{" "}
      <KpiCard
        label="Clicks"
        value={(o.clicks || 0).toLocaleString()}
        sub={{
          text: `${o.ctr || 0}% CTR`,
        }}
      />{" "}
      <KpiCard
        label="Sitewide Booked"
        value={data.estimates?.booked || 0}
        color={"#15803D"}
      />{" "}
      <KpiCard
        label="Sitewide Revenue"
        value={fmtMoney(data.revenue || 0)}
        color={"#15803D"}
        sub={{
          text: "correlated, not attributed",
        }}
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading site rollup...
      </div>
    );
  if (!data)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">No rollup data yet.</div>
      </UiCard>
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
        background: "#18181B" + "22",
      }}
      className="text-ui-body [padding:1px_5px] rounded-xs text-zinc-900 [margin-left:6px]"
    >
      HUB
    </span>
  );
  return (
    <div className="flex flex-col [gap:16px]">
      <div className="seo-analytics-period flex max-sm:flex-wrap [gap:8px]">
        {[7, 30, 90].map((d) => (
          <Button
            key={d}
            onClick={() => setDays(d)}
            variant={days === d ? "primary" : "secondary"}
          >
            {d}d
          </Button>
        ))}
      </div>
      <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:12px]">
        <KpiCard
          label="Inbound Calls"
          value={num(t.calls)}
          sub={{
            text: `${num(t.missedCalls)} missed`,
            color: t.missedCalls > 0 ? "#A16207" : undefined,
          }}
        />
        <KpiCard
          label="Leads"
          value={num(t.leads)}
          sub={{
            text: `${num(t.won)} won`,
            color: "#15803D",
          }}
        />
        <KpiCard
          label="Site Calls"
          value={num(t.siteCalls)}
          sub={{
            text: "attributed to a fleet domain",
          }}
        />
        <KpiCard
          label="Site Leads"
          value={num(t.siteLeads)}
          sub={{
            text: "attributed to a fleet domain",
          }}
        />
      </div>
      <UiCard className="p-6">
        <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
          Calls + Leads by Site
        </div>
        <div className="overflow-x-auto">
          <Table className="[width:100%] [border-collapse:collapse]">
            <THead>
              <TR>
                <TH>Site</TH>
                <TH>Lane</TH>
                <TH className="text-right u-nums">Calls</TH>
                <TH className="text-right u-nums">Missed</TH>
                <TH className="text-right u-nums">Form Leads</TH>
                <TH className="text-right u-nums">Call Leads</TH>
                <TH className="text-right u-nums">Leads</TH>
                <TH className="text-right u-nums">Won</TH>
              </TR>
            </THead>
            <TBody>
              {sites.map((s) => (
                <TR key={s.domain}>
                  <TD>
                    {s.domain}
                    {s.kind === "hub" && hubChip}
                  </TD>
                  <TD className="text-ink-secondary">{s.lane}</TD>
                  <TD className="text-right u-nums">{cell(s.calls)}</TD>
                  <TD
                    style={{
                      color: s.missedCalls ? "#A16207" : "#27272A",
                    }}
                    className="text-right u-nums"
                  >
                    {cell(s.missedCalls)}
                  </TD>
                  <TD className="text-right u-nums">{cell(s.formLeads)}</TD>
                  <TD className="text-right u-nums">{cell(s.callLeads)}</TD>
                  <TD className="text-right u-nums">{cell(s.leads)}</TD>
                  <TD
                    style={{
                      color: s.won ? "#15803D" : "#27272A",
                    }}
                    className="text-right u-nums"
                  >
                    {cell(s.won)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
        <div className="text-ui-body text-ink-secondary [margin-top:10px]">
          Calls attribute by tracking number; leads by lead source. Call Leads
          are calls that became pipeline entries, so they overlap with Calls.
        </div>
      </UiCard>
      {(nonSite.length > 0 || other.length > 0 || un.leads > 0) && (
        <div className="seo-kpi-grid-3 grid max-sm:!grid-cols-1 [grid-template-columns:1fr_1fr] [gap:12px] [align-items:start]">
          {nonSite.length > 0 && (
            <UiCard className="p-6">
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                Non-Site Lines
              </div>
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>Line</TH>
                      <TH className="text-right u-nums">Calls</TH>
                      <TH className="text-right u-nums">Missed</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {nonSite.map((l) => (
                      <TR key={l.label}>
                        <TD>{l.label}</TD>
                        <TD className="text-right u-nums">{cell(l.calls)}</TD>
                        <TD
                          style={{
                            color: l.missedCalls ? "#A16207" : "#27272A",
                          }}
                          className="text-right u-nums"
                        >
                          {cell(l.missedCalls)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </UiCard>
          )}
          {(other.length > 0 || un.leads > 0) && (
            <UiCard className="p-6">
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                Non-Site Lead Sources
              </div>
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>Source</TH>
                      <TH className="text-right u-nums">Leads</TH>
                      <TH className="text-right u-nums">Won</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {other.map((s) => (
                      <TR key={s.name}>
                        <TD>{s.name}</TD>
                        <TD className="text-right u-nums">{cell(s.leads)}</TD>
                        <TD
                          style={{
                            color: s.won ? "#15803D" : "#27272A",
                          }}
                          className="text-right u-nums"
                        >
                          {cell(s.won)}
                        </TD>
                      </TR>
                    ))}
                    {un.leads > 0 && (
                      <TR>
                        <TD className="text-ink-secondary">
                          No source attributed
                        </TD>
                        <TD className="text-right u-nums">{cell(un.leads)}</TD>
                        <TD
                          style={{
                            color: un.won ? "#15803D" : "#27272A",
                          }}
                          className="text-right u-nums"
                        >
                          {cell(un.won)}
                        </TD>
                      </TR>
                    )}
                  </TBody>
                </Table>
              </div>
            </UiCard>
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading...
      </div>
    );
  if (!data)
    return (
      <UiCard className="[padding:40px] text-center">
        <div className="text-ink-secondary">No citations.</div>
      </UiCard>
    );
  const bs = data.byStatus || {};
  const sc = {
    active: "#15803D",
    inconsistent: "#991B1B",
    missing: "#A16207",
    claimed: "#18181B",
    unchecked: "#71717A",
  };
  return (
    <div className="flex flex-col [gap:16px]">
      {" "}
      <div className="seo-kpi-grid-5 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(5,_1fr)] [gap:12px]">
        {" "}
        <KpiCard label="Active" value={bs.active || 0} color={"#15803D"} />{" "}
        <KpiCard
          label="Inconsistent"
          value={bs.inconsistent || 0}
          color={"#991B1B"}
        />{" "}
        <KpiCard label="Missing" value={bs.missing || 0} color={"#A16207"} />{" "}
        <KpiCard label="Claimed" value={bs.claimed || 0} color={"#18181B"} />{" "}
        <KpiCard label="Unchecked" value={bs.unchecked || 0} />{" "}
      </div>{" "}
      <UiCard className="p-6">
        {(data.citations || []).map((c, i) => (
          <div
            key={i}
            className="flex items-center [gap:10px] [padding:8px_0] border-b border-hairline border-zinc-200"
          >
            {" "}
            <div
              style={{
                background: sc[c.status] || "#71717A",
              }}
              className="[width:8px] [height:8px] rounded-sm"
            />{" "}
            <div className="[flex:1] text-ui-body text-zinc-900">
              {c.directory_name}
            </div>{" "}
            <span
              style={{
                background: (sc[c.status] || "#71717A") + "22",
                color: sc[c.status] || "#71717A",
              }}
              className="text-ui-body [padding:2px_8px] rounded-sm font-medium"
            >
              {c.status}
            </span>{" "}
          </div>
        ))}
      </UiCard>{" "}
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
      adminFetch(`/admin/analytics/overview?period=${days}`).catch((e) => ({
        error: e.message,
      })),
      adminFetch(`/admin/analytics/sources?period=${days}`).catch((e) => ({
        data: [],
        error: e.message,
      })),
      adminFetch(`/admin/analytics/landing-pages?period=${days}`).catch(
        (e) => ({
          data: [],
          error: e.message,
        }),
      ),
      adminFetch(`/admin/analytics/local-performance?period=${days}`).catch(
        (e) => ({
          error: e.message,
        }),
      ),
      adminFetch(`/admin/analytics/data-manager/readiness?period=${days}`).catch((e) => ({
        error: e.message,
      })),
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
      <div className="text-ink-secondary [padding:40px] text-center">
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
  const setupLinks = Array.isArray(local.setup?.utmWebsiteLinks)
    ? local.setup.utmWebsiteLinks
    : [];
  const localWarnings = Array.isArray(local.warnings) ? local.warnings : [];
  const dataManagerWarnings = Array.isArray(dm.warnings) ? dm.warnings : [];
  const analyticsNotices = [
    ...(overview?.configured === false
      ? [
          {
            title: "Google Analytics access",
            message:
              "Set GOOGLE_SERVICE_ACCOUNT_JSON and GA4_PROPERTY_ID, then grant the service account Viewer access in GA4.",
          },
        ]
      : []),
    ...(overview?.configured !== false && overview?.error
      ? [
          {
            title: "Google Analytics access",
            message: overview.error,
          },
        ]
      : []),
    ...localWarnings.map((warning) => ({
      title: "Local performance data",
      message: `${warning?.source || "source"}: ${warning?.message || "Unavailable"}`,
    })),
    ...(dm.error
      ? [
          {
            title: "Google Ads Data Manager",
            message: dm.error,
          },
        ]
      : []),
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
      .catch((e) =>
        setDataManagerResult({
          synced: false,
          conversionType,
          error: e.message,
        }),
      )
      .finally(() => setDataManagerBusy(null));
  };
  const dmStatus = (config) => {
    if (config?.configured)
      return dm.liveUploadsAllowed ? "Live-ready" : "Validate-only";
    if (config?.missing?.length) return "Needs config";
    return "Checking";
  };
  const dmTone = (config) => (config?.configured ? "#15803D" : "#A16207");
  const dmMetric = (config, key) => fmt(config?.candidates?.[key] || 0);
  const dmResultText = dataManagerResult
    ? `${dataManagerResult.conversionType === "qualified_lead" ? "Qualified Lead" : "Completed Revenue"}: ${dataManagerResult.synced ? `${fmt(dataManagerResult.sent || 0)} event${Number(dataManagerResult.sent || 0) === 1 ? "" : "s"} validated` : dataManagerResult.error || "Validation failed"}`
    : null;
  return (
    <div className="flex flex-col [gap:16px]">
      {/* Period selector */}
      <div className="seo-analytics-period flex max-sm:flex-wrap [gap:8px]">
        {[7, 14, 28, 30, 90].map((d) => (
          <Button
            key={d}
            onClick={() => setDays(d)}
            variant={days === d ? "primary" : "secondary"}
          >
            {d}d
          </Button>
        ))}
      </div>
      {analyticsNotices.length > 0 && (
        <UiCard className="[padding:16px] text-zinc-700">
          <div className="text-ui-body font-medium text-zinc-900">
            Analytics data notices
          </div>
          <div className="flex flex-col [gap:6px] [margin-top:8px]">
            {analyticsNotices.map((notice, idx) => (
              <div
                key={`${notice.title}-${idx}`}
                className="text-ui-body text-ink-secondary [line-height:1.5]"
              >
                <strong className="text-zinc-900">{notice.title}:</strong>{" "}
                {notice.message}
              </div>
            ))}
          </div>
        </UiCard>
      )}
      {profiles.length > 0 && (
        <>
          <div className="seo-kpi-grid-3 grid max-sm:!grid-cols-1 [grid-template-columns:repeat(4,_1fr)] [gap:12px]">
            <KpiCard
              label="GBP Interactions"
              value={fmt(localGbp.interactions)}
              sub={{
                text: `${fmt(localGbp.calls)} calls · ${fmt(localGbp.directionRequests)} directions`,
              }}
            />
            <KpiCard
              label="GBP Website Clicks"
              value={fmt(localGbp.websiteClicks)}
              sub={{
                text: "4-profile blended total",
              }}
            />
            <KpiCard
              label="GBP UTM Sessions"
              value={fmt(localGa4.sessions)}
              sub={{
                text: `${fmt(localGa4.conversions)} GA4 key events`,
              }}
            />
            <KpiCard
              label="GBP CRM Revenue"
              value={money(localCrm.acceptedEstimateRevenue)}
              sub={{
                text: `${fmt(localCrm.leads)} leads · ${fmt(localCrm.bookedJobs)} booked`,
              }}
            />
          </div>
          <UiCard className="p-6">
            <div className="flex justify-between [gap:16px] items-start [margin-bottom:12px]">
              <div>
                <div className="text-ui-body font-medium text-zinc-900">
                  Local Performance By Profile
                </div>
                <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                  Native GBP totals stay blended in GA4; profile rows use Waves
                  GBP sync, UTMs, and CRM attribution.
                </div>
              </div>
              <div className="text-ui-body text-ink-secondary">
                {fmt(readiness.eligible)}/{fmt(readiness.leads)} upload-ready
                leads
              </div>
            </div>
            <div className="overflow-x-auto">
              <Table className="[width:100%] [border-collapse:collapse] [min-width:860px]">
                <THead>
                  <TR>
                    <TH>Profile</TH>
                    <TH className="text-right u-nums">GBP Clicks</TH>
                    <TH className="text-right u-nums">GA4 Sessions</TH>
                    <TH className="text-right u-nums">Leads</TH>
                    <TH className="text-right u-nums">Booked</TH>
                    <TH className="text-right u-nums">Revenue</TH>
                    <TH className="text-right u-nums">Upload Ready</TH>
                  </TR>
                </THead>
                <TBody>
                  {profiles.map((profile) => (
                    <TR key={profile.id}>
                      <TD>
                        <div className="font-medium text-zinc-900">
                          {profile.name}
                        </div>
                        <a
                          href={profile.trackingUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="block [margin-top:4px] text-ui-body text-ink-secondary [text-decoration:none] [max-width:320px] overflow-hidden text-ellipsis whitespace-nowrap"
                        >
                          {profile.trackingUrl}
                        </a>
                      </TD>
                      <TD className="text-right u-nums">
                        {fmt(profile.gbp?.websiteClicks)}
                      </TD>
                      <TD className="text-right u-nums">
                        {fmt(profile.ga4?.sessions)}
                      </TD>
                      <TD className="text-right u-nums">
                        {fmt(profile.crm?.leads)}
                      </TD>
                      <TD className="text-right u-nums">
                        {fmt(profile.crm?.bookedJobs)}
                      </TD>
                      <TD className="text-right u-nums">
                        {money(profile.crm?.acceptedEstimateRevenue)}
                      </TD>
                      <TD className="text-right u-nums">
                        {fmt(profile.crm?.dataManagerEligible)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </UiCard>
          <UiCard className="[padding:16px]">
            <div className="text-ui-body font-medium text-zinc-900">
              GA4 And Google Ads Setup
            </div>
            <div className="grid [grid-template-columns:repeat(3,_1fr)] [gap:12px] [margin-top:12px]">
              <div className="text-ui-body text-zinc-900 [line-height:1.5]">
                <strong>GA4 GBP link</strong>
                <br />
                <span className="text-ink-secondary">
                  Link all 4 profiles in GA4 Admin. Native GBP metrics are
                  aggregate-only.
                </span>
              </div>
              <div className="text-ui-body text-zinc-900 [line-height:1.5]">
                <strong>GBP website URLs</strong>
                <br />
                <span className="text-ink-secondary">
                  {setupLinks.length} tagged links configured for per-profile
                  website attribution.
                </span>
              </div>
              <div className="text-ui-body text-zinc-900 [line-height:1.5]">
                <strong>Ads feedback loop</strong>
                <br />
                <span className="text-ink-secondary">
                  {dmStatus(dmCompleted)} · {dmMetric(dmCompleted, "eligible")}{" "}
                  completed-revenue events ready
                </span>
                <div className="flex [gap:8px] flex-wrap [margin-top:10px]">
                  <Button
                    type="button"
                    onClick={() => validateDataManager("qualified_lead")}
                    disabled={!!dataManagerBusy || !dmQualified?.configured}
                    className="inline-flex items-center [gap:6px]"
                    variant={dmQualified?.configured ? "primary" : "secondary"}
                  >
                    <UploadCloud size={14} />
                    {dataManagerBusy === "qualified_lead"
                      ? "Validating"
                      : "Validate leads"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => validateDataManager("completed_job_revenue")}
                    disabled={!!dataManagerBusy || !dmCompleted?.configured}
                    className="inline-flex items-center [gap:6px]"
                    variant={dmCompleted?.configured ? "primary" : "secondary"}
                  >
                    <UploadCloud size={14} />
                    {dataManagerBusy === "completed_job_revenue"
                      ? "Validating"
                      : "Validate revenue"}
                  </Button>
                </div>
              </div>
            </div>
            <div className="grid [grid-template-columns:repeat(2,_1fr)] [gap:12px] [margin-top:14px] [padding-top:12px] border-t border-hairline border-zinc-200">
              {[
                ["Qualified Lead", dmQualified],
                ["Completed Revenue", dmCompleted],
              ].map(([label, config]) => (
                <div
                  key={label}
                  className="text-ui-body text-zinc-900 [line-height:1.5]"
                >
                  <div className="flex items-center justify-between [gap:8px]">
                    <strong>{label}</strong>
                    <span
                      style={{
                        color: dmTone(config),
                      }}
                      className="text-ui-body font-medium"
                    >
                      {dmStatus(config)}
                    </span>
                  </div>
                  <div className="text-ink-secondary [margin-top:4px]">
                    {dmMetric(config, "eligible")} ready ·{" "}
                    {dmMetric(config, "alreadySent")} sent ·{" "}
                    {dmMetric(config, "missingMatchKeys")} missing match keys
                  </div>
                  {config?.missing?.length > 0 && (
                    <div className="text-zinc-700 [margin-top:4px]">
                      Missing {config.missing.join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {dmResultText && (
              <div
                style={{
                  color: dataManagerResult?.synced ? "#15803D" : "#991B1B",
                }}
                className="[margin-top:12px] text-ui-body font-medium"
              >
                {dmResultText}
              </div>
            )}
          </UiCard>
        </>
      )}
      {/* KPI Row */}
      <div className="seo-kpi-grid-3 grid max-sm:!grid-cols-1 [grid-template-columns:repeat(3,_1fr)] [gap:12px]">
        {[
          {
            label: "Sessions",
            value: fmt(data.sessions),
          },
          {
            label: "Users",
            value: fmt(data.users),
          },
          {
            label: "New Users",
            value: fmt(data.newUsers),
          },
        ].map((k) => (
          <KpiCard key={k.label} label={k.label} value={k.value} />
        ))}
      </div>{" "}
      <div className="seo-kpi-grid-3 grid max-sm:!grid-cols-1 [grid-template-columns:repeat(3,_1fr)] [gap:12px]">
        {[
          {
            label: "Bounce Rate",
            value: pct(data.bounceRate),
            color:
              data.bounceRate > 0.6
                ? "#991B1B"
                : data.bounceRate > 0.4
                  ? "#A16207"
                  : "#15803D",
          },
          {
            label: "Avg Session",
            value: dur(data.avgSessionDuration),
          },
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
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Traffic Sources
          </div>{" "}
          <div className="flex flex-col [gap:6px]">
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
                  organic: "#15803D",
                  paid: "#A16207",
                  direct: "#18181B",
                  referral: "#18181B",
                  social: "#ec4899",
                }[s.source?.toLowerCase()] || "#71717A";
              return (
                <div
                  key={i}
                  className="flex items-center [gap:10px] [padding:8px_12px] bg-zinc-100 rounded-md"
                >
                  {" "}
                  <span
                    style={{
                      background: srcColor,
                    }}
                    className="[width:8px] [height:8px] rounded-xs shrink-0"
                  />{" "}
                  <div className="[flex:1] [min-width:0px]">
                    {" "}
                    <div className="text-ui-body text-zinc-900 font-medium">
                      {s.source || "unknown"}
                      {s.medium ? ` / ${s.medium}` : ""}
                    </div>{" "}
                  </div>{" "}
                  <div className="text-ui-body font-medium text-zinc-900">
                    {fmt(s.sessions)}
                  </div>{" "}
                  <div className="text-ui-body text-ink-secondary [width:50px] text-right">
                    {pctOfTotal}%
                  </div>{" "}
                </div>
              );
            })}
          </div>{" "}
        </UiCard>
      )}
      {/* Top Pages */}
      {topPages.length > 0 && (
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Top Landing Pages
          </div>{" "}
          <div className="flex flex-col [gap:4px]">
            {" "}
            <div className="seo-top-pages-header flex max-sm:hidden [padding:0_12px_8px] text-ui-body text-ink-secondary">
              {" "}
              <div className="[flex:1]">Page</div>{" "}
              <div className="[width:70px] text-right">Sessions</div>{" "}
              <div className="[width:70px] text-right">Bounce</div>{" "}
              <div className="[width:70px] text-right">Avg Time</div>{" "}
            </div>
            {topPages.slice(0, 20).map((p, i) => (
              <div
                key={i}
                className="seo-top-pages-row flex max-sm:flex-wrap max-sm:gap-1 max-sm:[&>div:first-child]:w-full max-sm:[&>div:first-child]:flex-none items-center [padding:8px_12px] rounded-sm"
                style={{
                  background: i % 2 === 0 ? "#F4F4F5" : "transparent",
                }}
              >
                {" "}
                <div className="[flex:1] text-ui-body text-zinc-900 overflow-hidden text-ellipsis whitespace-nowrap break-all">
                  {p.landingPage || p.page || p.pagePath}
                </div>{" "}
                <div className="[width:70px] text-right text-ui-body font-medium text-zinc-900 shrink-0">
                  {fmt(p.sessions || p.pageviews)}
                </div>{" "}
                <div
                  style={{
                    color: p.bounceRate > 0.6 ? "#991B1B" : "#71717A",
                  }}
                  className="[width:70px] text-right text-ui-body shrink-0"
                >
                  {pct(p.bounceRate)}
                </div>{" "}
                <div className="[width:70px] text-right text-ui-body text-ink-secondary shrink-0">
                  {dur(p.avgSessionDuration)}
                </div>{" "}
              </div>
            ))}
          </div>{" "}
        </UiCard>
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
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading site audit...
      </div>
    );
  if (!data?.hasData)
    return (
      <UiCard className="text-center [padding:60px]">
        <div className="text-[18px] font-medium text-zinc-900 [margin-bottom:8px]">
          No Audit Data Yet
        </div>{" "}
        {canRunSeoActions && (
          <Button onClick={runAudit} disabled={running}>
            {running ? "Auditing..." : "Run Site Audit"}
          </Button>
        )}{" "}
      </UiCard>
    );
  const run = data.latestRun || {};
  const pages = data.pages || [];
  const issues = data.issues || [];
  const history = data.history || [];
  const scoreColor = (s) =>
    s >= 80 ? "#15803D" : s >= 50 ? "#A16207" : "#991B1B";
  const severityColor = {
    critical: "#991B1B",
    warning: "#A16207",
    info: "#71717A",
    healthy: "#15803D",
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
    <div className="flex flex-col [gap:16px]">
      {/* KPI Row */}
      <div className="seo-audit-kpi-grid grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:12px]">
        {" "}
        <UiCard className="[padding:16px] text-center">
          {" "}
          <div className="text-ui-body text-ink-secondary">
            Site Health Score
          </div>{" "}
          <div
            style={{
              color: scoreColor(parseFloat(run.avg_health_score || 0)),
            }}
            className="text-[36px] font-medium"
          >
            {Math.round(run.avg_health_score || 0)}
          </div>{" "}
          <div className="text-ui-body text-ink-secondary">
            {run.pages_crawled || 0} pages crawled
          </div>{" "}
        </UiCard>
        {[
          {
            label: "Healthy",
            key: "healthy",
            count: run.pages_healthy || 0,
            color: "#15803D",
          },
          {
            label: "Warning",
            key: "warning",
            count: run.pages_warning || 0,
            color: "#A16207",
          },
          {
            label: "Critical",
            key: "critical",
            count: run.pages_critical || 0,
            color: "#991B1B",
          },
        ].map((s) => (
          <UiCard
            key={s.key}
            onClick={() => setFilter(filter === s.key ? "all" : s.key)}
            style={{
              border:
                filter === s.key ? `2px solid ${s.color}` : "1px solid #E4E4E7",
            }}
            className="[padding:16px] text-center cursor-pointer"
          >
            {" "}
            <div className="text-ui-body text-ink-secondary">
              {s.label}
            </div>{" "}
            <div
              style={{
                color: s.color,
              }}
              className="text-[28px] font-medium"
            >
              {s.count}
            </div>{" "}
          </UiCard>
        ))}
      </div>
      {/* Re-run + last run info */}
      <div className="flex justify-between items-center">
        {" "}
        <div className="text-ui-body text-ink-secondary">
          Last audit:{" "}
          {run.run_date ? new Date(run.run_date).toLocaleString() : "N/A"}
        </div>{" "}
        {canRunSeoActions && (
          <Button onClick={runAudit} disabled={running}>
            {running ? "Running..." : "Re-run Audit"}
          </Button>
        )}{" "}
      </div>
      {/* Top Issues Summary */}
      {issues.length > 0 && (
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Top Issues
          </div>{" "}
          <div className="flex flex-col [gap:8px]">
            {issues.slice(0, 15).map((iss, i) => (
              <div
                key={i}
                className="flex items-center [gap:10px] [padding:8px_12px] bg-zinc-100 rounded-md border-hairline border-zinc-200"
              >
                {" "}
                <span
                  style={{
                    background: severityColor[iss.severity] || "#71717A",
                  }}
                  className="[width:8px] [height:8px] rounded-xs shrink-0"
                />{" "}
                <div className="[flex:1] [min-width:0px]">
                  {" "}
                  <div className="text-ui-body text-zinc-900 font-medium">
                    {iss.issue_type?.replace(/_/g, " ")}
                  </div>
                  {iss.details && (
                    <div className="text-ui-body text-ink-secondary [margin-top:2px] overflow-hidden text-ellipsis whitespace-nowrap">
                      {iss.details}
                    </div>
                  )}
                </div>{" "}
                <div
                  style={{
                    color: severityColor[iss.severity] || "#71717A",
                  }}
                  className="text-ui-body font-medium shrink-0"
                >
                  {iss.affected_count} page{iss.affected_count !== 1 ? "s" : ""}
                </div>{" "}
              </div>
            ))}
          </div>{" "}
        </UiCard>
      )}

      {/* Page-by-Page Breakdown */}
      <UiCard className="p-6">
        {" "}
        <div className="flex justify-between items-center [margin-bottom:12px]">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900">
            Pages {filter !== "all" ? `(${filter})` : ""} —{" "}
            {filteredPages.length}
          </div>
          {filter !== "all" && (
            <Button
              onClick={() => setFilter("all")}
              className="[background:none]"
            >
              Show all
            </Button>
          )}
        </div>{" "}
        <div className="flex flex-col [gap:6px]">
          {filteredPages.slice(0, 50).map((p, i) => {
            const status = getPageStatus(p);
            const pageIssues = parseAuditIssues(p.issues);
            const isExpanded = expandedPage === i;
            return (
              <div key={i}>
                {" "}
                <div
                  onClick={() => setExpandedPage(isExpanded ? null : i)}
                  className="flex items-center [gap:10px] [padding:10px_12px] bg-zinc-100 rounded-md cursor-pointer border-hairline border-zinc-200"
                >
                  {/* Score circle */}
                  <div
                    style={{
                      border: `3px solid ${scoreColor(p.technical_health_score || 0)}`,
                      color: scoreColor(p.technical_health_score || 0),
                    }}
                    className="[width:36px] [height:36px] rounded-xs shrink-0 flex items-center justify-center text-ui-body font-medium"
                  >
                    {Math.round(p.technical_health_score || 0)}
                  </div>
                  {/* URL + meta */}
                  <div className="[flex:1] [min-width:0px]">
                    {" "}
                    <div className="text-ui-body text-zinc-900 font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                      {shortUrl(p.url)}
                    </div>{" "}
                    <div className="text-ui-body text-ink-secondary [margin-top:2px]">
                      {p.status_code && (
                        <span className="[margin-right:8px]">
                          {p.status_code}
                        </span>
                      )}
                      {p.response_time_ms != null && (
                        <span className="[margin-right:8px]">
                          {p.response_time_ms}ms
                        </span>
                      )}
                      {p.word_count != null && (
                        <span>{p.word_count} words</span>
                      )}
                    </div>{" "}
                  </div>
                  {/* Issue counts */}
                  <div className="flex [gap:6px] shrink-0">
                    {p.issue_count_critical > 0 && (
                      <span
                        style={{
                          background: "#991B1B" + "18",
                        }}
                        className="text-ui-body font-medium text-alert-fg [padding:2px_6px] rounded-sm"
                      >
                        {p.issue_count_critical} critical
                      </span>
                    )}
                    {p.issue_count_warning > 0 && (
                      <span
                        style={{
                          background: "#A16207" + "18",
                        }}
                        className="text-ui-body font-medium text-zinc-700 [padding:2px_6px] rounded-sm"
                      >
                        {p.issue_count_warning} warning
                      </span>
                    )}
                    {status === "healthy" && (
                      <span
                        style={{
                          background: "#15803D" + "18",
                        }}
                        className="text-ui-body font-medium text-zinc-900 [padding:2px_6px] rounded-sm"
                      >
                        OK
                      </span>
                    )}
                  </div>{" "}
                  <span className="text-ui-body text-ink-secondary shrink-0">
                    {isExpanded ? "▲" : "▼"}
                  </span>{" "}
                </div>
                {/* Expanded details */}
                {isExpanded && (
                  <div
                    style={{
                      marginTop: -2,
                    }}
                    className="[padding:12px_16px] bg-zinc-100 rounded-xs border-t border-hairline border-zinc-200 [border-top-color:transparent] border-hairline border-zinc-200"
                  >
                    {/* Meta info */}
                    <div className="seo-audit-expanded-grid grid max-sm:!grid-cols-1 [grid-template-columns:1fr_1fr] [gap:8px] [margin-bottom:12px]">
                      {p.meta_title && (
                        <div>
                          <div className="text-ui-body text-ink-secondary">
                            Title ({p.meta_title_length} chars)
                          </div>
                          <div className="text-ui-body text-zinc-900 [margin-top:2px]">
                            {p.meta_title}
                          </div>
                        </div>
                      )}
                      {p.meta_description && (
                        <div>
                          <div className="text-ui-body text-ink-secondary">
                            Description ({p.meta_description_length} chars)
                          </div>
                          <div className="text-ui-body text-zinc-900 [margin-top:2px]">
                            {p.meta_description?.substring(0, 160)}
                          </div>
                        </div>
                      )}
                      {p.h1_text && (
                        <div>
                          <div className="text-ui-body text-ink-secondary">
                            H1 (count: {p.h1_count})
                          </div>
                          <div className="text-ui-body text-zinc-900 [margin-top:2px]">
                            {p.h1_text}
                          </div>
                        </div>
                      )}
                      <div>
                        {" "}
                        <div className="text-ui-body text-ink-secondary">
                          Structure
                        </div>{" "}
                        <div className="text-ui-body text-zinc-900 [margin-top:2px]">
                          H2s: {p.h2_count || 0} | Links:{" "}
                          {p.internal_links_count || 0} int /{" "}
                          {p.external_links_count || 0} ext | Images:{" "}
                          {p.total_images || 0} ({p.images_missing_alt || 0} no
                          alt)
                        </div>{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        <div className="text-ui-body text-ink-secondary">
                          Schema
                        </div>{" "}
                        <div className="text-ui-body text-zinc-900 [margin-top:2px]">
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
                            <span className="text-zinc-900 [margin-left:6px]">
                              FAQ
                            </span>
                          )}
                          {p.has_local_business_schema && (
                            <span className="text-zinc-900 [margin-left:6px]">
                              LocalBusiness
                            </span>
                          )}
                        </div>{" "}
                      </div>
                      {p.canonical_url && (
                        <div>
                          <div className="text-ui-body text-ink-secondary">
                            Canonical
                          </div>
                          <div
                            style={{
                              color: p.canonical_mismatch
                                ? "#991B1B"
                                : "#15803D",
                            }}
                            className="text-ui-body [margin-top:2px]"
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
                        <div className="text-ui-body font-medium text-ink-secondary [margin-bottom:6px]">
                          Issues
                        </div>
                        {pageIssues.map((iss, j) => (
                          <div
                            key={j}
                            style={{
                              borderBottom:
                                j < pageIssues.length - 1
                                  ? "1px solid #E4E4E7"
                                  : "none",
                            }}
                            className="flex items-start [gap:8px] [padding:6px_0]"
                          >
                            {" "}
                            <span
                              style={{
                                background:
                                  severityColor[iss.severity] || "#71717A",
                              }}
                              className="[width:6px] [height:6px] rounded-xs [margin-top:5px] shrink-0"
                            />{" "}
                            <div>
                              {" "}
                              <div className="text-ui-body text-zinc-900">
                                {iss.message || iss.type?.replace(/_/g, " ")}
                              </div>
                              {iss.details && (
                                <div className="text-ui-body text-ink-secondary [margin-top:1px]">
                                  {iss.details}
                                </div>
                              )}
                            </div>{" "}
                          </div>
                        ))}
                      </div>
                    )}
                    {pageIssues.length === 0 && (
                      <div className="text-ui-body text-zinc-900">
                        No issues found — page is healthy
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>{" "}
      </UiCard>
      {/* Audit History */}
      {history.length > 1 && (
        <UiCard className="p-6">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
            Audit History
          </div>{" "}
          <div
            className="seo-audit-history-grid grid max-sm:!grid-cols-3 [gap:8px]"
            style={{
              gridTemplateColumns: `repeat(${Math.min(history.length, 6)}, 1fr)`,
            }}
          >
            {history.slice(0, 6).map((h, i) => (
              <div
                key={i}
                style={{
                  border: i === 0 ? "2px solid #18181B" : "1px solid #E4E4E7",
                }}
                className="text-center [padding:12px] bg-zinc-100 rounded-md"
              >
                {" "}
                <div className="text-ui-body text-ink-secondary">
                  {new Date(h.date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </div>{" "}
                <div
                  style={{
                    color: scoreColor(h.score),
                  }}
                  className="text-[22px] font-medium"
                >
                  {Math.round(h.score)}
                </div>{" "}
                <div className="text-ui-body text-ink-secondary">
                  {h.pages} pages
                </div>
                {h.critical > 0 && (
                  <div className="text-ui-body text-alert-fg">
                    {h.critical} critical
                  </div>
                )}
              </div>
            ))}
          </div>{" "}
        </UiCard>
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
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading URL Intelligence...
      </div>
    );
  if (!data)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        No data — run a refresh to populate.
      </div>
    );
  const subTabs = [
    {
      key: "overview",
      label: "Overview",
    },
    {
      key: "diagnosis",
      label: "By Diagnosis",
    },
    {
      key: "priority",
      label: "Priority Queue",
    },
    {
      key: "duplicates",
      label: "Duplicates",
    },
    {
      key: "intent",
      label: "Intent Routing",
    },
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
    healthy: "#15803D",
    needs_technical_fix: "#991B1B",
    needs_canonical_fix: "#A16207",
    needs_content_refresh: "#A16207",
    needs_indexation_fix: "#991B1B",
    low_priority: "#71717A",
    review_required: "#A16207",
    unknown: "#71717A",
  };
  return (
    <div className="[padding:24px] flex flex-col [gap:20px]">
      <div className="seo-sub-tabs flex max-sm:flex-nowrap max-sm:overflow-x-auto [gap:8px] items-center flex-wrap">
        {subTabs.map((st) => (
          <Button
            key={st.key}
            onClick={() => {
              setSubTab(st.key);
              setScanPage(0);
            }}
            variant={subTab === st.key ? "primary" : "secondary"}
          >
            {st.label}
          </Button>
        ))}
        {canRefresh && (
          <Button onClick={handleRefresh} className="[margin-left:auto]">
            Refresh Domain
          </Button>
        )}
      </div>

      {subTab === "overview" && (
        <>
          <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:16px]">
            <KpiCard label="Total URLs" value={fmt(data.total_urls)} />
            <KpiCard
              label="Healthy"
              value={`${data.by_status.find((s) => s.status === "healthy")?.count || 0}`}
              color={"#15803D"}
            />
            <KpiCard
              label="Needs Fix"
              value={`${data.total_urls - (data.by_status.find((s) => s.status === "healthy")?.count || 0) - (data.by_status.find((s) => s.status === "unknown")?.count || 0)}`}
              color={"#991B1B"}
            />
            <KpiCard
              label="Indexation Gap"
              value={`${data.indexation_gap?.gap_pct || 0}%`}
              color={data.indexation_gap?.gap_pct > 20 ? "#991B1B" : "#15803D"}
            />
          </div>

          <UiCard className="p-6">
            <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
              Diagnosis Breakdown
            </div>
            <div className="grid [grid-template-columns:repeat(auto-fill,_minmax(180px,_1fr))] [gap:10px]">
              {data.by_diagnosis
                .filter((d) => d.count > 0)
                .map((d) => (
                  <div
                    key={d.diagnosis}
                    onClick={() => {
                      setSubTab("diagnosis");
                      setDiagnosisFilter(d.diagnosis);
                      setScanPage(0);
                    }}
                    className="[padding:12px] rounded-md cursor-pointer flex justify-between items-center border-hairline border-zinc-200"
                  >
                    <span className="text-ui-body text-zinc-900">
                      {diagnosisLabels[d.diagnosis] || d.diagnosis}
                    </span>
                    <span className="text-ui-body font-medium text-zinc-900">
                      {d.count}
                    </span>
                  </div>
                ))}
            </div>
          </UiCard>

          {data.top_issues?.length > 0 && (
            <UiCard className="p-6">
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
                Top Priority Issues
              </div>
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>URL</TH>
                      <TH>Diagnosis</TH>
                      <TH className="text-right u-nums">Priority</TH>
                      <TH>Action</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data.top_issues.map((row) => (
                      <TR key={row.id}>
                        <TD className="[max-width:300px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.url}
                        </TD>
                        <TD className="u-nums">
                          <span
                            style={{
                              background: statusColors[row.primary_status]
                                ? `${statusColors[row.primary_status]}18`
                                : "#71717A18",
                              color:
                                statusColors[row.primary_status] || "#71717A",
                            }}
                            className="[padding:2px_8px] rounded-sm text-ui-body font-medium"
                          >
                            {diagnosisLabels[row.primary_diagnosis] ||
                              row.primary_diagnosis}
                          </span>
                        </TD>
                        <TD className="text-right u-nums">
                          {row.priority_score}
                        </TD>
                        <TD className="text-ui-body [max-width:300px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.recommended_action}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </UiCard>
          )}

          {data.canonical_conflicts > 0 && (
            <UiCard className="p-6 border-l border-hairline border-zinc-200">
              <div className="text-ui-body text-zinc-700 font-medium">
                {data.canonical_conflicts} canonical conflict
                {data.canonical_conflicts > 1 ? "s" : ""} detected
              </div>
              <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                Switch to the Indexation tab → Canonical Conflicts to review.
              </div>
            </UiCard>
          )}
        </>
      )}

      {(subTab === "diagnosis" || subTab === "priority") && (
        <UiCard className="p-6">
          {subTab === "diagnosis" && (
            <div className="[margin-bottom:16px] flex [gap:8px] items-center">
              <span className="text-ui-body text-ink-secondary">Filter:</span>
              <Select
                className="!w-auto"
                value={diagnosisFilter}
                onChange={(e) => {
                  setDiagnosisFilter(e.target.value);
                  setScanPage(0);
                }}
              >
                <option value="">All</option>
                {Object.entries(diagnosisLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {subTab === "priority" && (
            <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
              Priority Queue — highest impact first
            </div>
          )}

          {scanData?.urls?.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>URL</TH>
                      <TH>Status</TH>
                      <TH>Diagnosis</TH>
                      <TH className="text-right u-nums">Priority</TH>
                      <TH className="text-right u-nums">Clicks 28d</TH>
                      <TH className="text-right u-nums">Position</TH>
                      {subTab === "priority" && <TH>Recommended Action</TH>}
                    </TR>
                  </THead>
                  <TBody>
                    {scanData.urls.map((row) => (
                      <TR key={row.id}>
                        <TD className="[max-width:260px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.url}
                        </TD>
                        <TD className="u-nums">
                          <span
                            style={{
                              background: statusColors[row.primary_status]
                                ? `${statusColors[row.primary_status]}18`
                                : "#71717A18",
                              color:
                                statusColors[row.primary_status] || "#71717A",
                            }}
                            className="[padding:2px_8px] rounded-sm text-ui-body"
                          >
                            {row.primary_status}
                          </span>
                        </TD>
                        <TD className="u-nums">
                          {diagnosisLabels[row.primary_diagnosis] ||
                            row.primary_diagnosis}
                        </TD>
                        <TD className="text-right u-nums">
                          {row.priority_score}
                        </TD>
                        <TD className="text-right u-nums">
                          {fmt(row.gsc_clicks_28d)}
                        </TD>
                        <TD className="text-right u-nums">
                          {row.gsc_avg_position_28d
                            ? parseFloat(row.gsc_avg_position_28d).toFixed(1)
                            : "—"}
                        </TD>
                        {subTab === "priority" && (
                          <TD className="text-ui-body [max-width:260px] overflow-hidden text-ellipsis whitespace-nowrap">
                            {row.recommended_action}
                          </TD>
                        )}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <div className="flex [gap:8px] [margin-top:16px] items-center">
                <Button
                  disabled={scanPage === 0}
                  onClick={() => setScanPage((p) => Math.max(0, p - 1))}
                  variant="secondary"
                >
                  Prev
                </Button>
                <span className="text-ui-body text-ink-secondary">
                  {scanPage * 25 + 1}–
                  {Math.min((scanPage + 1) * 25, scanData.total)} of{" "}
                  {scanData.total}
                </span>
                <Button
                  disabled={(scanPage + 1) * 25 >= scanData.total}
                  onClick={() => setScanPage((p) => p + 1)}
                  variant="secondary"
                >
                  Next
                </Button>
              </div>
            </>
          ) : (
            <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
              {scanData ? "No URLs match the current filter." : "Loading..."}
            </div>
          )}
        </UiCard>
      )}

      {subTab === "duplicates" && <DuplicatesSubTab domain={domain} />}

      {subTab === "intent" && <IntentSubTab domain={domain} />}
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
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading...
      </div>
    );
  return (
    <UiCard className="p-6">
      <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
        Duplicate Content Clusters — body similarity &gt; 80%
      </div>
      {data && data.length > 0 ? (
        <div className="overflow-x-auto">
          <Table className="[width:100%] [border-collapse:collapse]">
            <THead>
              <TR>
                <TH>URL</TH>
                <TH>Domain</TH>
                <TH className="text-right u-nums">Similarity</TH>
                <TH>City</TH>
                <TH>Service</TH>
                <TH>Page Type</TH>
              </TR>
            </THead>
            <TBody>
              {data.map((row) => (
                <TR key={row.id}>
                  <TD className="[max-width:280px] overflow-hidden text-ellipsis whitespace-nowrap">
                    {row.url}
                  </TD>
                  <TD className="u-nums">{row.domain}</TD>
                  <TD className="text-right u-nums">
                    {row.body_similarity_max != null
                      ? `${row.body_similarity_max}%`
                      : "—"}
                  </TD>
                  <TD className="u-nums">{row.city || "—"}</TD>
                  <TD className="u-nums">{row.service || "—"}</TD>
                  <TD className="u-nums">{row.page_type || "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : (
        <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
          No duplicate clusters detected. Run duplicate detection to populate.
        </div>
      )}
    </UiCard>
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
  const severityColors = {
    severe: "#991B1B",
    moderate: "#A16207",
    mild: "#71717A",
    none: "#15803D",
  };
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading...
      </div>
    );
  return (
    <UiCard className="p-6">
      <div className="flex justify-between items-center [margin-bottom:16px]">
        <div className="text-ui-body font-medium text-zinc-900">
          Intent Routing — Query → Page Alignment
        </div>
        <Select
          className="!w-auto"
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
        >
          <option value="">All</option>
          <option value="severe">Severe</option>
          <option value="moderate">Moderate</option>
          <option value="mild">Mild</option>
        </Select>
      </div>
      {data && data.length > 0 ? (
        <div className="overflow-x-auto">
          <Table className="[width:100%] [border-collapse:collapse]">
            <THead>
              <TR>
                <TH>Query Cluster</TH>
                <TH>Intent</TH>
                <TH>Expected</TH>
                <TH>Actual Winner</TH>
                <TH>Misroute</TH>
                <TH>Severity</TH>
                <TH className="text-right u-nums">Impressions</TH>
              </TR>
            </THead>
            <TBody>
              {data.map((row) => (
                <TR key={row.id}>
                  <TD className="[max-width:200px] overflow-hidden text-ellipsis whitespace-nowrap">
                    {row.query_cluster}
                  </TD>
                  <TD className="u-nums">{row.intent_type}</TD>
                  <TD className="u-nums">{row.expected_page_type}</TD>
                  <TD className="[max-width:200px] overflow-hidden text-ellipsis whitespace-nowrap">
                    {row.actual_winner_url}
                  </TD>
                  <TD className="u-nums">{row.misroute_type}</TD>
                  <TD className="u-nums">
                    {row.misroute_severity &&
                      row.misroute_severity !== "none" && (
                        <span
                          style={{
                            background: `${severityColors[row.misroute_severity] || "#71717A"}18`,
                            color:
                              severityColors[row.misroute_severity] ||
                              "#71717A",
                          }}
                          className="[padding:2px_8px] rounded-sm text-ui-body"
                        >
                          {row.misroute_severity}
                        </span>
                      )}
                  </TD>
                  <TD className="text-right u-nums">
                    {fmt(row.impressions_total)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      ) : (
        <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
          No intent routes found. Run intent map builder to populate.
        </div>
      )}
    </UiCard>
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
    {
      key: "queue",
      label: "Queue",
    },
    {
      key: "drafts",
      label: "AI Drafts",
    },
    {
      key: "progress",
      label: "In Progress",
    },
    {
      key: "experiments",
      label: "Experiments",
    },
  ];
  const tierColors = {
    auto: "#15803D",
    editor: "#71717A",
    seo: "#A16207",
    owner: "#991B1B",
  };
  return (
    <div className="[padding:24px] flex flex-col [gap:20px]">
      <div className="seo-sub-tabs flex max-sm:flex-nowrap max-sm:overflow-x-auto [gap:8px] items-center flex-wrap">
        {subTabs.map((st) => (
          <Button
            key={st.key}
            onClick={() => setSubTab(st.key)}
            variant={subTab === st.key ? "primary" : "secondary"}
          >
            {st.label}
          </Button>
        ))}
        {canAdmin && subTab === "queue" && (
          <div className="[margin-left:auto] flex [gap:8px]">
            <Button
              onClick={() =>
                adminPost("/admin/seo/actions/generate", { domain }).then(loadData)
              }
            >
              Generate Actions
            </Button>
            <Button
              onClick={() =>
                adminPost("/admin/seo/actions/auto-approve", { domain }).then(loadData)
              }
              variant="secondary"
            >
              Auto-Approve
            </Button>
          </div>
        )}
        {canAdmin && subTab === "drafts" && (
          <Button
            onClick={() =>
              adminPost("/admin/seo/actions/generate-drafts", {}).then(loadData)
            }
            className="[margin-left:auto]"
          >
            Generate Drafts
          </Button>
        )}
      </div>

      {summary && (
        <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:16px]">
          <KpiCard
            label="Pending Auto"
            value={fmt(summary.pending_by_tier?.auto || 0)}
            color={"#15803D"}
          />
          <KpiCard
            label="Pending Editor"
            value={fmt(summary.pending_by_tier?.editor || 0)}
          />
          <KpiCard
            label="Pending SEO"
            value={fmt(summary.pending_by_tier?.seo || 0)}
            color={"#A16207"}
          />
          <KpiCard label="Done" value={fmt(summary.done)} color={"#15803D"} />
        </div>
      )}

      {loading ? (
        <div className="text-ink-secondary [padding:40px] text-center">
          Loading...
        </div>
      ) : (
        <UiCard className="p-6">
          {subTab === "queue" && (
            <>
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
                Pending Actions — by priority
              </div>
              {actions.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table className="[width:100%] [border-collapse:collapse]">
                    <THead>
                      <TR>
                        <TH>URL</TH>
                        <TH>Issue</TH>
                        <TH>Action</TH>
                        <TH className="text-right u-nums">Priority</TH>
                        <TH>Tier</TH>
                        {canAdmin && <TH>Actions</TH>}
                      </TR>
                    </THead>
                    <TBody>
                      {actions.map((a) => (
                        <TR key={a.id}>
                          <TD className="[max-width:240px] overflow-hidden text-ellipsis whitespace-nowrap">
                            {a.url}
                          </TD>
                          <TD className="u-nums">{a.issue_type}</TD>
                          <TD className="u-nums">
                            {a.action_type.replace(/_/g, " ")}
                          </TD>
                          <TD className="text-right u-nums">
                            {a.priority_score}
                          </TD>
                          <TD className="u-nums">
                            <span
                              style={{
                                background: `${tierColors[a.approval_tier] || "#71717A"}18`,
                                color: tierColors[a.approval_tier] || "#71717A",
                              }}
                              className="[padding:2px_8px] rounded-sm text-ui-body"
                            >
                              {a.approval_tier}
                            </span>
                          </TD>
                          {canAdmin && (
                            <TD className="u-nums">
                              <div className="flex [gap:4px]">
                                <Button
                                  onClick={() => handleAction(a.id, "approve")}
                                  className="[background:#15803D18]"
                                >
                                  Approve
                                </Button>
                                <Button
                                  onClick={() => handleAction(a.id, "reject")}
                                  className="text-alert-fg"
                                  variant="secondary"
                                >
                                  Reject
                                </Button>
                              </div>
                            </TD>
                          )}
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
                  No pending actions. Run the pipeline to generate.
                </div>
              )}
            </>
          )}

          {subTab === "drafts" && (
            <>
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
                AI Title/Meta Drafts
              </div>
              {actions.filter((a) => a.ai_draft).length > 0 ? (
                <div className="flex flex-col [gap:16px]">
                  {actions
                    .filter((a) => a.ai_draft)
                    .map((a) => {
                      let draft = {};
                      try {
                        draft =
                          typeof a.ai_draft === "string"
                            ? JSON.parse(a.ai_draft)
                            : a.ai_draft || {};
                      } catch {}
                      let detail = {};
                      try {
                        detail =
                          typeof a.detail === "string"
                            ? JSON.parse(a.detail)
                            : a.detail || {};
                      } catch {}
                      return (
                        <div
                          key={a.id}
                          className="rounded-md [padding:16px] border-hairline border-zinc-200"
                        >
                          <div className="text-ui-body text-ink-secondary [margin-bottom:8px]">
                            {a.url}
                          </div>
                          <div className="grid [grid-template-columns:1fr_1fr] [gap:16px]">
                            <div>
                              <div className="text-ui-body text-ink-secondary font-medium [margin-bottom:4px]">
                                Current
                              </div>
                              <div className="text-ui-body text-zinc-900">
                                {detail.current_title || "—"}
                              </div>
                              <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                                {detail.current_meta || "—"}
                              </div>
                            </div>
                            <div>
                              <div className="text-ui-body text-zinc-900 font-medium [margin-bottom:4px]">
                                Proposed
                              </div>
                              <div className="text-ui-body text-zinc-900 font-medium">
                                {draft.title || "—"}
                              </div>
                              <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                                {draft.meta_description || "—"}
                              </div>
                            </div>
                          </div>
                          {draft.reasoning && (
                            <div className="text-ui-body text-ink-secondary [margin-top:8px] [font-style:italic]">
                              {draft.reasoning}
                            </div>
                          )}
                          {canAdmin && (
                            <div className="flex [gap:8px] [margin-top:12px]">
                              <Button
                                onClick={() => handleAction(a.id, "approve")}
                              >
                                Approve
                              </Button>
                              <Button
                                onClick={() => handleAction(a.id, "reject")}
                                className="text-alert-fg"
                                variant="secondary"
                              >
                                Reject
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
                  No AI drafts yet. Click "Generate Drafts" to create title/meta
                  suggestions.
                </div>
              )}
            </>
          )}

          {subTab === "progress" && (
            <>
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
                Execution Status
              </div>
              {actions.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table className="[width:100%] [border-collapse:collapse]">
                    <THead>
                      <TR>
                        <TH>URL</TH>
                        <TH>Action</TH>
                        <TH>Status</TH>
                        <TH>Executor</TH>
                        <TH>Completed</TH>
                        <TH>Notes</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {actions.map((a) => (
                        <TR key={a.id}>
                          <TD className="[max-width:240px] overflow-hidden text-ellipsis whitespace-nowrap">
                            {a.url}
                          </TD>
                          <TD className="u-nums">
                            {a.action_type.replace(/_/g, " ")}
                          </TD>
                          <TD className="u-nums">
                            <span
                              style={{
                                background:
                                  a.execution_status === "done"
                                    ? "#15803D18"
                                    : "#A1620718",
                                color:
                                  a.execution_status === "done"
                                    ? "#15803D"
                                    : "#A16207",
                              }}
                              className="[padding:2px_8px] rounded-sm text-ui-body"
                            >
                              {a.execution_status}
                            </span>
                          </TD>
                          <TD className="u-nums">{a.executor || "—"}</TD>
                          <TD className="u-nums">
                            {a.completed_at
                              ? new Date(a.completed_at).toLocaleDateString()
                              : "—"}
                          </TD>
                          <TD className="text-ui-body [max-width:200px] overflow-hidden text-ellipsis whitespace-nowrap">
                            {a.execution_notes || "—"}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
                  No actions in progress.
                </div>
              )}
            </>
          )}

          {subTab === "experiments" && (
            <>
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
                SEO Experiments
              </div>
              {actions.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table className="[width:100%] [border-collapse:collapse]">
                    <THead>
                      <TR>
                        <TH>URL</TH>
                        <TH>Action</TH>
                        <TH>Published</TH>
                        <TH className="text-right u-nums">Pre Clicks</TH>
                        <TH className="text-right u-nums">Post Clicks</TH>
                        <TH className="text-right u-nums">Pre Pos</TH>
                        <TH className="text-right u-nums">Post Pos</TH>
                        <TH>Status</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {actions.map((e) => (
                        <TR key={e.id}>
                          <TD className="[max-width:240px] overflow-hidden text-ellipsis whitespace-nowrap">
                            {e.url}
                          </TD>
                          <TD className="u-nums">
                            {e.action_type.replace(/_/g, " ")}
                          </TD>
                          <TD className="u-nums">{e.publish_date || "—"}</TD>
                          <TD className="text-right u-nums">
                            {fmt(e.pre_28d_clicks)}
                          </TD>
                          <TD className="text-right u-nums">
                            {e.post_28d_clicks != null
                              ? fmt(e.post_28d_clicks)
                              : "—"}
                          </TD>
                          <TD className="text-right u-nums">
                            {e.pre_28d_position
                              ? parseFloat(e.pre_28d_position).toFixed(1)
                              : "—"}
                          </TD>
                          <TD className="text-right u-nums">
                            {e.post_28d_position
                              ? parseFloat(e.post_28d_position).toFixed(1)
                              : "—"}
                          </TD>
                          <TD className="u-nums">
                            <span
                              style={{
                                background:
                                  e.status === "accepted"
                                    ? "#15803D18"
                                    : e.status === "rejected"
                                      ? "#991B1B18"
                                      : "#A1620718",
                                color:
                                  e.status === "accepted"
                                    ? "#15803D"
                                    : e.status === "rejected"
                                      ? "#991B1B"
                                      : "#A16207",
                              }}
                              className="[padding:2px_8px] rounded-sm text-ui-body"
                            >
                              {e.status}
                            </span>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
                  No experiments yet. Complete actions to create experiments.
                </div>
              )}
            </>
          )}
        </UiCard>
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
      .catch(() =>
        setInspectData({
          _error: true,
        }),
      )
      .finally(() => setInspectLoading(false));
  }
  const subTabs = [
    {
      key: "gap",
      label: "Indexation Gap",
    },
    {
      key: "conflicts",
      label: "Canonical Conflicts",
    },
    {
      key: "crawled",
      label: "Not Indexed",
    },
    {
      key: "sitemap",
      label: "Sitemap Issues",
    },
    {
      key: "inspector",
      label: "URL Inspector",
    },
  ];
  return (
    <div className="[padding:24px] flex flex-col [gap:20px]">
      <div className="seo-sub-tabs flex max-sm:flex-nowrap max-sm:overflow-x-auto [gap:8px] flex-wrap">
        {subTabs.map((st) => (
          <Button
            key={st.key}
            onClick={() => setSubTab(st.key)}
            variant={subTab === st.key ? "primary" : "secondary"}
          >
            {st.label}
          </Button>
        ))}
      </div>

      {subTab === "gap" &&
        (loading ? (
          <div className="text-ink-secondary [padding:40px] text-center">
            Loading...
          </div>
        ) : (
          gapData && (
            <UiCard className="p-6">
              <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:20px]">
                Indexation Gap — {gapData.domain}
              </div>
              <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:16px] [margin-bottom:24px]">
                <KpiCard label="Submitted" value={fmt(gapData.submitted)} />
                <KpiCard
                  label="Indexed"
                  value={fmt(gapData.indexed)}
                  color={"#15803D"}
                />
                <KpiCard
                  label="Gap"
                  value={fmt(gapData.gap)}
                  color={gapData.gap > 0 ? "#991B1B" : "#15803D"}
                />
                <KpiCard
                  label="Gap %"
                  value={`${gapData.gap_pct}%`}
                  color={
                    gapData.gap_pct > 20
                      ? "#991B1B"
                      : gapData.gap_pct > 10
                        ? "#A16207"
                        : "#15803D"
                  }
                />
              </div>

              {gapData.gap_pct > 20 && (
                <div className="[padding:12px] rounded-md [margin-bottom:16px] bg-alert-bg border-hairline border-zinc-200">
                  <span className="text-ui-body text-alert-fg font-medium">
                    Indexation gap above 20% — indicates quality, duplication,
                    or crawl-budget issues.
                  </span>
                </div>
              )}

              {gapData.by_coverage_state?.length > 0 && (
                <>
                  <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:12px]">
                    By Coverage State
                  </div>
                  <Table className="[width:100%] [border-collapse:collapse]">
                    <THead>
                      <TR>
                        <TH>Coverage State</TH>
                        <TH className="text-right u-nums">Count</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {gapData.by_coverage_state.map((row) => (
                        <TR key={row.coverage_state}>
                          <TD className="u-nums">{row.coverage_state}</TD>
                          <TD className="text-right u-nums">{row.count}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </>
              )}
            </UiCard>
          )
        ))}

      {subTab === "conflicts" &&
        (loading ? (
          <div className="text-ink-secondary [padding:40px] text-center">
            Loading...
          </div>
        ) : (
          <UiCard className="p-6">
            <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
              Canonical Conflicts — Hub / Spoke
            </div>
            {conflictsData?.length > 0 ? (
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>Spoke URL</TH>
                      <TH>Hub URL</TH>
                      <TH className="text-right u-nums">Body Sim %</TH>
                      <TH>Google Canonical</TH>
                      <TH>Status</TH>
                      <TH>Fix</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {conflictsData.map((row) => (
                      <TR key={row.id}>
                        <TD className="[max-width:200px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.spoke_url}
                        </TD>
                        <TD className="[max-width:200px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.hub_url}
                        </TD>
                        <TD className="text-right u-nums">
                          {row.body_similarity_pct != null
                            ? `${row.body_similarity_pct}%`
                            : "—"}
                        </TD>
                        <TD className="[max-width:200px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.google_selected_canonical || "—"}
                        </TD>
                        <TD className="u-nums">
                          <span
                            style={{
                              background:
                                row.status === "open"
                                  ? "#A1620718"
                                  : "#15803D18",
                              color:
                                row.status === "open" ? "#A16207" : "#15803D",
                            }}
                            className="[padding:2px_8px] rounded-sm text-ui-body"
                          >
                            {row.status}
                          </span>
                        </TD>
                        <TD className="text-ui-body [max-width:240px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.recommended_fix}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : (
              <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
                No canonical conflicts detected. Run a refresh + conflict
                detection to populate.
              </div>
            )}
          </UiCard>
        ))}

      {subTab === "crawled" &&
        (loading ? (
          <div className="text-ink-secondary [padding:40px] text-center">
            Loading...
          </div>
        ) : (
          <UiCard className="p-6">
            <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
              Not Indexed — Priority URLs
            </div>
            {crawledNotIndexed?.urls?.length > 0 ? (
              <div className="overflow-x-auto">
                <Table className="[width:100%] [border-collapse:collapse]">
                  <THead>
                    <TR>
                      <TH>URL</TH>
                      <TH>Coverage State</TH>
                      <TH className="text-right u-nums">Priority</TH>
                      <TH>In Sitemap</TH>
                      <TH>Action</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {crawledNotIndexed.urls.map((row) => (
                      <TR key={row.id}>
                        <TD className="[max-width:280px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.url}
                        </TD>
                        <TD className="u-nums">{row.coverage_state || "—"}</TD>
                        <TD className="text-right u-nums">
                          {row.priority_score}
                        </TD>
                        <TD className="u-nums">
                          {row.in_sitemap ? "Yes" : "No"}
                        </TD>
                        <TD className="text-ui-body [max-width:240px] overflow-hidden text-ellipsis whitespace-nowrap">
                          {row.recommended_action}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : (
              <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
                No indexation problems found — or data not yet populated.
              </div>
            )}
          </UiCard>
        ))}

      {subTab === "sitemap" && <SitemapIssuesSubTab domain={domain} />}

      {subTab === "inspector" && (
        <UiCard className="p-6">
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
            URL Inspector
          </div>
          <div className="flex [gap:8px] [margin-bottom:20px]">
            <Input
              type="text"
              value={inspectUrl}
              onChange={(e) => setInspectUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleInspect()}
              placeholder="Enter URL to inspect..."
              className="[flex:1]"
            />
            <Button onClick={handleInspect} disabled={inspectLoading}>
              {inspectLoading ? "Inspecting..." : "Inspect"}
            </Button>
          </div>

          {inspectData && !inspectData._error && (
            <div className="flex flex-col [gap:16px]">
              {/* Status banner */}
              <div
                style={{
                  background:
                    inspectData.primary_status === "healthy"
                      ? "#15803D0A"
                      : "#A162070A",
                  border: `1px solid ${inspectData.primary_status === "healthy" ? "#15803D30" : "#A1620730"}`,
                }}
                className="[padding:16px] rounded-md"
              >
                <div className="text-ui-body font-medium text-zinc-900">
                  {inspectData.url}
                </div>
                <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                  Status: <strong>{inspectData.primary_status}</strong> ·
                  Diagnosis: <strong>{inspectData.primary_diagnosis}</strong> ·
                  Priority: <strong>{inspectData.priority_score}</strong>
                </div>
              </div>

              {/* Detail sections */}
              <div className="seo-audit-expanded-grid grid max-sm:!grid-cols-1 [grid-template-columns:1fr_1fr] [gap:16px]">
                <div className="flex flex-col [gap:8px]">
                  <div className="text-ui-body font-medium text-zinc-900">
                    Identity
                  </div>
                  {[
                    ["Domain", inspectData.domain],
                    ["Type", inspectData.hub_or_spoke],
                    ["Page Type", inspectData.page_type],
                    ["City", inspectData.city || "—"],
                    ["Service", inspectData.service || "—"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between text-ui-body">
                      <span className="text-ink-secondary">{k}</span>
                      <span className="text-zinc-900">{v}</span>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col [gap:8px]">
                  <div className="text-ui-body font-medium text-zinc-900">
                    Indexation
                  </div>
                  {[
                    ["Coverage", inspectData.coverage_state || "—"],
                    ["Indexing State", inspectData.indexing_state || "—"],
                    ["In Sitemap", inspectData.in_sitemap ? "Yes" : "No"],
                    [
                      "Canonical Match",
                      inspectData.canonical_match === true
                        ? "Yes"
                        : inspectData.canonical_match === false
                          ? "No"
                          : "—",
                    ],
                    ["Status Code", inspectData.status_code || "—"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between text-ui-body">
                      <span className="text-ink-secondary">{k}</span>
                      <span className="text-zinc-900">{v}</span>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col [gap:8px]">
                  <div className="text-ui-body font-medium text-zinc-900">
                    Performance (28d)
                  </div>
                  {[
                    ["Clicks", fmt(inspectData.gsc_clicks_28d)],
                    ["Impressions", fmt(inspectData.gsc_impressions_28d)],
                    [
                      "CTR",
                      inspectData.gsc_ctr_28d != null
                        ? `${(parseFloat(inspectData.gsc_ctr_28d) * 100).toFixed(1)}%`
                        : "—",
                    ],
                    [
                      "Avg Position",
                      inspectData.gsc_avg_position_28d
                        ? parseFloat(inspectData.gsc_avg_position_28d).toFixed(
                            1,
                          )
                        : "—",
                    ],
                    ["Backlinks", fmt(inspectData.backlinks_count)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between text-ui-body">
                      <span className="text-ink-secondary">{k}</span>
                      <span className="text-zinc-900">{v}</span>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col [gap:8px]">
                  <div className="text-ui-body font-medium text-zinc-900">
                    Scores
                  </div>
                  {[
                    ["Technical QA", inspectData.technical_qa_score ?? "—"],
                    ["Content QA", inspectData.content_qa_score ?? "—"],
                    ["Local QA", inspectData.local_qa_score ?? "—"],
                    [
                      "Word Count",
                      inspectData.word_count
                        ? fmt(inspectData.word_count)
                        : "—",
                    ],
                    ["Approval", inspectData.approval_level || "—"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between text-ui-body">
                      <span className="text-ink-secondary">{k}</span>
                      <span className="text-zinc-900">{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recommended action */}
              {inspectData.recommended_action && (
                <div className="[padding:16px] rounded-md [background:#09090B08] border-hairline border-zinc-200">
                  <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:6px]">
                    RECOMMENDED ACTION
                  </div>
                  <div className="text-ui-body text-zinc-900">
                    {inspectData.recommended_action}
                  </div>
                  {inspectData.alternative_action && (
                    <div className="text-ui-body text-ink-secondary [margin-top:6px]">
                      Alt: {inspectData.alternative_action}
                    </div>
                  )}
                </div>
              )}

              {/* Canonical detail */}
              {(inspectData.user_declared_canonical ||
                inspectData.google_selected_canonical) && (
                <div className="[padding:16px] rounded-md border-hairline border-zinc-200">
                  <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:8px]">
                    CANONICAL
                  </div>
                  <div className="text-ui-body text-ink-secondary">
                    User declared:{" "}
                    <span className="text-zinc-900">
                      {inspectData.user_declared_canonical || "—"}
                    </span>
                  </div>
                  <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                    Google selected:{" "}
                    <span className="text-zinc-900">
                      {inspectData.google_selected_canonical || "—"}
                    </span>
                  </div>
                </div>
              )}

              {/* Title / Meta */}
              <div className="[padding:16px] rounded-md border-hairline border-zinc-200">
                <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:8px]">
                  CONTENT
                </div>
                <div className="text-ui-body text-ink-secondary">
                  Title:{" "}
                  <span className="text-zinc-900">
                    {inspectData.title || "—"}
                  </span>
                </div>
                <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                  H1:{" "}
                  <span className="text-zinc-900">{inspectData.h1 || "—"}</span>
                </div>
                <div className="text-ui-body text-ink-secondary [margin-top:4px]">
                  Meta:{" "}
                  <span className="text-zinc-900">
                    {inspectData.meta_description || "—"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {inspectData?._error && (
            <div className="text-alert-fg text-ui-body [padding:20px] text-center">
              URL not found in intelligence layer. Run a domain refresh first.
            </div>
          )}
        </UiCard>
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
  if (loading)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        Loading...
      </div>
    );
  if (!data)
    return (
      <div className="text-ink-secondary [padding:40px] text-center">
        No sitemap issues data. Run validation first.
      </div>
    );
  const severityColor = {
    critical: "#991B1B",
    warning: "#A16207",
  };
  return (
    <div className="flex flex-col [gap:20px]">
      <div className="seo-kpi-grid-4 grid max-sm:!grid-cols-2 [grid-template-columns:repeat(4,_1fr)] [gap:16px]">
        <KpiCard
          label="Total Issues"
          value={fmt(data.total_issues)}
          color={data.total_issues > 0 ? "#991B1B" : "#15803D"}
        />
        <KpiCard
          label="Critical"
          value={fmt(
            data.by_severity?.find((s) => s.severity === "critical")?.count ||
              0,
          )}
          color={"#991B1B"}
        />
        <KpiCard
          label="Warning"
          value={fmt(
            data.by_severity?.find((s) => s.severity === "warning")?.count || 0,
          )}
          color={"#A16207"}
        />
        <KpiCard label="Issue Types" value={fmt(data.by_type?.length || 0)} />
      </div>

      {data.issues?.length > 0 ? (
        <UiCard className="p-6">
          <div className="text-ui-body font-medium text-zinc-900 [margin-bottom:16px]">
            Sitemap Issues — {data.domain}
          </div>
          <div className="overflow-x-auto">
            <Table className="[width:100%] [border-collapse:collapse]">
              <THead>
                <TR>
                  <TH>URL</TH>
                  <TH>Issue</TH>
                  <TH>Severity</TH>
                  <TH>Detail</TH>
                </TR>
              </THead>
              <TBody>
                {data.issues.map((row) => (
                  <TR key={row.id}>
                    <TD className="[max-width:280px] overflow-hidden text-ellipsis whitespace-nowrap">
                      {row.page_url}
                    </TD>
                    <TD className="u-nums">
                      {row.issue_type.replace(/_/g, " ")}
                    </TD>
                    <TD className="u-nums">
                      <span
                        style={{
                          background: `${severityColor[row.severity] || "#71717A"}18`,
                          color: severityColor[row.severity] || "#71717A",
                        }}
                        className="[padding:2px_8px] rounded-sm text-ui-body"
                      >
                        {row.severity}
                      </span>
                    </TD>
                    <TD className="text-ui-body [max-width:280px] overflow-hidden text-ellipsis whitespace-nowrap">
                      {row.detail}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </UiCard>
      ) : (
        <UiCard className="p-6">
          <div className="text-ink-secondary text-ui-body [padding:20px] text-center">
            No sitemap issues found.
          </div>
        </UiCard>
      )}
    </div>
  );
}

// ── Main Page ──

export default function SEOPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedWorkspace = searchParams.get("workspace");
  const workspace = Object.hasOwn(WORKSPACE_BY_KEY, requestedWorkspace)
    ? requestedWorkspace
    : "command";
  const [activeViews, setActiveViews] = useState(() =>
    Object.fromEntries(
      SEO_WORKSPACES.map((item) => [
        item.key,
        defaultViewForWorkspace(item.key),
      ]),
    ),
  );
  const activeWorkspace = WORKSPACE_BY_KEY[workspace] || SEO_WORKSPACES[0];
  const requestedView = searchParams.get("view");
  const activeView = activeWorkspace.sections.some(
    (section) => section.key === requestedView,
  )
    ? requestedView
    : defaultViewForWorkspace(workspace);

  useEffect(() => {
    setActiveViews((prev) =>
      prev[workspace] === activeView
        ? prev
        : { ...prev, [workspace]: activeView },
    );
  }, [activeView, workspace]);

  function handleWorkspaceChange(key) {
    if (!Object.hasOwn(WORKSPACE_BY_KEY, key) || key === workspace) return;
    const nextView = activeViews[key] || defaultViewForWorkspace(key);
    const next = new URLSearchParams(searchParams);
    next.set("workspace", key);
    next.set("view", nextView);
    navigate({
      pathname: location.pathname,
      search: `?${next.toString()}`,
      hash: location.hash,
    });
  }
  function handleViewChange(key) {
    if (
      key === activeView ||
      !activeWorkspace.sections.some((section) => section.key === key)
    )
      return;
    setActiveViews((prev) => ({
      ...prev,
      [workspace]: key,
    }));
    const next = new URLSearchParams(searchParams);
    next.set("workspace", workspace);
    next.set("view", key);
    navigate({
      pathname: location.pathname,
      search: `?${next.toString()}`,
      hash: location.hash,
    });
  }
  return (
    <UiSurface
      density="comfortable"
      className="seo-page mx-auto w-full max-w-[1400px] [&_a[href]]:inline-flex [&_a[href]]:min-h-11 [&_a[href]]:items-center"
    >
      {" "}
      <AdminCommandHeader
        title="SEO"
        icon={Search}
        sections={SEO_WORKSPACES}
        activeKey={workspace}
        onSectionChange={handleWorkspaceChange}
        ariaLabel="SEO section"
        navGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-6"
        secondarySections={activeWorkspace.sections}
        secondaryActiveKey={activeView}
        onSecondaryChange={handleViewChange}
        secondaryAriaLabel={`${activeWorkspace.label} SEO view`}
        secondaryNavGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
      />
      {activeView === "dashboard" && (
        <Suspense
          fallback={
            <div className="text-ink-secondary [padding:40px] text-center">
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
      {activeView === "refresh-audit" && <RefreshAuditTab />}
      {activeView === "ai-overview" && <AIOverviewTab />}
      {activeView === "funnel" && <FunnelTab />}
      {activeView === "geo-grid" && <GeoGridTab />}
      {activeView === "analytics" && <AnalyticsTab />}
      {activeView === "by-site" && <BySiteTab />}
      {activeView === "url-intel" && <UrlIntelTab domain={PRIMARY_DOMAIN} />}
      {activeView === "actions" && <ActionsTab domain={PRIMARY_DOMAIN} />}
      {activeView === "indexation" && <IndexationTab domain={PRIMARY_DOMAIN} />}
      {activeView === "site-audit" && <SiteAuditTab />}
    </UiSurface>
  );
}
