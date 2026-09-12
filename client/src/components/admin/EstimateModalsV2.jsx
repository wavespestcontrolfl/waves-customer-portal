// client/src/components/admin/EstimateModalsV2.jsx
// Monochrome V2 of FollowUpModal + DeclineModal. Strict 1:1 with V1 on:
//   - FollowUp: POST /admin/estimates/:id/follow-up { message }
//   - Decline:  PATCH /admin/estimates/:id       { status, declineReason }
//   - Default SMS copy (first name + first address segment)
//   - DECLINE_REASONS list (imported from EstimatePage.jsx)
// Reskinned with Dialog primitive, zinc ramp, alert-fg on destructive confirm.
import React, { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Radio,
  Textarea,
  cn,
} from "../ui";
import {
  DECLINE_REASONS,
  declinePayload,
} from "../../pages/admin/EstimatePage";
// The canonical helper surfaces the server's `error` string (a 409 "held for
// a re-price" reason, "No phone on file", …) instead of "HTTP 409"; it also
// redirects on 401 and retries 429 once (UI audit F0076).
import { adminFetch } from "../../utils/admin-fetch";

export function FollowUpModalV2({ estimate, onClose, onSent }) {
  const firstName = estimate.customerName?.split(" ")[0] || "there";
  const addrShort = estimate.address?.split(",")[0] || "your property";
  const [message, setMessage] = useState(
    `Hi ${firstName}, just checking in on the estimate I sent for ${addrShort}. Any questions? — Adam, Waves`,
  );
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}/follow-up`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      onSent();
    } catch (err) {
      alert("Follow-up failed: " + err.message);
    }
    setSending(false);
  };

  return (
    <Dialog open onClose={onClose} size="md">
      {" "}
      <DialogHeader>
        {" "}
        <DialogTitle>Follow Up — {estimate.customerName}</DialogTitle>{" "}
        <div className="text-ui-body text-ink-secondary mt-0.5">
          {estimate.address || "—"}
        </div>{" "}
      </DialogHeader>{" "}
      <DialogBody>
        {" "}
        <Field
          label="SMS Message"
          help="Delivered via Twilio · replies route to the shared inbox"
        >
          <Textarea
            value={message}
            onChange={(ev) => setMessage(ev.target.value)}
            rows={4}
            className="min-h-[96px]"
          />
        </Field>{" "}
      </DialogBody>{" "}
      <DialogFooter>
        {" "}
        <Button variant="secondary" onClick={onClose} disabled={sending}>
          Cancel
        </Button>{" "}
        <Button
          variant="primary"
          onClick={handleSend}
          disabled={sending || !message.trim()}
        >
          {sending ? "Sending…" : "Send Follow-Up SMS"}
        </Button>{" "}
      </DialogFooter>{" "}
    </Dialog>
  );
}

export function DeclineModalV2({ estimate, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [competitorName, setCompetitorName] = useState("");
  const [competitorPrice, setCompetitorPrice] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // "Other" needs its note — the server 400s a blank one.
  const incomplete = !reason || (reason === "declined_other" && !note.trim());

  const handleSave = async () => {
    if (incomplete) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}`, {
        method: "PATCH",
        body: JSON.stringify(declinePayload({ reason, competitorName, competitorPrice, note })),
      });
      onSaved();
    } catch (err) {
      alert("Failed: " + err.message);
    }
    setSaving(false);
  };

  return (
    <Dialog open onClose={onClose} size="sm">
      {" "}
      <DialogHeader>
        {" "}
        <DialogTitle>Mark as lost</DialogTitle>{" "}
        <div className="text-ui-body text-ink-secondary mt-0.5">
          {estimate.customerName}
          {estimate.address ? ` — ${estimate.address.split(",")[0]}` : ""}
        </div>{" "}
      </DialogHeader>{" "}
      <DialogBody>
        {" "}
        <div className="text-ui-body font-medium text-ink-secondary uppercase tracking-label mb-2">
          Reason
        </div>{" "}
        <div className="flex flex-col gap-1.5">
          {DECLINE_REASONS.map((r) => {
            const selected = reason === r.code;
            return (
              <React.Fragment key={r.code}>
                <label
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded-xs cursor-pointer",
                    "text-ui-body border-hairline transition-colors",
                    selected
                      ? "bg-zinc-50 border-zinc-900 text-zinc-900"
                      : "bg-white border-zinc-300 text-ink-secondary hover:bg-zinc-50",
                  )}
                >
                  {" "}
                  <Radio
                    type="radio"
                    name="declineReason"
                    checked={selected}
                    onChange={() => setReason(r.code)}
                  />{" "}
                  {r.label}
                </label>
                {selected && r.fields === "competitor" && (
                  <div className="grid grid-cols-2 gap-2 ml-6 mb-1">
                    <Input
                      value={competitorName}
                      onChange={(ev) => setCompetitorName(ev.target.value)}
                      placeholder="Competitor"
                      aria-label="Competitor"
                    />
                    <Input
                      value={competitorPrice}
                      onChange={(ev) => setCompetitorPrice(ev.target.value)}
                      placeholder="Their price ($)"
                      aria-label="Competitor price"
                      inputMode="decimal"
                    />
                  </div>
                )}
                {selected && r.fields === "note" && (
                  <Input
                    value={note}
                    onChange={(ev) => setNote(ev.target.value)}
                    placeholder="What happened?"
                    aria-label="Decline note"
                    className="ml-6 mb-1"
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>{" "}
      </DialogBody>{" "}
      <DialogFooter>
        {" "}
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>{" "}
        <Button
          variant="danger"
          onClick={handleSave}
          disabled={saving || incomplete}
        >
          {saving ? "Saving…" : "Mark as Lost"}
        </Button>{" "}
      </DialogFooter>{" "}
    </Dialog>
  );
}

// Extend modal — pushes expires_at forward by a preset window and sends the
// customer a heads-up SMS in Waves voice. Default 7d; 14/30/90 are the other
// presets; custom value is a free-text input (1-180 days).
const EXTEND_PRESETS = [7, 14, 30, 90];

function previewExpiry(currentExpiresAt, days) {
  const now = new Date();
  const cur = currentExpiresAt ? new Date(currentExpiresAt) : now;
  const anchor = cur > now ? cur : now;
  const next = new Date(anchor.getTime() + days * 86400000);
  return next.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

export function ExtendEstimateModalV2({ estimate, onClose, onExtended }) {
  const [days, setDays] = useState(7);
  const [customDays, setCustomDays] = useState("");
  const [silent, setSilent] = useState(false);
  const [sending, setSending] = useState(false);

  const effectiveDays =
    days === "custom" ? Number.parseInt(customDays, 10) || 0 : days;
  const valid = effectiveDays >= 1 && effectiveDays <= 180;
  const hasPhone = !!estimate.customerPhone;

  const handleExtend = async () => {
    if (!valid) return;
    setSending(true);
    try {
      const result = await adminFetch(
        `/admin/estimates/${estimate.id}/extend`,
        {
          method: "POST",
          body: JSON.stringify({ days: effectiveDays, silent }),
        },
      );
      onExtended?.(result);
    } catch (err) {
      alert("Extend failed: " + err.message);
    }
    setSending(false);
  };

  return (
    <Dialog open onClose={onClose} size="md">
      {" "}
      <DialogHeader>
        {" "}
        <DialogTitle>Extend estimate</DialogTitle>{" "}
        <div className="text-ui-body text-ink-secondary mt-0.5">
          {estimate.customerName}
          {estimate.address ? ` — ${estimate.address.split(",")[0]}` : ""}
        </div>{" "}
        {estimate.expiresAt && (
          <div className="text-ui-body text-ink-tertiary mt-0.5">
            Current expiry:{" "}
            {new Date(estimate.expiresAt).toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
              timeZone: "America/New_York",
            })}
          </div>
        )}{" "}
      </DialogHeader>{" "}
      <DialogBody>
        {" "}
        <div className="text-ui-body font-medium text-ink-secondary uppercase tracking-label mb-2">
          Add time
        </div>{" "}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 mb-3">
          {EXTEND_PRESETS.map((d) => {
            const selected = days === d;
            return (
              <Button
                key={d}
                type="button"
                variant={selected ? "primary" : "secondary"}
                onClick={() => setDays(d)}
              >
                +{d} days
              </Button>
            );
          })}{" "}
          <Button
            type="button"
            variant={days === "custom" ? "primary" : "secondary"}
            onClick={() => setDays("custom")}
          >
            Custom
          </Button>{" "}
        </div>
        {days === "custom" && (
          <div className="mb-3">
            <Input
              type="number"
              min={1}
              max={180}
              inputMode="numeric"
              value={customDays}
              onChange={(ev) => setCustomDays(ev.target.value)}
              placeholder="Days (1–180)"
              aria-label="Custom days to extend"
            />
          </div>
        )}
        {valid && (
          <div className="text-ui-body text-ink-secondary mb-3">
            New expiry:{" "}
            <span className="text-zinc-900 font-medium">
              {previewExpiry(estimate.expiresAt, effectiveDays)}
            </span>
          </div>
        )}{" "}
        <label className="flex items-start gap-2 text-ui-body text-ink-secondary cursor-pointer">
          {" "}
          <Checkbox
            checked={silent}
            onChange={(ev) => setSilent(ev.target.checked)}
            className="mt-1"
          />{" "}
          <span>
            Skip the customer SMS (just extend silently — Waves voice text is
            sent by default
            {hasPhone
              ? ""
              : "; no phone on file so this would be skipped anyway"}
            ).
          </span>{" "}
        </label>{" "}
      </DialogBody>{" "}
      <DialogFooter>
        {" "}
        <Button variant="secondary" onClick={onClose} disabled={sending}>
          Cancel
        </Button>{" "}
        <Button
          variant="primary"
          onClick={handleExtend}
          disabled={sending || !valid}
        >
          {sending
            ? "Extending…"
            : silent || !hasPhone
              ? `Extend +${effectiveDays}d`
              : `Extend +${effectiveDays}d & text`}
        </Button>{" "}
      </DialogFooter>{" "}
    </Dialog>
  );
}
