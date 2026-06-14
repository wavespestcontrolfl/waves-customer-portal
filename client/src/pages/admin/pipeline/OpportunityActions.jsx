import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from "../../../components/ui";
import { PIPELINE_STAGES } from "./pipelineStages";

function appendParam(params, key, value) {
  if (value !== null && value !== undefined && value !== "") params.set(key, value);
}

function createEstimateUrl(opportunity) {
  const params = new URLSearchParams();
  params.set("tab", "new");
  appendParam(params, "leadId", opportunity.leadId);
  appendParam(params, "customerId", opportunity.customerId);
  appendParam(params, "address", opportunity.address);
  appendParam(params, "customerName", opportunity.name === "Unknown Customer" ? "" : opportunity.name);
  appendParam(params, "customerPhone", opportunity.phone);
  appendParam(params, "customerEmail", opportunity.email);
  appendParam(params, "serviceInterest", opportunity.serviceInterest);
  return `/admin/estimates?${params.toString()}`;
}

function communicationUrl(opportunity) {
  const params = new URLSearchParams();
  appendParam(params, "phone", opportunity.phone);
  appendParam(params, "customerId", opportunity.customerId);
  appendParam(params, "leadId", opportunity.leadId);
  return `/admin/communications${params.toString() ? `?${params.toString()}` : ""}`;
}

function estimateSendIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `estimate-send-${Date.now()}-${Math.random()}`;
}

function actionConfig(kind, opportunity) {
  const name = opportunity.name || "this customer";
  switch (kind) {
    case "send_estimate":
      return {
        title: "Send estimate",
        description: `Send this estimate to ${name} by email and SMS now.`,
        confirmLabel: "Send Estimate",
        tone: "primary",
      };
    case "mark_accepted":
      return {
        title: "Mark accepted",
        description: `Mark ${name} as accepted from a verbal yes.`,
        confirmLabel: "Mark Accepted",
        tone: "primary",
      };
    case "mark_annual_prepay":
      return {
        title: "Mark annual prepay",
        description: `Mark ${name} as accepted for annual prepay. This creates a pending annual prepay invoice and renewal term, but does not text, email, or auto-schedule the customer.`,
        confirmLabel: "Mark Annual Prepay",
        tone: "primary",
      };
    case "decline_estimate":
      return {
        title: "Mark estimate declined",
        description: "Record why this estimate was declined.",
        confirmLabel: "Mark Declined",
        reasonLabel: "Decline reason",
        reasonPlaceholder: "Price, timing, chose another provider...",
        reasonRequired: true,
        tone: "danger",
      };
    case "extend_estimate":
      return {
        title: "Extend expiration",
        description: "Choose how many days to extend this estimate.",
        confirmLabel: "Extend",
        daysLabel: "Days",
        defaultDays: "7",
        tone: "primary",
      };
    case "mark_lead_lost":
      return {
        title: "Mark lead lost",
        description: "Record why this lead was lost.",
        confirmLabel: "Mark Lost",
        reasonLabel: "Lost reason",
        reasonPlaceholder: "Not serviceable, no response, price, timing...",
        reasonRequired: true,
        tone: "danger",
      };
    case "link_lead":
      return {
        title: "Link matching lead",
        description: "Confirm which lead should be attached to this estimate. The two rows will collapse into one opportunity after linking.",
        confirmLabel: "Link Lead",
        tone: "primary",
      };
    default:
      return null;
  }
}

function primaryAction(opportunity) {
  switch (opportunity.stage) {
    case PIPELINE_STAGES.NEW_LEAD:
      return { label: "Contact", kind: "navigate", to: communicationUrl(opportunity) };
    case PIPELINE_STAGES.CONTACTED:
    case PIPELINE_STAGES.QUALIFIED:
    case PIPELINE_STAGES.ESTIMATE_NEEDED:
      return { label: "Create Estimate", kind: "navigate", to: createEstimateUrl(opportunity) };
    case PIPELINE_STAGES.ESTIMATE_DRAFT:
      return opportunity.estimateId
        ? { label: "Send Estimate", kind: "send_estimate" }
        : { label: "Create Estimate", kind: "navigate", to: createEstimateUrl(opportunity) };
    case PIPELINE_STAGES.ESTIMATE_SENT:
    case PIPELINE_STAGES.ESTIMATE_VIEWED:
      return opportunity.estimateId
        ? { label: "Follow Up", kind: "follow_up" }
        : { label: "Contact", kind: "navigate", to: communicationUrl(opportunity) };
    case PIPELINE_STAGES.WON:
      return { label: "Schedule", kind: "navigate", to: "/admin/schedule" };
    case PIPELINE_STAGES.LOST:
      return { label: "View Details", kind: "navigate", to: opportunity.estimateId ? "/admin/estimates?tab=estimates" : "/admin/leads" };
    default:
      return { label: "Open", kind: "navigate", to: "/admin/estimates" };
  }
}

function menuActions(opportunity) {
  const actions = [{ label: "View History", kind: "view_history" }];
  if (opportunity.leadId) actions.push({ label: "Open Legacy Leads", kind: "navigate", to: "/admin/leads" });
  if (opportunity.estimateId) actions.push({ label: "Open Legacy Estimates", kind: "navigate", to: "/admin/estimates?tab=estimates" });
  if (opportunity.customerId) actions.push({ label: "Open Customer", kind: "navigate", to: `/admin/customers?customerId=${encodeURIComponent(opportunity.customerId)}` });
  if (opportunity.stage !== PIPELINE_STAGES.ESTIMATE_NEEDED && opportunity.leadId) {
    actions.push({ label: "Create Estimate", kind: "navigate", to: createEstimateUrl(opportunity) });
  }
  if (opportunity.estimateId) {
    if (opportunity.isDuplicateRisk && !opportunity.leadId) {
      actions.push({ label: "Link Matching Lead", kind: "link_lead" });
    }
    if (opportunity.stage === PIPELINE_STAGES.ESTIMATE_DRAFT) {
      actions.push({ label: "Edit Estimate", kind: "navigate", to: "/admin/estimates?tab=estimates" });
    }
    if ([PIPELINE_STAGES.ESTIMATE_SENT, PIPELINE_STAGES.ESTIMATE_VIEWED].includes(opportunity.stage)) {
      actions.push({ label: "Follow Up", kind: "follow_up" });
    }
    if ([PIPELINE_STAGES.ESTIMATE_SENT, PIPELINE_STAGES.ESTIMATE_VIEWED].includes(opportunity.stage)) {
      actions.push({ label: "Mark Accepted", kind: "mark_accepted" });
      actions.push({ label: "Mark Annual Prepay", kind: "mark_annual_prepay" });
      actions.push({ label: "Mark Declined", kind: "decline_estimate" });
    }
    if ([PIPELINE_STAGES.ESTIMATE_SENT, PIPELINE_STAGES.ESTIMATE_VIEWED, PIPELINE_STAGES.LOST].includes(opportunity.stage)) {
      actions.push({ label: "Extend Expiration", kind: "extend_estimate" });
    }
  }
  if (opportunity.leadId && opportunity.status !== "lost" && opportunity.status !== "won") {
    actions.push({ label: "Mark Lead Lost", kind: "mark_lead_lost" });
  }
  if (opportunity.phone) actions.push({ label: "Message", kind: "navigate", to: communicationUrl(opportunity) });
  return actions;
}

function formatHistoryDate(value) {
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

function historyQuery(opportunity) {
  const params = new URLSearchParams();
  appendParam(params, "opportunityId", opportunity.opportunityId);
  appendParam(params, "leadId", opportunity.leadId);
  appendParam(params, "estimateId", opportunity.estimateId);
  params.set("limit", "80");
  return params.toString();
}

export default function OpportunityActions({ opportunity, onRefresh, adminFetch }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("7");
  const [feedback, setFeedback] = useState(null);
  const [linkCandidates, setLinkCandidates] = useState([]);
  const [linkEstimate, setLinkEstimate] = useState(null);
  const [selectedLeadId, setSelectedLeadId] = useState("");
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [history, setHistory] = useState(null);
  const action = primaryAction(opportunity);
  const missingEstimateReadyFields = !opportunity.address || !opportunity.serviceInterest || (!opportunity.phone && !opportunity.email);
  const pendingConfig = pendingAction ? actionConfig(pendingAction.kind, opportunity) : null;

  async function runPrimary() {
    await runAction(action);
  }

  async function openDialog(item) {
    const config = actionConfig(item.kind, opportunity);
    if (!config) return false;
    setReason("");
    setDays(config.defaultDays || "7");
    setFeedback(null);
    setLinkCandidates([]);
    setLinkEstimate(null);
    setSelectedLeadId("");
    setPendingAction(item);
    if (item.kind === "link_lead") {
      setLoadingCandidates(true);
      try {
        const data = await adminFetch(`/admin/pipeline/opportunities/${opportunity.estimateId}/link-candidates`);
        setLinkEstimate(data.estimate || null);
        setLinkCandidates(data.candidates || []);
        setSelectedLeadId(data.candidates?.[0]?.leadId || "");
      } catch (err) {
        showFeedback("error", `Candidate lookup failed: ${err.message}`);
      } finally {
        setLoadingCandidates(false);
      }
    }
    return true;
  }

  function showFeedback(type, message) {
    setFeedback({ type, message });
  }

  function closePendingAction() {
    if (busy) return;
    setPendingAction(null);
    if (feedback?.type === "error") setFeedback(null);
  }

  async function performAction(item, payload = {}) {
    if (item.kind === "follow_up") {
      await adminFetch(`/admin/estimates/${opportunity.estimateId}/follow-up`, { method: "POST" });
      return "Follow-up logged.";
    }
    if (item.kind === "send_estimate") {
      await adminFetch(`/admin/estimates/${opportunity.estimateId}/send`, {
        method: "POST",
        body: JSON.stringify({
          sendMethod: "both",
          idempotencyKey: estimateSendIdempotencyKey(),
        }),
      });
      return "Estimate sent.";
    }
    if (item.kind === "mark_accepted") {
      await adminFetch(`/admin/estimates/${opportunity.estimateId}/mark-accepted`, {
        method: "POST",
        body: JSON.stringify({ source: "pipeline_verbal_yes" }),
      });
      return "Estimate marked accepted.";
    }
    if (item.kind === "mark_annual_prepay") {
      await adminFetch(`/admin/estimates/${opportunity.estimateId}/mark-accepted`, {
        method: "POST",
        body: JSON.stringify({
          source: "pipeline_verbal_annual_prepay",
          billingTerm: "prepay_annual",
        }),
      });
      return "Annual prepay marked accepted.";
    }
    if (item.kind === "decline_estimate") {
      await adminFetch(`/admin/estimates/${opportunity.estimateId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "declined", declineReason: payload.reason }),
      });
      return "Estimate marked declined.";
    }
    if (item.kind === "extend_estimate") {
      await adminFetch(`/admin/estimates/${opportunity.estimateId}/extend`, {
        method: "POST",
        body: JSON.stringify({ days: payload.days }),
      });
      return "Estimate expiration extended.";
    }
    if (item.kind === "mark_lead_lost") {
      await adminFetch(`/admin/leads/${opportunity.leadId}/lost`, {
        method: "POST",
        body: JSON.stringify({ reason: payload.reason }),
      });
      return "Lead marked lost.";
    }
    if (item.kind === "link_lead") {
      await adminFetch("/admin/pipeline/opportunities/link", {
        method: "POST",
        body: JSON.stringify({
          leadId: payload.leadId,
          estimateId: opportunity.estimateId,
        }),
      });
      return "Lead linked to estimate.";
    }
    return "Action completed.";
  }

  async function runAction(item) {
    if (busy) return;
    if (item.kind === "navigate") {
      navigate(item.to);
      return;
    }
    if (item.kind === "view_history") {
      setHistoryOpen(true);
      setHistoryLoading(true);
      setHistoryError(null);
      setHistory(null);
      try {
        const data = await adminFetch(`/admin/pipeline/opportunities/history?${historyQuery(opportunity)}`);
        setHistory(data);
      } catch (err) {
        setHistoryError(err);
      } finally {
        setHistoryLoading(false);
      }
      return;
    }
    if (item.kind === "follow_up") {
      if (!opportunity.estimateId) {
        navigate(communicationUrl(opportunity));
        return;
      }
      setBusy(true);
      try {
        const message = await performAction(item);
        showFeedback("success", message);
        onRefresh?.();
      } catch (err) {
        showFeedback("error", `Follow-up failed: ${err.message}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (await openDialog(item)) {
      return;
    }
  }

  async function confirmPendingAction() {
    if (!pendingAction || !pendingConfig || busy) return;
    const trimmedReason = reason.trim();
    if (pendingConfig.reasonRequired && !trimmedReason) {
      showFeedback("error", `${pendingConfig.reasonLabel} is required.`);
      return;
    }
    let parsedDays = null;
    if (pendingAction.kind === "extend_estimate") {
      parsedDays = Number.parseInt(days, 10);
      if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 180) {
        showFeedback("error", "Enter a whole number of days between 1 and 180.");
        return;
      }
    }
    if (pendingAction.kind === "link_lead" && !selectedLeadId) {
      showFeedback("error", "Choose a lead to link.");
      return;
    }
    setBusy(true);
    try {
      const message = await performAction(pendingAction, {
        reason: trimmedReason,
        days: parsedDays,
        leadId: selectedLeadId,
      });
      setPendingAction(null);
      showFeedback("success", message);
      onRefresh?.();
    } catch (err) {
      showFeedback("error", `${pendingConfig.title} failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={runPrimary}
            disabled={busy}
            title={action.label === "Create Estimate" && missingEstimateReadyFields
              ? "Missing address, service, or contact info. The estimate form will still open with available fields."
              : undefined}
            className={cn("whitespace-nowrap", missingEstimateReadyFields && action.label === "Create Estimate" && "border-alert-fg text-alert-fg")}
          >
            {busy ? "Working" : action.label}
          </Button>
          <details className="relative">
            <summary className="list-none inline-flex h-11 sm:h-7 w-9 sm:w-7 items-center justify-center rounded-xs border-hairline border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 u-focus-ring cursor-pointer">
              <MoreHorizontal size={16} strokeWidth={1.8} aria-hidden />
              <span className="sr-only">More actions</span>
            </summary>
            <div className="absolute right-0 z-30 mt-2 w-56 rounded-sm border-hairline border-zinc-200 bg-white shadow-lg p-1">
              {menuActions(opportunity).map((item) => (
                <button
                  key={`${item.label}-${item.kind}-${item.to || ""}`}
                  type="button"
                  onClick={() => runAction(item)}
                  className="w-full flex items-center justify-between gap-2 rounded-xs px-3 py-2 text-left text-12 text-zinc-700 hover:bg-zinc-50 u-focus-ring"
                >
                  <span>{item.label}</span>
                  {item.kind === "navigate" && <ExternalLink size={13} strokeWidth={1.8} aria-hidden />}
                </button>
              ))}
            </div>
          </details>
        </div>
        {feedback && (
          <div
            className={cn(
              "max-w-[260px] rounded-xs border-hairline px-2 py-1 text-left text-11",
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

      <Dialog open={!!pendingAction} onClose={closePendingAction} size="sm">
        <DialogHeader>
          <DialogTitle>{pendingConfig?.title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="m-0 text-13 leading-5 text-ink-secondary">{pendingConfig?.description}</p>
          {pendingConfig?.reasonLabel && (
            <label className="block">
              <span className="mb-1 block text-12 font-medium text-zinc-800">{pendingConfig.reasonLabel}</span>
              <textarea
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  if (feedback?.type === "error") setFeedback(null);
                }}
                placeholder={pendingConfig.reasonPlaceholder}
                rows={4}
                className="w-full rounded-sm border-hairline border-zinc-300 px-3 py-2 text-13 text-zinc-900 placeholder:text-ink-tertiary u-focus-ring"
              />
            </label>
          )}
          {pendingConfig?.daysLabel && (
            <label className="block">
              <span className="mb-1 block text-12 font-medium text-zinc-800">{pendingConfig.daysLabel}</span>
              <input
                type="number"
                min="1"
                max="180"
                step="1"
                value={days}
                onChange={(event) => {
                  setDays(event.target.value);
                  if (feedback?.type === "error") setFeedback(null);
                }}
                className="w-full rounded-sm border-hairline border-zinc-300 px-3 py-2 text-13 text-zinc-900 u-focus-ring"
              />
            </label>
          )}
          {pendingAction?.kind === "link_lead" && (
            <div className="space-y-3">
              {linkEstimate && (
                <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-12 text-zinc-700">
                  <div className="font-medium text-zinc-900">{linkEstimate.name}</div>
                  <div className="mt-1 text-ink-secondary">
                    {[linkEstimate.phone, linkEstimate.email].filter(Boolean).join(" / ") || "No contact info"}
                  </div>
                  <div className="mt-1 text-ink-tertiary">{linkEstimate.address || "No address"}</div>
                </div>
              )}
              {loadingCandidates ? (
                <div className="text-12 text-ink-secondary">Loading matching leads...</div>
              ) : linkCandidates.length === 0 ? (
                <div className="rounded-xs border-hairline border-amber-300 bg-amber-50 px-3 py-2 text-12 text-amber-900">
                  No likely lead matches were found. Open the legacy lead and estimate views to link manually.
                </div>
              ) : (
                <div className="space-y-2">
                  {linkCandidates.map((candidate) => (
                    <label
                      key={candidate.leadId}
                      className={cn(
                        "block cursor-pointer rounded-sm border-hairline p-3 text-12",
                        selectedLeadId === candidate.leadId ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white hover:bg-zinc-50",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="radio"
                          name={`link-lead-${opportunity.estimateId}`}
                          value={candidate.leadId}
                          checked={selectedLeadId === candidate.leadId}
                          onChange={() => {
                            setSelectedLeadId(candidate.leadId);
                            if (feedback?.type === "error") setFeedback(null);
                          }}
                          className="mt-1"
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-zinc-900">{candidate.name}</div>
                          <div className="mt-1 text-ink-secondary">
                            {[candidate.phone, candidate.email].filter(Boolean).join(" / ") || "No contact info"}
                          </div>
                          <div className="mt-1 text-ink-tertiary">{candidate.address || "No address"}</div>
                          <div className="mt-1 text-ink-tertiary">
                            {[candidate.serviceInterest, candidate.source, candidate.status].filter(Boolean).join(" / ")}
                          </div>
                          {candidate.estimateId && (
                            <div className="mt-2 text-alert-fg">Already linked to another estimate.</div>
                          )}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {feedback?.type === "error" && (
            <div className="rounded-xs border-hairline border-alert-fg/30 bg-red-50 px-3 py-2 text-12 text-alert-fg">
              {feedback.message}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={closePendingAction} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={pendingConfig?.tone === "danger" ? "danger" : "primary"}
            onClick={confirmPendingAction}
            disabled={busy || loadingCandidates || (pendingAction?.kind === "link_lead" && linkCandidates.length === 0)}
          >
            {busy ? "Working" : pendingConfig?.confirmLabel}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} size="lg">
        <DialogHeader>
          <DialogTitle>Opportunity History</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {historyLoading ? (
            <div className="text-13 text-ink-secondary">Loading history...</div>
          ) : historyError ? (
            <div className="rounded-xs border-hairline border-alert-fg/30 bg-red-50 px-3 py-2 text-12 text-alert-fg">
              History failed: {historyError.message}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-12">
                <div className="font-medium text-zinc-900">
                  {history?.opportunity?.customerName || opportunity.name || "Unknown Customer"}
                </div>
                <div className="mt-1 text-ink-secondary">
                  {[history?.opportunity?.leadId && `Lead ${history.opportunity.leadId.slice(0, 8)}`, history?.opportunity?.estimateId && `Est ${history.opportunity.estimateId.slice(0, 8)}`]
                    .filter(Boolean)
                    .join(" / ") || "No linked records"}
                </div>
              </div>
              {!history?.data?.length ? (
                <div className="text-13 text-ink-secondary">No history events found.</div>
              ) : (
                <div className="space-y-3">
                  {history.data.map((event) => (
                    <div key={event.id} className="rounded-sm border-hairline border-zinc-200 bg-white p-3 text-12">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium text-zinc-900">{event.title}</div>
                        <div className="text-11 text-ink-tertiary">{formatHistoryDate(event.occurredAt)}</div>
                      </div>
                      {event.description && (
                        <div className="mt-1 text-ink-secondary">{event.description}</div>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2 text-11 text-ink-tertiary">
                        {event.actor && <span>{event.actor}</span>}
                        {event.source && <span>{event.source.replace(/_/g, " ")}</span>}
                        {event.metadata?.hasNote && <span>Has note</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setHistoryOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
