import React from 'react';

// GATE_REPORT_WEB_TOP (owner 2026-10-20): the first screen of the simple web service report. The server sends one
// `webTop` object while the gate is live (server/services/service-report/report-web-top.js); every sentence here is
// fixed or already on the report. No price, no product name. Text is 14px or larger.

const NAVY = '#04395E';
const MUTED = '#3F4A65';
const GOOD = '#0F7B54';
const WATCH = '#9A5B0B';
const GOLD = '#C99A2E';
const BAR = 'rgba(4, 57, 94, 0.72)';
const TRACK = 'rgba(4, 57, 94, 0.12)';

const CARD_PLAIN = { background: '#fff', border: '1px solid #D8D0C0', borderRadius: 14 };
const label = { fontSize: 14, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: NAVY, margin: 0 };
const body = { fontSize: 17, lineHeight: 1.45, color: NAVY, margin: '4px 0 0' };

// A date as "Oct 7". The server sends YYYY-MM-DD; noon UTC read in UTC keeps the day whatever the viewer's zone.
const noon = (ymd) => new Date(`${ymd}T12:00:00Z`);
const dayName = (ymd) => noon(ymd).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const dayDate = (ymd) => noon(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const inches = (n) => `${Number(n.toFixed(2))}`;

function Card({ glass, children, ...rest }) {
  return (
    <section
      {...(glass ? { 'data-glass': 'card' } : {})}
      style={{ ...(glass ? {} : CARD_PLAIN), boxSizing: 'border-box', minWidth: 0, padding: '14px 16px', marginTop: 12 }}
      {...rest}
    >
      {children}
    </section>
  );
}

// "Up 11 points since your last visit." as a line with an arrow. The words carry the meaning; the arrow is a hint.
function scoreChange(score) {
  if (score.previous == null) return { arrow: '', color: MUTED, text: 'This is your starting score.' };
  const diff = score.value - score.previous;
  if (diff === 0) return { arrow: '●', color: MUTED, text: 'Same as your last visit.' };
  const points = Math.abs(diff) === 1 ? '1 point' : `${Math.abs(diff)} points`;
  return diff > 0
    ? { arrow: '▲', color: GOOD, text: `Up ${points} since your last visit.` }
    : { arrow: '▼', color: WATCH, text: `Down ${points} since your last visit.` };
}

function ScoreStrip({ trend, note }) {
  const label6 = `Lawn score at your last ${trend.length} visits: ${trend.map((p) => `${p.label} ${p.value}`).join(', ')}.`;
  return (
    <div style={{ marginTop: 14 }}>
      <p style={{ ...label, textTransform: 'none', letterSpacing: 0 }}>{`Your last ${trend.length} visits`}</p>
      <div role="img" aria-label={label6} style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 96, marginTop: 6 }}>
        {trend.map((p, i) => (
          <div key={`${p.label}-${i}`} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
            <span style={{ fontSize: 14, fontWeight: i === trend.length - 1 ? 700 : 400, color: NAVY, lineHeight: 1.2 }}>{p.value}</span>
            <div style={{ width: '100%', maxWidth: 28, height: `${Math.max(4, Math.round(p.value * 0.72))}px`, marginTop: 2, borderRadius: 4, background: i === trend.length - 1 ? NAVY : BAR }} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4, fontSize: 14, color: MUTED }}>
        <span>{trend[0].label}</span>
        <span>{trend[trend.length - 1].label}</span>
      </div>
      {note ? <p style={{ fontSize: 14, lineHeight: 1.45, color: MUTED, margin: '8px 0 0' }}>{note}</p> : null}
    </div>
  );
}

function RainBar({ rain, glass }) {
  const days = rain.days;
  const max = Math.max(0.25, ...days.map((d) => d.inches || 0));
  const measured = days.filter((d) => d.inches != null);
  const first = measured[0].date;
  const last = measured[measured.length - 1].date;
  const since = rain.sinceVisitInches;
  const visitDate = days.find((d) => d.isVisit)?.date;
  const afterVisit = Boolean(visitDate) && days.some((d) => d.date > visitDate);
  const summary = days.map((d) => `${dayName(d.date)} ${d.inches == null ? 'no reading' : `${inches(d.inches)} inch`}${d.isVisit ? ', day of your visit' : ''}`).join('; ');
  return (
    <Card glass={glass} aria-label="Rain at your home">
      <h2 style={{ ...label, textTransform: 'none', letterSpacing: 0, fontSize: 17 }}>{afterVisit ? 'Rain since your visit' : 'Rain around your visit'}</h2>
      <p style={{ fontSize: 14, color: MUTED, margin: '2px 0 0' }}>{`Measured at your home, ${dayDate(first)} to ${dayDate(last)}.`}</p>
      <div role="img" aria-label={summary} style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 118, marginTop: 8 }}>
        {days.map((d) => (
          <div key={d.date} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
            <span style={{ fontSize: 14, color: NAVY, lineHeight: 1.2 }}>{d.inches == null ? '–' : (d.inches > 0 ? inches(d.inches) : '0')}</span>
            <div style={{ width: '100%', maxWidth: 26, height: `${d.inches == null ? 2 : Math.max(2, Math.round((d.inches / max) * 64))}px`, marginTop: 2, borderRadius: 4, background: d.isVisit ? GOLD : (d.inches ? BAR : TRACK) }} />
            <span style={{ fontSize: 14, color: NAVY, fontWeight: d.isVisit ? 700 : 400, marginTop: 4 }}>{dayName(d.date)}</span>
            <span style={{ fontSize: 14, color: MUTED, minHeight: 20, lineHeight: '20px' }}>{d.isVisit ? 'Visit' : ' '}</span>
          </div>
        ))}
      </div>
      {since != null ? <p style={body}>{since > 0 ? `Since your visit: ${inches(since)} in of rain.` : 'Since your visit: no measurable rain.'}</p> : null}
      <p style={{ fontSize: 14, lineHeight: 1.45, color: MUTED, margin: '6px 0 0', fontStyle: 'italic' }}>Based on NOAA radar and rain-gauge data — local totals may vary.</p>
    </Card>
  );
}

// The first card: the score and how it moved, the strip, the one action, the one hold.
function GlanceCard({ webTop, glass }) {
  const { score, trend, trendNote, action, hold } = webTop;
  const change = score ? scoreChange(score) : null;
  const strip = Array.isArray(trend) && trend.length >= 2 ? trend : null;
  return (
    <Card glass={glass} aria-label="Your visit at a glance">
      {score ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: NAVY }}>Lawn score</span>
          <span style={{ fontSize: 44, fontWeight: 700, lineHeight: 1, color: NAVY }}>{score.value}</span>
          <span style={{ fontSize: 14, color: MUTED }}>out of 100</span>
        </div>
      ) : null}
      {change ? (
        <p style={{ ...body, color: change.color, fontWeight: 600 }}>
          {change.arrow ? <span aria-hidden="true">{change.arrow} </span> : null}{change.text}
        </p>
      ) : null}
      {strip ? <ScoreStrip trend={strip} note={trendNote} /> : null}
      {action ? (
        <div style={{ marginTop: score ? 14 : 0 }}>
          <p style={label}>Do this</p>
          <p style={body}>{action}</p>
        </div>
      ) : null}
      {hold ? (
        <div style={{ marginTop: action || score ? 12 : 0 }}>
          <p style={label}>Hold off</p>
          <p style={body}>{hold}</p>
        </div>
      ) : null}
    </Card>
  );
}

export default function WebTopCard({ webTop, glass = false }) {
  if (!webTop || typeof webTop !== 'object') return null;
  const { score, action, hold, rain } = webTop;
  const showRain = Array.isArray(rain?.days) && rain.days.some((d) => d.inches != null);
  if (!score && !action && !hold && !showRain) return null;
  return (
    <div data-testid="web-top" className="sr-shell" style={{ maxWidth: 760, margin: '0 auto', padding: '0 16px', boxSizing: 'border-box' }}>
      {score || action || hold ? <GlanceCard webTop={webTop} glass={glass} /> : null}
      {showRain ? <RainBar rain={rain} glass={glass} /> : null}
    </div>
  );
}
