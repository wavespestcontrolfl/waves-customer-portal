import { useState, useEffect, useCallback, useRef } from "react";
import { Award, Building2, CheckCircle2, Download, RefreshCw, Search, Send, Star, UserCheck } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import ReviewVelocityEngine from "./ReviewVelocityEngine";
import GBPManagementPanel from "./GBPManagement";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: `teal` folded to zinc-900. Semantic green/amber/red preserved.
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
const isMobile = typeof window !== "undefined" && window.innerWidth < 640;

// Flat leaf sections (one per content tab). `activeTab` holds a LEAF key, so
// every {activeTab === "..."} render block below is unchanged.
const REVIEWS_LEAF_SECTIONS = [
  { key: "reviews", label: "Reviews", Icon: Star },
  { key: "gbp", label: "GBP Management", Icon: Building2 },
  { key: "outreach", label: "Review Outreach", Icon: Send },
  { key: "incentives", label: "Incentives", Icon: Award },
];

// The flat leaf bar is grouped into parent sections, each revealing its leaf
// tabs in a sub-row. The primary "reviews" group stays first.
const REVIEWS_TAB_GROUPS = [
  { key: "reviews", label: "Reviews", Icon: Star, tabs: ["reviews"] },
  {
    key: "outreach",
    label: "Outreach",
    Icon: Send,
    tabs: ["outreach", "incentives"],
  },
  { key: "gbp", label: "GBP", Icon: Building2, tabs: ["gbp"] },
];
const REVIEWS_LEAF_BY_KEY = Object.fromEntries(
  REVIEWS_LEAF_SECTIONS.map((s) => [s.key, s]),
);

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    const text = await r.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON body (proxy/gateway error page, stale cached bundle, timeout).
        // Surface the HTTP status instead of a raw "Unexpected token" parse error.
        throw new Error(
          r.ok ? "Unexpected non-JSON response from server" : `HTTP ${r.status}`,
        );
      }
    }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  return `${months} months ago`;
}

function Stars({ count, size = 16 }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
      }}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          size={size}
          fill={i < count ? D.amber : "none"}
          color={i < count ? D.amber : D.border}
          strokeWidth={1.8}
        />
      ))}
    </span>
  );
}

// --- Stat Card ---
function StatCard({ label, value, sub, color, highlight }) {
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${highlight ? color : D.border}`,
        borderRadius: 12,
        padding: isMobile ? "14px 12px" : "20px 24px",
        flex: isMobile ? "1 1 calc(50% - 6px)" : "1 1 0",
        minWidth: isMobile ? 0 : 180,
      }}
    >
      {" "}
      <div
        style={{
          color: D.muted,
          fontSize: 12,
          fontFamily: "Roboto, Arial, sans-serif",
          textTransform: "uppercase",
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        {label}
      </div>{" "}
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 28,
          fontWeight: 700,
          color: color || D.heading,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ color: D.muted, fontSize: 13, marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

// --- Star Breakdown Bar ---
function BreakdownBar({ star, count, max }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}
    >
      {" "}
      <span
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 12,
          color: D.muted,
          width: 16,
          textAlign: "right",
        }}
      >
        {star}
      </span>{" "}
      <Star size={11} color={D.amber} fill={D.amber} style={{ flexShrink: 0 }} />{" "}
      <div
        style={{
          flex: 1,
          height: 8,
          background: "#FFFFFF",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        {" "}
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: D.amber,
            borderRadius: 4,
            transition: "width 0.3s ease",
          }}
        />{" "}
      </div>{" "}
      <span
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 12,
          color: D.muted,
          width: 24,
          textAlign: "right",
        }}
      >
        {count}
      </span>{" "}
    </div>
  );
}

// --- Location Card ---
function LocationCard({ loc, breakdown, onRequestReview }) {
  const maxCount = breakdown ? Math.max(...Object.values(breakdown), 1) : 1;
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: isMobile ? 14 : 20,
        flex: isMobile ? "1 1 100%" : "1 1 220px",
        minWidth: isMobile ? 0 : 220,
      }}
    >
      {" "}
      <div
        style={{
          fontFamily: "Roboto, Arial, sans-serif",
          fontSize: 16,
          fontWeight: 600,
          color: D.heading,
          marginBottom: 4,
        }}
      >
        {loc.name}
      </div>{" "}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        {" "}
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 20,
            fontWeight: 700,
            color: D.heading,
          }}
        >
          {loc.avgRating}
        </span>{" "}
        <Stars count={Math.round(Number(loc.avgRating))} size={14} />{" "}
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 13,
            color: D.muted,
          }}
        >
          ({loc.count})
        </span>{" "}
      </div>{" "}
      <div style={{ marginBottom: 16 }}>
        {[5, 4, 3, 2, 1].map((s) => (
          <BreakdownBar
            key={s}
            star={s}
            count={breakdown?.[String(s)] || 0}
            max={maxCount}
          />
        ))}
      </div>{" "}
      <div style={{ display: "flex", gap: 8 }}>
        {" "}
        <button
          onClick={() => onRequestReview(loc)}
          style={{
            flex: 1,
            padding: "8px 12px",
            background: D.teal,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontSize: 13,
            fontFamily: "Roboto, Arial, sans-serif",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Request Review
        </button>
        {loc.reviewUrl && (
          <a
            href={loc.reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "8px 12px",
              border: `1px solid ${D.border}`,
              color: D.muted,
              borderRadius: 8,
              fontSize: 13,
              fontFamily: "Roboto, Arial, sans-serif",
              textDecoration: "none",
              display: "flex",
              alignItems: "center",
            }}
          >
            Google
          </a>
        )}
      </div>{" "}
    </div>
  );
}

// --- Review Card ---
function ReviewCard({ review, onReplySubmit, onDismiss }) {
  const [editing, setEditing] = useState(false);
  const [replyText, setReplyText] = useState(review.reply || "");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const handleSubmit = async () => {
    if (!replyText.trim()) return;
    setSubmitting(true);
    try {
      await onReplySubmit(review.id, replyText.trim());
      setEditing(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      alert("Failed to post reply: " + e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAiReply = async () => {
    setAiLoading(true);
    try {
      const data = await adminFetch(`/admin/reviews/${review.id}/ai-reply`, {
        method: "POST",
      });
      if (data.reply) {
        setReplyText(data.reply);
        setEditing(true);
      }
    } catch (e) {
      alert("AI reply failed: " + e.message);
    } finally {
      setAiLoading(false);
    }
  };

  const LOCATION_LABELS = {
    "bradenton": "Lakewood Ranch",
    parrish: "Parrish",
    sarasota: "Sarasota",
    venice: "Venice",
  };

  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 12,
        padding: 20,
        marginBottom: 12,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 8,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {" "}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {review.reviewerPhoto ? (
            <img
              src={review.reviewerPhoto}
              alt=""
              style={{ width: 36, height: 36, borderRadius: "50%" }}
            />
          ) : (
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                background: "#334155",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
                fontWeight: 600,
                color: D.muted,
              }}
            >
              {(review.reviewerName || "?")[0]}
            </div>
          )}
          <div>
            {" "}
            <div
              style={{
                fontFamily: "Roboto, Arial, sans-serif",
                fontSize: 15,
                fontWeight: 600,
                color: D.heading,
              }}
            >
              {review.reviewerName}
            </div>{" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 2,
              }}
            >
              {" "}
              <Stars count={review.starRating} size={14} />{" "}
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "Roboto, Arial, sans-serif",
                  background: "#334155",
                  color: "#FFFFFF",
                  padding: "2px 8px",
                  borderRadius: 99,
                }}
              >
                {LOCATION_LABELS[review.locationId] || review.locationId}
              </span>{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 12,
            color: D.muted,
          }}
        >
          {timeAgo(review.reviewCreatedAt)}
        </div>{" "}
      </div>
      {/* Review text */}
      {review.reviewText && (
        <div
          style={{
            fontFamily: "Roboto, Arial, sans-serif",
            fontSize: 14,
            color: D.text,
            lineHeight: 1.6,
            margin: "12px 0",
          }}
        >
          {review.reviewText}
        </div>
      )}

      {/* Matched customer */}
      {review.matchedCustomer && (
        <div
          style={{
            fontSize: 13,
            fontFamily: "Roboto, Arial, sans-serif",
            color: D.teal,
            marginBottom: 12,
          }}
        >
          Matched: {review.matchedCustomer.name} — {review.matchedCustomer.tier}
        </div>
      )}

      {/* Reply section */}
      <div
        style={{
          borderTop: `1px solid ${D.border}`,
          paddingTop: 12,
          marginTop: 8,
        }}
      >
        {review.draftReply && !review.reply && !editing && (
          <div
            style={{
              padding: 10,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              background: D.bg,
              marginBottom: 10,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 12,
                color: D.muted,
                fontFamily: "Roboto, Arial, sans-serif",
                marginBottom: 4,
              }}
            >
              Saved draft
            </div>{" "}
            <div
              style={{
                fontSize: 13,
                color: D.text,
                fontFamily: "Roboto, Arial, sans-serif",
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
              }}
            >
              {review.draftReply}
            </div>{" "}
            <button
              onClick={() => {
                setReplyText(review.draftReply);
                setEditing(true);
              }}
              style={{
                marginTop: 8,
                padding: "6px 12px",
                background: "transparent",
                border: `1px solid ${D.teal}`,
                color: D.teal,
                borderRadius: 6,
                fontSize: 12,
                fontFamily: "Roboto, Arial, sans-serif",
                cursor: "pointer",
              }}
            >
              Use Draft
            </button>{" "}
          </div>
        )}

        {success && (
          <div
            style={{
              color: D.green,
              fontSize: 13,
              fontFamily: "Roboto, Arial, sans-serif",
              marginBottom: 8,
            }}
          >
            Reply posted successfully
          </div>
        )}

        {review.reply && !editing ? (
          <div>
            {" "}
            <div
              style={{
                fontSize: 12,
                color: D.muted,
                fontFamily: "Roboto, Arial, sans-serif",
                marginBottom: 4,
              }}
            >
              Your reply{" "}
              {review.replyUpdatedAt && (
                <span>· {timeAgo(review.replyUpdatedAt)}</span>
              )}
            </div>{" "}
            <div
              style={{
                fontSize: 14,
                color: D.text,
                fontFamily: "Roboto, Arial, sans-serif",
                lineHeight: 1.5,
                marginBottom: 8,
              }}
            >
              {review.reply}
            </div>{" "}
            <div style={{ display: "flex", gap: 8 }}>
              {" "}
              <button
                onClick={() => {
                  setEditing(true);
                  setReplyText(review.reply);
                }}
                style={{
                  padding: "6px 14px",
                  background: "transparent",
                  border: `1px solid ${D.border}`,
                  color: D.muted,
                  borderRadius: 6,
                  fontSize: 13,
                  fontFamily: "Roboto, Arial, sans-serif",
                  cursor: "pointer",
                  minHeight: 44,
                }}
              >
                Edit
              </button>{" "}
              <button
                onClick={handleAiReply}
                disabled={aiLoading}
                style={{
                  padding: "6px 14px",
                  background: "transparent",
                  border: `1px solid ${D.teal}`,
                  color: D.teal,
                  borderRadius: 6,
                  fontSize: 13,
                  fontFamily: "Roboto, Arial, sans-serif",
                  cursor: "pointer",
                  opacity: aiLoading ? 0.5 : 1,
                }}
              >
                {aiLoading ? "Generating..." : "AI Reply"}
              </button>{" "}
            </div>{" "}
          </div>
        ) : editing || !review.reply ? (
          <div>
            {" "}
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write your reply..."
              rows={3}
              style={{
                width: "100%",
                padding: 12,
                background: D.bg,
                border: `1px solid ${D.border}`,
                borderRadius: 8,
                color: D.text,
                fontSize: 14,
                fontFamily: "Roboto, Arial, sans-serif",
                resize: "vertical",
                outline: "none",
                boxSizing: "border-box",
              }}
            />{" "}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {" "}
              <button
                onClick={handleSubmit}
                disabled={submitting || !replyText.trim()}
                style={{
                  padding: "8px 18px",
                  background: D.teal,
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: "Roboto, Arial, sans-serif",
                  fontWeight: 600,
                  cursor: submitting ? "not-allowed" : "pointer",
                  opacity: submitting || !replyText.trim() ? 0.5 : 1,
                }}
              >
                {submitting
                  ? "Posting..."
                  : review.reply
                    ? "Update Reply"
                    : "Reply"}
              </button>{" "}
              <button
                onClick={handleAiReply}
                disabled={aiLoading}
                style={{
                  padding: "8px 18px",
                  background: "transparent",
                  border: `1px solid ${D.teal}`,
                  color: D.teal,
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: "Roboto, Arial, sans-serif",
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: aiLoading ? 0.5 : 1,
                }}
              >
                {aiLoading ? "Generating..." : "AI Reply"}
              </button>
              {replyText.trim() && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(replyText);
                  }}
                  style={{
                    padding: "8px 18px",
                    background: "transparent",
                    border: `1px solid ${D.border}`,
                    color: D.muted,
                    borderRadius: 8,
                    fontSize: 13,
                    fontFamily: "Roboto, Arial, sans-serif",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Copy
                </button>
              )}
              {editing && (
                <button
                  onClick={() => {
                    setEditing(false);
                    setReplyText(review.reply || "");
                  }}
                  style={{
                    padding: "8px 14px",
                    background: "transparent",
                    border: `1px solid ${D.border}`,
                    color: D.muted,
                    borderRadius: 8,
                    fontSize: 13,
                    fontFamily: "Roboto, Arial, sans-serif",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              )}
            </div>{" "}
          </div>
        ) : null}
      </div>
      {/* Dismiss */}
      {onDismiss && (
        <div style={{ textAlign: "right", marginTop: 8 }}>
          {" "}
          <button
            onClick={() => onDismiss(review.id)}
            style={{
              padding: "4px 10px",
              background: "transparent",
              border: "none",
              color: D.muted,
              fontSize: 11,
              fontFamily: "Roboto, Arial, sans-serif",
              cursor: "pointer",
              opacity: 0.6,
            }}
          >
            Dismiss
          </button>{" "}
        </div>
      )}
    </div>
  );
}

// --- Select input ---
function Select({ value, onChange, options, style: extraStyle }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "8px 12px",
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 8,
        color: D.text,
        fontSize: 13,
        fontFamily: "Roboto, Arial, sans-serif",
        outline: "none",
        cursor: "pointer",
        ...extraStyle,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function money(cents) {
  const value = (Number(cents) || 0) / 100;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function fmtShortDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function fmtDateTime(value) {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      timeZoneName: "short",
    });
  } catch {
    return "";
  }
}

function PolicyInfoCard({ Icon, label, value, sub, color = D.teal }) {
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderRadius: 8,
        padding: 14,
        display: "grid",
        gridTemplateColumns: "20px minmax(0, 1fr)",
        gap: 10,
        alignItems: "start",
      }}
    >
      <Icon size={18} color={color} style={{ marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: D.muted, marginBottom: 4 }}>
          {label}
        </div>
        <div style={{ fontSize: 14, fontWeight: 800, color: D.heading, lineHeight: 1.25 }}>
          {value}
        </div>
        {sub && (
          <div style={{ fontSize: 12, color: D.muted, marginTop: 5, lineHeight: 1.4 }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewIncentivesPanel() {
  const [days, setDays] = useState("30");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [error, setError] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [activeRepairId, setActiveRepairId] = useState(null);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidateResults, setCandidateResults] = useState([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [matching, setMatching] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    setQueueLoading(true);
    setError(null);
    Promise.all([
      adminFetch(`/admin/reviews/incentives?days=${days}`),
      adminFetch(`/admin/reviews/incentives/attribution-queue?days=${days}`),
    ])
      .then(([d, q]) => {
        setData(d);
        setQueue(q.items || []);
        setLoading(false);
        setQueueLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
        setQueueLoading(false);
      });
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const runSync = async () => {
    setRunning(true);
    setError(null);
    try {
      const d = await adminFetch("/admin/reviews/incentives/sync", {
        method: "POST",
        body: JSON.stringify({ days: Number(days) || 30 }),
      });
      const q = await adminFetch(`/admin/reviews/incentives/attribution-queue?days=${days}`);
      setData(d);
      setQueue(q.items || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const markPendingPaid = async () => {
    const ids = (data?.payouts || [])
      .filter((p) => p.status !== "paid")
      .map((p) => p.id);
    if (!ids.length) return;
    setMarkingPaid(true);
    setError(null);
    try {
      await adminFetch("/admin/reviews/incentives/mark-paid", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setMarkingPaid(false);
    }
  };

  const downloadCsv = async () => {
    try {
      const res = await fetch(
        `${API_BASE}/admin/reviews/incentives/export?days=${days}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "waves-review-incentives.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  };

  const openRepair = (review) => {
    const isOpen = activeRepairId === review.id;
    setActiveRepairId(isOpen ? null : review.id);
    setCandidateSearch(isOpen ? "" : review.reviewerName || "");
    setCandidateResults([]);
  };

  const searchCandidates = async (review) => {
    setCandidateLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        reviewId: review.id,
        q: candidateSearch || review.reviewerName || "",
      });
      const result = await adminFetch(`/admin/reviews/incentives/attribution-candidates?${params.toString()}`);
      setCandidateResults(result.candidates || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setCandidateLoading(false);
    }
  };

  const attributeCandidate = async (review, candidate, service) => {
    const matchKey = `${review.id}:${candidate.id}:${service.id}`;
    setMatching((prev) => ({ ...prev, [matchKey]: true }));
    setError(null);
    try {
      await adminFetch("/admin/reviews/incentives/attribute", {
        method: "POST",
        body: JSON.stringify({
          reviewId: review.id,
          customerId: candidate.id,
          technicianId: service.technicianId,
          serviceRecordId: service.serviceRecordId,
        }),
      });
      setActiveRepairId(null);
      setCandidateSearch("");
      setCandidateResults([]);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setMatching((prev) => ({ ...prev, [matchKey]: false }));
    }
  };

  const summary = data?.summary || {};
  const payouts = data?.payouts || [];
  const pendingIds = payouts.filter((p) => p.status !== "paid").map((p) => p.id);
  const policy = data?.policy || {};
  const needsAttributionCount = queueLoading
    ? "..."
    : queue.length || ((summary.unattributedGoogleReviews || 0) + (summary.unattributedReviewRequests || 0));
  const confirmedGoogleReviews = Number(summary.confirmedGoogleReviews || 0);
  const programStartsAt = policy.programStartsAt || data?.period?.programStartsAt || null;
  const programStartLabel = fmtDateTime(programStartsAt) || "Not configured";
  const policyEnabled = policy.enabled !== false;
  const noEligiblePostLaunchReviews = policyEnabled
    && confirmedGoogleReviews === 0
    && payouts.length === 0
    && queue.length === 0;

  return (
    <div style={{ fontFamily: "Roboto, Arial, sans-serif" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>
            Technician Review Incentives
          </div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 2 }}>
            Flat {money(policy.amountCents || 500)} bonus per confirmed Google review.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Select
            value={days}
            onChange={setDays}
            options={[
              { value: "7", label: "7 Days" },
              { value: "30", label: "30 Days" },
              { value: "90", label: "90 Days" },
            ]}
          />
          <button
            onClick={runSync}
            disabled={running}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "9px 14px",
              borderRadius: 8,
              border: "none",
              background: D.teal,
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: running ? "not-allowed" : "pointer",
              opacity: running ? 0.55 : 1,
            }}
          >
            <RefreshCw size={15} />
            {running ? "Running..." : "Run Attribution"}
          </button>
          <button
            onClick={downloadCsv}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "9px 14px",
              borderRadius: 8,
              border: `1px solid ${D.border}`,
              background: D.card,
              color: D.text,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            <Download size={15} />
            Export
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            border: `1px solid ${D.red}`,
            color: D.red,
            background: "#FEF2F2",
            borderRadius: 8,
            padding: 12,
            marginBottom: 14,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: D.muted, padding: 48, textAlign: "center" }}>
          Loading review incentives...
        </div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))",
              gap: 10,
              marginBottom: 14,
            }}
          >
            <PolicyInfoCard
              Icon={Award}
              label="Program active since"
              value={programStartLabel}
              sub="Reviews before this cutoff stay excluded from payouts and attribution repair."
            />
            <PolicyInfoCard
              Icon={CheckCircle2}
              label="Payout trigger"
              value="Confirmed public Google reviews after activation"
              sub="A bonus row is created only after the review is synced from Google and matched to a technician."
              color={D.green}
            />
            <PolicyInfoCard
              Icon={Search}
              label="Attribution context"
              value="Rate page and review requests are not payout triggers"
              sub="They only help connect a confirmed Google review to the right customer and technician."
              color={D.amber}
            />
          </div>

          {noEligiblePostLaunchReviews && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "22px minmax(0, 1fr)",
                gap: 10,
                alignItems: "start",
                background: "#F0FDF4",
                border: `1px solid ${D.green}`,
                borderRadius: 8,
                padding: 14,
                marginBottom: 14,
              }}
            >
              <CheckCircle2 size={18} color={D.green} style={{ marginTop: 1 }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>
                  No eligible post-launch Google reviews yet.
                </div>
                <div style={{ fontSize: 12, color: D.text, marginTop: 4, lineHeight: 1.45 }}>
                  Old reviews are intentionally ignored. The first public Google review after activation will either create an earned payout or appear in the attribution queue.
                </div>
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            <StatCard
              label="Post-Launch Reviews"
              value={confirmedGoogleReviews}
              sub="public Google reviews since activation"
              color={D.heading}
            />
            <StatCard
              label="Earned"
              value={money(summary.earnedCents)}
              sub={`${summary.payoutCount || 0} technician bonuses`}
              color={D.teal}
            />
            <StatCard
              label="Pending Payroll"
              value={money(summary.pendingCents)}
              sub={`${summary.pendingCount || 0} unpaid bonuses`}
              color={summary.pendingCents > 0 ? D.amber : D.green}
            />
            <StatCard
              label="Paid"
              value={money(summary.paidCents)}
              sub={`${summary.paidCount || 0} closed bonuses`}
              color={D.green}
            />
            <StatCard
              label="Needs Attribution"
              value={needsAttributionCount}
              sub="post-launch reviews missing a customer or technician match"
              color={D.red}
            />
          </div>

          <div
            style={{
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 10,
              padding: 16,
              marginBottom: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>
                  Attribution Queue
                </div>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                  Confirmed Google reviews without a technician bonus row.
                </div>
              </div>
              <button
                onClick={load}
                disabled={queueLoading}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: `1px solid ${D.border}`,
                  background: D.card,
                  color: D.text,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: queueLoading ? "not-allowed" : "pointer",
                  opacity: queueLoading ? 0.55 : 1,
                }}
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            </div>

            {queueLoading && !queue.length ? (
              <div style={{ color: D.muted, fontSize: 13, padding: "16px 0" }}>
                Loading attribution queue...
              </div>
            ) : queue.length === 0 ? (
              <div style={{ color: D.muted, fontSize: 13, padding: "16px 0" }}>
                {confirmedGoogleReviews === 0
                  ? "No eligible post-launch Google reviews in this period."
                  : "No unmatched post-launch Google reviews in this period."}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {queue.slice(0, 25).map((review) => {
                  const isOpen = activeRepairId === review.id;
                  return (
                    <div
                      key={review.id}
                      style={{
                        border: `1px solid ${D.border}`,
                        borderRadius: 8,
                        background: D.bg,
                        padding: 12,
                      }}
                    >
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) auto",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        <div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            <span style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>
                              {review.reviewerName}
                            </span>
                            <Stars count={Number(review.starRating) || 0} size={13} />
                            <span style={{ fontSize: 12, color: D.muted }}>
                              {[fmtShortDate(review.reviewCreatedAt), review.locationId].filter(Boolean).join(" | ")}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                            {review.customerName || review.reason?.replace("_", " ")}
                          </div>
                          {review.reviewText && (
                            <div
                              style={{
                                color: D.text,
                                fontSize: 13,
                                marginTop: 6,
                                lineHeight: 1.45,
                                maxWidth: 760,
                              }}
                            >
                              {review.reviewText.length > 220
                                ? `${review.reviewText.slice(0, 220)}...`
                                : review.reviewText}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => openRepair(review)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 6,
                            padding: "8px 12px",
                            borderRadius: 8,
                            border: `1px solid ${D.border}`,
                            background: isOpen ? D.teal : D.card,
                            color: isOpen ? "#fff" : D.text,
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <Search size={14} />
                          Match
                        </button>
                      </div>

                      {isOpen && (
                        <div
                          style={{
                            marginTop: 12,
                            borderTop: `1px solid ${D.border}`,
                            paddingTop: 12,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              alignItems: "center",
                              flexWrap: "wrap",
                              marginBottom: 10,
                            }}
                          >
                            <input
                              value={candidateSearch}
                              onChange={(e) => setCandidateSearch(e.target.value)}
                              placeholder="Customer name, phone, address, or city"
                              style={{
                                flex: "1 1 280px",
                                minWidth: 0,
                                padding: "9px 11px",
                                borderRadius: 8,
                                border: `1px solid ${D.inputBorder}`,
                                fontSize: 13,
                                color: D.text,
                                background: D.card,
                              }}
                            />
                            <button
                              onClick={() => searchCandidates(review)}
                              disabled={candidateLoading}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                                padding: "9px 12px",
                                borderRadius: 8,
                                border: "none",
                                background: D.teal,
                                color: "#fff",
                                fontSize: 12,
                                fontWeight: 700,
                                cursor: candidateLoading ? "not-allowed" : "pointer",
                                opacity: candidateLoading ? 0.55 : 1,
                              }}
                            >
                              <Search size={14} />
                              Search
                            </button>
                          </div>

                          {candidateLoading ? (
                            <div style={{ color: D.muted, fontSize: 13 }}>Searching...</div>
                          ) : candidateResults.length === 0 ? (
                            <div style={{ color: D.muted, fontSize: 13 }}>
                              No candidate results.
                            </div>
                          ) : (
                            <div style={{ display: "grid", gap: 8 }}>
                              {candidateResults.map((candidate) => (
                                <div
                                  key={candidate.id}
                                  style={{
                                    border: `1px solid ${D.border}`,
                                    borderRadius: 8,
                                    background: D.card,
                                    padding: 10,
                                  }}
                                >
                                  <div style={{ fontSize: 13, fontWeight: 800, color: D.heading }}>
                                    {candidate.name}
                                  </div>
                                  <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                                    {[candidate.address, candidate.city, candidate.phone].filter(Boolean).join(" | ")}
                                  </div>
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: 8,
                                      flexWrap: "wrap",
                                      marginTop: 10,
                                    }}
                                  >
                                    {(candidate.services || []).length === 0 ? (
                                      <span style={{ color: D.muted, fontSize: 12 }}>
                                        No recent technician visits.
                                      </span>
                                    ) : (
                                      candidate.services.map((service) => {
                                        const matchKey = `${review.id}:${candidate.id}:${service.id}`;
                                        return (
                                          <button
                                            key={service.id}
                                            onClick={() => attributeCandidate(review, candidate, service)}
                                            disabled={Boolean(matching[matchKey]) || !service.technicianId}
                                            style={{
                                              display: "inline-flex",
                                              alignItems: "center",
                                              gap: 6,
                                              padding: "8px 10px",
                                              borderRadius: 8,
                                              border: `1px solid ${D.border}`,
                                              background: D.bg,
                                              color: service.technicianId ? D.text : D.muted,
                                              fontSize: 12,
                                              fontWeight: 700,
                                              cursor: service.technicianId ? "pointer" : "not-allowed",
                                              opacity: matching[matchKey] ? 0.55 : 1,
                                            }}
                                          >
                                            <UserCheck size={14} />
                                            {matching[matchKey] ? "Matching..." : `${service.technicianName} | ${fmtShortDate(service.serviceDate)}`}
                                          </button>
                                        );
                                      })
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: isMobile ? "1fr" : "minmax(260px, 0.8fr) minmax(0, 1.4fr)",
              gap: 14,
              alignItems: "start",
            }}
          >
            <div
              style={{
                background: D.card,
                border: `1px solid ${D.border}`,
                borderRadius: 10,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginBottom: 12 }}>
                Leaderboard
              </div>
              {(data?.leaderboard || []).length === 0 ? (
                <div style={{ color: D.muted, fontSize: 13 }}>No attributed review bonuses yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {data.leaderboard.map((row, index) => (
                    <div
                      key={row.technicianId || index}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "24px 1fr auto",
                        gap: 10,
                        alignItems: "center",
                        padding: "10px 0",
                        borderBottom: index === data.leaderboard.length - 1 ? "none" : `1px solid ${D.border}`,
                      }}
                    >
                      <div style={{ fontWeight: 800, color: D.muted }}>{index + 1}</div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: D.text }}>
                          {row.technicianName}
                        </div>
                        <div style={{ fontSize: 12, color: D.muted }}>
                          {row.reviewCount} review{row.reviewCount === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div style={{ fontFamily: "JetBrains Mono, monospace", fontWeight: 800 }}>
                        {money(row.earnedCents)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div
              style={{
                background: D.card,
                border: `1px solid ${D.border}`,
                borderRadius: 10,
                padding: 16,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>
                  Payout Ledger
                </div>
                <button
                  onClick={markPendingPaid}
                  disabled={markingPaid || pendingIds.length === 0}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: `1px solid ${D.border}`,
                    background: pendingIds.length ? D.card : D.bg,
                    color: pendingIds.length ? D.text : D.muted,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: pendingIds.length ? "pointer" : "not-allowed",
                    opacity: markingPaid ? 0.55 : 1,
                  }}
                >
                  <CheckCircle2 size={15} />
                  {markingPaid ? "Updating..." : "Mark Pending Paid"}
                </button>
              </div>

              {payouts.length === 0 ? (
                <div style={{ color: D.muted, fontSize: 13, padding: "20px 0" }}>
                  No payout rows in this period.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {payouts.slice(0, 50).map((p) => (
                    <div
                      key={p.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: isMobile ? "1fr" : "1fr auto auto",
                        gap: isMobile ? 6 : 12,
                        alignItems: "center",
                        border: `1px solid ${D.border}`,
                        borderRadius: 8,
                        padding: "10px 12px",
                        background: D.bg,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
                          {p.technicianName}
                        </div>
                        <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                          {[p.customerName, p.source?.replace("_", " "), fmtShortDate(p.earnedAt)]
                            .filter(Boolean)
                            .join(" | ")}
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 800,
                          color: p.status === "paid" ? D.green : D.amber,
                          textTransform: "uppercase",
                        }}
                      >
                        {/* The summary calls unpaid bonuses "Pending Payroll";
                            keep the ledger vocab aligned (status is 'earned'). */}
                        {p.status === "paid" ? "Paid" : "Pending"}
                      </div>
                      <div style={{ fontFamily: "JetBrains Mono, monospace", fontWeight: 800 }}>
                        {money(p.amountCents)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function ReviewsPage() {
  const [activeTab, setActiveTab] = useState("reviews");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters
  const [filterLocation, setFilterLocation] = useState("all");
  const [filterRating, setFilterRating] = useState("all");
  // Default to "needs-reply" so the queue shows only the reviews still
  // waiting on a portal response. Reviews we've already replied to
  // (either via the portal or directly on Google — the latter flowing
  // back through the hourly Places sync as `review_reply`) drop off the
  // list automatically. Operators can flip back to "All Reviews" via
  // the filter dropdown when they need the full archive.
  const [filterResponded, setFilterResponded] = useState("needs-reply");
  const [search, setSearch] = useState("");
  const loadSeqRef = useRef(0);

  const loadData = useCallback(() => {
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: "200" });
    if (filterLocation !== "all") params.set("location", filterLocation);
    if (filterRating !== "all") params.set("rating", filterRating);
    if (filterResponded === "responded") params.set("responded", "true");
    if (filterResponded === "needs-reply") params.set("responded", "false");
    if (search.trim()) params.set("search", search.trim());
    adminFetch(`/admin/reviews?${params.toString()}`)
      .then((d) => {
        if (loadSeq !== loadSeqRef.current) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (loadSeq !== loadSeqRef.current) return;
        setError(e.message);
        setLoading(false);
      });
  }, [filterLocation, filterRating, filterResponded, search]);

  useEffect(() => {
    const t = setTimeout(loadData, search.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadData, search]);

  const handleReply = async (reviewId, replyText) => {
    await adminFetch(`/admin/reviews/${reviewId}/reply`, {
      method: "POST",
      body: JSON.stringify({ replyText }),
    });
    // Update local state
    setData((prev) => ({
      ...prev,
      reviews: prev.reviews.map((r) =>
        r.id === reviewId
          ? { ...r, reply: replyText, replyUpdatedAt: new Date().toISOString() }
          : r,
      ),
    }));
  };

  const handleDismiss = async (reviewId) => {
    await adminFetch(`/admin/reviews/${reviewId}/dismiss`, { method: "POST" });
    setData((prev) => ({
      ...prev,
      reviews: prev.reviews.filter((r) => r.id !== reviewId),
    }));
  };

  const handleRequestReview = (loc) => {
    if (loc.reviewUrl) {
      navigator.clipboard
        .writeText(loc.reviewUrl)
        .then(() => {
          alert(`Review link for ${loc.name} copied to clipboard!`);
        })
        .catch(() => {
          window.open(loc.reviewUrl, "_blank");
        });
    }
  };

  // --- Compute reviews data (without early returns, so tabs always render) ---
  const reviews = data?.reviews || [];
  const stats = data?.stats || {};
  const locations = data?.locations || [];
  const {
    totalReviews = 0,
    avgRating = 0,
    unresponded = 0,
    responded = 0,
    newThisMonth = 0,
    breakdown = {},
    locationBreakdown = {},
    perLocation = [],
  } = stats;

  // Response rate must use locally synced review rows only. Google's
  // user_ratings_total includes older reviews that Places does not return in
  // the review list, so mixing that total with local reply rows overstates
  // replies.
  const ratedTotal = responded + unresponded;
  const respondedCount = responded;
  const responseRate =
    ratedTotal > 0 ? Math.round((respondedCount / ratedTotal) * 100) : 0;

  // --- Filtering ---
  const filtered = reviews.filter((r) => {
    // Server-side filters load the matching result set. Keep this light client
    // pass as a guard against stale in-flight responses during fast filter edits.
    if (filterLocation !== "all" && r.locationId !== filterLocation)
      return false;
    if (filterRating !== "all" && r.starRating !== Number(filterRating))
      return false;
    if (filterResponded === "responded" && !r.reply) return false;
    if (filterResponded === "needs-reply" && r.reply) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matches =
        (r.reviewerName || "").toLowerCase().includes(q) ||
        (r.reviewText || "").toLowerCase().includes(q) ||
        (r.matchedCustomer?.name || "").toLowerCase().includes(q);
      if (!matches) return false;
    }
    return true;
  });

  // Build per-location lookup merging API locations with stats
  const locLookup = {};
  locations.forEach((l) => {
    locLookup[l.id] = { ...l, count: 0, avgRating: "0.0" };
  });
  perLocation.forEach((p) => {
    if (locLookup[p.locationId]) {
      locLookup[p.locationId].count = p.count;
      locLookup[p.locationId].avgRating = p.avgRating;
    }
  });

  const locationOptions = [
    { value: "all", label: "All Locations" },
    { value: "bradenton", label: "Lakewood Ranch" },
    { value: "parrish", label: "Parrish" },
    { value: "sarasota", label: "Sarasota" },
    { value: "venice", label: "Venice" },
  ];

  const ratingOptions = [
    { value: "all", label: "All Ratings" },
    { value: "5", label: "5 Stars" },
    { value: "4", label: "4 Stars" },
    { value: "3", label: "3 Stars" },
    { value: "2", label: "2 Stars" },
    { value: "1", label: "1 Star" },
  ];

  const respondedOptions = [
    { value: "all", label: "All Reviews" },
    { value: "responded", label: "Responded" },
    { value: "needs-reply", label: "Needs Reply" },
  ];
  const activeGroup =
    REVIEWS_TAB_GROUPS.find((g) => g.tabs.includes(activeTab)) ||
    REVIEWS_TAB_GROUPS[0];
  const fallbackLocations = locations.filter(
    (l) => l.reviewsSource && l.reviewsSource !== "gbp",
  );

  return (
    <div>
      {" "}
      <AdminCommandHeader
        title="Reviews"
        icon={Star}
        sections={REVIEWS_TAB_GROUPS.map((g) => ({
          key: g.key,
          label: g.label,
          Icon: g.Icon,
        }))}
        activeKey={activeGroup.key}
        onSectionChange={(key) => {
          const g = REVIEWS_TAB_GROUPS.find((x) => x.key === key);
          if (g) setActiveTab(g.tabs[0]);
        }}
        ariaLabel="Reviews section"
        navGridClassName="grid-cols-1 md:grid-cols-3"
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
            const leaf = REVIEWS_LEAF_BY_KEY[key];
            const active = activeTab === key;
            const LeafIcon = leaf.Icon;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
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
      {/* ====================== TAB: REVIEWS ====================== */}
      {activeTab === "reviews" && (
        <div>
          {/* Loading state */}
          {loading && (
            <div
              style={{
                color: D.muted,
                padding: 60,
                textAlign: "center",
                fontFamily: "Roboto, Arial, sans-serif",
                fontSize: 15,
              }}
            >
              Loading reviews...
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div
              style={{
                color: D.red,
                padding: 60,
                textAlign: "center",
                fontFamily: "Roboto, Arial, sans-serif",
              }}
            >
              {" "}
              <div style={{ fontSize: 16, marginBottom: 12 }}>
                Failed to load reviews
              </div>{" "}
              <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>
                {error}
              </div>{" "}
              <button
                onClick={loadData}
                style={{
                  padding: "8px 20px",
                  background: D.teal,
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 14,
                  fontFamily: "Roboto, Arial, sans-serif",
                  cursor: "pointer",
                }}
              >
                Retry
              </button>{" "}
            </div>
          )}

          {/* Reviews content */}
          {!loading && !error && data && (
            <>
              {fallbackLocations.length > 0 && (
                <div
                  style={{
                    border: `1px solid ${D.amber}`,
                    background: "#FFFBEB",
                    color: D.amber,
                    borderRadius: 8,
                    padding: "10px 12px",
                    marginBottom: 14,
                    fontSize: 13,
                  }}
                >
                  {fallbackLocations.map((l) => l.name).join(", ")} currently
                  use Places review fallback until GBP Reviews API access is
                  available.
                </div>
              )}
              {/* Page header + Sync Reviews button removed: the page tab
                  ("Reviews") already labels this surface, and the hourly
                  cron added in PR #382 (services/scheduler.js) keeps
                  google_reviews fresh without anyone clicking sync. */}

              {/* Stats bar */}
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  marginBottom: 24,
                  flexWrap: "wrap",
                }}
              >
                {" "}
                <StatCard
                  label="Total Reviews"
                  value={totalReviews}
                  sub={
                    <span>
                      <span style={{ fontFamily: "JetBrains Mono, monospace" }}>
                        {Number(avgRating).toFixed(1)}
                      </span>{" "}
                      <Stars count={Math.round(avgRating)} size={13} />
                    </span>
                  }
                />{" "}
                <StatCard
                  label="No Portal Reply"
                  value={unresponded}
                  color={unresponded > 0 ? D.amber : D.green}
                  sub={
                    unresponded > 0 ? "reply via AI Reply below" : "all replied"
                  }
                />{" "}
                <StatCard
                  label="New This Month"
                  value={newThisMonth}
                  color={D.teal}
                />{" "}
                <StatCard
                  label="Response Rate"
                  value={`${responseRate}%`}
                  color={
                    responseRate >= 90
                      ? D.green
                      : responseRate >= 70
                        ? D.amber
                        : D.red
                  }
                  sub={`${respondedCount} of ${ratedTotal} replied`}
                />{" "}
              </div>
              {/* Per-location cards */}
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  marginBottom: 24,
                  flexWrap: "wrap",
                }}
              >
                {Object.values(locLookup).map((loc) => (
                  <LocationCard
                    key={loc.id}
                    loc={loc}
                    // A location with no synced reviews (e.g. a brand-new GBP)
                    // has no locationBreakdown entry — show zero bars, never
                    // the all-locations breakdown, which painted 178 5-star
                    // rows under a "0.0 (0)" Venice card.
                    breakdown={
                      locationBreakdown[loc.id] || {
                        5: 0,
                        4: 0,
                        3: 0,
                        2: 0,
                        1: 0,
                      }
                    }
                    onRequestReview={handleRequestReview}
                  />
                ))}
              </div>
              {/* Filter bar */}
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  marginBottom: 20,
                  flexWrap: "wrap",
                  alignItems: "center",
                  padding: "12px 16px",
                  background: D.card,
                  border: `1px solid ${D.border}`,
                  borderRadius: 10,
                }}
              >
                {" "}
                <Select
                  value={filterLocation}
                  onChange={setFilterLocation}
                  options={locationOptions}
                />{" "}
                <Select
                  value={filterRating}
                  onChange={setFilterRating}
                  options={ratingOptions}
                />{" "}
                <Select
                  value={filterResponded}
                  onChange={setFilterResponded}
                  options={respondedOptions}
                />{" "}
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search reviews..."
                  style={{
                    padding: "8px 12px",
                    background: D.bg,
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    color: D.text,
                    fontSize: 13,
                    fontFamily: "Roboto, Arial, sans-serif",
                    outline: "none",
                    flex: "1 1 180px",
                    minWidth: 160,
                  }}
                />{" "}
                <span
                  style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 12,
                    color: D.muted,
                  }}
                >
                  {filtered.length} review{filtered.length !== 1 ? "s" : ""}
                </span>{" "}
              </div>
              {/* Reviews feed */}
              {filtered.length === 0 ? (
                <div
                  style={{
                    padding: 48,
                    textAlign: "center",
                    color: D.muted,
                    fontFamily: "Roboto, Arial, sans-serif",
                    background: D.card,
                    borderRadius: 12,
                    border: `1px solid ${D.border}`,
                  }}
                >
                  {" "}
                  <Star
                    size={32}
                    color={D.muted}
                    style={{ marginBottom: 12 }}
                  />{" "}
                  <div style={{ fontSize: 15 }}>
                    No reviews match your filters
                  </div>{" "}
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    Try adjusting your search or filter criteria
                  </div>{" "}
                </div>
              ) : (
                filtered.map((r) => (
                  <ReviewCard
                    key={r.id}
                    review={r}
                    onReplySubmit={handleReply}
                    onDismiss={handleDismiss}
                  />
                ))
              )}
            </>
          )}
        </div>
      )}
      {/* ====================== TAB: REVIEW OUTREACH ====================== */}
      {activeTab === "gbp" && <GBPManagementPanel />}
      {activeTab === "outreach" && <ReviewVelocityEngine />}
      {activeTab === "incentives" && <ReviewIncentivesPanel />}
    </div>
  );
}
