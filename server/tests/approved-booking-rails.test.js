/**
 * The approved-card rails (services/scheduling/approved-booking-rails.js): one
 * table, one runner, run after every customer/series lock and before the first
 * insert of the Schedule booking transaction. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { RAILS, runApprovedBookingRails } = require('../services/scheduling/approved-booking-rails');
const EstimateLock = require('../utils/customer-estimate-lock');
const StartProgram = require('../services/intelligence-bar/start-program');
const InspectionCredit = require('../services/inspection-credit');
const Tools = require('../services/intelligence-bar/tools');

const CUSTOMER_ID = '00000000-0000-4000-8000-00000000c0a1';
let log;
let billingRow;

function fakeTrx() {
  return (table) => {
    let locked = false;
    const b = {
      where: () => b,
      forUpdate: () => { locked = true; log.push(`lock:${table}`); return b; },
      first: async () => { if (!locked) log.push(`read:${table}`); return table === 'customers' ? billingRow : { address_line1: '1 Example St', city: 'Sarasota', state: 'FL', zip: '34201' }; },
    };
    return b;
  };
}

const baseCtx = (req) => ({
  req, customerId: CUSTOMER_ID, seriesDates: ['2099-03-03', '2099-04-07'], techDates: [],
  assertTech: jest.fn(async () => ({})),
  probeOverlap: jest.fn(async () => []),
  resolveAnchorPropertyId: jest.fn(async () => 'prop-1'),
});

const BILLING = { payer_id: null, billing_mode: 'monthly_membership', per_application_fee: null, waveguard_tier: 'Bronze', monthly_rate: '41.33' };

beforeEach(() => {
  log = [];
  jest.spyOn(require('../services/booking-contact-state'), 'currentContactKey').mockImplementation(async () => { log.push('read:contact'); return 'key-a'; });
  jest.spyOn(require('../services/consultation-outcomes'), 'openConsultationCandidates').mockImplementation(async () => { log.push('read:consultations'); return []; });
  billingRow = { ...BILLING };
  jest.spyOn(EstimateLock, 'lockCustomerEstimates').mockImplementation(async () => { log.push('lock:estimates-advisory'); });
  jest.spyOn(StartProgram, 'openEstimateForCustomer').mockImplementation(async () => { log.push('read:open-estimate'); return null; });
  jest.spyOn(InspectionCredit, 'projectRedeemableOfferAmount').mockImplementation(async () => { log.push('read:credit'); return 0; });
  jest.spyOn(Tools, 'bookingOverlapFacts').mockImplementation(async (_c, rows, date) => rows.map((r) => ({ fact: `${r.id}|${date}` })));
  jest.spyOn(StartProgram, 'serviceAnchorAddress').mockReturnValue('1 Example St, Sarasota, FL 34201');
});
afterEach(() => jest.restoreAllMocks());

const run = (req, ctxOverrides = {}) => runApprovedBookingRails(fakeTrx(), { ...baseCtx(req), ...ctxOverrides });
const codeOf = async (promise) => { try { await promise; return null; } catch (e) { return e.code; } };

test('the table names every rail code once', () => {
  expect(RAILS.map((r) => r.code)).toEqual([
    'BILLING_CHANGED', 'COMMERCIAL_CHANGED', 'LEDGER_CHANGED', 'CONSULTATIONS_CHANGED', 'CONTACT_CHANGED', 'ESTIMATE_OPENED', 'INSPECTION_CREDIT_CHANGED', 'DATES_CHANGED', 'ADDRESS_CHANGED', 'OVERLAP_CHANGED', 'TECH_NOT_ASSIGNABLE',
  ]);
});

test('a booking with no approved card runs no rail and reads nothing', async () => {
  await run({});
  expect(log).toEqual([]);
});

describe('each rail: a read that differs from the pinned fact throws its code', () => {
  test('BILLING_CHANGED (a payer-only change)', async () => {
    billingRow = { ...BILLING, payer_id: 'payer-1' };
    expect(await codeOf(run({ approvedBilling: BILLING }))).toBe('BILLING_CHANGED');
    billingRow = { ...BILLING };
    expect(await codeOf(run({ approvedBilling: BILLING }))).toBeNull();
  });
  test('COMMERCIAL_CHANGED (property_type flipped to business under the lock; the canonical predicate decides)', async () => {
    expect(await codeOf(run({ approvedNotCommercial: true }))).toBeNull();
    billingRow = { ...BILLING, property_type: 'business' };
    expect(await codeOf(run({ approvedNotCommercial: true }))).toBe('COMMERCIAL_CHANGED');
    billingRow = { ...BILLING, property_type: 'Commercial' };
    expect(await codeOf(run({ approvedNotCommercial: true }))).toBe('COMMERCIAL_CHANGED');
    billingRow = { ...BILLING, waveguard_tier: 'Commercial' };
    expect(await codeOf(run({ approvedNotCommercial: true }))).toBe('COMMERCIAL_CHANGED');
    // A booking that did not pin it (the Schedule page) reads nothing.
    log = [];
    billingRow = { ...BILLING, property_type: 'business' };
    expect(await codeOf(run({}))).toBeNull();
    expect(log).toEqual([]);
  });
  test('LEDGER_CHANGED (a monthly bill line moved under the lock)', async () => {
    const PlanRateLedger = require('../services/plan-rate-ledger');
    const loadComponents = jest.spyOn(PlanRateLedger, 'loadComponents').mockResolvedValue([{ family_key: 'pest_control', monthly_rate: '41.33' }]);
    const RateChange = require('../services/intelligence-bar/rate-change');
    const pin = RateChange.ledgerPin([{ family_key: 'pest_control', monthly_rate: '41.33' }], '41.33');
    billingRow = { ...BILLING, monthly_rate: '41.33' };
    expect(await codeOf(run({ approvedLedgerPin: pin }))).toBeNull();
    loadComponents.mockResolvedValue([{ family_key: 'pest_control', monthly_rate: '45.00' }]);
    expect(await codeOf(run({ approvedLedgerPin: pin }))).toBe('LEDGER_CHANGED');
  });
  test('ESTIMATE_OPENED (any open estimate, no service-family reading)', async () => {
    StartProgram.openEstimateForCustomer.mockResolvedValue({ id: 'est-1' });
    expect(await codeOf(run({ approvedNoOpenEstimate: true }))).toBe('ESTIMATE_OPENED');
    // The rail asks the same question the card's own check asks: the customer id and the transaction, nothing else.
    expect(StartProgram.openEstimateForCustomer).toHaveBeenCalledWith(CUSTOMER_ID, expect.anything());
  });
  test.each([
    ['waveguard_tier_source', 'auto'], ['active', false], ['pipeline_stage', 'lead'], ['member_since', '2020-01-01'], ['deleted_at', '2026-10-01'],
  ])('BILLING_CHANGED when the plan-sync input %s moves under the lock (round 4)', async (col, value) => {
    const pinned = { ...BILLING, waveguard_tier_source: 'manual', active: true, pipeline_stage: 'active_customer', member_since: null, deleted_at: null };
    billingRow = { ...pinned, [col]: value };
    expect(await codeOf(run({ approvedBilling: pinned }))).toBe('BILLING_CHANGED');
    billingRow = { ...pinned };
    expect(await codeOf(run({ approvedBilling: pinned }))).toBeNull();
  });
  test('the card pins every customers column the plan sync reads', () => {
    const fs = require('fs');
    const path = require('path');
    const { CARD_BILLING_COLS } = require('../services/scheduling/approved-booking-rails');
    const src = fs.readFileSync(path.join(__dirname, '../services/self-booking-plan-sync.js'), 'utf8');
    const fnBody = (name) => { const at = src.indexOf(`function ${name}(`); return src.slice(at, src.indexOf('\n}\n', at)); };
    const read = new Set();
    for (const name of ['buildCustomerWaveGuardAlignmentUpdates', 'isAutoDerivedTierLabelRow']) {
      for (const m of fnBody(name).matchAll(/\b(?:customer|row)\??\.([a-z_]+)/g)) read.add(m[1]);
    }
    read.delete('earliest_service_date'); // derived from the schedule rows, not a customers column
    read.add('deleted_at'); // the sync's customer_not_found / live-customer check
    for (const col of read) expect(CARD_BILLING_COLS).toContain(col);
  });
  test('CONSULTATIONS_CHANGED (a consultation that appears, changes outcome or goes away after the card)', async () => {
    const Consultations = require('../services/consultation-outcomes');
    const spy = jest.spyOn(Consultations, 'openConsultationCandidates').mockResolvedValue([]);
    expect(await codeOf(run({ approvedConsultations: [] }))).toBeNull();
    spy.mockResolvedValue([{ outcome_id: 7, outcome: 'warm' }]);
    expect(await codeOf(run({ approvedConsultations: [] }))).toBe('CONSULTATIONS_CHANGED');
    expect(await codeOf(run({ approvedConsultations: ['7:warm'] }))).toBeNull();
    expect(await codeOf(run({ approvedConsultations: ['7:cold'] }))).toBe('CONSULTATIONS_CHANGED');
    spy.mockResolvedValue([]);
    expect(await codeOf(run({ approvedConsultations: ['7:warm'] }))).toBe('CONSULTATIONS_CHANGED');
    // A booking that pinned nothing about consultations (the Schedule page) reads nothing.
    spy.mockClear();
    expect(await codeOf(run({}))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  test('CONTACT_CHANGED (the recipient key moves under the lock; a pinned booking reads it, an unpinned one does not)', async () => {
    const Contact = require('../services/booking-contact-state');
    const spy = jest.spyOn(Contact, 'currentContactKey').mockResolvedValue('key-a');
    expect(await codeOf(run({ approvedContact: 'key-a' }))).toBeNull();
    spy.mockResolvedValue('key-b');
    expect(await codeOf(run({ approvedContact: 'key-a' }))).toBe('CONTACT_CHANGED');
    // An unreadable lookup reads as null, which never equals a pinned key.
    spy.mockResolvedValue(null);
    expect(await codeOf(run({ approvedContact: 'key-a' }))).toBe('CONTACT_CHANGED');
    spy.mockClear();
    expect(await codeOf(run({}))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  test('CONTACT_CHANGED reads the confirmation key for the approved property and, when pinned, the account-level welcome key', async () => {
    const Contact = require('../services/booking-contact-state');
    const spy = jest.spyOn(Contact, 'currentContactKey').mockImplementation(async (_id, opts = {}) => (opts.kind === 'welcome' ? 'welcome-a' : `confirm-${opts.propertyId || 'none'}`));
    const anchor = { propertyId: 'prop-1', address: '1 Example St, Sarasota, FL 34201' };
    const req = { approvedContact: 'confirm-prop-1', approvedWelcomeContact: 'welcome-a', approvedServiceAnchor: anchor };
    expect(await codeOf(run(req))).toBeNull();
    expect(spy).toHaveBeenCalledWith(CUSTOMER_ID, { propertyId: 'prop-1' });
    expect(spy).toHaveBeenCalledWith(CUSTOMER_ID, { kind: 'welcome' });
    // The welcome moved (the account holder's address), the confirmation did not.
    expect(await codeOf(run({ ...req, approvedWelcomeContact: 'welcome-old' }))).toBe('CONTACT_CHANGED');
    // The confirmation moved for that property alone.
    expect(await codeOf(run({ ...req, approvedContact: 'confirm-other' }))).toBe('CONTACT_CHANGED');
  });
  test('INSPECTION_CREDIT_CHANGED', async () => {
    InspectionCredit.projectRedeemableOfferAmount.mockResolvedValue({ amount: 25 });
    expect(await codeOf(run({ creditFreeCard: true }))).toBe('INSPECTION_CREDIT_CHANGED');
  });
  test('DATES_CHANGED', async () => {
    expect(await codeOf(run({ approvedVisitDates: ['2099-03-03', '2099-04-08'] }))).toBe('DATES_CHANGED');
    expect(await codeOf(run({ approvedVisitDates: ['2099-03-03', '2099-04-07'] }))).toBeNull();
  });
  test('ADDRESS_CHANGED (a different property, and a different address)', async () => {
    expect(await codeOf(run({ approvedServiceAnchor: { propertyId: 'prop-2', address: '1 Example St, Sarasota, FL 34201' } }))).toBe('ADDRESS_CHANGED');
    expect(await codeOf(run({ approvedServiceAnchor: { propertyId: 'prop-1', address: '9 Other Rd' } }))).toBe('ADDRESS_CHANGED');
    expect(await codeOf(run({ approvedServiceAnchor: { propertyId: 'prop-1', address: '1 Example St, Sarasota, FL 34201' } }))).toBeNull();
  });
  test('OVERLAP_CHANGED (any series date; an approved fact passes)', async () => {
    const ctx = baseCtx({ approvedOverlapFacts: ['visit-1|2099-04-07'] });
    ctx.probeOverlap = jest.fn(async (_t, date) => (date === '2099-04-07' ? [{ id: 'visit-1' }] : []));
    await expect(runApprovedBookingRails(fakeTrx(), ctx)).resolves.toBeUndefined();
    ctx.probeOverlap = jest.fn(async (_t, date) => (date === '2099-03-03' ? [{ id: 'visit-2' }] : [{ id: 'visit-1' }]));
    expect(await codeOf(runApprovedBookingRails(fakeTrx(), ctx))).toBe('OVERLAP_CHANGED');
  });
  test('TECH_NOT_ASSIGNABLE (the first date the technician is unavailable on)', async () => {
    const err = Object.assign(new Error('Technician Sam Tech is marked out and cannot be assigned work'), { code: 'TECH_NOT_ASSIGNABLE', statusCode: 422 });
    const ctx = baseCtx({});
    ctx.techDates = ['2099-03-03', '2099-04-07'];
    ctx.assertTech = jest.fn(async (_t, date) => { if (date === '2099-04-07') throw err; });
    await expect(runApprovedBookingRails(fakeTrx(), ctx)).rejects.toBe(err);
    expect(ctx.assertTech).toHaveBeenCalledTimes(2);
  });
});

test('every lock is taken before any read, and the estimate lock is the last lock', async () => {
  jest.spyOn(require('../services/plan-rate-ledger'), 'loadComponents').mockResolvedValue([]);
  await run({
    approvedNotCommercial: true, approvedLedgerPin: require('../services/intelligence-bar/rate-change').ledgerPin([], BILLING.monthly_rate),
    approvedBilling: BILLING, approvedNoOpenEstimate: true, creditFreeCard: true, approvedConsultations: [], approvedContact: 'key-a',
    approvedVisitDates: ['2099-03-03', '2099-04-07'],
    approvedServiceAnchor: { propertyId: 'prop-1', address: '1 Example St, Sarasota, FL 34201' }, approvedOverlapFacts: [],
  });
  const firstRead = log.findIndex((e) => e.startsWith('read:'));
  const lastLock = log.map((e) => e.startsWith('lock:')).lastIndexOf(true);
  expect(lastLock).toBeLessThan(firstRead);
  // Every customer row lock (billing, commercial, ledger, consultations, contact) comes before the estimate lock, which is a leaf.
  expect(log.slice(0, 6)).toEqual(['lock:customers', 'lock:customers', 'lock:customers', 'lock:customers', 'lock:customers', 'lock:estimates-advisory']);
  // The billing read comes after the customer row lock.
  expect(log.indexOf('lock:customers')).toBeLessThan(log.indexOf('read:customers'));
  expect(log.indexOf('lock:estimates-advisory')).toBeLessThan(log.indexOf('read:open-estimate'));
});
