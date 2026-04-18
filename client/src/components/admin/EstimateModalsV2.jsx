// client/src/components/admin/EstimateModalsV2.jsx
// Monochrome V2 of FollowUpModal + DeclineModal. Strict 1:1 with V1 on:
//   - FollowUp: POST /admin/estimates/:id/follow-up { message }
//   - Decline:  PATCH /admin/estimates/:id       { status, declineReason }
//   - Default SMS copy (first name + first address segment)
//   - DECLINE_REASONS list (imported from EstimatePage.jsx)
// Reskinned with Dialog primitive, zinc ramp, alert-fg on destructive confirm.
import React, { useState } from 'react';
import {
  Button,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Textarea,
  cn,
} from '../ui';
import { DECLINE_REASONS } from '../../pages/admin/EstimatePage';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

export function FollowUpModalV2({ estimate, onClose, onSent }) {
  const firstName = estimate.customerName?.split(' ')[0] || 'there';
  const addrShort = estimate.address?.split(',')[0] || 'your property';
  const [message, setMessage] = useState(
    `Hi ${firstName}, just checking in on the estimate I sent for ${addrShort}. Any questions? — Adam, Waves`,
  );
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}/follow-up`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      onSent();
    } catch (err) {
      alert('Follow-up failed: ' + err.message);
    }
    setSending(false);
  };

  return (
    <Dialog open onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>Follow Up — {estimate.customerName}</DialogTitle>
        <div className="text-12 text-ink-secondary mt-0.5">
          {estimate.address || '—'}
        </div>
      </DialogHeader>
      <DialogBody>
        <label className="block text-11 font-medium text-ink-secondary uppercase tracking-label mb-1.5">
          SMS Message
        </label>
        <Textarea
          value={message}
          onChange={(ev) => setMessage(ev.target.value)}
          rows={4}
          className="min-h-[96px]"
        />
        <div className="text-11 text-ink-tertiary mt-1.5">
          Delivered via Twilio · replies route to the shared inbox
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSend}
          disabled={sending || !message.trim()}
        >
          {sending ? 'Sending…' : 'Send Follow-Up SMS'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function DeclineModalV2({ estimate, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!reason) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'declined', declineReason: reason }),
      });
      onSaved();
    } catch (err) {
      alert('Failed: ' + err.message);
    }
    setSaving(false);
  };

  return (
    <Dialog open onClose={onClose} size="sm">
      <DialogHeader>
        <DialogTitle>Mark as Lost</DialogTitle>
        <div className="text-12 text-ink-secondary mt-0.5">
          {estimate.customerName}
          {estimate.address ? ` — ${estimate.address.split(',')[0]}` : ''}
        </div>
      </DialogHeader>
      <DialogBody>
        <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-2">
          Reason
        </div>
        <div className="flex flex-col gap-1.5">
          {DECLINE_REASONS.map((r) => {
            const selected = reason === r;
            return (
              <label
                key={r}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-xs cursor-pointer',
                  'text-13 border-hairline transition-colors',
                  selected
                    ? 'bg-zinc-50 border-zinc-900 text-zinc-900'
                    : 'bg-white border-zinc-300 text-ink-secondary hover:bg-zinc-50',
                )}
              >
                <input
                  type="radio"
                  name="declineReason"
                  checked={selected}
                  onChange={() => setReason(r)}
                  className="sr-only"
                />
                <span
                  className={cn(
                    'inline-block h-3.5 w-3.5 rounded-full border-hairline flex-shrink-0',
                    selected ? 'bg-zinc-900 border-zinc-900 ring-2 ring-white ring-inset' : 'border-zinc-400',
                  )}
                  aria-hidden
                />
                {r}
              </label>
            );
          })}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={handleSave}
          disabled={saving || !reason}
        >
          {saving ? 'Saving…' : 'Mark as Lost'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
