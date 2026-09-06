import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui";
import useModalFocus from "../../hooks/useModalFocus";
import { etDatetimeLocalToISO } from "../../lib/timezone";

const SendContext = createContext(null);
const headers = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}` });
const CHANNEL_LABELS = { sms: "Text message", email: "Email", both: "Text message and email" };

export function useEstimateSend() {
  return useContext(SendContext);
}

// Every Pipeline entry point opens the same saved-offer confirmation. The
// promise settles only when the operator closes the outcome, so callers refresh
// their own existing list/activity loaders without another global cache.
export function EstimateSendProvider({ children }) {
  const [request, setRequest] = useState(null);
  const requestRef = useRef(null);
  const open = useCallback((id, options = {}) => new Promise((resolve) => {
    if (requestRef.current) { resolve(null); return; }
    const next = { id, ...options, resolve };
    requestRef.current = next;
    setRequest(next);
  }), []);
  const close = useCallback((result) => {
    requestRef.current?.resolve(result || null);
    requestRef.current = null;
    setRequest(null);
  }, []);
  useEffect(() => () => requestRef.current?.resolve(null), []);
  return <SendContext.Provider value={open}>
    {children}
    {request && <EstimateSendDialog key={request.id} request={request} onClose={close} />}
  </SendContext.Provider>;
}

export default function EstimateSendDialog({ request, onClose }) {
  const [preview, setPreview] = useState(null);
  const [method, setMethod] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState(null);
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);
  const attempt = useRef(null);
  const dialogRef = useModalFocus(true, () => { if (!inFlight.current) onClose(outcome); });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/estimates/${request.id}/send-preview`, { headers: headers(), signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load the saved estimate.");
        if (!controller.signal.aborted) setPreview(data);
      })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [request.id]);

  async function send() {
    if (inFlight.current || !preview || !method || outcome) return;
    let scheduled = null;
    if (scheduledAt) {
      // The portal is Eastern-only. An offset supplied by the selected date's
      // ET calendar avoids interpreting a datetime-local value in another zone.
      const when = new Date(etDatetimeLocalToISO(scheduledAt));
      if (!Number.isFinite(when.getTime()) || when <= new Date()) { setError("Choose a future send time in Eastern time."); return; }
      scheduled = when.toISOString();
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    // Keep the exact body/key after a transport failure. Only a new dialog is
    // a deliberate new attempt; the server returns completed attempt receipts.
    attempt.current ||= {
      sendMethod: method, scheduledAt: scheduled,
      expectedEditVersion: preview.editVersion, messageVersion: preview.messageVersion,
      groupVersions: preview.groupVersions,
      idempotencyKey: crypto.randomUUID(), acknowledgeEngineReview: acknowledged,
      acknowledgeUncertainSend: acknowledged,
    };
    try {
      const response = await fetch(`/api/admin/estimates/${request.id}/send`, {
        method: "POST", headers: headers(), body: JSON.stringify(attempt.current),
      });
      const data = await response.json();
      if (!response.ok && !data.channels) throw new Error(data.error || "Send failed. Your saved estimate is retained.");
      setOutcome({ ...data, status: response.status });
      if (!response.ok) setError(data.error || "No requested channel reached a provider.");
    } catch (err) {
      setError(`${err.message} The saved estimate is retained. Retrying checks the same attempt.`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const locked = busy || !!attempt.current;
  const blocked = preview?.blockReason && !preview.requiresEngineReview;
  const stale = request.expectedEditVersion && preview?.editVersion && request.expectedEditVersion !== preview.editVersion;
  const notice = [request.warning, preview?.requiresEngineReview ? preview.blockReason : "", preview?.uncertainAttempt ? "An earlier send has an uncertain outcome. Check the conversation and email delivery records; another send could duplicate it." : ""].filter(Boolean).join(" ");
  const needsAcknowledgment = !!notice;
  return createPortal(
    <div className="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-3 sm:p-6">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="estimate-send-title" className="w-full max-w-2xl max-h-[calc(100dvh-24px)] overflow-y-auto bg-white text-ink-primary rounded-sm shadow-xl p-5 sm:p-6 text-16">
        <div className="flex items-start justify-between gap-4">
          <div><h2 id="estimate-send-title" className="text-22 font-medium">Review and send</h2><p className="text-14 text-ink-secondary mt-1">The saved estimate is the offer being sent.</p></div>
          <Button variant="ghost" className="min-h-11" disabled={busy} onClick={() => onClose(outcome)}>Close</Button>
        </div>
        {!preview && !error && <p role="status" className="py-6">Loading saved recipient and message…</p>}
        {error && <p role="alert" className="my-4 text-alert-fg">{error}</p>}
        {preview && <div className="space-y-5 mt-5">
          <div className="border-b border-zinc-200 pb-4 break-words">
            <p className="font-medium">{preview.customerName || "Unnamed recipient"}</p>
            <p className="text-14 text-ink-secondary">{preview.address || "No service address"}</p>
            <p className="text-14 text-ink-secondary mt-1">{preview.status} · saved {new Date(preview.updatedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} Eastern</p>
            <a className="inline-flex items-center min-h-11 text-ink-primary underline u-focus-ring" href={preview.previewPath} target="_blank" rel="noopener noreferrer">Preview saved customer document</a>
            <p className="text-14">Recipient changes belong in Customer &amp; property, followed by Save draft.</p>
          </div>
          {(blocked || stale) && <p role="alert" className="text-alert-fg">{stale ? "This offer changed since the editor loaded. Reopen it and review the current version." : preview.blockReason}</p>}
          <fieldset disabled={locked} className="border-0 p-0 min-w-0">
            <legend className="font-medium mb-2">Choose delivery channel</legend>
            {Object.entries(CHANNEL_LABELS).map(([key, label]) => <label key={key} className="flex items-center gap-3 min-h-11">
              <input type="radio" name="estimate-send-channel" value={key} checked={method === key} onChange={() => setMethod(key)} disabled={(key !== "email" && !preview.customerPhone) || (key !== "sms" && !preview.customerEmail)} />
              <span>{label}</span>
            </label>)}
            <p className="text-14 text-ink-secondary mt-2 break-words">Text: {preview.customerPhone || "No phone saved"}<br />Email: {preview.customerEmail || "No email saved"}</p>
          </fieldset>
          {method && <div className="space-y-3">
            <h3 className="font-medium">Message preview</h3>
            {method !== "email" && <div><p className="text-14 font-medium mb-1">Text message</p><p className="whitespace-pre-wrap break-words rounded-sm bg-zinc-50 p-3 text-14">{preview.messages.sms || "The text template is unavailable. Sending this channel will fail."}</p></div>}
            {method !== "sms" && <div><p className="text-14 font-medium mb-1">{preview.messages.email?.subject || "Email template unavailable"}</p><p className="whitespace-pre-wrap break-words rounded-sm bg-zinc-50 p-3 text-14">{preview.messages.email?.text || "Sending this channel will fail."}</p></div>}
            <p className="text-14 text-ink-secondary">Delivery replaces the full estimate URL with a tracked secure link to the same offer.</p>
          </div>}
          <label className="block">Send later (Eastern time, optional)<input aria-label="Send later in Eastern time" type="datetime-local" disabled={locked} value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="mt-2 block w-full min-w-0 min-h-11 border border-zinc-300 rounded-sm p-2 text-16 u-focus-ring" /></label>
          {needsAcknowledgment && <label className="flex items-start gap-3 min-h-11 text-14"><input className="mt-1" type="checkbox" disabled={locked} checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} /><span>{notice} I reviewed this warning and authorize this send.</span></label>}
          {outcome && <div role="status" className="border-t border-zinc-200 pt-4 space-y-2">
            {outcome.scheduled && <p>Scheduled for {new Date(outcome.scheduledAt).toLocaleString("en-US", { timeZone: "America/New_York" })} Eastern. No provider handoff yet.</p>}
            {Object.entries(outcome.channels || {}).map(([channel, result]) => <p key={channel}>{CHANNEL_LABELS[channel]} to {channel === "sms" ? preview.customerPhone : preview.customerEmail}: {result.uncertain ? "provider outcome uncertain; check delivery records before resending" : result.ok && result.real !== false ? "provider accepted; delivery not confirmed" : result.error || "not sent"}.</p>)}
            {outcome.groupPublicationFailures > 0 && <p className="text-alert-fg">{outcome.groupPublicationFailures} grouped properties were not published. Review the group before another send.</p>}
            {outcome.replayed && <p className="text-14">This is the recorded outcome of the earlier attempt. No new message was sent.</p>}
          </div>}
          <div className="flex flex-wrap gap-2 border-t border-zinc-200 pt-4">
            {!outcome && <Button className="min-h-11" disabled={!method || busy || blocked || stale || (needsAcknowledgment && !acknowledged)} onClick={send}>{busy ? "Sending…" : attempt.current ? "Check / retry attempt" : scheduledAt ? "Confirm scheduled send" : "Confirm send"}</Button>}
            {preview.customerUrl && <Button variant="secondary" className="min-h-11" onClick={async () => { try { await navigator.clipboard.writeText(preview.customerUrl); setCopied(true); } catch { setError("Copy failed. Open the saved preview to access the link."); } }}>{copied ? "Link copied" : "Copy secure estimate link"}</Button>}
            <Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => onClose(outcome)}>{outcome ? "Done" : "Cancel"}</Button>
          </div>
        </div>}
      </section>
    </div>, document.body,
  );
}
