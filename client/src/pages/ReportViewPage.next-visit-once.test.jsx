// @vitest-environment jsdom
// Owner 2026-10-22 ("we dont need to mention the next service twice"):
// "What's next" drops its "Next visit:" line when the plan card or the
// upcoming visits card already names that same visit.
import { describe, expect, it } from 'vitest';
import { nextVisitShownInPlanCard } from './ReportViewPage';

const NEXT = { scheduledDate: '2099-01-18', serviceType: 'Quarterly Pest Control Service', windowStart: '10:00' };

describe('nextVisitShownInPlanCard', () => {
  it('is true when the visits list holds the same date and service', () => {
    const data = { nextSameServiceAppointment: NEXT, upcomingVisitsCard: { merged: true, visits: [{ ...NEXT }] } };
    expect(nextVisitShownInPlanCard(data, 'live')).toBe(true);
  });

  it('is false when the list holds another visit, or the view is not live', () => {
    const other = { nextSameServiceAppointment: NEXT, upcomingVisitsCard: { visits: [{ ...NEXT, scheduledDate: '2099-02-01' }] } };
    expect(nextVisitShownInPlanCard(other, 'live')).toBe(false);
    const same = { nextSameServiceAppointment: NEXT, upcomingVisitsCard: { visits: [{ ...NEXT }] } };
    expect(nextVisitShownInPlanCard(same, 'pdf')).toBe(false);
    expect(nextVisitShownInPlanCard({ upcomingVisitsCard: { visits: [NEXT] } }, 'live')).toBe(false);
  });

  it('is true when the plan card names it in its "Your next visit" line (no visits list)', () => {
    const data = { nextSameServiceAppointment: NEXT, nextAppointment: { ...NEXT }, planSummary: { visitsThisYear: 1 } };
    expect(nextVisitShownInPlanCard(data, 'live')).toBe(true);
    expect(nextVisitShownInPlanCard({ ...data, planSummary: null }, 'live')).toBe(false);
    expect(nextVisitShownInPlanCard({ ...data, nextAppointment: { ...NEXT, serviceType: 'Lawn Care' } }, 'live')).toBe(false);
  });
});

describe('nextVisitShownInPlanCard with another visit (status card, dashboards)', () => {
  it('checks the visit it is given instead of nextSameServiceAppointment', () => {
    const other = { ...NEXT, scheduledDate: '2099-03-01' };
    const data = { nextSameServiceAppointment: NEXT, upcomingVisitsCard: { visits: [{ ...other }] } };
    expect(nextVisitShownInPlanCard(data, 'live', other)).toBe(true);
    expect(nextVisitShownInPlanCard(data, 'live', { ...other, scheduledDate: '2099-04-01' })).toBe(false);
    expect(nextVisitShownInPlanCard(data, 'live', null)).toBe(false);
  });
});

describe('nextVisitShownInPlanCard needs the same window', () => {
  it('a same-day, same-service visit in another window is a different visit', () => {
    const data = { nextSameServiceAppointment: NEXT, upcomingVisitsCard: { visits: [{ ...NEXT, windowStart: '14:00' }] } };
    expect(nextVisitShownInPlanCard(data, 'live')).toBe(false);
    expect(nextVisitShownInPlanCard({ ...data, upcomingVisitsCard: { visits: [{ ...NEXT, windowStart: '10:00:00' }] } }, 'live')).toBe(true);
  });
});

describe('the plan sentence keeps the arrival window (no visits list)', () => {
  it('prints date and window, so hiding the status card cell loses nothing', async () => {
    const React = (await import('react')).default;
    const { render } = await import('@testing-library/react');
    const { PlanSummaryCard } = await import('./ReportViewPage');
    const data = {
      planSummary: { visitsThisYear: 2 },
      nextAppointment: { ...NEXT },
      nextSameServiceAppointment: { ...NEXT },
    };
    const { container } = render(React.createElement(PlanSummaryCard, { data, mode: 'live' }));
    expect(container.textContent).toContain('Your next Quarterly Pest Control visit is Sun, Jan 18, 10:00 AM–12:00 PM.');
    expect(nextVisitShownInPlanCard(data, 'live', data.nextAppointment)).toBe(true);
  });
});
