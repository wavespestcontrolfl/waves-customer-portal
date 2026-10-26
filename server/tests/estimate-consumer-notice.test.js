/**
 * The Florida consumer notice on the estimate page (GATE_ESTIMATE_CONSUMER_NOTICE, Rule 5E-14.105(1)): which
 * estimates need the FDACS-13692, the customer's state, and the issuer that puts the form in front of them.
 * Invariants: any termite-family line counts (a pest plan with a Bora-Care add-on too); signed wins over awaiting;
 * one open notice per customer (a repeat returns it with a fresh link, unless it would read differently now); the
 * estimate row is never written; no account, no representative and an already-signed notice are distinct answers.
 * Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/consumer-notices', () => ({
  ...jest.requireActual('../services/consumer-notices'),
  findConsumerNotice: jest.fn(),
}));
jest.mock('../services/document-contract-delivery', () => ({ deliverDocumentRequestChannels: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn().mockResolvedValue({ id: 'alert-1' }),
}));

const { findConsumerNotice, CONSUMER_NOTICE_TEMPLATE_KEY } = require('../services/consumer-notices');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { deliverDocumentRequestChannels } = require('../services/document-contract-delivery');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { TEMPLATE: SEED } = require('../models/migrations/20261024140000_seed_fdacs_13692_consumer_notice');
const {
  SNAPSHOT_SOURCE, MANUAL_ACCEPT_SOURCE, estimateNeedsConsumerNotice, consumerNoticeState, consumerNoticeCtaFor, consumerNoticeBlocksAccept,
  ensureEstimateConsumerNotice, sendManualAcceptConsumerNotice,
} = require('../services/estimate-consumer-notice');

const req = { ip: '203.0.113.9', get: () => 'jest-agent' };
const TEMPLATE = { id: 'tpl-13692', template_key: CONSUMER_NOTICE_TEMPLATE_KEY, status: 'active', active_version_id: 'ver-1', requires_signature: true, expire_after_days: 14, name: SEED.name };
const VERSION = { id: 'ver-1', template_id: 'tpl-13692', version_number: 1, title: SEED.title, body: SEED.body, signer_disclosure: 'I agree to sign electronically.' };
const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Owner', email: 'pat@example.com', phone: '+19415550100', address_line1: '12 Test Lane', active: true };

const etToday = () => {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()).split('-');
  return `${m}/${d}/${y}`;
};

// Estimate rows with the real estimate_data shapes the public page reads.
const estimate = (recurring = [], oneTime = [], extra = {}) => ({
  id: 'est-1', customer_id: 'cust-1', status: 'sent', created_by_technician_id: 'tech-1',
  estimate_data: { result: { recurring: { services: recurring }, oneTime: { items: oneTime } } },
  ...extra,
});
const PEST = { service: 'pest_control', name: 'Pest Control' };

describe('estimateNeedsConsumerNotice', () => {
  test.each([
    ['a recurring termite bait line', estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }])],
    ['a bait line named only by its label', estimate([{ name: 'Termite Bait Station Monitoring' }])],
    ['a recurring foam line', estimate([{ service: 'foam_recurring', name: 'Recurring Termite Foam Service' }])],
    ['a commercial termite bait monitoring line', estimate([{ service: 'commercial_termite_bait', name: 'Commercial Termite Bait Monitoring' }])],
    ['a one-time trenching line', estimate([], [{ service: 'termite_trenching', name: 'Termite Trenching', price: 1500 }])],
    ['a liquid barrier line named only by its label', estimate([], [{ name: 'Liquid Termite Barrier Treatment', price: 1500 }])],
    ['a pre-slab line', estimate([], [{ service: 'pre_slab_termiticide', name: 'Pre-Slab Termiticide', price: 900 }])],
    ['a one-time foam line', estimate([], [{ service: 'termite_foam', name: 'Termite Foam Treatment', price: 300 }])],
    ['a Bora-Care add-on on a pest plan', estimate([PEST], [{ service: 'bora_care', name: 'Bora-Care Attic Treatment', price: 900 }])],
    // engineInputs-only estimates: the engine replay is the only place their one-time lines exist (the page shows them).
    ['an inputs-only pest plan with one-time trenching', { estimate_data: { engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services: { pest: { frequency: 'quarterly' }, trenching: { perimeterLF: 240 } } } } }],
    ['an inputs-only trenching quote with no recurring line', { estimate_data: { engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services: { trenching: { perimeterLF: 240 } } } } }],
    ['a bait line inside an engine-invocation result', { estimate_data: { engineResult: { lineItems: [{ service: 'termite_bait', name: 'Termite Bait Stations', annual: 480 }] } } }],
    ['estimate data stored as a JSON string', { estimate_data: JSON.stringify({ result: { recurring: { services: [{ name: 'Termite Bait Stations' }] } } }) }],
  ])('%s needs the notice', (_label, row) => {
    expect(estimateNeedsConsumerNotice(row)).toBe(true);
  });

  test.each([
    ['a pest-only estimate', estimate([PEST])],
    ['a pest plan with its WaveGuard setup fee', estimate([PEST], [{ service: 'waveguard_setup', name: 'WaveGuard Setup', price: 99 }])],
    ['a lawn-only estimate', estimate([{ service: 'lawn_care', name: 'Lawn Care' }])],
    ['a commercial rodent bait line (not a termite treatment)', estimate([{ service: 'commercial_rodent_bait', name: 'Commercial Rodent Bait Stations' }])],
    ['a WDO inspection (an inspection is not a treatment)', estimate([], [{ service: 'wdo_inspection', name: 'WDO Inspection', price: 150 }])],
    ['an inputs-only pest plan', { estimate_data: { engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services: { pest: { frequency: 'quarterly' } } } } }],
    ['an engine-invocation pest result', { estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest Control', annual: 480 }] } } }],
    ['an estimate with no data', { estimate_data: {} }],
  ])('%s does not', (_label, row) => {
    expect(estimateNeedsConsumerNotice(row)).toBe(false);
  });

  test('an explicit estData wins over the row (the caller may pass the data it already parsed)', () => {
    expect(estimateNeedsConsumerNotice({}, estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }]).estimate_data)).toBe(true);
  });
});

// A tiny in-memory stand-in for the tables the service touches.
// `estimateRow` is the estimate the issuer reads under lock (default: the termite estimate the tests pass in).
function makeDb({ contracts = [], technicians = [], customer = CUSTOMER, template = TEMPLATE, version = VERSION, estimateRow = undefined } = {}) {
  const state = { contracts: contracts.map((c) => ({ ...c })), events: [], writes: [], techQueries: [], locks: [] };
  const make = (table) => {
    const q = { where: {}, statusIn: null, source: undefined };
    const api = {
      where(obj) { Object.assign(q.where, obj); return api; },
      whereNull() { return api; },
      whereIn(col, vals) { if (col === 'status') q.statusIn = vals; return api; },
      whereRaw(_sql, binds) { q.source = binds[0]; return api; },
      orderByRaw() { return api; },
      orderBy() { return api; },
      forUpdate() { state.locks.push(table); return api; },
      limit() { return api; },
      async select() {
        if (table === 'technicians') { state.techQueries.push(q.where); return technicians.filter((t) => t.role === q.where.role && t.active && t.employment_status === 'active'); }
        return [];
      },
      async first() {
        if (table === 'document_templates') return q.where.template_key ? template : { active_version_id: template.active_version_id, status: template.status, template_key: template.template_key };
        if (table === 'document_template_versions') return version;
        if (table === 'customers') return customer;
        if (table === 'estimates') return estimateRow === undefined ? estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }]) : estimateRow;
        if (table === 'technicians') {
          state.techQueries.push(q.where);
          return technicians.find((t) => t.id === q.where.id && t.active === q.where.active && t.employment_status === q.where.employment_status) || null;
        }
        if (table === 'customer_contracts') {
          return state.contracts
            .filter((c) => c.customer_id === q.where.customer_id && c.document_template_key === q.where.document_template_key)
            .filter((c) => !q.statusIn || q.statusIn.includes(c.status))
            .filter((c) => q.source === undefined || c.document_variables_snapshot?.estimate?.source === q.source)[0] || null;
        }
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
        // jsonb() hands back a raw value for the real driver; the fake reads it back as the object it was built from.
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

const TECH = { id: 'tech-1', name: 'Terry Tech', role: 'technician', active: true, employment_status: 'active' };
const ADMIN = { id: 'admin-1', name: 'Alex Admin', role: 'admin', active: true, employment_status: 'active' };
const openNotice = (extra = {}) => ({
  id: 'contract-open', customer_id: 'cust-1', document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY, contract_type: 'document_template', status: 'sent',
  document_variables_snapshot: { estimate: { id: 'est-1', source: SNAPSHOT_SOURCE } }, contract_text_snapshot: 'stale text', ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_ESTIMATE_CONSUMER_NOTICE = 'true';
  findConsumerNotice.mockResolvedValue(null);
});
afterAll(() => { delete process.env.GATE_ESTIMATE_CONSUMER_NOTICE; });

describe('consumerNoticeState', () => {
  test('signed when a notice is on file dated on or before today (Eastern)', async () => {
    findConsumerNotice.mockResolvedValue({ source: 'esign', id: 'c1', signedOn: '10/01/2026' });
    const { database } = makeDb({ contracts: [openNotice()] });
    expect(await consumerNoticeState('cust-1', database)).toBe('signed');
    expect(findConsumerNotice).toHaveBeenCalledWith(database, 'cust-1', { onOrBefore: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  test('awaiting when an open Document Request exists and nothing is signed', async () => {
    const { database } = makeDb({ contracts: [openNotice({ status: 'viewed' })] });
    expect(await consumerNoticeState('cust-1', database)).toBe('awaiting');
  });

  test.each(['signed', 'cancelled', 'expired', 'voided'])('a %s Document Request alone is none (signed ones are read by findConsumerNotice)', async (status) => {
    const { database } = makeDb({ contracts: [openNotice({ status })] });
    expect(await consumerNoticeState('cust-1', database)).toBe('none');
  });

  test('none without any notice', async () => {
    const { database } = makeDb();
    expect(await consumerNoticeState('cust-1', database)).toBe('none');
  });
});

describe('consumerNoticeCtaFor and consumerNoticeBlocksAccept', () => {
  const termite = estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }]);

  test('no termite line: nothing on the payload and nothing blocks', async () => {
    const { database } = makeDb();
    expect(await consumerNoticeCtaFor(estimate([PEST]), database)).toBeNull();
    expect(await consumerNoticeBlocksAccept(estimate([PEST]), database)).toBe(false);
  });

  test('a termite line reports the state; only a signed notice stops blocking', async () => {
    const { database } = makeDb();
    expect(await consumerNoticeCtaFor(termite, database)).toEqual({ state: 'none', canSign: true });
    expect(await consumerNoticeBlocksAccept(termite, database)).toBe(true);
    const awaiting = makeDb({ contracts: [openNotice()] });
    expect(await consumerNoticeCtaFor(termite, awaiting.database)).toEqual({ state: 'awaiting', canSign: true });
    findConsumerNotice.mockResolvedValue({ source: 'paper', id: 'p1', signedOn: '10/01/2026' });
    expect(await consumerNoticeCtaFor(termite, database)).toEqual({ state: 'signed', canSign: false });
    expect(await consumerNoticeBlocksAccept(termite, database)).toBe(false);
  });

  test('an estimate with no customer account cannot sign (call us) and cannot accept', async () => {
    const { database } = makeDb();
    const orphan = { ...termite, customer_id: null };
    expect(await consumerNoticeCtaFor(orphan, database)).toEqual({ state: 'none', canSign: false, reason: 'no_account' });
    expect(await consumerNoticeBlocksAccept(orphan, database)).toBe(true);
  });

  test('the payload read fails soft, the accept check fails closed', async () => {
    findConsumerNotice.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    const { database } = makeDb();
    expect(await consumerNoticeCtaFor(termite, database)).toBeNull();
    await expect(consumerNoticeBlocksAccept(termite, database)).rejects.toThrow('db down');
  });
});

describe('ensureEstimateConsumerNotice', () => {
  const termite = estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }]);

  test('creates ONE notice from the active template version, names the creator, never writes the estimate', async () => {
    const { database, state } = makeDb({ technicians: [TECH, ADMIN] });
    const result = await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(result.signingUrl).toMatch(/\/contract\/[A-Za-z0-9_-]{20,}$/);

    expect(state.contracts).toHaveLength(1);
    const [row] = state.contracts;
    expect(row).toMatchObject({
      customer_id: 'cust-1', contract_type: 'document_template', status: 'sent', document_template_key: CONSUMER_NOTICE_TEMPLATE_KEY,
      document_template_id: 'tpl-13692', document_template_version_id: 'ver-1', requires_signature_snapshot: true,
      recipient_name: 'Pat Owner', service_name: 'Florida consumer notice (FDACS-13692)',
    });
    expect(row.share_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.shared_at).toBeInstanceOf(Date);
    expect(row.contract_text_snapshot).toContain('Print Name of Consumer: Pat Owner');
    expect(row.contract_text_snapshot).toContain('Print Name of Pest Control Representative: Terry Tech');
    expect(row.contract_text_snapshot).toContain(`Date: ${etToday()}`);
    expect(row.document_variables_snapshot.estimate).toEqual({ id: 'est-1', source: SNAPSHOT_SOURCE });
    // The marker carries the estimate id, never the estimate token.
    expect(JSON.stringify(row.document_variables_snapshot)).not.toMatch(/token/i);
    expect(state.events.map((e) => e.event_type)).toEqual(['created_from_document_template', 'share_link_created']);
    expect(state.writes.filter((w) => w.table === 'estimates')).toEqual([]);
    expect(lockCustomerComms).toHaveBeenCalledWith(expect.anything(), 'cust-1');
  });

  test('locks in the order every customer contact write takes: customer, estimate, then the contracts', async () => {
    const { database, state } = makeDb({ technicians: [TECH] });
    await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(state.locks.slice(0, 2)).toEqual(['customers', 'estimates']);
    expect(state.locks.indexOf('customer_contracts')).toBeGreaterThan(state.locks.indexOf('estimates'));
  });

  test('the estimate locked here decides: reassigned to another customer, it issues nothing', async () => {
    const { database, state } = makeDb({ technicians: [TECH], estimateRow: { ...termite, customer_id: 'cust-2' } });
    await expect(ensureEstimateConsumerNotice({ estimate: termite, req, conn: database })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });

  test('the route\'s eligibility re-run on the locked row (declined, archived, call-side block) stops the issue', async () => {
    const { database, state } = makeDb({ technicians: [TECH] });
    const blockedFor = jest.fn().mockResolvedValue(true);
    await expect(ensureEstimateConsumerNotice({ estimate: termite, req, conn: database, blockedFor })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(blockedFor).toHaveBeenCalledWith(database, expect.objectContaining({ id: 'est-1' }));
    expect(state.writes).toEqual([]);
  });

  test('a revision that removed the termite line before the lock issues nothing', async () => {
    const { database, state } = makeDb({ technicians: [TECH], estimateRow: estimate([PEST]) });
    await expect(ensureEstimateConsumerNotice({ estimate: termite, req, conn: database })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });

  test('a missing locked estimate issues nothing', async () => {
    const { database, state } = makeDb({ technicians: [TECH], estimateRow: null });
    await expect(ensureEstimateConsumerNotice({ estimate: termite, req, conn: database })).resolves.toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });

  test('the link is stored as a hash only, and the same open notice comes back with a fresh link', async () => {
    const { database, state } = makeDb({ technicians: [TECH] });
    const first = await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    const hashAfterFirst = state.contracts[0].share_token_hash;
    const second = await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(second).toMatchObject({ ok: true, status: 200 });
    expect(state.contracts).toHaveLength(1);
    expect(state.contracts[0].share_token_hash).not.toBe(hashAfterFirst);
    expect(second.signingUrl).not.toBe(first.signingUrl);
    expect(first.signingUrl).not.toContain(hashAfterFirst);
    expect(state.events.filter((e) => e.event_type === 'share_link_created')).toHaveLength(2);
  });

  test('an open notice that would read differently now is cancelled and replaced', async () => {
    const { database, state } = makeDb({ technicians: [TECH], contracts: [openNotice()] });
    const result = await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(state.contracts.find((c) => c.id === 'contract-open')).toMatchObject({ status: 'cancelled', share_token_hash: null });
    expect(state.contracts).toHaveLength(2);
    expect(state.events.map((e) => e.event_type)).toEqual(['cancelled', 'created_from_document_template', 'share_link_created']);
  });

  test('a newer form version with the same text is not reused: the old notice is cancelled and replaced', async () => {
    // First issue on version 1, then the open row is read back as if it were still on an older version.
    const first = makeDb({ technicians: [TECH] });
    await ensureEstimateConsumerNotice({ estimate: termite, req, conn: first.database });
    const [issued] = first.state.contracts;
    const { database, state } = makeDb({ technicians: [TECH], contracts: [{ ...issued, id: 'contract-old', document_template_version_id: 'ver-0' }] });
    const result = await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(state.contracts.find((c) => c.id === 'contract-old')).toMatchObject({ status: 'cancelled' });
    expect(state.contracts.filter((c) => c.status === 'sent')).toHaveLength(1);
    expect(state.contracts.find((c) => c.status === 'sent').document_template_version_id).toBe('ver-1');
  });

  test('a notice staff issued by hand (no estimate marker) is never re-linked', async () => {
    const staffRow = openNotice({ id: 'staff-issued', document_variables_snapshot: { issuer: { name: 'Pat Office' } } });
    const { database, state } = makeDb({ technicians: [TECH], contracts: [staffRow] });
    const result = await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(state.contracts.find((c) => c.id === 'staff-issued')).toMatchObject({ status: 'sent' });
    expect(state.contracts.find((c) => c.id === 'staff-issued').share_token_hash).toBeUndefined();
  });

  test('without an active creator it falls back to the one active admin', async () => {
    const gone = { ...TECH, active: false, employment_status: 'inactive' };
    const { database, state } = makeDb({ technicians: [gone, ADMIN] });
    await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(state.contracts[0].contract_text_snapshot).toContain('Print Name of Pest Control Representative: Alex Admin');
  });

  test('an estimate with no creator falls back to the one active admin too', async () => {
    const { database, state } = makeDb({ technicians: [ADMIN] });
    await ensureEstimateConsumerNotice({ estimate: { ...termite, created_by_technician_id: null }, req, conn: database });
    expect(state.contracts[0].contract_text_snapshot).toContain('Alex Admin');
  });

  test.each([
    ['no creator and no admin', []],
    ['no creator and two admins', [ADMIN, { ...ADMIN, id: 'admin-2', name: 'Sam Admin' }]],
  ])('%s answers 409 no_representative and writes nothing', async (_label, technicians) => {
    const { database, state } = makeDb({ technicians });
    const result = await ensureEstimateConsumerNotice({ estimate: { ...termite, created_by_technician_id: null }, req, conn: database });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'no_representative' });
    expect(result.error).toMatch(/call us/i);
    expect(state.writes).toEqual([]);
  });

  test('an estimate with no customer account answers 409 no_account before touching anything', async () => {
    const { database, state } = makeDb({ technicians: [TECH] });
    const result = await ensureEstimateConsumerNotice({ estimate: { ...termite, customer_id: null }, req, conn: database });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'no_account' });
    expect(lockCustomerComms).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  test('a notice already on file answers 409 already_signed and writes nothing', async () => {
    findConsumerNotice.mockResolvedValue({ source: 'paper', id: 'p1', signedOn: '10/01/2026' });
    const { database, state } = makeDb({ technicians: [TECH] });
    const result = await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'already_signed' });
    expect(state.writes).toEqual([]);
  });

  test('the gate is read again after the last lock: a kill switch thrown mid-request writes nothing', async () => {
    const { database, state } = makeDb({ technicians: [TECH] });
    const pending = ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    delete process.env.GATE_ESTIMATE_CONSUMER_NOTICE;
    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });

  test('a missing template or version answers 409 template_unavailable', async () => {
    const { database, state } = makeDb({ technicians: [TECH], version: null });
    const result = await ensureEstimateConsumerNotice({ estimate: termite, req, conn: database });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'template_unavailable' });
    expect(state.writes).toEqual([]);
  });
});

// GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND (owner 2026-10-26): after the office's Mark accepted, a termite estimate
// whose customer has no signed notice gets it by email and text; anything the office must finish rings the bell.
describe('sendManualAcceptConsumerNotice', () => {
  const accepted = estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }], [], { status: 'accepted' });
  const delivered = (contractId) => ({ ok: true, deliveries: [{ channel: 'email', ok: true }, { channel: 'sms', ok: true }], contractId });

  beforeEach(() => {
    process.env.GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND = 'true';
    deliverDocumentRequestChannels.mockImplementation(async (contractId) => delivered(contractId));
  });
  afterAll(() => { delete process.env.GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND; });

  test('gate off: nothing is read or sent', async () => {
    delete process.env.GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND;
    const { database, state } = makeDb({ estimateRow: accepted });
    expect(await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database })).toEqual({ skipped: 'gate_off' });
    expect(state.writes).toEqual([]);
    expect(deliverDocumentRequestChannels).not.toHaveBeenCalled();
  });

  test.each([
    ['an estimate with no termite line', estimate([PEST], [], { status: 'accepted' }), 'no_termite_line'],
    ['an estimate that is not accepted', estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }]), 'not_applicable'],
    ['an estimate with no customer', estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }], [], { status: 'accepted', customer_id: null }), 'not_applicable'],
  ])('%s sends nothing', async (_label, row, skipped) => {
    const { database, state } = makeDb({ estimateRow: row, technicians: [TECH] });
    expect(await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database })).toEqual({ skipped });
    expect(state.writes).toEqual([]);
    expect(deliverDocumentRequestChannels).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a notice already signed sends nothing', async () => {
    findConsumerNotice.mockResolvedValue({ source: 'paper' });
    const { database } = makeDb({ estimateRow: accepted, technicians: [TECH] });
    expect(await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database })).toEqual({ skipped: 'already_signed' });
    expect(deliverDocumentRequestChannels).not.toHaveBeenCalled();
  });

  test('no notice yet: issues one marked as a Mark accepted notice and sends it by email and text', async () => {
    const { database, state } = makeDb({ estimateRow: accepted, technicians: [TECH] });
    const result = await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database });
    expect(state.contracts).toHaveLength(1);
    const [row] = state.contracts;
    // Not the estimate page's marker: a link opened from a text offers no "Back to your estimate".
    expect(row.document_variables_snapshot.estimate).toEqual({ id: 'est-1', source: MANUAL_ACCEPT_SOURCE });
    expect(state.events.every((e) => e.actor_type === 'system')).toBe(true);
    expect(deliverDocumentRequestChannels).toHaveBeenCalledWith(row.id, { actorType: 'system' }, expect.objectContaining({ channels: ['email', 'sms'] }));
    expect(result).toEqual({ sent: true, contractId: row.id, channels: ['email', 'sms'] });
    expect(state.writes.filter((w) => w.table === 'estimates')).toEqual([]);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('the gate turned off while the reads were pending: nothing is sent', async () => {
    const { database } = makeDb({ estimateRow: accepted, technicians: [TECH], contracts: [openNotice()] });
    findConsumerNotice.mockImplementation(async () => { delete process.env.GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND; return null; });
    expect(await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database })).toEqual({ skipped: 'gate_off', contractId: 'contract-open' });
    expect(deliverDocumentRequestChannels).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('an open notice from any source is resent, not issued again', async () => {
    const { database, state } = makeDb({ estimateRow: accepted, technicians: [TECH], contracts: [openNotice()] });
    const result = await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database });
    expect(state.writes).toEqual([]);
    expect(deliverDocumentRequestChannels).toHaveBeenCalledWith('contract-open', { actorType: 'system' }, expect.objectContaining({ channels: ['email', 'sms'] }));
    expect(result).toMatchObject({ sent: true, contractId: 'contract-open' });
  });

  test('neither channel delivered: the office bell rings with the customer name', async () => {
    deliverDocumentRequestChannels.mockResolvedValue({ ok: false, deliveries: [{ channel: 'email', ok: false }, { channel: 'sms', ok: false }] });
    const { database } = makeDb({ estimateRow: accepted, technicians: [TECH], contracts: [openNotice()] });
    expect(await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database })).toMatchObject({ sent: false, reason: 'not_delivered' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(spec).toMatchObject({ area: 'Estimates', severity: 'needs-you', subject: { type: 'estimate', id: 'est-1' }, why: 'Neither the email nor the text went out.' });
    expect(spec.action).toContain('Pat Owner');
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'manual-accept-consumer-notice:est-1' });
    // The real composer accepts it (docs/admin-notifications.md: headline length, one-sentence why, no codes).
    expect(() => jest.requireActual('../services/admin-alert-compose').composeAdminAlert(spec)).not.toThrow();
  });

  test('no name to print as the representative: nothing is sent and the office bell rings', async () => {
    const { database, state } = makeDb({ estimateRow: accepted, technicians: [] });
    expect(await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database })).toEqual({ sent: false, reason: 'no_representative' });
    expect(state.contracts).toEqual([]);
    expect(deliverDocumentRequestChannels).not.toHaveBeenCalled();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(() => jest.requireActual('../services/admin-alert-compose').composeAdminAlert(raiseAdminAlert.mock.calls[0][1])).not.toThrow();
  });

  test('a read error never throws: it rings the bell', async () => {
    const { database } = makeDb({ estimateRow: accepted, technicians: [TECH] });
    findConsumerNotice.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    expect(await sendManualAcceptConsumerNotice({ estimateId: 'est-1', conn: database })).toEqual({ sent: false, reason: 'error' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });
});
