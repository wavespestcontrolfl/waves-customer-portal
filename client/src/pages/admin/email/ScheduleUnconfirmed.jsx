import { ActionFeedback } from "../../../components/ui/ActionFeedback";
import { Button } from "../../../components/ui/Button";

// Shown while a schedule request for this draft has no definite answer
// (lost, or still running after the page was left). Plain Send waits: it
// could deliver a copy now while the queued one still sends later. A sent
// email leaves the Scheduled list, so the check names the Sent folder too.
const NOTICE = {
  may_have_sent: "Gmail may already have sent this email. Look in the Gmail Sent folder and under Scheduled.",
  taken_over: "This email may still be open as a draft in another tab or window. Close or discard it there before you send this one.",
  restore_unconfirmed: "The Scheduled list may still offer this email. If it shows Open as draft for it, do not open it again before you send this one.",
  unconfirmed: "A schedule request for this email was not confirmed. Look under Scheduled and in the Gmail Sent folder.",
};

export default function ScheduleUnconfirmed({ editor, replyId = null, className }) {
  if (!editor.scheduleUnconfirmed(replyId) || editor.scheduling) return null;
  return <ActionFeedback error className={className}>
    {NOTICE[editor.guardKind(replyId)] || NOTICE.unconfirmed}
    <Button variant="secondary" className="ml-2" onClick={() => editor.confirmScheduleChecked(replyId)}>
      {["taken_over", "restore_unconfirmed"].includes(editor.guardKind(replyId)) ? "I checked: no other copy" : "I checked: it is in neither"}
    </Button>
  </ActionFeedback>;
}
