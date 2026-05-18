import { describe, expect, it } from 'vitest';
import {
  cleanVisitSummary,
  formatDate,
  quickNavigationLinks,
  readinessStatusBadge,
  reviewRequestCopy,
  timelineEventsForDisplay,
} from './ReportViewPage.jsx';

describe('ReportViewPage date formatting', () => {
  it('keeps UTC-midnight service dates on their calendar day', () => {
    expect(formatDate('2026-05-17')).toBe('Sunday, May 17, 2026');
    expect(formatDate('2026-05-17T00:00:00.000Z')).toBe('Sunday, May 17, 2026');
  });

  it('still formats true timestamps in Eastern time', () => {
    expect(formatDate('2026-05-17T02:00:00.000Z')).toBe('Saturday, May 16, 2026');
  });
});

describe('ReportViewPage summary copy cleanup', () => {
  it('removes broken Waves signature fragments from the visit summary', () => {
    expect(cleanVisitSummary(
      'Thanks for having us out today. We focused on the perimeter. You should see activity ease over the next 1-2 weeks, and - Waves',
    )).toBe('Your routine service is complete. We focused on the perimeter. You may see activity ease over the next 1-2 weeks.');
  });
});

describe('ReportViewPage report chrome helpers', () => {
  it('omits product quick navigation when no products were applied', () => {
    const labels = quickNavigationLinks({ hasProducts: false }).map(([, label]) => label);
    expect(labels).not.toContain('Products Applied');
    expect(labels).toContain('Coverage Map');
  });

  it('does not show a readiness status badge without re-entry context', () => {
    expect(readinessStatusBadge(null)).toBeNull();
  });

  it('keeps untracked customer interaction out of the timeline display', () => {
    const events = timelineEventsForDisplay([
      { type: 'arrived_on_site', label: 'Arrived' },
      { type: 'customer_interaction', label: 'Customer interaction' },
      { type: 'service_completed', label: 'Completed' },
    ]);
    expect(events.map((event) => event.type)).toEqual(['arrived_on_site', 'service_completed']);
  });

  it('uses distinct review request copy for top and bottom placements', () => {
    const top = reviewRequestCopy('top');
    const bottom = reviewRequestCopy('bottom');
    expect(top.title).toBe("How did today's visit go?");
    expect(bottom.title).toBe('Help the next neighbor choose faster');
    expect(top.title).not.toBe(bottom.title);
    expect(top.cta).toBe('Share feedback');
    expect(bottom.cta).toBe('Share feedback');
  });
});
