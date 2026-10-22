import { useCallback, useEffect, useState } from "react";
import {
  loadEmailDrafts,
  setEmailSending,
  subscribeEmailDrafts,
  updateEmailDrafts,
  updateEmailSendAttempt,
} from "../../../lib/emailDrafts";
import { adminFetch } from "./emailApi";
import { formatSendAt } from "./scheduleSend";

const SEND_ERRORS = {
  reply: "Failed to send reply: ",
  compose: "Failed to send: ",
};

// The composer and reply boxes are plain textareas, but the server sends the
// body as text/html. Escape the four HTML-significant characters before
// turning newlines into <br>, so "price <100 and >50" arrives intact and
// pasted markup is shown, not rendered.
export function encodeEmailBody(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

const uncertainKey = (userId) => `waves_email_schedule_uncertain:${userId}`;
// Whether a refusal came from the schedule route after it looked the key up
// (it says keyChecked). Any other refusal (sign-in, rate limit, gate off, a
// proxy) never reached that lookup: the key stays, so a retry finds the first
// row instead of queuing a second email.
function keyLookedUp(result) {
  return result.keyChecked === true;
}

// What the server's settled answer for an unconfirmed schedule request means
// for the draft: `next` is the guard that stays (null: none), `withdraw`
// removes the draft because the server holds that email.
const KEY_SETTLED = { request: "key_settled", clientKey: null };
function reconcileOutcome(row) {
  if (!row) return { next: null, message: "That request never queued an email. You can send or schedule this draft." };
  if (row.status === "sent") return { next: null, withdraw: true, message: "That email already went out. It is in the Gmail Sent folder." };
  if (["scheduled", "sending"].includes(row.status)) {
    return { next: null, withdraw: true, message: `That email is scheduled after all (${formatSendAt(row.sendAt)}). Find it under Scheduled.` };
  }
  if (row.status === "failed") return { next: null, message: "Gmail refused that email. Your draft is still here." };
  // outcome_unknown, or cancelled (its text may be a draft in another tab):
  // the operator's own check decides, so the guard stays without a key.
  return { next: KEY_SETTLED, message: row.status === "cancelled"
    ? "That email was cancelled and may be open as a draft in another tab. Look there, then tap I checked."
    : "That email may have gone out. Look in the Gmail Sent folder, then tap I checked." };
}

// The guard a restored email that Gmail may have sent carries: no request
// fingerprint matches it, so scheduling it again also waits for the check.
const MAY_HAVE_SENT = { request: "may_have_sent", clientKey: null };

// A retried key can return a row the sender already settled: nothing is
// queued, so the draft stays and the outcome shows.
const SETTLED_MESSAGES = {
  failed: "Gmail refused this email. Your draft is still here.",
  outcome_unknown: "This email may have gone out. Look in the Gmail Sent folder before you send it again.",
  // Never queued again by itself: its text may already be back in a draft
  // in another tab, and a second copy could go out.
  cancelled: "This email was cancelled after an earlier request, and its text may be open as a draft in another tab. Look there, under Scheduled and in the Gmail Sent folder, then tap I checked to use this draft.",
};

// The answer to a schedule request that queued (or had already sent) the
// email. `cleared` is false when edits made while the request ran are still
// in the draft: those were not scheduled.
function queuedMessage(status, sendAt, cleared) {
  // The first request's email already went out: say so, never "Scheduled".
  const done = status === "sent"
    ? "This email already went out. It is in the Gmail Sent folder."
    : `Scheduled for ${formatSendAt(sendAt)}. Find it under Scheduled.`;
  return cleared ? done : `${done} Your newer edits were not scheduled and are still in the draft.`;
}

// FNV-1a, enough to tell "the same email at the same time" from another one.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${hash.toString(16)}`;
}
function readUncertainSchedules(userId) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(uncertainKey(userId)) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

export default function useEmailEditor(userId) {
  const [draftSession] = useState(() => loadEmailDrafts(userId));
  const snapshot = () => ({
    drafts: draftSession.drafts,
    saved: draftSession.saved,
    sending: { ...draftSession.sending },
    attempts: { ...draftSession.attempts },
  });
  const [editor, setEditor] = useState(snapshot);
  useEffect(
    () => subscribeEmailDrafts(draftSession, () => setEditor(snapshot())),
    [draftSession],
  );
  const { drafts, saved, sending, attempts } = editor;
  const composeForm = drafts.compose;
  const [showCompose, setComposeOpen] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState(null);
  const [sendFeedback, setSendFeedback] = useState({});
  // Schedule state lives on the shared draft session, not in this hook, so
  // leaving Communications and coming back keeps it. `uncertain` holds, per
  // draft slot, the key of a schedule request with no definite answer yet
  // (saved before the request, so in flight counts too): the same email at
  // the same time reuses it, and plain Send waits until the operator checked
  // the Scheduled list. It is in this tab's sessionStorage, so a reload keeps it.
  if (!draftSession.schedule) draftSession.schedule = { scheduling: null, uncertain: readUncertainSchedules(userId) };
  const shared = draftSession.schedule;
  const notifyDrafts = () => draftSession.listeners.forEach((notify) => notify());
  const { scheduling } = shared;
  const setScheduling = (kind) => { shared.scheduling = kind; notifyDrafts(); };
  const uncertainSchedule = { current: shared.uncertain };
  // Returns false when the tab could not save it. A key that cannot survive
  // a reload cannot stop a second row, so the caller must not send.
  const rememberUncertain = (slot, entry) => {
    const before = uncertainSchedule.current[slot];
    if (entry) uncertainSchedule.current[slot] = entry;
    else delete uncertainSchedule.current[slot];
    let saved = true;
    try {
      sessionStorage.setItem(uncertainKey(userId), JSON.stringify(uncertainSchedule.current));
    } catch {
      if (entry) uncertainSchedule.current[slot] = before;
      saved = false;
    }
    notifyDrafts();
    return saved;
  };
  const slotOf = (replyId) => (replyId ? `reply:${replyId}` : "compose");
  // A schedule request for this draft slot has no definite answer: plain Send
  // could deliver a copy now while the queued one still sends later.
  const scheduleUnconfirmed = (replyId = null) => Boolean(uncertainSchedule.current[slotOf(replyId)]);
  // Why plain Send waits: "may_have_sent", "taken_over", or another kind.
  const guardKind = (replyId = null) => uncertainSchedule.current[slotOf(replyId)]?.request;
  // The operator looked under Scheduled and in Gmail Sent: the email is in
  // neither. A schedule request with a key is first settled on the server
  // (its row, or a void row that stops a late copy), and the guard follows
  // what that answer says; only a guard with no key is the operator's call.
  const confirmScheduleChecked = async (replyId = null) => {
    const slot = slotOf(replyId);
    const entry = uncertainSchedule.current[slot];
    if (scheduling || !entry) return;
    // A guard with no key is the operator's call. For an email that may have
    // gone out, that check is also its alert's job done: the guard clears only
    // once the server closed the alert, so a failed request can be repeated.
    if (!entry.clientKey) {
      if (entry.rowId && !(await alertClosed(entry.rowId))) {
        setSendFeedback((current) => ({ ...current, [replyId ? "reply" : "compose"]: { messageId: replyId, error: true, message: "Could not record the check. Try again in a moment." } }));
        return;
      }
      rememberUncertain(slot, null);
      return;
    }
    const kind = replyId ? "reply" : "compose";
    const say = (message, error = false) => setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error, message } }));
    let row;
    try {
      const response = await adminFetch("/api/admin/email/schedule/reconcile", { method: "POST", body: JSON.stringify({ clientKey: entry.clientKey }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error("reconcile");
      row = data.scheduled;
    } catch {
      say("Could not check that request. Try again in a moment.", true);
      return;
    }
    // The answer is for this key only: if the slot's guard changed while it
    // ran (a second tap, a new request), it says nothing about the new one.
    if (uncertainSchedule.current[slot]?.clientKey !== entry.clientKey) return;
    const outcome = reconcileOutcome(row);
    rememberUncertain(slot, outcome.next);
    const kept = outcome.withdraw && !withdrawIfQueued(replyId, row);
    say(kept ? `${outcome.message} Your newer edits were not scheduled and are still in the draft.` : outcome.message, Boolean(outcome.next));
  };
  const alertClosed = async (rowId) => {
    try {
      const response = await adminFetch(`/api/admin/email/scheduled/${encodeURIComponent(rowId)}/sent-checked`, { method: "POST" });
      return response.ok;
    } catch { return false; }
  };
  // Removes a draft whose email the server already holds (queued or sent),
  // but only while it is still that email's text: newer edits stay. Returns
  // whether it removed the draft.
  const withdrawIfQueued = (replyId, row) => {
    if (replyId) {
      if ((draftSession.drafts.replies[replyId] || "") !== row.draftText) return false;
      setReplyDraft(replyId, "");
      return true;
    }
    const current = draftSession.drafts.compose;
    const subject = current.subject.trim() || "(no subject)";
    if (current.body !== row.draftText || current.to.trim() !== row.to || subject !== row.subject) return false;
    setComposeForm(() => ({ to: "", subject: "", body: "" }));
    setShowCompose(false);
    return true;
  };
  const setShowCompose = (visible) => {
    if (visible) setSendFeedback((current) => ({ ...current, compose: null }));
    setComposeOpen(visible);
  };
  const clearDraftResult = useCallback(() => setDraftResult(null), []);
  const changeDrafts = (update) => updateEmailDrafts(draftSession, update);
  const setReplyDraft = (id, text) => {
    // A new or discarded draft in this conversation must not sit under an
    // older "Reply sent." banner that reads as if the new text went out.
    setSendFeedback((current) =>
      current.reply?.messageId === id ? { ...current, reply: null } : current,
    );
    // The store's answer: { saved } for this write, or null if it was refused.
    return changeDrafts((current) => ({
      ...current,
      replies: { ...current.replies, [id]: text },
    }));
  };
  const setComposeForm = (update) => {
    setSendFeedback((current) => ({ ...current, compose: null }));
    return changeDrafts((current) => ({
      ...current,
      compose: update(current.compose),
    }));
  };
  const hasComposeDraft = Object.values(composeForm).some(Boolean);
  const hasDrafts =
    hasComposeDraft || Object.values(drafts.replies).some(Boolean);
  const storageError = !saved;
  const recoveryNotice = storageError
    ? "Draft recovery is unavailable. Your text stays while navigating here; copy it before reloading or closing this tab."
    : "Drafts are saved in this browser tab until you send, discard, or sign out.";

  const sendEmail = async (kind, payload, snapshot, replyId, onSuccess) => {
    const key = kind === "compose" ? "compose" : `reply:${replyId}`;
    if (draftSession.attempts[key]) return;
    if (!setEmailSending(draftSession, kind, true)) return;
    setSendFeedback((current) => ({ ...current, [kind]: null }));
    const attempt = { id: crypto.randomUUID(), status: "running", startedAt: new Date().toISOString(), snapshot, replyId };
    if (!updateEmailSendAttempt(draftSession, key, attempt)) {
      setEmailSending(draftSession, kind, false);
      window.alert("Send was not started because its recovery record could not be saved.");
      return;
    }
    let accepted = false;
    try {
      const response = await adminFetch("/api/admin/email/send", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          body: encodeEmailBody(payload.body),
        }),
      });
      // Router-level authentication/authorization answers before the send
      // handler runs: the email definitively never reached Gmail, so release
      // the guard instead of locking the composer behind reconciliation.
      if (response.status === 401 || response.status === 403) {
        updateEmailSendAttempt(draftSession, key, null, attempt.id);
        window.alert(SEND_ERRORS[kind] + "Your session is not authorized to send email. Sign in again and retry.");
        return;
      }
      const result = await response.json();
      if (result.status === "failed") {
        updateEmailSendAttempt(draftSession, key, null, attempt.id);
        window.alert(SEND_ERRORS[kind] + (result.error || "The email was not accepted."));
        return;
      }
      if (!response.ok || !result.success || !result.messageId) throw new Error("Email outcome unknown");
      accepted = true;
      updateEmailSendAttempt(draftSession, key, { ...attempt, status: "provider_accepted", messageId: result.messageId }, attempt.id);
      // onSuccess reports whether the submitted snapshot was still the draft;
      // edits made while the send was pending stay behind, unsent, and the
      // banner must say so instead of labelling that newer text as sent.
      const submittedCurrent = await onSuccess();
      const sent = kind === "reply" ? "Reply sent." : "Email sent.";
      setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, message: submittedCurrent ? sent : `${sent} Your newer edits are still here.` } }));
      if (draftSession.saved) updateEmailSendAttempt(draftSession, key, null, attempt.id);
    } catch {
      if (accepted) {
        window.alert("Gmail accepted the email. The inbox could not refresh; do not resend it.");
      } else {
        updateEmailSendAttempt(draftSession, key, { ...attempt, status: "outcome_unknown" }, attempt.id);
        setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error: true, message: kind === "reply" ? "Reply send was not confirmed. Your draft is still here." : "Email send was not confirmed. Your draft is still here." } }));
      }
    } finally {
      setEmailSending(draftSession, kind, false);
    }
  };

  const handleReply = async (email, onSent) => {
    const text = drafts.replies[email?.id] || "";
    if (!email || !text.trim() || scheduleUnconfirmed(email.id)) return;
    const revision = draftSession.replyRevisions[email.id] || 0;
    await sendEmail(
      "reply",
      {
        // ADMIN-BUG-R22: relayed mail (contact forms, lead marketplaces,
        // ticketing) has a no-reply From with the real recipient in
        // Reply-To. Same rule the server's AI-draft path already applies
        // (email-actions.js: reply_to || from_address).
        to: email.reply_to || email.from_address,
        subject: `Re: ${email.subject || ""}`,
        body: text,
        threadId: email.gmail_thread_id,
      },
      text,
      email.id,
      async () => {
        const submittedCurrent = (draftSession.replyRevisions[email.id] || 0) === revision;
        changeDrafts((current) => ({
          ...current,
          replies: {
            ...current.replies,
            [email.id]: submittedCurrent ? "" : current.replies[email.id],
          },
        }));
        const clearedRevision = draftSession.replyRevisions[email.id] || 0;
        await onSent(email);
        // The thread refresh can be slow; a reply typed during it is newer too.
        return submittedCurrent && (draftSession.replyRevisions[email.id] || 0) === clearedRevision;
      },
    );
  };

  const handleComposeSend = async (onSent) => {
    if (!composeForm.to.trim() || !composeForm.body.trim() || scheduleUnconfirmed()) return;
    await sendEmail(
      "compose",
      {
        to: composeForm.to.trim(),
        subject: composeForm.subject.trim() || "(no subject)",
        body: composeForm.body,
      },
      composeForm,
      null,
      async () => {
        // Only clear the submitted snapshot; edits can outlive this component.
        const submittedCurrent = draftSession.drafts.compose === composeForm;
        if (submittedCurrent) {
          setComposeForm(() => ({ to: "", subject: "", body: "" }));
          setShowCompose(false);
        }
        const cleared = draftSession.drafts.compose;
        await onSent();
        return submittedCurrent && draftSession.drafts.compose === cleared;
      },
    );
  };

  // Schedule send (GATE_EMAIL_SEND_LATER). The server queues the email; the
  // draft clears only if it still holds the text that was queued. A request
  // whose answer was lost keeps its clientKey (uncertainSchedule), and the
  // Scheduled list reloads after every attempt.
  const scheduleEmail = async (kind, payload, replyId, sendAt, clearQueued, onScheduled) => {
    if (scheduling || draftSession.sending[kind]) return;
    const slot = slotOf(replyId);
    // Only a fingerprint is kept (sessionStorage must never hold the email).
    const request = fingerprint(JSON.stringify({ ...payload, sendAt }));
    const prior = uncertainSchedule.current[slot];
    // While an earlier request has no definite answer, only the same email at
    // the same time may go (it reuses that key). A changed one would get a new
    // key and could queue a second copy beside the first.
    if (prior && prior.request !== request) {
      setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error: true, message: "An earlier schedule request for this email was not confirmed. Look under Scheduled and in the Gmail Sent folder, then tap I checked before you change it." } }));
      return;
    }
    setScheduling(kind);
    setSendFeedback((current) => ({ ...current, [kind]: null }));
    const submit = async (clientKey) => {
      // Saved before the request: a reload while it is in flight still finds
      // the key. Cleared only on a definite answer.
      if (!rememberUncertain(slot, { request, clientKey })) throw Object.assign(new Error("Key not saved"), { notStarted: true });
      const response = await adminFetch("/api/admin/email/schedule", {
        method: "POST",
        body: JSON.stringify({ ...payload, body: encodeEmailBody(payload.body), draftText: payload.body, sendAt, clientKey }),
      });
      const result = await response.json().catch(() => null);
      // A 2xx or 5xx without a readable answer may hide a committed insert.
      if (!result || (response.ok && !result.success)) throw new Error("Schedule outcome unknown");
      return { response, result };
    };
    try {
      const { response, result } = await submit(prior?.clientKey || crypto.randomUUID());
      if (!response.ok) {
        if (keyLookedUp(result)) rememberUncertain(slot, null);
        setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error: true, message: result.error || "The email was not scheduled. Your draft is still here." } }));
        return;
      }
      const status = result.scheduled?.status;
      // A row Gmail may have sent (outcome_unknown) or one cancelled since
      // (its text may be a draft in another tab) keeps the key, so plain
      // Send waits for the operator's check; every other answer is definite.
      if (!["outcome_unknown", "cancelled"].includes(status) && !result.scheduled?.mayHaveSent) rememberUncertain(slot, null);
      const settled = SETTLED_MESSAGES[status];
      if (settled) {
        setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error: true, message: settled } }));
        return;
      }
      const message = queuedMessage(status, sendAt, clearQueued());
      setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, message } }));
    } catch (err) {
      if (err?.notStarted) {
        setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error: true, message: "Scheduling did not start: this browser could not save its safety key. Your draft is still here." } }));
        return;
      }
      setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error: true, message: "Scheduling was not confirmed. Look under Scheduled before you schedule or send it again." } }));
    } finally {
      setScheduling(null);
      await onScheduled?.();
    }
  };

  const handleComposeSchedule = (sendAt, onScheduled) => {
    if (!composeForm.to.trim() || !composeForm.body.trim()) return undefined;
    const payload = { to: composeForm.to.trim(), subject: composeForm.subject.trim(), body: composeForm.body };
    return scheduleEmail("compose", payload, null, sendAt, () => {
      // Compared by value: an edit changed back to the queued text is still
      // the queued email and must not stay behind as a sendable copy.
      const current = draftSession.drafts.compose;
      if (current.to.trim() !== payload.to || current.subject.trim() !== payload.subject || current.body !== payload.body) return false;
      setComposeForm(() => ({ to: "", subject: "", body: "" }));
      setShowCompose(false);
      return true;
    }, onScheduled);
  };

  const handleReplySchedule = (email, sendAt, onScheduled) => {
    const text = drafts.replies[email?.id] || "";
    if (!email || !text.trim()) return undefined;
    return scheduleEmail("reply", {
      to: email.reply_to || email.from_address, subject: `Re: ${email.subject || ""}`, body: text,
      threadId: email.gmail_thread_id, replyEmailId: email.id,
    }, email.id, sendAt, () => {
      if (draftSession.drafts.replies[email.id] !== text) return false;
      setReplyDraft(email.id, "");
      return true;
    }, onScheduled);
  };

  // Gmail's "Cancel send": the cancelled email comes back as a draft. It never
  // overwrites a draft in progress; the caller says so instead.
  // Checked BEFORE the server cancel, so a cancelled email always has a
  // place to land.
  const scheduledDraftBlocked = (draft) => (draft.replyEmailId
    ? Boolean((draftSession.drafts.replies[draft.replyEmailId] || "").trim())
    : Object.values(draftSession.drafts.compose).some(Boolean));
  // Returns false when blocked, { opened: false } when the tab could not
  // save the Sent-check guard (the draft does not open), else
  // { opened: true, saved }: `saved` is the draft write's own result.
  const restoreScheduledDraft = (draft) => {
    if (scheduledDraftBlocked(draft)) return false;
    // Gmail may already have this email: plain Send waits for the same
    // Sent-folder check as an unconfirmed schedule request. A guard that
    // cannot survive a reload is no guard, so the draft does not open.
    if (draft.mayHaveSent && !rememberUncertain(slotOf(draft.replyEmailId), { ...MAY_HAVE_SENT, rowId: draft.id })) return { opened: false };
    if (draft.replyEmailId) return { opened: true, saved: setReplyDraft(draft.replyEmailId, draft.draftText)?.saved === true };
    const written = setComposeForm(() => ({ to: draft.to, subject: draft.subject === "(no subject)" ? "" : draft.subject, body: draft.draftText }));
    setShowCompose(true);
    return { opened: true, saved: written?.saved === true };
  };

  const reconcileSend = (key, outcome) => {
    const attempt = draftSession.attempts[key];
    if (!attempt || draftSession.sending[key === "compose" ? "compose" : "reply"]) return;
    // Like outreach reconciliation, these are explicit operator verdicts after
    // checking Sent. An empty search result never releases a send automatically.
    if (outcome === "sent") {
      changeDrafts(current => key === "compose" ? { ...current, compose:
        ["to", "subject", "body"].every(field => current.compose[field] === attempt.snapshot[field])
          ? { to: "", subject: "", body: "" } : current.compose,
      } : { ...current, replies: { ...current.replies,
        [attempt.replyId]: current.replies[attempt.replyId] === attempt.snapshot ? "" : current.replies[attempt.replyId],
      } });
      if (!draftSession.saved) return;
    }
    if (updateEmailSendAttempt(draftSession, key, null, attempt.id)) {
      const kind = key === "compose" ? "compose" : "reply";
      setSendFeedback(current => kind === "reply" && current.reply?.messageId !== attempt.replyId
        ? current : { ...current, [kind]: null });
    }
  };

  const handleAiDraft = async (email, isSelected) => {
    if (!email || drafting || draftSession.sending.reply) return;
    const replyRevision = draftSession.replyRevisions[email.id] || 0;
    setDrafting(true);
    setDraftResult(null);
    setSendFeedback((current) => ({ ...current, reply: null }));
    try {
      const r = await adminFetch(
        `/api/admin/email/message/${email.id}/ai-draft`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (d?.error || typeof d?.reply_draft !== "string" || !d.reply_draft.trim()) throw new Error("Draft unavailable");
      if (
        (draftSession.replyRevisions[email.id] || 0) === replyRevision
      ) {
        setReplyDraft(email.id, d.reply_draft);
        if (isSelected(email.id)) setDraftResult(d);
      }
    } catch {
      setSendFeedback((current) => ({ ...current, reply: { messageId: email.id, error: true, message: "Could not create an AI draft. Your text is still here." } }));
    }
    setDrafting(false);
  };

  return {
    drafts,
    sendFeedback,
    composeForm,
    setComposeForm,
    setReplyDraft,
    showCompose,
    setShowCompose,
    sending: sending.reply,
    composeSending: sending.compose,
    drafting,
    draftResult,
    clearDraftResult,
    hasDrafts,
    hasComposeDraft,
    storageError,
    recoveryNotice,
    sendAttempts: attempts,
    reconcileSend,
    handleReply,
    handleComposeSend,
    handleAiDraft,
    scheduling,
    scheduleUnconfirmed,
    guardKind,
    confirmScheduleChecked,
    handleComposeSchedule,
    handleReplySchedule,
    restoreScheduledDraft,
    scheduledDraftBlocked,
  };
}
