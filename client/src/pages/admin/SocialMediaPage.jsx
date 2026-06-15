import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import {
  Activity,
  BarChart3,
  CalendarDays,
  FileText,
  History,
  PenSquare,
  Rss,
  Share2,
  Sparkles,
  Star,
  TrendingUp,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
const ContentCalendar = lazy(() => import("./ContentCalendar"));

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: `teal` and `blue` fold to zinc-900; `purple` folds too.
// Semantic green/amber/red preserved for status/alert accents.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  purple: "#18181B",
  blue: "#18181B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  input: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const sCard = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
};
const sBtn = (bg, color) => ({
  padding: "8px 16px",
  background: bg,
  color,
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});
const sBadge = (bg, color) => ({
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 4,
  background: bg,
  color,
  fontWeight: 600,
  display: "inline-block",
});
const sInput = {
  width: "100%",
  padding: "10px 12px",
  background: D.input,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  color: D.text,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const PLATFORM_ICONS = { facebook: "", instagram: "", linkedin: "", gbp: "" };
const PLATFORM_COLORS = {
  facebook: D.blue,
  instagram: D.purple,
  linkedin: D.blue,
  gbp: D.green,
};
const SOCIAL_TABS = [
  { key: "campaigns", label: "Campaign Builder", Icon: Sparkles },
  { key: "audit", label: "Run Audit", Icon: Activity },
  { key: "reviews", label: "Review Graphics", Icon: Star },
  { key: "competitors", label: "Competitor Swipe", Icon: TrendingUp },
  { key: "compose", label: "Compose & Publish", Icon: PenSquare },
  { key: "rss", label: "RSS Feed", Icon: Rss },
  { key: "calendar", label: "Calendar", Icon: CalendarDays },
  { key: "analytics", label: "Analytics", Icon: BarChart3 },
  { key: "templates", label: "Templates", Icon: FileText },
  { key: "history", label: "Post History", Icon: History },
];

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.innerWidth < 640,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

function MetaHealthStrip({ health, onRefresh }) {
  const facebook = health?.credentials?.find((cred) => cred.platform === "facebook");
  const instagram = health?.credentials?.find((cred) => cred.platform === "instagram");
  if (!facebook && !instagram) return null;

  const healthy = facebook?.status === "healthy" && instagram?.status === "healthy";
  const fbDetails = facebook?.details || {};
  const igDetails = instagram?.details || {};
  const linkedIg = fbDetails.linkedInstagramUsername
    ? `@${fbDetails.linkedInstagramUsername}`
    : "No linked IG";
  const igLabel = igDetails.username ? `@${igDetails.username}` : "Instagram";
  const quotaLabel = igDetails.quotaUsage != null && Number.isFinite(Number(igDetails.quotaUsage))
    ? `Quota used: ${igDetails.quotaUsage}`
    : "Quota available";

  return (
    <div
      style={{
        ...sCard,
        marginTop: -8,
        marginBottom: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        borderLeft: `4px solid ${healthy ? D.green : D.amber}`,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: D.heading }}>
          Meta Publishing Health
        </div>
        <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
          Facebook: {fbDetails.pageName || "Page check"} · Linked IG: {linkedIg} · Instagram: {igLabel} · {quotaLabel}
        </div>
        {health?.checkedAt && (
          <div style={{ fontSize: 10, color: D.muted, marginTop: 3 }}>
            Checked {new Date(health.checkedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })}
          </div>
        )}
      </div>
      <button onClick={onRefresh} style={sBtn(D.heading, D.white)}>
        Refresh
      </button>
    </div>
  );
}

export default function SocialMediaPage() {
  const [tab, setTab] = useState("campaigns");
  const [status, setStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [rssItems, setRssItems] = useState([]);
  const [history, setHistory] = useState([]);
  const [toast, setToast] = useState("");
  const [health, setHealth] = useState(null);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [alert, setAlert] = useState(null);

  const loadData = useCallback(async () => {
    const [s, st, h, hl, al] = await Promise.all([
      adminFetch("/admin/social-media/status").catch(() => null),
      adminFetch("/admin/social-media/stats").catch(() => null),
      adminFetch("/admin/social-media/history?limit=20").catch(() => ({
        posts: [],
      })),
      adminFetch("/admin/social-media/health").catch(() => null),
      adminFetch("/admin/social-media/alerts").catch(() => null),
    ]);
    setStatus(s);
    setStats(st);
    setHistory(h.posts || []);
    setHealth(hl);
    if (al?.active) setAlert(al.alert);
    else setAlert(null);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      {" "}
      <AdminCommandHeader
        title="Social Media"
        icon={Share2}
        sections={SOCIAL_TABS}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Social Media section"
        navGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-10"
      />
      {/* Failure alert banner */}
      {alert && (
        <div
          style={{
            ...sCard,
            marginBottom: 12,
            background: `${D.red}08`,
            borderLeft: `4px solid ${D.red}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: D.red }}>
              {alert.message}
            </div>
            <div style={{ fontSize: 11, color: D.muted }}>
              Since {new Date(alert.raised_at).toLocaleString('en-US', { timeZone: 'America/New_York' })}
            </div>
          </div>
          <button
            onClick={async () => {
              await adminFetch("/admin/social-media/alerts", {
                method: "DELETE",
              }).catch(() => {});
              setAlert(null);
              showToast("Alert dismissed");
            }}
            style={sBtn(D.muted, "#fff")}
          >
            Dismiss
          </button>
        </div>
      )}
      {/* Automation status banner */}
      {status?.automation && (
        <div
          style={{
            ...sCard,
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
            borderLeft: `4px solid ${
              status.automation.paused ? D.red
              : status.automation.dryRun ? D.amber
              : status.automation.enabled ? D.green
              : D.muted
            }`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: status.automation.paused
                  ? D.red
                  : status.automation.dryRun
                    ? D.amber
                    : status.automation.enabled
                      ? D.green
                      : D.muted,
              }}
            />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
                Automation:{" "}
                {status.automation.paused
                  ? "Paused"
                  : status.automation.dryRun
                    ? "Dry Run"
                    : status.automation.enabled
                      ? "Active"
                      : "Disabled"}
              </div>
              <div style={{ fontSize: 12, color: D.muted }}>
                RSS: {status.automation.rssAutopublish ? "On" : "Off"} ·{" "}
                Scheduled: {status.automation.scheduledPosts ? "On" : "Off"} ·{" "}
                Newsletter: {status.automation.newsletterAutoshare ? "On" : "Off"}
              </div>
            </div>
          </div>
          {status.automation.enabled && (
            <button
              onClick={async () => {
                setPauseLoading(true);
                try {
                  await adminFetch("/admin/social-media/pause", {
                    method: "POST",
                    body: JSON.stringify({
                      paused: !status.automation.paused,
                    }),
                  });
                  await loadData();
                  showToast(
                    status.automation.paused
                      ? "Automation resumed"
                      : "Automation paused",
                  );
                } catch {
                  showToast("Failed to toggle pause");
                } finally {
                  setPauseLoading(false);
                }
              }}
              disabled={pauseLoading}
              style={sBtn(
                status.automation.paused ? D.green : D.red,
                "#fff",
              )}
            >
              {pauseLoading
                ? "..."
                : status.automation.paused
                  ? "Resume"
                  : "Pause All"}
            </button>
          )}
        </div>
      )}
      {/* Platform health + connection status */}
      {status && (
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          {Object.entries(status.platforms).map(([key, p]) => {
            const cred = health?.credentials?.find(
              (c) => c.platform === key || c.platform === `${key}_lwr`,
            );
            const healthStatus = cred?.status || (p.configured ? "unknown" : "not_configured");
            const statusColor =
              healthStatus === "healthy" ? D.green
              : healthStatus === "expired" ? D.red
              : healthStatus === "error" ? D.amber
              : D.muted;
            const statusLabel =
              !p.enabled && key !== "ai" && key !== "gemini"
                ? "Disabled"
                : healthStatus === "healthy"
                  ? "Healthy"
                  : healthStatus === "expired"
                    ? "Expired"
                    : healthStatus === "error"
                      ? "Error"
                      : healthStatus === "not_configured"
                        ? "Not configured"
                        : "Unknown";

            return (
              <div
                key={key}
                style={{
                  ...sCard,
                  flex: "1 1 140px",
                  minWidth: 140,
                  marginBottom: 0,
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: D.heading,
                    textTransform: "capitalize",
                  }}
                >
                  {key === "gbp" ? "GBP" : key}
                </div>
                <div style={{ marginTop: 4 }}>
                  <span
                    style={sBadge(
                      !p.enabled && key !== "ai" && key !== "gemini"
                        ? `${D.muted}15`
                        : `${statusColor}22`,
                      !p.enabled && key !== "ai" && key !== "gemini"
                        ? D.muted
                        : statusColor,
                    )}
                  >
                    {statusLabel}
                  </span>
                </div>
                {cred?.lastError && healthStatus !== "healthy" && (
                  <div
                    style={{
                      fontSize: 10,
                      color: D.muted,
                      marginTop: 4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 140,
                    }}
                    title={cred.lastError}
                  >
                    {cred.lastError}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {status && (
        <MetaHealthStrip
          health={health}
          onRefresh={async () => {
            try {
              const next = await adminFetch("/admin/social-media/health?force=1");
              setHealth(next);
              showToast("Meta health refreshed");
            } catch (e) {
              showToast(`Meta health refresh failed: ${e.message}`);
            }
          }}
        />
      )}
      {/* Stats — kept; sit below the platform connection row. */}
      {stats && (
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          {[
            { label: "Total Posts", value: stats.total, color: D.heading },
            { label: "Published", value: stats.published, color: D.green },
            { label: "Failed", value: stats.failed, color: D.red },
            { label: "Last 7d", value: stats.last7d, color: D.teal },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                ...sCard,
                flex: "1 1 120px",
                minWidth: 120,
                marginBottom: 0,
                textAlign: "center",
              }}
            >
              {" "}
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 22,
                  fontWeight: 700,
                  color: s.color,
                }}
              >
                {s.value}
              </div>{" "}
              <div
                style={{
                  fontSize: 10,
                  color: D.muted,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  marginTop: 2,
                }}
              >
                {s.label}
              </div>{" "}
            </div>
          ))}
        </div>
      )}
      {tab === "campaigns" && (
        <CampaignBuilderTab showToast={showToast} onSaved={loadData} />
      )}
      {tab === "audit" && (
        <AutonomousRunAuditTab showToast={showToast} onRan={loadData} />
      )}
      {tab === "reviews" && <ReviewGraphicsTab showToast={showToast} />}
      {tab === "competitors" && <CompetitorSwipeTab showToast={showToast} />}
      {tab === "compose" && (
        <ComposeTab showToast={showToast} onPublished={loadData} />
      )}
      {tab === "rss" && <RSSTab showToast={showToast} onPublished={loadData} />}
      {tab === "calendar" && <CalendarTab />}
      {tab === "analytics" && <AnalyticsTab />}
      {tab === "templates" && <TemplatesTab showToast={showToast} />}
      {tab === "history" && (
        <HistoryTab history={history} onRefresh={loadData} />
      )}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          background: D.card,
          border: `1px solid ${D.green}`,
          borderRadius: 8,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          boxShadow: "0 8px 32px rgba(0,0,0,.4)",
          zIndex: 300,
          fontSize: 12,
          transform: toast ? "translateY(0)" : "translateY(80px)",
          opacity: toast ? 1 : 0,
          transition: "all .3s",
          pointerEvents: "none",
        }}
      >
        {" "}
        <span style={{ color: D.green }}></span>
        <span style={{ color: D.text }}>{toast}</span>{" "}
      </div>{" "}
    </div>
  );
}

// LinkedIn is intentionally omitted until the LinkedIn app/page access is
// approved and publishToAll can actually post there — otherwise an admin could
// select it, generate LinkedIn copy, and have the publish silently skip it.
const CAMPAIGN_CHANNELS = ["gbp", "facebook", "instagram"];
const CAMPAIGN_CITIES = ["Sarasota", "Bradenton", "Lakewood Ranch", "Parrish", "Venice", "Port Charlotte", "North Port"];
const CAMPAIGN_SERVICES = ["termite", "lawn care", "mosquito", "general pest", "rodent", "tree and shrub"];
const CAMPAIGN_ANGLES = ["what we are seeing", "signs to check", "myth/fact", "new Florida homeowner", "do not ignore this"];
const CAMPAIGN_CTAS = ["book inspection", "request estimate", "read guide", "call button"];

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value) || typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function FieldLabel({ children }) {
  return (
    <label
      style={{
        fontSize: 11,
        color: D.muted,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        display: "block",
        marginBottom: 4,
      }}
    >
      {children}
    </label>
  );
}

function ChannelToggles({ channels, onChange }) {
  const toggle = (channel) => {
    const next = channels.includes(channel)
      ? channels.filter((item) => item !== channel)
      : [...channels, channel];
    onChange(next.length ? next : [channel]);
  };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {CAMPAIGN_CHANNELS.map((channel) => (
        <label
          key={channel}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 10px",
            border: `1px solid ${channels.includes(channel) ? D.heading : D.border}`,
            borderRadius: 8,
            color: channels.includes(channel) ? D.heading : D.muted,
            fontSize: 12,
            cursor: "pointer",
            background: channels.includes(channel) ? "#FAFAFA" : D.card,
          }}
        >
          <input
            type="checkbox"
            checked={channels.includes(channel)}
            onChange={() => toggle(channel)}
          />
          {channel === "gbp" ? "GBP" : channel}
        </label>
      ))}
    </div>
  );
}

function AutonomousStudioPanel({ showToast, onRan }) {
  const [status, setStatus] = useState(null);
  const [running, setRunning] = useState("");

  const load = useCallback(() => {
    adminFetch("/admin/social-media/autonomous/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (mode) => {
    setRunning(mode);
    try {
      const result = await adminFetch("/admin/social-media/autonomous/run", {
        method: "POST",
        body: JSON.stringify({ force: true, mode }),
      });
      if (result.skipped) showToast(`Autonomous run skipped: ${result.reason}`);
      else if (result.dryRun) showToast("Autonomous dry run completed");
      else showToast(mode === "draft" ? "Autonomous draft created" : "Autonomous publish run completed");
      load();
      onRan?.();
    } catch (e) {
      showToast(`Autonomous run failed: ${e.message}`);
    } finally {
      setRunning("");
    }
  };

  const latest = status?.latestRun;
  const stateColor =
    status?.paused ? D.red
    : status?.enabled && status?.globalAutomationEnabled ? D.green
    : D.amber;
  const stateLabel =
    status?.paused ? "Paused"
    : status?.enabled && status?.globalAutomationEnabled ? "Autonomous"
    : "Not fully enabled";

  return (
    <div
      style={{
        ...sCard,
        marginBottom: 16,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        borderLeft: `4px solid ${stateColor}`,
      }}
    >
      <div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 15, color: D.heading, fontWeight: 600 }}>
            Autonomous Social Studio
          </div>
          <span style={sBadge(`${stateColor}18`, stateColor)}>{stateLabel}</span>
          {status?.dryRun && <span style={sBadge(`${D.amber}18`, D.amber)}>Dry run</span>}
        </div>
        <div style={{ fontSize: 12, color: D.muted }}>
          Mode: {status?.mode || "publish"} · Cadence: every {status?.intervalHours || 24}h · Channels: {(status?.channels || []).join(", ") || "gbp, facebook, instagram"}
        </div>
        {latest && (
          <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>
            Last run: {latest.status} · {latest.topic || "no topic"} · {new Date(latest.started_at).toLocaleString()}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => run("draft")}
          disabled={!!running}
          style={{ ...sBtn(D.teal, D.white), opacity: running ? 0.5 : 1 }}
        >
          {running === "draft" ? "Running..." : "Run Draft"}
        </button>
        <button
          onClick={() => run("publish")}
          disabled={!!running}
          style={{ ...sBtn(D.green, D.white), opacity: running ? 0.5 : 1 }}
        >
          {running === "publish" ? "Running..." : "Run Publish"}
        </button>
      </div>
    </div>
  );
}

function runStatusColor(status) {
  if (status === "published" || status === "draft_created") return D.green;
  if (status === "dry_run") return D.teal;
  if (status === "failed") return D.red;
  if (status === "skipped") return D.amber;
  return D.muted;
}

function formatRunDate(value) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No timestamp";
  return date.toLocaleString();
}

function platformResultColor(result) {
  if (result?.success) return D.green;
  if (result?.dryRun) return D.teal;
  if (result?.skipped) return D.amber;
  return D.red;
}

// ── Autonomous Run Audit Tab ──
function AutonomousRunAuditTab({ showToast, onRan }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState({ runs: [] });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/social-media/autonomous/runs?limit=30")
      .then(setData)
      .catch(() => setData({ runs: [] }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runNow = async (mode) => {
    setRunning(mode);
    try {
      const result = await adminFetch("/admin/social-media/autonomous/run", {
        method: "POST",
        body: JSON.stringify({ force: true, mode }),
      });
      if (result.skipped) showToast(`Autonomous run skipped: ${result.reason}`);
      else if (result.dryRun) showToast("Autonomous dry run completed");
      else showToast(mode === "draft" ? "Autonomous draft created" : "Autonomous publish run completed");
      load();
      onRan?.();
    } catch (e) {
      showToast(`Autonomous run failed: ${e.message}`);
    } finally {
      setRunning("");
    }
  };

  const runs = data.runs || [];
  const failed = runs.filter((run) => run.status === "failed").length;
  const completed = runs.filter((run) => ["published", "draft_created", "dry_run"].includes(run.status)).length;
  const lastRun = runs[0];

  return (
    <div>
      <div
        style={{
          ...sCard,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
            Autonomous Run Audit
          </div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
            Last run: {lastRun ? `${lastRun.status} · ${formatRunDate(lastRun.startedAt)}` : "none"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={load} disabled={loading} style={{ ...sBtn(D.heading, D.white), opacity: loading ? 0.5 : 1 }}>
            Refresh
          </button>
          <button onClick={() => runNow("draft")} disabled={!!running} style={{ ...sBtn(D.teal, D.white), opacity: running ? 0.5 : 1 }}>
            {running === "draft" ? "Running..." : "Run Draft"}
          </button>
          <button onClick={() => runNow("publish")} disabled={!!running} style={{ ...sBtn(D.green, D.white), opacity: running ? 0.5 : 1 }}>
            {running === "publish" ? "Running..." : "Run Publish"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { label: "Runs", value: runs.length, color: D.heading },
          { label: "Completed", value: completed, color: D.green },
          { label: "Failed", value: failed, color: failed ? D.red : D.muted },
          { label: "With Images", value: runs.filter((run) => run.imageUrl).length, color: D.teal },
        ].map((item) => (
          <div key={item.label} style={{ ...sCard, flex: "1 1 140px", minWidth: 140, marginBottom: 0, textAlign: "center" }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: item.color }}>
              {item.value}
            </div>
            <div style={{ fontSize: 10, color: D.muted, textTransform: "uppercase", letterSpacing: 1, marginTop: 2 }}>
              {item.label}
            </div>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading autonomous runs...</div>
      ) : runs.length === 0 ? (
        <div style={{ ...sCard, textAlign: "center", color: D.muted }}>
          No autonomous social studio runs yet.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {runs.map((run) => {
            const color = runStatusColor(run.status);
            const platformResults = run.platformResults || [];
            const channels = run.channels?.length ? run.channels : parseMaybeJson(run.preview?.inputs?.channels, []);
            return (
              <div
                key={run.id}
                style={{
                  ...sCard,
                  marginBottom: 0,
                  borderLeft: `4px solid ${color}`,
                  display: "grid",
                  gridTemplateColumns: isMobile || !run.imageUrl ? "1fr" : "1fr 150px",
                  gap: 16,
                }}
              >
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
                        {run.topic || run.post?.title || "Autonomous social run"}
                      </div>
                      <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                        {[run.city, run.service, run.mode].filter(Boolean).join(" · ")} · {formatRunDate(run.startedAt)}
                      </div>
                    </div>
                    <span style={sBadge(`${color}18`, color)}>{run.status}</span>
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                    {channels.map((channel) => (
                      <span key={`${run.id}-${channel}`} style={sBadge(`${(PLATFORM_COLORS[channel] || D.heading)}12`, PLATFORM_COLORS[channel] || D.heading)}>
                        {channel === "gbp" ? "GBP" : channel}
                      </span>
                    ))}
                    {run.post?.status && (
                      <span style={sBadge(`${D.muted}15`, D.muted)}>post {run.post.status}</span>
                    )}
                  </div>

                  {run.skipReason && (
                    <div style={{ marginTop: 10, fontSize: 12, color: D.red }}>
                      {run.skipReason}
                    </div>
                  )}

                  {platformResults.length > 0 && (
                    <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                      {platformResults.map((result, index) => {
                        const resultColor = platformResultColor(result);
                        const label = result.location ? `${result.platform}/${result.location}` : result.platform;
                        const detail =
                          result.success ? "posted"
                          : result.dryRun ? "dry run"
                          : result.skipped ? "skipped"
                          : result.error || "failed";
                        return (
                          <div
                            key={`${run.id}-${label}-${index}`}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 10,
                              padding: "7px 9px",
                              border: `1px solid ${D.border}`,
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                          >
                            <span style={{ color: D.heading, fontWeight: 600 }}>{label || "platform"}</span>
                            <span style={{ color: resultColor }}>{detail}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap", fontSize: 12 }}>
                    {run.imageUrl && (
                      <a href={run.imageUrl} target="_blank" rel="noopener noreferrer" style={{ color: D.teal }}>
                        Open image
                      </a>
                    )}
                    {run.post?.sourceUrl && (
                      <a href={run.post.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: D.teal }}>
                        Open source
                      </a>
                    )}
                    {run.socialMediaPostId && (
                      <span style={{ color: D.muted }}>Post ID: {run.socialMediaPostId}</span>
                    )}
                  </div>
                </div>

                {run.imageUrl && (
                  <a href={run.imageUrl} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
                    <img
                      src={run.imageUrl}
                      alt=""
                      style={{
                        width: "100%",
                        aspectRatio: "1 / 1",
                        objectFit: "cover",
                        borderRadius: 8,
                        border: `1px solid ${D.border}`,
                        background: "#FAFAFA",
                      }}
                    />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Campaign Builder Tab ──
function CampaignBuilderTab({ showToast, onSaved }) {
  const isMobile = useIsMobile();
  const [form, setForm] = useState({
    topic: "termite swarm season",
    city: "Sarasota",
    service: "termite",
    angle: "what we are seeing",
    cta: "book inspection",
    channels: ["gbp", "facebook", "instagram"],
  });
  const [preview, setPreview] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const generate = async () => {
    if (!form.topic.trim()) {
      showToast("Enter a campaign topic");
      return;
    }
    setLoading(true);
    try {
      const data = await adminFetch("/admin/social-media/campaign-builder/preview", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setPreview(data);
      setDrafts(data.drafts || {});
    } catch (e) {
      showToast(`Campaign preview failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const saveDraft = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      const result = await adminFetch("/admin/social-media/campaign-builder/save", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          link: preview.suggestedLink,
          preview: { ...preview, drafts },
        }),
      });
      if (result.preview) setPreview(result.preview);
      showToast("Campaign saved as social draft");
      onSaved();
    } catch (e) {
      showToast(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <AutonomousStudioPanel showToast={showToast} onRan={onSaved} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "360px 1fr",
          gap: 16,
        }}
      >
      <div>
        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 14 }}>
            Local Campaign
          </div>
          <div style={{ marginBottom: 12 }}>
            <FieldLabel>Topic</FieldLabel>
            <input
              value={form.topic}
              onChange={(e) => update("topic", e.target.value)}
              placeholder="termite swarm season"
              style={sInput}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            <div>
              <FieldLabel>City</FieldLabel>
              <select value={form.city} onChange={(e) => update("city", e.target.value)} style={sInput}>
                {CAMPAIGN_CITIES.map((city) => <option key={city}>{city}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel>Service</FieldLabel>
              <select value={form.service} onChange={(e) => update("service", e.target.value)} style={sInput}>
                {CAMPAIGN_SERVICES.map((service) => <option key={service}>{service}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            <div>
              <FieldLabel>Angle</FieldLabel>
              <select value={form.angle} onChange={(e) => update("angle", e.target.value)} style={sInput}>
                {CAMPAIGN_ANGLES.map((angle) => <option key={angle}>{angle}</option>)}
              </select>
            </div>
            <div>
              <FieldLabel>CTA</FieldLabel>
              <select value={form.cta} onChange={(e) => update("cta", e.target.value)} style={sInput}>
                {CAMPAIGN_CTAS.map((cta) => <option key={cta}>{cta}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <FieldLabel>Channels</FieldLabel>
            <ChannelToggles channels={form.channels} onChange={(value) => update("channels", value)} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={generate}
              disabled={loading}
              style={{ ...sBtn(D.teal, D.white), flex: 1, opacity: loading ? 0.5 : 1 }}
            >
              {loading ? "Generating..." : "Generate Drafts"}
            </button>
            <button
              onClick={saveDraft}
              disabled={!preview || saving}
              style={{ ...sBtn(D.green, D.white), flex: 1, opacity: !preview || saving ? 0.5 : 1 }}
            >
              {saving ? "Saving..." : "Save Draft"}
            </button>
          </div>
        </div>

        {preview?.sources?.length > 0 && (
          <div style={sCard}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 10 }}>
              Source Facts
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {preview.sources.map((source, index) => (
                <div key={`${source.type}-${index}`} style={{ borderTop: index ? `1px solid ${D.border}` : "none", paddingTop: index ? 8 : 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                    <span style={sBadge(`${D.heading}10`, D.heading)}>{source.type}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: D.heading }}>{source.label}</span>
                  </div>
                  <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.45 }}>{source.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div>
        {!preview ? (
          <div style={{ ...sCard, minHeight: 280, display: "grid", placeItems: "center", color: D.muted, textAlign: "center" }}>
            <div>
              <div style={{ fontSize: 15, color: D.heading, fontWeight: 600, marginBottom: 6 }}>
                Build autonomous local posts
              </div>
              <div style={{ fontSize: 12 }}>
                The studio uses service facts, content history, pest pressure language, review proof, and competitor patterns.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {Object.entries(drafts).map(([platform, text]) => {
              const validation = preview.validation?.[platform];
              return (
                <div key={platform} style={{ ...sCard, marginBottom: 0, borderLeft: `3px solid ${PLATFORM_COLORS[platform] || D.heading}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, textTransform: "capitalize" }}>
                      {platform === "gbp" ? "Google Business Profile" : platform}
                    </div>
                    <span style={sBadge(validation?.valid === false ? `${D.red}18` : `${D.green}18`, validation?.valid === false ? D.red : D.green)}>
                      {validation?.valid === false ? "Needs edit" : "Clear"}
                    </span>
                  </div>
                  <textarea
                    value={text}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [platform]: e.target.value }))}
                    rows={platform === "instagram" ? 7 : 5}
                    style={{ ...sInput, resize: "vertical", lineHeight: 1.5 }}
                  />
                  {validation?.issues?.length > 0 && (
                    <div style={{ marginTop: 8, color: D.red, fontSize: 12 }}>
                      {validation.issues.join("; ")}
                    </div>
                  )}
                </div>
              );
            })}
            {preview.suggestedLink && (
              <div style={{ ...sCard, marginBottom: 0, fontSize: 12, color: D.muted }}>
                Suggested link:{" "}
                <a href={preview.suggestedLink} target="_blank" rel="noopener noreferrer" style={{ color: D.teal }}>
                  {preview.suggestedLink}
                </a>
              </div>
            )}
            {preview.visual?.imageUrl && (
              <div style={{ ...sCard, marginBottom: 0, fontSize: 12, color: D.muted }}>
                Visual card:{" "}
                <a href={preview.visual.imageUrl} target="_blank" rel="noopener noreferrer" style={{ color: D.teal }}>
                  Open rendered image
                </a>
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </>
  );
}

// ── Review Graphics Tab ──
function ReviewGraphicsTab({ showToast }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState({ candidates: [], saved: [] });
  const [loading, setLoading] = useState(true);
  const [privacy, setPrivacy] = useState({});
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/social-media/review-graphics?limit=30")
      .then(setData)
      .catch(() => setData({ candidates: [], saved: [] }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createGraphic = async (candidate) => {
    setSavingId(candidate.googleReviewId);
    try {
      await adminFetch("/admin/social-media/review-graphics", {
        method: "POST",
        body: JSON.stringify({
          googleReviewId: candidate.googleReviewId,
          privacyMode: privacy[candidate.googleReviewId] || "first_name_city",
          templateKey: "waves_clean_square",
          channels: ["gbp", "facebook", "instagram"],
        }),
      });
      showToast("Review graphic draft saved");
      load();
    } catch (e) {
      showToast(`Review graphic failed: ${e.message}`);
    } finally {
      setSavingId(null);
    }
  };

  const approveGraphic = async (graphic) => {
    try {
      await adminFetch(`/admin/social-media/review-graphics/${graphic.id}/approve`, { method: "POST" });
      showToast("Review graphic approved");
      load();
    } catch (e) {
      showToast(`Approve failed: ${e.message}`);
    }
  };

  if (loading) {
    return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading review graphics...</div>;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "1fr 360px",
        gap: 16,
      }}
    >
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>
          Eligible 5-star Reviews
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {(data.candidates || []).map((candidate) => (
            <div key={candidate.googleReviewId} style={{ ...sCard, marginBottom: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
                    {candidate.reviewerDisplayName}
                  </div>
                  <div style={{ fontSize: 11, color: D.muted }}>
                    5-star Google review - {candidate.city}
                  </div>
                </div>
                <span style={sBadge(`${D.green}18`, D.green)}>No photo by default</span>
              </div>
              <div style={{ fontSize: 13, color: D.text, lineHeight: 1.55, marginBottom: 12 }}>
                "{candidate.excerpt}"
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  value={privacy[candidate.googleReviewId] || "first_name_city"}
                  onChange={(e) => setPrivacy((prev) => ({ ...prev, [candidate.googleReviewId]: e.target.value }))}
                  style={{ ...sInput, width: 190 }}
                >
                  <option value="first_name_city">First name + city</option>
                  <option value="initials">Initials + city</option>
                  <option value="anonymous">Anonymous + city</option>
                </select>
                <button
                  onClick={() => createGraphic(candidate)}
                  disabled={savingId === candidate.googleReviewId}
                  style={{ ...sBtn(D.teal, D.white), opacity: savingId === candidate.googleReviewId ? 0.5 : 1 }}
                >
                  {savingId === candidate.googleReviewId ? "Saving..." : "Create Graphic Draft"}
                </button>
              </div>
            </div>
          ))}
          {data.candidates?.length === 0 && (
            <div style={{ ...sCard, textAlign: "center", color: D.muted }}>
              No eligible unsaved 5-star reviews found.
            </div>
          )}
        </div>
      </div>

      <div>
        <div style={{ ...sCard, marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 10 }}>
            Graphic Preview
          </div>
          <div
            style={{
              aspectRatio: "1 / 1",
              background: "#FAFAFA",
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              padding: 24,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: D.muted }}>
                Waves Pest Control
              </div>
              <div style={{ fontSize: 24, color: D.heading, fontWeight: 600, marginTop: 10 }}>
                5-star Google review
              </div>
            </div>
            <div style={{ fontSize: 16, lineHeight: 1.45, color: D.text }}>
              "{data.candidates?.[0]?.excerpt || "Helpful, professional, and local service."}"
            </div>
            <div style={{ fontSize: 13, color: D.muted }}>
              {data.candidates?.[0]?.reviewerDisplayName || "Waves customer, Sarasota"}
            </div>
          </div>
        </div>

        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 10 }}>
            Saved Graphics
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {(data.saved || []).slice(0, 8).map((graphic) => {
              const channels = parseMaybeJson(graphic.channels, []);
              return (
                <div key={graphic.id} style={{ borderTop: `1px solid ${D.border}`, paddingTop: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontSize: 12, color: D.heading, fontWeight: 600 }}>
                      {graphic.reviewer_display_name}
                    </div>
                    <span style={sBadge(graphic.status === "approved" ? `${D.green}18` : `${D.amber}18`, graphic.status === "approved" ? D.green : D.amber)}>
                      {graphic.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: D.muted, marginTop: 3 }}>
                    {channels.join(", ") || "gbp, facebook, instagram"}
                  </div>
                  {graphic.status !== "approved" && (
                    <button
                      onClick={() => approveGraphic(graphic)}
                      style={{ ...sBtn(D.green, D.white), marginTop: 8, padding: "6px 10px", fontSize: 11 }}
                    >
                      Approve
                    </button>
                  )}
                  {graphic.image_url && (
                    <a href={graphic.image_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: D.teal, marginTop: 8, display: "inline-block" }}>
                      Open image
                    </a>
                  )}
                </div>
              );
            })}
            {data.saved?.length === 0 && (
              <div style={{ color: D.muted, fontSize: 12 }}>No saved graphics yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Competitor Swipe Tab ──
function CompetitorSwipeTab({ showToast }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState({ profiles: [], posts: [], patterns: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [capture, setCapture] = useState({
    companyName: "Prodigy Pest Solutions",
    platform: "facebook",
    profileUrl: "",
    postUrl: "",
    topic: "termite",
    hookType: "local trigger",
    creativeFormat: "photo post",
    likesCount: 0,
    commentsCount: 0,
    sharesCount: 0,
    viewsCount: 0,
    whyItWorked: "",
    copyablePattern: "",
  });

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/social-media/competitor-swipe")
      .then(setData)
      .catch(() => setData({ profiles: [], posts: [], patterns: [] }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateCapture = (key, value) => setCapture((prev) => ({ ...prev, [key]: value }));

  const saveCapture = async () => {
    setSaving(true);
    try {
      await adminFetch("/admin/social-media/competitor-swipe/posts", {
        method: "POST",
        body: JSON.stringify(capture),
      });
      showToast("Competitor post captured");
      setCapture((prev) => ({
        ...prev,
        postUrl: "",
        likesCount: 0,
        commentsCount: 0,
        sharesCount: 0,
        viewsCount: 0,
        whyItWorked: "",
        copyablePattern: "",
      }));
      load();
    } catch (e) {
      showToast(`Capture failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const profiles = data.profiles || [];
  const profileName = (profile) => profile.company_name || profile.companyName;
  const growth = (profile) => profile.growth_pct ?? profile.growthPct;
  const location = (profile) => [profile.city, profile.state].filter(Boolean).join(", ");

  if (loading) {
    return <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>Loading competitor swipe file...</div>;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "1fr 420px",
        gap: 16,
      }}
    >
      <div>
        <div style={{ ...sCard, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>
            Fastest Risers From PCT 2026
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
            {profiles.slice(0, 12).map((profile) => {
              const notes = parseMaybeJson(profile.strategic_notes || profile.strategicNotes, []);
              return (
                <div key={profile.id || profileName(profile)} style={{ padding: 12, border: `1px solid ${D.border}`, borderRadius: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{profileName(profile)}</div>
                    <span style={sBadge(`${D.green}18`, D.green)}>+{growth(profile)}%</span>
                  </div>
                  <div style={{ fontSize: 11, color: D.muted, marginBottom: 8 }}>{location(profile)}</div>
                  <div style={{ fontSize: 12, color: D.text, lineHeight: 1.45 }}>
                    {notes[0] || "Track hooks, format, visible engagement, and copyable pattern."}
                  </div>
                  <button
                    onClick={() => updateCapture("companyName", profileName(profile))}
                    style={{ ...sBtn(D.teal, D.white), marginTop: 10, padding: "6px 10px", fontSize: 11 }}
                  >
                    Capture Post
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>
            Copyable Patterns
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {(data.patterns || []).map((pattern) => (
              <div key={pattern.key} style={{ borderTop: `1px solid ${D.border}`, paddingTop: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{pattern.label}</div>
                <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.45 }}>{pattern.copyablePattern}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={sCard}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>
            Captured Posts
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {(data.posts || []).map((post) => (
              <div key={post.id} style={{ padding: 12, border: `1px solid ${D.border}`, borderRadius: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: D.heading }}>{post.company_name}</div>
                  <span style={sBadge(`${D.heading}10`, D.heading)}>Score {post.engagement_score}</span>
                </div>
                <div style={{ fontSize: 11, color: D.muted, marginTop: 3 }}>
                  {post.platform} - {post.topic || "uncategorized"} - {post.creative_format || "post"}
                </div>
                {post.why_it_worked && (
                  <div style={{ fontSize: 12, color: D.text, marginTop: 8, lineHeight: 1.45 }}>
                    {post.why_it_worked}
                  </div>
                )}
                {post.post_url && (
                  <a href={post.post_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: D.teal, marginTop: 8, display: "inline-block" }}>
                    Open post
                  </a>
                )}
              </div>
            ))}
            {data.posts?.length === 0 && (
              <div style={{ color: D.muted, fontSize: 12 }}>No competitor posts captured yet.</div>
            )}
          </div>
        </div>
      </div>

      <div style={sCard}>
        <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>
          Manual Engagement Capture
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <FieldLabel>Company</FieldLabel>
            <select value={capture.companyName} onChange={(e) => updateCapture("companyName", e.target.value)} style={sInput}>
              {profiles.map((profile) => <option key={profile.id || profileName(profile)}>{profileName(profile)}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <FieldLabel>Platform</FieldLabel>
              <select value={capture.platform} onChange={(e) => updateCapture("platform", e.target.value)} style={sInput}>
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
                <option value="linkedin">LinkedIn</option>
                <option value="gbp">GBP</option>
                <option value="tiktok">TikTok</option>
              </select>
            </div>
            <div>
              <FieldLabel>Format</FieldLabel>
              <input value={capture.creativeFormat} onChange={(e) => updateCapture("creativeFormat", e.target.value)} style={sInput} />
            </div>
          </div>
          <div>
            <FieldLabel>Post URL</FieldLabel>
            <input value={capture.postUrl} onChange={(e) => updateCapture("postUrl", e.target.value)} placeholder="https://..." style={sInput} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <FieldLabel>Topic</FieldLabel>
              <input value={capture.topic} onChange={(e) => updateCapture("topic", e.target.value)} style={sInput} />
            </div>
            <div>
              <FieldLabel>Hook Type</FieldLabel>
              <input value={capture.hookType} onChange={(e) => updateCapture("hookType", e.target.value)} style={sInput} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {[
              ["likesCount", "Likes"],
              ["commentsCount", "Comments"],
              ["sharesCount", "Shares"],
              ["viewsCount", "Views"],
            ].map(([key, label]) => (
              <div key={key}>
                <FieldLabel>{label}</FieldLabel>
                <input
                  type="number"
                  min="0"
                  value={capture[key]}
                  onChange={(e) => updateCapture(key, e.target.value)}
                  style={sInput}
                />
              </div>
            ))}
          </div>
          <div>
            <FieldLabel>Why It Worked</FieldLabel>
            <textarea
              value={capture.whyItWorked}
              onChange={(e) => updateCapture("whyItWorked", e.target.value)}
              rows={3}
              style={{ ...sInput, resize: "vertical" }}
            />
          </div>
          <div>
            <FieldLabel>Copyable Pattern</FieldLabel>
            <textarea
              value={capture.copyablePattern}
              onChange={(e) => updateCapture("copyablePattern", e.target.value)}
              rows={3}
              style={{ ...sInput, resize: "vertical" }}
            />
          </div>
          <button
            onClick={saveCapture}
            disabled={saving}
            style={{ ...sBtn(D.green, D.white), opacity: saving ? 0.5 : 1 }}
          >
            {saving ? "Saving..." : "Save Capture"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Compose Tab ──
function ComposeTab({ showToast, onPublished }) {
  const isMobile = useIsMobile();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [customContent, setCustomContent] = useState({});

  const handlePreview = async () => {
    if (!title.trim()) {
      showToast("Enter a title");
      return;
    }
    setGenerating(true);
    try {
      const data = await adminFetch("/admin/social-media/preview", {
        method: "POST",
        body: JSON.stringify({ title, description, link }),
      });
      setPreview(data);
      setCustomContent(data);
    } catch (e) {
      showToast(`Preview failed: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const result = await adminFetch("/admin/social-media/publish", {
        method: "POST",
        body: JSON.stringify({ title, description, link, customContent }),
      });
      const successes = result.platforms?.filter((p) => p.success).length || 0;
      const skipped = result.platforms?.filter((p) => p.skipped).length || 0;
      const failed = result.platforms?.filter((p) => p.error).length || 0;
      showToast(
        `Published: ${successes} success, ${skipped} skipped, ${failed} failed`,
      );
      onPublished();
    } catch (e) {
      showToast(`Publish failed: ${e.message}`);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
        gap: 16,
      }}
    >
      {/* Left — Input */}
      <div>
        {" "}
        <div style={sCard}>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 16,
            }}
          >
            Content Source
          </div>{" "}
          <div style={{ marginBottom: 12 }}>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                display: "block",
                marginBottom: 4,
              }}
            >
              Title
            </label>{" "}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Blog post title or topic..."
              style={sInput}
            />{" "}
          </div>{" "}
          <div style={{ marginBottom: 12 }}>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                display: "block",
                marginBottom: 4,
              }}
            >
              Description
            </label>{" "}
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Brief description or excerpt..."
              style={{ ...sInput, resize: "vertical" }}
            />{" "}
          </div>{" "}
          <div style={{ marginBottom: 16 }}>
            {" "}
            <label
              style={{
                fontSize: 11,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                display: "block",
                marginBottom: 4,
              }}
            >
              Link URL
            </label>{" "}
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://www.wavespestcontrol.com/blog/..."
              style={sInput}
            />{" "}
          </div>{" "}
          <div style={{ display: "flex", gap: 8 }}>
            {" "}
            <button
              onClick={handlePreview}
              disabled={generating}
              style={{
                ...sBtn(D.teal, D.white),
                flex: 1,
                opacity: generating ? 0.5 : 1,
              }}
            >
              {generating ? "Generating AI Content..." : "Generate AI Preview"}
            </button>{" "}
            <button
              onClick={handlePublish}
              disabled={publishing || !preview}
              style={{
                ...sBtn(D.green, D.white),
                flex: 1,
                opacity: publishing || !preview ? 0.5 : 1,
              }}
            >
              {publishing ? "Publishing..." : "Publish All"}
            </button>{" "}
          </div>{" "}
        </div>{" "}
      </div>
      {/* Right — Preview */}
      <div>
        {!preview ? (
          <div
            style={{
              ...sCard,
              textAlign: "center",
              padding: 60,
              color: D.muted,
            }}
          >
            {" "}
            <div style={{ fontSize: 32, marginBottom: 12 }}></div>{" "}
            <div style={{ fontSize: 15 }}>
              Enter content and click Generate AI Preview
            </div>{" "}
            <div style={{ fontSize: 12, marginTop: 4 }}>
              AI will create platform-optimized versions for each channel
            </div>{" "}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {["facebook", "instagram", "linkedin", "gbp"].map((platform) => (
              <div
                key={platform}
                style={{
                  ...sCard,
                  marginBottom: 0,
                  borderLeft: `3px solid ${PLATFORM_COLORS[platform]}`,
                }}
              >
                {" "}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  {" "}
                  <span style={{ fontSize: 18 }}>
                    {PLATFORM_ICONS[platform]}
                  </span>{" "}
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: D.heading,
                      textTransform: "capitalize",
                    }}
                  >
                    {platform === "gbp"
                      ? "Google Business (all 4 locations)"
                      : platform}
                  </span>{" "}
                </div>{" "}
                <textarea
                  value={customContent[platform] || ""}
                  onChange={(e) =>
                    setCustomContent((prev) => ({
                      ...prev,
                      [platform]: e.target.value,
                    }))
                  }
                  rows={3}
                  style={{ ...sInput, resize: "vertical", fontSize: 12 }}
                />{" "}
              </div>
            ))}
          </div>
        )}
      </div>{" "}
    </div>
  );
}

// ── RSS Feed Tab ──
function RSSTab({ showToast, onPublished }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    adminFetch("/admin/social-media/rss")
      .then((d) => {
        setItems(d.items || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleAutoPublish = async () => {
    setChecking(true);
    try {
      const result = await adminFetch("/admin/social-media/check-rss", {
        method: "POST",
      });
      showToast(`RSS check done: ${result.processed} new post(s) published`);
      onPublished();
      // Refresh
      const d = await adminFetch("/admin/social-media/rss");
      setItems(d.items || []);
    } catch (e) {
      showToast(`RSS check failed: ${e.message}`);
    }
    setChecking(false);
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading RSS feed...
      </div>
    );

  return (
    <div>
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
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>
            Blog RSS Feed
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted }}>
            wavespestcontrol.com/feed/ — checked every 4 hours automatically
          </div>{" "}
        </div>{" "}
        <button
          onClick={handleAutoPublish}
          disabled={checking}
          style={{ ...sBtn(D.teal, D.white), opacity: checking ? 0.5 : 1 }}
        >
          {checking ? "Checking..." : "Check & Auto-Publish New"}
        </button>{" "}
      </div>{" "}
      <div style={{ display: "grid", gap: 8 }}>
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              ...sCard,
              marginBottom: 0,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 16,
            }}
          >
            {" "}
            <div style={{ flex: 1, minWidth: 0 }}>
              {" "}
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: D.heading,
                  marginBottom: 4,
                }}
              >
                {item.title}
              </div>{" "}
              <div
                style={{
                  fontSize: 12,
                  color: D.muted,
                  marginBottom: 4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.description?.substring(0, 150)}
              </div>{" "}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {" "}
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 11,
                    color: D.teal,
                    textDecoration: "none",
                  }}
                >
                  View post
                </a>
                {item.pubDate && (
                  <span style={{ fontSize: 11, color: D.muted }}>
                    {new Date(item.pubDate).toLocaleDateString()}
                  </span>
                )}
              </div>{" "}
            </div>
            {item.posted ? (
              <span style={sBadge(`${D.green}22`, D.green)}>Published</span>
            ) : (
              <span style={sBadge(`${D.amber}22`, D.amber)}>Not posted</span>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <div
            style={{
              ...sCard,
              textAlign: "center",
              padding: 40,
              color: D.muted,
            }}
          >
            No RSS items found
          </div>
        )}
      </div>{" "}
    </div>
  );
}

// ── History Tab ──
function HistoryTab({ history, onRefresh }) {
  const isMobile = useIsMobile();
  return (
    <div>
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
          Post History
        </div>{" "}
        <button onClick={onRefresh} style={sBtn(D.teal, D.white)}>
          Refresh
        </button>{" "}
      </div>
      {history.length === 0 ? (
        <div
          style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
        >
          No posts yet
        </div>
      ) : (
        history.map((post) => {
          let platforms = [];
          try {
            platforms =
              typeof post.platforms_posted === "string"
                ? JSON.parse(post.platforms_posted)
                : post.platforms_posted || [];
            if (!Array.isArray(platforms)) platforms = [];
          } catch {
            platforms = [];
          }
          return (
            <div key={post.id} style={{ ...sCard, marginBottom: 8 }}>
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginBottom: 8,
                }}
              >
                {" "}
                <div>
                  {" "}
                  <div
                    style={{ fontSize: 14, fontWeight: 600, color: D.heading }}
                  >
                    {post.title}
                  </div>
                  {post.source_url && (
                    <a
                      href={post.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: 11,
                        color: D.teal,
                        textDecoration: "none",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        display: "block",
                        maxWidth: isMobile ? 200 : 400,
                      }}
                    >
                      {post.source_url}
                    </a>
                  )}
                </div>{" "}
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {" "}
                  <span
                    style={sBadge(
                      post.status === "published"
                        ? `${D.green}22`
                        : `${D.red}22`,
                      post.status === "published" ? D.green : D.red,
                    )}
                  >
                    {post.status}
                  </span>{" "}
                  <span style={{ fontSize: 11, color: D.muted }}>
                    {new Date(post.created_at).toLocaleString()}
                  </span>{" "}
                </div>{" "}
              </div>{" "}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {platforms.map((p, i) => (
                  <span
                    key={i}
                    style={sBadge(
                      p.success
                        ? `${PLATFORM_COLORS[p.platform] || D.green}22`
                        : p.skipped
                          ? `${D.muted}22`
                          : `${D.red}22`,
                      p.success
                        ? PLATFORM_COLORS[p.platform] || D.green
                        : p.skipped
                          ? D.muted
                          : D.red,
                    )}
                  >
                    {p.platform}
                    {p.location ? ` (${p.location})` : ""}:{" "}
                    {p.success
                      ? ""
                      : p.skipped
                        ? "skipped"
                        : p.error
                          ? p.error.length > 30
                            ? p.error.substring(0, 30) + "..."
                            : p.error
                          : "No"}
                  </span>
                ))}
              </div>{" "}
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Calendar Tab ──
function CalendarTab() {
  return (
    <Suspense
      fallback={
        <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
          Loading calendar...
        </div>
      }
    >
      <ContentCalendar />
    </Suspense>
  );
}

// ── Analytics Tab ──
function AnalyticsTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch("/admin/social-media/analytics")
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading analytics...
      </div>
    );
  if (!data)
    return (
      <div
        style={{ ...sCard, textAlign: "center", padding: 40, color: D.muted }}
      >
        No analytics data yet
      </div>
    );

  const { byPlatform = {}, weeklyTrend = [], summary = {} } = data;

  return (
    <div>
      {/* Summary */}
      <div
        style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}
      >
        {[
          {
            label: "Total Posts",
            value: summary.totalPosts || 0,
            color: D.heading,
          },
          { label: "Published", value: summary.published || 0, color: D.green },
          {
            label: "Success Rate",
            value: `${summary.successRate || 0}%`,
            color: summary.successRate >= 80 ? D.green : D.amber,
          },
          {
            label: "Posts/Week",
            value: summary.postsPerWeek || 0,
            color: D.teal,
          },
          {
            label: "Most Active",
            value: summary.mostActivePlatform || "—",
            color: D.purple,
          },
        ].map((s) => (
          <div
            key={s.label}
            style={{
              ...sCard,
              flex: "1 1 120px",
              minWidth: 120,
              marginBottom: 0,
              textAlign: "center",
            }}
          >
            {" "}
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 20,
                fontWeight: 700,
                color: s.color,
              }}
            >
              {s.value}
            </div>{" "}
            <div
              style={{
                fontSize: 9,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 1,
                marginTop: 2,
              }}
            >
              {s.label}
            </div>{" "}
          </div>
        ))}
      </div>
      {/* By Platform */}
      <div style={{ ...sCard, marginBottom: 16 }}>
        {" "}
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 12,
          }}
        >
          Performance by Platform
        </div>{" "}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 10,
          }}
        >
          {Object.entries(byPlatform).map(([platform, stats]) => (
            <div
              key={platform}
              style={{
                padding: 14,
                background: D.input,
                borderRadius: 8,
                textAlign: "center",
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: D.heading,
                  textTransform: "capitalize",
                }}
              >
                {platform}
              </div>{" "}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "center",
                  marginTop: 8,
                  fontSize: 11,
                }}
              >
                {" "}
                <span style={{ color: D.green }}>{stats.success} </span>{" "}
                <span style={{ color: D.red }}>{stats.failed} No</span>{" "}
                <span style={{ color: D.muted }}>{stats.total} total</span>{" "}
              </div>{" "}
            </div>
          ))}
        </div>{" "}
      </div>
      {/* Weekly Trend */}
      {weeklyTrend.length > 0 && (
        <div style={{ ...sCard }}>
          {" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Weekly Posting Trend
          </div>{" "}
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 4,
              height: 100,
            }}
          >
            {weeklyTrend.map((w, i) => {
              const max = Math.max(...weeklyTrend.map((x) => x.total), 1);
              const h = Math.max(4, (w.total / max) * 80);
              return (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  {" "}
                  <div style={{ fontSize: 9, color: D.muted }}>
                    {w.total}
                  </div>{" "}
                  <div
                    style={{
                      width: "100%",
                      height: h,
                      background: w.published > 0 ? D.green : D.border,
                      borderRadius: 3,
                    }}
                  />{" "}
                  <div
                    style={{
                      fontSize: 8,
                      color: D.muted,
                      transform: "rotate(-45deg)",
                      transformOrigin: "center",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {w.week?.substring(5)}
                  </div>{" "}
                </div>
              );
            })}
          </div>{" "}
        </div>
      )}
    </div>
  );
}

// ── Templates Tab ──
function TemplatesTab({ showToast }) {
  const isMobile = useIsMobile();
  const TEMPLATES = [
    {
      id: "seasonal_tip",
      name: "Seasonal Pest Tip",
      icon: "",
      platforms: ["facebook", "instagram", "gbp"],
      template:
        "SW Florida pest alert: {topic}. Here's what homeowners need to know to protect their property this season. \n\n#wavespestcontrol #pestcontrol #swfl",
    },
    {
      id: "review_highlight",
      name: "Review Highlight",
      icon: "",
      platforms: ["facebook", "instagram"],
      template:
        ' "{review_text}"\n\nThank you {customer_name} for trusting Waves! We love protecting SWFL homes. \n\n#5starreview #wavespestcontrol',
    },
    {
      id: "before_after",
      name: "Before & After",
      icon: "",
      platforms: ["facebook", "instagram"],
      template:
        "Transformation Tuesday! Check out these results from our {service} treatment in {city}. \n\nSwipe to see the before → after!\n\n#wavespestcontrol #transformation #{city_tag}",
    },
    {
      id: "team_spotlight",
      name: "Team Spotlight",
      icon: "",
      platforms: ["facebook", "linkedin"],
      template:
        "Meet {tech_name}, one of our certified technicians! {tech_name} has been keeping SWFL homes pest-free for {years} years. \n\n#meettheteam #wavespestcontrol",
    },
    {
      id: "local_tip",
      name: "Local Area Tip",
      icon: "",
      platforms: ["facebook", "gbp"],
      template:
        "{city} homeowners: {tip}. Our techs serve {city} daily — call (941) 318-7612 for a free estimate! ",
    },
    {
      id: "blog_promo",
      name: "Blog Promotion",
      icon: "",
      platforms: ["facebook", "instagram", "linkedin", "gbp"],
      template:
        "New on the blog: {blog_title} \n\nRead the full article: {link}\n\n#wavespestcontrol #pestcontrol #swfl",
    },
  ];

  const [selectedTemplate, setSelectedTemplate] = useState(null);

  return (
    <div>
      {" "}
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: D.heading,
          marginBottom: 16,
        }}
      >
        Post Templates
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile
            ? "1fr"
            : "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}
      >
        {TEMPLATES.map((t) => (
          <div
            key={t.id}
            onClick={() =>
              setSelectedTemplate(selectedTemplate === t.id ? null : t.id)
            }
            style={{
              ...sCard,
              marginBottom: 0,
              cursor: "pointer",
              borderColor: selectedTemplate === t.id ? D.teal : D.border,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              {" "}
              <span style={{ fontSize: 20 }}>{t.icon}</span>{" "}
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
                {t.name}
              </div>{" "}
            </div>{" "}
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {t.platforms.map((p) => (
                <span
                  key={p}
                  style={sBadge(
                    `${PLATFORM_COLORS[p] || D.muted}22`,
                    PLATFORM_COLORS[p] || D.muted,
                  )}
                >
                  {p}
                </span>
              ))}
            </div>
            {selectedTemplate === t.id && (
              <div
                style={{
                  padding: 10,
                  background: D.input,
                  borderRadius: 8,
                  fontSize: 12,
                  color: D.muted,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  marginTop: 8,
                }}
              >
                {t.template}
                <div style={{ marginTop: 8 }}>
                  {" "}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(t.template);
                      showToast("Template copied!");
                    }}
                    style={sBtn(D.teal, D.white)}
                  >
                    Copy Template
                  </button>{" "}
                </div>{" "}
              </div>
            )}
          </div>
        ))}
      </div>{" "}
    </div>
  );
}
