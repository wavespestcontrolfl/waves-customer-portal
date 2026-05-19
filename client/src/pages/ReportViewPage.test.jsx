import { describe, expect, it } from 'vitest';
import {
  cleanVisitSummary,
  customerInteractionCopy,
  formatDate,
  formatDurationMinutes,
  formatTimelineTime,
  getMinutesBetween,
  getReportArrivalTime,
  getReportCompletionTime,
  quickNavigationLinks,
  readinessStatusBadge,
  reviewRequestCopy,
  serviceReportDateTimeLabel,
  timelineEventsForDisplay,
  timelineEventsWithReportTiming,
} from './ReportViewPage.jsx';

describe('ReportViewPage date formatting', () => {
  it('keeps UTC-midnight service dates on their calendar day', () => {
    expect(formatDate('2026-05-17')).toBe('Sunday, May 17, 2026');
    expect(formatDate('2026-05-17T00:00:00.000Z')).toBe('Sunday, May 17, 2026');
  });

  it('still formats true timestamps in Eastern time', () => {
    expect(formatDate('2026-05-17T02:00:00.000Z')).toBe('Saturday, May 16, 2026');
  });

  it('adds the visit time to the service report details date', () => {
    expect(serviceReportDateTimeLabel({
      serviceDate: '2026-05-17T00:00:00.000Z',
      visitTiming: {
        arrivedAt: '2026-05-17T18:35:27.764Z',
        exitedAt: '2026-05-17T18:35:27.766Z',
      },
    })).toBe('Sunday, May 17, 2026 at 2:35 PM');
  });

  it('uses a range when the visit has different arrival and completion times', () => {
    expect(serviceReportDateTimeLabel({
      serviceDate: '2026-05-17',
      visitTiming: {
        arrivedAt: '2026-05-17T18:35:00.000Z',
        exitedAt: '2026-05-17T19:10:00.000Z',
      },
    })).toBe('Sunday, May 17, 2026 at 2:35 PM to 3:10 PM');
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

  it('routes public timing fields into the Visit Progress event list', () => {
    const events = timelineEventsWithReportTiming(
      [{ type: 'report_published', timestamp: '2026-05-19T18:35:00.000Z' }],
      'tech_home_spoke_with_them',
      {},
      {
        coverageServiceType: 'pest_control',
        serviceRecord: {
          arrived_at: '2026-05-19T16:44:00.000Z',
          completed_at: '2026-05-19T18:35:00.000Z',
        },
      },
    );

    expect(events.map((event) => event.type)).toEqual([
      'arrived_on_site',
      'customer_interaction',
      'service_completed',
      'report_published',
    ]);
    expect(events.find((event) => event.type === 'service_completed').customerVisibleDescription)
      .toBe('Pest control service areas were marked complete.');
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

describe('ReportViewPage service timeline helpers', () => {
  it('uses service record arrived_at and completed_at for the customer timeline', () => {
    const report = {
      serviceRecord: {
        arrived_at: '2026-05-19T13:42:00.000Z',
        completed_at: '2026-05-19T14:28:00.000Z',
      },
    };

    const arrival = getReportArrivalTime(report);
    const completion = getReportCompletionTime(report);

    expect(formatTimelineTime(arrival)).toBe('9:42 AM');
    expect(formatTimelineTime(completion)).toBe('10:28 AM');
    expect(formatDurationMinutes(getMinutesBetween(arrival, completion))).toBe('46 minutes');
  });

  it('falls back through service record arrival aliases before scheduled service timing', () => {
    expect(getReportArrivalTime({
      serviceRecord: { actual_start_time: '2026-05-19T13:43:00.000Z' },
      scheduledService: { arrived_at: '2026-05-19T13:42:00.000Z' },
    })).toBe('2026-05-19T13:43:00.000Z');

    expect(getReportArrivalTime({
      serviceRecord: { check_in_time: '2026-05-19T13:44:00.000Z' },
      scheduledService: { arrived_at: '2026-05-19T13:42:00.000Z' },
    })).toBe('2026-05-19T13:44:00.000Z');
  });

  it('falls back to scheduled service arrival when report arrival is missing', () => {
    expect(getReportArrivalTime({
      scheduled_service: {
        arrived_at: '2026-05-19T13:42:00.000Z',
      },
    })).toBe('2026-05-19T13:42:00.000Z');
  });

  it('skips invalid timestamp values instead of displaying NaN dates', () => {
    expect(getReportArrivalTime({
      serviceRecord: {
        arrived_at: 'not a date',
        actual_start_time: '2026-05-19T13:42:00.000Z',
      },
    })).toBe('2026-05-19T13:42:00.000Z');
    expect(formatTimelineTime('not a date')).toBeNull();
  });

  it('uses completion aliases in priority order', () => {
    expect(getReportCompletionTime({
      serviceRecord: { actual_end_time: '2026-05-19T14:28:00.000Z' },
    })).toBe('2026-05-19T14:28:00.000Z');

    expect(getReportCompletionTime({
      serviceRecord: { check_out_time: '2026-05-19T14:29:00.000Z' },
    })).toBe('2026-05-19T14:29:00.000Z');
  });

  it('does not render a duration without valid arrival and completion timestamps', () => {
    expect(formatDurationMinutes(getMinutesBetween(null, '2026-05-19T14:28:00.000Z'))).toBeNull();
    expect(formatDurationMinutes(getMinutesBetween(
      '2026-05-19T14:28:00.000Z',
      '2026-05-19T13:42:00.000Z',
    ))).toBeNull();
  });

  it('does not surface internal tracking metadata through timeline helpers', () => {
    const report = {
      serviceRecord: {
        arrived_at: '2026-05-19T13:42:00.000Z',
        completed_at: '2026-05-19T14:28:00.000Z',
        arrival_source: 'bouncie_auto',
        arrival_metadata: { distanceMeters: 83 },
      },
    };
    const timelineCopy = [
      'Technician arrived',
      formatTimelineTime(getReportArrivalTime(report)),
      'Service completed',
      formatTimelineTime(getReportCompletionTime(report)),
      'Time on site',
      formatDurationMinutes(getMinutesBetween(
        getReportArrivalTime(report),
        getReportCompletionTime(report),
      )),
    ].filter(Boolean).join(' ');

    expect(timelineCopy).not.toMatch(/Bouncie|GPS|geofence|auto-arrival|arrival_source|distanceMeters|83 meters/i);
  });
});
