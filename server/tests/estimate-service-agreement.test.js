/**
 * The residential service agreement on the accepted estimate page (GATE_ESTIMATE_SERVICE_AGREEMENT): which lanes a
 * plan carries, the per-lane state, and the issuer that puts the agreement in front of the customer.
 * Invariants: pest-family and lawn-family recurring lines map to their lane; termite, commercial and one-time-only
 * estimates get nothing; signed wins over awaiting; one open agreement per estimate and lane (a repeat returns it with
 * a fresh link, unless it would read differently now); the estimate row is never written; no account and an already
 * signed agreement are distinct answers. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn().mockResolvedValue(undefined) }));

const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  SNAPSHOT_SOURCE, LANES, START_DATE_TEXT, estimateServiceAgreementLanes, laneServiceName, laneState, serviceAgreementCtaFor,
  ensureEstimateServiceAgreement,
} = require('../services/estimate-service-agreement');

const req = { ip: '203.0.113.9', get: () => 'jest-agent' };
const PEST_KEY = LANES.pest.templateKey;
const LAWN_KEY = LANES.lawn.templateKey;
const TEMPLATES = {
  [PEST_KEY]: { id: 'tpl-pest', template_key: PEST_KEY, status: 'active', active_version_id: 'ver-pest', requires_signature: true, expire_after_days: 14, name: 'Residential Pest Service Agreement' },
  [LAWN_KEY]: { id: 'tpl-lawn', template_key: LAWN_KEY, status: 'active', active_version_id: 'ver-lawn', requires_signature: true, expire_after_days: 14, name: 'Lawn & Ornamental Service Agreement' },
};
const VERSIONS = {
  'ver-pest': { id: 'ver-pest', template_id: 'tpl-pest', version_number: 1, title: 'Residential Pest Service Agreement', body: 'Customer: {{customer.name}}\nService address: {{customer.address}}\nService plan: {{service.name}}\nStart date: {{agreement.start_date}}', signer_disclosure: 'I agree to sign electronically.' },
  'ver-lawn': { id: 'ver-lawn', template_id: 'tpl-lawn', version_number: 1, title: 'Lawn & Ornamental Service Agreement', body: 'Customer: {{customer.name}}\nPlan: {{service.name}}\nStart: {{agreement.start_date}}', signer_disclosure: 'I agree to sign electronically.' },
};
const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Owner', email: 'pat@example.com', phone: '+19415550100', address_line1: '12 Test Lane', city: 'Bradenton', state: 'FL', zip: '34205', active: true };

// Estimate rows with the real estimate_data shapes the public page reads.
const estimate = (recurring = [], oneTime = [], extra = {}) => ({
  id: 'est-1', customer_id: 'cust-1', status: 'accepted', accepted_frequency_key: 'quarterly', address: '12 Test Lane, Bradenton, FL 34205',
  estimate_data: { result: { recurring: { services: recurring }, oneTime: { items: oneTime } } },
  ...extra,
});
const PEST = { service: 'pest_control', name: 'Pest Control', monthly: 50 };
const MOSQUITO = { service: 'mosquito', name: 'Mosquito Control', monthly: 60 };
const LAWN = { service: 'lawn_care', name: 'Lawn Care', monthly: 90 };
const TREE = { service: 'tree_shrub', name: 'Tree & Shrub Care', monthly: 45 };

describe('estimateServiceAgreementLanes', () => {
  test.each([
    ['a pest plan', estimate([PEST]), ['pest']],
    ['a mosquito plan', estimate([MOSQUITO]), ['pest']],
    ['a rodent bait plan named only by its label', estimate([{ name: 'Rodent Bait Station Monitoring' }]), ['pest']],
    ['a lawn plan', estimate([LAWN]), ['lawn']],
    ['a tree & shrub plan', estimate([TREE]), ['lawn']],
    ['a palm injection program', estimate([{ service: 'palm_injection', name: 'Palm Injection' }]), ['lawn']],
    ['a pest + lawn bundle, pest first', estimate([LAWN, PEST, TREE]), ['pest', 'lawn']],
    ['an engine-invocation pest result', { estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest Control', annual: 480 }] } } }, ['pest']],
    ['estimate data stored as a JSON string', { estimate_data: JSON.stringify({ result: { recurring: { services: [LAWN] } } }) }, ['lawn']],
    ['a mixed estimate accepted as the recurring plan', estimate([PEST], [{ service: 'pest_cleanout', name: 'One-Time Cleanout', price: 250 }], { accepted_service_mode: 'recurring' }), ['pest']],
    ['an accept that predates accepted_service_mode', estimate([PEST], [], { accepted_service_mode: null }), ['pest']],
  ])('%s', (_label, row, lanes) => {
    expect(estimateServiceAgreementLanes(row)).toEqual(lanes);
  });

  test.each([
    ['a termite bait program (its own agreement)', estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }])],
    ['a one-time-only estimate', estimate([], [{ service: 'pest_cleanout', name: 'One-Time Cleanout', price: 250 }])],
    ['an authored commercial proposal', estimate([PEST], [], { estimate_data: { proposal: { enabled: true }, result: { recurring: { services: [PEST] } } } })],
    ['an auto-priced commercial estimate', estimate([{ service: 'commercial_pest', name: 'Commercial Pest Control' }])],
    ['a commercial lawn line beside a residential one', estimate([LAWN, { service: 'commercial_lawn', name: 'Commercial Turf' }])],
    ['an estimate with no data', { estimate_data: {} }],
    ['a mixed estimate accepted as one-time service (its quoted plan was not bought)', estimate([PEST, LAWN], [{ service: 'pest_cleanout', name: 'One-Time Cleanout', price: 250 }], { accepted_service_mode: 'one_time' })],
  ])('%s gets no agreement', (_label, row) => {
    expect(estimateServiceAgreementLanes(row)).toEqual([]);
  });
});

describe('laneServiceName', () => {
  test('names the lane\'s recurring lines and never a cadence (a bundle\'s accepted frequency is the pest cadence, not the lawn program\'s)', () => {
    expect(laneServiceName(estimate([LAWN, PEST, MOSQUITO, TREE]), 'pest')).toBe('Pest Control + Mosquito Control');
    expect(laneServiceName(estimate([LAWN, PEST, TREE], [], { accepted_frequency_key: 'quarterly' }), 'lawn')).toBe('Lawn Care + Tree & Shrub Care');
    expect(laneServiceName(estimate([PEST], [], { accepted_frequency_key: null }), 'pest')).toBe('Pest Control');
  });
});

// A tiny in-memory stand-in for the tables the service touches.
function makeDb({ contracts = [], visits = [], customer = CUSTOMER, templates = TEMPLATES, versions = VERSIONS, estimateRow = undefined } = {}) {
  const state = { contracts: contracts.map((c) => ({ ...c })), events: [], writes: [], locks: [] };
  const make = (table) => {
    const q = { where: {}, statusIn: null, statusNotIn: null, raw: [] };
    const api = {
      where(obj) { Object.assign(q.where, obj); return api; },
      whereNull() { return api; },
      whereNotNull() { return api; },
      whereIn(col, vals) { if (col === 'status') q.statusIn = vals; return api; },
      whereNotIn(col, vals) { if (col === 'status') q.statusNotIn = vals; return api; },
      whereRaw(sql, binds) { q.raw.push({ sql, value: binds[0] }); return api; },
      orderByRaw() { return api; },
      orderBy() { return api; },
      forUpdate() { state.locks.push(table); return api; },
      limit() { return api; },
      matching() {
        return state.contracts
          .filter((c) => c.document_template_key === q.where.document_template_key)
          .filter((c) => !q.where.customer_id || c.customer_id === q.where.customer_id)
          .filter((c) => !q.statusIn || q.statusIn.includes(c.status))
          .filter((c) => !q.statusNotIn || !q.statusNotIn.includes(c.status))
          .filter((c) => q.raw.every(({ sql, value }) => (sql.includes("'id'") ? String(c.document_variables_snapshot?.estimate?.id) === String(value) : c.document_variables_snapshot?.estimate?.source === value)))
          .sort((a, b) => (b.status === 'signed') - (a.status === 'signed'));
      },
      async first() {
        if (table === 'document_templates') return templates[q.where.template_key] || Object.values(templates).find((t) => t.id === q.where.id) || null;
        if (table === 'document_template_versions') return versions[q.where.id] || null;
        if (table === 'customers') return customer;
        if (table === 'estimates') return estimateRow === undefined ? estimate([PEST, LAWN]) : estimateRow;
        if (table === 'scheduled_services') return visits.find((v) => v.source_estimate_id === q.where.source_estimate_id) || null;
        if (table === 'customer_contracts') return api.matching()[0] || null;
        return null;
      },
      async update(payload) {
        state.writes.push({ table, op: 'update', payload });
        const row = state.contracts.find((c) => c.id === q.where.id && (!q.statusIn || q.statusIn.includes(c.status)));
        if (!row) return 0;
        Object.assign(row, payload);
        return 1;
      },
      insert(row) {
        state.writes.push({ table, op: 'insert', payload: row });
        const stored = { id: `contract-${state.contracts.length + 1}`, created_at: new Date(), ...row };
        if (table === 'customer_contracts') {
          stored.document_variables_snapshot = JSON.parse(typeof row.document_variables_snapshot === 'string' ? row.document_variables_snapshot : JSON.stringify(row.document_variables_snapshot));
          state.contracts.push(stored);
        }
        if (table === 'customer_contract_events') state.events.push(row);
        const result = Promise.resolve([1]);
        result.returning = async () => [stored];
        return result;
      },
    };
    return api;
  };
  const database = (table) => make(table);
  database.transaction = async (cb) => cb(database);
  database.raw = (s) => s;
  return { database, state };
}

const openAgreement = (lane = 'pest', extra = {}) => ({
  id: `contract-open-${lane}`, customer_id: 'cust-1', document_template_key: LANES[lane].templateKey, contract_type: 'document_template', status: 'sent',
  document_template_version_id: lane === 'pest' ? 'ver-pest' : 'ver-lawn',
  document_variables_snapshot: { estimate: { id: 'est-1', source: SNAPSHOT_SOURCE, lane } }, contract_text_snapshot: 'stale text', ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_ESTIMATE_SERVICE_AGREEMENT = 'true';
});
afterAll(() => { delete process.env.GATE_ESTIMATE_SERVICE_AGREEMENT; });

describe('laneState and serviceAgreementCtaFor', () => {
  test('nothing on the payload for an estimate without a lane', async () => {
    const { database } = makeDb();
    expect(await serviceAgreementCtaFor(estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }]), database)).toBeNull();
    // A mixed estimate accepted as one-time service: its quoted plan was never bought, so nothing is offered.
    expect(await serviceAgreementCtaFor(estimate([PEST], [{ service: 'pest_cleanout', name: 'One-Time Cleanout', price: 250 }], { accepted_service_mode: 'one_time' }), database)).toBeNull();
  });

  test('one entry per lane with its state; signed wins over awaiting and cannot be signed again', async () => {
    const { database } = makeDb({ contracts: [openAgreement('pest'), openAgreement('pest', { id: 'contract-signed', status: 'signed', signed_at: new Date('2026-10-20T12:00:00Z') })] });
    expect(await laneState('est-1', 'pest', database)).toMatchObject({ state: 'signed', contractId: 'contract-signed' });
    expect(await laneState('est-1', 'lawn', database)).toEqual({ state: 'none' });
    expect(await serviceAgreementCtaFor(estimate([PEST, LAWN]), database)).toEqual([
      { lane: 'pest', title: 'Residential Pest Service Agreement', state: 'signed', canSign: false },
      { lane: 'lawn', title: 'Lawn & Ornamental Service Agreement', state: 'none', canSign: true },
    ]);
  });

  test('an open agreement for another estimate or issued by hand is not this estimate\'s', async () => {
    const { database } = makeDb({ contracts: [
      openAgreement('pest', { document_variables_snapshot: { estimate: { id: 'est-other', source: SNAPSHOT_SOURCE, lane: 'pest' } } }),
      openAgreement('pest', { id: 'by-hand', document_variables_snapshot: {} }),
    ] });
    expect(await laneState('est-1', 'pest', database)).toEqual({ state: 'none' });
  });

  test.each(['cancelled', 'expired', 'voided'])('a %s agreement reads as none', async (status) => {
    const { database } = makeDb({ contracts: [openAgreement('pest', { status })] });
    expect(await laneState('est-1', 'pest', database)).toEqual({ state: 'none' });
  });

  test('an estimate with no customer account cannot sign (call us)', async () => {
    const { database } = makeDb();
    expect(await serviceAgreementCtaFor(estimate([PEST], [], { customer_id: null }), database)).toEqual([
      { lane: 'pest', title: 'Residential Pest Service Agreement', state: 'none', canSign: false, reason: 'no_account' },
    ]);
  });

  test('the payload read fails soft', async () => {
    const { database } = makeDb();
    database.transaction = undefined;
    const broken = (table) => { if (table === 'customer_contracts') throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); return database(table); };
    expect(await serviceAgreementCtaFor(estimate([PEST]), broken)).toBeNull();
  });
});

describe('ensureEstimateServiceAgreement', () => {
  const bundle = estimate([PEST, LAWN]);

  test('creates ONE agreement for the lane from the active template version, with the plan name and first visit, never writing the estimate', async () => {
    const { database, state } = makeDb({ visits: [{ source_estimate_id: 'est-1', scheduled_date: '2026-11-03' }] });
    const result = await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'pest', req, conn: database });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(result.signingUrl).toMatch(/\/contract\/[A-Za-z0-9_-]{20,}$/);

    expect(state.contracts).toHaveLength(1);
    const [row] = state.contracts;
    expect(row).toMatchObject({
      customer_id: 'cust-1', contract_type: 'document_template', document_template_key: PEST_KEY, document_template_version_id: 'ver-pest',
      status: 'sent', title: 'Residential Pest Service Agreement', service_name: 'Pest Control',
    });
    expect(row.contract_text_snapshot).toContain('Customer: Pat Owner');
    expect(row.contract_text_snapshot).toContain('Service address: 12 Test Lane, Bradenton FL 34205');
    expect(row.contract_text_snapshot).toContain('Service plan: Pest Control\n');
    expect(row.contract_text_snapshot).toMatch(/Start date: November 3, 2026/);
    expect(row.document_variables_snapshot.estimate).toEqual({ id: 'est-1', source: SNAPSHOT_SOURCE, lane: 'pest' });
    expect(state.events.map((e) => e.event_type)).toEqual(['created_from_document_template', 'share_link_created']);
    expect(state.writes.filter((w) => w.table === 'estimates')).toEqual([]);
    expect(lockCustomerComms).toHaveBeenCalledWith(database, 'cust-1');
    // Lock order: customers, then the estimate, then the template version, then contracts.
    expect(state.locks.slice(0, 2)).toEqual(['customers', 'estimates']);
  });

  test('the lawn lane renders the lawn agreement; no booked visit prints the standing start text', async () => {
    const { database, state } = makeDb();
    const result = await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'lawn', req, conn: database });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(state.contracts[0]).toMatchObject({ document_template_key: LAWN_KEY, title: 'Lawn & Ornamental Service Agreement', service_name: 'Lawn Care' });
    expect(state.contracts[0].contract_text_snapshot).toContain(`Start: ${START_DATE_TEXT}`);
  });

  test('the account address is used when it exists; the estimate\'s service address stands in when it does not', async () => {
    const { database, state } = makeDb({ customer: { ...CUSTOMER, address_line1: null, city: null, zip: null } });
    await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'pest', req, conn: database });
    expect(state.contracts[0].contract_text_snapshot).toContain('Service address: 12 Test Lane, Bradenton, FL 34205, FL');
  });

  test('a repeat returns the same open agreement with a fresh link when it reads the same', async () => {
    const first = makeDb();
    await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'pest', req, conn: first.database });
    const [issued] = first.state.contracts;
    const { database, state } = makeDb({ contracts: [{ ...issued, status: 'viewed' }] });
    const result = await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'pest', req, conn: database });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(state.contracts).toHaveLength(1);
    expect(state.contracts[0].status).toBe('sent');
    expect(state.contracts[0].share_token_hash).not.toBe(issued.share_token_hash);
    expect(state.events.map((e) => e.event_type)).toEqual(['share_link_created']);
  });

  test('an open agreement that would read differently now is cancelled and replaced', async () => {
    const { database, state } = makeDb({ contracts: [openAgreement('pest')] });
    const result = await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'pest', req, conn: database });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(state.contracts.map((c) => c.status)).toEqual(['cancelled', 'sent']);
    expect(state.contracts[0]).toMatchObject({ cancelled_reason: expect.stringMatching(/^Superseded/), share_token_hash: null });
    expect(state.events.map((e) => e.event_type)).toEqual(['cancelled', 'created_from_document_template', 'share_link_created']);
  });

  test('a signed agreement for the lane is final', async () => {
    const { database, state } = makeDb({ contracts: [openAgreement('pest', { status: 'signed' })] });
    const result = await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'pest', req, conn: database });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'already_signed' });
    expect(state.writes).toEqual([]);
  });

  test.each([
    ['no customer account', { estimate: { ...bundle, customer_id: null } }, { status: 409, code: 'no_account' }],
    ['an unknown lane', { estimate: bundle, lane: 'termite' }, { status: 404, code: 'not_available' }],
    ['an inactive customer', { estimate: bundle, customer: { ...CUSTOMER, active: false } }, { status: 409, code: 'customer_unavailable' }],
    ['the estimate reassigned to another customer under lock', { estimate: bundle, estimateRow: { ...bundle, customer_id: 'cust-2' } }, { status: 404, code: 'not_available' }],
    ['a revision that removed the lane under lock', { estimate: bundle, estimateRow: estimate([LAWN]) }, { status: 404, code: 'not_available' }],
    ['the route\'s re-check saying the estimate closed', { estimate: bundle, blockedFor: async () => true }, { status: 404, code: 'not_available' }],
    ['no active template version', { estimate: bundle, templates: { ...TEMPLATES, [PEST_KEY]: { ...TEMPLATES[PEST_KEY], active_version_id: null } } }, { status: 409, code: 'template_unavailable' }],
  ])('%s refuses and writes nothing', async (_label, { estimate: row, lane = 'pest', blockedFor, ...dbOpts }, expected) => {
    const { database, state } = makeDb(dbOpts);
    const result = await ensureEstimateServiceAgreement({ estimate: row, lane, req, conn: database, blockedFor });
    expect(result).toMatchObject({ ok: false, ...expected });
    expect(state.writes).toEqual([]);
  });

  test('a merge value the template needs but the data lacks refuses (the customer never sees {{...}})', async () => {
    const { database, state } = makeDb({ customer: { ...CUSTOMER, first_name: '', last_name: '', company_name: '' }, versions: { ...VERSIONS, 'ver-pest': { ...VERSIONS['ver-pest'], body: 'Email: {{customer.email}} Phone: {{inspection.date}}' } } });
    const result = await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'pest', req, conn: database });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'template_unavailable' });
    expect(state.writes).toEqual([]);
  });

  test('the gate thrown while the locks were held writes nothing', async () => {
    const { database, state } = makeDb();
    const blockedFor = async () => { delete process.env.GATE_ESTIMATE_SERVICE_AGREEMENT; return false; };
    const result = await ensureEstimateServiceAgreement({ estimate: bundle, lane: 'pest', req, conn: database, blockedFor });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });
});
