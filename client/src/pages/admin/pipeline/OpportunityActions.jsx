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
      return { label: "Edit Estimate", kind: "navigate", to: "/admin/estimates?tab=estimates" };
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
  if (opportunity.leadId) actions.push({ label: "Open Legacy Leads", to: "/admin/leads" });
  if (opportunity.estimateId) actions.push({ label: "Open Legacy Estimates", to: "/admin/estimates?tab=estimates" });
  if (opportunity.customerId) actions.push({ label: "Open Customer", to: `/admin/customers?customerId=${encodeURIComponent(opportunity.customerId)}` });
  if (opportunity.stage !== PIPELINE_STAGES.ESTIMATE_NEEDED && opportunity.leadId) {
    actions.push({ label: "Create Estimate", to: createEstimateUrl(opportunity) });
  }
  if (opportunity.phone) actions.push({ label: "Message", to: communicationUrl(opportunity) });
  return actions;
}

export default function OpportunityActions({ opportunity, onRefresh, adminFetch }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const action = primaryAction(opportunity);
  const missingEstimateReadyFields = !opportunity.address || !opportunity.serviceInterest || (!opportunity.phone && !opportunity.email);

  async function runPrimary() {
    if (action.kind === "navigate") {
      navigate(action.to);
      return;
    }
    if (action.kind === "follow_up") {
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
              key={`${item.label}-${item.to}`}
              type="button"
              onClick={() => navigate(item.to)}
              className="w-full flex items-center justify-between gap-2 rounded-xs px-3 py-2 text-left text-12 text-zinc-700 hover:bg-zinc-50 u-focus-ring"
            >
              <span>{item.label}</span>
              <ExternalLink size={13} strokeWidth={1.8} aria-hidden />
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}
