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
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Textarea,
  cn,
} from "../ui";
import { DECLINE_REASONS } from "../../pages/admin/EstimatePage";

// Match the EstimatesPageV2 surface — the estimates page is locked to Roboto
// per Adam's design call, and these modals only render from that page, so
// the panel font follows the same body.
const ROBOTO_STYLE = { fontFamily: "'Roboto', Arial, sans-serif" };

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

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
    <Dialog open onClose={onClose} size="md" style={ROBOTO_STYLE}>
      {" "}
      <DialogHeader>
        {" "}
        <DialogTitle>Follow Up — {estimate.customerName}</DialogTitle>{" "}
        <div className="text-12 text-ink-secondary mt-0.5">
          {estimate.address || "—"}
        </div>{" "}
      </DialogHeader>{" "}
      <DialogBody>
        {" "}
        <label className="block text-11 font-medium text-ink-secondary uppercase tracking-label mb-1.5">
          SMS Message
        </label>{" "}
        <Textarea
          value={message}
          onChange={(ev) => setMessage(ev.target.value)}
          rows={4}
          className="min-h-[96px]"
        />{" "}
        <div className="text-11 text-ink-tertiary mt-1.5">
          Delivered via Twilio · replies route to the shared inbox
        </div>{" "}
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
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!reason) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "declined", declineReason: reason }),
      });
      onSaved();
    } catch (err) {
      alert("Failed: " + err.message);
    }
    setSaving(false);
  };

  return (
    <Dialog open onClose={onClose} size="sm" style={ROBOTO_STYLE}>
      {" "}
      <DialogHeader>
        {" "}
        <DialogTitle>Mark as Lost</DialogTitle>{" "}
        <div className="text-12 text-ink-secondary mt-0.5">
          {estimate.customerName}
          {estimate.address ? ` — ${estimate.address.split(",")[0]}` : ""}
        </div>{" "}
      </DialogHeader>{" "}
      <DialogBody>
        {" "}
        <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-2">
          Reason
        </div>{" "}
        <div className="flex flex-col gap-1.5">
          {DECLINE_REASONS.map((r) => {
            const selected = reason === r;
            return (
              <label
                key={r}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-xs cursor-pointer",
                  "text-13 border-hairline transition-colors",
                  selected
                    ? "bg-zinc-50 border-zinc-900 text-zinc-900"
                    : "bg-white border-zinc-300 text-ink-secondary hover:bg-zinc-50",
                )}
              >
                {" "}
                <input
                  type="radio"
                  name="declineReason"
                  checked={selected}
                  onChange={() => setReason(r)}
                  className="sr-only"
                />{" "}
                <span
                  className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full border-hairline flex-shrink-0",
                    selected
                      ? "bg-zinc-900 border-zinc-900 ring-2 ring-white ring-inset"
                      : "border-zinc-400",
                  )}
                  aria-hidden
                />
                {r}
              </label>
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
          disabled={saving || !reason}
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

  const effectiveDays = days === "custom"
    ? Number.parseInt(customDays, 10) || 0
    : days;
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
    <Dialog open onClose={onClose} size="md" style={ROBOTO_STYLE}>
      {" "}
      <DialogHeader>
        {" "}
        <DialogTitle>Extend estimate</DialogTitle>{" "}
        <div className="text-12 text-ink-secondary mt-0.5">
          {estimate.customerName}
          {estimate.address ? ` — ${estimate.address.split(",")[0]}` : ""}
        </div>{" "}
        {estimate.expiresAt && (
          <div className="text-11 text-ink-tertiary mt-0.5">
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
        <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-2">
          Add time
        </div>{" "}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 mb-3">
          {EXTEND_PRESETS.map((d) => {
            const selected = days === d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={cn(
                  "h-10 px-3 rounded-sm text-13 font-medium border-hairline u-focus-ring transition-colors",
                  selected
                    ? "bg-zinc-900 text-white border-zinc-900"
                    : "bg-white text-zinc-900 border-zinc-300 hover:bg-zinc-50",
                )}
              >
                +{d} days
              </button>
            );
          })}{" "}
          <button
            type="button"
            onClick={() => setDays("custom")}
            className={cn(
              "h-10 px-3 rounded-sm text-13 font-medium border-hairline u-focus-ring transition-colors",
              days === "custom"
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-zinc-900 border-zinc-300 hover:bg-zinc-50",
            )}
          >
            Custom
          </button>{" "}
        </div>
        {days === "custom" && (
          <div className="mb-3">
            <input
              type="number"
              min={1}
              max={180}
              inputMode="numeric"
              value={customDays}
              onChange={(ev) => setCustomDays(ev.target.value)}
              placeholder="Days (1–180)"
              aria-label="Custom days to extend"
              className="w-full h-10 px-3 text-14 rounded-sm bg-white border-hairline border-zinc-300 u-focus-ring"
            />
          </div>
        )}
        {valid && (
          <div className="text-12 text-ink-secondary mb-3">
            New expiry:{" "}
            <span className="text-zinc-900 font-medium">
              {previewExpiry(estimate.expiresAt, effectiveDays)}
            </span>
          </div>
        )}{" "}
        <label className="flex items-start gap-2 text-13 text-ink-secondary cursor-pointer">
          {" "}
          <input
            type="checkbox"
            checked={silent}
            onChange={(ev) => setSilent(ev.target.checked)}
            className="mt-1"
          />{" "}
          <span>
            Skip the customer SMS (just extend silently — Waves voice text is
            sent by default
            {hasPhone ? "" : "; no phone on file so this would be skipped anyway"}
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
