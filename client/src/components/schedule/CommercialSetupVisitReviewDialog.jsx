import React from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, buttonStyles } from '../ui';

export const COMMERCIAL_SETUP_VISIT_REVIEW = 'COMMERCIAL_SETUP_VISIT_REVIEW';
export const COMMERCIAL_SETUP_BOOKING_CHANGED_NOTICE = 'The appointment changed. Review the updated booking and save again.';

const cents = (value) => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
};

const money = (value) => `$${(value / 100).toFixed(2)}`;

export function commercialSetupReviewFromError(error) {
  const code = error?.code || error?.body?.code;
  const raw = error?.setupFeeReview || error?.body?.setupFeeReview;
  const prepaidAmountCents = cents(raw?.prepaidAmountCents);
  const visitFeeCents = cents(raw?.visitFeeCents);
  if (error?.status !== 409 || code !== COMMERCIAL_SETUP_VISIT_REVIEW
    || !raw?.invoiceId || !raw?.visitKey || prepaidAmountCents == null || visitFeeCents == null) return null;
  return {
    invoiceId: String(raw.invoiceId),
    visitKey: String(raw.visitKey),
    prepaidAmountCents,
    visitFeeCents,
  };
}

export function commercialSetupDecision(review, resolution) {
  if (!review || !['covered', 'separate'].includes(resolution)) return null;
  return {
    ...review,
    resolution,
  };
}

// Compare the payloads exactly as fetch will see them. JSON.stringify drops
// undefined object fields, which is important here: those fields are not part
// of the reviewed request and therefore must not make an otherwise identical
// retry look changed.
export function commercialSetupPayloadUnchanged(reviewedPayload, currentPayload) {
  return JSON.stringify(reviewedPayload) === JSON.stringify(currentPayload);
}

export default function CommercialSetupVisitReviewDialog({
  review,
  changed = false,
  busy = false,
  bookedGroups = [],
  remainingGroups = [],
  onResolve,
  onCancel,
}) {
  if (!review) return null;
  const prepaidAmount = money(review.prepaidAmountCents);
  const visitFee = money(review.visitFeeCents);
  const partialSave = bookedGroups.length > 0;
  const remainingNoun = remainingGroups.length === 1 ? 'booking' : 'bookings';
  return (
    <Dialog open onClose={busy ? undefined : onCancel} size="sm" layer={1400}>
      <DialogHeader>
        <DialogTitle>Choose how to handle this setup fee</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3 text-14 text-zinc-900">
        {changed && (
          <p role="alert" className="border border-warn-fg bg-warn-bg p-3 text-warn-fg">
            The source invoice or setup amount changed. Review these updated amounts and choose again.
          </p>
        )}
        {partialSave && (
          <div role="alert" className="border border-warn-fg bg-warn-bg p-3 text-warn-fg">
            <p><strong>These appointments are already booked:</strong> {bookedGroups.join(', ')}.</p>
            <p className="mt-2">
              <strong>Remaining {remainingNoun}:</strong>{' '}
              {remainingGroups.length ? remainingGroups.join(', ') : `the remaining ${remainingNoun}`}.
              Stopping here leaves the remaining {remainingNoun} unsaved.
            </p>
          </div>
        )}
        <p>
          The source invoice already carries a <strong>{prepaidAmount}</strong> commercial rodent setup. This booking's independent setup is <strong>{visitFee}</strong>.
        </p>
        <p className="text-zinc-600">
          Confirm whether that prepayment belongs to this booking. Choosing a separate setup keeps the source invoice available for the visit it belongs to.
        </p>
        <a
          className={buttonStyles({ variant: 'secondary', className: 'w-full' })}
          href={`/admin/invoices?invoice=${encodeURIComponent(review.invoiceId)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open source invoice
        </a>
      </DialogBody>
      <DialogFooter className="flex-col sm:flex-row">
        <Button variant="ghost" className="w-full sm:w-auto" onClick={onCancel} disabled={busy}>
          {partialSave ? `Stop — leave remaining ${remainingNoun} unsaved` : 'Cancel without saving'}
        </Button>
        <Button variant="secondary" className="w-full sm:w-auto" onClick={() => onResolve('separate')} disabled={busy}>
          Bill this booking's {visitFee} setup separately
        </Button>
        <Button className="w-full sm:w-auto" onClick={() => onResolve('covered')} loading={busy}>
          Apply {prepaidAmount} prepayment to this booking
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
