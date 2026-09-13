import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  BarChart3,
  DollarSign,
  Gift,
  LayoutDashboard,
  ListChecks,
  Settings,
  Users,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { getAdminUser } from "../../lib/adminAuth";
import useIsMobile from "../../hooks/useIsMobile";

const API = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: legacy color names remain to preserve the inline-style
// architecture, but non-alert uses fold into the zinc ramp.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#3F3F46",
  amber: "#52525B",
  red: "#A32D2D",
  alertDot: "#C8312F",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  purple: "#18181B",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
const MONO = "'JetBrains Mono', monospace";

function af(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...opts,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const fc = (c) => "$" + (c / 100).toFixed(2);
const fd = (d) => "$" + parseFloat(d || 0).toFixed(2);

// Zinc ramp — the label carries the milestone, not a colour.
const MILESTONE_COLORS = {
  none: D.muted,
  advocate: "#52525B",
  ambassador: "#3F3F46",
  champion: "#18181B",
};
const MILESTONE_LABELS = {
  none: "--",
  advocate: "Advocate",
  ambassador: "Ambassador",
  champion: "Champion",
};

function Stat({ label, value, sub }) {
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: "16px 20px",
        flex: "1 1 0",
        minWidth: 130,
      }}
    >
      {" "}
      <div
        style={{
          color: D.muted,
          fontSize: 14,
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 6,
        }}
      >
        {label}
      </div>{" "}
      <div
        style={{
          fontFamily: MONO,
          fontSize: 24,
          fontWeight: 500,
          color: D.heading,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

function Badge({ status }) {
  const state =
    {
      active: "active",
      pending: "queued",
      contacted: "queued",
      estimated: "queued",
      pending_service: "queued",
      signed_up: "complete",
      credited: "complete",
      applied: "complete",
      earned: "complete",
      paid: "complete",
      expired: "complete",
      sms_failed: "alert",
      rejected: "alert",
    }[status] || "complete";
  const color =
    state === "alert"
      ? D.red
      : state === "active"
        ? D.heading
        : state === "queued"
          ? "#52525B"
          : D.muted;
  const filled = state === "active" || state === "alert";
  const dotColor = state === "alert" ? D.alertDot : color;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 14,
        fontFamily: MONO,
        fontWeight: state === "active" || state === "alert" ? 500 : 400,
        textTransform: "uppercase",
        color,
        letterSpacing: "0.04em",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          flex: "0 0 5px",
          borderRadius: "50%",
          boxSizing: "border-box",
          background: filled ? dotColor : "transparent",
          border: filled ? "none" : `1px solid ${color}`,
        }}
      />
      {status?.replaceAll("_", " ")}
    </span>
  );
}

function MilestoneBadge({ level }) {
  const c = MILESTONE_COLORS[level] || D.muted;
  const label = MILESTONE_LABELS[level] || level;
  if (level === "none")
    return <span style={{ color: D.muted, fontSize: 14 }}>--</span>;
  return (
    <span
      style={{
        fontSize: 14,
        fontWeight: 500,
        padding: "2px 10px",
        borderRadius: 3,
        background: D.bg,
        color: c,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {label}
    </span>
  );
}

// Shared styles
const thSt = {
  padding: "10px 14px",
  textAlign: "left",
  fontSize: 14,
  fontWeight: 500,
  color: D.muted,
  borderBottom: `1px solid ${D.border}`,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};
const thR = { ...thSt, textAlign: "right" };
const tdSt = {
  padding: "10px 14px",
  fontSize: 14,
  color: D.text,
  borderBottom: `1px solid ${D.border}`,
};
const tdR = { ...tdSt, textAlign: "right", fontFamily: MONO };
const inputSt = {
  width: "100%",
  padding: "8px 12px",
  background: D.bg,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  color: D.heading,
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};
const btnPrimary = {
  padding: "8px 18px",
  borderRadius: 8,
  border: "none",
  background: D.teal,
  color: "#fff",
  fontSize: 14,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  cursor: "pointer",
};
const btnSmall = (background, color = "#fff") => ({
  padding: "3px 10px",
  borderRadius: 4,
  border: "none",
  background,
  color,
  fontSize: 14,
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  cursor: "pointer",
});

// The flat 6-tab bar is grouped into parent sections, each revealing its leaf
// tabs in a sub-row. `tab` still holds the LEAF key, so every {tab === "..."}
// render block below is unchanged.
const REFERRALS_TAB_LEAVES = [
  { key: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { key: "queue", label: "Queue", Icon: ListChecks },
  { key: "promoters", label: "Promoters", Icon: Users },
  { key: "payouts", label: "Payouts", Icon: DollarSign },
  { key: "analytics", label: "Analytics", Icon: BarChart3 },
  { key: "settings", label: "Settings", Icon: Settings },
];
const REFERRALS_TAB_GROUPS = [
  {
    key: "overview",
    label: "Overview",
    Icon: LayoutDashboard,
    tabs: ["dashboard", "analytics"],
  },
  { key: "queue", label: "Queue", Icon: ListChecks, tabs: ["queue"] },
  {
    key: "promoters",
    label: "Promoters",
    Icon: Users,
    tabs: ["promoters", "payouts"],
  },
  { key: "settings", label: "Settings", Icon: Settings, tabs: ["settings"] },
];
const REFERRALS_LEAF_BY_KEY = Object.fromEntries(
  REFERRALS_TAB_LEAVES.map((l) => [l.key, l]),
);

export default function ReferralsPageV2() {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState("dashboard");
  const [stats, setStats] = useState(null);
  const [promoters, setPromoters] = useState([]);
  const [queue, setQueue] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [settings, setSettings] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState(null);

  // Modals
  const [convertModal, setConvertModal] = useState(null);
  const [enrollModal, setEnrollModal] = useState(false);
  const [settingsEditing, setSettingsEditing] = useState(null);

  // Customer search for enroll/convert
  const [custSearch, setCustSearch] = useState("");
  const [custResults, setCustResults] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      af("/admin/referrals/stats").catch(() => null),
      af("/admin/referrals/promoters?status=all").catch(() => ({
        promoters: [],
      })),
      af("/admin/referrals/queue").catch(() => ({ referrals: [] })),
      af("/admin/referrals/payouts").catch(() => ({ payouts: [] })),
    ]).then(([s, p, q, pay]) => {
      setStats(s);
      setPromoters(p.promoters || []);
      setQueue(q.referrals || []);
      setPayouts(pay.payouts || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab === "settings" && !settings)
      af("/admin/referrals/settings")
        .then((r) => setSettings(r.settings))
        .catch(() => {});
    if (tab === "analytics" && !analytics)
      af("/admin/referrals/analytics")
        .then((r) => setAnalytics(r))
        .catch(() => {});
  }, [tab]);

  const searchCustomers = async (q) => {
    setCustSearch(q);
    if (q.length < 2) {
      setCustResults([]);
      return;
    }
    try {
      const r = await af(
        `/admin/customers?search=${encodeURIComponent(q)}&limit=8`,
      );
      setCustResults(r.customers || []);
    } catch {
      setCustResults([]);
    }
  };

  const flash = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  const handleEnroll = async (customerId) => {
    try {
      await af("/admin/referrals/enroll", {
        method: "POST",
        body: JSON.stringify({ customerId }),
      });
      flash("Promoter enrolled");
      setEnrollModal(false);
      setCustSearch("");
      setCustResults([]);
      load();
    } catch (e) {
      flash("Error: " + e.message);
    }
  };

  // Status changes are admin-only server-side (PATCH /:id/status is
  // requireAdmin); the buttons are hidden for technicians below, and the
  // catch keeps any refusal (403/409 guard) visible instead of an
  // unhandled rejection.
  const isAdmin = getAdminUser()?.role === "admin";
  const handleStatusChange = async (id, status) => {
    try {
      await af(`/admin/referrals/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      load();
    } catch (e) {
      flash("Error: " + e.message);
    }
  };

  const handleConvert = async () => {
    if (!convertModal) return;
    try {
      await af(`/admin/referrals/${convertModal.id}/convert`, {
        method: "POST",
        body: JSON.stringify({
          customerId: convertModal.customerId,
          tier: convertModal.tier,
          monthlyValue: convertModal.monthlyValue,
        }),
      });
      flash("Referral converted");
      setConvertModal(null);
      load();
    } catch (e) {
      flash("Error: " + e.message);
    }
  };

  const handleApprovePayout = async (id) => {
    await af(`/admin/referrals/payouts/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    flash("Payout approved");
    load();
  };

  const handleSaveSettings = async () => {
    if (!settingsEditing) return;
    try {
      const r = await af("/admin/referrals/settings", {
        method: "PUT",
        body: JSON.stringify(settingsEditing),
      });
      setSettings(r.settings);
      setSettingsEditing(null);
      flash("Settings saved");
    } catch (e) {
      flash("Error: " + e.message);
    }
  };

  const copyLink = (link) => {
    navigator.clipboard.writeText(link);
    flash("Copied");
  };

  // Submit referral form state
  const [refForm, setRefForm] = useState({
    promoterId: "",
    name: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const handleSubmitRef = async () => {
    if (!refForm.name || !refForm.phone) return;
    setSubmitting(true);
    try {
      await af("/admin/referrals/submit", {
        method: "POST",
        body: JSON.stringify(refForm),
      });
      setRefForm({
        promoterId: "",
        name: "",
        phone: "",
        email: "",
        address: "",
        notes: "",
      });
      flash("Referral submitted");
      load();
    } catch (e) {
      flash("Error: " + e.message);
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div>
        {" "}
        <AdminCommandHeader title="Referrals" icon={Gift} />{" "}
        <div style={{ color: D.muted, padding: 60, textAlign: "center" }}>
          Loading referral program...
        </div>{" "}
      </div>
    );
  }

  const activeGroup =
    REFERRALS_TAB_GROUPS.find((g) => g.tabs.includes(tab)) ||
    REFERRALS_TAB_GROUPS[0];

  const filteredPromoters = search
    ? promoters.filter((p) =>
        `${p.first_name} ${p.last_name} ${p.customer_phone} ${p.referral_code}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : promoters;

  return (
    <div>
      {" "}
      <AdminCommandHeader
        title="Referrals"
        icon={Gift}
        sections={REFERRALS_TAB_GROUPS.map((g) =>
          g.key === "queue"
            ? { key: g.key, label: `${g.label} (${queue.length})`, Icon: g.Icon }
            : { key: g.key, label: g.label, Icon: g.Icon },
        )}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = REFERRALS_TAB_GROUPS.find((x) => x.key === key);
          if (g) setTab(g.tabs[0]);
        }}
        ariaLabel="Referrals section"
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
          {activeGroup.tabs.map((key) => {
            const leaf = REFERRALS_LEAF_BY_KEY[key];
            const active = tab === key;
            const LeafIcon = leaf.Icon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  height: 36,
                  padding: "0 14px",
                  borderRadius: 6,
                  fontSize: 14,
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  cursor: "pointer",
                  border: `1px solid ${active ? "#18181B" : "#E4E4E7"}`,
                  background: active ? "#18181B" : "#FFFFFF",
                  color: active ? "#fff" : "#27272A",
                }}
              >
                <LeafIcon size={14} strokeWidth={1.9} />
                {leaf.label}
              </button>
            );
          })}
        </div>
      )}
      {msg && (
        <div
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            background: msg.includes("Error") ? `${D.red}22` : D.bg,
            border: `1px solid ${msg.includes("Error") ? D.red : D.border}`,
            color: msg.includes("Error") ? D.red : D.heading,
            fontSize: 14,
            marginBottom: 16,
          }}
        >
          {msg}
        </div>
      )}
      {/* DASHBOARD */}
      {tab === "dashboard" && stats && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {" "}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {" "}
            <Stat
              label="Active Promoters"
              value={stats.activePromoters}
            />{" "}
            <Stat
              label="Referrals"
              value={stats.totalReferrals}
              sub={`${stats.convertedReferrals} converted`}
            />{" "}
            <Stat
              label="Pending"
              value={stats.pendingReferrals}
            />{" "}
            <Stat
              label="Total Rewards"
              value={fd(stats.totalRewardsDollars)}
            />{" "}
            <Stat
              label="Paid Out"
              value={fc(stats.totalPaidOutCents)}
              sub={`${stats.pendingPayouts} pending`}
            />{" "}
            <Stat
              label="Program ROI"
              value={`${stats.programROI}%`}
            />{" "}
          </div>{" "}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {" "}
            <div
              style={{
                flex: 1,
                minWidth: 300,
                background: D.card,
                borderRadius: 12,
                padding: 20,
                border: `1px solid ${D.border}`,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 500,
                  color: D.heading,
                  marginBottom: 14,
                }}
              >
                Recent Activity
              </div>
              {queue.length === 0 ? (
                <div
                  style={{
                    color: D.muted,
                    padding: 20,
                    textAlign: "center",
                    fontSize: 14,
                  }}
                >
                  No referrals yet
                </div>
              ) : (
                queue.slice(0, 8).map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "8px 0",
                      borderBottom: `1px solid ${D.border}33`,
                    }}
                  >
                    {" "}
                    <div>
                      {" "}
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: D.heading,
                        }}
                      >
                        {r.referee_name ||
                          `${r.referral_first_name || ""} ${r.referral_last_name || ""}`.trim()}
                      </div>{" "}
                      <div style={{ fontSize: 14, color: D.muted }}>
                        from{" "}
                        {r.promoter_first
                          ? `${r.promoter_first} ${r.promoter_last}`
                          : "--"}{" "}
                        / {r.source || "portal"}
                      </div>{" "}
                    </div>{" "}
                    <Badge status={r.status} />{" "}
                  </div>
                ))
              )}
            </div>{" "}
            <div
              style={{
                flex: 1,
                minWidth: 300,
                background: D.card,
                borderRadius: 12,
                padding: 20,
                border: `1px solid ${D.border}`,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 500,
                  color: D.heading,
                  marginBottom: 14,
                }}
              >
                Top Promoters
              </div>
              {promoters.filter((p) => p.total_referrals_converted > 0).length === 0 && (
                <div style={{ fontSize: 14, color: D.muted }}>
                  No converted referrals yet
                </div>
              )}
              {promoters
                .filter((p) => p.total_referrals_converted > 0)
                .slice(0, 8)
                .map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "8px 0",
                      borderBottom: `1px solid ${D.border}33`,
                    }}
                  >
                    {" "}
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      {" "}
                      <div>
                        {" "}
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 500,
                            color: D.heading,
                          }}
                        >
                          {p.first_name} {p.last_name}
                        </div>{" "}
                        <div style={{ fontSize: 14, color: D.muted }}>
                          {p.total_referrals_converted} converted /{" "}
                          {p.total_referrals_sent} sent
                        </div>{" "}
                      </div>{" "}
                      <MilestoneBadge
                        level={p.milestone_level || "none"}
                      />{" "}
                    </div>{" "}
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 14,
                        fontWeight: 500,
                        color: D.green,
                      }}
                    >
                      {fc(p.total_earned_cents)}
                    </div>{" "}
                  </div>
                ))}
            </div>{" "}
          </div>{" "}
        </div>
      )}
      {/* QUEUE */}
      {tab === "queue" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Submit form */}
          <div
            style={{
              background: D.card,
              borderRadius: 12,
              padding: 20,
              border: `1px solid ${D.border}`,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: D.heading,
                marginBottom: 12,
              }}
            >
              Submit Referral
            </div>{" "}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 8,
                marginBottom: 8,
              }}
            >
              {" "}
              <input
                placeholder="Friend's name *"
                value={refForm.name}
                onChange={(e) =>
                  setRefForm((f) => ({ ...f, name: e.target.value }))
                }
                style={inputSt}
              />{" "}
              <input
                placeholder="Phone *"
                value={refForm.phone}
                onChange={(e) =>
                  setRefForm((f) => ({ ...f, phone: e.target.value }))
                }
                style={inputSt}
              />{" "}
              <input
                placeholder="Email"
                value={refForm.email}
                onChange={(e) =>
                  setRefForm((f) => ({ ...f, email: e.target.value }))
                }
                style={inputSt}
              />{" "}
              <input
                placeholder="Promoter ID"
                value={refForm.promoterId}
                onChange={(e) =>
                  setRefForm((f) => ({ ...f, promoterId: e.target.value }))
                }
                style={inputSt}
              />{" "}
            </div>{" "}
            <div style={{ display: "flex", gap: 8 }}>
              {" "}
              <input
                placeholder="Address"
                value={refForm.address}
                onChange={(e) =>
                  setRefForm((f) => ({ ...f, address: e.target.value }))
                }
                style={{ ...inputSt, flex: 1 }}
              />{" "}
              <input
                placeholder="Notes"
                value={refForm.notes}
                onChange={(e) =>
                  setRefForm((f) => ({ ...f, notes: e.target.value }))
                }
                style={{ ...inputSt, flex: 1 }}
              />{" "}
              <button
                onClick={handleSubmitRef}
                disabled={submitting}
                style={btnPrimary}
              >
                {submitting ? "..." : "Submit"}
              </button>{" "}
            </div>{" "}
          </div>
          {/* Queue table */}
          <div
            style={{
              background: D.card,
              borderRadius: 12,
              padding: 20,
              border: `1px solid ${D.border}`,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: D.heading,
                marginBottom: 14,
              }}
            >
              Referral Queue ({queue.length})
            </div>
            {queue.length === 0 ? (
              <div
                style={{
                  color: D.muted,
                  padding: 20,
                  textAlign: "center",
                  fontSize: 14,
                }}
              >
                No pending referrals
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                {" "}
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  {" "}
                  <thead>
                    <tr>
                      <th style={thSt}>Referral</th>
                      <th style={thSt}>From</th>
                      <th style={thSt}>Source</th>
                      <th style={thSt}>Status</th>
                      <th style={thR}>Actions</th>
                    </tr>
                  </thead>{" "}
                  <tbody>
                    {queue.map((r) => (
                      <tr key={r.id}>
                        {" "}
                        <td style={tdSt}>
                          {" "}
                          <div style={{ fontWeight: 500 }}>
                            {r.referee_name ||
                              `${r.referral_first_name || ""} ${r.referral_last_name || ""}`.trim()}
                          </div>{" "}
                          <div style={{ fontSize: 14, color: D.muted }}>
                            {r.referee_phone || r.referral_phone}{" "}
                            {r.referee_email || r.referral_email
                              ? `/ ${r.referee_email || r.referral_email}`
                              : ""}
                          </div>{" "}
                        </td>{" "}
                        <td style={tdSt}>
                          {r.promoter_first
                            ? `${r.promoter_first} ${r.promoter_last}`
                            : "--"}
                        </td>{" "}
                        <td style={{ ...tdSt, fontSize: 14 }}>
                          {r.source || "portal"}
                        </td>{" "}
                        <td style={tdSt}>
                          <Badge status={r.status} />
                        </td>{" "}
                        <td style={tdR}>
                          {" "}
                          <div
                            style={{
                              display: "flex",
                              gap: 4,
                              justifyContent: "flex-end",
                            }}
                          >
                            {isAdmin && ["pending", "sms_failed"].includes(r.status) && (
                              <button
                                onClick={() =>
                                  handleStatusChange(r.id, "contacted")
                                }
                                style={btnSmall(D.teal)}
                              >
                                Contacted
                              </button>
                            )}
                            {[
                              "contacted",
                              "estimated",
                              "pending",
                              "sms_failed",
                            ].includes(r.status) && (
                              <button
                                onClick={() =>
                                  setConvertModal({
                                    id: r.id,
                                    name:
                                      r.referee_name || r.referral_first_name,
                                    customerId: "",
                                    tier: "",
                                    monthlyValue: "",
                                  })
                                }
                                style={btnSmall(D.green)}
                              >
                                Convert
                              </button>
                            )}
                            {isAdmin && !["signed_up", "credited", "rejected"].includes(
                              r.status,
                            ) && (
                              <button
                                onClick={() =>
                                  handleStatusChange(r.id, "rejected")
                                }
                                style={{
                                  ...btnSmall(D.card, D.red),
                                  border: `1px solid ${D.red}`,
                                }}
                              >
                                Reject
                              </button>
                            )}
                          </div>{" "}
                        </td>{" "}
                      </tr>
                    ))}
                  </tbody>{" "}
                </table>{" "}
              </div>
            )}
          </div>{" "}
        </div>
      )}
      {/* PROMOTERS */}
      {tab === "promoters" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {" "}
          <div style={{ display: "flex", gap: 8 }}>
            {" "}
            <input
              placeholder="Search promoters..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...inputSt, maxWidth: 300 }}
            />{" "}
            <button onClick={() => setEnrollModal(true)} style={btnPrimary}>
              Enroll Customer
            </button>{" "}
          </div>{" "}
          <div
            style={{
              background: D.card,
              borderRadius: 12,
              padding: 20,
              border: `1px solid ${D.border}`,
              overflowX: "auto",
            }}
          >
            {" "}
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              {" "}
              <thead>
                <tr>
                  <th style={thSt}>Name</th>
                  <th style={thSt}>Code</th>
                  <th style={thSt}>Link</th>
                  <th style={thR}>Clicks</th>
                  <th style={thR}>Referrals</th>
                  <th style={thSt}>Milestone</th>
                  <th style={thR}>Available</th>
                  <th style={thR}>Pending</th>
                </tr>
              </thead>{" "}
              <tbody>
                {filteredPromoters.map((p) => (
                  <tr key={p.id}>
                    {" "}
                    <td style={tdSt}>
                      <span style={{ fontWeight: 500 }}>
                        {p.first_name} {p.last_name}
                      </span>
                      <br />
                      <span style={{ fontSize: 14, color: D.muted }}>
                        {p.customer_phone}
                      </span>
                    </td>{" "}
                    <td style={{ ...tdSt, fontFamily: MONO, fontSize: 14 }}>
                      {p.referral_code || "--"}
                    </td>{" "}
                    <td style={tdSt}>
                      {p.referral_link ? (
                        <button
                          onClick={() => copyLink(p.referral_link)}
                          style={{
                            background: "none",
                            border: `1px solid ${D.teal}33`,
                            color: D.teal,
                            fontSize: 14,
                            fontWeight: 500,
                            padding: "2px 8px",
                            borderRadius: 4,
                            cursor: "pointer",
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                          }}
                        >
                          Copy Link
                        </button>
                      ) : (
                        "--"
                      )}
                    </td>{" "}
                    <td style={tdR}>{p.total_clicks}</td>{" "}
                    <td style={tdR}>
                      {p.total_referrals_converted}/{p.total_referrals_sent}
                    </td>{" "}
                    <td style={tdSt}>
                      <MilestoneBadge level={p.milestone_level || "none"} />
                    </td>{" "}
                    <td style={{ ...tdR, color: D.green }}>
                      {fc(p.available_balance_cents || 0)}
                    </td>{" "}
                    <td style={{ ...tdR, color: D.amber }}>
                      {fc(p.pending_earnings_cents || 0)}
                    </td>{" "}
                  </tr>
                ))}
              </tbody>{" "}
            </table>{" "}
          </div>{" "}
        </div>
      )}
      {/* PAYOUTS */}
      {tab === "payouts" && (
        <div
          style={{
            background: D.card,
            borderRadius: 12,
            padding: 20,
            border: `1px solid ${D.border}`,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 16,
              fontWeight: 500,
              color: D.heading,
              marginBottom: 14,
            }}
          >
            Payouts
          </div>
          {payouts.length === 0 ? (
            <div
              style={{
                color: D.muted,
                padding: 20,
                textAlign: "center",
                fontSize: 14,
              }}
            >
              No payout requests
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              {" "}
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                {" "}
                <thead>
                  <tr>
                    <th style={thSt}>Promoter</th>
                    <th style={thR}>Amount</th>
                    <th style={thSt}>Method</th>
                    <th style={thSt}>Status</th>
                    <th style={thSt}>1099</th>
                    <th style={thR}>Actions</th>
                  </tr>
                </thead>{" "}
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id}>
                      {" "}
                      <td style={tdSt}>
                        {p.first_name} {p.last_name}
                      </td>{" "}
                      <td style={{ ...tdR, color: D.green, fontWeight: 500 }}>
                        {fc(p.amount_cents)}
                      </td>{" "}
                      <td style={tdSt}>
                        {(p.payout_method || p.method || "").replace("_", " ")}
                      </td>{" "}
                      <td style={tdSt}>
                        <Badge status={p.status} />
                      </td>{" "}
                      <td style={tdSt}>
                        {p.requires_1099 ? (
                          <span style={{ color: D.amber, fontSize: 14 }}>
                            Yes
                          </span>
                        ) : (
                          "--"
                        )}
                      </td>{" "}
                      <td style={tdR}>
                        {p.status === "pending" && (
                          <button
                            onClick={() => handleApprovePayout(p.id)}
                            style={btnSmall(D.green)}
                          >
                            Approve
                          </button>
                        )}
                      </td>{" "}
                    </tr>
                  ))}
                </tbody>{" "}
              </table>{" "}
            </div>
          )}
        </div>
      )}
      {/* SETTINGS */}
      {tab === "settings" &&
        settings &&
        (() => {
          const s = settingsEditing || settings;
          const upd = (k, v) =>
            setSettingsEditing({ ...(settingsEditing || settings), [k]: v });
          const isEditing = !!settingsEditing;
          const fields = [
            {
              section: "Rewards",
              items: [
                {
                  key: "referrer_reward_cents",
                  label: "Referrer Reward (cents)",
                  type: "number",
                },
                {
                  key: "referee_discount_cents",
                  label: "Referee Discount (cents)",
                  type: "number",
                },
              ],
            },
            {
              section: "Tier Bonuses",
              items: [
                {
                  key: "bonus_silver_cents",
                  label: "Silver Bonus (cents)",
                  type: "number",
                },
                {
                  key: "bonus_gold_cents",
                  label: "Gold Bonus (cents)",
                  type: "number",
                },
                {
                  key: "bonus_platinum_cents",
                  label: "Platinum Bonus (cents)",
                  type: "number",
                },
              ],
            },
            {
              section: "Milestones",
              items: [
                {
                  key: "milestone_3_bonus_cents",
                  label: "3 Referrals Bonus (cents)",
                  type: "number",
                },
                {
                  key: "milestone_5_bonus_cents",
                  label: "5 Referrals Bonus (cents)",
                  type: "number",
                },
                {
                  key: "milestone_10_bonus_cents",
                  label: "10 Referrals Bonus (cents)",
                  type: "number",
                },
              ],
            },
            {
              section: "Fraud Prevention",
              items: [
                {
                  key: "max_referrals_per_month",
                  label: "Max Referrals / Month",
                  type: "number",
                },
                {
                  key: "cooldown_days",
                  label: "Cooldown Days",
                  type: "number",
                },
                {
                  key: "min_payout_cents",
                  label: "Min Payout (cents)",
                  type: "number",
                },
              ],
            },
            {
              section: "Program",
              items: [
                {
                  key: "program_active",
                  label: "Program Active",
                  type: "boolean",
                },
                {
                  key: "auto_credit_enabled",
                  label: "Auto Credit",
                  type: "boolean",
                },
                {
                  key: "require_service_completion",
                  label: "Require 1st Service",
                  type: "boolean",
                },
                { key: "base_url", label: "Base URL", type: "text" },
              ],
            },
            {
              section: "SMS Templates",
              items: [
                {
                  key: "invite_sms_template",
                  label: "Invite SMS",
                  type: "textarea",
                },
                {
                  key: "reward_sms_template",
                  label: "Reward SMS",
                  type: "textarea",
                },
                {
                  key: "milestone_sms_template",
                  label: "Milestone SMS",
                  type: "textarea",
                },
              ],
            },
          ];
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {" "}
              <div
                style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
              >
                {!isEditing && (
                  <button
                    onClick={() => setSettingsEditing({ ...settings })}
                    style={btnPrimary}
                  >
                    Edit Settings
                  </button>
                )}
                {isEditing && (
                  <button
                    onClick={handleSaveSettings}
                    style={{ ...btnPrimary, background: D.green }}
                  >
                    Save
                  </button>
                )}
                {isEditing && (
                  <button
                    onClick={() => setSettingsEditing(null)}
                    style={{
                      ...btnPrimary,
                      background: "transparent",
                      border: `1px solid ${D.border}`,
                      color: D.muted,
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
              {fields.map((section) => (
                <div
                  key={section.section}
                  style={{
                    background: D.card,
                    borderRadius: 12,
                    padding: 20,
                    border: `1px solid ${D.border}`,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: D.heading,
                      marginBottom: 12,
                    }}
                  >
                    {section.section}
                  </div>{" "}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        section.items[0]?.type === "textarea"
                          ? "1fr"
                          : "repeat(auto-fill, minmax(200px, 1fr))",
                      gap: 12,
                    }}
                  >
                    {section.items.map((f) => (
                      <div key={f.key}>
                        {" "}
                        <div
                          style={{
                            fontSize: 14,
                            color: D.muted,
                            marginBottom: 4,
                            textTransform: "uppercase",
                            letterSpacing: 0.5,
                          }}
                        >
                          {f.label}
                        </div>
                        {f.type === "boolean" ? (
                          <button
                            onClick={() => isEditing && upd(f.key, !s[f.key])}
                            disabled={!isEditing}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "6px 14px",
                              borderRadius: 6,
                              border: `1px solid ${D.border}`,
                              background: D.bg,
                              color: s[f.key] ? D.heading : D.muted,
                              fontSize: 14,
                              fontWeight: 500,
                              cursor: isEditing ? "pointer" : "default",
                              textTransform: "uppercase",
                              letterSpacing: "0.06em",
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                width: 5,
                                height: 5,
                                flex: "0 0 5px",
                                borderRadius: "50%",
                                boxSizing: "border-box",
                                background: s[f.key] ? D.heading : "transparent",
                                border: s[f.key]
                                  ? "none"
                                  : `1px solid ${D.muted}`,
                              }}
                            />
                            {s[f.key] ? "Enabled" : "Disabled"}
                          </button>
                        ) : f.type === "textarea" ? (
                          <textarea
                            value={s[f.key] || ""}
                            onChange={(e) => upd(f.key, e.target.value)}
                            disabled={!isEditing}
                            rows={2}
                            style={{
                              ...inputSt,
                              resize: "vertical",
                              opacity: isEditing ? 1 : 0.6,
                            }}
                          />
                        ) : (
                          <input
                            type={f.type}
                            value={s[f.key] ?? ""}
                            onChange={(e) =>
                              upd(
                                f.key,
                                f.type === "number"
                                  ? parseInt(e.target.value) || 0
                                  : e.target.value,
                              )
                            }
                            disabled={!isEditing}
                            style={{ ...inputSt, opacity: isEditing ? 1 : 0.6 }}
                          />
                        )}
                      </div>
                    ))}
                  </div>{" "}
                </div>
              ))}
            </div>
          );
        })()}
      {/* ANALYTICS */}
      {tab === "analytics" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {!analytics ? (
            <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
              Loading analytics...
            </div>
          ) : (
            <>
              {/* Funnel */}
              <div
                style={{
                  background: D.card,
                  borderRadius: 12,
                  padding: 20,
                  border: `1px solid ${D.border}`,
                }}
              >
                {" "}
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 500,
                    color: D.heading,
                    marginBottom: 14,
                  }}
                >
                  Conversion Funnel
                </div>{" "}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {" "}
                  <Stat
                    label="Clicks"
                    value={analytics.funnel.clicks}
                    sub={`${analytics.funnel.uniqueClicks} unique`}
                  />{" "}
                  <Stat
                    label="Referrals"
                    value={analytics.funnel.referrals}
                    sub={`${analytics.funnel.clickToReferralRate}% click-to-ref`}
                  />{" "}
                  <Stat
                    label="Converted"
                    value={analytics.funnel.converted}
                    sub={`${analytics.funnel.conversionRate}% rate`}
                  />{" "}
                  <Stat
                    label="Lost"
                    value={analytics.funnel.lost}
                  />{" "}
                  <Stat
                    label="Pending"
                    value={analytics.funnel.pending}
                  />{" "}
                </div>{" "}
              </div>
              {/* Financial */}
              <div
                style={{
                  background: D.card,
                  borderRadius: 12,
                  padding: 20,
                  border: `1px solid ${D.border}`,
                }}
              >
                {" "}
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 500,
                    color: D.heading,
                    marginBottom: 14,
                  }}
                >
                  Financial / ROI
                </div>{" "}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {" "}
                  <Stat
                    label="Rewards Issued"
                    value={fd(analytics.financial.totalRewardsDollars)}
                  />{" "}
                  <Stat
                    label="Paid Out"
                    value={fc(analytics.financial.totalPaidOutCents)}
                  />{" "}
                  <Stat
                    label="Monthly Value"
                    value={fd(analytics.financial.totalMonthlyValue)}
                    sub="from converted refs"
                  />{" "}
                  <Stat
                    label="Est. Annual Rev"
                    value={fd(analytics.financial.estimatedAnnualRevenue)}
                  />{" "}
                  <Stat
                    label="ROI"
                    value={`${analytics.financial.roi}%`}
                  />{" "}
                </div>{" "}
              </div>
              {/* Top promoters bar chart */}
              <div
                style={{
                  background: D.card,
                  borderRadius: 12,
                  padding: 20,
                  border: `1px solid ${D.border}`,
                }}
              >
                {" "}
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 500,
                    color: D.heading,
                    marginBottom: 14,
                  }}
                >
                  Top Promoters
                </div>
                {analytics.topPromoters.length === 0 ? (
                  <div style={{ color: D.muted, fontSize: 14 }}>
                    No conversions yet
                  </div>
                ) : (
                  analytics.topPromoters.map((p, i) => {
                    const maxConv = analytics.topPromoters[0].conversions || 1;
                    const pct = Math.round((p.conversions / maxConv) * 100);
                    return (
                      <div key={p.id} style={{ marginBottom: 8 }}>
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginBottom: 2,
                          }}
                        >
                          {" "}
                          <span style={{ fontSize: 14, color: D.text }}>
                            {i + 1}. {p.name}{" "}
                            <MilestoneBadge level={p.milestone || "none"} />
                          </span>{" "}
                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 14,
                              color: D.green,
                            }}
                          >
                            {p.conversions} conv / {fc(p.earned)}
                          </span>{" "}
                        </div>{" "}
                        <div
                          style={{
                            background: D.bg,
                            borderRadius: 4,
                            height: 8,
                          }}
                        >
                          {" "}
                          <div
                            style={{
                              width: `${pct}%`,
                              height: "100%",
                              borderRadius: 4,
                              background: D.heading,
                            }}
                          />{" "}
                        </div>{" "}
                      </div>
                    );
                  })
                )}
              </div>{" "}
            </>
          )}
        </div>
      )}
      {/* CONVERT MODAL */}
      {convertModal && createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 999,
              }}
          onClick={() => setConvertModal(null)}
        >
          {" "}
          <div
            style={{
              background: D.card,
              borderRadius: 16,
              padding: 28,
              width: 420,
              border: `1px solid ${D.border}`,
              ...(isMobile
                ? {
                    width: "100%",
                    maxWidth: "none",
                    height: "100%",
                    maxHeight: "none",
                    borderRadius: 0,
                    boxSizing: "border-box",
                    overflowY: "auto",
                    paddingTop: "calc(28px + env(safe-area-inset-top, 0px))",
                    paddingBottom: "calc(28px + env(safe-area-inset-bottom, 0px))",
                    paddingLeft: "calc(28px + env(safe-area-inset-left, 0px))",
                    paddingRight: "calc(28px + env(safe-area-inset-right, 0px))",
                  }
                : {}),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {" "}
            <div
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: D.heading,
                marginBottom: 16,
              }}
            >
              Convert Referral
            </div>{" "}
            <div style={{ fontSize: 14, color: D.muted, marginBottom: 16 }}>
              Converting: {convertModal.name}
            </div>{" "}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {" "}
              <div>
                {" "}
                <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                  Customer Search
                </div>{" "}
                <input
                  placeholder="Search customer name or phone..."
                  value={custSearch}
                  onChange={(e) => searchCustomers(e.target.value)}
                  style={inputSt}
                />
                {custResults.length > 0 && (
                  <div
                    style={{
                      background: D.bg,
                      border: `1px solid ${D.border}`,
                      borderRadius: 8,
                      marginTop: 4,
                      maxHeight: 150,
                      overflow: "auto",
                    }}
                  >
                    {custResults.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => {
                          setConvertModal((m) => ({ ...m, customerId: c.id }));
                          setCustSearch(`${c.first_name} ${c.last_name}`);
                          setCustResults([]);
                        }}
                        style={{
                          padding: "8px 12px",
                          cursor: "pointer",
                          borderBottom: `1px solid ${D.border}33`,
                          fontSize: 14,
                          color: D.text,
                        }}
                      >
                        {c.first_name} {c.last_name}{" "}
                        <span style={{ color: D.muted }}>({c.phone})</span>{" "}
                      </div>
                    ))}
                  </div>
                )}
              </div>{" "}
              <div>
                {" "}
                <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                  WaveGuard Tier
                </div>{" "}
                <select
                  value={convertModal.tier}
                  onChange={(e) =>
                    setConvertModal((m) => ({ ...m, tier: e.target.value }))
                  }
                  style={{ ...inputSt, appearance: "auto" }}
                >
                  {" "}
                  <option value="">Select tier...</option>{" "}
                  <option value="Platinum">Platinum</option>{" "}
                  <option value="Gold">Gold</option>{" "}
                  <option value="Silver">Silver</option>{" "}
                  <option value="Bronze">Bronze</option>{" "}
                  <option value="One-Time">One-Time</option>{" "}
                </select>{" "}
              </div>{" "}
              <div>
                {" "}
                <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                  Monthly Value ($)
                </div>{" "}
                <input
                  type="number"
                  placeholder="e.g. 79"
                  value={convertModal.monthlyValue}
                  onChange={(e) =>
                    setConvertModal((m) => ({
                      ...m,
                      monthlyValue: e.target.value,
                    }))
                  }
                  style={inputSt}
                />{" "}
              </div>{" "}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                {" "}
                <button
                  onClick={handleConvert}
                  style={{ ...btnPrimary, background: D.green, flex: 1 }}
                >
                  Convert
                </button>{" "}
                <button
                  onClick={() => setConvertModal(null)}
                  style={{
                    ...btnPrimary,
                    background: "transparent",
                    border: `1px solid ${D.border}`,
                    color: D.muted,
                  }}
                >
                  Cancel
                </button>{" "}
              </div>{" "}
            </div>{" "}
          </div>{" "}
        </div>,
        document.body,
      )}
      {/* ENROLL MODAL */}
      {enrollModal && createPortal(
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 999,
              }}
          onClick={() => setEnrollModal(false)}
        >
          {" "}
          <div
            style={{
              background: D.card,
              borderRadius: 16,
              padding: 28,
              width: 400,
              border: `1px solid ${D.border}`,
              ...(isMobile
                ? {
                    width: "100%",
                    maxWidth: "none",
                    height: "100%",
                    maxHeight: "none",
                    borderRadius: 0,
                    boxSizing: "border-box",
                    overflowY: "auto",
                    paddingTop: "calc(28px + env(safe-area-inset-top, 0px))",
                    paddingBottom: "calc(28px + env(safe-area-inset-bottom, 0px))",
                    paddingLeft: "calc(28px + env(safe-area-inset-left, 0px))",
                    paddingRight: "calc(28px + env(safe-area-inset-right, 0px))",
                  }
                : {}),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {" "}
            <div
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: D.heading,
                marginBottom: 16,
              }}
            >
              Enroll Customer as Promoter
            </div>{" "}
            <input
              placeholder="Search customer name or phone..."
              value={custSearch}
              onChange={(e) => searchCustomers(e.target.value)}
              style={{ ...inputSt, marginBottom: 8 }}
            />
            {custResults.length > 0 && (
              <div
                style={{
                  background: D.bg,
                  border: `1px solid ${D.border}`,
                  borderRadius: 8,
                  maxHeight: 200,
                  overflow: "auto",
                }}
              >
                {custResults.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => handleEnroll(c.id)}
                    style={{
                      padding: "10px 14px",
                      cursor: "pointer",
                      borderBottom: `1px solid ${D.border}33`,
                      fontSize: 14,
                      color: D.text,
                    }}
                  >
                    {c.first_name} {c.last_name}{" "}
                    <span style={{ color: D.muted }}>({c.phone})</span>{" "}
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => {
                setEnrollModal(false);
                setCustSearch("");
                setCustResults([]);
              }}
              style={{
                ...btnPrimary,
                background: "transparent",
                border: `1px solid ${D.border}`,
                color: D.muted,
                marginTop: 12,
                width: "100%",
              }}
            >
              Cancel
            </button>{" "}
          </div>{" "}
        </div>,
        document.body,
      )}
    </div>
  );
}
