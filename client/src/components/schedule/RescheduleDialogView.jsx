import {
  ActionFeedback,
  Button,
  Card,
  CardBody,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  UiSurface,
} from "../ui";
import BestTimeHint from "./BestTimeHint";
import SlotConflictNotice from "./SlotConflictNotice";
import { seriesMoveSummary } from "./seriesMove";

export default function RescheduleDialogView({
  service,
  reason,
  setReason,
  notes,
  setNotes,
  notificationType,
  setNotificationType,
  sending,
  seriesConfirm,
  seriesConfirmDate,
  confirmSeriesMove,
  clearSeriesConfirm,
  reasons,
  loading,
  options,
  windowFor,
  handleReschedule,
  showManual,
  setShowManual,
  manualDate,
  setManualDate,
  manualTime,
  setManualTime,
  durationMinutes,
  handleManualReschedule,
  manualConflicts,
  manualBestTimes,
  manualPicked,
  manualBestInRange,
  onClose,
}) {
  return (
    <UiSurface density="comfortable">
      <Dialog open onClose={onClose} layer={1000} aria-label="Reschedule service">
        <DialogHeader><DialogTitle>Reschedule service</DialogTitle></DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-ui-body text-ink-secondary">{service.customerName} — {service.serviceType}</p>
          <Field label="Reason">
            <Select value={reason} onChange={(event) => setReason(event.target.value)}>
              {reasons.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </Select>
          </Field>
          <Field label="Notes (optional)">
            <Input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Additional context..." />
          </Field>
          <Field label="Client booking notifications" help="This controls the immediate reschedule text. Automated reminders will follow the new appointment time.">
            <Select value={notificationType} onChange={(event) => setNotificationType(event.target.value)} disabled={sending}>
              <option value="none">Don&rsquo;t send a notification</option>
              <option value="sms">Text message</option>
            </Select>
          </Field>
          {seriesConfirm && (
            <Card data-testid="series-move-confirm"><CardBody>
              <h3 className="text-ui-body font-medium mb-2">Move to {seriesConfirmDate || seriesConfirm.body.newDate}?</h3>
              <div
                role="status"
                data-testid="series-move-notice"
                className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2"
              >
                {seriesConfirm.stale ? (
                  <p className="mb-1 text-ui-body font-medium text-ink-primary">
                    The recurring plan changed since you looked — review the updated line and confirm again.
                  </p>
                ) : null}
                <p className="text-ui-body leading-relaxed text-ink-primary">
                  <strong className="font-medium">Recurring plan:</strong>{" "}
                  {seriesMoveSummary(seriesConfirm.preview)}
                </p>
              </div>
              <div className="ui-record-actions mt-3">
                <Button onClick={confirmSeriesMove} disabled={sending}>{sending ? "Moving…" : "Move visit + later visits"}</Button>
                <Button variant="secondary" onClick={clearSeriesConfirm} disabled={sending}>Back</Button>
              </div>
            </CardBody></Card>
          )}
          <h3 className="text-18 font-medium">Suggested dates (on route)</h3>
          {loading ? <ActionFeedback>Finding best dates...</ActionFeedback> : (
            <div className="space-y-2">
              {options.map((option, index) => (
                <Card key={index}><CardBody className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-ui-body font-medium">{option.displayDate}</div>
                    <div className="text-ui-body text-ink-secondary">
                      {windowFor(option.suggestedWindow?.start)?.display || option.suggestedWindow?.display}{" "}
                      · {option.currentLoad} jobs · {option.sameAreaServices} same area
                    </div>
                  </div>
                  <Button onClick={() => handleReschedule(option)} disabled={sending}>Select</Button>
                </CardBody></Card>
              ))}
            </div>
          )}
          <div className="border-t border-hairline border-zinc-200 pt-3">
            <Button variant="ghost" onClick={() => setShowManual(!showManual)} aria-expanded={showManual}>
              {showManual ? "\u25BC" : "\u25B6"} Pick Custom Date &amp; Time
            </Button>
            {showManual && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <Field label="Date"><Input type="date" value={manualDate} onChange={(event) => setManualDate(event.target.value)} /></Field>
                <Field label="Start Time">
                  <Select value={manualTime} onChange={(event) => setManualTime(event.target.value)}>
                    {Array.from({ length: 14 }, (_, index) => index + 6)
                      .filter((hour) => hour * 60 + durationMinutes <= 20 * 60)
                      .map((hour) => {
                        const value = `${String(hour).padStart(2, "0")}:00`;
                        const label = `${hour % 12 || 12}:00 ${hour >= 12 ? "PM" : "AM"}`;
                        return <option key={value} value={value}>{label}</option>;
                      })}
                  </Select>
                </Field>
                <Button className="sm:col-span-2" onClick={handleManualReschedule} disabled={sending || !manualDate}>Reschedule</Button>
              </div>
            )}
            {showManual && <SlotConflictNotice conflicts={manualConflicts} style={{ marginTop: 10 }} />}
            {showManual && (
              <BestTimeHint
                bestTimes={manualBestTimes}
                picked={manualPicked}
                bestInRange={manualBestInRange}
                currentStart={manualTime}
                currentDate={manualDate}
                currentTechnicianId={service.technicianId || service.technician_id}
                onPick={(slot) => setManualTime(slot.start)}
                onPickDate={(slot) => { setManualDate(slot.date); setManualTime(slot.start); }}
                style={{ marginTop: 10 }}
              />
            )}
          </div>
        </DialogBody>
        <DialogFooter><Button variant="secondary" onClick={onClose}>Cancel</Button></DialogFooter>
      </Dialog>
    </UiSurface>
  );
}
