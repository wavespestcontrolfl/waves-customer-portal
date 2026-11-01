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
jest.mock('../services/autopay-setup-link', () => ({ requestAutopaySetupLink: jest.fn(), billingLaneSupported: jest.fn(() => true) }));

const NotificationService = require('../services/notification-service');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  TEMPLATE_KEY, SNAPSHOT_SOURCE, START_DATE_TEXT, ensureAgreement, agreementStateForEstimate, agreementCtaFor, agreementAdminStatus,
  signEligibility, agreementTermsConflict, AGREEMENT_TERMS, lockEstimateForSign, refuseStaleSignature, handleAgreementSigned, signedQuoteMatches,
  AGREEMENT_PAYMENT_TEXT, autopayNextStep, STALE_PROPOSAL_MESSAGE, quoteFingerprint, buildAgreementValues, signableProposal,
} = require('../services/commercial-proposal-agreement');
const { requestAutopaySetupLink, billingLaneSupported } = require('../services/autopay-setup-link');
const AutopayEligibility = require('../services/autopay-eligibility');

const { BODY, TEMPLATE, VERSION, CUSTOMER, estimateRow, makeDb } = require('./helpers/commercial-agreement-fake-db');

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

describe('the signed quote is frozen with the contract', () => {
  test('the snapshot stores the whole normalized proposal and totals, and a later edit does not change it', async () => {
    const { database, state } = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database });
    const snap = () => JSON.parse(state.contracts[0].document_variables_snapshot).estimate;
    const before = snap();
    expect(before.proposal).toEqual(expect.objectContaining({ enabled: true }));
    expect(JSON.stringify(before.proposal)).not.toMatch(/"id":/);
    expect(before.totals).toEqual(expect.objectContaining({ annualRecurring: before.annualRecurring }));
    // The estimate is edited after issue: the stored copy is what was offered, untouched.
    state.estimate = estimateRow({}, { taxRate: 0.06 });
    expect(snap()).toEqual(before);
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

describe('building use: online signing needs the pick (audit fix 5)', () => {
  const NOTE = 'Online signing needs the building use: pick it in the builder and save.';
  const NO_USE = [['missing', undefined], ['blank', ''], ['whitespace only', '   '], ['an unknown value', 'warehouse']];

  test.each(NO_USE)('building use %s: unsignable, with the existing terms_conflict reason and an operator note', (_label, buildingUse) => {
    expect(signEligibility(estimateRow({}, { buildingUse }))).toMatchObject({ ok: false, reason: 'terms_conflict', field: 'buildingUse', note: NOTE });
  });

  test.each(['residential', 'nonresidential', ' Residential '])('building use %j: signable', (buildingUse) => {
    expect(signEligibility(estimateRow({}, { buildingUse }))).toMatchObject({ ok: true });
  });

  test('no building use: /data offers no button, the builder status carries the note, the issuer refuses and writes nothing', async () => {
    const estimate = estimateRow({}, { buildingUse: undefined });
    const { database, state } = makeDb({ estimate });
    expect(await agreementCtaFor(estimate, database)).toEqual({ canSign: false, state: 'none', reason: 'terms_conflict', field: 'buildingUse' });
    expect(await agreementAdminStatus(estimate, database)).toEqual({ state: 'none', signingBlocked: 'terms_conflict', field: 'buildingUse', note: NOTE });
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: false, status: 404, code: 'not_signable' });
    expect(state.writes).toEqual([]);
  });

  test('the locked re-check refuses when the pick was removed between the route read and the lock', async () => {
    const { database, state } = makeDb({ estimate: estimateRow({}, { buildingUse: undefined }) });
    expect(await ensureAgreement({ estimate: estimateRow(), req, database })).toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });

  test('sign time: an open agreement whose proposal lost its building use is refused and cancelled', async () => {
    const made = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database: made.database });
    made.state.estimate = estimateRow({}, { buildingUse: undefined });
    const contract = made.state.contracts[0];
    const estimateLock = await lockEstimateForSign(made.database, contract);
    expect(await refuseStaleSignature({ trx: made.database, contract, estimateLock, req })).toBe(STALE_PROPOSAL_MESSAGE);
    expect(made.state.contracts[0].status).toBe('cancelled');
  });

  test('a signed agreement keeps its status line when the pick is later removed (signing history is final)', async () => {
    const made = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database: made.database });
    made.state.contracts[0].status = 'signed';
    expect(await agreementAdminStatus(estimateRow({}, { buildingUse: undefined }), made.database)).toMatchObject({ state: 'signed' });
  });
});

describe('agreement terms: online signing only when EVERY structured term agrees with the agreement (one chokepoint)', () => {
  test('the server reads the same constants the proposal builder prefills (shared module), word for word', () => {
    expect(AGREEMENT_TERMS).toBe(require('../../shared/commercial-agreement-terms.cjs').AGREEMENT_TERMS);
    expect(AGREEMENT_TERMS).toEqual({
      initialTermMonths: 12,
      renewal: 'Renews automatically for 12-month terms unless either party gives written notice at least 30 days before the term ends.',
      priceAdjustment: "Pricing may be adjusted at renewal or with at least 30 days' written notice.",
      cancellation: "Either party may cancel with 30 days' written notice. Charges for services already performed remain due.",
    });
  });

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
    ['payment terms unset (no terms at all)', undefined, 'paymentTerms', 'payment terms Net 30 or Net 60'],
    ['terms authored without a payment term', { initialTermMonths: 12 }, 'paymentTerms', 'payment terms Net 30 or Net 60'],
    ['due on receipt', { paymentTerms: 'due_on_receipt' }, 'paymentTerms', 'payment terms Net 30 or Net 60'],
    ['Net-15', { paymentTerms: 'net15' }, 'paymentTerms', 'payment terms Net 30 or Net 60'],
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

describe('payment paragraph: Auto Pay (GATE_COMMERCIAL_AUTOPAY), Net 30 or Net 60', () => {
  const NOTE = (detail) => `Online signing needs the proposal terms to match the agreement: ${detail}.`;
  // Version 2 as the migration builds it: version 1's paragraph replaced by the slot.
  const { V1_PAYMENT: V1, V2_PAYMENT: V2 } = require('../models/migrations/20261025120000_commercial_agreement_payment_terms');
  const SLOT_BODY = BODY.replace(V1, V2);
  const slotDb = (estimate) => makeDb({
    estimate,
    version: { ...VERSION, id: 'ver-2', version_number: 2, body: SLOT_BODY },
    template: { ...TEMPLATE, active_version_id: 'ver-2' },
  });
  const autopay = (overrides = {}, proposal = {}) => estimateRow(overrides, { commercialTerms: { paymentTerms: 'autopay' }, ...proposal });
  const net60 = (overrides = {}) => estimateRow(overrides, { commercialTerms: { paymentTerms: 'net60' } });
  const { commercialAgreementBlockedFor } = require('../routes/estimate-public');
  const ORIGINAL_AUTOPAY_GATE = process.env.GATE_COMMERCIAL_AUTOPAY;
  beforeEach(() => {
    process.env.GATE_COMMERCIAL_AUTOPAY = 'true';
    commercialAgreementBlockedFor.mockReset().mockResolvedValue(false);
  });
  afterEach(() => {
    if (ORIGINAL_AUTOPAY_GATE === undefined) delete process.env.GATE_COMMERCIAL_AUTOPAY;
    else process.env.GATE_COMMERCIAL_AUTOPAY = ORIGINAL_AUTOPAY_GATE;
  });

  test('the three paragraphs are the owner-approved texts, word for word (autopay 2026-10-24, Net 30 2026-06-24, Net 60 2026-10-29)', () => {
    expect(AGREEMENT_PAYMENT_TEXT).toBe(require('../../shared/commercial-agreement-terms.cjs').AGREEMENT_PAYMENT_TEXT);
    expect(AGREEMENT_PAYMENT_TEXT).toEqual({
      autopay: "You authorize Waves to charge the card or bank account on file after each service is completed, plus applicable tax. You may change the payment method any time, and cancel autopay with 30 days' written notice, after which invoices are due Net 30.",
      net30: 'Services are invoiced on Net 30 terms \u2014 payment is due within thirty (30) days of the invoice date. Past-due balances may be subject to a late fee and/or suspension of service until the account is brought current.',
      net60: 'Services are invoiced on Net 60 terms \u2014 payment is due within sixty (60) days of the invoice date. Past-due balances may be subject to a late fee and/or suspension of service until the account is brought current.',
    });
  });

  test('Net 60 signs online like Net 30, with or without the Auto Pay gate, and prints its own paragraph in the payment slot', async () => {
    expect(signEligibility(net60())).toMatchObject({ ok: true });
    const { proposal, totals } = signableProposal(net60());
    expect(buildAgreementValues(net60(), proposal, totals).agreement.payment_terms).toBe(AGREEMENT_PAYMENT_TEXT.net60);
    const estimate = net60();
    const { database, state } = slotDb(estimate);
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: true, status: 201 });
    expect(state.contracts[0].contract_text_snapshot).toContain(`Billing and payment: ${AGREEMENT_PAYMENT_TEXT.net60}`);
    expect(state.contracts[0].contract_text_snapshot).not.toContain(AGREEMENT_PAYMENT_TEXT.net30);
    delete process.env.GATE_COMMERCIAL_AUTOPAY;
    expect(signEligibility(net60())).toMatchObject({ ok: true });
  });

  test('Net 60 is never issued on the version-1 template, whose fixed paragraph says Net 30', async () => {
    const estimate = net60();
    const { database, state } = makeDb({ estimate });
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: false, status: 409, code: 'template_unavailable' });
    expect(state.contracts).toHaveLength(0);
  });

  test('an Auto Pay agreement prints the Auto Pay paragraph in the payment slot', async () => {
    const estimate = autopay();
    const { database, state } = slotDb(estimate);
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: true, status: 201 });
    expect(state.contracts[0].contract_text_snapshot).toContain(`Billing and payment: ${AGREEMENT_PAYMENT_TEXT.autopay} Pricing may be adjusted`);
    expect(JSON.parse(state.contracts[0].document_variables_snapshot).agreement.payment_terms).toBe(AGREEMENT_PAYMENT_TEXT.autopay);
  });

  test('a Net 30 agreement prints the paragraph version 1 fixed, word for word', async () => {
    const { V1_PAYMENT } = require('../models/migrations/20261025120000_commercial_agreement_payment_terms');
    const { database, state } = slotDb(estimateRow());
    expect(await ensureAgreement({ estimate: estimateRow(), req, database })).toMatchObject({ ok: true, status: 201 });
    expect(state.contracts[0].contract_text_snapshot).toContain(V1_PAYMENT);
  });

  test('Auto Pay on a version without the payment slot is refused and writes nothing; Net 30 still issues there', async () => {
    const estimate = autopay();
    const { database, state } = makeDb({ estimate });
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: false, status: 409, code: 'template_unavailable' });
    expect(state.contracts).toHaveLength(0);
    const net30 = makeDb();
    expect(await ensureAgreement({ estimate: estimateRow(), req, database: net30.database })).toMatchObject({ ok: true, status: 201 });
  });

  test('Auto Pay is signable only with the gate on and Bill by invoice off; the builder line names both terms', async () => {
    expect(signEligibility(autopay())).toMatchObject({ ok: true });
    expect(await agreementCtaFor(autopay(), slotDb(autopay()).database)).toEqual({ canSign: true, state: 'none' });
    expect(signEligibility(autopay({ bill_by_invoice: true }))).toMatchObject({
      ok: false, reason: 'terms_conflict', field: 'paymentTerms', note: NOTE('payment terms Auto Pay, or Net 30 or Net 60 with Bill by invoice'),
    });
    expect(signEligibility(estimateRow({}, { commercialTerms: { paymentTerms: 'net15' } }))).toMatchObject({
      note: NOTE('payment terms Auto Pay, or Net 30 or Net 60 with Bill by invoice'),
    });
    delete process.env.GATE_COMMERCIAL_AUTOPAY;
    expect(signEligibility(autopay())).toMatchObject({ ok: false, reason: 'terms_conflict', field: 'paymentTerms', note: NOTE('payment terms Net 30 or Net 60') });
  });

  test('changing the payment term after issue supersedes the open agreement (the fingerprint covers it)', async () => {
    const { database, state } = slotDb(estimateRow());
    await ensureAgreement({ estimate: estimateRow(), req, database });
    state.estimate = autopay();
    expect(await ensureAgreement({ estimate: autopay(), req, database })).toMatchObject({ ok: true, status: 201, created: true });
    expect(state.contracts[0]).toMatchObject({ status: 'cancelled', share_token_hash: null });
    expect(state.contracts[1].contract_text_snapshot).toContain(AGREEMENT_PAYMENT_TEXT.autopay);
  });

  test('the Auto Pay gate thrown while the issue waited on the CONTRACT row lock (the last lock): 404, nothing written', async () => {
    const estimate = autopay();
    const { database, state } = slotDb(estimate);
    state.onContractLock = async () => { delete process.env.GATE_COMMERCIAL_AUTOPAY; };
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: false, status: 404, code: 'not_signable' });
    expect(state.contracts).toHaveLength(0);
    expect(state.writes).toEqual([]);
  });

  test('the same flip does not re-open an open Auto Pay agreement (its link is not rotated)', async () => {
    const estimate = autopay();
    const { database, state } = slotDb(estimate);
    await ensureAgreement({ estimate, req, database });
    const hashBefore = state.contracts[0].share_token_hash;
    const writesBefore = state.writes.length;
    state.onContractLock = async () => { delete process.env.GATE_COMMERCIAL_AUTOPAY; };
    expect(await ensureAgreement({ estimate, req, database })).toMatchObject({ ok: false, status: 404 });
    expect(state.contracts[0].share_token_hash).toBe(hashBefore);
    expect(state.writes).toHaveLength(writesBefore);
  });

  test('the fingerprint ignores the payment paragraph text, so an agreement issued before it existed keeps a valid link', async () => {
    const estimate = estimateRow();
    const { proposal, totals } = signableProposal(estimate);
    const values = buildAgreementValues(estimate, proposal, totals);
    expect(values.agreement.payment_terms).toBe(AGREEMENT_PAYMENT_TEXT.net30);
    const { payment_terms: _dropped, ...preChangeAgreement } = values.agreement;
    const args = { proposal, totals, customerId: 'cust-1', templateVersionId: 'ver-1' };
    expect(quoteFingerprint({ ...args, values })).toBe(quoteFingerprint({ ...args, values: { ...values, agreement: preChangeAgreement } }));
    // At the sign boundary: a Net 30 contract whose snapshot predates the paragraph signs.
    const made = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database: made.database });
    const contract = made.state.contracts[0];
    const snapshot = JSON.parse(contract.document_variables_snapshot);
    delete snapshot.agreement.payment_terms;
    contract.document_variables_snapshot = JSON.stringify(snapshot);
    const estimateLock = await lockEstimateForSign(made.database, contract);
    expect(await refuseStaleSignature({ trx: made.database, contract, estimateLock, req })).toBeNull();
  });

  test('the gate turned off after an Auto Pay agreement was issued refuses the signature and cancels it', async () => {
    const estimate = autopay();
    const made = slotDb(estimate);
    await ensureAgreement({ estimate, req, database: made.database });
    delete process.env.GATE_COMMERCIAL_AUTOPAY;
    const contract = made.state.contracts[0];
    const estimateLock = await lockEstimateForSign(made.database, contract);
    expect(await refuseStaleSignature({ trx: made.database, contract, estimateLock, req })).toBe(STALE_PROPOSAL_MESSAGE);
    expect(made.state.contracts[0].status).toBe('cancelled');
  });

  describe('the office alert says how the customer pays', () => {
    async function signedAutopay() {
      const estimate = autopay();
      const made = slotDb(estimate);
      await ensureAgreement({ estimate, req, database: made.database });
      Object.assign(made.state.contracts[0], { status: 'signed', signed_at: new Date('2026-10-24T15:00:00Z') });
      return made;
    }
    afterEach(() => jest.restoreAllMocks());

    test('Auto Pay with no saved method yet: the office is told to send a setup link if none is saved before the first visit', async () => {
      jest.spyOn(AutopayEligibility, 'customerOnAutopay').mockResolvedValue(false);
      const { database } = await signedAutopay();
      await handleAgreementSigned({ contractId: 'contract-1', database });
      const { detail } = NotificationService.notifyAdmin.mock.calls[0][3];
      expect(detail).toContain('Payment: Auto Pay, but no card or bank account is saved yet.');
      expect(detail).toContain('send an Auto Pay setup link from the customer page');
      expect(detail).toContain('no visit, invoice or charge was created');
    });

    test('Auto Pay already on: the alert says a method is saved', async () => {
      jest.spyOn(AutopayEligibility, 'customerOnAutopay').mockResolvedValue(true);
      const { database } = await signedAutopay();
      await handleAgreementSigned({ contractId: 'contract-1', database });
      expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toContain('Payment: Auto Pay, and a card or bank account is saved. ');
    });

    test('Auto Pay on, but the billing type does not charge each completed service: the alert says to check it', async () => {
      jest.spyOn(AutopayEligibility, 'customerOnAutopay').mockResolvedValue(true);
      billingLaneSupported.mockReturnValueOnce(false);
      const { database } = await signedAutopay();
      await handleAgreementSigned({ contractId: 'contract-1', database });
      expect(NotificationService.notifyAdmin.mock.calls[0][3].detail)
        .toContain("but this account's billing type does not charge each completed service: check it on the customer page before the first visit.");
    });

    test('an unreadable Auto Pay state never reads as on', async () => {
      jest.spyOn(AutopayEligibility, 'customerOnAutopay').mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
      const { database } = await signedAutopay();
      await handleAgreementSigned({ contractId: 'contract-1', database });
      expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toContain('but no card or bank account is saved yet');
    });

    test('Net 30: the alert says Net 30 by invoice', async () => {
      const { database, state } = makeDb();
      await ensureAgreement({ estimate: estimateRow(), req, database });
      Object.assign(state.contracts[0], { status: 'signed', signed_at: new Date() });
      await handleAgreementSigned({ contractId: 'contract-1', database });
      expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toContain('Payment: Net 30 by invoice.');
    });

    test('Net 60: the alert says Net 60 by invoice', async () => {
      const estimate = net60();
      const { database, state } = slotDb(estimate);
      await ensureAgreement({ estimate, req, database });
      Object.assign(state.contracts[0], { status: 'signed', signed_at: new Date() });
      await handleAgreementSigned({ contractId: 'contract-1', database });
      expect(NotificationService.notifyAdmin.mock.calls[0][3].detail).toContain('Payment: Net 60 by invoice.');
    });
  });

  // GATE_COMMERCIAL_FIRST_VISIT books the first visit only under the quote the customer signed.
  describe('signedQuoteMatches: the quote now is the quote the customer signed', () => {
    async function signedFor(estimate) {
      const made = makeDb({ estimate });
      await ensureAgreement({ estimate, req, database: made.database });
      Object.assign(made.state.contracts[0], { status: 'signed', signed_at: new Date() });
      return made;
    }

    test('unchanged since signing: true', async () => {
      const estimate = estimateRow();
      const { database } = await signedFor(estimate);
      expect(await signedQuoteMatches(estimate, database)).toBe(true);
    });

    test('a price edited after signing: false', async () => {
      const estimate = estimateRow();
      const { database } = await signedFor(estimate);
      const edited = estimateRow({}, { buildings: [{ name: 'Main building', lineItems: [{ description: 'Quarterly pest service', quantity: 1, unitPrice: 350, frequency: 'quarterly', taxable: true }] }] });
      expect(await signedQuoteMatches(edited, database)).toBe(false);
    });

    test('a visit length set after signing is scheduling only: still true, and the fingerprint ignores it', async () => {
      const programs = [{ service: 'pest', label: 'Interior Pest Control', frequencyPerYear: 12, pricePerApplication: 81.67, taxable: true }];
      const estimate = estimateRow({}, { buildings: [], programs });
      const { database } = await signedFor(estimate);
      const withLength = estimateRow({}, { buildings: [], programs: [{ ...programs[0], visitMinutes: 30 }] });
      expect(await signedQuoteMatches(withLength, database)).toBe(true);
    });

    test('a building use picked after signing is the operator classification: still true', async () => {
      const estimate = estimateRow();
      const { database } = await signedFor(estimate);
      expect(await signedQuoteMatches(estimateRow({}, { buildingUse: 'residential' }), database)).toBe(true);
    });

    test('nothing signed, or another customer: false', async () => {
      const estimate = estimateRow();
      const made = makeDb({ estimate });
      await ensureAgreement({ estimate, req, database: made.database });
      expect(await signedQuoteMatches(estimate, made.database)).toBe(false);
      const { database } = await signedFor(estimate);
      expect(await signedQuoteMatches({ ...estimate, customer_id: 'cust-2' }, database)).toBe(false);
    });
  });

  // GATE_COMMERCIAL_FIRST_VISIT: when the signer can book the first visit online, the office watches for that booking
  // (its own alert) instead of booking by phone beside it.
  describe('the office alert when the customer books the first visit online', () => {
    afterEach(() => jest.restoreAllMocks());
    async function signedNet30() {
      const made = makeDb();
      await ensureAgreement({ estimate: estimateRow(), req, database: made.database });
      Object.assign(made.state.contracts[0], { status: 'signed', signed_at: new Date() });
      return made;
    }

    test('online booking open: watch for the booking, done when a visit is booked', async () => {
      const online = jest.spyOn(require('../services/commercial-first-visit'), 'firstVisitOnlineFor').mockResolvedValue(true);
      const { database } = await signedNet30();
      await handleAgreementSigned({ contractId: 'contract-1', database });
      expect(online).toHaveBeenCalledWith(expect.any(String), database);
      const [, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
      expect(headline).toMatch(/^Estimates — watch for .+ (first visit )?booking$/);
      expect(why).toMatch(/; they can book the first visit online now\.$/);
      expect(opts.detail).toContain('They can now pick their first visit online, and you get a second alert when they book.');
      expect(opts.detail).not.toContain('Mark the estimate won, then schedule the first visit.');
      expect(opts.metadata).toMatchObject({ doneWhen: 'visit_booked' });
    });

    test('online booking not open: the office marks it won and books, as before', async () => {
      jest.spyOn(require('../services/commercial-first-visit'), 'firstVisitOnlineFor').mockResolvedValue(false);
      const { database } = await signedNet30();
      await handleAgreementSigned({ contractId: 'contract-1', database });
      const [, headline, , opts] = NotificationService.notifyAdmin.mock.calls[0];
      expect(headline).toMatch(/^Estimates — mark .+ won/);
      expect(opts.detail).toContain('Mark the estimate won, then schedule the first visit.');
      expect(opts.metadata).toMatchObject({ doneWhen: 'estimate_marked_won' });
    });
  });

  describe('autopayNextStep: the signing page\'s next step after an Auto Pay agreement is signed', () => {
    async function signed(estimate = autopay()) {
      const made = slotDb(estimate);
      await ensureAgreement({ estimate, req, database: made.database });
      Object.assign(made.state.contracts[0], { status: 'signed', signed_at: new Date() });
      return made;
    }
    beforeEach(() => requestAutopaySetupLink.mockReset());

    test('mints the standalone Auto Pay setup link INLINE for the contract\'s customer (nothing is sent) and returns its URL', async () => {
      requestAutopaySetupLink.mockResolvedValue({ requested: true, action: 'link_created', reason: 'created', secureUrl: 'https://portal.example/secure/tok' });
      const { database } = await signed();
      expect(await autopayNextStep({ contractId: 'contract-1', database })).toEqual({ state: 'setup', url: 'https://portal.example/secure/tok' });
      expect(requestAutopaySetupLink).toHaveBeenCalledWith({ customerId: 'cust-1', delivery: 'inline', trigger: 'commercial_proposal_sign' });
    });

    test.each([
      ['a consented saved card the link service enrolled', { requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' }],
      ['Auto Pay already active', { requested: false, action: 'skipped', reason: 'autopay_already_active' }],
    ])('%s: Auto Pay is on, no link', async (_label, result) => {
      requestAutopaySetupLink.mockResolvedValue(result);
      const { database } = await signed();
      expect(await autopayNextStep({ contractId: 'contract-1', database })).toEqual({ state: 'on' });
    });

    test('an account already on Auto Pay whose billing type does not charge each completed service gets no "Auto Pay is set up"', async () => {
      requestAutopaySetupLink.mockResolvedValue({ requested: false, action: 'skipped', reason: 'autopay_already_active' });
      billingLaneSupported.mockReturnValueOnce(false);
      const { database } = await signed();
      expect(await autopayNextStep({ contractId: 'contract-1', database })).toBeNull();
      expect(billingLaneSupported).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1' }));
    });

    test('a declined link (payer-billed, gate off, unsupported lane) is no next step', async () => {
      requestAutopaySetupLink.mockResolvedValue({ requested: false, action: 'skipped', reason: 'payer_billed' });
      const { database } = await signed();
      expect(await autopayNextStep({ contractId: 'contract-1', database })).toBeNull();
    });

    test('a Net 30 agreement, an unsigned one, one this feature did not issue, or the gate off: no link is minted', async () => {
      const net30 = await signed(estimateRow());
      expect(await autopayNextStep({ contractId: 'contract-1', database: net30.database })).toBeNull();
      const open = await signed();
      open.state.contracts[0].status = 'sent';
      expect(await autopayNextStep({ contractId: 'contract-1', database: open.database })).toBeNull();
      const byHand = await signed();
      byHand.state.contracts[0].document_variables_snapshot = JSON.stringify({ customer: { name: 'Hand Issued LLC' } });
      expect(await autopayNextStep({ contractId: 'contract-1', database: byHand.database })).toBeNull();
      const dark = await signed();
      delete process.env.GATE_COMMERCIAL_AUTOPAY;
      expect(await autopayNextStep({ contractId: 'contract-1', database: dark.database })).toBeNull();
      expect(requestAutopaySetupLink).not.toHaveBeenCalled();
    });

    test('never throws', async () => {
      requestAutopaySetupLink.mockRejectedValue(new Error('stripe down'));
      const { database } = await signed();
      await expect(autopayNextStep({ contractId: 'contract-1', database })).resolves.toBeNull();
    });
  });
});

describe('lock order: customer first, like every customer contact write', () => {
  test('issue locks comms fence, customer, estimate, template, then the contract row (no estimate-before-customer)', async () => {
    const { database, state } = makeDb();
    lockCustomerComms.mockImplementationOnce(async () => { state.order.push('comms'); });
    await ensureAgreement({ estimate: estimateRow(), req, database });
    expect(state.order).toEqual(['comms', 'customers', 'estimates', 'document_templates', 'customer_contracts']);
  });

  test('the estimate moved to another customer between the unlocked read and the lock: refused, nothing written', async () => {
    const { database, state } = makeDb({ estimate: estimateRow({ customer_id: 'cust-2' }) });
    // The route read the estimate under cust-1; by the time it is locked it belongs to cust-2.
    const result = await ensureAgreement({ estimate: estimateRow({ customer_id: 'cust-1' }), req, database });
    expect(result).toMatchObject({ ok: false, status: 404, code: 'not_signable' });
    expect(state.writes).toEqual([]);
    expect(state.contracts).toHaveLength(0);
    // The customer lock was taken, the mismatched estimate was locked, and nothing went further.
    expect(state.order).toEqual(['customers', 'estimates']);
  });

  test('the estimate lost its customer (unlinked) before the lock: refused, nothing written', async () => {
    const { database, state } = makeDb({ estimate: estimateRow({ customer_id: null }) });
    expect(await ensureAgreement({ estimate: estimateRow(), req, database })).toMatchObject({ ok: false, status: 404 });
    expect(state.writes).toEqual([]);
  });

  test('sign boundary: the estimate lock comes after the customer lock the route already holds, and an estimate that moved is refused without the open check', async () => {
    const { commercialAgreementBlockedFor } = require('../routes/estimate-public');
    commercialAgreementBlockedFor.mockReset().mockResolvedValue(false);
    const made = makeDb();
    await ensureAgreement({ estimate: estimateRow(), req, database: made.database });
    made.state.order.length = 0;
    made.state.estimate = estimateRow({ customer_id: 'cust-2' });
    const contract = made.state.contracts[0];
    const estimateLock = await lockEstimateForSign(made.database, contract);
    expect(estimateLock).toMatchObject({ blocked: true, customerMoved: true });
    expect(commercialAgreementBlockedFor).not.toHaveBeenCalled();
    expect(made.state.order).toEqual(['estimates']);
    expect(await refuseStaleSignature({ trx: made.database, contract, estimateLock, req })).toBe('This proposal was updated. Please open the latest proposal to sign.');
    expect(made.state.contracts[0].status).toBe('cancelled');
    expect(JSON.parse(made.state.events.find((e) => e.event_type === 'cancelled').metadata)).toMatchObject({ cause: 'customer_changed' });
    expect(made.state.contracts[0].signed_at).toBeUndefined();
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

describe('agreementAdminStatus: the builder Readiness card names every reason online signing is off', () => {
  test('a one-time-only proposal: not offered, with the note', async () => {
    const estimate = estimateRow({}, { buildings: [{ name: 'Main', lineItems: [{ description: 'Cleanout', quantity: 1, unitPrice: 400, frequency: 'one_time', taxable: true }] }] });
    const { database } = makeDb({ estimate });
    expect(await agreementAdminStatus(estimate, database)).toEqual({
      state: 'none', signingBlocked: 'not_signable', note: 'Online signing needs a recurring service. One-time work is signed with the office.',
    });
  });

  test('a closed proposal (won, declined, expired, archived): closed comes first; a signed agreement still reads signed', async () => {
    const estimate = estimateRow({ status: 'accepted', customer_id: null });
    const { database } = makeDb({ estimate });
    expect(await agreementAdminStatus(estimate, database, { closed: true })).toEqual({
      state: 'none', signingBlocked: 'closed', note: 'Online signing is closed: the proposal is won, declined, expired or archived.',
    });
    expect(await agreementAdminStatus(estimateRow(), database, { closed: false })).toEqual({ state: 'none' });
  });

  test('no linked customer account: blocked, with the note (the customer page asks the customer to call)', async () => {
    const estimate = estimateRow({ customer_id: null });
    const { database } = makeDb({ estimate });
    expect(await agreementCtaFor(estimate, database)).toEqual({ canSign: false, state: 'none' });
    expect(await agreementAdminStatus(estimate, database)).toEqual({
      state: 'none', signingBlocked: 'no_account', note: 'Online signing needs a linked customer account. Until then the page asks the customer to call.',
    });
  });
});
