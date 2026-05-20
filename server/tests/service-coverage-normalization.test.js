const {
  DEFAULT_SERVICE_COVERAGE_CONFIG,
  normalizeCoverageStatus,
  normalizeServiceCoverage,
} = require('../services/service-report/service-coverage');

describe('service coverage normalization', () => {
  test('areas only returns list-only service coverage', () => {
    const coverage = normalizeServiceCoverage({
      serviceRecordId: 'service-1',
      serviceLine: 'pest',
      serviceType: 'Quarterly Pest Control Service',
      serviceDate: '2026-05-17',
      propertyAddress: '12312 Cedar Pass Trl, Parrish, FL 34219',
      serviceAreas: ['Perimeter', 'Entry Points'],
      serviceLocations: [],
      zones: [],
    }, DEFAULT_SERVICE_COVERAGE_CONFIG);

    expect(coverage.enabled).toBe(true);
    expect(coverage.title).toBe('Service Coverage');
    expect(coverage.items).toHaveLength(2);
    expect(coverage.map.available).toBe(false);
    expect(coverage.items[0]).toMatchObject({
      markerLabel: 'A',
      areaName: 'Perimeter',
      customerDescription: 'Exterior perimeter service completed.',
      status: 'completed',
      statusLabel: 'Completed',
    });
  });

  test('areas and map locations share coverage items and preserve marker labels', () => {
    const coverage = normalizeServiceCoverage({
      serviceRecordId: 'service-1',
      serviceLine: 'pest',
      serviceType: 'Quarterly Pest Control Service',
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
    }, DEFAULT_SERVICE_COVERAGE_CONFIG);

    expect(coverage.items).toHaveLength(2);
    expect(coverage.items.map((item) => item.markerLabel)).toEqual(['A', 'B']);
    expect(coverage.items[1].customerDescription).toBe('Entry points inspected and treated.');
    expect(coverage.map.available).toBe(true);
    expect(coverage.map.markers.map((marker) => marker.label)).toEqual(['A', 'B']);
  });

  test('service-line wording avoids pest-only copy', () => {
    const lawn = normalizeServiceCoverage({
      serviceRecordId: 'service-lawn',
      serviceLine: 'lawn',
      serviceType: 'Lawn Fertilization',
      serviceLocations: [{ id: 'front', name: 'Front Lawn', status: 'weed_control_applied' }],
    }, DEFAULT_SERVICE_COVERAGE_CONFIG);
    const termite = normalizeServiceCoverage({
      serviceRecordId: 'service-termite',
      serviceLine: 'termite',
      serviceType: 'Termite Station Service',
      serviceLocations: [{ id: 'station-4', name: 'Station 4', status: 'station_checked' }],
    }, DEFAULT_SERVICE_COVERAGE_CONFIG);

    expect(lawn.title).toBe('Lawn Coverage');
    expect(lawn.intro).toContain('lawn service');
    expect(lawn.items[0].customerDescription).toBe('Weed control applied.');
    expect(termite.title).toBe('Inspection & Treatment Coverage');
    expect(termite.intro).toContain('checked stations');
    expect(termite.items[0]).toMatchObject({
      status: 'checked',
      statusLabel: 'Checked',
      customerDescription: 'Station checked.',
    });
  });

  test('hidden items are not exposed and inaccessible reasons are customer-friendly', () => {
    const coverage = normalizeServiceCoverage({
      serviceRecordId: 'service-1',
      serviceLine: 'pest',
      serviceLocations: [
        { id: 'public', name: 'Backyard', status: 'inaccessible', skippedReason: 'the gate was locked' },
        { id: 'internal', name: 'Internal risk note', status: 'needs_attention', isVisibleToCustomer: false },
      ],
    }, DEFAULT_SERVICE_COVERAGE_CONFIG);

    expect(coverage.items).toHaveLength(1);
    expect(coverage.items[0]).toMatchObject({
      status: 'inaccessible',
      statusLabel: 'Inaccessible',
      customerDescription: 'Technician could not access this area because the gate was locked.',
    });
    expect(coverage.summary).toMatchObject({
      completedCount: 0,
      inspectedCount: 0,
      inaccessibleCount: 1,
      needsAttentionCount: 0,
    });
  });

  test('normalizes broad internal statuses to simple customer labels', () => {
    expect(normalizeCoverageStatus('weed_control_applied')).toBe('completed');
    expect(normalizeCoverageStatus('bait_replaced')).toBe('completed');
    expect(normalizeCoverageStatus('station_checked')).toBe('checked');
    expect(normalizeCoverageStatus('inspection_completed')).toBe('inspected');
  });
});
