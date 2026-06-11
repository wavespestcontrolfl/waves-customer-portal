/**
 * Typed specialty report rendering — report-data integration of the
 * persisted typedReportSnapshot, driven by the golden fixtures in
 * docs/design/specialty-report-fixtures (the readability layer from the
 * product contract, PR 0).
 */

const fs = require('fs');
const path = require('path');
const { buildReportV1Data } = require('../services/service-report/report-data');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'docs', 'design', 'specialty-report-fixtures');
const BANNED_CUSTOMER_WORDS = [
  'clear', 'cleared', 'gone', 'eliminated', 'no infestation', 'guaranteed', 'resolved',
];

function loadFixtures() {
  return fs.readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')));
}

function stubKnex(fixtures = {}) {
  const knex = (table) => {
    const rows = fixtures[table] || [];
    const query = {
      where: () => query,
      orderBy: () => query,
      modify: () => query,
      limit: () => query,
      select: () => Promise.resolve(rows),
      first: () => Promise.resolve(rows[0] || null),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  return knex;
}

function serviceRowForSnapshot(snapshot, overrides = {}) {
  return {
    id: 'service-typed-1',
    customer_id: 'customer-1',
    service_line: 'pest',
    service_type: snapshot.serviceLabel || snapshot.typeLabel,
    service_date: '2026-06-11',
    first_name: 'Pat',
    last_name: 'Customer',
    areas_serviced: '[]',
    structured_notes: '{}',
    service_data: JSON.stringify({ typedReportSnapshot: snapshot }),
    pressure_index: null,
    ...overrides,
  };
}

describe('typed specialty report data (golden fixtures)', () => {
  const fixtures = loadFixtures();

  test('golden fixture set is present', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const fixture of fixtures) {
    const snapshot = fixture.typedReportSnapshot;
    const expected = fixture.expected || {};

    test(`${fixture.fixture}: renders snapshot, suppresses Pest Pressure`, async () => {
      const data = await buildReportV1Data(
        serviceRowForSnapshot(snapshot),
        'token-typed',
        stubKnex(),
        { pestPressureConfig: { enabled: true, showOnCustomerReport: true, enabledServiceLines: [] } }
      );

      // Pest Pressure never renders for typed reports — even with the
      // engine fully enabled for the 'pest' line.
      expect(data.pestPressure).toBeNull();
      expect(data.pressureIndex).toBeNull();
      expect(data.metrics.find((m) => m.key === 'pressure_index')).toBeUndefined();

      // The customer artifact renders from the persisted snapshot.
      expect(data.typedReport).toBeTruthy();
      expect(data.typedReport.todaysResult).toEqual(snapshot.todaysResult);
      expect(data.typedReport.reportTypeLabel).toBe(snapshot.reportTypeLabel);
      expect(data.typedReport.findings.length).toBe(snapshot.findings.length);

      // Banned words never appear in headline/body copy.
      const copy = JSON.stringify(data.typedReport.todaysResult).toLowerCase();
      for (const word of BANNED_CUSTOMER_WORDS) {
        expect(copy.includes(word)).toBe(false);
      }

      if (snapshot.activity) {
        expect(data.activity).toMatchObject({
          indicatorKey: snapshot.activity.indicatorKey,
          score: snapshot.activity.score,
        });
        // Gauge metric replaces pressure in the band.
        expect(data.metrics.find((m) => m.key === 'activity_score')).toMatchObject({
          label: snapshot.activity.label,
          value: snapshot.activity.score,
        });
        // First visit never claims a trend.
        if ((snapshot.visitSequence || 1) === 1) {
          expect(data.activity.trend).toBeNull();
        }
      } else {
        expect(data.activity).toBeNull();
        expect(data.metrics.find((m) => m.key === 'activity_score')).toBeUndefined();
      }

      if (expected.reportTitleContains) {
        expect(data.typedReport.reportTypeLabel).toContain(expected.reportTitleContains);
      }
      if (expected.trendClaimed === true) {
        expect(data.typedReport.isProgressVisit).toBe(true);
        expect(snapshot.activity.trendWord).toBeTruthy();
      }
      if (expected.zeroStateRendersPositively || expected.zeroScoreRendersPositively) {
        const zeroItem = data.typedReport.findings.find(
          (f) => /no active signs/i.test(String(f.customerValueLabel))
        );
        expect(zeroItem).toBeTruthy();
      }
    });
  }

  test('activity history hydrates from service_activity_scores and marks the current visit', async () => {
    const snapshot = fixtures.find((f) => f.fixture === 'cockroach_followup_improving').typedReportSnapshot;
    const data = await buildReportV1Data(
      serviceRowForSnapshot(snapshot),
      'token-history',
      stubKnex({
        service_activity_scores: [
          { service_record_id: 'service-typed-1', service_date: '2026-06-11', score: 1 },
          { service_record_id: 'service-prior', service_date: '2026-05-28', score: 3 },
        ],
      })
    );
    expect(data.activity.history).toHaveLength(2);
    expect(data.activity.history[data.activity.history.length - 1]).toMatchObject({
      serviceRecordId: 'service-typed-1',
      isCurrent: true,
      score: 1,
    });
    expect(data.activity.isBaseline).toBe(false);
    expect(data.activity.levelWord).toBe('Very low activity');
  });

  test('recurring pest report is untouched by the typed path (regression)', async () => {
    const data = await buildReportV1Data({
      id: 'service-recurring',
      customer_id: 'customer-1',
      service_line: 'pest',
      service_type: 'Quarterly Pest Control Service',
      service_date: '2026-06-11',
      first_name: 'Van',
      last_name: 'Lee',
      areas_serviced: JSON.stringify(['Perimeter']),
      structured_notes: '{}',
      service_data: '{}',
      pressure_index: 2.5,
    }, 'token-recurring', stubKnex());

    expect(data.typedReport).toBeNull();
    expect(data.activity).toBeNull();
    // pressureIndex stays customer-visible when pestPressure view renders;
    // with the default config (none loaded in the stub) the view may be
    // null, but the typed path must not have been what nulled it.
    expect(data.metrics.find((m) => m.key === 'activity_score')).toBeUndefined();
  });
});
