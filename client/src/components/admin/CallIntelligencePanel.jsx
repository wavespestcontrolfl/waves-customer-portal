// client/src/components/admin/CallIntelligencePanel.jsx
// Per-call review surface for the Calls tab (V2 zinc system + components/ui).
//
// Reads GET /admin/call-recordings/calls/:id/intelligence — one normalized
// object built from what the pipeline already persisted — and lets the
// office act on it without replaying the recording:
//   - summary, outcome, intent, appointment, prices, objections;
//   - the honest processing state (queued / processing / complete / failed,
//     with the reason) instead of a green tick inferred from a transcript;
//   - evidence-linked commitments: what Waves promised and what the caller
//     agreed to, each confirmable, dismissable, markable done, or editable —
//     a human verdict survives every reprocess; "Jump" hands the quote to
//     the transcript so it can be checked in seconds;
//   - whether a promise was kept (the later record that fulfilled it, with
//     the basis of the match — never a summary's say-so);
//   - the customer link with its source (generated vs set by a person) and
//     a way to repoint it;
//   - recordings that arrived after processing, adoptable in one click;
//   - later outcomes (lead, estimate, visit, invoice) as associations.
import { useEffect, useState } from "react";
import { Badge, Button, Input, Select, cn } from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

const PHASE_LABEL = {
  queued: "Queued",
  waiting_for_recording: "Waiting for recording",
  processing: "Processing",
  complete: "Complete",
  failed_retrying: "Failed — retrying",
  failed: "Failed",
  unknown: "Unknown state",
};

const KIND_LABEL = {
  send_estimate: "Send estimate",
  send_appointment_confirmation: "Send appointment confirmation",
  callback: "Call back",
  send_report: "Send report",
  send_paperwork: "Send paperwork",
  technician_follow_up: "Technician follow-up",
  schedule_visit: "Schedule visit",
  send_photos: "Send photos",
  confirm_date: "Confirm date",
  call_back: "Call us back",
  provide_info: "Provide info",
  make_payment: "Make payment",
  other: "Other",
};

const WAVES_KINDS = ["send_estimate", "send_appointment_confirmation", "callback", "send_report", "send_paperwork", "technician_follow_up", "schedule_visit", "other"];
const CUSTOMER_KINDS = ["send_photos", "confirm_date", "call_back", "provide_info", "make_payment", "other"];

function fmtWhen(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function humanize(value) {
  return value ? String(value).replace(/_/g, " ") : null;
}

function Row({ label, children }) {
  if (children == null || children === "" || (Array.isArray(children) && !children.length)) return null;
  return (
    <div className="flex gap-2 text-14 md:text-12">
      <span className="w-28 shrink-0 text-ink-tertiary">{label}</span>
      <span className="text-ink-secondary min-w-0 break-words">{children}</span>
    </div>
  );
}

export function commitmentStatusTone(c) {
  if (c.status === "fulfilled") return "strong";
  if (c.status === "dismissed") return "neutral";
  return c.due_at && new Date(c.due_at).getTime() < Date.now() ? "alert" : "neutral";
}

export default function CallIntelligencePanel({ callId, onJumpToQuote }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: "idle", data: null, error: null });
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(null); // { id, description, due_at }
  const [adding, setAdding] = useState(null); // { party, kind, description, due_at }
  const [relink, setRelink] = useState(null); // { query, results }

  const load = async () => {
    setState((s) => ({ ...s, status: "loading", error: null }));
    try {
      const body = await adminFetch(`/admin/call-recordings/calls/${encodeURIComponent(callId)}/intelligence`);
      setState({ status: "ready", data: body.intelligence, error: null });
    } catch (err) {
      setState({ status: "error", data: null, error: err.message || "Could not load call intelligence." });
    }
  };

  // Load once, the first time the panel is opened; `load` is stable for the
  // life of the component (it closes over callId only).
  useEffect(() => {
    if (open && state.status === "idle") load();
  }, [open, state.status]);

  const act = async (label, fn) => {
    if (busy) return;
    setBusy(label);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setNotice({ tone: "alert", text: err.message || "That change did not save." });
    } finally {
      setBusy(null);
    }
  };

  const patchCommitment = (id, payload) =>
    adminFetch(`/admin/call-recordings/commitments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) });

  const view = state.data;

  return (
    <div className="mt-1.5 ml-8 bg-zinc-50 border-hairline rounded-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 p-2 text-left u-focus-ring min-h-11 sm:min-h-0"
        aria-expanded={open}
      >
        <span className="text-13 md:text-11 text-ink-tertiary font-medium">Call intelligence</span>
        <span aria-hidden className="text-12 text-ink-tertiary">{open ? "▾" : "▸"}</span>
      </button>

      {open && state.status === "loading" && (
        <div className="px-2 pb-2 text-13 md:text-12 text-ink-tertiary" role="status" aria-live="polite">Loading…</div>
      )}
      {open && state.status === "error" && (
        <div className="px-2 pb-2 text-13 md:text-12 text-alert-fg" role="alert">
          {state.error}{" "}
          <button type="button" className="underline u-focus-ring" onClick={load}>Retry</button>
        </div>
      )}

      {open && view && (
        <div className="px-2 pb-2 space-y-3">
          {notice && (
            <div className={cn("text-13 md:text-12", notice.tone === "alert" ? "text-alert-fg" : "text-ink-secondary")} role="status" aria-live="polite">
              {notice.text}
            </div>
          )}

          {/* Processing truth */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={view.processing.phase === "failed" ? "alert" : view.processing.phase === "complete" ? "strong" : "neutral"} dot>
              {PHASE_LABEL[view.processing.phase] || view.processing.phase}
            </Badge>
            {view.processing.review_status && (view.processing.review_status === "open" || view.processing.review_status === "in_progress") && (
              <Badge tone="alert">Needs review</Badge>
            )}
            {view.processing.generation != null && (
              <span className="text-12 md:text-11 text-ink-tertiary">pass {view.processing.generation}</span>
            )}
            {view.processing.timings?.total_ms != null && (
              <span className="text-12 md:text-11 text-ink-tertiary">{Math.round(view.processing.timings.total_ms / 1000)}s</span>
            )}
          </div>
          {view.processing.detail && (
            <div className="text-13 md:text-12 text-ink-secondary">{view.processing.detail}</div>
          )}
          {Array.isArray(view.processing.validation_errors) && view.processing.validation_errors.length > 0 && (
            <div className="text-13 md:text-12 text-ink-tertiary">
              Extraction schema issues: {view.processing.validation_errors.map((e) => `${e.instancePath || ""} ${e.message || ""}`.trim()).join("; ")}
            </div>
          )}

          {/* Summary + facts */}
          {view.summary && <p className="text-14 md:text-12 text-ink-primary leading-relaxed">{view.summary}</p>}
          <div className="space-y-0.5">
            <Row label="Outcome">
              {[humanize(view.outcome.disposition), view.outcome.recommended_disposition && `suggested: ${humanize(view.outcome.recommended_disposition)}`, humanize(view.outcome.call_nature)].filter(Boolean).join(" · ")}
            </Row>
            <Row label="Intent">
              {[humanize(view.intent.primary_service_category), view.intent.specific_service_name, humanize(view.intent.service_intent), humanize(view.intent.urgency)].filter(Boolean).join(" · ")}
            </Row>
            <Row label="Pests">{view.intent.pests_observed.map(humanize).join(", ")}</Row>
            <Row label="Property">{[view.property.address, humanize(view.property.property_type), view.property.pets_on_property ? `pets: ${view.property.pet_notes || "yes"}` : null].filter(Boolean).join(" · ")}</Row>
            <Row label="Appointment">
              {view.appointment.status && view.appointment.status !== "none"
                ? [humanize(view.appointment.status), fmtWhen(view.appointment.confirmed_start_at), view.appointment.preferred_time_of_day && `prefers ${view.appointment.preferred_time_of_day}`].filter(Boolean).join(" · ")
                : null}
            </Row>
            <Row label="Price">
              {view.prices.quoted_price_usd != null
                ? `$${view.prices.quoted_price_usd} (${humanize(view.prices.quote_type)})`
                : view.prices.quote_promised ? "estimate promised" : view.prices.quote_requested ? "quote requested" : null}
            </Row>
            <Row label="Objections">{view.objections.join("; ")}</Row>
            <Row label="Buying signals">{view.buying_signals.join("; ")}</Row>
            <Row label="Lead quality">{[humanize(view.outcome.lead_quality), humanize(view.outcome.sentiment), view.confidence?.overall != null && `confidence ${Math.round(view.confidence.overall * 100)}%`].filter(Boolean).join(" · ")}</Row>
          </div>

          {/* Next action */}
          {view.next_action && (
            <div className="text-14 md:text-12 text-ink-primary">
              <span className="text-ink-tertiary">Next: </span>
              {view.next_action.action}
              {view.next_action.due_at && <span className="text-ink-tertiary"> · by {fmtWhen(view.next_action.due_at)}</span>}
              <span className="text-ink-tertiary"> · {view.next_action.owner}</span>
            </div>
          )}

          {/* Customer link */}
          <div className="text-14 md:text-12 flex flex-wrap items-center gap-2">
            <span className="text-ink-tertiary">Customer:</span>
            <span className="text-ink-secondary">{view.links.customer_name || (view.links.customer_id ? view.links.customer_id : "not linked")}</span>
            <Badge tone={view.links.customer_link.source === "human" ? "strong" : "neutral"}>
              {view.links.customer_link.source === "human" ? "set by office" : view.links.customer_link.source === "generated" ? "generated" : "none"}
            </Badge>
            <Button size="sm" variant="secondary" onClick={() => setRelink(relink ? null : { query: "", results: [] })} aria-label="Change linked customer">
              {relink ? "Cancel" : "Change"}
            </Button>
          </div>
          {relink && (
            <div className="space-y-1.5">
              <Input
                aria-label="Search customers by name or phone"
                placeholder="Search customers by name or phone"
                value={relink.query}
                onChange={async (e) => {
                  const query = e.target.value;
                  setRelink((r) => ({ ...r, query }));
                  if (query.trim().length < 2) return;
                  try {
                    const body = await adminFetch(`/admin/customers?search=${encodeURIComponent(query.trim())}&limit=8`);
                    const results = Array.isArray(body?.customers) ? body.customers : Array.isArray(body) ? body : [];
                    setRelink((r) => (r ? { ...r, results } : r));
                  } catch (err) {
                    setNotice({ tone: "alert", text: err.message || "Customer search failed." });
                  }
                }}
              />
              <div className="flex flex-wrap gap-1.5">
                {relink.results.map((cust) => (
                  <Button
                    key={cust.id}
                    size="sm"
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => act("relink", async () => {
                      await adminFetch(`/admin/call-recordings/calls/${encodeURIComponent(callId)}/customer`, { method: "PUT", body: JSON.stringify({ customer_id: cust.id }) });
                      setRelink(null);
                    })}
                  >
                    {[cust.first_name, cust.last_name].filter(Boolean).join(" ") || cust.id}
                  </Button>
                ))}
                {view.links.customer_id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => act("unlink", async () => {
                      await adminFetch(`/admin/call-recordings/calls/${encodeURIComponent(callId)}/customer`, { method: "PUT", body: JSON.stringify({ customer_id: null }) });
                      setRelink(null);
                    })}
                  >
                    Unlink
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Commitments */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-13 md:text-11 text-ink-tertiary font-medium uppercase tracking-label">Commitments</span>
              <Button size="sm" variant="ghost" onClick={() => setAdding(adding ? null : { party: "waves", kind: "callback", description: "", due_at: "" })}>
                {adding ? "Cancel" : "Add"}
              </Button>
            </div>
            {adding && (
              <form
                className="mt-1.5 space-y-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  act("add", async () => {
                    await adminFetch(`/admin/call-recordings/calls/${encodeURIComponent(callId)}/commitments`, {
                      method: "POST",
                      body: JSON.stringify({ party: adding.party, kind: adding.kind, description: adding.description, due_at: adding.due_at || null }),
                    });
                    setAdding(null);
                  });
                }}
              >
                <div className="flex flex-wrap gap-1.5">
                  <Select aria-label="Who committed" value={adding.party} onChange={(e) => setAdding((a) => ({ ...a, party: e.target.value, kind: e.target.value === "waves" ? "callback" : "send_photos" }))}>
                    <option value="waves">Waves promised</option>
                    <option value="customer">Customer agreed</option>
                  </Select>
                  <Select aria-label="Commitment kind" value={adding.kind} onChange={(e) => setAdding((a) => ({ ...a, kind: e.target.value }))}>
                    {(adding.party === "waves" ? WAVES_KINDS : CUSTOMER_KINDS).map((k) => (
                      <option key={k} value={k}>{KIND_LABEL[k]}</option>
                    ))}
                  </Select>
                </div>
                <Input aria-label="Commitment description" required placeholder="What exactly was promised" value={adding.description} onChange={(e) => setAdding((a) => ({ ...a, description: e.target.value }))} />
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input aria-label="Due date and time" type="datetime-local" value={adding.due_at} onChange={(e) => setAdding((a) => ({ ...a, due_at: e.target.value }))} />
                  <Button size="sm" type="submit" disabled={!!busy || !adding.description.trim()}>Save</Button>
                </div>
              </form>
            )}
            {view.commitments.length === 0 && !adding && (
              <div className="mt-1 text-13 md:text-12 text-ink-tertiary">No commitments were detected on this call.</div>
            )}
            <ul className="mt-1 space-y-1.5">
              {view.commitments.map((c) => {
                const stale = view.processing.generation != null && c.source === "ai" && c.last_seen_generation != null && c.last_seen_generation < view.processing.generation;
                const isEditing = editing?.id === c.id;
                return (
                  <li key={c.id} className="border-hairline rounded-md bg-white p-2 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={c.party === "waves" ? "strong" : "neutral"}>{c.party === "waves" ? "Waves" : "Customer"}</Badge>
                      <span className="text-13 md:text-11 text-ink-tertiary">{KIND_LABEL[c.kind] || humanize(c.kind)}</span>
                      <Badge tone={commitmentStatusTone(c)} dot>{c.status}</Badge>
                      <Badge tone="neutral">{c.source === "human" ? "office" : c.human_state ? `AI · ${c.human_state}` : "AI"}</Badge>
                      {stale && <span className="text-12 md:text-11 text-ink-tertiary">not detected on pass {view.processing.generation}</span>}
                      {c.confidence != null && c.source !== "human" && (
                        <span className="text-12 md:text-11 text-ink-tertiary">{Math.round(c.confidence * 100)}%</span>
                      )}
                    </div>
                    {isEditing ? (
                      <form
                        className="space-y-1.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          act("edit", async () => {
                            await patchCommitment(c.id, { action: "edit", description: editing.description, due_at: editing.due_at || null });
                            setEditing(null);
                          });
                        }}
                      >
                        <Input aria-label="Edit description" value={editing.description} onChange={(e) => setEditing((s) => ({ ...s, description: e.target.value }))} />
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Input aria-label="Edit due date" type="datetime-local" value={editing.due_at} onChange={(e) => setEditing((s) => ({ ...s, due_at: e.target.value }))} />
                          <Button size="sm" type="submit" disabled={!!busy}>Save</Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                        </div>
                      </form>
                    ) : (
                      <div className="text-14 md:text-12 text-ink-primary">
                        {c.description}
                        {c.due_at && <span className="text-ink-tertiary"> · due {fmtWhen(c.due_at)}{c.due_basis === "suggested" ? " (suggested)" : ""}</span>}
                      </div>
                    )}
                    {c.status === "fulfilled" && c.fulfillment && (
                      <div className="text-13 md:text-12 text-ink-secondary">
                        Kept: {humanize(c.fulfillment.kind)}{c.fulfillment.matched_at ? ` on ${fmtWhen(c.fulfillment.matched_at)}` : ""}
                        <span className="text-ink-tertiary"> · {humanize(c.fulfillment.basis)}</span>
                      </div>
                    )}
                    {c.human_note && <div className="text-13 md:text-12 text-ink-tertiary">Note: {c.human_note}</div>}
                    {Array.isArray(c.evidence) && c.evidence.length > 0 && (
                      <ul className="space-y-0.5">
                        {c.evidence.map((e, i) => (
                          <li key={i} className="text-13 md:text-12 text-ink-secondary italic flex flex-wrap items-baseline gap-1.5">
                            <span>
                              {e.speaker ? `${e.speaker === "agent" ? "Agent" : "Caller"}: ` : ""}"{e.quote}"
                              {e.start_ms != null && <span className="not-italic text-ink-tertiary"> @{Math.floor(e.start_ms / 60000)}:{String(Math.floor((e.start_ms % 60000) / 1000)).padStart(2, "0")}</span>}
                              {e.matched === false && <span className="not-italic text-ink-tertiary"> (not found in transcript)</span>}
                            </span>
                            {e.matched !== false && onJumpToQuote && (
                              <button type="button" className="not-italic text-12 md:text-11 underline u-focus-ring" onClick={() => onJumpToQuote(e.quote)}>
                                Jump
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {!isEditing && (
                      <div className="flex flex-wrap gap-1.5">
                        {c.status === "open" && c.human_state !== "confirmed" && (
                          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act("confirm", () => patchCommitment(c.id, { action: "confirm" }))}>Confirm</Button>
                        )}
                        {c.status === "open" && (
                          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => act("fulfill", () => patchCommitment(c.id, { action: "fulfill" }))}>Mark done</Button>
                        )}
                        {c.status === "open" && (
                          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("dismiss", () => patchCommitment(c.id, { action: "dismiss" }))}>Dismiss</Button>
                        )}
                        {c.status !== "open" && (
                          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("reopen", () => patchCommitment(c.id, { action: "reopen" }))}>Reopen</Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() => setEditing({ id: c.id, description: c.description, due_at: c.due_at ? new Date(c.due_at).toISOString().slice(0, 16) : "" })}
                        >
                          Edit
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Parked recordings */}
          {view.recordings.additional.length > 0 && (
            <div className="space-y-1">
              <span className="text-13 md:text-11 text-ink-tertiary font-medium uppercase tracking-label">Recordings that arrived later</span>
              {view.recordings.additional.map((r) => (
                <div key={r.recording_sid} className="flex flex-wrap items-center gap-2 text-13 md:text-12 text-ink-secondary">
                  <span>
                    {r.recording_duration_seconds != null ? `${r.recording_duration_seconds}s` : "unknown length"}
                    {r.received_at ? ` · received ${fmtWhen(r.received_at)}` : ""}
                    {r.parked_because ? ` · ${humanize(r.parked_because)}` : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => act("adopt", () => adminFetch(`/admin/call-recordings/calls/${encodeURIComponent(callId)}/adopt-recording`, { method: "POST", body: JSON.stringify({ recording_sid: r.recording_sid }) }))}
                  >
                    Use this recording & reprocess
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Later outcomes */}
          {view.outcomes && (view.outcomes.lead || view.outcomes.estimates.length || view.outcomes.appointments.length || view.outcomes.invoices.length) ? (
            <div className="space-y-0.5">
              <span className="text-13 md:text-11 text-ink-tertiary font-medium uppercase tracking-label">After the call</span>
              <Row label="Lead">{view.outcomes.lead ? `${humanize(view.outcomes.lead.status)}${view.outcomes.lead.lost_reason ? ` (${humanize(view.outcomes.lead.lost_reason)})` : ""} · ${humanize(view.outcomes.lead.basis)}` : null}</Row>
              <Row label="Estimates">{view.outcomes.estimates.map((e) => `${humanize(e.status)}${e.sent_at ? ` sent ${fmtWhen(e.sent_at)}` : ""}${e.accepted_at ? `, accepted ${fmtWhen(e.accepted_at)}` : ""} · ${humanize(e.basis)}`).join("; ")}</Row>
              <Row label="Visits">{view.outcomes.appointments.map((a) => `${humanize(a.status)} ${a.scheduled_date || ""}${a.completed_at ? " (completed)" : ""} · ${humanize(a.basis)}`).join("; ")}</Row>
              <Row label="Invoices">{view.outcomes.invoices.map((i) => `${humanize(i.status)}${i.total != null ? ` $${i.total}` : ""}${i.paid_at ? " paid" : ""} · ${humanize(i.basis)}`).join("; ")}</Row>
              {view.outcomes.revenue_cents > 0 && <Row label="Paid">{`$${(view.outcomes.revenue_cents / 100).toFixed(2)} · ${view.outcomes.basis_note}`}</Row>}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
