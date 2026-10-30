import { useState, useEffect, useCallback, useId, useRef } from "react";
import { useSearchParams } from "react-router-dom";
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
import useModalFocus from "../../hooks/useModalFocus";

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
    if (!r.ok) {
      // Show the server's own reason (a 400 names the bad field) instead of "HTTP 400".
      return r
        .json()
        .catch(() => ({}))
        .then((body) => {
          throw new Error(body?.error || `HTTP ${r.status}`);
        });
    }
    return r.json();
  });
}

// Customer search rows are camelCase (mapCustomerListRow); a missing part must not print "undefined".
const customerDisplayName = (c) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ");

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

// 44px mobile touch target (CLAUDE.md). Spread into a button's style; desktop
// density is unchanged because it returns nothing off mobile.
const touch = (isMobile) =>
  isMobile
    ? {
        minHeight: 44,
        minWidth: 44,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }
    : null;

// Persistent failure text shown inside the control that failed (the page-level
// flash banner clears in 3 s and sits behind the full-screen mobile dialogs).
const errorSt = {
  padding: "8px 12px",
  borderRadius: 8,
  background: `${D.red}22`,
  border: `1px solid ${D.red}`,
  color: D.red,
  fontSize: 14,
  marginTop: 10,
};

// Visible caption for a settings control. A text/number/textarea caption is a
// real <label htmlFor>; a boolean toggle is named by its own aria-label, so its
// caption stays plain text (a label there would toggle it on click).
function SettingCaption({ htmlFor, children }) {
  const Tag = htmlFor ? "label" : "div";
  return (
    <Tag
      {...(htmlFor ? { htmlFor } : {})}
      style={{
        display: "block",
        fontSize: 14,
        color: D.muted,
        marginBottom: 4,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </Tag>
  );
}

// A customer search result: a native button so Tab reaches it and Enter or
// Space picks it, drawn like the plain row it replaces.
const resultBtnSt = (isMobile, padding) => ({
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  padding,
  background: "none",
  border: "none",
  borderBottom: `1px solid ${D.border}33`,
  borderRadius: 0,
  textAlign: "left",
  font: "inherit",
  fontSize: 14,
  color: D.text,
  cursor: "pointer",
  ...(isMobile ? { minHeight: 44 } : {}),
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

// Inbound referral actions answer with the server's own reason (a 409 says
// which guard refused), so the card can show it instead of "HTTP 409".
function adminPost(path, body) {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}

function inboundEvidenceLine(evidence) {
  if (evidence.source === "link")
    return `Came in through referral link ${evidence.code}`;
  if (evidence.spokenName)
    return `Said on the first call: "Referred by ${evidence.spokenName}"`;
  return "Said on the first call that a customer referred them, with no name";
}

function inboundConfirmedMessage(result) {
  if (result.error === "convert_failed")
    return "Error: referral saved, but the conversion failed. Use Convert on it in the queue below.";
  if (result.error === "credit_failed")
    return "Referral confirmed, but the $25 credits did not post. They post at the next plan visit.";
  if (result.credited) return "Referral confirmed. $25 credited to both accounts.";
  if (!result.creditsNow)
    return "Referral confirmed. The $25 credits post at the next completed plan visit.";
  return "Referral confirmed. The credit step posted nothing; check the referral in the queue below.";
}

// GATE_REFERRAL_INBOUND_CONFIRM: one plan customer who came in through a
// referral link or named a referrer. The office picks the referrer (a
// suggestion or a search result), then confirms; or marks "not a referral".
function InboundReferralCard({ item, onDone, flash }) {
  const isMobile = useIsMobile();
  const [chosen, setChosen] = useState(null);
  const [search, setSearch] = useState(item.evidence.spokenName || "");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const runSearch = async (q) => {
    setSearch(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      const r = await af(
        `/admin/customers?search=${encodeURIComponent(q.trim())}&limit=8`,
      );
      setResults(
        (r.customers || []).filter((c) => c.id !== item.customerId),
      );
    } catch {
      setResults([]);
    }
  };

  const confirm = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      const result = await adminPost(
        `/admin/referrals/inbound/${item.customerId}/confirm`,
        { referrerCustomerId: chosen.customerId },
      );
      flash(inboundConfirmedMessage(result));
      onDone();
    } catch (e) {
      flash("Error: " + e.message);
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await adminPost(`/admin/referrals/inbound/${item.customerId}/dismiss`);
      flash("Removed from the list");
      onDone();
    } catch (e) {
      flash("Error: " + e.message);
      setBusy(false);
    }
  };

  const firstName = item.name.split(" ")[0] || "the customer";
  const pickRow = (c, note) => (
    <div
      key={c.customerId}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 0",
        borderBottom: `1px solid ${D.border}`,
        fontSize: 14,
        color: D.text,
      }}
    >
      <span>
        {c.name || "(no name)"}
        <span style={{ color: D.muted }}>
          {c.city ? ` · ${c.city}` : ""}
          {c.phone ? ` · ${c.phone}` : ""}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
      <button
        onClick={() => setChosen(c)}
        disabled={busy}
        style={{ ...btnSmall(D.card, D.heading), ...touch(isMobile) }}
      >
        Choose
      </button>
    </div>
  );

  return (
    <div
      style={{
        border: `1px solid ${D.border}`,
        borderRadius: 10,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 14, color: D.heading, fontWeight: 500 }}>
        <a
          href={`/admin/customers?customerId=${item.customerId}`}
          style={{ color: D.heading }}
        >
          {item.name || "(no name)"}
        </a>
        <span style={{ color: D.muted, fontWeight: 400 }}>
          {item.city ? ` · ${item.city}` : ""}
          {` · ${item.plan.tier} ${fd(item.plan.monthlyRate)}/mo · `}
          {item.creditsNow
            ? "plan visit done"
            : "no completed plan visit yet"}
        </span>
      </div>
      <div style={{ fontSize: 14, color: D.text }}>
        {inboundEvidenceLine(item.evidence)}
      </div>
      {item.selfReferral && (
        <div style={{ fontSize: 14, color: D.muted }}>
          The link code belongs to this customer's own household.
        </div>
      )}
      {chosen ? (
        <div
          style={{
            background: D.bg,
            borderRadius: 8,
            padding: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 14, color: D.heading }}>
            Confirm {chosen.name || "this customer"} as the referrer.{" "}
            {item.creditsNow
              ? "Both accounts get the $25 credit now. The referrer gets one thank-you email at the next 9:00 AM ET, and no text."
              : `Both accounts get the $25 credit at ${firstName}'s next completed plan visit. The referrer then gets one thank-you email at the next 9:00 AM ET, and no text.`}{" "}
            A referrer's 3rd, 5th or 10th referral also sends the usual milestone text.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={confirm}
              disabled={busy}
              style={{ ...btnPrimary, ...touch(isMobile) }}
            >
              {busy ? "..." : "Confirm"}
            </button>
            <button
              onClick={() => setChosen(null)}
              disabled={busy}
              style={{
                ...btnPrimary,
                background: D.card,
                color: D.heading,
                border: `1px solid ${D.border}`,
                ...touch(isMobile),
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {item.suggestions.length > 0 && (
            <div>
              <div style={{ fontSize: 14, color: D.muted }}>
                {item.evidence.source === "link"
                  ? "Owner of the link code"
                  : "Likely referrers"}
              </div>
              {item.suggestions.map((c) =>
                pickRow(
                  c,
                  [
                    c.viaCode ? null : c.exact ? "full name match" : null,
                    c.onPlan ? "on a plan" : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ),
              )}
            </div>
          )}
          <input
            placeholder="Find the referrer by name or phone"
            value={search}
            onChange={(e) => runSearch(e.target.value)}
            style={inputSt}
          />
          {results.map((c) =>
            pickRow({
              customerId: c.id,
              name: `${c.firstName || ""} ${c.lastName || ""}`.trim(),
              city: c.city,
              phone: c.phone,
            }),
          )}
          {dismissing ? (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 14, color: D.text }}>
              Remove {firstName} from this list for good?
              <button
                onClick={dismiss}
                disabled={busy}
                style={{ ...btnSmall(D.teal), ...touch(isMobile) }}
              >
                Yes, not a referral
              </button>
              <button
                onClick={() => setDismissing(false)}
                disabled={busy}
                style={{ ...btnSmall(D.card, D.heading), ...touch(isMobile) }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div>
              <button
                onClick={() => setDismissing(true)}
                disabled={busy}
                style={{ ...btnSmall(D.card, D.muted), ...touch(isMobile) }}
              >
                Not a referral
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ReferralsPageV2() {
  const isMobile = useIsMobile();
  // `?tab=queue` (the new-referral bell row's link) opens that tab on first render.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const wanted = searchParams.get("tab");
    return wanted && Object.hasOwn(REFERRALS_LEAF_BY_KEY, wanted) ? wanted : "dashboard";
  });
  const [stats, setStats] = useState(null);
  const [promoters, setPromoters] = useState([]);
  const [queue, setQueue] = useState([]);
  const [inbound, setInbound] = useState({ enabled: false, items: [] });
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

  // Dialog + payout request state. A request in flight disables its control;
  // a failure stays inside the dialog (or beside the payout) with the draft kept.
  const inFlight = useRef(new Set());
  const [convertPending, setConvertPending] = useState(false);
  const [convertError, setConvertError] = useState("");
  const [enrollPending, setEnrollPending] = useState(false);
  const [enrollError, setEnrollError] = useState("");
  const [approvingId, setApprovingId] = useState(null);
  const [payoutError, setPayoutError] = useState(null); // { id, message }
  const convertTitleId = useId();
  const enrollTitleId = useId();
  const tierSelectRef = useRef(null);

  const closeConvert = () => {
    if (inFlight.current.has("convert")) return;
    setConvertModal(null);
    setConvertError("");
    setCustSearch("");
    setCustResults([]);
  };
  const closeEnroll = () => {
    if (inFlight.current.has("enroll")) return;
    setEnrollModal(false);
    setEnrollError("");
    setCustSearch("");
    setCustResults([]);
  };
  // Focus moves into the dialog on open, Tab stays inside, Escape closes, and
  // focus returns to the control that opened it (shared hook, same as ui/Dialog).
  const convertDialogRef = useModalFocus(Boolean(convertModal), closeConvert);
  const enrollDialogRef = useModalFocus(enrollModal, closeEnroll);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      af("/admin/referrals/stats").catch(() => null),
      af("/admin/referrals/promoters?status=all").catch(() => ({
        promoters: [],
      })),
      af("/admin/referrals/queue").catch(() => ({ referrals: [] })),
      af("/admin/referrals/payouts").catch(() => ({ payouts: [] })),
      af("/admin/referrals/inbound").catch(() => ({ enabled: false, items: [] })),
    ]).then(([s, p, q, pay, inb]) => {
      setStats(s);
      setPromoters(p.promoters || []);
      setQueue(q.referrals || []);
      setPayouts(pay.payouts || []);
      setInbound({ enabled: Boolean(inb.enabled), items: inb.items || [] });
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
    if (inFlight.current.has("enroll")) return;
    inFlight.current.add("enroll");
    setEnrollPending(true);
    setEnrollError("");
    try {
      await af("/admin/referrals/enroll", {
        method: "POST",
        body: JSON.stringify({ customerId }),
      });
      inFlight.current.delete("enroll");
      setEnrollPending(false);
      flash("Promoter enrolled");
      closeEnroll();
      load();
    } catch (e) {
      // Keep the dialog open; the page flash sits behind it on mobile.
      inFlight.current.delete("enroll");
      setEnrollPending(false);
      setEnrollError(e.message || "Could not enroll this customer.");
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
    if (!convertModal || inFlight.current.has("convert")) return;
    inFlight.current.add("convert");
    setConvertPending(true);
    setConvertError("");
    try {
      await af(`/admin/referrals/${convertModal.id}/convert`, {
        method: "POST",
        body: JSON.stringify({
          customerId: convertModal.customerId,
          tier: convertModal.tier,
          monthlyValue: convertModal.monthlyValue,
        }),
      });
      inFlight.current.delete("convert");
      setConvertPending(false);
      flash("Referral converted");
      closeConvert();
      load();
    } catch (e) {
      // Keep the dialog and its draft open; show the reason inside it.
      inFlight.current.delete("convert");
      setConvertPending(false);
      setConvertError(e.message || "Could not convert this referral.");
    }
  };

  const handleApprovePayout = async (id) => {
    if (inFlight.current.has(`payout:${id}`)) return;
    inFlight.current.add(`payout:${id}`);
    setApprovingId(id);
    setPayoutError(null);
    try {
      await af(`/admin/referrals/payouts/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      flash("Payout approved");
      load();
    } catch (e) {
      // e.g. 400 "Insufficient promoter balance for this payout"
      setPayoutError({ id, message: e.message || "Could not approve this payout." });
    } finally {
      inFlight.current.delete(`payout:${id}`);
      setApprovingId(null);
    }
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
            ? { key: g.key, label: `${g.label} (${queue.length + inbound.items.length})`, Icon: g.Icon }
            : { key: g.key, label: g.label, Icon: g.Icon },
        )}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = REFERRALS_TAB_GROUPS.find((x) => x.key === key);
          if (g) setTab(g.tabs[0]);
        }}
        ariaLabel="Referrals section"
        navGridClassName="grid-cols-2 md:grid-cols-4 xl:grid-cols-4"
        secondarySections={
          activeGroup.tabs.length > 1
            ? activeGroup.tabs.map((key) => REFERRALS_LEAF_BY_KEY[key])
            : []
        }
        secondaryActiveKey={tab}
        onSecondaryChange={setTab}
        secondaryAriaLabel="Referrals sub-section"
      />
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
          {inbound.enabled && inbound.items.length > 0 && (
            <div
              style={{
                background: D.card,
                borderRadius: 12,
                padding: 20,
                border: `1px solid ${D.border}`,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 16, fontWeight: 500, color: D.heading }}>
                  Needs confirmation ({inbound.items.length})
                </div>
                <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
                  Plan customers who came in through a referral link or named
                  a referrer. Confirm the referrer to pay the $25 rewards.
                </div>
              </div>
              {inbound.items.map((item) => (
                <InboundReferralCard
                  key={item.customerId}
                  item={item}
                  onDone={load}
                  flash={flash}
                />
              ))}
            </div>
          )}
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
                              gap: isMobile ? 8 : 4,
                              justifyContent: "flex-end",
                            }}
                          >
                            {isAdmin && ["pending", "sms_failed"].includes(r.status) && (
                              <button
                                onClick={() =>
                                  handleStatusChange(r.id, "contacted")
                                }
                                style={{ ...btnSmall(D.teal), ...touch(isMobile) }}
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
                                style={{ ...btnSmall(D.green), ...touch(isMobile) }}
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
                                  ...touch(isMobile),
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
                            ...touch(isMobile),
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
                            disabled={approvingId === p.id}
                            style={{
                              ...btnSmall(D.green),
                              ...touch(isMobile),
                              ...(approvingId === p.id ? { opacity: 0.6 } : {}),
                            }}
                          >
                            {approvingId === p.id ? "Approving..." : "Approve"}
                          </button>
                        )}
                        {payoutError?.id === p.id && (
                          <div
                            role="alert"
                            style={{
                              color: D.red,
                              fontSize: 14,
                              marginTop: 6,
                              maxWidth: 260,
                              marginLeft: "auto",
                              fontFamily: "inherit",
                              textAlign: "right",
                            }}
                          >
                            {payoutError.message}
                          </div>
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
                        <SettingCaption
                          htmlFor={f.type === "boolean" ? undefined : `ref-setting-${f.key}`}
                        >
                          {f.label}
                        </SettingCaption>
                        {f.type === "boolean" ? (
                          <button
                            type="button"
                            aria-label={`${f.label}: ${s[f.key] ? "Enabled" : "Disabled"}`}
                            onClick={() => isEditing && upd(f.key, !s[f.key])}
                            disabled={!isEditing}
                            style={{
                              ...touch(isMobile),
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
                            id={`ref-setting-${f.key}`}
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
                            id={`ref-setting-${f.key}`}
                            type={f.type}
                            value={s[f.key] ?? ""}
                            onChange={(e) =>
                              upd(
                                f.key,
                                f.type === "number"
                                  ? Math.max(0, parseInt(e.target.value) || 0)
                                  : e.target.value,
                              )
                            }
                            disabled={!isEditing}
                            {...(f.type === "number" ? { min: 0, step: 1 } : {})}
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
          onClick={closeConvert}
        >
          {" "}
          <div
            ref={convertDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={convertTitleId}
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
              id={convertTitleId}
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
                <label
                  htmlFor="ref-convert-customer"
                  style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                >
                  Customer Search
                </label>{" "}
                <input
                  id="ref-convert-customer"
                  autoFocus
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
                      <button
                        type="button"
                        key={c.id}
                        onClick={() => {
                          setConvertModal((m) => ({ ...m, customerId: c.id }));
                          setCustSearch(customerDisplayName(c));
                          setCustResults([]);
                          // The pressed result unmounts; keep focus in the form.
                          tierSelectRef.current?.focus();
                        }}
                        style={resultBtnSt(isMobile, "8px 12px")}
                      >
                        {customerDisplayName(c)}{" "}
                        <span style={{ color: D.muted }}>({c.phone})</span>{" "}
                      </button>
                    ))}
                  </div>
                )}
              </div>{" "}
              <div>
                {" "}
                <label
                  htmlFor="ref-convert-tier"
                  style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                >
                  WaveGuard Tier
                </label>{" "}
                <select
                  id="ref-convert-tier"
                  ref={tierSelectRef}
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
                <label
                  htmlFor="ref-convert-value"
                  style={{ display: "block", fontSize: 14, color: D.muted, marginBottom: 4 }}
                >
                  Monthly Value ($)
                </label>{" "}
                <input
                  id="ref-convert-value"
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
              {convertError && (
                <div role="alert" style={errorSt}>
                  {convertError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                {" "}
                <button
                  onClick={handleConvert}
                  disabled={convertPending}
                  style={{
                    ...btnPrimary,
                    background: D.green,
                    flex: 1,
                    ...touch(isMobile),
                    ...(convertPending ? { opacity: 0.6, cursor: "default" } : {}),
                  }}
                >
                  {convertPending ? "Converting..." : "Convert"}
                </button>{" "}
                <button
                  onClick={closeConvert}
                  disabled={convertPending}
                  style={{
                    ...btnPrimary,
                    background: "transparent",
                    border: `1px solid ${D.border}`,
                    color: D.muted,
                    ...touch(isMobile),
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
          onClick={closeEnroll}
        >
          {" "}
          <div
            ref={enrollDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={enrollTitleId}
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
              id={enrollTitleId}
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
              aria-label="Search customers to enroll"
              autoFocus
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
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => handleEnroll(c.id)}
                    disabled={enrollPending}
                    style={{
                      ...resultBtnSt(isMobile, "10px 14px"),
                      ...(enrollPending ? { opacity: 0.6, cursor: "default" } : {}),
                    }}
                  >
                    {customerDisplayName(c)}{" "}
                    <span style={{ color: D.muted }}>({c.phone})</span>{" "}
                  </button>
                ))}
              </div>
            )}
            {enrollPending && (
              <div role="status" style={{ fontSize: 14, color: D.muted, marginTop: 8 }}>
                Enrolling...
              </div>
            )}
            {enrollError && (
              <div role="alert" style={errorSt}>
                {enrollError}
              </div>
            )}
            <button
              onClick={closeEnroll}
              disabled={enrollPending}
              style={{
                ...btnPrimary,
                background: "transparent",
                border: `1px solid ${D.border}`,
                color: D.muted,
                marginTop: 12,
                width: "100%",
                ...touch(isMobile),
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
