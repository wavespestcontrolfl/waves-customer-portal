// @vitest-environment jsdom
// Pins for the 2026-07-16 audit fixes in the V2 report primitives:
// inchLabel integer handling, unknown mowing band honesty, TrendChip
// unknown-trend behavior, MeterSvg empty-string guard.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LawnTrends, ScoreRing as LawnScoreRing, WaterIntakeBar } from './LawnReportV2';
import { ScoreRing as TreeShrubScoreRing } from '../treeShrubV2/TreeShrubReportV2';
import { MeterSvg, TrendChip } from '../GaugePrimitives';

afterEach(cleanup);

describe('WaterIntakeBar inch labels', () => {
  it('renders 0 as 0" (the old regex ate integer zeros: 0 → \'"\', 10 → \'1"\')', () => {
    render(<WaterIntakeBar water={{ rainInches: 0, irrigationInches: 1.5, totalInches: 1.5, targetInches: 1.25, status: 'balanced' }} />);
    expect(screen.getByText('0"')).toBeInTheDocument();
    // irrigation + total both read 1.5" here — the point is they render as
    // numbers, not the old bare-quote artifact
    expect(screen.getAllByText('1.5"').length).toBeGreaterThan(0);
  });
});

describe('WaterIntakeBar irrigation honesty (owner 2026-08-04)', () => {
  it('no schedule on file: shows "Not on file" instead of a false 0" reading', () => {
    render(<WaterIntakeBar water={{ rainInches: 2.96, irrigationInches: 0, totalInches: 2.96, targetInches: 0.75, status: 'high', confidence: 'low', scheduleOnFile: false }} />);
    expect(screen.getByText('Not on file')).toBeInTheDocument();
    expect(screen.queryByText('0"')).not.toBeInTheDocument();
    // The confidence tag names the actual gap instead of blaming the rain data.
    expect(screen.getByText('Irrigation not on file')).toBeInTheDocument();
    expect(screen.queryByText('Limited data this week')).not.toBeInTheDocument();
    // And a rain-only figure never renders as a complete weekly "Total"
    // beside "Not on file" (codex P2 r9).
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
  });

  it('no schedule on file: an irrigation/total-flavored explanation is suppressed with the row (codex P2 r22)', () => {
    render(<WaterIntakeBar water={{ rainInches: 2.96, irrigationInches: 0, targetInches: 0.75, status: 'high', confidence: 'low', scheduleOnFile: false, explanation: 'Your irrigation schedule added 0" this week for a total of 2.96".' }} />);
    expect(screen.queryByText(/irrigation schedule added/)).not.toBeInTheDocument();
  });

  it('no schedule on file with a missing irrigation amount still shows "Not on file" (codex P2 r24)', () => {
    render(<WaterIntakeBar water={{ rainInches: 2.96, irrigationInches: null, targetInches: 0.75, status: 'high', confidence: 'low', scheduleOnFile: false }} />);
    expect(screen.getByText('Not on file')).toBeInTheDocument();
  });

  it('no schedule on file: a pure rain narrative explanation still renders', () => {
    render(<WaterIntakeBar water={{ rainInches: 2.96, irrigationInches: 0, targetInches: 0.75, status: 'high', confidence: 'low', scheduleOnFile: false, explanation: 'Heavy rain this week kept the lawn well above its weekly needs.' }} />);
    expect(screen.getByText(/Heavy rain this week/)).toBeInTheDocument();
  });

  it('a real schedule keeps the numeric row and the standard confidence tag', () => {
    render(<WaterIntakeBar water={{ rainInches: 1.2, irrigationInches: 0.5, totalInches: 1.7, targetInches: 0.75, status: 'high', confidence: 'high', scheduleOnFile: true }} />);
    expect(screen.getByText('0.5"')).toBeInTheDocument();
    expect(screen.queryByText('Not on file')).not.toBeInTheDocument();
    expect(screen.getByText('Verified data')).toBeInTheDocument();
  });

  it('rain-unknown payload renders no false Rain 0" row and no summed Total (codex P2 r6/r7)', () => {
    render(<WaterIntakeBar water={{ rainInches: null, irrigationInches: 0.5, totalInches: null, targetInches: 0.75, status: 'unknown', confidence: 'low', scheduleOnFile: true }} />);
    expect(screen.queryByText('Rain')).not.toBeInTheDocument();
    expect(screen.getAllByText('Irrigation').length).toBeGreaterThan(0);
    // Total from summing only the known components would claim rain was zero.
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
  });

  it('all readings missing + no schedule: the CTA still renders (codex P2 r8)', () => {
    render(<WaterIntakeBar water={{ rainInches: null, irrigationInches: null, totalInches: null, targetInches: 0.75, status: 'unknown', confidence: 'low', scheduleOnFile: false }} />);
    expect(screen.getByText('Water This Week')).toBeInTheDocument();
    expect(screen.getByText(/Add your watering schedule/)).toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
    expect(screen.queryByText('Rain')).not.toBeInTheDocument();
  });

  it('no visible reading draws no bar or target legend (codex P2 r12)', () => {
    // Rain unknown + not-on-file zero irrigation: text rows only, no chart.
    const { container } = render(<WaterIntakeBar water={{ rainInches: null, irrigationInches: 0, totalInches: null, targetInches: 0.75, status: 'unknown', confidence: 'low', scheduleOnFile: false }} />);
    expect(container.querySelector('[title="Target"]')).toBeNull();
    expect(container.querySelector('[title="Rain"]')).toBeNull();
  });

  it('rain-unknown + no schedule keeps the low-confidence label (codex P2 r2)', () => {
    // Number(null) coerces to a finite 0 — the override must verify the rain
    // reading actually exists before claiming irrigation is the only gap.
    render(<WaterIntakeBar water={{ rainInches: null, irrigationInches: 0, totalInches: 0, targetInches: 0.75, status: 'unknown', confidence: 'low', scheduleOnFile: false }} />);
    expect(screen.getByText('Limited data this week')).toBeInTheDocument();
    expect(screen.queryByText('Irrigation not on file')).not.toBeInTheDocument();
  });

  it('the bar scales to visible segments when the Total row is hidden (codex P2 r10)', () => {
    // Rain 2.86 vs 0.75 target, no schedule → Total hidden but the axis must
    // still include the rain segment: the target marker lands ~21%, not 80%.
    const { container } = render(<WaterIntakeBar water={{ rainInches: 2.86, irrigationInches: 0, totalInches: 2.86, targetInches: 0.75, status: 'high', confidence: 'low', scheduleOnFile: false }} />);
    const marker = container.querySelector('[title="Target"]');
    expect(marker).toBeTruthy();
    expect(parseFloat(marker.style.left)).toBeLessThan(30);
  });

  it('an explicit scheduleOnFile:false wins over stale positive inches (codex P2 r30, supersedes r3)', () => {
    // The customer disabled their irrigation system but a prefs-only inches
    // value survived in the payload: the explicit false is authoritative —
    // no numeric row, no Total that includes the stale inches (hasTotal is
    // gated on irrOnFile per r9, so the r3 contradiction can't render).
    render(<WaterIntakeBar water={{ rainInches: 1, irrigationInches: 1.25, totalInches: 2.25, targetInches: 0.75, status: 'high', confidence: 'medium', scheduleOnFile: false }} />);
    expect(screen.queryByText('1.25"')).not.toBeInTheDocument();
    expect(screen.getByText('Not on file')).toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
  });

  it('older payloads without scheduleOnFile keep the numeric row (no false "Not on file")', () => {
    render(<WaterIntakeBar water={{ rainInches: 1.2, irrigationInches: 0, totalInches: 1.2, targetInches: 0.75, status: 'high', confidence: 'low' }} />);
    expect(screen.getByText('0"')).toBeInTheDocument();
    expect(screen.queryByText('Not on file')).not.toBeInTheDocument();
    expect(screen.getByText('Limited data this week')).toBeInTheDocument();
  });
});

describe('LawnTrends first-visit baseline (owner 2026-08-04)', () => {
  it('no chartable series + a real score → baseline card, not silence', () => {
    render(<LawnTrends trends={{}} baselineScore={74} hasNextVisit />);
    expect(screen.getByText('Progress Tracking')).toBeInTheDocument();
    expect(screen.getByText(/baseline at 74\/100/)).toBeInTheDocument();
    expect(screen.getByText(/Starting with your next visit/)).toBeInTheDocument();
  });

  it('no scheduled next visit → the copy never promises one (codex P2 r3)', () => {
    render(<LawnTrends trends={{}} baselineScore={74} />);
    expect(screen.getByText('Progress Tracking')).toBeInTheDocument();
    expect(screen.queryByText(/Starting with your next visit/)).not.toBeInTheDocument();
    expect(screen.getByText(/When your lawn is next assessed/)).toBeInTheDocument();
  });

  it('no score → still renders nothing (an unscored visit makes no baseline claim)', () => {
    const { container } = render(<LawnTrends trends={{}} />);
    expect(container).toBeEmptyDOMElement();
    // Empty string coerces to a finite 0 — must read as missing, never as
    // "baseline at 0/100" (codex P2 r5).
    const { container: empty } = render(<LawnTrends trends={{}} baselineScore="" />);
    expect(empty).toBeEmptyDOMElement();
  });

  it('real trends render charts, never the baseline card', () => {
    const overall = [
      { date: '2026-06-01', label: 'Jun 1', value: 62 },
      { date: '2026-07-01', label: 'Jul 1', value: 70 },
    ];
    render(<LawnTrends trends={{ overall }} baselineScore={70} />);
    expect(screen.getByText('Lawn Health Trend')).toBeInTheDocument();
    expect(screen.queryByText('Progress Tracking')).not.toBeInTheDocument();
  });
});

describe('LawnTrends mowing band honesty', () => {
  const mowing = [
    { date: '2026-05-26', value: 3.2 },
    { date: '2026-07-06', value: 3.4 },
  ];

  it('unknown band ([null, null] from the server) shows readings without a false off-target accent', () => {
    render(<LawnTrends trends={{ mowing, mowingBand: [null, null] }} />);
    expect(screen.getByText('Mowing Height')).toBeInTheDocument();
    expect(screen.getByText('recent readings')).toBeInTheDocument();
    expect(screen.queryByText('vs. ideal band')).not.toBeInTheDocument();
  });

  it('a real band keeps the vs. ideal band framing', () => {
    render(<LawnTrends trends={{ mowing, mowingBand: [3.5, 4.0] }} />);
    expect(screen.getByText('vs. ideal band')).toBeInTheDocument();
  });
});

describe('GaugePrimitives honesty guards', () => {
  it('TrendChip renders nothing for an unknown trend instead of asserting "Stable"', () => {
    const { container } = render(<TrendChip trend="mystery_state" delta={null} />);
    expect(container).toBeEmptyDOMElement();
    render(<TrendChip trend="stable" delta={0} />);
    expect(screen.getByText(/Stable/)).toBeInTheDocument();
  });

  it('MeterSvg treats an empty-string score as not-yet-available, not a real 0', () => {
    render(<MeterSvg score="" label={null} />);
    expect(screen.getByRole('img', { name: /score not yet available/i })).toBeInTheDocument();
  });
});

describe('WaterIntakeBar moved-home note (codex gh-r25)', () => {
  it('explains a withheld irrigation figure after an address change', () => {
    render(<WaterIntakeBar water={{ rainInches: 0.3, irrigationInches: null, targetInches: 0.75, status: 'low', scheduleOnFile: false, scheduleUnconfirmed: true }} />);
    expect(screen.getByTestId('lawn-schedule-unconfirmed')).toHaveTextContent(/address changed/);
  });
});

describe('WaterIntakeBar week-plan aftercare credit (codex gh-r14)', () => {
  const water = { rainInches: 0.2, irrigationInches: 0.5, totalInches: 0.7, targetInches: 0.75, status: 'balanced', weekPlan: { title: 'This week: run once', detail: 'About 20 minutes.', visitInPlanWeek: true, prescribesRun: true } };
  it('with a plan on the card the legacy balance explanation is suppressed — the plan is the sole watering instruction (codex gh-r21)', () => {
    render(<WaterIntakeBar water={{ ...water, status: 'low', explanation: 'A little more irrigation time will help this week.' }} />);
    expect(screen.getByTestId('lawn-week-plan')).toBeInTheDocument();
    expect(screen.queryByText(/more irrigation time will help/)).toBeNull();
    cleanup();
    render(<WaterIntakeBar water={{ rainInches: 0.2, irrigationInches: 0.5, totalInches: 0.7, targetInches: 1, status: 'low', explanation: 'A little more irrigation time will help this week.' }} />);
    expect(screen.getByText(/more irrigation time will help/)).toBeInTheDocument();
  });
  it('a credited watering-in shows the REDUCED plan, never the unreduced run under the credit note (codex gh-r24)', () => {
    const afterTreatment = { title: 'This week: covered by today’s treatment watering-in', detail: 'No further turf runs this week.' };
    render(<WaterIntakeBar water={{ ...water, weekPlan: { ...water.weekPlan, afterTreatment } }} aftercare={{ watering: 'Water in today’s application.', waterInRequired: true }} />);
    expect(screen.getByTestId('lawn-week-plan-title')).toHaveTextContent(afterTreatment.title);
    expect(screen.getByTestId('lawn-week-plan-detail')).toHaveTextContent('No further turf runs this week.');
    expect(screen.queryByText('About 20 minutes.')).toBeNull();
    cleanup();
    // No required watering-in → the plan itself.
    render(<WaterIntakeBar water={{ ...water, weekPlan: { ...water.weekPlan, afterTreatment } }} aftercare={{ watering: 'Keep your normal schedule.', waterInRequired: false }} />);
    expect(screen.getByTestId('lawn-week-plan-title')).toHaveTextContent('This week: run once');
  });
  it('credits the treatment watering only for a label-REQUIRED watering-in inside the plan week', () => {
    render(<WaterIntakeBar water={water} aftercare={{ watering: 'Water in today’s application.', waterInRequired: true }} />);
    expect(screen.getByTestId('lawn-week-plan-aftercare-note')).toHaveTextContent(/counts as one of this week/);
  });
  it('never credits the neutral "keep your normal schedule" fallback as a run', () => {
    render(<WaterIntakeBar water={water} aftercare={{ watering: 'No special watering is needed because of today’s treatment — keep your normal schedule.', waterInRequired: false }} />);
    expect(screen.getByTestId('lawn-week-plan')).toBeInTheDocument();
    expect(screen.queryByTestId('lawn-week-plan-aftercare-note')).toBeNull();
  });
  it('a HOLD plan keeps treatment-first but never claims a run was covered (codex gh-r16)', () => {
    render(<WaterIntakeBar water={{ ...water, weekPlan: { title: 'This week: skip your turf watering', detail: 'Your lawn has what it needs.', visitInPlanWeek: true, prescribesRun: false } }} aftercare={{ watering: 'Water in today’s application.', waterInRequired: true }} />);
    const note = screen.getByTestId('lawn-week-plan-aftercare-note');
    expect(note).toHaveAttribute('data-plan-credit', 'hold');
    expect(note).toHaveTextContent(/treatment comes first/);
    expect(note).toHaveTextContent(/no extra runs/);
    expect(note).not.toHaveTextContent(/counts as one of this week/);
  });
  it('never credits a historical visit\'s watering-in against the current week', () => {
    render(<WaterIntakeBar water={{ ...water, weekPlan: { ...water.weekPlan, visitInPlanWeek: false } }} aftercare={{ watering: 'Water in today’s application.', waterInRequired: true }} />);
    expect(screen.getByTestId('lawn-week-plan')).toBeInTheDocument();
    expect(screen.queryByTestId('lawn-week-plan-aftercare-note')).toBeNull();
  });
});

// The live page's Print button / Cmd+P used to print every ring the customer
// had not scrolled to as 0 with an empty arc: draw-in and count-up are gated
// on an IntersectionObserver and the `print` PrintContext only covers the
// ?mode=pdf renders, not the @media print pass. beforeprint now settles the
// rings in place (shared usePrintRequested — same code path in both reports).
describe('ScoreRing settles on beforeprint without ever scrolling into view', () => {
  it.each([
    ['lawnV2', LawnScoreRing],
    ['treeShrubV2', TreeShrubScoreRing],
  ])('%s: a never-intersected ring renders its final value and full arc once printing begins', (_label, ScoreRing) => {
    // test-setup's IntersectionObserver stub never fires, so the ring sits in
    // its pre-scroll state — exactly the frame the print pass used to capture.
    const { container } = render(<ScoreRing value={72} size={120} stroke={10} />);
    const arc = () => container.querySelectorAll('circle')[1];
    const circumference = Number(arc().getAttribute('stroke-dasharray'));
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(Number(arc().getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference, 5);

    // Deliberately NOT wrapped in act(): the browser snapshots when the
    // beforeprint handlers return, so the value and arc must be in the DOM
    // synchronously — act() would drain passive effects and mask a late copy
    // (codex P1 r1).
    const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      window.dispatchEvent(new Event('beforeprint'));
      expect(screen.getByText('72')).toBeInTheDocument();
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
    }
    act(() => {}); // drain anything left so the remaining assertions see steady state

    expect(screen.getByText('72')).toBeInTheDocument();
    expect(Number(arc().getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * (1 - 0.72), 5);
    expect(arc().style.transition).toBe('none');
  });
});


describe('Stacked lawn trends', () => {
  it('explains each score and keeps metric cards in one column', () => {
    const points = [{ label: 'Jul 10', value: 81 }, { label: 'Sep 5', value: 83 }];
    const { container } = render(<LawnTrends trends={{ overall: points, weed: points, coverage: points, color: points, stress: points }} />);
    expect(screen.getAllByText('What this means')).toHaveLength(5);
    expect(screen.queryByText('higher is better')).toBeNull();
    expect(screen.queryByText('Your overall lawn score across recent visits.')).toBeNull();
    expect(screen.getAllByText('Latest reading: 83. Previous reading: 81.')).toHaveLength(5);
    const grid = [...container.querySelectorAll('div')].find((node) => node.style.display === 'grid' && node.style.gridTemplateColumns === 'minmax(0, 1fr)');
    expect(grid).toBeTruthy();
    expect(grid.children).toHaveLength(4);
  });
});
