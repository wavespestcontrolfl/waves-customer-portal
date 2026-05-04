// Mobile-only "New customer" sheet (IMG_3735 / IMG_3736).
// Full-screen sheet over the Customers page. Matches the compact mobile layout:
//   · round X top-left, round "Save" pill top-right (dims when invalid)
//   · big "New customer" heading
//   · grey "Import from contacts" pill (stub — needs iOS bridge)
//   · rounded outlined inputs for name / phone / email
//   · "Address" section label then Country / Line 1 / Line 2 / City / State / ZIP
//
// Submits to the existing /admin/customers/quick-add endpoint. That endpoint
// accepts first/last name, phone, email, address (line 1), city, state, zip,
// and profile label. Line 2 is collected in the UI for parity with the mobile
// layout but not sent (no column exists yet; add a migration if needed).

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function ringClass() {
  return 'block w-full bg-white text-zinc-900 border-hairline border-zinc-300 rounded-md px-4 ' +
    'focus:outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900 u-focus-ring';
}

export default function MobileNewCustomerSheet({ open, onClose, onCreated }) {
  const [form, setForm] = useState({
    firstName: '', lastName: '', phone: '', email: '',
    addressLine1: '', addressLine2: '', city: '', state: 'FL', zip: '',
    profileLabel: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  // Square requires first + last + phone at minimum (matches server quick-add).
  const canSave = useMemo(
    () => form.firstName.trim() && form.lastName.trim() && form.phone.trim(),
    [form.firstName, form.lastName, form.phone],
  );

  if (!open) return null;

  async function handleSave() {
    if (!canSave || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/admin/customers/quick-add`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim() || undefined,
          address: form.addressLine1.trim() || undefined,
          city: form.city.trim() || undefined,
          state: form.state.trim() || undefined,
          zip: form.zip.trim() || undefined,
          profileLabel: form.profileLabel.trim() || undefined,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      onCreated?.(data.customer);
      onClose?.();
    } catch (e) {
      setError(e.message || 'Failed to create customer');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[110] bg-white overflow-y-auto md:hidden">
      {/* Sticky header: X left, Save pill right. 56px tall. */}
      <div
        className="sticky top-0 bg-white flex items-center px-3"
        style={{ height: 56, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center rounded-full bg-zinc-100 u-focus-ring text-zinc-900"
          style={{ width: 36, height: 36 }}
        >
          <X size={20} strokeWidth={1.75} />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave || submitting}
          className="rounded-full font-medium u-focus-ring"
          style={{
            padding: '8px 18px',
            fontSize: 15,
            background: canSave ? '#18181B' : '#F4F4F5',
            color: canSave ? '#FFFFFF' : '#A1A1AA',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="px-5 pb-16 mx-auto" style={{ maxWidth: 560 }}>
        {/* Heading */}
        <h1
          className="text-zinc-900"
          style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.01em', marginTop: 12, marginBottom: 18 }}
        >
          New customer
        </h1>

        {/* Import from contacts (stub — needs native bridge) */}
        <button
          type="button"
          onClick={() => alert('Import from contacts — coming soon')}
          className="w-full rounded-full bg-zinc-100 text-zinc-900 font-semibold u-focus-ring"
          style={{ padding: '14px 20px', fontSize: 15, marginBottom: 18 }}
        >
          Import from contacts
        </button>

        {/* Name + phone + email */}
        <div className="flex flex-col gap-3">
          <input
            className={ringClass()}
            style={{ height: 56, fontSize: 15 }}
            placeholder="First name"
            value={form.firstName}
            onChange={(e) => set('firstName', e.target.value)}
            autoComplete="given-name"
          />
          <input
            className={ringClass()}
            style={{ height: 56, fontSize: 15 }}
            placeholder="Last name"
            value={form.lastName}
            onChange={(e) => set('lastName', e.target.value)}
            autoComplete="family-name"
          />
          <div className={ringClass() + ' flex items-center gap-2'} style={{ height: 56, paddingLeft: 14, paddingRight: 14 }}>
            <span style={{ fontSize: 22, lineHeight: 1 }} aria-hidden="true">🇺🇸</span>
            <span className="text-zinc-400" style={{ fontSize: 15 }}>▾</span>
            <input
              type="tel"
              inputMode="tel"
              placeholder="Phone number"
              className="flex-1 bg-transparent outline-none"
              style={{ fontSize: 15 }}
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
              autoComplete="tel"
            />
          </div>
          <input
            className={ringClass()}
            style={{ height: 56, fontSize: 15 }}
            type="email"
            inputMode="email"
            placeholder="Email address"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            autoComplete="email"
          />
        </div>

        {/* Divider */}
        <div className="my-6 h-px bg-zinc-200" />

        {/* Address */}
        <h2
          className="text-zinc-900"
          style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}
        >
          Address
        </h2>
        <div className="flex flex-col gap-3">
          {/* Country — read-only for now (all customers SWFL / US) */}
          <div
            className={ringClass() + ' flex items-center gap-3'}
            style={{ height: 64, paddingLeft: 14, paddingRight: 14 }}
          >
            <span style={{ fontSize: 22, lineHeight: 1 }} aria-hidden="true">🇺🇸</span>
            <div className="flex-1 min-w-0" style={{ lineHeight: 1.2 }}>
              <div className="text-zinc-900 font-semibold" style={{ fontSize: 13 }}>Country</div>
              <div className="text-zinc-900" style={{ fontSize: 15, marginTop: 1 }}>United States</div>
            </div>
            <span className="text-zinc-400" style={{ fontSize: 18 }}>▾</span>
          </div>
          <input
            className={ringClass()}
            style={{ height: 56, fontSize: 15 }}
            placeholder="Address line 1"
            value={form.addressLine1}
            onChange={(e) => set('addressLine1', e.target.value)}
            autoComplete="address-line1"
          />
          <input
            className={ringClass()}
            style={{ height: 56, fontSize: 15 }}
            placeholder="Address line 2"
            value={form.addressLine2}
            onChange={(e) => set('addressLine2', e.target.value)}
            autoComplete="address-line2"
          />
          <input
            className={ringClass()}
            style={{ height: 56, fontSize: 15 }}
            placeholder="Property label"
            value={form.profileLabel}
            onChange={(e) => set('profileLabel', e.target.value)}
          />
          <input
            className={ringClass()}
            style={{ height: 56, fontSize: 15 }}
            placeholder="City"
            value={form.city}
            onChange={(e) => set('city', e.target.value)}
            autoComplete="address-level2"
          />
          {/* State */}
          <div
            className={ringClass() + ' flex items-center gap-2'}
            style={{ height: 56, paddingLeft: 14, paddingRight: 14 }}
          >
            <input
              className="flex-1 bg-transparent outline-none"
              style={{ fontSize: 15 }}
              placeholder="State"
              value={form.state}
              onChange={(e) => set('state', e.target.value.toUpperCase().slice(0, 2))}
              autoComplete="address-level1"
            />
            <span className="text-zinc-400" style={{ fontSize: 18 }}>▾</span>
          </div>
          <input
            className={ringClass()}
            style={{ height: 56, fontSize: 15 }}
            inputMode="numeric"
            placeholder="ZIP"
            value={form.zip}
            onChange={(e) => set('zip', e.target.value)}
            autoComplete="postal-code"
          />
        </div>

        {error && (
          <div
            className="mt-5 rounded-md border-hairline border-alert-fg/30 bg-alert-bg p-3 text-alert-fg"
            style={{ fontSize: 13 }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
