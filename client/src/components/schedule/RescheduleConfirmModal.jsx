// Confirmation modal shown when an appointment block is drag-dropped
// to a new time/date. Layout: prose summary + Client booking
// notifications + Return to editing / Reschedule appointment /
// Reschedule series (recurring only).
//
// The parent grid is responsible for optimistic UI (moving the block
// visually) — this modal only confirms and commits via onConfirm
// (called with { notificationType, scope }), or tells the parent to
// revert via onCancel.
import { useEffect, useState } from 'react';
import { Button } from '../ui';
import { useSlotConflicts } from './useSlotConflicts';
import SlotConflictNotice from './SlotConflictNotice';
import { useBestTimes } from './useBestTimes';
import BestTimeHint from './BestTimeHint';

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
  onConfirm,
  onCancel,
}) {
  const [notificationType, setNotificationType] = useState('none');
  const [busy, setBusy] = useState(false);

  // Advisory overlap check on the fixed drag-drop target — warn-only, the
  // confirm buttons never key off it. On a series reschedule the check only
  // covers this first occurrence (copy stays singular by design).
  const [toStart, toEnd] = String(toWindow || '').split('-');
  const { conflicts } = useSlotConflicts({
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
    customerId,
    durationMinutes,
    excludeServiceIds: serviceId != null ? [serviceId] : undefined,
    enabled: open,
  });

  // The modal stays mounted between drags (open just flips), so a previous
  // reschedule's notification choice would silently carry into the next one —
  // an accidental customer SMS one click away. Reset to the no-SMS default
  // each time it opens.
  useEffect(() => {
    if (open) setNotificationType('none');
  }, [open]);

  if (!open) return null;

  const submit = async (scope) => {
    setBusy(true);
    try {
      await onConfirm({ notificationType, scope });
    } finally {
      setBusy(false);
    }
  };

  const fromText = `${formatDateLong(fromDate)} at ${formatTimeFromMinutes(fromMinutes)}`;
  const toText = `${formatDateLong(toDate)} at ${formatTimeFromMinutes(toMinutes)}`;
  const who = customerName || 'this client';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-zinc-900/40"
        onClick={busy ? undefined : onCancel}
      />
      <div
        className="relative w-full max-w-2xl bg-white rounded-md shadow-xl"
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
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Reschedule appointment'}
          </Button>
          {isRecurring && (
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
    </div>
  );
}
