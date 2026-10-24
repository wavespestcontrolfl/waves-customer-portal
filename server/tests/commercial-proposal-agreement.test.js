/**
 * Commercial proposal online signing (GATE_COMMERCIAL_PROPOSAL_SIGN): the service that issues the
 * Commercial Pest Service Agreement from an authored proposal, and the after-signature office alert.
 * Invariants: one open agreement per estimate (a repeat returns it); the estimate row is never written;
 * a changed quote retires the stale open agreement; a signed agreement is final; the alert is deduped per
 * contract and ignores every contract this feature did not issue.
 * Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n1' }) }));

const NotificationService = require('../services/notification-service');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  TEMPLATE_KEY, SNAPSHOT_SOURCE, START_DATE_TEXT, ensureAgreement, agreementStateForEstimate, agreementCtaFor, handleAgreementSigned,
} = require('../services/commercial-proposal-agreement');

const BODY = [
  'Commercial Pest Service Agreement',
  'Business / account: {{customer.name}}',
  'Service location(s): {{customer.address}}',
  'Service plan: {{service.name}}',
  'Start date: {{agreement.start_date}}',
].join('\n');
const TEMPLATE = { id: 'tpl-1', template_key: TEMPLATE_KEY, status: 'active', active_version_id: 'ver-1', requires_signature: true, expire_after_days: 14, name: 'Commercial Pest Service Agreement' };
const VERSION = { id: 'ver-1', template_id: 'tpl-1', version_number: 1, title: 'Commercial Pest Service Agreement', body: BODY, signer_disclosure: 'I agree to sign electronically.' };

function estimateRow(overrides = {}, proposalOverrides = {}) {
  return {
    id: 'est-0001',
    estimate_slug: 'EST-2026-0042',
    customer_id: 'cust-1',
    status: 'viewed',
    customer_name: 'Harbor Plaza Association',
    address: '100 Sample Way, Bradenton, FL 34205',
    estimate_data: {
      proposal: {
        enabled: true,
        title: 'Commercial Service Proposal',
        preparedFor: 'Harbor Plaza Association LLC',
        propertyAddress: '100 Sample Way, Bradenton, FL 34205',
        taxRate: 0.07,
        taxLabel: 'Sales tax',
        buildings: [{ name: 'Main building', lineItems: [{ description: 'Quarterly pest service', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true }] }],
        ...proposalOverrides,
      },
    },
    ...overrides,
  };
}

const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', email: 'pat@example.com', phone: '+19415550100', address_line1: '9 Home St', active: true };

// A tiny in-memory stand-in for the tables the service touches.
function makeDb({ estimate = estimateRow(), customer = CUSTOMER, contracts = [], template = TEMPLATE, version = VERSION } = {}) {
  const state = { estimate, customer, template, version, contracts: contracts.map((c) => ({ ...c })), events: [], writes: [] };
  const snapshotEstimateId = (row) => {
    const snap = typeof row.document_variables_snapshot === 'string' ? JSON.parse(row.document_variables_snapshot) : row.document_variables_snapshot;
    return snap?.estimate?.id;
  };
  const make = (table) => {
    const q = { where: {}, statusIn: null, statusNotIn: null, estimateId: null };
    const api = {
      where(obj) { Object.assign(q.where, obj); return api; },
      whereNull() { return api; },
      whereIn(col, vals) { if (col === 'status') q.statusIn = vals; return api; },
      whereNotIn(col, vals) { if (col === 'status') q.statusNotIn = vals; return api; },
      whereRaw(_sql, binds) { q.estimateId = binds[0]; return api; },
      orderByRaw() { return api; },
      forUpdate() { return api; },
      async first() {
        if (table === 'document_templates') return q.where.template_key ? state.template : { active_version_id: state.template.active_version_id, status: state.template.status, template_key: state.template.template_key };
        if (table === 'document_template_versions') return state.version;
        if (table === 'estimates') return state.estimate;
        if (table === 'customers') return state.customer;
        if (table === 'customer_contracts') {
          const rows = state.contracts
            .filter((c) => (q.where.id ? c.id === q.where.id : c.document_template_key === q.where.document_template_key))
            .filter((c) => q.estimateId == null || String(snapshotEstimateId(c)) === String(q.estimateId))
            .filter((c) => !q.statusIn || q.statusIn.includes(c.status))
            .filter((c) => !q.statusNotIn || !q.statusNotIn.includes(c.status))
            .sort((a, b) => (b.status === 'signed') - (a.status === 'signed'));
          return rows[0] || null;
        }
        return null;
      },
      async update(payload) {
        state.writes.push({ table, op: 'update', payload });
        if (table !== 'customer_contracts') return 1;
        const row = state.contracts.find((c) => c.id === q.where.id && (!q.statusIn || q.statusIn.includes(c.status)));
        if (!row) return 0;
        Object.assign(row, payload);
        return 1;
      },
      insert(row) {
        state.writes.push({ table, op: 'insert', payload: row });
        const stored = { id: `contract-${state.contracts.length + 1}`, created_at: new Date(), ...row };
        if (table === 'customer_contracts') state.contracts.push(stored);
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

const req = { ip: '203.0.113.9', get: () => 'jest-agent' };
const estimateWrites = (state) => state.writes.filter((w) => w.table === 'estimates');

const ORIGINAL_GATE = process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_COMMERCIAL_PROPOSAL_SIGN = 'true';
});
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
  else process.env.GATE_COMMERCIAL_PROPOSAL_SIGN = ORIGINAL_GATE;
});

describe('ensureAgreement', () => {
  test('creates ONE agreement from the commercial template with the quote in its variables and snapshot, and never writes the estimate', async () => {
    const { database, state } = makeDb();
    const result = await ensureAgreement({ estimate: estimateRow(), req, database });
    expect(result).toMatchObject({ ok: true, status: 201, created: true });
    expect(result.signingUrl).toMatch(/\/contract\/[A-Za-z0-9_-]{20,}$/);

    expect(state.contracts).toHaveLength(1);
    const [row] = state.contracts;
    expect(row).toMatchObject({
      customer_id: 'cust-1', contract_type: 'document_template', status: 'sent', document_template_key: TEMPLATE_KEY,
      document_template_id: 'tpl-1', document_template_version_id: 'ver-1', requires_signature_snapshot: true,
      recipient_email: 'pat@example.com',
    });
    expect(row.share_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.share_token_expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(row.service_name).toBe('Commercial pest control — EST-2026-0042 — $1,200 per year, serviced quarterly, plus sales tax');
    expect(row.contract_text_snapshot).toContain('Business / account: Harbor Plaza Association LLC');
    expect(row.contract_text_snapshot).toContain('Service location(s): 100 Sample Way, Bradenton, FL 34205');
    expect(row.contract_text_snapshot).toContain(`Start date: ${START_DATE_TEXT}`);
    expect(START_DATE_TEXT).toBe('Set when we schedule your first visit');

    const snapshot = JSON.parse(row.document_variables_snapshot);
    expect(snapshot.estimate).toMatchObject({
      id: 'est-0001', number: 'EST-2026-0042', source: SNAPSHOT_SOURCE, annualRecurring: 1200, monthlyEquivalent: 100, recurringTax: 84, firstYearTotal: 1284,
    });
    expect(snapshot.agreement.start_date).toBe(START_DATE_TEXT);
    expect(state.events.map((e) => e.event_type)).toEqual(['created_from_document_template', 'share_link_created']);
    expect(estimateWrites(state)).toEqual([]);
  });

  test('a second call returns the same open agreement with a fresh link and creates no second row', async () => {
    const { database, state } = makeDb();
    const first = await ensureAgreement({ estimate: estimateRow(), req, database });
    const hashBefore = state.contracts[0].share_token_hash;
    const second = await ensureAgreement({ estimate: estimateRow(), req, database });
    expect(second).toMatchObject({ ok: true, status: 200, created: false, contractId: first.contractId });
    expect(state.contracts).toHaveLength(1);
    expect(second.signingUrl).not.toBe(first.signingUrl);
    expect(state.contracts[0].share_token_hash).not.toBe(hashBefore);
    expect(state.contracts[0].status).toBe('sent');
  });

  test('a proposal that changed since issue retires the stale open agreement and issues a current one', async () => {
    const { database, state } = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    const changed = estimateRow({}, { buildings: [{ name: 'Main building', lineItems: [{ description: 'Monthly pest service', quantity: 1, unitPrice: 150, frequency: 'monthly', taxable: false }] }] });
    state.estimate = changed;
    const second = await ensureAgreement({ estimate: changed, req, database });
    expect(second).toMatchObject({ ok: true, status: 201, created: true });
    expect(state.contracts).toHaveLength(2);
    expect(state.contracts[0]).toMatchObject({ status: 'cancelled', share_token_hash: null });
    expect(state.contracts[1].service_name).toBe('Commercial pest control — EST-2026-0042 — $1,800 per year, serviced monthly');
  });

  test('a signed agreement is final: 409, no new agreement, no new link', async () => {
    const { database, state } = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    state.contracts[0].status = 'signed';
    const again = await ensureAgreement({ estimate: estimateRow(), req, database });
    expect(again).toMatchObject({ ok: false, status: 409, code: 'already_signed' });
    expect(state.contracts).toHaveLength(1);
  });

  test('an estimate with no customer account answers 409 and writes nothing', async () => {
    const estimate = estimateRow({ customer_id: null });
    const { database, state } = makeDb({ estimate });
    const result = await ensureAgreement({ estimate, req, database });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'no_customer' });
    expect(result.error).toMatch(/call us/i);
    expect(state.writes).toEqual([]);
  });

  test.each([
    ['no authored proposal (synthesized fallback)', () => estimateRow({ estimate_data: {} })],
    ['a one-time-only proposal (no recurring service)', () => estimateRow({}, { buildings: [{ name: 'Main', lineItems: [{ description: 'Cleanout', quantity: 1, unitPrice: 400, frequency: 'one_time' }] }] })],
  ])('%s is refused with the generic not-found and writes nothing', async (_label, build) => {
    const estimate = build();
    const { database, state } = makeDb({ estimate });
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });

  test('the route re-check on the locked estimate row wins: blocked means nothing is created', async () => {
    const { database, state } = makeDb();
    const blockedFor = jest.fn().mockResolvedValue(true);
    expect(await ensureAgreement({ estimate: estimateRow(), req, database, blockedFor })).toMatchObject({ ok: false, status: 404 });
    expect(blockedFor).toHaveBeenCalledTimes(1);
    expect(state.contracts).toHaveLength(0);
  });

  test('an inactive template or customer refuses without creating anything', async () => {
    const noTemplate = makeDb({ template: null });
    expect(await ensureAgreement({ estimate: estimateRow(), req, database: noTemplate.database })).toMatchObject({ ok: false, status: 409, code: 'template_unavailable' });
    const inactive = makeDb({ customer: { ...CUSTOMER, active: false } });
    expect(await ensureAgreement({ estimate: estimateRow(), req, database: inactive.database })).toMatchObject({ ok: false, status: 409, code: 'customer_unavailable' });
    expect(inactive.state.contracts).toHaveLength(0);
  });
});

describe('gate re-read at the commit boundary', () => {
  test('the kill switch thrown while the request waited on locks: 404, and no row, link or event is written', async () => {
    const { database, state } = makeDb();
    // The wait happens inside the comms fence; the gate flips off while it is held.
    lockCustomerComms.mockImplementationOnce(async () => { delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN; });
    const result = await ensureAgreement({ estimate: estimateRow(), req, database });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(state.contracts).toHaveLength(0);
    expect(state.writes).toEqual([]);
  });

  test('the same flip does not re-open an existing agreement (its link is not rotated)', async () => {
    const { database, state } = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    const hashBefore = state.contracts[0].share_token_hash;
    const writesBefore = state.writes.length;
    lockCustomerComms.mockImplementationOnce(async () => { delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN; });
    expect(await ensureAgreement({ estimate: estimateRow(), req, database })).toMatchObject({ ok: false, status: 404 });
    expect(state.contracts[0].share_token_hash).toBe(hashBefore);
    expect(state.writes).toHaveLength(writesBefore);
  });
});

describe('quote fingerprint: an open agreement is reused only for the identical quote', () => {
  const line = (over = {}) => ({ description: 'Quarterly pest service', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true, ...over });
  const building = (lines) => [{ name: 'Main building', lineItems: lines }];

  test('identical proposal reuses the agreement, even when the editor re-mints row ids', async () => {
    const { database, state } = makeDb();
    const first = await ensureAgreement({ estimate: estimateRow({}, { buildings: building([line({ id: 'row-a' })]) }), req, database });
    state.estimate = estimateRow({}, { buildings: building([line({ id: 'row-b' })]) });
    const second = await ensureAgreement({ estimate: state.estimate, req, database });
    expect(second).toMatchObject({ ok: true, status: 200, created: false, contractId: first.contractId });
    expect(state.contracts).toHaveLength(1);
    expect(JSON.parse(state.contracts[0].document_variables_snapshot).estimate.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ['a one-time charge changes (same annual price)', () => ({ proposal: { buildings: building([line(), line({ description: 'Cleanout', unitPrice: 250, frequency: 'one_time', taxable: false })]) } })],
    ['the tax rate changes (same annual price)', () => ({ proposal: { taxRate: 0.06 } })],
    ['the scope changes (a property scope item, same price)', () => ({ proposal: { propertyScope: { items: [{ label: 'Buildings', value: '3' }] } } })],
    ['the terms change (same price)', () => ({ proposal: { terms: 'Net-45 billing.' } })],
    ['a corrective-work line is added (same recurring price)', () => ({ proposal: { correctiveWork: [{ description: 'Seal entry points', amount: 400, taxable: false }] } })],
    ['the customer account changes', () => ({ estimate: { customer_id: 'cust-2' }, customer: { ...CUSTOMER, id: 'cust-2', email: 'other@example.com' } })],
  ])('%s: the open agreement is superseded and a current one issued', async (_label, build) => {
    const { database, state } = makeDb();
    const first = await ensureAgreement({ estimate: estimateRow(), req, database });
    const { proposal = {}, estimate: estimateOver = {}, customer } = build();
    state.estimate = estimateRow(estimateOver, proposal);
    if (customer) state.customer = customer;
    const second = await ensureAgreement({ estimate: state.estimate, req, database });
    expect(second).toMatchObject({ ok: true, status: 201, created: true });
    expect(second.contractId).not.toBe(first.contractId);
    expect(state.contracts).toHaveLength(2);
    expect(state.contracts[0]).toMatchObject({ status: 'cancelled', share_token_hash: null });
    expect(state.contracts[1].status).toBe('sent');
    const fingerprints = state.contracts.map((c) => JSON.parse(c.document_variables_snapshot).estimate.fingerprint);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
    expect(state.events.filter((e) => e.event_type === 'cancelled')).toHaveLength(1);
  });

  test('a new template version supersedes too', async () => {
    const { database, state } = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    state.version = { ...VERSION, id: 'ver-2' };
    state.template = { ...TEMPLATE, active_version_id: 'ver-2' };
    expect(await ensureAgreement({ estimate: estimateRow(), req, database })).toMatchObject({ ok: true, status: 201, created: true });
  });
});

describe('agreementStateForEstimate / agreementCtaFor', () => {
  test('none, then awaiting, then signed', async () => {
    const { database, state } = makeDb();
    expect(await agreementStateForEstimate('est-0001', database)).toEqual({ state: 'none' });
    await ensureAgreement({ estimate: estimateRow(), req, database });
    expect(await agreementStateForEstimate('est-0001', database)).toMatchObject({ state: 'awaiting', contractId: 'contract-1' });
    state.contracts[0].status = 'signed';
    state.contracts[0].signed_at = new Date('2026-10-24T15:00:00Z');
    expect(await agreementStateForEstimate('est-0001', database)).toMatchObject({ state: 'signed', contractId: 'contract-1' });
  });

  test('the page block: signable proposal only, canSign needs a customer and an unsigned agreement', async () => {
    const { database, state } = makeDb();
    expect(await agreementCtaFor(estimateRow(), database)).toEqual({ canSign: true, state: 'none' });
    expect(await agreementCtaFor(estimateRow({ customer_id: null }), database)).toEqual({ canSign: false, state: 'none' });
    expect(await agreementCtaFor(estimateRow({ estimate_data: {} }), database)).toBeNull();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    state.contracts[0].status = 'signed';
    expect(await agreementCtaFor(estimateRow(), database)).toEqual({ canSign: false, state: 'signed' });
  });
});

describe('handleAgreementSigned', () => {
  async function signedContract(overrides = {}) {
    const { database, state } = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    Object.assign(state.contracts[0], { status: 'signed', signed_at: new Date('2026-10-24T15:00:00Z'), signed_name: 'Pat Sample', ...overrides });
    return { database, state };
  }

  test('raises ONE deduped needs-you alert that links the proposal, writes an activity row, and leaves the estimate alone', async () => {
    const { database, state } = await signedContract();
    const result = await handleAgreementSigned({ contractId: 'contract-1', database });
    expect(result).toEqual({ alerted: true });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('customer');
    expect(headline).toBe('Estimates — mark Harbor Plaza Association LLC won');
    expect(headline.length).toBeLessThanOrEqual(60);
    expect(why).toBe('Signed the commercial agreement for EST-2026-0042; the estimate is still open and nothing is booked.');
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: 'commercial-agreement-signed:contract-1',
      link: '/admin/estimates/est-0001/proposal',
      metadata: { estimateId: 'est-0001', customerId: 'cust-1', contractId: 'contract-1', severity: 'needs-you', subject: { type: 'estimate', id: 'est-0001' }, who: 'person' },
    });
    expect(opts.detail).toContain('Mark the estimate won, then schedule the first visit.');
    const activity = state.writes.filter((w) => w.table === 'activity_log');
    expect(activity).toHaveLength(1);
    expect(activity[0].payload).toMatchObject({ estimate_id: 'est-0001', action: 'commercial_agreement_signed' });
    expect(estimateWrites(state)).toEqual([]);
  });

  test('a short name keeps the whole instruction in the headline', async () => {
    const estimate = estimateRow({}, { preparedFor: 'Bay Hotel' });
    const { database, state } = makeDb({ estimate });
    await ensureAgreement({ estimate, req, database });
    Object.assign(state.contracts[0], { status: 'signed', signed_at: new Date() });
    await handleAgreementSigned({ contractId: 'contract-1', database });
    expect(NotificationService.notifyAdmin.mock.calls[0][1]).toBe('Estimates — mark Bay Hotel won and book the first visit');
  });

  test.each([
    ['another template', { document_template_key: 'service_agreement.residential_pest' }],
    ['a commercial agreement staff issued by hand (no estimate marker)', { document_variables_snapshot: JSON.stringify({ customer: { name: 'Hand Issued LLC' } }) }],
    ['a contract that is not signed', { status: 'sent' }],
  ])('%s raises nothing', async (_label, overrides) => {
    const { database, state } = await signedContract(overrides);
    const result = await handleAgreementSigned({ contractId: 'contract-1', database });
    expect(result.alerted).toBeUndefined();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(state.writes.filter((w) => w.table === 'activity_log')).toEqual([]);
  });

  test('never throws: a failing alert resolves as a skip', async () => {
    const { database } = await signedContract();
    NotificationService.notifyAdmin.mockRejectedValueOnce(new Error('bell down'));
    await expect(handleAgreementSigned({ contractId: 'contract-1', database })).resolves.toEqual({ skipped: 'error' });
  });
});
