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
jest.mock('../routes/estimate-public', () => ({ commercialAgreementBlockedFor: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n1' }) }));

const NotificationService = require('../services/notification-service');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  TEMPLATE_KEY, SNAPSHOT_SOURCE, START_DATE_TEXT, ensureAgreement, agreementStateForEstimate, agreementCtaFor, agreementAdminStatus,
  signEligibility, agreementTermsConflict, AGREEMENT_TERMS, lockEstimateForSign, refuseStaleSignature, handleAgreementSigned,
} = require('../services/commercial-proposal-agreement');

const { TEMPLATE, VERSION, CUSTOMER, estimateRow, makeDb } = require('./helpers/commercial-agreement-fake-db');

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

  test('the kill switch thrown while waiting on the CONTRACT row lock (the last lock): 404, no link rotated, nothing written', async () => {
    const { database, state } = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    const hashBefore = state.contracts[0].share_token_hash;
    const writesBefore = state.writes.length;
    state.onContractLock = async () => { delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN; };
    expect(await ensureAgreement({ estimate: estimateRow(), req, database })).toMatchObject({ ok: false, status: 404 });
    expect(state.contracts).toHaveLength(1);
    expect(state.contracts[0].share_token_hash).toBe(hashBefore);
    expect(state.writes).toHaveLength(writesBefore);
  });

  test('the same flip at the contract lock does not issue a first agreement either', async () => {
    const { database, state } = makeDb();
    state.onContractLock = async () => { delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN; };
    expect(await ensureAgreement({ estimate: estimateRow(), req, database })).toMatchObject({ ok: false, status: 404 });
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

describe('agreement terms: online signing only when EVERY structured term agrees with the agreement (one chokepoint)', () => {
  const withTerms = (commercialTerms) => estimateRow({}, { commercialTerms });
  const NOTE = (detail) => `Online signing needs the proposal terms to match the agreement: ${detail}.`;
  const ALIGNED = {
    paymentTerms: 'net30',
    initialTermMonths: 12,
    renewal: AGREEMENT_TERMS.renewal,
    cancellation: AGREEMENT_TERMS.cancellation,
    priceAdjustment: AGREEMENT_TERMS.priceAdjustment,
  };
  // [label, authored commercialTerms, conflicting field, the builder line's ask]
  const CONFLICTS = [
    ['payment terms unset (no terms at all)', undefined, 'paymentTerms', 'payment terms Net 30'],
    ['terms authored without a payment term', { initialTermMonths: 12 }, 'paymentTerms', 'payment terms Net 30'],
    ['due on receipt', { paymentTerms: 'due_on_receipt' }, 'paymentTerms', 'payment terms Net 30'],
    ['Net-15', { paymentTerms: 'net15' }, 'paymentTerms', 'payment terms Net 30'],
    ['a 6-month initial term', { ...ALIGNED, initialTermMonths: 6 }, 'initialTermMonths', 'initial term 12 months (or blank)'],
    ['a 24-month initial term', { ...ALIGNED, initialTermMonths: 24 }, 'initialTermMonths', 'initial term 12 months (or blank)'],
    ['a zero-month (month-to-month) initial term', { ...ALIGNED, initialTermMonths: 0 }, 'initialTermMonths', 'initial term 12 months (or blank)'],
    ['a different renewal', { ...ALIGNED, renewal: 'Month-to-month, no automatic renewal.' }, 'renewal', 'renewal blank or automatic 12-month terms with 30 days\' notice'],
    ['a different cancellation', { ...ALIGNED, cancellation: 'Cancel any time with 10 days notice.' }, 'cancellation', 'cancellation blank or 30 days\' written notice'],
    ['a different price adjustment', { ...ALIGNED, priceAdjustment: 'Annual 5% increase every January.' }, 'priceAdjustment', 'price adjustment blank or at renewal / with 30 days\' notice'],
  ];

  test.each(CONFLICTS)('%s: the one predicate names the field', (_label, terms, field, detail) => {
    const eligibility = signEligibility(withTerms(terms));
    expect(eligibility).toMatchObject({ ok: false, reason: 'terms_conflict', field, note: NOTE(detail) });
  });

  test.each(CONFLICTS)('%s: the issuer refuses with the generic 404 and writes nothing', async (_label, terms) => {
    const estimate = withTerms(terms);
    const { database, state } = makeDb({ estimate });
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: false, status: 404, code: 'not_signable' });
    expect(state.writes).toEqual([]);
  });

  test.each(CONFLICTS)('%s: the locked re-check refuses too (terms changed between the route read and the lock)', async (_label, terms) => {
    const { database, state } = makeDb({ estimate: withTerms(terms) });
    expect(await ensureAgreement({ estimate: estimateRow(), req, database })).toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });

  test.each(CONFLICTS)('%s: /data gets canSign false with the reason and field (no button)', async (_label, terms, field) => {
    const { database } = makeDb();
    expect(await agreementCtaFor(withTerms(terms), database)).toEqual({ canSign: false, state: 'none', reason: 'terms_conflict', field });
  });

  test.each(CONFLICTS)('%s: the builder status names the field to change', async (_label, terms, field, detail) => {
    const { database } = makeDb();
    expect(await agreementAdminStatus(withTerms(terms), database)).toEqual({
      state: 'none', signingBlocked: 'terms_conflict', field, note: NOTE(detail),
    });
  });

  test.each([
    ['Net 30 alone (every other term blank)', { paymentTerms: 'net30' }],
    ['Net 30 spelled "Net-30"', { paymentTerms: 'Net-30' }],
    ['Net 30 with a 12-month initial term', { paymentTerms: 'net30', initialTermMonths: 12 }],
    ['every term set to the agreement-aligned text', ALIGNED],
    ['aligned texts in other case, spacing and apostrophe style', {
      paymentTerms: 'net30',
      renewal: `  ${AGREEMENT_TERMS.renewal.toUpperCase()}  `,
      cancellation: AGREEMENT_TERMS.cancellation.replace(/ /g, '   ').replace("'", '’'),
      priceAdjustment: AGREEMENT_TERMS.priceAdjustment.toLowerCase().replace("'", '’'),
    }],
    ['site access instructions (they add to the agreement)', { paymentTerms: 'net30', accessRequirements: 'Check in at the front office; gate code on request.' }],
  ])('allowed: %s', async (_label, terms) => {
    const estimate = withTerms(terms);
    expect(signEligibility(estimate)).toMatchObject({ ok: true });
    const { database } = makeDb({ estimate });
    expect(await agreementCtaFor(estimate, database)).toEqual({ canSign: true, state: 'none' });
    expect(await agreementAdminStatus(estimate, database)).toEqual({ state: 'none' });
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: true, status: 201 });
  });

  test('free-text additional terms do not block (they add to the agreement)', () => {
    expect(signEligibility(estimateRow({}, { terms: 'Interior units are treated on request, billed per visit.' }))).toMatchObject({ ok: true });
  });

  test('an unknown structured term fails closed, and every key the proposal normalizer emits has a rule', () => {
    expect(agreementTermsConflict({ commercialTerms: { ...ALIGNED, futureTerm: 'anything' } })).toMatchObject({ field: 'futureTerm' });
    // The normalizer is the source of the field list: if it ever emits a key with no rule, this fails (and so would signing).
    const { normalizeCommercialTerms } = require('../services/estimate-proposal');
    const emitted = normalizeCommercialTerms({
      ...ALIGNED, accessRequirements: 'Front office', futureTerm: 'dropped by the normalizer today',
    });
    expect(Object.keys(emitted).sort()).toEqual(['accessRequirements', 'cancellation', 'initialTermMonths', 'paymentTerms', 'priceAdjustment', 'renewal']);
    expect(agreementTermsConflict({ commercialTerms: emitted })).toBeNull();
  });

  test('the agreement-aligned texts survive the normalizer unchanged (no length truncation)', () => {
    const { normalizeCommercialTerms } = require('../services/estimate-proposal');
    const emitted = normalizeCommercialTerms(ALIGNED);
    expect(emitted.renewal).toBe(AGREEMENT_TERMS.renewal);
    expect(emitted.cancellation).toBe(AGREEMENT_TERMS.cancellation);
    expect(emitted.priceAdjustment).toBe(AGREEMENT_TERMS.priceAdjustment);
  });

  test('a signed agreement stays signed in the builder and on the page whatever the terms say now', async () => {
    const { database, state } = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    state.contracts[0].status = 'signed';
    const changed = withTerms({ paymentTerms: 'net15' });
    expect(await agreementAdminStatus(changed, database)).toMatchObject({ state: 'signed' });
    expect(await agreementAdminStatus(changed, database)).not.toHaveProperty('signingBlocked');
    expect(await agreementCtaFor(changed, database)).toEqual({ canSign: false, state: 'signed' });
  });
});

describe('sign boundary: a contract may be signed only for the quote it shows', () => {
  const { commercialAgreementBlockedFor } = require('../routes/estimate-public');
  const MESSAGE = 'This proposal was updated. Please open the latest proposal to sign.';

  async function issued() {
    const made = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database: made.database });
    return made;
  }
  // What contracts-public does: lock the estimate (step 1), then refuse or allow at signing (step 2).
  async function signAttempt({ database, state }) {
    const contract = state.contracts[0];
    const estimateLock = await lockEstimateForSign(database, contract);
    return { estimateLock, refusal: await refuseStaleSignature({ trx: database, contract, estimateLock, req }) };
  }
  const cancelledEvents = (state) => state.events.filter((e) => e.event_type === 'cancelled');

  beforeEach(() => commercialAgreementBlockedFor.mockReset().mockResolvedValue(false));

  test('the contract as issued (nothing edited) is fine to sign: issue and sign-time fingerprints agree', async () => {
    const made = await issued();
    const { estimateLock, refusal } = await signAttempt(made);
    expect(estimateLock).toMatchObject({ blocked: false });
    expect(refusal).toBeNull();
    expect(made.state.contracts[0].status).toBe('sent');
    expect(cancelledEvents(made.state)).toHaveLength(0);
  });

  test('a proposal re-saved with new row ids is still the same quote', async () => {
    const made = await issued();
    made.state.estimate = estimateRow({}, { buildings: [{ name: 'Main building', lineItems: [{ id: 'new-row-id', description: 'Quarterly pest service', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true }] }] });
    expect((await signAttempt(made)).refusal).toBeNull();
  });

  test.each([
    ['a one-time charge was added', () => ({ proposal: { buildings: [{ name: 'Main building', lineItems: [{ description: 'Quarterly pest service', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true }, { description: 'Cleanout', quantity: 1, unitPrice: 250, frequency: 'one_time' }] }] } })],
    ['the tax rate changed', () => ({ proposal: { taxRate: 0.06 } })],
    ['the terms changed', () => ({ proposal: { terms: 'Net-45 billing.' } })],
    ['payment terms were changed to Net-15', () => ({ proposal: { commercialTerms: { paymentTerms: 'net15' } } })],
    ['payment terms were cleared', () => ({ proposal: { commercialTerms: null } })],
    ['the initial term was changed to 6 months', () => ({ proposal: { commercialTerms: { paymentTerms: 'net30', initialTermMonths: 6 } } })],
    ['the renewal wording was changed', () => ({ proposal: { commercialTerms: { paymentTerms: 'net30', renewal: 'Month-to-month.' } } })],
    ['the cancellation wording was changed', () => ({ proposal: { commercialTerms: { paymentTerms: 'net30', cancellation: 'Cancel any time.' } } })],
    ['the price adjustment wording was changed', () => ({ proposal: { commercialTerms: { paymentTerms: 'net30', priceAdjustment: 'Annual 5% increase.' } } })],
    ['the estimate moved to another customer', () => ({ estimate: { customer_id: 'cust-2' } })],
  ])('%s after issue: signing is refused, the stale contract is cancelled, nothing is signed', async (_label, build) => {
    const made = await issued();
    const { proposal = {}, estimate = {} } = build();
    made.state.estimate = estimateRow(estimate, proposal);
    const { refusal } = await signAttempt(made);
    expect(refusal).toBe(MESSAGE);
    expect(made.state.contracts[0]).toMatchObject({ status: 'cancelled', share_token_hash: null, share_token_expires_at: null });
    expect(made.state.contracts[0].signed_at).toBeUndefined();
    expect(cancelledEvents(made.state)).toHaveLength(1);
    expect(JSON.parse(cancelledEvents(made.state)[0].metadata)).toMatchObject({ reason: 'stale_at_signature' });
    expect(estimateWrites(made.state)).toEqual([]);
  });

  test('an estimate that is no longer open (accepted, declined, expired, archived) refuses and cancels', async () => {
    const made = await issued();
    commercialAgreementBlockedFor.mockResolvedValue(true);
    expect((await signAttempt(made)).refusal).toBe(MESSAGE);
    expect(made.state.contracts[0].status).toBe('cancelled');
    expect(JSON.parse(cancelledEvents(made.state)[0].metadata)).toMatchObject({ cause: 'estimate_closed' });
  });

  test('the gate off at signing refuses and cancels', async () => {
    const made = await issued();
    delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
    expect((await signAttempt(made)).refusal).toBe(MESSAGE);
    expect(made.state.contracts[0].status).toBe('cancelled');
    expect(JSON.parse(cancelledEvents(made.state)[0].metadata)).toMatchObject({ cause: 'gate_off' });
  });

  test('the locked re-check the route uses is the one handed to the sign boundary', async () => {
    const made = await issued();
    await signAttempt(made);
    expect(commercialAgreementBlockedFor).toHaveBeenCalledWith(made.database, expect.objectContaining({ id: 'est-0001' }));
  });

  test('a contract this feature did not issue is not ours: no estimate lock, no check', async () => {
    const made = await issued();
    const contract = made.state.contracts[0];
    expect(await lockEstimateForSign(made.database, { ...contract, document_template_key: 'service_agreement.residential_pest' })).toBeNull();
    expect(await lockEstimateForSign(made.database, { ...contract, document_variables_snapshot: JSON.stringify({ customer: { name: 'Hand Issued LLC' } }) })).toBeNull();
    expect(commercialAgreementBlockedFor).not.toHaveBeenCalled();
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
