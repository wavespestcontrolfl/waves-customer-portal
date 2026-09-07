import { D } from "./emailStyles";
import EmailQuickLinks from "../../../components/admin/EmailQuickLinks";
import { appendStaticLinkClause } from "../../../lib/composerLinks";
import EmailSendOutcome from "./EmailSendOutcome";

export default function EmailReply({ active, sender, mailbox, editor }) {
  const { selectedEmail } = mailbox;
  const { drafts, setReplyDraft, sending, drafting, draftResult } = editor;
  const replyText = drafts.replies[selectedEmail.id] || "";
  const attemptKey = `reply:${selectedEmail.id}`;
  const replyDisabled = sending || Boolean(editor.sendAttempts[attemptKey]) || !replyText.trim();
  return (
    <div
      style={{
        background: D.card,
        borderRadius: 8,
        padding: 16,
        border: `1px solid ${D.border}`,
      }}
    >
      {" "}
      <div
        style={{
          fontSize: 12,
          color: D.muted,
          marginBottom: 8,
        }}
      >
        Reply to {sender}
      </div>{" "}
      <textarea
        value={replyText}
        aria-label="Reply"
        onChange={(e) => setReplyDraft(selectedEmail.id, e.target.value)}
        placeholder="Type your reply..."
        rows={4}
        style={{
          width: "100%",
          padding: 12,
          background: D.bg,
          border: `1px solid ${D.border}`,
          borderRadius: 6,
          color: D.text,
          fontSize: 13,
          resize: "vertical",
          outline: "none",
          fontFamily: "'Roboto', Arial, sans-serif",
          boxSizing: "border-box",
        }}
      />
      {!sending && <EmailSendOutcome attempt={editor.sendAttempts[attemptKey]} onResolve={outcome => editor.reconcileSend(attemptKey, outcome)} />}
      {draftResult && (
        <div
          style={{
            fontSize: 11,
            color: D.green,
            marginTop: 4,
            marginBottom: 4,
          }}
        >
          {"\u2713"} AI draft loaded — review and edit before sending
        </div>
      )}
      {replyText && (
        <button
          type="button"
          onClick={() => setReplyDraft(selectedEmail.id, "")}
          disabled={sending}
          style={{
            fontSize: 14,
            color: D.muted,
            marginBottom: 8,
            padding: "8px 12px",
            border: `1px solid ${D.border}`,
            borderRadius: 6,
            background: "transparent",
            cursor: "pointer",
          }}
        >
          Discard reply
        </button>
      )}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 8,
          justifyContent: "flex-end",
        }}
      >
        {" "}
        <EmailQuickLinks key={selectedEmail.id} active={active} recipient={selectedEmail.from_address}
          disabled={sending} onInsert={(link) => setReplyDraft(selectedEmail.id, appendStaticLinkClause(replyText, link))} />
        <button
          onClick={() =>
            editor.handleAiDraft(selectedEmail, mailbox.isSelected)
          }
          disabled={drafting}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            background: D.purple + "22",
            border: `1px solid ${D.purple}44`,
            color: D.purple,
            opacity: drafting ? 0.5 : 1,
          }}
        >
          {drafting ? "Drafting..." : "\u2728 AI Draft"}
        </button>{" "}
        <button
          onClick={() => editor.handleReply(selectedEmail, mailbox.loadThread)}
          disabled={replyDisabled}
          style={{
            padding: "8px 20px",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            border: "none",
            cursor: "pointer",
            background: D.teal,
            color: "#fff",
            opacity: replyDisabled ? 0.5 : 1,
          }}
        >
          {sending ? "Sending..." : "Send Reply"}
        </button>{" "}
      </div>{" "}
    </div>
  );
}
