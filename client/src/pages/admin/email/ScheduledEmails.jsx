import { useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { ActionFeedback } from "../../../components/ui/ActionFeedback";
import { formatSendAt } from "./scheduleSend";

const STATUS_TEXT = {
  sending: "Sending now",
  cancelled: "Cancelled",
  failed: "Not sent: Gmail refused it",
  outcome_unknown: "May have gone out: check the Gmail Sent folder first",
};

// Email > Scheduled, as in Gmail: what is queued and when, with Cancel send.
// A row Gmail refused or may have sent shows Back to draft. Cancel and Back
// to draft hand the text to the composer once; a cancelled row then stays
// listed a while, read-only, with Show text (a cancel whose answer was lost
// still shows its text, but never opens it as a second draft).
export default function ScheduledEmails({ scheduled, editor, mailbox }) {
  const [feedback, setFeedback] = useState(null);
  const [shownId, setShownId] = useState(null);
  const takeBack = async (row) => {
    setFeedback(null);
    if (editor.scheduledDraftBlocked(row)) {
      setFeedback({ error: true, message: row.replyEmailId
        ? "That conversation already has a reply draft. Send or discard it first, then try again."
        : "You have a new email in progress. Send or discard it first, then try again." });
      return;
    }
    const { draft, error } = await scheduled.cancel(row.id);
    if (!draft) { setFeedback({ error: true, message: error }); return; }
    const restored = editor.restoreScheduledDraft(draft);
    if (!restored?.opened) {
      setShownId(draft.id);
      setFeedback({ error: true, message: restored === false
        ? "Cancelled, but another draft is open, so its text is shown below. Copy it from there."
        : "Cancelled, but this browser could not save its safety check, so its text is shown below. Check the Gmail Sent folder before you use it." });
      return;
    }
    if (draft.replyEmailId) mailbox.showEmailById(draft.replyEmailId);
    setFeedback({ error: !restored.saved, message: restored.saved
      ? (draft.replyEmailId ? "Cancelled. The reply is back in its conversation as a draft." : "Cancelled. The email is open as a draft.")
      : "Cancelled and open as a draft, but this browser could not save it: if you reload, find its text under Scheduled (Show text)." });
  };

  return <section aria-label="Scheduled emails" className="space-y-4">
    {feedback && <ActionFeedback error={feedback.error}>{feedback.message}</ActionFeedback>}
    <div className="overflow-hidden rounded-md border-hairline border-zinc-200 bg-white">
      {scheduled.loading && scheduled.emails.length === 0 ? <p className="m-0 min-h-40 p-6 text-ink-secondary" role="status">Loading scheduled emails…</p>
        : scheduled.error ? <ActionFeedback error onRetry={scheduled.reload} className="min-h-40 p-6">Scheduled emails are unavailable.</ActionFeedback>
        : scheduled.emails.length === 0 ? <div className="p-8 text-center text-ink-secondary">
          <Clock size={24} className="mx-auto mb-3" aria-hidden />
          <p className="m-0">No scheduled emails. Use the arrow next to Send to schedule one.</p>
        </div>
        : <ul className="m-0 list-none p-0">{scheduled.emails.map((row) => <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 border-b-hairline border-zinc-200 p-4 last:border-b-0">
          <div className="min-w-0 flex-1 break-words">
            <p className="m-0 font-medium">To: {row.to}</p>
            <p className="m-0 mt-1">{row.subject || "(no subject)"}</p>
            <p className="m-0 mt-1 truncate text-ink-secondary">{String(row.draftText || "").split("\n")[0]}</p>
            <p className={["failed", "outcome_unknown"].includes(row.status) ? "m-0 mt-1 text-alert-fg" : "u-nums m-0 mt-1 text-ink-secondary"}>
              {row.status === "scheduled" ? `Sends ${formatSendAt(row.sendAt)}` : STATUS_TEXT[row.status] || row.status}
            </p>
          </div>
          {row.status === "cancelled"
            ? <Button variant="secondary" className="shrink-0" onClick={() => setShownId(shownId === row.id ? null : row.id)}>{shownId === row.id ? "Hide text" : "Show text"}</Button>
            : row.status !== "sending" && <Button variant="secondary" className="shrink-0" onClick={() => takeBack(row)}
              disabled={Boolean(scheduled.pendingId)} loading={scheduled.pendingId === row.id}>
              {row.status === "scheduled" ? "Cancel send" : "Back to draft"}
            </Button>}
          {shownId === row.id && <pre className="m-0 w-full whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-ui-body" aria-label="Email text">{row.draftText}</pre>}
        </li>)}</ul>}
    </div>
  </section>;
}
