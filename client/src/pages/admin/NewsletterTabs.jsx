// client/src/pages/admin/NewsletterTabs.jsx
//
// Exposes the History and Subscribers views as named exports so
// NewsletterPage.jsx can host them as tabs alongside its Dashboard tab.
// The Automations tab is wired separately via EmailAutomationsPanelV2 —
// imported directly by NewsletterPage. There is no manual composer: the
// weekly issue is drafted and sent by the autopilot + proof flow.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Download,
  Search,
  Upload,
  UserPlus,
} from "lucide-react";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  ActionFeedback,
  Badge,
  Button,
  Card,
  cn,
  Field,
  Input,
  Checkbox,
  UiSurface,
} from "../../components/ui";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
// Mirrors the server QUIZ_TOKEN_PATTERN (newsletter-quiz.js) — matches
// {{quiz}}, {{quiz:id}}, {{quiz-text}}, {{quiz-text:id}}. Used to detect
// whether the body already carries a quiz (one quiz per email).
const QUIZ_TOKEN_RE = /\{\{quiz(?:-text)?(?::[a-z0-9-]+)?\}\}/i;
function formatEtDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
function parseSubscriberCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map((value) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ""),
  );
  const indexOf = (...keys) =>
    headers.findIndex((header) => keys.includes(header));
  const emailIndex = indexOf("email", "emailaddress");
  if (emailIndex < 0) throw new Error("CSV needs an email column");
  const firstIndex = indexOf("firstname", "first");
  const lastIndex = indexOf("lastname", "last");
  return rows
    .slice(1)
    .map((values) => ({
      email: values[emailIndex]?.trim() || "",
      firstName: firstIndex >= 0 ? values[firstIndex]?.trim() || "" : "",
      lastName: lastIndex >= 0 ? values[lastIndex]?.trim() || "" : "",
    }))
    .filter((subscriber) => subscriber.email);
}
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  });
}

// ── History ────────────────────────────────────────────────────────

// History reads the page-level /sends payload (NewsletterPage re-reads it
// when History opens, on focus, on an interval and after any action here),
// so delivery status and recovery controls stay current while the tab is
// open. Until a read that finished after History opened lands, it shows
// Loading, never an older list. A failed refresh keeps the last loaded rows
// on screen, marked as not refreshed, with a retry.
export function HistoryView({ sendsData, sendsLoading, sendsReads, onRefresh }) {
  const [openedAtRead] = useState(sendsReads);
  const fresh = sendsReads > openedAtRead;
  const [lastLoaded, setLastLoaded] = useState(null);
  useEffect(() => {
    if (fresh && sendsData) setLastLoaded(sendsData);
  }, [fresh, sendsData]);
  const shown = fresh ? sendsData || lastLoaded : null;
  const sends = shown?.sends || [];
  const aggregate = shown?.aggregate;
  const loading = !fresh || (sendsLoading && !shown);
  const readFailed = fresh && !sendsLoading && !sendsData;
  // Per-send variant breakdown (a vs b counts) — fetched lazily when the
  // operator expands an A/B row, then cached.
  const [variantStats, setVariantStats] = useState({});
  const [expandedId, setExpandedId] = useState(null);
  // Per-send quiz-results panel — fetched lazily when the operator expands a
  // quiz row, then cached. Independent of the A/B panel (a send can have both).
  const [quizResults, setQuizResults] = useState({});
  const [quizOpenId, setQuizOpenId] = useState(null);
  const [feedbackResults, setFeedbackResults] = useState({});
  const [feedbackOpenId, setFeedbackOpenId] = useState(null);
  const load = onRefresh;
  const cancelSchedule = async (id) => {
    if (!confirm("Cancel this scheduled send and return it to draft?")) return;
    try {
      await adminFetch(`/admin/newsletter/sends/${id}/cancel-schedule`, {
        method: "POST",
      });
      load();
    } catch (e) {
      alert("Cancel failed: " + e.message);
    }
  };
  const deleteDraft = async (id) => {
    if (
      !confirm(
        "Delete this draft? A linked weekly calendar entry will be marked skipped so autopilot cannot recreate it.",
      )
    )
      return;
    try {
      await adminFetch(`/admin/newsletter/sends/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  };
  const resumeSend = async (send) => {
    const recovery = send.status === "sending";
    if (
      !confirm(
        recovery
          ? "Recover this stalled campaign? Only recipients without a success signal will be retried."
          : "Resume this campaign? Only failed or unfinished recipients will be retried.",
      )
    )
      return;
    try {
      await adminFetch(`/admin/newsletter/sends/${send.id}/resume`, { method: "POST" });
      load();
    } catch (e) {
      alert(`${recovery ? "Recovery" : "Resume"} failed: ${e.message}`);
      // A refused resume can still change the row (a zero-ledger campaign
      // returns to draft, a stale claim is released): reload so the row
      // shows its real state and next action.
      load();
    }
  };

  // Toggle the A/B breakdown panel. First open lazy-loads /sends/:id (the
  // detail endpoint includes variantStats); subsequent toggles read from
  // the cache. A failed read is cached as { error: true }, so the panel
  // shows it with a retry (retry=true re-reads without toggling), and
  // reopening a failed panel reads again. The feedback and quiz panels
  // below work the same way.
  const toggleVariants = async (id, retry = false) => {
    if (!retry) {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      if (variantStats[id] && !variantStats[id].error) return;
    }
    setVariantStats((prev) => ({ ...prev, [id]: undefined }));
    try {
      const d = await adminFetch(`/admin/newsletter/sends/${id}`);
      setVariantStats((prev) => ({ ...prev, [id]: d.variantStats || {} }));
    } catch {
      setVariantStats((prev) => ({ ...prev, [id]: { error: true } }));
    }
  };

  // Toggle the reaction-feedback panel. First open lazy-loads /sends/:id
  // (the detail endpoint includes the 👍/😐/👎 rollup); subsequent toggles
  // read from the cache.
  const toggleFeedback = async (id, retry = false) => {
    if (!retry) {
      if (feedbackOpenId === id) {
        setFeedbackOpenId(null);
        return;
      }
      setFeedbackOpenId(id);
      if (feedbackResults[id] && !feedbackResults[id].error) return;
    }
    setFeedbackResults((prev) => ({ ...prev, [id]: undefined }));
    try {
      const d = await adminFetch(`/admin/newsletter/sends/${id}`);
      setFeedbackResults((prev) => ({
        ...prev,
        [id]: {
          feedback: d.feedback || null,
        },
      }));
    } catch {
      setFeedbackResults((prev) => ({
        ...prev,
        [id]: {
          error: true,
        },
      }));
    }
  };

  // Toggle the quiz-results panel. First open lazy-loads the aggregated answer
  // breakdown; subsequent toggles read from the cache.
  const toggleQuiz = async (id, retry = false) => {
    if (!retry) {
      if (quizOpenId === id) {
        setQuizOpenId(null);
        return;
      }
      setQuizOpenId(id);
      if (quizResults[id] && !quizResults[id].error) return;
    }
    setQuizResults((prev) => ({ ...prev, [id]: undefined }));
    try {
      const d = await adminFetch(`/admin/newsletter/sends/${id}/quiz-results`);
      setQuizResults((prev) => ({
        ...prev,
        [id]: d,
      }));
    } catch {
      setQuizResults((prev) => ({
        ...prev,
        [id]: {
          error: true,
        },
      }));
    }
  };
  return (
    <UiSurface density="comfortable" className="space-y-4">
      <Card className="p-0 overflow-hidden">
        {" "}
        <div className="flex items-center justify-between p-4 border-b border-hairline border-zinc-200 flex-wrap gap-2">
          {" "}
          <div>
            {" "}
            <h3 className="text-16 font-medium text-zinc-900">
              Past sends
            </h3>{" "}
            <p className="text-ui-body text-ink-tertiary mt-0.5">
              Delivery health, scheduling, and subject-line results.
            </p>{" "}
          </div>{" "}
          <span className="text-ui-body text-ink-tertiary u-nums">
            {sends.length} campaign{sends.length === 1 ? "" : "s"}
          </span>{" "}
        </div>
        {aggregate && aggregate.campaignCount > 0 && (
          <div className="border-b border-hairline border-zinc-200">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-zinc-200">
              <AggStat
                label="Delivery"
                value={pctLabel(aggregate.rates.deliveryRate)}
              />
              <AggStat
                label="Open"
                value={pctLabel(aggregate.rates.openRate)}
              />
              <AggStat
                label="Click"
                value={pctLabel(aggregate.rates.clickRate)}
              />
              <AggStat
                label="Bounce"
                value={pctLabel(aggregate.rates.bounceRate)}
                alert={aggregate.rates.bounceRate > 0.02}
              />
              <AggStat
                label="Unsub"
                value={pctLabel(aggregate.rates.unsubscribeRate)}
              />
              <AggStat
                label="Complaint"
                value={pctLabel(aggregate.rates.complaintRate)}
                alert={aggregate.rates.complaintRate > 0.001}
              />
            </div>
            <p className="text-ui-body text-ink-tertiary px-4 py-1.5 u-nums">
              Pooled across {aggregate.campaignCount} sent campaign
              {aggregate.campaignCount === 1 ? "" : "s"} · open/click over
              delivered, bounce over recipients
            </p>
          </div>
        )}
        {readFailed && shown && (
          <ActionFeedback error onRetry={onRefresh} className="mx-4 mt-3">
            Campaigns could not be refreshed. This list may be out of date.
          </ActionFeedback>
        )}
        {loading ? (
          <div className="text-ui-body text-ink-secondary p-6 text-center">
            Loading…
          </div>
        ) : !shown ? (
          // Not loading with nothing to show: the read failed.
          <ActionFeedback error onRetry={onRefresh} className="m-4">
            Campaigns could not be loaded.
          </ActionFeedback>
        ) : sends.length === 0 ? (
          <div className="text-ui-body text-ink-secondary p-8 text-center">
            No campaigns yet. The weekly issue appears here after the Monday autopilot drafts it.
          </div>
        ) : (
          <div className="space-y-0">
            {sends.map((s) => {
              const pct = s.recipient_count
                ? Math.round((s.delivered_count / s.recipient_count) * 100)
                : 0;
              const isAb = !!s.subject_b;
              const isOpen = expandedId === s.id;
              const hasQuiz =
                QUIZ_TOKEN_RE.test(s.html_body || "") ||
                QUIZ_TOKEN_RE.test(s.text_body || "");
              const quizIsOpen = quizOpenId === s.id;
              return (
                <div
                  key={s.id}
                  className="border-b border-hairline border-zinc-200"
                >
                  {" "}
                  <div className="px-4 py-3 flex flex-col lg:flex-row lg:items-start gap-3 lg:gap-4">
                    {" "}
                    <div className="flex-1 min-w-0">
                      {" "}
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        {" "}
                        <span className="text-14 font-medium text-zinc-900 truncate">
                          {s.subject}
                        </span>
                        {isAb && (
                          <Button
                            type="button"
                            onClick={() => toggleVariants(s.id)}
                            className=""
                            title={
                              isOpen
                                ? "Hide A/B breakdown"
                                : "Show A/B breakdown"
                            }
                            variant="secondary"
                            aria-label={
                              isOpen
                                ? "Hide A/B breakdown"
                                : "Show A/B breakdown"
                            }
                          >
                            A/B {isOpen ? "▾" : "▸"}
                          </Button>
                        )}
                        {hasQuiz && s.status === "sent" && (
                          <Button
                            type="button"
                            onClick={() => toggleQuiz(s.id)}
                            className=""
                            title={
                              quizIsOpen
                                ? "Hide quiz results"
                                : "Show quiz results"
                            }
                            variant="secondary"
                            aria-label={
                              quizIsOpen
                                ? "Hide quiz results"
                                : "Show quiz results"
                            }
                          >
                            Quiz {quizIsOpen ? "▾" : "▸"}
                          </Button>
                        )}
                        {s.status === "sent" && (
                          <Button
                            type="button"
                            onClick={() => toggleFeedback(s.id)}
                            className=""
                            title={
                              feedbackOpenId === s.id
                                ? "Hide reader feedback"
                                : "Show reader feedback"
                            }
                            variant="secondary"
                            aria-label={
                              feedbackOpenId === s.id
                                ? "Hide reader feedback"
                                : "Show reader feedback"
                            }
                          >
                            Feedback {feedbackOpenId === s.id ? "▾" : "▸"}
                          </Button>
                        )}
                        {s.segment_filter && (
                          <Badge tone="neutral">Segmented</Badge>
                        )}
                        <StatusChip status={s.status} />{" "}
                      </div>{" "}
                      <div className="text-ui-body text-ink-tertiary">
                        {s.created_by_name || "Admin"} ·{" "}
                        {s.status === "scheduled" && s.scheduled_for
                          ? `scheduled for ${formatEtDateTime(s.scheduled_for)}`
                          : s.sent_at
                            ? formatEtDateTime(s.sent_at)
                            : "draft (not sent)"}
                      </div>
                      {isAb && (
                        <div className="text-ui-body text-ink-tertiary mt-0.5 truncate">
                          B: {s.subject_b}
                        </div>
                      )}
                    </div>{" "}
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:flex lg:items-center gap-3 lg:gap-5 text-ui-body flex-shrink-0">
                      {s.status === "draft" && (
                        <Button
                          type="button"
                          onClick={() => deleteDraft(s.id)}
                          className=""
                          variant="secondary"
                        >
                          Delete
                        </Button>
                      )}
                      {(s.status === "failed" || s.sending_stale || (s.status === "sent" && s.correctable)) && (
                        <Button
                          type="button"
                          onClick={() => resumeSend(s)}
                          className=""
                          variant="secondary"
                        >
                          {s.sending_stale ? "Recover stalled send" : "Resume"}
                        </Button>
                      )}
                      {s.status === "scheduled" ? (
                        <Button
                          type="button"
                          onClick={() => cancelSchedule(s.id)}
                          className=""
                          variant="secondary"
                        >
                          Cancel schedule
                        </Button>
                      ) : (
                        <>
                          {" "}
                          <Stat
                            label="Sent"
                            value={s.recipient_count || 0}
                          />{" "}
                          <Stat
                            label="Delivered"
                            value={`${s.delivered_count || 0} (${pct}%)`}
                          />{" "}
                          <Stat
                            label="Open"
                            value={pctLabel(s.rates?.openRate)}
                          />{" "}
                          <Stat
                            label="Click"
                            value={pctLabel(s.rates?.clickRate)}
                          />{" "}
                          <Stat
                            label="Bounced"
                            value={s.bounced_count || 0}
                            alert={s.bounced_count > 0}
                          />{" "}
                          <Stat
                            label="Unsub"
                            value={s.unsubscribed_count || 0}
                          />{" "}
                        </>
                      )}
                    </div>{" "}
                  </div>
                  {isAb && isOpen && (
                    <VariantBreakdown
                      stats={variantStats[s.id]}
                      subjectA={s.subject}
                      subjectB={s.subject_b}
                      onRetry={() => toggleVariants(s.id, true)}
                    />
                  )}
                  {hasQuiz && quizIsOpen && (
                    <QuizResultsBreakdown
                      data={quizResults[s.id]}
                      onRetry={() => toggleQuiz(s.id, true)}
                    />
                  )}
                  {feedbackOpenId === s.id && (
                    <FeedbackBreakdown
                      data={feedbackResults[s.id]}
                      onRetry={() => toggleFeedback(s.id, true)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </UiSurface>
  );
}

// ── Quiz results breakdown ───────────────────────────────────────────
//
// Per-campaign in-email quiz responses from /sends/:id/quiz-results: answer
// counts (labeled via the server quiz config), total responses, and the
// response rate over recipients. Monochrome bars (zinc) — this is data, not
// an alert, so no decorative color.
// A failed panel read, with a retry, so it never reads as "loading" or "none".
function BreakdownReadError({ what, onRetry }) {
  return (
    <ActionFeedback error onRetry={onRetry} className="mx-5 mb-3 -mt-2">
      Couldn't load {what}.
    </ActionFeedback>
  );
}

function QuizResultsBreakdown({ data, onRetry }) {
  if (!data) {
    return (
      <div className="px-5 pb-3 -mt-2 text-ui-body text-ink-tertiary">
        Loading quiz results…
      </div>
    );
  }
  if (data.error) {
    return <BreakdownReadError what="quiz results" onRetry={onRetry} />;
  }
  if (!data.totalResponses) {
    return (
      <div className="px-5 pb-3 -mt-2 text-ui-body text-ink-tertiary">
        No quiz responses yet — they appear as recipients tap an answer.
      </div>
    );
  }
  return (
    <div className="px-5 pb-4 -mt-1 space-y-3">
      <div className="text-ui-body text-ink-secondary u-nums">
        {data.totalResponses} response{data.totalResponses === 1 ? "" : "s"} ·{" "}
        {data.responseRate}% of {data.totalRecipients} recipient
        {data.totalRecipients === 1 ? "" : "s"} · tagged for segmentation
      </div>
      {data.quizzes.map((q) => {
        const max = Math.max(1, ...q.answers.map((a) => a.count));
        return (
          <div
            key={q.quizId}
            className="border-hairline border-zinc-200 rounded-sm p-3 bg-white"
          >
            <div className="text-ui-body font-medium text-zinc-900 mb-2">
              {q.question}
            </div>
            <div className="space-y-1.5">
              {q.answers.map((a) => {
                const share = q.responses
                  ? Math.round((a.count / q.responses) * 100)
                  : 0;
                return (
                  <div
                    key={a.key}
                    className="flex items-center gap-2 text-ui-body"
                  >
                    <span className="w-28 shrink-0 text-ink-secondary truncate">
                      {a.label}
                    </span>
                    <span className="flex-1 h-3 bg-zinc-100 rounded-sm overflow-hidden">
                      <span
                        className="block h-full bg-zinc-900"
                        style={{
                          width: `${Math.round((a.count / max) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="w-16 shrink-0 text-right u-nums text-ink-secondary">
                      {a.count} · {share}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Reader-feedback breakdown ────────────────────────────────────────
//
// 👍/😐/👎 rollup pulled from /sends/:id (server aggregates the deliveries
// table; one row per recipient so counts are people, not clicks). The
// "what was missing" tallies come from 👎 follow-up selections. Labels
// mirror the server-side allowlist in newsletter-feedback.js.

const FEEDBACK_REACTION_LABELS = [
  {
    key: "great",
    label: "👍 Great",
  },
  {
    key: "okay",
    label: "😐 Okay",
  },
  {
    key: "needs-work",
    label: "👎 Needs work",
  },
];
const FEEDBACK_MISSING_LABELS = {
  "closer-events": "Closer events",
  "local-news": "More local news",
  "restaurant-openings": "Restaurant openings",
  "family-activities": "Family activities",
  "home-tips": "Home tips",
};
function FeedbackBreakdown({ data, onRetry }) {
  if (!data) {
    return (
      <div className="px-5 pb-3 -mt-2 text-ui-body text-ink-tertiary">
        Loading reader feedback…
      </div>
    );
  }
  if (data.error) {
    return <BreakdownReadError what="reader feedback" onRetry={onRetry} />;
  }
  const reactions = data.feedback?.reactions || {};
  const missing = data.feedback?.missing || {};
  const total = Object.values(reactions).reduce((sum, n) => sum + n, 0);
  if (!total) {
    return (
      <div className="px-5 pb-3 -mt-2 text-ui-body text-ink-tertiary">
        No reactions yet — they appear as readers tap 👍 / 😐 / 👎 in the
        footer.
      </div>
    );
  }
  const max = Math.max(
    1,
    ...FEEDBACK_REACTION_LABELS.map((r) => reactions[r.key] || 0),
  );
  const missingEntries = Object.entries(FEEDBACK_MISSING_LABELS)
    .map(([key, label]) => ({
      key,
      label,
      count: missing[key] || 0,
    }))
    .filter((m) => m.count > 0);
  return (
    <div className="px-5 pb-4 -mt-1 space-y-3">
      <div className="text-ui-body text-ink-secondary u-nums">
        {total} reaction{total === 1 ? "" : "s"}
      </div>
      <div className="border-hairline border-zinc-200 rounded-sm p-3 bg-white space-y-1.5">
        {FEEDBACK_REACTION_LABELS.map((r) => {
          const count = reactions[r.key] || 0;
          const share = total ? Math.round((count / total) * 100) : 0;
          return (
            <div key={r.key} className="flex items-center gap-2 text-ui-body">
              <span className="w-28 shrink-0 text-ink-secondary truncate">
                {r.label}
              </span>
              <span className="flex-1 h-3 bg-zinc-100 rounded-sm overflow-hidden">
                <span
                  className="block h-full bg-zinc-900"
                  style={{
                    width: `${Math.round((count / max) * 100)}%`,
                  }}
                />
              </span>
              <span className="w-16 shrink-0 text-right u-nums text-ink-secondary">
                {count} · {share}%
              </span>
            </div>
          );
        })}
      </div>
      {missingEntries.length > 0 && (
        <div className="border-hairline border-zinc-200 rounded-sm p-3 bg-white">
          <div className="text-ui-body font-medium text-zinc-900 mb-2">
            👎 follow-up — what was missing
          </div>
          <div className="space-y-1 text-ui-body text-ink-secondary">
            {missingEntries.map((m) => (
              <div key={m.key} className="flex items-center justify-between">
                <span>{m.label}</span>
                <span className="u-nums">{m.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── A/B variant breakdown ────────────────────────────────────────────
//
// Per-variant counts pulled from /sends/:id (server aggregates the
// deliveries table grouped by ab_variant). "Winner" is whichever variant
// has the higher open rate among delivered messages — same heuristic
// most ESPs use; falls back to no-winner when both rates are within
// half a percentage point.

function VariantBreakdown({ stats, subjectA, subjectB, onRetry }) {
  if (!stats) {
    return (
      <div className="px-5 pb-3 -mt-2 text-ui-body text-ink-tertiary">
        Loading variant breakdown…
      </div>
    );
  }
  if (stats.error) {
    return <BreakdownReadError what="the A/B breakdown" onRetry={onRetry} />;
  }
  const a = stats.a;
  const b = stats.b;
  if (!a && !b) {
    return (
      <div className="px-5 pb-3 -mt-2 text-ui-body text-ink-tertiary">
        No A/B delivery rows yet — open rates appear once SendGrid events
        arrive.
      </div>
    );
  }
  const openRate = (v) => (v && v.delivered ? v.opened / v.delivered : null);
  const aRate = openRate(a);
  const bRate = openRate(b);
  let winner = null;
  if (aRate != null && bRate != null && Math.abs(aRate - bRate) >= 0.005) {
    winner = aRate > bRate ? "a" : "b";
  }
  return (
    <div className="px-5 pb-4 -mt-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
      {" "}
      <VariantCell
        letter="A"
        subject={subjectA}
        stats={a}
        rate={aRate}
        isWinner={winner === "a"}
      />{" "}
      <VariantCell
        letter="B"
        subject={subjectB}
        stats={b}
        rate={bRate}
        isWinner={winner === "b"}
      />{" "}
    </div>
  );
}
function VariantCell({ letter, subject, stats, rate, isWinner }) {
  return (
    <div
      className={cn(
        "border-hairline rounded-sm p-3 bg-white",
        isWinner ? "border-zinc-900" : "border-zinc-200",
      )}
    >
      {" "}
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        {" "}
        <span className="text-ui-body uppercase tracking-label text-ink-secondary">
          Variant {letter}
        </span>
        {isWinner && <Badge tone="strong">Winner</Badge>}
      </div>{" "}
      <div className="text-ui-body text-zinc-900 mb-2 truncate" title={subject}>
        {subject || <em className="text-ink-tertiary">(missing)</em>}
      </div>
      {!stats ? (
        <div className="text-ui-body text-ink-tertiary">
          No deliveries recorded.
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {" "}
          <Stat label="Sent" value={stats.total} />{" "}
          <Stat label="Delivered" value={stats.delivered} />{" "}
          <Stat
            label="Opens"
            value={`${stats.opened}${rate != null ? ` (${(rate * 100).toFixed(0)}%)` : ""}`}
          />{" "}
          <Stat label="Clicks" value={stats.clicked} />{" "}
        </div>
      )}
    </div>
  );
}
function StatusChip({ status }) {
  if (status === "sent") return <Badge tone="strong">Sent</Badge>;
  if (status === "sending") return <Badge tone="neutral">Sending…</Badge>;
  if (status === "scheduled") return <Badge tone="neutral">Scheduled</Badge>;
  if (status === "failed") return <Badge tone="alert">Failed</Badge>;
  return <Badge tone="neutral">Draft</Badge>;
}
function Stat({ label, value, alert }) {
  return (
    <div className="text-right">
      {" "}
      <div
        className={cn(
          "u-nums font-medium",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>{" "}
      <div className="text-ui-body text-ink-tertiary">{label}</div>{" "}
    </div>
  );
}

// Render a rate fraction (0..1) as a percentage, or "—" when null/undefined
// (zero-denominator) so an unmeasured rate isn't shown as a misleading 0%.
function pctLabel(rate) {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

// Centered tile for the History aggregate summary strip.
function AggStat({ label, value, alert }) {
  return (
    <div className="bg-white px-3 py-2 text-center">
      <div
        className={cn(
          "u-nums text-16 font-medium",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>
      <div className="text-ui-body text-ink-tertiary">{label}</div>
    </div>
  );
}

// ── Subscribers ───────────────────────────────────────────────────

const SUBSCRIBERS_PAGE_SIZE = 100;
function subscriberQuery(filter, q, offset) {
  const qs = new URLSearchParams();
  if (filter !== "all") qs.set("status", filter);
  if (q) qs.set("q", q);
  qs.set("limit", String(SUBSCRIBERS_PAGE_SIZE));
  qs.set("offset", String(offset));
  return qs;
}
export function SubscribersView() {
  const [subs, setSubs] = useState([]);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState("active");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [statusError, setStatusError] = useState(false);
  const [importPreConsented, setImportPreConsented] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [importConfirmation, setImportConfirmation] = useState(null);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [unsubscribeTarget, setUnsubscribeTarget] = useState(null);
  const [unsubscribeError, setUnsubscribeError] = useState("");
  const [unsubscribing, setUnsubscribing] = useState(false);
  const importInputRef = useRef(null);
  const subscribersAbortRef = useRef(null);
  const addInFlightRef = useRef(false);
  const importInFlightRef = useRef(false);
  const unsubscribeInFlightRef = useRef(false);

  const showStatus = (message, error = false) => {
    setStatus(message);
    setStatusError(error);
  };
  const closeAddDialog = () => {
    if (addInFlightRef.current) return;
    setAddOpen(false);
    setAddEmail("");
    setAddError("");
  };
  const closeImportDialog = () => {
    if (importInFlightRef.current) return;
    setImportConfirmation(null);
    setImportError("");
  };
  const closeUnsubscribeDialog = () => {
    if (unsubscribeInFlightRef.current) return;
    setUnsubscribeTarget(null);
    setUnsubscribeError("");
  };

  // Initial / filter-changed fetch — resets the list. Re-runs whenever
  // the filter or search query changes (via the useEffect below). Each run
  // gets a new controller, which loadMore uses to drop a page that belongs
  // to an older query.
  const load = useCallback(() => {
    subscribersAbortRef.current?.abort();
    const controller = new AbortController();
    subscribersAbortRef.current = controller;
    setLoading(true);
    setLoadingMore(false);
    setLoadError("");
    const qs = subscriberQuery(filter, q, 0);
    adminFetch(`/admin/newsletter/subscribers?${qs}`, { signal: controller.signal })
      .then((d) => {
        if (controller.signal.aborted) return;
        const next = d.subscribers || [];
        setSubs(next);
        setCounts(d.counts || {});
        setOffset(next.length);
        setHasMore(next.length === SUBSCRIBERS_PAGE_SIZE);
      })
      .catch((e) => {
        if (controller.signal.aborted || e.name === "AbortError") return;
        // The rows on screen belong to the previous query, so they go; the
        // failure shows with Retry instead of reading as an empty filter.
        setSubs([]);
        setHasMore(false);
        setLoadError(e.message || "Subscribers could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, [filter, q]);
  useEffect(() => {
    load();
    return () => subscribersAbortRef.current?.abort();
  }, [load]);
  const loadMore = async () => {
    // The list's controller stands for its query: load() aborts and
    // replaces it on every filter or search change (and on unmount), so a
    // page that answers after that belongs to an old query and is dropped
    // before it can touch the rows, offset or hasMore.
    const listController = subscribersAbortRef.current;
    const stale = () =>
      subscribersAbortRef.current !== listController || listController.signal.aborted;
    if (!listController || stale()) return;
    setLoadingMore(true);
    const qs = subscriberQuery(filter, q, offset);
    try {
      const d = await adminFetch(`/admin/newsletter/subscribers?${qs}`);
      if (stale()) return;
      const next = d.subscribers || [];
      setSubs((prev) => [...prev, ...next]);
      setOffset((cur) => cur + next.length);
      setHasMore(next.length === SUBSCRIBERS_PAGE_SIZE);
    } catch (e) {
      if (stale()) return;
      showStatus("Load more failed: " + e.message, true);
    } finally {
      if (!stale()) setLoadingMore(false);
    }
  };
  const exportCsv = async () => {
    showStatus("Building CSV…");
    try {
      const qs = new URLSearchParams();
      if (filter !== "all") qs.set("status", filter);
      if (q) qs.set("q", q);
      // Bypass adminFetch's JSON parsing — this returns text/csv.
      const res = await fetch(
        `${API_BASE}/admin/newsletter/subscribers.csv?${qs}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showStatus("CSV downloaded.");
    } catch (e) {
      showStatus("Export failed: " + e.message, true);
    }
  };
  const addSubscriber = async () => {
    if (!addEmail || addInFlightRef.current) return;
    addInFlightRef.current = true;
    setAdding(true);
    setAddError("");
    try {
      await adminFetch("/admin/newsletter/subscribers", {
        method: "POST",
        body: JSON.stringify({ email: addEmail }),
      });
      showStatus(`Added ${addEmail}.`);
      setAddOpen(false);
      setAddEmail("");
      load();
    } catch (e) {
      setAddError("Failed: " + e.message);
    } finally {
      addInFlightRef.current = false;
      setAdding(false);
    }
  };
  const importCsv = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const subscribers = parseSubscriberCsv(await file.text());
      if (!subscribers.length) throw new Error("No subscriber rows found");
      setImportError("");
      setImportConfirmation({ subscribers, preConsented: importPreConsented });
    } catch (e) {
      showStatus("Import failed: " + e.message, true);
    }
  };
  const confirmImport = async () => {
    if (!importConfirmation || importInFlightRef.current) return;
    importInFlightRef.current = true;
    setImporting(true);
    setImportError("");
    const { subscribers, preConsented } = importConfirmation;
    try {
      const result = await adminFetch("/admin/newsletter/subscribers/import", {
        method: "POST",
        body: JSON.stringify({ subscribers, source: "admin_import", preConsented }),
      });
      showStatus(
        `Imported ${result.inserted.toLocaleString()} subscriber${result.inserted === 1 ? "" : "s"}; ${result.skipped.toLocaleString()} skipped or already present.`,
      );
      setImportConfirmation(null);
      load();
    } catch (e) {
      setImportError("Import failed: " + e.message);
    } finally {
      importInFlightRef.current = false;
      setImporting(false);
    }
  };
  const removeSubscriber = async () => {
    if (!unsubscribeTarget || unsubscribeInFlightRef.current) return;
    unsubscribeInFlightRef.current = true;
    setUnsubscribing(true);
    setUnsubscribeError("");
    try {
      await adminFetch(`/admin/newsletter/subscribers/${unsubscribeTarget.id}`, {
        method: "DELETE",
      });
      setUnsubscribeTarget(null);
      load();
    } catch (e) {
      setUnsubscribeError("Failed: " + e.message);
    } finally {
      unsubscribeInFlightRef.current = false;
      setUnsubscribing(false);
    }
  };
  return (
    <UiSurface density="comfortable" className="space-y-4">
      <Card className="p-0 overflow-hidden">
        {" "}
        <div className="flex items-start justify-between p-4 border-b border-hairline border-zinc-200 flex-wrap gap-3">
          {" "}
          <div>
            {" "}
            <h3 className="text-16 font-medium text-zinc-900">
              Subscribers
            </h3>{" "}
            <p className="text-ui-body text-ink-tertiary mt-0.5">
              Search the list, export filtered contacts, and manage opt-outs.
            </p>{" "}
          </div>{" "}
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              ref={importInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={importCsv}
              className="hidden"
              aria-label="Existing opt-in consent"
            />
            <label
              className="inline-flex items-center gap-1.5 text-ui-body text-ink-secondary"
              title="Leave unchecked for unverified lists; they remain pending and cannot receive campaigns."
            >
              <Checkbox
                checked={importPreConsented}
                onChange={(e) => setImportPreConsented(e.target.checked)}
                className="shrink-0"
              />
              Existing opt-in consent
            </label>
            <Button
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                importInputRef.current?.click();
              }}
              variant="secondary"
            >
              <Upload
                size={14}
                strokeWidth={1.75}
                className="mr-2"
                aria-hidden
              />
              Import CSV
            </Button>{" "}
            <Button onClick={exportCsv} variant="secondary">
              {" "}
              <Download
                size={14}
                strokeWidth={1.75}
                className="mr-2"
                aria-hidden
              />
              Export CSV
            </Button>{" "}
            <Button
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setAddError("");
                setAddOpen(true);
              }}
              variant="secondary"
            >
              {" "}
              <UserPlus
                size={14}
                strokeWidth={1.75}
                className="mr-2"
                aria-hidden
              />
              Add Subscriber
            </Button>{" "}
          </div>{" "}
        </div>{" "}
        <div className="p-4 border-b border-hairline border-zinc-100 flex items-center gap-2 flex-wrap">
          {["active", "pending", "unsubscribed", "bounced", "all"].map((f) => {
            const active = filter === f;
            const count =
              f === "all"
                ? (counts.all ??
                  Object.entries(counts)
                    .filter(([key]) => !["all", "bounced"].includes(key))
                    .reduce((sum, [, value]) => sum + Number(value || 0), 0))
                : counts[f] || 0;
            return (
              <Button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className="gap-1.5 rounded-full"
                    aria-pressed={active}
                    variant={active ? "primary" : "secondary"}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                <span
                  className={cn(
                    "u-nums text-ui-body",
                    active ? "text-zinc-300" : "text-ink-tertiary",
                  )}
                >
                  {count}
                </span>{" "}
              </Button>
            );
          })}
          <div className="relative w-full sm:w-72 sm:ml-auto">
            {" "}
            <Search
              size={14}
              strokeWidth={1.75}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
              aria-hidden
            />{" "}
            <Input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search email…"
              className="w-full pl-8"
              aria-label="Search email…"
            />{" "}
          </div>{" "}
        </div>
        {status && (
          <ActionFeedback error={statusError} className="mx-4 mt-3">
            {status}
          </ActionFeedback>
        )}
        {loading ? (
          <div className="text-ui-body text-ink-secondary p-6 text-center">
            Loading…
          </div>
        ) : loadError ? (
          <ActionFeedback error onRetry={load} className="m-4">
            Subscribers could not be loaded: {loadError}
          </ActionFeedback>
        ) : subs.length === 0 ? (
          <div className="text-ui-body text-ink-secondary p-8 text-center">
            No subscribers in this filter.
          </div>
        ) : (
          <div>
            {subs.map((s) => (
              <div
                key={s.id}
                className="px-4 py-3 border-b border-hairline border-zinc-200 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4"
              >
                {" "}
                <div className="flex-1 min-w-0">
                  {" "}
                  <div className="flex items-center gap-2">
                    {" "}
                    <span className="text-ui-body text-zinc-900 u-nums truncate">
                      {s.email}
                    </span>
                    {s.status === "unsubscribed" && (
                      <Badge tone="neutral">Unsubscribed</Badge>
                    )}
                    {s.status === "pending" && (
                      <Badge tone="neutral">Pending confirmation</Badge>
                    )}
                    {s.bounce_count > 0 && <Badge tone="alert">Bounced</Badge>}
                    {s.customer_id && <Badge tone="neutral">Customer</Badge>}
                  </div>{" "}
                  <div className="text-ui-body text-ink-tertiary">
                    {s.first_name || s.last_name
                      ? `${s.first_name || ""} ${s.last_name || ""}`.trim() +
                        " · "
                      : ""}
                    Source: {s.source || "unknown"} · Joined{" "}
                    {new Date(s.subscribed_at).toLocaleDateString()}
                    {s.bounce_count > 0 &&
                      ` · ${s.bounce_count} bounce${s.bounce_count === 1 ? "" : "s"}`}
                  </div>{" "}
                </div>
                {s.status === "active" && (
                  <Button
                    type="button"
                    onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      setUnsubscribeError("");
                      setUnsubscribeTarget({ id: s.id, email: s.email });
                    }}
                    className=""
                    variant="secondary"
                  >
                    Unsubscribe
                  </Button>
                )}
              </div>
            ))}
            {hasMore && (
              <div className="px-5 py-4 text-center">
                {" "}
                <Button
                  onClick={loadMore}
                  variant="secondary"
                  disabled={loadingMore}
                >
                  {loadingMore
                    ? "Loading…"
                    : `Load ${SUBSCRIBERS_PAGE_SIZE} more`}
                </Button>{" "}
              </div>
            )}
            {!hasMore && subs.length > SUBSCRIBERS_PAGE_SIZE && (
              <div className="px-5 py-4 text-center text-ui-body text-ink-tertiary">
                Showing all {subs.length} subscriber
                {subs.length === 1 ? "" : "s"} in this filter.
              </div>
            )}
          </div>
        )}
      </Card>
      <Dialog
        open={addOpen}
        onClose={closeAddDialog}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>Add subscriber</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); addSubscriber(); }}>
          <DialogBody className="space-y-3">
            <Field label="Email address" required>
              <Input
                autoFocus
                type="text"
                inputMode="email"
                value={addEmail}
                onChange={(event) => setAddEmail(event.target.value)}
              />
            </Field>
            {addError && <ActionFeedback error>{addError}</ActionFeedback>}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={closeAddDialog} disabled={adding}>
              Cancel
            </Button>
            <Button type="submit" loading={adding} disabled={!addEmail}>
              Add subscriber
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      <Dialog
        open={Boolean(importConfirmation)}
        onClose={closeImportDialog}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>Import subscribers?</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); confirmImport(); }}>
          <DialogBody className="space-y-3">
            {importConfirmation && (
              <p className="text-ui-body text-ink-secondary">
                Import {importConfirmation.subscribers.length.toLocaleString()} subscriber rows as{" "}
                {importConfirmation.preConsented
                  ? "active and immediately mailable"
                  : "pending confirmation"}?
              </p>
            )}
            {importError && <ActionFeedback error>{importError}</ActionFeedback>}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={closeImportDialog} disabled={importing}>
              Cancel
            </Button>
            <Button type="submit" loading={importing} autoFocus>
              Import subscribers
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      <Dialog
        open={Boolean(unsubscribeTarget)}
        onClose={closeUnsubscribeDialog}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>Unsubscribe subscriber?</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); removeSubscriber(); }}>
          <DialogBody className="space-y-3">
            {unsubscribeTarget && (
              <p className="text-ui-body text-ink-secondary u-nums">
                Unsubscribe {unsubscribeTarget.email}?
              </p>
            )}
            {unsubscribeError && <ActionFeedback error>{unsubscribeError}</ActionFeedback>}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={closeUnsubscribeDialog} disabled={unsubscribing}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={unsubscribing} autoFocus>
              Unsubscribe
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </UiSurface>
  );
}
