// GATE_LAWN_REPORT_LAYOUT: the lawn web report, ordered for a phone.
//
// ReportViewPage builds every section as an element it already knows how to render (the status
// card, "Your plan", the review ask, the products section, ...) and hands them over as `slots`.
// While the gate is live LawnLayoutSwitch renders LawnLayoutBody instead of the standard page body,
// and the body is an ORDERED LIST (LAYOUT_ORDER) of those sections plus the lawn blocks that the
// standard page keeps inside the lead card and the lawn section. Nothing is rewritten: the blocks
// are the same components, picked and ordered here. Gate off: LawnLayoutSwitch returns its children,
// so the page is exactly what it was.
//
// Hidden here, not deleted: the Visit Timeline, the Weather call block, "Your documents", the
// re-entry card (its sentence moves into "Your part"). The PDF document never uses this file.

import { Fragment } from 'react';
import ReportText from '../ReportSections';
import { COLORS, FONTS } from '../../../theme-brand';
import { CUSTOMER_SURFACE } from '../../../theme-customer';
import { usePrintRequested } from '../usePrintRequested';
import {
  Card,
  CardTitle,
  KeyLine,
  LawnFollowUpCard,
  LawnInsightCards,
  LawnPhotoFindings,
  LawnPhotoStrip,
  LawnProgramLine,
  LawnProgressionSlider,
  LawnTrends,
  LawnWateringBanner,
  MowingHeightGauge,
  PrintContext,
  RainLast7DaysChart,
  ScoreRing,
  VisualDiagnosisCards,
  WaterIntakeBar,
  nextVisitSentence,
  scoreStatus,
  statusMeta,
} from './LawnReportV2';
import {
  LAYOUT_COPY,
  bannerRepeatsAftercare,
  bannerShowsAnything,
  insightsWithoutRepeats,
  lawnLayoutActive,
  mowingLine,
  planShowsNextVisit,
  watchingLine,
  whenToCallLines,
  withoutRepeatedApplied,
  yourPartIsEmpty,
} from './lawnLayoutRules';

const TEXT = 'var(--text)';
const BODY = 'var(--text)';
const MUTED = 'var(--muted)';
const BORDER = CUSTOMER_SURFACE.border;
const TAN = '#F2EEE0';

const eyebrow = { fontFamily: FONTS.heading, fontWeight: 700, fontSize: 14, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.06em' };

// The white sub-boxes the standard lead card uses inside its tan card.
function LeadBox({ label, testId, children }) {
  return (
    <div data-testid={testId} style={{ padding: '11px 13px', background: COLORS.white, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
      <div data-gt="eyebrow" style={eyebrow}>{label}</div>
      <div style={{ fontSize: 16, color: BODY, lineHeight: 1.5, marginTop: 3 }}>{children}</div>
    </div>
  );
}

// A card that opens and closes; opened for a browser print so the printed page keeps its content.
function Collapsible({ summary, className, children }) {
  const printRequested = usePrintRequested();
  return (
    <details open={printRequested} className={`lawn-layout-collapse ${className || ''}`.trim()} style={{ marginBottom: 20 }}>
      <summary data-glass="card" style={{ cursor: 'pointer', listStyle: 'none', WebkitTapHighlightColor: 'transparent', padding: '16px 20px', background: COLORS.white, border: `1px solid ${BORDER}`, borderRadius: 16 }}>
        {summary}
      </summary>
      <div style={{ marginTop: 12 }}>{children}</div>
    </details>
  );
}

// ── (b) Your part ───────────────────────────────────────────────────────────
// What the customer does after this visit, from data the report already has: the re-entry sentence
// (the report's own, timed or condition), the watering banner (its water-in or hold lines and a label
// mow hold, printed once, here), and the lead's own homeowner step. Nothing to do = one fixed sentence.
export function LawnYourPartCard({ banner = null, reentry = null, lines = [], style = null }) {
  const empty = yourPartIsEmpty({ banner, reentry, lines });
  return (
    <Card style={{ background: TAN, ...(style || {}) }}>
      <div data-testid="lawn-your-part">
        <CardTitle>{LAYOUT_COPY.yourPartTitle}</CardTitle>
        {empty ? (
          <p style={{ margin: 0, fontSize: 16, color: BODY, lineHeight: 1.5 }}>{LAYOUT_COPY.nothingToDo}</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {reentry ? (
              <KeyLine
                label={LAYOUT_COPY.walkOnLabel}
                dot={COLORS.glassNavy}
                valueSize={16}
                value={(
                  <>
                    {reentry.text ? <div>{reentry.text}</div> : null}
                    {reentry.pets ? <div style={reentry.text ? { marginTop: 4 } : null}>{reentry.pets}</div> : null}
                  </>
                )}
              />
            ) : null}
            {bannerShowsAnything(banner) ? <LawnWateringBanner banner={banner} style={{ marginBottom: 0 }} /> : null}
            {lines.length ? (
              <KeyLine
                label={LAYOUT_COPY.alsoLabel}
                dot={COLORS.glassNavy}
                valueSize={16}
                value={lines.map((line, i) => <div key={i} style={i ? { marginTop: 4 } : null}>{line}</div>)}
              />
            ) : null}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── (a) the next lawn visit's reason ────────────────────────────────────────
function NextVisit({ data }) {
  const { lead, snapshot } = data.reportV2;
  const dateLine = planShowsNextVisit(data) ? null : nextVisitSentence(snapshot?.nextVisit);
  const value = [dateLine, lead.next].filter(Boolean).join(' — ');
  if (!value) return null;
  return (
    <Card>
      <KeyLine label="Next visit" value={value} dot={COLORS.glassNavy} valueSize={16} />
    </Card>
  );
}

// ── (c) what we did + why now ───────────────────────────────────────────────
function WhatWeDid({ data, slots }) {
  const v2 = data.reportV2;
  const { lead } = v2;
  const sinceLast = Array.isArray(lead.sinceLast?.lines) ? lead.sinceLast.lines.filter(Boolean) : [];
  const tech = withoutRepeatedApplied(lead.techParagraph, lead.applied);
  // The Visit Summary paragraph stays (it carries the season, the photo read and the next-visit topics);
  // only an applied sentence the lead's own sentence already says in full is left out of it.
  const summary = slots.visitSummary;
  const summaryText = summary ? withoutRepeatedApplied(summary.text, lead.applied) : null;
  return (
    <>
      {sinceLast.length || lead.applied || tech ? (
        <Card style={{ background: TAN, display: 'grid', gap: 10 }}>
          {sinceLast.length ? (
            <LeadBox label="Since your last visit" testId="lawn-since-last">
              {sinceLast.map((line, i) => <div key={i} style={i ? { marginTop: 4 } : null}>{line}</div>)}
            </LeadBox>
          ) : null}
          {lead.applied ? <LeadBox label="What we applied today">{lead.applied}</LeadBox> : null}
          {tech ? <LeadBox label="From your technician" testId="lawn-lead-tech">{tech}</LeadBox> : null}
        </Card>
      ) : null}
      {summaryText ? (
        <section data-glass="card" className="sr-section visit-summary-section" id="visit-summary">
          <h2>Visit Summary</h2>
          <ReportText text={summaryText} sections={summary.sections} nextVisitLabel={summary.nextVisitLabel} />
        </section>
      ) : null}
      <LawnProgramLine snapshot={v2.snapshot} />
    </>
  );
}

// ── (d) photos + findings ───────────────────────────────────────────────────
function PhotosAndFindings({ data, slots }) {
  const v2 = data.reportV2;
  const { lead } = v2;
  const hasPhotos = v2.photos?.length || v2.photoSet?.length || v2.photoSummary;
  const insights = insightsWithoutRepeats(v2.insights, { banner: v2.banner, aftercare: v2.aftercare });
  return (
    <>
      {hasPhotos ? <LawnPhotoStrip photos={v2.photos} photoSet={v2.photoSet} summary={v2.photoSummary} lead /> : null}
      {v2.photoSet?.length && v2.photoFindings?.length ? <LawnPhotoFindings findings={v2.photoFindings} /> : null}
      {v2.followUp?.scheduled && v2.followUp.reason && !lead.next ? <LawnFollowUpCard followUp={v2.followUp} showYourPart={false} /> : null}
      {insights.length ? <LawnInsightCards insights={insights} lead={lead} /> : null}
      {slots.recordedFindings}
      {slots.recommendations}
    </>
  );
}

// ── (e) score, collapsed ────────────────────────────────────────────────────
function ScoreSection({ data }) {
  const v2 = data.reportV2;
  const { lead } = v2;
  const snapshot = v2.snapshot || {};
  const status = snapshot.status || scoreStatus(snapshot.overallScore);
  const explanation = snapshot.scoreExplanation && snapshot.scoreExplanation !== lead.why ? snapshot.scoreExplanation : null;
  const hasNext = Boolean(snapshot.nextVisit?.label && snapshot.nextVisit.label !== 'Invalid Date');
  const summary = (
    <div data-testid="lawn-layout-score" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <div style={{ flex: 'none' }}><ScoreRing value={snapshot.overallScore} status={status} size={72} stroke={8} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div data-gt="eyebrow" style={{ ...eyebrow, marginBottom: 2 }}>Overall Lawn Status</div>
        <div style={{ fontFamily: FONTS.serif, fontSize: 19, fontWeight: 500, lineHeight: 1.2, color: TEXT }}>{lead.headline || statusMeta(status).label}</div>
        <div style={{ fontSize: 14, color: MUTED, marginTop: 4 }}>{LAYOUT_COPY.scoreToggle} <span aria-hidden="true">▾</span></div>
      </div>
    </div>
  );
  return (
    <Collapsible summary={summary} className="lawn-layout-score">
      {lead.why ? <Card><p style={{ margin: 0, fontSize: 16, color: BODY, lineHeight: 1.5 }}>{lead.why}</p></Card> : null}
      {v2.progression?.length >= 2 ? <LawnProgressionSlider frames={v2.progression} note={v2.progressionNote} /> : null}
      {v2.diagnosis?.length ? <VisualDiagnosisCards categories={v2.diagnosis} lead scoreExplanation={explanation} /> : null}
      {v2.trends ? <LawnTrends trends={v2.trends} baselineScore={snapshot.overallScore} hasNextVisit={hasNext} /> : null}
    </Collapsible>
  );
}

// ── (f) what to expect, when to call ────────────────────────────────────────
function WhatToExpect({ data }) {
  const v2 = data.reportV2;
  const watching = watchingLine(v2.lead, v2.insights);
  if (!v2.lead.whatToExpect && !watching) return null;
  return (
    <Card style={{ background: TAN, display: 'grid', gap: 10 }}>
      {v2.lead.whatToExpect ? <LeadBox label="What to expect" testId="lawn-lead-expect">{v2.lead.whatToExpect}</LeadBox> : null}
      {watching ? <LeadBox label="Watching" testId="lawn-lead-watching">{watching}</LeadBox> : null}
    </Card>
  );
}

function WhenToCall() {
  return (
    <Card>
      <div data-testid="lawn-when-to-call">
        <CardTitle>{LAYOUT_COPY.whenToCallTitle}</CardTitle>
        {whenToCallLines().map((line) => (
          <p key={line} style={{ margin: '0 0 8px', fontSize: 16, color: BODY, lineHeight: 1.5 }}>{line}</p>
        ))}
      </div>
    </Card>
  );
}

// ── (g) water this week, with the mowing height ─────────────────────────────
function WaterAndMowing({ data }) {
  const v2 = data.reportV2;
  const line = mowingLine(data.lawnLayout.mowingRange, v2.mowing);
  const coverageCardShown = (v2.insights || []).some((card) => card && card.kind === 'coverage_watch');
  return (
    <>
      {v2.water ? <WaterIntakeBar water={v2.water} aftercare={v2.aftercare} lead coverageCardShown={coverageCardShown} /> : null}
      {v2.rain7d?.length ? <RainLast7DaysChart days={v2.rain7d} confidence={v2.rain7dConfidence} source={v2.rain7dSource} /> : null}
      {v2.mowing ? <MowingHeightGauge mowing={v2.mowing} /> : null}
      {line ? <Card><p data-testid="lawn-mowing-line" style={{ margin: 0, fontSize: 16, color: BODY, lineHeight: 1.5 }}>{line}</p></Card> : null}
    </>
  );
}

// ── (i) products, collapsed ─────────────────────────────────────────────────
function Products({ slots }) {
  return (
    <Collapsible summary={<span style={{ fontFamily: FONTS.serif, fontSize: 21, fontWeight: 500, color: TEXT }}>Products Applied <span aria-hidden="true" style={{ fontSize: 14 }}>▾</span></span>} className="lawn-layout-products">
      {slots.products}
    </Collapsible>
  );
}

// The ordered list. Each key names one section; the page prints them top to bottom.
//   a  done + the next lawn visit    status, reservice, plan, upcoming, nextVisit
//   b  Your part                     yourPart
//   c  what we did + why now         whatWeDid
//   d  photos + findings             photos, recap, treatmentMap
//   e  score (collapsed)             score
//   f  what to expect + when to call expect, whenToCall, crossSell
//   g  water this week (+ mowing)    water, techNote, nearYou
//   h  rate us                       review, referral
//   i  products (collapsed)          products
export const LAYOUT_ORDER = [
  'status', 'reservice', 'plan', 'upcoming', 'nextVisit',
  'yourPart',
  'whatWeDid',
  'photos', 'recap', 'treatmentMap',
  'score',
  'expect', 'whenToCall', 'crossSell',
  'water', 'techNote', 'nearYou',
  'review', 'referral',
  'products',
];

const SECTIONS = {
  status: ({ slots }) => slots.status,
  reservice: ({ slots }) => slots.reservice,
  plan: ({ slots }) => slots.plan,
  upcoming: ({ slots }) => slots.upcoming,
  nextVisit: (props) => <NextVisit {...props} />,
  yourPart: ({ slots }) => slots.yourPart,
  whatWeDid: (props) => <WhatWeDid {...props} />,
  photos: (props) => <PhotosAndFindings {...props} />,
  recap: ({ slots }) => slots.recap,
  treatmentMap: ({ data, slots }) => (data.treatmentMap?.traced?.snapshotUrl ? slots.tracedMap : null),
  score: (props) => <ScoreSection {...props} />,
  expect: (props) => <WhatToExpect {...props} />,
  whenToCall: () => <WhenToCall />,
  crossSell: ({ slots }) => slots.crossSell,
  water: (props) => <WaterAndMowing {...props} />,
  techNote: ({ slots }) => slots.techNote,
  nearYou: ({ slots }) => slots.nearYou,
  review: ({ slots }) => slots.review,
  referral: ({ slots }) => slots.referral,
  products: (props) => <Products {...props} />,
};

const LAYOUT_CSS = `
  /* The Weather call block is not part of the lawn layout (hidden, not deleted). */
  .lawn-layout .hero-conditions { display: none; }
  /* The water card's copy of the watering instruction (the line inside the weekly plan's condition note)
     is hidden, not deleted, only when every sentence of it is a sentence "Your part" prints from the
     banner (bannerRepeatsAftercare). The "After today's visit" note also carries the label's re-entry
     text, so it is never hidden. */
  .lawn-layout-banner [data-testid="lawn-week-plan-condition"] > div { display: none; }
  /* The products section's own heading is the summary line above it. */
  .lawn-layout-products .applied-products-header { display: none; }
  .lawn-layout-collapse > summary::-webkit-details-marker { display: none; }
`;

export function LawnLayoutBody({ data, slots }) {
  const banner = bannerRepeatsAftercare(data.reportV2?.banner, data.reportV2?.aftercare) ? ' lawn-layout-banner' : '';
  return (
    <PrintContext.Provider value={false}>
      <div className={`lawn-layout${banner}`} style={{ display: 'contents' }}>
        <style>{LAYOUT_CSS}</style>
        {LAYOUT_ORDER.map((key) => <Fragment key={key}>{SECTIONS[key]({ data, slots })}</Fragment>)}
      </div>
    </PrintContext.Provider>
  );
}

/** The standard page body, or the lawn layout while the gate's payload key is on a live lawn report. */
export function LawnLayoutSwitch({ data, mode, layout, children }) {
  return lawnLayoutActive(data, mode) ? layout : children;
}
