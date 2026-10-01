// @vitest-environment jsdom
// Findings / water card diet (lawn report rebuild P8): in lead mode (the
// payload carries `lead`, GATE_LAWN_REPORT_LEAD) each finding keeps its
// headline, status and what-we-saw, and everything else folds into a native
// <details> that print/PDF opens. Without a lead the legacy rows render as before.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LawnReportV2Section from './LawnReportV2Section';
import { LawnInsightCards, LawnPhotoStrip, PrintContext, VisualDiagnosisCards, WaterIntakeBar } from './LawnReportV2';

afterEach(cleanup);

const LEAD = {
  headline: 'Stable, with a thin edge to watch',
  why: 'The thin edge is the main driver.',
  applied: null,
  yourPart: [],
  next: 'We will recheck the thin edge.',
};

const WATCH = {
  category: 'damage', status: 'watch', priority: 2, confidence: 'ai_supported',
  headline: 'Thin edge by the driveway',
  whatWeSaw: 'Thinning tan patches along the driveway edge.',
  whyItMatters: 'Stress here can spread if it is left alone.',
  wavesAction: 'Applied a curative treatment to the thin edge.',
  customerAction: 'Mow that strip one notch higher.',
  nextVisitPlan: 'Recheck the edge next visit.',
};
const URGENT = {
  category: 'weeds', status: 'needs_attention', priority: 1, confidence: null,
  headline: 'Weed pressure is climbing',
  whatWeSaw: 'Weeds competing with the turf in places.',
  whyItMatters: 'Weeds spread fastest when the turf is thin.',
  wavesAction: 'Spot-treated the weeds.',
  nextVisitPlan: 'Reassess weed pressure next visit.',
};
const OVERALL = {
  category: 'overall', status: 'healthy', priority: 1,
  headline: 'Your lawn is in good shape',
  whatWeSaw: 'Coverage, color, and weed control all look healthy today.',
  whyItMatters: null, wavesAction: null, nextVisitPlan: 'Keep the program steady.',
};

const detailsOf = (node) => node.closest('details');

describe('findings card in lead mode', () => {
  it('is titled "Priority findings" with no sub-line', () => {
    render(<LawnInsightCards insights={[WATCH]} lead={LEAD} />);
    expect(screen.getByRole('heading', { name: 'Priority findings' })).toBeInTheDocument();
    expect(screen.queryByText(/key findings from today/)).toBeNull();
    expect(screen.queryByText(/Action Plan/)).toBeNull();
  });

  it('keeps headline, status and what we saw visible, and folds the rest into "More about this"', () => {
    render(<LawnInsightCards insights={[URGENT, WATCH]} lead={LEAD} />);
    expect(screen.getByText(WATCH.headline)).toBeInTheDocument();
    expect(detailsOf(screen.getByText(WATCH.whatWeSaw))).toBeNull();
    expect(screen.getAllByText('More about this')).toHaveLength(2);
    const watchMore = detailsOf(screen.getByText(WATCH.whyItMatters));
    expect(watchMore).not.toBeNull();
    expect(within(watchMore).getByText(WATCH.wavesAction)).toBeInTheDocument();
    expect(within(watchMore).getByText(WATCH.nextVisitPlan)).toBeInTheDocument();
    expect(within(watchMore).getByText('Seen in today’s photos')).toBeInTheDocument();
  });

  it('shows why it matters inline for needs_attention only', () => {
    render(<LawnInsightCards insights={[URGENT, WATCH]} lead={LEAD} />);
    expect(detailsOf(screen.getByText(URGENT.whyItMatters))).toBeNull();
    expect(detailsOf(screen.getByText(WATCH.whyItMatters))).not.toBeNull();
    expect(detailsOf(screen.getByText(URGENT.wavesAction))).not.toBeNull();
  });

  it('keeps a homeowner step visible beside the lead (a step the lead did not carry is never folded away)', () => {
    render(<LawnInsightCards insights={[URGENT, WATCH]} lead={LEAD} />);
    expect(detailsOf(screen.getByText(WATCH.customerAction))).toBeNull();
  });

  it('keeps a top-card plan the lead could not carry visible, and folds it away when the lead owns the line', () => {
    const { unmount } = render(<LawnInsightCards insights={[URGENT]} lead={{ ...LEAD, next: null }} />);
    expect(detailsOf(screen.getByText(URGENT.nextVisitPlan))).toBeNull();
    unmount();
    render(<LawnInsightCards insights={[URGENT]} lead={LEAD} />);
    expect(screen.queryByText(URGENT.nextVisitPlan)).toBeNull();
  });

  it('opens every expander in print and leaves them closed on screen', () => {
    const { container, unmount } = render(<LawnInsightCards insights={[URGENT, WATCH]} lead={LEAD} />);
    const closed = [...container.querySelectorAll('details')];
    expect(closed).toHaveLength(2);
    expect(closed.every((d) => !d.open)).toBe(true);
    unmount();
    const printed = render(<PrintContext.Provider value><LawnInsightCards insights={[URGENT, WATCH]} lead={LEAD} /></PrintContext.Provider>);
    const open = [...printed.container.querySelectorAll('details')];
    expect(open).toHaveLength(2);
    expect(open.every((d) => d.open)).toBe(true);
    // Expander contents are in the printed DOM.
    expect(printed.container).toHaveTextContent(WATCH.wavesAction);
    expect(printed.container).toHaveTextContent(WATCH.nextVisitPlan);
  });

  it('hides the whole card when the only insight is the overall reassurance', () => {
    const { container } = render(<LawnInsightCards insights={[OVERALL]} lead={LEAD} />);
    expect(container).toBeEmptyDOMElement();
    const section = render(<LawnReportV2Section data={{ snapshot: { overallScore: 90 }, lead: LEAD, insights: [OVERALL] }} />);
    expect(section.container).not.toHaveTextContent('Priority findings');
  });

  it('renders no expander when a card has nothing to fold', () => {
    const bare = { category: 'weeds', status: 'needs_attention', priority: 1, headline: 'Weeds', whatWeSaw: 'Some weeds.', whyItMatters: 'They spread.' };
    const { container } = render(<LawnInsightCards insights={[bare]} lead={LEAD} />);
    expect(container.querySelector('details')).toBeNull();
  });
});

describe('findings card without a lead (legacy)', () => {
  it('keeps the old title, sub-line, inline rows and no expander', () => {
    const { container } = render(<LawnInsightCards insights={[URGENT, WATCH]} />);
    expect(screen.getByText('Priority Findings & Action Plan')).toBeInTheDocument();
    expect(screen.getByText(/key findings from today/)).toBeInTheDocument();
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText(WATCH.wavesAction)).toBeInTheDocument();
    expect(screen.getByText(WATCH.whyItMatters)).toBeInTheDocument();
    expect(screen.getByText('Seen in today’s photos')).toBeInTheDocument();
  });

  it('still renders the overall reassurance card', () => {
    render(<LawnInsightCards insights={[OVERALL]} />);
    expect(screen.getByText(OVERALL.headline)).toBeInTheDocument();
  });
});

const WATER = { rainInches: 0.9, irrigationInches: 0.7, totalInches: 1.6, targetInches: 1.25, status: 'balanced', scheduleOnFile: true, coverageWatch: true, explanation: 'Rain and irrigation together landed on target this week.' };
const AFTERCARE = { watering: 'Water in with 0.25 inches today.', reentry: 'Stay off the lawn until it dries.', evidenceSource: 'product_instruction', creditableWaterIn: true, waterInRequired: true };
const REVIEW_AFTERCARE = { watering: 'Confirm the label directions with your technician.', evidenceSource: 'legacy_unverified_instruction', needsReview: true };
const PLAN = { title: 'This week: 25 minutes per turf zone', detail: 'Run the zones on your allowed days.', action: 'run', prescribesRun: true };

describe('water card in lead mode', () => {
  it('puts the reading, label note and re-entry note in one "Why this reading" expander and drops the coverage callout', () => {
    const { container } = render(<WaterIntakeBar water={WATER} aftercare={AFTERCARE} lead />);
    expect(container.querySelector('.lawn-callout-watch')).toBeNull();
    expect(screen.queryByText(/Coverage watch/)).toBeNull();
    const details = container.querySelectorAll('details');
    expect(details).toHaveLength(1);
    expect(within(details[0]).getByText('Why this reading')).toBeInTheDocument();
    expect(within(details[0]).getByText(WATER.explanation)).toBeInTheDocument();
    expect(details[0].querySelector('.lawn-callout-after')).toHaveTextContent(AFTERCARE.watering);
    expect(details[0]).toHaveTextContent(AFTERCARE.reentry);
    expect(details[0].open).toBe(false);
  });

  it('orders numbers, status pill, plan callout, then the expander, and keeps the plan test ids', () => {
    const { container } = render(<WaterIntakeBar water={{ ...WATER, weekPlan: PLAN, confidence: 'high' }} aftercare={REVIEW_AFTERCARE} lead />);
    const text = container.textContent;
    expect(text.indexOf('Target range')).toBeLessThan(text.indexOf('Balanced'));
    expect(text.indexOf('Balanced')).toBeLessThan(text.indexOf(PLAN.title));
    expect(text.indexOf(PLAN.title)).toBeLessThan(text.indexOf('Why this reading'));
    expect(screen.getByTestId('lawn-week-plan-title')).toHaveTextContent(PLAN.title);
    expect(screen.getByTestId('lawn-week-plan-detail')).toHaveTextContent(PLAN.detail);
    expect(screen.getByTestId('lawn-week-plan-condition')).toBeInTheDocument();
    // A plan on the card is the sole watering instruction: the balance explanation stays suppressed.
    expect(screen.queryByText(WATER.explanation)).toBeNull();
    expect(within(container.querySelector('details')).queryByText(WATER.explanation)).toBeNull();
  });

  it('renders no expander when there is nothing to fold, and keeps the no-schedule CTA', () => {
    const { container } = render(<WaterIntakeBar water={{ rainInches: 2, irrigationInches: 0, targetInches: 1, status: 'high', scheduleOnFile: false }} lead />);
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('.lawn-water-cta')).not.toBeNull();
    expect(screen.getByText('Add your watering schedule →')).toBeInTheDocument();
  });

  it('opens the expander in print', () => {
    const { container } = render(<PrintContext.Provider value><WaterIntakeBar water={WATER} aftercare={AFTERCARE} lead /></PrintContext.Provider>);
    expect(container.querySelector('details').open).toBe(true);
    expect(container).toHaveTextContent(WATER.explanation);
  });
});

describe('water card without a lead (legacy)', () => {
  it('keeps the explanation inline, the coverage callout and the after-visit note', () => {
    const { container } = render(<WaterIntakeBar water={WATER} aftercare={AFTERCARE} />);
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText(WATER.explanation)).toBeInTheDocument();
    expect(container.querySelector('.lawn-callout-watch')).toHaveTextContent('Coverage watch:');
    expect(container.querySelector('.lawn-callout-after')).toHaveTextContent(AFTERCARE.watering);
  });
});

describe('photo notes and Turf Health sub-line in lead mode', () => {
  it('puts the photo summary in a "Technician notes" expander, exactly once', () => {
    const photos = [{ url: 'https://example.com/front.jpg', label: 'Front yard' }];
    const { container } = render(<LawnPhotoStrip photos={photos} summary="A few thin tan patches." lead />);
    expect(screen.getAllByText('A few thin tan patches.')).toHaveLength(1);
    const notes = detailsOf(screen.getByText('A few thin tan patches.'));
    expect(within(notes).getByText('Technician notes')).toBeInTheDocument();
    expect(notes.open).toBe(false);
    expect(container.querySelectorAll('details')).toHaveLength(1);
  });

  it('opens the notes in print, and keeps the bare paragraph without a lead', () => {
    const photos = [{ url: 'https://example.com/front.jpg' }];
    const printed = render(<PrintContext.Provider value><LawnPhotoStrip photos={photos} summary="A few thin tan patches." lead /></PrintContext.Provider>);
    expect(printed.container.querySelector('details').open).toBe(true);
    cleanup();
    const legacy = render(<LawnPhotoStrip photos={photos} summary="A few thin tan patches." />);
    expect(legacy.container.querySelector('details')).toBeNull();
    expect(screen.getAllByText('A few thin tan patches.')).toHaveLength(1);
  });

  it('Turf Health sub is the score explanation when present, else a short line; legacy keeps the long boilerplate', () => {
    const cats = [{ key: 'coverage', label: 'Coverage', score: 70, status: 'watch' }];
    const { unmount } = render(<VisualDiagnosisCards categories={cats} lead scoreExplanation="The score is mainly pulled down by coverage." />);
    expect(screen.getByText('The score is mainly pulled down by coverage.')).toBeInTheDocument();
    unmount();
    const { unmount: u2 } = render(<VisualDiagnosisCards categories={cats} lead />);
    expect(screen.getByText('Scored from today’s photos. Tap a row for details.')).toBeInTheDocument();
    u2();
    render(<VisualDiagnosisCards categories={cats} />);
    expect(screen.getByText(/Five diagnostic categories scored from today/)).toBeInTheDocument();
  });

  it('the section feeds the snapshot score explanation to the Turf Health sub-line in lead mode', () => {
    const data = {
      snapshot: { overallScore: 70, scoreExplanation: 'The score is mainly pulled down by coverage.' },
      lead: LEAD,
      diagnosis: [{ key: 'coverage', label: 'Coverage', score: 70, status: 'watch' }],
      photos: [], photoSummary: 'One summary line.',
    };
    render(<LawnReportV2Section data={data} />);
    expect(screen.getByText('The score is mainly pulled down by coverage.')).toBeInTheDocument();
    expect(screen.getAllByText('One summary line.')).toHaveLength(1);
    expect(detailsOf(screen.getByText('One summary line.'))).not.toBeNull();
  });
});

// The live page's own print pass (Report Tools "Print", Cmd+P) keeps
// PrintContext false, so the expanders open on beforeprint too: a closed
// <details> prints without its contents (codex P1 #5517 r1).
describe('lead-mode expanders open for the browser print pass', () => {
  it('findings, water and technician-notes details open once printing begins', () => {
    const { container } = render(
      <>
        <LawnInsightCards insights={[URGENT, WATCH]} lead={LEAD} />
        <WaterIntakeBar lead water={{ status: 'balanced', rainInches: 0.4, irrigationInches: 0.6, targetInches: 1, explanation: 'Rain plus your sprinklers met the target.' }} aftercare={{ watering: 'Skip turf watering until Thu 3 PM.', reentry: 'Keep pets off until dry.' }} />
        <LawnPhotoStrip lead photos={[{ url: 'https://example.test/a.jpg', label: 'Front' }]} summary="A few thin tan patches along the driveway edge." />
      </>,
    );
    const details = () => [...container.querySelectorAll('details')];
    expect(details().length).toBeGreaterThanOrEqual(3);
    expect(details().every((d) => !d.open)).toBe(true);
    const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      window.dispatchEvent(new Event('beforeprint'));
      expect(details().every((d) => d.open)).toBe(true);
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
  });
});
