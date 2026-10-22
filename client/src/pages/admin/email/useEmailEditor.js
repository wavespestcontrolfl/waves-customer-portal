import { useCallback, useEffect, useRef, useState } from "react";
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
  const [scheduling, setScheduling] = useState(null);
  // Per draft slot, the key of a schedule request whose answer never came:
  // the same email at the same time reuses it, so the server keeps one row.
  // Kept in this tab's sessionStorage, like the drafts, so a reload keeps it.
  const uncertainSchedule = useRef(null);
  if (uncertainSchedule.current === null) uncertainSchedule.current = readUncertainSchedules(userId);
  const rememberUncertain = (slot, entry) => {
    if (entry) uncertainSchedule.current[slot] = entry;
    else delete uncertainSchedule.current[slot];
    try { sessionStorage.setItem(uncertainKey(userId), JSON.stringify(uncertainSchedule.current)); } catch { /* memory copy still holds */ }
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
    changeDrafts((current) => ({
      ...current,
      replies: { ...current.replies, [id]: text },
    }));
  };
  const setComposeForm = (update) => {
    setSendFeedback((current) => ({ ...current, compose: null }));
    changeDrafts((current) => ({
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
    if (!email || !text.trim()) return;
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
    if (!composeForm.to.trim() || !composeForm.body.trim()) return;
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
    setScheduling(kind);
    setSendFeedback((current) => ({ ...current, [kind]: null }));
    const slot = replyId ? `reply:${replyId}` : "compose";
    // Only a fingerprint is kept (sessionStorage must never hold the email).
    const request = fingerprint(JSON.stringify({ ...payload, sendAt }));
    const prior = uncertainSchedule.current[slot];
    const submit = async (clientKey) => {
      // Saved before the request: a reload while it is in flight still finds
      // the key. Cleared only on a definite answer.
      rememberUncertain(slot, { request, clientKey });
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
      let { response, result } = await submit(prior?.request === request ? prior.clientKey : crypto.randomUUID());
      // A remembered key can name an email that was cancelled since: that is
      // not this request, so queue it again under a fresh key.
      if (response.ok && result.scheduled?.status === "cancelled") ({ response, result } = await submit(crypto.randomUUID()));
      if (!response.ok) {
        if (response.status < 500) rememberUncertain(slot, null);
        setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error: true, message: result.error || "The email was not scheduled. Your draft is still here." } }));
        return;
      }
      rememberUncertain(slot, null);
      clearQueued();
      setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, message: `Scheduled for ${formatSendAt(sendAt)}. Find it under Scheduled.` } }));
    } catch {
      setSendFeedback((current) => ({ ...current, [kind]: { messageId: replyId, error: true, message: "Scheduling was not confirmed. Look under Scheduled before you schedule or send it again." } }));
    } finally {
      setScheduling(null);
      await onScheduled?.();
    }
  };

  const handleComposeSchedule = (sendAt, onScheduled) => {
    if (!composeForm.to.trim() || !composeForm.body.trim()) return undefined;
    const queued = composeForm;
    return scheduleEmail("compose", { to: queued.to.trim(), subject: queued.subject.trim(), body: queued.body }, null, sendAt, () => {
      if (draftSession.drafts.compose !== queued) return;
      setComposeForm(() => ({ to: "", subject: "", body: "" }));
      setShowCompose(false);
    }, onScheduled);
  };

  const handleReplySchedule = (email, sendAt, onScheduled) => {
    const text = drafts.replies[email?.id] || "";
    if (!email || !text.trim()) return undefined;
    return scheduleEmail("reply", {
      to: email.reply_to || email.from_address, subject: `Re: ${email.subject || ""}`, body: text,
      threadId: email.gmail_thread_id, replyEmailId: email.id,
    }, email.id, sendAt, () => {
      if (draftSession.drafts.replies[email.id] === text) setReplyDraft(email.id, "");
    }, onScheduled);
  };

  // Gmail's "Cancel send": the cancelled email comes back as a draft. It never
  // overwrites a draft in progress; the caller says so instead.
  // Checked BEFORE the server cancel, so a cancelled email always has a
  // place to land.
  const scheduledDraftBlocked = (draft) => (draft.replyEmailId
    ? Boolean((draftSession.drafts.replies[draft.replyEmailId] || "").trim())
    : Object.values(draftSession.drafts.compose).some(Boolean));
  const restoreScheduledDraft = (draft) => {
    if (scheduledDraftBlocked(draft)) return false;
    if (draft.replyEmailId) {
      setReplyDraft(draft.replyEmailId, draft.draftText);
      return true;
    }
    setComposeForm(() => ({ to: draft.to, subject: draft.subject === "(no subject)" ? "" : draft.subject, body: draft.draftText }));
    setShowCompose(true);
    return true;
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
    handleComposeSchedule,
    handleReplySchedule,
    restoreScheduledDraft,
    scheduledDraftBlocked,
  };
}
