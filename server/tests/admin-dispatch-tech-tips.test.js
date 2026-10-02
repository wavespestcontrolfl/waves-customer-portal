/**
 * GET /admin/dispatch/:serviceId/tech-tips — the completion screen's tip
 * picker payload (tips-from-your-tech PR 2).
 *
 *  - Both gates off answer unavailable without touching the database.
 *  - The completion-choice gate independently returns dated structured prior
 *    recommendations for the same customer and service line.
 *  - Gate on returns the registry grouped for the visit's line and season,
 *    the per-customer "last sent" dates, and the irrigation-on-file
 *    condition — read-only, no writes.
 *  - The handler is registered on the dispatch router behind its router-level
 *    tech-or-admin auth, and its block never touches comms or transitions.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.first = async () => null;
    chain.returning = async () => [];
    chain.count = async () => [{ count: 0 }];
    chain.columnInfo = async () => ({});
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/completion-product-defaults', () => ({ resolveCompletionProductDefaults: jest.fn(async () => ({ products: [], holds: [] })) }));
// The real resolver for every route; the tip tests below stub the visit's
// service so their read lists stay exact.
const mockResolveProfile = jest.fn();
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: (...args) => mockResolveProfile(...args),
}));
beforeEach(() => {
  mockResolveProfile.mockImplementation((...args) => jest.requireActual('../services/service-completion-profiles').resolveCompletionProfileForScheduledService(...args));
});

const fs = require('fs');
const path = require('path');
const router = require('../routes/admin-dispatch');
const { TIPS } = require('../services/service-report/tip-library');

const completionSource = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');

function routeLayer(method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
}

function invoke(params = {}, actor = { techRole: 'admin', technicianId: 'admin-1' }, routePath = '/:serviceId/tech-tips') {
  const layer = routeLayer('get', routePath);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

// A scripted db: scheduled_services → the visit; service_records → optional
// recommendation history then prior frozen tips; property_preferences → the
// irrigation flag.
function scriptedDb({ service, recommendationRows = null, sentRows = [], prefs = null, addons = [], calls }) {
  return (table) => {
    calls.push(table);
    const chain = {};
    let throughDate = null;
    let rowLimit = null;
    let rowOffset = 0;
    let recommendationRead = false;
    const passthrough = ['whereRaw', 'orderBy', 'leftJoin'];
    for (const m of passthrough) chain[m] = () => chain;
    chain.limit = (value) => { rowLimit = value; return chain; };
    chain.offset = (value) => { rowOffset = value; return chain; };
    chain.select = (...columns) => {
      recommendationRead = columns.some((column) => column === 'id' || String(column).endsWith(' as id'));
      return chain;
    };
    chain.where = (...args) => {
      if (table === 'service_records' && ['service_date', 'service_records.service_date'].includes(args[0]) && args[1] === '<=') {
        throughDate = args[2];
      }
      return chain;
    };
    chain.first = async () => (table === 'scheduled_services' ? service : table === 'property_preferences' ? prefs : null);
    chain.then = (resolve) => {
      if (table === 'scheduled_service_addons') return Promise.resolve(addons).then(resolve);
      if (table !== 'service_records') return Promise.resolve([]).then(resolve);
      // History fixtures are published by default; visibility-negative cases
      // opt out explicitly with report_view_token: null.
      const rows = recommendationRead
        ? (recommendationRows || []).map((row) => {
          const historyPropertyId = Object.prototype.hasOwnProperty.call(row, 'history_property_id')
            ? row.history_property_id
            : service?.property_id || null;
          const defaultsToCurrentProperty = historyPropertyId
            && String(historyPropertyId) === String(service?.property_id || '');
          return {
            report_view_token: `token-${row.id}`,
            history_visit_id: row.scheduled_service_id || null,
            history_visit_customer_id: service?.customer_id || null,
            history_property_id: historyPropertyId,
            history_property_address_line1: defaultsToCurrentProperty ? service?.current_property_address_line1 : null,
            history_property_address_line2: defaultsToCurrentProperty ? service?.current_property_address_line2 : null,
            history_property_city: defaultsToCurrentProperty ? service?.current_property_city : null,
            history_property_zip: defaultsToCurrentProperty ? service?.current_property_zip : null,
            ...row,
          };
        })
        : sentRows;
      const bounded = throughDate
        ? rows.filter((row) => String(row.service_date instanceof Date
          ? row.service_date.toISOString() : row.service_date || '').slice(0, 10) <= throughDate)
        : rows;
      const page = rowLimit == null ? bounded : bounded.slice(rowOffset, rowOffset + rowLimit);
      return Promise.resolve(page).then(resolve);
    };
    chain.catch = () => chain;
    return chain;
  };
}

const SERVICE = {
  id: 'svc-1',
  customer_id: 'cust-1',
  service_type: 'Mosquito Treatment',
  scheduled_date: '2026-08-15',
  technician_id: 'tech-7',
  property_id: 'property-home',
  current_property_address_line1: '100 Main Street',
  current_property_address_line2: 'Apt 4',
  current_property_city: 'Sarasota',
  current_property_zip: '34205-1234',
};

afterEach(() => {
  mockDbCurrent = null;
  delete process.env.GATE_TECH_TIPS;
  delete process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES;
});

describe('GET /:serviceId/tech-tips', () => {
  beforeEach(() => {
    mockResolveProfile.mockResolvedValue({ serviceKey: 'mosquito_monthly_unlisted' });
  });

  test('the visit\'s catalog service leads with its own tips, which no other visit lists (owner-approved 2026-10-02)', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    mockResolveProfile.mockResolvedValue({ serviceKey: 'mosquito_monthly' });
    mockDbCurrent = scriptedDb({ service: SERVICE, calls: [] });
    const res = await invoke({ serviceId: 'svc-1' });
    expect(res.body.groups[0]).toMatchObject({ id: 'for_service', label: 'For this service', primary: true });
    expect(res.body.groups[0].tips.map((tip) => tip.id)).toEqual(['mq_pool', 'mq_tree_holes']);
    expect(mockResolveProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-1' }));
    mockResolveProfile.mockRejectedValue(new Error('catalog down'));
    const fallback = await invoke({ serviceId: 'svc-1' });
    expect(fallback.body.groups.map((group) => group.id)).not.toContain('for_service');
    expect(fallback.body.available).toBe(true);
  });

  test('an add-on line leads with its own tips beside the primary\'s (Codex #5582)', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    mockResolveProfile.mockResolvedValue({ serviceKey: 'mosquito_monthly' });
    // The key stamped on the line wins; an older line falls back to its catalog row's.
    mockDbCurrent = scriptedDb({ service: SERVICE, calls: [], addons: [{ key_snapshot: 'flea_tick', catalog_key: 'tick_control' }, { key_snapshot: null, catalog_key: 'bora_care' }] });
    const res = await invoke({ serviceId: 'svc-1' });
    expect(res.body.groups[0].tips.map((tip) => tip.id).sort())
      .toEqual(['bc_keep_dry', 'flea_keep_vacuuming', 'flea_pet_prevention', 'flea_shady_spots', 'mq_pool', 'mq_tree_holes']);
  });

  test('both gates off preserve the no-read unavailable response', async () => {
    const calls = [];
    mockDbCurrent = scriptedDb({ service: SERVICE, calls });
    for (const value of [undefined, '', 'false', 'off', '0', 'yes']) {
      if (value === undefined) delete process.env.GATE_TECH_TIPS;
      else process.env.GATE_TECH_TIPS = value;
      const res = await invoke({ serviceId: 'svc-1' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ available: false, completionChoicesEnabled: false });
    }
    expect(calls).toEqual([]);
  });

  test('gate on: a technician reads only their own assigned visit; admins read any', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    mockDbCurrent = scriptedDb({ service: SERVICE, calls: [] });
    const other = await invoke({ serviceId: 'svc-1' }, { techRole: 'technician', technicianId: 'tech-9' });
    expect(other.statusCode).toBe(403);
    expect(other.body.code).toBe('service_not_assigned');
    const own = await invoke({ serviceId: 'svc-1' }, { techRole: 'technician', technicianId: 'tech-7' });
    expect(own.statusCode).toBe(200);
    expect(own.body.available).toBe(true);
    const admin = await invoke({ serviceId: 'svc-1' }, { techRole: 'admin', technicianId: 'admin-1' });
    expect(admin.statusCode).toBe(200);
  });

  test('gate on: unknown service is a 404', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    mockDbCurrent = scriptedDb({ service: null, calls: [] });
    const res = await invoke({ serviceId: 'nope' });
    expect(res.statusCode).toBe(404);
  });

  test('gate on: only visit-line tips, with sent dates and conditions', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    const calls = [];
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      sentRows: [
        // pg returns DATE columns as a Date at UTC midnight — the payload
        // carries the calendar day, not that instant
        { service_date: new Date('2026-08-03T00:00:00.000Z'), tech_tips: [{ id: 'water_bromeliads', copy: 'x', source: 'library' }] },
        { service_date: '2026-07-01', tech_tips: [{ id: 'water_bromeliads' }, { id: 'light_warm_bulbs' }] },
      ],
      prefs: { irrigation_system: true, watering_days: ['mon', 'thu'], irrigation_run_minutes: null },
      calls,
    });
    const res = await invoke({ serviceId: 'svc-1' });
    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.completionChoicesEnabled).toBe(false);
    expect(res.body.line).toBe('mosquito');
    expect(res.body.season).toBe('wet');
    expect(res.body.groups.flatMap((g) => g.tips).map((tip) => tip.id).sort()).toEqual(TIPS.filter((tip) => tip.lines.includes('mosquito') && !tip.services).map((tip) => tip.id).sort());
    expect(res.body.groups[0].primary).toBe(true);
    // newest send wins per id
    expect(res.body.lastSent).toEqual({ water_bromeliads: '2026-08-03', light_warm_bulbs: '2026-07-01' });
    expect(res.body.conditions).toEqual({ irrigation_on_file: true });
    expect(res.body).not.toHaveProperty('previousRecommendations');
    // read-only: three reads, no writes
    expect(calls.sort()).toEqual(['property_preferences', 'scheduled_service_addons', 'scheduled_services', 'service_records']);
  });

  test('gate on: the irrigation flag alone never counts as settings on file', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    for (const prefs of [
      { irrigation_system: true },
      { irrigation_system: true, watering_days: [], irrigation_run_minutes: null, irrigation_inches_per_week: '', irrigation_zones: null, rain_sensor: null },
      // the column default (20260401000084) is not customer-entered data
      { irrigation_system: true, rain_sensor: false, irrigation_confirmed_fields: [] },
      // turf-profile entries share the ledger but say nothing about a schedule
      { irrigation_confirmed_fields: ['turf_grass', 'turf_county'] },
      { irrigation_confirmed_fields: '["turf_county"]' },
      null,
    ]) {
      mockDbCurrent = scriptedDb({ service: SERVICE, prefs, calls: [] });
      const res = await invoke({ serviceId: 'svc-1' });
      expect(res.body.conditions).toEqual({ irrigation_on_file: false });
    }
    for (const prefs of [{ rain_sensor: true }, { irrigation_zones: 6 }, { irrigation_inches_per_week: 1 }, { irrigation_system_type: 'rotor' }, { irrigation_confirmed_fields: ['turf_grass', 'watering_days'] }, { irrigation_confirmed_fields: '["rain_sensor"]' }]) {
      mockDbCurrent = scriptedDb({ service: SERVICE, prefs, calls: [] });
      const res = await invoke({ serviceId: 'svc-1' });
      expect(res.body.conditions).toEqual({ irrigation_on_file: true });
    }
  });

  test('gate on: a service with no customer skips the per-customer reads', async () => {
    process.env.GATE_TECH_TIPS = 'true';
    const calls = [];
    mockDbCurrent = scriptedDb({ service: { ...SERVICE, customer_id: null }, calls });
    const res = await invoke({ serviceId: 'svc-1' });
    expect(res.body.available).toBe(true);
    expect(res.body.lastSent).toEqual({});
    expect(res.body.conditions).toEqual({ irrigation_on_file: false });
    expect(calls).toEqual(['scheduled_services', 'scheduled_service_addons']);
  });

  test('completion choices work with tech tips off and return only three prior same-line visits through the visit date', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    const recommendationRows = [
      {
        id: 'future', scheduled_service_id: 'future-svc', service_line: 'mosquito', service_date: '2026-08-16',
        structured_notes: { formRecommendations: ['Future recommendation'] },
      },
      {
        id: 'current-record', scheduled_service_id: 'svc-1', service_line: 'mosquito', service_date: '2026-08-15',
        structured_notes: { formRecommendations: ['Current visit recommendation'] },
      },
      {
        id: 'internal-only', scheduled_service_id: 'internal-svc', service_line: 'mosquito', service_date: '2026-08-14',
        structured_notes: { typedReportDelivery: 'internal_only', formRecommendations: ['Internal-only recommendation'] },
      },
      {
        id: 'disabled-report', scheduled_service_id: 'disabled-svc', service_line: 'mosquito', service_date: '2026-08-13',
        structured_notes: { typedReportDelivery: 'disabled', formRecommendations: ['Disabled recommendation'] },
      },
      {
        id: 'incomplete-visit', scheduled_service_id: 'incomplete-svc', service_line: 'mosquito', service_date: '2026-08-12',
        structured_notes: { visitOutcome: 'incomplete', formRecommendations: ['Incomplete recommendation'] },
      },
      {
        id: 'backfill-visit', scheduled_service_id: 'backfill-svc', service_line: 'mosquito', service_date: '2026-08-11',
        structured_notes: { backfill: true, formRecommendations: ['Backfill recommendation'] },
      },
      {
        id: 'rec-1', scheduled_service_id: 'old-1', service_line: 'mosquito', service_date: '2026-08-01',
        technician_notes: 'Raw notes must never be mined for recommendations.',
        structured_notes: {
          formRecommendations: ['Drain standing water weekly', 'Trim dense foliage', 'Drain standing water weekly'],
          recommendations: ['Internal tagged next step'],
        },
      },
      {
        id: 'wrong-line', scheduled_service_id: 'old-lawn', service_line: 'lawn', service_date: '2026-07-30',
        structured_notes: { formRecommendations: ['Wrong service line'] },
      },
      {
        id: 'rec-2', scheduled_service_id: 'old-2', service_type: 'Mosquito Treatment', service_date: '2026-07-15',
        service_data: {
          typedReportSnapshot: {
            nextStepChips: ['Monitor activity'],
            values: { treatment_recommendation: 'Schedule a follow-up inspection', injection_recommended: 'No' },
          },
        },
      },
      {
        id: 'rec-3', scheduled_service_id: 'old-3', history_property_id: null,
        history_service_address_line1: '100 Main St.', history_service_address_line2: '#4',
        history_service_address_city: 'Sarasota', history_service_address_zip: '34205',
        service_line: 'mosquito', service_date: new Date('2026-06-20T00:00:00.000Z'),
        structured_notes: JSON.stringify({ formRecommendations: ['Empty outdoor containers'] }),
      },
      {
        id: 'rec-4', scheduled_service_id: 'old-4', service_line: 'mosquito', service_date: '2026-05-01',
        structured_notes: { formRecommendations: ['Older than the three-visit bound'] },
      },
    ];
    const calls = [];
    mockDbCurrent = scriptedDb({ service: SERVICE, recommendationRows, calls });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.statusCode).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.completionChoicesEnabled).toBe(true);
    expect(res.body.previousRecommendations).toEqual([
      { text: 'Drain standing water weekly', serviceDate: '2026-08-01', serviceRecordId: 'rec-1' },
      { text: 'Trim dense foliage', serviceDate: '2026-08-01', serviceRecordId: 'rec-1' },
      { text: 'Monitor activity', serviceDate: '2026-07-15', serviceRecordId: 'rec-2' },
      { text: 'Schedule a follow-up inspection', serviceDate: '2026-07-15', serviceRecordId: 'rec-2' },
      { text: 'Empty outdoor containers', serviceDate: '2026-06-20', serviceRecordId: 'rec-3' },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/Raw notes|Internal tagged|Internal-only|Disabled recommendation|Incomplete recommendation|Backfill recommendation|Wrong service line|Current visit|Future recommendation|Older than/);
    expect(calls).toEqual(['scheduled_services', 'service_records']);
  });

  test('completion history includes only customer-visible companions matching the current line on a visible record', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      recommendationRows: [{
        id: 'combined-lawn', scheduled_service_id: 'old-combined', service_line: 'lawn', service_date: '2026-08-01',
        structured_notes: { typedReportDelivery: 'auto_send', formRecommendations: ['Primary lawn recommendation'] },
        service_data: {
          typedReportSnapshot: { nextStepChips: ['Primary lawn next step'] },
          companionReportSnapshots: [
            {
              type: 'mosquito_event', delivery: 'auto_send',
              nextStepChips: ['Empty outdoor containers'],
              values: { inspection_recommendation: 'Recheck the screened patio' },
            },
            { type: 'mosquito_event', delivery: 'internal_only', nextStepChips: ['Internal mosquito step'] },
            { type: 'tree_shrub', delivery: 'auto_send', nextStepChips: ['Wrong companion line'] },
          ],
        },
      }],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([
      { text: 'Empty outdoor containers', serviceDate: '2026-08-01', serviceRecordId: 'combined-lawn' },
      { text: 'Recheck the screened patio', serviceDate: '2026-08-01', serviceRecordId: 'combined-lawn' },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/Primary lawn|Internal mosquito|Wrong companion/);
  });

  test.each(['internal_only', 'disabled'])('record-level %s suppresses primary and auto-send companion history', async (typedReportDelivery) => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      recommendationRows: [{
        id: 'suppressed-combined', scheduled_service_id: 'suppressed-combined-visit', service_line: 'lawn', service_date: '2026-08-01',
        structured_notes: { typedReportDelivery, formRecommendations: ['Suppressed primary'] },
        service_data: {
          companionReportSnapshots: [{
            type: 'mosquito_event', delivery: 'auto_send', nextStepChips: ['Suppressed companion'],
          }],
        },
      }],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([]);
  });

  test('delivery posture without a published report artifact exposes no primary or companion history', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      recommendationRows: [{
        id: 'unpublished', scheduled_service_id: 'unpublished-svc', service_line: 'mosquito', service_date: '2026-08-01',
        report_view_token: null,
        structured_notes: { typedReportDelivery: 'auto_send', formRecommendations: ['Unpublished primary'] },
        service_data: {
          typedReportSnapshot: { nextStepChips: ['Unpublished primary snapshot'] },
          companionReportSnapshots: [{
            type: 'mosquito_event', delivery: 'auto_send', nextStepChips: ['Unpublished companion'],
          }],
        },
      }],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([]);
  });

  test('typed snapshot recommendations use frozen customer wording and keep multi-select parts separate', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      recommendationRows: [{
        id: 'frozen-copy', scheduled_service_id: 'frozen-copy-svc', service_line: 'mosquito', service_date: '2026-08-01',
        service_data: {
          typedReportSnapshot: {
            values: {
              treatment_recommendation: 'Raw value that may map differently now',
              inspection_recommendations: 'Raw first, Raw second',
              injection_recommended: 'Yes',
            },
            findings: [
              {
                fieldKey: 'treatment_recommendation',
                value: 'Raw value that may map differently now',
                customerValueLabel: 'Frozen treatment wording',
              },
              {
                fieldKey: 'inspection_recommendations',
                value: 'Raw first, Raw second',
                customerValueLabel: 'Frozen first, Frozen second, with detail',
                customerValueParts: ['Frozen first', 'Frozen second, with detail'],
              },
            ],
          },
        },
      }],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([
      { text: 'Frozen treatment wording', serviceDate: '2026-08-01', serviceRecordId: 'frozen-copy' },
      { text: 'Frozen first', serviceDate: '2026-08-01', serviceRecordId: 'frozen-copy' },
      { text: 'Frozen second, with detail', serviceDate: '2026-08-01', serviceRecordId: 'frozen-copy' },
      { text: 'A palm injection is recommended', serviceDate: '2026-08-01', serviceRecordId: 'frozen-copy' },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/Raw value|Raw first|Raw second/);
  });

  test.each([
    ['exclusion_recommendation', 'Not needed at this time', 'No exclusion work is needed at this time.'],
    ['recommended_service', 'No service needed at this time', 'No service needed at this time'],
    ['exclusion_recommendation', 'Completed previously', 'Exclusion repairs were completed previously.'],
  ])('completion history excludes governed no-action %s=%s from legacy and frozen snapshots', async (fieldKey, value, customerValueLabel) => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: { ...SERVICE, service_type: 'Rodent Trapping' },
      recommendationRows: [{
        id: 'rodent-history', scheduled_service_id: 'prior-rodent', service_line: 'rodent', service_date: '2026-08-01',
        service_data: {
          typedReportSnapshot: { values: { [fieldKey]: value, sanitation_recommendations: ['Keep trash bins closed'] } },
          companionReportSnapshots: [{
            type: 'rodent_trapping', delivery: 'auto_send',
            values: { [fieldKey]: value, exclusion_recommendation: value },
            findings: [{ fieldKey, value, customerValueLabel }],
          }],
        },
      }],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([
      { text: 'Keep trash bins closed', serviceDate: '2026-08-01', serviceRecordId: 'rodent-history' },
    ]);
  });

  test('completion history retains positive governed rodent recommendations', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: { ...SERVICE, service_type: 'Rodent Trapping' },
      recommendationRows: [{
        id: 'rodent-history', scheduled_service_id: 'prior-rodent', service_line: 'rodent', service_date: '2026-08-01',
        service_data: {
          typedReportSnapshot: { values: { exclusion_recommendation: 'Recommended after activity stops', recommended_service: 'Sanitation cleanup' } },
        },
      }],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([
      { text: 'Exclusion repairs are recommended to reduce rodent access once trapping activity stops.', serviceDate: '2026-08-01', serviceRecordId: 'rodent-history' },
      { text: 'Sanitation cleanup', serviceDate: '2026-08-01', serviceRecordId: 'rodent-history' },
    ]);
  });

  test('completion history filters governed no-action chips while preserving actionable negative wording', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      recommendationRows: [{
        id: 'chip-history', scheduled_service_id: 'chip-history-visit', service_line: 'mosquito', service_date: '2026-08-01',
        service_data: {
          typedReportSnapshot: {
            nextStepChips: ['No action needed', 'No follow-up needed', 'No store-bought sprays', 'Empty outdoor containers'],
          },
        },
      }],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations.map((item) => item.text)).toEqual([
      'No store-bought sprays',
      'Empty outdoor containers',
    ]);
  });

  test('completion history counts scheduled visits once, deduplicates sibling text, and treats linked legacy-address visits separately', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      recommendationRows: [
        {
          id: 'sibling-a', scheduled_service_id: 'shared-visit', service_line: 'mosquito', service_date: '2026-08-10',
          structured_notes: { formRecommendations: ['Shared recommendation'] },
        },
        {
          id: 'sibling-b', scheduled_service_id: 'shared-visit', service_line: 'mosquito', service_date: '2026-08-10',
          structured_notes: { formRecommendations: ['Shared recommendation', 'Sibling-only recommendation'] },
        },
        {
          id: 'legacy-a', scheduled_service_id: 'legacy-a-svc', history_property_id: null,
          history_service_address_line1: '100 Main St.', history_service_address_line2: '#4',
          history_service_address_city: 'Sarasota', history_service_address_zip: '34205',
          service_line: 'mosquito', service_date: '2026-08-05',
          structured_notes: { formRecommendations: ['First legacy recommendation'] },
        },
        {
          id: 'legacy-b', scheduled_service_id: 'legacy-b-svc', history_property_id: null,
          history_service_address_line1: '100 Main Street', history_service_address_line2: 'Unit 4',
          history_service_address_city: 'Sarasota', history_service_address_zip: '34205-9999',
          service_line: 'mosquito', service_date: '2026-08-04',
          structured_notes: { formRecommendations: ['Second legacy recommendation'] },
        },
        {
          id: 'past-bound', scheduled_service_id: 'past-bound-svc', service_line: 'mosquito', service_date: '2026-08-03',
          structured_notes: { formRecommendations: ['Past visit bound'] },
        },
      ],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([
      { text: 'Shared recommendation', serviceDate: '2026-08-10', serviceRecordId: 'sibling-a' },
      { text: 'Sibling-only recommendation', serviceDate: '2026-08-10', serviceRecordId: 'sibling-b' },
      { text: 'First legacy recommendation', serviceDate: '2026-08-05', serviceRecordId: 'legacy-a' },
      { text: 'Second legacy recommendation', serviceDate: '2026-08-04', serviceRecordId: 'legacy-b' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('Past visit bound');
  });

  test('completion history scopes to the appointment property before applying the three-visit bound', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      recommendationRows: [
        {
          id: 'other-property-newest', scheduled_service_id: 'rental-visit', history_property_id: 'property-rental',
          service_line: 'mosquito', service_date: '2026-08-14', structured_notes: { formRecommendations: ['Rental recommendation'] },
        },
        {
          id: 'other-customer-link', scheduled_service_id: 'foreign-visit', history_visit_customer_id: 'cust-2', history_property_id: 'property-home',
          service_line: 'mosquito', service_date: '2026-08-14', structured_notes: { formRecommendations: ['Foreign visit recommendation'] },
        },
        {
          id: 'legacy-other-premise', scheduled_service_id: 'legacy-other', history_property_id: null,
          history_service_address_line1: '900 Other Avenue', history_service_address_city: 'Sarasota', history_service_address_zip: '34205',
          service_line: 'mosquito', service_date: '2026-08-13', structured_notes: { formRecommendations: ['Other premise recommendation'] },
        },
        {
          id: 'same-linked', scheduled_service_id: 'home-linked', history_property_id: 'property-home',
          service_line: 'mosquito', service_date: '2026-08-12', structured_notes: { formRecommendations: ['Same linked property'] },
        },
        {
          id: 'same-legacy', scheduled_service_id: 'home-legacy', history_property_id: null,
          history_service_address_line1: '100 Main St.', history_service_address_line2: '#4',
          history_service_address_city: 'Sarasota', history_service_address_zip: '34205',
          service_line: 'mosquito', service_date: '2026-08-11', structured_notes: { formRecommendations: ['Same canonical legacy premise'] },
        },
        {
          id: 'unlinked-record', scheduled_service_id: null,
          service_line: 'mosquito', service_date: '2026-08-10', structured_notes: { formRecommendations: ['Unlinked and unproven'] },
        },
        {
          id: 'third-home', scheduled_service_id: 'third-home', history_property_id: 'property-home',
          service_line: 'mosquito', service_date: '2026-08-09', structured_notes: { formRecommendations: ['Third same-property visit'] },
        },
        {
          id: 'past-home-bound', scheduled_service_id: 'past-home-bound', history_property_id: 'property-home',
          service_line: 'mosquito', service_date: '2026-08-08', structured_notes: { formRecommendations: ['Past same-property bound'] },
        },
      ],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations.map((item) => item.text)).toEqual([
      'Same linked property',
      'Same canonical legacy premise',
      'Third same-property visit',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/Rental|Foreign visit|Other premise|Unlinked|Past same-property/);
  });

  test('completion history is bounded to twelve suggestions', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'on';
    mockDbCurrent = scriptedDb({
      service: SERVICE,
      recommendationRows: [{
        id: 'rec-many', scheduled_service_id: 'old-many', service_line: 'mosquito', service_date: '2026-08-01',
        structured_notes: { formRecommendations: Array.from({ length: 15 }, (_, index) => `Recommendation ${index + 1}`) },
      }],
      calls: [],
    });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toHaveLength(12);
    expect(res.body.previousRecommendations.at(-1).text).toBe('Recommendation 12');
  });

  test('completion history paginates past more than 500 hidden visits and stops at three visible visits', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    const hiddenRows = Array.from({ length: 501 }, (_, index) => ({
      id: `hidden-${index}`,
      scheduled_service_id: `hidden-svc-${index}`,
      service_line: 'mosquito',
      service_date: '2026-08-10',
      structured_notes: { typedReportDelivery: 'internal_only', formRecommendations: [`Hidden ${index}`] },
    }));
    const recommendationRows = [
      ...hiddenRows,
      {
        id: 'older-primary', scheduled_service_id: 'older-primary-svc', service_line: 'mosquito', service_date: '2026-08-01',
        structured_notes: { formRecommendations: ['Primary visible recommendation'] },
      },
      {
        id: 'older-companion', scheduled_service_id: 'older-companion-svc', service_line: 'lawn', service_date: '2026-07-20',
        structured_notes: { typedReportDelivery: 'auto_send', formRecommendations: ['Hidden lawn recommendation'] },
        service_data: {
          companionReportSnapshots: [{
            type: 'mosquito_event', delivery: 'auto_send', nextStepChips: ['Companion visible recommendation'],
          }],
        },
      },
      {
        id: 'third-visible', scheduled_service_id: 'third-visible-svc', service_line: 'mosquito', service_date: '2026-07-01',
        structured_notes: { formRecommendations: ['Third visible recommendation'] },
      },
      {
        id: 'fourth-visible', scheduled_service_id: 'fourth-visible-svc', service_line: 'mosquito', service_date: '2026-06-01',
        structured_notes: { formRecommendations: ['Past visit bound'] },
      },
    ];
    const calls = [];
    mockDbCurrent = scriptedDb({ service: SERVICE, recommendationRows, calls });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([
      { text: 'Primary visible recommendation', serviceDate: '2026-08-01', serviceRecordId: 'older-primary' },
      { text: 'Companion visible recommendation', serviceDate: '2026-07-20', serviceRecordId: 'older-companion' },
      { text: 'Third visible recommendation', serviceDate: '2026-07-01', serviceRecordId: 'third-visible' },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/Hidden|Past visit bound/);
    expect(calls.filter((table) => table === 'service_records')).toHaveLength(2);
  });

  test('completion history stops paginating when hidden history is exhausted', async () => {
    process.env.GATE_SERVICE_REPORT_COMPLETION_CHOICES = 'true';
    const recommendationRows = Array.from({ length: 501 }, (_, index) => ({
      id: `hidden-${index}`,
      scheduled_service_id: `hidden-svc-${index}`,
      service_line: 'mosquito',
      service_date: '2026-08-01',
      structured_notes: { visitOutcome: 'incomplete', formRecommendations: [`Hidden ${index}`] },
    }));
    const calls = [];
    mockDbCurrent = scriptedDb({ service: SERVICE, recommendationRows, calls });

    const res = await invoke({ serviceId: 'svc-1' });

    expect(res.body.previousRecommendations).toEqual([]);
    expect(calls.filter((table) => table === 'service_records')).toHaveLength(2);
  });
});

describe('completion freeze contract', () => {
  test('the complete route freezes the picks through freezeTechTips into structured_notes.techTips', () => {
    const start = completionSource.indexOf('async function completeScheduledService(');
    expect(start).toBeGreaterThan(-1);
    const block = completionSource.slice(start);
    expect(block).toContain('freezeTechTips(completionInput.body?.techTips)');
    expect(block).toMatch(/techTips: techTipsFreeze\.tips/);
    // a rejected pick is an actionable 400 for a FRESH attempt, never a silent drop —
    // deferred past replay/conflict handling so a same-key retry keeps replaying
    // the stored completion even if the library changed (same posture as the
    // caption gate), and it marks the claimed attempt failed before returning
    const reject = block.indexOf("if (claim.action === 'proceed' && techTipsFreeze.dropped.length) {");
    expect(reject).toBeGreaterThan(-1);
    expect(reject).toBeGreaterThan(block.indexOf("if (claim.action === 'replay') {"));
    const rejectBlock = block.slice(reject, reject + 2400);
    expect(rejectBlock).toMatch(/markCompletionAttemptFailed\([\s\S]*tech_tip_rejected/);
    expect(rejectBlock).toMatch(/return \(\{ status: 400, body: \{[\s\S]*TECH_TIP_UNKNOWN[\s\S]*TECH_TIP_COPY_REJECTED/);
    // …and still before the completion transaction's first write
    expect(reject).toBeLessThan(block.indexOf("trx('service_records').insert(recordInsert)"));
    // the kill switch holds on the write path too
    expect(block).toMatch(/techTipsGateOn\(\)\s*\n?\s*\? freezeTechTips/);
    // ids resolve server-side — the client's copy never reaches the freeze
    expect(block).not.toMatch(/techTips\.copy|body\.techTips\.tips/);
  });
});

describe('route wiring contracts', () => {
  test('tree/shrub assess-preview returns the exact photo-set hash beside its HMAC', () => {
    const start = source.indexOf("router.post('/:serviceId/tree-shrub/assess-preview'");
    const end = source.indexOf("router.post('/:serviceId/rain-out'", start);
    const block = source.slice(start, end);
    expect(block).toContain('const photosHash = treeShrubPhotosHash(photos.map((p) => p && p.data));');
    expect(block).toContain('treeShrubReviewSignature(result.scores, result.scoredCount, req.params.serviceId, photosHash, result.observations)');
    expect(block).toContain('return res.json({ ...result, photosHash, status: \'complete\' });');
  });

  test('the handler is registered after the router-level tech-or-admin auth', () => {
    const layer = routeLayer('get', '/:serviceId/tech-tips');
    expect(layer).toBeTruthy();
    // and applies the per-visit ownership rule inside
    const start = source.indexOf("router.get('/:serviceId/tech-tips'");
    expect(source.slice(start, source.indexOf('\nrouter.', start + 1))).toContain('completionOwnershipError({');
    const authIdx = router.stack.findIndex((l) => !l.route && l.name === 'adminAuthenticate');
    expect(authIdx).toBeGreaterThan(-1);
    expect(router.stack.indexOf(layer)).toBeGreaterThan(authIdx);
  });

  test('the block is read-only: no writes, comms, or transitions', () => {
    const start = source.indexOf("router.get('/:serviceId/tech-tips'");
    expect(start).toBeGreaterThan(-1);
    const closer = '} catch (err) { next(err); }\n});';
    const end = source.indexOf(closer, start);
    const block = source.slice(start, end + closer.length);
    for (const forbidden of ['.update(', '.insert(', '.del(', 'sendCustomerMessage', 'markComplete', 'transitionJobStatus', 'twilio']) {
      expect(block).not.toContain(forbidden);
    }
    // parked [Next] lines arrive as internalRecommendations: merged into the
    // internal list, never the form-provenance list the report prints verbatim
    const cstart = completionSource.indexOf('async function completeScheduledService(');
    const cblock = completionSource.slice(cstart);
    const internalMerge = cblock.indexOf('const reportRecommendations = normalizeCompletionTextArray([');
    expect(cblock.slice(internalMerge, internalMerge + 600)).toContain('internalRecommendations');
    const formBlock = cblock.slice(cblock.indexOf('const formRecommendations = normalizeCompletionTextArray('), cblock.indexOf('const formRecommendations = normalizeCompletionTextArray(') + 200);
    expect(formBlock).not.toContain('internalRecommendations');
    // "sent" = a report the customer could open: undelivered postures are excluded
    expect(block).toContain("COALESCE(structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'");
    expect(block).toContain("COALESCE(structured_notes->>'visitOutcome', '') <> 'incomplete'");
    // the 90-day window is an ET calendar day bound from the shared helpers,
    // never the session-zone CURRENT_DATE
    expect(block).not.toMatch(/CURRENT_DATE|now\(\)/i);
    expect(block).toContain('etDateString(addETDays(new Date(), -90))');
  });

  test('prior recommendation history is date-bounded and never mines raw technician notes', () => {
    const start = source.indexOf('async function loadPreviousRecommendations');
    const end = source.indexOf('// GET /api/admin/dispatch/:serviceId/tech-tips', start);
    const block = source.slice(start, end);
    expect(block).toContain(".where('service_records.service_date', '<=', visitDay)");
    expect(block).toContain('PREVIOUS_RECOMMENDATION_VISIT_LIMIT');
    expect(block).toContain('PREVIOUS_RECOMMENDATION_ITEM_LIMIT');
    expect(block).toContain("'service_records.structured_notes as structured_notes'");
    expect(block).toContain("'service_records.service_data as service_data'");
    expect(block).toContain("'service_records.report_view_token as report_view_token'");
    expect(block).toContain(".leftJoin('scheduled_services as history_visit'");
    expect(block).toContain(".leftJoin('customer_properties as history_property'");
    expect(block).not.toContain('technician_notes');
  });
});

describe('default-product reads keep the current technician assignment boundary', () => {
  const { resolveCompletionProductDefaults } = require('../services/completion-product-defaults');
  const { etDateString, addETDays } = require('../utils/datetime-et');
  test.each([
    ['own current', 'technician', 'tech-7', 'confirmed', 0, 200],
    ['another technician', 'technician', 'tech-9', 'confirmed', 0, 404],
    ['unassigned', 'technician', null, 'confirmed', 0, 404],
    ['cancelled', 'technician', 'tech-7', 'cancelled', 0, 404],
    ['stale', 'technician', 'tech-7', 'confirmed', -8, 404],
    ['recent completed', 'technician', 'tech-7', 'completed', -1, 200],
    ['office', 'admin', 'tech-9', 'cancelled', -8, 200],
  ])('%s', async (_, techRole, technician_id, status, dayOffset, expected) => {
    resolveCompletionProductDefaults.mockClear();
    mockDbCurrent = table => {
      expect(table).toBe('scheduled_services');
      let rows = [{ id: 'svc-1', technician_id, status, scheduled_date: etDateString(addETDays(new Date(), dayOffset)) }];
      const q = {
        where(column, op, value) {
          if (typeof column === 'object') rows = rows.filter(row => Object.entries(column).every(([key, target]) => row[key] === target));
          else {
            const key = column.split('.').pop();
            rows = rows.filter(row => value === undefined ? row[key] === op : row[key] >= value);
          }
          return q;
        },
        whereNotIn(column, values) { rows = rows.filter(row => !values.includes(row[column.split('.').pop()])); return q; },
        first: async () => rows[0],
      };
      return q;
    };
    const result = await invoke({ serviceId: 'svc-1' }, { techRole, technicianId: 'tech-7' }, '/:serviceId/default-products');
    expect(result.statusCode).toBe(expected);
    expect(resolveCompletionProductDefaults).toHaveBeenCalledTimes(expected === 200 ? 1 : 0);
    if (expected === 404) expect(result.body).toEqual({ error: 'Service not found' });
  });

  test('a visit reassigned while defaults resolve is not returned to the former technician', async () => {
    let assigned = 'tech-7';
    resolveCompletionProductDefaults.mockClear();
    resolveCompletionProductDefaults.mockImplementationOnce(async () => { assigned = 'tech-9'; return { products: [{ id: 'p1' }] }; });
    mockDbCurrent = () => {
      let rows = [{ id: 'svc-1', technician_id: assigned, status: 'confirmed', scheduled_date: etDateString(new Date()) }];
      const q = {
        where(column, op, value) {
          if (typeof column === 'object') rows = rows.filter(row => Object.entries(column).every(([key, target]) => row[key] === target));
          else {
            const key = column.split('.').pop();
            rows = rows.filter(row => value === undefined ? row[key] === op : row[key] >= value);
          }
          return q;
        },
        whereNotIn(column, values) { rows = rows.filter(row => !values.includes(row[column.split('.').pop()])); return q; },
        first: async () => rows[0],
      };
      return q;
    };
    const result = await invoke({ serviceId: 'svc-1' }, { techRole: 'technician', technicianId: 'tech-7' }, '/:serviceId/default-products');
    expect(resolveCompletionProductDefaults).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(404);
    expect(result.body).toEqual({ error: 'Service not found' });
  });
});
