import React, { useState, useEffect, useRef } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import {
  Activity,
  Building2,
  CalendarOff,
  ChevronRight,
  DollarSign,
  KeyRound,
  Link2,
  MapPinned,
  Plug,
  RotateCcw,
  Save,
  Server,
  Settings as SettingsIcon,
  Target,
  ToggleLeft,
  X,
} from "lucide-react";
import useIsMobile from "../../hooks/useIsMobile";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import IntegrationHealthSection from "../../components/admin/IntegrationHealthSection";
import PortalUsageTab from "../../components/admin/PortalUsageTab";
import { trackAdminPageView } from "../../lib/adminUsage";
import {
  DEFAULT_KPI_TARGETS,
  KPI_METRIC_LABELS,
} from "./dashboard/kpi-targets";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  UiSurface,
  buttonStyles,
  cn,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then(async (r) => {
    if (r.status === 401) {
      window.location.href = "/admin/login";
      throw new Error("Session expired");
    }
    const data = await r.json().catch(() => ({}));
    // Reject on any non-2xx so save handlers hit their catch instead of showing
    // "saved" on a 403/500 (the body carries the server's error message).
    if (!r.ok) {
      throw new Error(data?.error || `Request failed (${r.status})`);
    }
    return data;
  });
}

function Toggle({ checked, onChange, label, description }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-hairline border-zinc-200 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="font-medium text-zinc-900">{label}</div>
        {description && <div className="mt-1 text-ui-caption text-ink-secondary">{description}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} aria-label={label} />
    </div>
  );
}

const VALID_TABS = [
  "general",
  "integrations",
  "gates",
  "link-library",
  "service-reports",
  "blackout-days",
  "kpi-targets",
  "operating-costs",
  "system",
  "usage",
];

// Nav-only consolidation: the six leaf tabs collapse into four parent groups.
// Tab state still holds the LEAF key (one of VALID_TABS); these groups only drive
// which parent button is active and which leaf the parent jumps to.
const SETTINGS_TAB_GROUPS = [
  { key: "general", label: "General", Icon: Building2, tabs: ["general", "link-library"] },
  { key: "integrations", label: "Integrations", Icon: Plug, tabs: ["integrations"] },
  { key: "service-reports", label: "Service Reports", Icon: MapPinned, tabs: ["service-reports"] },
  { key: "scheduling", label: "Scheduling", Icon: CalendarOff, tabs: ["blackout-days"] },
  { key: "financials", label: "Financials", Icon: Target, tabs: ["kpi-targets", "operating-costs"] },
  { key: "advanced", label: "Advanced", Icon: ToggleLeft, tabs: ["gates", "system", "usage"] },
];

// Per-leaf nav metadata for the sub-tab pill row.
const SETTINGS_LEAF_META = {
  general: { label: "General", Icon: Building2 },
  "link-library": { label: "Link Library", Icon: Link2 },
  integrations: { label: "Integrations", Icon: Plug },
  "service-reports": { label: "Service Reports", Icon: MapPinned },
  "blackout-days": { label: "Blackout Days", Icon: CalendarOff },
  "kpi-targets": { label: "KPI Targets", Icon: Target },
  "operating-costs": { label: "Operating Costs", Icon: DollarSign },
  gates: { label: "Feature Gates", Icon: ToggleLeft },
  system: { label: "System", Icon: Server },
  usage: { label: "Portal Usage", Icon: Activity },
};

export default function SettingsPage() {
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const [health, setHealth] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // ?tab=X deep-links from the mobile Settings surface land on the right tab.
  const initialTab = VALID_TABS.includes(searchParams.get("tab"))
    ? searchParams.get("tab")
    : "general";
  const [tab, setTab] = useState(initialTab);

  // Desktop sub-tab switches are state-only (no URL change), so the
  // AdminLayoutV2 route beacon can't see them — record the leaf visit
  // explicitly or the usage report undercounts the Settings tabs it is
  // meant to rank. Dedupe/settle in the lib absorb the ?tab= deep-link
  // overlap (same key → dropped). Codex #2961 r2.
  // Current leaf as a ref so the query-sync effect below can report the
  // RENDERED leaf without depending on `tab` state.
  const tabRef = useRef(initialTab);

  const selectTab = (leafKey) => {
    // Clicking the already-active leaf (or its parent group) changes
    // nothing rendered — record nothing, matching the shell's no-op
    // guards, or idle re-clicks inflate the leaf counts.
    if (leafKey === tab) return;
    setTab(leafKey);
    tabRef.current = leafKey;
    trackAdminPageView({
      pathname: "/admin/settings",
      search: `?tab=${leafKey}`,
      authoritative: true,
    });
  };

  // Mobile section links change ?tab= on the already-mounted page (the mobile
  // index and the tab panel share this route/component) — sync the param into
  // state so those taps actually switch tabs instead of leaving the prior one.
  // The same effect authoritatively records the leaf that actually RENDERS
  // after each query change (VALID_TABS fallback applied): search-only
  // navigations (back/forward, in-app links) never remount this page, so a
  // mount-only beacon can't cover them, and without it the layout would
  // record a raw invalid ?tab= the user never saw. Runs on mount too —
  // covering the query-less desktop open (default leaf) — and before the
  // layout's effect (child first), so the authoritative pending beacon
  // blocks the raw one. The query-less MOBILE index renders no leaf and is
  // skipped. Codex #2961 r4+r6.
  // Re-run only for REAL query changes: isMobile is read here (mobile-index
  // skip), but a breakpoint crossing must not resync state from a stale URL
  // param — after a state-only selectTab, the URL can still say ?tab=general
  // while Portal Usage is rendered, and a resize would eject the user and
  // record the stale leaf (Codex #2961 r9).
  const prevSearchRef = useRef(null);
  useEffect(() => {
    const searchStr = searchParams.toString();
    if (prevSearchRef.current === searchStr) return;
    prevSearchRef.current = searchStr;
    const qp = searchParams.get("tab");
    if (qp && VALID_TABS.includes(qp)) {
      setTab(qp);
      tabRef.current = qp;
    } else {
      // A REAL query-string change that removed (or mangled) ?tab= is a
      // navigation to the Settings root — reset to the default leaf, or
      // the previously rendered panel (e.g. Portal Usage) survives a
      // sidebar click to /admin/settings and the beacon records the stale
      // leaf (Codex #2961 r10).
      setTab("general");
      tabRef.current = "general";
    }
    if (isMobile && !qp) return;
    trackAdminPageView({
      pathname: "/admin/settings",
      search: `?tab=${tabRef.current}`,
      authoritative: true,
    });
  }, [searchParams, isMobile]);

  useEffect(() => {
    // Account identity must survive a separate health-service outage. Each
    // read settles independently; the profile remains server-authoritative.
    Promise.allSettled([
      fetch(`${API_BASE}/health`).then((r) => r.json()).then(setHealth),
      adminFetch("/admin/auth/me").then(setUser),
    ]).then(() => setLoading(false));
  }, []);

  // A ?tab= deep link into an owner-only group resolves to General once the
  // server-verified profile arrives. Declared ABOVE the early returns —
  // hooks must run on every render path or React throws "Rendered more
  // hooks than during the previous render" (codex P1).
  useEffect(() => {
    if (user && user.role !== "admin"
      && ["service-reports", "blackout-days", "kpi-targets", "integrations", "gates", "system", "link-library"].includes(tab)) {
      selectTab("general");
    }
    // selectTab is stable; errors-only lint config has no exhaustive-deps.
  }, [user, tab]);

  // On mobile — and when NOT deep-linked into a specific tab — render the
  // Square-style section index instead of the desktop tab panel.
  // Mobile has ONE settings surface: the Settings tab (/admin/more), which
  // lists these leaves inline. A tab-less /admin/settings on mobile used to
  // render a second index (the since-removed MobileSettingsPage) — send it there instead.
  // Deep links with ?tab= still render the leaf below.
  if (isMobile && !searchParams.get("tab")) return <Navigate to="/admin/more" replace />;

  if (loading) {
    return (
      <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
        <AdminCommandHeader variant="workspace" title="Settings" icon={SettingsIcon} />
        <ActionFeedback className="min-h-20">Loading settings...</ActionFeedback>
      </UiSurface>
    );
  }

  const gates = health?.gates || {};

  // Service Reports (coverage config) and Scheduling (blackout days) are
  // requireAdmin end to end server-side — hide the whole groups from
  // non-admin roles instead of rendering panels that can only 403
  // (2026-08-25 role lockdown). `user` is the server-verified /auth/me row.
  const isAdminRole = user?.role === "admin";
  // Non-admin Settings: General (account view) + Operating Costs +
  // Portal Usage. Integrations (its tab renders "Admin access required"),
  // Service Reports, Scheduling, KPI targets, feature gates, and System
  // are owner-only.
  const OWNER_ONLY_SETTINGS_LEAVES = ["kpi-targets", "gates", "system", "service-reports", "blackout-days", "link-library"];
  const visibleGroups = SETTINGS_TAB_GROUPS.filter(
    (g) => isAdminRole || !["service-reports", "scheduling", "integrations"].includes(g.key),
  ).map((g) => (
    isAdminRole
      ? g
      : { ...g, tabs: g.tabs.filter((t) => !OWNER_ONLY_SETTINGS_LEAVES.includes(t)) }
  )).filter((g) => g.tabs.length > 0);
  const activeGroup =
    visibleGroups.find((g) => g.tabs.includes(tab)) || visibleGroups[0];

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
      <AdminCommandHeader
        variant="workspace"
        title="Settings"
        icon={SettingsIcon}
        sections={visibleGroups}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = visibleGroups.find((x) => x.key === key);
          if (g) selectTab(g.tabs[0]);
        }}
        navGridClassName="grid-cols-2 md:grid-cols-4 xl:grid-cols-4"
        secondarySections={
          activeGroup.tabs.length > 1
            ? activeGroup.tabs.map((leafKey) => ({
                key: leafKey,
                label: SETTINGS_LEAF_META[leafKey]?.label || leafKey,
                Icon: SETTINGS_LEAF_META[leafKey]?.Icon,
              }))
            : []
        }
        secondaryActiveKey={tab}
        onSecondaryChange={selectTab}
        secondaryAriaLabel="Settings page"
        secondaryNavGridClassName="grid-cols-2 md:grid-cols-4"
      />
      {tab === "general" && (
        <div className="space-y-5">
          {searchParams.get("passwordChanged") === "1" && (
            <ActionFeedback>
              Password updated. Older staff sessions have been signed out.
            </ActionFeedback>
          )}
          <Card>
            <CardHeader><CardTitle>Company info</CardTitle></CardHeader>
            <CardBody>
              <dl className="grid gap-3 sm:grid-cols-2">
                {[
                  { label: "Company", value: "Waves Pest Control" },
                  { label: "Main phone", value: "(941) 318-7612" },
                  { label: "Website", value: "wavespestcontrol.com" },
                  { label: "Service area", value: "Bradenton, Sarasota, Venice, Parrish, LWR, North Port, Port Charlotte" },
                ].map((field) => (
                  <div key={field.label} className="rounded-md bg-zinc-50 p-3">
                    <dt className="text-ui-caption text-ink-secondary">{field.label}</dt>
                    <dd className="mt-1 font-medium text-zinc-900">{field.value}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader><CardTitle>Logged In As</CardTitle></CardHeader>
            <CardBody>
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-20 font-medium text-white">
                  {(user?.name || "A")[0]}
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-zinc-900">{user?.name || "Unknown"}</div>
                  <div className="break-words text-ui-caption text-ink-secondary">{user?.email} · {user?.role}</div>
                </div>
              </div>
              <Link to="/admin/change-password" className={buttonStyles({ variant: "secondary", density: "comfortable", className: "mt-4 gap-2" })}>
                <KeyRound size={16} aria-hidden /> Change password
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardHeader><CardTitle>WaveGuard tiers</CardTitle></CardHeader>
            <CardBody className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                { tier: "Bronze", discount: "0%" },
                { tier: "Silver", discount: "10%" },
                { tier: "Gold", discount: "15%" },
                { tier: "Platinum", discount: "20%" },
              ].map((t) => (
                <div key={t.tier} className="rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3 text-center">
                  <div className="font-medium text-zinc-900">{t.tier}</div>
                  <div className="mt-1 text-ui-caption text-ink-secondary">{t.discount} discount</div>
                </div>
              ))}
            </CardBody>
          </Card>
          {user?.role === "admin" && (
            <Card>
              <CardBody>
                <Link to="/admin/settings/pest-pressure" className="flex min-h-11 items-center justify-between gap-3 rounded-sm u-focus-ring">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-zinc-100 text-zinc-900">
                      <Activity size={18} aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-zinc-900">Pest pressure</div>
                      <div className="mt-1 text-ui-caption text-ink-secondary">
                        Configure the 0–5 score on customer service reports — service-line scope, weights, labels, trend thresholds, overrides, audit log.
                      </div>
                    </div>
                  </div>
                  <ChevronRight size={18} aria-hidden className="shrink-0 text-ink-secondary" />
                </Link>
              </CardBody>
            </Card>
          )}
        </div>
      )}
      {tab === "link-library" && <LinkLibraryTab />}
      {tab === "integrations" && <IntegrationsTab canAdmin={user?.role === "admin"} />}
      {tab === "gates" && (
        <Card>
          <CardHeader>
            <CardTitle>Feature gates</CardTitle>
            <p className="mt-1 text-ui-body text-ink-secondary">
              Control which integrations are active. Set via Railway environment variables.
            </p>
          </CardHeader>
          <CardBody>
            {Object.keys(gates).length === 0 ? null : (
              <div className="divide-y divide-zinc-200">
                {Object.entries(gates).map(([key, enabled]) => (
                  <div key={key} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="break-words font-medium text-zinc-900">{key}</div>
                      <div className="break-all text-ui-caption text-ink-secondary u-nums">
                        GATE_{key.replace(/([A-Z])/g, "_$1").toUpperCase()}
                      </div>
                    </div>
                    <Badge tone={enabled ? "strong" : "neutral"} dot>{enabled ? "Enabled" : "Disabled"}</Badge>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-4 rounded-md bg-zinc-50 p-3 text-ui-body text-ink-secondary">
              Gates are controlled via Railway environment variables. To change:
              Railway Dashboard → Variables → set GATE_NAME=true or remove the variable.
            </p>
          </CardBody>
        </Card>
      )}
      {tab === "service-reports" && <ServiceCoverageSettingsTab />}
      {tab === "blackout-days" && <BlackoutDaysTab />}
      {tab === "kpi-targets" && <KpiTargetsSettingsTab canAdmin={user?.role === "admin"} />}
      {tab === "operating-costs" && <OperatingCostsSettingsTab canAdmin={user?.role === "admin"} />}
      {tab === "system" && (
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>System info</CardTitle></CardHeader>
            <CardBody>
              <dl className="grid gap-3 sm:grid-cols-2">
                {[
                  { label: "Environment", value: health?.environment || "—" },
                  { label: "Status", value: health?.status || "—" },
                  { label: "Server time", value: health?.timestamp ? new Date(health.timestamp).toLocaleString() : "—" },
                  { label: "Database", value: "PostgreSQL (Railway)" },
                  { label: "Frontend", value: "React (Vite)" },
                  { label: "Backend", value: "Express.js" },
                  { label: "AI model", value: "Claude Sonnet 4" },
                  { label: "Migrations", value: "50 migrations" },
                ].map((field) => (
                  <div key={field.label} className="rounded-md bg-zinc-50 p-3">
                    <dt className="text-ui-caption text-ink-secondary">{field.label}</dt>
                    <dd className="mt-1 break-words font-medium text-zinc-900 u-nums">{field.value}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Cron jobs</CardTitle>
              <Badge tone={gates.cronJobs ? "strong" : "alert"} dot>
                {gates.cronJobs ? "Enabled" : "Disabled"}
              </Badge>
            </CardHeader>
            <CardBody className="divide-y divide-zinc-200">
              {[
                { time: "1:30 AM Mon", job: "Site audit", gate: "seoIntelligence" },
                { time: "2:00 AM", job: "Rank tracking", gate: "seoIntelligence" },
                { time: "2:30 AM", job: "AI Overview check", gate: "seoIntelligence" },
                { time: "3:00 AM", job: "Customer intelligence", gate: "cronJobs" },
                { time: "3:30 AM Sun", job: "Backlink scan", gate: "seoIntelligence" },
                { time: "5:00 AM", job: "Blog auto-generate", gate: "cronJobs" },
                { time: "5:30 AM Mon", job: "Content decay check", gate: "seoIntelligence" },
                { time: "6:00 AM", job: "GSC data sync", gate: "cronJobs" },
                { time: "8:00 AM", job: "Campaign advisor", gate: "cronJobs" },
                { time: "8:00 AM Fri", job: "CSR weekly rec", gate: "cronJobs" },
                { time: "Every 2hr", job: "Ad budget adjust", gate: "cronJobs" },
                { time: ":30 past hr", job: "Follow-up verify", gate: "cronJobs" },
              ].map((cron) => (
                <div key={`${cron.time}-${cron.job}`} className="grid grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-3 py-3">
                  <span className="text-ui-caption text-ink-secondary u-nums">{cron.time}</span>
                  <span className="text-zinc-700">{cron.job}</span>
                  <Badge tone={gates[cron.gate] ? "strong" : "neutral"}>{gates[cron.gate] ? "On" : "Off"}</Badge>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>
      )}
      {tab === "usage" && <PortalUsageTab canAdmin={user?.role === "admin"} />}
    </UiSurface>
  );
}

const SERVICE_COVERAGE_SERVICE_LINES = [
  { key: "default", label: "Default" },
  { key: "pest", label: "Pest" },
  { key: "lawn", label: "Lawn" },
  { key: "termite", label: "Termite" },
  { key: "tree_shrub", label: "Tree & Shrub" },
  { key: "mosquito", label: "Mosquito" },
  { key: "rodent", label: "Rodent" },
  { key: "commercial", label: "Commercial" },
];

const SERVICE_COVERAGE_STATUS_KEYS = [
  "completed",
  "treated",
  "inspected",
  "checked",
  "inaccessible",
  "needs_attention",
  "needs_follow_up",
  "skipped",
  "not_serviced",
];

function deepMergeConfig(base = {}, override = {}) {
  const merged = { ...base };
  Object.entries(override || {}).forEach(([key, value]) => {
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && base[key]
      && typeof base[key] === "object"
      && !Array.isArray(base[key])
    ) {
      merged[key] = deepMergeConfig(base[key], value);
      return;
    }
    merged[key] = value;
  });
  return merged;
}

function VisitTimelineSettingsCard() {
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    adminFetch("/admin/settings/visit-timeline")
      .then((data) => setConfig(data.config || data.defaults))
      .catch((err) => setMessage(err.message || "Could not load Visit Timeline settings."));
  }, []);

  const update = (patch) => setConfig((current) => ({ ...(current || {}), ...patch }));

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setMessage("");
    try {
      const data = await adminFetch("/admin/settings/visit-timeline", {
        method: "PUT",
        body: JSON.stringify({ config }),
      });
      setConfig(data.config || config);
      setMessage("Visit Timeline settings saved.");
    } catch (err) {
      setMessage(err.message || "Could not save Visit Timeline settings.");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setMessage("");
    try {
      const data = await adminFetch("/admin/settings/visit-timeline/reset", { method: "POST" });
      setConfig(data.config);
      setMessage("Visit Timeline settings restored to defaults.");
    } catch (err) {
      setMessage(err.message || "Could not restore Visit Timeline settings.");
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return <ActionFeedback className="min-h-20">Loading Visit Timeline settings...</ActionFeedback>;
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle>Visit Timeline</CardTitle>
          <p className="mt-1 text-ui-body text-ink-secondary">
            Configure the customer-facing timeline that uses Bouncie for movement and Waves report finalization for service completion.
          </p>
        </div>
        <div className="ui-record-actions">
          <Button variant="secondary" onClick={reset} disabled={saving}>
            <RotateCcw size={15} aria-hidden /> Restore defaults
          </Button>
          <Button onClick={save} loading={saving}>
            <Save size={15} aria-hidden /> {saving ? "Saving..." : "Save settings"}
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        <Toggle checked={config.enabled !== false} onChange={(value) => update({ enabled: value })} label="Enable Visit Timeline" description="Show one unified customer-facing visit timeline on service reports." />
        <Toggle checked={config.showOnCustomerReports !== false} onChange={(value) => update({ showOnCustomerReports: value })} label="Show on customer reports" />
        <Toggle checked={config.showTechnicianEnRoute !== false} onChange={(value) => update({ showTechnicianEnRoute: value })} label="Show technician en route" description="Source: Bouncie." />
        <Toggle checked={config.showTechnicianOnSite !== false} onChange={(value) => update({ showTechnicianOnSite: value })} label="Show technician on site" description="Source: Bouncie." />
        <div className="my-3 rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3">
          <div className="font-medium text-zinc-900">Service completed is required</div>
          <div className="mt-1 text-ui-caption text-ink-secondary">
            Completed reports always show Service completed from Waves report finalization.
          </div>
        </div>
        <Toggle checked={config.showCustomerContact !== false} onChange={(value) => update({ showCustomerContact: value })} label="Show customer contact detail" description="Shown inside Visit Timeline, not as a primary milestone." />
        <Toggle checked={config.showReportGenerated === true} onChange={(value) => update({ showReportGenerated: value })} label="Show report generated detail" description="Secondary detail only. Hidden by default." />
        <Toggle checked={config.showDuration === true} onChange={(value) => update({ showDuration: value })} label="Show duration when reliable" />
        <Field label="Minimum reliable duration" className="my-3 max-w-xs">
          <Input
            type="number"
            min="1"
            value={config.minimumDurationMinutes || 5}
            onChange={(event) => update({ minimumDurationMinutes: Number(event.target.value) || 5 })}
          />
        </Field>
        <Toggle checked={config.showTimingNoteWhenDurationUnavailable !== false} onChange={(value) => update({ showTimingNoteWhenDurationUnavailable: value })} label="Show timing note when duration is unavailable" />
        <Toggle checked={config.showDataSourceNote !== false} onChange={(value) => update({ showDataSourceNote: value })} label="Show data source note" />
        <Field label="Data source note" className="mt-3">
          <Textarea
            rows={2}
            value={config.dataSourceNote || ""}
            onChange={(event) => update({ dataSourceNote: event.target.value })}
          />
        </Field>
        {message && <ActionFeedback error={message.includes("Could not")} className="mt-3">{message}</ActionFeedback>}
      </CardBody>
    </Card>
  );
}

// Editable red/amber/green thresholds for the dashboard KPI tiles
// Owner-entered MONTHLY operating overhead (company_financials ovh_* — the
// adjusted-EBITDA bridge's authoritative overhead once entered; until then the
// bridge falls back to pricing assumptions and says so). Deliberately separate
// from the pricing inputs: a pricing tweak must never rewrite the P&L view.
const OVH_FIELDS_UI = [
  { key: "ovhOfficePayroll", col: "ovh_office_payroll", label: "Office payroll", hint: "admin/CSR wages — NOT tech labor (that's in job costs)" },
  { key: "ovhRent", col: "ovh_rent", label: "Rent / storage", hint: "office, warehouse, storage units" },
  { key: "ovhInsurance", col: "ovh_insurance", label: "Business insurance", hint: "GL, workers' comp, umbrella" },
  { key: "ovhSoftware", col: "ovh_software", label: "Software & subscriptions", hint: "portal hosting, phones, SaaS" },
  { key: "ovhVehicleFixed", col: "ovh_vehicle_fixed", label: "Vehicles (fixed)", hint: "payments, insurance, registration — fuel rides in job drive costs" },
  { key: "ovhOtherGa", col: "ovh_other_ga", label: "Other G&A", hint: "banking, professional fees, misc overhead" },
];

function OperatingCostsSettingsTab({ canAdmin }) {
  const [row, setRow] = useState(null); // latest company_financials row
  const [dirty, setDirty] = useState({}); // { ovhKey: string input value }
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // { text, error }

  useEffect(() => {
    adminFetch("/admin/revenue/settings")
      .then((data) => {
        if (!data || typeof data !== "object" || !("settings" in data)) {
          throw new Error(data?.error || "Could not load operating costs.");
        }
        setRow(data.settings || {});
      })
      .catch((err) => setMessage({ text: err.message || "Could not load operating costs.", error: true }));
  }, []);

  const valueOf = (f) =>
    dirty[f.key] !== undefined ? dirty[f.key] : row?.[f.col] != null ? String(parseFloat(row[f.col])) : "";

  const save = async () => {
    const body = {};
    for (const f of OVH_FIELDS_UI) {
      if (dirty[f.key] === undefined) continue;
      const raw = String(dirty[f.key]).trim();
      if (raw === "") { body[f.key] = null; continue; } // blank clears the figure
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        setMessage({ text: `"${f.label}" must be a number ≥ 0 (or blank to clear).`, error: true });
        return;
      }
      body[f.key] = v;
    }
    if (!Object.keys(body).length) {
      setMessage({ text: "Nothing to save yet — edit a figure first.", error: true });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await adminFetch("/admin/revenue/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (result?.error) throw new Error(result.error);
      if (result?.settings) setRow(result.settings);
      setDirty({});
      setMessage({ text: "Saved. The dashboard's EBITDA bridge switches to these entered costs on its next refresh.", error: false });
    } catch (err) {
      setMessage({ text: err.message || "Could not save operating costs.", error: true });
    } finally {
      setSaving(false);
    }
  };

  // Fail closed — no inputs until the latest row actually loaded (editing on
  // top of a failed load could clobber entered figures with blanks).
  if (!row) {
    return <ActionFeedback error={message?.error} className="min-h-20">{message?.text || "Loading operating costs..."}</ActionFeedback>;
  }

  const monthlyTotal = OVH_FIELDS_UI.reduce((t, f) => {
    const v = Number(valueOf(f));
    return t + (Number.isFinite(v) ? v : 0);
  }, 0);
  const enteredAt = row.overhead_entered_at ? String(row.overhead_entered_at).slice(0, 10) : null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle>Operating costs</CardTitle>
            <p className="mt-1 text-ui-body text-ink-secondary">
              Real monthly overhead for the dashboard's adjusted-EBITDA bridge. Separate from the
              pricing assumptions on purpose — job pricing and the company P&amp;L must not rewrite
              each other. Until these are entered, the bridge approximates from pricing settings
              and labels itself accordingly.
            </p>
            <p className="mt-2 text-ui-caption text-ink-secondary">
              {enteredAt ? `Last entered ${enteredAt}.` : "Never entered — the bridge is running on pricing assumptions."}
            </p>
          </div>
          {canAdmin && (
            <Button onClick={save} loading={saving} disabled={Object.keys(dirty).length === 0}>
              <Save size={15} aria-hidden /> {saving ? "Saving..." : "Save costs"}
            </Button>
          )}
        </CardHeader>
        {message && (
          <CardBody><ActionFeedback error={message.error}>{message.text}</ActionFeedback></CardBody>
        )}
      </Card>

      <Card>
        <CardBody className="divide-y divide-zinc-200">
          {OVH_FIELDS_UI.map((f) => (
            <div key={f.key} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-end sm:justify-between">
              <Field label={f.label} help={f.hint} className="min-w-0 flex-1 sm:max-w-md">
                <Input
                  type="number"
                  step="any"
                  min="0"
                  value={valueOf(f)}
                  placeholder="0"
                  disabled={!canAdmin}
                  onChange={(ev) => setDirty((d) => ({ ...d, [f.key]: ev.target.value }))}
                  className="u-nums"
                />
              </Field>
              <div className="flex items-center gap-2 sm:pb-3">
                {dirty[f.key] !== undefined && <Badge tone="neutral">Unsaved</Badge>}
                <span className="text-ui-caption text-ink-secondary">$ / month</span>
              </div>
            </div>
          ))}
          <div className="flex justify-between gap-3 pt-4">
            <span className="text-ink-secondary">Monthly overhead total</span>
            <span className="font-medium text-zinc-900 u-nums">
              ${monthlyTotal.toLocaleString("en-US", { maximumFractionDigits: 2 })}
            </span>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

// (/api/admin/kpi-targets, seeded from the old hardcoded values). Every
// snapshot metric is listed — ones without a target simply have no tone until
// the owner sets one. The dashboard falls back to DEFAULT_KPI_TARGETS when a
// row is missing, so clearing a field here never blanks a tile.
function KpiTargetsSettingsTab({ canAdmin }) {
  const [rows, setRows] = useState(null); // { [metric]: stored row }
  const [dirty, setDirty] = useState({}); // { [metric]: { target?, amberBandPct?, lowerIsBetter? } }
  const [saving, setSaving] = useState(false);
  // { text, error } — an explicit flag, not a substring heuristic, so server
  // validation rejections can never render green as if the save succeeded.
  const [message, setMessage] = useState(null);

  useEffect(() => {
    adminFetch("/admin/kpi-targets")
      .then((data) => {
        // adminFetch resolves non-2xx JSON bodies too — treat anything
        // without a real targets array as a failed load. Editing off
        // fallback defaults while the store didn't load would let a save
        // overwrite owner-set targets with the defaults.
        if (!Array.isArray(data?.targets)) {
          throw new Error(data?.error || "Could not load KPI targets.");
        }
        const byMetric = {};
        for (const row of data.targets) byMetric[row.metric] = row;
        setRows(byMetric);
      })
      .catch((err) => setMessage({ text: err.message || "Could not load KPI targets.", error: true }));
  }, []);

  // Stored row, overlaid by unsaved edits, falling back to the tile default.
  const effective = (metric) => ({
    ...(DEFAULT_KPI_TARGETS[metric] || {}),
    ...(rows?.[metric] || {}),
    ...(dirty[metric] || {}),
  });

  const edit = (metric, patch) =>
    setDirty((d) => ({ ...d, [metric]: { ...(d[metric] || {}), ...patch } }));

  const save = async () => {
    const changed = Object.keys(dirty);
    const targets = [];
    for (const metric of changed) {
      const e = effective(metric);
      // Blank must be rejected BEFORE coercion — Number("") is 0, which would
      // silently save a 0 target (always-green for higher-is-better tiles).
      const blank = e.target == null || (typeof e.target === "string" && e.target.trim() === "");
      const target = Number(e.target);
      if (blank || !Number.isFinite(target)) {
        setMessage({ text: `Enter a numeric target for "${KPI_METRIC_LABELS[metric] || metric}" (or discard the edit).`, error: true });
        return;
      }
      targets.push({
        metric,
        target,
        amberBandPct: e.amberBandPct == null || e.amberBandPct === "" ? 10 : Number(e.amberBandPct),
        lowerIsBetter: !!e.lowerIsBetter,
      });
    }
    if (!targets.length) {
      setMessage({ text: "Nothing to save yet — edit a target first.", error: true });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await adminFetch("/admin/kpi-targets", {
        method: "PUT",
        body: JSON.stringify({ targets }),
      });
      if (result?.error) throw new Error(result.error);
      // Re-fetch instead of merging locally: the server stamps
      // updated_by/updated_at (and the save busted its GET cache), so the
      // table shows the authoritative row, not stale "seeded"/old-editor
      // metadata until a reload.
      const fresh = await adminFetch("/admin/kpi-targets").catch(() => null);
      if (Array.isArray(fresh?.targets)) {
        const byMetric = {};
        for (const row of fresh.targets) byMetric[row.metric] = row;
        setRows(byMetric);
      } else {
        // Refresh hiccup after a successful save — keep the UI reflecting
        // what was saved rather than blanking.
        setRows((prev) => {
          const next = { ...(prev || {}) };
          for (const t of targets) next[t.metric] = { ...(next[t.metric] || {}), ...t };
          return next;
        });
      }
      setDirty({});
      setMessage({ text: `Saved ${targets.length} target${targets.length === 1 ? "" : "s"}. Dashboard tiles pick this up on their next refresh.`, error: false });
    } catch (err) {
      setMessage({ text: err.message || "Could not save KPI targets.", error: true });
    } finally {
      setSaving(false);
    }
  };

  // Fail closed: no editable table until a load actually succeeded — the
  // fallback defaults are for the dashboard tiles, not for editing, and a
  // save on top of them could clobber owner-set targets that failed to load.
  if (!rows) {
    return <ActionFeedback error={message?.error} className="min-h-20">{message?.text || "Loading KPI targets..."}</ActionFeedback>;
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle>KPI targets</CardTitle>
            <p className="mt-1 text-ui-body text-ink-secondary">
              Dashboard tiles color against these: green at/above target, amber within the band, red beyond it.
              "Lower is better" flips the comparison (callback rate, AR days, response speed).
            </p>
          </div>
          {canAdmin && (
            <Button onClick={save} loading={saving} disabled={Object.keys(dirty).length === 0}>
              <Save size={15} aria-hidden /> {saving ? "Saving..." : "Save targets"}
            </Button>
          )}
        </CardHeader>
        {message && (
          <CardBody><ActionFeedback error={message.error}>{message.text}</ActionFeedback></CardBody>
        )}
      </Card>

      <Card>
        <CardBody className="p-0">
          <Table className="min-w-[760px]" aria-label="KPI targets">
            <THead>
              <TR>
                <TH>Metric</TH>
                <TH>Target</TH>
                <TH>Direction</TH>
                <TH>Amber band %</TH>
                <TH>Last updated</TH>
              </TR>
            </THead>
            <TBody>
              {Object.keys(KPI_METRIC_LABELS).map((metric) => {
                const e = effective(metric);
                const stored = rows?.[metric];
                const isDirty = !!dirty[metric];
                return (
                  <TR key={metric}>
                    <TD>
                      {KPI_METRIC_LABELS[metric]}
                      {isDirty && <Badge tone="neutral" className="ml-2">Unsaved</Badge>}
                    </TD>
                    <TD>
                      <Input
                        type="number"
                        step="any"
                        value={e.target ?? ""}
                        placeholder="—"
                        disabled={!canAdmin}
                        aria-label={`${KPI_METRIC_LABELS[metric]} target`}
                        onChange={(ev) => edit(metric, { target: ev.target.value })}
                        className="w-28 u-nums"
                      />
                    </TD>
                    <TD>
                      <Select
                        value={e.lowerIsBetter ? "lower" : "higher"}
                        disabled={!canAdmin}
                        aria-label={`${KPI_METRIC_LABELS[metric]} direction`}
                        onChange={(ev) => edit(metric, { lowerIsBetter: ev.target.value === "lower" })}
                        className="w-40"
                      >
                        <option value="higher">Higher is better</option>
                        <option value="lower">Lower is better</option>
                      </Select>
                    </TD>
                    <TD>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        step="any"
                        value={e.amberBandPct ?? 10}
                        disabled={!canAdmin}
                        aria-label={`${KPI_METRIC_LABELS[metric]} amber band percent`}
                        onChange={(ev) => edit(metric, { amberBandPct: ev.target.value })}
                        className="w-28 u-nums"
                      />
                    </TD>
                    <TD className="text-ink-secondary">
                      {stored?.updatedAt
                        ? `${new Date(stored.updatedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}${stored.updatedBy ? ` · ${stored.updatedBy}` : ""}`
                        : stored ? "seeded" : "no target set"}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}

// ── Blackout days (owner ask 2026-07-14) ─────────────────────────────────
// Take a day off: any date added here disappears from every customer-facing
// offer surface (booking funnel, reschedule links, estimate slots, Waves AI
// searches) — enforced server-side at the slot engine's date enumeration.
// Admin manual scheduling stays possible on purpose.
const WEEKDAY_CHIP_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Link Library (Settings ▸ General ▸ Link Library) ──────────────────────
// The SMS composer's Insert Link sheet reads from this library. Rows marked
// Synced maintain themselves (website pages from the sitemap nightly, Google
// review links from the office config); hand-added rows are managed here.
const LINK_LIBRARY_CATEGORIES = [
  ["reviews", "Reviews"],
  ["booking", "Booking & quotes"],
  ["app", "Waves app"],
  ["website", "Website"],
  ["social", "Social"],
];
const LINK_LIBRARY_CATEGORY_LABELS = Object.fromEntries(LINK_LIBRARY_CATEGORIES);

function LinkLibraryTab() {
  const [links, setLinks] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [notice, setNotice] = useState(null); // { ok, text }
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ name: "", url: "", category: "website", clause: "" });

  const load = () => {
    setLoadErr(null);
    adminFetch("/admin/communications/link-library")
      .then((d) => {
        setLinks(Array.isArray(d.links) ? d.links : []);
        setLastSyncedAt(d.lastSyncedAt || null);
      })
      .catch((e) => setLoadErr(e.message));
  };
  useEffect(load, []);

  const handleSync = async (force = false) => {
    // A sync that would delete more than the shrinkage cap is refused (a
    // truncated sitemap must not erase the library). After a REAL site
    // restructure the owner confirms once and re-runs with force.
    if (
      force &&
      !window.confirm(
        "The sitemap now has far fewer pages than the library. Force-sync and delete every stored page no longer in it?",
      )
    ) {
      return;
    }
    setSyncing(true);
    setNotice(null);
    try {
      const r = await adminFetch("/admin/communications/link-library/sync", {
        method: "POST",
        body: JSON.stringify(force ? { force: true } : {}),
      });
      setNotice({ ok: true, text: `Synced ${r.fetched} website pages — ${r.added} added, ${r.updated} renamed, ${r.removed} removed.` });
      load();
    } catch (e) {
      const shrinkage = /implausible shrinkage/i.test(String(e.message || ""));
      setNotice({ ok: false, text: e.message, ...(shrinkage ? { shrinkage: true } : {}) });
    } finally {
      setSyncing(false);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setNotice(null);
    try {
      await adminFetch("/admin/communications/link-library", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setNotice({ ok: true, text: `${form.name.trim()} added — it's now searchable in the composer.` });
      setForm({ name: "", url: "", category: "website", clause: "" });
      load();
    } catch (err) {
      setNotice({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (row) => {
    setNotice(null);
    try {
      await adminFetch(`/admin/communications/link-library/${row.id}`, { method: "DELETE" });
      setNotice({ ok: true, text: `${row.name} removed.` });
      load();
    } catch (err) {
      setNotice({ ok: false, text: err.message });
    }
  };

  const all = links || [];
  const sitemapCount = all.filter((l) => l.source === "sitemap").length;
  const q = search.trim().toLowerCase();
  const matches = (l) =>
    !q ||
    q.split(/\s+/).every((t) =>
      `${l.name} ${l.url} ${l.keywords || ""} ${LINK_LIBRARY_CATEGORY_LABELS[l.category] || ""}`
        .toLowerCase()
        .includes(t),
    );
  // Without a search the ~600 sitemap rows stay collapsed behind their count;
  // office + manual rows always list.
  const visible = all.filter((l) => (q ? matches(l) : l.source !== "sitemap"));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Link library</CardTitle>
          <Button variant="secondary" onClick={() => handleSync()} loading={syncing}>
            {syncing ? "Syncing…" : "Sync website pages now"}
          </Button>
        </CardHeader>
        <CardBody className="space-y-3">
        <p className="text-ui-body text-ink-secondary">
          Everything here is searchable from the Messages composer's Insert Link button. Synced rows
          maintain themselves — website pages come from the wavespestcontrol.com sitemap nightly and
          the Google review links from the office list. Add anything else below.
        </p>
        <p className="text-ui-caption text-ink-secondary u-nums">
          {links === null && !loadErr ? "Loading…" : `${all.length} links (${sitemapCount} website pages)`}
          {lastSyncedAt && ` · website pages last synced ${new Date(lastSyncedAt).toLocaleString()}`}
        </p>
        {loadErr && <ActionFeedback error onRetry={load}>{loadErr}</ActionFeedback>}
        {notice && (
          <ActionFeedback error={!notice.ok}>
            <span>{notice.text}</span>
            {notice.shrinkage && (
              <Button variant="danger" onClick={() => handleSync(true)} loading={syncing}>
                Force full reconcile…
              </Button>
            )}
          </ActionFeedback>
        )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Saved links</CardTitle></CardHeader>
        <CardBody>
        <Field label="Search links" className="mb-3">
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search all ${all.length || ""} links — try 'termite', 'review', 'app'…`} />
        </Field>
        {!q && sitemapCount > 0 && (
          <p className="mb-2 text-ui-caption text-ink-secondary">
            Plus {sitemapCount} website pages synced from the sitemap — search to find one.
          </p>
        )}
        <div className="divide-y divide-zinc-200">
          {visible.map((row) => {
            const synced = row.source !== "manual";
            return (
              <div key={row.key || row.id} className="flex min-h-14 items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-zinc-900">{row.name}</div>
                  <div className="truncate text-ui-caption text-ink-secondary">
                    {String(row.url).replace(/^https?:\/\//, "")}
                  </div>
                </div>
                <Badge tone={synced ? "strong" : "neutral"} className="shrink-0">
                  {synced ? "Synced" : LINK_LIBRARY_CATEGORY_LABELS[row.category] || row.category}
                </Badge>
                {!synced && (
                  <Button
                    variant="ghost"
                    onClick={() => handleRemove(row)}
                    aria-label={`Remove ${row.name}`}
                    className="shrink-0 px-3"
                  >
                    <X size={16} aria-hidden />
                  </Button>
                )}
              </div>
            );
          })}
          {links !== null && !visible.length && (
            <div className="py-6 text-center text-ink-secondary">
              No links match &ldquo;{search.trim()}&rdquo;.
            </div>
          )}
        </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Add a link</CardTitle></CardHeader>
        <CardBody>
        <form onSubmit={handleAdd} className="grid gap-3">
          <Field label="Link name" required><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Name — e.g. Termite inspection video" /></Field>
          <Field label="Link URL" required><Input type="url" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://…" /></Field>
          <Field label="Category"><Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>{LINK_LIBRARY_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
          <Field label="Message text before the link"><Input value={form.clause} onChange={(e) => setForm((f) => ({ ...f, clause: e.target.value }))} placeholder="Text before the link (optional) — e.g. Watch our termite video here" /></Field>
          <Button type="submit" loading={saving} className="sm:justify-self-start">
            {saving ? "Adding…" : "Add link"}
          </Button>
        </form>
        </CardBody>
      </Card>
    </div>
  );
}

function BlackoutDaysTab() {
  const [blackouts, setBlackouts] = useState([]);
  const [weeklyDaysOff, setWeeklyDaysOff] = useState([]);
  const [weeklySaving, setWeeklySaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = () => {
    adminFetch("/admin/schedule/blackout-dates")
      .then((d) => {
        setBlackouts(d.blackouts || []);
        setWeeklyDaysOff(d.weeklyDaysOff || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const toggleWeeklyDay = async (dow) => {
    // Whole-array PUT: chips are disabled while a save is in flight so an
    // older snapshot can never finish last and overwrite a newer click.
    if (weeklySaving) return;
    const prev = weeklyDaysOff;
    const next = prev.includes(dow)
      ? prev.filter((d) => d !== dow)
      : [...prev, dow].sort((a, b) => a - b);
    setWeeklySaving(true);
    setWeeklyDaysOff(next); // optimistic — reverted on failure
    setError(null);
    try {
      const d = await adminFetch("/admin/schedule/blackout-dates/weekly", {
        method: "PUT",
        body: JSON.stringify({ daysOff: next }),
      });
      if (d?.error) throw new Error(d.error);
      setWeeklyDaysOff(d.weeklyDaysOff || next);
    } catch (e) {
      setWeeklyDaysOff(prev);
      setError(e.message);
    } finally {
      setWeeklySaving(false);
    }
  };

  const add = async () => {
    if (!date || saving) return;
    setSaving(true);
    setError(null);
    try {
      const d = await adminFetch("/admin/schedule/blackout-dates", {
        method: "POST",
        body: JSON.stringify({ date, reason: reason || null }),
      });
      if (d.error) throw new Error(d.error);
      setDate("");
      setReason("");
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    try {
      // adminFetch resolves parsed JSON even for non-401 HTTP errors — check
      // the body before mutating state, or a failed DELETE would show the
      // date as unblocked while it still blocks prod.
      const d = await adminFetch(`/admin/schedule/blackout-dates/${id}`, { method: "DELETE" });
      if (d?.error) throw new Error(d.error);
      setBlackouts((prev) => prev.filter((b) => b.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  const fmtDay = (d) => {
    try {
      const [y, m, day] = d.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, day, 12)).toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
      });
    } catch { return d; }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Blackout days</CardTitle>
        <p className="mt-1 text-ui-body text-ink-secondary">
        Days off. Customers can't book, reschedule into, or be offered these
        dates anywhere — booking funnel, reschedule links, estimate slots, and
        Waves AI searches all skip them. You can still schedule manually from
        dispatch if you choose to.
        </p>
      </CardHeader>
      <CardBody>
      <h4 className="text-ui-body font-medium text-zinc-900">Weekly days off</h4>
      <p className="mt-1 text-ui-body text-ink-secondary">
        Highlighted days are closed every week — removed from all the same
        customer-facing surfaces as the one-off dates below.
      </p>
      <div className="my-4 flex flex-wrap gap-2">
        {WEEKDAY_CHIP_LABELS.map((label, dow) => {
          const off = weeklyDaysOff.includes(dow);
          return (
            <Button
              key={label}
              variant={off ? "primary" : "secondary"}
              onClick={() => toggleWeeklyDay(dow)}
              disabled={weeklySaving}
              aria-pressed={off}
              aria-label={`${label} ${off ? "closed" : "open"} weekly`}
            >
              {label}
            </Button>
          );
        })}
      </div>

      <div className="mb-4 grid items-end gap-3 md:grid-cols-[minmax(180px,0.6fr)_minmax(240px,1fr)_auto]">
        <Field label="Blackout date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional — e.g. Vacation" maxLength={200} /></Field>
        <Button onClick={add} loading={saving} disabled={!date}>
          {saving ? "Saving…" : "Block day"}
        </Button>
      </div>

      {error && <ActionFeedback error className="mb-3">{error}</ActionFeedback>}

      {loading ? (
        <ActionFeedback className="min-h-16">Loading…</ActionFeedback>
      ) : blackouts.length === 0 ? (
        <div className="py-6 text-center text-ink-secondary">
          No blackout days set — every working day is offered.
        </div>
      ) : (
        <div className="divide-y divide-zinc-200">
          {blackouts.map((b) => (
            <div key={b.id} className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <div className="font-medium text-zinc-900 u-nums">{fmtDay(b.date)}</div>
                {b.reason && <div className="text-ui-caption text-ink-secondary">{b.reason}</div>}
              </div>
              <Button variant="secondary" onClick={() => remove(b.id)}>Unblock</Button>
            </div>
          ))}
        </div>
      )}
      </CardBody>
    </Card>
  );
}

function ServiceCoverageSettingsTab() {
  const [config, setConfig] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [serviceLine, setServiceLine] = useState("pest");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    adminFetch("/admin/settings/service-coverage")
      .then((data) => {
        setConfig(data.config || data.defaults);
        setDefaults(data.defaults || data.config);
      })
      .catch((err) => setMessage(err.message || "Could not load Service Coverage settings."));
  }, []);

  const update = (patch) => setConfig((current) => deepMergeConfig(current || defaults || {}, patch));
  const currentIntroKey = serviceLine === "default" ? "default" : serviceLine;
  const previewTitle = serviceLine === "default"
    ? config?.defaultTitle
    : config?.titleByServiceLine?.[serviceLine] || config?.defaultTitle;
  const previewIntro = config?.introByServiceLine?.[currentIntroKey] || config?.introByServiceLine?.default;

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const data = await adminFetch("/admin/settings/service-coverage", {
        method: "PUT",
        body: JSON.stringify({ config }),
      });
      setConfig(data.config || config);
      setMessage("Service Coverage settings saved.");
    } catch (err) {
      setMessage(err.message || "Could not save Service Coverage settings.");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setMessage("");
    try {
      const data = await adminFetch("/admin/settings/service-coverage/reset", { method: "POST" });
      setConfig(data.config || defaults);
      setMessage("Service Coverage settings restored to defaults.");
    } catch (err) {
      setMessage(err.message || "Could not restore Service Coverage settings.");
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return <ActionFeedback className="min-h-20">Loading Service Coverage settings...</ActionFeedback>;
  }

  return (
    <div className="space-y-5">
      <VisitTimelineSettingsCard />

      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle>Service coverage</CardTitle>
            <p className="mt-1 text-ui-body text-ink-secondary">
              Configure the unified customer-facing report card that combines serviced areas, technician-marked coverage, map display, and status wording.
            </p>
          </div>
          <div className="ui-record-actions">
            <Button variant="secondary" onClick={reset} disabled={saving}>
              <RotateCcw size={15} aria-hidden /> Restore defaults
            </Button>
            <Button onClick={save} loading={saving}>
              <Save size={15} aria-hidden /> {saving ? "Saving..." : "Save settings"}
            </Button>
          </div>
        </CardHeader>
        {message && <CardBody><ActionFeedback error={message.includes("Could not")}>{message}</ActionFeedback></CardBody>}
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Visibility</CardTitle></CardHeader>
            <CardBody>
            <Toggle checked={!!config.enabled} onChange={(value) => update({ enabled: value })} label="Enable Service Coverage" description="Build the normalized coverage object for service reports." />
            <Toggle checked={!!config.showOnCustomerReports} onChange={(value) => update({ showOnCustomerReports: value })} label="Show on customer reports" description="Hide this when coverage data should remain internal." />
            <Toggle checked={config.showSummaryCounts !== false} onChange={(value) => update({ showSummaryCounts: value })} label="Show summary counts" description="Completed, inspected, inaccessible, and needs attention chips." />
            <Toggle checked={config.showMap !== false} onChange={(value) => update({ showMap: value })} label="Show map" description="Do not render a blank map when no technician-marked map data exists." />
            <Toggle checked={config.showList !== false} onChange={(value) => update({ showList: value })} label="Show list" description="Show customer-friendly area, station, plant group, or lawn section rows." />
            <Toggle checked={config.showAddress !== false} onChange={(value) => update({ showAddress: value })} label="Show address" />
            <Toggle checked={config.showServiceDate !== false} onChange={(value) => update({ showServiceDate: value })} label="Show service date" />
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Copy by service line</CardTitle></CardHeader>
            <CardBody className="space-y-3">
            <div className="flex flex-wrap gap-2" aria-label="Service line">
              {SERVICE_COVERAGE_SERVICE_LINES.map((line) => (
                <Button
                  key={line.key}
                  variant={serviceLine === line.key ? "primary" : "secondary"}
                  aria-pressed={serviceLine === line.key}
                  onClick={() => setServiceLine(line.key)}
                >
                  {line.label}
                </Button>
              ))}
            </div>
            <Field label="Title">
              <Input
                value={serviceLine === "default" ? config.defaultTitle : config.titleByServiceLine?.[serviceLine] || ""}
                onChange={(event) => {
                  if (serviceLine === "default") update({ defaultTitle: event.target.value });
                  else update({ titleByServiceLine: { [serviceLine]: event.target.value } });
                }}
              />
            </Field>
            <Field label="Intro text">
              <Textarea
                value={config.introByServiceLine?.[currentIntroKey] || ""}
                onChange={(event) => update({ introByServiceLine: { [currentIntroKey]: event.target.value } })}
                rows={3}
              />
            </Field>
            <Field label="Disclaimer">
              <Textarea
                value={config.disclaimerText || ""}
                onChange={(event) => update({ disclaimerText: event.target.value })}
                rows={2}
              />
            </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Map privacy and notes</CardTitle></CardHeader>
            <CardBody>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Default layout">
                <Select value={config.defaultLayout || "split"} onChange={(event) => update({ defaultLayout: event.target.value })}>
                  <option value="split">Map right / list left</option>
                  <option value="map_top">Map top / list below</option>
                  <option value="list_only">List only</option>
                  <option value="map_only">Map only</option>
                </Select>
              </Field>
              <Field label="Map precision">
                <Select value={config.mapPrecisionMode || "exact"} onChange={(event) => update({ mapPrecisionMode: event.target.value })}>
                  <option value="exact">Exact pins</option>
                  <option value="approximate">Approximate zones</option>
                  <option value="hidden">Hide map</option>
                </Select>
              </Field>
            </div>
            <Toggle checked={config.showInaccessibleReasonsToCustomer !== false} onChange={(value) => update({ showInaccessibleReasonsToCustomer: value })} label="Show inaccessible reasons" />
            <Toggle checked={!!config.showTechnicianNotesToCustomer} onChange={(value) => update({ showTechnicianNotesToCustomer: value })} label="Show technician notes" description="Default should stay off for internal-only notes." />
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>Customer status labels</CardTitle></CardHeader>
            <CardBody className="grid gap-3 sm:grid-cols-2">
              {SERVICE_COVERAGE_STATUS_KEYS.map((key) => (
                <Field key={key} label={key.replace(/_/g, " ")}>
                  <Input
                    value={config.statusLabels?.[key] || ""}
                    onChange={(event) => update({ statusLabels: { [key]: event.target.value } })}
                  />
                </Field>
              ))}
            </CardBody>
          </Card>
        </div>

        <ServiceCoverageAdminPreview
          title={previewTitle}
          intro={previewIntro}
          disclaimer={config.disclaimerText}
          showMap={config.showMap !== false && config.mapPrecisionMode !== "hidden"}
          showList={config.showList !== false}
          showSummary={config.showSummaryCounts !== false}
          statusLabels={config.statusLabels || {}}
          serviceLine={serviceLine === "default" ? "pest" : serviceLine}
        />
      </div>
    </div>
  );
}

function ServiceCoverageAdminPreview({ title, intro, disclaimer, showMap, showList, showSummary, statusLabels, serviceLine }) {
  const sampleItems = serviceLine === "lawn"
    ? [
      { label: "A", area: "Front Lawn", description: "Lawn treatment completed.", status: "completed" },
      { label: "B", area: "Landscape Beds", description: "Weed control applied.", status: "completed" },
    ]
    : serviceLine === "termite"
      ? [
        { label: "A", area: "Station 4", description: "Station checked.", status: "checked" },
        { label: "B", area: "Station 8", description: "Bait replaced and station checked.", status: "completed" },
      ]
      : [
        { label: "A", area: "Perimeter", description: "Exterior perimeter service completed.", status: "completed" },
        { label: "B", area: "Entry Points", description: "Entry points inspected and treated.", status: "completed" },
      ];

  return (
    <Card className="lg:sticky lg:top-4">
      <CardHeader><CardTitle>Preview</CardTitle></CardHeader>
      <CardBody>
      <div className="rounded-md border-hairline border-zinc-200 bg-zinc-50 p-4">
        <h4 className="text-22 leading-[1.3] font-medium text-zinc-900">{title || "Service Coverage"}</h4>
        <p className="mt-1 text-ui-body text-ink-secondary">{intro}</p>
        <div className="mt-3 text-ui-caption text-ink-secondary u-nums">
          <div>12312 Cedar Pass Trl, Parrish, FL 34219</div>
          <div>Sunday, May 17, 2026</div>
        </div>
        {showSummary && (
          <div className="mt-3 flex flex-wrap gap-2">
            {["Completed: 2", "Inspected: 0", "Inaccessible: 0", "Needs Attention: 0"].map((chip) => (
              <Badge key={chip} tone="neutral">{chip}</Badge>
            ))}
          </div>
        )}
        {showMap && (
          <div className="relative mt-3 h-[150px] overflow-hidden rounded-md border-hairline border-zinc-200 bg-zinc-100">
            {sampleItems.map((item, index) => (
              <span
                key={item.label}
                className={cn(
                  "absolute flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 font-medium text-white",
                  index === 0 ? "left-[28%] top-[42%]" : "left-[60%] top-[54%]",
                )}
              >
                {item.label}
              </span>
            ))}
          </div>
        )}
        {showList && (
          <div className="mt-3 grid gap-2">
            {sampleItems.map((item) => (
              <div key={item.label} className="flex flex-wrap items-center justify-between gap-3 rounded-md border-hairline border-zinc-200 bg-white p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 font-medium text-white">
                    {item.label}
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium text-zinc-900">{item.area}</div>
                    <div className="text-ui-caption text-ink-secondary">{item.description}</div>
                  </div>
                </div>
                <Badge tone="strong">{statusLabels[item.status] || "Completed"}</Badge>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-ui-caption text-ink-secondary">{disclaimer}</p>
      </div>
      </CardBody>
    </Card>
  );
}

// Per-location Google Business Profile OAuth connect. Each location authorizes
// its own Google account, so this lists all four with a Connect button. The
// click fetches the consent URL with the admin bearer token (a top-level
// redirect can't carry that header), then navigates the browser to Google.
function GbpConnectSection() {
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const params = new URLSearchParams(window.location.search);
  const justConnected =
    params.get("gbpOAuth") === "success" ? params.get("location") : null;

  const load = () => {
    setLoading(true);
    adminFetch("/admin/gbp/locations")
      .then((d) => setLocations(d.locations || []))
      .catch(() => setLocations([]))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const connect = async (id) => {
    setBusy(id);
    try {
      const d = await adminFetch(
        `/admin/settings/google/auth-url?location=${encodeURIComponent(id)}`,
      );
      if (d.url) {
        window.location.href = d.url; // off to Google's consent screen
        return;
      }
      alert(d.error || "Could not start Google connection");
    } catch (e) {
      alert("Connect failed: " + e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Business Profile — per-location connection</CardTitle>
        <p className="mt-1 text-ui-body text-ink-secondary">
        Each location authorizes its own Google account. Connect a location to
        enable auto-posting (newsletters, updates) and review replies for that
        profile. Sign in as the Google account that manages that location.
        </p>
      </CardHeader>
      <CardBody>
      {justConnected && (
        <ActionFeedback className="mb-3">Connected {justConnected}. Status below may take a moment to refresh.</ActionFeedback>
      )}
      {loading ? (
        <ActionFeedback className="min-h-16">Loading…</ActionFeedback>
      ) : (
        <div className="divide-y divide-zinc-200">
          {locations.map((loc) => (
            <div key={loc.id} className="flex min-h-16 flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-zinc-900">{loc.name}</div>
                <div className="mt-1" title={loc.authError || ""}>
                  <Badge tone={loc.authError ? "alert" : loc.hasCredentials ? "strong" : "neutral"} dot>
                    {loc.hasCredentials ? "Connected" : loc.authError ? "Auth error — reconnect" : "Not connected"}
                  </Badge>
                </div>
              </div>
              <Button variant={loc.hasCredentials ? "secondary" : "primary"} onClick={() => connect(loc.id)} loading={busy === loc.id}>
                {busy === loc.id ? "Opening…" : loc.hasCredentials ? "Reconnect" : "Connect"}
              </Button>
            </div>
          ))}
        </div>
      )}
      </CardBody>
    </Card>
  );
}

// LinkedIn is a single owned company page (unlike GBP's four locations), so this
// is one Connect button + status. Click fetches the consent URL with the admin
// bearer token, then navigates the browser to LinkedIn.
function LinkedInConnectSection() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const justConnected = params.get("linkedinOAuth") === "success";
  const oauthFailed = params.get("linkedinOAuth") === "error";

  const load = () => {
    setLoading(true);
    adminFetch("/admin/settings/linkedin/status")
      .then((d) => setStatus(d))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const connect = async () => {
    setBusy(true);
    try {
      const d = await adminFetch("/admin/settings/linkedin/auth-url");
      if (d.url) {
        window.location.href = d.url; // off to LinkedIn's consent screen
        return;
      }
      alert(d.error || "Could not start LinkedIn connection");
    } catch (e) {
      alert("Connect failed: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  const connected = !!status?.connected;
  // OAuth succeeded but the authorizing member doesn't administer the configured
  // company page — every company-page post will 403, so flag it instead of green.
  const orgMismatch = connected && status?.orgVerified === false;
  return (
    <Card>
      <CardHeader>
        <CardTitle>LinkedIn — company page connection</CardTitle>
        <p className="mt-1 text-ui-body text-ink-secondary">
        Authorize the Waves LinkedIn Company Page to enable posting (blog shares,
        updates) from the marketing tools. Sign in as an admin of the page.
        </p>
      </CardHeader>
      <CardBody>
      {justConnected && (
        <ActionFeedback className="mb-3">LinkedIn connected. Status below may take a moment to refresh.</ActionFeedback>
      )}
      {oauthFailed && (
        <ActionFeedback error className="mb-3">
          LinkedIn connection didn't complete. Please try again — sign in as an
          admin of the Waves company page.
        </ActionFeedback>
      )}
      {loading ? (
        <ActionFeedback className="min-h-16">Loading…</ActionFeedback>
      ) : !status?.configured ? (
        <p className="text-ui-body text-ink-secondary">
          Not configured — set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in Railway.
        </p>
      ) : (
        <div className="flex min-h-16 flex-wrap items-center gap-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-zinc-900">Waves Pest Control</div>
            <div className={cn("mt-1 text-ui-caption", orgMismatch ? "text-alert-fg" : "text-ink-secondary")}>
              {orgMismatch
                ? "Connected, but this account doesn't administer the configured company page — Reconnect as a page admin"
                : connected
                  ? "Connected"
                  : "Not connected"}
              {connected && !orgMismatch && status?.tokenExpiresAt
                ? ` · token expires ${new Date(status.tokenExpiresAt).toLocaleDateString()}`
                : ""}
              {connected && !orgMismatch && !status?.hasRefreshToken
                ? " · no refresh token (re-auth ~60 days)"
                : ""}
            </div>
          </div>
          <Button variant={connected ? "secondary" : "primary"} onClick={connect} loading={busy}>
            {busy ? "Opening…" : connected ? "Reconnect" : "Connect"}
          </Button>
        </div>
      )}
      </CardBody>
    </Card>
  );
}

function IntegrationsTab({ canAdmin }) {
  if (!canAdmin) {
    return (
      <Card>
        <CardHeader><CardTitle>Admin access required</CardTitle></CardHeader>
        <CardBody className="text-ink-secondary">
          Integration configuration is limited to admin users.
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <GbpConnectSection />
      <LinkedInConnectSection />
      <IntegrationHealthSection />
    </div>
  );
}
