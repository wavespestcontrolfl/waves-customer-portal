import { useCallback, useEffect, useState } from "react";
import {
  loadEmailDrafts,
  setEmailSending,
  subscribeEmailDrafts,
  updateEmailDrafts,
  updateEmailSendAttempt,
} from "../../../lib/emailDrafts";
import { adminFetch } from "./emailApi";

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
        to: email.from_address,
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
  };
}
