import React from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, buttonStyles } from '../ui';

export const COMMERCIAL_SETUP_VISIT_REVIEW = 'COMMERCIAL_SETUP_VISIT_REVIEW';
export const COMMERCIAL_SETUP_BOOKING_CHANGED_NOTICE = 'The appointment changed. Review the updated booking and save again.';

const cents = (value) => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
};

const money = (value) => `$${(value / 100).toFixed(2)}`;

const addressText = (value) => {
  if (!value) return '';
  const nested = value.address && typeof value.address === 'object' ? value.address : {};
  const directAddress = typeof value.address === 'string' ? value.address.trim() : '';
  const street = directAddress || [
      value.address_line1 ?? value.line1 ?? nested.line1,
      value.address_line2 ?? value.line2 ?? nested.line2,
    ].filter(Boolean).join(', ');
  const locality = [
    value.city ?? nested.city,
    [value.state ?? nested.state, value.zip ?? value.postalCode ?? nested.zip ?? nested.postalCode].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
  return [street, locality].filter(Boolean).join(', ');
};

export function commercialSetupPropertySnapshot({
  property = null,
  propertyId = null,
  fallback = null,
  fallbackLabel = 'Account/default service address',
} = {}) {
  const id = property?.id ?? propertyId;
  const label = String(property?.label || '').trim()
    || (property?.is_primary === true ? 'Primary property' : '')
    || (id != null && String(id) ? `Property ${id}` : fallbackLabel);
  const address = addressText(property) || addressText(fallback);
  return {
    propertyLabel: label,
    propertyAddress: address || (id != null && String(id)
      ? `Address not available for property ${id}`
      : 'Address not available in this booking'),
  };
}

const bookingDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return value || 'Date not available';
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

const bookingTime = (value) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!match) return value || '';
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? 'AM' : 'PM'}`;
};

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
  booking = null,
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
  const services = Array.isArray(booking?.serviceNames) && booking.serviceNames.length
    ? booking.serviceNames.join(' + ')
    : 'Service details not available';
  const time = [bookingTime(booking?.windowStart), bookingTime(booking?.windowEnd)].filter(Boolean).join('–') || 'Time not available';
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
        <section aria-labelledby="commercial-setup-booking-heading" className="rounded border border-zinc-200 bg-zinc-50 p-3">
          <h3 id="commercial-setup-booking-heading" className="font-medium">Booking being reviewed</h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-zinc-600">Service</dt><dd>{services}</dd>
            <dt className="text-zinc-600">Cadence</dt><dd>{booking?.cadence || 'Cadence not available'}</dd>
            <dt className="text-zinc-600">Scheduled</dt><dd>{bookingDate(booking?.scheduledDate)} · {time}</dd>
            <dt className="text-zinc-600">Service property</dt><dd>{booking?.propertyLabel || 'Account/default service address'}</dd>
            <dt className="text-zinc-600">Service address</dt><dd>{booking?.propertyAddress || 'Address not available in this booking'}</dd>
          </dl>
        </section>
        <p>
          The source invoice includes a <strong>{prepaidAmount}</strong> commercial rodent setup. This visit's setup is <strong>{visitFee}</strong>.
        </p>
        <p className="text-zinc-600">
          Choose whether to use that setup on the source invoice for this visit. Choosing a separate setup keeps it available for the visit it belongs to.
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
          Use the {prepaidAmount} setup on the source invoice for this visit
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
