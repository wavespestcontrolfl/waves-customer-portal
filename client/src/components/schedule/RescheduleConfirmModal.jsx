// Confirmation modal shown when an appointment block is drag-dropped
// to a new time/date. Layout: prose summary + Client booking
// notifications + Return to editing / Reschedule appointment /
// Reschedule series (recurring only).
//
// The parent grid is responsible for optimistic UI (moving the block
// visually) — this modal only confirms and commits via onConfirm
// (called with { notificationType, scope, seriesAck?, seriesAckIds? }), or
// tells the parent to revert via onCancel.
//
// Collective series moves (GATE_ADMIN_COLLECTIVE_MOVE, owner ruling
// 2026-08-28): with the gate on, a date move of a recurring visit shifts its
// future sister visits — there is no this/series chooser. The modal renders
// ONE line from the server's series-move preview and submits the ack bound
// to that previewed set. onConfirm must REJECT with the server's 409
// `COLLECTIVE_MOVE_ACK_REQUIRED` (the plan changed since the preview, or no
// preview was shown) so the modal can re-render the refreshed line and stay
// open — every other failure stays the grid's to report and revert.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui';
import { useSlotConflicts } from './useSlotConflicts';
import SlotConflictNotice from './SlotConflictNotice';
import { useBestTimes } from './useBestTimes';
import BestTimeHint from './BestTimeHint';
import SeriesMoveNotice from './SeriesMoveNotice';
import {
  SERIES_ACK_REQUIRED,
  isCollectivePreview,
  parseSeriesAckError,
  seriesAckPayload,
  useSeriesMovePreview,
} from './seriesMove';

function formatDateLong(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTimeFromMinutes(min) {
  if (min == null || Number.isNaN(min)) return '';
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'am' : 'pm';
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

export default function RescheduleConfirmModal({
  open,
  customerName,
  fromDate,
  fromMinutes,
  toDate,
  toMinutes,
  isRecurring,
  technicianChange, // optional { fromName, toName }
  serviceId, // optional — enables the advisory slot-conflict check
  toWindow, // optional 'HH:MM-HH:MM' landing window (pending.newWindow)
  customerId, // optional — enables the advisory best-times hint
  durationMinutes, // optional — best-times hint duration (engine defaults 60)
  technicianId, // optional — scope the hint to the landing tech's route
  onConfirm,
  onCancel,
}) {
  const [notificationType, setNotificationType] = useState('none');
  const [busy, setBusy] = useState(false);
  // Server message from a refused ack — the previewed set changed under
  // the operator; the refreshed preview replaces the line.
  const [staleAck, setStaleAck] = useState('');

  // Collective-move disclosure: the server's preview of what a date move of
  // this recurring visit touches. Every recurring drag previews — including
  // a same-day time move (Day grid), where the server answers
  // `collective: false` from one row read — so the gate state is always
  // known and the gate-off chooser below never vanishes on a same-day drag.
  const seriesPreview = useSeriesMovePreview({
    serviceId,
    newDate: toDate,
    enabled: open && !!isRecurring,
  });
  const collective = isCollectivePreview(seriesPreview.preview);
  // The explicit "Reschedule series" button stays for every move the server
  // does NOT widen — gate off, or a same-day time move (the choke point only
  // widens DATE moves; GH codex P1: staff must still be able to shift the
  // time of the later visits together). It renders only once the preview
  // has answered: while the plan is still being read, or when the preview
  // request failed, offering `scope: 'series'` would move the series past
  // the disclosure the server enforces on `this_only` (hook P1).
  const seriesChooser = !!seriesPreview.preview && !collective;
  // Hold the confirm while the plan is still being read — submitting ahead
  // of the preview would only bounce off the server's ack check.
  const awaitingPreview = !!isRecurring && seriesPreview.loading && !seriesPreview.preview;

  // Advisory overlap check on the fixed drag-drop target — warn-only, the
  // confirm buttons never key off it. On a series reschedule the check only
  // covers this first occurrence (copy stays singular by design).
  const [toStart, toEnd] = String(toWindow || '').split('-');
  const { conflicts } = useSlotConflicts({
    serviceId,
    technicianId,
    durationMinutes,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(toDate || '')) ? toDate : null,
    windowStart: toStart || null,
    windowEnd: toEnd || null,
    excludeServiceIds: serviceId != null ? [serviceId] : [],
    enabled: open && !!toStart,
  });

  // Best times on the landing day — display-only by design: the landing
  // window is fixed by the drop, so the chips carry no onPick (cancel and
  // re-drop to take a suggestion). If the drop IS a best time, its chip
  // shows as selected.
  const { bestTimes } = useBestTimes({
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(toDate || '')) ? toDate : null,
    serviceId: serviceId != null ? serviceId : undefined,
    customerId,
    durationMinutes,
    technicianId,
    excludeServiceIds: serviceId != null ? [serviceId] : undefined,
    // No landing tech (unassigned-rail drops, unassigned visits) means the
    // all-tech detours would advertise a route the confirm can't take —
    // display-only chips can't adopt a technician. No tech, no hint.
    enabled: open && technicianId != null,
  });

  // The modal stays mounted between drags (open just flips), so a previous
  // reschedule's notification choice would silently carry into the next one —
  // an accidental customer SMS one click away. Reset to the no-SMS default
  // each time it opens.
  useEffect(() => {
    if (open) {
      setNotificationType('none');
      setStaleAck('');
    }
  }, [open]);

  if (!open) return null;

  const submit = async (scope) => {
    setBusy(true);
    try {
      await onConfirm({
        notificationType,
        scope,
        // The ack is bound to the previewed occurrence set; an explicit
        // "Reschedule series" needs none (scope 'series' is its own path).
        ...(scope === 'series' ? {} : seriesAckPayload(seriesPreview.preview)),
      });
    } catch (err) {
      const ack = parseSeriesAckError(err);
      if (ack?.code === SERIES_ACK_REQUIRED) {
        // Refreshed preview from the refusal — re-render, confirm again.
        seriesPreview.replace(ack.preview);
        setStaleAck(ack.message || 'The recurring plan changed — confirm again.');
        return;
      }
      // Anything else is the grid's to report (it already alerted and
      // reverted before rejecting) — never leave it unhandled here.
    } finally {
      setBusy(false);
    }
  };

  const fromText = `${formatDateLong(fromDate)} at ${formatTimeFromMinutes(fromMinutes)}`;
  const toText = `${formatDateLong(toDate)} at ${formatTimeFromMinutes(toMinutes)}`;
  const who = customerName || 'this client';

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-zinc-900/40"
        onClick={busy ? undefined : onCancel}
      />
      <div
        className="relative w-full h-full sm:h-auto max-w-none sm:max-w-2xl bg-white rounded-none sm:rounded-md shadow-xl overflow-y-auto box-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        style={{ border: '1px solid #E4E4E7', fontFamily: "'Roboto', system-ui, sans-serif" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid #E4E4E7' }}
        >
          <h2 className="text-16 font-medium tracking-tight text-zinc-900">
            Reschedule appointment
          </h2>
          <button
            onClick={busy ? undefined : onCancel}
            disabled={busy}
            className="text-zinc-500 hover:text-zinc-900 text-20 leading-none w-6 h-6 flex items-center justify-center"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-13 text-ink-primary leading-relaxed">
            Are you sure you want to reschedule your appointment with{' '}
            <strong className="font-medium">{who}</strong> from{' '}
            <strong className="font-medium">{fromText}</strong> to{' '}
            <strong className="font-medium">{toText}</strong>?
          </p>

          {technicianChange && (
            <p className="text-12 text-ink-secondary">
              Technician:{' '}
              <span className="text-ink-primary">
                {technicianChange.fromName || 'Unassigned'}
              </span>{' '}
              →{' '}
              <span className="text-ink-primary font-medium">
                {technicianChange.toName || 'Unassigned'}
              </span>
            </p>
          )}

          <div className="pt-1">
            <div className="text-13 font-medium text-ink-primary mb-2">
              Client booking notifications
            </div>
            <p className="text-12 text-ink-secondary mb-2">
              This controls the immediate reschedule text. Automated reminders will follow the new appointment time.
            </p>
            <div
              className="flex items-center gap-3 px-3 py-2 rounded-sm"
              style={{ border: '1px solid #E4E4E7' }}
            >
              <div className="text-12 font-medium text-ink-primary whitespace-nowrap">
                Notification type
              </div>
              <select
                value={notificationType}
                onChange={(e) => setNotificationType(e.target.value)}
                disabled={busy}
                className="flex-1 text-13 text-ink-primary bg-transparent outline-none"
              >
                <option value="none">Don&rsquo;t send a notification</option>
                <option value="sms">Text message</option>
              </select>
            </div>
          </div>

          <SeriesMoveNotice
            preview={seriesPreview.preview}
            loading={awaitingPreview}
            stale={staleAck}
          />
          {staleAck && !collective && (
            <p role="alert" className="text-12 text-ink-primary">
              {staleAck}
            </p>
          )}

          <SlotConflictNotice conflicts={conflicts} />
          <BestTimeHint bestTimes={bestTimes} currentStart={toStart} />
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3 flex-wrap"
          style={{ borderTop: '1px solid #E4E4E7' }}
        >
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Return to editing
          </Button>
          <Button
            variant="primary"
            onClick={() => submit('this_only')}
            disabled={busy || awaitingPreview}
          >
            {busy ? 'Saving…' : (collective ? 'Move visit + later visits' : 'Reschedule appointment')}
          </Button>
          {/* With collective moves on the server decides the scope of a DATE
              move — no this/series chooser there; the explicit series button
              stays for moves the server doesn't widen (never on a failed or
              pending preview). */}
          {isRecurring && seriesChooser && (
            <Button
              variant="secondary"
              onClick={() => submit('series')}
              disabled={busy}
            >
              Reschedule series
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
