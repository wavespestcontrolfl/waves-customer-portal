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
import SafeMarkdown from "./SafeMarkdown";
import { saveOfferDraft, sendOffer } from "./offerApi";
import {
  commsSummary,
  expiryLabel,
  formatDay,
  isStartWeekday,
  maskEmail,
  maskPhone,
  offerErrorMessage,
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
        {data.terms?.issuedAt ? ` · issued ${formatDay(data.terms.issuedAt)}` : " · issued version"}
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

function OfferFields({ fields, onChange, startError, sendTo }) {
  const set = (key) => (e) => onChange(key, e.target.value);
  return (
    <div className="flex flex-col gap-3">
      <Field label="Job">
        <Input value={fields.jobTitle} onChange={set("jobTitle")} maxLength={100} />
      </Field>
      <Field label="Start date" error={startError} help="Monday to Thursday only.">
        <Input type="date" value={fields.startDate} onChange={set("startDate")} />
      </Field>
      <Row label="Offer open until">
        <span className="text-14 text-zinc-800">{expiryLabel()}</span>
        <span className="text-14 text-zinc-400"> · 7 days from the day you send</span>
      </Row>
      <Field label="Hourly rate ($)">
        <Input type="number" inputMode="decimal" step="0.01" min="0" value={fields.hourlyRate} onChange={set("hourlyRate")} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Step rate ($)">
          <Input type="number" inputMode="decimal" step="0.01" min="0" value={fields.stepRate} onChange={set("stepRate")} />
        </Field>
        <Field label="Step date" help="First Monday after day 90.">
          <Input type="date" value={fields.stepEffectiveOn} onChange={set("stepEffectiveOn")} />
        </Field>
      </div>
      <Field label="Hours">
        <Input value={fields.hoursLine} onChange={set("hoursLine")} maxLength={300} />
      </Field>
      {sendTo && <Row label="Send to">{<span className="text-14 text-zinc-800">{sendTo}</span>}</Row>}
    </div>
  );
}

function ConfirmSend({ open, firstName, busy, error, onCancel, onConfirm }) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onCancel} size="sm" layer={140}>
      <DialogHeader>
        <DialogTitle>Send offer</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-14 text-zinc-800">
          Send this offer to {firstName}? It sends one text and one email.
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

function formView({ fields, saved, data, contact, busy }) {
  const phone = maskPhone(contact?.phone);
  const email = maskEmail(contact?.email);
  const startError = fields.startDate && !isStartWeekday(fields.startDate) ? "Pick a Monday to Thursday." : null;
  const fieldsOk = Boolean(fields.startDate) && !startError && fields.hourlyRate !== "" && fields.hoursLine.trim() !== "";
  const savedFields = fieldsFrom(saved);
  const dirty = !saved || FIELD_KEYS.some((k) => fields[k] !== savedFields[k]);
  return {
    firstName: String(contact?.name || "the applicant").trim().split(/\s+/)[0],
    sendTo: [phone && `Text ${phone}`, email && `Email ${email}`].filter(Boolean).join(" · "),
    startError,
    fieldsOk,
    dirty,
    canSend: Boolean(saved) && !dirty && fieldsOk && data.termsIssued && !busy,
  };
}

function OfferFormBody({ applicationId, contact, data, draft, onClose, onChanged, onSent }) {
  const start = draft || (data.current?.status === "draft" ? data.current : null);
  const [fields, setFields] = useState(() => fieldsFrom(start || data.defaults));
  const [saved, setSaved] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const { firstName, sendTo, startError, fieldsOk, dirty, canSend } = formView({ fields, saved, data, contact, busy });

  const onChange = (key, value) => {
    setFields((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "startDate" && next.stepRate !== "") next.stepEffectiveOn = stepDateFor(value);
      return next;
    });
  };

  const run = async (work) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (err) {
      setError(offerErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const { offer } = await saveOfferDraft(applicationId, toPayload(fields));
      setSaved(offer);
      setFields(fieldsFrom(offer));
      await onChanged();
    });

  const send = async () => {
    const ok = await run(async () => {
      const out = await sendOffer(applicationId, saved.id);
      setResult(out.comms || {});
      await onSent();
    });
    if (ok) setConfirming(false);
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
          <OfferFields fields={fields} onChange={onChange} startError={startError} sendTo={sendTo} />
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
            Sends one text and one email to {firstName}. Nothing goes out until you press Send offer.
          </div>
          {error && !confirming && <ActionFeedback error>{error}</ActionFeedback>}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button size="sm" variant="secondary" onClick={save} disabled={busy || !fieldsOk || !dirty}>
          {busy && !confirming ? "Saving…" : "Save draft"}
        </Button>
        <Button size="sm" onClick={() => setConfirming(true)} disabled={!canSend}>
          Send offer
        </Button>
      </DialogFooter>
      <ConfirmSend
        open={confirming}
        firstName={firstName}
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
