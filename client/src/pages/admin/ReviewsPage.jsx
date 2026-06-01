import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
      <span style={{ color: D.amber, fontSize: 12 }}>Star</span>{" "}
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
          <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            <StatCard
              label="Earned"
              value={money(summary.earnedCents)}
              sub={`${summary.payoutCount || 0} confirmed reviews`}
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
              sub="missing customer or technician match"
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
                No unmatched Google reviews in this period.
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
                        {p.status}
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

// REVIEW OUTREACH HELPERS
// =============================================================================

// =============================================================================
// REVIEW OUTREACH — database-backed
// =============================================================================
function ReviewOutreach() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState({});

  useEffect(() => {
    // Fetch customers with recent completed services who haven't left a review
    adminFetch("/admin/reviews/outreach-candidates")
      .then((d) => {
        setCustomers(d.customers || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = customers.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (c.name || "").toLowerCase().includes(q) ||
      (c.city || "").toLowerCase().includes(q) ||
      (c.phone || "").toLowerCase().includes(q)
    );
  });

  const sendReviewRequest = async (customer) => {
    setSending((prev) => ({ ...prev, [customer.id]: true }));
    try {
      await adminFetch("/admin/reviews/send-request", {
        method: "POST",
        body: JSON.stringify({ customerId: customer.id }),
      });
      setCustomers((prev) =>
        prev.map((c) =>
          c.id === customer.id ? { ...c, requestSent: true } : c,
        ),
      );
    } catch (e) {
      alert("Failed: " + e.message);
    } finally {
      setSending((prev) => ({ ...prev, [customer.id]: false }));
    }
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 60, textAlign: "center" }}>
        Loading outreach candidates...
      </div>
    );

  return (
    <div>
      {" "}
      <div
        style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}
      >
        {" "}
        <StatCard
          label="Outreach Candidates"
          value={customers.length}
          color={D.teal}
        />{" "}
        <StatCard
          label="Review Requests Sent"
          value={customers.filter((c) => c.requestSent).length}
          color={D.green}
        />{" "}
      </div>{" "}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name, city, or phone..."
        style={{
          width: "100%",
          padding: "10px 14px",
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 8,
          color: D.text,
          fontSize: 13,
          fontFamily: "Roboto, Arial, sans-serif",
          outline: "none",
          boxSizing: "border-box",
          marginBottom: 16,
        }}
      />
      {filtered.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: "center",
            color: D.muted,
            background: D.card,
            borderRadius: 12,
            border: `1px solid ${D.border}`,
          }}
        >
          {" "}
          <div style={{ fontSize: 15 }}>No outreach candidates found</div>{" "}
          <div style={{ fontSize: 13, marginTop: 4 }}>
            Customers with recent completed services who haven't been asked for
            a review will appear here.
          </div>{" "}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map((c) => (
            <div
              key={c.id}
              style={{
                background: D.card,
                border: `1px solid ${D.border}`,
                borderRadius: 10,
                padding: "14px 18px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              {" "}
              <div>
                {" "}
                <div
                  style={{ fontSize: 15, fontWeight: 600, color: D.heading }}
                >
                  {c.name}
                </div>{" "}
                <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                  {c.city && <span>{c.city} </span>}
                  {c.phone && <span>· {c.phone} </span>}
                  {c.lastService && (
                    <span>· Last service: {c.lastService} </span>
                  )}
                  {c.lastServiceDate && (
                    <span>
                      · {new Date(c.lastServiceDate).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {c.tier && (
                  <span
                    style={{
                      fontSize: 10,
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: `${D.teal}22`,
                      color: D.teal,
                      marginTop: 4,
                      display: "inline-block",
                    }}
                  >
                    {c.tier}
                  </span>
                )}
              </div>{" "}
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {c.requestSent ? (
                  <span
                    style={{ fontSize: 12, color: D.green, fontWeight: 600 }}
                  >
                    Sent
                  </span>
                ) : (
                  <button
                    onClick={() => sendReviewRequest(c)}
                    disabled={sending[c.id]}
                    style={{
                      padding: "8px 16px",
                      background: D.teal,
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      opacity: sending[c.id] ? 0.5 : 1,
                    }}
                  >
                    {sending[c.id] ? "Sending..." : "Send Review Request"}
                  </button>
                )}
              </div>{" "}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Legacy — removed Google Sheets dependency
function getReviewMessage(sentiment, firstName) {
  if (sentiment === "happy") {
    return `Hey ${firstName}! This is Adam with Waves Pest Control \u{1F30A} Thanks for being a great customer \u2014 it means the world to our small family business.\n\nIf you have 30 seconds, a quick Google review would help us more than you know:\n\nhttps://g.page/r/CRkzS6M4EpncEBE/review\n\nThank you! \u{1F64F}`;
  }
  if (sentiment === "issue") {
    return `Hi ${firstName}, this is Adam with Waves. I wanted to follow up and make sure everything's been taken care of. Your satisfaction is our top priority.\n\nPlease let me know if there's anything else we can do. \u2014 Waves \u{1F30A}`;
  }
  return `Hi ${firstName}! Adam here with Waves Pest Control \u{1F30A} Just checking in \u2014 hope everything's been great since our last visit.\n\nIf you've been happy with the service, a quick Google review would really help us out:\n\nhttps://g.page/r/CRkzS6M4EpncEBE/review\n\nThanks so much!`;
}

// (Old Google Sheets outreach was here — replaced by database version above)
function _PLACEHOLDER_REMOVED() {
  const [jobs, setJobs] = useState([]);
  const [smsRecords, setSmsRecords] = useState([]);
  const [callRecords, setCallRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [detailTab, setDetailTab] = useState("history");
  const [composeText, setComposeText] = useState("");
  const [localSms, setLocalSms] = useState([]);
  const [callModal, setCallModal] = useState(false);
  const smsEndRef = useRef(null);

  // Fetch all three sheets
  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(sheetURL("TECH KPIS")).then((r) => r.text()),
      fetch(sheetURL("SMS RECORDINGS")).then((r) => r.text()),
      fetch(sheetURL("CALL RECORDINGS")).then((r) => r.text()),
    ])
      .then(([kpiText, smsText, callText]) => {
        const kpiRows = parseCSV(kpiText);
        const smsRows = parseCSV(smsText);
        const callRows = parseCSV(callText);

        // Parse jobs (skip header)
        const parsedJobs = kpiRows
          .slice(1)
          .filter((r) => r.length > 5 && r[KPI_COLS.CustName]?.trim())
          .map((r) => ({
            date: r[KPI_COLS.Date]?.trim(),
            parsedDate: parseDate(r[KPI_COLS.Date]?.trim()),
            techName: r[KPI_COLS.TechName]?.trim(),
            svcType: r[KPI_COLS.SvcType]?.trim(),
            custName: r[KPI_COLS.CustName]?.trim(),
            custAddr: r[KPI_COLS.CustAddr]?.trim(),
            custEmail: r[KPI_COLS.CustEmail]?.trim(),
            apptStart: r[KPI_COLS.ApptStart]?.trim(),
            apptEnd: r[KPI_COLS.ApptEnd]?.trim(),
            laborHrs: r[KPI_COLS.LaborHrs]?.trim(),
            laborCost: r[KPI_COLS.LaborCost]?.trim(),
            matCost: r[KPI_COLS.MatCost]?.trim(),
            totalJobCost: r[KPI_COLS.TotalJobCost]?.trim(),
            revenue: r[KPI_COLS.Revenue]?.trim(),
            gp: r[KPI_COLS["GP$"]]?.trim(),
            gpPct: r[KPI_COLS["GP%"]]?.trim(),
            rpmh: r[KPI_COLS.RPMH]?.trim(),
            invoiceURL: r[KPI_COLS.InvoiceURL]?.trim(),
            svcPerformed: r[KPI_COLS.SvcPerformed]?.trim(),
            svcCallNotes: r[KPI_COLS.SvcCallNotes]?.trim(),
            custID: r[KPI_COLS.CustID]?.trim(),
            apptID: r[KPI_COLS.ApptID]?.trim(),
          }));

        // Parse SMS (header row then data)
        const smsHeader = smsRows[0] || [];
        const parsedSms = smsRows
          .slice(1)
          .filter((r) => r.length > 2)
          .map((r) => {
            const obj = {};
            smsHeader.forEach((h, i) => {
              obj[h.trim()] = (r[i] || "").trim();
            });
            return obj;
          });

        // Parse calls (header row then data)
        const callHeader = callRows[0] || [];
        const parsedCalls = callRows
          .slice(1)
          .filter((r) => r.length > 2)
          .map((r) => {
            const obj = {};
            callHeader.forEach((h, i) => {
              obj[h.trim()] = (r[i] || "").trim();
            });
            return obj;
          });

        setJobs(parsedJobs);
        setSmsRecords(parsedSms);
        setCallRecords(parsedCalls);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  // Group jobs by customer
  const customers = useMemo(() => {
    const map = {};
    jobs.forEach((j) => {
      const key = j.custName;
      if (!key) return;
      if (!map[key]) {
        map[key] = {
          name: key,
          addr: j.custAddr,
          email: j.custEmail,
          jobs: [],
        };
      }
      map[key].jobs.push(j);
      if (j.custAddr && !map[key].addr) map[key].addr = j.custAddr;
      if (j.custEmail && !map[key].email) map[key].email = j.custEmail;
    });
    // Sort jobs within each customer by date desc
    Object.values(map).forEach((c) => {
      c.jobs.sort((a, b) => (b.parsedDate || 0) - (a.parsedDate || 0));
      c.lastDate = c.jobs[0]?.parsedDate;
      c.lastSvcType = c.jobs[0]?.svcType;
      c.totalRevenue = c.jobs.reduce(
        (s, j) => s + (parseFloat(j.revenue?.replace(/[$,]/g, "")) || 0),
        0,
      );
    });
    // Sort customers by most recent service
    return Object.values(map).sort(
      (a, b) => (b.lastDate || 0) - (a.lastDate || 0),
    );
  }, [jobs]);

  // Match SMS/calls to customer by name
  const getCustomerSms = useCallback(
    (custName) => {
      const lower = custName.toLowerCase();
      return smsRecords.filter((s) => {
        const name = (
          s.CustomerName ||
          s.Name ||
          s.Customer ||
          ""
        ).toLowerCase();
        return name.includes(lower) || lower.includes(name);
      });
    },
    [smsRecords],
  );

  const getCustomerCalls = useCallback(
    (custName) => {
      const lower = custName.toLowerCase();
      return callRecords.filter((c) => {
        const name = (
          c.CustomerName ||
          c.Name ||
          c.Customer ||
          ""
        ).toLowerCase();
        return name.includes(lower) || lower.includes(name);
      });
    },
    [callRecords],
  );

  // Customer SMS/call counts for sidebar cards
  const customerMeta = useMemo(() => {
    const meta = {};
    customers.forEach((c) => {
      meta[c.name] = {
        smsCount: getCustomerSms(c.name).length,
        callCount: getCustomerCalls(c.name).length,
      };
    });
    return meta;
  }, [customers, getCustomerSms, getCustomerCalls]);

  // Search filtering
  const filteredCustomers = useMemo(() => {
    if (!searchQuery.trim()) return customers;
    const q = searchQuery.toLowerCase();
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.addr || "").toLowerCase().includes(q) ||
        (c.lastSvcType || "").toLowerCase().includes(q),
    );
  }, [customers, searchQuery]);

  // Stats
  const totalJobs = jobs.length;
  const uniqueCustomers = customers.length;
  const totalRevenue = jobs.reduce(
    (s, j) => s + (parseFloat(j.revenue?.replace(/[$,]/g, "")) || 0),
    0,
  );

  // Selected customer detail data
  const selSms = selectedCustomer
    ? [
        ...getCustomerSms(selectedCustomer.name),
        ...localSms.filter((ls) => ls.custName === selectedCustomer.name),
      ]
    : [];
  const selCalls = selectedCustomer
    ? getCustomerCalls(selectedCustomer.name)
    : [];
  const selPhone =
    selSms[0]?.Phone ||
    selSms[0]?.PhoneNumber ||
    selCalls[0]?.Phone ||
    selCalls[0]?.PhoneNumber ||
    "";

  // Sentiment + brief
  const sentiment = selectedCustomer
    ? getSentiment(
        selSms.map((s) => s.Message || s.Body || s.Text || ""),
        selCalls.map((c) => c.Transcript || c.Notes || c.Text || ""),
        selectedCustomer.jobs.map((j) => j.svcCallNotes || ""),
      )
    : "neutral";

  const sentimentLabel =
    sentiment === "happy"
      ? { text: "Positive", color: D.green, icon: "" }
      : sentiment === "issue"
        ? { text: "Needs Attention", color: D.red, icon: "" }
        : { text: "Neutral", color: D.amber, icon: "" };

  const handleSendSms = () => {
    if (!composeText.trim() || !selectedCustomer) return;
    console.log(
      "[Review Outreach] Send SMS to",
      selectedCustomer.name,
      ":",
      composeText,
    );
    setLocalSms((prev) => [
      ...prev,
      {
        custName: selectedCustomer.name,
        Date: new Date().toLocaleDateString(),
        Message: composeText,
        Direction: "outbound",
        _local: true,
      },
    ]);
    setComposeText("");
    setTimeout(
      () => smsEndRef.current?.scrollIntoView({ behavior: "smooth" }),
      100,
    );
  };

  const handleSelectCustomer = (c) => {
    setSelectedCustomer(c);
    setDetailTab("history");
    const firstName = c.name.split(" ")[0] || c.name;
    const cSms = getCustomerSms(c.name);
    const cCalls = getCustomerCalls(c.name);
    const cSentiment = getSentiment(
      cSms.map((s) => s.Message || s.Body || s.Text || ""),
      cCalls.map((cl) => cl.Transcript || cl.Notes || cl.Text || ""),
      c.jobs.map((j) => j.svcCallNotes || ""),
    );
    setComposeText(getReviewMessage(cSentiment, firstName));
  };

  if (loading) {
    return (
      <div
        style={{
          color: D.muted,
          padding: 60,
          textAlign: "center",
          fontFamily: "Roboto, Arial, sans-serif",
          fontSize: 15,
        }}
      >
        Loading review outreach data from Google Sheets...
      </div>
    );
  }

  if (error) {
    return (
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
          Failed to load sheet data
        </div>{" "}
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>
          {error}
        </div>{" "}
      </div>
    );
  }

  return (
    <div>
      {/* Stats bar */}
      <div
        style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}
      >
        {" "}
        <StatCard label="Total Jobs" value={totalJobs} color={D.teal} />{" "}
        <StatCard
          label="Unique Customers"
          value={uniqueCustomers}
          color={D.white}
        />{" "}
        <StatCard
          label="Total Revenue"
          value={`$${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          color={D.green}
        />{" "}
      </div>
      {/* Main layout */}
      <div style={{ display: "flex", gap: 16 }}>
        {/* Left sidebar */}
        <div style={{ width: 380, minWidth: 380, flexShrink: 0 }}>
          {" "}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search name, address, service..."
            style={{
              width: "100%",
              padding: "10px 14px",
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              color: D.text,
              fontSize: 13,
              fontFamily: "Roboto, Arial, sans-serif",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: 12,
            }}
          />{" "}
          <div
            style={{
              maxHeight: "calc(100vh - 320px)",
              overflowY: "auto",
              paddingRight: 4,
            }}
          >
            {filteredCustomers.map((c) => {
              const meta = customerMeta[c.name] || {
                smsCount: 0,
                callCount: 0,
              };
              const isSelected = selectedCustomer?.name === c.name;
              return (
                <div
                  key={c.name}
                  onClick={() => handleSelectCustomer(c)}
                  style={{
                    background: isSelected ? "#253347" : D.card,
                    border: `1px solid ${isSelected ? D.teal : D.border}`,
                    borderRadius: 10,
                    padding: "14px 16px",
                    marginBottom: 8,
                    cursor: "pointer",
                    transition: "border-color 0.15s",
                  }}
                >
                  {" "}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                    }}
                  >
                    {" "}
                    <div
                      style={{
                        fontFamily: "Roboto, Arial, sans-serif",
                        fontSize: 14,
                        fontWeight: 600,
                        color: D.heading,
                      }}
                    >
                      {c.name}
                    </div>{" "}
                    <div
                      style={{
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 11,
                        color: D.green,
                      }}
                    >
                      ${c.totalRevenue.toFixed(0)}
                    </div>{" "}
                  </div>
                  {c.addr && (
                    <div
                      style={{
                        fontSize: 12,
                        color: D.muted,
                        fontFamily: "Roboto, Arial, sans-serif",
                        marginTop: 2,
                      }}
                    >
                      {c.addr}
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      marginTop: 6,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    {" "}
                    <span
                      style={{
                        fontSize: 11,
                        color: D.teal,
                        fontFamily: "Roboto, Arial, sans-serif",
                      }}
                    >
                      {c.lastSvcType}
                    </span>{" "}
                    <span
                      style={{
                        fontSize: 11,
                        color: D.muted,
                        fontFamily: "JetBrains Mono, monospace",
                      }}
                    >
                      {c.lastDate ? formatDate(c.lastDate) : ""}
                    </span>
                    {meta.smsCount > 0 && (
                      <span style={{ fontSize: 11, color: D.muted }}>
                        {meta.smsCount}
                      </span>
                    )}
                    {meta.callCount > 0 && (
                      <span style={{ fontSize: 11, color: D.muted }}>
                        {meta.callCount}
                      </span>
                    )}
                  </div>{" "}
                </div>
              );
            })}
            {filteredCustomers.length === 0 && (
              <div
                style={{
                  color: D.muted,
                  textAlign: "center",
                  padding: 32,
                  fontFamily: "Roboto, Arial, sans-serif",
                  fontSize: 13,
                }}
              >
                No customers match your search
              </div>
            )}
          </div>{" "}
        </div>
        {/* Right panel */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!selectedCustomer ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: 400,
                color: D.muted,
                fontFamily: "Roboto, Arial, sans-serif",
                background: D.card,
                borderRadius: 12,
                border: `1px solid ${D.border}`,
              }}
            >
              {" "}
              <div style={{ fontSize: 40, marginBottom: 12 }}></div>{" "}
              <div style={{ fontSize: 15 }}>
                Select a customer to view details
              </div>{" "}
              <div style={{ fontSize: 13, marginTop: 4 }}>
                Click a customer card on the left to get started
              </div>{" "}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Customer header */}
              <div
                style={{
                  background: D.card,
                  border: `1px solid ${D.border}`,
                  borderRadius: 12,
                  padding: "18px 20px",
                }}
              >
                {" "}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  {" "}
                  <div>
                    {" "}
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 700,
                        color: D.heading,
                        fontFamily: "Roboto, Arial, sans-serif",
                      }}
                    >
                      {selectedCustomer.name}
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: D.muted,
                        fontFamily: "Roboto, Arial, sans-serif",
                        marginTop: 2,
                      }}
                    >
                      {selectedCustomer.addr && (
                        <span>{selectedCustomer.addr}</span>
                      )}
                      {selectedCustomer.email && (
                        <span>&middot; {selectedCustomer.email}</span>
                      )}
                      {selPhone && <span>&middot; {selPhone}</span>}
                    </div>{" "}
                  </div>{" "}
                  <div style={{ display: "flex", gap: 8 }}>
                    {" "}
                    <button
                      onClick={() => setCallModal(true)}
                      style={{
                        padding: "8px 16px",
                        background: "transparent",
                        border: `1px solid ${D.border}`,
                        color: D.text,
                        borderRadius: 8,
                        fontSize: 13,
                        fontFamily: "Roboto, Arial, sans-serif",
                        cursor: "pointer",
                      }}
                    >
                      Call via Twilio
                    </button>{" "}
                    <button
                      onClick={() => {
                        setDetailTab("sms");
                        setTimeout(
                          () =>
                            smsEndRef.current?.scrollIntoView({
                              behavior: "smooth",
                            }),
                          200,
                        );
                      }}
                      style={{
                        padding: "8px 16px",
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
                      Send Review SMS
                    </button>{" "}
                  </div>{" "}
                </div>{" "}
              </div>
              {/* AI Call Prep Brief */}
              <div
                style={{
                  background: D.card,
                  borderRadius: 12,
                  padding: "18px 20px",
                  border: "1px solid transparent",
                  backgroundImage: `linear-gradient(${D.card}, ${D.card}), linear-gradient(135deg, ${D.teal}44, ${D.teal}11)`,
                  backgroundOrigin: "border-box",
                  backgroundClip: "padding-box, border-box",
                }}
              >
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: D.teal,
                    fontFamily: "Roboto, Arial, sans-serif",
                    marginBottom: 12,
                  }}
                >
                  {"AI"} AI Call Prep Brief
                </div>{" "}
                <div
                  style={{
                    display: "flex",
                    gap: 24,
                    flexWrap: "wrap",
                    marginBottom: 12,
                  }}
                >
                  {" "}
                  <div>
                    {" "}
                    <div
                      style={{
                        fontSize: 11,
                        color: D.muted,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        fontFamily: "Roboto, Arial, sans-serif",
                      }}
                    >
                      Customer
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: D.text,
                        fontFamily: "Roboto, Arial, sans-serif",
                        marginTop: 2,
                      }}
                    >
                      {selectedCustomer.name}
                    </div>{" "}
                  </div>{" "}
                  <div>
                    {" "}
                    <div
                      style={{
                        fontSize: 11,
                        color: D.muted,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        fontFamily: "Roboto, Arial, sans-serif",
                      }}
                    >
                      Jobs
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: D.text,
                        fontFamily: "JetBrains Mono, monospace",
                        marginTop: 2,
                      }}
                    >
                      {selectedCustomer.jobs.length}
                    </div>{" "}
                  </div>{" "}
                  <div>
                    {" "}
                    <div
                      style={{
                        fontSize: 11,
                        color: D.muted,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        fontFamily: "Roboto, Arial, sans-serif",
                      }}
                    >
                      Revenue
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: D.green,
                        fontFamily: "JetBrains Mono, monospace",
                        marginTop: 2,
                      }}
                    >
                      ${selectedCustomer.totalRevenue.toFixed(0)}
                    </div>{" "}
                  </div>{" "}
                  <div>
                    {" "}
                    <div
                      style={{
                        fontSize: 11,
                        color: D.muted,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        fontFamily: "Roboto, Arial, sans-serif",
                      }}
                    >
                      Last Service
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: D.text,
                        fontFamily: "Roboto, Arial, sans-serif",
                        marginTop: 2,
                      }}
                    >
                      {selectedCustomer.lastSvcType} &middot;{" "}
                      {selectedCustomer.lastDate
                        ? formatDate(selectedCustomer.lastDate)
                        : "N/A"}
                    </div>{" "}
                  </div>{" "}
                  <div>
                    {" "}
                    <div
                      style={{
                        fontSize: 11,
                        color: D.muted,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        fontFamily: "Roboto, Arial, sans-serif",
                      }}
                    >
                      Sentiment
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 13,
                        color: sentimentLabel.color,
                        fontFamily: "Roboto, Arial, sans-serif",
                        marginTop: 2,
                      }}
                    >
                      {sentimentLabel.icon} {sentimentLabel.text}
                    </div>{" "}
                  </div>{" "}
                </div>{" "}
                <div
                  style={{
                    fontSize: 12,
                    color: D.muted,
                    fontFamily: "Roboto, Arial, sans-serif",
                    lineHeight: 1.5,
                  }}
                >
                  {sentiment === "happy" &&
                    `${selectedCustomer.name.split(" ")[0]} has shown positive sentiment in past communications. Great candidate for a review request.`}
                  {sentiment === "issue" &&
                    `${selectedCustomer.name.split(" ")[0]} may have had service concerns. Consider addressing any issues before requesting a review.`}
                  {sentiment === "neutral" &&
                    `No strong sentiment detected for ${selectedCustomer.name.split(" ")[0]}. A friendly check-in with a review request is appropriate.`}
                </div>{" "}
              </div>
              {/* Detail tabs */}
              <div
                style={{
                  display: "flex",
                  gap: 0,
                  borderBottom: `1px solid ${D.border}`,
                  marginBottom: 0,
                }}
              >
                {["history", "sms", "calls"].map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setDetailTab(tab)}
                    style={{
                      padding: "10px 20px",
                      background: "transparent",
                      border: "none",
                      borderBottom:
                        detailTab === tab
                          ? `2px solid ${D.teal}`
                          : "2px solid transparent",
                      color: detailTab === tab ? D.teal : D.muted,
                      fontSize: 13,
                      fontFamily: "Roboto, Arial, sans-serif",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {tab === "history"
                      ? "Service History"
                      : tab === "sms"
                        ? `SMS Thread (${selSms.length})`
                        : `Call Recordings (${selCalls.length})`}
                  </button>
                ))}
              </div>
              {/* Tab content */}
              <div
                style={{
                  background: D.card,
                  border: `1px solid ${D.border}`,
                  borderRadius: 12,
                  padding: 0,
                  maxHeight: "calc(100vh - 580px)",
                  overflowY: "auto",
                }}
              >
                {detailTab === "history" && (
                  <div style={{ padding: 16 }}>
                    {selectedCustomer.jobs.map((j, i) => (
                      <div
                        key={i}
                        style={{
                          padding: "12px 0",
                          borderBottom:
                            i < selectedCustomer.jobs.length - 1
                              ? `1px solid ${D.border}`
                              : "none",
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            flexWrap: "wrap",
                            gap: 8,
                          }}
                        >
                          {" "}
                          <div>
                            {" "}
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: D.heading,
                                fontFamily: "Roboto, Arial, sans-serif",
                              }}
                            >
                              {j.svcType}
                            </span>{" "}
                            <span
                              style={{
                                fontSize: 12,
                                color: D.muted,
                                fontFamily: "JetBrains Mono, monospace",
                                marginLeft: 10,
                              }}
                            >
                              {j.parsedDate ? formatDate(j.parsedDate) : j.date}
                            </span>{" "}
                          </div>{" "}
                          <div style={{ display: "flex", gap: 12 }}>
                            {" "}
                            <span
                              style={{
                                fontSize: 12,
                                color: D.muted,
                                fontFamily: "Roboto, Arial, sans-serif",
                              }}
                            >
                              Tech: {j.techName}
                            </span>{" "}
                            <span
                              style={{
                                fontSize: 12,
                                color: D.green,
                                fontFamily: "JetBrains Mono, monospace",
                              }}
                            >
                              $
                              {parseFloat(
                                j.revenue?.replace(/[$,]/g, "") || 0,
                              ).toFixed(0)}
                            </span>
                            {j.gpPct && (
                              <span
                                style={{
                                  fontSize: 12,
                                  color: D.amber,
                                  fontFamily: "JetBrains Mono, monospace",
                                }}
                              >
                                {j.gpPct} margin
                              </span>
                            )}
                          </div>{" "}
                        </div>
                        {j.svcPerformed && (
                          <div
                            style={{
                              fontSize: 12,
                              color: D.text,
                              fontFamily: "Roboto, Arial, sans-serif",
                              marginTop: 4,
                              lineHeight: 1.4,
                            }}
                          >
                            {j.svcPerformed}
                          </div>
                        )}
                        {j.svcCallNotes && (
                          <div
                            style={{
                              fontSize: 12,
                              color: D.muted,
                              fontFamily: "Roboto, Arial, sans-serif",
                              marginTop: 2,
                              fontStyle: "italic",
                            }}
                          >
                            {j.svcCallNotes}
                          </div>
                        )}
                      </div>
                    ))}
                    {selectedCustomer.jobs.length === 0 && (
                      <div
                        style={{
                          color: D.muted,
                          textAlign: "center",
                          padding: 24,
                          fontSize: 13,
                          fontFamily: "Roboto, Arial, sans-serif",
                        }}
                      >
                        No service history found
                      </div>
                    )}
                  </div>
                )}

                {detailTab === "sms" && (
                  <div
                    style={{
                      padding: 16,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {selSms.length === 0 && (
                      <div
                        style={{
                          color: D.muted,
                          textAlign: "center",
                          padding: 24,
                          fontSize: 13,
                          fontFamily: "Roboto, Arial, sans-serif",
                        }}
                      >
                        No SMS records found
                      </div>
                    )}
                    {selSms.map((s, i) => {
                      const isOutbound =
                        (s.Direction || "")
                          .toLowerCase()
                          .includes("outbound") ||
                        (s.Direction || "").toLowerCase().includes("out") ||
                        s._local;
                      const msg = s.Message || s.Body || s.Text || "";
                      return (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            justifyContent: isOutbound
                              ? "flex-end"
                              : "flex-start",
                          }}
                        >
                          {" "}
                          <div
                            style={{
                              maxWidth: "75%",
                              padding: "10px 14px",
                              borderRadius: 12,
                              background: isOutbound
                                ? "linear-gradient(135deg, #0ea5e9, #0284c7)"
                                : D.bg,
                              border: isOutbound
                                ? "none"
                                : `1px solid ${D.border}`,
                              color: D.text,
                              fontSize: 13,
                              fontFamily: "Roboto, Arial, sans-serif",
                              lineHeight: 1.5,
                            }}
                          >
                            {" "}
                            <div style={{ whiteSpace: "pre-wrap" }}>
                              {msg}
                            </div>{" "}
                            <div
                              style={{
                                fontSize: 10,
                                color: isOutbound
                                  ? "rgba(255,255,255,0.6)"
                                  : D.muted,
                                marginTop: 4,
                                fontFamily: "JetBrains Mono, monospace",
                              }}
                            >
                              {s.Date || s.Timestamp || ""}
                              {s._local && " (pending)"}
                            </div>{" "}
                          </div>{" "}
                        </div>
                      );
                    })}
                    <div ref={smsEndRef} />{" "}
                  </div>
                )}

                {detailTab === "calls" && (
                  <div style={{ padding: 16 }}>
                    {selCalls.length === 0 && (
                      <div
                        style={{
                          color: D.muted,
                          textAlign: "center",
                          padding: 24,
                          fontSize: 13,
                          fontFamily: "Roboto, Arial, sans-serif",
                        }}
                      >
                        No call recordings found
                      </div>
                    )}
                    {selCalls.map((c, i) => (
                      <div
                        key={i}
                        style={{
                          padding: "12px 0",
                          borderBottom:
                            i < selCalls.length - 1
                              ? `1px solid ${D.border}`
                              : "none",
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            marginBottom: 4,
                          }}
                        >
                          {" "}
                          <span
                            style={{
                              fontSize: 12,
                              color: D.muted,
                              fontFamily: "JetBrains Mono, monospace",
                            }}
                          >
                            {c.Date || c.Timestamp || ""}
                          </span>{" "}
                          <span
                            style={{
                              fontSize: 12,
                              color: D.muted,
                              fontFamily: "Roboto, Arial, sans-serif",
                            }}
                          >
                            {c.Duration || ""}
                          </span>{" "}
                        </div>
                        {(c.Transcript || c.Text || c.Notes) && (
                          <div
                            style={{
                              fontSize: 13,
                              color: D.text,
                              fontFamily: "Roboto, Arial, sans-serif",
                              lineHeight: 1.5,
                              marginTop: 4,
                            }}
                          >
                            {c.Transcript || c.Text || c.Notes}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Compose bar */}
              <div
                style={{
                  background: D.card,
                  border: `1px solid ${D.border}`,
                  borderRadius: 12,
                  padding: 16,
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-end",
                }}
              >
                {" "}
                <textarea
                  value={composeText}
                  onChange={(e) => setComposeText(e.target.value)}
                  placeholder="Type review request SMS..."
                  rows={3}
                  style={{
                    flex: 1,
                    padding: 12,
                    background: D.bg,
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    color: D.text,
                    fontSize: 13,
                    fontFamily: "Roboto, Arial, sans-serif",
                    resize: "vertical",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />{" "}
                <button
                  onClick={handleSendSms}
                  disabled={!composeText.trim()}
                  style={{
                    padding: "12px 24px",
                    background: D.teal,
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    fontSize: 14,
                    fontFamily: "Roboto, Arial, sans-serif",
                    fontWeight: 600,
                    cursor: composeText.trim() ? "pointer" : "not-allowed",
                    opacity: composeText.trim() ? 1 : 0.5,
                    whiteSpace: "nowrap",
                  }}
                >
                  Send {"\u2192"}
                </button>{" "}
              </div>{" "}
            </div>
          )}
        </div>{" "}
      </div>
      {/* Call modal */}
      {callModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={() => setCallModal(false)}
        >
          {" "}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 16,
              padding: "32px 40px",
              textAlign: "center",
              maxWidth: 400,
            }}
          >
            {" "}
            <div style={{ fontSize: 48, marginBottom: 16 }}></div>{" "}
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: D.heading,
                fontFamily: "Roboto, Arial, sans-serif",
                marginBottom: 8,
              }}
            >
              Initiating Call via Twilio
            </div>{" "}
            <div
              style={{
                fontSize: 14,
                color: D.muted,
                fontFamily: "Roboto, Arial, sans-serif",
                marginBottom: 4,
              }}
            >
              Calling {selectedCustomer?.name}
            </div>
            {selPhone && (
              <div
                style={{
                  fontSize: 13,
                  color: D.teal,
                  fontFamily: "JetBrains Mono, monospace",
                  marginBottom: 20,
                }}
              >
                {selPhone}
              </div>
            )}
            <div
              style={{
                fontSize: 12,
                color: D.muted,
                fontFamily: "Roboto, Arial, sans-serif",
                marginBottom: 20,
              }}
            >
              Twilio integration coming soon. This is a placeholder.
            </div>{" "}
            <button
              onClick={() => setCallModal(false)}
              style={{
                padding: "10px 28px",
                background: D.teal,
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontSize: 14,
                fontFamily: "Roboto, Arial, sans-serif",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Close
            </button>{" "}
          </div>{" "}
        </div>
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
  const reviewSections = [
    { key: "reviews", label: "Reviews", Icon: Star },
    { key: "gbp", label: "GBP Management", Icon: Building2 },
    { key: "outreach", label: "Review Outreach", Icon: Send },
    { key: "incentives", label: "Incentives", Icon: Award },
  ];
  const fallbackLocations = locations.filter(
    (l) => l.reviewsSource && l.reviewsSource !== "gbp",
  );

  return (
    <div>
      {" "}
      <AdminCommandHeader
        title="Reviews"
        icon={Star}
        sections={reviewSections}
        activeKey={activeTab}
        onSectionChange={setActiveTab}
        ariaLabel="Reviews section"
        navGridClassName="grid-cols-1 md:grid-cols-4"
      />
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
                    breakdown={locationBreakdown[loc.id] || breakdown}
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
                  <div style={{ fontSize: 32, marginBottom: 12 }}>
                    Star
                  </div>{" "}
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
