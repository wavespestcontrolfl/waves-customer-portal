const { pressureFromFindings } = require('../services/service-report/pressure-index');
const { renderTreatmentMap } = require('../services/service-report/treatment-map');
const { detectServiceLine } = require('../services/service-report/service-line-configs');
const {
  buildReportV1Data,
  locationAreaLabels,
  methodFromProduct,
  minutesFromElapsed,
} = require('../services/service-report/report-data');

describe('service report v1', () => {
  test('pressure index uses weighted current findings and prior smoothing', () => {
    const currentOnly = pressureFromFindings([
      { severity: 'low' },
      { severity: 'medium' },
      { severity: 'high' },
    ]);
    const smoothed = pressureFromFindings([
      { severity: 'low' },
      { severity: 'medium' },
      { severity: 'high' },
    ], 1.2);

    expect(currentOnly).toBe(3.6);
    expect(smoothed).toBe(3.0);
  });

  test('treatment map is deterministic and exposes interactive layer data', () => {
    const input = {
      geometry: {
        lot: { w: 620, h: 320 },
        house: { x: 220, y: 90, w: 180, h: 120 },
        garage: null,
        lanai: null,
        pool: null,
        drive: null,
        north_indicator: 'top',
        scale_ft_per_unit: 6,
      },
      zones: [
        { id: 'zone-a', letter: 'A', label: 'front perimeter', geometry: { x: 60, y: 40, w: 500, h: 40 } },
        { id: 'zone-b', letter: 'B', label: 'garage', geometry: { x: 420, y: 120, w: 70, h: 80 } },
      ],
      applications: [
        {
          id: 'app-1',
          product: { name: 'Demand CS', epa_reg: '100-1066' },
          method: 'perimeter_spray',
          zone_ids: ['zone-a'],
        },
        {
          id: 'app-2',
          product: { name: 'Glue board', epa_reg: '' },
          method: 'bait_placement',
          zone_ids: ['zone-b'],
        },
      ],
      flags: [{ zone_id: 'zone-a', label: 'Ant trail' }],
    };

    const first = renderTreatmentMap(input);
    const second = renderTreatmentMap(input);

    expect(first).toBe(second);
    expect(first).toContain('data-application-id="app-1"');
    expect(first).toContain('data-product-name="Demand CS"');
    expect(first).toContain('url(#hatch-spray)');
    expect(first).toContain('Ant trail');
  });

  test('service report classifiers keep customer-facing report labels accurate', () => {
    expect(detectServiceLine('Weed Control')).toBe('lawn');
    expect(detectServiceLine('Dethatching Service')).toBe('lawn');
    expect(detectServiceLine('Top Dressing')).toBe('lawn');
    expect(detectServiceLine('Sod Installation')).toBe('lawn');
    expect(detectServiceLine('Lawn Aeration')).toBe('lawn');
    expect(detectServiceLine('Mice Control')).toBe('rodent');
    expect(detectServiceLine('Mole Service')).toBe('rodent');
    expect(detectServiceLine('Palm Tree Nutritional Treatment')).toBe('palm');
    expect(detectServiceLine('Every 6 Weeks Tree & Shrub Care Service')).toBe('tree_shrub');
    expect(methodFromProduct({ product_category: 'bait' }, 'pest')).toBe('bait_placement');
    expect(methodFromProduct({ product_category: 'bait' }, 'rodent')).toBe('bait_placement');
  });

  test('elapsed time parser matches completion panel duration strings', () => {
    expect(minutesFromElapsed('10:05')).toBe(10);
    expect(minutesFromElapsed('10:35')).toBe(11);
    expect(minutesFromElapsed('1:02:30')).toBe(63);
    expect(minutesFromElapsed('25')).toBe(25);
  });

  test('fallback map zones only use actual location labels', () => {
    expect(locationAreaLabels([
      'Perimeter',
      'Customer spoke with tech',
      'No issues found',
      'Garage',
      'Follow-up recommended',
    ])).toEqual(['Perimeter', 'Garage']);
  });

  test('v1 data does not advertise the legacy report PDF', async () => {
    const fixtures = {
      service_products: [],
      property_geometries: [],
      property_zones: [],
      service_findings: [],
      service_photos: [],
    };
    const knex = (table) => {
      const rows = fixtures[table] || [];
      const query = {
        where: () => query,
        orderBy: () => query,
        first: () => Promise.resolve(rows[0] || null),
        catch: () => Promise.resolve(rows),
        then: (resolve) => Promise.resolve(rows).then(resolve),
      };
      return query;
    };

    const data = await buildReportV1Data({
      id: 'service-1',
      customer_id: 'customer-1',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-15',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Perimeter', 'No issues found']),
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-1', knex);

    expect(data.pdfUrl).toBeNull();
    expect(data.zones.map((zone) => zone.label)).toEqual(['Perimeter']);
  });
});
