// Service-line edit sheet opened from MobileCheckoutSheet per IMG_3730.
// Lets the tech adjust the scheduled service mid-visit: tier (billing
// cadence label), price override, staff assignment, duration, notes.
//
// Save → PUT /admin/schedule/:id/update-details (same endpoint the V1
// EditServiceModal uses, so the server side already understands every
// field sent here). Parent refetches the schedule on success so the
// checkout sheet's totals reflect the change.

import { useEffect, useMemo, useState } from 'react';
import { X, ChevronRight, Check } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      ...(options.headers || {}),
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
    return r.json().catch(() => ({}));
  });
}

// Billing-cadence variants the tech can swap to at the door. These map to
// serviceType strings the server already recognises (matches the pattern
// used by estimate-converter + services-dropdown). Keeping the labels
// short and Square-style — the full marketing names live elsewhere.
const TIER_OPTIONS = [
  { key: 'monthly',    label: 'Billed Monthly',       subtitle: 'Monthly visits',       duration: 30, pattern: /monthly/i },
  { key: 'bimonthly',  label: 'Bi-Monthly',           subtitle: 'Every 2 months',       duration: 30, pattern: /bi[-\s]?monthly/i },
  { key: 'quarterly',  label: 'Quarterly',            subtitle: '4 visits per year',    duration: 30, pattern: /quarterly/i },
  { key: 'semiannual', label: 'Semiannual',           subtitle: '2 visits per year',    duration: 45, pattern: /semi[-\s]?annual/i },
  { key: 'one_time',   label: 'One-Time Service',     subtitle: 'Single visit',         duration: 60, pattern: /(one[-\s]?time|single|initial)/i },
];

function detectTier(serviceType) {
  if (!serviceType) return 'monthly';
  for (const opt of TIER_OPTIONS) {
    if (opt.pattern.test(serviceType)) return opt.key;
  }
  return 'monthly';
}

function baseServiceName(serviceType) {
  if (!serviceType) return 'Service';
  return serviceType
    .replace(/\b(monthly|bi[-\s]?monthly|quarterly|semi[-\s]?annual|one[-\s]?time|single|initial)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[-|–]\s*$/g, '')
    .trim() || serviceType;
}

export default function MobileServiceEditModal({
  service,
  technicians = [],
  onClose,
  onSaved,
}) {
  const [tier, setTier] = useState(() => detectTier(service?.serviceType));
  const [price, setPrice] = useState(() => {
    const p = service?.estimatedPrice;
    return p != null ? String(p) : '';
  });
  const [technicianId, setTechnicianId] = useState(() => service?.technicianId || '');
  const [duration, setDuration] = useState(() => service?.estimatedDuration || 30);
  const [notes, setNotes] = useState(() => service?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showStaffPicker, setShowStaffPicker] = useState(false);

  const baseName = useMemo(() => baseServiceName(service?.serviceType), [service?.serviceType]);
  const headerTitle = service?.serviceType || 'Service';

  // If tier changes, surface an updated default duration unless the tech
  // has already hand-edited it. Keep price untouched — we don't know the
  // customer-specific price for a different cadence without a lookup.
  useEffect(() => {
    const opt = TIER_OPTIONS.find((o) => o.key === tier);
    if (opt) setDuration((prev) => prev ?? opt.duration);
  }, [tier]);

  const selectedTech = technicians.find((t) => String(t.id) === String(technicianId));
  const selectedTechLabel = selectedTech
    ? selectedTech.name || selectedTech.fullName || `Tech #${selectedTech.id}`
    : technicianId
    ? `Tech #${technicianId}`
    : 'Unassigned';

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const tierOpt = TIER_OPTIONS.find((o) => o.key === tier);
    const nextServiceType = tierOpt ? `${baseName} — ${tierOpt.label}` : service.serviceType;
    const parsedPrice = price !== '' && !isNaN(parseFloat(price)) ? parseFloat(price) : undefined;
    try {
      await adminFetch(`/admin/schedule/${service.id}/update-details`, {
        method: 'PUT',
        body: JSON.stringify({
          scheduledDate: service.scheduledDate
            ? String(service.scheduledDate).split('T')[0]
            : undefined,
          windowStart: service.windowStart,
          windowEnd: service.windowEnd,
          serviceType: nextServiceType,
          estimatedDuration: Number(duration) || 30,
          technicianId: technicianId || null,
          notes,
          estimatedPrice: parsedPrice,
          price: parsedPrice != null ? String(parsedPrice) : undefined,
        }),
      });
      onSaved?.();
    } catch (e) {
      setError(e.message || 'Failed to save');
      setSaving(false);
    }
  }

  if (!service) return null;

  return (
    <div className="fixed inset-0 z-[65] bg-white overflow-y-auto md:hidden">
      {/* Header: X + title + Save */}
      <div
        className="sticky top-0 bg-white border-b border-hairline border-zinc-200 flex items-center"
        style={{ height: 56, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center h-11 w-11 u-focus-ring text-zinc-900"
        >
          <X size={22} strokeWidth={1.75} />
        </button>
        <div
          className="flex-1 text-center font-medium text-zinc-900 truncate px-2"
          style={{ fontSize: 16 }}
        >
          {headerTitle}
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="bg-zinc-900 text-white font-medium u-focus-ring"
          style={{
            height: 56,
            padding: '0 18px',
            fontSize: 15,
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="mx-auto" style={{ maxWidth: 560 }}>
        {/* Tier list */}
        <div
          className="uppercase tracking-label font-medium text-ink-tertiary"
          style={{ fontSize: 11, padding: '18px 16px 10px' }}
        >
          {baseName.toUpperCase()}: CHOOSE ONE
        </div>
        <div>
          {TIER_OPTIONS.map((opt) => {
            const selected = tier === opt.key;
            const priceLabel = selected && price !== '' && !isNaN(parseFloat(price))
              ? `$${parseFloat(price).toFixed(2)}`
              : 'Variable';
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setTier(opt.key)}
                className="w-full flex items-center gap-3 bg-white border-b border-hairline border-zinc-200 active:bg-zinc-50 text-left u-focus-ring"
                style={{ padding: '14px 16px' }}
              >
                <div className="flex-1 min-w-0">
                  <div
                    className="font-medium text-zinc-900 truncate"
                    style={{ fontSize: 15 }}
                  >
                    {opt.label}
                  </div>
                  <div
                    className="text-ink-tertiary u-nums"
                    style={{ fontSize: 12, marginTop: 2 }}
                  >
                    {opt.duration} min · {opt.subtitle}
                  </div>
                </div>
                <div
                  className="u-nums text-ink-secondary shrink-0"
                  style={{ fontSize: 14 }}
                >
                  {priceLabel}
                </div>
                <span
                  aria-hidden
                  className="shrink-0 flex items-center justify-center rounded-full"
                  style={{
                    width: 22,
                    height: 22,
                    background: selected ? '#18181B' : 'transparent',
                    border: selected ? 'none' : '1.5px solid #D4D4D8',
                  }}
                >
                  {selected && <Check size={14} className="text-white" strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </div>

        {/* Price override */}
        <div
          className="bg-white border-b border-hairline border-zinc-200 flex items-center gap-3"
          style={{ padding: '14px 16px', marginTop: 18 }}
        >
          <div
            className="flex-1 text-zinc-900 font-medium"
            style={{ fontSize: 15 }}
          >
            Price
          </div>
          <div className="relative">
            <span
              className="absolute text-ink-tertiary"
              style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14 }}
            >
              $
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0.00"
              className="u-nums text-right border-hairline border-zinc-200 rounded-xs u-focus-ring"
              style={{
                width: 120,
                padding: '8px 10px 8px 22px',
                fontSize: 14,
                background: '#FAFAFA',
              }}
            />
          </div>
        </div>

        {/* Staff */}
        <button
          type="button"
          onClick={() => setShowStaffPicker((v) => !v)}
          className="w-full bg-white border-b border-hairline border-zinc-200 flex items-center gap-3 text-left active:bg-zinc-50 u-focus-ring"
          style={{ padding: '14px 16px' }}
        >
          <span
            aria-hidden
            style={{
              width: 3,
              alignSelf: 'stretch',
              background: '#2563EB',
              borderRadius: 2,
            }}
          />
          <div
            className="flex-1 text-zinc-900 font-medium"
            style={{ fontSize: 15 }}
          >
            Staff
          </div>
          <div
            className="u-nums text-ink-secondary truncate"
            style={{ fontSize: 14, maxWidth: 180 }}
          >
            {selectedTechLabel}
          </div>
          <ChevronRight size={16} className="text-ink-tertiary shrink-0" />
        </button>
        {showStaffPicker && (
          <div className="bg-zinc-50 border-b border-hairline border-zinc-200">
            <button
              type="button"
              onClick={() => { setTechnicianId(''); setShowStaffPicker(false); }}
              className={
                'w-full flex items-center justify-between text-left active:bg-zinc-100 ' +
                (!technicianId ? 'text-zinc-900 font-medium' : 'text-ink-secondary')
              }
              style={{ padding: '12px 16px', fontSize: 14 }}
            >
              <span>Unassigned</span>
              {!technicianId && <Check size={16} className="text-zinc-900" strokeWidth={2.5} />}
            </button>
            {technicians.map((t) => {
              const active = String(t.id) === String(technicianId);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setTechnicianId(t.id); setShowStaffPicker(false); }}
                  className={
                    'w-full flex items-center justify-between text-left active:bg-zinc-100 border-t border-hairline border-zinc-200/60 ' +
                    (active ? 'text-zinc-900 font-medium' : 'text-ink-secondary')
                  }
                  style={{ padding: '12px 16px', fontSize: 14 }}
                >
                  <span>{t.name || t.fullName || `Tech #${t.id}`}</span>
                  {active && <Check size={16} className="text-zinc-900" strokeWidth={2.5} />}
                </button>
              );
            })}
          </div>
        )}

        {/* Duration */}
        <div
          className="bg-white border-b border-hairline border-zinc-200 flex items-center gap-3"
          style={{ padding: '14px 16px' }}
        >
          <div
            className="flex-1 text-zinc-900 font-medium"
            style={{ fontSize: 15 }}
          >
            Duration
          </div>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            step="5"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="u-nums text-right border-hairline border-zinc-200 rounded-xs u-focus-ring"
            style={{
              width: 80,
              padding: '8px 10px',
              fontSize: 14,
              background: '#FAFAFA',
            }}
          />
          <span
            className="text-ink-tertiary"
            style={{ fontSize: 13 }}
          >
            mins
          </span>
        </div>

        {/* Notes */}
        <div
          className="bg-white"
          style={{ padding: '16px' }}
        >
          <div
            className="uppercase tracking-label font-medium text-ink-tertiary"
            style={{ fontSize: 11, marginBottom: 6 }}
          >
            Notes
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add Note"
            rows={3}
            className="w-full text-zinc-900 u-focus-ring"
            style={{
              fontSize: 14,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'vertical',
              minHeight: 60,
              padding: 0,
            }}
          />
        </div>

        {error && (
          <div
            className="text-alert-fg"
            style={{ padding: '12px 16px', fontSize: 13 }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
