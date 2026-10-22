import { ActionFeedback } from "../../../components/ui/ActionFeedback";
import { Button } from "../../../components/ui/Button";

// Shown while a schedule request for this draft has no definite answer
// (lost, or still running after the page was left). Plain Send waits: it
// could deliver a copy now while the queued one still sends later.
export default function ScheduleUnconfirmed({ editor, replyId = null, className }) {
  if (!editor.scheduleUnconfirmed(replyId) || editor.scheduling) return null;
  return <ActionFeedback error className={className}>
    A schedule request for this email was not confirmed. Look under Scheduled first.
    <Button variant="secondary" className="ml-2" onClick={() => editor.confirmScheduleChecked(replyId)}>I checked: it is not there</Button>
  </ActionFeedback>;
}
