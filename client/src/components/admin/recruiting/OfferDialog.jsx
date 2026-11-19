/**
 * Offer form for one application (Recruiting, GATE_JOB_OFFERS on).
 * Prefilled from the draft (`current`) or the server `defaults`; Save draft
 * posts the fields, Send offer asks first, then sends one text and one email.
 * The letter preview is the server's text for the SAVED draft, so Send stays
 * off until the form matches what was saved and the owner can read it.
 */
import React, { useState } from "react";
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
  commsSummary,
  expiryLabel,
  formatIssued,
  isStartWeekday,
  maskEmail,
  maskPhone,
  offerErrorMessage,
  sendChannels,
  stepDateFor,
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
      <div className="text-ui-caption font-medium text-ink-secondary sm:w-40 sm:shrink-0">{label}</div>
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
        <span className="text-14 text-zinc-400"> · 7 days from the day you send</span>
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

function initialDraftId(draft, data) {
  if (draft) return draft.id;
  return data.current?.status === "draft" ? data.current.id : null;
}

function isLocked(needRead, draftId, reviewed) {
  return needRead || Boolean(draftId && !reviewed);
}

function fieldChecks(fields) {
  const startError = fields.startDate && !isStartWeekday(fields.startDate) ? "Pick a Monday to Thursday." : null;
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

// Everything on screen comes from `data`, the latest successful read: the
// draft (`reviewed`), its letter preview and its draftHash. `edits` are only
// what the owner typed since that read.
function formView({ edits, reviewed, data, contact, busy, locked }) {
  const phone = maskPhone(contact?.phone);
  const email = maskEmail(contact?.email);
  const base = fieldsFrom(reviewed || data.defaults);
  const fields = { ...base, ...edits };
  const { startError, fieldsOk } = fieldChecks(fields);
  const dirty = !reviewed || FIELD_KEYS.some((k) => fields[k] !== base[k]);
  return {
    base,
    fields,
    firstName: String(contact?.name || "the applicant").trim().split(/\s+/)[0],
    sendTo: [phone && `Text ${phone}`, email && `Email ${email}`].filter(Boolean).join(" · "),
    startError,
    fieldsOk,
    dirty,
    canSend: data.viewer?.ownerActions === true && Boolean(reviewed?.draftHash) && !dirty && fieldsOk && data.termsIssued && !busy && !locked,
  };
}

function OfferFormBody({ applicationId, contact, data, draft, onClose, onChanged, onSent }) {
  const [edits, setEdits] = useState({});
  const [draftId, setDraftId] = useState(() => initialDraftId(draft, data));
  const [needRead, setNeedRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const reviewed = reviewedDraft(data, draftId);
  // Read-only until a read has succeeded and holds the draft this form is about.
  const locked = isLocked(needRead, draftId, reviewed);
  const { base, fields, firstName, sendTo, startError, fieldsOk, dirty, canSend } = formView({ edits, reviewed, data, contact, busy, locked });
  const ownerActions = data.viewer?.ownerActions === true;
  const sends = sendChannels(contact);

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

  // Re-read after a write. The form shows the result only once the read holds
  // the draft it expects; until then it stays read-only (Try again re-reads).
  const refresh = async (expectId) => {
    const next = await onChanged();
    if (next && reviewedDraft(next, expectId)) {
      setNeedRead(false);
      setEdits({});
    }
    return next;
  };

  const save = () =>
    run(async () => {
      const { offer } = await saveOfferDraft(applicationId, toPayload(fields));
      setDraftId(offer.id);
      setNeedRead(true);
      await refresh(offer.id);
    });

  const retryRead = () => run(() => refresh(draftId));

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await sendOffer(applicationId, reviewed.id, reviewed.draftHash);
      setResult(out.comms || {});
      await onSent();
      setConfirming(false);
    } catch (err) {
      setError(offerErrorMessage(err));
      if (err?.body?.code === "DRAFT_CHANGED") {
        setConfirming(false);
        setNeedRead(true);
        await refresh(reviewed.id);
      }
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <>
        <DialogBody>
          <p className="text-14 text-zinc-800 mb-1">Offer sent to {firstName}.</p>
          <p className="text-14 text-zinc-600">{commsSummary(result)}</p>
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
          {locked && !busy && (
            <ActionFeedback error onRetry={retryRead}>
              The offer could not be loaded after your last change. Fields and Send stay off until it loads.
            </ActionFeedback>
          )}
          <OfferFields fields={fields} onChange={onChange} startError={startError} sendTo={sendTo} disabled={busy || locked} />
          <Row label="Shared terms attached">
            <TermsBlock data={data} />
          </Row>
          <div>
            <div className="text-ui-caption font-medium text-ink-secondary mb-1">Letter preview</div>
            <div className="border-hairline border rounded p-3 max-h-80 overflow-y-auto">
              <SafeMarkdown markdown={data.letterPreview?.markdown} />
            </div>
            <div className="text-14 text-zinc-400 mt-1">Shows the saved draft. Save the draft to refresh it.</div>
          </div>
          <div className="text-14 text-zinc-500">
            {sendNote(ownerActions, sends, firstName)}
          </div>
          {error && !confirming && <ActionFeedback error>{error}</ActionFeedback>}
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
  const name = String(contact?.name || "Applicant");
  const status = (draft || data?.current)?.status;
  return (
    <Dialog open={open} onClose={onClose} layer={130} size="lg">
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
        />
      )}
    </Dialog>
  );
}
