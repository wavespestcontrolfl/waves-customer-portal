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
//
// GATE_LAWN_REPORT_STORY (owner 2026-10-23/24) adds a second order, STORY_LAYOUT_ORDER, used while the
// payload's lawnLayout key carries story:true: the review invitation and the technician's note lead, each
// applied product is explained inside "what we did" (visible, with its Poison Control note), Ask Waves sits
// in the page, and the plan, the next visit, the re-service card and the blog follow the lawn sections.
// Without the key the page prints LAYOUT_ORDER exactly as before.

import { Fragment, cloneElement, useEffect, useState } from 'react';
import ReportText, { reportSectionsForText } from '../ReportSections';
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
  sinceLastLabel,
  statusMeta,
} from './LawnReportV2';
import {
  LAYOUT_COPY,
  OFFICE_PHONE,
  appliedRepeatsResult,
  bannerRepeatsAftercare,
  bannerShowsAnything,
  insightsWithoutRepeats,
  lawnLayoutActive,
  mowingLine,
  pageCarriesInstruction,
  nextVisitPlacement,
  treatmentMayHaveBeenApplied,
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
export function LawnYourPartCard({ banner = null, reentry = null, lines = [], othersCarryInstruction = false, style = null }) {
  const empty = yourPartIsEmpty({ banner, reentry, lines });
  // Empty, but a later section carries a customer instruction (a recommendation, a finding's step, the weekly
  // plan): the card says nothing, and is left out, rather than claim there is nothing to do.
  if (empty && othersCarryInstruction) return null;
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

// True when the Visit Summary below prints its own "Next visit: <date>" line: the four-section technician report
// (whose "What's next" section opens with it) is on the page and the slot carries the label.
function summaryPrintsNextVisit(slots) {
  const summary = slots.visitSummary;
  return Boolean(summary && summary.nextVisitLabel && reportSectionsForText(summary.sections, summary.text)
    && summary.sections.some((section) => section.key === 'whatsNext'));
}

// ── (a) the next lawn visit's reason ────────────────────────────────────────
function NextVisit({ data, slots }) {
  const { lead, snapshot } = data.reportV2;
  const dateLine = nextVisitPlacement(data, { summaryPrintsNext: summaryPrintsNextVisit(slots) }).leadDrops ? null : nextVisitSentence(snapshot?.nextVisit);
  const value = [dateLine, lead.next].filter(Boolean).join(' — ');
  if (!value) return null;
  return (
    <Card>
      <KeyLine label="Next visit" value={value} dot={COLORS.glassNavy} valueSize={16} />
    </Card>
  );
}

// ── (c) what we did + why now ───────────────────────────────────────────────
// The parts both orders print: the lead's "since last visit" lines, the technician paragraph (less an applied
// sentence the lead says in full) and the Visit Summary card.
function whatWeDidParts(data, slots) {
  const v2 = data.reportV2;
  const { lead } = v2;
  const sinceLast = Array.isArray(lead.sinceLast?.lines) ? lead.sinceLast.lines.filter(Boolean) : [];
  const tech = withoutRepeatedApplied(lead.techParagraph, lead.applied);
  // The Visit Summary paragraph stays (it carries the season, the photo read and the next-visit topics);
  // only an applied sentence the lead's own sentence already says in full is left out of it.
  // The screened four-section technician report (summary.sections) prints as the standard page prints it,
  // whole: the lead's applied sentence is not a substitute for its sections.
  const summary = slots.visitSummary;
  const sectioned = Boolean(summary) && Boolean(reportSectionsForText(summary.sections, summary.text));
  // The "What's next" date line prints only when no earlier printer (the plan area, the status card) printed the same visit.
  const summaryNextLabel = summary && !nextVisitPlacement(data, { summaryPrintsNext: summaryPrintsNextVisit(slots) }).summaryDrops ? summary.nextVisitLabel : null;
  const summaryText = summary && !sectioned ? withoutRepeatedApplied(summary.text, lead.applied) : (summary && summary.text) || null;
  const sinceLastBox = sinceLast.length ? (
    <LeadBox label={sinceLastLabel(lead.sinceLast)} testId="lawn-since-last">
      {sinceLast.map((line, i) => <div key={i} style={i ? { marginTop: 4 } : null}>{line}</div>)}
    </LeadBox>
  ) : null;
  const visitSummary = summaryText || slots.recordedFindings ? (
    <section data-glass="card" className="sr-section visit-summary-section" id="visit-summary">
      <h2>Visit Summary</h2>
      {summaryText ? <ReportText text={summaryText} sections={summary.sections} nextVisitLabel={summaryNextLabel} /> : null}
      {slots.recordedFindings}
    </section>
  ) : null;
  return { v2, lead, sinceLastBox, tech, visitSummary };
}

function WhatWeDid({ data, slots }) {
  const { v2, lead, sinceLastBox, tech, visitSummary } = whatWeDidParts(data, slots);
  return (
    <>
      {sinceLastBox || lead.applied || tech ? (
        <Card style={{ background: TAN, display: 'grid', gap: 10 }}>
          {sinceLastBox}
          {lead.applied ? <LeadBox label="What we applied today">{lead.applied}</LeadBox> : null}
          {tech ? <LeadBox label="From your technician" testId="lawn-lead-tech">{tech}</LeadBox> : null}
        </Card>
      ) : null}
      {visitSummary}
      <LawnProgramLine snapshot={v2.snapshot} />
    </>
  );
}

// GATE_LAWN_REPORT_STORY (owner 2026-10-23: "we dont incorporate the products along with the content"): the
// applied sentence opens the products section, which explains each product where the customer reads about the
// visit ("Your treatment, explained", visible, with its Poison Control note). An applied sentence with no
// product cards to open stays in the card. The Visit Summary card is collapsed under one line.
function StoryWhatWeDid({ data, slots }) {
  const { v2, lead, sinceLastBox, tech, visitSummary } = whatWeDidParts(data, slots);
  const applied = appliedRepeatsResult(lead.applied, v2.todaysResult) ? null : lead.applied;
  const appliedWithoutProducts = applied && slots.productsKind !== 'products';
  return (
    <>
      {sinceLastBox || tech || appliedWithoutProducts ? (
        <Card style={{ background: TAN, display: 'grid', gap: 10 }}>
          {sinceLastBox}
          {tech ? <LeadBox label="What we noticed" testId="lawn-lead-tech">{tech}</LeadBox> : null}
          {appliedWithoutProducts ? <p style={{ margin: 0 }}>{applied}</p> : null}
        </Card>
      ) : null}
      {cloneElement(slots.products, { presentation: 'story', intro: applied })}
      <LawnProgramLine snapshot={v2.snapshot} />
      {visitSummary ? (
        <Collapsible summary={<span className="lawn-story-summary-label">{LAYOUT_COPY.storySummaryToggle} <span aria-hidden="true">▾</span></span>} className="lawn-story-summary">
          {visitSummary}
        </Collapsible>
      ) : null}
    </>
  );
}

// ── (d) photos + findings ───────────────────────────────────────────────────
function PhotosAndFindings({ data, slots, nowMs, printing }) {
  const v2 = data.reportV2;
  const { lead } = v2;
  const hasPhotos = v2.photos?.length || v2.photoSet?.length || v2.photoSummary;
  const insights = insightsWithoutRepeats(v2.insights, { banner: v2.banner, aftercare: v2.aftercare, nowMs, printing });
  return (
    <>
      {hasPhotos ? <LawnPhotoStrip photos={v2.photos} photoSet={v2.photoSet} summary={v2.photoSummary} lead /> : null}
      {v2.photoSet?.length && v2.photoFindings?.length ? <LawnPhotoFindings findings={v2.photoFindings} /> : null}
      {v2.followUp?.scheduled && v2.followUp.reason && !lead.next ? <LawnFollowUpCard followUp={v2.followUp} showYourPart={false} /> : null}
      {insights.length ? <LawnInsightCards insights={insights} lead={lead} /> : null}
      {slots.markedPhotos}
      {slots.highlights}
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
    <div data-testid="lawn-layout-score" className="report-template-column" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
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

// The first approved line is about "the area we treated", so it prints only when a treatment may have been
// applied (the products section's own verdict). With no treatment the damage line stands alone; the office
// number then prints by itself (no new sentence), the way the footer prints it.
function WhenToCall({ treated }) {
  return (
    <Card>
      <div data-testid="lawn-when-to-call">
        <CardTitle>{LAYOUT_COPY.whenToCallTitle}</CardTitle>
        {whenToCallLines({ treated }).map((line) => (
          <p key={line} className="sr-v2-body" style={{ margin: '0 0 8px', fontSize: 16, color: BODY, lineHeight: 1.5 }}>{line}</p>
        ))}
        {treated ? null : (
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.5 }}>
            <a data-testid="lawn-when-to-call-phone" href={OFFICE_PHONE.tel} style={{ color: COLORS.glassNavy, fontWeight: 700 }}>{OFFICE_PHONE.display}</a>
          </p>
        )}
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
// The wrapper follows the verdict AppliedProductsSection prints from (appliedProductsKind):
//   products  the product cards in a collapsed block; the Poison Control note stays visible below it
//   poison    the Poison Control section alone, visible under its own heading (never a "Products" label)
//   none      nothing
function Products({ slots }) {
  if (slots.productsKind === 'none') return null;
  if (slots.productsKind === 'poison') return slots.products;
  return (
    <>
      <Collapsible summary={<span style={{ fontFamily: FONTS.serif, fontSize: 21, fontWeight: 500, color: TEXT }}>Products Applied <span aria-hidden="true" style={{ fontSize: 14 }}>▾</span></span>} className="lawn-layout-products">
        {slots.products}
      </Collapsible>
      {slots.poisonNote}
    </>
  );
}

// The ordered list. Each key names one section; the page prints them top to bottom.
//   a  done + the next lawn visit    status, blog (the Waves blog post), reservice, plan, upcoming, nextVisit
//   b  Your part                     yourPart
//   c  what we did + why now         whatWeDid
//   c  (also)                         the Visit Summary card holds the recorded findings list, as on the standard page
//   d  photos + findings             photos (+ marked photos, service highlights, recommendations), recap, treatmentMap
//   e  score (collapsed)             score
//   f  what to expect + when to call expect, whenToCall, crossSell
//   g  water this week (+ mowing)    water, techNote, nearYou
//   h  rate us                       review, referral
//   i  products (collapsed)          products
export const LAYOUT_ORDER = [
  'status', 'blog', 'reservice', 'plan', 'upcoming', 'nextVisit',
  'yourPart', 'newSod',
  'whatWeDid',
  'photos', 'recap', 'treatmentMap',
  'score',
  'expect', 'whenToCall', 'crossSell',
  'water', 'techNote', 'nearYou',
  'review', 'referral',
  'products',
];

// GATE_LAWN_REPORT_STORY (owner 2026-10-23: "How did Adam do today ... towards the top", the technician's note
// "near the top", products with "why are we doing this"; 2026-10-24 "keep both": Ask Waves in the page, the plan
// and the next visit after the lawn sections):
//   status, then the review invitation and the technician's note together (personal)
//   Your part, new sod
//   what we did with each product explained, the program line, the Visit Summary (collapsed)
//   photos and findings, recap, treatment map
//   score (collapsed), what to expect, water this week, Ask Waves
//   plan, upcoming visits, the next lawn visit, re-service
//   when to call, near you, the blog post, cross-sell, referral
export const STORY_LAYOUT_ORDER = [
  'status', 'personal',
  'yourPart', 'newSod',
  'whatWeDidStory',
  'photos', 'recap', 'treatmentMap',
  'score',
  'expect', 'water', 'ask',
  'plan', 'upcoming', 'nextVisit', 'reservice',
  'whenToCall', 'nearYou', 'blog', 'crossSell', 'referral',
];

const SECTIONS = {
  status: ({ slots }) => slots.status,
  personal: ({ slots }) => <div className="lawn-story-personal">{slots.review}{slots.techNote}</div>,
  ask: ({ slots }) => slots.ask,
  whatWeDidStory: (props) => <StoryWhatWeDid {...props} />,
  blog: ({ slots }) => slots.blog,
  reservice: ({ slots }) => slots.reservice,
  plan: ({ slots }) => slots.plan,
  upcoming: ({ slots }) => slots.upcoming,
  nextVisit: (props) => <NextVisit {...props} />,
  newSod: ({ slots }) => slots.newSod,
  yourPart: ({ data, slots, nowMs, printing }) => cloneElement(slots.yourPart, { othersCarryInstruction: pageCarriesInstruction(data, nowMs, printing) }),
  whatWeDid: (props) => <WhatWeDid {...props} />,
  photos: (props) => <PhotosAndFindings {...props} />,
  recap: ({ slots }) => slots.recap,
  treatmentMap: ({ data, slots }) => (data.treatmentMap?.traced?.snapshotUrl ? slots.tracedMap : null),
  score: (props) => <ScoreSection {...props} />,
  expect: (props) => <WhatToExpect {...props} />,
  whenToCall: ({ data, slots }) => <WhenToCall treated={treatmentMayHaveBeenApplied(data, slots.productsKind)} />,
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
  /* The Poison Control note is printed outside the collapsed block (safety content), so the copy inside
     it is not shown a second time. */
  .lawn-layout-products .poison-control-note { display: none; }
  .lawn-layout-collapse > summary::-webkit-details-marker { display: none; }
  /* GATE_LAWN_REPORT_STORY: every rule below names a class only the story order prints. */
  .lawn-story-summary-label { display: flex; justify-content: space-between; font-size: 16px; font-weight: 600; color: ${COLORS.glassNavy}; }
  .lawn-story-personal { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin: 0 0 24px; }
  .lawn-story-personal > .sr-section,
  .lawn-story-personal > .report-card { margin: 0; }
  .lawn-story-personal #tech-note .tech-photo { width: 48px !important; height: 48px !important; }
  .lawn-story-personal #tech-note blockquote { padding-left: 22px !important; }
  .lawn-story-personal #tech-note p { font-size: 16px; line-height: 1.6; }
  .lawn-story-personal .review-request-card { display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; gap: 20px; }
  .lawn-story-personal .review-request-card h3 { font-size: 24px !important; line-height: 1.25; text-align: left !important; }
  .lawn-story-personal .review-request-card .review-cta { min-height: 48px; width: 100%; text-align: center; }
  .lawn-story-section { min-width: 0; scroll-margin-top: 80px; }
  .lawn-story-section:empty { display: none; }
  .lawn-story-section > .sr-section:first-child { margin-top: 0; }
  .lawn-story-section[data-story-section="whatWeDidStory"] { margin-top: 28px; }
  .lawn-story-section[data-story-section="ask"] { margin: 24px 0; }
  .lawn-story-section[data-story-section="blog"] .blog-post-image { max-height: 240px; }
  .lawn-story-section .treatment-story { margin: 0 0 20px; }
  .lawn-story-section .lawn-layout-collapse { margin: 20px 0; }
  @media (max-width: 600px) {
    .lawn-story-personal .review-request-card { gap: 16px; padding: 20px; }
    .lawn-story-personal .review-request-card h3 { font-size: 20px !important; }
  }
  @media print {
    .lawn-story-personal { display: block; }
    .lawn-story-section { break-inside: auto; }
  }
`;

// "Now" for every rule that depends on the watering banner. The banner ends at its expiresAt and then
// prints one fine-print note instead of its lines (LawnWateringBanner re-renders itself at that moment);
// this one timer makes the layout's own rules (the finding dedupe, the water card's hidden line, the
// "nothing to do" test) re-evaluate at the same moment, with no refresh.
function useBannerClock(banner) {
  const expiresMs = banner?.expiresAt ? Date.parse(banner.expiresAt) : NaN;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(expiresMs)) return undefined;
    const wait = expiresMs - Date.now() + 1000;
    // Already past expiry by the time this effect runs (a slow first paint): re-read the clock now, once, or the
    // state keeps the value from the first render and the rules would never see the expiry.
    if (wait <= 0) { setNowMs(Date.now()); return undefined; }
    if (wait > 2147483647) return undefined;
    const timer = setTimeout(() => setNowMs(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [expiresMs]);
  return nowMs;
}

// story: GATE_LAWN_REPORT_STORY (lawnStoryActive on the page) picks STORY_LAYOUT_ORDER.
export function LawnLayoutBody({ data, slots, story = false }) {
  const nowMs = useBannerClock(data.reportV2?.banner);
  // The same signal LawnWateringBanner reads (usePrintRequested: the browser's print pass): while printing, the
  // banner prints its lines even after expiry, so the dedupe must follow it.
  const printing = usePrintRequested();
  const banner = bannerRepeatsAftercare(data.reportV2?.banner, data.reportV2?.aftercare, nowMs, printing) ? ' lawn-layout-banner' : '';
  return (
    <PrintContext.Provider value={false}>
      <div className={`lawn-layout${banner}`} style={{ display: 'contents' }}>
        <style>{LAYOUT_CSS}</style>
        {story
          ? STORY_LAYOUT_ORDER.map((key) => <div className="lawn-story-section" data-story-section={key} id={`lawn-section-${key}`} key={key}>{SECTIONS[key]({ data, slots, nowMs, printing })}</div>)
          : LAYOUT_ORDER.map((key) => <Fragment key={key}>{SECTIONS[key]({ data, slots, nowMs, printing })}</Fragment>)}
      </div>
    </PrintContext.Provider>
  );
}

/** The standard page body, or the lawn layout while the gate's payload key is on a live lawn report. */
export function LawnLayoutSwitch({ data, mode, layout, children }) {
  return lawnLayoutActive(data, mode) ? layout : children;
}
