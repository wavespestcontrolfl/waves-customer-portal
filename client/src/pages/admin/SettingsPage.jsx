import { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  Building2,
  ChevronRight,
  MapPinned,
  Plug,
  RotateCcw,
  Save,
  Server,
  Settings as SettingsIcon,
  Target,
  ToggleLeft,
  Users,
} from "lucide-react";
import MobileSettingsPage from "../../components/admin/MobileSettingsPage";
import useIsMobile from "../../hooks/useIsMobile";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import IntegrationHealthSection from "../../components/admin/IntegrationHealthSection";
import {
  DEFAULT_KPI_TARGETS,
  KPI_METRIC_LABELS,
} from "./dashboard/kpi-targets";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal folded to zinc-900. Semantic green/amber/red preserved.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then((r) => {
    if (r.status === 401) {
      window.location.href = "/admin/login";
      throw new Error("Session expired");
    }
    return r.json();
  });
}

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

function Toggle({ checked, onChange, label, description }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 0",
        borderBottom: `1px solid ${D.border}`,
      }}
    >
      {" "}
      <div>
        {" "}
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
          {label}
        </div>
        {description && (
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
            {description}
          </div>
        )}
      </div>{" "}
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 44,
          height: 24,
          borderRadius: 12,
          padding: 2,
          cursor: "pointer",
          background: checked ? D.teal : D.border,
          transition: "background 0.2s",
        }}
      >
        {" "}
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            background: D.white,
            transform: checked ? "translateX(20px)" : "translateX(0)",
            transition: "transform 0.2s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          }}
        />{" "}
      </div>{" "}
    </div>
  );
}

const VALID_TABS = [
  "general",
  "integrations",
  "gates",
  "team",
  "service-reports",
  "kpi-targets",
  "system",
];

// Nav-only consolidation: the six leaf tabs collapse into four parent groups.
// Tab state still holds the LEAF key (one of VALID_TABS); these groups only drive
// which parent button is active and which leaf the parent jumps to.
const SETTINGS_TAB_GROUPS = [
  { key: "general", label: "General", Icon: Building2, tabs: ["general", "team"] },
  { key: "integrations", label: "Integrations", Icon: Plug, tabs: ["integrations"] },
  { key: "service-reports", label: "Service Reports", Icon: MapPinned, tabs: ["service-reports"] },
  // Financials grows an "Operating Costs" leaf in the dashboard lane's Phase 5.
  { key: "financials", label: "Financials", Icon: Target, tabs: ["kpi-targets"] },
  { key: "advanced", label: "Advanced", Icon: ToggleLeft, tabs: ["gates", "system"] },
];

// Per-leaf nav metadata for the sub-tab pill row.
const SETTINGS_LEAF_META = {
  general: { label: "General", Icon: Building2 },
  team: { label: "Team", Icon: Users },
  integrations: { label: "Integrations", Icon: Plug },
  "service-reports": { label: "Service Reports", Icon: MapPinned },
  "kpi-targets": { label: "KPI Targets", Icon: Target },
  gates: { label: "Feature Gates", Icon: ToggleLeft },
  system: { label: "System", Icon: Server },
};

export default function SettingsPage() {
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const [health, setHealth] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // ?tab=X deep-links from MobileSettingsPage land on the right tab.
  const initialTab = VALID_TABS.includes(searchParams.get("tab"))
    ? searchParams.get("tab")
    : "general";
  const [tab, setTab] = useState(initialTab);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/health`).then((r) => r.json()),
      adminFetch("/admin/auth/me"),
    ])
      .then(([h, u]) => {
        setHealth(h);
        setUser(u);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // On mobile — and when NOT deep-linked into a specific tab — render the
  // Square-style section index instead of the desktop tab panel.
  if (isMobile && !searchParams.get("tab")) return <MobileSettingsPage />;

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading settings...
      </div>
    );

  const gates = health?.gates || {};

  const activeGroup =
    SETTINGS_TAB_GROUPS.find((g) => g.tabs.includes(tab)) || SETTINGS_TAB_GROUPS[0];

  return (
    <div>
      {" "}
      <AdminCommandHeader
        title="Settings"
        icon={SettingsIcon}
        sections={SETTINGS_TAB_GROUPS}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = SETTINGS_TAB_GROUPS.find((x) => x.key === key);
          if (g) setTab(g.tabs[0]);
        }}
        navGridClassName="grid-cols-2 md:grid-cols-4 xl:grid-cols-4"
      />
      {activeGroup.tabs.length > 1 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 16,
          }}
        >
          {activeGroup.tabs.map((leafKey) => {
            const meta = SETTINGS_LEAF_META[leafKey];
            const LeafIcon = meta?.Icon;
            const active = tab === leafKey;
            return (
              <button
                key={leafKey}
                type="button"
                onClick={() => setTab(leafKey)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 36,
                  padding: "0 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  cursor: "pointer",
                  border: active ? "1px solid #18181B" : "1px solid #E4E4E7",
                  background: active ? "#18181B" : "#FFFFFF",
                  color: active ? "#fff" : "#27272A",
                }}
              >
                {LeafIcon && <LeafIcon size={14} strokeWidth={1.9} aria-hidden />}
                {meta?.label || leafKey}
              </button>
            );
          })}
        </div>
      )}
      {/* ── GENERAL ── */}
      {tab === "general" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {" "}
          <Card>
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: D.heading,
                marginBottom: 16,
              }}
            >
              Company Info
            </div>{" "}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              {[
                { label: "Company", value: "Waves Pest Control" },
                { label: "Main Phone", value: "(941) 318-7612" },
                { label: "Website", value: "wavespestcontrol.com" },
                {
                  label: "Service Area",
                  value:
                    "Bradenton, Sarasota, Venice, Parrish, LWR, North Port, Port Charlotte",
                },
              ].map((f, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px 14px",
                    background: D.bg,
                    borderRadius: 8,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      fontSize: 11,
                      color: D.muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      marginBottom: 4,
                    }}
                  >
                    {f.label}
                  </div>{" "}
                  <div
                    style={{ fontSize: 13, color: D.heading, fontWeight: 500 }}
                  >
                    {f.value}
                  </div>{" "}
                </div>
              ))}
            </div>{" "}
          </Card>{" "}
          <Card>
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: D.heading,
                marginBottom: 16,
              }}
            >
              Logged In As
            </div>{" "}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              {" "}
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: `linear-gradient(135deg, ${D.teal}, ${D.green})`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: D.heading,
                  fontSize: 20,
                  fontWeight: 700,
                }}
              >
                {(user?.name || "A")[0]}
              </div>{" "}
              <div>
                {" "}
                <div
                  style={{ fontSize: 15, fontWeight: 600, color: D.heading }}
                >
                  {user?.name || "Unknown"}
                </div>{" "}
                <div style={{ fontSize: 12, color: D.muted }}>
                  {user?.email} · {user?.role}
                </div>{" "}
              </div>{" "}
            </div>{" "}
          </Card>{" "}
          <Card>
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: D.heading,
                marginBottom: 16,
              }}
            >
              WaveGuard Tiers
            </div>{" "}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 10,
              }}
            >
              {[
                { tier: "Bronze", discount: "0%", color: "#CD7F32" },
                { tier: "Silver", discount: "10%", color: "#90CAF9" },
                { tier: "Gold", discount: "15%", color: "#FDD835" },
                { tier: "Platinum", discount: "20%", color: "#E5E4E2" },
              ].map((t) => (
                <div
                  key={t.tier}
                  style={{
                    padding: 14,
                    background: D.bg,
                    borderRadius: 10,
                    textAlign: "center",
                    borderTop: `3px solid ${t.color}`,
                  }}
                >
                  {" "}
                  <div
                    style={{ fontSize: 14, fontWeight: 700, color: t.color }}
                  >
                    {t.tier}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                    {t.discount} discount
                  </div>{" "}
                </div>
              ))}
            </div>{" "}
          </Card>{" "}
          <Card>
            <Link
              to="/admin/settings/pest-pressure"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 36, height: 36, borderRadius: 8,
                    background: D.bg, display: "flex",
                    alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Activity size={18} color={D.heading} />
                </div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>Pest Pressure</div>
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                    Configure the 0–5 score on customer service reports — service-line scope, weights, labels, trend thresholds, overrides, audit log.
                  </div>
                </div>
              </div>
              <ChevronRight size={18} color={D.muted} />
            </Link>
          </Card>
        </div>
      )}
      {/* ── INTEGRATIONS ── */}
      {tab === "integrations" && <IntegrationsTab canAdmin={user?.role === "admin"} />}
      {/* ── FEATURE GATES ── */}
      {tab === "gates" && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 4,
            }}
          >
            Feature Gates
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>
            Control which integrations are active. Set via Railway environment
            variables.
          </div>
          {Object.entries(gates).map(([key, enabled]) => (
            <div
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 0",
                borderBottom: `1px solid ${D.border}`,
              }}
            >
              {" "}
              <div>
                {" "}
                <div
                  style={{ fontSize: 13, fontWeight: 600, color: D.heading }}
                >
                  {key}
                </div>{" "}
                <div style={{ fontSize: 11, fontFamily: MONO, color: D.muted }}>
                  GATE_{key.replace(/([A-Z])/g, "_$1").toUpperCase()}
                </div>{" "}
              </div>{" "}
              <span
                style={{
                  padding: "4px 12px",
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 700,
                  background: enabled ? D.green + "22" : D.border + "44",
                  color: enabled ? D.green : D.muted,
                }}
              >
                {enabled ? "ENABLED" : "DISABLED"}
              </span>{" "}
            </div>
          ))}
          <div
            style={{
              marginTop: 16,
              fontSize: 12,
              color: D.muted,
              padding: "10px 14px",
              background: D.bg,
              borderRadius: 8,
              borderLeft: `3px solid ${D.border}`,
            }}
          >
            Gates are controlled via Railway environment variables. To change:
            Railway Dashboard → Variables → set GATE_NAME=true or remove the
            variable.
          </div>{" "}
        </Card>
      )}
      {/* ── TEAM ── */}
      {tab === "team" && (
        <Card>
          {" "}
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: D.heading,
              marginBottom: 16,
            }}
          >
            Team Members
          </div>{" "}
          <TeamList />{" "}
        </Card>
      )}
      {tab === "service-reports" && <ServiceCoverageSettingsTab />}
      {tab === "kpi-targets" && (
        <KpiTargetsSettingsTab canAdmin={user?.role === "admin"} />
      )}
      {/* ── SYSTEM ── */}
      {tab === "system" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {" "}
          <Card>
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: D.heading,
                marginBottom: 16,
              }}
            >
              System Info
            </div>{" "}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              {[
                { label: "Environment", value: health?.environment || "—" },
                { label: "Status", value: health?.status || "—" },
                {
                  label: "Server Time",
                  value: health?.timestamp
                    ? new Date(health.timestamp).toLocaleString()
                    : "—",
                },
                { label: "Database", value: "PostgreSQL (Railway)" },
                { label: "Frontend", value: "React (Vite)" },
                { label: "Backend", value: "Express.js" },
                { label: "AI Model", value: "Claude Sonnet 4" },
                { label: "Migrations", value: "50 migrations" },
              ].map((f, i) => (
                <div
                  key={i}
                  style={{
                    padding: "10px 14px",
                    background: D.bg,
                    borderRadius: 8,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      fontSize: 11,
                      color: D.muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      marginBottom: 4,
                    }}
                  >
                    {f.label}
                  </div>{" "}
                  <div
                    style={{ fontSize: 13, color: D.heading, fontFamily: MONO }}
                  >
                    {f.value}
                  </div>{" "}
                </div>
              ))}
            </div>{" "}
          </Card>{" "}
          <Card>
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: D.heading,
                marginBottom: 12,
              }}
            >
              Cron Jobs
            </div>{" "}
            <div
              style={{
                fontSize: 12,
                color: gates.cronJobs ? D.green : D.red,
                fontWeight: 600,
                marginBottom: 12,
              }}
            >
              Cron jobs {gates.cronJobs ? "ENABLED" : "DISABLED"}
            </div>
            {[
              {
                time: "1:30 AM Mon",
                job: "Site audit",
                gate: "seoIntelligence",
              },
              {
                time: "2:00 AM",
                job: "Rank tracking",
                gate: "seoIntelligence",
              },
              {
                time: "2:30 AM",
                job: "AI Overview check",
                gate: "seoIntelligence",
              },
              {
                time: "3:00 AM",
                job: "Customer intelligence",
                gate: "cronJobs",
              },
              {
                time: "3:30 AM Sun",
                job: "Backlink scan",
                gate: "seoIntelligence",
              },
              { time: "5:00 AM", job: "Blog auto-generate", gate: "cronJobs" },
              {
                time: "5:30 AM Mon",
                job: "Content decay check",
                gate: "seoIntelligence",
              },
              { time: "6:00 AM", job: "GSC data sync", gate: "cronJobs" },
              { time: "8:00 AM", job: "Campaign advisor", gate: "cronJobs" },
              { time: "8:00 AM Fri", job: "CSR weekly rec", gate: "cronJobs" },
              { time: "Every 2hr", job: "Ad budget adjust", gate: "cronJobs" },
              {
                time: ":30 past hr",
                job: "Follow-up verify",
                gate: "cronJobs",
              },
            ].map((c, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 0",
                  borderBottom: `1px solid ${D.border}22`,
                }}
              >
                {" "}
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background: gates[c.gate] ? D.green : D.muted,
                    flexShrink: 0,
                  }}
                />{" "}
                <span
                  style={{
                    fontSize: 12,
                    color: D.muted,
                    fontFamily: MONO,
                    width: 100,
                  }}
                >
                  {c.time}
                </span>{" "}
                <span style={{ fontSize: 12, color: D.text }}>
                  {c.job}
                </span>{" "}
              </div>
            ))}
          </Card>{" "}
        </div>
      )}
    </div>
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

function settingsInputStyle(extra = {}) {
  return {
    width: "100%",
    border: `1px solid ${D.inputBorder}`,
    borderRadius: 8,
    padding: "9px 10px",
    color: D.heading,
    background: D.white,
    fontSize: 13,
    lineHeight: 1.35,
    boxSizing: "border-box",
    ...extra,
  };
}

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
    return <Card><div style={{ color: D.muted, fontSize: 13 }}>Loading Visit Timeline settings...</div></Card>;
  }

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Visit Timeline</div>
          <div style={{ marginTop: 4, fontSize: 12, color: D.muted, lineHeight: 1.45 }}>
            Configure the customer-facing timeline that uses Bouncie for movement and Waves report finalization for service completion.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button type="button" onClick={reset} disabled={saving} style={{ ...settingsButtonStyle("secondary"), opacity: saving ? 0.6 : 1 }}>
            <RotateCcw size={15} /> Restore defaults
          </button>
          <button type="button" onClick={save} disabled={saving} style={{ ...settingsButtonStyle("primary"), opacity: saving ? 0.6 : 1 }}>
            <Save size={15} /> {saving ? "Saving..." : "Save settings"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
        <Toggle checked={config.enabled !== false} onChange={(value) => update({ enabled: value })} label="Enable Visit Timeline" description="Show one unified customer-facing visit timeline on service reports." />
        <Toggle checked={config.showOnCustomerReports !== false} onChange={(value) => update({ showOnCustomerReports: value })} label="Show on customer reports" />
        <Toggle checked={config.showTechnicianEnRoute !== false} onChange={(value) => update({ showTechnicianEnRoute: value })} label="Show technician en route" description="Source: Bouncie." />
        <Toggle checked={config.showTechnicianOnSite !== false} onChange={(value) => update({ showTechnicianOnSite: value })} label="Show technician on site" description="Source: Bouncie." />
        <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, background: "#FAFAFA" }}>
          <div style={{ fontSize: 13, color: D.heading, fontWeight: 800 }}>Service completed is required</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 3, lineHeight: 1.4 }}>
            Completed reports always show Service completed from Waves report finalization.
          </div>
        </div>
        <Toggle checked={config.showCustomerContact !== false} onChange={(value) => update({ showCustomerContact: value })} label="Show customer contact detail" description="Shown inside Visit Timeline, not as a primary milestone." />
        <Toggle checked={config.showReportGenerated === true} onChange={(value) => update({ showReportGenerated: value })} label="Show report generated detail" description="Secondary detail only. Hidden by default." />
        <Toggle checked={config.showDuration === true} onChange={(value) => update({ showDuration: value })} label="Show duration when reliable" />
        <label style={settingsLabelStyle}>
          Minimum reliable duration
          <input
            type="number"
            min="1"
            value={config.minimumDurationMinutes || 5}
            onChange={(event) => update({ minimumDurationMinutes: Number(event.target.value) || 5 })}
            style={settingsInputStyle()}
          />
        </label>
        <Toggle checked={config.showTimingNoteWhenDurationUnavailable !== false} onChange={(value) => update({ showTimingNoteWhenDurationUnavailable: value })} label="Show timing note when duration is unavailable" />
        <Toggle checked={config.showDataSourceNote !== false} onChange={(value) => update({ showDataSourceNote: value })} label="Show data source note" />
        <label style={settingsLabelStyle}>
          Data source note
          <textarea
            rows={2}
            value={config.dataSourceNote || ""}
            onChange={(event) => update({ dataSourceNote: event.target.value })}
            style={settingsInputStyle({ resize: "vertical" })}
          />
        </label>
      </div>
      {message && <div style={{ marginTop: 12, fontSize: 12, color: message.includes("Could not") ? D.red : D.green }}>{message}</div>}
    </Card>
  );
}

// Editable red/amber/green thresholds for the dashboard KPI tiles
// (/api/admin/kpi-targets, seeded from the old hardcoded values). Every
// snapshot metric is listed — ones without a target simply have no tone until
// the owner sets one. The dashboard falls back to DEFAULT_KPI_TARGETS when a
// row is missing, so clearing a field here never blanks a tile.
function KpiTargetsSettingsTab({ canAdmin }) {
  const [rows, setRows] = useState(null); // { [metric]: stored row }
  const [dirty, setDirty] = useState({}); // { [metric]: { target?, amberBandPct?, lowerIsBetter? } }
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    adminFetch("/admin/kpi-targets")
      .then((data) => {
        const byMetric = {};
        for (const row of data.targets || []) byMetric[row.metric] = row;
        setRows(byMetric);
      })
      .catch((err) => setMessage(err.message || "Could not load KPI targets."));
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
        setMessage(`Enter a numeric target for "${KPI_METRIC_LABELS[metric] || metric}" (or discard the edit).`);
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
      setMessage("Nothing to save yet — edit a target first.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const result = await adminFetch("/admin/kpi-targets", {
        method: "PUT",
        body: JSON.stringify({ targets }),
      });
      if (result?.error) throw new Error(result.error);
      setRows((prev) => {
        const next = { ...(prev || {}) };
        for (const t of targets) next[t.metric] = { ...(next[t.metric] || {}), ...t };
        return next;
      });
      setDirty({});
      setMessage(`Saved ${targets.length} target${targets.length === 1 ? "" : "s"}. Dashboard tiles pick this up on their next refresh.`);
    } catch (err) {
      setMessage(err.message || "Could not save KPI targets.");
    } finally {
      setSaving(false);
    }
  };

  if (!rows && !message) {
    return <Card><div style={{ color: D.muted, fontSize: 13 }}>Loading KPI targets...</div></Card>;
  }

  const inputStyle = {
    width: 90,
    padding: "6px 8px",
    fontSize: 13,
    fontFamily: MONO,
    border: `1px solid ${D.inputBorder}`,
    borderRadius: 6,
    background: D.white,
    color: D.text,
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>KPI Targets</div>
            <div style={{ marginTop: 4, fontSize: 12, color: D.muted, lineHeight: 1.45 }}>
              Dashboard tiles color against these: green at/above target, amber within the band, red beyond it.
              "Lower is better" flips the comparison (callback rate, AR days, response speed).
            </div>
          </div>
          {canAdmin && (
            <button
              type="button"
              onClick={save}
              disabled={saving || Object.keys(dirty).length === 0}
              style={{ ...settingsButtonStyle("primary"), opacity: saving || Object.keys(dirty).length === 0 ? 0.6 : 1 }}
            >
              <Save size={15} /> {saving ? "Saving..." : "Save targets"}
            </button>
          )}
        </div>
        {message && (
          <div style={{ marginTop: 12, fontSize: 12, color: /Could not|Enter a numeric/.test(message) ? D.red : D.green }}>
            {message}
          </div>
        )}
      </Card>

      <Card>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: D.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                <th style={{ padding: "6px 10px 10px 0" }}>Metric</th>
                <th style={{ padding: "6px 10px 10px 0" }}>Target</th>
                <th style={{ padding: "6px 10px 10px 0" }}>Direction</th>
                <th style={{ padding: "6px 10px 10px 0" }}>Amber band %</th>
                <th style={{ padding: "6px 0 10px 0" }}>Last updated</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(KPI_METRIC_LABELS).map((metric) => {
                const e = effective(metric);
                const stored = rows?.[metric];
                const isDirty = !!dirty[metric];
                return (
                  <tr key={metric} style={{ borderTop: `1px solid ${D.border}` }}>
                    <td style={{ padding: "10px 10px 10px 0", color: D.text }}>
                      {KPI_METRIC_LABELS[metric]}
                      {isDirty && <span style={{ color: D.amber, marginLeft: 6 }}>•</span>}
                    </td>
                    <td style={{ padding: "10px 10px 10px 0" }}>
                      <input
                        type="number"
                        step="any"
                        value={e.target ?? ""}
                        placeholder="—"
                        disabled={!canAdmin}
                        onChange={(ev) => edit(metric, { target: ev.target.value })}
                        style={inputStyle}
                      />
                    </td>
                    <td style={{ padding: "10px 10px 10px 0" }}>
                      <select
                        value={e.lowerIsBetter ? "lower" : "higher"}
                        disabled={!canAdmin}
                        onChange={(ev) => edit(metric, { lowerIsBetter: ev.target.value === "lower" })}
                        style={{ ...inputStyle, width: 130, fontFamily: "inherit" }}
                      >
                        <option value="higher">Higher is better</option>
                        <option value="lower">Lower is better</option>
                      </select>
                    </td>
                    <td style={{ padding: "10px 10px 10px 0" }}>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="any"
                        value={e.amberBandPct ?? 10}
                        disabled={!canAdmin}
                        onChange={(ev) => edit(metric, { amberBandPct: ev.target.value })}
                        style={inputStyle}
                      />
                    </td>
                    <td style={{ padding: "10px 0", color: D.muted, fontSize: 12 }}>
                      {stored?.updatedAt
                        ? `${new Date(stored.updatedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}${stored.updatedBy ? ` · ${stored.updatedBy}` : ""}`
                        : stored ? "seeded" : "no target set"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
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
    return <Card><div style={{ color: D.muted, fontSize: 13 }}>Loading Service Coverage settings...</div></Card>;
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <VisitTimelineSettingsCard />

      <Card>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>Service Coverage</div>
            <div style={{ marginTop: 4, fontSize: 12, color: D.muted, lineHeight: 1.45 }}>
              Configure the unified customer-facing report card that combines serviced areas, technician-marked coverage, map display, and status wording.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button type="button" onClick={reset} disabled={saving} style={{ ...settingsButtonStyle("secondary"), opacity: saving ? 0.6 : 1 }}>
              <RotateCcw size={15} /> Restore defaults
            </button>
            <button type="button" onClick={save} disabled={saving} style={{ ...settingsButtonStyle("primary"), opacity: saving ? 0.6 : 1 }}>
              <Save size={15} /> {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </div>
        {message && <div style={{ marginTop: 12, fontSize: 12, color: message.includes("Could not") ? D.red : D.green }}>{message}</div>}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(320px, .8fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 10 }}>Visibility</div>
            <Toggle checked={!!config.enabled} onChange={(value) => update({ enabled: value })} label="Enable Service Coverage" description="Build the normalized coverage object for service reports." />
            <Toggle checked={!!config.showOnCustomerReports} onChange={(value) => update({ showOnCustomerReports: value })} label="Show on customer reports" description="Hide this when coverage data should remain internal." />
            <Toggle checked={config.showSummaryCounts !== false} onChange={(value) => update({ showSummaryCounts: value })} label="Show summary counts" description="Completed, inspected, inaccessible, and needs attention chips." />
            <Toggle checked={config.showMap !== false} onChange={(value) => update({ showMap: value })} label="Show map" description="Do not render a blank map when no technician-marked map data exists." />
            <Toggle checked={config.showList !== false} onChange={(value) => update({ showList: value })} label="Show list" description="Show customer-friendly area, station, plant group, or lawn section rows." />
            <Toggle checked={config.showAddress !== false} onChange={(value) => update({ showAddress: value })} label="Show address" />
            <Toggle checked={config.showServiceDate !== false} onChange={(value) => update({ showServiceDate: value })} label="Show service date" />
          </Card>

          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Copy by Service Line</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {SERVICE_COVERAGE_SERVICE_LINES.map((line) => (
                <button
                  type="button"
                  key={line.key}
                  onClick={() => setServiceLine(line.key)}
                  style={{
                    border: `1px solid ${serviceLine === line.key ? D.teal : D.border}`,
                    background: serviceLine === line.key ? D.teal : D.white,
                    color: serviceLine === line.key ? D.white : D.text,
                    borderRadius: 999,
                    padding: "7px 10px",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {line.label}
                </button>
              ))}
            </div>
            <label style={settingsLabelStyle}>
              Title
              <input
                value={serviceLine === "default" ? config.defaultTitle : config.titleByServiceLine?.[serviceLine] || ""}
                onChange={(event) => {
                  if (serviceLine === "default") update({ defaultTitle: event.target.value });
                  else update({ titleByServiceLine: { [serviceLine]: event.target.value } });
                }}
                style={settingsInputStyle()}
              />
            </label>
            <label style={{ ...settingsLabelStyle, marginTop: 12 }}>
              Intro text
              <textarea
                value={config.introByServiceLine?.[currentIntroKey] || ""}
                onChange={(event) => update({ introByServiceLine: { [currentIntroKey]: event.target.value } })}
                rows={3}
                style={settingsInputStyle({ resize: "vertical" })}
              />
            </label>
            <label style={{ ...settingsLabelStyle, marginTop: 12 }}>
              Disclaimer
              <textarea
                value={config.disclaimerText || ""}
                onChange={(event) => update({ disclaimerText: event.target.value })}
                rows={2}
                style={settingsInputStyle({ resize: "vertical" })}
              />
            </label>
          </Card>

          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Map Privacy and Notes</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label style={settingsLabelStyle}>
                Default layout
                <select value={config.defaultLayout || "split"} onChange={(event) => update({ defaultLayout: event.target.value })} style={settingsInputStyle()}>
                  <option value="split">Map right / list left</option>
                  <option value="map_top">Map top / list below</option>
                  <option value="list_only">List only</option>
                  <option value="map_only">Map only</option>
                </select>
              </label>
              <label style={settingsLabelStyle}>
                Map precision
                <select value={config.mapPrecisionMode || "exact"} onChange={(event) => update({ mapPrecisionMode: event.target.value })} style={settingsInputStyle()}>
                  <option value="exact">Exact pins</option>
                  <option value="approximate">Approximate zones</option>
                  <option value="hidden">Hide map</option>
                </select>
              </label>
            </div>
            <Toggle checked={config.showInaccessibleReasonsToCustomer !== false} onChange={(value) => update({ showInaccessibleReasonsToCustomer: value })} label="Show inaccessible reasons" />
            <Toggle checked={!!config.showTechnicianNotesToCustomer} onChange={(value) => update({ showTechnicianNotesToCustomer: value })} label="Show technician notes" description="Default should stay off for internal-only notes." />
          </Card>

          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, marginBottom: 12 }}>Customer Status Labels</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              {SERVICE_COVERAGE_STATUS_KEYS.map((key) => (
                <label key={key} style={settingsLabelStyle}>
                  {key.replace(/_/g, " ")}
                  <input
                    value={config.statusLabels?.[key] || ""}
                    onChange={(event) => update({ statusLabels: { [key]: event.target.value } })}
                    style={settingsInputStyle()}
                  />
                </label>
              ))}
            </div>
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

const settingsLabelStyle = {
  display: "grid",
  gap: 6,
  color: D.muted,
  fontSize: 12,
  fontWeight: 700,
  textTransform: "capitalize",
};

function settingsButtonStyle(tone) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    border: `1px solid ${tone === "primary" ? D.teal : D.border}`,
    borderRadius: 8,
    background: tone === "primary" ? D.teal : D.white,
    color: tone === "primary" ? D.white : D.text,
    padding: "8px 11px",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
  };
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
    <Card style={{ position: "sticky", top: 16 }}>
      <div style={{ fontSize: 12, color: D.muted, fontWeight: 800, textTransform: "uppercase", marginBottom: 10 }}>Preview</div>
      <div style={{ border: `1px solid ${D.border}`, borderRadius: 10, padding: 16, background: "#FAFAFA" }}>
        <h2 style={{ margin: "0 0 6px", color: D.heading, fontSize: 24, lineHeight: 1.2 }}>{title || "Service Coverage"}</h2>
        <p style={{ margin: 0, color: D.muted, fontSize: 13, lineHeight: 1.45 }}>{intro}</p>
        <div style={{ marginTop: 10, color: D.muted, fontSize: 12, lineHeight: 1.45 }}>
          <div>12312 Cedar Pass Trl, Parrish, FL 34219</div>
          <div>Sunday, May 17, 2026</div>
        </div>
        {showSummary && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {["Completed: 2", "Inspected: 0", "Inaccessible: 0", "Needs Attention: 0"].map((chip) => (
              <span key={chip} style={{ border: "1px solid #BBF7D0", background: "#DCFCE7", color: "#14532D", borderRadius: 999, padding: "6px 8px", fontSize: 11, fontWeight: 800 }}>
                {chip}
              </span>
            ))}
          </div>
        )}
        {showMap && (
          <div style={{ marginTop: 12, height: 150, border: `1px solid ${D.border}`, borderRadius: 8, background: "#EAF2F5", position: "relative", overflow: "hidden" }}>
            {sampleItems.map((item, index) => (
              <span
                key={item.label}
                style={{
                  position: "absolute",
                  left: `${28 + index * 32}%`,
                  top: `${42 + index * 12}%`,
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: D.teal,
                  color: D.white,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                {item.label}
              </span>
            ))}
          </div>
        )}
        {showList && (
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {sampleItems.map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, background: D.white }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <span style={{ width: 28, height: 28, borderRadius: 999, background: D.teal, color: D.white, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 900, flex: "0 0 auto" }}>
                    {item.label}
                  </span>
                  <div>
                    <div style={{ color: D.heading, fontSize: 13, fontWeight: 800 }}>{item.area}</div>
                    <div style={{ color: D.muted, fontSize: 12, lineHeight: 1.35 }}>{item.description}</div>
                  </div>
                </div>
                <span style={{ border: "1px solid #BBF7D0", background: "#DCFCE7", color: "#14532D", borderRadius: 999, padding: "6px 8px", fontSize: 11, fontWeight: 800 }}>
                  {statusLabels[item.status] || "Completed"}
                </span>
              </div>
            ))}
          </div>
        )}
        <p style={{ margin: "12px 0 0", color: D.muted, fontSize: 12, lineHeight: 1.45 }}>{disclaimer}</p>
      </div>
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
    <Card style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 4 }}>
        Google Business Profile — per-location connection
      </div>
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>
        Each location authorizes its own Google account. Connect a location to
        enable auto-posting (newsletters, updates) and review replies for that
        profile. Sign in as the Google account that manages that location.
      </div>
      {justConnected && (
        <div
          style={{
            fontSize: 12,
            color: D.green,
            background: D.green + "18",
            padding: "8px 12px",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          ✓ Connected {justConnected}. Status below may take a moment to refresh.
        </div>
      )}
      {loading ? (
        <div style={{ fontSize: 13, color: D.muted }}>Loading…</div>
      ) : (
        locations.map((loc) => (
          <div
            key={loc.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 0",
              borderBottom: `1px solid ${D.border}`,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
                {loc.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: loc.hasCredentials ? D.green : loc.authError ? D.red : D.muted,
                }}
                title={loc.authError || ""}
              >
                {loc.hasCredentials
                  ? "● Connected"
                  : loc.authError
                    ? "● Auth error — reconnect"
                    : "○ Not connected"}
              </div>
            </div>
            <button
              onClick={() => connect(loc.id)}
              disabled={busy === loc.id}
              style={{
                padding: "6px 14px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                cursor: busy === loc.id ? "default" : "pointer",
                border: `1px solid ${D.teal}`,
                background: loc.hasCredentials ? "transparent" : D.teal,
                color: loc.hasCredentials ? D.teal : D.white,
                opacity: busy === loc.id ? 0.5 : 1,
              }}
            >
              {busy === loc.id
                ? "Opening…"
                : loc.hasCredentials
                  ? "Reconnect"
                  : "Connect"}
            </button>
          </div>
        ))
      )}
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
    <Card style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 4 }}>
        LinkedIn — company page connection
      </div>
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>
        Authorize the Waves LinkedIn Company Page to enable posting (blog shares,
        updates) from the marketing tools. Sign in as an admin of the page.
      </div>
      {justConnected && (
        <div
          style={{
            fontSize: 12,
            color: D.green,
            background: D.green + "18",
            padding: "8px 12px",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          ✓ LinkedIn connected. Status below may take a moment to refresh.
        </div>
      )}
      {oauthFailed && (
        <div
          style={{
            fontSize: 12,
            color: D.red,
            background: D.red + "14",
            padding: "8px 12px",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          ✕ LinkedIn connection didn't complete. Please try again — sign in as an
          admin of the Waves company page.
        </div>
      )}
      {loading ? (
        <div style={{ fontSize: 13, color: D.muted }}>Loading…</div>
      ) : !status?.configured ? (
        <div style={{ fontSize: 12, color: D.muted }}>
          Not configured — set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in Railway.
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
              Waves Pest Control
            </div>
            <div style={{ fontSize: 11, color: orgMismatch ? D.amber : connected ? D.green : D.muted }}>
              {orgMismatch
                ? "⚠ Connected, but this account doesn't administer the configured company page — Reconnect as a page admin"
                : connected
                ? "● Connected"
                : "○ Not connected"}
              {connected && !orgMismatch && status?.tokenExpiresAt
                ? ` · token expires ${new Date(status.tokenExpiresAt).toLocaleDateString()}`
                : ""}
              {connected && !orgMismatch && !status?.hasRefreshToken
                ? " · no refresh token (re-auth ~60 days)"
                : ""}
            </div>
          </div>
          <button
            onClick={connect}
            disabled={busy}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? "default" : "pointer",
              border: `1px solid ${D.teal}`,
              background: connected ? "transparent" : D.teal,
              color: connected ? D.teal : D.white,
              opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? "Opening…" : connected ? "Reconnect" : "Connect"}
          </button>
        </div>
      )}
    </Card>
  );
}

function IntegrationsTab({ canAdmin }) {
  if (!canAdmin) {
    return (
      <Card>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 4 }}>
          Admin access required
        </div>
        <div style={{ fontSize: 12, color: D.muted }}>
          Integration configuration is limited to admin users.
        </div>
      </Card>
    );
  }

  return (
    <>
      <GbpConnectSection />
      <LinkedInConnectSection />
      <IntegrationHealthSection />
    </>
  );
}

function TeamList() {
  const [team, setTeam] = useState([]);
  useEffect(() => {
    adminFetch("/admin/auth/me")
      .then((me) => {
        // Just show current user for now
        setTeam([me]);
      })
      .catch(() => {});
  }, []);

  return (
    <div>
      {team.map((t, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "12px 0",
            borderBottom: `1px solid ${D.border}`,
          }}
        >
          {" "}
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: `linear-gradient(135deg, ${D.teal}, ${D.green})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: D.heading,
              fontSize: 16,
              fontWeight: 700,
            }}
          >
            {(t.name || "?")[0]}
          </div>{" "}
          <div style={{ flex: 1 }}>
            {" "}
            <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>
              {t.name}
            </div>{" "}
            <div style={{ fontSize: 12, color: D.muted }}>{t.email}</div>{" "}
          </div>{" "}
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 600,
              background: t.role === "admin" ? D.teal + "22" : D.border,
              color: t.role === "admin" ? D.teal : D.muted,
              textTransform: "capitalize",
            }}
          >
            {t.role}
          </span>{" "}
        </div>
      ))}
    </div>
  );
}
