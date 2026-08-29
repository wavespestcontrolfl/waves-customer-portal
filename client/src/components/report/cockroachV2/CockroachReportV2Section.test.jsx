// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import CockroachReportV2Section from './CockroachReportV2Section';
import { COCKROACH_V2_DASHBOARD_FIELD_KEYS } from './CockroachReportV2';

const base = {
  source: 'primary',
  status: { key: 'active', tone: 'watch', label: 'German cockroach activity was moderate today' },
  statusSummary: 'Live roaches and droppings were found in 4 areas.',
  aiSummary: { headline: null, body: 'Reviewed narrative.' },
  metrics: [
    { label: 'Activity today', value: 'Moderate' },
    { label: 'Areas with activity', value: '4' },
    { label: 'Treatments applied', value: 'Bait · IGR · Crack & crevice +1' },
  ],
  speciesLabel: 'German cockroach',
  activityLevel: 'Moderate',
  locations: ['Kitchen', 'Behind refrigerator', 'Under sink', 'Cabinet hinges'],
  evidence: ['Live roaches', 'Droppings'],
  conditions: ['Moisture / leaks'],
  work: [
    { key: 'Bait', short: 'Bait', title: 'Placed gel bait at the active harborage points', detail: 'Roaches carry it back to the nest.' },
    { key: 'IGR', short: 'IGR', title: 'Applied an insect growth regulator', detail: null },
  ],
  help: { items: [{ key: 'no_sprays', text: 'Do not use store-bought sprays or foggers — they scatter roaches away from the bait.' }], why: 'German cockroach control fails most often when sprays are used between visits.' },
  program: { treatmentNumber: 1, treatmentsTotal: 2, complete: false },
  whatsNext: {
    title: 'Treatment 1 of 2 complete',
    badge: 'IN PROGRESS',
    nextVisitMissing: false,
    lines: [
      { label: 'Next treatment', kind: 'next_visit' },
      { label: 'What we will do', text: 'Re-check every harborage point.' },
      { label: 'Between now and then', text: 'Expect to still see some roaches for 7–10 days.' },
    ],
  },
  nextVisit: { scheduledDate: '2026-09-10', windowStart: '09:00:00', serviceType: 'Cockroach Treatment' },
  visitSequence: 1,
};

describe('CockroachReportV2Section', () => {
  afterEach(cleanup);
  it('renders the five cards in order with the treatment position and the next-treatment date', () => {
    render(<CockroachReportV2Section data={base} nextVisitLabel="Thu, Sep 10 · 9–11am" narrative="Reviewed narrative." activityTrend={{ score: 3, isBaseline: true }} />);
    expect(screen.getByText(/Today's result · Treatment 1 of 2/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('German cockroach activity was moderate today');
    expect(screen.getByText('Reviewed narrative.')).toBeTruthy();
    expect(screen.getByText(/Baseline recorded today/)).toBeTruthy();
    expect(screen.getByText('Where we found activity')).toBeTruthy();
    expect(screen.getByText('Cabinet hinges')).toBeTruthy();
    expect(screen.getByText('Droppings')).toBeTruthy();
    expect(screen.getByText('What we did today')).toBeTruthy();
    expect(screen.getByText('Placed gel bait at the active harborage points')).toBeTruthy();
    expect(screen.getByText(/How you can help/)).toBeTruthy();
    expect(screen.getByText(/sprays are used between visits/)).toBeTruthy();
    expect(screen.getByText('Treatment 1 of 2 complete')).toBeTruthy();
    expect(screen.getByText('IN PROGRESS')).toBeTruthy();
    expect(screen.getByText(/Next treatment — Thu, Sep 10 · 9–11am/)).toBeTruthy();
    const text = document.body.textContent;
    expect(text.indexOf('Where we found activity')).toBeLessThan(text.indexOf('What we did today'));
    expect(text.indexOf('What we did today')).toBeLessThan(text.indexOf('How you can help'));
    expect(text.indexOf('How you can help')).toBeLessThan(text.indexOf('Your cockroach treatment program'));
  });

  it('never prints a next-visit row without a label (pdf/static, or nothing booked) and shows the complete badge', () => {
    const done = {
      ...base,
      program: { treatmentNumber: 2, treatmentsTotal: 2, complete: true },
      whatsNext: { title: 'Treatment 2 of 2 complete', badge: 'COMPLETE', nextVisitMissing: false, lines: [{ label: 'What to expect', text: 'The bait keeps working for several weeks.' }] },
      nextVisit: null,
    };
    render(<CockroachReportV2Section data={done} nextVisitLabel={null} />);
    expect(screen.getByText('COMPLETE')).toBeTruthy();
    expect(screen.queryByText('Next treatment')).toBeNull();
    expect(screen.getByText('The bait keeps working for several weeks.')).toBeTruthy();
  });

  it('a clear visit relabels the location card as inspected and drops empty cards', () => {
    const clear = { ...base, status: { key: 'clear', tone: 'good', label: "No cockroach activity observed during today's inspection" }, evidence: [], conditions: [], work: [], help: { items: [], why: null } };
    render(<CockroachReportV2Section data={clear} />);
    expect(screen.getByText('Where we inspected')).toBeTruthy();
    expect(screen.queryByText('What we did today')).toBeNull();
    expect(screen.queryByText(/How you can help/)).toBeNull();
  });

  it('renders nothing without data and exports the dashboard field-key set the page filters with', () => {
    const { container } = render(<CockroachReportV2Section data={null} />);
    expect(container.innerHTML).toBe('');
    expect(COCKROACH_V2_DASHBOARD_FIELD_KEYS.has('species')).toBe(true);
    expect(COCKROACH_V2_DASHBOARD_FIELD_KEYS.has('activity_level')).toBe(true);
  });
});
