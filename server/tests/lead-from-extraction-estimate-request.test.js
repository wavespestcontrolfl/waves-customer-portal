/**
 * surfaceEstimateRequestForCustomer (codex #3569): the ONLY artifact behind a
 * written-estimate promise to an EXISTING customer (who gets no lead).
 * bell:true, one card per call, suppressed ≠ persisted, errors non-blocking.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const { notifyAdmin } = require('../services/notification-service');
const { surfaceEstimateRequestForCustomer } = require('../services/lead-from-extraction');

beforeEach(() => jest.clearAllMocks());

test('files the CANONICAL quote-promised bell (lead lane, no_lead marker) with bell:true, the customer link, fulfilment details, and a per-call dedupe key', async () => {
  notifyAdmin.mockResolvedValue({ id: 'n-1' });
  const out = await surfaceEstimateRequestForCustomer('c-1', { first_name: 'pat', last_name: 'LEE', requested_service: 'mosquito', call_summary: 'asked what monthly costs', email: 'pat@example.com', address_line1: '12 Shell Dr', city: 'Venice', zip: '34285' }, { callSid: 'CA1', phone: '+19415551234' });
  expect(out).toEqual({ persisted: true, suppressed: false });
  expect(notifyAdmin).toHaveBeenCalledWith(
    'lead',
    'Quote promised on call — send it',
    expect.stringMatching(/^Pat Lee: the voice agent could not give a number and promised a written estimate \(mosquito\)\.[\s\S]*Existing customer — no lead is tracking this promise[\s\S]*Email given on the call: pat@example\.com[\s\S]*Service address given on the call: 12 Shell Dr, Venice, 34285[\s\S]*Callback number: \+19415551234/),
    expect.objectContaining({
      bell: true,
      link: '/admin/customers?customerId=c-1',
      dedupeKey: 'relay-estimate-request:CA1', // notifyAdmin's top-level dedupe option
      // the markers call-recording-processor's quotePromisedAlreadyNotified() and the estimator upgrade read
      metadata: expect.objectContaining({ customerId: 'c-1', callSid: 'CA1', quote_promised: true, no_lead: true, property_count: 1, kind: 'estimate_request', requested_service: 'mosquito', email: 'pat@example.com', address_line1: '12 Shell Dr', phone: '+19415551234' }),
    }),
  );
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
