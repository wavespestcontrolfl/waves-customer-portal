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
    expect(detectServiceLine('Palmetto Roach Treatment')).toBe('pest');
    expect(detectServiceLine('Initial Palmetto Knockdown')).toBe('pest');
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
    expect(data.serviceData).toBeUndefined();
    expect(data.zones.map((zone) => zone.label)).toEqual(['Perimeter']);
  });

  test('v1 data exposes completion panel fields used by the report', async () => {
    const fixtures = {
      service_products: [{
        id: 'product-1',
        product_name: 'Demand CS',
        product_category: 'insecticide',
        active_ingredient: 'Lambda-cyhalothrin',
        application_rate: '0.800',
        rate_unit: 'fl_oz',
        total_amount: '2.000',
        amount_unit: 'fl_oz',
        created_at: '2026-05-15T14:00:00Z',
      }],
      property_geometries: [],
      property_zones: [],
      service_findings: [],
      service_photos: [{
        id: 'photo-1',
        s3_url: 'https://example.com/photo.jpg',
        caption: 'After service',
        created_at: '2026-05-15T14:15:00Z',
      }],
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
      technician_name: 'Avery Tech',
      customer_interaction: 'spoke',
      soil_temp: 82,
      thatch_measurement: 0.5,
      soil_ph: 6.8,
      soil_moisture: 33,
      areas_serviced: JSON.stringify(['Perimeter', 'Garage']),
      structured_notes: JSON.stringify({
        customerRecap: 'Completed the exterior service and addressed activity around the garage.',
        timeOnSite: '42:00',
        protocolActionsCompleted: ['Applied perimeter band'],
        observations: ['Pest activity noted'],
        recommendations: ['Seal entry gaps near garage'],
      }),
      service_data: JSON.stringify({
        protocol: {
          actions: ['Cobweb sweep'],
          observations: ['Standing water found'],
          recommendations: ['Irrigation adjustment needed'],
          visitOutcome: 'follow_up_needed',
        },
      }),
    }, 'token-1', knex);

    expect(data.summary).toMatch(/Completed the exterior service/);
    expect(data.customerInteraction).toBe('spoke');
    expect(data.visitOutcome).toBe('follow_up_needed');
    expect(data.serviceAreas).toEqual(['Perimeter', 'Garage']);
    expect(data.protocol.actions).toEqual(['Cobweb sweep', 'Applied perimeter band']);
    expect(data.findings.map((finding) => finding.title)).toEqual(['Standing water found', 'Pest activity noted']);
    expect(data.recommendations).toEqual(['Irrigation adjustment needed', 'Seal entry gaps near garage']);
    expect(data.metrics.find((metric) => metric.key === 'on_site_min').value).toBe(42);
    expect(data.measurements).toEqual({ soilTemp: 82, thatch: 0.5, soilPh: 6.8, moisture: 33 });
    expect(data.applications[0].product.name).toBe('Demand CS');
    expect(data.photos[0].url).toBe('https://example.com/photo.jpg');
  });
});
