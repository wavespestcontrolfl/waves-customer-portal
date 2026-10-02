// Re-service report card payload (GATE_RESERVICE_REPORT_CARD) through the real
// buildReportV1Data: key absent while dark (payload otherwise identical), the
// card built from the words FROZEN on the record at completion, performed vs
// non-performed outcomes, and non-callbacks never carrying it. Synthetic names.

jest.mock('../services/photos', () => ({
  getViewUrl: jest.fn(async (key) => `https://example.test/${key}`),
  CUSTOMER_DWELL_TTL_SECONDS: 3600,
}));

const { buildReportV1Data } = require('../services/service-report/report-data');

// Minimal fixture knex — same shape as report-lawn-next-visit.test.js.
function makeKnex(fixtures = {}) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const q = {};
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (arguments.length === 2) rows = rows.filter((r) => r[a] === b);
        return q;
      },
      andWhere() { return q; },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot() { return q; },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      whereRaw() { return q; },
      orderBy() { return q; },
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}


const ENV = ['GATE_RESERVICE_REPORT_COPY', 'GATE_RESERVICE_REPORT_CARD'];
const ORIGINAL = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

function pestCallback(overrides = {}, frozen = { version: 1, text: 'Ants are back in the kitchen.', source: 'picker', pests: ['ants'] }) {
  return {
    id: 'svc-card-1',
    scheduled_service_id: 'ss-card-1',
    customer_id: 'cust-card',
    service_line: 'pest',
    service_type: 'Pest Control Re-Service',
    service_date: '2026-09-30',
    is_callback: true,
    first_name: 'Test',
    last_name: 'Customer',
    areas_serviced: JSON.stringify(['Inside', 'Outside']),
    client_pest_rating: 2,
    client_pest_rating_source: 'technician',
    client_pest_rating_defaulted: false,
    structured_notes: JSON.stringify({}),
    service_data: JSON.stringify(frozen ? { reserviceRequest: frozen } : {}),
    ...overrides,
  };
}

const fixtures = () => ({
  service_products: [
    { id: 'p1', service_record_id: 'svc-card-1', product_name: 'Test Product', application_method: 'perimeter_spray', targets: JSON.stringify(['Ants', 'Spiders']), created_at: '2026-09-30' },
  ],
  // The record's persisted gauge score: the tech's tap IS the score, and the
  // card's "Activity seen" word is this row's label (Codex r8).
  pest_pressure_scores: [
    { id: 'pps-1', service_record_id: 'svc-card-1', customer_id: 'cust-card', service_line: 'pest', displayed_score: '2.0', calculated_score: '2.0', label_key: 'low', label_name: 'Low' },
  ],
});

function on() {
  process.env.GATE_RESERVICE_REPORT_COPY = 'true';
  process.env.GATE_RESERVICE_REPORT_CARD = 'true';
}

describe('reservice report card payload', () => {
  test('card gate off: the payload has no reserviceReportCard key at all', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    delete process.env.GATE_RESERVICE_REPORT_CARD;
    const data = await buildReportV1Data(pestCallback(), 'tok-card-off', makeKnex(fixtures()));
    expect('reserviceReportCard' in data).toBe(false);
    expect(data.reserviceReport).toBeTruthy();
  });

  test('gate on adds only that key: every other payload key is unchanged', async () => {
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
    delete process.env.GATE_RESERVICE_REPORT_CARD;
    const off = await buildReportV1Data(pestCallback(), 'tok-card-cmp', makeKnex(fixtures()));
    on();
    const withCard = await buildReportV1Data(pestCallback(), 'tok-card-cmp', makeKnex(fixtures()));
    expect(withCard.reserviceReportCard).toBeTruthy();
    const rest = { ...withCard };
    delete rest.reserviceReportCard;
    expect(JSON.parse(JSON.stringify(rest))).toEqual(JSON.parse(JSON.stringify(off)));
  });

  test('no gauge on the report, no pressure word on the card (Codex r12)', async () => {
    on();
    const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
    const hidden = { ...DEFAULT_CONFIG, enabledServiceLines: ['mosquito'] };
    const data = await buildReportV1Data(pestCallback(), 'tok-card-hidden', makeKnex(fixtures()), { pestPressureConfig: hidden });
    expect(data.pestPressure).toBeNull();
    expect(data.reserviceReportCard.whatWeDid.found).toBeNull();
  });

  test('gate on, performed pest callback: frozen words, summary, safety line, still-seeing topic', async () => {
    on();
    const data = await buildReportV1Data(pestCallback(), 'tok-card-1', makeKnex(fixtures()));
    const card = data.reserviceReportCard;
    expect(card.youToldUs).toMatchObject({ source: 'picker', quoted: true, text: 'Ants are back in the kitchen.', pests: ['Ants'] });
    expect(card.whatWeDid).toMatchObject({ pests: ['ants', 'spiders'], where: 'inside and outside' });
    expect(card.whatWeDid.found).toEqual({ rating: 2, label: 'Low' });
    expect(card.whatWeDid.safetyLine).toMatch(/kids and pets/);
    expect(card.stillSeeing).toBe('ants or spiders');
  });

  test('a live edit of the booking never reaches the card (words come from the frozen copy)', async () => {
    on();
    const svc = pestCallback();
    const knex = makeKnex({
      ...fixtures(),
      scheduled_services: [{ id: 'ss-card-1', customer_request: 'EDITED LATER', customer_request_source: 'office', customer_request_pests: ['wasps'] }],
    });
    const data = await buildReportV1Data(svc, 'tok-card-2', knex);
    expect(JSON.stringify(data.reserviceReportCard)).not.toContain('EDITED');
    expect(data.reserviceReportCard.youToldUs.text).toBe('Ants are back in the kitchen.');
  });

  test('no frozen request: no "You told us", the rest of the card still builds', async () => {
    on();
    const data = await buildReportV1Data(pestCallback({}, null), 'tok-card-3', makeKnex(fixtures()));
    expect(data.reserviceReportCard.youToldUs).toBeNull();
    expect(data.reserviceReportCard.whatWeDid).toBeTruthy();
  });

  test('inspection_only callback: no "What we did", "You told us" still shows', async () => {
    on();
    const svc = pestCallback({
      service_data: JSON.stringify({
        protocol: { visitOutcome: 'inspection_only' },
        reserviceRequest: { version: 1, text: 'Ants are back in the kitchen.', source: 'text', pests: [] },
      }),
    });
    const data = await buildReportV1Data(svc, 'tok-card-4', makeKnex(fixtures()));
    expect(data.reserviceReport.outcome).toBe('inspection_only');
    expect(data.reserviceReportCard.whatWeDid).toBeNull();
    expect(data.reserviceReportCard.youToldUs).toMatchObject({ quoted: true });
  });

  test('not a callback: no card even with the gates on', async () => {
    on();
    const data = await buildReportV1Data(pestCallback({ is_callback: false }), 'tok-card-5', makeKnex(fixtures()));
    expect('reserviceReportCard' in data).toBe(false);
  });

  test('copy gate off: no card (it hangs off the reserviceReport block)', async () => {
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    process.env.GATE_RESERVICE_REPORT_CARD = 'true';
    const data = await buildReportV1Data(pestCallback(), 'tok-card-6', makeKnex(fixtures()));
    expect('reserviceReportCard' in data).toBe(false);
  });
});
