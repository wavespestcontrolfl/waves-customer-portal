import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { Button, cn } from "../../../components/ui";
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
  const actions = [];
  if (opportunity.leadId) actions.push({ label: "Open Legacy Leads", kind: "navigate", to: "/admin/leads" });
  if (opportunity.estimateId) actions.push({ label: "Open Legacy Estimates", kind: "navigate", to: "/admin/estimates?tab=estimates" });
  if (opportunity.customerId) actions.push({ label: "Open Customer", kind: "navigate", to: `/admin/customers?customerId=${encodeURIComponent(opportunity.customerId)}` });
  if (opportunity.stage !== PIPELINE_STAGES.ESTIMATE_NEEDED && opportunity.leadId) {
    actions.push({ label: "Create Estimate", kind: "navigate", to: createEstimateUrl(opportunity) });
  }
  if (opportunity.estimateId) {
    if (opportunity.stage === PIPELINE_STAGES.ESTIMATE_DRAFT) {
      actions.push({ label: "Edit Estimate", kind: "navigate", to: "/admin/estimates?tab=estimates" });
    }
    if ([PIPELINE_STAGES.ESTIMATE_SENT, PIPELINE_STAGES.ESTIMATE_VIEWED].includes(opportunity.stage)) {
      actions.push({ label: "Follow Up", kind: "follow_up" });
    }
    if ([PIPELINE_STAGES.ESTIMATE_SENT, PIPELINE_STAGES.ESTIMATE_VIEWED].includes(opportunity.stage)) {
      actions.push({ label: "Mark Accepted", kind: "mark_accepted" });
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

export default function OpportunityActions({ opportunity, onRefresh, adminFetch }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const action = primaryAction(opportunity);
  const missingEstimateReadyFields = !opportunity.address || !opportunity.serviceInterest || (!opportunity.phone && !opportunity.email);

  async function runPrimary() {
    await runAction(action);
  }

  async function runAction(item) {
    if (busy) return;
    if (item.kind === "navigate") {
      navigate(item.to);
      return;
    }
    if (item.kind === "follow_up") {
      if (!opportunity.estimateId) {
        navigate(communicationUrl(opportunity));
        return;
      }
      setBusy(true);
      try {
        await adminFetch(`/admin/estimates/${opportunity.estimateId}/follow-up`, { method: "POST" });
        onRefresh?.();
      } catch (err) {
        window.alert(`Follow-up failed: ${err.message}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (item.kind === "send_estimate") {
      if (!opportunity.estimateId) return;
      if (!window.confirm(`Send this estimate to ${opportunity.name || "the customer"} now?`)) return;
      setBusy(true);
      try {
        await adminFetch(`/admin/estimates/${opportunity.estimateId}/send`, {
          method: "POST",
          body: JSON.stringify({ sendMethod: "both" }),
        });
        onRefresh?.();
      } catch (err) {
        window.alert(`Send failed: ${err.message}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (item.kind === "mark_accepted") {
      if (!opportunity.estimateId) return;
      if (!window.confirm(`Mark ${opportunity.name || "this customer"} as accepted from a verbal yes?`)) return;
      setBusy(true);
      try {
        await adminFetch(`/admin/estimates/${opportunity.estimateId}/mark-accepted`, {
          method: "POST",
          body: JSON.stringify({ source: "pipeline_verbal_yes" }),
        });
        onRefresh?.();
      } catch (err) {
        window.alert(`Mark accepted failed: ${err.message}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (item.kind === "decline_estimate") {
      if (!opportunity.estimateId) return;
      const reason = window.prompt("Reason for declining this estimate?");
      if (!reason || !reason.trim()) return;
      setBusy(true);
      try {
        await adminFetch(`/admin/estimates/${opportunity.estimateId}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "declined", declineReason: reason.trim() }),
        });
        onRefresh?.();
      } catch (err) {
        window.alert(`Mark declined failed: ${err.message}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (item.kind === "extend_estimate") {
      if (!opportunity.estimateId) return;
      const rawDays = window.prompt("Extend expiration by how many days?", "7");
      if (!rawDays) return;
      const days = Number.parseInt(rawDays, 10);
      if (!Number.isInteger(days) || days < 1 || days > 180) {
        window.alert("Enter a whole number of days between 1 and 180.");
        return;
      }
      setBusy(true);
      try {
        await adminFetch(`/admin/estimates/${opportunity.estimateId}/extend`, {
          method: "POST",
          body: JSON.stringify({ days }),
        });
        onRefresh?.();
      } catch (err) {
        window.alert(`Extend failed: ${err.message}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (item.kind === "mark_lead_lost") {
      if (!opportunity.leadId) return;
      const reason = window.prompt("Reason this lead was lost?");
      if (!reason || !reason.trim()) return;
      setBusy(true);
      try {
        await adminFetch(`/admin/leads/${opportunity.leadId}/lost`, {
          method: "POST",
          body: JSON.stringify({ reason: reason.trim() }),
        });
        onRefresh?.();
      } catch (err) {
        window.alert(`Mark lead lost failed: ${err.message}`);
      } finally {
        setBusy(false);
      }
    }
  }

  return (
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
  );
}
