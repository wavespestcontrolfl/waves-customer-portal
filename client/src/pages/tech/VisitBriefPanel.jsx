// Expanded Visit Brief for one stop on the tech route (TechHomePage
// StopRow accordion). Everything here is READ-ONLY display of data the
// server already derived:
//   - day-payload row fields (phone, address, alerts, last-visit previews,
//     prepaid, billingLane.prediction)
//   - GET /admin/schedule/:id/estimate-source  → the Quoted section
//   - GET /admin/schedule/:id/visit-brief      → access codes + history
//     (LLM prose only when GATE_PREVISIT_BRIEF serves a brief; the
//     deterministic `facts` block when GATE_VISIT_FACTS is on; silent
//     degrade to day-row alerts alone when both are dark)
// Money labels are deliberately distinct — Quoted / Paid · prepaid /
// Amount due today — and never show a catalog price. Checkout math stays
// in MobileCheckoutSheet; this panel displays, checkout charges.
//
// Tech portal style rule (CLAUDE.md): inline styles + dark palette,
// Montserrat headings per-element. No Tailwind, no components/ui.
import { stopPropertyAlerts } from './routeStops';
import {
  fmtMoney,
  prepaidLine,
  quotedLineLabel,
  smsHref,
  telHref,
  visitMoneySummary,
} from './visitBrief';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  amber: '#f59e0b',
  red: '#ef4444',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

const sectionLabelStyle = {
  fontSize: 12,
  fontWeight: 700,
  color: DARK.muted,
  textTransform: 'uppercase',
  letterSpacing: 1,
  margin: '14px 0 6px',
  fontFamily: "'Montserrat', sans-serif",
};

const factRowStyle = { fontSize: 14, color: DARK.text, margin: '3px 0 0' };
const factMutedStyle = { fontSize: 14, color: DARK.muted, margin: '3px 0 0' };

function SectionLabel({ children }) {
  return <div style={sectionLabelStyle}>{children}</div>;
}

// tel:/sms: anchors styled like ActionBtn — real links so iOS hands them
// to the dialer/Messages without a tap-through.
function LinkBtn({ href, icon, label, onClick }) {
  const base = {
    flex: 1,
    padding: '10px 4px',
    borderRadius: 8,
    border: `1px solid ${DARK.border}`,
    background: 'transparent',
    color: DARK.text,
    fontSize: 13,
    fontWeight: 600,
    textDecoration: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    cursor: 'pointer',
  };
  if (href) {
    return <a href={href} style={base}><span style={{ fontSize: 15 }}>{icon}</span> {label}</a>;
  }
  return (
    <button type="button" onClick={onClick} style={base}>
      <span style={{ fontSize: 15 }}>{icon}</span> {label}
    </button>
  );
}

// The exact code rows the day payload never carries (redacted there by
// design) — only non-null codes render.
const CODE_LABELS = [
  ['neighborhoodGate', 'Neighborhood gate'],
  ['propertyGate', 'Property gate'],
  ['garage', 'Garage'],
  ['lockbox', 'Lockbox'],
];

function AccessSection({ alerts, access }) {
  const codeRows = access
    ? CODE_LABELS.map(([key, label]) => (access.codes?.[key] ? [label, access.codes[key]] : null)).filter(Boolean)
    : [];
  const noteRows = access
    ? [
      access.pets ? ['Pets', access.pets] : null,
      access.petsSecuredPlan ? ['Pets secured', access.petsSecuredPlan] : null,
      access.chemicalSensitivities ? ['Chemical sensitivity', access.chemicalSensitivities] : null,
      access.parkingNotes ? ['Parking', access.parkingNotes] : null,
      access.accessNotes ? ['Access', access.accessNotes] : null,
      access.specialInstructions ? ['Instructions', access.specialInstructions] : null,
    ].filter(Boolean)
    : [];
  if (!alerts.length && !codeRows.length && !noteRows.length) return null;
  return (
    <>
      <SectionLabel>Access</SectionLabel>
      {alerts.map((a, i) => {
        const text = typeof a === 'string' ? a : a?.text;
        if (!text) return null;
        const accent = a?.type === 'chemical' ? DARK.red : a?.type === 'no_card_on_file' ? DARK.amber : null;
        return (
          <div key={i} style={{
            fontSize: 14,
            color: accent || DARK.text,
            fontWeight: a?.type === 'no_card_on_file' ? 600 : undefined,
            marginBottom: 3,
            paddingLeft: 8,
            borderLeft: `2px solid ${accent || DARK.teal}`,
          }}>
            {text}
          </div>
        );
      })}
      {codeRows.map(([label, code]) => (
        <p key={label} style={factRowStyle}>
          <span style={{ color: DARK.muted }}>{label}: </span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{code}</span>
        </p>
      ))}
      {noteRows.map(([label, value]) => (
        <p key={label} style={factRowStyle}>
          <span style={{ color: DARK.muted }}>{label}: </span>{value}
        </p>
      ))}
    </>
  );
}

function QuotedSection({ estimate, loading }) {
  if (loading) {
    return (
      <>
        <SectionLabel>Quoted</SectionLabel>
        <p style={factMutedStyle}>Loading estimate…</p>
      </>
    );
  }
  if (!estimate?.linked) return null;
  const lines = Array.isArray(estimate.lines) ? estimate.lines : [];
  const deposit = estimate.deposit || null;
  const payment = estimate.payment || null;
  return (
    <>
      <SectionLabel>Quoted{estimate.estimateSlug ? ` · ${estimate.estimateSlug}` : ''}</SectionLabel>
      {lines.map((line, i) => {
        const label = quotedLineLabel(line);
        return (
          <p key={i} style={factRowStyle}>
            {line.estimateLabel || line.name || 'Service'}
            {label ? <span style={{ color: DARK.teal, fontWeight: 600 }}> — {label}</span> : null}
          </p>
        );
      })}
      {deposit?.payerBilled && (
        <p style={{ ...factRowStyle, color: DARK.amber, fontWeight: 600 }}>
          Bills to a payer — do not collect from the homeowner.
        </p>
      )}
      {Number(deposit?.paid) > 0 && (
        <p style={factRowStyle}>
          Deposit paid {fmtMoney(deposit.paid)}
          {Number(deposit.creditRemaining) > 0 ? ` · ${fmtMoney(deposit.creditRemaining)} credit remaining` : ''}
        </p>
      )}
      {deposit?.required && !(Number(deposit?.paid) > 0) && (
        <p style={{ ...factRowStyle, color: DARK.amber }}>
          Deposit required{Number(deposit.policyAmount) > 0 ? ` (${fmtMoney(deposit.policyAmount)})` : ''}
        </p>
      )}
      {payment?.annualPrepay && <p style={factRowStyle}>Annual prepay plan</p>}
      {payment?.billingTerm && !payment?.annualPrepay && (
        <p style={factMutedStyle}>Billing: {String(payment.billingTerm).replace(/_/g, ' ')}</p>
      )}
    </>
  );
}

function MoneySection({ service, quotedTotal }) {
  const summary = visitMoneySummary(service);
  const prepaid = prepaidLine(service);
  const rows = [];
  const quoted = fmtMoney(quotedTotal);
  if (quoted) rows.push(['Quoted', quoted, null]);
  if (prepaid || summary.invoice?.settled) {
    rows.push(['Paid · prepaid', prepaid || summary.note, null]);
  }
  if (summary.headline) {
    rows.push(['Amount due today', summary.headline, summary.collectNeeded ? DARK.amber : null]);
  }
  if (!rows.length) return null;
  return (
    <>
      <SectionLabel>Money</SectionLabel>
      {rows.map(([label, value, accent]) => (
        <p key={label} style={{ ...factRowStyle, color: accent || DARK.text, fontWeight: accent ? 700 : undefined }}>
          <span style={{ color: DARK.muted, fontWeight: 400 }}>{label}: </span>{value}
        </p>
      ))}
      {summary.invoice && !summary.invoice.settled && summary.note && (
        <p style={factMutedStyle}>{summary.note}</p>
      )}
      {(summary.invoice?.lines || []).map((li, i) => (
        <p key={i} style={factMutedStyle}>• {li.description} — {fmtMoney(li.amount)}</p>
      ))}
    </>
  );
}

function LastVisitSection({ service, servedBrief, facts }) {
  // Deterministic products from whichever source answered; LLM prose only
  // from a served brief.
  const briefLast = servedBrief?.last_visit || facts?.last_visit || null;
  const date = briefLast?.date || service.lastServiceDate || null;
  const type = briefLast?.type || service.lastServiceType || null;
  const notes = service.lastServiceNotes || service.lastLineServiceNotes || null;
  const summary = servedBrief?.last_visit?.summary || null;
  const products = Array.isArray(briefLast?.products) ? briefLast.products : [];
  const priorities = Array.isArray(servedBrief?.priorities) ? servedBrief.priorities : [];
  const watchItems = Array.isArray(servedBrief?.watch_items) ? servedBrief.watch_items : [];
  if (!date && !notes && !products.length && !priorities.length && !watchItems.length) return null;
  return (
    <>
      <SectionLabel>Last visit</SectionLabel>
      {date && (
        <p style={factRowStyle}>
          {String(date).slice(0, 10)}{type ? ` · ${type}` : ''}
        </p>
      )}
      {summary && <p style={factRowStyle}>{summary}</p>}
      {!summary && notes && <p style={factMutedStyle}>{notes}</p>}
      {products.length > 0 && (
        <p style={factRowStyle}>
          <span style={{ color: DARK.muted }}>Products: </span>
          {products.map((p) => p?.name).filter(Boolean).join(', ')}
        </p>
      )}
      {priorities.map((p, i) => <p key={`p${i}`} style={factRowStyle}>• {p}</p>)}
      {watchItems.map((w, i) => <p key={`w${i}`} style={{ ...factRowStyle, color: DARK.amber }}>• {w}</p>)}
    </>
  );
}

// The pre-existing per-service action buttons, moved verbatim from the
// old ServiceRow (labels + terminal logic + trace-eligibility guard
// unchanged) — one row per member service on a grouped stop.
function ServiceActions({ service, showType, onPhotos, onProject, onZone, onLead }) {
  const btn = {
    padding: '8px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
    border: `1px solid ${DARK.border}`, background: 'transparent',
    color: DARK.teal, cursor: 'pointer',
  };
  return (
    <div style={{ marginTop: 8 }}>
      {showType && (
        <p style={{ ...factMutedStyle, margin: '0 0 4px' }}>
          {service.serviceType || service.service_type || 'Service'}
        </p>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={() => onProject(service)} style={btn}>
          {/* A visit with an existing linked report continues it (in-place
              editor) instead of creating a duplicate; a sent/closed report
              or completed visit is terminal (openProjectOrContinue no-ops). */}
          {service.linkedProject?.status === 'sent'
            ? '🗂️ Sent'
            : service.linkedProject?.status === 'closed' || service.status === 'completed'
              ? '🗂️ Completed'
              : service.linkedProject?.id ? '🗂️ Continue' : '🗂️ Report'}
        </button>
        <button onClick={() => onPhotos(service)} style={btn}>📷 Photos</button>
        {/* Hidden when the schedule feed marks the service trace-ineligible
            (GATE_TRACE_ELIGIBILITY): nothing is sprayed on bait/trapping/
            inspection stops. Absent flag keeps the button — the write route
            enforces the same registry either way. */}
        {service.traceEligible !== false && (
          <button onClick={() => onZone(service)} aria-label="Trace treatment zone" style={btn}>🛰️ Zone</button>
        )}
        <button onClick={() => onLead(service)} aria-label="Flag opportunity" style={{ ...btn, color: DARK.amber }}>🚩</button>
      </div>
    </div>
  );
}

export default function VisitBriefPanel({ stop, detail, onRetry, onPhotos, onProject, onZone, onLead }) {
  const service = stop.primary;
  const phone = service.customerPhone || service.customer_phone || null;
  const address = service.address || null;
  const alerts = stopPropertyAlerts(stop);
  const loading = detail?.status === 'loading';
  const failed = detail?.status === 'error';
  const estimate = detail?.estimate || null;
  const servedBrief = detail?.brief?.brief || null;
  const facts = detail?.brief?.facts || null;
  const access = servedBrief?.access || facts?.access || null;
  const tel = telHref(phone);
  const sms = smsHref(phone);

  return (
    <div data-testid="visit-brief-panel" style={{ borderTop: `1px solid ${DARK.border}`, marginTop: 10, paddingTop: 10 }}>
      {(tel || sms || address) && (
        <div style={{ display: 'flex', gap: 8 }}>
          {tel && <LinkBtn href={tel} icon="📞" label="Call" />}
          {sms && <LinkBtn href={sms} icon="💬" label="Text" />}
          {address && (
            <LinkBtn
              icon="🗺️"
              label="Navigate"
              onClick={() => window.open(`https://maps.google.com/?q=${encodeURIComponent(address)}`, '_blank')}
            />
          )}
        </div>
      )}
      {address && <p style={{ ...factMutedStyle, marginTop: 8 }}>{address}</p>}

      <AccessSection alerts={alerts} access={access} />

      <QuotedSection estimate={estimate} loading={loading} />

      {/* Quoted = only what the linked estimate proved — a visit with no
          estimate shows no Quoted row (never a catalog/current price). */}
      <MoneySection service={service} quotedTotal={estimate?.linked ? estimate.quotedTotal : null} />

      <LastVisitSection service={service} servedBrief={servedBrief} facts={facts} />

      {failed && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={onRetry}
            style={{
              border: `1px solid ${DARK.border}`, background: 'transparent', color: DARK.muted,
              borderRadius: 6, padding: '6px 10px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Couldn't load estimate & access details — retry
          </button>
        </div>
      )}

      <SectionLabel>Actions</SectionLabel>
      {stop.services.map((s) => (
        <ServiceActions
          key={s.id}
          service={s}
          showType={stop.services.length > 1}
          onPhotos={onPhotos}
          onProject={onProject}
          onZone={onZone}
          onLead={onLead}
        />
      ))}
    </div>
  );
}
