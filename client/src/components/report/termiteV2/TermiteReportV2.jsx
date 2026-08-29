// Termite Report V2 — customer-facing, station-protection visual layer.
//
// Presentational components ONLY, driven by the `termiteReportV2` payload key
// (server/services/service-report/termite-report-v2.js) plus the shared
// stationMap payload. Same card geometry, status tones, and customer-surface
// warm tokens as the pest/mosquito V2 layers (NOT admin monochrome).
//
// Composition principle (owner 2026-08-29): the customer answers four
// questions immediately — Did you inspect my whole system? Did you find
// activity? What did you do about it? What happens next? — and exceptions
// come first, complete record second.
//
// Honest-copy: every number comes from documented station counts; absence
// claims stay scoped to stations inspected today ("No termite activity
// observed", never "no termites found" / "termite free"). The section
// renders nothing when its payload is absent (flag off / not a bait visit).
import { useState } from 'react';
import { COLORS } from '../../../theme-brand';
import { CUSTOMER_SURFACE } from '../../../theme-customer';

// ── Surface tokens (shared with the pest / mosquito V2 surface) ─────────────────
const TEXT = 'var(--text)';
const MUTED = 'var(--muted)';
const BORDER = CUSTOMER_SURFACE.border;
const CARD = COLORS.white;

// Typed findings the dashboard already renders (hero counts, activity state,
// bait consumption, location). Every OTHER typed field — activity signs,
// bait/station issues and actions, conducive conditions, the full
// recommendation list — still prints in the typed findings card, so a
// flooded station or a cartridge replacement never drops out of the customer
// record when the dashboard mounts (codex P1 #3600 r1).
export const TERMITE_V2_DASHBOARD_FIELD_KEYS = new Set([
  'total_stations',
  'stations_checked',
  'stations_inaccessible',
  'stations_with_activity',
  'termite_activity',
  'active_station_location',
  'bait_consumption',
]);

// Status tone → accent + soft wash (same triad as pest/mosquito V2 — one family).
const TONE = {
  good: { color: COLORS.glassNavy, wash: 'rgba(4, 57, 94, 0.08)', border: 'rgba(4, 57, 94, 0.35)' },
  watch: { color: COLORS.glassNavy, wash: 'rgba(4, 57, 94, 0.08)', border: 'rgba(4, 57, 94, 0.38)' },
  attention: { color: COLORS.red, wash: 'rgba(200, 16, 46, 0.06)', border: 'rgba(200, 16, 46, 0.3)' },
};
function tone(key) { return TONE[key] || TONE.watch; }

// Geometry matches the report's .sr-section cards (24px padding, 20px rhythm).
const card = {
  background: CARD,
  border: `1px solid ${BORDER}`,
  borderRadius: 16,
  padding: '24px 24px',
  marginBottom: 20,
};
// 14px minimum on every customer surface (AGENTS.md) — eyebrows and
// metadata included.
const eyebrow = {
  fontSize: 14,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: MUTED,
  fontWeight: 700,
  marginBottom: 8,
};

// ── 1. Today's result: headline · body · three metrics ─────────────────────────
// `narrative` = the tech-reviewed body (payload aiSummary.body), already
// cleaned by the page the same way the typed Today's Result card cleans it.
// Cross-visit trend sentence from the activity gauge payload — the stored
// trendWord already carries the interval ("increased since the last visit",
// trendWordForScores), so it renders verbatim exactly as ActivityCard does;
// baseline visits claim no trend.
export function activityTrendLine(activity) {
  if (!activity || activity.score == null) return null;
  if (activity.isBaseline) return 'Baseline recorded today — trend starts next visit.';
  if (activity.trendWord) return `Termite activity has ${String(activity.trendWord).replace(/\.$/, '')}.`;
  return null;
}

export function TermiteStatusHero({ status, statusSummary, metrics, narrative = null, activityTrend = null, visitSequence = 1 }) {
  if (!status) return null;
  const t = tone(status.tone);
  const trendLine = activityTrendLine(activityTrend);
  return (
    <section data-glass="card" style={{ ...card, borderColor: t.border, background: `linear-gradient(180deg, ${t.wash}, ${CARD} 60%)` }}>
      <div style={eyebrow}>
        Today&apos;s result
        {visitSequence > 1 ? ` · Visit ${visitSequence}` : ''}
      </div>
      <h2 style={{ margin: 0, fontSize: 22, lineHeight: 1.25, color: TEXT }}>{status.label}</h2>
      {statusSummary ? (
        <p style={{ margin: '10px 0 0', fontSize: 15, lineHeight: 1.55, color: TEXT }}>{statusSummary}</p>
      ) : null}
      {narrative ? (
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

// ── 2. Station details: exceptions first, complete record second ──────────────
// ONE card (owner 2026-08-29 — the separate "Needs attention" list restated
// the same stations the record listed right below it). Exception stations
// (activity / inaccessible) render as full rows at the top with what we did
// and what happens next; the normal stations collapse into a one-line count
// with "View all stations". If 20 stations are perfect and two aren't, the
// homeowner never scans 22 rows to find out. Renders no exception block on a
// clean visit.
export function stationExceptions(stationMap) {
  const stations = Array.isArray(stationMap?.stations) ? stationMap.stations : [];
  return stations.filter((st) => st.status === 'activity' || st.status === 'inaccessible');
}

// Dot colors mirror the map legend (waves navy checked/serviced with gold
// ring on serviced, red activity, gray inaccessible) so the record and the
// map read as one system.
const RECORD_LINES = {
  ok: { color: COLORS.glassNavy, text: 'Checked · No activity observed' },
  serviced: { color: COLORS.glassNavy, ring: '#FFD700', text: 'Checked · Serviced this visit' },
  activity: { color: COLORS.red, text: 'Termite activity observed' },
  inaccessible: { color: '#9CA3AF', text: 'Not accessible this visit' },
};

function stationTitle(st) {
  return `Station ${st.number}${st.label ? ` · ${st.label}` : ''}`;
}

export function TermiteStationRecord({ stationMap }) {
  const [expanded, setExpanded] = useState(false);
  const stations = Array.isArray(stationMap?.stations) ? stationMap.stations : [];
  if (!stations.length) return null;
  const exceptions = stationExceptions(stationMap);
  const checked = stations.filter((st) => st.status === 'ok' || st.status === 'serviced');
  // Historical / fail-soft reports carry registry pins with NO status
  // (termite-stations.js falls back to the registry when a visit has no
  // check rows). Those are "on file", never "checked — no activity"
  // (codex P2 #3600 r1).
  const onFile = stations.filter((st) => !exceptions.includes(st) && !checked.includes(st));

  const exceptionRow = (st) => (
    <div
      key={st.id}
      style={{
        borderLeft: `3px solid ${st.status === 'activity' ? COLORS.red : COLORS.glassNavy}`,
        background: st.status === 'activity' ? 'rgba(200, 16, 46, 0.04)' : 'rgba(4, 57, 94, 0.04)',
        borderRadius: '0 12px 12px 0',
        padding: '10px 14px',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.glassNavy }}>{stationTitle(st)}</div>
      <div style={{ fontSize: 14, lineHeight: 1.6, color: TEXT, marginTop: 2 }}>
        {/* Servicing is a visit-level fact (a pin is activity OR serviced,
            never both) — the hero body carries it; no per-station claim. */}
        {st.status === 'activity' ? (
          <>
            <div>Termite activity observed</div>
            <div style={{ color: MUTED }}>Monitoring continues</div>
          </>
        ) : (
          <>
            <div>Could not be accessed this visit</div>
            <div style={{ color: MUTED }}>Will be checked next visit</div>
          </>
        )}
      </div>
    </div>
  );

  const plainRow = (st) => {
    const line = RECORD_LINES[st.status] || { color: '#64748B', text: 'On file · Not checked this visit' };
    return (
      <div key={st.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderTop: `1px solid ${BORDER}` }}>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            flex: '0 0 auto',
            marginTop: 5,
            background: line.color,
            boxShadow: line.ring ? `0 0 0 2px ${line.ring}` : 'none',
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>{stationTitle(st)}</div>
          <div style={{ fontSize: 14, lineHeight: 1.45, color: MUTED }}>{line.text}</div>
        </div>
      </div>
    );
  };

  const collapsed = [...checked, ...onFile];
  // Only 'ok' pins support an absence statement; a serviced pin may be the
  // very station the hero reports activity at (statuses are mutually
  // exclusive), so serviced pins get count-neutral service wording
  // (codex P2 #3600 r28).
  const clean = checked.filter((st) => st.status === 'ok');
  const serviced = checked.filter((st) => st.status === 'serviced');
  const summaryParts = [];
  if (clean.length) {
    // "All" only when every station on the visit was checked clean — never
    // beside exceptions, serviced, OR on-file (unchecked) stations
    // (codex P2 #3600 r17).
    const every = !exceptions.length && !onFile.length && !serviced.length;
    summaryParts.push(`${every ? 'All ' : ''}${clean.length} ${exceptions.length || serviced.length ? 'other ' : ''}station${clean.length === 1 ? '' : 's'} checked — no activity observed`);
  }
  if (serviced.length) {
    summaryParts.push(`${serviced.length} station${serviced.length === 1 ? '' : 's'} serviced this visit`);
  }
  if (onFile.length) {
    summaryParts.push(`${onFile.length} station${onFile.length === 1 ? '' : 's'} on file — not checked this visit`);
  }
  const summary = summaryParts.join(' · ');

  return (
    <section data-glass="card" style={card}>
      <div style={eyebrow}>Station details</div>
      {exceptions.length ? (
        <>
          <div style={{ fontSize: 15, fontWeight: 700, color: TEXT, marginBottom: 10 }}>Needs attention</div>
          <div style={{ display: 'grid', gap: 12 }}>{exceptions.map(exceptionRow)}</div>
        </>
      ) : null}
      {collapsed.length > 0 ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, paddingTop: exceptions.length ? 14 : 0, marginTop: exceptions.length ? 14 : 0, borderTop: exceptions.length ? `1px solid ${BORDER}` : 'none' }}>
          <span style={{ fontSize: 14, color: MUTED }}>{summary}</span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 14, fontWeight: 700, color: COLORS.glassNavy, cursor: 'pointer', flex: '0 0 auto' }}
          >
            {expanded ? 'Hide stations' : 'View all stations'}
          </button>
        </div>
      ) : null}
      {expanded ? <div style={{ marginTop: 8 }}>{collapsed.map(plainRow)}</div> : null}
    </section>
  );
}

// ── Partial station sync: honest placeholder for the map + station rows ───────
export function TermiteStationSyncNote() {
  return (
    <section data-glass="card" style={card}>
      <div style={eyebrow}>Station details</div>
      {/* Durable wording — a skipped station check has no retry path, so
          this note may stand for the life of the report (codex P2 r23). */}
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: MUTED }}>
        A station-by-station map isn&apos;t available for this visit: one or
        more station checks did not match your technician&apos;s record. The
        counts above come from that record.
      </p>
    </section>
  );
}

// ── What happens next: the tech's required next-step commitment ───────────────
// Every termite_bait_station completion records a next step (activity-
// indicators REQUIRED_NEXT_STEP_TYPES). The dashboard replaces the typed
// Today's Result card that used to print it, so it prints it here.
export function TermiteWhatsNext({ nextStep }) {
  if (!nextStep) return null;
  return (
    <section data-glass="card" style={card}>
      <div style={eyebrow}>What happens next</div>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: TEXT }}>{nextStep}</p>
    </section>
  );
}

// ── Your one move: the tech's top customer recommendation ──────────────────────
export function TermiteNextStep({ primaryMove }) {
  if (!primaryMove) return null;
  return (
    <section data-glass="card" style={card}>
      <div style={eyebrow}>Your one move</div>
      <h3 style={{ margin: 0, fontSize: 17, lineHeight: 1.3, color: TEXT }}>{primaryMove.title}</h3>
      {primaryMove.why ? (
        <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: TEXT }}>{primaryMove.why}</p>
      ) : null}
      <div style={{ marginTop: 12, display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 14, color: MUTED }}>
        {primaryMove.impact ? <span>{primaryMove.impact}</span> : null}
        {primaryMove.dueLabel ? <span style={{ fontWeight: 700 }}>{primaryMove.dueLabel}</span> : null}
      </div>
    </section>
  );
}

// ── Your termite protection: program · next visit · warranty ───────────────────
// The report reinforces what the customer actually bought: an installed
// monitoring network around the property, documented visit by visit.
export function TermiteProtection({ nextVisitLabel = null, bondLines = [], programLabel = 'Termite bait station program' }) {
  // nextVisitLabel is the SAME-LINE next appointment only (builder-scoped);
  // the ACTIVE badge rides bond evidence alone — a scheduled visit is a
  // date, not a warranty claim (codex P2 #3600 r1).
  if (!nextVisitLabel && !bondLines.length) return null;
  const active = bondLines.length > 0;
  const cell = { minWidth: 0 };
  const cellLabel = { ...eyebrow, marginBottom: 4 };
  const cellValue = { fontSize: 15, fontWeight: 700, color: TEXT, lineHeight: 1.4 };
  return (
    <section data-glass="card" style={{ ...card, borderColor: 'rgba(4, 57, 94, 0.35)', background: `linear-gradient(180deg, rgba(4, 57, 94, 0.06), ${CARD} 55%)` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={eyebrow}>Your termite protection</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: TEXT }}>{programLabel}</div>
        </div>
        {active ? (
          <span style={{ background: COLORS.glassNavy, color: '#fff', borderRadius: 999, padding: '4px 12px', fontSize: 14, fontWeight: 700, letterSpacing: '0.04em', flex: '0 0 auto' }}>
            ACTIVE
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gap: 14 }}>
        {nextVisitLabel ? (
          <div style={cell}>
            <div style={cellLabel}>Next monitoring visit</div>
            <div style={cellValue}>{nextVisitLabel}</div>
          </div>
        ) : null}
        {bondLines.map((b, i) => (
          <div style={cell} key={`${i}-${b.label}`}>
            <div style={cellLabel}>{b.serviceType || 'Termite warranty'}</div>
            <div style={cellValue}>{b.label}</div>
          </div>
        ))}
      </div>
      {/* My Plan tab renders the termite bond card (PortalPage MyPlanTab). */}
      <a
        href="/?tab=plan"
        style={{
          display: 'inline-block',
          marginTop: 18,
          background: COLORS.yellow,
          color: COLORS.glassNavy,
          fontWeight: 700,
          fontSize: 14,
          borderRadius: 999,
          padding: '10px 20px',
          textDecoration: 'none',
        }}
      >
        View termite protection plan →
      </a>
    </section>
  );
}
