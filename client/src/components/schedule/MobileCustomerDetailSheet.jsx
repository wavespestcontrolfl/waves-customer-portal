// client/src/components/schedule/MobileCustomerDetailSheet.jsx
//
// Full-screen mobile customer detail sheet. Opens from
// MobileAppointmentDetailSheet when the operator taps the Customer
// row, instead of navigating to /admin/customers (which dropped them
// out of the schedule context entirely).
//
// Layout mirrors Square's customer detail screen:
//   Top bar   — X close + Edit pill
//   Hero      — name + 3-stat row (Visits / Last visit / First visit)
//   Contact   — Phone / Email / Address, each as its own block
//   Payment   — saved cards on file (tap to remove in a follow-up PR)
//   Transactions — recent payments
//   Appointments — Upcoming / Previous tabs, repeating badge
//
// Data: one fetch to GET /admin/customers/:id (existing 16-table
// detail endpoint). We already hit this elsewhere, so the backend
// shape is stable.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminFetch } from '../../lib/adminFetch';

function fmtMonthDay(d) {
  if (!d) return '';
  const dt = new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00:00' : d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}
function fmtMonthYear(d) {
  if (!d) return '';
  const dt = new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00:00' : d);
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'America/New_York' });
}
function fmtApptDate(d, time) {
  if (!d) return '';
  const dt = new Date(typeof d === 'string' && d.length === 10 ? d + 'T12:00:00' : d);
  const datePart = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  if (!time) return datePart;
  // "09:00:00" → "9:00 AM"
  const [hh, mm] = String(time).split(':').map(Number);
  const h12 = ((hh + 11) % 12) + 1;
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const timePart = `${h12}:${String(mm || 0).padStart(2, '0')} ${ampm}`;
  return `${datePart} at ${timePart}`;
}
function money(n) {
  const v = Number(n || 0);
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function MobileCustomerDetailSheet({ customerId, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [apptTab, setApptTab] = useState('upcoming');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await adminFetch(`/admin/customers/${customerId}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
      setData(d);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [customerId]);

  useEffect(() => { if (customerId) load(); }, [customerId, load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!customerId) return null;

  // Endpoint returns { customer: { firstName, lastName, email, phone,
  // address: {line1, city, state, zip}, ... }, services, scheduled,
  // payments, cards, ... } — note camelCase on customer + nested address.
  const c = data?.customer || null;
  const services = data?.services || [];
  const scheduled = data?.scheduled || [];
  const payments = data?.payments || [];
  const cards = data?.cards || [];

  // Visit stats — pulled from service_records (completed visits). Counts any
  // service record with a service_date, first = earliest, last = most recent.
  const completedVisits = services.filter((s) => s.service_date);
  const sortedAsc = [...completedVisits].sort((a, b) => String(a.service_date).localeCompare(String(b.service_date)));
  const sortedDesc = [...sortedAsc].reverse();
  const visitCount = completedVisits.length;
  const lastVisitAt = sortedDesc[0]?.service_date || null;
  const firstVisitAt = sortedAsc[0]?.service_date || null;

  const now = new Date();
  const upcomingAppts = scheduled.filter((s) => new Date(s.scheduled_date) >= new Date(now.toDateString()) && !['completed', 'cancelled'].includes(s.status));
  const previousAppts = [...scheduled]
    .filter((s) => !upcomingAppts.includes(s))
    .sort((a, b) => String(b.scheduled_date).localeCompare(String(a.scheduled_date)));
  upcomingAppts.sort((a, b) => String(a.scheduled_date).localeCompare(String(b.scheduled_date)));
  const apptList = apptTab === 'upcoming' ? upcomingAppts : previousAppts;

  // Transactions: sum payments with status paid/refunded, most recent first.
  const txns = [...payments]
    .filter((p) => ['paid', 'refunded'].includes(p.status))
    .sort((a, b) => String(b.payment_date || b.created_at).localeCompare(String(a.payment_date || a.created_at)))
    .slice(0, 10);

  return (
    <div
      role="dialog"
      aria-label="Customer detail"
      className="fixed inset-0 z-[110] bg-surface-page overflow-y-auto"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      {/* Top bar */}
      <div
        className="sticky top-0 bg-surface-page flex items-center justify-between gap-3 px-4 border-b border-hairline border-zinc-200"
        style={{ height: 64, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex items-center justify-center rounded-full bg-white border border-hairline border-zinc-200 text-ink-primary u-focus-ring"
          style={{ width: 44, height: 44, fontSize: 20, lineHeight: 1 }}
        >
          ✕
        </button>
        <button
          type="button"
          onClick={() => { if (c?.id) navigate(`/admin/customers?customerId=${encodeURIComponent(c.id)}`); }}
          aria-label="Edit customer"
          className="rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
          style={{ height: 44, padding: '0 26px', fontSize: 15 }}
        >
          Edit
        </button>
      </div>

      <div className="px-5 py-6 mx-auto" style={{ maxWidth: 560 }}>
        {loading && <div className="py-10 text-center text-13 text-ink-secondary">Loading…</div>}
        {err && <div className="py-10 text-center text-13 text-alert-fg">Couldn't load: {err}</div>}

        {!loading && !err && c && (
          <>
            {/* Name */}
            <h1
              className="text-ink-primary"
              style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1, margin: '4px 0 20px' }}
            >
              {`${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown'}
            </h1>

            {/* Stat row — Visits | Last visit | First visit */}
            <section
              className="flex items-stretch"
              style={{ gap: 14, paddingBottom: 24, borderBottom: '6px solid #F4F4F5', marginBottom: 24 }}
            >
              <StatCell label="Visits" value={visitCount || 0} />
              <div style={{ width: 1, background: '#E4E4E7' }} />
              <StatCell label="Last visit" value={lastVisitAt ? fmtMonthDay(lastVisitAt) : '—'} />
              <div style={{ width: 1, background: '#E4E4E7' }} />
              <StatCell label="First visit" value={firstVisitAt ? fmtMonthYear(firstVisitAt) : '—'} />
            </section>

            {/* Phone */}
            {c.phone && (
              <ContactRow label="Phone number">
                <a href={`tel:${c.phone}`} className="text-ink-primary" style={{ fontSize: 17 }}>{c.phone}</a>
              </ContactRow>
            )}
            {c.email && (
              <ContactRow label="Email address">
                <a href={`mailto:${c.email}`} className="text-ink-primary" style={{ fontSize: 17, wordBreak: 'break-word' }}>{c.email}</a>
              </ContactRow>
            )}
            {(c.address?.line1 || c.address?.city) && (
              <ContactRow label="Address">
                <div style={{ fontSize: 17 }}>
                  {[
                    c.address.line1,
                    [c.address.city, c.address.state].filter(Boolean).join(', '),
                    c.address.zip,
                  ].filter(Boolean).join(', ')}
                </div>
              </ContactRow>
            )}

            {/* Payment on file */}
            <Section title="Payment on file" bottomBorder>
              {cards.length === 0 ? (
                <div className="text-ink-tertiary" style={{ fontSize: 15 }}>None saved</div>
              ) : (
                cards.map((pm) => (
                  <div
                    key={pm.id}
                    className="flex items-center gap-3 py-2"
                    style={{ fontSize: 17 }}
                  >
                    <div
                      className="inline-flex items-center justify-center rounded-sm bg-white border-hairline border-zinc-200 text-ink-primary font-medium"
                      style={{ width: 40, height: 28, fontSize: 11, letterSpacing: '0.04em' }}
                    >
                      {(pm.card_brand || '').toUpperCase().slice(0, 5)}
                    </div>
                    <div className="flex-1">
                      {(pm.card_brand || 'Card')[0].toUpperCase() + (pm.card_brand || 'card').slice(1)} {pm.last_four}
                      {pm.is_default && <span className="text-ink-tertiary" style={{ fontSize: 13 }}> · default</span>}
                    </div>
                  </div>
                ))
              )}
            </Section>

            {/* Transactions */}
            {txns.length > 0 && (
              <Section title="Transactions" bottomBorder>
                {txns.map((p) => (
                  <div key={p.id} className="flex items-start gap-3 py-3 border-b border-hairline border-zinc-100 last:border-b-0">
                    <div
                      className="inline-flex items-center justify-center rounded-sm bg-white border border-hairline border-zinc-200 text-ink-tertiary flex-shrink-0"
                      style={{ width: 40, height: 40 }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                        <rect x="2" y="5" width="20" height="14" rx="2" />
                        <line x1="2" y1="10" x2="22" y2="10" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-ink-primary" style={{ fontSize: 16, fontWeight: 500 }}>
                        {money(p.amount)} {p.status === 'refunded' ? 'Refund at' : 'Purchase at'} Waves Pest Control
                      </div>
                      <div className="text-ink-secondary" style={{ fontSize: 13, marginTop: 2 }}>
                        {fmtMonthDay(p.payment_date || p.created_at)}
                      </div>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {/* Appointments */}
            <section style={{ paddingTop: 24 }}>
              <h2 className="text-ink-primary" style={{ fontSize: 20, fontWeight: 700, margin: '0 0 14px' }}>
                Appointments
              </h2>
              <div className="flex items-center border-b border-hairline border-zinc-200" style={{ marginBottom: 14 }}>
                {['upcoming', 'previous'].map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setApptTab(k)}
                    className={apptTab === k ? 'text-ink-primary' : 'text-ink-secondary'}
                    style={{
                      padding: '10px 14px', fontSize: 16, fontWeight: apptTab === k ? 700 : 500,
                      borderBottom: apptTab === k ? '2px solid #18181B' : '2px solid transparent',
                      background: 'none',
                    }}
                  >
                    {k === 'upcoming' ? 'Upcoming' : 'Previous'}
                  </button>
                ))}
              </div>
              {apptList.length === 0 ? (
                <div className="text-ink-tertiary py-4" style={{ fontSize: 15 }}>
                  No {apptTab === 'upcoming' ? 'upcoming' : 'previous'} appointments
                </div>
              ) : (
                apptList.slice(0, 8).map((s) => (
                  <div
                    key={s.id}
                    className="flex items-start gap-3 py-3 border-b border-hairline border-zinc-100 last:border-b-0"
                    style={{ borderLeft: '3px solid #1B2C5B', paddingLeft: 12, marginLeft: -12 }}
                  >
                    <div
                      className="inline-flex items-center justify-center rounded-sm bg-white border border-hairline border-zinc-200 text-ink-tertiary flex-shrink-0"
                      style={{ width: 40, height: 40 }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-ink-primary line-clamp-2" style={{ fontSize: 16, fontWeight: 500 }}>
                          {s.service_type || 'Appointment'}
                        </div>
                        {s.is_recurring && (
                          <span
                            className="inline-flex items-center rounded-full bg-white border border-hairline border-zinc-200 text-ink-secondary flex-shrink-0"
                            style={{ fontSize: 12, padding: '4px 10px', fontWeight: 500 }}
                          >
                            Repeating
                          </span>
                        )}
                      </div>
                      <div className="text-ink-secondary" style={{ fontSize: 13, marginTop: 2 }}>
                        {fmtApptDate(s.scheduled_date, s.window_start)}
                      </div>
                    </div>
                  </div>
                ))
              )}
              {apptList.length > 8 && (
                <button
                  type="button"
                  onClick={() => navigate(`/admin/customers?customerId=${encodeURIComponent(c.id)}`)}
                  className="text-ink-primary"
                  style={{ fontSize: 16, fontWeight: 700, marginTop: 16, padding: '8px 0', background: 'none' }}
                >
                  View all
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function StatCell({ label, value }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-ink-secondary" style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{label}</div>
      <div className="text-ink-primary truncate" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
    </div>
  );
}

function ContactRow({ label, children }) {
  return (
    <div style={{ paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid #E4E4E7' }}>
      <div className="text-ink-primary" style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function Section({ title, children, bottomBorder = false }) {
  return (
    <section
      style={{
        paddingTop: 8,
        paddingBottom: 16,
        borderBottom: bottomBorder ? '6px solid #F4F4F5' : 'none',
        marginBottom: bottomBorder ? 16 : 0,
      }}
    >
      <h2 className="text-ink-primary" style={{ fontSize: 20, fontWeight: 700, margin: '0 0 10px' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}
