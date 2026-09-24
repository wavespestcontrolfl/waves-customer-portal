import { Send, Sparkles } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Field } from "../../../components/ui/Field";
import { Textarea } from "../../../components/ui/Textarea";
import { ActionFeedback } from "../../../components/ui/ActionFeedback";
import EmailQuickLinks from "../../../components/admin/EmailQuickLinks";
import { appendStaticLinkClause } from "../../../lib/composerLinks";
import EmailSendOutcome from "./EmailSendOutcome";

export default function EmailReply({ active, sender, mailbox, editor }) {
  const { selectedEmail } = mailbox;
  const { drafts, setReplyDraft, sending, drafting, draftResult } = editor;
  const replyText = drafts.replies[selectedEmail.id] || "";
  const attemptKey = `reply:${selectedEmail.id}`;
  const attempt = editor.sendAttempts[attemptKey];
  // ADMIN-BUG-R22: relayed mail (contact forms, lead marketplaces, ticketing)
  // has a no-reply From with the real recipient in Reply-To — the reply must
  // target and display that address, not the relay's From.
  const effectiveRecipient = selectedEmail.reply_to || selectedEmail.from_address;
  const replyLabel = effectiveRecipient !== selectedEmail.from_address
    ? `Reply to ${effectiveRecipient} (via ${sender})`
    : `Reply to ${sender}`;
  return <section aria-label="Email reply" className="rounded-md border-hairline border-zinc-200 bg-white p-4">
    <Field label={replyLabel}>
      <Textarea value={replyText} aria-label="Reply" onChange={(event) => setReplyDraft(selectedEmail.id, event.target.value)} placeholder="Type your reply..." rows={4} />
    </Field>
    {!sending && <EmailSendOutcome attempt={attempt} onResolve={outcome => editor.reconcileSend(attemptKey, outcome)} />}
    {editor.sendFeedback.reply?.messageId === selectedEmail.id && <ActionFeedback error={editor.sendFeedback.reply.error} className="mt-2">{editor.sendFeedback.reply.message}</ActionFeedback>}
    {draftResult && <ActionFeedback className="mt-2">AI draft loaded — review and edit before sending</ActionFeedback>}
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      {replyText && <Button variant="ghost" onClick={() => setReplyDraft(selectedEmail.id, "")} disabled={sending} className="mr-auto">Discard reply</Button>}
      <EmailQuickLinks key={selectedEmail.id} active={active} recipient={effectiveRecipient} disabled={sending}
        onInsert={(link) => setReplyDraft(selectedEmail.id, appendStaticLinkClause(replyText, link))} />
      <Button variant="secondary" onClick={() => editor.handleAiDraft(selectedEmail, mailbox.isSelected)} loading={drafting} disabled={sending} className="gap-2">
        <Sparkles size={16} aria-hidden />AI draft
      </Button>
      <Button onClick={() => editor.handleReply(selectedEmail, mailbox.loadThread)} loading={sending} disabled={Boolean(attempt) || !replyText.trim()} className="gap-2">
        <Send size={16} aria-hidden />Send reply
      </Button>
    </div>
  </section>;
}
