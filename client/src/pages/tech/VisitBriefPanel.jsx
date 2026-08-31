// Expanded Visit Brief for one stop on the tech route (TechHomePage
// StopRow accordion). Everything here is READ-ONLY display of data the
// server already derived:
//   - day-payload row fields (phone, address, alerts, line-scoped
//     last-visit previews, prepaid, billingLane.prediction)
//   - GET /admin/schedule/:id/estimate-source  → the Quoted section
//   - GET /admin/schedule/:id/visit-brief      → access codes + history
//     (LLM prose only when GATE_PREVISIT_BRIEF serves a brief; the
//     deterministic `facts` block when GATE_VISIT_FACTS is on; silent
//     degrade to day-row alerts alone when both are dark)
// Grouped stops fetch and render PER MEMBER: siblings keep their own
// line-scoped history, billing lanes, and possibly separate estimate
// provenance — the panel dedupes what is genuinely shared (property
// access, an estimate both lines came from) and shows the rest per
// service. Money labels are deliberately distinct — Quoted / Paid ·
// prepaid / Amount due today — and never show a catalog price. Checkout
// math stays in MobileCheckoutSheet; this panel displays, checkout
// charges.
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

// Member service-type sub-label inside a section, shown only on grouped
// stops where per-member blocks need telling apart.
function MemberLabel({ service, show }) {
  if (!show) return null;
  return (
    <p style={{ ...factMutedStyle, margin: '6px 0 0' }}>
      {service.serviceType || service.service_type || 'Service'}
    </p>
  );
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

function QuotedSection({ estimate }) {
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

// One member service's Paid · prepaid / Amount due today rows. Grouped
// stops render one block per member (siblings keep separate invoices and
// billing lanes — a prepaid primary must not hide a sibling's amount due).
function MemberMoney({ service, showType }) {
  const summary = visitMoneySummary(service);
  const prepaid = prepaidLine(service);
  const rows = [];
  if (prepaid || summary.invoice?.settled) {
    rows.push(['Paid · prepaid', prepaid || summary.note, null]);
  }
  if (summary.headline) {
    rows.push(['Amount due today', summary.headline, summary.collectNeeded ? DARK.amber : null]);
  }
  if (!rows.length) return null;
  return (
    <>
      <MemberLabel service={service} show={showType} />
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

function MoneySection({ stop, quotedTotal }) {
  const quoted = fmtMoney(quotedTotal);
  const memberHasMoney = stop.services.some((s) => {
    const m = visitMoneySummary(s);
    return m.headline || m.invoice || prepaidLine(s);
  });
  if (!quoted && !memberHasMoney) return null;
  return (
    <>
      <SectionLabel>Money</SectionLabel>
      {quoted && (
        <p style={factRowStyle}>
          <span style={{ color: DARK.muted }}>Quoted: </span>{quoted}
        </p>
      )}
      {stop.services.map((s) => (
        <MemberMoney key={s.id} service={s} showType={stop.services.length > 1} />
      ))}
    </>
  );
}

// The WDO pre-inspection brief (appointment-tagger's shape: risk_score,
// risk_reason, top_3_priorities, top_3_unknowns, vulnerabilities,
// homeowner_questions) — a different schema from the generic visit brief,
// rendered on its own so the guidance is not silently dropped.
function WdoBriefSection({ brief }) {
  const list = (v) => (Array.isArray(v) ? v : []).filter(Boolean);
  const priorities = list(brief.top_3_priorities);
  const unknowns = list(brief.top_3_unknowns);
  const vulnerabilities = list(brief.vulnerabilities);
  const questions = list(brief.homeowner_questions);
  if (!brief.risk_score && !priorities.length && !unknowns.length && !vulnerabilities.length && !questions.length) return null;
  return (
    <>
      <SectionLabel>WDO pre-inspection</SectionLabel>
      {brief.risk_score && (
        <p style={{ ...factRowStyle, fontWeight: 700 }}>
          Risk: {brief.risk_score}
          {brief.risk_reason ? <span style={{ color: DARK.muted, fontWeight: 400 }}> — {brief.risk_reason}</span> : null}
        </p>
      )}
      {priorities.map((p, i) => <p key={`p${i}`} style={factRowStyle}>• {p}</p>)}
      {vulnerabilities.map((v, i) => <p key={`v${i}`} style={{ ...factRowStyle, color: DARK.amber }}>• {v}</p>)}
      {unknowns.length > 0 && (
        <>
          <p style={{ ...factMutedStyle, marginTop: 6 }}>Unknowns:</p>
          {unknowns.map((u, i) => <p key={`u${i}`} style={factMutedStyle}>• {u}</p>)}
        </>
      )}
      {questions.length > 0 && (
        <>
          <p style={{ ...factMutedStyle, marginTop: 6 }}>Ask the homeowner:</p>
          {questions.map((q, i) => <p key={`q${i}`} style={factRowStyle}>• {q}</p>)}
        </>
      )}
    </>
  );
}

// One protocol-window / history product line — label facts only, exactly
// as the brief stored them.
function productLine(p) {
  const bits = [p?.name];
  if (p?.ratePer1000 != null && p?.rateUnit) bits.push(`${p.ratePer1000} ${p.rateUnit}/1000 sq ft`);
  else if (p?.rate != null && p?.rateUnit) bits.push(`${p.rate} ${p.rateUnit}`);
  if (p?.role) bits.push(p.role);
  return bits.filter(Boolean).join(' · ');
}

// The served generic visit brief's guidance the tech actually preps from:
// visit scope prose, customer context, and the deterministic product
// guidance (lawn protocol window with its fixed-vs-conditional split and
// protocol gates, or same-line product history + companion lines). The
// LLM never wrote the product lists — they render verbatim.
function BriefGuidanceSection({ brief, service, showType }) {
  if (!brief) return null;
  const guidance = brief.product_guidance || null;
  const lawn = guidance?.source === 'lawn_protocol_window' ? guidance : null;
  const historyProducts = guidance?.source === 'service_history' && Array.isArray(guidance.products)
    ? guidance.products.filter((p) => p?.name)
    : [];
  const companions = Array.isArray(guidance?.companions) ? guidance.companions : [];
  const fixed = lawn && Array.isArray(lawn.products) ? lawn.products.filter((p) => p?.name) : [];
  const conditional = lawn && Array.isArray(lawn.conditional_products) ? lawn.conditional_products.filter((p) => p?.name) : [];
  const protocolGates = lawn && Array.isArray(lawn.protocol_gates) ? lawn.protocol_gates.filter((g) => g?.title || g?.ruleText) : [];
  const hasContent = brief.open_scope || brief.customer_context
    || fixed.length || conditional.length || protocolGates.length
    || historyProducts.length || companions.length;
  if (!hasContent) return null;
  return (
    <>
      <SectionLabel>Visit guidance</SectionLabel>
      <MemberLabel service={service} show={showType} />
      {brief.open_scope && <p style={factRowStyle}>{brief.open_scope}</p>}
      {brief.customer_context && <p style={factMutedStyle}>{brief.customer_context}</p>}
      {lawn?.window && (
        <p style={{ ...factRowStyle, fontWeight: 600 }}>
          {lawn.window.title || 'Protocol window'}
          {lawn.window.goal ? <span style={{ color: DARK.muted, fontWeight: 400 }}> — {lawn.window.goal}</span> : null}
        </p>
      )}
      {protocolGates.map((g, i) => (
        <p key={`g${i}`} style={{ ...factRowStyle, color: DARK.amber }}>
          ⚠ {g.title || 'Protocol gate'}{g.ruleText ? ` — ${g.ruleText}` : ''}
        </p>
      ))}
      {fixed.map((p, i) => <p key={`f${i}`} style={factRowStyle}>• {productLine(p)}</p>)}
      {conditional.map((p, i) => (
        <p key={`c${i}`} style={factMutedStyle}>
          • {productLine(p)} — conditional{p.trigger ? `: ${p.trigger}` : ''}
        </p>
      ))}
      {historyProducts.length > 0 && (
        <p style={factRowStyle}>
          <span style={{ color: DARK.muted }}>Prior products: </span>
          {historyProducts.map((p) => p.name).join(', ')}
        </p>
      )}
      {companions.map((c, i) => (
        <p key={`co${i}`} style={factMutedStyle}>
          {String(c.line || 'companion').replace(/_/g, ' ')}: {(c.products || []).map((p) => p?.name).filter(Boolean).join(', ') || 'no prior products'}
        </p>
      ))}
    </>
  );
}

function LastVisitSection({ service, visitBrief, facts, showType }) {
  // Deterministic products from whichever source answered; LLM prose only
  // from a served brief. Day-row fallbacks use the LINE-SCOPED fields
  // only (lastLineService*): the any-line lastService* fields would label
  // another line's visit — a recent pest stop on a lawn visit — as this
  // stop's history.
  const briefLast = visitBrief?.last_visit || facts?.last_visit || null;
  const date = briefLast?.date || service.lastLineServiceDate || null;
  const type = briefLast?.type || service.lastLineServiceType || null;
  const notes = service.lastLineServiceNotes || null;
  const summary = visitBrief?.last_visit?.summary || null;
  const products = Array.isArray(briefLast?.products) ? briefLast.products : [];
  const priorities = Array.isArray(visitBrief?.priorities) ? visitBrief.priorities : [];
  const watchItems = Array.isArray(visitBrief?.watch_items) ? visitBrief.watch_items : [];
  if (!date && !notes && !products.length && !priorities.length && !watchItems.length) return null;
  return (
    <>
      <MemberLabel service={service} show={showType} />
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
  const grouped = stop.services.length > 1;
  const loading = detail?.status === 'loading';
  const failed = detail?.status === 'error';
  const byService = detail?.byService || {};

  // Per-member view of the two detail fetches. The endpoint serves briefs
  // of different SHAPES by type: the generic visit brief carries
  // access/last_visit/priorities/guidance; the WDO brief is the
  // pre-inspection schema and gets its own section — reading visit-brief
  // keys off it would silently drop all of its guidance.
  const memberBits = stop.services.map((s) => {
    const d = byService[s.id] || {};
    const briefType = d.brief?.type || null;
    const servedBrief = d.brief?.brief || null;
    const wdo = briefType === 'wdo_inspection' ? servedBrief : null;
    return {
      service: s,
      estimate: d.estimate || null,
      wdo,
      visitBrief: wdo ? null : servedBrief,
      facts: d.brief?.facts || null,
    };
  });
  // Property access is shared across the stop — first member that
  // answered carries it.
  const access = memberBits.map((m) => m.visitBrief?.access || m.facts?.access).find(Boolean) || null;
  // Estimates dedupe by id: siblings booked from ONE estimate render it
  // once; separately-quoted siblings each render their own.
  const estimates = [];
  for (const m of memberBits) {
    if (m.estimate?.linked && !estimates.some((e) => e.estimateId && e.estimateId === m.estimate.estimateId)) {
      estimates.push(m.estimate);
    }
  }
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

      {memberBits.map((m) => (m.wdo ? (
        <div key={`wdo-${m.service.id}`}>
          <WdoBriefSection brief={m.wdo} />
        </div>
      ) : null))}

      {loading && <p style={{ ...factMutedStyle, marginTop: 10 }}>Loading estimate & visit details…</p>}
      {estimates.map((est) => (
        <QuotedSection key={est.estimateId || est.estimateSlug || 'est'} estimate={est} />
      ))}

      {/* Quoted = only what a linked estimate proved — never a catalog
          price. The headline Quoted total renders only when the whole
          stop traces to ONE estimate; separately-quoted siblings keep
          their totals inside their own Quoted sections. */}
      <MoneySection stop={stop} quotedTotal={estimates.length === 1 ? estimates[0].quotedTotal : null} />

      {memberBits.some((m) => {
        const bl = m.visitBrief?.last_visit || m.facts?.last_visit;
        return bl || m.service.lastLineServiceDate || m.service.lastLineServiceNotes
          || (m.visitBrief?.priorities || []).length || (m.visitBrief?.watch_items || []).length;
      }) && (
        <>
          <SectionLabel>Last visit</SectionLabel>
          {memberBits.map((m) => (
            <LastVisitSection
              key={m.service.id}
              service={m.service}
              visitBrief={m.visitBrief}
              facts={m.facts}
              showType={grouped}
            />
          ))}
        </>
      )}

      {memberBits.map((m) => (
        <BriefGuidanceSection
          key={`guide-${m.service.id}`}
          brief={m.visitBrief}
          service={m.service}
          showType={grouped}
        />
      ))}

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
          showType={grouped}
          onPhotos={onPhotos}
          onProject={onProject}
          onZone={onZone}
          onLead={onLead}
        />
      ))}
    </div>
  );
}
