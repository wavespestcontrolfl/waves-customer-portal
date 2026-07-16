import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  Bot,
  Camera,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileText,
  MessageSquare,
  Phone,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useFeatureFlagReady } from "../../hooks/useFeatureFlag";
import { useIntelligenceBar } from "../../hooks/useIntelligenceBar";
import { adminFetch } from "../../utils/admin-fetch";
import { cn, Dialog, DialogHeader, DialogTitle, DialogBody } from "../../components/ui";
import PendingActionsCard from "../../components/admin/PendingActionsCard";
import { AttachIcon } from "../../components/admin/IntelligenceBarShell";

const BUILD_PROMPT = "Build the estimate from all available evidence. If this is a recognized customer, preserve current services and price only requested additions using the selected lead account context. Verify property facts, protocols, inventory, presentation sections, and per-line margin, then propose the draft for my confirmation.";
const NO_FALLBACK_ACTIONS = [];

function money(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount % 1 ? 2 : 0,
  }).format(amount);
}

function serviceTemplateLabel(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function spendSourceLabel(value) {
  if (value === "last_paid_invoice") return "last paid invoice";
  if (value === "scheduled_estimate") return "scheduled price fallback";
  return "price unavailable";
}

function leadName(lead) {
  return lead?.name || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Unnamed lead";
}

function laneDot(lane) {
  return lane === "yellow" ? "bg-[#F59E0B]" : "bg-[#10B981]";
}

function AgentInline({ children }) {
  return String(children || "").split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => (
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index} className="font-medium text-zinc-950">{part.slice(2, -2)}</strong>
      : <React.Fragment key={index}>{part}</React.Fragment>
  ));
}

function AgentResponse({ text }) {
  return String(text || "").split("\n").map((line, index) => {
    if (!line.trim()) return <div key={index} className="h-2" />;
    if (line.startsWith("### ")) return <div key={index} className="mb-1 mt-3 text-[14px] font-medium text-zinc-950"><AgentInline>{line.slice(4)}</AgentInline></div>;
    if (line.startsWith("## ")) return <div key={index} className="mb-2 mt-4 text-[16px] font-medium text-zinc-950"><AgentInline>{line.slice(3)}</AgentInline></div>;
    if (/^[-•*]\s/.test(line)) return <div key={index} className="mb-1 flex gap-2 pl-1"><span aria-hidden="true">•</span><span><AgentInline>{line.replace(/^[-•*]\s/, "")}</AgentInline></span></div>;
    return <div key={index} className="mb-1"><AgentInline>{line}</AgentInline></div>;
  });
}

function SectionCard({ title, subtitle, action, children, className = "" }) {
  return (
    <section className={cn("min-w-0 rounded-md border border-zinc-200 bg-white", className)}>
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-medium tracking-tight text-zinc-950">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[14px] leading-5 text-zinc-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function TinyFact({ label, value }) {
  return (
    <div className="min-w-0">
      <div className="text-[14px] text-zinc-500">{label}</div>
      <div className="truncate text-[14px] font-medium text-zinc-900">{value || "Not found"}</div>
    </div>
  );
}

function LeadPicker({ selectedId, leads, value, loading, disabled, onValueChange, onSelect }) {
  return (
    <div className="space-y-3 p-4">
      <label className="block text-[14px] font-medium text-zinc-800" htmlFor="agent-lead-search">
        Search open leads
      </label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={18} aria-hidden="true" />
        <input
          id="agent-lead-search"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          disabled={disabled}
          placeholder="Name, phone, address, or service"
          className="h-12 w-full rounded-sm border border-zinc-300 bg-white pl-10 pr-3 text-[16px] text-zinc-950 outline-none placeholder:text-zinc-400 focus:border-zinc-900"
        />
      </div>
      <div className="max-h-64 divide-y divide-zinc-100 overflow-y-auto rounded-sm border border-zinc-200">
        {loading && <div className="p-4 text-[14px] text-zinc-500">Loading leads…</div>}
        {!loading && leads.length === 0 && (
          <div className="p-4 text-[14px] text-zinc-500">No open leads match this search.</div>
        )}
        {!loading && leads.map((lead) => {
          const selected = String(lead.id) === String(selectedId);
          return (
            <button
              key={lead.id}
              type="button"
              onClick={() => onSelect(lead.id)}
              disabled={disabled}
              className={cn(
                "block min-h-16 w-full px-3 py-3 text-left transition-colors",
                selected ? "bg-zinc-100" : "bg-white hover:bg-zinc-50",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium text-zinc-950">{leadName(lead)}</div>
                  <div className="mt-0.5 truncate text-[14px] text-zinc-500">
                    {[lead.service_interest, lead.address || lead.city].filter(Boolean).join(" · ") || "No service details"}
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-1 text-[14px] text-zinc-600">
                  {String(lead.status || "new").replaceAll("_", " ")}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EvidencePanel({ context }) {
  const quoteFields = context?.quote_form?.message_fields || [];
  const calls = context?.calls || [];
  const sms = context?.sms_thread || [];
  return (
    <div className="divide-y divide-zinc-200">
      <div className="grid grid-cols-3 gap-3 p-4">
        <TinyFact label="Quote fields" value={String(quoteFields.length)} />
        <TinyFact label="Calls / transcripts" value={`${calls.length} / ${calls.filter((call) => call.transcript).length}`} />
        <TinyFact label="SMS messages" value={context?.shared_phone_history_suppressed ? "Hidden" : String(sms.length)} />
      </div>
      {context?.shared_phone_history_suppressed && (
        <div className="bg-zinc-50 px-4 py-3 text-[14px] leading-5 text-zinc-700">
          This phone appears on more than one lead, so phone-based SMS and prior-estimate history is hidden to prevent mixing customers.
        </div>
      )}
      <details className="group">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 py-3 text-[14px] font-medium text-zinc-800">
          Review source evidence
          <ChevronDown size={18} className="transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-4 border-t border-zinc-200 p-4 text-[14px] leading-6 text-zinc-700">
          <div>
            <div className="mb-1 font-medium text-zinc-950">Quote form</div>
            {quoteFields.length ? quoteFields.map((row) => (
              <div key={row.field} className="mb-2 rounded-sm bg-zinc-50 p-3">
                <div className="font-medium text-zinc-700">{row.field}</div>
                <div>{row.text}</div>
              </div>
            )) : <div className="text-zinc-500">No message-like quote fields were found.</div>}
          </div>
          <div>
            <div className="mb-1 font-medium text-zinc-950">Call transcripts</div>
            {calls.length ? calls.map((call, index) => (
              <details key={call.id || index} className="mb-2 rounded-sm border border-zinc-200 bg-white">
                <summary className="cursor-pointer px-3 py-2 font-medium">Call {index + 1} · {call.duration_seconds || 0}s</summary>
                <div className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-zinc-200 p-3">
                  {call.transcript || (call.has_recording
                    ? "Recording exists, but no transcript is available. The estimator must not infer what was said."
                    : "No recording or transcript is available for this call.")}
                  {call.transcript_summary && (
                    <div className="mt-3 rounded-sm bg-zinc-50 p-3">
                      <div className="font-medium text-zinc-900">Lead call summary · lower-confidence than transcript</div>
                      <div>{call.transcript_summary}</div>
                    </div>
                  )}
                </div>
              </details>
            )) : <div className="text-zinc-500">No usable transcript was found.</div>}
          </div>
          <div>
            <div className="mb-1 font-medium text-zinc-950">SMS conversation</div>
            {sms.length ? (
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-sm bg-zinc-50 p-3">
                {sms.map((message, index) => (
                  <div key={message.id || index} className="rounded-sm bg-white p-2">
                    <span className="font-medium">{message.direction || message.type || "message"}: </span>
                    {message.body || message.message || message.content || ""}
                  </div>
                ))}
              </div>
            ) : <div className="text-zinc-500">No usable SMS history was found.</div>}
          </div>
        </div>
      </details>
    </div>
  );
}

export function CustomerAccountPanel({ account, profile }) {
  if (!account?.recognized) {
    return (
      <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-[14px] leading-5 text-zinc-600">
        No unambiguous customer account match. This will price as a new-customer estimate unless staff links the correct account.
      </div>
    );
  }

  const services = account.current_services || [];
  return (
    <div className="border-b border-zinc-200 bg-emerald-50/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-medium text-emerald-950">
            <CheckCircle2 size={18} aria-hidden="true" /> Existing customer recognized
          </div>
          <p className="mt-1 text-[14px] leading-5 text-emerald-900">
            Current services and their paid prices stay unchanged. They establish the starting tier; the estimator applies the combined tier only to requested additions.
          </p>
        </div>
        <span className="rounded-full border border-emerald-200 bg-white px-3 py-1 text-[14px] text-emerald-900">
          {account.current_tier || profile?.waveguard_tier || (account.active_plan ? "Active plan" : "No active plan")}
          {Number(account.current_discount_pct) > 0 ? ` · ${account.current_discount_pct}% current discount` : ""}
        </span>
      </div>
      <div className="mt-3 overflow-hidden rounded-sm border border-emerald-200 bg-white">
        <div className="border-b border-emerald-100 px-3 py-2 text-[14px] font-medium text-zinc-900">Current service + spend</div>
        {services.length ? services.map((service) => (
          <div key={service.key} className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-3 last:border-b-0">
            <div>
              <div className="text-[14px] font-medium text-zinc-950">{service.label || serviceTemplateLabel(service.key)}</div>
              <div className="text-[14px] text-zinc-500">
                {spendSourceLabel(service.spendSource)}
                {service.lastPaidAt ? ` · ${String(service.lastPaidAt).slice(0, 10)}` : ""}
                {service.qualifiesForWaveGuard === false ? " · not a tier service" : ""}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[16px] font-medium text-zinc-950">
                {service.currentPerVisit == null ? "Not available" : money(service.currentPerVisit)}
              </div>
              <div className="text-[14px] text-zinc-500">per application</div>
            </div>
          </div>
        )) : (
          <div className="px-3 py-3 text-[14px] text-zinc-600">Account matched, but no active recurring service rows were found.</div>
        )}
      </div>
    </div>
  );
}

function DraftSummary({ draft, contact, account, onPreview, onSend, sending, sendMessage }) {
  if (!draft) {
    return <div className="p-4 text-[14px] leading-6 text-zinc-500">No Agent Estimate draft yet. Build one, review the AI basis, then confirm the draft card.</div>;
  }
  const canSend = draft.status === "draft" && draft.editable_here === true;
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white px-3 py-1 text-[14px] font-medium text-zinc-800">
          <span className={cn("h-2 w-2 rounded-full", laneDot(draft.lane))} />
          {draft.lane === "yellow" ? "AI Draft · Review" : "AI Draft"}
        </span>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-[14px] text-zinc-600">{draft.status || "draft"}</span>
      </div>
      <div className="grid grid-cols-3 gap-3 rounded-sm bg-zinc-50 p-3">
        <TinyFact label="Monthly" value={money(draft.monthly_total)} />
        <TinyFact label="Annual" value={money(draft.annual_total)} />
        <TinyFact label="One-time" value={money(draft.onetime_total)} />
      </div>
      {(draft.presentation_template || draft.service_template_keys?.length) && (
        <div className="rounded-sm border border-zinc-200 p-3">
          <div className="text-[14px] font-medium text-zinc-900">Customer presentation</div>
          <div className="mt-1 text-[14px] text-zinc-600">
            {serviceTemplateLabel(draft.presentation_template || "service")}
            {draft.service_template_keys?.length && draft.service_template_keys.length > 1
              ? ` · ${draft.service_template_keys.map(serviceTemplateLabel).join(" + ")}`
              : ""}
          </div>
          {account?.recognized && (
            <div className="mt-1 text-[14px] text-zinc-500">Expansion estimate; current services are not duplicated in this presentation.</div>
          )}
        </div>
      )}
      {draft.lane_reasons?.length > 0 && (
        <div className="rounded-sm border border-zinc-200 p-3">
          <div className="mb-1 text-[14px] font-medium text-zinc-900">Review before sending</div>
          <ul className="list-disc space-y-1 pl-5 text-[14px] leading-5 text-zinc-600">
            {draft.lane_reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      )}
      <button
        type="button"
        onClick={onPreview}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-sm border border-zinc-300 bg-white px-4 text-[14px] font-medium text-zinc-900 hover:bg-zinc-50"
      >
        <ExternalLink size={18} aria-hidden="true" /> Preview customer estimate
      </button>
      {canSend && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button
            type="button"
            disabled={!contact?.phone || sending}
            onClick={() => onSend("sms")}
            className="flex h-12 items-center justify-center gap-2 rounded-sm bg-zinc-900 px-3 text-[14px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageSquare size={18} aria-hidden="true" /> Send SMS
          </button>
          <button
            type="button"
            disabled={!contact?.email || sending}
            onClick={() => onSend("email")}
            className="flex h-12 items-center justify-center gap-2 rounded-sm bg-zinc-900 px-3 text-[14px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={18} aria-hidden="true" /> Send email
          </button>
          <button
            type="button"
            disabled={!contact?.phone || !contact?.email || sending}
            onClick={() => onSend("both")}
            className="flex h-12 items-center justify-center gap-2 rounded-sm border border-zinc-300 bg-white px-3 text-[14px] font-medium text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send both
          </button>
        </div>
      )}
      {sending && <div className="text-[14px] text-zinc-600">Sending estimate…</div>}
      {sendMessage && <div role="status" className="rounded-sm bg-zinc-100 p-3 text-[14px] text-zinc-800">{sendMessage}</div>}
    </div>
  );
}

function LearningPanel({ leadId, user, memories, onReload }) {
  const [rule, setRule] = useState("");
  const [rationale, setRationale] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const submitCandidate = async () => {
    if (rule.trim().length < 12) return;
    setSaving(true);
    setMessage("");
    try {
      await adminFetch("/admin/agent-estimate/memory", {
        method: "POST",
        body: JSON.stringify({ rule_text: rule.trim(), rationale: rationale.trim(), source_lead_id: leadId || null }),
      });
      setRule("");
      setRationale("");
      setMessage("Learning candidate saved for admin review.");
      await onReload();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };

  const review = async (id, status) => {
    await adminFetch(`/admin/agent-estimate/memory/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await onReload();
  };

  return (
    <details className="group">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between px-4 py-3 text-[14px] font-medium text-zinc-900">
        Controlled learning
        <ChevronDown size={18} className="transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-4 border-t border-zinc-200 p-4">
        <p className="text-[14px] leading-6 text-zinc-600">
          A correction in this chat applies immediately to this estimate. Save repeatable rules here; the agent uses them only after an admin approves them.
        </p>
        <textarea
          value={rule}
          onChange={(event) => setRule(event.target.value)}
          placeholder="Example: For this HOA, verify irrigated turf area separately from common-area parcel size."
          className="min-h-24 w-full rounded-sm border border-zinc-300 p-3 text-[16px] text-zinc-950 outline-none placeholder:text-zinc-400 focus:border-zinc-900"
        />
        <input
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="Why this should become a repeatable rule (optional)"
          className="h-12 w-full rounded-sm border border-zinc-300 px-3 text-[14px] outline-none focus:border-zinc-900"
        />
        <button
          type="button"
          disabled={saving || rule.trim().length < 12}
          onClick={submitCandidate}
          className="h-12 rounded-sm border border-zinc-300 bg-white px-4 text-[14px] font-medium text-zinc-900 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save learning candidate"}
        </button>
        {message && <div className="text-[14px] text-zinc-700">{message}</div>}
        {memories.length > 0 && (
          <div className="space-y-2">
            {memories.slice(0, 12).map((memory) => (
              <div key={memory.id} className="rounded-sm border border-zinc-200 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-[14px] leading-5 text-zinc-800">{memory.rule_text}</p>
                  <span className="rounded-full bg-zinc-100 px-2 py-1 text-[14px] text-zinc-600">{memory.status}</span>
                </div>
                {user?.role === "admin" && memory.status === "pending" && (
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => review(memory.id, "approved")} className="h-11 rounded-sm bg-zinc-900 px-4 text-[14px] font-medium text-white">Approve</button>
                    <button type="button" onClick={() => review(memory.id, "rejected")} className="h-11 rounded-sm border border-zinc-300 px-4 text-[14px] font-medium text-zinc-800">Reject</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export default function AgentEstimatePage() {
  const { enabled, ready } = useFeatureFlagReady("agent_estimate", false);
  const outlet = useOutletContext() || {};
  const user = outlet.user || null;
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedLeadId = searchParams.get("leadId") || "";
  const [leadSearch, setLeadSearch] = useState("");
  const [leadOptions, setLeadOptions] = useState([]);
  const [leadSearchLoading, setLeadSearchLoading] = useState(false);
  const [context, setContext] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [draft, setDraft] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState("");
  const [memories, setMemories] = useState([]);
  const fileInputRef = useRef(null);
  const primedLeadRef = useRef(null);
  const activeLeadRef = useRef(selectedLeadId);
  const contextRequestRef = useRef(0);
  const leadSearchRequestRef = useRef(0);

  const loadContext = useCallback(async () => {
    const requestId = contextRequestRef.current + 1;
    contextRequestRef.current = requestId;
    if (!selectedLeadId || !enabled) {
      setContext(null);
      setDraft(null);
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    setContextError("");
    setContext(null);
    setDraft(null);
    try {
      const data = await adminFetch(`/admin/agent-estimate/lead/${selectedLeadId}`);
      if (contextRequestRef.current !== requestId) return;
      setContext(data.context || null);
      setDraft(data.context?.current_estimate || null);
    } catch (error) {
      if (contextRequestRef.current !== requestId) return;
      setContextError(error.message);
      setContext(null);
      setDraft(null);
    } finally {
      if (contextRequestRef.current === requestId) setContextLoading(false);
    }
  }, [selectedLeadId, enabled]);

  const loadMemories = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await adminFetch("/admin/agent-estimate/memory");
      setMemories(data.memories || []);
    } catch {
      setMemories([]);
    }
  }, [enabled]);

  const handleAfterSubmit = useCallback((data) => {
    if (!data?.confirmedAction || data?.toolCalls?.[0]?.name !== "create_agent_estimate_draft") return;
    const result = data.result;
    if (!result?.success) return;
    setDraft((current) => ({
      ...current,
      id: result.estimate_id,
      token: result.token,
      status: "draft",
      source: "estimator_engine",
      lane: result.lane,
      lane_reasons: result.lane_reasons || [],
      monthly_total: result.monthly_total,
      annual_total: result.annual_total,
      onetime_total: result.onetime_total,
      presentation_template: result.presentation_template || null,
      service_template_keys: result.service_template_keys || [],
      editable_here: true,
    }));
    loadContext();
  }, [loadContext]);

  const intelligence = useIntelligenceBar({
    context: "agent_estimate",
    buildPageData: () => ({ agent_estimate_context: context, current_estimate: draft }),
    fallbackActions: NO_FALLBACK_ACTIONS,
    getRequestKey: () => selectedLeadId,
  });

  useEffect(() => {
    if (activeLeadRef.current === selectedLeadId) return;
    activeLeadRef.current = selectedLeadId;
    contextRequestRef.current += 1;
    primedLeadRef.current = null;
    setContext(null);
    setDraft(null);
    setContextError("");
    setSendMessage("");
    setPreviewOpen(false);
    intelligence.clear();
  }, [selectedLeadId, intelligence.clear]);

  useEffect(() => {
    if (!ready || !enabled) return undefined;
    const requestId = leadSearchRequestRef.current + 1;
    leadSearchRequestRef.current = requestId;
    const timer = window.setTimeout(async () => {
      setLeadSearchLoading(true);
      try {
        const qs = new URLSearchParams({ status: "open", limit: "20" });
        if (leadSearch.trim()) qs.set("search", leadSearch.trim());
        const data = await adminFetch(`/admin/leads?${qs.toString()}`);
        if (leadSearchRequestRef.current === requestId) setLeadOptions(data.leads || []);
      } catch {
        if (leadSearchRequestRef.current === requestId) setLeadOptions([]);
      } finally {
        if (leadSearchRequestRef.current === requestId) setLeadSearchLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (leadSearchRequestRef.current === requestId) leadSearchRequestRef.current += 1;
    };
  }, [leadSearch, ready, enabled]);

  useEffect(() => { loadContext(); }, [loadContext]);
  useEffect(() => { loadMemories(); }, [loadMemories]);

  useEffect(() => {
    if (!context?.suggested_prompt || primedLeadRef.current === selectedLeadId) return;
    primedLeadRef.current = selectedLeadId;
    intelligence.setPrompt(context.suggested_prompt);
    intelligence.setExpanded(true);
  }, [context?.suggested_prompt, selectedLeadId, intelligence.setPrompt, intelligence.setExpanded]);

  const contact = context?.lead || null;
  const previewUrl = draft?.token ? `/estimate/${draft.token}?adminPreview=1` : null;
  const quickActions = intelligence.quickActions || [];
  const buildDisabled = !context || contextLoading || intelligence.loading;
  const openLead = ["new", "contacted", "estimate_sent", "estimate_viewed"].includes(String(contact?.status || "new"));
  // Closed (won/lost/unresponsive/duplicate) leads must not reach the draft
  // tool through ANY entry — Build, quick actions, or a typed Ask AI prompt.
  const askDisabled = buildDisabled || !openLead;
  // A lead linked to a non-Agent estimate (legacy draft, or one already sent/
  // scheduled) can never be drafted or revised here — the server rejects both
  // paths deterministically — so don't send the operator through a paid AI
  // run and confirmation that is guaranteed to fail.
  const buildBlocked = !!draft && draft.editable_here !== true;

  const chooseLead = (leadId) => {
    setSearchParams(leadId ? { leadId } : {});
  };

  const sendDraft = async (sendMethod) => {
    if (!draft?.id || draft.status !== "draft" || draft.editable_here !== true || sending) return;
    // Capture the lead this send belongs to — if the operator switches leads
    // before the request resolves, the completion must not mark the newly
    // selected draft as sent or reload the old lead under the new URL.
    const sendLeadId = selectedLeadId;
    setSending(true);
    setSendMessage("");
    try {
      const data = await adminFetch(`/admin/estimates/${draft.id}/send`, {
        method: "POST",
        body: JSON.stringify({
          sendMethod,
          idempotencyKey: globalThis.crypto?.randomUUID?.() || `agent-estimate-send-${Date.now()}`,
        }),
      });
      if (activeLeadRef.current !== sendLeadId) return;
      const label = sendMethod === "sms" ? "SMS" : sendMethod === "email" ? "email" : "SMS and email";
      const channelIssues = Object.entries(data.channels || {})
        .filter(([, value]) => value && !value.ok)
        .map(([channel, value]) => `${channel}: ${value.error || "failed"}`);
      setSendMessage(channelIssues.length ? `Estimate sent with an issue — ${channelIssues.join("; ")}` : `Estimate sent by ${label}.`);
      setDraft((current) => ({ ...current, status: "sent" }));
      await loadContext();
    } catch (error) {
      if (activeLeadRef.current !== sendLeadId) return;
      setSendMessage(`Send failed: ${error.message}`);
    } finally {
      setSending(false);
    }
  };

  const evidenceCount = useMemo(() => (
    (context?.quote_form?.message_fields?.length || 0)
    + (context?.calls?.length || 0)
    + (context?.sms_thread?.length || 0)
  ), [context]);

  if (!ready) {
    return <div className="p-6 text-[14px] text-zinc-600">Checking Agent Estimate access…</div>;
  }
  if (!enabled) {
    return (
      <div className="mx-auto max-w-xl rounded-md border border-zinc-200 bg-white p-6 text-[14px] text-zinc-700">
        Agent Estimate is off for this account. Enable the <span className="font-medium">agent_estimate</span> user flag when you are ready to test it.
      </div>
    );
  }

  return (
    <div className="mx-auto min-w-0 max-w-[1500px] font-sans text-zinc-950">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[14px] font-medium text-zinc-500">
            <Bot size={18} aria-hidden="true" /> Manual · gated
          </div>
          <h1 className="text-[28px] font-normal tracking-tight">Agent Estimate</h1>
          <p className="mt-1 max-w-3xl text-[14px] leading-6 text-zinc-600">
            Pull a lead’s calls, texts, quote form, and recognized customer account into one evidence-backed estimate. Current services stay intact; the pricing engine prices additions; you preview and send.
          </p>
        </div>
        {selectedLeadId && (
          <button type="button" onClick={loadContext} disabled={contextLoading} className="flex h-11 items-center gap-2 rounded-sm border border-zinc-300 bg-white px-4 text-[14px] font-medium text-zinc-800 disabled:opacity-50">
            <RefreshCw size={17} className={contextLoading ? "animate-spin" : ""} aria-hidden="true" /> Refresh evidence
          </button>
        )}
      </header>

      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.55fr)]">
        <main className="min-w-0 space-y-4">
          <SectionCard title="1 · Choose a lead" subtitle="Open leads include new prospects and existing-customer expansion requests.">
            <LeadPicker
              selectedId={selectedLeadId}
              leads={leadOptions}
              value={leadSearch}
              loading={leadSearchLoading}
              disabled={intelligence.loading}
              onValueChange={setLeadSearch}
              onSelect={chooseLead}
            />
          </SectionCard>

          {contextError && <div role="alert" className="rounded-sm border border-alert-fg bg-white p-4 text-[14px] text-alert-fg">{contextError}</div>}
          {contextLoading && <div className="rounded-md border border-zinc-200 bg-white p-5 text-[14px] text-zinc-600">Loading quote form, transcripts, SMS, profile, and prior estimates…</div>}

          {context && (
            <>
              <SectionCard title="2 · Lead evidence" subtitle={`${evidenceCount} source records loaded`}>
                <div className="grid gap-3 border-b border-zinc-200 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <TinyFact label="Lead" value={leadName(contact)} />
                  <TinyFact label="Service" value={contact?.service_interest} />
                  <TinyFact label="Phone" value={contact?.phone} />
                  <TinyFact label="Address" value={contact?.address} />
                </div>
                <CustomerAccountPanel account={context.customer_account} profile={context.customer_profile} />
                <EvidencePanel context={context} />
              </SectionCard>

              <SectionCard title="3 · Ask the estimator" subtitle="Corrections here adapt this estimate immediately. Permanent learning stays approval-controlled.">
                <div className="space-y-3 p-4">
                  {!openLead && (
                    <div className="rounded-sm bg-zinc-50 p-3 text-[14px] leading-5 text-zinc-700">
                      This lead is {String(contact?.status || "closed").replaceAll("_", " ")} — Agent Estimate drafting works on open leads only. Reopen the lead to build or revise a draft here.
                    </div>
                  )}
                  {openLead && buildBlocked && (
                    <div className="rounded-sm bg-zinc-50 p-3 text-[14px] leading-5 text-zinc-700">
                      This lead is linked to {draft?.status === "draft" ? "a draft from another estimator flow" : `an estimate that is already ${String(draft?.status || "in progress").replaceAll("_", " ")}`} — Agent Estimate can’t revise it. Review it from the Estimates page instead.
                    </div>
                  )}
                  <button
                    type="button"
                    disabled={askDisabled || buildBlocked}
                    onClick={() => intelligence.submit(context.suggested_prompt || BUILD_PROMPT)}
                    className="flex min-h-14 w-full items-center justify-center gap-2 rounded-sm bg-zinc-900 px-5 text-[16px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Sparkles size={20} aria-hidden="true" />
                    {intelligence.loading ? "Building and checking…" : draft?.editable_here ? "Review or revise draft" : "Build estimate"}
                  </button>

                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {quickActions.filter((action) => action.id !== "build").map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        disabled={askDisabled}
                        onClick={() => intelligence.submit(action.prompt)}
                        className="h-11 shrink-0 rounded-sm border border-zinc-300 bg-white px-3 text-[14px] font-medium text-zinc-800 disabled:opacity-40"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>

                  <textarea
                    value={intelligence.prompt}
                    onChange={(event) => intelligence.setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !askDisabled) intelligence.submit();
                    }}
                    placeholder="Ask a property question, change scope, or tell AI what to double-check…"
                    className="min-h-28 w-full rounded-sm border border-zinc-300 bg-white p-3 text-[16px] leading-6 text-zinc-950 outline-none placeholder:text-zinc-400 focus:border-zinc-900"
                  />

                  {intelligence.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {intelligence.attachments.map((attachment, index) => (
                        <div key={`${attachment.name}-${index}`} className="relative h-20 w-20 overflow-hidden rounded-sm border border-zinc-200">
                          <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
                          <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => intelligence.removeAttachment(index)} className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-white text-zinc-900">
                            <X size={16} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-[auto_1fr] gap-2 sm:flex">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={intelligence.loading || intelligence.attachmentsLoading}
                      className="flex h-12 items-center justify-center gap-2 rounded-sm border border-zinc-300 bg-white px-4 text-[14px] font-medium text-zinc-800 disabled:opacity-40"
                    >
                      <AttachIcon /> Add photo
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        intelligence.addAttachments(event.target.files);
                        event.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      disabled={!intelligence.prompt.trim() || askDisabled || intelligence.attachmentsLoading}
                      onClick={() => intelligence.submit()}
                      className="flex h-12 flex-1 items-center justify-center gap-2 rounded-sm bg-zinc-900 px-5 text-[14px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Bot size={18} aria-hidden="true" /> Ask AI
                    </button>
                  </div>

                  {intelligence.loading && (
                    <div className="space-y-2 py-2" role="status">
                      <div className="h-3 w-11/12 animate-pulse rounded bg-zinc-100" />
                      <div className="h-3 w-9/12 animate-pulse rounded bg-zinc-100" />
                      <div className="text-[14px] text-zinc-500">Checking evidence, property facts, protocols, inventory, and pricing…</div>
                    </div>
                  )}

                  {intelligence.response && !intelligence.loading && (
                    <div className="rounded-sm border border-zinc-200 bg-zinc-50 p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-[14px] font-medium text-zinc-950"><Bot size={18} aria-hidden="true" /> Estimator response</div>
                        <button type="button" onClick={intelligence.clear} className="h-11 px-3 text-[14px] font-medium text-zinc-600">Clear chat</button>
                      </div>
                      <div className={cn("text-[14px] leading-6", intelligence.response.startsWith("Error:") ? "text-alert-fg" : "text-zinc-800")}>
                        <AgentResponse text={intelligence.response} />
                      </div>
                      <PendingActionsCard
                        actions={intelligence.pendingActions}
                        variant="light"
                        touchFriendly
                        onResolved={(action, decision, body) => {
                          // This callback is the closure from the render the card
                          // was confirmed in; the pending-action payload is
                          // display-only and may omit leadId. Compare the render's
                          // lead against the live ref so a confirmation that
                          // resolves after a lead switch never applies the old
                          // lead's draft to the new one.
                          if (activeLeadRef.current !== selectedLeadId) return;
                          if (action?.params?.leadId && String(action.params.leadId) !== String(selectedLeadId)) return;
                          if (decision === "confirm" && body?.success) {
                            handleAfterSubmit({
                              toolCalls: [{ name: action.tool }],
                              confirmedAction: true,
                              result: body.result,
                            });
                          }
                        }}
                      />
                    </div>
                  )}
                </div>
              </SectionCard>
            </>
          )}
        </main>

        <aside className="min-w-0 space-y-4 xl:sticky xl:top-0">
          <SectionCard title="Draft + send" subtitle="The customer receives nothing until you tap a send button.">
            <DraftSummary
              draft={draft}
              contact={contact}
              account={context?.customer_account}
              onPreview={() => setPreviewOpen(true)}
              onSend={sendDraft}
              sending={sending}
              sendMessage={sendMessage}
            />
            {previewUrl && (
              <div className="hidden border-t border-zinc-200 p-3 lg:block">
                <iframe title="Customer estimate preview" src={previewUrl} className="h-[720px] w-full rounded-sm border border-zinc-200 bg-white" />
              </div>
            )}
          </SectionCard>

          <SectionCard title="Accuracy guardrails" subtitle="$35 loaded labor · 35% collected margin target">
            <div className="space-y-3 p-4 text-[14px] leading-5 text-zinc-700">
              <div className="flex gap-2"><CheckCircle2 size={18} className="mt-0.5 shrink-0" aria-hidden="true" /> Pricing engine owns every dollar.</div>
              <div className="flex gap-2"><FileText size={18} className="mt-0.5 shrink-0" aria-hidden="true" /> Protocol and inventory affect feasibility/review, never price.</div>
              <div className="flex gap-2"><Camera size={18} className="mt-0.5 shrink-0" aria-hidden="true" /> Photo observations retain per-field confidence and occlusion notes.</div>
              <div className="flex gap-2"><Phone size={18} className="mt-0.5 shrink-0" aria-hidden="true" /> Existing accounts supply current service/spend; only requested additions are priced.</div>
            </div>
            <div className="border-t border-zinc-200">
              {/* key remounts the panel on lead switch so an in-progress rule
                  draft can't be submitted with the wrong source_lead_id */}
              <LearningPanel key={selectedLeadId || "none"} leadId={selectedLeadId} user={user} memories={memories} onReload={loadMemories} />
            </div>
          </SectionCard>
        </aside>
      </div>

      <Dialog open={previewOpen && !!previewUrl} onClose={() => setPreviewOpen(false)} size="lg" className="h-[calc(100dvh-2rem)] max-w-6xl overflow-hidden">
        <DialogHeader className="flex items-center justify-between gap-3">
          <DialogTitle>Customer preview</DialogTitle>
          <button type="button" onClick={() => setPreviewOpen(false)} aria-label="Close preview" className="flex h-11 w-11 items-center justify-center rounded-sm border border-zinc-300 text-zinc-800"><X size={20} /></button>
        </DialogHeader>
        <DialogBody className="h-[calc(100%-77px)] p-0">
          {previewUrl && <iframe title="Full customer estimate preview" src={previewUrl} className="h-full w-full bg-white" />}
        </DialogBody>
      </Dialog>
    </div>
  );
}
