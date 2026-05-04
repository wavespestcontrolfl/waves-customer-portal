import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { adminFetch } from '../../lib/adminFetch';
import { TIMEZONE } from '../../lib/timezone';
import CallBridgeLink from '../admin/CallBridgeLink';

const TIER_DISCOUNT = { bronze: 0, silver: 0.10, gold: 0.15, platinum: 0.20 };

function tierLabel(t) {
  if (!t) return '';
  const s = String(t).toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function money(value) {
  const n = Number(value || 0);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function fmtTime(hhmm) {
  const minutes = parseMinutes(hhmm);
  if (minutes == null) return '';
  const h24 = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(2, '0');
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${mm} ${ap}`;
}

function fmtWindow(service) {
  const start = fmtTime(service?.windowStart);
  const end = fmtTime(service?.windowEnd);
  if (start && end) return `${start} – ${end}`;
  return service?.windowDisplay || start || '';
}

function fmtDuration(service) {
  if (service?.estimatedDuration) return `${service.estimatedDuration} mins`;
  const start = parseMinutes(service?.windowStart);
  const end = parseMinutes(service?.windowEnd);
  if (start == null || end == null || end <= start) return '';
  return `${end - start} mins`;
}

function fmtDateLong(value) {
  if (!value) return '';
  const iso = String(value).split('T')[0];
  const date = new Date(iso + 'T12:00:00Z');
  return date.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtApptDate(date, time) {
  const dateText = fmtDateLong(date);
  const timeText = fmtTime(time);
  return [dateText, timeText].filter(Boolean).join(', ');
}

function addressText(c, fallback) {
  if (fallback) return fallback;
  const a = c?.address || {};
  return [
    a.line1,
    [a.city, a.state].filter(Boolean).join(', '),
    a.zip,
  ].filter(Boolean).join(' ');
}

function Section({ title, children }) {
  return (
    <section className="border-t border-hairline border-zinc-200 py-5">
      <h2 className="text-16 font-medium text-zinc-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}

export default function ScheduleCustomerSidebar({
  service,
  onClose,
  onEdit,
  onBookNext,
  onSavedNote,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState(service?.notes || '');
  const [savingNote, setSavingNote] = useState(false);
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    setNote(service?.notes || '');
    setSavedNote(false);
  }, [service?.id, service?.notes]);

  useEffect(() => {
    if (!service?.customerId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    adminFetch(`/admin/customers/${service.customerId}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
        if (!cancelled) setData(json);
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load customer'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [service?.customerId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const c = data?.customer || {};
  const scheduled = data?.scheduled || [];
  const payments = data?.payments || [];
  const cards = data?.cards || [];

  const tier = String(service?.waveguardTier || c.tier || '').toLowerCase();
  const discountPct = TIER_DISCOUNT[tier] || 0;
  const basePrice = service?.estimatedPrice != null
    ? Number(service.estimatedPrice)
    : Number(service?.monthlyRate || c.monthlyRate || 0);
  const discount = Math.round(basePrice * discountPct * 100) / 100;
  const total = Math.max(0, basePrice - discount);
  const timeWindow = fmtWindow(service);
  const duration = fmtDuration(service);
  const address = addressText(c, service?.address);
  const phone = service?.customerPhone || c.phone || '';
  const email = c.email || '';
  const noteDirty = (service?.notes || '') !== note;

  const appointmentHistory = useMemo(() => {
    const currentId = service?.id;
    return [...scheduled]
      .sort((a, b) => String(b.scheduled_date).localeCompare(String(a.scheduled_date)))
      .slice(0, 8)
      .map((item) => ({ ...item, isCurrent: item.id === currentId }));
  }, [scheduled, service?.id]);

  const saveNote = async () => {
    if (!service?.id || !noteDirty) return;
    setSavingNote(true);
    try {
      const r = await adminFetch(`/admin/dispatch/${service.id}/note`, {
        method: 'PATCH',
        body: { notes: note },
      });
      if (!r.ok) {
        const json = await r.json().catch(() => ({}));
        throw new Error(json?.error || `HTTP ${r.status}`);
      }
      setSavedNote(true);
      onSavedNote?.(service, note);
    } catch (err) {
      window.alert('Failed to save note: ' + err.message);
    } finally {
      setSavingNote(false);
    }
  };

  if (!service) return null;

  return (
    <div className="fixed inset-0 z-[1000] pointer-events-none font-sans">
      <aside
        className="pointer-events-auto fixed right-0 top-0 h-screen w-full max-w-[430px] bg-white shadow-2xl border-l border-hairline border-zinc-200 overflow-y-auto"
        aria-label="Appointment details"
      >
        <div className="sticky top-0 z-10 bg-white border-b border-hairline border-zinc-200 px-5 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onBookNext?.(service)}
              className="h-9 px-3 rounded-sm bg-zinc-900 text-white text-12 font-medium uppercase tracking-label u-focus-ring"
            >
              Book next
            </button>
            <button
              type="button"
              onClick={() => onEdit?.(service)}
              className="h-9 px-3 rounded-sm bg-white border-hairline border-zinc-300 text-zinc-900 text-12 font-medium uppercase tracking-label u-focus-ring"
            >
              Edit
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-9 w-9 inline-flex items-center justify-center rounded-sm bg-white border-hairline border-zinc-300 text-zinc-900 u-focus-ring"
          >
            <X size={17} strokeWidth={1.75} />
          </button>
        </div>

        <div className="px-6 py-5">
          <h1 className="text-24 font-medium tracking-tight text-zinc-900 mb-4">
            {service.customerName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Customer'}
          </h1>

          {loading && <div className="text-13 text-ink-secondary py-2">Loading customer details...</div>}
          {error && <div className="text-13 text-alert-fg py-2">{error}</div>}

          <div className="space-y-3 mb-5">
            {phone && (
              <div>
                <div className="u-label text-ink-tertiary mb-1">Phone</div>
                <CallBridgeLink phone={phone} customerName={service.customerName} className="text-15 text-zinc-900 hover:underline">
                  {phone}
                </CallBridgeLink>
              </div>
            )}
            {email && (
              <div>
                <div className="u-label text-ink-tertiary mb-1">Email</div>
                <a href={`mailto:${email}`} className="text-15 text-zinc-900 hover:underline break-words">{email}</a>
              </div>
            )}
            {phone && (
              <a
                href={`/admin/communications?phone=${encodeURIComponent(phone)}`}
                className="inline-flex h-9 items-center rounded-sm border-hairline border-zinc-300 bg-white px-3 text-12 font-medium uppercase tracking-label text-zinc-900 no-underline u-focus-ring"
              >
                View messages
              </a>
            )}
          </div>

          <Section title="Appointment">
            <div className="text-15 text-zinc-900">{timeWindow}{duration ? ` (${duration})` : ''}</div>
            <div className="text-13 text-ink-secondary mt-1">{fmtDateLong(service.scheduledDate)}</div>
            {address && (
              <div className="mt-4">
                <div className="u-label text-ink-tertiary mb-1">Location</div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-14 text-zinc-900 hover:underline"
                >
                  {address}
                </a>
              </div>
            )}
            {service.technicianName && (
              <div className="mt-4">
                <div className="u-label text-ink-tertiary mb-1">Staff</div>
                <div className="text-14 text-zinc-900">{service.technicianName}</div>
              </div>
            )}
          </Section>

          <Section title="Services and items">
            <div className="flex items-start justify-between gap-3 pb-3 border-b border-hairline border-zinc-100">
              <div className="min-w-0">
                <div className="text-15 text-zinc-900">{service.serviceType || 'Service'}</div>
                <div className="text-13 text-ink-secondary mt-1">{[fmtTime(service.windowStart), duration].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="u-nums text-14 text-zinc-900">{money(basePrice)}</div>
            </div>
            {discountPct > 0 && (
              <div className="flex items-center justify-between gap-3 py-3 border-b border-hairline border-zinc-100">
                <div className="text-14 text-zinc-900">WaveGuard {tierLabel(tier)} discount</div>
                <div className="u-nums text-14 text-zinc-900">({money(discount)})</div>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 pt-3">
              <div className="text-15 font-medium text-zinc-900">Total</div>
              <div className="u-nums text-15 font-medium text-zinc-900">{money(total)}</div>
            </div>
            <a
              href={`/admin/invoices?customer=${encodeURIComponent(service.customerId)}`}
              className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-sm bg-zinc-900 px-4 text-13 font-medium uppercase tracking-label text-white no-underline u-focus-ring"
            >
              Take payment
            </a>
          </Section>

          <Section title="Client notes">
            <textarea
              value={note}
              onChange={(e) => { setNote(e.target.value); setSavedNote(false); }}
              placeholder="Add a note"
              rows={4}
              className="w-full rounded-sm border-hairline border-zinc-300 bg-white px-3 py-2 text-14 text-zinc-900 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-12 text-ink-tertiary">
                {savedNote ? 'Saved' : noteDirty ? 'Unsaved changes' : ''}
              </span>
              <button
                type="button"
                onClick={saveNote}
                disabled={!noteDirty || savingNote}
                className="h-8 px-3 rounded-sm border-hairline border-zinc-300 bg-white text-12 font-medium uppercase tracking-label text-zinc-900 disabled:opacity-40 u-focus-ring"
              >
                {savingNote ? 'Saving...' : 'Save note'}
              </button>
            </div>
          </Section>

          <Section title="Payment on file">
            {cards.length === 0 ? (
              <div className="text-14 text-ink-secondary">None saved</div>
            ) : cards.map((card) => (
              <div key={card.id} className="flex items-center justify-between py-2 border-b border-hairline border-zinc-100 last:border-b-0">
                <span className="text-14 text-zinc-900">{card.card_brand || 'Card'} ending {card.last_four}</span>
                {card.is_default && <span className="text-12 text-ink-tertiary">Default</span>}
              </div>
            ))}
          </Section>

          {payments.length > 0 && (
            <Section title="Transactions">
              {payments.slice(0, 5).map((payment) => (
                <div key={payment.id} className="flex items-start justify-between gap-3 py-2 border-b border-hairline border-zinc-100 last:border-b-0">
                  <div>
                    <div className="text-14 text-zinc-900">{payment.status || 'payment'}</div>
                    <div className="text-12 text-ink-secondary">{fmtDateLong(payment.payment_date || payment.created_at)}</div>
                  </div>
                  <div className="u-nums text-14 text-zinc-900">{money(payment.amount)}</div>
                </div>
              ))}
            </Section>
          )}

          <Section title="Appointments history">
            {appointmentHistory.length === 0 ? (
              <div className="text-14 text-ink-secondary">No appointments found</div>
            ) : appointmentHistory.map((item) => (
              <div key={item.id} className="py-3 border-b border-hairline border-zinc-100 last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-14 font-medium text-zinc-900">
                      {fmtApptDate(item.scheduled_date, item.window_start)}
                    </div>
                    <div className="text-13 text-ink-secondary mt-1 truncate">{item.service_type || 'Service'}</div>
                    {item.tech_name && <div className="text-12 text-ink-tertiary mt-1">Staff: {item.tech_name}</div>}
                  </div>
                  <span className="text-11 uppercase tracking-label text-ink-tertiary">
                    {item.isCurrent ? 'Current' : item.status || ''}
                  </span>
                </div>
              </div>
            ))}
          </Section>
        </div>
      </aside>
    </div>
  );
}
