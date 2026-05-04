// Mobile-only detail sheet shown when a user taps an appointment row in the
// MobileDispatchList. Matches the Jobber-style reference shared by the owner:
//   X · Edit header · Review & checkout CTA · Customer (chevron to Customer 360)
//   · Services and items · Date and time · Location (map deep-link) ·
//   Appointment note (editable) · Booked on <date> footer ·
//   Cancel appointment / Mark as no-show / Book next appointment.
//
// Review & checkout  → opens MobileCheckoutSheet (Square-style pricing review
//                      → MobilePaymentSheet → Tap to Pay / Cash / etc.).
// Edit (top-right)   → opens EditServiceModal (existing V1).
// Cancel / No-show   → PUT /admin/dispatch/:id/status with status="cancelled"
//                      or status="no_show" (existing endpoint).
// Book next          → opens CreateAppointmentModal with this customer
//                      pre-filled (defaultCustomer prop).
// Note save          → PATCH /admin/dispatch/:id/note (new endpoint).

import { useEffect, useState } from 'react';
import { TIMEZONE } from '../../lib/timezone';
import MobileCustomerDetailSheet from './MobileCustomerDetailSheet';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

// WaveGuard tier → discount fraction. Source of truth:
// server/services/pricing-engine/constants.js WAVEGUARD.tiers
// (see docs/pricing/POLICY.md). Hardcoded here because the client bundle
// can't import server constants directly — keep aligned on every change.
const TIER_DISCOUNT = { bronze: 0, silver: 0.10, gold: 0.15, platinum: 0.20 };

function tierLabel(t) {
  if (!t) return '';
  const s = String(t).toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDateLong(dateStr) {
  if (!dateStr) return '';
  const iso = String(dateStr).split('T')[0];
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatBookedOn(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return '';
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h24 = parseInt(m[1], 10);
  const mm = m[2];
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${mm} ${ap}`;
}

function formatWindow(svc) {
  const s = formatTime(svc.windowStart);
  const e = formatTime(svc.windowEnd);
  if (!s) return svc.windowDisplay || '';
  if (!e) return s;
  return `${s} – ${e}`;
}

function durationHrs(svc) {
  if (!svc.windowStart || !svc.windowEnd) return '';
  const toMin = (hm) => {
    const m = hm.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  const a = toMin(svc.windowStart);
  const b = toMin(svc.windowEnd);
  if (a == null || b == null || b <= a) return '';
  const mins = b - a;
  if (mins === 60) return '1 hr';
  if (mins % 60 === 0) return `${mins / 60} hr`;
  if (mins < 60) return `${mins} mins`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} hr ${m} min`;
}

function mapDeepLink(address) {
  if (!address) return '';
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const encoded = encodeURIComponent(address);
  return isIos ? `maps://?q=${encoded}` : `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

export default function MobileAppointmentDetailSheet({
  service,
  onClose,
  onEdit,
  onTreatmentPlan,
  onReviewCheckout,
  onBookNext,
  onCancelled,
  onNoShow,
}) {
  const [note, setNote] = useState(service?.notes || '');
  const [savingNote, setSavingNote] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState(null);
  const [actionBusy, setActionBusy] = useState('');
  const [showCustomer, setShowCustomer] = useState(false);

  useEffect(() => {
    setNote(service?.notes || '');
    setNoteSavedAt(null);
  }, [service?.id, service?.notes]);

  if (!service) return null;

  const tier = service.waveguardTier ? String(service.waveguardTier).toLowerCase() : null;
  const pct = tier && TIER_DISCOUNT[tier] != null ? TIER_DISCOUNT[tier] : 0;
  const rawPrice = service.estimatedPrice != null ? Number(service.estimatedPrice) : null;
  const price = rawPrice != null ? rawPrice : Number(service.monthlyRate || 0);
  const discount = Math.round(price * pct * 100) / 100;
  const total = Math.max(0, price - discount);
  const timeWindow = formatWindow(service);
  const hrs = durationHrs(service);

  const coveredByMembership = !!tier && (rawPrice === 0 || rawPrice == null);
  const prepaidAmt = service.prepaidAmount != null ? Number(service.prepaidAmount) : null;
  const isPrepaid = prepaidAmt != null && prepaidAmt > 0;

  const noteDirty = (service?.notes || '') !== note;
  const isLawn = String(service?.serviceType || '').toLowerCase().includes('lawn');

  const saveNote = async () => {
    if (!noteDirty) return true;
    setSavingNote(true);
    try {
      await adminFetch(`/admin/dispatch/${service.id}/note`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: note }),
      });
      setNoteSavedAt(Date.now());
      // Reflect saved state locally so noteDirty flips back to false.
      service.notes = note;
      return true;
    } catch (err) {
      alert('Failed to save note: ' + err.message);
      return false;
    } finally {
      setSavingNote(false);
    }
  };

  const cancelAppointment = async () => {
    if (!window.confirm(`Cancel appointment for ${service.customerName || 'customer'}? This cannot be undone.`)) return;
    setActionBusy('cancel');
    try {
      await adminFetch(`/admin/dispatch/${service.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      onCancelled?.(service);
      onClose?.();
    } catch (err) {
      alert('Failed to cancel: ' + err.message);
    } finally { setActionBusy(''); }
  };

  const markNoShow = async () => {
    if (!window.confirm(`Mark ${service.customerName || 'customer'} as a no-show?`)) return;
    setActionBusy('noshow');
    try {
      await adminFetch(`/admin/dispatch/${service.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'no_show' }),
      });
      onNoShow?.(service);
      onClose?.();
    } catch (err) {
      alert('Failed to mark no-show: ' + err.message);
    } finally { setActionBusy(''); }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-white overflow-y-auto"
      style={{ fontFamily: 'Roboto, system-ui, sans-serif', fontWeight: 700 }}
    >
      {/* Top bar: Close · Edit — both bumped to iOS-friendly tap targets (≥44px)
          and given word labels instead of a bare ✕ glyph so they read at a
          glance on mobile. */}
      <div
        className="sticky top-0 bg-white flex items-center justify-between gap-3 px-4 border-b border-hairline border-zinc-200"
        style={{ height: 64, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-white border border-hairline border-zinc-200 text-ink-primary u-focus-ring"
          style={{ height: 44, padding: '0 18px', fontSize: 15 }}
        >
          <span style={{ fontSize: 18, lineHeight: 1 }}>✕</span>
          <span>Close</span>
        </button>
        <button
          type="button"
          onClick={() => onEdit?.(service)}
          aria-label="Edit appointment"
          className="rounded-sm bg-zinc-900 text-white u-focus-ring"
          style={{ height: 44, padding: '0 26px', fontSize: 15 }}
        >
          Edit
        </button>
      </div>

      <div className="px-4 pt-4 pb-10 mx-auto" style={{ maxWidth: 560 }}>
        {/* Review & checkout */}
        <button
          type="button"
          onClick={() => onReviewCheckout?.(service)}
          className="w-full rounded-sm bg-zinc-900 text-white u-focus-ring"
          style={{ padding: '14px 20px', fontSize: 16 }}
        >
          {coveredByMembership || isPrepaid ? 'Complete visit' : 'Review & checkout'}
        </button>
        {coveredByMembership && !isPrepaid && (
          <div className="text-ink-secondary text-center mt-2" style={{ fontSize: 12 }}>
            Covered by WaveGuard {tierLabel(tier)} — no charge needed
          </div>
        )}
        {isPrepaid && (
          <div className="text-ink-secondary text-center mt-2" style={{ fontSize: 12 }}>
            Prepaid ${prepaidAmt.toFixed(2)}
            {service.prepaidMethod ? ` via ${service.prepaidMethod.replace(/_/g, ' ')}` : ''} — no charge needed
          </div>
        )}
        {isLawn && (
          <button
            type="button"
            onClick={() => onTreatmentPlan?.(service)}
            className="w-full rounded-sm bg-white text-zinc-900 border border-hairline border-zinc-300 u-focus-ring mt-3"
            style={{ padding: '13px 20px', fontSize: 15 }}
          >
            Treatment plan
          </button>
        )}

        {/* Customer */}
        {service.customerId && (
          <section className="mt-8">
            <div className="text-zinc-900" style={{ fontSize: 20, marginBottom: 10 }}>
              Customer
            </div>
            <button
              type="button"
              onClick={() => setShowCustomer(true)}
              className="w-full flex items-start justify-between gap-3 py-3 border-b border-hairline border-zinc-200 text-left bg-transparent hover:bg-zinc-50 -mx-1 px-1 rounded-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="text-zinc-900 truncate" style={{ fontSize: 16 }}>
                  {service.customerName || 'Unknown'}
                </div>
                <div className="text-ink-secondary truncate" style={{ fontSize: 13, marginTop: 2 }}>
                  {service.customerPhone || ''}
                </div>
              </div>
              <span aria-hidden className="text-ink-secondary" style={{ fontSize: 22, lineHeight: 1 }}>›</span>
            </button>
          </section>
        )}

        {/* Services and items */}
        <section className="mt-8">
          <div className="text-zinc-900" style={{ fontSize: 20, marginBottom: 10 }}>
            Services and items
          </div>
          <div className="py-3 border-b border-hairline border-zinc-200 flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-zinc-900" style={{ fontSize: 15 }}>
                {service.serviceType || '—'}
              </div>
              <div className="text-ink-secondary" style={{ fontSize: 13, marginTop: 2 }}>
                {timeWindow}
                {service.estimatedDuration ? (timeWindow ? ' · ' : '') + `${service.estimatedDuration} mins` : ''}
              </div>
            </div>
            <div className="u-nums text-zinc-900" style={{ fontSize: 15 }}>
              ${price.toFixed(2)}
            </div>
          </div>

          {pct > 0 && (
            <div className="py-3 border-b border-hairline border-zinc-200 flex items-center justify-between">
              <span className="text-zinc-900" style={{ fontSize: 14 }}>
                WaveGuard {tierLabel(tier)} Discount ({Math.round(pct * 100)}%)
              </span>
              <span className="u-nums text-zinc-900" style={{ fontSize: 14 }}>
                −${discount.toFixed(2)}
              </span>
            </div>
          )}

          <div className="py-3 flex items-center justify-between">
            <span className="text-zinc-900" style={{ fontSize: 16 }}>
              Total
            </span>
            <span className="u-nums text-zinc-900" style={{ fontSize: 16 }}>
              ${total.toFixed(2)}
            </span>
          </div>
        </section>

        {/* Date and time */}
        <section className="mt-8">
          <div className="text-zinc-900" style={{ fontSize: 20, marginBottom: 10 }}>
            Date and time
          </div>
          <div className="text-zinc-900" style={{ fontSize: 15 }}>
            {formatDateLong(service.scheduledDate)}
          </div>
          {timeWindow && (
            <div className="text-ink-secondary" style={{ fontSize: 14, marginTop: 2 }}>
              {timeWindow}{hrs ? ` (${hrs})` : ''}
            </div>
          )}
        </section>

        {/* Location */}
        {service.address && (
          <section className="mt-8">
            <div className="text-zinc-900" style={{ fontSize: 20, marginBottom: 10 }}>
              Location
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-zinc-900" style={{ fontSize: 15, lineHeight: 1.3 }}>
                  {service.address.split(',')[0] || service.address}
                </div>
                <div className="text-ink-secondary" style={{ fontSize: 13, marginTop: 2 }}>
                  {service.address.split(',').slice(1).join(',').trim()}
                </div>
              </div>
              <a
                href={mapDeepLink(service.address)}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in Maps"
                className="flex items-center justify-center rounded-full bg-white border border-hairline border-zinc-200 u-focus-ring"
                style={{ width: 40, height: 40, fontSize: 18, textDecoration: 'none', color: '#18181B' }}
              >
                ➤
              </a>
            </div>
          </section>
        )}

        {/* Appointment note — editable */}
        <section className="mt-8">
          <div className="text-zinc-900" style={{ fontSize: 20, marginBottom: 10 }}>
            Appointment note
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm px-3 py-3 text-ink-primary focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            style={{ fontSize: 15, resize: 'vertical', minHeight: 96, fontFamily: 'inherit', fontWeight: 'inherit' }}
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-ink-tertiary" style={{ fontSize: 12 }}>
              {noteSavedAt ? 'Saved' : noteDirty ? 'Unsaved changes' : ''}
            </span>
            <button
              type="button"
              onClick={async () => {
                if (!noteDirty) {
                  onClose?.();
                  return;
                }
                const saved = await saveNote();
                if (saved) onClose?.();
              }}
              disabled={savingNote}
              className="rounded-sm bg-zinc-900 text-white u-focus-ring disabled:opacity-50"
              style={{ padding: '8px 18px', fontSize: 14 }}
            >
              {savingNote ? 'Saving…' : 'Back'}
            </button>
          </div>
        </section>

        {/* Booked on footer */}
        {service.createdAt && (
          <div className="text-center text-ink-secondary mt-8" style={{ fontSize: 13 }}>
            Booked on {formatBookedOn(service.createdAt)}
          </div>
        )}

        {/* Action buttons */}
        <section className="mt-6 border-t border-hairline border-zinc-200 pt-4 flex flex-col gap-3">
          <button
            type="button"
            onClick={cancelAppointment}
            disabled={!!actionBusy}
            className="w-full rounded-full bg-white border border-hairline border-zinc-200 text-alert-fg u-focus-ring disabled:opacity-50"
            style={{ padding: '14px 20px', fontSize: 16 }}
          >
            {actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel appointment'}
          </button>
          <button
            type="button"
            onClick={markNoShow}
            disabled={!!actionBusy}
            className="w-full rounded-full bg-white border border-hairline border-zinc-200 text-alert-fg u-focus-ring disabled:opacity-50"
            style={{ padding: '14px 20px', fontSize: 16 }}
          >
            {actionBusy === 'noshow' ? 'Saving…' : 'Mark as no-show'}
          </button>
          <button
            type="button"
            onClick={() => onBookNext?.(service)}
            className="w-full rounded-full bg-white border border-hairline border-zinc-200 text-zinc-900 u-focus-ring"
            style={{ padding: '14px 20px', fontSize: 16 }}
          >
            Book next appointment
          </button>
        </section>
      </div>

      {/* Customer detail sheet — opens over this sheet when the operator
          taps the Customer row, instead of navigating to /admin/customers
          and losing the schedule context. */}
      {showCustomer && service.customerId && (
        <MobileCustomerDetailSheet
          customerId={service.customerId}
          onClose={() => setShowCustomer(false)}
        />
      )}
    </div>
  );
}
