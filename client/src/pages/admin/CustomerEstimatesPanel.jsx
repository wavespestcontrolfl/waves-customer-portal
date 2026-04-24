// client/src/pages/admin/CustomerEstimatesPanel.jsx
// Slide-over panel opened from EstimatesPageV2 when the operator clicks
// a customer name. Summarizes the customer + their full estimate history
// + conversion stats + last comms touchpoint. Everything fetched from
// GET /admin/customers/:id/estimates-summary.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Phone, MessageSquare, FilePlus2, ExternalLink, ChevronLeft, PhoneCall } from 'lucide-react';
import { Badge, Button, cn } from '../../components/ui';
import { adminFetch } from '../../lib/adminFetch';

const STATUS_TONES = {
  draft: 'muted',
  sent: 'neutral',
  viewed: 'neutral',
  accepted: 'strong',
  declined: 'alert',
  expired: 'muted',
};

const STATUS_LABELS = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
};

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtMoney(n) {
  const v = Number(n || 0);
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function timeAgo(d) {
  if (!d) return '';
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(d);
}

export default function CustomerEstimatesPanel({ customerId, onClose }) {
  const [data, setData] = useState(null);
  const [comms, setComms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const [summaryRes, commsRes] = await Promise.all([
        adminFetch(`/admin/customers/${customerId}/estimates-summary`),
        adminFetch(`/admin/customers/${customerId}/comms?limit=15`).catch(() => null),
      ]);
      const d = await summaryRes.json();
      if (!summaryRes.ok) throw new Error(d?.error || `HTTP ${summaryRes.status}`);
      setData(d);
      if (commsRes && commsRes.ok) {
        const cd = await commsRes.json();
        setComms(cd?.comms || []);
      } else {
        setComms([]);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { if (customerId) load(); }, [customerId, load]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!customerId) return null;

  const c = data?.customer;
  const estimates = data?.estimates || [];
  const stats = data?.stats;
  const lastContact = data?.lastContact;

  const prefillHref = c
    ? `/admin/estimates?${new URLSearchParams({
        address: `${c.address_line1 || ''}${c.city ? ', ' + c.city : ''}${c.state ? ', ' + c.state : ''}${c.zip ? ' ' + c.zip : ''}`.trim(),
        customerName: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        customerPhone: c.phone || '',
        customerEmail: c.email || '',
      }).toString()}`
    : '/admin/estimates';

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-[480px] bg-white border-l border-hairline border-zinc-200 shadow-2xl flex flex-col"
        role="dialog"
        aria-label="Customer + estimate history"
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-hairline border-zinc-200">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to estimates"
            className="inline-flex items-center gap-1 h-9 px-2 -ml-1 rounded-sm text-ink-secondary hover:text-zinc-900 hover:bg-zinc-50 u-focus-ring"
          >
            <ChevronLeft size={18} strokeWidth={1.75} />
            <span className="text-13 font-medium">Back</span>
          </button>
          <div className="flex-1 text-center min-w-0 px-2">
            <div className="text-11 uppercase tracking-label text-ink-tertiary">Customer</div>
          </div>
          {/* Spacer to balance the Back button's width and keep the eyebrow centered */}
          <div className="w-[70px]" aria-hidden />
        </div>

        {loading && <div className="p-6 text-13 text-ink-secondary text-center">Loading…</div>}
        {err && <div className="p-6 text-13 text-alert-fg text-center">Couldn't load: {err}</div>}

        {!loading && !err && c && (
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
            {/* Customer card — name is the primary header, then company, then phone/email/address */}
            <section className="border border-hairline border-zinc-200 rounded-sm p-3 space-y-1 text-13">
              <div className="text-16 font-medium text-zinc-900 mb-1">
                {`${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unknown'}
              </div>
              {c.company_name && (
                <div className="text-ink-secondary">{c.company_name}</div>
              )}
              {c.phone && (
                <div className="flex items-center gap-2">
                  <Phone size={13} strokeWidth={1.75} className="text-ink-tertiary" />
                  <a href={`tel:${c.phone}`} className="text-zinc-900 hover:underline font-mono">{c.phone}</a>
                </div>
              )}
              {c.email && (
                <div className="flex items-center gap-2">
                  <span className="text-ink-tertiary text-11 w-[13px]">@</span>
                  <a href={`mailto:${c.email}`} className="text-zinc-900 hover:underline truncate">{c.email}</a>
                </div>
              )}
              {(c.address_line1 || c.city) && (
                <div className="text-ink-secondary mt-1">
                  {c.address_line1}
                  {c.address_line1 && (c.city || c.state) ? <br /> : null}
                  {[c.city, c.state].filter(Boolean).join(', ')}{c.zip ? ' ' + c.zip : ''}
                </div>
              )}
              <div className="flex items-center gap-1.5 pt-2 flex-wrap">
                {c.waveguard_tier && <Badge tone="neutral">{c.waveguard_tier}</Badge>}
                {c.property_type === 'commercial' || c.property_type === 'business' ? (
                  <Badge tone="muted">Commercial</Badge>
                ) : null}
                {c.active === false && <Badge tone="alert">Inactive</Badge>}
              </div>
            </section>

            {/* Quick actions */}
            <section className="grid grid-cols-2 gap-2">
              {c.phone && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(`Call ${c.first_name || ''} ${c.last_name || ''}`.trim() + ` at ${c.phone}?\n\nWaves will call your phone first — press 1 to connect.`)) return;
                    try {
                      const r = await adminFetch('/admin/communications/call', {
                        method: 'POST',
                        body: JSON.stringify({ to: c.phone, fromNumber: '+19412975749' }),
                      });
                      const res = await r.json().catch(() => ({}));
                      if (!res?.success) alert('Call failed: ' + (res?.error || 'unknown error'));
                    } catch (e) { alert('Call failed: ' + e.message); }
                  }}
                  className="inline-flex items-center justify-center gap-2 h-10 border-hairline border-zinc-900 rounded-sm text-white bg-zinc-900 hover:bg-zinc-800 text-12 font-medium uppercase tracking-label"
                >
                  <Phone size={14} strokeWidth={1.75} /> Call
                </button>
              )}
              {c.phone && (
                <a
                  href={`/admin/communications?phone=${encodeURIComponent(c.phone)}`}
                  className="inline-flex items-center justify-center gap-2 h-10 border-hairline border-zinc-900 rounded-sm text-white bg-zinc-900 hover:bg-zinc-800 text-12 font-medium uppercase tracking-label"
                >
                  <MessageSquare size={14} strokeWidth={1.75} /> SMS
                </a>
              )}
              <Link
                to={prefillHref}
                className="inline-flex items-center justify-center gap-2 h-10 border-hairline border-zinc-300 rounded-sm text-zinc-900 bg-white hover:bg-zinc-50 text-12 font-medium uppercase tracking-label"
              >
                <FilePlus2 size={14} strokeWidth={1.75} /> New estimate
              </Link>
              <Link
                to={`/admin/customers?customerId=${encodeURIComponent(c.id)}`}
                className="inline-flex items-center justify-center gap-2 h-10 border-hairline border-zinc-300 rounded-sm text-zinc-900 bg-white hover:bg-zinc-50 text-12 font-medium uppercase tracking-label"
              >
                <ExternalLink size={14} strokeWidth={1.75} /> Customer 360
              </Link>
            </section>

            {/* Stats */}
            {stats && stats.total > 0 && (
              <section className="grid grid-cols-3 gap-2 text-center">
                <StatCell label="Estimates" value={stats.total} />
                <StatCell label="Accepted" value={stats.accepted} accent={stats.accepted > 0 ? 'good' : undefined} />
                <StatCell
                  label="Conversion"
                  value={stats.conversionRate != null ? `${Math.round(stats.conversionRate * 100)}%` : '—'}
                  sub={stats.conversionRate != null ? `${stats.accepted}/${stats.accepted + stats.declined} decided` : null}
                />
              </section>
            )}

            {stats && stats.acceptedLifetimeMonthly > 0 && (
              <div className="text-12 text-ink-secondary">
                <strong className="text-zinc-900">{fmtMoney(stats.acceptedLifetimeMonthly)}/mo</strong> across accepted estimates
              </div>
            )}

            {/* Communications — full chronological thread (SMS + calls) pulled
                from /admin/customers/:id/comms. Falls back to the single
                lastContact row from the summary endpoint when the comms call
                is empty or failed. */}
            {(comms.length > 0 || lastContact) && (
              <section className="border-t border-hairline border-zinc-200 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="uppercase tracking-label text-11 text-ink-tertiary">
                    Communications {comms.length > 0 && `(${comms.length})`}
                  </div>
                  {c.phone && (
                    <Link
                      to={`/admin/communications?phone=${encodeURIComponent(c.phone)}`}
                      className="text-11 text-ink-secondary hover:text-zinc-900 underline decoration-dotted"
                    >
                      Open thread →
                    </Link>
                  )}
                </div>
                {comms.length > 0 ? (
                  <div className="space-y-1.5">
                    {comms.slice(0, 10).map((m) => <CommsRow key={m.id} m={m} />)}
                    {comms.length > 10 && (
                      <div className="text-11 text-ink-tertiary text-center pt-1">
                        + {comms.length - 10} more — open thread to see all
                      </div>
                    )}
                  </div>
                ) : lastContact ? (
                  <div className="text-12 text-ink-secondary">
                    <span className="text-zinc-900">{lastContact.channel === 'voice' ? 'Call' : 'SMS'}</span>
                    {' '}({lastContact.direction === 'inbound' ? 'from customer' : 'from us'}) · {timeAgo(lastContact.at)}
                    {lastContact.preview && lastContact.channel === 'sms' && (
                      <div className="mt-1 text-ink-secondary italic truncate">"{lastContact.preview}"</div>
                    )}
                  </div>
                ) : null}
              </section>
            )}

            {/* Estimates list */}
            <section>
              <div className="text-11 uppercase tracking-label text-ink-tertiary mb-2">
                Estimate history ({estimates.length})
              </div>
              {estimates.length === 0 ? (
                <div className="text-13 text-ink-secondary text-center py-6 border border-hairline border-dashed border-zinc-200 rounded-sm">
                  No estimates yet.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {estimates.map((e) => {
                    const tone = STATUS_TONES[e.status] || 'muted';
                    const label = STATUS_LABELS[e.status] || e.status;
                    const anchorDate = e.accepted_at || e.declined_at || e.viewed_at || e.sent_at || e.created_at;
                    return (
                      <div
                        key={e.id}
                        className="border border-hairline border-zinc-200 rounded-sm p-2.5 flex items-start justify-between gap-2 hover:bg-zinc-50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge tone={tone}>{label}</Badge>
                            {e.waveguard_tier && <span className="text-11 text-ink-secondary">{e.waveguard_tier}</span>}
                            <span className="text-11 text-ink-tertiary">{timeAgo(anchorDate)}</span>
                          </div>
                          {e.service_interest && (
                            <div className="text-12 text-ink-secondary mt-0.5 truncate">{e.service_interest}</div>
                          )}
                          {e.decline_reason && (
                            <div className="text-12 text-alert-fg mt-0.5">Declined: {e.decline_reason}</div>
                          )}
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className={cn('text-14 font-medium u-nums', Number(e.monthly_total || 0) > 0 ? 'text-zinc-900' : 'text-ink-tertiary')}>
                            {fmtMoney(e.monthly_total)}<span className="text-11 text-ink-tertiary">/mo</span>
                          </div>
                          {e.token && (
                            <a
                              href={`/estimate/${e.token}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-11 text-ink-secondary hover:text-zinc-900 underline decoration-dotted"
                            >
                              View →
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </aside>
    </>
  );
}

function StatCell({ label, value, sub, accent }) {
  return (
    <div className="border border-hairline border-zinc-200 rounded-sm p-2">
      <div className={cn('text-18 u-nums font-medium', accent === 'good' ? 'text-zinc-900' : 'text-zinc-900')}>
        {value}
      </div>
      <div className="text-11 text-ink-tertiary uppercase tracking-label">{label}</div>
      {sub && <div className="text-11 text-ink-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

// One row in the Communications section. Handles SMS + voice shapes from
// /admin/customers/:id/comms. Kept minimal — body/aiSummary/duration as
// appropriate, direction as a left-border accent (ours=zinc, theirs=blue).
function CommsRow({ m }) {
  const isOut = m.direction === 'outbound';
  const isVoice = m.channel === 'voice';
  const Icon = isVoice ? PhoneCall : MessageSquare;
  const label = isVoice
    ? (isOut ? 'Call placed' : (m.answeredBy === 'ai_agent' ? 'Call (AI answered)' : 'Call received'))
    : (isOut ? 'SMS sent' : 'SMS received');
  const subtitle = isVoice
    ? (m.aiSummary || (m.durationSeconds ? `${Math.round(m.durationSeconds / 60)} min` : null))
    : m.body;
  return (
    <div
      className={cn(
        'border border-hairline border-zinc-200 rounded-sm px-2.5 py-2 text-12 flex items-start gap-2',
        !isOut && 'border-l-2 border-l-waves-blue',
      )}
    >
      <Icon size={13} strokeWidth={1.75} className="text-ink-tertiary mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-zinc-900 font-medium">{label}</span>
          <span className="text-11 text-ink-tertiary">· {timeAgo(m.createdAt)}</span>
          {m.ourEndpointLabel && (
            <span className="text-11 text-ink-tertiary">· {m.ourEndpointLabel}</span>
          )}
        </div>
        {subtitle && (
          <div className="text-ink-secondary mt-0.5 line-clamp-2">{subtitle}</div>
        )}
      </div>
    </div>
  );
}
