import React, { useState } from "react";
import { createPortal } from "react-dom";
import useIsMobile from "../../hooks/useIsMobile";


/* ── theme tokens ───────────────────────────────────────────── */
const C = {
  dark: "#F1F5F9",
  navy: "#F0F7FC",
  card: "#FFFFFF",
  border: "#E2E8F0",
  teal: "#0A7EC2",
  green: "#16A34A",
  amber: "#F0A500",
  red: "#C0392B",
  blue: "#2563eb",
  white: "#334155",
  gray: "#64748B",
  input: "#FFFFFF",
  heading: "#0F172A",
  inputBorder: "#CBD5E1",
  radius: "10px",
};

/* ── inline style helpers ───────────────────────────────────── */
const sInput = {
  width: "100%",
  padding: "12px 14px",
  background: C.input,
  border: `1px solid ${C.inputBorder}`,
  borderRadius: C.radius,
  color: C.heading,
  fontFamily: "'Roboto', Arial, sans-serif",
  fontSize: 16,
  minHeight: 46,
  boxSizing: "border-box",
  outline: "none",
};


// =========================================================================
// ESTIMATES PIPELINE VIEW — list of sent estimates with status tracking
// =========================================================================
const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const STATUS_CONFIG = {
  draft: { label: "Draft", color: C.gray, bg: `${C.gray}22` },
  sent: { label: "Sent", color: C.teal, bg: `${C.teal}22` },
  scheduled: { label: "Scheduled", color: C.teal, bg: `${C.teal}22` },
  viewed: { label: "Viewed", color: C.amber, bg: `${C.amber}22` },
  accepted: { label: "Accepted", color: C.green, bg: `${C.green}22` },
  declined: { label: "Declined", color: C.red, bg: `${C.red}22` },
  expired: { label: "Expired", color: C.gray, bg: `${C.gray}15` },
};

/* ── Competitor detection for intel badge ──────────────────── */
const COMPETITORS = [
  "trugreen",
  "massey",
  "turner",
  "all u need",
  "terminix",
  "orkin",
];
function detectCompetitor(notes) {
  if (!notes) return null;
  const lower = notes.toLowerCase();
  for (const c of COMPETITORS) {
    if (lower.includes(c)) {
      // Capitalize for display
      return c
        .split(" ")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
    }
  }
  return null;
}

/* ── Urgency indicator logic based on timestamps ──────────── */
function getUrgencyIndicator(e) {
  const now = Date.now();
  const HOUR = 3600000;

  if (e.status === "sent" && !e.viewedAt && e.sentAt) {
    const hoursSinceSent = (now - new Date(e.sentAt).getTime()) / HOUR;
    if (hoursSinceSent >= 72)
      return { label: "Going cold", color: C.red, bg: `${C.red}18` };
    if (hoursSinceSent >= 24)
      return { label: "Not opened", color: C.amber, bg: `${C.amber}18` };
  }

  if (e.status === "viewed" && e.viewedAt) {
    // Key off the latest engagement (re-view/click), not the first view — a
    // customer who re-opened the estimate yesterday isn't overdue.
    const engagementStamps = [e.lastViewedAt, e.viewedAt, e.lastClickedAt]
      .map((iso) => (iso ? new Date(iso).getTime() : NaN))
      .filter((ts) => !Number.isNaN(ts));
    const hoursSinceViewed = (now - Math.max(...engagementStamps)) / HOUR;
    if (hoursSinceViewed >= 168)
      return { label: "Final follow-up", color: C.red, bg: `${C.red}18` };
    if (hoursSinceViewed >= 48)
      return { label: "Follow up", color: C.amber, bg: `${C.amber}18` };
  }

  return null;
}

/* ── Decline reason options ────────────────────────────────── */
// Normalized loss dispositions (server/services/estimate-disposition.js —
// staff codes). `code` is what analytics slice on; `label` is what the
// operator reads and what lands in the legacy decline_reason badge.
// `fields` opens the extra inputs for that option.
const DECLINE_REASONS = [
  { code: "declined_price", label: "Too expensive" },
  { code: "declined_competitor", label: "Went with competitor", fields: "competitor" },
  { code: "declined_timing", label: "Not ready / timing" },
  { code: "not_needed", label: "Service not needed" },
  { code: "diy", label: "Doing it themselves" },
  { code: "no_response", label: "No response" },
  { code: "invalid_lead", label: "Invalid / out of area / duplicate" },
  { code: "declined_other", label: "Other", fields: "note" },
];

// Body for PATCH /admin/estimates/:id from a decline modal's state.
function declinePayload({ reason, competitorName, competitorPrice, note }) {
  const option = DECLINE_REASONS.find((r) => r.code === reason);
  return {
    status: "declined",
    disposition: reason,
    declineReason: option?.label || reason,
    // The note travels only with the option that owns it — a stale Other
    // note must not ride along after the radio selection changes.
    dispositionNote: option?.fields === "note" ? note?.trim() || undefined : undefined,
    competitorName: option?.fields === "competitor" ? competitorName?.trim() || undefined : undefined,
    competitorPrice: option?.fields === "competitor" && competitorPrice?.trim() ? competitorPrice.trim() : undefined,
  };
}

/* ── Follow-Up Modal ──────────────────────────────────────── */
function FollowUpModal({ estimate, onClose, onSent }) {
  const isMobile = useIsMobile();
  const firstName = estimate.customerName?.split(" ")[0] || "there";
  const addrShort = estimate.address?.split(",")[0] || "your property";
  const [message, setMessage] = useState(
    `Hi ${firstName}, just checking in on the estimate I sent for ${addrShort}. Any questions? — Adam, Waves`,
  );
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}/follow-up`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      onSent();
    } catch (err) {
      alert("Follow-up failed: " + err.message);
    }
    setSending(false);
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 16,
      }}
      onClick={onClose}
    >
      {" "}
      <div
        style={{
          background: C.card,
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          padding: 24,
          maxWidth: 480,
          width: "100%",
          ...(isMobile
            ? {
                width: "100%",
                maxWidth: "none",
                height: "100%",
                maxHeight: "none",
                borderRadius: 0,
                boxSizing: "border-box",
                overflowY: "auto",
                paddingTop: "calc(24px + env(safe-area-inset-top, 0px))",
                paddingBottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
                paddingLeft: "calc(24px + env(safe-area-inset-left, 0px))",
                paddingRight: "calc(24px + env(safe-area-inset-right, 0px))",
              }
            : {}),
        }}
        onClick={(ev) => ev.stopPropagation()}
      >
        {" "}
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: C.heading,
            marginBottom: 4,
          }}
        >
          Follow Up — {estimate.customerName}
        </div>{" "}
        <div style={{ fontSize: 12, color: C.gray, marginBottom: 16 }}>
          {estimate.address}
        </div>{" "}
        <label
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: C.gray,
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginBottom: 6,
            display: "block",
          }}
        >
          SMS Message
        </label>{" "}
        <textarea
          value={message}
          onChange={(ev) => setMessage(ev.target.value)}
          rows={4}
          style={{
            ...sInput,
            resize: "vertical",
            minHeight: 90,
            marginBottom: 16,
          }}
        />{" "}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          {" "}
          <button
            onClick={onClose}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: "transparent",
              color: C.gray,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>{" "}
          <button
            onClick={handleSend}
            disabled={sending}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: C.amber,
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              opacity: sending ? 0.6 : 1,
            }}
          >
            {sending ? "Sending..." : "Send Follow-Up SMS"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>,
    document.body,
  );
}

/* ── Decline Reason Modal ─────────────────────────────────── */
function DeclineModal({ estimate, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const [reason, setReason] = useState("");
  const [competitorName, setCompetitorName] = useState("");
  const [competitorPrice, setCompetitorPrice] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // "Other" needs its note — the server 400s a blank one.
  const incomplete = !reason || (reason === "declined_other" && !note.trim());

  const handleSave = async () => {
    if (incomplete) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}`, {
        method: "PATCH",
        body: JSON.stringify(declinePayload({ reason, competitorName, competitorPrice, note })),
      });
      onSaved();
    } catch (err) {
      alert("Failed: " + err.message);
    }
    setSaving(false);
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 16,
      }}
      onClick={onClose}
    >
      {" "}
      <div
        style={{
          background: C.card,
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          padding: 24,
          maxWidth: 400,
          width: "100%",
          ...(isMobile
            ? {
                width: "100%",
                maxWidth: "none",
                height: "100%",
                maxHeight: "none",
                borderRadius: 0,
                boxSizing: "border-box",
                overflowY: "auto",
                paddingTop: "calc(24px + env(safe-area-inset-top, 0px))",
                paddingBottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
                paddingLeft: "calc(24px + env(safe-area-inset-left, 0px))",
                paddingRight: "calc(24px + env(safe-area-inset-right, 0px))",
              }
            : {}),
        }}
        onClick={(ev) => ev.stopPropagation()}
      >
        {" "}
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: C.heading,
            marginBottom: 4,
          }}
        >
          Mark as Lost
        </div>{" "}
        <div style={{ fontSize: 12, color: C.gray, marginBottom: 16 }}>
          {estimate.customerName} — {estimate.address?.split(",")[0]}
        </div>{" "}
        <label
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: C.gray,
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginBottom: 8,
            display: "block",
          }}
        >
          Reason
        </label>{" "}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginBottom: 18,
          }}
        >
          {DECLINE_REASONS.map((r) => (
            <React.Fragment key={r.code}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                fontSize: 14,
                color: reason === r.code ? C.heading : C.gray,
                padding: "8px 12px",
                borderRadius: 8,
                background: reason === r.code ? `${C.red}18` : "transparent",
                border: `1px solid ${reason === r.code ? C.red : C.border}`,
                transition: "all 0.15s",
              }}
            >
              {" "}
              <input
                type="radio"
                name="declineReason"
                checked={reason === r.code}
                onChange={() => setReason(r.code)}
                style={{ accentColor: C.red, width: 16, height: 16 }}
              />
              {r.label}
            </label>
            {reason === r.code && r.fields === "competitor" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "0 0 4px 26px" }}>
                <input
                  value={competitorName}
                  onChange={(ev) => setCompetitorName(ev.target.value)}
                  placeholder="Competitor"
                  aria-label="Competitor"
                  style={{ padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.heading, fontSize: 14 }}
                />
                <input
                  value={competitorPrice}
                  onChange={(ev) => setCompetitorPrice(ev.target.value)}
                  placeholder="Their price ($)"
                  aria-label="Competitor price"
                  inputMode="decimal"
                  style={{ padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.heading, fontSize: 14 }}
                />
              </div>
            )}
            {reason === r.code && r.fields === "note" && (
              <input
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
                placeholder="What happened?"
                aria-label="Decline note"
                style={{ margin: "0 0 4px 26px", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.heading, fontSize: 14 }}
              />
            )}
            </React.Fragment>
          ))}
        </div>{" "}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          {" "}
          <button
            onClick={onClose}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: "transparent",
              color: C.gray,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>{" "}
          <button
            onClick={handleSave}
            disabled={saving || incomplete}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: C.red,
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              opacity: saving || !reason ? 0.5 : 1,
            }}
          >
            {saving ? "Saving..." : "Mark as Lost"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>,
    document.body,
  );
}

/* ── Action-oriented filter logic ─────────────────────────── */
const PIPELINE_FILTERS = [
  { key: "all", label: "All", color: C.heading },
  { key: "needs_estimate", label: "Needs Estimate", color: C.amber },
  { key: "ready_to_send", label: "Ready to Send", color: C.teal },
  { key: "scheduled", label: "Scheduled", color: C.teal },
  { key: "awaiting", label: "Awaiting Response", color: C.blue },
  { key: "follow_up", label: "Follow Up Now", color: C.amber },
  { key: "won", label: "Won", color: C.green },
  { key: "lost", label: "Lost", color: C.red },
  { key: "archived", label: "Archived", color: C.muted || C.heading },
];

function classifyEstimate(e) {
  // Archived trumps status for filter bucketing. The list API returns only
  // archived rows when ?archived=only is set, so this mostly affects the
  // filter-count math in the pills.
  if (e.archivedAt) return "archived";
  if (e.status === "accepted") return "won";
  if (e.status === "declined" || e.status === "expired") return "lost";
  if (e.status === "draft" && (!e.monthlyTotal || e.monthlyTotal === 0))
    return "needs_estimate";
  if (e.status === "draft" && e.monthlyTotal > 0) return "ready_to_send";
  if (e.status === "scheduled") return "scheduled";
  if (e.status === "sent" && !e.viewedAt) return "awaiting";
  if (e.status === "viewed") return "follow_up";
  if (e.status === "sent" && e.viewedAt) return "follow_up";
  return "all";
}



export {
  STATUS_CONFIG,
  PIPELINE_FILTERS,
  DECLINE_REASONS,
  declinePayload,
  classifyEstimate,
  getUrgencyIndicator,
  detectCompetitor,
  FollowUpModal,
  DeclineModal,
};
