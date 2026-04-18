// Confirmation modal shown when an appointment block is drag-dropped
// to a new time/date. Mirrors Square Appointments' reschedule prompt:
// summary line + customer-notification dropdown + Cancel / Reschedule.
//
// The parent grid is responsible for optimistic UI (moving the block
// visually) — this modal only confirms and commits via onConfirm, or
// tells the parent to revert via onCancel.
import { useState } from 'react';
import { Button } from '../ui';

export default function RescheduleConfirmModal({
  open,
  customerName,
  fromLabel,
  toLabel,
  technicianChange, // optional { fromName, toName }
  onConfirm,
  onCancel,
}) {
  const [notificationType, setNotificationType] = useState('none');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm({ notificationType });
    } finally {
      setBusy(false);
    }
  };

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
        className="relative w-full max-w-lg bg-white rounded-md shadow-xl"
        style={{ border: '1px solid #E4E4E7' }}
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
            Reschedule{' '}
            {customerName ? (
              <strong className="font-medium">{customerName}</strong>
            ) : (
              'this appointment'
            )}{' '}
            from <strong className="font-medium">{fromLabel}</strong> to{' '}
            <strong className="font-medium">{toLabel}</strong>?
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

          <div>
            <div className="u-label text-ink-secondary mb-1.5">
              Customer notification
            </div>
            <select
              value={notificationType}
              onChange={(e) => setNotificationType(e.target.value)}
              disabled={busy}
              className="w-full text-13 px-3 h-9 rounded-sm bg-white text-ink-primary u-focus-ring"
              style={{ border: '1px solid #E4E4E7' }}
            >
              <option value="none">Don&rsquo;t send a notification</option>
              <option value="sms">Ask customer to confirm via SMS</option>
            </select>
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: '1px solid #E4E4E7' }}
        >
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleConfirm} disabled={busy}>
            {busy ? 'Saving…' : 'Reschedule'}
          </Button>
        </div>
      </div>
    </div>
  );
}
