import React, { useState, useEffect, useCallback } from "react";
import { Inbox, PhoneCall, CheckCircle2, XCircle, AlertTriangle, ThumbsUp, ThumbsDown, Zap } from "lucide-react";
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

// What the reviewer can mark wrong on a Deny. Kept in sync with the server
// whitelist in routes/admin-triage.js (WRONG_FIELDS).
const WRONG_FIELD_OPTIONS = [
  { key: "name", label: "Name" },
  { key: "address", label: "Address" },
  { key: "service", label: "Service" },
  { key: "scheduling", label: "Date / time" },
  { key: "consent", label: "SMS consent" },
  { key: "spam_status", label: "Spam vs legit" },
  { key: "routing", label: "Routing (wrong call)" },
];

// Human-readable labels for the deterministic + model triage reasons.
const REASON_LABELS = {
  out_of_service_area: "Out of service area",
  missing_service_address: "Missing address",
  address_unverifiable: "Address unverifiable",
  address_unverified: "Address unverified",
  address_validation_unavailable: "Address check unavailable",
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
  name_email_mismatch: "Name / email mismatch",
  not_confirmed: "Time not confirmed",
  confirmed_without_start_time: "Confirmed, no start time",
  low_confidence: "Low confidence",
  address_recovered: "Address recovered — read back",
  email_unverified: "Email spelled — read back",
  email_invalid: "Email couldn't be captured",
};

// Correction evidence the call processor attaches to address/email review
// items (as-heard value, recovered/candidate values, and the exact question
// to ask on the callback). payload is jsonb — object from pg, string if a
// route ever serializes it.
function parsePayload(payload) {
  if (!payload) return null;
  if (typeof payload === "object") return payload;
  try { return JSON.parse(payload); } catch { return null; }
}

function ConfirmEvidence({ payload }) {
  const p = parsePayload(payload);
  if (!p) return null;
  const emailCandidates = Array.isArray(p.email_candidates) ? p.email_candidates : [];
  const addressCandidates = Array.isArray(p.address_candidates) ? p.address_candidates : [];
  const rows = [
    p.address_as_heard && { label: "Heard", value: p.address_as_heard },
    p.address_recovered && { label: "Matched to", value: p.address_recovered },
    !p.address_recovered && addressCandidates.length > 0 && { label: "Did you mean", value: addressCandidates.join(" · ") },
    p.email_as_heard && { label: "Heard", value: p.email_as_heard },
    emailCandidates.length > 0 && {
      label: emailCandidates.length === 1 ? "Likely" : "Candidates",
      value: emailCandidates.map((c) => `${c.value}${typeof c.confidence === "number" ? ` (${Math.round(c.confidence * 100)}%)` : ""}`).join(" · "),
    },
  ].filter(Boolean);
  if (!rows.length && !p.confirmation_question) return null;
  return (
    <div className="mt-2 bg-zinc-50 border-hairline rounded-md p-2">
      <div className="text-11 text-ink-tertiary font-medium mb-1">Confirm before dispatch</div>
      {rows.map((r) => (
        <div key={`${r.label}-${r.value}`} className="text-12 text-ink-secondary">
          <span className="text-ink-tertiary">{r.label}:</span> {r.value}
        </div>
      ))}
      {p.confirmation_question && (
        <div className="text-12 text-zinc-900 mt-1">Ask: “{p.confirmation_question}”</div>
      )}
    </div>
  );
}

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

function parseWrongFields(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) || []; } catch { return []; }
}

function VerdictBadge({ verdict, wrongFields }) {
  if (!verdict) return null;
  if (verdict === "accept") return <Badge tone="strong">Accepted</Badge>;
  const fields = parseWrongFields(wrongFields);
  const labels = fields
    .map((f) => WRONG_FIELD_OPTIONS.find((o) => o.key === f)?.label || f)
    .join(", ");
  return <Badge tone="alert">Denied{labels ? ` · ${labels}` : ""}</Badge>;
}

export default function TriageInboxTabV2() {
  const [mode, setMode] = useState("triage"); // 'triage' | 'auto_routed'
  const [status, setStatus] = useState("open");
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ open: 0, in_progress: 0, resolved: 0, dismissed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actioning, setActioning] = useState(null);
  const [dismissFor, setDismissFor] = useState(null); // triage item being dismissed (note dialog)
  const [denyFor, setDenyFor] = useState(null); // { item, kind } — field-picker dialog
  const [denyFields, setDenyFields] = useState([]);

  const load = useCallback((nextMode, nextStatus) => {
    setLoading(true);
    setError("");
    const url = nextMode === "auto_routed" ? `/admin/triage/auto-routed` : `/admin/triage?status=${nextStatus}`;
    adminFetch(url)
      .then((d) => {
        setItems(d.items || []);
        if (d.counts) setCounts(d.counts);
        setLoading(false);
      })
      .catch((err) => {
        setError(isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : "Failed to load.");
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(mode, status); }, [mode, status, load]);

  // Record a verdict (accept, or deny with fields). kind = 'triage' | 'auto_routed'.
  const recordVerdict = (item, kind, verdict, wrongFields, note) => {
    const busyKey = kind === "triage" ? item.id : item.call_log_id;
    setActioning(busyKey);
    const url = kind === "triage"
      ? `/admin/triage/${item.id}/verdict`
      : `/admin/triage/auto-routed/${item.call_log_id}/verdict`;
    adminFetch(url, {
      method: "POST",
      body: JSON.stringify({ verdict, wrong_fields: wrongFields || [], note: note || null }),
    })
      .then(() => {
        setActioning(null);
        setDenyFor(null);
        setDenyFields([]);
        if (kind === "triage") {
          // A verdict is call-level: the server resolves every open flag for the
          // call, so drop all sibling rows for this call_log_id, not just the
          // clicked one, and move that many into the resolved bucket.
          const removed = items.filter((i) => i.call_log_id === item.call_log_id).length || 1;
          setItems((prev) => prev.filter((i) => i.call_log_id !== item.call_log_id));
          setCounts((prev) => {
            const c = { ...prev };
            if (c[status] != null) c[status] = Math.max(0, c[status] - removed);
            if (c.resolved != null) c.resolved += removed;
            return c;
          });
        } else {
          // Auto-routed list keeps the row; just stamp the verdict locally.
          setItems((prev) => prev.map((i) =>
            i.call_log_id === item.call_log_id
              ? { ...i, feedback_verdict: verdict, feedback_wrong_fields: wrongFields || [] }
              : i));
        }
      })
      .catch((err) => {
        setActioning(null);
        setError(isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : "Action failed — try again.");
      });
  };

  const dismissItem = (item, note) => {
    setActioning(item.id);
    adminFetch(`/admin/triage/${item.id}/dismiss`, {
      method: "PUT",
      body: JSON.stringify({ note: note || null }),
    })
      .then(() => {
        setActioning(null);
        setDismissFor(null);
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        setCounts((prev) => {
          const c = { ...prev };
          if (c[status] != null) c[status] = Math.max(0, c[status] - 1);
          if (c.dismissed != null) c.dismissed += 1;
          return c;
        });
      })
      .catch((err) => {
        setActioning(null);
        setError(isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : "Action failed — try again.");
      });
  };

  const openDeny = (item, kind) => { setDenyFields([]); setDenyFor({ item, kind }); };
  const toggleDenyField = (key) =>
    setDenyFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const isTriage = mode === "triage";
  const isOpenView = isTriage && (status === "open" || status === "in_progress");

  return (
    <div className="flex flex-col gap-4 px-3 md:px-0 pb-10">
      {/* Mode switch: needs-review queue vs auto-routed review */}
      <div className="flex gap-2 flex-wrap pt-3">
        <button
          type="button"
          onClick={() => setMode("triage")}
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-md border-hairline text-13 font-medium transition-colors",
            isTriage ? "bg-zinc-900 text-white border-zinc-900" : "bg-surface-card text-ink-secondary border-zinc-200 hover:bg-surface-hover"
          )}
        >
          <Inbox size={13} strokeWidth={1.75} aria-hidden /> Needs review
        </button>
        <button
          type="button"
          onClick={() => setMode("auto_routed")}
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-md border-hairline text-13 font-medium transition-colors",
            !isTriage ? "bg-zinc-900 text-white border-zinc-900" : "bg-surface-card text-ink-secondary border-zinc-200 hover:bg-surface-hover"
          )}
        >
          <Zap size={13} strokeWidth={1.75} aria-hidden /> Auto-routed
        </button>
      </div>

      {/* Status filter chips (triage mode only) */}
      {isTriage && (
        <div className="flex gap-2 flex-wrap">
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
      )}

      {error && (
        <div className="flex items-center gap-2 text-13 text-alert-fg bg-alert-bg border-hairline border-alert-fg/30 rounded-md px-3 py-2">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {error}
        </div>
      )}

      {!isTriage && (
        <p className="text-12 text-ink-tertiary -mb-1">
          Calls the AI booked automatically. Press <span className="font-medium">Accept</span> if the appointment is right,
          <span className="font-medium"> Deny</span> if anything's off — this trains future routing.
        </p>
      )}

      <Card>
        <CardBody>
          {loading ? (
            <div className="p-8 text-center text-ink-tertiary text-14">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center">
              <Inbox size={28} strokeWidth={1.5} className="mx-auto text-ink-disabled mb-2" aria-hidden />
              <div className="text-14 text-ink-secondary">
                {isTriage ? (status === "open" ? "No calls awaiting review." : "Nothing here.") : "No auto-routed calls yet."}
              </div>
              <div className="text-12 text-ink-tertiary mt-1">
                {isTriage
                  ? "Calls the AI can't safely auto-route land here for a quick human check."
                  : "When the AI books a call automatically, it shows here for an accept/deny check."}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-zinc-200">
              {items.map((item) => {
                const synopsis = item.lead_synopsis || item.call_summary || item.summary || "No summary available.";
                const recId = item.recording_sid || item.call_log_id;
                const busyKey = isTriage ? item.id : item.call_log_id;
                return (
                  <div
                    key={isTriage ? item.id : item.route_decision_id}
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
                          {isTriage ? (
                            <Badge tone={item.severity === "blocking" ? "alert" : "neutral"}>
                              {reasonLabel(item.reason_code)}
                            </Badge>
                          ) : (
                            <Badge tone="neutral">Auto-routed{item.sms_enqueued ? " · SMS sent" : ""}</Badge>
                          )}
                          <VerdictBadge verdict={item.feedback_verdict} wrongFields={item.feedback_wrong_fields} />
                        </div>
                        <div className="text-12 text-ink-tertiary mt-0.5">
                          {(item.customer_phone || item.from_phone || "")}{" · "}
                          {timeAgo(item.call_created_at || item.created_at)}
                        </div>
                      </div>

                      {/* Actions: open triage items, or ANY auto-routed call.
                          Auto-routed rows keep both buttons even after a verdict
                          so an accidental deny (or a changed mind) can be flipped
                          back to accept — the verdict badge shows current state. */}
                      {(isOpenView || !isTriage) && (
                        <div className="flex items-center gap-2 shrink-0">
                          {isOpenView && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={actioning === busyKey}
                              onClick={() => setDismissFor(item)}
                            >
                              <XCircle size={13} strokeWidth={1.75} className="mr-1" aria-hidden /> Dismiss
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={actioning === busyKey}
                            onClick={() => openDeny(item, isTriage ? "triage" : "auto_routed")}
                          >
                            <ThumbsDown size={13} strokeWidth={1.75} className="mr-1" aria-hidden /> Deny
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={actioning === busyKey}
                            onClick={() => recordVerdict(item, isTriage ? "triage" : "auto_routed", "accept")}
                          >
                            <ThumbsUp size={13} strokeWidth={1.75} className="mr-1" aria-hidden /> Accept
                          </Button>
                        </div>
                      )}
                    </div>

                    <p className="text-13 text-ink-secondary mt-2 whitespace-pre-wrap line-clamp-6">{synopsis}</p>

                    {isTriage && <ConfirmEvidence payload={item.payload} />}

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

      {/* Deny → "what was wrong?" field picker */}
      <Dialog open={!!denyFor} onClose={() => setDenyFor(null)} size="sm">
        {denyFor && (
          <>
            <DialogHeader>
              <DialogTitle>What was wrong? — {callerName(denyFor.item)}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="text-13 text-ink-secondary mb-3">
                Tap each part the AI got wrong. This is how the router learns where it's misfiring.
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                {WRONG_FIELD_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => toggleDenyField(o.key)}
                    className={cn(
                      "h-8 px-3 rounded-md border-hairline text-13 font-medium transition-colors",
                      denyFields.includes(o.key)
                        ? "bg-zinc-900 text-white border-zinc-900"
                        : "bg-surface-card text-ink-secondary border-zinc-200 hover:bg-surface-hover"
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <Textarea id="deny-note" rows={2} placeholder="Note (optional)…" defaultValue="" />
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={() => setDenyFor(null)}>Cancel</Button>
              <Button
                variant="danger"
                size="sm"
                disabled={actioning === (denyFor.kind === "triage" ? denyFor.item.id : denyFor.item.call_log_id)}
                onClick={() => {
                  const note = document.getElementById("deny-note")?.value?.trim() || null;
                  recordVerdict(denyFor.item, denyFor.kind, "deny", denyFields, note);
                }}
              >
                Submit deny
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>

      {/* Dismiss (triage only) — not actionable, no verdict */}
      <Dialog open={!!dismissFor} onClose={() => setDismissFor(null)} size="sm">
        {dismissFor && (
          <>
            <DialogHeader>
              <DialogTitle>Dismiss — {callerName(dismissFor)}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="text-13 text-ink-secondary mb-2">
                Dismiss this flag (not actionable — no accept/deny recorded). Add a note (optional).
              </p>
              <Textarea id="dismiss-note" rows={3} placeholder="Note (optional)…" defaultValue="" />
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" size="sm" onClick={() => setDismissFor(null)}>Cancel</Button>
              <Button
                variant="danger"
                size="sm"
                disabled={actioning === dismissFor.id}
                onClick={() => {
                  const note = document.getElementById("dismiss-note")?.value?.trim() || null;
                  dismissItem(dismissFor, note);
                }}
              >
                {actioning === dismissFor.id ? "Saving…" : "Dismiss"}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </div>
  );
}
