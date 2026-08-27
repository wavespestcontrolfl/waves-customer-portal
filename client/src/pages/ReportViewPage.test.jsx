import { describe, expect, it } from 'vitest';
import {
  applicationPestFamily,
  applicationPurpose,
  applicationPurposeCopy,
  applicationTechnicalExplanation,
  cleanVisitSummary,
  customerInteractionCopy,
  customerActionItems,
  formatDate,
  formatDurationMinutes,
  formatTermiteBondRenewalLabel,
  formatTimelineTime,
  getMinutesBetween,
  getReportArrivalTime,
  getReportCompletionTime,
  latestPendingReentryTarget,
  lawnWateringGuidance,
  normalizeServiceCoverage,
  normalizeVisitTimeline,
  reportAskPrompts,
  readinessStatusBadge,
  reviewRequestCopy,
  serviceReportDateTimeLabel,
  smartStatusSummary,
  timelineEventsForDisplay,
  timelineEventsWithReportTiming,
  visitWorkSummary,
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

describe('ReportViewPage termite warranty cell label', () => {
  it('formats the renewal date for the hero cell', () => {
    expect(formatTermiteBondRenewalLabel({ renewsAt: '2027-03-14' })).toBe('Renews Mar 14, 2027');
  });

  it('returns null for absent or malformed bond data (cell does not render)', () => {
    expect(formatTermiteBondRenewalLabel(null)).toBeNull();
    expect(formatTermiteBondRenewalLabel({})).toBeNull();
    expect(formatTermiteBondRenewalLabel({ renewsAt: 'not-a-date' })).toBeNull();
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
      heading: 'one area needs attention!',
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
      heading: 'we found activity that needs attention!',
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

  it('both placements carry the redesigned ask — legacy bottom-mount reports included (codex r2 P2)', () => {
    const top = reviewRequestCopy('top', 'Casey', 'Adam');
    const bottom = reviewRequestCopy('bottom', 'Casey', 'Adam');
    expect(top.title).toBe('How did Adam do today, Casey?');
    expect(bottom.title).toBe(top.title);
    expect(bottom.cta).toBe('Rate today’s visit');
  });

  it('names the technician and the customer when the payload carries them (owner ruling 2026-08-13)', () => {
    expect(reviewRequestCopy('top', 'Casey', 'Adam').title).toBe('How did Adam do today, Casey?');
    // First name only, even from a full technician name.
    expect(reviewRequestCopy('top', 'Casey', 'Adam Benetti').title).toBe('How did Adam do today, Casey?');
    // Either side missing degrades gracefully, never renders a dangling comma.
    expect(reviewRequestCopy('top', '', 'Adam').title).toBe('How did Adam do today?');
    expect(reviewRequestCopy('top', 'Casey', '').title).toBe('How did we do today, Casey?');
  });
});

describe('ReportViewPage lawn watering guidance', () => {
  it('surfaces the approved per-product irrigation note when present', () => {
    const guidance = lawnWateringGuidance({
      product: { category: 'adjuvant', irrigation_notes: 'Water or rainfall may be needed after application when directed by the service report.' },
    });
    expect(guidance.detail).toBe('Water or rainfall may be needed after application when directed by the service report.');
    expect(guidance.headline).toMatch(/watering note/i);
  });

  it('does not invent watering intervals from product category when there is no label note', () => {
    expect(lawnWateringGuidance({ product: { category: 'fertilizer', product_type: 'fertilizer' } })).toBeNull();
    expect(lawnWateringGuidance({ product: { category: 'herbicide', name: 'Drive XLR8' } })).toBeNull();
    expect(lawnWateringGuidance({ product: { category: 'fungicide' } })).toBeNull();
    expect(lawnWateringGuidance({ product: {} })).toBeNull();
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

  // 2026-07-16 audit: the client fallback builder mirrored the server's
  // fabrication — inspected/skipped/not-serviced areas were described and
  // counted as completed work.
  it('never describes or counts inspected/skipped/not-serviced areas as completed', () => {
    const coverage = normalizeServiceCoverage({
      serviceLine: 'pest',
      serviceType: 'Quarterly Pest Control Service',
      serviceAreas: [],
      zones: [],
      serviceLocations: [
        { id: 'loc-a', name: 'Perimeter', status: 'inspected' },
        { id: 'loc-b', name: 'Back Gate Zone', status: 'skipped', skippedReason: 'heavy rain' },
        { id: 'loc-c', name: 'Detached Shed', status: 'not_serviced' },
        { id: 'loc-d', name: 'Garage', status: 'needs_follow_up' },
      ],
    });

    const byName = Object.fromEntries(coverage.items.map((item) => [item.areaName, item]));
    expect(byName.Perimeter.status).toBe('inspected');
    expect(byName.Perimeter.customerDescription).toBe('Perimeter inspected.');
    expect(byName['Back Gate Zone'].customerDescription).toBe('Service was skipped because heavy rain.');
    expect(byName['Detached Shed'].customerDescription).toBe('This area was not serviced on this visit.');
    expect(byName.Garage.customerDescription).toBe('Technician flagged this area for follow-up.');
    expect(coverage.summary).toMatchObject({
      completedCount: 0,
      inspectedCount: 1,
      skippedCount: 2,
      needsAttentionCount: 1,
    });
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

  it('typed reports name the actual service in the completed event description', () => {
    const timeline = normalizeVisitTimeline({
      workflowEvents: [
        { type: 'arrived_on_site', timestamp: '2026-05-17T18:35:00.000Z' },
      ],
      visitTiming: {},
      timingSource: {
        visitOutcome: 'completed',
        serviceLine: 'pest',
        serviceDisplayName: 'Bed Bug Treatment',
        typedReport: { type: 'bed_bug' },
        serviceRecord: {
          completed_at: '2026-05-17T19:05:00.000Z',
        },
      },
    });
    expect(timeline.events.find((event) => event.type === 'service_completed').customerDescription)
      .toBe('Your technician completed your Bed Bug Treatment and finalized the report.');
  });

  it('visitWorkSummary derives the cell from typed findings when no applications or coverage exist', () => {
    const data = {
      typedReport: {
        findings: [
          { fieldKey: 'rooms_treated', customerValueLabel: 'Primary bedroom, guest bedroom' },
          { fieldKey: 'work_completed', customerValueParts: ['Crack & crevice treatment', 'Steam treatment', 'Interceptors installed'] },
        ],
      },
    };
    expect(visitWorkSummary(data, 'Service completed today.'))
      .toBe('3 service steps completed · Primary bedroom, guest bedroom');
    // Long free-text rooms drop out of the cell instead of overflowing it.
    const longRooms = {
      typedReport: {
        findings: [
          { fieldKey: 'rooms_treated', customerValueLabel: 'Primary bedroom, guest bedroom, den, upstairs hallway and both bathrooms' },
          { fieldKey: 'work_completed', value: ['Steam treatment'] },
        ],
      },
    };
    expect(visitWorkSummary(longRooms, 'Service completed today.'))
      .toBe('1 service step completed');
    // Legacy snapshots persist chips as one comma-joined string — never
    // split (labels can contain commas); a countless neutral phrase stands.
    const legacy = {
      typedReport: {
        findings: [
          { fieldKey: 'rooms_treated', customerValueLabel: 'Primary bedroom' },
          { fieldKey: 'work_completed', value: 'Crack & crevice treatment, Steam treatment' },
        ],
      },
    };
    expect(visitWorkSummary(legacy, 'Service completed today.'))
      .toBe('Service work completed · Primary bedroom');
    // No typed work recorded → the generic fallback stands.
    expect(visitWorkSummary({ typedReport: { findings: [] } }, 'Service completed today.'))
      .toBe('Service completed today.');
    // Rooms WITHOUT any work action never stand alone — a bare location is
    // not a statement of what Waves did (codex P2 post-merge).
    const roomsOnly = {
      typedReport: {
        findings: [
          { fieldKey: 'rooms_treated', customerValueLabel: 'Primary bedroom' },
        ],
      },
    };
    expect(visitWorkSummary(roomsOnly, 'Service completed today.'))
      .toBe('Service completed today.');
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

describe('product purpose follows recorded pest identity', () => {
  // App shapes mirror the live /:token/data payload: { method, targets,
  // product: { name, category, active_ingredient } } — the 2026-08-02
  // cockroach report where Advion Cockroach Gel printed "Targeted ant bait"
  // and two fogged roach products printed mosquito copy.
  const roachGel = {
    method: 'bait_placement',
    targets: ['German cockroaches', 'American cockroaches'],
    product: { name: 'Advion Cockroach Gel Bait', category: 'bait', active_ingredient: 'Indoxacarb 0.6%' },
  };
  const foggedInsecticide = {
    method: 'fog_ulv',
    targets: ['German cockroaches'],
    product: { name: 'Alpine WSG', category: 'insecticide', active_ingredient: 'Dinotefuran 40.0%' },
  };
  const foggedIgr = {
    method: 'fog_ulv',
    targets: ['German cockroaches'],
    product: { name: 'Gentrol IGR', category: 'IGR', active_ingredient: '(S)-Hydroprene 9.0%' },
  };

  it('captions cockroach gel bait as cockroach bait, never ant bait', () => {
    expect(applicationPurpose(roachGel, 'pest')).toBe('Targeted cockroach bait');
    const copy = [
      applicationPurposeCopy(roachGel, 'pest'),
      ...applicationTechnicalExplanation(roachGel, 'pest'),
    ].join(' ');
    expect(copy).toMatch(/cockroaches/);
    expect(copy).not.toMatch(/\bants?\b/i);
  });

  it('never invents an observed activity level for bait placements', () => {
    const antGel = { method: 'bait_placement', targets: ['Ghost ants'], product: { name: 'Optigard Ant Gel Bait', category: 'bait' } };
    expect(applicationPurpose(antGel, 'pest')).toBe('Targeted ant bait');
    for (const app of [roachGel, antGel]) {
      expect(applicationPurposeCopy(app, 'pest')).not.toMatch(/light\s+\w*\s*activity/i);
    }
  });

  it('does not caption a fogged roach treatment as a mosquito application', () => {
    for (const app of [foggedInsecticide, foggedIgr]) {
      expect(applicationPurpose(app, 'pest')).toBe('Targeted cockroach treatment');
      const copy = [
        applicationPurposeCopy(app, 'pest'),
        ...applicationTechnicalExplanation(app, 'pest'),
      ].join(' ');
      expect(copy).toMatch(/cockroaches/);
      expect(copy).not.toMatch(/mosquito/i);
    }
  });

  it('keeps mosquito copy for mosquito visits and mosquito-identified fogs', () => {
    expect(applicationPurpose(foggedInsecticide, 'mosquito')).toBe('Mosquito pressure reduction');
    const mosquitoFog = { method: 'fog_ulv', targets: ['Mosquitoes'], product: { name: 'DeltaGard', category: 'insecticide' } };
    expect(applicationPurpose(mosquitoFog, 'pest')).toBe('Mosquito pressure reduction');
    expect(applicationTechnicalExplanation(mosquitoFog, 'pest').join(' ')).toMatch(/mosquito/i);
  });

  it('resolves canonical enum target keys, not just display labels', () => {
    const enumFog = { method: 'fog_ulv', targets: ['german_roaches'], product: { name: 'Alpine WSG', category: 'insecticide' } };
    expect(applicationPurpose(enumFog, 'pest')).toBe('Targeted cockroach treatment');
    const enumBait = { method: 'bait_placement', targets: ['ghost_ant'], product: { name: 'Generic Gel', category: 'bait' } };
    expect(applicationPurpose(enumBait, 'pest')).toBe('Targeted ant bait');
  });

  it('fails closed to generic copy when identity is unknown or ambiguous', () => {
    const unknownFog = { method: 'fog_ulv', targets: [], product: { name: 'CB-80', category: 'insecticide' } };
    expect(applicationPurpose(unknownFog, 'pest')).toBe('Space fog treatment');
    expect(applicationPurposeCopy(unknownFog, 'pest')).toMatch(/treated areas/);
    expect(applicationPurposeCopy(unknownFog, 'pest')).not.toMatch(/mosquito|\bants?\b|roach/i);
    const mixedBait = { method: 'bait_placement', targets: ['Ghost ants', 'German cockroaches'], product: { name: 'Multi-Pest Bait Stations', category: 'bait' } };
    expect(applicationPestFamily(mixedBait)).toBe(null);
    expect(applicationPurpose(mixedBait, 'pest')).toBe('Targeted bait placement');
  });

  it('treats an unrecognized co-target as ambiguity, not a match', () => {
    // Gentrol's catalog prefill keeps all three targets unless the tech trims
    // them — one recognized family plus unmatched co-targets must stay generic.
    const mixedFog = {
      method: 'fog_ulv',
      targets: ['German cockroaches', 'Drain flies', 'Pantry pests'],
      product: { name: 'Gentrol IGR', category: 'IGR' },
    };
    expect(applicationPestFamily(mixedFog)).toBe(null);
    expect(applicationPurpose(mixedFog, 'pest')).toBe('Space fog treatment');
    expect(applicationPurposeCopy(mixedFog, 'pest')).not.toMatch(/cockroach|mosquito/i);
  });

  it('reads identity from the product name ahead of the recorded targets', () => {
    const mislabeledTargets = { method: 'bait_placement', targets: ['Ghost ants'], product: { name: 'Advion Cockroach Gel Bait', category: 'bait' } };
    expect(applicationPurpose(mislabeledTargets, 'pest')).toBe('Targeted cockroach bait');
  });

  it('rodent bait copy makes no insect bait-sharing claim', () => {
    const rodentBait = { method: 'bait_placement', targets: ['Rodents'], product: { name: 'Contrac Blox', category: 'bait' } };
    const detail = applicationTechnicalExplanation(rodentBait, 'pest').join(' ');
    expect(detail).toMatch(/rodents/i);
    expect(detail).not.toMatch(/share|nest|foraging/i);
  });

  it('limits the bait-sharing mechanism to social insects — unknown targets get feeding-only copy', () => {
    const silverfishBait = { method: 'bait_placement', targets: ['Silverfish'], product: { name: 'Dekko Silverfish Paks', category: 'bait' } };
    const detail = applicationTechnicalExplanation(silverfishBait, 'pest').join(' ');
    expect(detail).toMatch(/targeted bait placement/i);
    expect(detail).not.toMatch(/share|nest|harborage|foraging/i);
    const roachDetail = applicationTechnicalExplanation(roachGel, 'pest').join(' ');
    expect(roachDetail).toMatch(/share it with others/);
  });

  it('keeps termite and rodent station/bait purposes unchanged', () => {
    expect(applicationPurpose({ method: 'station_check', product: { name: 'Trelona ATBS' } }, 'termite')).toBe('Station service');
    expect(applicationPurpose({ method: 'bait_placement', product: { name: 'Contrac Blox' } }, 'rodent')).toBe('Bait placement');
  });
});

// Fungicide purpose copy names the RECORDED disease targets — the same
// recorded-targets-only guard as lawn insect control (owner relevance pass
// 2026-08-03: the Artavia card read generic boilerplate while the visit
// documented large patch / gray leaf spot / take-all root rot).
describe('lawn fungicide purpose copy', () => {
  const fungicide = {
    method: 'broadcast_spray',
    targets: ['Large patch', 'Gray leaf spot', 'Take-all root rot'],
    product: { name: 'Artavia 2 SC (Azoxy)', category: 'Fungicide', active_ingredient: 'Azoxystrobin' },
  };

  it('names the recorded disease targets, lowercased, without claiming observation', () => {
    expect(applicationPurpose(fungicide, 'lawn')).toBe('Fungus control application');
    expect(applicationPurposeCopy(fungicide, 'lawn')).toBe(
      'Applied to protect the turf against large patch, gray leaf spot, take-all root rot, the targets your technician recorded for this application.',
    );
    // Chips can be untrimmed catalog prefill (label targets) — the copy must
    // never present them as observed/documented disease (codex P1 #3187).
    expect(applicationPurposeCopy(fungicide, 'lawn')).not.toMatch(/documented|observed|found|designed/i);
  });

  it('normalizes enum-key targets before printing', () => {
    const enumTargets = { ...fungicide, targets: ['take_all_root_rot'] };
    expect(applicationPurposeCopy(enumTargets, 'lawn')).toContain('take all root rot');
    expect(applicationPurposeCopy(enumTargets, 'lawn')).not.toContain('_');
  });

  it('fails closed to the generic line with no recorded targets', () => {
    const noTargets = { ...fungicide, targets: [] };
    expect(applicationPurposeCopy(noTargets, 'lawn')).toBe(
      'Applied to support turf health where fungus pressure or seasonal conditions called for protection.',
    );
  });
});

// Nutrient why-used correlates to today's tech-confirmed photo diagnosis
// (owner 2026-08-04): the generic program line was identical on every
// fertilizer card while the same page's assessment carried the reason. The
// claims stay within the record — category status/label are the server-derived
// diagnosis the Turf Health section already renders; no "chosen because"
// causality, no observed-condition wording.
describe('lawn nutrient purpose copy — diagnosis correlation', () => {
  const iron = {
    method: 'broadcast_spray',
    targets: [],
    product: { name: 'LESCO Chelated Iron Plus', category: 'Fertilizer', active_ingredient: 'Iron + N (foliar)' },
  };
  const potassium = {
    method: 'broadcast_spray',
    targets: [],
    product: { name: 'LESCO K-Flow 0-0-25 17% S', category: 'Fertilizer', active_ingredient: 'Potassium 0-0-25 + sulfur' },
  };
  const GENERIC = 'Used to support turf density, color, and recovery within the documented lawn program.';
  const diagnosis = (colorStatus, stressStatus) => ([
    { key: 'color_vigor', label: 'Color & Vigor', status: colorStatus },
    { key: 'damage_disease_signals', label: 'Stress / Damage Signals', status: stressStatus },
  ]);

  it('iron cites a flagged Color & Vigor category', () => {
    const why = applicationPurposeCopy(iron, 'lawn', { diagnosis: diagnosis('watch', 'healthy') });
    expect(why).toContain('Color & Vigor');
    expect(why).toContain('area to watch');
    // Recorded-diagnosis claims only — never observed/chosen-because wording.
    expect(why).not.toMatch(/observed|found|because|chosen/i);
  });

  it('potassium cites flagged stress signals', () => {
    const why = applicationPurposeCopy(potassium, 'lawn', { diagnosis: diagnosis('healthy', 'watch') });
    expect(why).toContain('Stress / Damage Signals');
    expect(why).toContain('potassium');
  });

  it('an un-flagged matching category fails closed to the generic line', () => {
    expect(applicationPurposeCopy(iron, 'lawn', { diagnosis: diagnosis('healthy', 'watch') })).toBe(GENERIC);
    expect(applicationPurposeCopy(potassium, 'lawn', { diagnosis: diagnosis('watch', 'strong') })).toBe(GENERIC);
  });

  it('no diagnosis context (older payloads / PDF fallback) keeps the generic line', () => {
    expect(applicationPurposeCopy(iron, 'lawn')).toBe(GENERIC);
    expect(applicationPurposeCopy(iron, 'lawn', { diagnosis: [] })).toBe(GENERIC);
  });

  it('an unrecognized nutrient product never borrows a diagnosis line', () => {
    const lime = { method: 'broadcast_spray', targets: [], product: { name: 'Pelletized Lime', category: 'Fertilizer', active_ingredient: 'Calcium carbonate 15-0-0' } };
    expect(applicationPurposeCopy(lime, 'lawn', { diagnosis: diagnosis('watch', 'watch') })).toBe(GENERIC);
  });

  it('a potassium chelate takes the potassium reason, not the chelate/color one (codex P2 r4)', () => {
    const kChelate = { method: 'broadcast_spray', targets: [], product: { name: 'K-Boost', category: 'Fertilizer', active_ingredient: 'Potassium chelate' } };
    const why = applicationPurposeCopy(kChelate, 'lawn', { diagnosis: diagnosis('watch', 'watch') });
    expect(why).toContain('Stress / Damage Signals');
    expect(why).not.toContain('Color & Vigor');
    // Only Color flagged → the potassium rule matches first, its category is
    // un-flagged, and the copy fails closed rather than borrowing color.
    expect(applicationPurposeCopy(kChelate, 'lawn', { diagnosis: diagnosis('watch', 'healthy') })).toBe(GENERIC);
  });
});

// Free-form target chips are unrestricted text — only governed disease
// vocabulary may render on the fungicide line; ANY unrecognized target
// fails the whole line closed (codex P1 #3187 r16).
describe('fungicide targets are restricted to governed disease vocabulary', () => {
  const base = {
    method: 'broadcast_spray',
    product: { name: 'Artavia 2 SC (Azoxy)', category: 'Fungicide', active_ingredient: 'Azoxystrobin' },
  };

  it('free-form claims never render, even alongside recognized diseases', () => {
    for (const targets of [['pet-safe'], ['EPA-approved'], ['dries in 1 hour'], ['Large patch', 'pet-safe']]) {
      const copy = applicationPurposeCopy({ ...base, targets }, 'lawn');
      expect(copy).toBe(
        'Applied to support turf health where fungus pressure or seasonal conditions called for protection.',
      );
    }
  });

  it('governed names, including enum keys and the combined prefill label, still render', () => {
    expect(applicationPurposeCopy({ ...base, targets: ['Brown patch / large patch', 'Fairy ring'] }, 'lawn'))
      .toContain('brown patch / large patch, fairy ring');
    expect(applicationPurposeCopy({ ...base, targets: ['take_all_root_rot'] }, 'lawn'))
      .toContain('take all root rot');
  });
});

// Allowlist stays synchronized with the catalog prefill vocabulary — the
// oomycete products' normal prefills must render (codex P2 #3187 r17),
// while the deliberately-excluded root-rot claim still fails closed.
describe('fungicide vocabulary covers the oomycete catalog prefills', () => {
  const base = {
    method: 'broadcast_spray',
    product: { name: 'Subdue Maxx Fungicide', category: 'Fungicide', active_ingredient: 'Mefenoxam' },
  };

  it('Banol/Subdue prefill targets render', () => {
    const copy = applicationPurposeCopy(
      { ...base, targets: ['Pythium blight', 'Pythium damping-off', 'Yellow tuft (downy mildew)'] },
      'lawn',
    );
    expect(copy).toContain('pythium blight, pythium damping-off, yellow tuft (downy mildew)');
  });

  it('the excluded root-rot claim still fails the line closed', () => {
    expect(applicationPurposeCopy({ ...base, targets: ['Pythium root rot'] }, 'lawn')).toBe(
      'Applied to support turf health where fungus pressure or seasonal conditions called for protection.',
    );
  });
});
