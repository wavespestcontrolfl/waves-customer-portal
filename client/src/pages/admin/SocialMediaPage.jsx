import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
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
import { formatETDate } from "../../lib/timezone";
import {
  Badge,
  Button,
  Card as UiCard,
  Checkbox,
  Input,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Textarea,
  UiSurface,
  cn,
} from "../../components/ui";
const ContentCalendar = lazy(() => import("./ContentCalendar"));
const API_BASE = import.meta.env.VITE_API_URL || "/api";
// Defense-in-depth: the server already rejects non-http(s) competitor URLs at
// the storage boundary, but never render a stored URL as an href without
// re-checking the scheme — guards any legacy/edited row against javascript:/
// data: links.
function safeHttpHref(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? url
      : null;
  } catch {
    return null;
  }
}
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

function Card({ className, ...props }) {
  const hasExplicitMargin = /(?:^|\s)mb-/.test(className || "");
  return (
    <UiCard
      className={cn("p-4", !hasExplicitMargin && "mb-3", className)}
      {...props}
    />
  );
}

const PLATFORM_ICONS = { facebook: "", instagram: "", linkedin: "", gbp: "" };

// Autonomous run + credential health statuses. compliance_rejected belongs here
// too: content-scheduler.js:746 writes it when the compliance judge parks a post.
function statusTone(value) {
  return ["failed", "error", "expired", "compliance_rejected"].includes(value) ? "alert" : "neutral";
}

// Raw platform keys came off the API lowercase and were displayed through
// textTransform: "capitalize". The shared type stack drops that, so the label
// has to be built rather than styled.
const PLATFORM_HEALTH_LABELS = { healthy: "Healthy", expired: "Expired", error: "Error", not_configured: "Not configured" };
const PLATFORM_LABELS = { gbp: "GBP", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", gemini: "Gemini", x: "X", tiktok: "TikTok", youtube: "YouTube" };
function platformLabel(key, overrides = {}) {
  if (overrides[key]) return overrides[key];
  if (PLATFORM_LABELS[key]) return PLATFORM_LABELS[key];
  return typeof key === "string" && key ? key.charAt(0).toUpperCase() + key.slice(1) : key;
}

// A history row is only an alert when the publish actually failed. draft,
// scheduled and dry_run are routine workflow states (social-content-studio.js
// creates drafts, content-scheduler.js creates scheduled rows).
// compliance_rejected is persisted by content-scheduler.js:746 when the
// compliance judge parks a scheduled post — a genuine publishing failure, not a
// routine workflow state.
const FAILED_POST_STATUSES = ["failed", "error", "expired", "rejected", "compliance_rejected"];
function postStatusTone(value) {
  return FAILED_POST_STATUSES.includes(value) ? "alert" : "neutral";
}
const SOCIAL_TABS = [
  {
    key: "campaigns",
    label: "Campaign Builder",
    Icon: Sparkles,
  },
  {
    key: "audit",
    label: "Run Audit",
    Icon: Activity,
  },
  {
    key: "reviews",
    label: "Review Graphics",
    Icon: Star,
  },
  {
    key: "competitors",
    label: "Competitor Swipe",
    Icon: TrendingUp,
  },
  {
    key: "compose",
    label: "Compose & Publish",
    Icon: PenSquare,
  },
  {
    key: "rss",
    label: "RSS Feed",
    Icon: Rss,
  },
  {
    key: "calendar",
    label: "Calendar",
    Icon: CalendarDays,
  },
  {
    key: "analytics",
    label: "Analytics",
    Icon: BarChart3,
  },
  {
    key: "templates",
    label: "Templates",
    Icon: FileText,
  },
  {
    key: "history",
    label: "Post History",
    Icon: History,
  },
];

// The 10-tab bar is grouped into parent sections, each revealing its leaf tabs
// in a sub-row. `tab` state still holds the LEAF key, so every
// {tab === "..."} render block below is unchanged.
const SOCIAL_TAB_GROUPS = [
  {
    key: "studio",
    label: "Studio",
    Icon: PenSquare,
    tabs: ["campaigns", "compose", "templates"],
  },
  {
    key: "posts",
    label: "Posts",
    Icon: CalendarDays,
    tabs: ["calendar", "history"],
  },
  {
    key: "automation",
    label: "Automation",
    Icon: Activity,
    tabs: ["rss", "audit"],
  },
  {
    key: "reviews",
    label: "Review Graphics",
    Icon: Star,
    tabs: ["reviews"],
  },
  {
    key: "competitors",
    label: "Competitors",
    Icon: TrendingUp,
    tabs: ["competitors"],
  },
  {
    key: "analytics",
    label: "Analytics",
    Icon: BarChart3,
    tabs: ["analytics"],
  },
];
const SOCIAL_LEAF_BY_KEY = Object.fromEntries(
  SOCIAL_TABS.map((s) => [s.key, s]),
);
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
// The summary line's optional-chain fallbacks are what pushed this function over
// the complexity limit; deriving them once keeps the component a render.
function metaHealthSummary(health) {
  const facebook = health?.credentials?.find((cred) => cred.platform === "facebook");
  const instagram = health?.credentials?.find((cred) => cred.platform === "instagram");
  if (!facebook && !instagram) return null;
  const fbDetails = facebook?.details || {};
  const igDetails = instagram?.details || {};
  const quota = Number(igDetails.quotaUsage);
  return {
    healthy: facebook?.status === "healthy" && instagram?.status === "healthy",
    pageName: fbDetails.pageName || "Page check",
    linkedIg: fbDetails.linkedInstagramUsername ? `@${fbDetails.linkedInstagramUsername}` : "No linked IG",
    igLabel: igDetails.username ? `@${igDetails.username}` : "Instagram",
    quotaLabel: igDetails.quotaUsage != null && Number.isFinite(quota) ? `Quota used: ${igDetails.quotaUsage}` : "Quota available",
  };
}

function MetaHealthStrip({ health, onRefresh }) {
  const summary = metaHealthSummary(health);
  if (!summary) return null;
  const { healthy, pageName, linkedIg, igLabel, quotaLabel } = summary;
  return (
    <Card
      className={cn(
        "-mt-2 mb-5 flex items-center justify-between gap-3 border-l-4 flex-wrap",
        healthy ? "border-l-zinc-900" : "border-l-zinc-400",
      )}
    >
      <div>
        <div className="text-ui-body font-medium text-zinc-900">
          Meta Publishing Health
        </div>
        <div className="text-ui-body text-ink-secondary mt-1">
          Facebook: {pageName} · Linked IG: {linkedIg}{" "}
          · Instagram: {igLabel} · {quotaLabel}
        </div>
        {health?.checkedAt && (
          <div className="text-ui-body text-ink-secondary mt-[3px]">
            Checked{" "}
            {new Date(health.checkedAt).toLocaleString("en-US", {
              timeZone: "America/New_York",
            })}
          </div>
        )}
      </div>
      <Button onClick={onRefresh}>Refresh</Button>
    </Card>
  );
}
// Extracted so the page component itself stays under the configured complexity
// maximum: the automation banner alone carried four status branches and the
// pause control two more.
function AUTOMATION_LABEL(automation) {
  if (automation.paused) return "Paused";
  if (automation.dryRun) return "Dry Run";
  return automation.enabled ? "Active" : "Disabled";
}

// Table-driven so adding a tab does not add a branch to the page component.
const TAB_BODIES = {
  campaigns: ({ showToast, loadData }) => <CampaignBuilderTab showToast={showToast} onSaved={loadData} />,
  audit: ({ showToast, loadData }) => <AutonomousRunAuditTab showToast={showToast} onRan={loadData} />,
  reviews: ({ showToast }) => <ReviewGraphicsTab showToast={showToast} />,
  competitors: ({ showToast }) => <CompetitorSwipeTab showToast={showToast} />,
  compose: ({ showToast, loadData }) => <ComposeTab showToast={showToast} onPublished={loadData} />,
  rss: ({ showToast, loadData }) => <RSSTab showToast={showToast} onPublished={loadData} />,
  calendar: () => <CalendarTab />,
  analytics: () => <AnalyticsTab />,
  templates: ({ showToast }) => <TemplatesTab showToast={showToast} />,
  history: ({ history, loadData }) => <HistoryTab history={history} onRefresh={loadData} />,
};

function TabBody(props) {
  const render = TAB_BODIES[props.tab];
  return render ? render(props) : null;
}

function FailureAlertBanner({ alert, onDismiss }) {
  if (!alert) return null;
  return (
      <Card className="mb-3 flex items-center justify-between gap-3 border-alert-fg bg-alert-bg border-l-4">
        <div>
          <div className="text-ui-body font-medium text-alert-fg">
            {alert.message}
          </div>
          <div className="text-ui-body text-ink-secondary">
            Since{" "}
            {new Date(alert.raised_at).toLocaleString("en-US", {
              timeZone: "America/New_York",
            })}
          </div>
        </div>
        <Button onClick={onDismiss} variant="secondary">
          Dismiss
        </Button>
      </Card>
  );
}

function AutomationStatusBanner({ automation, pauseLoading, onTogglePause }) {
  if (!automation) return null;
  return (
      <Card
        className={cn(
          "mb-4 flex items-center justify-between border-l-4 flex-wrap gap-3",
          automation.paused
            ? "border-l-alert-fg"
            : automation.enabled
              ? "border-l-zinc-900"
              : "border-l-zinc-400",
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-2.5 h-2.5 rounded-full",
              automation.paused ? "bg-alert-fg" : "bg-zinc-900",
            )}
          />
          <div>
            <div className="text-ui-body font-medium text-zinc-900">
              Automation: {AUTOMATION_LABEL(automation)}
            </div>
            <div className="text-ui-body text-ink-secondary">
              RSS: {automation.rssAutopublish ? "On" : "Off"} ·{" "}
              Scheduled: {automation.scheduledPosts ? "On" : "Off"} ·{" "}
              Newsletter:{" "}
              {automation.newsletterAutoshare ? "On" : "Off"}
            </div>
          </div>
        </div>
        {automation.enabled && (
          <Button onClick={onTogglePause} disabled={pauseLoading}>
            {pauseLoading
              ? "..."
              : automation.paused
                ? "Resume"
                : "Pause All"}
          </Button>
        )}
      </Card>
  );
}

export default function SocialMediaPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedTab = searchParams.get("tab");
  const tab = Object.hasOwn(SOCIAL_LEAF_BY_KEY, requestedTab) ? requestedTab : "campaigns";
  const setTab = useCallback(
    (nextTab) => {
      if (!Object.hasOwn(SOCIAL_LEAF_BY_KEY, nextTab) || nextTab === tab) return;
      const next = new URLSearchParams(searchParams);
      next.set("tab", nextTab);
      navigate({
        pathname: location.pathname,
        search: `?${next.toString()}`,
        hash: location.hash,
      });
    },
    [location.hash, location.pathname, navigate, searchParams, tab],
  );
  const activeGroup =
    SOCIAL_TAB_GROUPS.find((g) => g.tabs.includes(tab)) || SOCIAL_TAB_GROUPS[0];
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
    <UiSurface density="comfortable" className="max-w-[1300px] mx-auto text-ui-body text-ink-primary">
      {" "}
      <AdminCommandHeader
        title="Social media"
        icon={Share2}
        sections={SOCIAL_TAB_GROUPS.map((g) => ({
          key: g.key,
          label: g.label,
          Icon: g.Icon,
        }))}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = SOCIAL_TAB_GROUPS.find((x) => x.key === key);
          if (g) setTab(g.tabs[0]);
        }}
        ariaLabel="Social Media section"
        navGridClassName="grid-cols-2 md:grid-cols-3 xl:grid-cols-6"
        variant="workspace"
      />
      {activeGroup.tabs.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {activeGroup.tabs.map((key) => {
            const leaf = SOCIAL_LEAF_BY_KEY[key];
            const active = tab === key;
            const LeafIcon = leaf.Icon;
            return (
              <Button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                variant={active ? "primary" : "secondary"}
                className="gap-1.5"
              >
                <LeafIcon size={14} strokeWidth={1.9} />
                {leaf.label}
              </Button>
            );
          })}
        </div>
      )}
      <FailureAlertBanner
        alert={alert}
        onDismiss={async () => {
          await adminFetch("/admin/social-media/alerts", {
                method: "DELETE",
              }).catch(() => {});
          setAlert(null);
          showToast("Alert dismissed");
        }}
      />
      <AutomationStatusBanner
        automation={status?.automation}
        pauseLoading={pauseLoading}
        onTogglePause={async () => {
          setPauseLoading(true);
          try {
            await adminFetch("/admin/social-media/pause", {
                    method: "POST",
                    body: JSON.stringify({
                      paused: !status.automation.paused,
                    }),
                  });
            await loadData();
            showToast(status.automation.paused ? "Automation resumed" : "Automation paused");
          } catch {
            showToast("Failed to toggle pause");
          } finally {
            setPauseLoading(false);
          }
        }}
      />
      {/* Platform health + connection status */}
      {status && (
        <div className="flex gap-2.5 mb-5 flex-wrap">
          {Object.entries(status.platforms).map(([key, p]) => {
            const cred = health?.credentials?.find(
              (c) => c.platform === key || c.platform === `${key}_lwr`,
            );
            const healthStatus =
              cred?.status || (p.configured ? "unknown" : "not_configured");
            const disabled = !p.enabled && key !== "ai" && key !== "gemini";
            const statusLabel = disabled ? "Disabled" : PLATFORM_HEALTH_LABELS[healthStatus] || "Unknown";
            // Disabled wins over the credential state: an expired token on a
            // platform nobody is publishing to is not actionable, and main
            // overrode the credential colour to muted whenever enabled was false.
            const statusBadgeTone = disabled ? "neutral" : statusTone(healthStatus);
            return (
              <Card
                key={key}
                className="flex-[1_1_140px] min-w-[140px] mb-0 text-center"
              >
                <div className="text-ui-body font-medium text-zinc-900">
                  {platformLabel(key)}
                </div>
                <div className="mt-1">
                  <Badge tone={statusBadgeTone}>{statusLabel}</Badge>
                </div>
                {cred?.lastError && healthStatus !== "healthy" && (
                  <div
                    title={cred.lastError}
                    className="text-ui-body text-ink-secondary mt-1 overflow-hidden text-ellipsis whitespace-nowrap max-w-[140px]"
                  >
                    {cred.lastError}
                  </div>
                )}
              </Card>
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
        <div className="flex gap-2.5 mb-5 flex-wrap">
          {[
            { label: "Total Posts", value: stats.total },
            { label: "Published", value: stats.published },
            { label: "Failed", value: stats.failed, alert: stats.failed > 0 },
            { label: "Last 7d", value: stats.last7d },
          ].map((s) => (
            <Card
              key={s.label}
              className="flex-[1_1_120px] min-w-[120px] mb-0 text-center"
            >
              {" "}
              <div
                className={cn(
                  "text-22 font-medium u-nums",
                  s.alert && "text-alert-fg",
                )}
              >
                {s.value}
              </div>{" "}
              <div className="text-ui-body text-ink-secondary mt-0.5">
                {s.label}
              </div>{" "}
            </Card>
          ))}
        </div>
      )}
      <TabBody tab={tab} showToast={showToast} loadData={loadData} history={history} />
      <div
        style={{
          transform: toast ? "translateY(0)" : "translateY(-80px)",
          opacity: toast ? 1 : 0,
        }}
        className="fixed top-[calc(20px+env(safe-area-inset-top,0px))] right-5 bg-white border-hairline border-zinc-300 rounded-md px-4 py-2.5 flex items-center gap-2 z-[300] text-ui-body transition-all pointer-events-none"
      >
        {" "}
        <span className="text-zinc-900">{toast}</span>{" "}
      </div>{" "}
    </UiSurface>
  );
}

// LinkedIn is intentionally omitted until the LinkedIn app/page access is
// approved and publishToAll can actually post there — otherwise an admin could
// select it, generate LinkedIn copy, and have the publish silently skip it.
const CAMPAIGN_CHANNELS = ["gbp", "facebook", "instagram"];
const CAMPAIGN_CITIES = [
  "Sarasota",
  "Bradenton",
  "Lakewood Ranch",
  "Parrish",
  "Venice",
  "Port Charlotte",
  "North Port",
];
const CAMPAIGN_SERVICES = [
  "termite",
  "lawn care",
  "mosquito",
  "general pest",
  "rodent",
  "tree and shrub",
];
const CAMPAIGN_ANGLES = [
  "what we are seeing",
  "signs to check",
  "myth/fact",
  "new Florida homeowner",
  "do not ignore this",
];
const CAMPAIGN_CTAS = [
  "book inspection",
  "request estimate",
  "read guide",
  "call button",
];
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
    <label className="text-ui-body text-ink-secondary block mb-1">
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
    <div className="flex gap-2 flex-wrap">
      {CAMPAIGN_CHANNELS.map((channel) => (
        <label
          key={channel}
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-2 rounded-md border-hairline text-ui-body cursor-pointer",
            channels.includes(channel)
              ? "border-zinc-900 bg-zinc-50 text-zinc-900"
              : "border-zinc-300 bg-white text-ink-secondary",
          )}
        >
          <Checkbox
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
// The run-outcome and enablement ladders are what put this panel over the
// complexity limit; both are pure functions of the response and the status.
function autonomousRunMessage(result, mode) {
  if (result.skipped) return `Autonomous run skipped: ${result.reason}`;
  if (result.dryRun) return "Autonomous dry run completed";
  return mode === "draft" ? "Autonomous draft created" : "Autonomous publish run completed";
}

function autonomousStateLabel(status) {
  if (status?.paused) return "Paused";
  return status?.enabled && status?.globalAutomationEnabled ? "Autonomous" : "Not fully enabled";
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
      showToast(autonomousRunMessage(result, mode));
      load();
      onRan?.();
    } catch (e) {
      showToast(`Autonomous run failed: ${e.message}`);
    } finally {
      setRunning("");
    }
  };
  const latest = status?.latestRun;
  const stateIsAlert = status?.paused;
  const stateLabel = autonomousStateLabel(status);
  return (
    <Card
      className={cn(
        "mb-4 flex justify-between items-center gap-4 border-l-4 flex-wrap",
        stateIsAlert ? "border-l-alert-fg" : "border-l-zinc-900",
      )}
    >
      <div>
        <div className="flex gap-2 items-center mb-1">
          <div className="text-ui-body text-zinc-900 font-medium">
            Autonomous Social Studio
          </div>
          <Badge tone={stateIsAlert ? "alert" : "neutral"}>{stateLabel}</Badge>
          {status?.dryRun && <Badge>Dry run</Badge>}
        </div>
        <div className="text-ui-body text-ink-secondary">
          Mode: {status?.mode || "publish"} · Cadence: every{" "}
          {status?.intervalHours || 24}h · Channels:{" "}
          {(status?.channels || []).join(", ") || "gbp, facebook, instagram"}
        </div>
        {latest && (
          <div className="text-ui-body text-ink-secondary mt-1">
            Last run: {latest.status} · {latest.topic || "no topic"} ·{" "}
            {formatRunDate(latest.started_at)}
          </div>
        )}
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button
          onClick={() => run("draft")}
          disabled={!!running}
          variant="secondary"
        >
          {running === "draft" ? "Running..." : "Run Draft"}
        </Button>
        <Button onClick={() => run("publish")} disabled={!!running}>
          {running === "publish" ? "Running..." : "Run Publish"}
        </Button>
      </div>
    </Card>
  );
}
// Publishable variants for a draft run: creative-engine runs carry an array in
// preview.visual.variants; legacy single-card drafts collapse to one entry so
// the same approval UI serves both. Mirrors the server's runVariants().
function draftRunVariants(run) {
  const visual = run?.preview?.visual || {};
  if (Array.isArray(visual.variants) && visual.variants.length)
    return visual.variants;
  if (visual.imageUrl || run?.imageUrl)
    return [
      {
        imageUrl: visual.imageUrl || run.imageUrl,
      },
    ];
  return [];
}
function formatRunDate(value) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No timestamp";
  // Portal time is Eastern everywhere — pin the zone so run timestamps don't
  // render in the viewer's local timezone (AGENTS.md America/New_York rule).
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
  });
}
// ── Autonomous Run Audit Tab ──
// One audit row per run. Extracted from the map so the studio tab's arrow stops
// carrying the whole card's branch set (variant choice, video vs still, per-
// platform results and the approve/reject controls all branch independently).
// The draft-review panel — variant chooser, per-channel copy and the
// approve/reject controls — is the bulk of a pending run's branch set, so it
// renders on its own rather than inside the card's arrow.
function AutonomousDraftReview({ run, variants, chosenIdx, chosenVariant, chosenIsVideo, drafts, busy, acting, setVariantChoice, approveRun, rejectRun }) {
  return (
                <div className="mt-3 p-3 rounded-md border-hairline border-zinc-300 bg-zinc-50">
                  <div className="text-ui-body font-medium text-zinc-700">
                    Pending approval
                  </div>

                  {variants.length > 1 && (
                    <div className="flex gap-2 flex-wrap mt-2.5">
                      {variants.map((v, idx) => {
                        const isVideo = v?.type === "video";
                        const src = safeHttpHref(
                          isVideo ? v?.videoUrl : v?.imageUrl,
                        );
                        if (!src) return null;
                        const selected = idx === chosenIdx;
                        return (
                          <Button
                            key={`${run.id}-variant-${idx}`}
                            type="button"
                            onClick={() =>
                              setVariantChoice((prev) => ({
                                ...prev,
                                [run.id]: idx,
                              }))
                            }
                            title={v?.conceptKey || `Variant ${idx + 1}`}
                            variant="secondary"
                            className={cn(
                              "p-0 rounded-md cursor-pointer leading-none relative",
                              selected
                                ? "ring-2 ring-zinc-900"
                                : "opacity-75",
                            )}
                          >
                            {isVideo ? (
                              <video
                                src={src}
                                muted
                                playsInline
                                className="w-[84px] h-[84px] object-cover rounded-sm pointer-events-none"
                              />
                            ) : (
                              <img
                                src={src}
                                alt={v?.conceptKey || `Variant ${idx + 1}`}
                                className="w-[84px] h-[84px] object-cover rounded-sm"
                              />
                            )}
                            {isVideo && (
                              <Badge className="absolute bottom-1 left-1 leading-[14px]">
                                ▶ REEL
                              </Badge>
                            )}
                          </Button>
                        );
                      })}
                    </div>
                  )}

                  {Object.keys(drafts).length > 0 && (
                    <div className="mt-2.5 grid gap-1.5">
                      {Object.entries(drafts).map(([platform, text]) => (
                        <div
                          key={`${run.id}-draft-${platform}`}
                          className="rounded-md px-2.5 py-2 bg-white border-hairline border-zinc-200"
                        >
                          <div className="text-ui-body font-medium text-ink-secondary mb-1">
                            {platformLabel(platform)}
                          </div>
                          <div className="text-ui-body text-zinc-900 whitespace-pre-wrap max-h-[110px] overflow-y-auto">
                            {String(text || "")}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {Array.isArray(run.preview?.sources) &&
                    run.preview.sources.length > 0 && (
                      <div className="mt-2.5 grid gap-1.5">
                        <div className="text-ui-body font-medium text-ink-secondary">
                          Source facts
                        </div>
                        {run.preview.sources.map((source, index) => (
                          <div
                            key={`${run.id}-source-${index}`}
                            className="flex gap-1.5 items-baseline text-ui-body leading-[1.45]"
                          >
                            <Badge>{source.type}</Badge>
                            <span className="text-ink-secondary">
                              <span className="text-zinc-900 font-medium">
                                {source.label}
                              </span>
                              {source.detail ? ` — ${source.detail}` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                  <div className="flex gap-2 mt-3 flex-wrap">
                    <Button
                      onClick={() => approveRun(run)}
                      disabled={busy || !variants.length}
                    >
                      {acting === `approve-${run.id}`
                        ? "Publishing..."
                        : "Approve & Publish"}
                    </Button>
                    <Button
                      onClick={() => rejectRun(run)}
                      disabled={busy}
                      variant="danger"
                    >
                      {acting === `reject-${run.id}`
                        ? "Rejecting..."
                        : "Reject"}
                    </Button>
                    {run.preview?.visual?.creative?.conceptKey && (
                      <span className="text-ui-body text-ink-secondary self-center">
                        scene:{" "}
                        {variants[chosenIdx]?.conceptKey ||
                          run.preview.visual.creative.conceptKey}
                      </span>
                    )}
                  </div>
                </div>
  );
}

// Per-platform outcome rows: each result independently branches on location,
// success, dryRun and skipped, which is most of what was left in the card.
function AutonomousPlatformResults({ run, platformResults }) {
  return (
                <div className="mt-3 grid gap-1.5">
                  {platformResults.map((result, index) => {
                    const label = result.location
                      ? `${result.platform}/${result.location}`
                      : result.platform;
                    const detail = result.success
                      ? "posted"
                      : result.dryRun
                        ? "dry run"
                        : result.skipped
                          ? "skipped"
                          : result.error || "failed";
                    return (
                      <div
                        key={`${run.id}-${label}-${index}`}
                        className="flex justify-between gap-2.5 px-[9px] py-[7px] rounded-md border-hairline border-zinc-200 text-ui-body"
                      >
                        <span className="text-zinc-900 font-medium">
                          {label || "platform"}
                        </span>
                        <span
                          className={
                            !result.success &&
                            !result.dryRun &&
                            !result.skipped
                              ? "text-alert-fg"
                              : "text-ink-secondary"
                          }
                        >
                          {detail}
                        </span>
                      </div>
                    );
                  })}
                </div>
  );
}

// Which media a run row shows, and which variant it is showing, is a ladder of
// its own: a pending draft follows the operator's variant choice, a published
// run prefers the Reel it actually shipped over the fallback still.
function autonomousRunMedia(run, variantChoice) {
  const isPendingDraft = run.status === "draft_created";
  const variants = isPendingDraft ? draftRunVariants(run) : [];
  const chosenIdx = Math.min(variantChoice[run.id] ?? 0, Math.max(0, variants.length - 1));
  const chosenVariant = isPendingDraft && variants.length ? variants[chosenIdx] : null;
  const publishedVideoUrl = isPendingDraft ? null : safeHttpHref(run.preview?.visual?.videoUrl);
  const chosenIsVideo = chosenVariant ? chosenVariant.type === "video" : !!publishedVideoUrl;
  const chosenMedia = chosenVariant && (chosenIsVideo ? chosenVariant.videoUrl : chosenVariant.imageUrl);
  return {
    isPendingDraft, variants, chosenIdx, chosenVariant, chosenIsVideo,
    displayImage: chosenVariant ? chosenMedia : publishedVideoUrl || run.imageUrl,
  };
}

// Three independent optional links/ids; pulling them out keeps the card's own
// branch count under the configured maximum.
function AutonomousRunLinks({ run }) {
  return (
              <div className="flex gap-3 mt-3 flex-wrap text-ui-body">
                {safeHttpHref(run.imageUrl) && (
                  <a
                    href={safeHttpHref(run.imageUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-900"
                  >
                    Open image
                  </a>
                )}
                {safeHttpHref(run.post?.sourceUrl) && (
                  <a
                    href={safeHttpHref(run.post.sourceUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-900"
                  >
                    Open source
                  </a>
                )}
                {run.socialMediaPostId && (
                  <span className="text-ink-secondary">
                    Post ID: {run.socialMediaPostId}
                  </span>
                )}
              </div>
  );
}

function AutonomousRunHeading({ run }) {
  return (
    <div className="flex justify-between items-start gap-3 flex-wrap">
      <div>
        <div className="text-ui-body font-medium text-zinc-900">
          {run.topic || run.post?.title || "Autonomous social run"}
        </div>
        <div className="text-ui-body text-ink-secondary mt-1">
          {[run.city, run.service, run.mode].filter(Boolean).join(" · ")} · {formatRunDate(run.startedAt)}
        </div>
      </div>
      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
    </div>
  );
}

function AutonomousRunCard({ run, variantChoice, setVariantChoice, acting, approveRun, rejectRun, isMobile }) {
          const platformResults = run.platformResults || [];
          const channels = run.channels?.length
            ? run.channels
            : parseMaybeJson(run.preview?.inputs?.channels, []);
          const { isPendingDraft, variants, chosenIdx, chosenVariant, chosenIsVideo, displayImage } =
            autonomousRunMedia(run, variantChoice);
          const drafts = run.preview?.drafts || {};
          const busy =
            acting === `approve-${run.id}` || acting === `reject-${run.id}`;
          return (
            <Card
              key={run.id}
              style={{
                gridTemplateColumns:
                  isMobile || !displayImage ? "1fr" : "1fr 150px",
              }}
              className={cn(
                "mb-0 grid gap-4 border-l-4",
                statusTone(run.status) === "alert"
                  ? "border-l-alert-fg"
                  : "border-l-zinc-300",
              )}
            >
              <div>
                <AutonomousRunHeading run={run} />

                <div className="flex gap-1.5 flex-wrap mt-2.5">
                  {channels.map((channel) => (
                    <Badge key={`${run.id}-${channel}`}>
                      {channel === "gbp" ? "GBP" : channel}
                    </Badge>
                  ))}
                  {run.post?.status && <Badge>post {run.post.status}</Badge>}
                </div>

                {run.skipReason && (
                  // The reason follows its own row's status: a disabled, paused
                  // or human-rejected run is routine and reads in the secondary
                  // ink, the way its badge already does; only a real failure is
                  // alert red.
                  <div className={cn("mt-2.5 text-ui-body", statusTone(run.status) === "alert" ? "text-alert-fg" : "text-ink-secondary")}>
                    {run.skipReason}
                  </div>
                )}

                {isPendingDraft && (
                  <AutonomousDraftReview
                    run={run}
                    variants={variants}
                    chosenIdx={chosenIdx}
                    chosenVariant={chosenVariant}
                    chosenIsVideo={chosenIsVideo}
                    drafts={drafts}
                    busy={busy}
                    acting={acting}
                    setVariantChoice={setVariantChoice}
                    approveRun={approveRun}
                    rejectRun={rejectRun}
                  />
                )}

                {platformResults.length > 0 && (
                  <AutonomousPlatformResults run={run} platformResults={platformResults} />
                )}

                <AutonomousRunLinks run={run} />
              </div>

              {safeHttpHref(displayImage) &&
                (chosenIsVideo ? (
                  <video
                    src={safeHttpHref(displayImage)}
                    controls
                    muted
                    playsInline
                    className="w-full aspect-[9/16] object-cover rounded-md border-hairline border-zinc-200 bg-zinc-100"
                  />
                ) : (
                  <a
                    href={safeHttpHref(displayImage)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <img
                      src={safeHttpHref(displayImage)}
                      alt=""
                      className="w-full aspect-square object-cover rounded-md border-hairline border-zinc-200 bg-zinc-100"
                    />
                  </a>
                ))}
            </Card>
          );
}

function AutonomousRunAuditTab({ showToast, onRan }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState({
    runs: [],
  });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState("");
  const [variantChoice, setVariantChoice] = useState({}); // runId → selected variant index
  const [acting, setActing] = useState(""); // "approve-<id>" | "reject-<id>" while in flight

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/social-media/autonomous/runs?limit=30")
      .then(setData)
      .catch(() =>
        setData({
          runs: [],
        }),
      )
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
      else
        showToast(
          mode === "draft"
            ? "Autonomous draft created"
            : "Autonomous publish run completed",
        );
      load();
      onRan?.();
    } catch (e) {
      showToast(`Autonomous run failed: ${e.message}`);
    } finally {
      setRunning("");
    }
  };
  const approveRun = async (run) => {
    setActing(`approve-${run.id}`);
    try {
      const result = await adminFetch(`/admin/social-media/autonomous/runs/${run.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ variantIndex: variantChoice[run.id] ?? 0 }),
      });
      if (result.published) showToast("Draft approved and published");
      else if (result.dryRun)
        showToast("Approve ran in dry-run mode — not published");
      else showToast("Approve attempted — publish did not succeed, draft kept");
      load();
      onRan?.();
    } catch (e) {
      showToast(`Approve failed: ${e.message}`);
    } finally {
      setActing("");
    }
  };
  const rejectRun = async (run) => {
    setActing(`reject-${run.id}`);
    try {
      await adminFetch(`/admin/social-media/autonomous/runs/${run.id}/reject`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast("Draft rejected");
      load();
      onRan?.();
    } catch (e) {
      showToast(`Reject failed: ${e.message}`);
    } finally {
      setActing("");
    }
  };
  const runs = data.runs || [];
  const failed = runs.filter((run) => run.status === "failed").length;
  const pending = runs.filter((run) => run.status === "draft_created").length;
  const completed = runs.filter((run) =>
    ["published", "draft_created", "dry_run"].includes(run.status),
  ).length;
  const lastRun = runs[0];
  return (
    <div>
      <Card className="flex justify-between items-center gap-4 flex-wrap">
        <div>
          <div className="text-ui-body font-medium text-zinc-900">
            Autonomous Run Audit
          </div>
          <div className="text-ui-body text-ink-secondary mt-1">
            Last run:{" "}
            {lastRun
              ? `${lastRun.status} · ${formatRunDate(lastRun.startedAt)}`
              : "none"}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={load} disabled={loading} variant="secondary">
            Refresh
          </Button>
          <Button
            onClick={() => runNow("draft")}
            disabled={!!running}
            variant="secondary"
          >
            {running === "draft" ? "Running..." : "Run Draft"}
          </Button>
          <Button
            onClick={() => runNow("publish")}
            disabled={!!running}
            style={{
              opacity: running ? 0.5 : 1,
            }}
          >
            {running === "publish" ? "Running..." : "Run Publish"}
          </Button>
        </div>
      </Card>

      <div className="flex gap-2.5 mb-4 flex-wrap">
        {[
          { label: "Runs", value: runs.length },
          { label: "Pending Approval", value: pending },
          { label: "Completed", value: completed },
          { label: "Failed", value: failed, alert: failed > 0 },
          {
            label: "With Images",
            value: runs.filter((run) => run.imageUrl).length,
          },
        ].map((item) => (
          <Card
            key={item.label}
            className="flex-[1_1_140px] min-w-[140px] mb-0 text-center"
          >
            <div
              className={cn(
                "text-22 font-medium u-nums",
                item.alert && "text-alert-fg",
              )}
            >
              {item.value}
            </div>
            <div className="text-ui-body text-ink-secondary mt-0.5">
              {item.label}
            </div>
          </Card>
        ))}
      </div>

      {loading ? (
        <div className="text-ink-secondary p-10 text-center">
          Loading autonomous runs...
        </div>
      ) : runs.length === 0 ? (
        <Card className="text-center text-ink-secondary">
          No autonomous social studio runs yet.
        </Card>
      ) : (
        <div className="grid gap-3">
          {runs.map((run) => (
            <AutonomousRunCard
              key={run.id}
              run={run}
              variantChoice={variantChoice}
              setVariantChoice={setVariantChoice}
              acting={acting}
              approveRun={approveRun}
              rejectRun={rejectRun}
              isMobile={isMobile}
            />
          ))}
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
  const update = (key, value) =>
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }));
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
          gridTemplateColumns: isMobile ? "1fr" : "360px 1fr",
        }}
        className="grid gap-4"
      >
        <div>
          <Card>
            <div className="text-ui-body font-medium text-zinc-900 mb-3.5">
              Local Campaign
            </div>
            <div className="mb-3">
              <FieldLabel>Topic</FieldLabel>
              <Input
                value={form.topic}
                onChange={(e) => update("topic", e.target.value)}
                placeholder="termite swarm season"
              />
            </div>
            <div className="grid [grid-template-columns:1fr_1fr] gap-2.5 mb-3">
              <div>
                <FieldLabel>City</FieldLabel>
                <Select
                  value={form.city}
                  onChange={(e) => update("city", e.target.value)}
                >
                  {CAMPAIGN_CITIES.map((city) => (
                    <option key={city}>{city}</option>
                  ))}
                </Select>
              </div>
              <div>
                <FieldLabel>Service</FieldLabel>
                <Select
                  value={form.service}
                  onChange={(e) => update("service", e.target.value)}
                >
                  {CAMPAIGN_SERVICES.map((service) => (
                    <option key={service}>{service}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid [grid-template-columns:1fr_1fr] gap-2.5 mb-3">
              <div>
                <FieldLabel>Angle</FieldLabel>
                <Select
                  value={form.angle}
                  onChange={(e) => update("angle", e.target.value)}
                >
                  {CAMPAIGN_ANGLES.map((angle) => (
                    <option key={angle}>{angle}</option>
                  ))}
                </Select>
              </div>
              <div>
                <FieldLabel>CTA</FieldLabel>
                <Select
                  value={form.cta}
                  onChange={(e) => update("cta", e.target.value)}
                >
                  {CAMPAIGN_CTAS.map((cta) => (
                    <option key={cta}>{cta}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="mb-4">
              <FieldLabel>Channels</FieldLabel>
              <ChannelToggles
                channels={form.channels}
                onChange={(value) => update("channels", value)}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={generate} disabled={loading} className="flex-1">
                {loading ? "Generating..." : "Generate Drafts"}
              </Button>
              <Button
                onClick={saveDraft}
                disabled={!preview || saving}
                variant="secondary"
                className="flex-1"
              >
                {saving ? "Saving..." : "Save Draft"}
              </Button>
            </div>
          </Card>

          {preview?.sources?.length > 0 && (
            <Card>
              <div className="text-ui-body font-medium text-zinc-900 mb-2.5">
                Source Facts
              </div>
              <div className="grid gap-2">
                {preview.sources.map((source, index) => (
                  <div
                    key={`${source.type}-${index}`}
                    className={cn(
                      index > 0 &&
                        "pt-2 border-t border-hairline border-zinc-200",
                    )}
                  >
                    <div className="flex gap-1.5 items-center mb-[3px]">
                      <Badge>{source.type}</Badge>
                      <span className="text-ui-body font-medium text-zinc-900">
                        {source.label}
                      </span>
                    </div>
                    <div className="text-ui-body text-ink-secondary leading-[1.45]">
                      {source.detail}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div>
          {!preview ? (
            <Card className="min-h-[280px] grid place-items-center text-ink-secondary text-center">
              <div>
                <div className="text-ui-body text-zinc-900 font-medium mb-1.5">
                  Build autonomous local posts
                </div>
                <div className="text-ui-body">
                  The studio uses service facts, content history, pest pressure
                  language, review proof, and competitor patterns.
                </div>
              </div>
            </Card>
          ) : (
            <div className="grid gap-3">
              {Object.entries(drafts).map(([platform, text]) => {
                const validation = preview.validation?.[platform];
                return (
                  <Card
                    key={platform}
                    className="mb-0 border-l-[3px] border-l-zinc-900"
                  >
                    <div className="flex justify-between gap-3 mb-2">
                      <div className="text-ui-body font-medium text-zinc-900">
                        {platformLabel(platform, { gbp: "Google Business Profile" })}
                      </div>
                      <Badge
                        tone={validation?.valid === false ? "alert" : "neutral"}
                      >
                        {validation?.valid === false ? "Needs edit" : "Clear"}
                      </Badge>
                    </div>
                    <Textarea
                      value={text}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [platform]: e.target.value,
                        }))
                      }
                      rows={platform === "instagram" ? 7 : 5}
                      className="resize-y leading-normal"
                    />
                    {validation?.issues?.length > 0 && (
                      <div className="mt-2 text-alert-fg text-ui-body">
                        {validation.issues.join("; ")}
                      </div>
                    )}
                  </Card>
                );
              })}
              {preview.suggestedLink && (
                <Card className="mb-0 text-ui-body text-ink-secondary">
                  Suggested link:{" "}
                  {safeHttpHref(preview.suggestedLink) ? (
                    <a
                      href={safeHttpHref(preview.suggestedLink)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-900"
                    >
                      {preview.suggestedLink}
                    </a>
                  ) : (
                    <span>{preview.suggestedLink}</span>
                  )}
                </Card>
              )}
              {safeHttpHref(preview.visual?.imageUrl) && (
                <Card className="mb-0 text-ui-body text-ink-secondary">
                  Visual card:{" "}
                  <a
                    href={safeHttpHref(preview.visual.imageUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-900"
                  >
                    Open rendered image
                  </a>
                </Card>
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
  const [data, setData] = useState({
    candidates: [],
    saved: [],
  });
  const [loading, setLoading] = useState(true);
  const [privacy, setPrivacy] = useState({});
  const [savingId, setSavingId] = useState(null);
  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/social-media/review-graphics?limit=30")
      .then(setData)
      .catch(() =>
        setData({
          candidates: [],
          saved: [],
        }),
      )
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
    return (
      <div className="text-ink-secondary p-10 text-center">
        Loading review graphics...
      </div>
    );
  }
  return (
    <div
      style={{
        gridTemplateColumns: isMobile ? "1fr" : "1fr 360px",
      }}
      className="grid gap-4"
    >
      <div>
        <div className="text-ui-body font-medium text-zinc-900 mb-3">
          Eligible 5-star Reviews
        </div>
        <div className="grid gap-2.5">
          {(data.candidates || []).map((candidate) => (
            <Card key={candidate.googleReviewId} className="mb-0">
              <div className="flex justify-between gap-3 mb-2">
                <div>
                  <div className="text-ui-body font-medium text-zinc-900">
                    {candidate.reviewerDisplayName}
                  </div>
                  <div className="text-ui-body text-ink-secondary">
                    5-star Google review - {candidate.city}
                  </div>
                </div>
                <Badge>No photo by default</Badge>
              </div>
              <div className="text-ui-body text-zinc-900 leading-[1.55] mb-3">
                "{candidate.excerpt}"
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                <Select
                  value={privacy[candidate.googleReviewId] || "first_name_city"}
                  onChange={(e) =>
                    setPrivacy((prev) => ({
                      ...prev,
                      [candidate.googleReviewId]: e.target.value,
                    }))
                  }
                  className="w-[190px]"
                >
                  <option value="first_name_city">First name + city</option>
                  <option value="initials">Initials + city</option>
                  <option value="anonymous">Anonymous + city</option>
                </Select>
                <Button
                  onClick={() => createGraphic(candidate)}
                  disabled={savingId === candidate.googleReviewId}
                >
                  {savingId === candidate.googleReviewId
                    ? "Saving..."
                    : "Create Graphic Draft"}
                </Button>
              </div>
            </Card>
          ))}
          {data.candidates?.length === 0 && (
            <Card className="text-center text-ink-secondary">
              No eligible unsaved 5-star reviews found.
            </Card>
          )}
        </div>
      </div>

      <div>
        <Card className="mb-3">
          <div className="text-ui-body font-medium text-zinc-900 mb-2.5">
            Graphic Preview
          </div>
          <div className="aspect-square bg-zinc-100 rounded-md border-hairline border-zinc-200 p-6 flex flex-col justify-between">
            <div>
              <div className="text-ui-body text-ink-secondary">
                Waves Pest Control
              </div>
              <div className="text-[24px] text-zinc-900 font-medium mt-2.5">
                5-star Google review
              </div>
            </div>
            <div className="text-ui-body leading-[1.45] text-zinc-900">
              "
              {data.candidates?.[0]?.excerpt ||
                "Helpful, professional, and local service."}
              "
            </div>
            <div className="text-ui-body text-ink-secondary">
              {data.candidates?.[0]?.reviewerDisplayName ||
                "Waves customer, Sarasota"}
            </div>
          </div>
        </Card>

        <Card>
          <div className="text-ui-body font-medium text-zinc-900 mb-2.5">
            Saved Graphics
          </div>
          <div className="grid gap-2">
            {(data.saved || []).slice(0, 8).map((graphic) => {
              const channels = parseMaybeJson(graphic.channels, []);
              return (
                <div
                  key={graphic.id}
                  className="pt-2 border-t border-hairline border-zinc-200"
                >
                  <div className="flex justify-between gap-2">
                    <div className="text-ui-body text-zinc-900 font-medium">
                      {graphic.reviewer_display_name}
                    </div>
                    <Badge>{graphic.status}</Badge>
                  </div>
                  <div className="text-ui-body text-ink-secondary mt-[3px]">
                    {channels.join(", ") || "gbp, facebook, instagram"}
                  </div>
                  {graphic.status !== "approved" && (
                    <Button
                      onClick={() => approveGraphic(graphic)}
                      className="mt-2 px-2.5 py-1.5 text-ui-body"
                    >
                      Approve
                    </Button>
                  )}
                  {safeHttpHref(graphic.image_url) && (
                    <a
                      href={safeHttpHref(graphic.image_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ui-body text-zinc-900 mt-2 inline-block"
                    >
                      Open image
                    </a>
                  )}
                </div>
              );
            })}
            {data.saved?.length === 0 && (
              <div className="text-ink-secondary text-ui-body">
                No saved graphics yet.
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Competitor Swipe Tab ──
function CompetitorSwipeTab({ showToast }) {
  const isMobile = useIsMobile();
  const [data, setData] = useState({
    profiles: [],
    posts: [],
    patterns: [],
  });
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
      .catch(() =>
        setData({
          profiles: [],
          posts: [],
          patterns: [],
        }),
      )
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const updateCapture = (key, value) =>
    setCapture((prev) => ({
      ...prev,
      [key]: value,
    }));
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
  const location = (profile) =>
    [profile.city, profile.state].filter(Boolean).join(", ");
  if (loading) {
    return (
      <div className="text-ink-secondary p-10 text-center">
        Loading competitor swipe file...
      </div>
    );
  }
  return (
    <div
      style={{
        gridTemplateColumns: isMobile ? "1fr" : "1fr 420px",
      }}
      className="grid gap-4"
    >
      <div>
        <Card className="mb-4">
          <div className="text-ui-body font-medium text-zinc-900 mb-3">
            Fastest Risers From PCT 2026
          </div>
          <div
            style={{
              gridTemplateColumns: isMobile
                ? "1fr"
                : "repeat(auto-fill, minmax(240px, 1fr))",
            }}
            className="grid gap-2.5"
          >
            {profiles.slice(0, 12).map((profile) => {
              const notes = parseMaybeJson(
                profile.strategic_notes || profile.strategicNotes,
                [],
              );
              return (
                <div
                  key={profile.id || profileName(profile)}
                  className="p-3 rounded-md border-hairline border-zinc-200"
                >
                  <div className="flex justify-between gap-2 mb-1.5">
                    <div className="text-ui-body font-medium text-zinc-900">
                      {profileName(profile)}
                    </div>
                    <Badge>+{growth(profile)}%</Badge>
                  </div>
                  <div className="text-ui-body text-ink-secondary mb-2">
                    {location(profile)}
                  </div>
                  <div className="text-ui-body text-zinc-900 leading-[1.45]">
                    {notes[0] ||
                      "Track hooks, format, visible engagement, and copyable pattern."}
                  </div>
                  <Button
                    onClick={() =>
                      updateCapture("companyName", profileName(profile))
                    }
                    className="mt-2.5 px-2.5 py-1.5 text-ui-body"
                  >
                    Capture Post
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <div className="text-ui-body font-medium text-zinc-900 mb-3">
            Copyable Patterns
          </div>
          <div className="grid gap-2">
            {(data.patterns || []).map((pattern) => (
              <div
                key={pattern.key}
                className="pt-2 border-t border-hairline border-zinc-200"
              >
                <div className="text-ui-body font-medium text-zinc-900">
                  {pattern.label}
                </div>
                <div className="text-ui-body text-ink-secondary leading-[1.45]">
                  {pattern.copyablePattern}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <div className="text-ui-body font-medium text-zinc-900 mb-3">
            Captured Posts
          </div>
          <div className="grid gap-2.5">
            {(data.posts || []).map((post) => (
              <div
                key={post.id}
                className="p-3 rounded-md border-hairline border-zinc-200"
              >
                <div className="flex justify-between gap-2">
                  <div className="text-ui-body font-medium text-zinc-900">
                    {post.company_name}
                  </div>
                  <Badge>Score {post.engagement_score}</Badge>
                </div>
                <div className="text-ui-body text-ink-secondary mt-[3px]">
                  {post.platform} - {post.topic || "uncategorized"} -{" "}
                  {post.creative_format || "post"}
                </div>
                {post.why_it_worked && (
                  <div className="text-ui-body text-zinc-900 mt-2 leading-[1.45]">
                    {post.why_it_worked}
                  </div>
                )}
                {safeHttpHref(post.post_url) && (
                  <a
                    href={safeHttpHref(post.post_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ui-body text-zinc-900 mt-2 inline-block"
                  >
                    Open post
                  </a>
                )}
              </div>
            ))}
            {data.posts?.length === 0 && (
              <div className="text-ink-secondary text-ui-body">
                No competitor posts captured yet.
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <div className="text-ui-body font-medium text-zinc-900 mb-3">
          Manual Engagement Capture
        </div>
        <div className="grid gap-2.5">
          <div>
            <FieldLabel>Company</FieldLabel>
            <Select
              value={capture.companyName}
              onChange={(e) => updateCapture("companyName", e.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id || profileName(profile)}>
                  {profileName(profile)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid [grid-template-columns:1fr_1fr] gap-2.5">
            <div>
              <FieldLabel>Platform</FieldLabel>
              <Select
                value={capture.platform}
                onChange={(e) => updateCapture("platform", e.target.value)}
              >
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
                <option value="linkedin">LinkedIn</option>
                <option value="gbp">GBP</option>
                <option value="tiktok">TikTok</option>
              </Select>
            </div>
            <div>
              <FieldLabel>Format</FieldLabel>
              <Input
                value={capture.creativeFormat}
                onChange={(e) =>
                  updateCapture("creativeFormat", e.target.value)
                }
              />
            </div>
          </div>
          <div>
            <FieldLabel>Post URL</FieldLabel>
            <Input
              value={capture.postUrl}
              onChange={(e) => updateCapture("postUrl", e.target.value)}
              placeholder="https://..."
            />
          </div>
          <div className="grid [grid-template-columns:1fr_1fr] gap-2.5">
            <div>
              <FieldLabel>Topic</FieldLabel>
              <Input
                value={capture.topic}
                onChange={(e) => updateCapture("topic", e.target.value)}
              />
            </div>
            <div>
              <FieldLabel>Hook Type</FieldLabel>
              <Input
                value={capture.hookType}
                onChange={(e) => updateCapture("hookType", e.target.value)}
              />
            </div>
          </div>
          <div className="grid [grid-template-columns:repeat(4,_1fr)] gap-2">
            {[
              ["likesCount", "Likes"],
              ["commentsCount", "Comments"],
              ["sharesCount", "Shares"],
              ["viewsCount", "Views"],
            ].map(([key, label]) => (
              <div key={key}>
                <FieldLabel>{label}</FieldLabel>
                <Input
                  type="number"
                  min="0"
                  value={capture[key]}
                  onChange={(e) => updateCapture(key, e.target.value)}
                />
              </div>
            ))}
          </div>
          <div>
            <FieldLabel>Why It Worked</FieldLabel>
            <Textarea
              value={capture.whyItWorked}
              onChange={(e) => updateCapture("whyItWorked", e.target.value)}
              rows={3}
              className="resize-y"
            />
          </div>
          <div>
            <FieldLabel>Copyable Pattern</FieldLabel>
            <Textarea
              value={capture.copyablePattern}
              onChange={(e) => updateCapture("copyablePattern", e.target.value)}
              rows={3}
              className="resize-y"
            />
          </div>
          <Button onClick={saveCapture} disabled={saving}>
            {saving ? "Saving..." : "Save Capture"}
          </Button>
        </div>
      </Card>
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
        gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
      }}
      className="grid gap-4"
    >
      {/* Left — Input */}
      <div>
        {" "}
        <Card>
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 mb-4">
            Content Source
          </div>{" "}
          <div className="mb-3">
            {" "}
            <label className="text-ui-body text-ink-secondary block mb-1">
              Title
            </label>{" "}
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Blog post title or topic..."
            />{" "}
          </div>{" "}
          <div className="mb-3">
            {" "}
            <label className="text-ui-body text-ink-secondary block mb-1">
              Description
            </label>{" "}
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Brief description or excerpt..."
              className="resize-y"
            />{" "}
          </div>{" "}
          <div className="mb-4">
            {" "}
            <label className="text-ui-body text-ink-secondary block mb-1">
              Link URL
            </label>{" "}
            <Input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://www.wavespestcontrol.com/blog/..."
            />{" "}
          </div>{" "}
          <div className="flex gap-2">
            {" "}
            <Button
              onClick={handlePreview}
              disabled={generating}
              className="flex-1"
            >
              {generating ? "Generating AI Content..." : "Generate AI Preview"}
            </Button>{" "}
            <Button
              onClick={handlePublish}
              disabled={publishing || !preview}
              variant="secondary"
              className="flex-1"
            >
              {publishing ? "Publishing..." : "Publish All"}
            </Button>{" "}
          </div>{" "}
        </Card>{" "}
      </div>
      {/* Right — Preview */}
      <div>
        {!preview ? (
          <Card className="text-center !p-[60px] text-ink-secondary">
            {" "}
            <div className="text-[32px] mb-3"></div>{" "}
            <div className="text-ui-body">
              Enter content and click Generate AI Preview
            </div>{" "}
            <div className="text-ui-body mt-1">
              AI will create platform-optimized versions for each channel
            </div>{" "}
          </Card>
        ) : (
          <div className="grid gap-2.5">
            {["facebook", "instagram", "linkedin", "gbp"].map((platform) => (
              <Card
                key={platform}
                className="mb-0 border-l-[3px] border-l-zinc-900"
              >
                {" "}
                <div className="flex items-center gap-2 mb-2">
                  {" "}
                  <span className="text-[18px]">
                    {PLATFORM_ICONS[platform]}
                  </span>{" "}
                  <span className="text-ui-body font-medium text-zinc-900">
                    {platformLabel(platform, { gbp: "Google Business (all 4 locations)" })}
                  </span>{" "}
                </div>{" "}
                <Textarea
                  value={customContent[platform] || ""}
                  onChange={(e) =>
                    setCustomContent((prev) => ({
                      ...prev,
                      [platform]: e.target.value,
                    }))
                  }
                  rows={3}
                  className="resize-y text-ui-body"
                />{" "}
              </Card>
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
      <div className="text-ink-secondary p-10 text-center">
        Loading RSS feed...
      </div>
    );
  return (
    <div>
      {" "}
      <div className="flex justify-between items-center mb-4">
        {" "}
        <div>
          {" "}
          <div className="text-ui-body font-medium text-zinc-900">
            Blog RSS Feed
          </div>{" "}
          <div className="text-ui-body text-ink-secondary">
            wavespestcontrol.com/feed/ — checked every 4 hours automatically
          </div>{" "}
        </div>{" "}
        <Button onClick={handleAutoPublish} disabled={checking}>
          {checking ? "Checking..." : "Check & Auto-Publish New"}
        </Button>{" "}
      </div>{" "}
      <div className="grid gap-2">
        {items.map((item, i) => (
          <Card
            key={i}
            className="mb-0 flex justify-between items-center gap-4"
          >
            {" "}
            <div className="flex-1 min-w-0">
              {" "}
              <div className="text-ui-body font-medium text-zinc-900 mb-1">
                {item.title}
              </div>{" "}
              <div className="text-ui-body text-ink-secondary mb-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {item.description?.substring(0, 150)}
              </div>{" "}
              <div className="flex gap-2 items-center">
                {" "}
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ui-body text-zinc-900 no-underline"
                >
                  View post
                </a>
                {item.pubDate && (
                  <span className="text-ui-body text-ink-secondary">
                    {new Date(item.pubDate).toLocaleDateString()}
                  </span>
                )}
              </div>{" "}
            </div>
            {item.posted ? <Badge>Published</Badge> : <Badge>Not posted</Badge>}
          </Card>
        ))}
        {items.length === 0 && (
          <Card className="text-center p-10 text-ink-secondary">
            No RSS items found
          </Card>
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
      <div className="flex justify-between items-center mb-4">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900">
          Post History
        </div>{" "}
        <Button onClick={onRefresh}>Refresh</Button>{" "}
      </div>
      {history.length === 0 ? (
        <Card className="text-center p-10 text-ink-secondary">
          No posts yet
        </Card>
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
            <Card key={post.id} className="mb-2">
              {" "}
              <div className="flex justify-between items-start mb-2">
                {" "}
                <div>
                  {" "}
                  <div className="text-ui-body font-medium text-zinc-900">
                    {post.title}
                  </div>
                  {post.source_url && (
                    <a
                      href={post.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        maxWidth: isMobile ? 200 : 400,
                      }}
                      className="text-ui-body text-zinc-900 no-underline overflow-hidden text-ellipsis whitespace-nowrap block"
                    >
                      {post.source_url}
                    </a>
                  )}
                </div>{" "}
                <div className="flex gap-1 items-center">
                  {" "}
                  <Badge tone={postStatusTone(post.status)}>
                    {post.status}
                  </Badge>{" "}
                  <span className="text-ui-body text-ink-secondary">
                    {new Date(post.created_at).toLocaleString()}
                  </span>{" "}
                </div>{" "}
              </div>{" "}
              <div className="flex gap-1.5 flex-wrap">
                {platforms.map((p, i) => (
                  <Badge
                    key={i}
                    tone={!p.success && !p.skipped ? "alert" : "neutral"}
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
                  </Badge>
                ))}
              </div>{" "}
            </Card>
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
        <div className="text-ink-secondary p-10 text-center">
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
      <div className="text-ink-secondary p-10 text-center">
        Loading analytics...
      </div>
    );
  if (!data)
    return (
      <Card className="text-center p-10 text-ink-secondary">
        No analytics data yet
      </Card>
    );
  const {
    byPlatform = {},
    weeklyTrend = [],
    summary = {},
    topPosts = [],
  } = data;
  return (
    <div>
      {/* Summary */}
      <div className="flex gap-2.5 mb-5 flex-wrap">
        {[
          { label: "Total Posts", value: summary.totalPosts || 0 },
          { label: "Published", value: summary.published || 0 },
          { label: "Success Rate", value: `${summary.successRate || 0}%` },
          { label: "Posts/Week", value: summary.postsPerWeek || 0 },
          { label: "Most Active", value: summary.mostActivePlatform || "—" },
        ].map((s) => (
          <Card
            key={s.label}
            className="flex-[1_1_120px] min-w-[120px] mb-0 text-center"
          >
            {" "}
            <div className="text-18 font-medium text-zinc-900 u-nums">
              {s.value}
            </div>{" "}
            <div className="text-ui-body text-ink-secondary mt-0.5">
              {s.label}
            </div>{" "}
          </Card>
        ))}
      </div>
      {/* By Platform */}
      <Card className="mb-4">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 mb-3">
          Performance by Platform
        </div>{" "}
        <div className="grid [grid-template-columns:repeat(auto-fill,_minmax(180px,_1fr))] gap-2.5">
          {Object.entries(byPlatform).map(([platform, stats]) => (
            <div
              key={platform}
              className="p-3.5 bg-zinc-50 rounded-md text-center border-hairline border-zinc-200"
            >
              {" "}
              <div className="text-ui-body font-medium text-zinc-900">
                {platformLabel(platform)}
              </div>{" "}
              <div className="flex gap-2 justify-center mt-2 text-ui-body">
                {" "}
                <span className="text-zinc-900">{stats.success} </span>{" "}
                <span className={stats.failed > 0 ? "text-alert-fg" : "text-ink-secondary"}>
                  {stats.failed} No
                </span>{" "}
                <span className="text-ink-secondary">
                  {stats.total} total
                </span>{" "}
              </div>{" "}
            </div>
          ))}
        </div>{" "}
      </Card>
      {/* Top posts — ranked by ingested engagement once the sync has data */}
      <Card className="mb-4">
        <div className="flex justify-between items-baseline mb-3">
          <div className="text-ui-body font-medium text-zinc-900">
            {summary.engagementRanked
              ? "Top Posts by Engagement"
              : "Recent Published Posts"}
          </div>
          <div className="text-ui-body text-ink-secondary">
            {summary.engagementRanked
              ? `${summary.engagementSyncedPosts} posts with engagement data`
              : "No engagement data yet — enable SOCIAL_ENGAGEMENT_SYNC_ENABLED"}
          </div>
        </div>
        {topPosts.length === 0 ? (
          <div className="text-ui-body text-ink-secondary">
            No published posts
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="w-full border-collapse text-ui-body">
              <THead>
                <TR className="text-ink-secondary text-left">
                  <TH className="px-2 py-1.5 font-medium">Post</TH>
                  <TH className="px-2 py-1.5 font-medium">Published</TH>
                  <TH className="px-2 py-1.5 font-medium text-right">Likes</TH>
                  <TH className="px-2 py-1.5 font-medium text-right">
                    Comments
                  </TH>
                  <TH className="px-2 py-1.5 font-medium text-right">Shares</TH>
                  <TH className="px-2 py-1.5 font-medium text-right">Score</TH>
                </TR>
              </THead>
              <TBody>
                {topPosts.map((p) => {
                  const e = p.engagement;
                  const num = (v) => (e ? v : "—");
                  return (
                    <TR key={p.id}>
                      <TD className="px-2 py-1.5 text-zinc-900 max-w-[360px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {p.title || "(untitled)"}
                      </TD>
                      <TD className="px-2 py-1.5 text-ink-secondary whitespace-nowrap">
                        {p.publishedAt ? formatETDate(p.publishedAt) : "—"}
                      </TD>
                      <TD nums className="px-2 py-1.5 text-right">
                        {num(e?.likes)}
                      </TD>
                      <TD nums className="px-2 py-1.5 text-right">
                        {num(e?.comments)}
                      </TD>
                      <TD nums className="px-2 py-1.5 text-right">
                        {e && e.shares != null ? e.shares : "—"}
                      </TD>
                      <TD nums className="px-2 py-1.5 text-right text-zinc-900 font-medium">
                        {num(e?.score)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
      {/* Weekly Trend */}
      {weeklyTrend.length > 0 && (
        <Card>
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 mb-3">
            Weekly Posting Trend
          </div>{" "}
          {/* Up to 12 weekly buckets: each column keeps a floor width so the
              12px MM-DD labels never collide, and the row scrolls sideways on
              phones instead of widening the Analytics tab (Codex round 4). */}
          <div className="overflow-x-auto">
            <div className="flex items-end gap-1 h-[136px] pb-4 min-w-max">
              {weeklyTrend.map((w, i) => {
                const max = Math.max(...weeklyTrend.map((x) => x.total), 1);
                const h = Math.max(4, (w.total / max) * 80);
                return (
                  <div
                    key={i}
                    className="flex-1 min-w-9 flex flex-col items-center gap-0.5"
                  >
                    {" "}
                    <div className="text-ui-body text-ink-secondary u-nums">
                      {w.total}
                    </div>{" "}
                    <div
                      style={{
                        height: h,
                      }}
                      className={cn(
                        "w-full rounded-xs",
                        w.published > 0 ? "bg-zinc-900" : "bg-zinc-200",
                      )}
                    />{" "}
                    <div className="text-ui-body text-ink-secondary -rotate-45 origin-center whitespace-nowrap">
                      {w.week?.substring(5)}
                    </div>{" "}
                  </div>
                );
              })}
            </div>{" "}
          </div>
        </Card>
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
      <div className="text-ui-body font-medium text-zinc-900 mb-4">
        Post Templates
      </div>{" "}
      <div
        style={{
          gridTemplateColumns: isMobile
            ? "1fr"
            : "repeat(auto-fill, minmax(280px, 1fr))",
        }}
        className="grid gap-3"
      >
        {TEMPLATES.map((t) => (
          <Card
            key={t.id}
            onClick={() =>
              setSelectedTemplate(selectedTemplate === t.id ? null : t.id)
            }
            className={cn(
              "mb-0 cursor-pointer",
              selectedTemplate === t.id &&
                "border-zinc-900 ring-1 ring-zinc-900",
            )}
          >
            {" "}
            <div className="flex items-center gap-2 mb-2">
              {" "}
              <span className="text-[20px]">{t.icon}</span>{" "}
              <div className="text-ui-body font-medium text-zinc-900">
                {t.name}
              </div>{" "}
            </div>{" "}
            <div className="flex gap-1 mb-2">
              {t.platforms.map((p) => (
                <Badge key={p}>{p}</Badge>
              ))}
            </div>
            {selectedTemplate === t.id && (
              <div className="p-2.5 bg-zinc-50 rounded-md text-ui-body text-ink-secondary leading-[1.6] whitespace-pre-wrap mt-2">
                {t.template}
                <div className="mt-2">
                  {" "}
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(t.template);
                      showToast("Template copied!");
                    }}
                  >
                    Copy Template
                  </Button>{" "}
                </div>{" "}
              </div>
            )}
          </Card>
        ))}
      </div>{" "}
    </div>
  );
}
