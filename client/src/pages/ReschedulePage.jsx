/**
 * /reschedule/:token — the reschedule flow of the shared ScheduleFlowPage
 * (owner 2026-09-04: reschedule + re-service merged into one page). The
 * route entry, the test file and every inbound link keep this module name;
 * everything the page does lives in ScheduleFlowPage.jsx.
 */
import ScheduleFlowPage from './ScheduleFlowPage';

export default function ReschedulePage() {
  return <ScheduleFlowPage flow="reschedule" />;
}
