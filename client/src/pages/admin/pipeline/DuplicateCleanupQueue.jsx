import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle2, History, Link2, RefreshCw, SearchX, XCircle } from "lucide-react";
import { Badge, Button, cn } from "../../../components/ui";
import { defaultCandidateId, rankCandidateMatches } from "./duplicateCleanup";

function compactId(id) {
  if (!id) return "";
  return String(id).slice(0, 8);
}

function contactLine(record) {
  return [record?.phone, record?.email].filter(Boolean).join(" / ") || "No contact info";
}

function MatchBadges({ match }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {match.exactPhone && <Badge tone="neutral">Phone</Badge>}
      {match.exactEmail && <Badge tone="neutral">Email</Badge>}
      {match.exactAddress && <Badge tone="neutral">Address</Badge>}
      {match.alreadyLinked && <Badge tone="alert">Already Linked</Badge>}
      {match.highConfidence && <Badge tone="strong">High Confidence</Badge>}
    </div>
  );
}

const DISMISS_REASONS = [
  { value: "not_same_customer", label: "Not same customer" },
  { value: "bad_match", label: "Bad match" },
  { value: "already_handled", label: "Already handled" },
  { value: "other", label: "Other" },
];

const DISMISS_REASON_LABELS = {
  not_same_customer: "Not same customer",
  bad_match: "Bad match",
  already_handled: "Already handled",
  other: "Other",
};

function formatHistoryTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(date);
}

function ReviewedHistoryPanel({ adminFetch, refreshKey, onReopened }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [feedback, setFeedback] = useState(null);

  async function loadHistory({ silent = false } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    setFeedback(null);
    try {
      const data = await adminFetch("/admin/pipeline/opportunities/reviewed-history?limit=8");
      setItems(data.data || []);
    } catch (err) {
      setError(err);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await adminFetch("/admin/pipeline/opportunities/reviewed-history?limit=8");
        if (!ignore) setItems(data.data || []);
      } catch (err) {
        if (!ignore) setError(err);
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [adminFetch, refreshKey]);

  async function reopenItem(item) {
    if (!item?.estimateId || !item?.leadId || busyKey) return;
    const key = `${item.action}-${item.id}`;
    setBusyKey(key);
    setFeedback(null);
    try {
      await adminFetch("/admin/pipeline/opportunities/reviewed-history/reopen", {
        method: "POST",
        body: JSON.stringify({
          action: item.action,
          estimateId: item.estimateId,
          leadId: item.leadId,
        }),
      });
      setFeedback({
        type: "success",
        message: item.action === "linked" ? "Link reopened." : "Dismissal reopened.",
      });
      await loadHistory({ silent: true });
      onReopened?.();
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="border-b border-hairline border-zinc-200 bg-zinc-50 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-13 font-medium text-zinc-900">
          <History size={15} strokeWidth={1.8} aria-hidden />
          Reviewed History
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="gap-2"
          onClick={() => loadHistory({ silent: true })}
          disabled={loading}
        >
          <RefreshCw size={13} strokeWidth={1.8} aria-hidden />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-12 text-ink-secondary">
          <RefreshCw size={13} strokeWidth={1.8} className="animate-spin" aria-hidden />
          Loading reviewed decisions
        </div>
      ) : error ? (
        <div className="mt-3 rounded-sm border-hairline border-alert-fg/30 bg-red-50 p-2 text-12 text-alert-fg">
          Reviewed history failed: {error.message}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-3 text-12 text-ink-secondary">No reviewed decisions yet.</div>
      ) : (
        <>
          {feedback && (
            <div
              className={cn(
                "mt-3 rounded-xs border-hairline px-2 py-1 text-11",
                feedback.type === "error"
                  ? "border-alert-fg/30 bg-red-50 text-alert-fg"
                  : "border-emerald-300 bg-emerald-50 text-emerald-800",
              )}
              role="status"
            >
              {feedback.message}
            </div>
          )}
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {items.map((item) => {
              const key = `${item.action}-${item.id}`;
              const canReopen = Boolean(item.estimateId && item.leadId);
              return (
                <div key={key} className="rounded-sm border-hairline border-zinc-200 bg-white p-3 text-12">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={item.action === "linked" ? "strong" : "neutral"}>
                      {item.action === "linked" ? "Linked" : "Dismissed"}
                    </Badge>
                    {item.estimateId && <span className="text-ink-secondary">{item.estimateRef || `Est ${compactId(item.estimateId)}`}</span>}
                    {item.leadId && <span className="text-ink-secondary">{item.leadRef || `Lead ${compactId(item.leadId)}`}</span>}
                  </div>
                  {(item.customerName || item.estimateLabel || item.leadLabel) && (
                    <div className="mt-2 font-medium text-zinc-900">
                      {item.customerName || item.estimateLabel || item.leadLabel}
                    </div>
                  )}
                  {(item.estimateLabel || item.leadLabel) && (
                    <div className="mt-1 text-11 text-ink-tertiary">
                      {[item.estimateLabel && `Estimate: ${item.estimateLabel}`, item.leadLabel && `Lead: ${item.leadLabel}`]
                        .filter(Boolean)
                        .join(" / ")}
                    </div>
                  )}
                  <div className="mt-2 text-ink-secondary">
                    {item.action === "dismissed"
                      ? DISMISS_REASON_LABELS[item.reason] || "Dismissed"
                      : "Lead and estimate linked"}
                    {item.hasNote ? " with note" : ""}
                  </div>
                  <div className="mt-1 text-11 text-ink-tertiary">
                    {[item.actor, formatHistoryTime(item.createdAt)].filter(Boolean).join(" / ")}
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    disabled={!canReopen || Boolean(busyKey)}
                    onClick={() => reopenItem(item)}
                  >
                    {busyKey === key ? "Reopening" : item.action === "linked" ? "Undo Link" : "Reopen"}
                  </Button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function QueueRow({ opportunity, adminFetch, onDismissed, onLinked }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [dismissedCount, setDismissedCount] = useState(0);
  const [selectedLeadId, setSelectedLeadId] = useState("");
  const [dismissReason, setDismissReason] = useState("not_same_customer");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    let ignore = false;

    async function loadCandidates() {
      setLoading(true);
      setError(null);
      setFeedback(null);
      try {
        const data = await adminFetch(`/admin/pipeline/opportunities/${opportunity.estimateId}/link-candidates`);
        if (ignore) return;
        const ranked = rankCandidateMatches(data.estimate, data.candidates || []);
        setEstimate(data.estimate || null);
        setCandidates(ranked);
        setDismissedCount(data.dismissedCount || 0);
        setSelectedLeadId(defaultCandidateId(data.estimate, ranked));
      } catch (err) {
        if (!ignore) setError(err);
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    if (opportunity.estimateId) loadCandidates();

    return () => {
      ignore = true;
    };
  }, [adminFetch, opportunity.estimateId]);

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.leadId === selectedLeadId),
    [candidates, selectedLeadId],
  );
  const canLink = Boolean(selectedCandidate && !selectedCandidate.match.alreadyLinked);

  async function linkSelected() {
    if (!canLink || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await adminFetch("/admin/pipeline/opportunities/link", {
        method: "POST",
        body: JSON.stringify({
          leadId: selectedLeadId,
          estimateId: opportunity.estimateId,
        }),
      });
      setFeedback({ type: "success", message: "Linked. This row will leave the cleanup queue." });
      onLinked?.(opportunity.estimateId);
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function dismissDuplicateRisk() {
    if (!selectedLeadId || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await adminFetch(`/admin/pipeline/opportunities/${opportunity.estimateId}/dismiss-duplicate-risk`, {
        method: "POST",
        body: JSON.stringify({
          leadId: selectedLeadId || null,
          reason: dismissReason,
        }),
      });
      setFeedback({ type: "success", message: "Dismissed. Refreshing the remaining candidates." });
      onDismissed?.();
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-hairline border-zinc-200 p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.9fr)_minmax(360px,1.4fr)_auto]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone="alert">Duplicate Risk</Badge>
            {opportunity.estimateId && <Badge tone="neutral">Est {compactId(opportunity.estimateId)}</Badge>}
          </div>
          <div className="mt-3 font-medium text-zinc-900">{estimate?.name || opportunity.name || "Unknown Customer"}</div>
          <div className="mt-1 text-12 text-ink-secondary">{contactLine(estimate || opportunity)}</div>
          <div className="mt-1 text-12 text-ink-tertiary">{estimate?.address || opportunity.address || "No address"}</div>
          <div className="mt-3 text-11 leading-4 text-ink-tertiary">
            Pick the matching lead before linking. Name-only matches are shown for review but are not preselected.
          </div>
          {dismissedCount > 0 && (
            <div className="mt-2 text-11 leading-4 text-ink-tertiary">
              {dismissedCount} dismissed match{dismissedCount === 1 ? "" : "es"} hidden.
            </div>
          )}
        </div>

        <div>
          {loading ? (
            <div className="flex items-center gap-2 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-12 text-ink-secondary">
              <RefreshCw size={14} strokeWidth={1.8} className="animate-spin" aria-hidden />
              Loading candidates
            </div>
          ) : error ? (
            <div className="rounded-sm border-hairline border-alert-fg/30 bg-red-50 p-3 text-12 text-alert-fg">
              Candidate lookup failed: {error.message}
            </div>
          ) : candidates.length === 0 ? (
            <div className="flex items-center gap-2 rounded-sm border-hairline border-amber-300 bg-amber-50 p-3 text-12 text-amber-900">
              <SearchX size={14} strokeWidth={1.8} aria-hidden />
              No candidates found
            </div>
          ) : (
            <div className="space-y-2">
              {candidates.map((candidate) => (
                <label
                  key={candidate.leadId}
                  className={cn(
                    "block rounded-sm border-hairline p-3 text-12",
                    candidate.match.alreadyLinked ? "bg-zinc-50 opacity-75" : "cursor-pointer bg-white hover:bg-zinc-50",
                    selectedLeadId === candidate.leadId ? "border-zinc-900" : "border-zinc-200",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      name={`cleanup-lead-${opportunity.estimateId}`}
                      value={candidate.leadId}
                      checked={selectedLeadId === candidate.leadId}
                      disabled={candidate.match.alreadyLinked}
                      onChange={() => {
                        setSelectedLeadId(candidate.leadId);
                        setFeedback(null);
                      }}
                      className="mt-1"
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-zinc-900">{candidate.name}</div>
                      <div className="mt-1 text-ink-secondary">{contactLine(candidate)}</div>
                      <div className="mt-1 text-ink-tertiary">{candidate.address || "No address"}</div>
                      <div className="mt-1 text-ink-tertiary">
                        {[candidate.serviceInterest, candidate.source, candidate.status].filter(Boolean).join(" / ")}
                      </div>
                      <MatchBadges match={candidate.match} />
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex min-w-[150px] flex-col items-stretch justify-start gap-2">
          <Button className="gap-2" onClick={linkSelected} disabled={!canLink || busy || loading}>
            <Link2 size={14} strokeWidth={1.9} aria-hidden />
            {busy ? "Linking" : "Link Selected"}
          </Button>
          <label className="block">
            <span className="sr-only">Dismiss reason</span>
            <select
              value={dismissReason}
              onChange={(event) => setDismissReason(event.target.value)}
              disabled={busy}
              className="h-9 w-full rounded-sm border-hairline border-zinc-300 bg-white px-2 text-12 text-zinc-900 u-focus-ring"
            >
              {DISMISS_REASONS.map((reason) => (
                <option key={reason.value} value={reason.value}>{reason.label}</option>
              ))}
            </select>
          </label>
          <Button variant="secondary" className="gap-2" onClick={dismissDuplicateRisk} disabled={!selectedLeadId || busy || loading}>
            <XCircle size={14} strokeWidth={1.9} aria-hidden />
            Not a Duplicate
          </Button>
          {selectedCandidate?.match.highConfidence && (
            <div className="flex items-start gap-1 text-11 leading-4 text-emerald-800">
              <CheckCircle2 size={13} strokeWidth={1.8} className="mt-0.5 flex-shrink-0" aria-hidden />
              Exact phone or email match
            </div>
          )}
          {feedback && (
            <div
              className={cn(
                "rounded-xs border-hairline px-2 py-1 text-11",
                feedback.type === "error"
                  ? "border-alert-fg/30 bg-red-50 text-alert-fg"
                  : "border-emerald-300 bg-emerald-50 text-emerald-800",
              )}
              role="status"
            >
              {feedback.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DuplicateCleanupQueue({ opportunities, adminFetch, onRefresh }) {
  const [resolvedEstimateIds, setResolvedEstimateIds] = useState(() => new Set());
  const [historyVersion, setHistoryVersion] = useState(0);
  const visibleOpportunities = opportunities.filter((opportunity) => !resolvedEstimateIds.has(opportunity.estimateId));

  function refreshHistory() {
    setHistoryVersion((version) => version + 1);
  }

  function handleResolved(estimateId) {
    setResolvedEstimateIds((current) => {
      const next = new Set(current);
      next.add(estimateId);
      return next;
    });
    refreshHistory();
    onRefresh?.();
  }

  function handleDismissed() {
    refreshHistory();
    onRefresh?.();
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline border-zinc-200 p-4">
        <div>
          <div className="text-14 font-medium text-zinc-900">Duplicate Cleanup Queue</div>
          <div className="mt-1 text-12 text-ink-secondary">
            Review likely standalone estimates and link them to the correct lead.
          </div>
        </div>
        <Badge tone="neutral">{visibleOpportunities.length} visible</Badge>
      </div>

      <ReviewedHistoryPanel adminFetch={adminFetch} refreshKey={historyVersion} onReopened={handleDismissed} />

      {visibleOpportunities.length === 0 ? (
        <div className="p-10 text-center text-13 text-ink-secondary">
          No duplicate-risk opportunities remain on this page.
        </div>
      ) : (
        visibleOpportunities.map((opportunity) => (
          <QueueRow
            key={opportunity.opportunityId}
            opportunity={opportunity}
            adminFetch={adminFetch}
            onDismissed={handleDismissed}
            onLinked={handleResolved}
          />
        ))
      )}
    </div>
  );
}
