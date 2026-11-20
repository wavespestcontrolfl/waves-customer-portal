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
  isGateOffAnswer,
  isLostAnswer,
  isStartWeekday,
  isStaleWrite,
  LOST_ANSWER_TEXT,
  OUT_CHANGED_TEXT,
  outChangeDetail,
  isValidDay,
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
  const num = (v) => (v === "" ? null : Number(v.trim()));
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

function OfferFields({ fields, onChange, startError, rateErrors, sendTo, disabled }) {
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
      <Field label="Hourly rate ($)" error={rateErrors.hourlyRate}>
        <Input type="text" inputMode="decimal" value={fields.hourlyRate} onChange={set("hourlyRate")} disabled={disabled} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Step rate ($)" error={rateErrors.stepRate}>
          <Input type="text" inputMode="decimal" value={fields.stepRate} onChange={set("stepRate")} disabled={disabled} />
        </Field>
        {/* A save sends a step date only with a step rate, so the date is set only once a rate is. */}
        <Field label="Step date" help="First Monday after day 90.">
          <Input type="date" value={fields.stepEffectiveOn} onChange={set("stepEffectiveOn")} disabled={disabled || fields.stepRate === ""} />
        </Field>
      </div>
      <Field label="Hours">
        <Input value={fields.hoursLine} onChange={set("hoursLine")} disabled={disabled} maxLength={300} />
      </Field>
      {sendTo && <Row label="Send to">{<span className="text-14 text-zinc-800">{sendTo}</span>}</Row>}
    </div>
  );
}

// replaces: the server's offer read names an offer out now that this Send replaces
// (sendReplacesId). Its link stops working at the send, before any text or email.
function ConfirmSend({ open, firstName, sends, replaces, busy, error, onCancel, onConfirm }) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onCancel} size="sm" layer={140}>
      <DialogHeader>
        <DialogTitle>Send offer</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-14 text-zinc-800">
          Send this offer to {firstName}?{sends ? ` It sends ${sends}.` : ""}
        </p>
        {replaces && (
          <p className="mt-2 text-14 text-zinc-800">
            It replaces the offer you sent before. That link stops working when you press Send offer, even if this one does not reach {firstName}.
          </p>
        )}
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

// The rates are text fields, so the form checks exactly what the owner sees: a number field reports text it cannot
// read as empty, and an empty step rate means no raise (it clears the step date). A rate is dollars and cents, the
// server's own format; the server checks the range.
const RATE_TEXT = /^\d+(\.\d{1,2})?$/;
const rateError = (value) => (value === "" || RATE_TEXT.test(value.trim()) ? null : "Enter dollars and cents, like 23.50.");

function fieldChecks(fields) {
  const startError = startDateError(fields);
  const rateErrors = { hourlyRate: rateError(fields.hourlyRate), stepRate: rateError(fields.stepRate) };
  const ratesOk = fields.hourlyRate !== "" && !rateErrors.hourlyRate && !rateErrors.stepRate;
  const fieldsOk = Boolean(fields.startDate) && !startError && ratesOk && fields.hoursLine.trim() !== "";
  return { startError, rateErrors, fieldsOk };
}

// The step date follows the start date whenever a step rate is set, and is
// recomputed when a cleared rate is restored. It stays editable after that.
// With no step rate it is empty and cannot be edited (a save would drop it).
function applyEdit(cur, key, value) {
  const next = { ...cur, [key]: value };
  if (key === "startDate" && next.stepRate !== "") next.stepEffectiveOn = stepDateFor(value);
  if (key === "stepRate") next.stepEffectiveOn = value === "" ? "" : cur.stepRate === "" ? stepDateFor(cur.startDate) : cur.stepEffectiveOn;
  return next;
}

function sendNote(ownerActions, sends, firstName) {
  if (!ownerActions) return "Only the owner can send this offer. You can save the draft.";
  // No phone or email on file: Send stays off (formView), so the note says only that.
  if (!sends) return offerErrorMessage({ body: { code: "NO_CONTACT" } });
  return `Sends ${sends} to ${firstName}. Nothing goes out until you press Send offer.`;
}

// What is on screen is the draft this form pinned when it loaded it (`pinned`, a
// draft from a successful read) plus what the owner typed since (`edits`). A
// newer read never replaces it silently.
function formView({ edits, pinned, data, contact, busy, locked }) {
  // Who Send reaches, as the server's offer read names them (the send's own rule).
  const { sms: phone, email } = data.sendTo || {};
  const base = fieldsFrom(pinned || data.defaults);
  const fields = { ...base, ...edits };
  const { startError, rateErrors, fieldsOk } = fieldChecks(fields);
  const dirty = !pinned || FIELD_KEYS.some((k) => fields[k] !== base[k]);
  // Send needs a phone or an email to send to, and the letter preview of this exact draft on
  // screen: what the owner reads is what goes out.
  const sendReady = data.viewer?.ownerActions === true && Boolean(sendChannels(data.sendTo)) && Boolean(pinned?.draftHash) && Boolean(letterFor(data, pinned)) && !dirty && fieldsOk && data.termsIssued && !locked;
  return {
    base,
    fields,
    firstName: String(contact?.name || "the applicant").trim().split(/\s+/)[0],
    sendTo: [phone && `Text ${phone}`, email && `Email ${email}`].filter(Boolean).join(" · "),
    startError,
    rateErrors,
    fieldsOk,
    dirty,
    sendReady,
    canSend: sendReady && !busy,
  };
}

// message: the server's sentence when a write was refused as stale; else the
// form saw a newer version in a background read.
// The form's read-only state. A background read that differs from the pinned draft,
// or a refused stale write (`conflict`), makes it "changed": read-only, with the
// owner's edits still on screen, until they load the newer version (`newer`; after a
// refused first save, the open draft another admin made). It is also read-only until
// a read has succeeded and holds the draft this form is about.
// reviewedOut: the offers out (the read's outStamp) as the owner last reviewed them.
// A read with other offers out (an answer, a date request) while the draft itself is
// unchanged locks a saved draft too (outOnly): the notice says what changed, and
// Continue with this draft takes the new stamp and keeps the draft and the edits.
function formLock({ data, draftId, pinned, needRead, conflict, reviewedOut }) {
  const latest = reviewedDraft(data, draftId);
  // A form with no draft yet: an open draft in the read is another admin's (this form's own
  // save sets draftId first). It shows as changed, with the owner's edits kept, until they load it.
  const newer = latest || (!draftId ? openDraft(data) : null);
  const draftMoved = Boolean(!draftId && newer) || (Boolean(pinned) && (!latest || latest.draftHash !== pinned.draftHash));
  const outOnly = Boolean(pinned) && !draftMoved && data.outStamp !== reviewedOut;
  const changed = !needRead && (conflict || draftMoved || outOnly);
  return { newer, changed, outOnly, locked: needRead || changed || Boolean(draftId && !pinned) };
}

function ReadOnlyNotice({ changed, locked, message, hasNewer, outChange, onAdopt, onRetry, refreshFailed }) {
  // Only the offers out changed: say what changed, and let the owner go on with the same draft and edits.
  if (changed && outChange) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <ActionFeedback error className="flex-1">
          {message} {outChange.detail}
        </ActionFeedback>
        <Button size="sm" variant="secondary" onClick={outChange.onContinue}>
          Continue with this draft
        </Button>
      </div>
    );
  }
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
      {refreshFailed ? "The offer could not be refreshed." : "The offer could not be loaded after your last change."} Fields and Send stay off until it loads.
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

// stale: the page's last read of the offer, or of the application, failed (a background re-read
// after a stage change, say), so the data on screen may be out of date. The card turns its
// actions off then; the form stays read-only until a read works (Try again re-reads both).
function OfferFormBody({ applicationId, contact, data, draft, seenOut, stale, onClose, onChanged, onSent, onBusyChange }) {
  const [edits, setEdits] = useState({});
  const [draftId, setDraftId] = useState(() => initialDraftId(draft, data));
  const [pinned, setPinned] = useState(() => reviewedDraft(data, initialDraftId(draft, data)));
  // The offers out as the owner reviewed them: on the card before the action that opened the form (seenOut: a Revise
  // opens it only after a write and a read), else when it opened; then at Continue with this draft. Send carries this
  // stamp, never a later read's, so the server refuses a send over a change the owner has not seen (OFFERS_CHANGED).
  const [reviewedOut, setReviewedOut] = useState(() => seenOut ?? data.outStamp);
  const [needRead, setNeedRead] = useState(false);
  // Set when the server refused a write as stale. The form stays read-only, with the owner's
  // edits on screen, until they load the new version or close the form.
  const [conflict, setConflict] = useState(false);
  // "save" or "send" while the form re-reads after a write whose answer was lost.
  const [lost, setLost] = useState(null);
  // Set when a write answered that offers are turned off: nothing was written. The form
  // stays read-only until a read works, and that read turns the flow off, which closes it.
  const [off, setOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  // The dialog's own close handler (Escape, backdrop) honors the same busy state.
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const { newer, changed, outOnly, locked } = formLock({ data, draftId, pinned, needRead: needRead || stale, conflict, reviewedOut });
  // A refused write's sentence shows once, in the read-only notice (after the re-read); else a change to the offers out.
  const notice = conflict ? error : outOnly && OUT_CHANGED_TEXT;
  const { base, fields, firstName, sendTo, startError, rateErrors, fieldsOk, dirty, sendReady, canSend } = formView({ edits, pinned, data, contact, busy, locked });
  // A read that changes the draft, or locks the form, while the Send question is open closes
  // the question: Send carries only the hash of the draft whose letter is on screen.
  useEffect(() => {
    if (confirming && !busy && !sendReady) setConfirming(false);
  }, [confirming, busy, sendReady]);
  const ownerActions = data.viewer?.ownerActions === true;
  const sends = sendChannels(data.sendTo);
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

  // Re-read after a write. The form stays read-only until the read holds the draft it
  // expects (Try again re-reads). A draft the form already pins (`kept`; after a save, the
  // version that save wrote) is never swapped for another version of itself: formLock shows
  // a newer one as changed, for the owner to review before Send. A form with no draft of
  // that id pins the one in the read. With no expected id (a form with no draft yet), a read
  // that works only ends the wait: an open draft in it is another admin's, and formLock shows
  // it as changed, edits kept, until the owner loads it (Show the new version).
  const refresh = async (expectId, kept = pinned) => {
    const next = await onChanged();
    const found = next && expectId ? reviewedDraft(next, expectId) : null;
    if (found && found.id !== kept?.id) {
      setPinned(found);
      setEdits({});
    }
    if (found || (next && !expectId)) {
      if (found) setDraftId(found.id);
      setNeedRead(false);
    }
    return next;
  };

  // Try again after a failed read. After a save it pins the saved draft; if the read shows
  // that draft is gone (another admin sent or discarded it), a form with nothing typed closes
  // and the card shows the offer's state. After a refused write, or one that found offers
  // turned off, it only re-reads: the owner still picks, and edits stay on screen.
  const reread = async () => {
    if (conflict || lost || off) {
      const next = await onChanged();
      if (!next) return;
      setNeedRead(false);
      setOff(false);
      if (lost) settleLost(next, lost);
      return;
    }
    const expected = pinned?.id || draftId;
    const next = await refresh(expected);
    if (!next || !expected || reviewedDraft(next, expected)) return;
    // The draft is gone. With typed edits, the form stays read-only and says so, as after any read of that state: the
    // owner closes it and loses nothing unseen.
    if (dirty) setNeedRead(false);
    else onClose();
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

  // A read after a lost answer decides what happened. The draft as it was: nothing
  // was written, so the form stays as it is, edits included. Anything else (the
  // offer went out, or the draft changed): read-only, as after a refused write.
  const settleLost = (next, kind) => {
    const still = pinned ? reviewedDraft(next, pinned.id) : openDraft(next);
    const unchanged = pinned ? still?.draftHash === pinned.draftHash : !still;
    setLost(null);
    if (unchanged) {
      setError(LOST_ANSWER_TEXT[kind]);
    } else {
      setConflict(true);
      setError(null);
    }
  };

  // The answer to a save or send was lost: re-read before the form offers the write
  // again. If the read fails, Try again only re-reads.
  const lostWrite = async (kind) => {
    setConfirming(false);
    setError(null);
    setLost(kind);
    setNeedRead(true);
    const next = await onChanged();
    if (!next) return;
    setNeedRead(false);
    settleLost(next, kind);
  };

  // Offers were turned off (404 enabled:false): nothing was written. Save and Send stay off,
  // and the Send question closes, until a read works. That read turns the flow off, which
  // closes this form; if the read fails, the form stays read-only and Try again re-reads.
  const gateOff = async () => {
    setConfirming(false);
    setOff(true);
    setNeedRead(true);
    if (!(await onChanged())) return;
    setOff(false);
    setNeedRead(false);
  };

  // Any other refusal (the Terms are not issued, no phone or email on file, not the owner
  // account, a field the server will not take): nothing was written, and the server sees
  // something this form does not. Close the Send question and re-read the offer and the
  // application, so Save and Send follow what the server sees; if that read fails, both stay
  // off and Try again re-reads.
  const refusedWrite = async () => {
    setConfirming(false);
    setNeedRead(true);
    if (await onChanged()) setNeedRead(false);
  };

  // A failed write: a lost answer re-reads; a refusal shows the server's sentence and re-reads.
  const writeFailed = async (err, kind) => {
    if (isLostAnswer(err)) return lostWrite(kind);
    setError(offerErrorMessage(err));
    if (isStaleWrite(err)) await staleWrite();
    else if (isGateOffAnswer(err)) await gateOff();
    else await refusedWrite();
  };

  const adoptLatest = () => {
    if (!newer) return onClose();
    setPinned(newer);
    setDraftId(newer.id);
    setEdits({});
    setConflict(false);
    setError(null);
  };

  // Only the offers out changed, and the notice has said what: the form takes the new stamp and keeps the draft and the
  // owner's edits. A change to the draft itself still needs Show the new version.
  const continueWithDraft = () => {
    setReviewedOut(data.outStamp);
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
      // The form pins the version this save wrote (the answer carries its hash), so the read
      // after it can only confirm it: another admin's save in between shows as changed.
      setDraftId(offer.id);
      setPinned(offer);
      setEdits({});
      setNeedRead(true);
      await refresh(offer.id, offer);
    } catch (err) {
      await writeFailed(err, "save");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await sendOffer(applicationId, pinned.id, pinned.draftHash, reviewedOut);
      // The answer's offer row is read after delivery: it can already be withdrawn or replaced.
      setResult({ comms: out.comms || {}, offerStatus: out.offer?.status });
      await onSent();
      setConfirming(false);
    } catch (err) {
      await writeFailed(err, "send");
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
          {/* Off until the read after the send lands, so the card behind never shows the sent draft as open. */}
          <Button size="sm" onClick={onClose} disabled={busy}>
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
              outChange={outOnly ? { detail: outChangeDetail(data, pinned), onContinue: continueWithDraft } : null}
              onAdopt={adoptLatest}
              onRetry={retryRead}
              refreshFailed={stale && !needRead}
            />
          )}
          <OfferFields fields={fields} onChange={onChange} startError={startError} rateErrors={rateErrors} sendTo={sendTo} disabled={busy || locked} />
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
        replaces={Boolean(data.sendReplacesId)}
        busy={busy}
        error={error}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
        onConfirm={() => (sendReady ? send() : setConfirming(false))}
      />
    </>
  );
}

export default function OfferDialog({ open, applicationId, contact, data, draft, seenOut = null, stale = false, onClose, onChanged, onSent }) {
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
          seenOut={seenOut}
          stale={stale}
          onClose={onClose}
          onChanged={onChanged}
          onSent={onSent}
          onBusyChange={setBusy}
        />
      )}
    </Dialog>
  );
}
