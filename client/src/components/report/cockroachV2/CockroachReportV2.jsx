// Cockroach Report V2 — the one-time cockroach TREATMENT PROGRAM dashboard.
// Same glass card language as termite bait V2 / recurring pest V2 (owner
// 2026-08-29: "glass UI look, same as termite bait, recurring pest"): white
// glass cards, navy ink, uppercase eyebrows, one hero. Every sentence here
// comes from the server builder (cockroach-report-v2.js) — this file lays
// out, it does not compose copy.
import { COLORS } from '../../../theme-brand';
import { CUSTOMER_SURFACE } from '../../../theme-customer';
import Icon from '../../Icon';

const TEXT = 'var(--text)';
const MUTED = 'var(--muted)';
const BORDER = CUSTOMER_SURFACE.border;
const CARD = COLORS.white;

export const COCKROACH_V2_DASHBOARD_FIELD_KEYS = new Set([
  'species',
  'activity_level',
  'activity_locations',
  'evidence_observed',
  'conducive_conditions',
  'work_completed',
  'customer_prep',
]);

const TONE = {
  good: { color: COLORS.glassNavy, wash: 'rgba(4, 57, 94, 0.08)', border: 'rgba(4, 57, 94, 0.35)' },
  watch: { color: COLORS.glassNavy, wash: 'rgba(4, 57, 94, 0.08)', border: 'rgba(4, 57, 94, 0.38)' },
};
function tone(key) { return TONE[key] || TONE.watch; }

const card = {
  background: CARD,
  border: `1px solid ${BORDER}`,
  borderRadius: 16,
  padding: '24px 24px',
  marginBottom: 20,
};
const eyebrow = {
  fontSize: 14,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: MUTED,
  fontWeight: 700,
  marginBottom: 8,
};
const chip = {
  display: 'inline-block',
  background: 'rgba(4, 57, 94, 0.07)',
  color: COLORS.glassNavy,
  borderRadius: 999,
  padding: '4px 10px',
  fontSize: 14,
  fontWeight: 600,
};

export function activityTrendLine(activity) {
  if (!activity || activity.score == null) return null;
  if (activity.isBaseline) return 'Baseline recorded today — trend starts at your next treatment.';
  if (activity.trendWord) return `Roach activity has ${String(activity.trendWord).replace(/\.$/, '')}.`;
  return null;
}

// ── 1. Today's result ─────────────────────────────────────────────────────────
export function CockroachStatusHero({ status, statusSummary, metrics, narrative = null, activityTrend = null, program = null }) {
  if (!status) return null;
  const t = tone(status.tone);
  // The headline already carries the comparison on a trend visit
  // (improving / worsening / stable) — the sentence stays for the baseline
  // and the plain-level cases only (codex P2 #3613 r4).
  const trendLine = ['improving', 'worsening', 'stable'].includes(status.key) ? null : activityTrendLine(activityTrend);
  const position = program?.treatmentNumber
    ? ` · Treatment ${program.treatmentNumber}${program.treatmentsTotal ? ` of ${program.treatmentsTotal}` : ''}`
    : '';
  return (
    <section data-glass="card" style={{ ...card, borderColor: t.border, background: `linear-gradient(180deg, ${t.wash}, ${CARD} 60%)` }}>
      <div style={eyebrow}>Today&apos;s result{position}</div>
      <h2 style={{ margin: 0, fontSize: 22, lineHeight: 1.25, color: TEXT }}>{status.label}</h2>
      {statusSummary ? (
        <p style={{ margin: '10px 0 0', fontSize: 15, lineHeight: 1.55, color: TEXT }}>{statusSummary}</p>
      ) : null}
      {narrative && narrative !== statusSummary ? (
        <p className="ai-summary-body" style={{ margin: '12px 0 0', fontSize: 14, lineHeight: 1.5, color: MUTED }}>{narrative}</p>
      ) : null}
      {trendLine ? (
        <p style={{ margin: '10px 0 0', fontSize: 14, color: MUTED }}>{trendLine}</p>
      ) : null}
      {Array.isArray(metrics) && metrics.length ? (
        <div style={{ marginTop: 16, display: 'grid', gap: 6 }}>
          {metrics.map((m) => (
            <div key={m.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 14, borderTop: `1px solid ${BORDER}`, paddingTop: 6 }}>
              <span style={{ color: MUTED }}>{m.label}</span>
              <span style={{ color: t.color, fontWeight: 700 }}>{m.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ── 2. Where we found activity ────────────────────────────────────────────────
// Rooms and areas from the tech's location chips; evidence and conducive
// conditions are recorded once for the visit (the form does not tie them
// to a room), so they print once, never per room.
export function CockroachWhereFound({ locations = [], evidence = [], conditions = [], statusKey = null }) {
  if (!locations.length && !evidence.length && !conditions.length) return null;
  const clear = statusKey === 'clear';
  return (
    <section data-glass="card" style={card}>
      <div style={eyebrow}>{clear ? 'Where we inspected' : 'Where we found activity'}</div>
      {locations.length ? (
        <div style={{ display: 'grid', gap: 0 }}>
          {locations.map((loc, i) => (
            <div key={loc} style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 10, alignItems: 'start', padding: '10px 0', borderTop: i === 0 ? 'none' : `1px solid ${BORDER}` }}>
              <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: '50%', marginTop: 5, background: clear ? 'transparent' : COLORS.glassNavy, border: clear ? `2px solid ${COLORS.glassNavy}` : 'none', boxShadow: clear ? 'none' : '0 0 0 4px rgba(4, 57, 94, 0.12)' }} />
              <div style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>{loc}</div>
            </div>
          ))}
        </div>
      ) : null}
      {evidence.length ? (
        <div style={{ marginTop: locations.length ? 12 : 0 }}>
          <div style={{ ...eyebrow, fontSize: 14, marginBottom: 6 }}>Evidence observed</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {evidence.map((e) => <span key={e} style={chip}>{e}</span>)}
          </div>
        </div>
      ) : null}
      {conditions.length ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...eyebrow, fontSize: 14, marginBottom: 6 }}>Conditions that attract roaches</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {conditions.map((c) => <span key={c} style={chip}>{c}</span>)}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── 3. What we did today ──────────────────────────────────────────────────────
export function CockroachWorkDone({ work = [] }) {
  if (!work.length) return null;
  return (
    <section data-glass="card" style={card}>
      <div style={eyebrow}>What we did today</div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
        {work.map((w) => (
          <li key={w.key || w.title} style={{ display: 'grid', gridTemplateColumns: '26px 1fr', gap: 10, alignItems: 'start' }}>
            <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: 8, background: 'rgba(4, 57, 94, 0.08)', display: 'grid', placeItems: 'center', fontSize: 14, fontWeight: 700, color: COLORS.glassNavy }}>
              {String(w.short || w.title || '?').charAt(0).toUpperCase()}
            </span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>{w.title}</div>
              {w.detail ? <div style={{ fontSize: 14, color: MUTED, marginTop: 2 }}>{w.detail}</div> : null}
            </div>
          </li>
        ))}
      </ul>
      <p style={{ margin: '12px 0 0', fontSize: 14, color: MUTED }}>Product names, EPA registrations and re-entry guidance are listed under Products applied below.</p>
    </section>
  );
}

// ── 4. How you can help ───────────────────────────────────────────────────────
export function CockroachHowToHelp({ help = null }) {
  const items = Array.isArray(help?.items) ? help.items : [];
  if (!items.length && !help?.why) return null;
  return (
    <section data-glass="card" style={card}>
      <div style={eyebrow}>How you can help the treatment work</div>
      {items.length ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
          {items.map((item) => (
            <li key={item.key || item.text} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 10, fontSize: 15, lineHeight: 1.5, color: TEXT }}>
              <span aria-hidden="true" style={{ color: '#1f7a4d', display: 'inline-flex' }}><Icon name="check" size={16} strokeWidth={2.5} /></span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {help?.why ? (
        <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 12, background: 'rgba(201, 150, 43, 0.14)', border: '1px solid rgba(201, 150, 43, 0.35)', fontSize: 14, lineHeight: 1.5, color: TEXT }}>
          {help.why}
        </div>
      ) : null}
    </section>
  );
}

// ── 5. Your cockroach treatment program (what happens next) ──────────────────
// One eyebrow per card, then bold-title + muted-detail rows — the same
// rhythm as "What we did today" (owner eyeball 2026-08-29: stacked
// eyebrow labels inside the card read off from the rest of the page).
export function CockroachProgram({ whatsNext = null, nextVisitLabel = null }) {
  if (!whatsNext) return null;
  const complete = whatsNext.badge === 'COMPLETE';
  return (
    <section data-glass="card" style={{ ...card, borderColor: 'rgba(4, 57, 94, 0.35)', background: `linear-gradient(180deg, rgba(4, 57, 94, 0.06), ${CARD} 55%)` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={eyebrow}>Your cockroach treatment program</div>
          <h3 style={{ margin: 0, fontSize: 17, lineHeight: 1.3, color: TEXT }}>{whatsNext.title}</h3>
        </div>
        {whatsNext.badge ? (
          <span style={{ background: complete ? 'rgba(4, 57, 94, 0.10)' : COLORS.glassNavy, color: complete ? COLORS.glassNavy : '#fff', borderRadius: 999, padding: '4px 12px', fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', flex: '0 0 auto', marginTop: 2 }}>
            {whatsNext.badge}
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
        {(whatsNext.lines || []).map((line, i) => {
          const isDate = line.kind === 'next_visit';
          if (isDate && !nextVisitLabel) return null;
          return (
            <div key={`${i}-${line.label}`} style={{ borderTop: i === 0 ? 'none' : `1px solid ${BORDER}`, paddingTop: i === 0 ? 0 : 12 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>
                {line.label}{isDate ? ` — ${nextVisitLabel}` : ''}
              </div>
              {!isDate && line.text ? (
                <div style={{ fontSize: 14, lineHeight: 1.5, color: MUTED, marginTop: 2 }}>{line.text}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
