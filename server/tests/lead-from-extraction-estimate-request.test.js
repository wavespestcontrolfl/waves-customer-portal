/**
 * surfaceEstimateRequestForCustomer (codex #3569): the ONLY artifact behind a
 * written-estimate promise to an EXISTING customer (who gets no lead).
 * bell:true, one card per call, suppressed ≠ persisted, errors non-blocking.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/voice-agent/relay-context', () => ({ claimOwnedElsewhere: jest.fn() }));

const db = require('../models/db');
const { notifyAdmin } = require('../services/notification-service');
const { surfaceEstimateRequestForCustomer } = require('../services/lead-from-extraction');

beforeEach(() => jest.clearAllMocks());

test('files the CANONICAL quote-promised bell (lead lane, no_lead marker) with bell:true, the customer link, fulfilment details, and a per-call dedupe key', async () => {
  notifyAdmin.mockResolvedValue({ id: 'n-1' });
  const out = await surfaceEstimateRequestForCustomer('c-1', { first_name: 'pat', last_name: 'LEE', requested_service: 'mosquito', call_summary: 'asked what monthly costs', email: 'pat@example.com', address_line1: '12 Shell Dr', city: 'Venice', zip: '34285' }, { callSid: 'CA1', phone: '+19415551234', spokenExpectation: 'about_15_minutes' });
  expect(out).toEqual({ persisted: true, suppressed: false });
  expect(notifyAdmin).toHaveBeenCalledWith(
    'lead',
    'Quote promised on call — send it',
    expect.stringMatching(/^Pat Lee: the voice agent could not give a number and promised a written estimate \(mosquito\)\.[\s\S]*told it usually goes out in about 15 minutes — send it NOW[\s\S]*Existing customer — no lead is tracking this promise[\s\S]*Email given on the call: pat@example\.com[\s\S]*Service address given on the call: 12 Shell Dr, Venice, 34285[\s\S]*Callback number: \+19415551234/),
    expect.objectContaining({
      bell: true,
      link: '/admin/customers?customerId=c-1',
      dedupeKey: 'relay-estimate-request:CA1', // notifyAdmin's top-level dedupe option
      // the markers call-recording-processor's quotePromisedAlreadyNotified() and the estimator upgrade read
      metadata: expect.objectContaining({ customerId: 'c-1', callSid: 'CA1', quote_promised: true, no_lead: true, property_count: 1, kind: 'estimate_request', requested_service: 'mosquito', email: 'pat@example.com', address_line1: '12 Shell Dr', phone: '+19415551234', spoken_expectation: 'about_15_minutes', urgent: true }),
    }),
  );
});

test('closed / unknown expectations are stated honestly and are not urgent', async () => {
  notifyAdmin.mockResolvedValue({ id: 'n-2' });
  await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat' }, { callSid: 'CA2', spokenExpectation: 'when_office_opens' });
  expect(notifyAdmin).toHaveBeenLastCalledWith('lead', expect.any(String), expect.stringContaining('goes out when the office opens — send it first thing'), expect.objectContaining({ metadata: expect.objectContaining({ spoken_expectation: 'when_office_opens', urgent: false }) }));
  await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat' }, { callSid: 'CA3' });
  expect(notifyAdmin).toHaveBeenLastCalledWith('lead', expect.any(String), expect.stringContaining('as soon as possible'), expect.objectContaining({ metadata: expect.objectContaining({ spoken_expectation: 'as_soon_as_possible', urgent: false }) }));
});

test('suppressed sentinel or missing id ⇒ NOT persisted', async () => {
  notifyAdmin.mockResolvedValue({ id: null, suppressed: true, reason: 'internal_test' });
  expect(await surfaceEstimateRequestForCustomer('c-1', {}, {})).toEqual({ persisted: false, suppressed: true });
  notifyAdmin.mockResolvedValue(null);
  expect(await surfaceEstimateRequestForCustomer('c-1', {}, {})).toEqual({ persisted: false, suppressed: false });
});

test('no customer ⇒ no card; a thrown notify is non-blocking', async () => {
  expect(await surfaceEstimateRequestForCustomer(null, {}, {})).toEqual({ persisted: false, suppressed: false });
  expect(notifyAdmin).not.toHaveBeenCalled();
  notifyAdmin.mockRejectedValue(new Error('boom'));
  expect(await surfaceEstimateRequestForCustomer('c-1', {}, {})).toEqual({ persisted: false, suppressed: false });
});

test('details the caller CONFIRMED from the account are labelled as that, never as given on the call (#5803 follow-up)', async () => {
  notifyAdmin.mockResolvedValue({ id: 'n-9' });
  await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'pat@example.com', address_line1: '12 Shell Dr', city: 'Venice', zip: '34285' }, { callSid: 'CA9', accountDetailsConfirmed: ['name', 'email', 'address'] });
  const [, , body, opts] = notifyAdmin.mock.calls[0];
  expect(body).toContain('Email on the account (the caller confirmed it on the call): pat@example.com');
  expect(body).toContain('Service address on the account (the caller confirmed it on the call): 12 Shell Dr, Venice, 34285');
  expect(body).not.toMatch(/given on the call/);
  expect(opts.metadata.details_from_account).toEqual(['name', 'email', 'address']);
});

describe('a later capture on the same call rewrites the card', () => {
  const { claimOwnedElsewhere } = require('../services/voice-agent/relay-context');
  const standingCard = (row) => db.mockReturnValue({ where: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) });
  const optsOf = () => notifyAdmin.mock.calls[notifyAdmin.mock.calls.length - 1][3];
  const trx = Object.assign(jest.fn(), { marker: 'trx' });
  beforeEach(() => { db.transaction = jest.fn(async (cb) => cb(trx)); });

  test('it refreshes in place, and rings again only when what the office acts on changed or it was marked done', async () => {
    notifyAdmin.mockResolvedValue({ id: 'n-1' });
    await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'pat@example.com', address_line1: '9 Rental Rd', city: 'Venice', zip: '34285', requested_service: 'mosquito' }, { callSid: 'CA1', phone: '+19415551234' });
    const { refreshOnDedupe, ringOnRefresh } = optsOf();
    expect(refreshOnDedupe).toBe(true);
    const same = { email: 'pat@example.com', address_line1: '9 Rental Rd', city: 'Venice', zip: '34285', requested_service: 'mosquito', phone: '+19415551234', still_missing: [] };
    expect(ringOnRefresh({ done_at: null }, same)).toBe(false); // e.g. only the summary grew
    expect(ringOnRefresh({ done_at: null }, { ...same, address_line1: '12 Test Street' })).toBe(true);
    expect(ringOnRefresh({ done_at: null }, { ...same, requested_service: 'termite' })).toBe(true);
    expect(ringOnRefresh({ done_at: null }, { ...same, phone: '+19415550000' })).toBe(true);
    expect(ringOnRefresh({ done_at: null }, { ...same, still_missing: ['address_line1'] })).toBe(true);
    expect(ringOnRefresh({ done_at: '2026-10-03T12:00:00Z' }, same)).toBe(true);
  });

  test('a correction that leaves the request incomplete revises the standing card and says what to confirm; with no card standing it files nothing', async () => {
    standingCard({ id: 'n-1' });
    notifyAdmin.mockResolvedValue({ id: 'n-1', deduped: true, refreshed: true });
    await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'pat@example.com', address_line1: null, city: 'Venice', zip: null }, { callSid: 'CA1', stillMissing: ['address_line1'] });
    const body = notifyAdmin.mock.calls[0][2];
    expect(body).toContain('still missing: street address');
    expect(body).toContain('Location given on the call: Venice');
    expect(body).not.toMatch(/Service address/);
    expect(optsOf().metadata).toMatchObject({ address_line1: null, city: 'Venice', still_missing: ['address_line1'], quote_promised: true });

    notifyAdmin.mockClear();
    standingCard(undefined);
    expect(await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', city: 'Venice' }, { callSid: 'CA1', stillMissing: ['email', 'address_line1'] })).toEqual({ persisted: false, suppressed: false });
    expect(await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat' }, { stillMissing: ['address_line1'] })).toEqual({ persisted: false, suppressed: false });
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('the write is fenced to the session that owns the call: a superseded socket writes nothing', async () => {
    claimOwnedElsewhere.mockResolvedValue(false);
    notifyAdmin.mockResolvedValue({ id: 'n-1' });
    expect(await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat' }, { callSid: 'CA1', sessionKey: 'sk-1' })).toEqual({ persisted: true, suppressed: false });
    expect(claimOwnedElsewhere).toHaveBeenCalledWith(trx, 'CA1', 'sk-1');
    expect(notifyAdmin.mock.calls[0][3].trx).toBe(trx);

    notifyAdmin.mockClear();
    claimOwnedElsewhere.mockResolvedValue(true);
    expect(await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'stale@example.com' }, { callSid: 'CA1', sessionKey: 'sk-old' })).toEqual({ persisted: false, suppressed: false, superseded: true });
    expect(notifyAdmin).not.toHaveBeenCalled();

    claimOwnedElsewhere.mockResolvedValue(false);
    notifyAdmin.mockRejectedValue(new Error('boom'));
    expect(await surfaceEstimateRequestForCustomer('c-1', {}, { callSid: 'CA1', sessionKey: 'sk-1' })).toEqual({ persisted: false, suppressed: false });
  });
});
