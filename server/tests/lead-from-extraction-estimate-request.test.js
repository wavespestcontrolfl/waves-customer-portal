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

describe('a later capture on the same call rewrites the card (#5751)', () => {
  const standingCard = (row) => db.mockReturnValue({ where: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) });
  const optsOf = () => notifyAdmin.mock.calls[notifyAdmin.mock.calls.length - 1][3];

  test('the card refreshes in place, and rings again only when where the estimate goes changed or the office had marked it done', async () => {
    notifyAdmin.mockResolvedValue({ id: 'n-1' });
    await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'pat@example.com', address_line1: '9 Rental Rd', city: 'Venice', zip: '34285' }, { callSid: 'CA1' });
    const { refreshOnDedupe, ringOnRefresh } = optsOf();
    expect(refreshOnDedupe).toBe(true);
    const same = { email: 'pat@example.com', address_line1: '9 Rental Rd', city: 'Venice', zip: '34285' };
    expect(ringOnRefresh({ done_at: null }, same)).toBe(false); // e.g. only the summary grew
    expect(ringOnRefresh({ done_at: null }, { ...same, address_line1: '12 Test Street', city: 'Bradenton', zip: '34205' })).toBe(true);
    expect(ringOnRefresh({ done_at: '2026-10-03T12:00:00Z' }, same)).toBe(true);
  });

  test('an address taken from the account is labelled as the account\'s, never as given on the call', async () => {
    notifyAdmin.mockResolvedValue({ id: 'n-1' });
    await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'pat@example.com', address_line1: '12 Test Street', city: 'Bradenton', zip: '34205' }, { callSid: 'CA1', locationFromAccount: true });
    const body = notifyAdmin.mock.calls[0][2];
    expect(body).toContain('No address was given on the call. Service address on the account: 12 Test Street, Bradenton, 34205');
    expect(body).not.toContain('Service address given on the call');
    expect(body).toContain('Email given on the call: pat@example.com');
    expect(optsOf().metadata).toMatchObject({ address_source: 'account', email_source: 'call', still_missing: [] });
    await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'pat@example.com', address_line1: '9 Rental Rd' }, { callSid: 'CA2', emailFromAccount: true });
    expect(notifyAdmin.mock.calls[1][2]).toContain('No email was given on the call. Email on the account: pat@example.com');
    expect(notifyAdmin.mock.calls[1][2]).not.toContain('Email given on the call');
    expect(optsOf().metadata).toMatchObject({ address_source: 'call', email_source: 'account' });
  });

  test('a correction that leaves the request incomplete revises the standing card: the old address is gone and the card says what to confirm', async () => {
    standingCard({ id: 'n-1' });
    notifyAdmin.mockResolvedValue({ id: 'n-1', deduped: true, refreshed: true });
    await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'pat@example.com', address_line1: null, city: 'Venice', zip: null }, { callSid: 'CA1', stillMissing: ['address_line1'] });
    const body = notifyAdmin.mock.calls[0][2];
    expect(body).toContain('still missing: street address');
    expect(body).toContain('Location given on the call: Venice');
    expect(body).not.toMatch(/Service address/);
    expect(optsOf().metadata).toMatchObject({ address_line1: null, city: 'Venice', zip: null, address_source: 'call', still_missing: ['address_line1'], quote_promised: true });
    expect(optsOf().ringOnRefresh({ done_at: null }, { email: 'pat@example.com', address_line1: '12 Test Street', city: 'Bradenton', zip: '34205' })).toBe(true);
  });

  test('an incomplete capture with no card standing files nothing: a request that was never complete is not a "send it" card', async () => {
    standingCard(undefined);
    expect(await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', city: 'Venice' }, { callSid: 'CA1', stillMissing: ['email', 'address_line1'] })).toEqual({ persisted: false, suppressed: false });
    expect(await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', city: 'Venice' }, { stillMissing: ['address_line1'] })).toEqual({ persisted: false, suppressed: false });
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});

describe('the card write is fenced against a session takeover (#5751)', () => {
  const { claimOwnedElsewhere } = require('../services/voice-agent/relay-context');
  const trx = Object.assign(jest.fn(), { marker: 'trx' });
  beforeEach(() => { db.transaction = jest.fn(async (cb) => cb(trx)); });

  test('the owning session writes on the fence\'s transaction; a superseded socket writes nothing', async () => {
    claimOwnedElsewhere.mockResolvedValue(false);
    notifyAdmin.mockResolvedValue({ id: 'n-1' });
    expect(await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat' }, { callSid: 'CA1', sessionKey: 'sk-1' })).toEqual({ persisted: true, suppressed: false });
    expect(claimOwnedElsewhere).toHaveBeenCalledWith(trx, 'CA1', 'sk-1');
    expect(notifyAdmin.mock.calls[0][3].trx).toBe(trx);

    notifyAdmin.mockClear();
    claimOwnedElsewhere.mockResolvedValue(true);
    expect(await surfaceEstimateRequestForCustomer('c-1', { first_name: 'Pat', email: 'stale@example.com' }, { callSid: 'CA1', sessionKey: 'sk-old' })).toEqual({ persisted: false, suppressed: false, superseded: true });
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed write inside the fence is not persisted and never throws', async () => {
    claimOwnedElsewhere.mockResolvedValue(false);
    notifyAdmin.mockRejectedValue(new Error('boom'));
    expect(await surfaceEstimateRequestForCustomer('c-1', {}, { callSid: 'CA1', sessionKey: 'sk-1' })).toEqual({ persisted: false, suppressed: false });
  });

  test('no session key (no claim to prove) keeps the unfenced write', async () => {
    notifyAdmin.mockResolvedValue({ id: 'n-1' });
    await surfaceEstimateRequestForCustomer('c-1', {}, { callSid: 'CA1' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(notifyAdmin.mock.calls[0][3].trx).toBeUndefined();
  });
});
