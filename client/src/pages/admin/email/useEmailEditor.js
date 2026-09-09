import { useCallback, useEffect, useState } from "react";
import {
  loadEmailDrafts,
  setEmailSending,
  subscribeEmailDrafts,
  updateEmailDrafts,
} from "../../../lib/emailDrafts";
import { adminFetch } from "./emailApi";

const SEND_ERRORS = {
  reply: "Reply send was not confirmed. Your draft is still here.",
  compose: "Email send was not confirmed. Your draft is still here.",
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
  });
  const [editor, setEditor] = useState(snapshot);
  useEffect(
    () => subscribeEmailDrafts(draftSession, () => setEditor(snapshot())),
    [draftSession],
  );
  const { drafts, saved, sending } = editor;
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
  const setReplyDraft = (id, text) =>
    changeDrafts((current) => ({
      ...current,
      replies: { ...current.replies, [id]: text },
    }));
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

  const sendEmail = async (kind, payload, onSuccess, messageId) => {
    if (!setEmailSending(draftSession, kind, true)) return;
    setSendFeedback((current) => ({ ...current, [kind]: null }));
    try {
      const response = await adminFetch("/api/admin/email/send", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          body: encodeEmailBody(payload.body),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!result.success) throw new Error("Send not confirmed");
      await onSuccess();
      setSendFeedback((current) => ({ ...current, [kind]: { messageId, message: kind === "reply" ? "Reply sent." : "Email sent." } }));
    } catch {
      setSendFeedback((current) => ({ ...current, [kind]: { messageId, error: true, message: SEND_ERRORS[kind] } }));
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
      async () => {
        changeDrafts((current) => ({
          ...current,
          replies: {
            ...current.replies,
            [email.id]:
              (draftSession.replyRevisions[email.id] || 0) === revision
                ? ""
                : current.replies[email.id],
          },
        }));
        await onSent(email);
      },
      email.id,
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
      () => {
        // Only clear the submitted snapshot; edits can outlive this component.
        if (draftSession.drafts.compose === composeForm) {
          setComposeForm(() => ({ to: "", subject: "", body: "" }));
          setShowCompose(false);
        }
        onSent();
      },
    );
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
    handleReply,
    handleComposeSend,
    handleAiDraft,
  };
}
