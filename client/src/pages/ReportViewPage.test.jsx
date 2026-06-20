import { describe, expect, it } from 'vitest';
import {
  cleanVisitSummary,
  customerInteractionCopy,
  customerActionItems,
  formatDate,
  formatDurationMinutes,
  formatTimelineTime,
  getMinutesBetween,
  getReportArrivalTime,
  getReportCompletionTime,
  latestPendingReentryTarget,
  lawnWateringGuidance,
  normalizeServiceCoverage,
  normalizeVisitTimeline,
  quickNavigationLinks,
  reportAskPrompts,
  readinessStatusBadge,
  reviewRequestCopy,
  serviceReportDateTimeLabel,
  smartStatusSummary,
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
    expect(labels).not.toContain('Products');
    expect(labels).toContain('Timeline');
    expect(labels).toContain('Map');
    expect(labels).not.toContain('Visit Progress');
    expect(labels).not.toContain('Areas Serviced');
    expect(labels).not.toContain('Coverage Map');
  });

  it('omits visit timeline quick navigation when the timeline is hidden', () => {
    const labels = quickNavigationLinks({ hasVisitTimeline: false }).map(([, label]) => label);
    expect(labels).not.toContain('Timeline');
    expect(labels).toContain('Map');
  });

  it('only includes the re-entry quick navigation when re-entry context exists', () => {
    expect(quickNavigationLinks({ hasReentry: false }).map(([, label]) => label)).not.toContain('Re-entry');
    expect(quickNavigationLinks({ hasReentry: true }).map(([, label]) => label)).toContain('Re-entry');
  });

  it('does not suggest Pest Pressure questions when the section is disabled', () => {
    expect(reportAskPrompts({
      pestPressure: { enabled: false, showOnCustomerReport: true },
    })).not.toContain('What does Pest Pressure mean?');
    expect(reportAskPrompts({
      pestPressure: { enabled: true, showOnCustomerReport: true },
    })).toContain('What does Pest Pressure mean?');
  });

  it('does not show a readiness status badge without re-entry context', () => {
    expect(readinessStatusBadge(null)).toBeNull();
  });

  it('uses the latest pending re-entry target for aggregate readiness messaging', () => {
    const nowMs = Date.parse('2026-05-21T18:00:00.000Z');
    const target = latestPendingReentryTarget([
      { label: 'Exterior', readyAt: '2026-05-21T18:30:00.000Z' },
      { label: 'Interior', readyAt: '2026-05-21T20:00:00.000Z' },
      { label: 'Garage', readyAt: '2026-05-21T17:30:00.000Z' },
    ], nowMs);

    expect(target).toEqual(expect.objectContaining({
      label: 'Interior',
      readyAt: '2026-05-21T20:00:00.000Z',
    }));
  });

  it('drops stale re-entry wait actions once all targets are ready', () => {
    const data = {
      dynamicContext: {
        reentry: {
          displayTimezone: 'America/New_York',
          targets: [
            { label: 'Exterior', readyAt: '2026-05-21T18:30:00.000Z' },
            { label: 'Interior', readyAt: '2026-05-21T20:00:00.000Z' },
          ],
          petAdvisory: 'Keep pets away until dry.',
        },
      },
      findings: [],
    };

    expect(customerActionItems({
      data,
      nowMs: Date.parse('2026-05-21T19:00:00.000Z'),
    })[0].label).toContain('treated interior');

    expect(customerActionItems({
      data,
      nowMs: Date.parse('2026-05-21T20:01:00.000Z'),
    })).toEqual([]);
  });

  it('treats needs-follow-up coverage as action needed in status and next steps', () => {
    const coverage = {
      items: [{
        areaName: 'Lanai',
        status: 'needs_follow_up',
        customerDescription: 'Technician recommended a follow-up check.',
      }],
    };
    const data = {
      serviceCoverage: {
        enabled: true,
        items: coverage.items,
      },
      findings: [],
      applications: [],
    };

    expect(smartStatusSummary(data, 'static', Date.parse('2026-05-21T19:00:00.000Z'))).toEqual(expect.objectContaining({
      heading: 'one area needs attention.',
      status: 'Follow-up recommended',
      result: 'Lanai was marked follow-up recommended.',
    }));

    expect(customerActionItems({ data, coverage })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Review Lanai marked follow-up recommended.',
        detail: 'Technician recommended a follow-up check.',
      }),
    ]));
  });

  it('adds a fallback action for high-severity findings without recommendations', () => {
    const actions = customerActionItems({
      data: {
        findings: [{
          severity: 'high',
          title: 'Ant activity near front entry',
          detail: 'Activity was documented near the threshold.',
        }],
      },
    });

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Review the documented activity: Ant activity near front entry.',
        detail: 'Activity was documented near the threshold.',
      }),
    ]));
  });

  it('keeps pending re-entry visible when high-severity findings exist', () => {
    const status = smartStatusSummary({
      dynamicContext: {
        reentry: {
          displayTimezone: 'America/New_York',
          targets: [{ label: 'Interior', readyAt: '2026-05-21T20:00:00.000Z' }],
        },
      },
      findings: [{
        severity: 'high',
        title: 'Ant activity near front entry',
      }],
      applications: [],
    }, 'static', Date.parse('2026-05-21T19:00:00.000Z'));

    expect(status).toEqual(expect.objectContaining({
      heading: 'we found activity that needs attention.',
      status: 'Ready after 4:00 PM',
      statusTone: 'pending',
    }));
    expect(status.result).toContain('Interior areas are still drying.');
    expect(status.result).toContain('Ant activity near front entry still needs attention.');
  });

  it('keeps untracked customer interaction out of the timeline display', () => {
    const events = timelineEventsForDisplay([
      { type: 'arrived_on_site', label: 'Arrived', timestamp: '2026-05-17T18:35:00.000Z' },
      { type: 'customer_interaction', label: 'Customer interaction' },
      { type: 'service_completed', label: 'Completed', timestamp: '2026-05-17T19:05:00.000Z' },
      { type: 'report_published', label: 'Report published' },
    ]);
    expect(events.map((event) => event.type)).toEqual(['technician_on_site', 'service_completed']);
  });

  it('routes public timing fields into the Visit Timeline event list', () => {
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
      'technician_on_site',
      'service_completed',
    ]);
    expect(events.find((event) => event.type === 'service_completed').customerVisibleDescription)
      .toBe('Your technician completed the pest control service and finalized the report.');
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

describe('ReportViewPage lawn watering guidance', () => {
  it('prefers the recorded per-product irrigation note when present', () => {
    const guidance = lawnWateringGuidance({
      product: { category: 'fertilizer', irrigation_notes: 'Water in only when the service report says so.' },
    });
    expect(guidance.detail).toBe('Water in only when the service report says so.');
    expect(guidance.headline).toMatch(/follow the watering note/i);
  });

  it('tells customers to water in nutrient applications', () => {
    expect(lawnWateringGuidance({ product: { category: 'fertilizer', product_type: 'fertilizer' } }).headline)
      .toMatch(/water it in/i);
    expect(lawnWateringGuidance({ product: { name: 'High Manganese Combo', category: 'micronutrient' } }).headline)
      .toMatch(/water it in/i);
  });

  it('tells customers to keep weed treatments dry', () => {
    const guidance = lawnWateringGuidance({ product: { category: 'herbicide', name: 'Drive XLR8' } });
    expect(guidance.headline).toMatch(/keep the lawn dry/i);
    expect(guidance.detail).toMatch(/24 to 48 hours/i);
  });

  it('tells customers to let fungicides dry before watering', () => {
    expect(lawnWateringGuidance({ product: { category: 'fungicide' } }).headline).toMatch(/let it dry/i);
  });

  it('falls back to normal-watering guidance for unrecognized products', () => {
    expect(lawnWateringGuidance({ product: { category: 'unknown' } }).headline).toMatch(/normal watering/i);
  });
});

describe('ReportViewPage service coverage helper', () => {
  it('normalizes legacy areas and map data into one section model', () => {
    const coverage = normalizeServiceCoverage({
      serviceLine: 'pest',
      serviceType: 'Quarterly Pest Control Service',
      serviceDate: '2026-05-17',
      propertyAddress: '12312 Cedar Pass Trl, Parrish, FL 34219',
      serviceAreas: ['Perimeter', 'Entry Points'],
      zones: [
        { id: 'zone-a', letter: 'A', label: 'Perimeter' },
        { id: 'zone-b', letter: 'B', label: 'Entry Points' },
      ],
      serviceLocations: [
        {
          id: 'loc-a',
          zoneId: 'zone-a',
          name: 'Perimeter',
          status: 'serviced',
          geometry: { type: 'LineString', coordinates: [[0.1, 0.1], [0.8, 0.1]] },
        },
        {
          id: 'loc-b',
          zoneId: 'zone-b',
          name: 'Entry Points',
          status: 'serviced',
          geometry: { type: 'Point', coordinates: [0.5, 0.5] },
        },
      ],
    });

    expect(coverage.enabled).toBe(true);
    expect(coverage.title).toBe('Service Area Map');
    expect(coverage.items.map((item) => item.markerLabel)).toEqual(['A', 'B']);
    expect(coverage.items[0].customerDescription).toBe('Exterior perimeter service completed.');
    expect(coverage.items[1].customerDescription).toBe('Entry points inspected and treated.');
    expect(coverage.map.available).toBe(true);
  });

  it('uses API-provided serviceCoverage without falling back to duplicate legacy sections', () => {
    const coverage = normalizeServiceCoverage({
      serviceCoverage: {
        enabled: true,
        title: 'Lawn Coverage',
        intro: 'Custom intro',
        items: [{ id: 'front', markerLabel: 'A', areaName: 'Front Lawn', status: 'completed' }],
        map: { available: false, markers: [] },
      },
      serviceAreas: ['Should not duplicate'],
    });

    expect(coverage.title).toBe('Lawn Coverage');
    expect(coverage.intro).toBe('Custom intro');
    expect(coverage.items).toHaveLength(1);
  });

  it('honors API-disabled service coverage even when legacy fields are present', () => {
    const coverage = normalizeServiceCoverage({
      serviceCoverage: { enabled: false },
      serviceAreas: ['Perimeter'],
      serviceLocations: [{ id: 'loc-a', name: 'Perimeter', status: 'serviced' }],
    });

    expect(coverage.enabled).toBe(false);
  });
});

describe('ReportViewPage visit timeline helpers', () => {
  it('always includes service_completed for a completed report and sources it from the report', () => {
    const timeline = normalizeVisitTimeline({
      workflowEvents: [
        { type: 'technician_en_route', timestamp: '2026-05-17T16:44:00.000Z' },
        { type: 'arrived_on_site', timestamp: '2026-05-17T18:35:00.000Z' },
      ],
      visitTiming: {},
      timingSource: {
        visitOutcome: 'completed',
        serviceLine: 'pest',
        serviceRecord: {
          completed_at: '2026-05-17T19:05:00.000Z',
        },
      },
    });

    expect(timeline.title).toBe('Visit Timeline');
    expect(timeline.events.map((event) => event.type)).toEqual([
      'technician_en_route',
      'technician_on_site',
      'service_completed',
    ]);
    expect(timeline.events.find((event) => event.type === 'service_completed')).toMatchObject({
      label: 'Service completed',
      occurredAt: '2026-05-17T19:05:00.000Z',
      source: 'service_report',
      customerDescription: 'Your technician completed the pest control service and finalized the report.',
    });
  });

  it('collapses same-time on-site and service-completed events to the completion event', () => {
    const timestamp = '2026-05-17T18:35:00.000Z';
    const timeline = normalizeVisitTimeline({
      visitTiming: { arrivedAt: timestamp, exitedAt: timestamp },
      timingSource: {
        visitOutcome: 'completed',
        serviceLine: 'pest',
        serviceRecord: {
          arrived_at: timestamp,
          completed_at: timestamp,
        },
      },
      config: { showDuration: true },
    });

    expect(timeline.events.map((event) => [event.type, event.displayTime])).toEqual([
      ['service_completed', '2:35 PM'],
    ]);
    expect(timeline.durationMinutes).toBeNull();
    expect(timeline.timingNote).toBe('Exact on-site duration was not available for this visit.');
  });

  it('shows customer contact as a detail and hides report published by default', () => {
    const timeline = normalizeVisitTimeline({
      workflowEvents: [
        { type: 'arrived_on_site', timestamp: '2026-05-17T18:35:00.000Z' },
        { type: 'report_published', timestamp: '2026-05-17T18:35:00.000Z' },
      ],
      customerInteraction: 'tech_home_spoke_with_them',
      timingSource: {
        visitOutcome: 'completed',
        serviceLine: 'pest',
        serviceRecord: {
          completed_at: '2026-05-17T18:35:00.000Z',
        },
      },
    });

    expect(timeline.events.map((event) => event.type)).toEqual(['service_completed']);
    expect(timeline.details).toEqual([
      expect.objectContaining({
        type: 'customer_contact',
        label: 'Customer contact',
        text: 'The technician spoke with someone at the home.',
        showAsTimelineEvent: false,
      }),
    ]);
    expect(timeline.details.some((detail) => detail.type === 'report_generated')).toBe(false);
  });

  it('keeps a server-disabled timeline disabled even when fallback timing exists', () => {
    const timeline = normalizeVisitTimeline({
      visitTimeline: {
        enabled: false,
        events: [
          { type: 'technician_on_site', occurredAt: '2026-05-17T18:35:00.000Z' },
          { type: 'service_completed', occurredAt: '2026-05-17T18:35:00.000Z' },
        ],
      },
      visitTiming: {
        arrivedAt: '2026-05-17T18:35:00.000Z',
        exitedAt: '2026-05-17T18:35:00.000Z',
      },
      timingSource: {
        status: 'completed',
        serviceRecord: {
          arrived_at: '2026-05-17T18:35:00.000Z',
          completed_at: '2026-05-17T18:35:00.000Z',
        },
      },
    });

    expect(timeline.enabled).toBe(false);
  });

  it('does not re-add events omitted from a server-provided timeline', () => {
    const timeline = normalizeVisitTimeline({
      visitTimeline: {
        enabled: true,
        status: 'completed',
        config: {
          showTechnicianEnRoute: false,
          showTechnicianOnSite: false,
        },
        events: [
          { type: 'service_completed', occurredAt: '2026-05-17T19:05:00.000Z' },
        ],
      },
      workflowEvents: [
        { type: 'technician_en_route', timestamp: '2026-05-17T16:44:00.000Z' },
        { type: 'arrived_on_site', timestamp: '2026-05-17T18:35:00.000Z' },
      ],
      visitTiming: {
        arrivedAt: '2026-05-17T18:35:00.000Z',
        exitedAt: '2026-05-17T19:05:00.000Z',
      },
    });

    expect(timeline.events.map((event) => event.type)).toEqual(['service_completed']);
  });

  it('respects showExactTimes when normalizing server and derived timeline events', () => {
    const serverTimeline = normalizeVisitTimeline({
      visitTimeline: {
        enabled: true,
        config: { showExactTimes: false },
        events: [
          { type: 'service_completed', occurredAt: '2026-05-17T19:05:00.000Z' },
        ],
      },
    });
    const derivedTimeline = normalizeVisitTimeline({
      workflowEvents: [
        { type: 'arrived_on_site', timestamp: '2026-05-17T18:35:00.000Z' },
        { type: 'report_published', timestamp: '2026-05-17T19:06:00.000Z' },
      ],
      timingSource: {
        status: 'completed',
        serviceRecord: {
          completed_at: '2026-05-17T19:05:00.000Z',
        },
      },
      config: { showExactTimes: false, showReportGenerated: true },
    });

    expect(serverTimeline.events[0]).toMatchObject({
      occurredAt: '2026-05-17T19:05:00.000Z',
      displayTime: null,
    });
    expect(derivedTimeline.events.map((event) => event.displayTime)).toEqual([null, null]);
    expect(derivedTimeline.details.find((detail) => detail.type === 'report_generated')).toMatchObject({
      text: 'Report generated May 17, 2026.',
      displayTime: null,
    });
  });

  it('can show report generated as a secondary detail when enabled', () => {
    const timeline = normalizeVisitTimeline({
      workflowEvents: [
        { type: 'service_completed', timestamp: '2026-05-17T18:35:00.000Z' },
        { type: 'report_published', timestamp: '2026-05-17T18:36:00.000Z' },
      ],
      timingSource: { serviceLine: 'pest' },
      config: { showReportGenerated: true },
    });

    expect(timeline.events.map((event) => event.type)).toEqual(['service_completed']);
    expect(timeline.details.find((detail) => detail.type === 'report_generated')).toMatchObject({
      label: 'Report generated',
      text: 'Report generated May 17, 2026 at 2:36 PM.',
      showAsTimelineEvent: false,
    });
  });

  it.each([
    ['pest', 'Your technician completed the pest control service and finalized the report.'],
    ['lawn', 'Your technician completed the lawn service and finalized the report.'],
    ['termite', 'Your technician completed the termite service and finalized the report.'],
    ['tree_shrub', 'Your technician completed the tree and shrub service and finalized the report.'],
    ['mosquito', 'Your technician completed the mosquito service and finalized the report.'],
    ['rodent', 'Your technician completed the rodent service and finalized the report.'],
    ['commercial', 'Your technician completed the service and finalized the report.'],
  ])('uses service-line-specific completed copy for %s', (serviceLine, expectedCopy) => {
    const timeline = normalizeVisitTimeline({
      timingSource: {
        visitOutcome: 'completed',
        serviceLine,
        serviceRecord: { completed_at: '2026-05-17T18:35:00.000Z' },
      },
    });

    expect(timeline.events.find((event) => event.type === 'service_completed').customerDescription)
      .toBe(expectedCopy);
  });

  it('does not falsely show service_completed for an incomplete report', () => {
    const timeline = normalizeVisitTimeline({
      workflowEvents: [{ type: 'arrived_on_site', timestamp: '2026-05-17T18:35:00.000Z' }],
      timingSource: {
        status: 'scheduled',
        serviceLine: 'pest',
      },
    });

    expect(timeline.events.map((event) => event.type)).toEqual(['technician_on_site']);
  });

  it('shows service_completed without a misleading timestamp when completedAt is missing', () => {
    const timeline = normalizeVisitTimeline({
      timingSource: {
        status: 'completed',
        serviceLine: 'pest',
      },
    });

    expect(timeline.events).toEqual([
      expect.objectContaining({
        type: 'service_completed',
        label: 'Service completed',
        occurredAt: null,
        displayTime: null,
        customerDescription: 'The service was marked complete.',
      }),
    ]);
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
