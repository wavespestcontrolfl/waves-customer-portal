import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ActionFeedback, Badge, Button, Checkbox, Field, Input, Select } from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import { buildKitIndex, pillForLine } from "./bidChecklistKit";
import { etDatetimeLocalValue } from "../../lib/timezone";

// Bid Desk checklist panel (GATE_BID_CHECKLIST, dark). The page shows it only when the server says the gate is on
// (`checklist_live` in the bid's reply). It records what the operator knows about a bid: the solicitation type, the
// questions and site-visit dates, the estimate and proposal, the documents that came by email, a checklist and the
// submission record. Nothing here is sent to a buyer, a general contractor or an agency.

// A save whose answer never arrived (the network dropped) may or may not have been written. The page reloads what the
// server has instead of saying "Not saved", so a blind retry does not repeat a line (same wording as the Bid kit).
export const UNCONFIRMED_MESSAGE = "Could not confirm the save. The list below shows what the server has now.";

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
  const [unchanged, setUnchanged] = useState(false);
  useEffect(() => {
    setForm({
      type: bid.solicitation_type || "", scored: scoredOf(bid.scored), questions: etDatetimeLocalValue(bid.questions_due_at),
      walk: etDatetimeLocalValue(bid.job_walk_at), mandatory: !!bid.job_walk_mandatory,
    });
  }, [bid.solicitation_type, bid.scored, bid.questions_due_at, bid.job_walk_at, bid.job_walk_mandatory]);
  const set = (key) => (event) => {
    setUnchanged(false);
    setForm((f) => ({ ...f, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  };
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
      <div className="grid gap-2">
        <div>
          <Button disabled={busy} onClick={() => {
            // A field goes in the request only when the operator changed it. The server treats a changed site-visit
            // date as confirmed, so the prefilled date of an invite must not ride along with a type change. A field
            // sent unchanged could also put back a value another save has moved since this panel last loaded.
            const body = {};
            if (orNull(form.type) !== (bid.solicitation_type || null)) body.solicitationType = orNull(form.type);
            if (scoredToApi(form.scored) !== scoredToApi(scoredOf(bid.scored))) body.scored = scoredToApi(form.scored);
            if (!!form.mandatory !== !!bid.job_walk_mandatory) body.jobWalkMandatory = !!form.mandatory;
            if (form.questions !== etDatetimeLocalValue(bid.questions_due_at)) body.questionsDueAt = orNull(form.questions);
            if (form.walk !== etDatetimeLocalValue(bid.job_walk_at)) body.jobWalkAt = orNull(form.walk);
            if (Object.keys(body).length === 0) { setUnchanged(true); return; }
            setUnchanged(false);
            save(body, "Bid details saved");
          }}>Save bid details</Button>
        </div>
        {unchanged && <ActionFeedback>Nothing changed</ActionFeedback>}
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
      const res = await adminFetch(`/admin/email/message/${doc.email_id}/attachment/${encodeURIComponent(doc.gmail_attachment_id)}`, { skipContentType: true });
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
            {doc.gmail_attachment_id && <Button size="sm" variant="secondary" aria-label={`Download ${doc.name}`} onClick={() => download(doc)}>Download</Button>}
          </li>
        ))}
      </ul>
      {error && <ActionFeedback error className="mt-2">{error}</ActionFeedback>}
    </>
  );
}

function EditRow({ item, busy, onSave, onCancel }) {
  const [label, setLabel] = useState(item.label);
  const [source, setSource] = useState(item.source_text || "");
  const [required, setRequired] = useState(!!item.required);
  return (
    <form className="grid gap-2 rounded-sm border-hairline border-zinc-200 px-3 py-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" onSubmit={async (event) => {
      event.preventDefault();
      if (await onSave(item, { label: label.trim(), sourceText: source.trim(), required })) onCancel();
    }}>
      <Field id={`edit-label-${item.id}`} label="Line">
        <Input value={label} maxLength={500} onChange={(event) => setLabel(event.target.value)} />
      </Field>
      <Field id={`edit-source-${item.id}`} label="Quote or page from the solicitation">
        <Input value={source} maxLength={2000} onChange={(event) => setSource(event.target.value)} />
      </Field>
      <Checkbox id={`edit-required-${item.id}`} label="Required" checked={required} onChange={(event) => setRequired(event.target.checked)} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !label.trim()}>Save line</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// The Bid kit status of a line that needs a kit paper (read only: it links to the kit item and never ticks the line).
function KitPill({ templateKey, kit }) {
  const pill = pillForLine(templateKey, kit);
  if (!pill) return null;
  return (
    <Link to={pill.to} title={pill.title} aria-label={`${pill.text}. ${pill.title}`} data-testid="kit-pill" className="no-underline">
      <Badge tone={pill.tone}>{pill.text}</Badge>
    </Link>
  );
}

function ChecklistRow({ item, kit, first, last, busy, onTick, onNotes, onArchive, onMove, onEdit }) {
  const [notes, setNotes] = useState(item.notes || "");
  const [editing, setEditing] = useState(false);
  const draft = useRef(notes);
  draft.current = notes;
  const lastSent = useRef(item.notes || "");
  const saving = useRef(false);
  const again = useRef(false);
  // A refresh replaces the note only while the field holds no unsaved typing (its text is still the note the server
  // last had), focused or not: an untouched field must not keep an older note that its next blur would send back.
  // Typing not saved yet stays, since a refresh can bring back a note older than the draft (the reply to a save the
  // operator has typed past); the draft is saved on its next blur. The same holds while this row's note save is in
  // flight or a newer draft is queued behind it: another reload (a tick) can bring back the older text, and the
  // queued draft must still be the one sent.
  useEffect(() => {
    const unsaved = draft.current !== lastSent.current;
    lastSent.current = item.notes || "";
    if (unsaved || saving.current || again.current) return;
    setNotes(item.notes || "");
  }, [item.notes]);
  // A note saves when its field loses focus. The save does not lock the panel (a tap that starts the blur would land
  // on a control the save had just disabled and be lost). This row sends one note save at a time; a blur that comes
  // while one is in flight sends the newer draft when it finishes.
  const saveNotes = async () => {
    if (saving.current) { again.current = true; return; }
    saving.current = true;
    try {
      do {
        again.current = false;
        const text = draft.current;
        if (text === lastSent.current) break;
        // A failed save (refused, or no answer) stops here unless a newer draft was blurred behind it: that one was
        // already left by the operator and is still sent.
        if (await onNotes(item, text)) lastSent.current = text;
        else if (!again.current) break;
      } while (again.current);
    } finally {
      saving.current = false;
    }
  };
  if (editing) return <li data-section={item.section}><EditRow item={item} busy={busy} onSave={onEdit} onCancel={() => setEditing(false)} /></li>;
  return (
    // A stop check (a go / no-go question) sits first and is shaded so it reads apart from the paperwork lines.
    <li data-section={item.section} className={`grid gap-1 rounded-sm border-hairline border-zinc-200 px-3 py-2${item.section === "stop" ? " bg-zinc-50" : ""}`}>
      <div className="flex flex-wrap items-start gap-2">
        <Checkbox id={`check-${item.id}`} label={item.label} checked={!!item.checked_at} disabled={busy} onChange={(event) => onTick(item, event.target.checked)} />
        {!item.required && <Badge>Optional</Badge>}
        <KitPill templateKey={item.template_key} kit={kit} />
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" disabled={busy || first} aria-label={`Move up: ${item.label}`} onClick={() => onMove(item, -1)}>Up</Button>
          <Button size="sm" variant="ghost" disabled={busy || last} aria-label={`Move down: ${item.label}`} onClick={() => onMove(item, 1)}>Down</Button>
          <Button size="sm" variant="ghost" disabled={busy} aria-label={`Edit: ${item.label}`} onClick={() => setEditing(true)}>Edit</Button>
          <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove: ${item.label}`} onClick={() => onArchive(item)}>Remove</Button>
        </span>
      </div>
      {item.source_text && <div className="text-ui-caption text-ink-secondary">From the solicitation: “{item.source_text}”</div>}
      <Input aria-label={`Note: ${item.label}`} placeholder="Note" maxLength={2000} value={notes}
        onChange={(event) => setNotes(event.target.value)} onBlur={saveNotes} />
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

function Checklist({ bidId, bid, items, progress, missing, busy, run, invite, kit }) {
  const act = (path, method, body, query = "") => adminFetch(`/admin/bid-desk/${bidId}/checklist${path}${query}`, { method, ...(body === undefined ? {} : { body }) });
  const start = (query) => run(() => act("/start", "POST", bid.solicitation_type ? { type: bid.solicitation_type } : {}, query));
  // "Add missing lines" is offered whenever the bid has template lines it does not carry (an unset type means the base
  // ten), even with no live lines left (a line added and removed must not leave the page with no way to start).
  const addMissing = missing > 0 && (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => start("?add=missing")}>Add missing lines for this type</Button>
  );
  return (
    <>
      {items.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-ui-body">
          <span className="text-ink-secondary">No checklist yet. It starts from the lines for the solicitation type{bid.solicitation_type ? ` (${TYPE_LABEL[bid.solicitation_type]})` : ""}.</span>
          <Button disabled={busy} onClick={() => start("")}>Start checklist</Button>
          {addMissing}
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-ui-body">
            <Badge tone={progress.required > 0 && progress.checked === progress.required ? "strong" : "neutral"}>{progress.checked}/{progress.required}</Badge>
            <span className="text-ink-secondary">required lines checked</span>
            {addMissing}
          </div>
          <ul className="grid gap-2">
            {items.map((item, index) => (
              <ChecklistRow key={item.id} item={item} kit={kit} first={index === 0} last={index === items.length - 1} busy={busy}
                onTick={(row, checked) => run(() => act(`/${row.id}`, "PATCH", { checked }))}
                onNotes={(row, notes) => run(() => act(`/${row.id}`, "PATCH", { notes }), { background: true })}
                onArchive={(row) => run(() => act(`/${row.id}`, "DELETE"))}
                onEdit={(row, changes) => run(() => act(`/${row.id}`, "PATCH", changes))}
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
  const [refreshError, setRefreshError] = useState("");
  const first = useRef(true);

  // The Bid kit list, read once per panel (GATE_BID_KIT). It loads beside the checklist and the pills appear when it
  // arrives. Flag off, a refused or failed read, or an unusable reply: no pills and no message, the checklist is as before.
  const kitLive = useFeatureFlag("bid_kit");
  const [kit, setKit] = useState(null);
  useEffect(() => {
    if (!kitLive) { setKit(null); return undefined; }
    let live = true;
    (async () => {
      try {
        const res = await adminFetch("/admin/bid-kit");
        if (!res.ok) return;
        const index = buildKitIndex(await res.json());
        if (live) setKit(index);
      } catch { /* the checklist shows without kit pills */ }
    })();
    return () => { live = false; };
  }, [kitLive]);

  // Reloads the lines, progress, estimate and documents. A failure (network error, a refusal, the gate turned off) is
  // shown in the checklist section until the next success; it never throws.
  // Reloads can overlap now (a note save runs beside a tick); only the newest reload is applied.
  const refreshSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const res = await adminFetch(`/admin/bid-desk/${bidId}`);
      const body = await res.json().catch(() => ({}));
      if (seq !== refreshSeq.current) return;
      if (!(res.ok && body.checklist_live)) throw new Error(`HTTP ${res.status}`);
      setState({ checklist: body.checklist, progress: body.checklist_progress, missing: body.checklist_missing ?? 0, estimate: body.estimate, documents: body.documents });
      // The list row's chip follows at once, not on the next list load.
      if (onProgress) onProgress(bidId, body.checklist_progress);
      setRefreshError("");
    } catch {
      if (seq !== refreshSeq.current) return;
      setRefreshError("Could not reload the checklist, so the lines below may be out of date. Reload the page to check.");
    }
  }, [bidId, onProgress]);

  // A linked or unlinked estimate, or a new solicitation type, changes what the server builds (the estimate summary,
  // and how many template lines for the type the bid does not carry yet).
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    refresh();
  }, [bid.estimate_id, bid.solicitation_type, refresh]);

  // Runs one checklist call, then reloads the lines. Returns whether it worked.
  // A background run (a note save) leaves the panel unlocked: the operator may keep typing and tapping.
  const run = async (call, { background = false } = {}) => {
    if (!background) setBusy(true);
    setMessage({ text: "", error: false });
    try {
      let res;
      try {
        res = await call();
      } catch {
        // No answer arrived: the server may have written the change. Show what it has now.
        setMessage({ text: UNCONFIRMED_MESSAGE, error: true });
        await refresh();
        return false;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await refresh();
      // A plain answer from the server (for example, every template line was removed) is shown, not an error.
      if (body.message) setMessage({ text: body.message, error: false });
      return true;
    } catch (err) {
      setMessage({ text: `Not saved: ${err.message}`, error: true });
      return false;
    } finally {
      if (!background) setBusy(false);
    }
  };

  const disabled = busy || parentBusy;
  return (
    <div data-testid="bid-checklist-panel">
      <Section title="Bid details"><Details bid={bid} busy={disabled} save={save} /></Section>
      <Section title="Estimate and proposal"><EstimateLink bid={bid} estimate={state.estimate} busy={disabled} save={save} /></Section>
      <Section title="Documents"><Documents documents={state.documents} /></Section>
      <Section title="Checklist">
        <Checklist bidId={bidId} bid={bid} items={state.checklist} progress={state.progress} missing={state.missing ?? 0} busy={disabled} run={run} invite={invite} kit={kit} />
        {message.text && <ActionFeedback error={message.error} className="mt-2">{message.text}</ActionFeedback>}
        {refreshError && <ActionFeedback error className="mt-2">{refreshError}</ActionFeedback>}
      </Section>
      <Section title="Submission record"><Submission bid={bid} busy={disabled} save={save} invite={invite} /></Section>
    </div>
  );
}
