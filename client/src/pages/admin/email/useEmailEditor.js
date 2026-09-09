import { useCallback, useEffect, useState } from "react";
import {
  loadEmailDrafts,
  setEmailSending,
  subscribeEmailDrafts,
  updateEmailDrafts,
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
  });
  const [editor, setEditor] = useState(snapshot);
  useEffect(
    () => subscribeEmailDrafts(draftSession, () => setEditor(snapshot())),
    [draftSession],
  );
  const { drafts, saved, sending } = editor;
  const composeForm = drafts.compose;
  const [showCompose, setShowCompose] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState(null);
  const clearDraftResult = useCallback(() => setDraftResult(null), []);
  const changeDrafts = (update) => updateEmailDrafts(draftSession, update);
  const setReplyDraft = (id, text) =>
    changeDrafts((current) => ({
      ...current,
      replies: { ...current.replies, [id]: text },
    }));
  const setComposeForm = (update) =>
    changeDrafts((current) => ({
      ...current,
      compose: update(current.compose),
    }));
  const hasComposeDraft = Object.values(composeForm).some(Boolean);
  const hasDrafts =
    hasComposeDraft || Object.values(drafts.replies).some(Boolean);
  const storageError = !saved;
  const recoveryNotice = storageError
    ? "Draft recovery is unavailable. Your text stays while navigating here; copy it before reloading or closing this tab."
    : "Drafts are saved in this browser tab until you send, discard, or sign out.";

  const sendEmail = async (kind, payload, onSuccess) => {
    if (!setEmailSending(draftSession, kind, true)) return;
    try {
      const response = await adminFetch("/api/admin/email/send", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          body: encodeEmailBody(payload.body),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await onSuccess();
    } catch (error) {
      window.alert(SEND_ERRORS[kind] + error.message);
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
    if (!email) return;
    const replyRevision = draftSession.replyRevisions[email.id] || 0;
    setDrafting(true);
    setDraftResult(null);
    try {
      const r = await adminFetch(
        `/api/admin/email/message/${email.id}/ai-draft`,
        { method: "POST" },
      );
      const d = await r.json();
      if (
        d.reply_draft &&
        (draftSession.replyRevisions[email.id] || 0) === replyRevision
      ) {
        setReplyDraft(email.id, d.reply_draft);
        if (isSelected(email.id)) setDraftResult(d);
      }
    } catch {
      /* ignore */
    }
    setDrafting(false);
  };

  return {
    drafts,
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
