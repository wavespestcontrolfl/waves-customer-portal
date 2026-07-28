jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildReportCopyContext } = require('../services/service-report/report-copy-context');

// Permissive knex stub. lawn_assessments gets query-aware resolution: a
// where({ service_id }) chain resolves to the `linked` row (the visit-linked
// "today" lookup), a where('service_date', '<', …) chain resolves to the
// `prior` row — mirroring how the real queries differ.
function makeKnexStub({ customers = [], linked = null, prior = null } = {}) {
  const calls = [];
  const stub = (table) => {
    calls.push(table);
    const chain = { _byServiceId: false, _priorHistory: false };
    for (const method of ['whereIn', 'whereNull', 'whereNot', 'andWhere', 'orWhere', 'orWhereNot', 'orderBy', 'orderByRaw', 'limit', 'select', 'join', 'groupBy', 'count', 'whereRaw', 'whereBetween']) {
      chain[method] = () => chain;
    }
    // The prior-history query is the one that joins scheduled_services (its
    // bound runs on the linked visit's scheduled_date).
    chain.leftJoin = (joined) => {
      if (String(joined).includes('scheduled_services')) chain._priorHistory = true;
      return chain;
    };
    chain.modify = (fn) => { if (typeof fn === 'function') fn(chain); return chain; };
    chain.where = (...args) => {
      if (args[0] && typeof args[0] === 'object' && 'service_id' in args[0]) chain._byServiceId = true;
      return chain;
    };
    const resolveRows = () => {
      if (table === 'customers') return customers;
      // The prior query aliases the table ('lawn_assessments as la').
      if (!String(table).startsWith('lawn_assessments')) return [];
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
    expect(contextText).toContain('LAWN ASSESSMENT (photo-scored TODAY');
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
    expect(contextText).toContain('NOT today');
    expect(contextText).not.toContain('photo-scored TODAY');
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
