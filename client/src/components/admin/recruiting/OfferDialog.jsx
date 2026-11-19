/**
 * Offer form for one application (Recruiting, GATE_JOB_OFFERS on).
 * Prefilled from the draft (`current`) or the server `defaults`; Save draft
 * posts the fields, Send offer asks first, then sends one text and one email.
 * The letter preview is the server's text for the SAVED draft, so Send stays
 * off until the form matches what was saved and the owner can read it.
 */
import React, { useEffect, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "../../ui";
import SafeMarkdown from "../../SafeMarkdown";
import { saveOfferDraft, sendOffer } from "./offerApi";
import {
  describeSend,
  expiryLabel,
  formatIssued,
  isStartWeekday,
  isStaleWrite,
  isValidDay,
  maskEmail,
  maskPhone,
  offerErrorMessage,
  sendChannels,
  stepDateFor,
  todayET,
} from "./offerLogic";

const FIELD_KEYS = ["jobTitle", "startDate", "hourlyRate", "stepRate", "stepEffectiveOn", "hoursLine"];

function fieldsFrom(source) {
  const out = {};
  for (const key of FIELD_KEYS) out[key] = source?.[key] == null ? "" : String(source[key]);
  return out;
}

function toPayload(fields) {
  const num = (v) => (v === "" ? null : Number(v));
  return {
    jobTitle: fields.jobTitle.trim(),
    startDate: fields.startDate,
    hourlyRate: num(fields.hourlyRate),
    stepRate: num(fields.stepRate),
    stepEffectiveOn: fields.stepRate === "" ? null : fields.stepEffectiveOn || null,
    hoursLine: fields.hoursLine.trim(),
  };
}

function TermsBlock({ data }) {
  if (data.termsIssued) {
    return (
      <div className="text-14 text-zinc-800">
        {data.terms?.title || "Technician Terms"}
        {data.terms?.issuedAt ? ` · issued ${formatIssued(data.terms.issuedAt)}` : " · issued version"}
      </div>
    );
  }
  const blockers = Array.isArray(data.termsBlockers) ? data.termsBlockers : [];
  return (
    <div>
      <div className="text-14 text-zinc-800">The shared terms are not issued yet. Send is off until they are.</div>
      {blockers.length > 0 && (
        <ul className="list-disc pl-5 mt-1 text-14 text-zinc-600">
          {blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <div className="ui-label sm:w-40 sm:shrink-0">{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function OfferFields({ fields, onChange, startError, sendTo, disabled }) {
  const set = (key) => (e) => onChange(key, e.target.value);
  return (
    <div className="flex flex-col gap-3">
      <Field label="Job">
        <Input value={fields.jobTitle} onChange={set("jobTitle")} disabled={disabled} maxLength={100} />
      </Field>
      <Field label="Start date" error={startError} help="Monday to Thursday only.">
        <Input type="date" value={fields.startDate} onChange={set("startDate")} disabled={disabled} />
      </Field>
      <Row label="Offer open until">
        <span className="text-14 text-zinc-800">{expiryLabel()}</span>
        <span className="text-14 text-zinc-500"> · 7 days from the day you send</span>
      </Row>
      <Field label="Hourly rate ($)">
        <Input type="number" inputMode="decimal" step="0.01" min="0" value={fields.hourlyRate} onChange={set("hourlyRate")} disabled={disabled} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Step rate ($)">
          <Input type="number" inputMode="decimal" step="0.01" min="0" value={fields.stepRate} onChange={set("stepRate")} disabled={disabled} />
        </Field>
        <Field label="Step date" help="First Monday after day 90.">
          <Input type="date" value={fields.stepEffectiveOn} onChange={set("stepEffectiveOn")} disabled={disabled} />
        </Field>
      </div>
      <Field label="Hours">
        <Input value={fields.hoursLine} onChange={set("hoursLine")} disabled={disabled} maxLength={300} />
      </Field>
      {sendTo && <Row label="Send to">{<span className="text-14 text-zinc-800">{sendTo}</span>}</Row>}
    </div>
  );
}

function ConfirmSend({ open, firstName, sends, busy, error, onCancel, onConfirm }) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onCancel} size="sm" layer={140}>
      <DialogHeader>
        <DialogTitle>Send offer</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-14 text-zinc-800">
          Send this offer to {firstName}?{sends ? ` It sends ${sends}.` : ""}
        </p>
        {error && (
          <ActionFeedback error className="mt-3">
            {error}
          </ActionFeedback>
        )}
      </DialogBody>
      <DialogFooter>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? "Sending…" : "Send offer"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// The draft (by id) the letter preview in `data` was built from. Its draftHash
// is what Send carries, so Send can only name a draft the owner has read.
function reviewedDraft(data, draftId) {
  if (!draftId) return null;
  return [data.draft, data.current].find((o) => o && o.id === draftId && o.status === "draft") || null;
}

function openDraft(data) {
  return [data.draft, data.current].find((o) => o && o.status === "draft") || null;
}

function initialDraftId(draft, data) {
  if (draft) return draft.id;
  return data.current?.status === "draft" ? data.current.id : null;
}

// The letter belongs to the form only when the read says it was built for this very
// draft (offer id and hash); otherwise another offer's letter must not show.
function letterFor(data, pinned) {
  const letter = data.letterPreview;
  return pinned && letter && letter.offerId === pinned.id && letter.draftHash === pinned.draftHash ? letter.markdown : null;
}

// A start date that cannot be formed, is today or earlier (the server's rule), falls on Friday to Sunday, or would push
// the pay step date past year 9999 gets a plain message (and no step date).
function startDateError({ startDate, stepRate }) {
  if (!startDate) return null;
  if (!isValidDay(startDate)) return "Enter a valid date.";
  if (startDate <= todayET()) return "Pick a date in the future.";
  if (!isStartWeekday(startDate)) return "Pick a Monday to Thursday.";
  return stepRate !== "" && !stepDateFor(startDate) ? "That start date is too far out for a pay step date." : null;
}

function fieldChecks(fields) {
  const startError = startDateError(fields);
  const fieldsOk = Boolean(fields.startDate) && !startError && fields.hourlyRate !== "" && fields.hoursLine.trim() !== "";
  return { startError, fieldsOk };
}

// The step date follows the start date whenever a step rate is set, and is
// recomputed when a cleared rate is restored. It stays editable after that.
function applyEdit(cur, key, value) {
  const next = { ...cur, [key]: value };
  if (key === "startDate" && next.stepRate !== "") next.stepEffectiveOn = stepDateFor(value);
  if (key === "stepRate") next.stepEffectiveOn = value === "" ? "" : cur.stepRate === "" ? stepDateFor(cur.startDate) : cur.stepEffectiveOn;
  return next;
}

function sendNote(ownerActions, sends, firstName) {
  if (!ownerActions) return "Only the owner can send this offer. You can save the draft.";
  const who = sends ? `Sends ${sends} to ${firstName}.` : offerErrorMessage({ body: { code: "NO_CONTACT" } });
  return `${who} Nothing goes out until you press Send offer.`;
}

// What is on screen is the draft this form pinned when it loaded it (`pinned`, a
// draft from a successful read) plus what the owner typed since (`edits`). A
// newer read never replaces it silently.
function formView({ edits, pinned, data, contact, busy, locked }) {
  const phone = maskPhone(contact?.phone);
  const email = maskEmail(contact?.email);
  const base = fieldsFrom(pinned || data.defaults);
  const fields = { ...base, ...edits };
  const { startError, fieldsOk } = fieldChecks(fields);
  const dirty = !pinned || FIELD_KEYS.some((k) => fields[k] !== base[k]);
  return {
    base,
    fields,
    firstName: String(contact?.name || "the applicant").trim().split(/\s+/)[0],
    sendTo: [phone && `Text ${phone}`, email && `Email ${email}`].filter(Boolean).join(" · "),
    startError,
    fieldsOk,
    dirty,
    // Send needs the letter preview of this exact draft on screen: what the owner reads is what goes out.
    canSend: data.viewer?.ownerActions === true && Boolean(pinned?.draftHash) && Boolean(letterFor(data, pinned)) && !dirty && fieldsOk && data.termsIssued && !busy && !locked,
  };
}

// message: the server's sentence when a write was refused as stale; else the
// form saw a newer version in a background read.
// The form's read-only state. A background read that differs from the pinned draft,
// or a refused stale write (`conflict`), makes it "changed": read-only, with the
// owner's edits still on screen, until they load the newer version (`newer`; after a
// refused first save, the open draft another admin made). It is also read-only until
// a read has succeeded and holds the draft this form is about.
function formLock({ data, draftId, pinned, needRead, conflict }) {
  const latest = reviewedDraft(data, draftId);
  const newer = latest || (conflict && !draftId ? openDraft(data) : null);
  const changed = !needRead && (conflict || (Boolean(pinned) && (!latest || latest.draftHash !== pinned.draftHash)));
  return { newer, changed, locked: needRead || changed || Boolean(draftId && !pinned) };
}

function ReadOnlyNotice({ changed, locked, message, hasNewer, onAdopt, onRetry }) {
  if (changed) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <ActionFeedback error className="flex-1">
          {message || (hasNewer ? "This draft changed. Review the new version." : "This draft is no longer open. Close this form to see the offer.")}
        </ActionFeedback>
        {hasNewer && (
          <Button size="sm" variant="secondary" onClick={onAdopt}>
            Show the new version
          </Button>
        )}
      </div>
    );
  }
  if (!locked) return null;
  return (
    <ActionFeedback error onRetry={onRetry}>
      The offer could not be loaded after your last change. Fields and Send stay off until it loads.
    </ActionFeedback>
  );
}

function LetterBox({ letter }) {
  return (
    <div className="border-hairline border border-zinc-200 rounded p-3 max-h-80 overflow-y-auto">
      {letter ? <SafeMarkdown markdown={letter} /> : <p className="text-14 text-zinc-500">Save the draft to see the letter.</p>}
    </div>
  );
}

function OfferFormBody({ applicationId, contact, data, draft, onClose, onChanged, onSent, onBusyChange }) {
  const [edits, setEdits] = useState({});
  const [draftId, setDraftId] = useState(() => initialDraftId(draft, data));
  const [pinned, setPinned] = useState(() => reviewedDraft(data, initialDraftId(draft, data)));
  const [needRead, setNeedRead] = useState(false);
  // Set when the server refused a write as stale. The form stays read-only, with the owner's
  // edits on screen, until they load the new version or close the form.
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  // The dialog's own close handler (Escape, backdrop) honors the same busy state.
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const { newer, changed, locked } = formLock({ data, draftId, pinned, needRead, conflict });
  // A refused write's sentence shows once, in the read-only notice (after the re-read).
  const notice = conflict ? error : null;
  const { base, fields, firstName, sendTo, startError, fieldsOk, dirty, canSend } = formView({ edits, pinned, data, contact, busy, locked });
  const ownerActions = data.viewer?.ownerActions === true;
  const sends = sendChannels(contact);
  const letter = letterFor(data, pinned);

  const onChange = (key, value) => setEdits((prev) => applyEdit({ ...base, ...prev }, key, value));

  const run = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(offerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Re-read after a write. The form pins the draft in the read only once the read
  // holds the draft it expects; until then it stays read-only (Try again re-reads).
  // With no expected id (another admin created the first draft meanwhile) the open
  // draft in the read is adopted.
  const refresh = async (expectId) => {
    const next = await onChanged();
    const found = next && (expectId ? reviewedDraft(next, expectId) : openDraft(next));
    if (found) setPinned(found);
    if (found || (next && !expectId)) {
      if (found) setDraftId(found.id);
      setNeedRead(false);
      setEdits({});
    }
    return next;
  };

  // Try again after a failed read. After a save it pins the saved draft; if the read shows
  // that draft is gone (another admin sent or discarded it), the form closes and the card
  // shows the offer's state. After a refused write it only re-reads: the owner still picks.
  const reread = async () => {
    if (conflict) {
      if (await onChanged()) setNeedRead(false);
      return;
    }
    const expected = pinned?.id || draftId;
    const next = await refresh(expected);
    if (next && expected && !reviewedDraft(next, expected)) onClose();
  };
  const retryRead = () => run(reread);

  // The server refused a write because the draft, the offer or the application moved on:
  // nothing was written. Re-read, keep the owner's edits on screen, and wait for them.
  const staleWrite = async () => {
    setConfirming(false);
    setConflict(true);
    setNeedRead(true);
    if (await onChanged()) setNeedRead(false);
  };

  const adoptLatest = () => {
    if (!newer) return onClose();
    setPinned(newer);
    setDraftId(newer.id);
    setEdits({});
    setConflict(false);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // An existing draft is named by the id and hash pinned when it was loaded.
      const guard = pinned ? { draftId: pinned.id, draftHash: pinned.draftHash } : {};
      const { offer } = await saveOfferDraft(applicationId, { ...toPayload(fields), ...guard });
      setDraftId(offer.id);
      setNeedRead(true);
      await refresh(offer.id);
    } catch (err) {
      setError(offerErrorMessage(err));
      if (isStaleWrite(err)) await staleWrite();
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await sendOffer(applicationId, pinned.id, pinned.draftHash);
      // The answer's offer row is read after delivery: it can already be withdrawn or replaced.
      setResult({ comms: out.comms || {}, offerStatus: out.offer?.status });
      await onSent();
      setConfirming(false);
    } catch (err) {
      setError(offerErrorMessage(err));
      if (isStaleWrite(err)) await staleWrite();
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const sent = describeSend(result.comms, firstName, result.offerStatus);
    return (
      <>
        <DialogBody>
          <p className="text-14 text-zinc-800 mb-1">{sent.headline}</p>
          {sent.lines.map((line) => (
            <p key={line} className="text-14 text-zinc-600">
              {line}
            </p>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogBody>
        <div className="flex flex-col gap-4">
          {!busy && (
            <ReadOnlyNotice
              changed={changed}
              locked={locked}
              message={notice}
              hasNewer={Boolean(newer)}
              onAdopt={adoptLatest}
              onRetry={retryRead}
            />
          )}
          <OfferFields fields={fields} onChange={onChange} startError={startError} sendTo={sendTo} disabled={busy || locked} />
          <Row label="Shared terms attached">
            <TermsBlock data={data} />
          </Row>
          <div>
            <div className="ui-label mb-1">Letter preview</div>
            <LetterBox letter={letter} />
            <div className="text-14 text-zinc-500 mt-1">Shows the saved draft. Save the draft to refresh it.</div>
          </div>
          <div className="text-14 text-zinc-500">
            {sendNote(ownerActions, sends, firstName)}
          </div>
          {error && !confirming && !notice && <ActionFeedback error>{error}</ActionFeedback>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button size="sm" variant="secondary" onClick={save} disabled={busy || locked || !fieldsOk || !dirty}>
          {busy && !confirming ? "Saving…" : "Save draft"}
        </Button>
        {ownerActions && !locked && (
          <Button size="sm" onClick={() => setConfirming(true)} disabled={!canSend}>
            Send offer
          </Button>
        )}
      </DialogFooter>
      <ConfirmSend
        open={confirming}
        firstName={firstName}
        sends={sends}
        busy={busy}
        error={error}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={send}
      />
    </>
  );
}

export default function OfferDialog({ open, applicationId, contact, data, draft, onClose, onChanged, onSent }) {
  const [busy, setBusy] = useState(false);
  const name = String(contact?.name || "Applicant");
  const status = (draft || data?.current)?.status;
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} layer={130} size="lg">
      <DialogHeader>
        <DialogTitle>
          Offer: {name} {status === "draft" || !status ? <Badge>Draft</Badge> : null}
        </DialogTitle>
      </DialogHeader>
      {open && data && (
        <OfferFormBody
          key={draft?.id || "current"}
          applicationId={applicationId}
          contact={contact}
          data={data}
          draft={draft}
          onClose={onClose}
          onChanged={onChanged}
          onSent={onSent}
          onBusyChange={setBusy}
        />
      )}
    </Dialog>
  );
}
