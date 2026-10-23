import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ActionFeedback, Badge, Button, Checkbox, Field, Input, Select } from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { etDatetimeLocalValue } from "../../lib/timezone";

// Bid Desk checklist panel (GATE_BID_CHECKLIST, dark). The page shows it only when the server says the gate is on
// (`checklist_live` in the bid's reply). It records what the operator knows about a bid: the solicitation type, the
// questions and site-visit dates, the estimate and proposal, the documents that came by email, a checklist and the
// submission record. Nothing here is sent to a buyer, a general contractor or an agency.

export const TYPE_LABEL = {
  quote: "Quote request", itb: "Invitation to bid (ITB)", rfq: "Request for quote (RFQ)", rfp: "Request for proposal (RFP)",
  itn: "Invitation to negotiate (ITN)", federal: "Federal solicitation", gc_subcontract: "General contractor subcontract", other: "Other",
};
const SCORED_VALUE = { true: "scored", false: "pass_fail" };
const scoredOf = (value) => (value === true || value === false ? SCORED_VALUE[value] : "");
const scoredToApi = (value) => (value === "scored" ? true : value === "pass_fail" ? false : null);
const orNull = (value) => (value ? value : null);

function sizeText(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const Section = ({ title, children }) => (
  <section className="mt-4 border-t-hairline border-zinc-200 pt-3">
    <h3 className="mb-2 text-ui-body font-medium text-zinc-900">{title}</h3>
    {children}
  </section>
);

function Details({ bid, busy, save }) {
  const [form, setForm] = useState({});
  useEffect(() => {
    setForm({
      type: bid.solicitation_type || "", scored: scoredOf(bid.scored), questions: etDatetimeLocalValue(bid.questions_due_at),
      walk: etDatetimeLocalValue(bid.job_walk_at), mandatory: !!bid.job_walk_mandatory,
    });
  }, [bid.solicitation_type, bid.scored, bid.questions_due_at, bid.job_walk_at, bid.job_walk_mandatory]);
  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field id="bid-type" label="Solicitation type">
        <Select value={form.type ?? ""} onChange={set("type")}>
          <option value="">Not set</option>
          {Object.entries(TYPE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </Field>
      <Field id="bid-scored" label="How it is judged">
        <Select value={form.scored ?? ""} onChange={set("scored")}>
          <option value="">Not set</option>
          <option value="scored">Scored proposal</option>
          <option value="pass_fail">Pass or fail</option>
        </Select>
      </Field>
      <Field id="bid-questions" label="Questions due (Eastern time)" help="Reminds the bell 2 days before.">
        <Input type="datetime-local" value={form.questions ?? ""} onChange={set("questions")} />
      </Field>
      <div className="grid gap-1">
        <Field id="bid-walk" label="Site visit or job walk (Eastern time)" help="Reminds the bell 2 days before, once the date is confirmed.">
          <Input type="datetime-local" value={form.walk ?? ""} onChange={set("walk")} />
        </Field>
        <Checkbox id="bid-walk-mandatory" label="Mandatory" checked={!!form.mandatory} onChange={set("mandatory")} />
        {bid.job_walk_at && !bid.job_walk_confirmed && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warn">Unconfirmed</Badge>
            <span className="text-ui-caption text-ink-secondary">Read from the invite. No reminder until you confirm it.</span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => save({ jobWalkConfirmed: true }, "Site visit date confirmed")}>Confirm site visit date</Button>
          </div>
        )}
      </div>
      <div>
        <Button disabled={busy} onClick={() => {
          // A date goes in the request only when the operator changed it. The server treats a changed site-visit
          // date as confirmed, so the prefilled date of an invite must not ride along with a type change.
          const body = { solicitationType: orNull(form.type), scored: scoredToApi(form.scored), jobWalkMandatory: !!form.mandatory };
          if (form.questions !== etDatetimeLocalValue(bid.questions_due_at)) body.questionsDueAt = orNull(form.questions);
          if (form.walk !== etDatetimeLocalValue(bid.job_walk_at)) body.jobWalkAt = orNull(form.walk);
          save(body, "Bid details saved");
        }}>Save bid details</Button>
      </div>
    </div>
  );
}

function EstimateLink({ bid, estimate, busy, save }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState(null);
  const [error, setError] = useState("");
  const search = async () => {
    setError("");
    try {
      const res = await adminFetch(`/admin/bid-desk/estimates?q=${encodeURIComponent(query.trim())}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setFound(body.estimates || []);
    } catch (err) {
      setFound(null);
      setError(`Search failed: ${err.message}`);
    }
  };
  if (bid.estimate_id && estimate) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-ui-body">
        <span>{[estimate.slug, estimate.name].filter(Boolean).join(" · ") || "Linked estimate"}</span>
        {estimate.status && <Badge>{estimate.status}</Badge>}
        <Link className="underline" to={estimate.proposal_path}>Open proposal</Link>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => save({ estimateId: null }, "Estimate unlinked")}>Unlink</Button>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 basis-full md:basis-80">
          <Field id="bid-estimate-search" label="Find the estimate" help="Type the estimate number or the customer name.">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Button variant="secondary" disabled={busy || query.trim().length < 2} onClick={search}>Search estimates</Button>
      </div>
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      {found && found.length === 0 && <div className="text-ui-body text-ink-secondary">No estimate matches.</div>}
      {found && found.length > 0 && (
        <ul className="grid gap-1">
          {found.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-ui-body">
              <span>{[row.slug, row.name].filter(Boolean).join(" · ") || row.id}</span>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => save({ estimateId: row.id }, "Estimate linked")}>Link</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Documents({ documents }) {
  const [error, setError] = useState("");
  const download = async (doc) => {
    setError("");
    try {
      const res = await adminFetch(doc.download_path, { skipContentType: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = doc.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Could not download the file. Try again.");
    }
  };
  if (!documents.length) return <div className="text-ui-body text-ink-secondary">No files came with the emails on this bid.</div>;
  return (
    <>
      <ul className="grid gap-1">
        {documents.map((doc) => (
          <li key={doc.id} className="flex flex-wrap items-center gap-2 text-ui-body">
            <span className="min-w-0 break-words font-medium">{doc.name}</span>
            {doc.size != null && <span className="text-ink-secondary">{sizeText(doc.size)}</span>}
            <span className="min-w-0 break-words text-ink-secondary">from “{doc.email_subject || "(no subject)"}”</span>
            {doc.download_path && <Button size="sm" variant="secondary" aria-label={`Download ${doc.name}`} onClick={() => download(doc)}>Download</Button>}
          </li>
        ))}
      </ul>
      {error && <ActionFeedback error className="mt-2">{error}</ActionFeedback>}
    </>
  );
}

function ChecklistRow({ item, first, last, busy, onTick, onNotes, onArchive, onMove }) {
  const [notes, setNotes] = useState(item.notes || "");
  useEffect(() => setNotes(item.notes || ""), [item.notes]);
  return (
    // A stop check (a go / no-go question) sits first and is shaded so it reads apart from the paperwork lines.
    <li data-section={item.section} className={`grid gap-1 rounded-sm border-hairline border-zinc-200 px-3 py-2${item.section === "stop" ? " bg-zinc-50" : ""}`}>
      <div className="flex flex-wrap items-start gap-2">
        <Checkbox id={`check-${item.id}`} label={item.label} checked={!!item.checked_at} disabled={busy} onChange={(event) => onTick(item, event.target.checked)} />
        {!item.required && <Badge>Optional</Badge>}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" disabled={busy || first} aria-label={`Move up: ${item.label}`} onClick={() => onMove(item, -1)}>Up</Button>
          <Button size="sm" variant="ghost" disabled={busy || last} aria-label={`Move down: ${item.label}`} onClick={() => onMove(item, 1)}>Down</Button>
          <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove: ${item.label}`} onClick={() => onArchive(item)}>Remove</Button>
        </span>
      </div>
      {item.source_text && <div className="text-ui-caption text-ink-secondary">From the solicitation: “{item.source_text}”</div>}
      <Input aria-label={`Note: ${item.label}`} placeholder="Note" maxLength={2000} value={notes}
        onChange={(event) => setNotes(event.target.value)} onBlur={() => { if (notes !== (item.notes || "")) onNotes(item, notes); }} />
    </li>
  );
}

function AddRow({ busy, onAdd }) {
  const [label, setLabel] = useState("");
  const [source, setSource] = useState("");
  return (
    <form className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end" onSubmit={async (event) => {
      event.preventDefault();
      if (await onAdd({ label: label.trim(), sourceText: source.trim() || undefined })) { setLabel(""); setSource(""); }
    }}>
      <Field id="bid-add-label" label="New line">
        <Input value={label} maxLength={500} onChange={(event) => setLabel(event.target.value)} />
      </Field>
      <Field id="bid-add-source" label="Quote or page from the solicitation">
        <Input value={source} maxLength={2000} onChange={(event) => setSource(event.target.value)} />
      </Field>
      <Button type="submit" variant="secondary" disabled={busy || !label.trim()}>Add line</Button>
    </form>
  );
}

function Checklist({ bidId, bid, items, progress, busy, run, invite }) {
  const act = (path, method, body, query = "") => adminFetch(`/admin/bid-desk/${bidId}/checklist${path}${query}`, { method, ...(body === undefined ? {} : { body }) });
  const start = (query) => run(() => act("/start", "POST", bid.solicitation_type ? { type: bid.solicitation_type } : {}, query));
  return (
    <>
      {items.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-ui-body">
          <span className="text-ink-secondary">No checklist yet. It starts from the lines for the solicitation type{bid.solicitation_type ? ` (${TYPE_LABEL[bid.solicitation_type]})` : ""}.</span>
          <Button disabled={busy} onClick={() => start("")}>Start checklist</Button>
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-ui-body">
            <Badge tone={progress.required > 0 && progress.checked === progress.required ? "strong" : "neutral"}>{progress.checked}/{progress.required}</Badge>
            <span className="text-ink-secondary">required lines checked</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => start("?add=missing")}>Add missing lines for this type</Button>
          </div>
          <ul className="grid gap-2">
            {items.map((item, index) => (
              <ChecklistRow key={item.id} item={item} first={index === 0} last={index === items.length - 1} busy={busy}
                onTick={(row, checked) => run(() => act(`/${row.id}`, "PATCH", { checked }))}
                onNotes={(row, notes) => run(() => act(`/${row.id}`, "PATCH", { notes }))}
                onArchive={(row) => run(() => act(`/${row.id}`, "DELETE"))}
                onMove={(row, step) => {
                  const ids = items.map((entry) => entry.id);
                  const at = ids.indexOf(row.id);
                  ids.splice(at + step, 0, ids.splice(at, 1)[0]);
                  return run(() => act("/reorder", "POST", { ids }));
                }} />
            ))}
          </ul>
        </>
      )}
      <AddRow busy={busy} onAdd={(row) => run(() => act("", "POST", row))} />
      {invite && items.length > 0 && progress.checked < progress.required && (
        <div className="mt-2 text-ui-caption text-warn-fg">{progress.required - progress.checked} required lines are not checked yet. You can still mark the bid submitted.</div>
      )}
    </>
  );
}

function Submission({ bid, busy, save, invite }) {
  const [at, setAt] = useState("");
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    setAt(etDatetimeLocalValue(bid.submitted_at));
    setConfirmation(bid.submission_confirmation || "");
  }, [bid.submitted_at, bid.submission_confirmation]);
  return (
    <>
      {invite && <div className="mb-2 text-ui-body text-ink-secondary">Record when the bid was handed in and the confirmation number. Neither is required.</div>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] md:items-end">
        <Field id="bid-submitted-at" label="Submitted (Eastern time)">
          <Input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
        </Field>
        <Field id="bid-confirmation" label="Confirmation number or receipt">
          <Input value={confirmation} maxLength={500} onChange={(event) => setConfirmation(event.target.value)} />
        </Field>
        <Button disabled={busy} onClick={() => save({ submittedAt: orNull(at), submissionConfirmation: confirmation.trim() }, "Submission record saved")}>Save submission</Button>
      </div>
    </>
  );
}

/**
 * @param bid       the bid row (with the columns GATE_BID_CHECKLIST adds)
 * @param extras    { checklist, progress, estimate, documents } from the bid's reply
 * @param save      (body, doneMessage) => Promise<boolean>: a PATCH of the bid, by the page
 * @param invite    true while the Decision field says Submitted: the submission record is invited, never required
 */
export default function BidChecklistPanel({ bidId, bid, extras, save, busy: parentBusy, invite, onProgress }) {
  const [state, setState] = useState(extras);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ text: "", error: false });
  const first = useRef(true);

  const refresh = useCallback(async () => {
    const res = await adminFetch(`/admin/bid-desk/${bidId}`);
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.checklist_live) {
      setState({ checklist: body.checklist, progress: body.checklist_progress, estimate: body.estimate, documents: body.documents });
      // The list row's chip follows at once, not on the next list load.
      if (onProgress) onProgress(bidId, body.checklist_progress);
    }
  }, [bidId, onProgress]);

  // A linked or unlinked estimate changes the summary the server builds.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    refresh().catch(() => {});
  }, [bid.estimate_id, refresh]);

  // Runs one checklist call, then reloads the lines. Returns whether it worked.
  const run = async (call) => {
    setBusy(true);
    setMessage({ text: "", error: false });
    try {
      const res = await call();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await refresh();
      return true;
    } catch (err) {
      setMessage({ text: `Not saved: ${err.message}`, error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || parentBusy;
  return (
    <div data-testid="bid-checklist-panel">
      <Section title="Bid details"><Details bid={bid} busy={disabled} save={save} /></Section>
      <Section title="Estimate and proposal"><EstimateLink bid={bid} estimate={state.estimate} busy={disabled} save={save} /></Section>
      <Section title="Documents"><Documents documents={state.documents} /></Section>
      <Section title="Checklist">
        <Checklist bidId={bidId} bid={bid} items={state.checklist} progress={state.progress} busy={disabled} run={run} invite={invite} />
        {message.text && <ActionFeedback error={message.error} className="mt-2">{message.text}</ActionFeedback>}
      </Section>
      <Section title="Submission record"><Submission bid={bid} busy={disabled} save={save} invite={invite} /></Section>
    </div>
  );
}
