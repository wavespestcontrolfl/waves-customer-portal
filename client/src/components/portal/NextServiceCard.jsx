/*
 * NextServiceCard
 *
 * Drop-in preview of the redesigned data-surface pattern. Mirrors the LM
 * "Balance / Pay now" card from the design reference, adapted to show the
 * customer's next scheduled service.
 *
 * Usage (preview):
 *   import NextServiceCard from '@/components/portal/NextServiceCard';
 *   <NextServiceCard service={mockService} onViewDetails={…} onReschedule={…} onCallTech={…} />
 *
 * Data contract (all optional — component degrades gracefully):
 *   service = {
 *     serviceType:  'General Pest Control' | 'Lawn Treatment' | …
 *     date:         Date | ISO string
 *     windowStart:  Date | ISO string        // e.g. 9:00 AM
 *     windowEnd:    Date | ISO string        // e.g. 11:00 AM
 *     technician:   { firstName, lastName, phone }
 *     address:      '123 Maple St'           // street line only
 *     status:       'scheduled' | 'enroute' | 'inprogress' | 'completed'
 *     etaMinutes:   number                   // when status === 'enroute'
 *     visitNumber:  number                   // '#2 of 6'
 *     visitTotal:   number
 *   }
 *
 * No emoji. Icons are inline SVG, stroke-only, inherit `currentColor`.
 */

const STATUS_META = {
  scheduled:  { label: 'Scheduled',   dot: 'wp-dot--tide',    pulse: false },
  enroute:    { label: 'On the way',  dot: 'wp-dot--tide',    pulse: true  },
  inprogress: { label: 'In progress', dot: 'wp-dot--gold',    pulse: true  },
  completed:  { label: 'Completed',   dot: 'wp-dot--success', pulse: false },
};

export default function NextServiceCard({
  service,
  onViewDetails,
  onReschedule,
  onCallTech,
}) {
  if (!service) return null;

  const status = STATUS_META[service.status] || STATUS_META.scheduled;
  const dateObj = service.date ? new Date(service.date) : null;
  const primaryAction = getPrimaryAction(service.status);

  const techName = service.technician
    ? [service.technician.firstName, service.technician.lastName].filter(Boolean).join(' ')
    : null;
  const techInitial = service.technician?.firstName?.[0] || 'W';

  return (
    <article className="wp-card wp-card--stripe" aria-labelledby="next-svc-title">
      <div className="wp-card__body">
        {/* Row 1 — label + status pill */}
        <header style={rowHeader}>
          <span className="wp-label">Next service</span>
          <span className="wp-pill">
            <span
              className={`wp-dot ${status.dot}${status.pulse ? ' wp-dot--pulse' : ''}`}
              aria-hidden="true"
            />
            {status.label}
            {service.status === 'enroute' && service.etaMinutes != null && (
              <> · {service.etaMinutes} min</>
            )}
          </span>
        </header>

        {/* Row 2 — the big moment: date + service type */}
        <div style={{ marginTop: 14 }}>
          {dateObj && (
            <div id="next-svc-title" className="wp-numeric" style={dateStyle}>
              {formatDate(dateObj)}
            </div>
          )}
          <div className="wp-title" style={{ marginTop: 6 }}>
            {service.serviceType || 'Scheduled service'}
            {service.visitNumber && (
              <span className="wp-muted" style={visitCountStyle}>
                {' '}· Visit {service.visitNumber}
                {service.visitTotal ? ` of ${service.visitTotal}` : ''}
              </span>
            )}
          </div>
        </div>

        {/* Row 3 — tech chip + time window */}
        {(techName || service.windowStart) && (
          <div style={techRowStyle}>
            <div className="wp-avatar" aria-hidden="true">{techInitial}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              {techName && (
                <div className="wp-body" style={{ fontWeight: 600, color: 'var(--wp-ink)' }}>
                  {techName}
                </div>
              )}
              {service.windowStart && (
                <div className="wp-meta">
                  Arrives {formatWindow(service.windowStart, service.windowEnd)}
                </div>
              )}
            </div>
            {service.technician?.phone && onCallTech && (
              <button
                type="button"
                className="wp-btn wp-btn--quiet wp-btn--sm"
                onClick={onCallTech}
                aria-label={`Call ${techName || 'technician'}`}
              >
                <IconPhone />
                Call
              </button>
            )}
          </div>
        )}

        {/* Row 4 — address */}
        {service.address && (
          <div style={addressRowStyle}>
            <IconPin />
            <span>{service.address}</span>
          </div>
        )}
      </div>

      {/* Row 5 — primary action (on a muted inset below card body, LM pattern) */}
      <footer style={footerStyle}>
        <button
          type="button"
          className="wp-btn wp-btn--ink wp-btn--block"
          onClick={primaryAction === 'reschedule' ? onReschedule : onViewDetails}
        >
          {primaryAction === 'track' && 'Track technician'}
          {primaryAction === 'viewReport' && 'View service report'}
          {primaryAction === 'reschedule' && 'Reschedule'}
          {primaryAction === 'details' && 'View details'}
        </button>
        {primaryAction !== 'reschedule' && onReschedule && (
          <button
            type="button"
            className="wp-btn wp-btn--ghost wp-btn--block"
            onClick={onReschedule}
            style={{ marginTop: 4 }}
          >
            Reschedule
          </button>
        )}
      </footer>
    </article>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

function getPrimaryAction(status) {
  switch (status) {
    case 'enroute':    return 'track';
    case 'inprogress': return 'track';
    case 'completed':  return 'viewReport';
    default:           return 'details';
  }
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).toUpperCase();
}

function formatWindow(start, end) {
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  const fmt = (dt) => dt.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: dt.getMinutes() ? '2-digit' : undefined,
  });
  return e ? `${fmt(s)}–${fmt(e)}` : fmt(s);
}

/* ─────────────────────────── icons ─────────────────────────── */

function IconPhone() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function IconPin() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx={12} cy={10} r={3} />
    </svg>
  );
}

/* ─────────────────────────── styles ─────────────────────────── */

const rowHeader = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const dateStyle = {
  fontSize: 34,
  letterSpacing: '0.04em',
  color: 'var(--wp-ink)',
};

const visitCountStyle = {
  fontFamily: 'var(--wp-font-body)',
  fontSize: 'var(--wp-fs-sm)',
  fontWeight: 500,
};

const techRowStyle = {
  marginTop: 18,
  paddingTop: 14,
  borderTop: '1px solid var(--wp-surface-mute)',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const addressRowStyle = {
  marginTop: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: 'var(--wp-ink-muted)',
  fontSize: 'var(--wp-fs-sm)',
};

const footerStyle = {
  padding: 16,
  background: 'var(--wp-cream-soft)',
  borderTop: '1px solid var(--wp-surface-mute)',
};
