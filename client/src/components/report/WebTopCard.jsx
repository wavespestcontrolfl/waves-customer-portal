import React from 'react';
import {
  DOC, DOC_EYEBROW, DOC_FONT, FS, FW, LH, RADIUS, SP, docCard,
} from '../../theme-doc';
import { COLORS } from '../../theme-brand';
import { doThisLine, holdOffLine } from '../../pages/serviceReportLines';

// GATE_REPORT_WEB_TOP (owner 2026-10-20): the first screen of the simple web service report. The server sends one
// `webTop` object while the gate is live (the lawn score, its strip and the measured rain). "Do this" and "Re-entry"
// are picked here from the same lists ServiceReportDocument prints (pages/serviceReportLines.js), so the card can never
// say anything the document does not. No price, no product name. Text is 14px or larger.

const TRACK_H = 64; // tallest rain bar, px of chart height (a data height, not a type size)

// All type, space, colour and radius come from the document design system (docs/design/customer-doc-style-guide.md).
const label = { ...DOC_EYEBROW, marginBottom: 0 };
const body = { fontFamily: DOC_FONT, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.ink, margin: `${SP.xxs}px 0 0` };
const fine = { fontFamily: DOC_FONT, fontSize: FS.body, lineHeight: LH.snug, color: DOC.muted };

// A date as "Oct 7". The server sends YYYY-MM-DD; noon UTC read in UTC keeps the day whatever the viewer's zone.
const noon = (ymd) => new Date(`${ymd}T12:00:00Z`);
const dayName = (ymd) => noon(ymd).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const dayDate = (ymd) => noon(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const inches = (n) => `${Number(n.toFixed(2))}`;

function Card({ glass, children, ...rest }) {
  return (
    <section
      {...(glass ? { 'data-glass': 'card' } : {})}
      style={{ ...(glass ? {} : docCard()), boxSizing: 'border-box', minWidth: 0, padding: `${SP.sm}px ${SP.md}px`, marginTop: SP.sm }}
      {...rest}
    >
      {children}
    </section>
  );
}

// "Up 11 points since your last visit." as a line with an arrow. The words carry the meaning; the arrow is a hint.
function scoreChange(score) {
  if (score.previous == null) return { arrow: '', color: DOC.muted, text: 'This is your starting score.' };
  const diff = score.value - score.previous;
  if (diff === 0) return { arrow: '●', color: DOC.muted, text: 'Same as your last visit.' };
  const points = Math.abs(diff) === 1 ? '1 point' : `${Math.abs(diff)} points`;
  return diff > 0
    ? { arrow: '▲', color: DOC.success, text: `Up ${points} since your last visit.` }
    : { arrow: '▼', color: DOC.ink, text: `Down ${points} since your last visit.` };
}

// One column of a bar chart: the value above, the bar, then whatever sits under it.
const column = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' };

function ScoreStrip({ trend, note }) {
  const label6 = `Lawn score at your last ${trend.length} visits: ${trend.map((p) => `${p.label} ${p.value}`).join(', ')}.`;
  return (
    <div style={{ marginTop: SP.md }}>
      <p style={{ ...fine, fontWeight: FW.semibold, color: DOC.ink, margin: 0 }}>{`Your last ${trend.length} visits`}</p>
      <div role="img" aria-label={label6} style={{ display: 'flex', alignItems: 'flex-end', gap: SP.xs, height: 96, marginTop: SP.xs }}>
        {trend.map((p, i) => {
          const current = i === trend.length - 1;
          return (
            <div key={`${p.label}-${i}`} style={column}>
              <span style={{ ...fine, fontWeight: current ? FW.bold : FW.regular, color: DOC.ink, lineHeight: LH.heading }}>{p.value}</span>
              <div style={{ width: '100%', maxWidth: 28, height: `${Math.max(4, Math.round(p.value * 0.72))}px`, marginTop: 2, borderRadius: RADIUS.tag, background: DOC.brand, opacity: current ? 1 : 0.7 }} />
            </div>
          );
        })}
      </div>
      <div aria-hidden="true" style={{ ...fine, display: 'flex', justifyContent: 'space-between', gap: SP.xs, marginTop: SP.xxs }}>
        <span>{trend[0].label}</span>
        <span>{trend[trend.length - 1].label}</span>
      </div>
      {note ? <p style={{ ...fine, margin: `${SP.xs}px 0 0` }}>{note}</p> : null}
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
  const sinceDays = Number(rain.sinceVisitDays) || 0;
  const span = sinceDays === 1 ? 'the day' : `the ${sinceDays} days`;
  const visitDate = days.find((d) => d.isVisit)?.date;
  const afterVisit = Boolean(visitDate) && days.some((d) => d.date > visitDate);
  const summary = days.map((d) => `${dayName(d.date)} ${d.inches == null ? 'no reading' : `${inches(d.inches)} inch`}${d.isVisit ? ', day of your visit' : ''}`).join('; ');
  return (
    <Card glass={glass} aria-label="Rain at your home">
      <h2 style={{ margin: 0, fontFamily: DOC_FONT, fontSize: FS.sub, fontWeight: FW.semibold, lineHeight: LH.heading, color: DOC.ink }}>{afterVisit ? 'Rain after your visit' : 'Rain around your visit'}</h2>
      <p style={{ ...fine, margin: `${SP.xxs}px 0 0` }}>{`Measured at your home, ${dayDate(first)} to ${dayDate(last)}.`}</p>
      <div role="img" aria-label={summary} style={{ display: 'flex', alignItems: 'flex-end', gap: SP.xxs, height: 118, marginTop: SP.xs }}>
        {days.map((d) => (
          <div key={d.date} style={column}>
            <span style={{ ...fine, color: DOC.ink, lineHeight: LH.heading }}>{d.inches == null ? '–' : (d.inches > 0 ? inches(d.inches) : '0')}</span>
            <div style={{ width: '100%', maxWidth: 26, height: `${d.inches == null ? 2 : Math.max(2, Math.round((d.inches / max) * TRACK_H))}px`, marginTop: 2, borderRadius: RADIUS.tag, background: d.isVisit ? COLORS.yellow : (d.inches ? DOC.brand : DOC.border), opacity: !d.isVisit && d.inches ? 0.7 : 1 }} />
            <span style={{ ...fine, color: DOC.ink, fontWeight: d.isVisit ? FW.bold : FW.regular, marginTop: SP.xxs }}>{dayName(d.date)}</span>
            <span style={{ ...fine, minHeight: SP.lg, lineHeight: `${SP.lg}px` }}>{d.isVisit ? 'Visit' : '\u00a0'}</span>
          </div>
        ))}
      </div>
      {since != null && sinceDays > 0 ? <p style={body}>{since > 0 ? `In ${span} after your visit: ${inches(since)} in of rain.` : `In ${span} after your visit: no measurable rain.`}</p> : null}
      <p style={{ ...fine, margin: `${SP.xs}px 0 0`, fontStyle: 'italic' }}>Based on NOAA radar and rain-gauge data — local totals may vary.</p>
    </Card>
  );
}

// The first card: the score and how it moved, the strip, the one action, the one hold.
function GlanceCard({ webTop, data, glass }) {
  const { score, trend, trendNote } = webTop;
  const action = doThisLine(data);
  const hold = holdOffLine(data);
  const change = score ? scoreChange(score) : null;
  const strip = Array.isArray(trend) && trend.length >= 2 ? trend : null;
  return (
    <Card glass={glass} aria-label="Your visit at a glance">
      {score ? (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: SP.xs, flexWrap: 'wrap' }}>
          <span data-gt="eyebrow" style={label}>Lawn score</span>
          <span style={{ fontFamily: DOC_FONT, fontSize: FS.h1, fontWeight: FW.bold, lineHeight: LH.solid, color: DOC.ink }}>{score.value}</span>
          <span style={fine}>out of 100</span>
        </div>
      ) : null}
      {change ? (
        <p style={{ ...body, color: change.color, fontWeight: FW.semibold }}>
          {change.arrow ? <span aria-hidden="true">{change.arrow} </span> : null}{change.text}
        </p>
      ) : null}
      {strip ? <ScoreStrip trend={strip} note={trendNote} /> : null}
      {action ? (
        <div style={{ marginTop: score ? SP.md : 0 }}>
          <p data-gt="eyebrow" style={label}>Do this</p>
          <p style={body}>{action}</p>
        </div>
      ) : null}
      {hold ? (
        <div style={{ marginTop: action || score ? SP.sm : 0 }}>
          <p data-gt="eyebrow" style={label}>Re-entry</p>
          <p style={body}>{hold}</p>
        </div>
      ) : null}
    </Card>
  );
}

// "web-top-card": the page's print rule hides it, so a browser Print of the page is the full document.
export default function WebTopCard({ webTop, data, glass = false }) {
  if (!webTop || typeof webTop !== 'object' || !data) return null;
  const { rain } = webTop;
  const showRain = Array.isArray(rain?.days) && rain.days.some((d) => d.inches != null);
  return (
    <div data-testid="web-top" className="sr-shell web-top-card" style={{ maxWidth: 760, margin: '0 auto', padding: `0 ${SP.md}px`, boxSizing: 'border-box' }}>
      <GlanceCard webTop={webTop} data={data} glass={glass} />
      {showRain ? <RainBar rain={rain} glass={glass} /> : null}
    </div>
  );
}
