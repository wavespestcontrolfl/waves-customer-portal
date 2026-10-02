// @vitest-environment jsdom
// The lawn report LEAD layout (lawn report rebuild P7, GATE_LAWN_REPORT_LEAD):
// ReportViewPage mounts LawnLeadCard under the watering banner; the lawn section
// then drops the snapshot hero and the follow-up card and opens with the photo
// strip. A payload without `lead` renders the legacy layout.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import LawnReportV2Section from './LawnReportV2Section';
import { LawnInsightCards, LawnLeadCard } from './LawnReportV2';

afterEach(cleanup);

const SNAPSHOT = {
  overallScore: 68,
  status: 'watch',
  statusHeadline: 'Stable — watching thin edges',
  scoreExplanation: 'The score is mainly pulled down by stress and damage signals.',
  rootCause: 'The thin edge is the main driver.',
  seasonalNote: 'Peak-season lawns often run a little thinner at the edges.',
  todaysFocus: ['Weed control', 'Fungus prevention'],
  watching: ['Thin edge by the driveway'],
  wavesNext: 'We will recheck the thin edge.',
  customerAction: 'Raise your mower to 4 inches this week.',
  noActionNeeded: false,
  nextVisit: { label: 'Tuesday, October 13', source: 'scheduled' },
};

const LEAD = {
  headline: 'Stable, with a thin edge to watch',
  why: 'The score is mainly pulled down by stress and damage signals, while the other areas look healthy.',
  applied: 'Today we applied a broadleaf herbicide to the edge weeds.',
  yourPart: ['Raise your mower to 4 inches this week.'],
  next: 'We will recheck the thin edge and compare it with today’s photos.',
};

const INSIGHT = {
  category: 'damage', status: 'watch', priority: 1, headline: 'Thin edge by the driveway',
  whatWeSaw: 'Thinning tan patches along the driveway edge.',
  whyItMatters: 'Stress here can spread if it is left alone.',
  wavesAction: 'Applied a curative treatment to the thin edge.',
  customerAction: 'Raise your mower to 4 inches this week.',
  nextVisitPlan: 'We will recheck the thin edge and compare it with today’s photos.',
};

const PHOTOS = [{ url: 'https://example.com/front.jpg', label: 'Front yard' }];

const payload = (overrides = {}) => ({
  snapshot: SNAPSHOT,
  lead: LEAD,
  insights: [INSIGHT],
  followUp: { scheduled: true, headline: 'Follow-up already planned', reason: 'We will recheck the thin edge.', customerAction: 'No action is needed from you before then unless the area changes quickly.' },
  photos: PHOTOS,
  photoSummary: 'A few thin tan patches along the driveway edge.',
  ...overrides,
});

const words = (node) => (node.textContent || '').trim().split(/\s+/).filter(Boolean).length;

const renderLead = (overrides = {}) => {
  const { lead = LEAD, snapshot = SNAPSHOT } = overrides;
  return render(<LawnLeadCard lead={lead} snapshot={snapshot} />);
};

describe('LawnLeadCard layout', () => {
  it('renders the headline, why, applied block, your part and one next visit line in the lead region', () => {
    renderLead();
    const region = screen.getByTestId('lawn-lead-region');
    expect(within(region).getByRole('heading', { name: LEAD.headline })).toBeInTheDocument();
    expect(region).toHaveTextContent(LEAD.why);
    expect(region).toHaveTextContent('What we applied today');
    expect(region).toHaveTextContent(LEAD.applied);
    expect(region).toHaveTextContent('Your part this week');
    expect(region).toHaveTextContent(LEAD.yourPart[0]);
  });

  it('renders What to expect and Watching blocks only when the v6 writer supplied them', () => {
    const { unmount } = renderLead();
    expect(screen.queryByTestId('lawn-lead-expect')).toBeNull();
    expect(screen.queryByTestId('lawn-lead-watching')).toBeNull();
    unmount();
    renderLead({ lead: { ...LEAD, whatToExpect: 'Weeds usually start to yellow or curl within about 3 to 7 days.', watching: 'Thin areas along the driveway edge.' } });
    const expectBlock = screen.getByTestId('lawn-lead-expect');
    expect(expectBlock).toHaveTextContent('What to expect');
    expect(expectBlock).toHaveTextContent('Weeds usually start to yellow or curl within about 3 to 7 days.');
    expect(screen.getByTestId('lawn-lead-watching')).toHaveTextContent('Watching');
    expect(screen.getByTestId('lawn-lead-watching')).toHaveTextContent('Thin areas along the driveway edge.');
  });

  it('leaves out Today’s focus, the driving box, the watching list, "What Waves will do next" and the seasonal note', () => {
    renderLead();
    const region = screen.getByTestId('lawn-lead-region');
    for (const text of [/Today.s focus/i, /What.s driving it/i, /Main things we.re watching/i, /What Waves will do next/i, SNAPSHOT.seasonalNote, 'Weed control', 'Thin edge by the driveway']) {
      expect(within(region).queryByText(text)).toBeNull();
    }
  });

  it('joins the next visit date and lead.next on one line', () => {
    renderLead();
    const region = screen.getByTestId('lawn-lead-region');
    expect(within(region).getAllByText('Next visit')).toHaveLength(1);
    expect(region).toHaveTextContent(`Tuesday, October 13 — ${LEAD.next}`);
  });

  it('shows either half alone, and an estimate as "Expected around"', () => {
    const { unmount } = renderLead({ lead: { ...LEAD, next: null } });
    let region = screen.getByTestId('lawn-lead-region');
    expect(region).toHaveTextContent('Tuesday, October 13');
    expect(region).not.toHaveTextContent('—');
    unmount();
    renderLead({ snapshot: { ...SNAPSHOT, nextVisit: null } });
    region = screen.getByTestId('lawn-lead-region');
    expect(region).toHaveTextContent(LEAD.next);
    expect(within(region).getAllByText('Next visit')).toHaveLength(1);
    cleanup();
    renderLead({ snapshot: { ...SNAPSHOT, nextVisit: { label: 'Tuesday, October 13', source: 'estimated', cadenceWeeks: 4 } } });
    expect(screen.getByTestId('lawn-lead-region')).toHaveTextContent(`Expected around Tuesday, October 13 (about every 4 weeks) — ${LEAD.next}`);
  });

  it('guards an Invalid Date label and renders no Next visit line when both halves are missing', () => {
    renderLead({ snapshot: { ...SNAPSHOT, nextVisit: { label: 'Invalid Date', source: 'scheduled' } }, lead: { ...LEAD, next: null } });
    const region = screen.getByTestId('lawn-lead-region');
    expect(region).not.toHaveTextContent('Invalid Date');
    expect(within(region).queryByText('Next visit')).toBeNull();
  });

  it('an empty yourPart renders no "Your part" line and no stock no-action sentence', () => {
    renderLead({ lead: { ...LEAD, yourPart: [] }, snapshot: { ...SNAPSHOT, customerAction: null, noActionNeeded: true } });
    const region = screen.getByTestId('lawn-lead-region');
    expect(within(region).queryByText(/Your part/i)).toBeNull();
    expect(region).not.toHaveTextContent(/No action is needed/i);
  });

  it('falls back to the status label when the lead has no headline', () => {
    renderLead({ lead: { ...LEAD, headline: null } });
    const region = screen.getByTestId('lawn-lead-region');
    expect(within(region).getByRole('heading', { level: 2 })).toHaveTextContent(/watch/i);
  });

  it('stays inside the 250 visible-word budget for a realistic payload (banner lines included)', () => {
    const banner = ['Water in today’s treatment by Thu 2 PM.', 'Run spray heads about 15 minutes a zone and rotors about 40 minutes.', 'Run it even if it is not your usual day.'];
    renderLead();
    const bannerWords = banner.join(' ').split(/\s+/).length;
    expect(words(screen.getByTestId('lawn-lead-region')) + bannerWords).toBeLessThanOrEqual(250);
  });

  describe('Since your last visit (lead.sinceLast)', () => {
    const SINCE = { priorDate: '2026-08-01', lines: ['Last visit we applied weed control.', 'Weed control is on track.'] };

    it('renders nothing when the lead has no block, or an empty one', () => {
      renderLead();
      expect(screen.queryByTestId('lawn-since-last')).toBeNull();
      cleanup();
      renderLead({ lead: { ...LEAD, sinceLast: { priorDate: '2026-08-01', lines: [] } } });
      expect(screen.queryByTestId('lawn-since-last')).toBeNull();
    });

    it('prints the server lines as given, labelled with the prior visit day, above "What we applied today"', () => {
      renderLead({ lead: { ...LEAD, sinceLast: SINCE } });
      const block = screen.getByTestId('lawn-since-last');
      expect(block).toHaveTextContent('Since your last visit, Aug 1');
      for (const line of SINCE.lines) expect(within(block).getByText(line)).toBeInTheDocument();
      const region = screen.getByTestId('lawn-lead-region');
      const text = region.textContent;
      expect(text.indexOf('Since your last visit')).toBeLessThan(text.indexOf('What we applied today'));
    });

    it('the day is the calendar day the server sent, whatever the viewer time zone, and a bad date drops only the date', () => {
      renderLead({ lead: { ...LEAD, sinceLast: { ...SINCE, priorDate: '2026-12-31' } } });
      expect(screen.getByTestId('lawn-since-last')).toHaveTextContent('Since your last visit, Dec 31');
      cleanup();
      renderLead({ lead: { ...LEAD, sinceLast: { ...SINCE, priorDate: 'nope' } } });
      const block = screen.getByTestId('lawn-since-last');
      expect(block).toHaveTextContent('Since your last visit');
      expect(block).not.toHaveTextContent(/Invalid|nope|,/);
    });

    it('still fits the 250 visible-word budget with a full block and banner lines', () => {
      const full = { priorDate: '2026-08-01', lines: [
        'Last visit we applied weed control, fungus protection and fertilizer.',
        'Your overall lawn score is down since then.',
        'Weed control is behind where we expected.',
        'Still on our watch list: weeds and mowing height.',
      ] };
      const banner = ['Water in today’s treatment by Thu 2 PM.', 'Run spray heads about 15 minutes a zone and rotors about 40 minutes.', 'Run it even if it is not your usual day.'];
      renderLead({ lead: { ...LEAD, sinceLast: full } });
      expect(words(screen.getByTestId('lawn-lead-region')) + banner.join(' ').split(/\s+/).length).toBeLessThanOrEqual(250);
    });
  });

  it('merges a style override (the page mounts it with a top margin)', () => {
    render(<LawnLeadCard lead={LEAD} snapshot={SNAPSHOT} style={{ marginTop: 16 }} />);
    expect(screen.getByTestId('lawn-lead-region').firstElementChild.style.marginTop).toBe('16px');
  });

  it('renders a bare lead', () => {
    render(<LawnLeadCard lead={{ headline: null, why: null, applied: null, yourPart: [], next: null }} snapshot={{ overallScore: 90 }} />);
    expect(screen.getByTestId('lawn-lead-region')).toBeInTheDocument();
  });
});

describe('LawnReportV2Section lead mode', () => {
  it('does not mount the lead card, the hero or the follow-up card itself', () => {
    render(<LawnReportV2Section data={payload()} />);
    expect(screen.queryByTestId('lawn-lead-region')).toBeNull();
    expect(screen.queryByText('Overall Lawn Status')).toBeNull();
    expect(screen.queryByText('Follow-up already planned')).toBeNull();
    expect(screen.queryByText(/No action is needed from you/)).toBeNull();
    expect(screen.queryByText(SNAPSHOT.seasonalNote)).toBeNull();
  });

  it('opens with the standalone photo strip and its summary, then the findings', () => {
    const { container } = render(<LawnReportV2Section data={payload()} />);
    const embed = container.querySelector('.report-v2-embed');
    expect(embed.firstElementChild).toHaveTextContent('A few thin tan patches along the driveway edge.');
    expect(screen.getByText('Thin edge by the driveway')).toBeInTheDocument();
    const text = embed.textContent;
    expect(text.indexOf('A few thin tan patches')).toBeLessThan(text.indexOf('Priority findings'));
  });

  it('the top card hides its step the lead shows and its next-visit plan whenever the lead has one', () => {
    render(<LawnReportV2Section data={payload()} />);
    expect(screen.getByText(INSIGHT.whatWeSaw)).toBeInTheDocument();
    expect(screen.queryByText(INSIGHT.customerAction)).toBeNull();
    expect(screen.queryByText(INSIGHT.nextVisitPlan, { exact: false })).toBeNull();
  });

  it('hides the plan even when lead.next is a different sentence', () => {
    render(<LawnReportV2Section data={payload({ lead: { ...LEAD, next: 'Recheck the whole front yard.' }, insights: [{ ...INSIGHT, customerAction: null, nextVisitPlan: 'Spot-treat the edge.' }] })} />);
    expect(screen.queryByText('Spot-treat the edge.', { exact: false })).toBeNull();
  });

  it('keeps the card plan when the lead has no next line', () => {
    render(<LawnReportV2Section data={payload({ lead: { ...LEAD, next: null }, insights: [{ ...INSIGHT, customerAction: null, nextVisitPlan: 'Spot-treat the edge.' }] })} />);
    expect(screen.getByText('Spot-treat the edge.', { exact: false })).toBeInTheDocument();
  });

  it('prints a plan the lead could not show beside the card step, so a follow-up is still stated', () => {
    const card = { ...INSIGHT, customerAction: 'Check sprinkler coverage in that area.', nextVisitPlan: 'Recheck the moisture balance next visit.' };
    render(<LawnReportV2Section data={payload({ insights: [card], lead: { ...LEAD, yourPart: [], next: null } })} />);
    expect(screen.getByText('Check sprinkler coverage in that area.')).toBeInTheDocument();
    expect(screen.getByText('Recheck the moisture balance next visit.', { exact: false })).toBeInTheDocument();
  });

  it('keeps the follow-up card, without a "Your part" line, when the lead has no next line', () => {
    const { container } = render(<LawnReportV2Section data={payload({ lead: { ...LEAD, next: null } })} />);
    const card = screen.getByText('Follow-up already planned');
    expect(card).toBeInTheDocument();
    expect(screen.getByText('We will recheck the thin edge.')).toBeInTheDocument();
    expect(screen.queryByText(/Your part:/)).toBeNull();
    expect(screen.queryByText(/No action is needed from you/)).toBeNull();
    // Between the photo strip and the findings.
    const text = container.textContent;
    expect(text.indexOf('A few thin tan patches')).toBeLessThan(text.indexOf('Follow-up already planned'));
    expect(text.indexOf('Follow-up already planned')).toBeLessThan(text.indexOf('Priority findings'));
  });

  it('does not mount the follow-up card when the lead carries a next line, or when it has no reason or is not scheduled', () => {
    const { unmount } = render(<LawnReportV2Section data={payload()} />);
    expect(screen.queryByText('Follow-up already planned')).toBeNull();
    unmount();
    const base = payload({ lead: { ...LEAD, next: null } }).followUp;
    const { unmount: u2 } = render(<LawnReportV2Section data={payload({ lead: { ...LEAD, next: null }, followUp: { ...base, reason: null } })} />);
    expect(screen.queryByText('Follow-up already planned')).toBeNull();
    u2();
    render(<LawnReportV2Section data={payload({ lead: { ...LEAD, next: null }, followUp: { ...base, scheduled: false } })} />);
    expect(screen.queryByText('Follow-up already planned')).toBeNull();
  });

  it('finding rows read at 16px in lead mode and 14.5px without a lead', () => {
    const { unmount } = render(<LawnInsightCards insights={[{ ...INSIGHT, customerAction: null, nextVisitPlan: null }]} lead={{ ...LEAD, next: null }} />);
    const row = screen.getByText(INSIGHT.whatWeSaw).closest('div');
    expect(row.style.fontSize).toBe('16px');
    expect(screen.getByText(INSIGHT.whyItMatters).closest('div').style.fontSize).toBe('16px');
    unmount();
    render(<LawnInsightCards insights={[INSIGHT]} />);
    expect(screen.getByText(INSIGHT.whatWeSaw).closest('div').style.fontSize).toBe('14.5px');
    expect(screen.getByText(INSIGHT.customerAction).closest('div').style.fontSize).toBe('14.5px');
  });

  it('keeps a card step the lead did not carry (the lead dropped a watering step under the banner)', () => {
    const cardOnly = { ...INSIGHT, customerAction: 'Check sprinkler coverage in that area.' };
    render(<LawnReportV2Section data={payload({ insights: [cardOnly], lead: { ...LEAD, yourPart: [] } })} />);
    expect(screen.getByText('Check sprinkler coverage in that area.')).toBeInTheDocument();
  });

  it('only the top-ranked card is trimmed', () => {
    const second = { ...INSIGHT, priority: 2, headline: 'Second finding', whatWeSaw: 'Another thing.' };
    render(<LawnReportV2Section data={payload({ insights: [INSIGHT, second] })} />);
    expect(screen.getAllByText(INSIGHT.customerAction)).toHaveLength(1);
    // The top card's plan is the lead's "Next visit" line; the second card's own plan sits in its expander.
    expect(screen.queryAllByText(INSIGHT.nextVisitPlan, { exact: false })).toHaveLength(1);
    expect(screen.getByText(INSIGHT.nextVisitPlan, { exact: false }).closest('details')).not.toBeNull();
  });

  it('LawnInsightCards without a lead prop keeps every row (default behavior unchanged)', () => {
    render(<LawnInsightCards insights={[INSIGHT]} />);
    expect(screen.getByText(INSIGHT.customerAction)).toBeInTheDocument();
  });

  it('renders the water card above the score breakdown', () => {
    const { container } = render(<LawnReportV2Section data={payload({
      water: { rainInches: 0.9, irrigationInches: 0.7, totalInches: 1.6, targetInches: 1.25, status: 'balanced', scheduleOnFile: true },
      diagnosis: [{ key: 'turf_density', label: 'Turf Density', score: 73, status: 'watch' }],
    })} />);
    const text = container.textContent;
    expect(text.indexOf('Water This Week')).toBeGreaterThan(text.indexOf('Priority findings'));
    expect(text.indexOf('Turf Density')).toBeGreaterThan(text.indexOf('Water This Week'));
  });
});

describe('program line (GATE_LAWN_EXPECTATIONS)', () => {
  const PROGRAM = 'In October the program focuses on the fall feeding with iron, plus fall disease prevention where the lawn needs it and a thatch check.';
  const programSnapshot = { ...SNAPSHOT, seasonalNote: PROGRAM, seasonalNoteSource: 'program' };

  it('lead mode renders the program line exactly once, beside the trends', () => {
    const { container } = render(<LawnReportV2Section data={payload({ snapshot: programSnapshot, trends: { overall: [{ date: '2026-04-15', value: 60 }, { date: '2026-10-14', value: 68 }] } })} />);
    expect(screen.getAllByText(PROGRAM)).toHaveLength(1);
    expect(container.textContent.match(new RegExp(PROGRAM.slice(0, 30), 'g'))).toHaveLength(1);
    expect(screen.getByText('This time of year')).toBeInTheDocument();
  });

  it('lead mode renders it with no trends payload too (a first visit)', () => {
    render(<LawnReportV2Section data={payload({ snapshot: programSnapshot })} />);
    expect(screen.getAllByText(PROGRAM)).toHaveLength(1);
  });

  it('lead mode never renders an unmarked season note (gate off, or a null program line)', () => {
    render(<LawnReportV2Section data={payload()} />);
    expect(screen.queryByText('This time of year')).toBeNull();
    expect(screen.queryByText(SNAPSHOT.seasonalNote)).toBeNull();
  });

  it('legacy layout renders the line once, in the hero, without the lead block', () => {
    render(<LawnReportV2Section data={payload({ lead: undefined, snapshot: programSnapshot })} />);
    expect(screen.getAllByText(PROGRAM)).toHaveLength(1);
    expect(screen.queryByText('This time of year')).toBeNull();
  });
});

describe('legacy layout without a lead', () => {
  it('still renders the hero, the follow-up card and the full findings rows', () => {
    render(<LawnReportV2Section data={payload({ lead: undefined })} />);
    expect(screen.queryByTestId('lawn-lead-region')).toBeNull();
    expect(screen.getByText('Overall Lawn Status')).toBeInTheDocument();
    expect(screen.getByText(/Today.s focus/)).toBeInTheDocument();
    expect(screen.getByText('Main things we’re watching')).toBeInTheDocument();
    expect(screen.getByText('What Waves will do next')).toBeInTheDocument();
    expect(screen.getByText(SNAPSHOT.seasonalNote)).toBeInTheDocument();
    expect(screen.getByText('Follow-up already planned')).toBeInTheDocument();
    expect(screen.getAllByText(INSIGHT.customerAction).length).toBeGreaterThan(1);
  });
});
