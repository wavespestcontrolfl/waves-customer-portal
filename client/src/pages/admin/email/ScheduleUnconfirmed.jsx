import { ActionFeedback } from "../../../components/ui/ActionFeedback";
import { Button } from "../../../components/ui/Button";

// Shown while a schedule request for this draft has no definite answer
// (lost, or still running after the page was left). Plain Send waits: it
// could deliver a copy now while the queued one still sends later. A sent
// email leaves the Scheduled list, so the check names the Sent folder too.
const NOTICE = {
  may_have_sent: "Gmail may already have sent this email. Look in the Gmail Sent folder and under Scheduled.",
  unconfirmed: "A schedule request for this email was not confirmed. Look under Scheduled and in the Gmail Sent folder.",
};

export default function ScheduleUnconfirmed({ editor, replyId = null, className }) {
  if (!editor.scheduleUnconfirmed(replyId) || editor.scheduling) return null;
  return <ActionFeedback error className={className}>
    {NOTICE[editor.guardKind(replyId)] || NOTICE.unconfirmed}
    <Button variant="secondary" className="ml-2" onClick={() => editor.confirmScheduleChecked(replyId)}>
      I checked: it is in neither
    </Button>
  </ActionFeedback>;
}
