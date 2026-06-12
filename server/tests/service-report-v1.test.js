// Legacy pressureFromFindings + computePressureIndex have been replaced by
// the pest-pressure engine. See server/tests/pest-pressure-*.test.js for
// the equivalent coverage against the new 5-component weighted formula.
const { renderTreatmentMap } = require('../services/service-report/treatment-map');
const { buildSatelliteTreatmentMapContext } = require('../services/service-report/satellite-treatment-map');
const { detectServiceLine } = require('../services/service-report/service-line-configs');
const {
  buildReportV1Data,
  buildWorkflowEvents,
  buildVisitTimeline,
  locationAreaLabels,
  methodFromProduct,
  minutesFromElapsed,
  normalizeAdvisoryForTreatmentScope,
  buildCompletionAdvisory,
} = require('../services/service-report/report-data');
const {
  hashPhotoChainPayload,
  validatePhotoChainRows,
} = require('../services/service-report/photo-chain');
const { formatTechnicianForCustomer } = require('../utils/technician-name');
const { computeOnSiteMin } = require('../services/service-report/metrics-band');
const {
  cfBrowserRenderingTimeoutMs,
  renderReportPdfWithCloudflare,
  selectedPdfRenderer,
  serviceReportViewerUrl,
} = require('../services/service-report/pdf');
const {
  safePdfRenderError,
  sanitizedPdfRenderMetadata,
} = require('../services/service-report/pdf-events');
const {
  buildServiceReportV1DeliveryContext,
  buildServiceReportV1Sms,
  serviceReportV1SmsType,
  shouldSendServiceReportV1Delivery,
} = require('../services/service-report/delivery');
const { buildServiceReportV1Email } = require('../services/service-report/email-delivery');
const { buildPressureTrendContextFromRows } = require('../services/service-report/pressure-trend');
const { buildSinceLastVisitContext } = require('../services/service-report/since-last-visit');
const {
  buildPremiumExperienceContextFromRows,
  buildWeatherCallContext,
  validateCustomerCopy,
} = require('../services/service-report/premium-experience');
const {
  normalizeFawnConditions,
  weatherCodeLabel,
} = require('../services/service-report/application-conditions');
const {
  answerServiceReportQuestion,
} = require('../services/service-report/report-assistant');
const { buildReentryContextFromRecord } = require('../services/service-report/reentry');
const {
  enqueueServiceReportV1EmailDelivery,
  nextServiceReportDeliveryAttemptAt,
} = require('../services/service-report/delivery-queue');
const { buildNoActivityFinding } = require('../services/service-report/no-activity-finding');

describe('service report v1', () => {
  function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  test('dynamic pressure trend floors persisted zero values at 0.3', () => {
    const context = buildPressureTrendContextFromRows({
      record: { id: 'service-current', service_date: '2026-05-16', pressure_index: 0 },
      priorRows: [{ id: 'service-1', service_date: '2026-04-16', pressure_index: 0 }],
      findings: [],
    });

    expect(context.points.map((point) => point.pressureIndex)).toEqual([0.3, 0.3]);
    expect(context.baseline.pressureIndex).toBe(0.3);
    expect(context.current.pressureIndex).toBe(0.3);
    expect(context.customerSummary).toBe('Pest pressure remains low at 0.3.');
  });

  test('since-last-visit pressure copy uses the customer pressure floor', async () => {
    const fixtures = {
      service_records: [
        {
          id: 'service-prior',
          customer_id: 'customer-1',
          status: 'completed',
          service_line: 'pest',
          service_type: 'Quarterly Pest Control Service',
          service_date: '2026-04-16',
          pressure_index: 0,
        },
      ],
      service_findings: [],
    };
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (typeof criteria === 'function') return query;
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value));
          }
          return query;
        },
        whereNot(criteria) {
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] !== value));
          }
          return query;
        },
        whereIn(column, values) {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        orderBy: () => query,
        select: () => query,
        first: () => Promise.resolve(rows[0] || null),
        catch: () => Promise.resolve(rows),
      };
      return query;
    };

    const context = await buildSinceLastVisitContext({
      record: {
        id: 'service-current',
        customer_id: 'customer-1',
        service_line: 'pest',
        service_type: 'Quarterly Pest Control Service',
        pressure_index: 0,
      },
      knex,
    });

    expect(context.pressureLine).toBe('Pressure: 0.3 -> 0.3');
  });

  test('dynamic pressure trend includes current override and customer ROI copy', () => {
    const context = buildPressureTrendContextFromRows({
      record: {
        id: 'service-current',
        service_date: '2026-05-16',
        pressure_index: null,
      },
      currentPressureIndexOverride: 1.6,
      priorRows: [
        { id: 'service-1', service_date: '2026-01-12', pressure_index: 3.2 },
        { id: 'service-2', service_date: '2026-03-04', pressure_index: 2.4 },
      ],
      findings: [
        { service_record_id: 'service-current', severity: 'low', title: 'Light ant activity' },
        { service_record_id: 'service-current', severity: 'high', title: 'Active trail at entry' },
      ],
    });

    expect(context.points.map((point) => point.serviceRecordId)).toEqual(['service-1', 'service-2', 'service-current']);
    expect(context.current.pressureIndex).toBe(1.6);
    expect(context.direction).toBe('down');
    expect(context.percentChange).toBe(50);
    expect(context.current.mainDriver).toBe('Active trail at entry');
    expect(context.customerSummary).toContain('down 50%');
  });

  test('dynamic pressure trend avoids odd percentages from low baseline and handles first visit', () => {
    const lowBaseline = buildPressureTrendContextFromRows({
      record: { id: 'service-current', service_date: '2026-05-16', pressure_index: 0.4 },
      priorRows: [{ id: 'service-1', service_date: '2026-01-12', pressure_index: 0.8 }],
      findings: [],
    });
    const firstVisit = buildPressureTrendContextFromRows({
      record: { id: 'service-current', service_date: '2026-05-16', pressure_index: 1.4 },
      priorRows: [],
      findings: [],
    });

    expect(lowBaseline.percentChange).toBeUndefined();
    expect(lowBaseline.customerSummary).toBe('Pest pressure remains low at 0.4.');
    expect(firstVisit.direction).toBe('first_visit');
    expect(firstVisit.customerSummary).toContain('first pressure marker: 1.4');
  });

  test('dynamic re-entry context uses latest application and absolute ready times', () => {
    const context = buildReentryContextFromRecord({
      id: 'service-1',
      started_at: '2026-05-16T13:00:00.000Z',
      ended_at: '2026-05-16T13:20:00.000Z',
      areas_serviced: JSON.stringify(['Exterior perimeter', 'Interior baseboards']),
      applications: [
        { appliedAt: '2026-05-16T13:10:00.000Z' },
        { appliedAt: '2026-05-16T13:30:00.000Z' },
      ],
      advisory: {
        exterior_reentry_min: 30,
        interior_reentry_min: 120,
        irrigation_hold_hr: 24,
        pet_advisory: 'Keep pets off treated zones until dry.',
      },
    }, new Date('2026-05-16T13:35:00.000Z'));

    expect(context.anchorAppliedAt).toBe('2026-05-16T13:30:00.000Z');
    expect(context.targets).toHaveLength(2);
    expect(context.targets[0]).toMatchObject({ key: 'exterior', statusAtGeneratedAt: 'pending' });
    expect(context.targets[1]).toMatchObject({ key: 'interior', statusAtGeneratedAt: 'pending' });
    expect(context.petAdvisory).toBe('Keep pets off treated zones until dry.');
    expect(context.irrigationReadyAt).toBe('2026-05-17T13:30:00.000Z');
    expect(context.customerSummary).toContain('Exterior ready at');
  });

  test('re-entry and advisory only expose interior timing when interior was treated', () => {
    const advisory = {
      exterior_reentry_min: 30,
      interior_reentry_min: 120,
      irrigation_hold_hr: 24,
    };
    const unknownScope = normalizeAdvisoryForTreatmentScope(advisory, {
      service: { areas_serviced: JSON.stringify([]) },
      applications: [{ application_method: 'perimeter_spray' }],
    });
    const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
      service: { areas_serviced: JSON.stringify(['Exterior perimeter']) },
      applications: [{ application_area: 'Exterior perimeter', application_method: 'perimeter_spray' }],
    });
    const context = buildReentryContextFromRecord({
      id: 'service-exterior-only',
      ended_at: '2026-05-16T13:20:00.000Z',
      areas_serviced: JSON.stringify(['Exterior perimeter']),
      applications: [{ appliedAt: '2026-05-16T13:20:00.000Z', application_area: 'Exterior perimeter' }],
      advisory,
    }, new Date('2026-05-16T13:25:00.000Z'));

    expect(unknownScope).toMatchObject({ exterior_reentry_min: 30, interior_reentry_min: 120 });
    expect(normalized).toMatchObject({ exterior_reentry_min: 30, interior_reentry_min: 0 });
    expect(context.targets.map((target) => target.key)).toEqual(['exterior']);
  });

  describe('structured action scope drives interior re-entry', () => {
    const advisory = { exterior_reentry_min: 30, interior_reentry_min: 120, irrigation_hold_hr: 24 };
    const exteriorAreas = JSON.stringify(['Exterior perimeter']);
    const interiorAreas = JSON.stringify(['Interior — baseboards/kitchen/baths']);

    test('interior treatment action keeps interior even with exterior-only areas', () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: {
          areas_serviced: exteriorAreas,
          structured_notes: {
            areasTreated: ['Exterior perimeter'],
            protocolActionScopesCompleted: [
              { label: 'Applied interior treatment', scope: 'interior', treatmentApplied: true },
            ],
          },
        },
      });
      expect(normalized).toMatchObject({ interior_reentry_min: 120 });
    });

    test('interior INSPECTION (treatmentApplied:false) does NOT fire interior', () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: {
          areas_serviced: exteriorAreas,
          structured_notes: {
            areasTreated: ['Exterior perimeter'],
            protocolActionScopesCompleted: [
              { label: 'Interior inspection', scope: 'interior', treatmentApplied: false },
            ],
          },
        },
      });
      expect(normalized).toMatchObject({ interior_reentry_min: 0 });
    });

    test('exterior-only actions zero interior', () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: {
          structured_notes: {
            protocolActionScopesCompleted: [
              { label: 'Applied non-repellent solutions (exterior)', scope: 'exterior', treatmentApplied: true },
            ],
          },
        },
      });
      expect(normalized).toMatchObject({ interior_reentry_min: 0 });
    });

    test('mixed interior + exterior actions keep both windows', () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: {
          structured_notes: {
            protocolActionScopesCompleted: [
              { label: 'Applied repellent solutions (exterior)', scope: 'exterior', treatmentApplied: true },
              { label: 'Applied non-repellent solutions (interior)', scope: 'interior', treatmentApplied: true },
            ],
          },
        },
      });
      expect(normalized).toMatchObject({ exterior_reentry_min: 30, interior_reentry_min: 120 });
    });

    test('conflict: exterior area + interior action ⇒ interior fires', () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: {
          areas_serviced: exteriorAreas,
          structured_notes: {
            protocolActionScopesCompleted: [
              { label: 'Applied interior treatment', scope: 'interior', treatmentApplied: true },
            ],
          },
        },
      });
      expect(normalized).toMatchObject({ interior_reentry_min: 120 });
    });

    test('conflict: interior area + exterior action ⇒ interior still fires (area wins)', () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: {
          areas_serviced: interiorAreas,
          structured_notes: {
            protocolActionScopesCompleted: [
              { label: 'Applied non-repellent solutions (exterior)', scope: 'exterior', treatmentApplied: true },
            ],
          },
        },
      });
      expect(normalized).toMatchObject({ interior_reentry_min: 120 });
    });

    test('legacy record with no structured scopes falls back to area regex', () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: { areas_serviced: exteriorAreas },
        applications: [{ application_area: 'Exterior perimeter' }],
      });
      expect(normalized).toMatchObject({ interior_reentry_min: 0 });
    });

    test('structured_notes as a JSON string is parsed', () => {
      const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
        service: {
          areas_serviced: exteriorAreas,
          structured_notes: JSON.stringify({
            protocolActionScopesCompleted: [
              { label: 'Applied interior treatment', scope: 'interior', treatmentApplied: true },
            ],
          }),
        },
      });
      expect(normalized).toMatchObject({ interior_reentry_min: 120 });
    });

    test.each([null, [], 'not-json', [{ junk: true }], [{ scope: 'interior' }]])(
      'malformed protocolActionScopesCompleted (%p) is ignored; exterior areas still zero interior',
      (bad) => {
        const normalized = normalizeAdvisoryForTreatmentScope(advisory, {
          service: {
            areas_serviced: exteriorAreas,
            structured_notes: { protocolActionScopesCompleted: bad },
          },
        });
        expect(normalized).toMatchObject({ interior_reentry_min: 0 });
      },
    );

    // Write-path coverage: buildCompletionAdvisory is exactly what the
    // /complete route persists. Asserts the route's scope wiring, not just
    // the normalizer in isolation.
    test('buildCompletionAdvisory: exterior areas + interior treatment action keeps interior', () => {
      const built = buildCompletionAdvisory({
        advisoryDefaults: advisory,
        completionAreas: ['Exterior perimeter'],
        protocolActionScopes: [
          { label: 'Applied interior treatment', scope: 'interior', treatmentApplied: true },
        ],
      });
      expect(built).toMatchObject({ exterior_reentry_min: 30, interior_reentry_min: 120 });
    });

    test('buildCompletionAdvisory: exterior-only completion zeroes interior', () => {
      const built = buildCompletionAdvisory({
        advisoryDefaults: advisory,
        completionAreas: ['Exterior perimeter'],
        protocolActionScopes: [],
      });
      expect(built).toMatchObject({ exterior_reentry_min: 30, interior_reentry_min: 0 });
    });
  });

  test('premium experience builds customer-facing modules from service facts', () => {
    const context = buildPremiumExperienceContextFromRows({
      record: {
        id: 'service-current',
        pressure_index: 1.6,
        conditions: JSON.stringify({
          temp_f: 82,
          humidity_pct: 64,
          wind_mph: 8,
          rain_24h_in: 0.04,
          source: 'FAWN 311 Myakka River',
        }),
      },
      dynamicContext: {
        pressureTrend: {
          direction: 'down',
          percentChange: 53,
          customerSummary: 'Pest pressure is down 53% since your first WaveGuard service.',
          current: { pressureIndex: 1.6 },
          points: [
            { serviceRecordId: 'service-1', pressureIndex: 3.4 },
            { serviceRecordId: 'service-current', pressureIndex: 1.6 },
          ],
        },
      },
      findings: [
        {
          id: 'finding-1',
          category: 'conducive_condition',
          severity: 'medium',
          title: 'Ghost ant trail at front entry threshold',
          detail: 'Light activity from mulch bed to door sweep',
          recommendation: 'Keep mulch pulled back two inches from the front-entry foundation.',
          zone_id: 'zone-c',
        },
      ],
      applications: [
        {
          id: 'app-1',
          productName: 'Advion Ant Gel',
          method: 'bait_placement',
          targets: ['ghost_ant'],
        },
        {
          id: 'app-2',
          productName: 'Demand CS',
          method: 'perimeter_spray',
          targets: ['ghost_ant', 'american_roach'],
        },
      ],
      zones: [
        { id: 'zone-c', letter: 'C', label: 'Front entry', category: 'perimeter' },
      ],
      visitRows: [{ id: 'service-1' }, { id: 'service-current' }],
    });

    expect(context.aiSummaryPersonality.variants.straight.headline).toContain('down 53%');
    expect(context.aiSummaryPersonality.variants.unfiltered.body).toContain('mulch');
    expect(context.primaryMove.title).toContain('mulch pulled back');
    expect(context.propertyDefenseStatus.items.find((item) => item.key === 'perimeter_shield')).toMatchObject({ status: 'active' });
    expect(context.bugFiles[0]).toMatchObject({ suspectLabel: 'Ghost ant' });
    expect(context.whyActivity.title).toBe('Why you might still see ants');
    expect(context.weatherCall).toMatchObject({
      headline: 'Good treatment window.',
      factsLine: '82°F · 64% humidity · 8 mph wind · 0.04 in rain',
    });
    expect(context.pressureReceipt.stats.some((stat) => stat.label === 'Pressure down' && stat.value === '53%')).toBe(true);
    expect(validateCustomerCopy(context.aiSummaryPersonality.variants.unfiltered.body)).toBe(true);
  });

  test('premium weather call formats raw weather without overclaiming', () => {
    const good = buildWeatherCallContext({
      record: {
        conditions: JSON.stringify({
          temp_f: 82,
          humidity_pct: 64,
          wind_mph: 8,
          rain_24h_in: 0.04,
        }),
      },
    });
    const windy = buildWeatherCallContext({
      record: {
        conditions: JSON.stringify({
          wind_mph: 16,
          rain_24h_in: 0,
        }),
      },
    });

    expect(good.headline).toBe('Good treatment window.');
    expect(good.factsLine).toContain('82°F');
    expect(windy.headline).toBe('Wind was elevated.');
    expect(`${good.headline} ${good.body} ${windy.headline} ${windy.body}`).not.toMatch(/perfect|guaranteed|safe/i);
  });

  test('application conditions normalize FAWN snapshots for report storage', () => {
    const conditions = normalizeFawnConditions({
      temp_f: 84.6,
      humidity_pct: 71.2,
      wind_mph: 6.4,
      rainfall_in: 0.034,
      soil_temp_f: 78.4,
      station: 'Myakka River',
      station_key: 'myakka',
      observation_time: '2026-05-17T10:00:00-04:00',
      latitude: 27.35,
      longitude: -82.18,
    }, { capturedAt: new Date('2026-05-17T14:05:00.000Z') });

    expect(conditions).toMatchObject({
      temp_f: 85,
      humidity_pct: 71,
      wind_mph: 6,
      rain_24h_in: 0.03,
      soil_temp_f: 78,
      source: 'FAWN - Myakka River',
      provider: 'fawn',
      station: 'Myakka River',
      station_key: 'myakka',
      observation_time: '2026-05-17T10:00:00-04:00',
      captured_at: '2026-05-17T14:05:00.000Z',
    });
  });

  test('application condition weather codes stay customer-readable for fallback source', () => {
    expect(weatherCodeLabel(0)).toBe('Clear');
    expect(weatherCodeLabel(63)).toBe('Rain');
    expect(weatherCodeLabel(95)).toBe('Thunderstorms');
  });

  test('Ask Waves AI explains applications with technical context instead of product-only list', () => {
    const data = {
      serviceDisplayName: 'Quarterly Pest Control Service',
      serviceAreas: ['Exterior perimeter'],
      conditions: {
        temp_f: 84,
        humidity_pct: 70,
        wind_mph: 6,
        rain_24h_in: 0.02,
        source: 'FAWN - Myakka River',
      },
      applications: [
        {
          id: 'app-taurus',
          product: { name: 'Taurus SC', catalogId: 'cat-taurus' },
          method: 'perimeter_spray',
          methodLabel: 'Perimeter spray',
          applicationArea: 'Exterior perimeter',
          targets: ['ant', 'american_roach'],
        },
        {
          id: 'app-bifen',
          product: { name: 'Bifen XTS' },
          method: 'perimeter_spray',
          methodLabel: 'Perimeter spray',
          applicationArea: 'Exterior perimeter',
          targets: ['american_roach'],
        },
        {
          id: 'app-surfactant',
          product: { name: 'LESCO 90/10 Nonionic Surfactant' },
          method: 'perimeter_spray',
          methodLabel: 'Perimeter spray',
          applicationArea: 'Exterior perimeter',
        },
      ],
    };
    const productContext = {
      byApplicationId: {
        'app-taurus': {
          active_ingredient: 'Fipronil 9.1%',
          epa_reg_number: '53883-279',
        },
        'app-bifen': {
          active_ingredient: 'Bifenthrin 25.1%',
          rainfast_minutes: 60,
        },
      },
      byProductName: {},
    };

    const answer = answerServiceReportQuestion({
      question: 'What was applied today?',
      data,
      productContext,
    });

    expect(answer).toContain('Quarterly Pest Control Service');
    expect(answer).toContain('FAWN - Myakka River');
    expect(answer).toContain('active ingredient: Fipronil 9.1%');
    expect(answer).toContain('active ingredient: Bifenthrin 25.1%');
    expect(answer).toContain('spray adjuvant');
    expect(answer).toContain('Sources used: this service report');
    expect(answer).not.toBe('Taurus SC: Perimeter spray. Bifen XTS: Perimeter spray. LESCO 90/10 Nonionic Surfactant: Perimeter spray.');
  });

  test('Ask Waves AI gives useful next steps even when no recommendation is recorded', () => {
    const answer = answerServiceReportQuestion({
      question: 'What should I do next?',
      data: {
        serviceDisplayName: 'Quarterly Pest Control Service',
        serviceAreas: ['Exterior perimeter'],
        recommendations: [],
        findings: [],
        applications: [
          {
            id: 'app-1',
            product: { name: 'Taurus SC' },
            method: 'perimeter_spray',
            methodLabel: 'Perimeter spray',
            applicationArea: 'Exterior perimeter',
            targets: ['ant'],
          },
        ],
        dynamicContext: {
          reentry: {
            customerSummary: 'Exterior ready at 10:45 AM.',
          },
          premiumExperience: {
            weatherCall: {
              headline: 'Good treatment window.',
              body: 'Low rainfall and moderate wind supported exterior application.',
            },
          },
        },
      },
    });

    expect(answer).toContain('No special repair or prep was flagged');
    expect(answer).toContain('Exterior ready at 10:45 AM');
    expect(answer).toContain('Avoid rinsing');
    expect(answer).toContain('Watch for ants');
    expect(answer).not.toContain('No customer action was recommended on this report.');
  });

  test('Ask Waves AI does not call recommendations-only reports clean', () => {
    const answer = answerServiceReportQuestion({
      question: 'What did you find?',
      data: {
        findings: [],
        recommendations: ['Seal the gap under the front threshold.'],
      },
    });

    expect(answer).toContain('Recommended next step: Seal the gap under the front threshold.');
    expect(answer).not.toContain('No activity was observed');
  });

  test('Ask Waves AI uses approved lawn snapshot copy for lawn findings and next steps', () => {
    const data = {
      serviceLine: 'lawn',
      lawnAssessment: {
        scores: { overallScore: 83, turfDensity: 80, weedSuppression: 90, fungusControl: 88, thatchScore: 70 },
        customerSummary: 'Approved snapshot: moderate weed pressure is being monitored.',
        observations: 'Older tech observation should not replace approved snapshot copy.',
        snapshot: {
          summary: 'Approved snapshot: moderate weed pressure is being monitored.',
          findings: [{ customerCopy: 'We saw moderate weed pressure in the front lawn.' }],
          expectedWindow: { minDays: 14, maxDays: 21 },
          nextWatchItems: ['Compare the front lawn on the next service.'],
        },
        recommendationCards: [
          { customerCopy: 'We will keep watching this area on your next visit.' },
        ],
      },
      findings: [],
      recommendations: [],
    };

    expect(answerServiceReportQuestion({ question: 'What did you find?', data }))
      .toContain('We saw moderate weed pressure in the front lawn.');
    expect(answerServiceReportQuestion({ question: 'What should I do next?', data }))
      .toContain('We will keep watching this area on your next visit.');
    expect(answerServiceReportQuestion({ question: 'What should I do next?', data }))
      .toContain('Visible improvement usually takes 14-21 days');
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
          id: 'app-station',
          product: { name: 'Station inspection', epa_reg: '' },
          method: 'station_check',
          zone_ids: ['zone-b'],
        },
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
    expect(first).not.toContain('data-application-id="app-station"');
    expect(first).toContain('data-application-id="app-1"');
    expect(first).toContain('data-map-number="1"');
    expect(first).toContain('data-product-name="Demand CS"');
    expect(first).toContain('class="app-badge"');
    expect(first).toContain('url(#hatch-spray)');
    expect(first).toContain('Ant trail');
  });

  test('satellite treatment map is on by default, disablable via env, and keeps Google imagery out of PDF and SMS export', async () => {
    const previousEnabled = process.env.SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED;
    const previousKey = process.env.GOOGLE_STATIC_MAPS_API_KEY;
    try {
      process.env.SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED = 'false';
      process.env.GOOGLE_STATIC_MAPS_API_KEY = 'test-key';
      const disabled = await buildSatelliteTreatmentMapContext({
        service: { customer_latitude: 27.39, customer_longitude: -82.43 },
      });
      expect(disabled).toMatchObject({ available: false, fallbackReason: 'disabled' });

      delete process.env.SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED;
      process.env.GOOGLE_STATIC_MAPS_API_KEY = 'test-key';
      const enabled = await buildSatelliteTreatmentMapContext({
        service: { customer_latitude: 27.39, customer_longitude: -82.43 },
        zones: [{ id: 'zone-a', letter: 'A', label: 'Front entry', category: 'perimeter', geometry: { x: 60, y: 40, w: 120, h: 40 } }],
        applications: [
          {
            id: 'station-check-1',
            method: 'station_check',
            product: { name: 'Station check' },
            zone_ids: ['zone-a'],
          },
          {
            id: 'app-1',
            method: 'perimeter_spray',
            product: { name: 'Demand CS', epa_reg: '100-1066', active_ingredient: 'lambda-cyhalothrin' },
            targets: ['ghost_ant'],
            zone_ids: ['zone-a'],
          },
        ],
      });

      expect(enabled.available).toBe(true);
      expect(enabled.provider).toBe('google_maps');
      expect(enabled.live.url).toContain('maps.googleapis.com/maps/api/staticmap');
      expect(enabled.capabilities.canUseInPdf).toBe(false);
      expect(enabled.capabilities.canUseInSmsPreview).toBe(false);
      expect(enabled.overlay.zones[0].overlaySource).toBe('local_schematic');
      expect(enabled.overlay.applications).toHaveLength(1);
      expect(enabled.overlay.applications[0]).toMatchObject({
        id: 'app-1',
        productName: 'Demand CS',
        epaReg: '100-1066',
        activeIngredient: 'lambda-cyhalothrin',
        targets: ['ghost_ant'],
        zoneIds: ['zone-a'],
        zoneLabels: ['Front entry'],
      });
    } finally {
      if (previousEnabled === undefined) delete process.env.SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED;
      else process.env.SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED = previousEnabled;
      if (previousKey === undefined) delete process.env.GOOGLE_STATIC_MAPS_API_KEY;
      else process.env.GOOGLE_STATIC_MAPS_API_KEY = previousKey;
    }
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

  test('combined-service names detect their PRIMARY line (cutover)', () => {
    // "pest" BEFORE the rodent/termite token = pest-primary combined name —
    // the combined report renders the pest layout (pest pressure, pest copy)
    // with the companion as a section, not a rodent/termite report.
    expect(detectServiceLine('Pest & Rodent Control')).toBe('pest');
    expect(detectServiceLine('Quarterly Pest + Termite Bait Station')).toBe('pest');
    expect(detectServiceLine('Lawn + Tree & Shrub')).toBe('lawn');
    // Token order is load-bearing: rodent_general_one_time is named
    // "Rodent Pest Control" and must STAY a rodent report (Codex P2).
    expect(detectServiceLine('Rodent Pest Control')).toBe('rodent');
    // Names without "pest" keep their standalone lines.
    expect(detectServiceLine('Quarterly Rodent Bait Station Service')).toBe('rodent');
    expect(detectServiceLine('Termite Bait Station System')).toBe('termite');
    // Lawn/turf and mosquito mentions still beat an explicit "pest".
    expect(detectServiceLine('Lawn Pest Treatment')).toBe('lawn');
    expect(detectServiceLine('Mosquito & Pest Bundle')).toBe('mosquito');
    expect(methodFromProduct({ product_category: 'insecticide' }, 'tree_shrub')).toBe('foliar_spray');
    expect(methodFromProduct({ product_category: 'insecticide' }, 'palm')).toBe('foliar_spray');
  });

  test('customer technician formatter preserves generic fallbacks', () => {
    expect(formatTechnicianForCustomer({ name: 'Adam Benetti' })).toBe('Adam B.');
    expect(formatTechnicianForCustomer({ name: 'Your Waves technician' })).toBe('Your Waves technician');
    expect(formatTechnicianForCustomer({ name: 'Your tech' })).toBe('Your tech');
  });

  test('clean-visit finding copy matches service line', () => {
    expect(buildNoActivityFinding('pest').detail).toMatch(/pest activity/);
    expect(buildNoActivityFinding('lawn').detail).toMatch(/Turf areas/);
    expect(buildNoActivityFinding('lawn').detail).not.toMatch(/pest activity/);
    expect(buildNoActivityFinding('tree_shrub').detail).toMatch(/tree and shrub/i);
    expect(buildNoActivityFinding('palm').detail).toMatch(/palms/i);
  });

  test('v1 data auto-inserts a positive clean finding and pressure floor for clean visits', async () => {
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
      id: 'service-clean',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
      service_date: '2026-05-16',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Perimeter']),
      structured_notes: '{}',
      service_data: '{}',
      pressure_index: 0,
    }, 'token-clean', knex);

    expect(data.pressureIndex).toBe(0.3);
    expect(data.metrics.find((metric) => metric.key === 'pressure_index')).toMatchObject({ value: 0.3 });
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]).toMatchObject({
      category: 'no_activity',
      severity: 'info',
      title: 'No activity observed this visit',
    });
  });

  test('v1 data keeps synthetic clean findings out of finding metrics', async () => {
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
      id: 'service-clean-termite',
      customer_id: 'customer-1',
      service_line: 'termite',
      service_type: 'Termite Service',
      service_date: '2026-05-16',
      status: 'completed',
      first_name: 'Van',
      last_name: 'Lee',
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-clean-termite', knex);

    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]).toMatchObject({ category: 'no_activity' });
    expect(data.metrics.find((metric) => metric.key === 'findings')).toMatchObject({ value: 0 });
  });

  test('v1 data does not label recommendations-only reports as no activity', async () => {
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
      id: 'service-recommendation-only',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
      service_date: '2026-05-16',
      status: 'completed',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Perimeter']),
      structured_notes: JSON.stringify({
        recommendations: ['Seal the gap under the front threshold.'],
      }),
      service_data: '{}',
    }, 'token-recommendation-only', knex);

    expect(data.findings).toHaveLength(0);
    expect(data.recommendations).toEqual(['Seal the gap under the front threshold.']);
  });

  test('elapsed time parser matches completion panel duration strings', () => {
    expect(minutesFromElapsed('10:05')).toBe(10);
    expect(minutesFromElapsed('10:35')).toBe(11);
    expect(minutesFromElapsed('1:02:30')).toBe(63);
    expect(minutesFromElapsed('25')).toBe(25);
  });

  test('on-site minutes ignore default zero elapsed and fall back to timestamps', () => {
    expect(computeOnSiteMin({
      timeOnSite: '0:00',
      started_at: '2026-05-18T14:00:00.000Z',
      ended_at: '2026-05-18T14:42:00.000Z',
    })).toBe(42);
    expect(computeOnSiteMin({ timeOnSite: '10:05' })).toBe(10);
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

  test('product application area narrows fallback treatment zones', async () => {
    const fixtures = {
      service_products: [{
        id: 'product-1',
        product_name: 'Demand CS',
        product_category: 'insecticide',
        application_method: 'perimeter_spray',
        application_area: 'Garage',
      }],
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
      id: 'service-areas',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-15',
      started_at: '2026-05-15T13:00:00.000Z',
      ended_at: '2026-05-15T13:42:00.000Z',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Perimeter', 'Garage']),
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-areas', knex);

    expect(data.zones.map((zone) => zone.label)).toEqual(['Perimeter', 'Garage']);
    expect(data.applications[0].zone_ids).toEqual(['default-zone-2']);
  });

  test('v1 data exposes coverage locations and workflow events for the public report', async () => {
    const fixtures = {
      service_products: [{
        id: 'product-1',
        service_record_id: 'service-coverage',
        product_name: 'Demand CS',
        product_category: 'insecticide',
        application_method: 'perimeter_spray',
        zone_ids: ['zone-a'],
      }],
      property_geometries: [],
      property_zones: [
        {
          id: 'zone-a',
          customer_id: 'customer-1',
          is_active: true,
          letter: 'A',
          label: 'Exterior perimeter',
          category: 'perimeter',
          geometry: { x: 60, y: 42, w: 500, h: 44 },
          geometry_image: { x: 0.12, y: 0.18, w: 0.76, h: 0.1 },
          service_lines: ['pest'],
        },
        {
          id: 'zone-b',
          customer_id: 'customer-1',
          is_active: true,
          letter: 'B',
          label: 'Garage',
          category: 'interior',
          geometry: { x: 420, y: 124, w: 70, h: 80 },
          geometry_image: { x: 0.64, y: 0.38, w: 0.12, h: 0.18 },
          service_lines: ['pest'],
        },
      ],
      service_findings: [
        {
          id: 'finding-1',
          service_record_id: 'service-coverage',
          zone_id: 'zone-a',
          category: 'activity',
          severity: 'medium',
          title: 'Ant activity noted',
          detail: 'Activity was noted near the rear foundation.',
        },
        {
          id: 'finding-clean',
          service_record_id: 'service-coverage',
          zone_id: 'zone-b',
          category: 'no_activity',
          severity: 'low',
          title: 'No activity observed',
          detail: 'No entry points found in the garage.',
        },
      ],
      service_photos: [],
      scheduled_services: [{
        id: 'scheduled-coverage',
        en_route_at: '2026-05-15T13:58:00.000Z',
      }],
    };
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value));
          }
          return query;
        },
        orderBy: () => query,
        first: () => Promise.resolve(rows[0] || null),
        catch: () => Promise.resolve(rows),
        then: (resolve) => Promise.resolve(rows).then(resolve),
      };
      return query;
    };

    const data = await buildReportV1Data({
      id: 'service-coverage',
      scheduled_service_id: 'scheduled-coverage',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-15',
      started_at: '2026-05-15T14:05:00.000Z',
      ended_at: '2026-05-15T14:46:00.000Z',
      report_generated_at: '2026-05-15T14:52:00.000Z',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Exterior perimeter', 'Garage']),
      structured_notes: JSON.stringify({
        skippedAreas: [{ name: 'Crawlspace', reason: 'Access blocked' }],
      }),
      service_data: '{}',
    }, 'token-coverage', knex);

    expect(data.coverageServiceType).toBe('pest_control');
    expect(data.serviceLocations.find((location) => location.name === 'Exterior perimeter')).toMatchObject({
      status: 'serviced',
      geometry: { type: 'LineString' },
      imageGeometry: { type: 'LineString' },
    });
    expect(data.serviceLocations.find((location) => location.name === 'Garage')).toMatchObject({
      status: 'inspected',
      imageGeometry: { type: 'Polygon' },
    });
    expect(data.serviceLocations.find((location) => location.status === 'activity_found')).toMatchObject({
      name: 'Exterior perimeter',
      customerVisibleNote: 'Activity was noted near the rear foundation.',
      imageGeometry: { type: 'Point' },
    });
    expect(data.serviceLocations.filter((location) => (
      location.status === 'activity_found' || location.status === 'entry_point_found'
    ))).toHaveLength(1);
    expect(data.serviceLocations.find((location) => location.name === 'Crawlspace')).toMatchObject({
      status: 'skipped',
      skippedReason: 'Access blocked',
    });
    expect(data.workflowEvents.map((event) => event.type)).toEqual([
      'technician_en_route',
      'arrived_on_site',
      'service_completed',
      'report_published',
    ]);
    expect(data.visitTimeline.events.map((event) => event.type)).toEqual([
      'technician_en_route',
      'technician_on_site',
      'service_completed',
    ]);
    expect(data.visitTimeline.events.find((event) => event.type === 'service_completed')).toMatchObject({
      source: 'service_report',
      label: 'Service completed',
    });
  });

  test('workflow wall-clock timestamps are interpreted as Eastern time', async () => {
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
      id: 'service-workflow-naive',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-15',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Perimeter']),
      structured_notes: JSON.stringify({
        workflowEvents: [
          { type: 'arrived_on_site', timestamp: '2026-05-15T14:05' },
          { type: 'service_completed', timestamp: '2026-05-15T14:46:30' },
        ],
      }),
      service_data: '{}',
    }, 'token-workflow-naive', knex);

    expect(data.workflowEvents.map((event) => event.timestamp)).toEqual([
      '2026-05-15T18:05:00.000Z',
      '2026-05-15T18:46:30.000Z',
    ]);
  });

  test('workflow preserves absolute DB event Dates', () => {
    const events = buildWorkflowEvents({
      service: {
        en_route_at: new Date('2026-05-15T13:58:00.000Z'),
        started_at: new Date('2026-05-15T14:05:00.000Z'),
        ended_at: new Date('2026-05-15T14:46:00.000Z'),
        report_generated_at: new Date('2026-05-15T18:52:00.000Z'),
      },
      serviceLine: 'pest',
    });

    expect(events.map((event) => [event.type, event.timestamp])).toEqual([
      ['technician_en_route', '2026-05-15T13:58:00.000Z'],
      ['arrived_on_site', '2026-05-15T14:05:00.000Z'],
      ['service_completed', '2026-05-15T14:46:00.000Z'],
      ['report_published', '2026-05-15T18:52:00.000Z'],
    ]);

    const scheduledFallbackEvents = buildWorkflowEvents({
      service: {
        scheduled_en_route_at: new Date('2026-05-15T13:58:00.000Z'),
        scheduled_actual_start_time: new Date('2026-05-15T14:05:00.000Z'),
        scheduled_actual_end_time: new Date('2026-05-15T14:46:00.000Z'),
      },
      serviceLine: 'pest',
    });

    expect(scheduledFallbackEvents.map((event) => [event.type, event.timestamp])).toEqual([
      ['technician_en_route', '2026-05-15T13:58:00.000Z'],
      ['arrived_on_site', '2026-05-15T14:05:00.000Z'],
      ['service_completed', '2026-05-15T14:46:00.000Z'],
    ]);
  });

  test('visit timeline collapses same-time on-site and completion events', () => {
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        service_line: 'pest',
        en_route_at: '2026-05-17T16:44:00.000Z',
        arrived_at: '2026-05-17T18:35:00.000Z',
        completed_at: '2026-05-17T18:35:00.000Z',
        report_generated_at: '2026-05-17T18:35:00.000Z',
      },
      serviceLine: 'pest',
      customerInteraction: 'tech_home_spoke_with_them',
    });

    expect(timeline.events.map((event) => [event.type, event.displayTime, event.source])).toEqual([
      ['technician_en_route', '12:44 PM', 'bouncie'],
      ['service_completed', '2:35 PM', 'service_report'],
    ]);
    expect(timeline.events.find((event) => event.type === 'service_completed').customerDescription)
      .toBe('Your technician completed the pest control service and finalized the report.');
    expect(timeline.durationMinutes).toBeNull();
    expect(timeline.timingNote).toBe('Exact on-site duration was not available for this visit.');
    expect(timeline.config).toMatchObject({
      enabled: true,
      showOnCustomerReports: true,
      showTechnicianEnRoute: true,
      showTechnicianOnSite: true,
      showServiceCompleted: true,
      serviceCompletedRequiredWhenReportCompleted: true,
      showExactTimes: true,
    });
    expect(timeline.details).toEqual([
      expect.objectContaining({
        type: 'customer_contact',
        text: 'The technician spoke with someone at the home.',
        showAsTimelineEvent: false,
      }),
    ]);
  });

  test('visit timeline adds Service completed for completed reports even when Bouncie has no completion event', () => {
    const timeline = buildVisitTimeline({
      service: {
        status: 'completed',
        service_line: 'lawn',
        arrived_at: '2026-05-17T18:35:00.000Z',
        completed_at: '2026-05-17T19:05:00.000Z',
      },
      serviceLine: 'lawn',
      workflowEvents: [
        { type: 'technician_en_route', timestamp: '2026-05-17T16:44:00.000Z' },
        { type: 'arrived_on_site', timestamp: '2026-05-17T18:35:00.000Z' },
      ],
    });

    expect(timeline.events.map((event) => event.type)).toEqual([
      'technician_en_route',
      'technician_on_site',
      'service_completed',
    ]);
    expect(timeline.events.find((event) => event.type === 'service_completed')).toMatchObject({
      occurredAt: '2026-05-17T19:05:00.000Z',
      source: 'service_report',
      customerDescription: 'Your technician completed the lawn service and finalized the report.',
    });
  });

  test('v1 data exposes public report asset endpoints', async () => {
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

    expect(data.pdfUrl).toBe('/api/reports/token-1');
    expect(data.mapSvgUrl).toBe('/api/reports/token-1/map.svg');
    expect(data.serviceData).toBeUndefined();
    expect(data.zones.map((zone) => zone.label)).toEqual(['Perimeter']);
  });

  test('v1 data exposes customer-safe service timeline timestamps from finalized report data', async () => {
    const fixtures = {
      service_products: [],
      property_geometries: [],
      property_zones: [],
      service_findings: [],
      service_photos: [],
      scheduled_services: [{
        id: 'scheduled-timing',
        arrived_at: '2026-05-19T13:40:00.000Z',
        actual_start_time: '2026-05-19T13:41:00.000Z',
        check_in_time: '2026-05-19T13:42:00.000Z',
        completed_at: '2026-05-19T14:29:00.000Z',
        actual_end_time: '2026-05-19T14:30:00.000Z',
        check_out_time: '2026-05-19T14:31:00.000Z',
        arrival_source: 'bouncie_auto',
        arrival_metadata: { distanceMeters: 83 },
      }],
    };
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value));
          }
          return query;
        },
        orderBy: () => query,
        first: () => Promise.resolve(rows[0] || null),
        catch: () => Promise.resolve(rows),
        then: (resolve) => Promise.resolve(rows).then(resolve),
      };
      return query;
    };

    const data = await buildReportV1Data({
      id: 'service-timing',
      scheduled_service_id: 'scheduled-timing',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-19',
      arrived_at: '2026-05-19T13:42:00.000Z',
      actual_start_time: '2026-05-19T13:43:00.000Z',
      check_in_time: '2026-05-19T13:44:00.000Z',
      completed_at: '2026-05-19T14:28:00.000Z',
      actual_end_time: '2026-05-19T14:29:00.000Z',
      check_out_time: '2026-05-19T14:30:00.000Z',
      arrival_source: 'bouncie_auto',
      arrival_metadata: { distanceMeters: 83 },
      first_name: 'Van',
      last_name: 'Lee',
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-timing', knex);

    expect(data.visitTiming).toMatchObject({
      arrivedAt: '2026-05-19T13:42:00.000Z',
      exitedAt: '2026-05-19T14:28:00.000Z',
      onSiteMinutes: 46,
    });
    expect(data.serviceRecord).toMatchObject({
      arrived_at: '2026-05-19T13:42:00.000Z',
      actual_start_time: '2026-05-19T13:43:00.000Z',
      check_in_time: '2026-05-19T13:44:00.000Z',
      completed_at: '2026-05-19T14:28:00.000Z',
    });
    expect(data.scheduledService).toMatchObject({
      arrived_at: '2026-05-19T13:40:00.000Z',
      completed_at: '2026-05-19T14:29:00.000Z',
    });
    expect(data.visitTimeline.events.find((event) => event.type === 'technician_on_site')).toMatchObject({
      source: 'bouncie',
    });
    const serialized = JSON.stringify({
      ...data,
      visitTimeline: undefined,
    });
    expect(serialized).not.toMatch(/bouncie|gps|geofence|auto-arrival|arrival_source|distanceMeters/i);
  });

  test('v1 data falls back to scheduled service arrival when service record arrival is missing', async () => {
    const fixtures = {
      service_products: [],
      property_geometries: [],
      property_zones: [],
      service_findings: [],
      service_photos: [],
      scheduled_services: [{
        id: 'scheduled-fallback',
        arrived_at: '2026-05-19T13:42:00.000Z',
        completed_at: '2026-05-19T14:28:00.000Z',
      }],
    };
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value));
          }
          return query;
        },
        orderBy: () => query,
        first: () => Promise.resolve(rows[0] || null),
        catch: () => Promise.resolve(rows),
        then: (resolve) => Promise.resolve(rows).then(resolve),
      };
      return query;
    };

    const data = await buildReportV1Data({
      id: 'service-fallback',
      scheduled_service_id: 'scheduled-fallback',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-19',
      first_name: 'Van',
      last_name: 'Lee',
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-fallback', knex);

    expect(data.visitTiming).toMatchObject({
      arrivedAt: '2026-05-19T13:42:00.000Z',
      exitedAt: '2026-05-19T14:28:00.000Z',
      onSiteMinutes: 46,
    });
    expect(data.serviceRecord.arrived_at).toBeNull();
    expect(data.scheduledService.arrived_at).toBe('2026-05-19T13:42:00.000Z');
  });

  test('v1 data prefers finalized legacy service record timing before scheduled service timing', async () => {
    const fixtures = {
      service_products: [],
      property_geometries: [],
      property_zones: [],
      service_findings: [],
      service_photos: [],
      scheduled_services: [{
        id: 'scheduled-legacy-fallback',
        arrived_at: '2026-05-19T13:42:00.000Z',
        completed_at: '2026-05-19T14:28:00.000Z',
      }],
    };
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value));
          }
          return query;
        },
        orderBy: () => query,
        first: () => Promise.resolve(rows[0] || null),
        catch: () => Promise.resolve(rows),
        then: (resolve) => Promise.resolve(rows).then(resolve),
      };
      return query;
    };

    const data = await buildReportV1Data({
      id: 'service-legacy-timing',
      scheduled_service_id: 'scheduled-legacy-fallback',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-19',
      started_at: '2026-05-19T13:50:00.000Z',
      ended_at: '2026-05-19T14:20:00.000Z',
      first_name: 'Van',
      last_name: 'Lee',
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-legacy-timing', knex);

    expect(data.visitTiming).toMatchObject({
      arrivedAt: '2026-05-19T13:50:00.000Z',
      exitedAt: '2026-05-19T14:20:00.000Z',
      onSiteMinutes: 30,
    });
    expect(data.scheduledService).toMatchObject({
      arrived_at: '2026-05-19T13:42:00.000Z',
      completed_at: '2026-05-19T14:28:00.000Z',
    });
  });

  test('v1 data uses structured workflow events as public timing fallback', async () => {
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
      id: 'service-workflow-timing',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-19',
      first_name: 'Van',
      last_name: 'Lee',
      structured_notes: JSON.stringify({
        workflowEvents: [
          {
            type: 'arrived_on_site',
            timestamp: '2026-05-19T13:42:00.000Z',
          },
          {
            type: 'service_completed',
            timestamp: '2026-05-19T14:28:00.000Z',
          },
        ],
      }),
      service_data: '{}',
    }, 'token-workflow-timing', knex);

    expect(data.visitTiming).toMatchObject({
      arrivedAt: '2026-05-19T13:42:00.000Z',
      exitedAt: '2026-05-19T14:28:00.000Z',
      onSiteMinutes: 46,
    });
    expect(data.workflowEvents.map((event) => event.type)).toEqual([
      'arrived_on_site',
      'service_completed',
    ]);
  });

  test('v1 data carries completion panel fields into the public report payload', async () => {
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
      id: 'service-complete',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Residential Pest Control',
      service_date: '2026-05-15',
      started_at: '2026-05-15T13:00:00.000Z',
      ended_at: '2026-05-15T13:42:00.000Z',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Perimeter', 'Customer spoke with tech']),
      customer_interaction: null,
      soil_temp: 78,
      thatch_measurement: 0.5,
      soil_ph: 6.8,
      soil_moisture: 24,
      structured_notes: JSON.stringify({
        customerRecap: 'Treated the front entry and garage, then reviewed the concern with the customer.',
        timeOnSite: '42:00',
        customerInteraction: 'spoke',
        areasTreated: ['Perimeter', 'Garage'],
        protocolActionsCompleted: ['Treated front entry trail'],
        observations: ['Light ant activity at front entry'],
        recommendations: ['Seal the small gap under the front door'],
      }),
      service_data: '{}',
    }, 'token-complete', knex);

    expect(data.summary).toBe('Treated the front entry and garage, then reviewed the concern with the customer.');
    expect(data.serviceDisplayName).toBe('Residential Pest Control');
    expect(data.customerInteraction).toBe('spoke');
    expect(data.visitTiming).toMatchObject({
      arrivedAt: '2026-05-15T13:00:00.000Z',
      exitedAt: '2026-05-15T13:42:00.000Z',
      onSiteMinutes: 42,
    });
    expect(data.serviceAreas).toEqual(['Perimeter', 'Garage']);
    expect(data.measurements).toMatchObject({
      soilTemp: 78,
      thatch: 0.5,
      soilPh: 6.8,
      moisture: 24,
    });
    expect(data.protocol.actions).toEqual(['Treated front entry trail']);
    expect(data.protocol.observations).toEqual(['Light ant activity at front entry']);
    expect(data.recommendations).toContain('Seal the small gap under the front door');
    expect(data.metrics.find((metric) => metric.key === 'on_site_min')).toMatchObject({ value: 42 });
  });

  test('v1 data filters saved property zones to the report service line', async () => {
    const fixtures = {
      service_products: [],
      property_geometries: [],
      property_zones: [
        {
          id: 'zone-lawn',
          customer_id: 'customer-1',
          is_active: true,
          letter: 'A',
          label: 'Front lawn',
          category: 'lawn',
          geometry: { x: 60, y: 40, w: 160, h: 80 },
          service_lines: ['lawn'],
        },
        {
          id: 'zone-pest',
          customer_id: 'customer-1',
          is_active: true,
          letter: 'B',
          label: 'Kitchen baseboards',
          category: 'interior',
          geometry: { x: 260, y: 140, w: 90, h: 60 },
          service_lines: ['pest'],
        },
      ],
      service_findings: [],
      service_photos: [],
      lawn_assessments: [],
    };
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value));
          }
          return query;
        },
        orderBy(column, direction = 'asc') {
          rows.sort((a, b) => {
            const av = a[column] ?? '';
            const bv = b[column] ?? '';
            const result = String(av).localeCompare(String(bv));
            return String(direction).toLowerCase() === 'desc' ? -result : result;
          });
          return query;
        },
        first: () => Promise.resolve(rows[0] || null),
        catch: () => Promise.resolve(rows),
        then: (resolve) => Promise.resolve(rows).then(resolve),
      };
      return query;
    };

    const data = await buildReportV1Data({
      id: 'service-lawn-zones',
      customer_id: 'customer-1',
      service_line: 'lawn',
      service_type: 'Weed Control',
      service_date: '2026-05-16',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Front lawn']),
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-lawn-zones', knex);

    expect(data.zones.map((zone) => zone.label)).toEqual(['Front lawn']);
  });

  test('v1 data includes linked lawn assessment and exposes lawn health metrics', async () => {
    const fixtures = {
      service_products: [],
      property_geometries: [],
      property_zones: [],
      service_findings: [],
      service_photos: [],
      lawn_assessments: [
        {
          id: 'assessment-1',
          customer_id: 'customer-1',
          service_record_id: 'service-old',
          service_id: 'scheduled-old',
          confirmed_by_tech: true,
          service_date: '2026-03-04',
          turf_density: 60,
          weed_suppression: 70,
          color_health: 65,
          fungus_control: 75,
          thatch_level: 60,
          overall_score: 66,
          observations: 'Baseline turf assessment recorded.',
        },
        {
          id: 'assessment-2',
          customer_id: 'customer-1',
          service_record_id: 'service-lawn',
          service_id: 'scheduled-lawn',
          confirmed_by_tech: true,
          service_date: '2026-05-16',
          turf_density: 80,
          weed_suppression: 90,
          color_health: 82,
          fungus_control: 88,
          thatch_level: 70,
          overall_score: 83,
          observations: 'Turf density improved and weed pressure was low.',
          recommendations: JSON.stringify({ customerTip: 'Water deeply in the morning as needed.' }),
        },
      ],
      lawn_assessment_photos: [
        {
          id: 'photo-1',
          assessment_id: 'assessment-2',
          customer_visible: true,
          is_best_photo: true,
          quality_score: 92,
          photo_order: 0,
          s3_key: 'pending/assessment-2/photo.jpg',
          photo_type: 'front_yard',
        },
      ],
      customer_turf_profiles: [
        {
          id: 'profile-1',
          customer_id: 'customer-1',
          active: true,
          grass_type: 'st_augustine',
          lawn_sqft: 6200,
          irrigation_type: 'in_ground',
        },
      ],
      property_health_snapshots: [
        {
          id: 'snapshot-draft',
          customer_id: 'customer-1',
          assessment_id: 'assessment-2',
          domain: 'lawn',
          customer_visible: true,
          approved_at: null,
          headline: 'Draft snapshot',
          summary_customer: 'Draft copy should not appear.',
          findings: JSON.stringify([{ customer_copy: 'Draft finding should not appear.', internal_copy: 'internal' }]),
          created_at: '2026-05-16T10:00:00.000Z',
        },
        {
          id: 'snapshot-approved',
          customer_id: 'customer-1',
          assessment_id: 'assessment-2',
          domain: 'lawn',
          customer_visible: true,
          approved_at: '2026-05-16T11:00:00.000Z',
          headline: 'Moderate issue being treated',
          summary_customer: 'Approved snapshot: moderate weed pressure is being monitored.',
          findings: JSON.stringify([{
            key: 'weed_pressure',
            label: 'Weed pressure',
            severity: 2,
            confidence: 0.84,
            customer_copy: 'We saw moderate weed pressure in the front lawn.',
            internal_copy: 'Internal scoring detail',
            evidence_refs: ['assessment:2'],
          }]),
          treatment_context: JSON.stringify({
            completed_today: true,
            service_type: 'Lawn Care',
            products_applied_summary: 'the scheduled lawn application',
          }),
          expected_window: JSON.stringify({ min_days: 14, max_days: 21 }),
          next_watch_items: JSON.stringify(['Compare the front lawn on the next service.']),
          created_at: '2026-05-16T11:00:00.000Z',
        },
      ],
      property_recommendation_cards: [
        {
          id: 'card-draft',
          snapshot_id: 'snapshot-approved',
          customer_id: 'customer-1',
          domain: 'lawn',
          customer_visible: true,
          status: 'draft',
          type: 'tier_upgrade',
          priority: 'high',
          customer_copy: 'Draft recommendation should not appear.',
        },
        {
          id: 'card-approved',
          snapshot_id: 'snapshot-approved',
          customer_id: 'customer-1',
          domain: 'lawn',
          customer_visible: true,
          status: 'approved',
          approved_at: '2026-05-16T11:05:00.000Z',
          type: 'follow_up',
          title: 'Keep watching this area',
          priority: 'medium',
          confidence: 0.77,
          internal_reason: 'Internal reason',
          trigger_signals: JSON.stringify([{ key: 'callback_risk' }]),
          customer_copy: 'We will keep watching this area on your next visit.',
          recommended_action: JSON.stringify({ action_type: 'request_follow_up', cta_label: 'Request follow-up' }),
          created_at: '2026-05-16T11:05:00.000Z',
        },
      ],
    };
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value));
          }
          return query;
        },
        whereNotNull(column) {
          rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
          return query;
        },
        orderBy(column, direction = 'asc') {
          rows.sort((a, b) => {
            const av = a[column] ?? '';
            const bv = b[column] ?? '';
            const result = String(av).localeCompare(String(bv));
            return String(direction).toLowerCase() === 'desc' ? -result : result;
          });
          return query;
        },
        limit(count) {
          rows = rows.slice(0, count);
          return query;
        },
        first() {
          return Promise.resolve(rows[0] || null);
        },
        catch() {
          return Promise.resolve(rows);
        },
        then(resolve) {
          return Promise.resolve(rows).then(resolve);
        },
      };
      return query;
    };

    const data = await buildReportV1Data({
      id: 'service-lawn',
      customer_id: 'customer-1',
      scheduled_service_id: 'scheduled-lawn',
      service_line: 'lawn',
      service_type: 'Lawn Care',
      service_date: '2026-05-16',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Front lawn']),
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-lawn', knex);

    expect(data.serviceLine).toBe('lawn');
    expect(data.lawnAssessment.scores.overallScore).toBe(83);
    expect(data.lawnAssessment.initialScores.overallScore).toBe(66);
    expect(data.lawnAssessment.customerSummary).toBe('Approved snapshot: moderate weed pressure is being monitored.');
    expect(data.lawnAssessment.trendSummary).toBe('Lawn health is up 17 points since your first assessment.');
    expect(data.lawnAssessment.snapshot).toMatchObject({
      id: 'snapshot-approved',
      headline: 'Moderate issue being treated',
      summary: 'Approved snapshot: moderate weed pressure is being monitored.',
      findings: [{ key: 'weed_pressure', customerCopy: 'We saw moderate weed pressure in the front lawn.' }],
      expectedWindow: { minDays: 14, maxDays: 21 },
    });
    expect(data.lawnAssessment.snapshot.findings[0]).not.toHaveProperty('internal_copy');
    expect(data.lawnAssessment.snapshot.findings[0]).not.toHaveProperty('confidence');
    expect(data.lawnAssessment.snapshot.findings[0]).not.toHaveProperty('evidence_refs');
    expect(data.lawnAssessment.recommendationCards).toEqual([
      expect.objectContaining({
        id: 'card-approved',
        customerCopy: 'We will keep watching this area on your next visit.',
      }),
    ]);
    expect(data.lawnAssessment.recommendationCards[0]).not.toHaveProperty('internal_reason');
    expect(data.lawnAssessment.recommendationCards[0]).not.toHaveProperty('trigger_signals');
    expect(data.lawnAssessment.recommendationCards[0]).not.toHaveProperty('confidence');
    expect(data.lawnAssessment.trend.map((point) => point.overallScore)).toEqual([66, 83]);
    expect(data.lawnAssessment.turfProfile).toMatchObject({ grassType: 'st_augustine', lawnSqft: 6200 });
    expect(data.findings).toEqual([]);
    expect(data.metrics.find((metric) => metric.key === 'lawn_health')).toMatchObject({
      label: 'Lawn health',
      value: 83,
      unit: '%',
    });
    expect(data.metrics.some((metric) => metric.label === 'Pressure index')).toBe(false);
  });

  test('v1 data does not add clean lawn findings when an assessment has scores only', async () => {
    const fixtures = {
      service_products: [],
      property_geometries: [],
      property_zones: [],
      service_findings: [],
      service_photos: [],
      lawn_assessments: [
        {
          id: 'assessment-low',
          customer_id: 'customer-1',
          service_record_id: 'service-lawn-low',
          confirmed_by_tech: true,
          service_date: '2026-05-16',
          overall_score: 35,
          turf_density: 35,
          weed_suppression: 20,
          color_health: 40,
          fungus_control: 30,
          thatch_level: 50,
          observations: '',
          recommendations: null,
        },
      ],
      lawn_assessment_photos: [],
      customer_turf_profiles: [],
    };
    const knex = (table) => {
      let rows = [...(fixtures[table] || [])];
      const query = {
        where(criteria) {
          if (criteria && typeof criteria === 'object') {
            rows = rows.filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value));
          }
          return query;
        },
        orderBy: () => query,
        limit(count) {
          rows = rows.slice(0, count);
          return query;
        },
        first: () => Promise.resolve(rows[0] || null),
        catch: () => Promise.resolve(rows),
        then: (resolve) => Promise.resolve(rows).then(resolve),
      };
      return query;
    };

    const data = await buildReportV1Data({
      id: 'service-lawn-low',
      customer_id: 'customer-1',
      service_line: 'lawn',
      service_type: 'Lawn Care',
      service_date: '2026-05-16',
      status: 'completed',
      first_name: 'Van',
      last_name: 'Lee',
      structured_notes: '{}',
      service_data: '{}',
    }, 'token-lawn-low', knex);

    expect(data.lawnAssessment.scores.overallScore).toBe(35);
    expect(data.findings).toEqual([]);
  });

  test('photo hash chain validates deterministic metadata and detects tampering', () => {
    const first = {
      id: 'photo-1',
      service_record_id: 'service-1',
      photo_type: 'progress',
      storage_key: 'service-photos/service-1/one.jpg',
      caption: 'Front entry',
      captured_at: '2026-05-16T12:00:00.000Z',
      image_sha256: 'a'.repeat(64),
      sort_order: 0,
    };
    const firstHash = hashPhotoChainPayload(first, null);
    const second = {
      id: 'photo-2',
      service_record_id: 'service-1',
      photo_type: 'progress',
      storage_key: 'service-photos/service-1/two.jpg',
      caption: 'Rear perimeter',
      captured_at: '2026-05-16T12:01:00.000Z',
      image_sha256: 'b'.repeat(64),
      sort_order: 1,
      prev_hash_sha256: firstHash,
    };
    const secondHash = hashPhotoChainPayload(second, firstHash);
    const validRows = [
      { ...first, prev_hash_sha256: null, hash_sha256: firstHash },
      { ...second, hash_sha256: secondHash },
    ];

    expect(validatePhotoChainRows(validRows)).toEqual({
      valid: true,
      photo_count: 2,
      broken_at: null,
    });

    const tampered = validRows.map((row) => (
      row.id === 'photo-1' ? { ...row, caption: 'Changed caption' } : row
    ));
    expect(validatePhotoChainRows(tampered)).toMatchObject({
      valid: false,
      broken_at: 'photo-1',
      reason: 'hash_mismatch',
    });
  });

  test('v1 PDF renderer has no compact fallback and viewer URL points to the report page', () => {
    expect(serviceReportViewerUrl('token-1')).toBe('http://localhost:5173/report/token-1?mode=pdf');
    expect(require('../services/service-report/pdf').renderFallbackPdf).toBeUndefined();
  });

  test('Cloudflare PDF renderer sends the Browser Run pdfOptions payload', async () => {
    const originalFetch = global.fetch;
    const originalAccountId = process.env.CF_ACCOUNT_ID;
    const originalToken = process.env.CF_BROWSER_RENDERING_TOKEN;
    const calls = [];

    process.env.CF_ACCOUNT_ID = 'account-1';
    process.env.CF_BROWSER_RENDERING_TOKEN = 'token-1';
    global.fetch = jest.fn(async (endpoint, options) => {
      const body = Buffer.from('%PDF-1.4\n');
      calls.push({ endpoint, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    });

    try {
      const pdf = await renderReportPdfWithCloudflare('https://example.test/report/token-1?mode=pdf', {
        serviceRecordId: 'service-1',
      });

      expect(Buffer.isBuffer(pdf)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].endpoint).toBe(
        'https://api.cloudflare.com/client/v4/accounts/account-1/browser-rendering/pdf',
      );
      expect(calls[0].options.headers.Authorization).toBe('Bearer token-1');
      expect(calls[0].options.signal).toBeDefined();
      expect(calls[0].options.signal.aborted).toBe(false);
      expect(calls[0].body).toMatchObject({
        url: 'https://example.test/report/token-1?mode=pdf',
        viewport: { width: 816, height: 1056 },
        gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
        waitForSelector: { selector: '.service-report-v1', visible: true, timeout: 10000 },
        emulateMediaType: 'print',
        pdfOptions: {
          format: 'letter',
          printBackground: true,
          displayHeaderFooter: true,
        },
      });
      expect(calls[0].body.pdf).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
      restoreEnv('CF_ACCOUNT_ID', originalAccountId);
      restoreEnv('CF_BROWSER_RENDERING_TOKEN', originalToken);
    }
  });

  test('PDF renderer selects Cloudflare automatically when credentials are present', () => {
    const originalRenderer = process.env.PDF_RENDERER;
    const originalAccountId = process.env.CF_ACCOUNT_ID;
    const originalToken = process.env.CF_BROWSER_RENDERING_TOKEN;

    try {
      delete process.env.PDF_RENDERER;
      delete process.env.CF_ACCOUNT_ID;
      delete process.env.CF_BROWSER_RENDERING_TOKEN;
      expect(selectedPdfRenderer()).toBe('puppeteer');

      process.env.CF_ACCOUNT_ID = 'account-1';
      process.env.CF_BROWSER_RENDERING_TOKEN = 'token-1';
      expect(selectedPdfRenderer()).toBe('cloudflare_browser_rendering');

      process.env.PDF_RENDERER = 'puppeteer';
      expect(selectedPdfRenderer()).toBe('puppeteer');

      process.env.PDF_RENDERER = 'cloudflare';
      expect(selectedPdfRenderer()).toBe('cloudflare_browser_rendering');
    } finally {
      restoreEnv('PDF_RENDERER', originalRenderer);
      restoreEnv('CF_ACCOUNT_ID', originalAccountId);
      restoreEnv('CF_BROWSER_RENDERING_TOKEN', originalToken);
    }
  });

  test('Cloudflare PDF renderer timeout falls back to a bounded default', () => {
    const originalTimeout = process.env.CF_BROWSER_RENDERING_TIMEOUT_MS;
    try {
      delete process.env.CF_BROWSER_RENDERING_TIMEOUT_MS;
      expect(cfBrowserRenderingTimeoutMs()).toBe(45000);
      process.env.CF_BROWSER_RENDERING_TIMEOUT_MS = '12000';
      expect(cfBrowserRenderingTimeoutMs()).toBe(12000);
      process.env.CF_BROWSER_RENDERING_TIMEOUT_MS = '0';
      expect(cfBrowserRenderingTimeoutMs()).toBe(45000);
    } finally {
      restoreEnv('CF_BROWSER_RENDERING_TIMEOUT_MS', originalTimeout);
    }
  });

  test('Cloudflare PDF renderer rejects non-PDF 2xx responses', async () => {
    const originalFetch = global.fetch;
    const originalAccountId = process.env.CF_ACCOUNT_ID;
    const originalToken = process.env.CF_BROWSER_RENDERING_TOKEN;
    const body = Buffer.from('<html>Not a PDF</html>');

    process.env.CF_ACCOUNT_ID = 'account-1';
    process.env.CF_BROWSER_RENDERING_TOKEN = 'token-1';
    global.fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }));

    try {
      await expect(renderReportPdfWithCloudflare('https://example.test/report/token-1?mode=pdf', {
        serviceRecordId: 'service-1',
      })).rejects.toMatchObject({ code: 'invalid_pdf_response' });
    } finally {
      global.fetch = originalFetch;
      restoreEnv('CF_ACCOUNT_ID', originalAccountId);
      restoreEnv('CF_BROWSER_RENDERING_TOKEN', originalToken);
    }
  });

  test('PDF render telemetry redacts bearer report URLs', () => {
    const metadata = sanitizedPdfRenderMetadata({
      service_record_id: 'service-1',
      provider: 'cloudflare_browser_rendering',
      url: 'https://portal.wavespestcontrol.com/report/token-1?mode=pdf',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-2',
      report_url: 'https://portal.wavespestcontrol.com/report/token-3',
      viewerUrl: 'https://portal.wavespestcontrol.com/report/token-4',
      err: 'Navigation failed at https://portal.wavespestcontrol.com/report/token-5?mode=pdf',
      responseText: 'third-party body',
    });

    expect(metadata).toMatchObject({
      service_record_id: 'service-1',
      provider: 'cloudflare_browser_rendering',
      url: '[redacted]',
      reportUrl: '[redacted]',
      report_url: '[redacted]',
      viewerUrl: '[redacted]',
      err: 'Navigation failed at https://portal.wavespestcontrol.com/report/[redacted]',
      responseText: '[redacted]',
    });
    expect(safePdfRenderError({
      status: 500,
      message: 'Failed at https://portal.wavespestcontrol.com/report/token-6?mode=pdf',
    })).toBe('status=500 Failed at https://portal.wavespestcontrol.com/report/[redacted]');
  });

  test('v1 SMS delivery copy includes public report link and advisory re-entry', () => {
    const body = buildServiceReportV1Sms({
      customerFirstName: 'Van',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
      advisory: {
        exterior_reentry_min: 30,
        interior_reentry_min: 120,
      },
    });

    expect(body).toContain('Hi Van, your Waves service report is ready: https://portal.wavespestcontrol.com/report/token-1');
    expect(body).toContain('Re-entry: 30 min outside, 120 min inside.');
    expect(body).toContain('Reply STOP to opt out.');
    expect(body).not.toContain('serviceData');
  });

  test('v1.1 SMS delivery keeps the existing body unchanged when dynamic context exists', () => {
    const body = buildServiceReportV1Sms({
      customerFirstName: 'Ava',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
      advisory: {
        exterior_reentry_min: 30,
        interior_reentry_min: 120,
      },
      dynamicContext: {
        pressureTrend: {
          direction: 'down',
          customerSummary: 'Pest pressure is down 38% since your first WaveGuard service.',
        },
        reentry: {
          displayTimezone: 'America/New_York',
          targets: [
            { key: 'exterior', readyAt: '2026-05-16T14:12:00.000Z' },
            { key: 'interior', readyAt: '2026-05-16T15:42:00.000Z' },
          ],
        },
      },
    });

    expect(body).toBe(
      'Hi Ava, your Waves service report is ready: https://portal.wavespestcontrol.com/report/token-1\n'
      + 'Re-entry: 30 min outside, 120 min inside.\n'
      + 'Reply STOP to opt out.'
    );
  });

  test('v1 SMS delivery gates on template version and completed status', () => {
    expect(shouldSendServiceReportV1Delivery({
      report_template_version: 'service_report_v1',
      status: 'completed',
    })).toBe(true);
    expect(shouldSendServiceReportV1Delivery({
      report_template_version: 'service_report_v1',
      status: 'complete',
    })).toBe(true);
    expect(shouldSendServiceReportV1Delivery({
      report_template_version: null,
      status: 'completed',
    })).toBe(false);
    expect(shouldSendServiceReportV1Delivery({
      report_template_version: 'service_report_v1',
      status: 'incomplete',
    })).toBe(false);
    expect(shouldSendServiceReportV1Delivery({
      report_template_version: 'service_report_v1',
      status: 'voided',
    })).toBe(false);
  });

  test('v1 delivery context carries invoice link and report metadata', () => {
    const context = buildServiceReportV1DeliveryContext({
      record: {
        id: 'service-1',
        report_template_version: 'service_report_v1',
        status: 'completed',
        service_line: 'pest',
        advisory: JSON.stringify({
          exterior_reentry_min: 45,
          interior_reentry_min: 90,
        }),
      },
      service: {
        first_name: 'Van',
        service_type: 'Residential Pest Control',
      },
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
      smsReportUrl: 'https://portal.wavespestcontrol.com/l/report-abc12',
      payUrl: 'https://portal.wavespestcontrol.com/l/invoice-xyz89',
    });

    expect(context.enabled).toBe(true);
    expect(context.smsType).toBe(serviceReportV1SmsType({ hasInvoiceLink: true }));
    expect(context.body).toContain('https://portal.wavespestcontrol.com/l/report-abc12');
    expect(context.body).toContain('Re-entry: 45 min outside, 90 min inside.');
    expect(context.body).toContain('Invoice: https://portal.wavespestcontrol.com/l/invoice-xyz89');
    expect(context.metadata).toMatchObject({
      original_message_type: 'service_report_v1_with_invoice',
      service_record_id: 'service-1',
      report_template_version: 'service_report_v1',
      report_url: 'https://portal.wavespestcontrol.com/report/token-1',
      report_sms_url: 'https://portal.wavespestcontrol.com/l/report-abc12',
      service_line: 'pest',
    });
  });

  test('v1 email delivery copy includes advisory and report CTA', () => {
    const email = buildServiceReportV1Email({
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
      pdfAttached: true,
      data: {
        serviceLineDisplay: 'WaveGuard pest control',
        serviceType: 'Residential Pest Control',
        serviceDate: '2026-05-15',
        customerName: 'Van Lee',
        technicianName: 'Jose Alvarado',
        cityState: 'Lakewood Ranch, FL',
        applications: [{ id: 'app-1' }],
        findings: [{ title: 'Ghost ant trail at front entry threshold' }],
        metrics: [{ label: 'Pressure index', value: 1.7 }],
        advisory: {
          exterior_reentry_min: 30,
          interior_reentry_min: 120,
        },
      },
    });

    expect(email.subject).toContain('Your Waves service report — Residential Pest Control');
    expect(email.html).toContain('https://portal.wavespestcontrol.com/report/token-1');
    expect(email.html).toContain('Exterior re-entry');
    expect(email.html).toContain('30 min');
    expect(email.html).toContain('Ghost ant trail at front entry threshold');
    expect(email.text).toContain('The PDF service report is attached.');
  });

  test('v1 email delivery does not count synthetic clean findings', () => {
    const email = buildServiceReportV1Email({
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-clean',
      data: {
        serviceType: 'Residential Pest Control',
        customerName: 'Van Lee',
        applications: [],
        findings: [{
          category: 'no_activity',
          severity: 'info',
          title: 'No activity observed this visit',
        }],
        metrics: [{ label: 'Pressure index', value: 0.3 }],
        advisory: {},
      },
    });

    expect(email.text).toContain('Findings: 0 findings');
    expect(email.text).toContain('No action-required findings were documented during this visit.');
    expect(email.text).not.toContain('Top findings: No activity observed this visit');
    expect(email.html).not.toContain('Top findings');
  });

  test('v1 delivery queue enqueue is idempotent per service record and channel', async () => {
    const rows = [];
    const knex = (table) => {
      expect(table).toBe('service_report_deliveries');
      const query = {
        criteria: null,
        where(criteria) {
          query.criteria = criteria;
          return query;
        },
        first() {
          return Promise.resolve(rows.find((row) => Object.entries(query.criteria || {})
            .every(([key, value]) => row[key] === value)) || null);
        },
        insert(row) {
          return {
            returning: async () => {
              const inserted = { id: `delivery-${rows.length + 1}`, ...row };
              rows.push(inserted);
              return [inserted];
            },
          };
        },
      };
      return query;
    };

    const first = await enqueueServiceReportV1EmailDelivery({
      serviceRecordId: 'service-1',
      customerId: 'customer-1',
      token: 'token-1',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
      pdfUrl: 'https://portal.wavespestcontrol.com/api/reports/token-1',
    }, knex);
    const second = await enqueueServiceReportV1EmailDelivery({
      serviceRecordId: 'service-1',
      customerId: 'customer-1',
      token: 'token-1',
      reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
      pdfUrl: 'https://portal.wavespestcontrol.com/api/reports/token-1',
    }, knex);

    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    expect(second.delivery.id).toBe(first.delivery.id);
    expect(rows).toHaveLength(1);
  });

  test('v1 delivery queue retry schedule backs off deterministically', () => {
    const now = new Date('2026-05-16T12:00:00.000Z');
    expect(nextServiceReportDeliveryAttemptAt(now, 1).toISOString()).toBe('2026-05-16T12:05:00.000Z');
    expect(nextServiceReportDeliveryAttemptAt(now, 2).toISOString()).toBe('2026-05-16T12:15:00.000Z');
    expect(nextServiceReportDeliveryAttemptAt(now, 3).toISOString()).toBe('2026-05-16T13:00:00.000Z');
    expect(nextServiceReportDeliveryAttemptAt(now, 99).toISOString()).toBe('2026-05-17T12:00:00.000Z');
  });
});
