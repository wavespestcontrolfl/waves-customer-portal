import React, { useState, useEffect, useCallback } from "react";
import { Inbox, PhoneCall, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Textarea,
  cn,
} from "../../components/ui";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const STATUS_TABS = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
  { key: "dismissed", label: "Dismissed" },
];

// Human-readable labels for the deterministic + model triage reasons.
const REASON_LABELS = {
  out_of_service_area: "Out of service area",
  missing_service_address: "Missing address",
  address_unverifiable: "Address unverifiable",
  low_confidence_address: "Low-confidence address",
  ambiguous_scheduling: "Ambiguous scheduling",
  reschedule_or_cancel: "Reschedule / cancel",
  cancellation_request: "Cancellation request",
  caller_not_authorized: "Caller not authorized",
  hoa_common_area_requires_approval: "HOA common-area (needs approval)",
  commercial_requires_quote: "Commercial (needs quote)",
  prior_complaint_unresolved: "Prior complaint",
  low_extraction_confidence: "Low extraction confidence",
  spam_or_wrong_number: "Spam / wrong number",
  caller_phone_missing: "Caller phone missing",
  do_not_contact_requested: "Do not contact",
  after_hours_emergency: "After-hours emergency",
  not_confirmed: "Time not confirmed",
  confirmed_without_start_time: "Confirmed, no start time",
  low_confidence: "Low confidence",
};

function reasonLabel(code) {
  if (!code) return "Needs review";
  return REASON_LABELS[code] || code.replace(/_/g, " ");
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function callerName(item) {
  const full = [item.first_name, item.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  const phone = item.customer_phone || item.from_phone || item.to_phone;
  return phone || "Unknown caller";
}

export default function TriageInboxTabV2() {
  const [status, setStatus] = useState("open");
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ open: 0, in_progress: 0, resolved: 0, dismissed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actioning, setActioning] = useState(null); // item id mid-action
  const [noteFor, setNoteFor] = useState(null); // { item, action } when confirming with a note

  const load = useCallback((next) => {
    setLoading(true);
    setError("");
    adminFetch(`/admin/triage?status=${next}`)
      .then((d) => {
        setItems(d.items || []);
        setCounts(d.counts || {});
        setLoading(false);
      })
      .catch((err) => {
        setError(isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : "Failed to load triage items.");
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(status); }, [status, load]);

  const runAction = (item, action, note) => {
    setActioning(item.id);
    adminFetch(`/admin/triage/${item.id}/${action}`, {
      method: "PUT",
      body: JSON.stringify({ note: note || null }),
    })
      .then(() => {
        setNoteFor(null);
        setActioning(null);
        // Drop the row locally and move the count to the destination bucket.
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        setCounts((prev) => {
          const c = { ...prev };
          if (c[status] != null) c[status] = Math.max(0, c[status] - 1);
          const dest = action === "resolve" ? "resolved" : "dismissed";
          if (c[dest] != null) c[dest] += 1;
          return c;
        });
      })
      .catch((err) => {
        setActioning(null);
        setError(isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : "Action failed — try again.");
      });
  };

  const isOpenView = status === "open" || status === "in_progress";

  return (
    <div className="flex flex-col gap-4 px-3 md:px-0 pb-10">
      {/* Status filter chips */}
      <div className="flex gap-2 flex-wrap pt-3">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setStatus(t.key)}
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-3 rounded-md border-hairline text-13 font-medium transition-colors",
              status === t.key
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-surface-card text-ink-secondary border-zinc-200 hover:bg-surface-hover"
            )}
          >
            {t.label}
            <span className={cn("text-11", status === t.key ? "text-zinc-300" : "text-ink-tertiary")}>
              {counts[t.key] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 text-13 text-alert-fg bg-alert-bg border-hairline border-alert-fg/30 rounded-md px-3 py-2">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {error}
        </div>
      )}

      <Card>
        <CardBody>
          {loading ? (
            <div className="p-8 text-center text-ink-tertiary text-14">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center">
              <Inbox size={28} strokeWidth={1.5} className="mx-auto text-ink-disabled mb-2" aria-hidden />
              <div className="text-14 text-ink-secondary">
                {status === "open" ? "No calls awaiting review." : "Nothing here."}
              </div>
              <div className="text-12 text-ink-tertiary mt-1">
                Calls the AI can't safely auto-route land here for a quick human check.
              </div>
            </div>
          ) : (
            <div className="divide-y divide-zinc-200">
              {items.map((item) => {
                const synopsis = item.lead_synopsis || item.call_summary || item.summary || "No summary available.";
                const recId = item.recording_sid || item.call_log_id;
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "py-4 first:pt-0 last:pb-0 pl-3 border-l-[3px]",
                      isOpenView && item.severity === "blocking"
                        ? "border-l-alert-fg bg-alert-bg/30"
                        : "border-l-transparent"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-14 font-medium text-zinc-900 truncate">{callerName(item)}</span>
                          <Badge tone={item.severity === "blocking" ? "alert" : "neutral"}>
                            {reasonLabel(item.reason_code)}
                          </Badge>
                          {item.severity === "advisory" && (
                            <span className="text-11 uppercase tracking-label text-ink-tertiary">advisory</span>
                          )}
                        </div>
                        <div className="text-12 text-ink-tertiary mt-0.5">
                          {(item.customer_phone || item.from_phone || "")}{" · "}
                          {timeAgo(item.call_created_at || item.created_at)}
                        </div>
                      </div>
                      {isOpenView && (
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={actioning === item.id}
                            onClick={() => setNoteFor({ item, action: "dismiss" })}
                          >
                            <XCircle size={13} strokeWidth={1.75} className="mr-1" aria-hidden /> Dismiss
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={actioning === item.id}
                            onClick={() => setNoteFor({ item, action: "resolve" })}
                          >
                            <CheckCircle2 size={13} strokeWidth={1.75} className="mr-1" aria-hidden /> Resolve
                          </Button>
                        </div>
                      )}
                    </div>

                    <p className="text-13 text-ink-secondary mt-2 whitespace-pre-wrap line-clamp-6">{synopsis}</p>

                    {item.resolution_note && (
                      <div className="text-12 text-ink-tertiary mt-2 italic">Note: {item.resolution_note}</div>
                    )}

                    {item.recording_url && (
                      <div className="mt-2 bg-zinc-50 border-hairline rounded-md p-2">
                        <div className="flex items-center gap-1.5 text-11 text-ink-tertiary font-medium mb-1">
                          <PhoneCall size={11} strokeWidth={1.75} aria-hidden /> Recording
                        </div>
                        <audio controls preload="none" className="w-full h-8">
                          <source
                            src={`${API_BASE}/admin/call-recordings/audio/${recId}?token=${encodeURIComponent(localStorage.getItem("waves_admin_token") || "")}`}
                            type="audio/mpeg"
                          />
                        </audio>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Resolve / dismiss confirm with optional note */}
      <Dialog open={!!noteFor} onClose={() => setNoteFor(null)} size="sm">
        {noteFor && (
          <>
            <DialogHeader>
              <DialogTitle>
                {noteFor.action === "resolve" ? "Resolve" : "Dismiss"} — {callerName(noteFor.item)}
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="text-13 text-ink-secondary mb-2">
                {noteFor.action === "resolve"
                  ? "Mark this call handled. Add a note for the record (optional)."
                  : "Dismiss this flag (not actionable). Add a note (optional)."}
              </p>
              <Textarea id="triage-note" rows={3} placeholder="Note (optional)…" defaultValue="" />
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={() => setNoteFor(null)}>Cancel</Button>
              <Button
                variant={noteFor.action === "resolve" ? "primary" : "danger"}
                size="sm"
                disabled={actioning === noteFor.item.id}
                onClick={() => {
                  const note = document.getElementById("triage-note")?.value?.trim() || null;
                  runAction(noteFor.item, noteFor.action, note);
                }}
              >
                {actioning === noteFor.item.id ? "Saving…" : noteFor.action === "resolve" ? "Resolve" : "Dismiss"}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </div>
  );
}
