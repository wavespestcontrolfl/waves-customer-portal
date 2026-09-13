import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Award,
  Building2,
  CheckCircle2,
  Download,
  RefreshCw,
  Search,
  Send,
  Star,
  UserCheck,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  Badge,
  Button,
  buttonStyles,
  Card,
  Input,
  Select as UiSelect,
  Textarea,
  UiSurface,
} from "../../components/ui";
import ReviewVelocityEngine from "./ReviewVelocityEngine";
import GBPManagementPanel from "./GBPManagement";
const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Flat leaf sections (one per content tab). `activeTab` holds a LEAF key, so
// every {activeTab === "..."} render block below is unchanged.
const REVIEWS_LEAF_SECTIONS = [
  {
    key: "reviews",
    label: "Reviews",
    Icon: Star,
  },
  {
    key: "gbp",
    label: "GBP Management",
    Icon: Building2,
  },
  {
    key: "outreach",
    label: "Review Outreach",
    Icon: Send,
  },
  {
    key: "incentives",
    label: "Incentives",
    Icon: Award,
  },
];

// The flat leaf bar is grouped into parent sections, each revealing its leaf
// tabs in a sub-row. The primary "reviews" group stays first.
const REVIEWS_TAB_GROUPS = [
  {
    key: "reviews",
    label: "Reviews",
    Icon: Star,
    tabs: ["reviews"],
  },
  {
    key: "outreach",
    label: "Outreach",
    Icon: Send,
    tabs: ["outreach", "incentives"],
  },
  {
    key: "gbp",
    label: "GBP",
    Icon: Building2,
    tabs: ["gbp"],
  },
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
          r.ok
            ? "Unexpected non-JSON response from server"
            : `HTTP ${r.status}`,
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
    <span className="inline-flex items-center gap-[2px]">
      {Array.from(
        {
          length: 5,
        },
        (_, i) => (
          <Star
            key={i}
            size={size}
            className={
              i < count ? "fill-current text-warn-fg" : "text-zinc-300"
            }
            strokeWidth={1.8}
          />
        ),
      )}
    </span>
  );
}

// --- Stat Card ---
function StatCard({ label, value, sub, color }) {
  return (
    <Card className="min-w-[150px] flex-1 p-5">
      {" "}
      <div className="text-ink-secondary text-ui-body mb-[8px]">
        {label}
      </div>{" "}
      <div className={`text-[28px] font-medium${color ? ` ${color}` : ""}`}>
        {value}
      </div>
      {sub && (
        <div className="text-ink-secondary text-ui-body mt-[4px]">{sub}</div>
      )}
    </Card>
  );
}

// --- Star Breakdown Bar ---
function BreakdownBar({ star, count, max }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex items-center gap-[8px] mb-[4px]">
      {" "}
      <span className="text-ui-body text-ink-secondary w-[16px] text-right">
        {star}
      </span>{" "}
      <Star size={14} className="fill-current text-warn-fg" />{" "}
      <progress
        className="h-2 flex-1 accent-zinc-900"
        value={pct}
        max="100"
        aria-label={`${star} star reviews`}
      />{" "}
      <span className="text-ui-body text-ink-secondary w-[24px] text-right">
        {count}
      </span>{" "}
    </div>
  );
}

// --- Location Card ---
function LocationCard({ loc, breakdown, onRequestReview }) {
  const maxCount = breakdown ? Math.max(...Object.values(breakdown), 1) : 1;
  return (
    <Card className="w-full p-5 sm:max-w-[300px]">
      {" "}
      <div className="text-ui-body font-medium text-zinc-900 mb-[4px]">
        {loc.name}
      </div>{" "}
      <div className="flex items-center gap-[8px] mb-[12px]">
        {" "}
        <span className="text-[20px] font-medium text-zinc-900">
          {loc.avgRating}
        </span>{" "}
        <Stars count={Math.round(Number(loc.avgRating))} size={14} />{" "}
        <span className="text-ui-body text-ink-secondary">
          ({loc.count})
        </span>{" "}
      </div>{" "}
      <div className="mb-[16px]">
        {[5, 4, 3, 2, 1].map((s) => (
          <BreakdownBar
            key={s}
            star={s}
            count={breakdown?.[String(s)] || 0}
            max={maxCount}
          />
        ))}
      </div>{" "}
      <div className="flex gap-[8px]">
        {" "}
        <Button
          onClick={() => onRequestReview(loc)}
          variant="primary"
          className="flex-[1]"
        >
          Request Review
        </Button>
        {loc.reviewUrl && (
          <a
            href={loc.reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonStyles({
              variant: "secondary",
              density: "comfortable",
            })}
          >
            Google
          </a>
        )}
      </div>{" "}
    </Card>
  );
}

// --- Auto-reply pipeline chip (review.autoReply from the list API) ---
function autoReplyLabel(a) {
  switch (a.status) {
    case "queued":
      return "Auto-reply queued";
    case "drafted":
      return "Shadow draft";
    case "posted":
      return "Auto-replied";
    case "parked":
      return a.reason === "low_rating"
        ? "Needs you (low rating)"
        : a.reason === "unrated"
          ? "Needs you (unrated)"
          : a.reason === "low_rating_requested"
            ? "Needs you (low rating — draft you asked for)"
            : a.reason === "unrated_requested"
              ? "Needs you (unrated — draft you asked for)"
              : a.reason === "below_threshold"
                ? "Needs you (below auto-post threshold)"
                : a.reason === "agent_ops_draft"
                  ? "Needs you (Agent Ops draft — Post now re-checks it)"
                  : "Needs you";
    case "failed":
      return "Auto-reply retrying";
    case "skipped":
      return "Auto-reply skipped";
    case "retracted":
      return "Reply retracted";
    default:
      return `Auto-reply: ${a.status}`;
  }
}
// Mapping onto the kit's 4 Badge tones (neutral | strong | warn | alert).
// Main distinguished 7 statuses by color; "posted" (done) gets strong,
// "parked" (routine — needs staff review, not an error: low rating,
// unrated, below threshold, or an Agent Ops draft) gets warn, "failed" (a
// genuine send failure, currently retrying) gets alert, everything else
// stays neutral.
function autoReplyTone(a) {
  if (a.status === "posted") return "strong";
  if (a.status === "parked") return "warn";
  if (a.status === "failed") return "alert";
  return "neutral";
}
function autoReplyTitle(a) {
  const bits = [];
  if (a.reason) bits.push(`reason: ${a.reason.replace(/_/g, " ")}`);
  if (a.mode) bits.push(`mode: ${a.mode.replace(/_/g, " ")}`);
  if (a.dueAt && a.status === "queued")
    bits.push(
      `due ${new Date(a.dueAt).toLocaleString("en-US", {
        timeZone: "America/New_York",
      })} ET`,
    );
  if (a.publishedAt)
    bits.push(
      `posted ${new Date(a.publishedAt).toLocaleString("en-US", {
        timeZone: "America/New_York",
      })} ET`,
    );
  return bits.join(" · ") || "Automatic reply pipeline";
}

// --- Review Card ---
function ReviewCard({ review, onReplySubmit, onDismiss, onAutoReplyAction }) {
  const [autoBusy, setAutoBusy] = useState(false);
  const autoReply = review.autoReply || null;
  const runAuto = async (action) => {
    if (!onAutoReplyAction) return;
    if (action === "retract" && !window.confirm("Delete this reply on Google?"))
      return;
    setAutoBusy(true);
    try {
      // Post now is bound to the draft this card displayed (null = none):
      // the server refuses if a different draft is on the row by then.
      await onAutoReplyAction(
        review.id,
        action,
        action === "post-now"
          ? {
              expectedDraft:
                review.draftReply || (autoReply && autoReply.draft) || null,
            }
          : undefined,
      );
      if (action === "retract") {
        setReplyText("");
        setEditing(false);
      }
    } catch (e) {
      alert(
        `${action === "retract" ? "Retract" : action === "post-now" ? "Post now" : "Skip"} failed: ${e.message}`,
      );
    } finally {
      setAutoBusy(false);
    }
  };
  const [editing, setEditing] = useState(false);
  const [replyText, setReplyText] = useState(review.reply || "");
  // Set by "Use Draft": the pipeline draft's identity, sent with the reply so
  // the server can refuse a draft the sync invalidated after it was loaded.
  const [draftToken, setDraftToken] = useState(null);
  // Set by "AI Reply": binds the generated text to the review + account facts
  // it was grounded on (validated at publish time).
  const [groundingToken, setGroundingToken] = useState(null);
  // The card keeps its key across reloads; when the live reply changes
  // underneath it (retract, sync, Google-side edit) the editor must follow,
  // or a retracted reply could be re-posted from stale editor text.
  // The draft slot this editor session observed (sent as expectedDraft). A
  // reload that changes the saved draft resets the editor too, so the
  // observed value can never drift from what the editor was seeded with.
  const [observedDraft, setObservedDraft] = useState(review.draftReply || null);
  useEffect(() => {
    setReplyText(review.reply || "");
    setEditing(false);
    setDraftToken(null);
    setGroundingToken(null);
    setObservedDraft(review.draftReply || null);
  }, [review.reply, review.draftReply, review.reviewToken]);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const handleSubmit = async () => {
    if (!replyText.trim()) return;
    setSubmitting(true);
    try {
      await onReplySubmit(review.id, replyText.trim(), {
        draftToken,
        groundingToken,
        expectedReply: review.reply || null,
        expectedDraft: observedDraft,
        expectedReview: review.reviewToken || null,
      });
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
        setGroundingToken(data.groundingToken || null);
        setDraftToken(null);
        setEditing(true);
      }
    } catch (e) {
      alert("AI reply failed: " + e.message);
    } finally {
      setAiLoading(false);
    }
  };
  const LOCATION_LABELS = {
    bradenton: "Lakewood Ranch",
    parrish: "Parrish",
    sarasota: "Sarasota",
    venice: "Venice",
  };
  return (
    <Card id={`review-${review.id}`} className="p-[20px] mb-[12px]">
      {/* Header */}
      <div className="flex justify-between items-start mb-[8px] flex-wrap gap-[8px]">
        {" "}
        <div className="flex items-center gap-[10px]">
          {review.reviewerPhoto ? (
            <img
              src={review.reviewerPhoto}
              alt=""
              className="w-[36px] h-[36px] rounded-sm"
            />
          ) : (
            <div className="w-[36px] h-[36px] rounded-sm flex items-center justify-center text-ui-body font-medium text-ink-secondary">
              {(review.reviewerName || "?")[0]}
            </div>
          )}
          <div>
            {" "}
            <div className="text-ui-body font-medium text-zinc-900">
              {review.reviewerName}
            </div>{" "}
            <div className="flex items-center gap-[8px] mt-[2px]">
              {" "}
              <Stars count={review.starRating} size={14} />{" "}
              <Badge tone="neutral">
                {LOCATION_LABELS[review.locationId] || review.locationId}
              </Badge>{" "}
              {review.missingSince && (
                <Badge
                  tone="warn"
                  title={`No longer returned by Google as of ${new Date(
                    review.missingSince,
                  ).toLocaleDateString("en-US", {
                    timeZone: "America/New_York",
                  })}. The full text is retained here as evidence for a missing-reviews support case.`}
                >
                  Removed from Google
                </Badge>
              )}{" "}
              {autoReply && !review.missingSince && (
                <Badge
                  title={autoReplyTitle(autoReply)}
                  tone={autoReplyTone(autoReply)}
                >
                  {autoReplyLabel(autoReply)}
                </Badge>
              )}{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
        <div className="text-ui-body text-ink-secondary">
          {timeAgo(review.reviewCreatedAt)}
        </div>{" "}
      </div>
      {/* Review text */}
      {review.reviewText && (
        <div className="text-ui-body text-zinc-900">{review.reviewText}</div>
      )}

      {/* Matched customer */}
      {review.matchedCustomer && (
        <div className="text-ui-body text-zinc-900 mb-[12px]">
          Matched: {review.matchedCustomer.name} — {review.matchedCustomer.tier}
        </div>
      )}

      {/* Reply section */}
      <div className="border-t border-hairline border-zinc-200 pt-[12px] mt-[8px]">
        {review.missingSince && (
          <div className="text-ui-body text-ink-secondary mb-[8px]">
            Removed from Google — replying is disabled. The review is retained
            here as evidence for a missing-reviews support case.
          </div>
        )}
        {!review.missingSince &&
          review.draftReply &&
          !review.reply &&
          !editing && (
            <Card className="p-[10px] mb-[10px]">
              {" "}
              <div className="text-ui-body text-ink-secondary mb-[4px]">
                Saved draft
              </div>{" "}
              <div className="text-ui-body text-zinc-900 whitespace-pre-wrap">
                {review.draftReply}
              </div>{" "}
              {review.draftStale && (
                <div className="mt-[6px] text-ui-body">
                  This draft was written before the reviewer changed the review
                  — read the current review and edit it before posting.
                </div>
              )}
              <Button
                onClick={() => {
                  setReplyText(review.draftReply);
                  setDraftToken(review.draftToken || null);
                  setGroundingToken(null);
                  setEditing(true);
                }}
                variant="secondary"
                className="mt-[8px]"
              >
                Use Draft
              </Button>{" "}
              {autoReply &&
                ["drafted", "parked", "failed", "queued"].includes(
                  autoReply.status,
                ) && (
                  <>
                    <Button
                      onClick={() => runAuto("post-now")}
                      disabled={autoBusy}
                      title="Post this draft to Google now (skips the delay and shadow mode)"
                      variant="primary"
                      className="mt-[8px] ml-[8px]"
                    >
                      {autoBusy ? "Working..." : "Post now"}
                    </Button>{" "}
                    <Button
                      onClick={() => runAuto("skip")}
                      disabled={autoBusy}
                      title="Take this review out of the automatic reply pipeline"
                      variant="secondary"
                      className="mt-[8px] ml-[4px]"
                    >
                      Skip auto
                    </Button>
                  </>
                )}
            </Card>
          )}
        {!review.missingSince &&
          autoReply &&
          (["queued", "failed"].includes(autoReply.status) ||
            (autoReply.status === "parked" &&
              ["google_uncertain", "persist_failed"].includes(
                autoReply.reason,
              ))) &&
          !review.draftReply &&
          !review.reply && (
            <div className="text-ui-body text-ink-secondary mb-[8px]">
              {autoReply.draft && (
                <Card className="p-[10px] mb-[8px] text-zinc-900 whitespace-pre-wrap">
                  <div className="text-ink-secondary mb-[4px]">
                    {autoReply.status === "parked"
                      ? "Auto-reply text attempted (needs reconciling)"
                      : "Auto-reply draft (publish retrying)"}
                  </div>
                  {autoReply.draft}
                </Card>
              )}
              {autoReply.status === "parked"
                ? autoReply.reason === "persist_failed"
                  ? "This reply is LIVE on Google but was not recorded here — confirm it after the next sync, or post / rewrite it."
                  : "Google did not answer in time — this reply MAY be live. Check the review after the next sync, or post / rewrite it."
                : autoReply.status === "failed"
                  ? `Auto-reply retrying${autoReply.reason ? ` (${autoReply.reason.replace(/_/g, " ")})` : ""}${
                      autoReply.dueAt
                        ? `, next attempt ${new Date(
                            autoReply.dueAt,
                          ).toLocaleString("en-US", {
                            timeZone: "America/New_York",
                            hour: "numeric",
                            minute: "2-digit",
                            month: "short",
                            day: "numeric",
                          })} ET`
                        : ""
                    }.`
                  : `Auto-reply scheduled${
                      autoReply.dueAt
                        ? ` for ${new Date(autoReply.dueAt).toLocaleString(
                            "en-US",
                            {
                              timeZone: "America/New_York",
                              hour: "numeric",
                              minute: "2-digit",
                              month: "short",
                              day: "numeric",
                            },
                          )} ET`
                        : ""
                    }.`}{" "}
              <Button
                onClick={() => runAuto("post-now")}
                disabled={autoBusy}
                title="Post to Google now (skips the delay and shadow mode)"
                variant="primary"
              >
                {autoBusy ? "Working..." : "Post now"}
              </Button>{" "}
              ·{" "}
              <Button
                onClick={() => runAuto("skip")}
                disabled={autoBusy}
                variant="secondary"
              >
                Skip auto
              </Button>
            </div>
          )}
        {success && (
          <div className="text-zinc-900 text-ui-body mb-[8px]">
            Reply posted successfully
          </div>
        )}

        {review.reply && !editing ? (
          <div>
            {" "}
            <div className="text-ui-body text-ink-secondary mb-[4px]">
              Your reply{" "}
              {review.replyUpdatedAt && (
                <span>· {timeAgo(review.replyUpdatedAt)}</span>
              )}
            </div>{" "}
            <div className="text-ui-body text-zinc-900 mb-[8px]">
              {review.reply}
            </div>{" "}
            {!review.missingSince && (
              <div className="flex gap-[8px]">
                {" "}
                <Button
                  onClick={() => {
                    // An ordinary manual edit carries no draft identity (codex r55).
                    setDraftToken(null);
                    setGroundingToken(null);
                    setEditing(true);
                    setReplyText(review.reply);
                  }}
                  variant="secondary"
                  className="min-h-[44px]"
                >
                  Edit
                </Button>{" "}
                <Button
                  onClick={handleAiReply}
                  disabled={aiLoading}
                  variant="secondary"
                >
                  {aiLoading ? "Generating..." : "AI Reply"}
                </Button>{" "}
                {autoReply &&
                  (autoReply.status === "posted" ||
                    (autoReply.status === "parked" &&
                      autoReply.reason === "review_edited_after_post")) && (
                    <Button
                      onClick={() => runAuto("retract")}
                      disabled={autoBusy}
                      title="Delete this automatically posted reply on Google"
                      variant="danger"
                    >
                      {autoBusy ? "Working..." : "Retract"}
                    </Button>
                  )}
              </div>
            )}{" "}
          </div>
        ) : !review.missingSince && (editing || !review.reply) ? (
          <div>
            {" "}
            <Textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write your reply..."
              rows={3}
              className="w-full resize-y box-border"
            />{" "}
            <div className="flex gap-[8px] mt-[8px]">
              {" "}
              <Button
                onClick={handleSubmit}
                disabled={submitting || !replyText.trim()}
                variant="primary"
              >
                {submitting
                  ? "Posting..."
                  : review.reply
                    ? "Update Reply"
                    : "Reply"}
              </Button>{" "}
              <Button
                onClick={handleAiReply}
                disabled={aiLoading}
                variant="secondary"
              >
                {aiLoading ? "Generating..." : "AI Reply"}
              </Button>
              {replyText.trim() && (
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(replyText);
                  }}
                  variant="secondary"
                >
                  Copy
                </Button>
              )}
              {editing && (
                <Button
                  onClick={() => {
                    // Cancel discards the draft AND its identity: a later
                    // manual reply on this card must not carry the tokens of
                    // a draft that was thrown away (codex r55).
                    setEditing(false);
                    setReplyText(review.reply || "");
                    setDraftToken(null);
                    setGroundingToken(null);
                  }}
                  variant="secondary"
                >
                  Cancel
                </Button>
              )}
            </div>{" "}
          </div>
        ) : null}
      </div>
      {/* Dismiss — hidden on removed rows: they are retained evidence, the
          Removed filter ignores the flag, and a dismissed+reinstated review
          would vanish from every live view (server 409s stale pages).
          Also hidden on a pipeline-posted reply: it must stay reachable for
          the edited-after-post bell and Retract (server 409s too). */}
      {onDismiss &&
        !review.missingSince &&
        !(
          review.autoReply?.status === "posted" &&
          !["human", "agent_ops"].includes(review.autoReply?.version)
        ) &&
        !(
          review.autoReply?.status === "parked" &&
          review.autoReply?.reason === "review_edited_after_post"
        ) && (
          <div className="text-right mt-[8px]">
            {" "}
            <Button
              onClick={() => onDismiss(review.id)}
              variant="secondary"
              className="opacity-[0.6]"
            >
              Dismiss
            </Button>{" "}
          </div>
        )}
    </Card>
  );
}

// --- Select input ---
function ReviewSelect({ value, onChange, options }) {
  return (
    <UiSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full sm:!w-auto sm:min-w-[170px] bg-white border-hairline border-zinc-200 rounded-md text-zinc-900 text-ui-body cursor-pointer"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </UiSelect>
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
function PolicyInfoCard({ Icon, label, value, sub, color }) {
  return (
    <Card className="p-[14px] grid grid-cols-[20px_minmax(0,1fr)] items-start gap-[10px]">
      <Icon size={18} className={`mt-[1px]${color ? ` ${color}` : ""}`} />
      <div className="min-w-[0px]">
        <div className="text-ui-body font-medium text-ink-secondary mb-[4px]">
          {label}
        </div>
        <div className="text-ui-body font-medium text-zinc-900">{value}</div>
        {sub && (
          <div className="text-ui-body text-ink-secondary mt-[5px]">{sub}</div>
        )}
      </div>
    </Card>
  );
}

// One customer row in the attribution repair panel — used by both the
// click-correlated "likely reviewers" list (with a badge) and the plain
// name/phone/address search results.
function RepairCandidateCard({
  review,
  candidate,
  matching,
  onAttribute,
  badge,
}) {
  return (
    <Card className="p-[10px]">
      <div className="flex items-center gap-[8px] flex-wrap">
        <span className="text-ui-body font-medium text-zinc-900">
          {candidate.name}
        </span>
        {badge}
      </div>
      <div className="text-ui-body text-ink-secondary mt-[2px]">
        {[candidate.address, candidate.city, candidate.phone]
          .filter(Boolean)
          .join(" | ")}
      </div>
      <div className="flex gap-[8px] flex-wrap mt-[10px]">
        {(candidate.services || []).length === 0 ? (
          review.reason === "click_auto_confirm" ? (
            // Click-auto rows must stay correctable even with no recent
            // technician visit: the payout stays unminted server-side, so a
            // technician-less confirm is allowed for exactly these rows
            // (GH codex #3483 r2 P1).
            <Button
              onClick={() => onAttribute(review, candidate, null)}
              disabled={Boolean(matching[`${review.id}:${candidate.id}:none`])}
              variant="primary"
              className="inline-flex items-center gap-[6px]"
            >
              <UserCheck size={14} />
              {matching[`${review.id}:${candidate.id}:none`]
                ? "Matching..."
                : "Confirm match (no visit on file)"}
            </Button>
          ) : (
            <span className="text-ink-secondary text-ui-body">
              No recent technician visits.
            </span>
          )
        ) : (
          candidate.services.map((service) => {
            const matchKey = `${review.id}:${candidate.id}:${service.id}`;
            return (
              <Button
                key={service.id}
                onClick={() => onAttribute(review, candidate, service)}
                disabled={Boolean(matching[matchKey]) || !service.technicianId}
                variant="primary"
                className="inline-flex items-center gap-[6px]"
              >
                <UserCheck size={14} />
                {matching[matchKey]
                  ? "Matching..."
                  : `${service.technicianName} | ${fmtShortDate(service.serviceDate)}`}
              </Button>
            );
          })
        )}
      </div>
    </Card>
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
  const [likelyReviewers, setLikelyReviewers] = useState([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [matching, setMatching] = useState({});
  // Monotonic guard: candidate state is shared across repair panels, so a
  // slow response for review A must never land after review B's panel opened
  // — the rendered candidates would belong to A while the attribute POST
  // carries B's review id (pre-push codex P1).
  const candidateReqRef = useRef(0);
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
    // Invalidate any in-flight candidate request — its response belongs to a
    // panel that is no longer the active one.
    candidateReqRef.current += 1;
    setActiveRepairId(isOpen ? null : review.id);
    setCandidateSearch(isOpen ? "" : review.reviewerName || "");
    setCandidateResults([]);
    setLikelyReviewers([]);
    setCandidateLoading(false);
    // Auto-search on open so the click-correlated "likely reviewers" show up
    // without a keystroke. No q: the server falls back to the reviewer name
    // AND expands its surnames ("slim northgate" finds Sam Northgate); an
    // explicit q is plain field matching (GH codex r6 P2).
    if (!isOpen) searchCandidates(review, "");
  };
  const searchCandidates = async (review, qOverride) => {
    const reqId = ++candidateReqRef.current;
    setCandidateLoading(true);
    setError(null);
    try {
      // The box opens holding the reviewer name; sent untouched it would be
      // an explicit q and lose the surname expansion — only what the admin
      // changed is a query.
      const params = new URLSearchParams({
        reviewId: review.id,
        q:
          qOverride ??
          (candidateSearch === (review.reviewerName || "")
            ? ""
            : candidateSearch),
      });
      const result = await adminFetch(`/admin/reviews/incentives/attribution-candidates?${params.toString()}`);
      if (candidateReqRef.current !== reqId) return; // superseded — drop stale response
      setCandidateResults(result.candidates || []);
      setLikelyReviewers(result.likelyReviewers || []);
    } catch (e) {
      if (candidateReqRef.current === reqId) setError(e.message);
    } finally {
      if (candidateReqRef.current === reqId) setCandidateLoading(false);
    }
  };
  const attributeCandidate = async (review, candidate, service) => {
    // service = null → technician-less click_auto confirm (payout stays
    // unminted server-side; only allowed for click_auto rows there).
    const matchKey = `${review.id}:${candidate.id}:${service ? service.id : "none"}`;
    setMatching((prev) => ({
      ...prev,
      [matchKey]: true,
    }));
    setError(null);
    try {
      await adminFetch("/admin/reviews/incentives/attribute", {
        method: "POST",
        body: JSON.stringify({
          reviewId: review.id,
          customerId: candidate.id,
          technicianId: service ? service.technicianId : null,
          serviceRecordId: service ? service.serviceRecordId : null,
          // Explicit no-visit intent: without it the server's technician
          // resolver could turn this confirm into a paid 'manual' link.
          noVisit: !service,
        }),
      });
      setActiveRepairId(null);
      setCandidateSearch("");
      setCandidateResults([]);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setMatching((prev) => ({
        ...prev,
        [matchKey]: false,
      }));
    }
  };
  const summary = data?.summary || {};
  const payouts = data?.payouts || [];
  const pendingIds = payouts
    .filter((p) => p.status !== "paid")
    .map((p) => p.id);
  const policy = data?.policy || {};
  const needsAttributionCount = queueLoading
    ? "..."
    : queue.length ||
      (summary.unattributedGoogleReviews || 0) +
        (summary.unattributedReviewRequests || 0);
  const confirmedGoogleReviews = Number(summary.confirmedGoogleReviews || 0);
  const programStartsAt =
    policy.programStartsAt || data?.period?.programStartsAt || null;
  const programStartLabel = fmtDateTime(programStartsAt) || "Not configured";
  const policyEnabled = policy.enabled !== false;
  const noEligiblePostLaunchReviews =
    policyEnabled &&
    confirmedGoogleReviews === 0 &&
    payouts.length === 0 &&
    queue.length === 0;
  return (
    <div>
      <div className="flex justify-between items-center gap-[12px] mb-[16px] flex-wrap">
        <div>
          <div className="text-[18px] font-medium text-zinc-900">
            Technician Review Incentives
          </div>
          <div className="text-ui-body text-ink-secondary mt-[2px]">
            Flat {money(policy.amountCents || 500)} bonus per confirmed Google
            review.
          </div>
        </div>
        <div className="flex gap-[8px] items-center flex-wrap">
          <ReviewSelect
            value={days}
            onChange={setDays}
            options={[
              {
                value: "7",
                label: "7 Days",
              },
              {
                value: "30",
                label: "30 Days",
              },
              {
                value: "90",
                label: "90 Days",
              },
            ]}
          />
          <Button
            onClick={runSync}
            disabled={running}
            variant="primary"
            className="inline-flex items-center gap-[6px]"
          >
            <RefreshCw size={15} />
            {running ? "Running..." : "Run Attribution"}
          </Button>
          <Button
            onClick={downloadCsv}
            variant="secondary"
            className="inline-flex items-center gap-[6px]"
          >
            <Download size={15} />
            Export
          </Button>
        </div>
      </div>

      {error && (
        <Card className="text-alert-fg p-[12px] mb-[14px] text-ui-body">
          {error}
        </Card>
      )}

      {loading ? (
        <div className="text-ink-secondary p-[48px] text-center">
          Loading review incentives...
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-[10px] mb-[14px]">
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
              color="text-green-700"
            />
            <PolicyInfoCard
              Icon={Search}
              label="Attribution context"
              value="Rate page and review requests are not payout triggers"
              sub="They only help connect a confirmed Google review to the right customer and technician."
              color="text-warn-fg"
            />
          </div>

          {noEligiblePostLaunchReviews && (
            <Card className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-[10px] p-[14px] mb-[14px]">
              <CheckCircle2 size={18} className="mt-[1px]" />
              <div>
                <div className="text-ui-body font-medium text-zinc-900">
                  No eligible post-launch Google reviews yet.
                </div>
                <div className="text-ui-body text-zinc-900 mt-[4px]">
                  Old reviews are intentionally ignored. The first public Google
                  review after activation will either create an earned payout or
                  appear in the attribution queue.
                </div>
              </div>
            </Card>
          )}

          <div className="flex gap-[12px] mb-[18px] flex-wrap">
            <StatCard
              label="Post-Launch Reviews"
              value={confirmedGoogleReviews}
              sub="public Google reviews since activation"
            />
            <StatCard
              label="Earned"
              value={money(summary.earnedCents)}
              sub={`${summary.payoutCount || 0} technician bonuses`}
            />
            <StatCard
              label="Pending Payroll"
              value={money(summary.pendingCents)}
              sub={`${summary.pendingCount || 0} unpaid bonuses`}
              color={
                summary.pendingCents > 0 ? "text-warn-fg" : "text-green-700"
              }
            />
            <StatCard
              label="Paid"
              value={money(summary.paidCents)}
              sub={`${summary.paidCount || 0} closed bonuses`}
              color="text-green-700"
            />
            <StatCard
              label="Needs Attribution"
              value={needsAttributionCount}
              sub="post-launch reviews missing a customer or technician match"
              color="text-alert-fg"
            />
          </div>

          <Card className="p-[16px] mb-[14px]">
            <div className="flex justify-between items-center gap-[10px] mb-[12px] flex-wrap">
              <div>
                <div className="text-ui-body font-medium text-zinc-900">
                  Attribution Queue
                </div>
                <div className="text-ui-body text-ink-secondary mt-[2px]">
                  Confirmed Google reviews without a technician bonus row.
                </div>
              </div>
              <Button
                onClick={load}
                disabled={queueLoading}
                variant="secondary"
                className="inline-flex items-center gap-[6px]"
              >
                <RefreshCw size={14} />
                Refresh
              </Button>
            </div>

            {queueLoading && !queue.length ? (
              <div className="text-ink-secondary text-ui-body">
                Loading attribution queue...
              </div>
            ) : queue.length === 0 ? (
              <div className="text-ink-secondary text-ui-body">
                {confirmedGoogleReviews === 0
                  ? "No eligible post-launch Google reviews in this period."
                  : "No unmatched post-launch Google reviews in this period."}
              </div>
            ) : (
              <div className="grid gap-[10px]">
                {/* Every click_auto_confirm row must render — the render cap
                    must never hide a probabilistic link from its only
                    correction surface (GH codex #3483 r4) — and auto rows
                    render IN ADDITION to the 25-row allowance for ordinary
                    repairs, never consuming it: a full confirm backlog must
                    not hide missing_customer/missing_technician rows the
                    backend returned (GH codex #3483 r10). */}
                {queue
                  .filter((r) => r.reason === "click_auto_confirm")
                  .concat(
                    queue
                      .filter((r) => r.reason !== "click_auto_confirm")
                      .slice(0, 25),
                  )
                  .map((review) => {
                    const isOpen = activeRepairId === review.id;
                    return (
                      <Card key={review.id} className="p-[12px]">
                        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-[10px] items-center">
                          <div>
                            <div className="flex items-center gap-[8px] flex-wrap">
                              <span className="text-ui-body font-medium text-zinc-900">
                                {review.reviewerName}
                              </span>
                              <Stars
                                count={Number(review.starRating) || 0}
                                size={13}
                              />
                              <span className="text-ui-body text-ink-secondary">
                                {[
                                  fmtShortDate(review.reviewCreatedAt),
                                  review.locationId,
                                ]
                                  .filter(Boolean)
                                  .join(" | ")}
                              </span>
                            </div>
                            <div className="text-ui-body text-ink-secondary mt-[4px]">
                              {review.customerName ||
                                review.reason?.replace("_", " ")}
                            </div>
                            {review.reviewText && (
                              <div className="text-zinc-900 text-ui-body mt-[6px] max-w-[760px]">
                                {review.reviewText.length > 220
                                  ? `${review.reviewText.slice(0, 220)}...`
                                  : review.reviewText}
                              </div>
                            )}
                          </div>
                          <Button
                            onClick={() => openRepair(review)}
                            variant="secondary"
                            className="inline-flex items-center justify-center gap-[6px] whitespace-nowrap"
                          >
                            <Search size={14} />
                            Match
                          </Button>
                        </div>

                        {isOpen && (
                          <div className="mt-[12px] border-t border-hairline border-zinc-200 pt-[12px]">
                            <div className="flex gap-[8px] items-center flex-wrap mb-[10px]">
                              <Input
                                value={candidateSearch}
                                onChange={(e) =>
                                  setCandidateSearch(e.target.value)
                                }
                                placeholder="Customer name, phone, address, or city"
                                className="flex-[1_1_280px] min-w-[0px]"
                              />
                              <Button
                                onClick={() => searchCandidates(review)}
                                disabled={candidateLoading}
                                variant="primary"
                                className="inline-flex items-center gap-[6px]"
                              >
                                <Search size={14} />
                                Search
                              </Button>
                            </div>

                            {candidateLoading ? (
                              <div className="text-ink-secondary text-ui-body">
                                Searching...
                              </div>
                            ) : (
                              <div className="grid gap-[8px]">
                                {likelyReviewers.length > 0 && (
                                  <>
                                    <div className="text-ui-body font-medium text-zinc-900">
                                      Likely reviewers
                                      <span className="text-ink-secondary">
                                        {
                                          " — tapped their review link near this review's timestamp"
                                        }
                                      </span>
                                    </div>
                                    {likelyReviewers.map((candidate) => (
                                      <RepairCandidateCard
                                        key={`likely-${candidate.id}`}
                                        review={review}
                                        candidate={candidate}
                                        matching={matching}
                                        onAttribute={attributeCandidate}
                                        badge={
                                          <span className="text-ui-body font-medium text-zinc-900 border-hairline border-zinc-200 rounded-md">
                                            Tapped link{" "}
                                            {candidate.clickOffsetLabel}
                                            {candidate.locationMatch
                                              ? " | same location"
                                              : ""}
                                            {candidate.nameMatch
                                              ? " | last name matches"
                                              : ""}
                                          </span>
                                        }
                                      />
                                    ))}
                                    {candidateResults.length > 0 && (
                                      <div className="text-ui-body font-medium text-zinc-900 mt-[4px]">
                                        Name search
                                      </div>
                                    )}
                                  </>
                                )}
                                {candidateResults.length === 0 &&
                                likelyReviewers.length === 0 ? (
                                  <div className="text-ink-secondary text-ui-body">
                                    No candidate results.
                                  </div>
                                ) : (
                                  candidateResults.map((candidate) => (
                                    <RepairCandidateCard
                                      key={candidate.id}
                                      review={review}
                                      candidate={candidate}
                                      matching={matching}
                                      onAttribute={attributeCandidate}
                                    />
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </Card>
                    );
                  })}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)] items-start gap-[14px]">
            <Card className="p-[16px]">
              <div className="text-ui-body font-medium text-zinc-900 mb-[12px]">
                Leaderboard
              </div>
              {(data?.leaderboard || []).length === 0 ? (
                <div className="text-ink-secondary text-ui-body">
                  No attributed review bonuses yet.
                </div>
              ) : (
                <div className="grid gap-[8px]">
                  {data.leaderboard.map((row, index) => (
                    <div
                      key={row.technicianId || index}
                      className="grid grid-cols-[24px_1fr_auto] gap-[10px] items-center py-[10px] border-b border-hairline border-zinc-200"
                    >
                      <div className="font-medium text-ink-secondary">
                        {index + 1}
                      </div>
                      <div>
                        <div className="text-ui-body font-medium text-zinc-900">
                          {row.technicianName}
                        </div>
                        <div className="text-ui-body text-ink-secondary">
                          {row.reviewCount} review
                          {row.reviewCount === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="font-medium">
                        {money(row.earnedCents)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-[16px]">
              <div className="flex justify-between items-center gap-[10px] mb-[12px] flex-wrap">
                <div className="text-ui-body font-medium text-zinc-900">
                  Payout Ledger
                </div>
                <Button
                  onClick={markPendingPaid}
                  disabled={markingPaid || pendingIds.length === 0}
                  variant="secondary"
                  className="inline-flex items-center gap-[6px]"
                >
                  <CheckCircle2 size={15} />
                  {markingPaid ? "Updating..." : "Mark Pending Paid"}
                </Button>
              </div>

              {payouts.length === 0 ? (
                <div className="text-ink-secondary text-ui-body">
                  No payout rows in this period.
                </div>
              ) : (
                <div className="grid gap-[8px]">
                  {payouts.slice(0, 50).map((p) => (
                    <Card
                      key={p.id}
                      className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-1.5 md:gap-3 items-center px-3 py-2.5"
                    >
                      <div>
                        <div className="text-ui-body font-medium text-zinc-900">
                          {p.technicianName}
                        </div>
                        <div className="text-ui-body text-ink-secondary mt-[2px]">
                          {[
                            p.customerName,
                            p.source?.replace("_", " "),
                            fmtShortDate(p.earnedAt),
                          ]
                            .filter(Boolean)
                            .join(" | ")}
                        </div>
                      </div>
                      <div className="text-ui-body font-medium">
                        {/* The summary calls unpaid bonuses "Pending Payroll";
                            keep the ledger vocab aligned (status is 'earned'). */}
                        {p.status === "paid" ? "Paid" : "Pending"}
                      </div>
                      <div className="font-medium">{money(p.amountCents)}</div>
                    </Card>
                  ))}
                </div>
              )}
            </Card>
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
  // Deep links from auto-reply bells: ?responded=responded|needs-reply|all
  // picks the view (a posted reply has left the default needs-reply view)
  // and ?review=<id> scrolls to that card once loaded.
  const deepLink = (() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const responded = q.get("responded");
      return {
        responded: ["responded", "needs-reply", "all", "removed"].includes(
          responded,
        )
          ? responded
          : null,
        review: q.get("review") || null,
      };
    } catch {
      return {
        responded: null,
        review: null,
      };
    }
  })();
  const [filterResponded, setFilterResponded] = useState(
    deepLink.responded || "needs-reply",
  );
  const [search, setSearch] = useState("");
  const scrolledToRef = useRef(false);
  useEffect(() => {
    if (!deepLink.review || scrolledToRef.current || !data?.reviews?.length)
      return;
    const el = document.getElementById(`review-${deepLink.review}`);
    if (el) {
      scrolledToRef.current = true;
      el.scrollIntoView({
        block: "center",
      });
    }
  }, [data]);
  const loadSeqRef = useRef(0);
  // Server pages at 200 rows; without a pager a large profile wipe would
  // leave older stamped reviews unreachable from the Removed filter (only
  // notification metadata would name them). pageRef tracks the last page
  // appended; hasMore = the last fetch returned a full page.
  const PAGE_SIZE = 200;
  const pageRef = useRef(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Append failures stay OUT of the page-level `error`: replacing the whole
  // page with the failed state would discard the evidence already loaded and
  // restart pagination from page 1 on retry.
  const [loadMoreError, setLoadMoreError] = useState(null);
  const buildParams = useCallback(
    (pageNum) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
      });
      if (pageNum > 1) params.set("page", String(pageNum));
      if (filterLocation !== "all") params.set("location", filterLocation);
      if (filterRating !== "all") params.set("rating", filterRating);
      if (filterResponded === "responded") params.set("responded", "true");
      if (filterResponded === "needs-reply") params.set("responded", "false");
      if (filterResponded === "removed") params.set("missing", "true");
      if (search.trim()) params.set("search", search.trim());
      // A notification deep link names one review; the server pins it into the
      // first page so an old row (beyond the page size) is still reached.
      if (pageNum === 1 && deepLink.review)
        params.set("review", deepLink.review);
      return params;
    },
    [filterLocation, filterRating, filterResponded, search, deepLink.review],
  );
  const loadData = useCallback(() => {
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    setLoading(true);
    setError(null);
    pageRef.current = 1;
    setHasMore(false);
    // A base load supersedes any in-flight append (its response is discarded
    // by the sequence check without ever clearing this flag) — reset it so
    // the new result's Load More button isn't permanently disabled.
    setLoadingMore(false);
    setLoadMoreError(null);
    // Returns the fetch chain so callers that must not re-enable an action
    // before the new row state is installed can await it (Post now on a
    // 1-3★ review that just drafted: the card must render the draft first).
    return adminFetch(`/admin/reviews?${buildParams(1).toString()}`)
      .then((d) => {
        if (loadSeq !== loadSeqRef.current) return;
        setData(d);
        setHasMore(
          d.hasMore != null
            ? !!d.hasMore
            : (d.reviews || []).length === PAGE_SIZE,
        );
        setLoading(false);
      })
      .catch((e) => {
        if (loadSeq !== loadSeqRef.current) return;
        setError(e.message);
        setLoading(false);
      });
  }, [buildParams]);
  const loadMore = useCallback(() => {
    // Capture the sequence so a filter change mid-flight discards this append.
    const loadSeq = loadSeqRef.current;
    const nextPage = pageRef.current + 1;
    setLoadingMore(true);
    setLoadMoreError(null);
    adminFetch(`/admin/reviews?${buildParams(nextPage).toString()}`)
      .then((d) => {
        if (loadSeq !== loadSeqRef.current) return;
        pageRef.current = nextPage;
        setHasMore(
          d.hasMore != null
            ? !!d.hasMore
            : (d.reviews || []).length === PAGE_SIZE,
        );
        setLoadingMore(false);
        setData((prev) => {
          if (!prev) return d;
          // Rows can shift between pages as the hourly sync inserts — dedupe
          // by id so a shifted row isn't rendered twice.
          const seen = new Set(prev.reviews.map((r) => r.id));
          return {
            ...prev,
            reviews: [
              ...prev.reviews,
              ...(d.reviews || []).filter((r) => !seen.has(r.id)),
            ],
          };
        });
      })
      .catch((e) => {
        if (loadSeq !== loadSeqRef.current) return;
        setLoadingMore(false);
        setLoadMoreError(e.message);
      });
  }, [buildParams]);
  useEffect(() => {
    const t = setTimeout(loadData, search.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadData, search]);

  // Auto-reply pipeline actions: retract (delete on Google), post-now
  // (publish the pending draft immediately), skip (leave the pipeline). The
  // row's reply / autoReply state changes server-side, so reload the list.
  const handleAutoReplyAction = async (reviewId, action, body) => {
    const path =
      action === "retract"
        ? `/admin/reviews/${reviewId}/retract-reply`
        : `/admin/reviews/${reviewId}/auto-reply/${action}`;
    const result = await adminFetch(path, body ? { method: "POST", body: JSON.stringify(body) } : { method: "POST" });
    // Post now on a 1-3★ / unrated review with no surfaced draft: the server
    // drafted + parked instead of posting; reload so the draft is rendered.
    if (result && result.message) alert(result.message);
    await loadData();
  };
  const handleReply = async (
    reviewId,
    replyText,
    {
      draftToken = null,
      groundingToken = null,
      expectedReply = null,
      expectedDraft = null,
      expectedReview = null,
    } = {},
  ) => {
    await adminFetch(`/admin/reviews/${reviewId}/reply`, {
      method: "POST",
      body: JSON.stringify({
        replyText,
        expectedReply,
        expectedDraft,
        ...(expectedReview ? { expectedReview } : {}),
        ...(draftToken ? { draftToken } : {}),
        ...(groundingToken ? { groundingToken } : {}),
      }),
    });
    // A reply removes the row from the server-side "needs reply" result set.
    // With more pages still on the server, keeping the mutable page offset
    // would skip one never-loaded row per reply (the set shrank underneath
    // the offset) — restart from page 1 instead. When everything is already
    // loaded (the common case), the cheap local update stands.
    if (filterResponded === "needs-reply" && hasMore) {
      loadData();
      return;
    }
    // Update local state
    setData((prev) => ({
      ...prev,
      reviews: prev.reviews.map((r) =>
        r.id === reviewId
          ? {
              ...r,
              reply: replyText,
              replyUpdatedAt: new Date().toISOString(),
              // The saved draft slot is consumed by the post (server-side the
              // "[DRAFT]" became the reply): clear it and its identity so a
              // follow-up edit does not report the obsolete draft as observed.
              draftReply: null,
              draftToken: null,
              draftStale: false,
              // A manual post closes out the auto-reply state server-side
              // (skipped/manual_reply); mirror it so Retract — which deletes
              // whatever reply is live — is not offered on a human's reply.
              autoReply: r.autoReply
                ? {
                    ...r.autoReply,
                    status: "skipped",
                    reason: "manual_reply",
                  }
                : null,
            }
          : r,
      ),
    }));
  };
  const handleDismiss = async (reviewId) => {
    await adminFetch(`/admin/reviews/${reviewId}/dismiss`, { method: "POST" });
    // Dismissed rows are excluded from every view except Removed, so the same
    // shrinking-result-set offset skew as handleReply applies here.
    if (filterResponded !== "removed" && hasMore) {
      loadData();
      return;
    }
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
    // Needs Reply keeps stamped (removed-from-Google) rows visible even when
    // replied — mirrors the server-side inclusion; the removal alert links here.
    if (filterResponded === "needs-reply" && r.reply && !r.missingSince)
      return false;
    if (filterResponded === "removed" && !r.missingSince) return false;
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
    locLookup[l.id] = {
      ...l,
      count: 0,
      avgRating: "0.0",
    };
  });
  perLocation.forEach((p) => {
    if (locLookup[p.locationId]) {
      locLookup[p.locationId].count = p.count;
      locLookup[p.locationId].avgRating = p.avgRating;
    }
  });
  const locationOptions = [
    {
      value: "all",
      label: "All Locations",
    },
    {
      value: "bradenton",
      label: "Lakewood Ranch",
    },
    {
      value: "parrish",
      label: "Parrish",
    },
    {
      value: "sarasota",
      label: "Sarasota",
    },
    {
      value: "venice",
      label: "Venice",
    },
  ];
  const ratingOptions = [
    {
      value: "all",
      label: "All Ratings",
    },
    {
      value: "5",
      label: "5 Stars",
    },
    {
      value: "4",
      label: "4 Stars",
    },
    {
      value: "3",
      label: "3 Stars",
    },
    {
      value: "2",
      label: "2 Stars",
    },
    {
      value: "1",
      label: "1 Star",
    },
  ];
  const respondedOptions = [
    {
      value: "all",
      label: "All Reviews",
    },
    {
      value: "responded",
      label: "Responded",
    },
    {
      value: "needs-reply",
      label: "Needs Reply",
    },
    {
      value: "removed",
      label: "Removed from Google",
    },
  ];
  const activeGroup =
    REVIEWS_TAB_GROUPS.find((g) => g.tabs.includes(activeTab)) ||
    REVIEWS_TAB_GROUPS[0];
  const fallbackLocations = locations.filter(
    (l) => l.reviewsSource === "places_fallback",
  );
  // 'none' = no GBP access AND no Places key — review tracking is fully
  // offline for these locations; saying "fallback" would overstate it.
  const offlineLocations = locations.filter((l) => l.reviewsSource === "none");
  return (
    <UiSurface density="comfortable">
      {" "}
      <AdminCommandHeader
        variant="workspace"
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
        <div className="flex flex-wrap gap-[8px] mb-[16px]">
          {activeGroup.tabs.map((key) => {
            const leaf = REVIEWS_LEAF_BY_KEY[key];
            const active = activeTab === key;
            const LeafIcon = leaf.Icon;
            return (
              <Button
                key={key}
                type="button"
                onClick={() => setActiveTab(key)}
                variant={active ? "primary" : "secondary"}
              >
                <LeafIcon size={14} strokeWidth={1.9} />
                {leaf.label}
              </Button>
            );
          })}
        </div>
      )}
      {/* ====================== TAB: REVIEWS ====================== */}
      {activeTab === "reviews" && (
        <div>
          {/* Loading state */}
          {loading && (
            <div className="text-ink-secondary p-[60px] text-center text-ui-body">
              Loading reviews...
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div className="text-alert-fg p-[60px] text-center">
              {" "}
              <div className="text-ui-body mb-[12px]">
                Failed to load reviews
              </div>{" "}
              <div className="text-ui-body text-ink-secondary mb-[16px]">
                {error}
              </div>{" "}
              <Button onClick={loadData} variant="primary">
                Retry
              </Button>{" "}
            </div>
          )}

          {/* Reviews content */}
          {!loading && !error && data && (
            <>
              {fallbackLocations.length > 0 && (
                <div className="border-hairline border-zinc-200 text-zinc-900 rounded-md mb-[14px] text-ui-body">
                  {fallbackLocations.map((l) => l.name).join(", ")} currently
                  use Places review fallback until GBP Reviews API access is
                  available.
                </div>
              )}
              {offlineLocations.length > 0 && (
                <div className="border-hairline border-zinc-200 text-alert-fg rounded-md mb-[14px] text-ui-body">
                  Review tracking is offline for{" "}
                  {offlineLocations.map((l) => l.name).join(", ")} — no GBP
                  Reviews API access and no Places API key, so new reviews and
                  removals are not being detected.
                </div>
              )}
              {/* Page header + Sync Reviews button removed: the page tab
                  ("Reviews") already labels this surface, and the hourly
                  cron added in PR #382 (services/scheduler.js) keeps
                  google_reviews fresh without anyone clicking sync. */}

              {/* Stats bar */}
              <div className="flex gap-[12px] mb-[24px] flex-wrap">
                {" "}
                <StatCard
                  label="Total Reviews"
                  value={totalReviews}
                  sub={
                    <span>
                      <span>{Number(avgRating).toFixed(1)}</span>{" "}
                      <Stars count={Math.round(avgRating)} size={13} />
                    </span>
                  }
                />{" "}
                <StatCard
                  label="No Portal Reply"
                  value={unresponded}
                  color={unresponded > 0 ? "text-warn-fg" : "text-green-700"}
                  sub={
                    unresponded > 0 ? "reply via AI Reply below" : "all replied"
                  }
                />{" "}
                <StatCard label="New This Month" value={newThisMonth} />{" "}
                <StatCard
                  label="Response Rate"
                  value={`${responseRate}%`}
                  color={
                    responseRate >= 90
                      ? "text-green-700"
                      : responseRate >= 70
                        ? "text-warn-fg"
                        : "text-alert-fg"
                  }
                  sub={`${respondedCount} of ${ratedTotal} replied`}
                />{" "}
              </div>
              {/* Per-location cards */}
              <div className="flex gap-[12px] mb-[24px] flex-wrap">
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
              <Card className="mb-5 flex flex-wrap items-center gap-3 rounded-md border border-hairline border-zinc-200 bg-white p-3">
                {" "}
                <ReviewSelect
                  value={filterLocation}
                  onChange={setFilterLocation}
                  options={locationOptions}
                />{" "}
                <ReviewSelect
                  value={filterRating}
                  onChange={setFilterRating}
                  options={ratingOptions}
                />{" "}
                <ReviewSelect
                  value={filterResponded}
                  onChange={setFilterResponded}
                  options={respondedOptions}
                />{" "}
                <Input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search reviews..."
                  className="flex-[1_1_180px] min-w-[160px]"
                />{" "}
                <span className="text-ui-body text-ink-secondary">
                  {filtered.length} review{filtered.length !== 1 ? "s" : ""}
                </span>{" "}
              </Card>
              {/* Reviews feed */}
              {filtered.length === 0 ? (
                <Card className="p-[48px] text-center text-ink-secondary">
                  {" "}
                  <Star size={32} className="mb-[12px]" />{" "}
                  <div className="text-ui-body">
                    No reviews match your filters
                  </div>{" "}
                  <div className="text-ui-body mt-[4px]">
                    Try adjusting your search or filter criteria
                  </div>{" "}
                </Card>
              ) : (
                filtered.map((r) => (
                  <ReviewCard
                    key={r.id}
                    review={r}
                    onReplySubmit={handleReply}
                    onDismiss={handleDismiss}
                    onAutoReplyAction={handleAutoReplyAction}
                  />
                ))
              )}
              {hasMore && (
                <div className="text-center mt-[12px]">
                  {loadMoreError && (
                    <div className="text-alert-fg text-ui-body mb-[8px]">
                      Couldn&apos;t load more reviews ({loadMoreError}) — the
                      reviews above are still loaded; retry below.
                    </div>
                  )}
                  <Button
                    onClick={loadMore}
                    disabled={loadingMore}
                    variant="secondary"
                    className="min-h-[44px]"
                  >
                    {loadingMore ? "Loading..." : "Load more reviews"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {/* ====================== TAB: REVIEW OUTREACH ====================== */}
      {activeTab === "gbp" && <GBPManagementPanel />}
      {activeTab === "outreach" && <ReviewVelocityEngine />}
      {activeTab === "incentives" && <ReviewIncentivesPanel />}
    </UiSurface>
  );
}
