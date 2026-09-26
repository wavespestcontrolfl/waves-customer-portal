jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildReportCopyContext } = require('../services/service-report/report-copy-context');
const { buildDeterministicReportCopy } = require('../routes/admin-schedule')._test;

// Permissive knex stub. lawn_assessments gets query-aware resolution: a
// where({ service_id }) chain resolves to the `linked` row (the visit-linked
// "today" lookup), a where('service_date', '<', …) chain resolves to the
// `prior` row — mirroring how the real queries differ.
function makeKnexStub({ customers = [], linked = null, prior = null, catalogProducts = [] } = {}) {
  const calls = [];
  const stub = (table) => {
    calls.push(table);
    const chain = { _byServiceId: false, _priorHistory: false, _whereIns: [] };
    for (const method of ['whereNull', 'whereNot', 'andWhere', 'orWhere', 'orWhereNot', 'orderBy', 'orderByRaw', 'limit', 'select', 'join', 'groupBy', 'count', 'whereRaw', 'whereBetween']) {
      chain[method] = () => chain;
    }
    chain.whereIn = (column, values) => { chain._whereIns.push([column, values]); return chain; };
    // The prior-history query is the one that joins scheduled_services (its
    // bound runs on the linked visit's scheduled_date).
    chain.leftJoin = (joined) => {
      if (String(joined).includes('scheduled_services')) chain._priorHistory = true;
      return chain;
    };
    chain.modify = (fn) => { if (typeof fn === 'function') fn(chain); return chain; };
    chain.where = (...args) => {
      if (typeof args[0] === 'function') {
        args[0].call(chain);
        return chain;
      }
      if (args[0] && typeof args[0] === 'object' && 'service_id' in args[0]) chain._byServiceId = true;
      if (args[0] && typeof args[0] === 'object' && 'id' in args[0]) chain._byId = true;
      // The supersession probe (loadLawnAssessments: "any NEWER row on the
      // same visit") filters on created_at. The stub models a visit with no
      // newer retake, so that probe must resolve EMPTY — without this flag it
      // returned the linked row itself, the code read it as an in-progress
      // retake, and every "today" test failed even though the real SQL
      // (strictly-newer created_at) behaves correctly.
      if (args[0] === 'created_at') chain._newerCheck = true;
      return chain;
    };
    const resolveRows = () => {
      if (table === 'customers') return customers;
      if (table === 'products_catalog') {
        return chain._whereIns.reduce((rows, [column, values]) => (
          rows.filter((row) => values.includes(row[column]))
        ), catalogProducts);
      }
      // The prior query aliases the table ('lawn_assessments as la').
      if (!String(table).startsWith('lawn_assessments')) return [];
      if (chain._newerCheck) return [];
      if (chain._byId) return linked ? [linked] : [];
      if (chain._byServiceId) return linked ? [linked] : [];
      if (chain._priorHistory) return prior ? [prior] : [];
      return [];
    };
    chain.first = async () => resolveRows()[0];
    chain.then = (resolve, reject) => Promise.resolve(resolveRows()).then(resolve, reject);
    chain.catch = () => chain;
    return chain;
  };
  stub.calls = calls;
  // knex.raw is used for the coalesced visit-date select; the stub resolves
  // rows by table/flags, so the expression itself is inert here.
  stub.raw = (expression) => expression;
  return stub;
}

const CUSTOMER = { id: 'c1', first_name: 'Pat', last_name: 'Lawn', city: 'Bradenton', state: 'FL', latitude: null, longitude: null, lawn_type: 'st_augustine', waveguard_tier: 'silver' };

const TODAY_ROW = {
  service_date: '2026-07-28', is_baseline: false,
  turf_density: 72, weed_suppression: 81, color_health: 64,
  stress_damage: 85, fungus_control: 90, thatch_level: 70,
};
const PRIOR_ROW = {
  service_date: '2026-06-20', is_baseline: false,
  turf_density: 64, weed_suppression: 81, color_health: 58,
  stress_damage: 80, fungus_control: 88, thatch_level: 70,
};

describe('buildReportCopyContext lawn assessment grounding', () => {
  test('visit-linked assessment renders the four reviewed categories with deltas', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER], linked: TODAY_ROW, prior: PRIOR_ROW });
    const { contextText, signals } = await buildReportCopyContext({
      customerId: 'c1',
      scheduledServiceId: 'svc-1',
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).toContain('LAWN ASSESSMENT (photo-scored for THIS VISIT');
    expect(contextText).toContain('turf density 72/100 (+8 vs Jun 20, 2026)');
    expect(contextText).toContain('color health 64/100 (+6 vs Jun 20, 2026)');
    // stress/damage comes from the tech-reviewed consolidated score, not the
    // raw fungus/thatch sub-reads.
    expect(contextText).toContain('stress/damage control 85/100 (+5 vs Jun 20, 2026)');
    expect(contextText).not.toContain('fungus control');
    expect(contextText).not.toContain('thatch');
    // Unchanged categories carry no delta suffix.
    expect(contextText).toContain('weed suppression 81/100,');
    expect(signals.hasLawnAssessment).toBe(true);
  });

  test('without a scheduledServiceId there is no today section — prior renders as history', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER], prior: PRIOR_ROW });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).toContain('LAST LAWN ASSESSMENT (photo-scored Jun 20, 2026');
    expect(contextText).toContain('NOT this visit');
    expect(contextText).not.toContain('photo-scored for THIS VISIT');
  });

  test('a baseline visit suppresses deltas against superseded history', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER], linked: { ...TODAY_ROW, is_baseline: true }, prior: PRIOR_ROW });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      scheduledServiceId: 'svc-1',
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).toContain('baseline visit — no comparison');
    expect(contextText).toContain('turf density 72/100');
    expect(contextText).not.toContain('vs Jun 20, 2026');
  });

  test('unscored categories are omitted, never rendered as 0/100', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER], linked: { service_date: '2026-07-28', is_baseline: false, turf_density: 72, weed_suppression: null, color_health: '', stress_damage: null, fungus_control: null, thatch_level: null } });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      scheduledServiceId: 'svc-1',
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).toContain('turf density 72/100');
    expect(contextText).not.toContain('0/100');
    expect(contextText).not.toContain('weed suppression');
    expect(contextText).not.toContain('stress/damage');
  });

  test('unreviewed vision observations never reach the grounding text', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER], linked: { ...TODAY_ROW, observations: 'Possible gray leaf spot near the mailbox.' } });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      scheduledServiceId: 'svc-1',
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).not.toContain('gray leaf spot');
    expect(contextText).not.toContain('OBSERVATIONS');
  });

  test('explicit null lawnAssessmentId (retake pending) suppresses the today section', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER], linked: TODAY_ROW, prior: PRIOR_ROW });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      scheduledServiceId: 'svc-1',
      lawnAssessmentId: null,
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).not.toContain('photo-scored for THIS VISIT');
    expect(contextText).toContain('LAST LAWN ASSESSMENT');
  });

  test('an explicit lawnAssessmentId grounds that confirmed row as today', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER], linked: TODAY_ROW, prior: PRIOR_ROW });
    const { contextText } = await buildReportCopyContext({
      customerId: 'c1',
      scheduledServiceId: 'svc-1',
      lawnAssessmentId: 'la-9',
      serviceType: 'Monthly Lawn Care Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(contextText).toContain('photo-scored for THIS VISIT');
    expect(contextText).toContain('turf density 72/100');
  });

  test('non-lawn service lines never query lawn_assessments', async () => {
    const knex = makeKnexStub({ customers: [CUSTOMER] });
    const { contextText, signals } = await buildReportCopyContext({
      customerId: 'c1',
      scheduledServiceId: 'svc-1',
      serviceType: 'Quarterly Pest Control Service',
      serviceDate: '2026-07-28',
      knex,
    });
    expect(knex.calls).not.toContain('lawn_assessments');
    expect(contextText).not.toContain('LAWN ASSESSMENT');
    expect(signals.hasLawnAssessment).toBe(false);
  });
});

describe('buildReportCopyContext deterministic application evidence', () => {
  test('binds approved repeated applications to the provider-failure fallback', async () => {
    const catalogProducts = [
      {
        id: 'approved', name: 'Approved Residual', category: 'Insecticide', product_type: 'pesticide',
        active_ingredient: 'Bifenthrin', epa_reg_number: '279-3206', approved_for_service_report: true,
        rei_hours: 0, rainfast_minutes: 90, reentry_summary: 'Keep people and pets away until dry.',
      },
      {
        id: 'unapproved', name: 'Unapproved Product', category: 'Insecticide', product_type: 'pesticide',
        epa_reg_number: '100-200', approved_for_service_report: false,
      },
      {
        id: 'noncanonical', name: 'Unsupported Category', category: 'Insecticide Plus', product_type: 'pesticide',
        epa_reg_number: '100-201', approved_for_service_report: true,
      },
    ];
    const result = await buildReportCopyContext({
      customerId: 'c1',
      serviceType: 'Quarterly Pest Control Service',
      serviceDate: '2026-07-28',
      products: [
        {
          productId: 'approved', applicationMethod: 'broadcast_spray',
          applicationArea: 'rear gate 2468', areaValue: '4200', areaUnit: 'sqft',
        },
        {
          productId: 'approved', applicationMethod: 'spot_treatment',
          applicationArea: 'Side lawn', areaValue: '-5', areaUnit: 'linear_ft',
        },
        {
          productId: 'unapproved', applicationMethod: 'garage PIN 9753',
          applicationArea: 'Bedding areas', areaValue: '600', areaUnit: 'sqft',
        },
        {
          productId: 'noncanonical', applicationMethod: 'foliar_spray',
          applicationArea: 'Palms', areaValue: '12', areaUnit: 'linear_ft',
        },
        { productId: 'approved', applicationMethod: 'constructor', applicationArea: 'Front lawn' },
      ],
      knex: makeKnexStub({ customers: [CUSTOMER], catalogProducts }),
    });

    expect(result.contextText).toContain('REI until dry');
    expect(result.contextText).toContain('rainfast 1.5 hr');
    expect(result.signals.productSafetyCount).toBe(2);
    expect(result.deterministicApplications).toEqual([
      {
        role: 'insect-control application', method: 'broadcast spray', area: 'rear gate [redacted]',
        areaValue: '4200', areaUnit: 'sqft',
      },
      {
        role: 'insect-control application', method: 'spot treatment', area: 'Side lawn',
        areaValue: null, areaUnit: null,
      },
      {
        role: 'insect-control application', method: null, area: 'Front lawn',
        areaValue: null, areaUnit: null,
      },
    ]);

    const report = buildDeterministicReportCopy({
      serviceType: 'Quarterly Pest Control Service',
      applicationRecords: result.deterministicApplications,
    });
    expect(report).toContain('using broadcast spray in rear gate [redacted] with 4200 sq ft recorded');
    expect(report).toContain('using spot treatment in Side lawn');
    expect(report).not.toMatch(/2468|9753|Unapproved Product|Unsupported Category|-5 linear ft/);
  });
});
